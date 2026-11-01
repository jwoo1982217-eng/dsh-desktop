import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
// ⚠️⚠️ **必须从 `node:http` 导入 `Server`**（不是 `node:net`）：`closeIdleConnections`
// 定义在 **`http.Server.prototype`** 上（空闲连接是 HTTP 概念）。从 `node:net` 导入
// 再 patch 只会给 `net.Server.prototype` 加一个**没人调用**的新属性 ⇒ 计数器恒为 0
// ⇒ 守卫**恒真**。这一格实测踩过：第一版就是 `node:net`，变异（finally 里不清理）
// 时"增量 = 0"看起来像修好了，实际是计数器根本没生效。
import { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOpenAiGateway, CLOSE_DRAIN_ACTIVE_MS } from '../../src/openai-gateway/server.js'

/**
 * Gitee issue IKQODR 的两个缺陷的回归锁。
 *
 * ## 缺陷 1（严重、100% 命中）：正常结束也补发失败帧
 *
 * `/v1/responses` 的流式出口在 `for await` 之后**无条件**补发 `response.failed`，
 * 而「自然收尾」时 `response.writableEnded` 同样是 `false`（还没调 `end()`）
 * ⇒ 每一次**成功**的请求都被追加一条失败事件，客户端把完整收到的一轮判为失败，
 * 且文案谎称「网关已关闭」而网关根本没关。同源：`/v1/chat/completions` 会发
 * **两个** `data: [DONE]`（`toOpenAiSse` 自己已发过一条）。
 *
 * ⚠️ 这个坑的教训：原注释写的是「被 abort 时补发」——读起来像条件已经存在，
 * 而代码里没有。**注释描述意图，不等于实现了意图。**
 *
 * ## 缺陷 2（中等）：换绑砍断在途 + 空窗期拒连
 *
 * 原先 `close()` 第一行就 `abort()`，而换绑是「先 `await close()`、再起新实例」
 * ⇒ ① 在途流被砍（实测 6 帧只收到 3 帧）；② 空窗期下游 `ECONNREFUSED`。
 * 修法：`detachListen()` 先交端口 → 新实例接管 → 旧实例**后台排水**
 * （`close({ drainActiveMs })`），并保留「用户主动关网关 = 立即中断」的语义。
 */

let home: string

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

/** 上游流：每 100ms 一帧，共 6 帧（约 600ms，远长于 250ms 宽限）。 */
function makeGateway(port: number) {
  return createOpenAiGateway({
    home,
    env: { ...process.env, DSH_OPENAI_GATEWAY_API_KEY: 'k', DSH_OPENAI_GATEWAY_PORT: String(port) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llm: {
      listProviders: () => ['fake'],
      listModels: async () => [{ id: 'fake-model', name: 'fake' }],
      resolveModelInfo: async () => ({ id: 'fake-model' }),
      async *stream(options: { signal?: AbortSignal }) {
        for (let i = 1; i <= 6; i += 1) {
          if (options?.signal?.aborted === true) return
          yield { type: 'text-delta', text: `chunk${i} ` } as never
          await new Promise<void>((r) => setTimeout(r, 100))
        }
        yield { type: 'finish', reason: { kind: 'stop' } } as never
      },
    } as never,
  })
}

function openStream(port: number) {
  let received = ''
  const done = new Promise<void>((resolve) => {
    const req = request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', timeout: 30000,
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
    }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (c: string) => { received += c })
      res.on('end', () => resolve())
      res.on('error', () => resolve())
      res.on('aborted', () => resolve())
    })
    req.on('error', () => resolve())
    req.end(JSON.stringify({ model: 'fake/fake-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }))
  })
  return { done, get received() { return received } }
}

