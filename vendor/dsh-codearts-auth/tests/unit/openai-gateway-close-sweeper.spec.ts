import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
// ⚠️⚠️ **必须从 `node:http` 导入 `Server`**（不是 `node:net`）：`closeIdleConnections`
// 定义在 **`http.Server.prototype`** 上（空闲连接是 HTTP 概念）。从 `node:net` 导入
// 再 patch 只会给 `net.Server.prototype` 加一个**没人调用**的新属性 ⇒ 计数器恒为 0
// ⇒ 守卫**恒真**。这一格实测踩过。
import { Server } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOpenAiGateway } from '../../src/openai-gateway/server.js'

/**
 * 对抗审计 P1-1：`close()` 中途抛错时 `idleSweeper` 定时器必须被清理。
 *
 * ## 缺陷（审计实测）
 *
 * `clearInterval(idleSweeper)` 原先放在 `await Promise.race` **之后**。让
 * `logger.warn` 抛错（宿主 logger 由外部注入、不保证不抛）⇒ `close()` 抛错，
 * 那行永不执行 ⇒ 20ms 定时器**永久空转**，且泄漏的 interval 钉住已关闭的
 * Server 引用（该 Server 永不回收）。
 *
 * 实测：抛错后 400ms 内 `closeIdleConnections` 又被调用 **13 次**、永不停止。
 * `unref` 只保证不钉住进程，**不保证不空转**。
 *
 * 修法：`clearInterval` 移入 `finally`。
 *
 * ## ⚠️ 为什么这个用例**必须独占一个文件**
 *
 * 计数器打在 `http.Server.prototype.closeIdleConnections` 上，是**全局**的。
 * 而 `openai-gateway-ikqodr.spec.ts` 里的 P1-b 用例会
 * `void close({ drainActiveMs: 600_000 })` ⇒ 留下一个跑 10 分钟的 sweeper
 * ⇒ 它调用的也是同一个原型方法 ⇒ **把本用例的计数污染成 13**（看起来像缺陷
 * 仍在，其实是别的实例在扫）。第一版放在那个文件里就跑出了这个假红/假绿。
 *
 * ⇒ 独立性是判据的一部分，不是洁癖。
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

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gw-sweeper-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('P1-1 修复：close 抛错时定时器必须被清理', () => {
  it('★★ logger.warn 抛错 ⇒ close 抛错但 closeIdleConnections 不得继续空转', async () => {
    const port = await freePort()
    const origCloseIdle = Server.prototype.closeIdleConnections
    let sweeps = 0
    // 计数 closeIdleConnections 调用次数
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Server.prototype as any).closeIdleConnections = function (this: unknown) {
      sweeps += 1
      return origCloseIdle.call(this as never)
    }

    const g = createOpenAiGateway({
      home,
      env: { ...process.env, DSH_OPENAI_GATEWAY_API_KEY: 'k', DSH_OPENAI_GATEWAY_PORT: String(port) },
      logger: {
        info: () => {},
        // ⚠️ 让 warn 抛错 —— 这正是审计的触发条件（排水超时告警那行）
        warn: () => { throw new Error('logger boom') },
        error: () => {},
      },
      llm: {
        listProviders: () => ['fake'],
        listModels: async () => [{ id: 'fake-model', name: 'fake' }],
        resolveModelInfo: async () => ({ id: 'fake-model' }),
        async *stream() {
          yield { type: 'text-delta', text: 'hi' } as never
          await new Promise<void>(() => {}) // 卡住 ⇒ 走排水超时 ⇒ 触发 warn
        },
      } as never,
    })
    await g.start()
    const req = request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', timeout: 20000,
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
    }, (res) => { res.resume() })
    req.on('error', () => {})
    req.end(JSON.stringify({ model: 'fake/fake-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }))
    await new Promise((r) => setTimeout(r, 300))

    let closeErr: string | null = null
    try {
      await g.close({ drainActiveMs: 100 })
    } catch (e) {
      closeErr = e instanceof Error ? e.message : String(e)
    }
    const afterClose = sweeps
    // 再等 400ms，看定时器是否还在空转
    await new Promise((r) => setTimeout(r, 400))
    const extra = sweeps - afterClose
    console.log('[P1-1] close 抛错 =', closeErr, '| close 后 400ms 内又扫次数 =', extra)
    console.log('[P1-1] ⇒ 审计实测修复前 = 13 次（每 20ms 一次、永不停止）')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Server.prototype as any).closeIdleConnections = origCloseIdle
    req.destroy()

    expect(closeErr).not.toBeNull()
    expect(extra, '定时器仍在空转 ⇒ 泄漏').toBe(0)
  }, 40000)
})
