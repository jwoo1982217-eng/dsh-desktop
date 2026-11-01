/**
 * 续期/取号抛出的**已分类**异常不得被降级成 `AUTH`（Gitee IKQ99X）。
 *
 * ## 真实缺陷（2026-10-25 在 master 上实测复现，逐格与 issue 一致）
 *
 * 401/403 分支把 `refresh()` 与 `resolveCredential()` 的异常一起 `catch` 吞掉
 * （只 `console.warn`）。当 `resolveCredential` 因「候选被该模型限流筛空」抛
 * `QUOTA_EXCEEDED`（`credential-resolver.ts` 的 `throwIfAllRateLimited`，文案
 * **带解禁时刻**）时：
 *
 * 1. `refreshedCredential` 保持 `undefined`；
 * 2. 限流账号已被 `getAvailableAccount` 过滤 ⇒ 换号循环第一跳 `break` ⇒
 *    `rotated` 恒 `false`；
 * 3. 落到兜底分支 ⇒ 抛 `AUTH` +「credential expired and refresh failed」。
 *
 * 后果**双重**：解禁时刻与「无需重新登录」这句唯一出路被丢掉；而 `AUTH` 又恰好是
 * DSH 客户端会**整条替换文案**的码（`failureMessage` → 「API 密钥无效」），
 * 连那句错话都留不全（`docs/agent-notes/client-ui.md` 的 IKLBSH）。
 *
 * ## ⚠️ 本组用例的对照格（缺一不可）
 *
 * 只断言「E 格变成 QUOTA_EXCEEDED」是**不够**的：把整个 catch 改成 `throw error`
 * 也能让它变绿，但那会破坏「刷新失败不致命、换号仍有机会」这条既有设计
 * （`1077c34` 的依据）。故 F 格（池里有可用账号）必须仍能换号成功。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { BuddyAdapter, DEFAULT_MODEL } from '../../src/buddy-adapter.js'
import type { BuddyCredential } from '../../src/buddy.js'

const CREDENTIAL_REF = credentialRef('BUDDY_ACCESS_TOKEN')

function makeCredential(token: string): BuddyCredential {
  return {
    access_token: token,
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'copilot.tencent.com',
  }
}

function sseOk(): Response {
  const encoder = new TextEncoder()
  const body = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body))
      controller.close()
    },
  }), { status: 200 })
}

/**
 * 造一个适配器：`resolveCredential` 第 1 次成功、之后抛 `thrown`；
 * 池的 `getAvailableAccount` 按 `poolCandidate` 返回（null = 全被限流筛空）。
 */
function makeAdapter(options: {
  thrown: unknown
  poolCandidate: string | undefined
  firstResponse?: Response
  secondResponse?: Response
}) {
  let resolveCalls = 0
  const sentTokens: string[] = []
  const pool = {
    async findAccountIdByCredential() { return 'acct-1' },
    async updateModelRateLimit() { /* 本组只关心错误归因 */ },
    async getAvailableAccount() {
      if (options.poolCandidate === undefined) return null
      return { entry: { id: `acct-${options.poolCandidate}` }, credential: makeCredential(options.poolCandidate) }
    },
  }
  const adapter = new BuddyAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => {
      resolveCalls += 1
      if (resolveCalls >= 2 && options.thrown !== undefined) throw options.thrown
      return makeCredential('AT1')
    },
    refresh: async () => { /* 续期本身成功：异常来自其后的取号 */ },
    accountPool: pool as never,
    fetchImpl: async (_url, init) => {
      const token = ((init?.headers as Headers | undefined)?.get('Authorization') ?? '').replace('Bearer ', '')
      sentTokens.push(token)
      if (token !== 'AT1' && options.secondResponse !== undefined) return options.secondResponse
      return options.firstResponse ?? new Response('', { status: 403 })
    },
  })
  return { adapter, sentTokens }
}

