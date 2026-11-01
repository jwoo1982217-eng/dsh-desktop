/**
 * bili（billion-context）拒发改写请求的**独立归类**（Gitee IKQ7AP）。
 *
 * ## 真实缺陷（2026-10-25 实测复现，四格）
 *
 * 长会话触发上下文压缩后，请求体被改写，而 codearts 的签名覆盖正文 ⇒
 * 本机压缩代理 bili 按 compress-or-refuse contract **拒发**（403 +
 * `signed_request_requires_resign` / `bili_resign_unavailable`）。
 * 旧实现的连锁反应：
 *
 * 1. `isTransientSignatureFailure` 只认 `body hash mismatch` ⇒ bili 不命中；
 * 2. `isAuthError` 对 401/403 恒真 ⇒ **白跑一次 refresh**（真实 STS 网络往返）；
 * 3. 重试时压缩仍在、重签凭据仍缺 ⇒ bili 依旧拒发 ⇒ `httpErrorCode` 归 `AUTH`；
 *    实测 message 只剩 `codearts: model request failed with HTTP 403`，
 *    `bili_resign_unavailable` 与「No re-sign credential」**全部丢失**。
 *
 * ## 修复后的四格（本文件逐格锁定）
 *
 * | 观测 | 修复前 | 修复后 |
 * |---|---|---|
 * | 错误码 | `AUTH` | `PROXY_REFUSED_SIGNED` |
 * | `refresh()` 调用 | 1 | **0** |
 * | `bili_resign_unavailable` 可搜 | 否 | 是 |
 * | 「No re-sign credential」可搜 | 否 | 是 |
 *
 * ## ⚠️ 判据的**收窄边**（与 `isTransientSignatureFailure` 同一条纪律）
 *
 * bili 的 `message` 里**恰好引用了** `APIG.0301` / `SignatureDoesNotMatch`
 * （描述它为什么拒发）⇒ 判据**只认 bili 独有的三个 marker**，
 * 把 `APIG.0301` / `SignatureDoesNotMatch` 加进来会让真凭据问题误判成代理拒发。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import {
  CodeArtsAdapter,
  isProxyResignRefusal,
  isTransientSignatureFailure,
  PROXY_REFUSED_SIGNED_CODE,
} from '../../src/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/types.js'

const CREDENTIAL_REF = credentialRef('CODEARTS_ACCESS_TOKEN')

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** 真实会话 `session-016866dc` turn 7 的逐字报文（Gitee IKQ7AP）。 */
const BILI_REFUSAL_BODY = JSON.stringify({
  error: {
    type: 'signed_request_requires_resign',
    code: 'bili_resign_unavailable',
    message: 'bili refused to forward this sdk-hmac-sha256 (CodeArts APIG SDK-HMAC-SHA256, #1884)-signed request: '
      + 'the signature covers the request body, and any rewrite (context compression) would invalidate it upstream '
      + '(401 APIG.0301 / SignatureDoesNotMatch). No re-sign credential was available for this scheme. ...',
    session_dead: true,
  },
})

/** 对照组：真实凭据失效 —— 必须仍走 refresh（不得被本判据抢走）。 */
const INVALID_TOKEN_BODY = '{"error_code":"APIG.0602","error_msg":"Invalid token"}'
/** 对照组：APIG 瞬时签名故障 —— 必须仍走「重发」。 */
const SIGNATURE_MISMATCH_BODY =
  '{"error_code":"APIG.0301","error_msg":"Incorrect IAM authentication information: calc ak sk signature fail:body hash mismatch x-sdk-content-sha256 header"}'

