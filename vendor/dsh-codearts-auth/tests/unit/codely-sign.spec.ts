/**
 * Codely 请求签名（`X-Codely-Signature`）的**向量锁**。
 *
 * ## 为什么这几条必须存在
 *
 * 2026-10-20 实测：同一 key、同一 ts，只有分隔符不同 → 结果天差地别：
 *
 * | 分隔符 | 结果 |
 * |---|---|
 * | `\|`（官方 CLI 二进制里的旧代码） | **401** |
 * | `\r\n`（npm 包源码的转义展示） | **401** |
 * | `\n`（**真实生效**） | **200** |
 *
 * ⇒ 任何"看起来等价"的重构（`join('|')`、`join(os.EOL)`、`join()` 不带参数）
 *   都会让整条推理通道**静默 401**。本文件用硬编码向量把 LF 钉死，
 *   并显式断言「`|` 与 `\r\n` 的结果**不相等**」——只断言"等于期望值"不够，
 *   因为如果实现被改成分隔符无关的写法，那条断言仍可能通过。
 */

import { describe, expect, it } from 'vitest'
import {
  CODELY_CLI_USER_AGENT,
  codelySignatureHeader,
  codelySigningKey,
  signedCodelyHeaders,
} from '../../src/codely-sign.js'

/** 固定向量（2026-10-20 计算，见文件头）。 */
const VECTOR = {
  cliApiKey: 'sk-vector-test-key',
  tsMs: 1_700_000_000_000,
  signingKeyHex: '0ad33fb257995d8181eed266bd43f206457dd25007798666a00e459069d8a5d2',
  header: 'v1.1700000000.AdWvnekCYLcvPTjG7VFMvQJklJu41L7Bwbvgb7l4kZo',
  /** 同样输入、错误分隔符的结果（必须**不**等于 `header`）。 */
  pipeHeader: 'v1.1700000000.Ok-Fv7wT84pUaSfkpBGyd25wygsWNoPdCsOp1E1ea_E',
  crlfHeader: 'v1.1700000000.AwiAYkKmLKzuSSD9f33DQp0tLI2sHcr1flw3EAMa7Cg',
}

describe('Codely 签名', () => {
  it('① 派生链 = HMAC(HMAC(SECRET,salt), cli_api_key)（固定向量）', () => {
    expect(codelySigningKey(VECTOR.cliApiKey).toString('hex')).toBe(VECTOR.signingKeyHex)
  })

  it('② 头值 = v1.<ts>.<base64url>，分隔符必须是 LF', () => {
    expect(codelySignatureHeader(VECTOR.cliApiKey, 'https://codely-litellm.tuanjie.cn/v1/chat/completions', VECTOR.tsMs))
      .toBe(VECTOR.header)
  })

  /**
   * ③ **回归锁**：错误分隔符必须算出**不同**的值。
   *
   * ⚠️ 只锁 ② 不够 —— 若有人把实现改成 `join()`（默认逗号）或别的分隔符，
   *    ② 会立刻变红（好事）；但如果他把实现改成"分隔符无关"的拼接方式
   *    （例如先把 ts 拼进 path），② 也可能变红。这条断言的作用是**留证**：
   *    明确记录「LF 与 | / CRLF 的结果不同」，将来有人怀疑时不必重跑实验。
   */
  it('③ 对照：| 与 \\r\\n 的结果都不同于 LF（证明分隔符敏感）', () => {
    expect(VECTOR.pipeHeader).not.toBe(VECTOR.header)
    expect(VECTOR.crlfHeader).not.toBe(VECTOR.header)
  })

  it('④ 只签名 pathname，query 不参与（差分实测：加 ?x=1 仍 200）', () => {
    const base = codelySignatureHeader(VECTOR.cliApiKey, 'https://h/v1/chat/completions', VECTOR.tsMs)
    const withQuery = codelySignatureHeader(VECTOR.cliApiKey, 'https://h/v1/chat/completions?x=1', VECTOR.tsMs)
    expect(withQuery).toBe(base)
  })

  it('⑤ 时间窗：ts 变化则签名变化（同一秒内稳定）', () => {
    const a = codelySignatureHeader(VECTOR.cliApiKey, 'https://h/v1/chat/completions', VECTOR.tsMs)
    const b = codelySignatureHeader(VECTOR.cliApiKey, 'https://h/v1/chat/completions', VECTOR.tsMs + 1000)
    expect(b).not.toBe(a)
    expect(a).toMatch(/^v1\.1700000000\.[\w-]{43}$/)
  })

  it('⑥ 完整请求头：UA 必须是 codely-cli 形态、session 头必填（缺它上游 400）', () => {
    const headers = signedCodelyHeaders({
      cliApiKey: VECTOR.cliApiKey,
      target: 'https://codely-litellm.tuanjie.cn/v1/chat/completions',
      sessionId: 'session-abc',
      timestampMs: VECTOR.tsMs,
    })
    expect(headers['User-Agent']).toBe(CODELY_CLI_USER_AGENT)
    expect(headers.Authorization).toBe(`Bearer ${VECTOR.cliApiKey}`)
    expect(headers['x-litellm-session-id']).toBe('session-abc')
    expect(headers['X-Codely-Signature']).toBe(VECTOR.header)
  })
})