beforeEach(() => { delete process.env.DSH_OPENAI_GATEWAY_ENABLED; home = mkdtempSync(join(tmpdir(), 'ikqodr-fix2-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

/**
 * ## ⚠️ 缺陷 1 的回归锁（本组）——「严重、100% 命中」的那个
 *
 * 审计打穿了一条**承诺与事实不符**：早先的提交信息声称「缺陷 1 有两条用例」，
 * 但那两条是我用**临时** spec 验证后删掉的，**永久守卫里一条都没有**。
 * 审计实测：把两处 `if (interrupted && …)` 还原成无条件（= 复现缺陷 1）⇒
 * 跑全量 18 个网关文件 **521 条全绿 0 failed** ⇒ 这个「每一轮都中招」的缺陷
 * 以后会**静默复发**。
 *
 * ⇒ 本组把两条锁补进永久守卫。**判据必须能区分「正常收尾」与「被打断」**：
 * - 正常收尾：`toResponsesSse` / `toOpenAiSse` **自己**已发过终止事件
 *   ⇒ 不得再补；chat 的 `[DONE]` 计数必须**恰为 1**；
 * - 被打断（换绑/关闭）：流里没有任何终止事件 ⇒ **必须**补。
 *
 * 两半都要有，否则「无条件补发」（缺陷 1）与「永不补发」（另一种缺陷）会各绿一半。
 */
describe('IKQODR 缺陷1：正常结束不得补发终止帧（零守卫补锁）', () => {
  /** 上游：正常吐完就结束（**不** abort、**不**报错）。 */
  const makeNormal = (port: number, home: string) => createOpenAiGateway({
    home,
    env: { ...process.env, DSH_OPENAI_GATEWAY_API_KEY: 'k', DSH_OPENAI_GATEWAY_PORT: String(port) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llm: {
      listProviders: () => ['fake'],
      listModels: async () => [{ id: 'fake-model', name: 'fake' }],
      resolveModelInfo: async () => ({ id: 'fake-model' }),
      async *stream() {
        yield { type: 'text-delta', text: 'hello' } as never
        yield { type: 'text-delta', text: ' world' } as never
        yield { type: 'finish', reason: { kind: 'stop' } } as never
      },
    } as never,
  })

  const postBody = (port: number, path: string): Promise<string> => new Promise((resolve) => {
    let raw = ''
    const req = request({
      host: '127.0.0.1', port, path, method: 'POST', timeout: 20000,
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
    }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (c: string) => { raw += c })
      res.on('end', () => resolve(raw))
      res.on('error', () => resolve(raw))
    })
    req.on('error', () => resolve(raw))
    req.end(JSON.stringify({
      model: 'fake/fake-model', stream: true, input: 'hi',
      messages: [{ role: 'user', content: 'hi' }],
    }))
  })

  it('★★ 正常结束的 /v1/responses ⇒ 末事件必须是 response.completed，**不得**出现 response.failed', async () => {
    const { createOpenAiGateway } = await import('../../src/openai-gateway/server.js')
    const home = mkdtempSync(join(tmpdir(), 'gw-d1a-'))
    try {
      const port = await freePort()
      const g = makeNormal(port, home)
      await g.start()
      const body = await postBody(port, '/v1/responses')
      await g.close({ drainActiveMs: 0 })

      const events = [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1])
      // ⚠️ 缺陷 1 的形态就是：completed 之后**紧跟**一条 failed
      expect(events.at(-1), `末事件应为 response.completed，实际 ${events.at(-1)}`).toBe('response.completed')
      expect(body, '正常结束的一轮被补发了 response.failed（缺陷 1 复发）').not.toContain('response.failed')
      expect(body, '文案谎称网关已关闭，而网关根本没关').not.toContain('网关已关闭')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  it('★★ 正常结束的 /v1/chat/completions ⇒ [DONE] 必须**恰为 1** 个', async () => {
    const { createOpenAiGateway } = await import('../../src/openai-gateway/server.js')
    const home = mkdtempSync(join(tmpdir(), 'gw-d1b-'))
    try {
      const port = await freePort()
      const g = makeNormal(port, home)
      await g.start()
      const body = await postBody(port, '/v1/chat/completions')
      await g.close({ drainActiveMs: 0 })

      const count = (body.match(/data: \[DONE\]/g) ?? []).length
      // ⚠️ 缺陷 1 同源形态：2 个（`toOpenAiSse` 自己已发过一条）
      expect(count, '重复的 [DONE] 会让严格解析的客户端判成异常收尾').toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('IKQODR 缺陷2 修复验收', () => {
  it('★★ detachListen 后旧实例在途流仍能跑完（6/6 帧）', async () => {
    const port = await freePort()
    const g = makeGateway(port)
    await g.start()
    const probe = openStream(port)
    await new Promise((r) => setTimeout(r, 250))
    const before = (probe.received.match(/chunk\d/g) ?? []).length
    console.log('[修2] detach 前已收到 =', before)

    // 交端口（换绑的第一步）
    g.detachListen()
    // 排水：给足窗口
    await g.close({ drainActiveMs: CLOSE_DRAIN_ACTIVE_MS })
    await probe.done
    const total = (probe.received.match(/chunk\d/g) ?? []).length
    console.log('[修2] 排水后总共收到 =', total, '（满额 6）')
    // ⚠️ 修复前实测只有 3 帧
    expect(total).toBe(6)
  }, 40000)

  it('★★ detachListen 后同端口可立即被新实例接管（空窗期≈0）', async () => {
    const port = await freePort()
    const g1 = makeGateway(port)
    await g1.start()
    g1.detachListen()
    // ⚠️ 立刻在同端口起新实例（不等待、不 sleep）
    const g2 = makeGateway(port)
    await g2.start()
    const addr = g2.address()
    console.log('[修2] 新实例接管 =', JSON.stringify(addr))
    expect(addr.port).toBe(port)
    // 物理判据：真的能连上（不是只回了配置字符串）
    const code = await new Promise<string>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/v1/models', method: 'GET', timeout: 3000 }, (res) => {
        res.resume(); resolve(`HTTP ${res.statusCode}`)
      })
      req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message))
      req.end()
    })
    console.log('[修2] 新实例可达性 =', code)
    expect(code).toBe('HTTP 401')
    await g2.close({ drainActiveMs: 0 })
  }, 40000)

  it('★ 用户主动关网关（drainActiveMs: 0）仍必须**立即**中断在途流', async () => {
    const port = await freePort()
    const g = makeGateway(port)
    await g.start()
    const probe = openStream(port)
    await new Promise((r) => setTimeout(r, 250))
    const before = (probe.received.match(/chunk\d/g) ?? []).length
    const t0 = Date.now()
    await g.close({ drainActiveMs: 0 })
    const elapsed = Date.now() - t0
    await probe.done
    const total = (probe.received.match(/chunk\d/g) ?? []).length
    console.log('[修2] 主动关：before =', before, '| total =', total, '| close 耗时 =', elapsed)
    // 语义不变：用户说「现在停」就是现在停 —— 不得等 6 帧跑完
    expect(total).toBeLessThan(6)
    expect(elapsed).toBeLessThan(2000)
  }, 40000)
})

/**
 * ★★ 换绑失败**必须重试**（自查发现的新失败模式）。
 *
 * 换绑的第一步 `detachListen()` 已经把**旧实例的端口交出去了**。此时若新实例
 * `start()` 失败（端口被外部进程抢、或内核尚未回收），网关就**完全没有监听**，
 * 而旧实例还在后台排水、不会自动恢复 —— **这比修复前更糟**（修复前旧实例至少
 * 还在监听）。
 *
 * 实测复现：`g1.detachListen()` → 外部占端口 → `g2.start()` 抛 `EADDRINUSE`
 * ⇒ 端口此刻 `EADDRINUSE`（既不是 g1 也不是 g2 在服务）。
 *
 * 修法：换绑路径（`replaced !== undefined`）首次 start 失败后**换新实例重试一次**
 * —— `detachListen()` 是同步释放端口的，第一次失败往往就是内核回收的极短窗口。
 */
describe('IKQODR：换绑失败必须重试（不留「无监听」状态）', () => {
  it('★★ 换绑时首次 start 失败 ⇒ 重试后必须仍在监听', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    let starts = 0
    let failNext = false
    runtime.registerGatewayFactory((() => ({
      async start() {
        starts += 1
        if (failNext) { failNext = false; throw new Error('listen EADDRINUSE (模拟)') }
      },
      detachListen() {},
      async close() {},
      address() { return { host: '127.0.0.1', port: 8326 } },
      apiKey: null,
    })) as never)
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(false)
    await runtime.applyGatewayDesiredState()
    expect(runtime.isGatewayRunning()).toBe(true)

    // 换绑 + 让首次 start 失败一次
    failNext = true
    const before = starts
    runtime.setGatewayDesiredAllowLan(true)
    await runtime.applyGatewayDesiredState()

    expect(runtime.isGatewayRunning()).toBe(true)
    // 首次失败 + 重试成功 ⇒ 至少 2 次
    expect(starts - before).toBeGreaterThanOrEqual(2)
  }, 20_000)

  it('★ 首次启动失败（非换绑）不得重试（没有旧实例要救）', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    // ⚠️ 必须从「干净状态」开始：前一个用例可能留下 running 实例，那样本轮会走
    // **换绑**分支（有旧实例要救）⇒ 重试是**正确**行为，本用例就变成测错对象。
    // 实测踩过：前一个用例的假实例 `address()` 恒返回回环地址，而期望态是
    // wildcard ⇒ 永远失配 ⇒ 每次收敛都走换绑分支 ⇒ starts 变 2（假红）。
    await runtime.disposeGatewayRuntime()
    let starts = 0
    runtime.registerGatewayFactory((() => ({
      async start() { starts += 1; throw new Error('boom') },
      detachListen() {},
      async close() {},
      address() { return { host: '127.0.0.1', port: 8326 } },
      apiKey: null,
    })) as never)
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(false)
    await runtime.applyGatewayDesiredState()
    expect(runtime.isGatewayRunning()).toBe(false)
    // ⚠️ 非换绑路径不该重试 —— 否则「端口被永久占用」会变成每次收敛都白发两发
    expect(starts).toBe(1)
  }, 20_000)
})

/**
 * ★★★ 对抗审计打穿的 P0/P1（换绑排水引入的**比原缺陷更糟**的失败模式）。
 *
 * ## P0：`detachListen()` 摘掉 `server` 句柄 ⇒ `close()` 失去唯一的强制断开手段
 *
 * 原修法把 `server = undefined`，于是已 detach 的实例走 `closeActiveOnly()` ——
 * **只 abort、不断连**。而 `abort()` 是**拉模型**：它只把 `signal.aborted` 置 true，
 * 网关要读到它，前提是**上游还能产帧**。上游一旦卡住（永不 resolve 的 await，
 * 例如 `LlmRuntime.listModels` 没有 signal 通道），就永远走不到检查点
 * ⇒ `active` 永不清空 ⇒ **socket 永不断开、客户端永久静默**。
 *
 * 审计实测（修复前基线对照）：
 * ```
 * 修复前基线：换绑 265ms 内强制断开，客户端 573ms 拿到 RST
 * 修复后    ：客户端 0 个响应头、永久静默（等满 20s 仍不断）
 *             而 close() 还打「已关闭」+「将中断剩余 N 个」两句谎话
 * ```
 *
 * ## 修法
 *
 * 拆成两个概念：`server` = 句柄（**detach 后仍保留**，它是 `closeAllConnections()`
 * 唯一抓手）；`listening` = 是否 accept 新连接（detach 后置 false）。
 * 并新增 `retired`：记住已摘除的句柄，让**再次 close** 也能强制断开（P1-b）。
 */
describe('IKQODR 对抗审计：detach 后必须仍能强制断开（P0/P1）', () => {
  /** 上游：吐一帧后**永远卡住**（完全无视 abort）—— 审计的「最现实路径」。 */
  const makeHanging = (port: number, home: string) => createOpenAiGateway({
    home,
    env: { ...process.env, DSH_OPENAI_GATEWAY_API_KEY: 'k', DSH_OPENAI_GATEWAY_PORT: String(port) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llm: {
      listProviders: () => ['fake'],
      listModels: async () => [{ id: 'fake-model', name: 'fake' }],
      resolveModelInfo: async () => ({ id: 'fake-model' }),
      async *stream() {
        yield { type: 'text-delta', text: 'hi' } as never
        await new Promise<void>(() => {})
      },
    } as never,
  })

  const openProbe = (port: number) => {
    const events: string[] = []
    const done = new Promise<void>((resolve) => {
      const req = request({
        host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', timeout: 30000,
        headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      }, (res) => {
        events.push(`status:${res.statusCode}`)
        res.resume()
        res.on('end', () => { events.push('end'); resolve() })
        res.on('aborted', () => { events.push('aborted'); resolve() })
        res.on('error', (e: NodeJS.ErrnoException) => { events.push(`err:${e.code}`); resolve() })
      })
      req.on('error', (e: NodeJS.ErrnoException) => { events.push(`req-err:${e.code}`); resolve() })
      req.end(JSON.stringify({ model: 'fake/fake-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }))
    })
    return { events, done }
  }

  const releasedWithin = (p: { done: Promise<void> }, ms: number): Promise<boolean> =>
    Promise.race([p.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])

  it('★★ P0：detach + close({drain:0}) + 上游卡死 ⇒ 客户端必须被强制释放', async () => {
    const { createOpenAiGateway } = await import('../../src/openai-gateway/server.js')
    const home = mkdtempSync(join(tmpdir(), 'gw-p0-'))
    try {
      const port = await freePort()
      const g = makeHanging(port, home)
      await g.start()
      const p = openProbe(port)
      await new Promise((r) => setTimeout(r, 300))

      g.detachListen()
      await g.close({ drainActiveMs: 0 })

      const released = await releasedWithin(p, 3000)
      // ⚠️ 修复前实测：false（永久静默）、events 只有/没有 status
      expect(released, 'detach 后 close 未能断开 socket ⇒ 客户端永久静默').toBe(true)
      expect(p.events.some((e) => e.startsWith('status:'))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 40_000)

  it('★★ P1-a：排水超时后必须**真的**断开（不是只打日志）', async () => {
    const { createOpenAiGateway } = await import('../../src/openai-gateway/server.js')
    const home = mkdtempSync(join(tmpdir(), 'gw-p1a-'))
    try {
      const port = await freePort()
      const g = makeHanging(port, home)
      await g.start()
      const p = openProbe(port)
      await new Promise((r) => setTimeout(r, 300))

      g.detachListen()
      const t0 = Date.now()
      await g.close({ drainActiveMs: 500 })
      const elapsed = Date.now() - t0
      const released = await releasedWithin(p, 3000)
      // ⚠️ 审计实测修复前：「耗时 1012ms 但已断 = false」—— 日志说了、连接没断
      expect(released, '排水到期后仍不断开 ⇒ 「将中断剩余 N 个」是谎话').toBe(true)
      expect(elapsed).toBeGreaterThan(400)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 40_000)

  it('★★ P1-b：排水中的旧实例必须可被**再次 close** 强制断开（孤儿的唯一出路）', async () => {
    const { createOpenAiGateway } = await import('../../src/openai-gateway/server.js')
    const home = mkdtempSync(join(tmpdir(), 'gw-p1b-'))
    try {
      const port = await freePort()
      // 旧实例：后台排水（换绑后 runtime 的做法）
      const g1 = makeHanging(port, home)
      await g1.start()
      const p1 = openProbe(port)
      await new Promise((r) => setTimeout(r, 300))
      g1.detachListen()
      void g1.close({ drainActiveMs: 600_000 }).catch(() => {})

      // 新实例接管
      const g2 = createOpenAiGateway({
        home,
        env: { ...process.env, DSH_OPENAI_GATEWAY_API_KEY: 'k', DSH_OPENAI_GATEWAY_PORT: String(port) },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        llm: {
          listProviders: () => ['fake'],
          listModels: async () => [{ id: 'fake-model', name: 'fake' }],
          resolveModelInfo: async () => ({ id: 'fake-model' }),
          async *stream() { yield { type: 'text-delta', text: 'ok' } as never },
        } as never,
      })
      await g2.start()

      // 对排水中的旧实例再次 close（模拟 dispose/用户关网关想强关它）
      await g1.close({ drainActiveMs: 0 })
      const released = await releasedWithin(p1, 3000)
      // ⚠️ 修复前实测：false（第二次 close 只 abort、无句柄可强制断开）
      expect(released, '旧实例无法被再次 close 断开 ⇒ 僵尸 socket 永久累积').toBe(true)

      await g2.close({ drainActiveMs: 0 })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 40_000)
})

/**
 * ★ 对抗审计 P2-2：**重试分支**的 `factory()` 抛错不得逃出 `applyGatewayDesiredState`。
 *
 * 主路径已显式守卫同一风险（注释写着「工厂按契约不该抛，但契约靠的是调用方自觉；
 * 单例模块级代码不能赌」），**重试这一发漏了**。实测：factory 第三次调用抛错
 * ⇒ 异常逃出、而 `lastError = null` + `running = false` ⇒ 面板把「启动失败」
 * 显示成「用户主动关闭」，`jet-hub-rpc.ts` 的 `await applyGatewayDesiredState()`
 * 变成一次失败操作。
 */
describe('IKQODR 对抗审计 P2-2：重试分支必须自己兜住 factory 抛错', () => {
  it('★ 重试时 factory() 抛错 ⇒ 不得逃出，且必须如实记 lastError', async () => {
    const runtime = await import('../../src/openai-gateway/runtime.js')
    await runtime.disposeGatewayRuntime()
    let calls = 0
    runtime.registerGatewayFactory((() => {
      calls += 1
      // 第 1 次（首轮）成功；第 2 次（换绑新建）start 失败以触发重试；
      // 第 3 次（重试）= factory 抛错
      if (calls === 3) throw new Error('factory boom on retry')
      return {
        async start() {
          if (calls === 2) throw new Error('listen EADDRINUSE (触发重试)')
        },
        detachListen() {},
        async close() {},
        address() { return { host: '127.0.0.1', port: 8326 } },
        apiKey: null,
      }
    }) as never)
    runtime.setGatewayDesiredEnabled(true)
    runtime.setGatewayDesiredAllowLan(false)
    await runtime.applyGatewayDesiredState()
    expect(runtime.isGatewayRunning()).toBe(true)

    // 换绑 ⇒ 第 2 次 factory 的实例 start 失败 ⇒ 重试 ⇒ 第 3 次 factory 抛错
    runtime.setGatewayDesiredAllowLan(true)
    let escaped: string | null = null
    try {
      await runtime.applyGatewayDesiredState()
    } catch (error) {
      escaped = error instanceof Error ? error.message : String(error)
    }
    // ⚠️ 关键：不得逃出（主路径同一风险已有守卫）
    expect(escaped, '重试分支的 factory 抛错逃出了 applyGatewayDesiredState').toBeNull()
    // 且必须如实上报（否则面板把「启动失败」显示成「用户主动关闭」）
    expect(runtime.isGatewayRunning()).toBe(false)
    expect(runtime.gatewayLastError(), 'lastError 为 null ⇒ 面板误显示成用户主动关闭').not.toBeNull()
  }, 20_000)
})