describe('isProxyResignRefusal（报文判据）', () => {
  it('★ 认 bili 的三个 marker（401 与 403 都接）', () => {
    expect(isProxyResignRefusal(403, BILI_REFUSAL_BODY)).toBe(true)
    expect(isProxyResignRefusal(401, BILI_REFUSAL_BODY)).toBe(true)
    expect(isProxyResignRefusal(403, 'signed_request_requires_resign')).toBe(true)
    expect(isProxyResignRefusal(403, 'bili_resign_unavailable')).toBe(true)
    expect(isProxyResignRefusal(403, 'Bili refused to forward this request')).toBe(true)
  })

  it('★ 收窄边：bili 引用的 APIG.0301 / SignatureDoesNotMatch 单独出现**不得**命中', () => {
    // 这两个词在 bili 的 message 里只是**引用**；单独出现时它们是 APIG 的报文，
    // 其中 APIG.0301 的 verify 支覆盖真实 AK/SK 错误 —— 放宽即误判。
    expect(isProxyResignRefusal(403, '{"error_code":"APIG.0301","error_msg":"verify ak sk signature fail"}')).toBe(false)
    expect(isProxyResignRefusal(403, 'SignatureDoesNotMatch')).toBe(false)
    // 真凭据失效与瞬时签名故障都不得命中。
    expect(isProxyResignRefusal(403, INVALID_TOKEN_BODY)).toBe(false)
    expect(isProxyResignRefusal(403, SIGNATURE_MISMATCH_BODY)).toBe(false)
  })

  it('非 401/403 一律不命中（正文里的字样不算）', () => {
    for (const status of [200, 400, 402, 429, 500]) {
      expect(isProxyResignRefusal(status, BILI_REFUSAL_BODY)).toBe(false)
    }
    // ⚠️ 与 `isModelSaturationError` 的 `status < 400 ⇒ false` 同一条纪律：
    // 模型正文里讨论「压缩代理拒发」是常态，不能把合法回答判成故障。
  })

  it('空体 / 非字符串安全', () => {
    expect(isProxyResignRefusal(403, '')).toBe(false)
  })
})

describe('bili 拒发的端到端归类（真实 CodeArtsAdapter）', () => {
  /** 403 恒回 bili 报文；记录 chat 与 refresh 的调用次数。 */
  async function runWithBiliRefusal(): Promise<{
    error: LlmError
    chatCalls: number
    refreshCalls: number
  }> {
    let chatCalls = 0
    let refreshCalls = 0
    const adapter = new CodeArtsAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => validCredential,
      refresh: async () => { refreshCalls += 1 },
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.includes('/queue/status')) {
          return new Response(JSON.stringify({ status: 'working' }), { status: 200 })
        }
        chatCalls += 1
        return new Response(BILI_REFUSAL_BODY, { status: 403 })
      },
    })
    let error: LlmError | undefined
    try {
      for await (const _chunk of adapter.stream({
        model: 'GLM-5.2',
        messages: [],
      } as never)) { /* 读完即可 */ }
    } catch (caught) {
      error = caught as LlmError
    }
    expect(error, '本步必须抛错').toBeInstanceOf(LlmError)
    return { error: error!, chatCalls, refreshCalls }
  }

  it('★ 码是 PROXY_REFUSED_SIGNED，不是 AUTH（issue 验收标准 1）', async () => {
    const { error } = await runWithBiliRefusal()
    // ⚠️⚠️ **`toBe(PROXY_REFUSED_SIGNED_CODE)` 是同义反复，真正有牙的是下一条**
    // （对抗审计实测的教训）：把常量值改成 `'AUTH'` 时，本行的左右两侧**一起变**、
    // 恒真；而 `not.toBe('AUTH')` 用的是**字面量** ⇒ 1 条红。
    // 保留本行只为可读性，判定力全靠下一条。
    expect(error.code).toBe(PROXY_REFUSED_SIGNED_CODE)
    // 字面量断言：码退化时唯一会红的一格（常量值变异实测 1 红，就是这条）。
    expect(error.code).not.toBe('AUTH')
  })

  it('★ refresh() 零调用（issue 验收标准 4：不再白刷凭据）', async () => {
    const { refreshCalls, chatCalls } = await runWithBiliRefusal()
    expect(refreshCalls, '凭据本来是好的，一次都不该刷').toBe(0)
    // 重发无效：压缩仍在、凭据仍缺 ⇒ 只发一次就该停手（旧实现是 2 次：白刷后重试）。
    expect(chatCalls, '重发必然再撞，不得多烧往返').toBe(1)
  })

  it('★ message 保留 bili_resign_unavailable 与可执行出路（issue 验收标准 5）', async () => {
    const { error } = await runWithBiliRefusal()
    expect(error.message).toContain('bili_resign_unavailable')
    // 修前 message 只剩 "model request failed with HTTP 403"，出路全丢。
    expect(error.message).toContain('重新登录无用')
    expect(error.message).toContain('BILI_RESIGN_PASSTHROUGH')
    // 纯文本渲染：Markdown 强调符会原样显示成星号。
    expect(error.message).not.toContain('**')
  })

  it('★ 不回归：真实凭据失效（APIG.0602）仍走 refresh（不得被本判据抢走）', async () => {
    let chatCalls = 0
    let refreshCalls = 0
    const adapter = new CodeArtsAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => validCredential,
      refresh: async () => { refreshCalls += 1 },
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.includes('/queue/status')) {
          return new Response(JSON.stringify({ status: 'working' }), { status: 200 })
        }
        chatCalls += 1
        // 刷新后放行：验证 refresh 确实被走到且链路能恢复。
        return refreshCalls > 0
          ? new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
          : new Response(INVALID_TOKEN_BODY, { status: 401 })
      },
    })
    for await (const _chunk of adapter.stream({ model: 'GLM-5.2', messages: [] } as never)) { /* 读完 */ }
    expect(refreshCalls, '真凭据失效仍必须刷新').toBe(1)
    expect(chatCalls).toBe(2)
  })
})

