import { mkdtempSync, rmSync } from 'node:fs'
import { Agent, request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountOpenAiGateway } from '../../src/openai-gateway/index.js'
import { disposeGatewayRuntime, gatewayLastError } from '../../src/openai-gateway/runtime.js'

/**
 * 网关**生命周期**的回归锁（Issue #11）。
 *
 * 背景：报障是「翻『允许局域网访问』后网关静默消失，无监听、无日志，下游全部
 * connection refused 却被误读成 API-key 问题」。本文件锁住三条真缺陷：
 *
 * 1. **close() 挂在在途 SSE socket 上**（原为 121s = keepAliveTimeout 120s + 1s）
 *    —— `server.close()` 的回调只在所有 socket 关闭后才触发，而 `abort()` 只停
 *    业务逻辑、不主动断连；
 * 2. **close() 抛错会逃出 `applyGatewayDesiredState`** —— 把「关网关」变成一次
 *    失败操作，且后续重建被整段跳过；
 * 3. **并发收敛泄漏实例** —— 连点开关时事件序列为
 *    `close#1:begin → start#2 → close#1:end → start#3`，实例 #1 与 #2 同时活着，
 *    且 #1 关完之后没人再管它。
 *
 * 另有 issue 建议 ②：`running: false` 必须能区分「用户关的」与「起不来的」。
 */

const ENV_KEYS = [
  'DSH_OPENAI_GATEWAY_PORT', 'DSH_OPENAI_GATEWAY_HOST',
  'DSH_OPENAI_GATEWAY_API_KEY', 'DSH_OPENAI_GATEWAY_ENABLED',
  'DSH_JET_HUB_STATE_DIR',
] as const
let saved: Record<string, string | undefined>
let home: string
let logs: string[] = []

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const p = typeof a === 'object' && a !== null ? a.port : 0
      s.close(() => resolve(p))
    })
  })
}
async function settle(ms = 80): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, ms))
}

