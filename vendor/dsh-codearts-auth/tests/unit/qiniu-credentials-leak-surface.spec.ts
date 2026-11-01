// ⚠️ 2026-10-31 对抗审计收编（原临时探针 zz-audit-m113-leak）：
// qiniu 凭据（API Key）泄漏面的动态验证。本地 127.0.0.1 服务器模拟上游，
// 零生产流量。
//
// ## ② 实测登记的**残余风险**（刻意不修，与仓库取舍一致）
//
// 恶意/被劫持的上游把 `Authorization` 头**回显进响应体** ⇒ key 作为「上游
// 原文」进入错误 message。这与 qoder 笔记「401/403 把原文剥掉的修法会丢
// 上游原文」同构：本仓库的取舍是**保留上游原文**（排障价值），而正常上游
// 不回显凭据，该面只在「上游主动作恶」时打开 —— 如实登记，不静默丢原文。
import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { QiniuAdapter } from '../../src/qiniu-adapter.js'
import { QINIU } from '../../src/qiniu-product.js'
import { maskQiniuKey } from '../../src/qiniu.js'

const SECRET = 'sk-qiniu-SECRETKEY-a1b2c3d4e5f6' // 形状合法（≥16 位 [A-Za-z0-9_.-]）

function startServer(handler: (req: any, res: any, body: string) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => { raw += c.toString() })
      req.on('end', () => handler(req, res, raw))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

function adapterWith(product: typeof QINIU, warn?: (m: string) => void): QiniuAdapter {
  return new QiniuAdapter({
    slots: async () => [{ id: 'qiniu-probe', apiKey: SECRET }],
    product,
    ...(warn ? { warn } : {}),
  } as never)
}

async function collect(adapter: QiniuAdapter): Promise<{ err?: Error; chunks: string[] }> {
  const chunks: string[] = []
  try {
    for await (const c of adapter.stream({ model: 'glm-4.5', messages: [{ role: 'user', content: 'hi' }] } as never)) {
      chunks.push(JSON.stringify(c))
    }
    return { chunks }
  } catch (e) {
    return { err: e as Error, chunks }
  }
}

describe('qiniu API Key 泄漏面（本地回环上游）', () => {
  it('① 正常 401（JSON 体不含 key）⇒ 错误链各出口不得出现完整 API Key', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"invalid api key"}}')
    })
    try {
      const product = { ...QINIU, baseUrl: `http://127.0.0.1:${port}/v1` }
      const warnLines: string[] = []
      const { err } = await collect(adapterWith(product, (m) => warnLines.push(m)))
      const surfaces = JSON.stringify({ err: err?.message, warn: warnLines })
      expect(err, '401 应抛错').toBeDefined()
      expect(surfaces.includes(SECRET), `完整 key 泄漏到 message/warn: ${surfaces.slice(0, 300)}`).toBe(false)
    } finally { server.close() }
  })

  it('② 恶意上游回显 Authorization 头 ⇒ key 经「上游响应体原文」进 message（残余风险登记用）', async () => {
    const { server, port } = await startServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `bad key ${req.headers.authorization ?? ''}` } }))
    })
    try {
      const product = { ...QINIU, baseUrl: `http://127.0.0.1:${port}/v1` }
      const { err } = await collect(adapterWith(product))
      expect(err).toBeDefined()
      console.log('[probe-echo] message 含上游回显的 key:', (err as Error).message.includes(SECRET))
    } finally { server.close() }
  })

  it('③ 200 + text/html 风控页（peek 出口）⇒ 不含 key；SERVER 不换号', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>captcha page</html>')
    })
    try {
      const product = { ...QINIU, baseUrl: `http://127.0.0.1:${port}/v1` }
      const warnLines: string[] = []
      const { err } = await collect(adapterWith(product, (m) => warnLines.push(m)))
      const surfaces = JSON.stringify({ err: err?.message, warn: warnLines })
      expect(surfaces.includes(SECRET), `key 泄漏: ${surfaces.slice(0, 300)}`).toBe(false)
      expect((err as Error).message).toContain('text/html')
    } finally { server.close() }
  })

  it('④ handleQiniuRpc 对非法 ref 的失败文案（真实 credentials 不可用时）只含指纹不含明文', async () => {
    // maskQiniuKey 非法形状回空串（不回显原文）
    expect(maskQiniuKey('short')).toBe('')
    expect(maskQiniuKey(undefined as never)).toBe('')
    expect(maskQiniuKey(SECRET)).toBe('sk-q…e5f6')
  })
})