/** 消费流并返回抛出的错误（成功出流时返回 undefined）。 */
async function errorOf(adapter: BuddyAdapter): Promise<LlmError | undefined> {
  try {
    for await (const _chunk of adapter.stream({
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never)) { /* 消费即可 */ }
    return undefined
  } catch (error) {
    return error as LlmError
  }
}

/** `credential-resolver.ts` 的 `throwIfAllRateLimited` 在线上抛出的真实形态。 */
const quotaError = () => new LlmError(
  'CodeBuddy（腾讯）：模型 deepseek-v4.1-flash 的可用账号均在限流中，'
  + '最近一个将于 2026/10/26 08:00:00 解禁。可改用其它 provider / 模型，'
  + '或等待解禁后再试（无需重新登录）。',
  'QUOTA_EXCEEDED',
)

describe('续期/取号异常不得降级成 AUTH（IKQ99X）', () => {
  it('★ E 格：抛 QUOTA_EXCEEDED + 池被筛空 ⇒ 必须如实报 QUOTA_EXCEEDED', async () => {
    const { adapter } = makeAdapter({ thrown: quotaError(), poolCandidate: undefined })
    const error = await errorOf(adapter)
    expect(error).toBeInstanceOf(LlmError)
    expect(error!.code).toBe('QUOTA_EXCEEDED')
    // 解禁时刻与「无需重新登录」必须原样到达用户眼前（这是本档存在的全部理由）。
    expect(error!.message).toContain('解禁')
    expect(error!.message).toContain('无需重新登录')
    // ⚠️ 反向对照：绝不能是那两句误导文案。
    expect(error!.message).not.toContain('credential expired')
    expect(error!.message).not.toContain('所有账号均被拒绝')
  })

  it('★ F 格（反向对照）：池里有可用账号时，异常仍然「不致命」—— 必须能换号成功', async () => {
    // ⚠️ 这条锁的是 `1077c34` 的原始设计：把 catch 改成无条件 `throw error`
    // 会让 E 格变绿而本格变红。两格同在才算真的修对。
    const { adapter, sentTokens } = makeAdapter({
      thrown: quotaError(),
      poolCandidate: 'AT2',
      secondResponse: sseOk(),
    })
    const error = await errorOf(adapter)
    expect(error, '换号应当成功，不该抛错').toBeUndefined()
    expect(sentTokens).toEqual(['AT1', 'AT2'])
  })

  it('★ G 格：403 + 非 JSON（HTML 网关页）同样不得掩盖 QUOTA_EXCEEDED', async () => {
    const { adapter } = makeAdapter({
      thrown: quotaError(),
      poolCandidate: undefined,
      firstResponse: new Response('<html>403 Forbidden</html>', { status: 403 }),
    })
    const error = await errorOf(adapter)
    expect(error!.code).toBe('QUOTA_EXCEEDED')
    expect(error!.message).not.toContain('credential expired')
  })

  it('★ H 格（不回归）：取号正常但池被筛空 ⇒ 仍是「所有账号均被拒绝」，不被本判据影响', async () => {
    const { adapter } = makeAdapter({ thrown: undefined, poolCandidate: undefined })
    const error = await errorOf(adapter)
    expect(error!.code).toBe('AUTH')
    expect(error!.message).toContain('所有账号均被拒绝')
  })

  it('★ 未分类的续期故障（网络抖动）仍走原兜底 AUTH —— 本判据只放行四个已分类码', async () => {
    // 若把判据放宽成「任何 LlmError 都透传」，一次 `SERVER` 抖动就会让用户看到
    // 一个与凭据无关的错误码，而真实动作仍是「重新登录」。
    const { adapter } = makeAdapter({
      thrown: new LlmError('buddy: upstream 502', 'SERVER'),
      poolCandidate: undefined,
    })
    const error = await errorOf(adapter)
    expect(error!.code).toBe('AUTH')
    expect(error!.message).toContain('credential expired and refresh failed')
  })

  it('★ 非 LlmError 的普通异常同样走原兜底（不得因本判据变成未捕获异常）', async () => {
    const { adapter } = makeAdapter({
      thrown: new Error('ECONNRESET'),
      poolCandidate: undefined,
    })
    const error = await errorOf(adapter)
    expect(error!.code).toBe('AUTH')
  })

  it('★ 四个已分类码逐个透传（表驱动：任何一格被删掉都会红）', async () => {
    for (const code of ['QUOTA_EXCEEDED', 'PERMISSION_DENIED', 'RATE_LIMIT', 'MISSING_CREDENTIAL']) {
      const { adapter } = makeAdapter({
        thrown: new LlmError(`${code} 的原始文案`, code),
        poolCandidate: undefined,
      })
      const error = await errorOf(adapter)
      expect(error!.code, `码 ${code} 应原样透传`).toBe(code)
      expect(error!.message, `码 ${code} 的文案应原样透传`).toContain(code)
    }
  })

  it('★ 11128 渠道校验档同样优先于本判据（对抗审计实测：这一格曾无守卫）', async () => {
    // 把判据挪到 `sawChannelVerification` **之前**时，第一版 8 条用例**全绿**
    // ⇒ 两档里只有 11140 那格有牙。本用例补上另一半。
    const body = JSON.stringify({ code: 11128, msg: 'request illegal' })
    const { adapter } = makeAdapter({
      thrown: quotaError(),
      poolCandidate: undefined,
      firstResponse: new Response(body, { status: 403 }),
    })
    const error = await errorOf(adapter)
    expect(error!.code).toBe('PERMISSION_DENIED')
    expect(error!.message).toContain('渠道校验')
  })

  it('★ rotated = true（换号真的发生过）也不得丢弃已分类异常', async () => {
    // ⚠️ 对抗审计实测的真泄漏：第一版判据只挂在 `!rotated` 的早退分支里，
    // 于是「池里还有别的号、但换过去也 401/403」这条路径仍然报 AUTH。
    // 对照格：同一份 resolveCredential，唯一差别是池里第二个号是否可解析。
    const { adapter, sentTokens } = makeAdapter({
      thrown: quotaError(),
      poolCandidate: 'AT2',
      // 第二个号也 403 ⇒ 换号发生过（rotated=true）但没救回来。
      secondResponse: new Response('forbidden', { status: 403 }),
    })
    const error = await errorOf(adapter)
    expect(sentTokens, '前提：换号确实发生过').toEqual(['AT1', 'AT2'])
    expect(error!.code).toBe('QUOTA_EXCEEDED')
    expect(error!.message).toContain('解禁')
  })

  it('★ 透传时带 status（否则网关会把 401 退化成可重试的 502）', async () => {
    const { adapter } = makeAdapter({ thrown: quotaError(), poolCandidate: undefined })
    const error = await errorOf(adapter)
    // `openai-gateway` 的 failureToOpenAiError 读 `error.status ?? error.failure.status`；
    // 都没有时回落 502（可重试）⇒ 「所有账号都在限流」会变成白重试。
    expect((error as unknown as { failure?: { status?: number } }).failure?.status).toBe(403)
  })
  it('★ 11140 档优先于本判据（上游报文证明的原因比本地池状态更具体）', async () => {
    // 同时满足「续期抛 QUOTA_EXCEEDED」与「响应体是 11140」时，必须仍报
    // PERMISSION_DENIED + 该档专用文案 —— 它是**上游对本请求的实际答复**。
    const body = JSON.stringify({ code: 11140, msg: 'request illegal' })
    const { adapter } = makeAdapter({
      thrown: quotaError(),
      poolCandidate: undefined,
      firstResponse: new Response(body, { status: 403 }),
    })
    const error = await errorOf(adapter)
    expect(error!.code).toBe('PERMISSION_DENIED')
    expect(error!.message).toContain('安全策略拦截')
  })
})