function makeContext() {
  return {
    logger: {
      info: (m: string) => { logs.push(`info:${m}`) },
      warn: (m: string) => { logs.push(`warn:${m}`) },
      error: (m: string) => { logs.push(`error:${m}`) },
    },
    llm: {
      listProviders: () => ['fake'],
      listModels: async () => [{ id: 'fake-model', name: 'fake' }],
      resolveModelInfo: async () => ({ id: 'fake-model' }),
      async *stream(options: { signal?: AbortSignal }) {
        yield { type: 'text-delta', text: 'hi' }
        await new Promise<void>((resolve) => {
          const s = options?.signal
          if (s === undefined) return
          if (s.aborted) return resolve()
          s.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    },
    get: () => undefined,
    effect: () => () => {},
  }
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  home = mkdtempSync(join(tmpdir(), 'dsh-fix11-'))
  process.env.DSH_JET_HUB_STATE_DIR = home
  process.env.DSH_OPENAI_GATEWAY_API_KEY = 'fix11-key'
  delete process.env.DSH_OPENAI_GATEWAY_PORT
  delete process.env.DSH_OPENAI_GATEWAY_HOST
  delete process.env.DSH_OPENAI_GATEWAY_ENABLED
  logs = []
})
afterEach(async () => {
  await disposeGatewayRuntime().catch(() => {})
  for (const k of ENV_KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
})

describe('修复验证：Issue #11', () => {
  it('★ 缺陷1：在途流式请求下 close() 必须快速返回（原为 121s）', async () => {
    const port = await freePort()
    process.env.DSH_OPENAI_GATEWAY_PORT = String(port)
    mountOpenAiGateway(makeContext() as never, { gatewayEnabled: () => true, gatewayAllowLan: () => false })
    await settle()
    const runtime = await import('../../src/openai-gateway/runtime.js')
    expect(runtime.isGatewayRunning()).toBe(true)

    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const req = request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      agent, timeout: 30000,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.DSH_OPENAI_GATEWAY_API_KEY}`,
      },
    }, (res) => { res.resume() })
    req.on('error', () => {})
    req.end(JSON.stringify({ model: 'fake/fake-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }))
    await new Promise((r) => setTimeout(r, 500))

    logs = []
    runtime.setGatewayDesiredAllowLan(true)
    const t0 = Date.now()
    let done = false
    void runtime.applyGatewayDesiredState().then(() => { done = true })
    await Promise.race([
      new Promise<void>((r) => { const i = setInterval(() => { if (done) { clearInterval(i); r() } }, 20) }),
      new Promise((r) => setTimeout(r, 10000)),
    ])
    const elapsed = Date.now() - t0

    // 必须远小于 120s；宽限是 250ms，加上重建开销给 3s 余量
    expect(done).toBe(true)
    expect(elapsed).toBeLessThan(3000)
    // 换绑必须真的成功
    expect(runtime.isGatewayRunning()).toBe(true)
    expect(runtime.gatewayAddress()?.host).toBe('0.0.0.0')
    // ⚠️ 这里**不再**断言「强制断开」——2026-10-26 加了 `CLOSE_IDLE_POLL_MS`
    // 轮询后，本用例的流**守 abort**（abort 后立即收尾）⇒ socket 会在宽限窗口内
    // 变 idle 被回收 ⇒ **根本走不到强制断开**（那是修复生效的证据）。
    // 「强制断开」这条腿由下面「流完全无视 abort」的用例单独锁住。

    agent.destroy(); req.destroy()
  }, 40000)

  it('★ 缺陷1b：无在途请求时不应打印「强制断开」（避免噪声）', async () => {
    const port = await freePort()
    process.env.DSH_OPENAI_GATEWAY_PORT = String(port)
    mountOpenAiGateway(makeContext() as never, { gatewayEnabled: () => true, gatewayAllowLan: () => false })
    await settle()
    const runtime = await import('../../src/openai-gateway/runtime.js')
    logs = []
    runtime.setGatewayDesiredAllowLan(true)
    await runtime.applyGatewayDesiredState()
    expect(logs.some((l) => l.includes('强制断开'))).toBe(false)
    expect(runtime.isGatewayRunning()).toBe(true)
  }, 30000)

  it('★ 缺陷2：close() 抛错不得逃出 applyGatewayDesiredState', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    let startCalls = 0
    const fake = {
      async start() { startCalls += 1 },
      async close() { throw new Error('close boom') },
      address() { return { host: '127.0.0.1', port: 8326 } },
      apiKey: null,
    }
    runtime.registerGatewayFactory(() => fake as never)
    runtime.setGatewayDesiredEnabled(true)
    await runtime.applyGatewayDesiredState()
    expect(runtime.isGatewayRunning()).toBe(true)

    runtime.setGatewayDesiredEnabled(false)
    // 关键：不得抛出
    await expect(runtime.applyGatewayDesiredState()).resolves.toBeUndefined()

    // 再打开必须能重建（原实现会跳过）
    runtime.setGatewayDesiredEnabled(true)
    await runtime.applyGatewayDesiredState()
    expect(runtime.isGatewayRunning()).toBe(true)
    expect(startCalls).toBe(2)
  }, 20000)

  it('★ 缺陷3：并发收敛不得泄漏实例', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    const events: string[] = []
    let n = 0
    runtime.registerGatewayFactory((() => {
      const id = ++n
      return {
        async start() { events.push(`start#${id}`) },
        // ⚠️ 换绑现在走 `detachListen()` 交端口 + 后台 `close({drainActiveMs})`
        // 排水（IKQODR 缺陷 2）⇒ 假实例**必须**实现 detachListen，否则那条腿被
        // try/catch 静默跳过，事件序列里就看不到「交出端口」这一步。
        detachListen() { events.push(`detach#${id}`) },
        async close() {
          events.push(`close#${id}:begin`)
          await new Promise((r) => setTimeout(r, 100))
          events.push(`close#${id}:end`)
        },
        address() { return { host: '127.0.0.1', port: 8326 } },
        apiKey: null,
      }
    }) as never)
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(false)
    await runtime.applyGatewayDesiredState()
    events.length = 0
    const before = n

    // ⚠️ 必须让**第一次收敛真正进入 close() 窗口**后再翻第二次，否则两次调用
    // 会被「重读期望态」合并成一次早退（事件序列为空 ⇒ 用例无牙）。
    runtime.setGatewayDesiredAllowLan(true)
    const p1 = runtime.applyGatewayDesiredState()
    // 10ms 足够让 p1 走到 close#N:begin（close 内部 sleep 100ms）
    await new Promise((r) => setTimeout(r, 10))
    runtime.setGatewayDesiredAllowLan(false)
    const p2 = runtime.applyGatewayDesiredState()
    await Promise.allSettled([p1, p2])


    // ⚠️ 判据必须是**「两个实例绝不重叠」**，而不是数个数。
    //
    // 原 bug 的序列是 `close#1:begin → start#2 → close#1:end → start#3` ——
    // 注意 `start#2` 出现在 `close#1:end` **之前** ⇒ 实例 #1 与 #2 同时活着，
    // 而 #1 的 close 完成后没人再管它（`running` 已指向 #3）⇒ 永久泄漏。
    // 只数 start/close 的次数**抓不到它**（原 bug 下 start=2、close=1，
    // 而 `close >= start - 1` 恰好成立 ⇒ 恒真）。
    //
    // ⚠️ 判据更新（IKQODR 缺陷 2 之后）：换绑**不再等** close 完成，而是
    // 「detachListen 交端口 → 新实例立刻 start → 旧实例后台排水」⇒ 旧实例的
    // `close#N:end` 出现在 `start#N+1` 之后是**设计如此**，不是泄漏。
    //
    // 真正的泄漏判据变成：**旧实例是否交出了端口**。没 detach 就让新实例起来
    // （或旧实例压根没人管）才是泄漏 —— 那会让两个实例同时持有监听。
    const firstStartOf = (id: number): number => events.indexOf(`start#${id}`)
    const detachOf = (id: number): number => events.indexOf(`detach#${id}`)
    const closeBeginOf = (id: number): number => events.indexOf(`close#${id}:begin`)
    let overlaps = 0
    for (let id = 2; id <= n; id += 1) {
      const started = firstStartOf(id)
      // 前一个实例必须在后一个 start **之前**交出端口（detach），且它的排水
      // 必须已经发起（close:begin）—— 两者缺一都说明旧实例没人管。
      const prevDetached = detachOf(id - 1)
      const prevClosing = closeBeginOf(id - 1)
      if (started === -1) continue
      if (prevDetached === -1 || prevClosing === -1) { overlaps += 1; continue }
      if (prevDetached > started || prevClosing > started) { overlaps += 1; continue }
    }
    expect(overlaps).toBe(0)

    // 最终状态必须与最后的期望（关 = 回环）一致。
    expect(runtime.isGatewayRunning()).toBe(true)
    expect(runtime.gatewayAddress()?.host).toBe('127.0.0.1')
  }, 20000)

  it('★ 建议②：启动失败必须留下 lastError 与 error 日志', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    runtime.registerGatewayFactory((() => ({
      async start() { throw new Error('listen EADDRINUSE: address already in use') },
      async close() {},
      address() { return { host: '0.0.0.0', port: 8326 } },
      apiKey: null,
    })) as never)
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(true)
    logs = []
    const errors: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
    try {
      await runtime.applyGatewayDesiredState()
    } finally { console.error = origError }


    expect(runtime.isGatewayRunning()).toBe(false)
    expect(gatewayLastError()).not.toBeNull()
    expect(gatewayLastError()!.kind).toBe('start-failed')
    expect(gatewayLastError()!.reason).toContain('EADDRINUSE')
    expect(errors.some((e) => e.includes('期望运行但未能监听'))).toBe(true)
  }, 20000)

  it('★ 建议②：主动关闭不得被误报成失败', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    runtime.registerGatewayFactory((() => ({
      async start() {},
      async close() {},
      address() { return { host: '127.0.0.1', port: 8326 } },
      apiKey: null,
    })) as never)
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(false)
    await runtime.applyGatewayDesiredState()
    expect(runtime.isGatewayRunning()).toBe(true)

    runtime.setGatewayDesiredEnabled(false)
    await runtime.applyGatewayDesiredState()
    expect(runtime.isGatewayRunning()).toBe(false)
    // 用户自己关的 ⇒ 不是错误
    expect(gatewayLastError()).toBeNull()
  }, 20000)

  /**
   * ★★ 对抗审计发现的 P1：串行化的代价是「一次永不完成的收敛会永久卡死队列」，
   * 而卡死后**没有任何自愈路径**（`disposeGatewayRuntime` 只挂在插件卸载上，
   * 生产路径里没人调）。实测：`close()` 不返回 ⇒ 用户反复点开关也永远
   * `running: false`，且无错误可查 —— 比原 bug 更糟（原 bug 至少 120s 后自愈）。
   *
   * 修法两层：`close()` 内部给「强制断开后的等待」加 CLOSE_DRAIN_MS 上限，
   * 收敛队列再加一个 CONVERGENCE_WATCHDOG_MS 看门狗兜底。
   */
  it('★★ 看门狗：一次收敛永不完成时，后续开关操作不得被永久阻塞', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    runtime.registerGatewayFactory((() => ({
      async start() {},
      // 永不 resolve：模拟底层 close 回调不触发的极端情况
      close() { return new Promise<void>(() => {}) },
      address() { return { host: '127.0.0.1', port: 8326 } },
      apiKey: null,
    })) as never)
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(false)
    await runtime.applyGatewayDesiredState()
    expect(runtime.isGatewayRunning()).toBe(true)

    // 制造卡死
    runtime.setGatewayDesiredEnabled(false)
    void runtime.applyGatewayDesiredState()
    await new Promise((r) => setTimeout(r, 200))

    // ⚠️ 对照（证明下面那条不是恒真）：看门狗未到点时，队列**确实**在阻塞。
    runtime.registerGatewayFactory((() => ({
      async start() {},
      async close() {},
      address() { return { host: '127.0.0.1', port: 8326 } },
      apiKey: null,
    })) as never)
    runtime.setGatewayDesiredEnabled(true)
    let blocked = false
    void runtime.applyGatewayDesiredState().then(() => { blocked = true })
    await new Promise((r) => setTimeout(r, 800))
    expect(blocked).toBe(false)

    // 等看门狗（15s）触发后，恢复能力必须回来
    await new Promise((r) => setTimeout(r, 15_500))
    let recovered = false
    void runtime.applyGatewayDesiredState().then(() => { recovered = true })
    await new Promise((r) => setTimeout(r, 1200))
    expect(recovered).toBe(true)
    expect(runtime.isGatewayRunning()).toBe(true)
  }, 40_000)

  /**
   * ★★ 对抗审计第二轮打穿的形态：**「不再等待」≠「真的生效」**。
   *
   * 上一版看门狗只把 `convergenceQueue` 置空，但已排在前者后面的调用仍挂在
   * `previous.then(...)` 上（`previous` 是永不 resolve 的 Promise）。实测：
   * 看门狗后 `applyGatewayDesiredState()` 确实「完成」了，但 `factoryCalls`
   * 没增加、`running` 仍是 false ⇒ **收敛体压根没执行**，用户点开关依旧无效。
   *
   * 判据必须是「收敛体真的跑了」（`factoryCalls` 增加 + `running` 变 true），
   * **不能只断言 Promise 完成** —— 后者在「只是不再等待」的实现下也成立（无牙）。
   *
   * ⚠️ **变异验证实测（如实登记）**：当前实现有**两道**冗余保护 ——
   * ① 看门狗到点清空 `convergenceQueue`；② 排队路径自带超时后自己收敛。
   * 只去掉 ① 或只去掉 ②，本用例**仍然通过**（另一道兜住了）⇒ **单条变异无牙**。
   * 只有**同时**去掉两者才变红（已实测）。因此本用例锁的是「组合行为」，
   * 不能用来单独证明任何一条机制存在 —— 单独证明见上面的「看门狗」用例。
   */
  it('★★ 卡死后重试必须真的重新收敛（不是「不再等待」）', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    let factoryCalls = 0
    let hangClose = true
    runtime.registerGatewayFactory((() => {
      factoryCalls += 1
      return {
        async start() {},
        close() {
          if (hangClose) return new Promise<void>(() => {})
          return Promise.resolve()
        },
        address() { return { host: '127.0.0.1', port: 8326 } },
        apiKey: null,
      }
    }) as never)
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(false)
    await runtime.applyGatewayDesiredState()
    expect(runtime.isGatewayRunning()).toBe(true)

    // 换绑卡死；⚠️ 期望态仍是「开」（真实用户场景：他还要用网关）
    runtime.setGatewayDesiredAllowLan(true)
    void runtime.applyGatewayDesiredState()
    await new Promise((r) => setTimeout(r, 200))
    hangClose = false

    // 等看门狗放开，然后重试
    await new Promise((r) => setTimeout(r, 15_500))
    const before = factoryCalls
    void runtime.applyGatewayDesiredState()
    await new Promise((r) => setTimeout(r, 1500))

    expect(factoryCalls).toBeGreaterThan(before)
    expect(runtime.isGatewayRunning()).toBe(true)
  }, 45_000)

  /**
   * ★★ 对抗审计发现：换绑/关闭时正在跑的流，客户端**拿不到协议要求的终止帧**。
   *
   * 根因：`handleChat` 的 `if (signal.aborted || response.destroyed) break` 之后
   * 直接 `response.end()`，跳过了 `toOpenAiSse` 末尾的 `data: [DONE]`。实测（审计
   * RST）：客户端事件是 `["status:200","end"]` —— 看着像「干净结束」—— 但 body
   * 里**没有 `[DONE]`**。严格按 OpenAI 协议解析的客户端（等 `[DONE]` 判结束）
   * 会把这次中止当成**异常截断**。
   *
   * `/v1/responses` 同族但协议不同（以 `response.completed`/`response.failed`
   * 结束，不发 `[DONE]`），也一并补了终止事件 —— 用 `response.failed` 而不是
   * `completed`，因为本轮确实被取消，谎报完成会让客户端把半截输出持久化。
   */
  it('★★ 换绑中止在途流时，客户端必须收到协议终止帧', async () => {
    const { createOpenAiGateway } = await import('../../src/openai-gateway/server.js')
    const home = mkdtempSync(join(tmpdir(), 'gw-lifecycle-done-'))
    const port = await freePort()
    const gateway = createOpenAiGateway({
      home,
      env: { ...process.env, DSH_OPENAI_GATEWAY_API_KEY: 'k', DSH_OPENAI_GATEWAY_PORT: String(port) },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      llm: {
        listProviders: () => ['fake'],
        listModels: async () => [{ id: 'fake-model', name: 'fake' }],
        resolveModelInfo: async () => ({ id: 'fake-model' }),
        async *stream(options: { signal?: AbortSignal }) {
          yield { type: 'text-delta', text: 'hello' } as never
          await new Promise<void>((resolve) => {
            const s = options?.signal
            if (s === undefined) return
            if (s.aborted) return resolve()
            s.addEventListener('abort', () => resolve(), { once: true })
          })
        },
      } as never,
    })
    try {
      await gateway.start()
      const collect = (path: string): { done: Promise<string> } => {
        let raw = ''
        const done = new Promise<string>((resolve) => {
          const req = request({
            host: '127.0.0.1', port, path, method: 'POST', timeout: 20000,
            headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
          }, (res) => {
            res.setEncoding('utf8')
            res.on('data', (c: string) => { raw += c })
            res.on('end', () => resolve(raw))
            res.on('aborted', () => resolve(raw))
            res.on('error', () => resolve(raw))
          })
          req.on('error', () => resolve(raw))
          req.end(JSON.stringify({
            model: 'fake/fake-model', stream: true, input: 'hi',
            messages: [{ role: 'user', content: 'hi' }],
          }))
        })
        return { done }
      }

      const chat = collect('/v1/chat/completions')
      const resp = collect('/v1/responses')
      await new Promise((r) => setTimeout(r, 250))
      await gateway.close()

      const chatBody = await chat.done
      const respBody = await resp.done
      // Chat Completions 的收尾约定是 `data: [DONE]`
      expect(chatBody).toContain('[DONE]')
      // Responses 的收尾是事件，不是 [DONE]；中止时必须是 failed（不得谎报 completed）
      expect(respBody).toContain('response.failed')
      expect(respBody).not.toContain('response.completed')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  /**
   * ★★ 审计打穿的「零守卫腿」：`lastError` 的**清理**有三条可达路径，删掉任一条
   * 6 条新守卫 + 面板 111 条**全绿**（审计逐条插桩证明可达性）。
   *
   * 每条用例的形态统一为：**先造出非 null 的 lastError，再走该路径，断言被清掉**。
   * ⚠️ 顺序不能反（「先成功 → 再关闭 → 断言 null」是**恒真**的：成功路径已把它
   * 清成 null，被测的那行删掉照样过 —— 审计实测 M5 就是这么无牙的）。
   */
  it('★★ lastError 清理腿：成功启动后必须清掉上一轮的失败痕迹', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    let fail = true
    runtime.registerGatewayFactory((() => ({
      async start() { if (fail) throw new Error('boom-once') },
      async close() {},
      address() { return { host: '127.0.0.1', port: 8326 } },
      apiKey: null,
    })) as never)
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(false)
    await runtime.applyGatewayDesiredState()
    // 先造出失败痕迹（这条断言本身也被「建议②」用例守着）
    expect(runtime.gatewayLastError()?.reason).toContain('boom-once')

    // 再让 start 成功 ⇒ 成功路径必须把它清掉
    fail = false
    await runtime.applyGatewayDesiredState()
    expect(runtime.isGatewayRunning()).toBe(true)
    expect(runtime.gatewayLastError()).toBeNull()
  }, 20_000)

  it('★★ lastError 清理腿：主动关闭（无实例早退）必须清掉失败痕迹', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    // 先造失败（factory-missing：不注册工厂）
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(true)
    await runtime.applyGatewayDesiredState()
    expect(runtime.gatewayLastError()?.kind).toBe('factory-missing')

    // 再主动关闭 ⇒ 走「shouldRun=false 且 running===undefined」的早退分支，必须清
    runtime.setGatewayDesiredEnabled(false)
    await runtime.applyGatewayDesiredState()
    expect(runtime.gatewayLastError()).toBeNull()
  }, 20_000)

  it('★★ lastError 清理腿：dispose 必须清掉上一轮的失败痕迹（跨热重载残留）', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    // ⚠️ 必须**显式**制造失败，不能靠「没注册工厂」——`factory` 是模块级单例，
    // 前一个用例注册的工厂会留下来 ⇒ `factory-missing` 不成立、`lastError` 是
    // null ⇒ 本用例变成恒真（实测：单跑绿、连跑红，正是这个原因）。
    // 用「start 抛错」制造**与工厂是否存在无关**的失败痕迹。
    runtime.registerGatewayFactory((() => ({
      async start() { throw new Error('dispose-leg-boom') },
      async close() {},
      address() { return { host: '127.0.0.1', port: 8326 } },
      apiKey: null,
    })) as never)
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(false)
    await runtime.applyGatewayDesiredState()
    // 前置断言：失败痕迹确实存在（否则下面的 `toBeNull` 是恒真）
    expect(runtime.gatewayLastError()?.reason).toContain('dispose-leg-boom')

    await runtime.disposeGatewayRuntime()
    expect(runtime.gatewayLastError()).toBeNull()
  }, 20_000)

  it('★ lastError 的 kind 枚举：factory-missing 必须能被区分出来', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    // ⚠️ `disposeGatewayRuntime()` 会清空 `factory`（模块级单例），这是**唯一**
    // 能可靠构造 `factory-missing` 的方式 —— 不能假设前一个用例的状态。
    await runtime.disposeGatewayRuntime()
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(true)
    await runtime.applyGatewayDesiredState()
    const err = runtime.gatewayLastError()
    expect(err).not.toBeNull()
    // ⚠️ 这个枚举值此前**从未被任何用例断言过**（审计 P2-1）。
    expect(err!.kind).toBe('factory-missing')
    expect(err!.reason).toContain('工厂')
    // `at` 时间戳必须存在（dispose 的清腿判据依赖它）
    expect(typeof err!.at).toBe('number')
  }, 20_000)

  /**
   * ★★ 审计 P0-1：`close()` 强制断开后的等待**必须**有上限。
   *
   * 可达路径（不是理论）：`closeAllConnections` 不可用时退到
   * `closeIdleConnections()`，而**本仓自己的对照实验已实测它对在途 SSE socket
   * 无效（永不返回）**。修复前那里是裸 `await settled` ⇒ `close()` 永不返回
   * ⇒ 收敛队列永久卡死（实测：6s 后仍未完成、第二次收敛也不完成），
   * 而 `disposeGatewayRuntime` 只在插件卸载时调 ⇒ **生产无自愈入口**。
   * 这比原 bug 更糟（原 bug 120s 后自愈）。
   */
  it('★★ fallback 分支（无 closeAllConnections）+ 无视 abort ⇒ close 必须有界', async () => {
    const { createOpenAiGateway } = await import('../../src/openai-gateway/server.js')
    const http = await import('node:http')
    const origCloseAll = http.Server.prototype.closeAllConnections
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(http.Server.prototype as any).closeAllConnections = undefined
    const home = mkdtempSync(join(tmpdir(), 'gw-lifecycle-fallback-'))
    try {
      const port = await freePort()
      const gateway = createOpenAiGateway({
        home,
        env: { ...process.env, DSH_OPENAI_GATEWAY_API_KEY: 'k', DSH_OPENAI_GATEWAY_PORT: String(port) },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        llm: {
          listProviders: () => ['fake'],
          listModels: async () => [{ id: 'fake-model', name: 'fake' }],
          resolveModelInfo: async () => ({ id: 'fake-model' }),
          async *stream() {
            yield { type: 'text-delta', text: 'hi' } as never
            // ⚠️ 完全无视 abort：最坏情况
            await new Promise<void>(() => {})
          },
        } as never,
      })
      await gateway.start()

      const agent = new Agent({ keepAlive: true, maxSockets: 1 })
      const req = request({
        host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', agent, timeout: 60000,
        headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      }, (res) => { res.resume() })
      req.on('error', () => {})
      req.end(JSON.stringify({ model: 'fake/fake-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }))
      await new Promise((r) => setTimeout(r, 400))

      const t0 = Date.now()
      let done = false
      void gateway.close().then(() => { done = true })
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 100))
        if (done) break
      }
      const elapsed = Date.now() - t0
      agent.destroy(); req.destroy()

      expect(done).toBe(true)
      // CLOSE_GRACE_MS(250) + CLOSE_DRAIN_MS(1000) + 余量
      expect(elapsed).toBeLessThan(3000)
    } finally {
      http.Server.prototype.closeAllConnections = origCloseAll
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  /**
   * ★★ 宽限窗口必须**真的**生效（2026-10-26 审计打穿「写了等于没写」）。
   *
   * 审计实测：`CLOSE_GRACE_MS = 0` 与 `= 250` 的客户端输出**逐字节相同**
   * （4979527B / `err=null` / `ended=true`）⇒ 那 250ms 是**纯延迟**，
   * 每一次带在途连接的 close 都必然走到强制断开，注释里「绝大多数情况在这里
   * 就完事」「避免连接重置」两句都不成立。
   *
   * 根因：`server.close()` 返回前**自己**调的那次 `closeIdleConnections()` 落在
   * 「响应还在写」的时刻（`response.end()` 在 `close()` 之后几毫秒）⇒ socket 不算
   * idle ⇒ 无效；此后上一版代码再也不调，只能干等超时。
   *
   * 修法：宽限期内每 `CLOSE_IDLE_POLL_MS`(20ms) 轮询一次 + 首个 tick 前手动补扫。
   */
  it('★★ 流在宽限内收尾时必须**不**强制断开（轮询让宽限真正生效）', async () => {
    const { createOpenAiGateway } = await import('../../src/openai-gateway/server.js')
    const home = mkdtempSync(join(tmpdir(), 'gw-lifecycle-grace-'))
    const warns: string[] = []
    try {
      const port = await freePort()
      const gateway = createOpenAiGateway({
        home,
        env: { ...process.env, DSH_OPENAI_GATEWAY_API_KEY: 'k', DSH_OPENAI_GATEWAY_PORT: String(port) },
        logger: {
          info: () => {},
          warn: (m: string) => { warns.push(m) },
          error: () => {},
        },
        llm: {
          listProviders: () => ['fake'],
          listModels: async () => [{ id: 'fake-model', name: 'fake' }],
          resolveModelInfo: async () => ({ id: 'fake-model' }),
          async *stream(options: { signal?: AbortSignal }) {
            yield { type: 'text-delta', text: 'hello' } as never
            // abort 后 50ms 收尾 —— 远早于 250ms 宽限
            await new Promise<void>((resolve) => {
              const s = options?.signal
              if (s === undefined) return
              if (s.aborted) return resolve()
              s.addEventListener('abort', () => resolve(), { once: true })
            })
            await new Promise<void>((r) => setTimeout(r, 50))
          },
        } as never,
      })
      await gateway.start()

      const probe = request({
        host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', timeout: 20000,
        headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      }, (res) => { res.resume() })
      probe.on('error', () => {})
      probe.end(JSON.stringify({ model: 'fake/fake-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }))
      await new Promise((r) => setTimeout(r, 200))

      const t0 = Date.now()
      await gateway.close()
      const elapsed = Date.now() - t0
      probe.destroy()

      // ⚠️ 修复前这里是 true（审计实测：每一次都强制断开）
      expect(warns.some((w) => w.includes('强制断开'))).toBe(false)
      // 且必须明显快于「干等满 250ms 再强制断开」
      expect(elapsed).toBeLessThan(250)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  /**
   * ★ 反向对照：轮询**救不了**「根本不收尾」的连接 —— 强制断开这条腿必须保留。
   *
   * ⚠️ 没有这条，把 `closeAllConnections()` 整段删掉也不会红（缺陷1 只看
   * 「快速返回」，而轮询会让它快速返回）。
   */
  it('★ 流完全无视 abort 时仍必须强制断开（轮询不得取代强制断开）', async () => {
    const { createOpenAiGateway } = await import('../../src/openai-gateway/server.js')
    const home = mkdtempSync(join(tmpdir(), 'gw-lifecycle-noabort-'))
    const warns: string[] = []
    try {
      const port = await freePort()
      const gateway = createOpenAiGateway({
        home,
        env: { ...process.env, DSH_OPENAI_GATEWAY_API_KEY: 'k', DSH_OPENAI_GATEWAY_PORT: String(port) },
        logger: {
          info: () => {},
          warn: (m: string) => { warns.push(m) },
          error: () => {},
        },
        llm: {
          listProviders: () => ['fake'],
          listModels: async () => [{ id: 'fake-model', name: 'fake' }],
          resolveModelInfo: async () => ({ id: 'fake-model' }),
          async *stream() {
            yield { type: 'text-delta', text: 'hi' } as never
            // 完全无视 abort
            await new Promise<void>(() => {})
          },
        } as never,
      })
      await gateway.start()
      const agent = new Agent({ keepAlive: true, maxSockets: 1 })
      const req = request({
        host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', agent, timeout: 30000,
        headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      }, (res) => { res.resume() })
      req.on('error', () => {})
      req.end(JSON.stringify({ model: 'fake/fake-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }))
      await new Promise((r) => setTimeout(r, 300))

      const t0 = Date.now()
      await gateway.close()
      const elapsed = Date.now() - t0
      agent.destroy(); req.destroy()

      expect(warns.some((w) => w.includes('强制断开'))).toBe(true)
      expect(elapsed).toBeLessThan(3000)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
})
