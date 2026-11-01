// ⚠️ 2026-10-31 对抗审计收编（原临时探针 zz-audit-m113-gate）：
// `DSH_UNIT_TEST_NO_WREQ` 闸门的**有牙性证明**（本地 127.0.0.1 回环 +
// 全局 fetch 桩，零上游流量）。
//
// ## 为什么需要它（合并审计的真实事故）
//
// 闸门缺失时（PR14 原样），本机装得到 wreq-js ⇒ `bunTlsFetch` 真发上游 ⇒
// opencode-rotate/stream 的网络桩全部被绕过、34 条用例拿真实 401/429 假红。
// 本用例断言「闸门在场 ⇒ 请求确实走了 proxyFetch 回退、全局 fetch 桩命中」，
// 变异删掉闸门（对抗审计 M6c）时本用例红 + rotate/stream 大面积红。
// e2e 配置不注入该 env ⇒ 真机验收路径不受影响。
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { OpencodeAdapter } from '../../src/opencode-adapter.js'
import { OPENCODE } from '../../src/opencode-product.js'

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

function adapterOn(port: number): OpencodeAdapter {
  const product = { ...OPENCODE, baseUrl: `http://127.0.0.1:${port}` } as never
  return new OpencodeAdapter({
    identitySlots: async () => [{
      id: 'probe-slot', kind: 'account', apiKey: 'oc_sk_probe_aaaaaaaaaaaaaaaaaaaaaaaa',
      proxy: undefined, fingerprint: { projectId: '3f3f7816fd9ceeaf0c3df15f6048b06b7f4e1787', generation: 0 },
      userAgent: OPENCODE.defaultUserAgent,
    } as never],
    product,
  } as never)
}

afterEach(() => { vi.restoreAllMocks() })

describe('opencode 传输层单测闸门的有牙性（DSH_UNIT_TEST_NO_WREQ ⇒ 回退 proxyFetch）', () => {
  it('闸门在场：传输层走 proxyFetch（回退）⇒ 请求经全局 fetch 桩、本地服务器收到请求', async () => {
    const { server, port } = await startServer()
    let stubHits = 0
    const spy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      stubHits++
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    })
    vi.stubGlobal('fetch', spy)
    try {
      const adapter = adapterOn(port)
      const chunks: string[] = []
      for await (const c of adapter.stream({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] } as never)) {
        chunks.push(JSON.stringify(c))
      }
      console.log(`[gate-baseline] stubHits=${stubHits} chunks=${chunks.length}`)
      expect(stubHits).toBe(1)
    } finally { server.close() }
  })
})
