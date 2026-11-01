/**
 * `fetchWithBunFingerprint` 回退边界的行为级守卫（2026-10-31 对抗审计 M6a 补牙）。
 *
 * ## 为什么需要它
 *
 * 对抗审计实测：删掉 `instanceof BunTlsUnavailableError` 判断（一切错误都回退
 * `proxyFetch` 重发）后，opencode-rotate/stream 74 条用例**全绿**——它们的桩全
 * 布在回退路径上（单测闸门在场 ⇒ 恒走 proxyFetch），行为层对「401/429 也回退
 * = 静默重发、同一次失败记两笔账」零守卫，只剩 opencode-bun-tls.spec 一条
 * **源码文本断言**（可被等价重写绕过）。
 *
 * ## 判据（行为级，与写法无关）
 *
 * - `bunTlsFetch` 抛 `BunTlsUnavailableError`（请求未发出）⇒ 回退 `proxyFetch`
 *   发一次（合法回退）；
 * - `bunTlsFetch` 抛**普通错误**（如 401 `LlmError` / `TypeError`——请求已发出
 *   或真失败了）⇒ **原样上抛**，且 `proxyFetch` **一次都不能被调**
 *   （重发 = 同一次失败记两笔账 + 可能多烧一次额度，仓库红线）。
 *
 * 实现方式：`vi.mock` 掉 `opencode-bun-tls.js` 与 `opencode-proxy.js` 两个模块
 * （`streamVia` 的两条传输腿），不走网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const bunTlsFetchMock = vi.hoisted(() => vi.fn())
const proxyFetchMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/opencode-bun-tls.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/opencode-bun-tls.js')>()
  return {
    ...actual,
    bunTlsFetch: bunTlsFetchMock,
    // ⚠️ 必须用 actual 的类：adapter 判 instanceof，跨模块副本会假绿
    //（仓库登记过的「跨模块副本 instanceof 假红/假绿」教训）。
    BunTlsUnavailableError: actual.BunTlsUnavailableError,
  }
})
vi.mock('../../src/opencode-proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/opencode-proxy.js')>()),
  proxyFetch: proxyFetchMock,
}))

const { OpencodeAdapter } = await import('../../src/opencode-adapter.js')
const { BunTlsUnavailableError } = await import('../../src/opencode-bun-tls.js')

afterEach(() => {
  bunTlsFetchMock.mockReset()
  proxyFetchMock.mockReset()
})

async function runStream(): Promise<{ chunks: StreamChunk[]; error?: unknown }> {
  const adapter = new OpencodeAdapter({
    identitySlots: async () => [{
      id: 'slot-a', kind: 'account', apiKey: 'opencode-fallback-edge-key-0000000000',
      proxy: undefined, fingerprint: { projectId: '3f3f7816fd9ceeaf0c3df15f6048b06b7f4e1787', generation: 0 },
      userAgent: 'opencode/1.18.22',
    }],
  } as never)
  const chunks: StreamChunk[] = []
  try {
    for await (const c of adapter.stream({
      provider: 'opencode', model: 'big-pickle',
      messages: [{ role: 'user', content: 'x' }], system: '', tools: [],
    } as unknown as GenerateOptions)) chunks.push(c)
    return { chunks }
  } catch (error) {
    return { chunks, error }
  }
}

describe('Bun 指纹传输的回退边界（行为级：只对「未发出」回退）', () => {
  it('缺席（BunTlsUnavailableError）⇒ 回退 proxyFetch 发一次', async () => {
    bunTlsFetchMock.mockRejectedValue(new BunTlsUnavailableError('模拟：模块没装上'))
    proxyFetchMock.mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    const { chunks, error } = await runStream()
    expect(error).toBeUndefined()
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    expect(proxyFetchMock).toHaveBeenCalledTimes(1)
  })

  it('⚠️ 真失败（普通 LlmError/401）⇒ 不得回退重发：proxyFetch 零调用、流无产出', async () => {
    const real = new Error('opencode: HTTP 401 — {"error":{"message":"Invalid credential"}}')
    bunTlsFetchMock.mockRejectedValue(real)
    const { chunks, error } = await runStream()
    // ⚠️ 判据不锁「错误身份」：单槽轮换会把 transport 形态包成 QUOTA_EXCEEDED
    //（轮换层的合法行为）。牙在「回退没有发生」：变异（catch-all 回退）下
    // proxyFetch 会被调用、桩返回 200 ⇒ 流成功无错 ⇒ 两条断言同时翻。
    expect(proxyFetchMock).not.toHaveBeenCalled()
    expect(error).toBeDefined()
    expect(chunks).toEqual([])
  })

  it('⚠️ 传输中断（TypeError: fetch failed）⇒ 同样不得回退重发', async () => {
    const real = new TypeError('fetch failed')
    bunTlsFetchMock.mockRejectedValue(real)
    const { chunks, error } = await runStream()
    expect(proxyFetchMock).not.toHaveBeenCalled()
    expect(error).toBeDefined()
    expect(chunks).toEqual([])
  })
})