describe('httpErrorCode 的分类面（issue 验收标准 1/2）', () => {
  // `httpErrorCode` 未导出；用「端到端错误码」锁它的行为（上面的用例已覆盖），
  // 这里只补判据函数层面的边界，避免为测一个私有函数而导出它。
  it('★ 判据与 isTransientSignatureFailure 互斥（同一份 403 报文只会落一边）', () => {
    // bili 报文：新判据命中、瞬时签名不命中。
    expect(isProxyResignRefusal(403, BILI_REFUSAL_BODY)).toBe(true)
    expect(isTransientSignatureFailure(403, BILI_REFUSAL_BODY)).toBe(false)
    // APIG 报文：瞬时签名命中（body hash mismatch 支）、新判据不命中。
    expect(isTransientSignatureFailure(403, SIGNATURE_MISMATCH_BODY)).toBe(true)
    expect(isProxyResignRefusal(403, SIGNATURE_MISMATCH_BODY)).toBe(false)
  })

  // ⚠️⚠️ **这两条变异实测出的「假绿」教训（2026-10-25）**：
  // 端到端主路径走的是循环里的**独立早退**（接线③），它在 `isAuthError` 与
  // `httpErrorCode` **之前**就抛了 ⇒ 单独删掉 `isAuthError` 的排除腿（V1）或
  // `httpErrorCode` 的单列腿（V2），端到端用例**全绿** —— 两处退化完全不可达，
  // 将来任何重构（例如有人把早退挪走、或改循环结构）都会让它们静默失效。
  //
  // ⇒ **防御性冗余也要有牙**：用「最短路」场景（bili 拒发**一次**后放行）把
  // 三条接线腿各自钉住 —— 早退被删时，请求会落到 refresh/重试链，可从
  // `refreshCalls` / `chatCalls` / 最终码分辨出走的是哪条腿。
  describe('三条接线腿逐一有牙（V1/V2 假绿的补守卫）', () => {
    /** bili 拒发 `failures` 次后放行；返回各计数与最终错误。 */
    async function runMixed(options: { failures: number; status?: number }): Promise<{
      error?: LlmError
      chatCalls: number
      refreshCalls: number
      ok: boolean
    }> {
      let chatCalls = 0
      let refreshCalls = 0
      let remaining = options.failures
      const status = options.status ?? 403
      const adapter = new CodeArtsAdapter({
        credentialRef: CREDENTIAL_REF,
        resolveCredential: async () => validCredential,
        refresh: async () => { refreshCalls += 1 },
        fetchImpl: async (input) => {
          const url = String(input)
          if (url.includes('/queue/status')) {
            return new Response(JSON.stringify({ status: 'working' }), { status: 200 })
          }
          chatCalls += 1
          if (remaining > 0) {
            remaining -= 1
            return new Response(BILI_REFUSAL_BODY, { status })
          }
          return new Response(
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        },
      })
      try {
        for await (const _chunk of adapter.stream({ model: 'GLM-5.2', messages: [] } as never)) { /* 读完 */ }
        return { chatCalls, refreshCalls, ok: true }
      } catch (caught) {
        return { error: caught as LlmError, chatCalls, refreshCalls, ok: false }
      }
    }

    it('★ 接线①（isAuthError 排除腿）：bili 拒发**一次**时不得白刷凭据（refresh 恒 0）', async () => {
      // ⚠️ **早退存在时「拒发一次后放行」到不了第二次请求**（早退直接抛错结束
      // 本轮）—— 这正是设计行为：重发必然再撞。⇒ 本用例锁的不是「能恢复」，
      // 而是「**就算早退被移走、落进 AUTH 分支也不会刷凭据**」：V1（删
      // `isAuthError` 的排除腿）只在早退不可达时才暴露，此时首连 403 会走
      // refresh 一次 ⇒ `refreshCalls` 变 1 ⇒ 本断言红。它是**防御性**的。
      const result = await runMixed({ failures: 1 })
      // 修复态：早退直接抛。
      expect(result.error?.code).toBe(PROXY_REFUSED_SIGNED_CODE)
      // ⚠️ V1 下这里会变 1（AUTH 分支先刷一次）⇒ 红指向被删的那条腿。
      expect(result.refreshCalls, '不得白刷凭据').toBe(0)
      expect(result.chatCalls, '重发无效，一次就停').toBe(1)
    })

    it('★ 持续拒发 ⇒ 不重试不刷新，一次请求就停（重发无效性的端到端锁）', async () => {
      const result = await runMixed({ failures: Number.POSITIVE_INFINITY })
      expect(result.ok).toBe(false)
      expect(result.error!.code).toBe(PROXY_REFUSED_SIGNED_CODE)
      // ⚠️ V1/V2/V3 任一腿退化时的形态各不相同（refresh 1 次后 AUTH /
      // 码变 AUTH / 落通用模板丢文案），但「恰好 1 次 chat 请求」是三条腿
      // 共同承诺的行为 ⇒ 它红说明至少一条腿坏了，指向本文件逐格排查。
      expect(result.chatCalls, '重发必然再撞，一次就停').toBe(1)
      expect(result.refreshCalls).toBe(0)
    })
  })
})

/**
 * 「代理拒发」不得被记成「模型已失效」（issue 反面教材的守卫）。
 *
 * ## 为什么这条脆弱的绿必须锁住
 *
 * issue 附言：同源缺陷在另一插件上把这条 403 映射成 session_dead →
 * `pool.disable()` ⇒ 账号永久不可用。本仓库没有那条路径（实测：早退不调
 * `updateModelRateLimit`、`account-pool` 无按错误码 disable 的入口），
 * 但 `dead-model-store.ts` 的 `IGNORED_CODES` **不显式包含**
 * `PROXY_REFUSED_SIGNED` —— 拦住误判的是 `NOT_GONE_PATTERNS` 的**文案腿**
 * （`/凭据/` 等），属「脆弱的绿」：将来改文案就可能把它漏进 30 天失效表。
 *
 * ⇒ 本用例锁住「当前文案 + 当前码 ⇒ 不判 gone」，并附**反向对照**
 * （真 gone 必须仍判 true）证明探针有牙。若将来有人改文案让它变红，
 * 正确修法是把码加进 `IGNORED_CODES`（码级防线），而不是改这条断言。
 */
describe('PROXY_REFUSED_SIGNED 不被 dead-model-store 误判为 gone', () => {
  it('★ bili 拒发不得被判「模型已失效」（否则可用模型被藏 30 天）', async () => {
    const { isModelGoneError } = await import('../../src/dead-model-store.js')
    const { proxyResignRefusalFailure } = await import('../../src/llm-adapter.js')
    const failure = proxyResignRefusalFailure('{"code":"bili_resign_unavailable"}')
    expect(isModelGoneError({ code: failure.code, message: failure.message })).toBe(false)
  })

  it('★ 反向对照：真「模型不存在」仍须判 gone（证明探针有牙）', async () => {
    const { isModelGoneError } = await import('../../src/dead-model-store.js')
    expect(isModelGoneError({ code: 'SERVER', message: 'buddy: model glm-5.9 does not exist' })).toBe(true)
  })
})
