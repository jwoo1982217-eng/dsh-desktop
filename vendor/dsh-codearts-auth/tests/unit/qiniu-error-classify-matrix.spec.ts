// ⚠️ 2026-10-31 对抗审计收编（原临时探针 zz-audit-m113-baseline），
// 同日随 P1 修复（401/403 先判 auth）更新期望：
// classifyQiniuError 的**交叉形态矩阵** —— HTTP 状态码与响应体文案**不一致**时的
// 归类必须按下面的不变式走：
//
// 1. **context_window 文案最先**（无论状态码）——PR26 的承重判据（bafbdeb 修的
//    「落 httpErrorCode(400)=INVALID_REQUEST ⇒ 溢出压缩不跑」就坏在顺序上）；
// 2. **401/403 恒归 auth**（状态码优先于额度/限流文案）——对抗审计 M1a 打穿后修
//    （B/B2/I 三格）：认证是账号态，落 quota 会被 markLimited 写成 UTC+8 次日
//    零点冷却，把认证故障放大成封池（loomy 2026-10-06「全池被封」事故同型，
//    不变式见 providers-loomy-raccoon-minimax.md §分类两条不变式 1）；
// 3. 其余按文案语义（额度/限流/形状/服务端）。
//
// 任何人重排 classifyQiniuError 的判定顺序必红（对抗审计 M1/M1b 变异实测有牙）。
// 纯函数调用、零网络。
import { describe, expect, it } from 'vitest'
import { classifyQiniuError } from '../../src/qiniu-product.js'

describe('classifyQiniuError 交叉形态矩阵（判定顺序锁死）', () => {
  it('12 格矩阵：context_window 最先、401/403 恒 auth、其余按文案', () => {
    const rows: Array<[string, { kind: string }, string]> = [
      // —— 不变式 1：context_window 文案压过一切状态码 ——
      ['A: 429 + maximum context length', classifyQiniuError(429, '{"error":{"message":"This model\'s maximum context length is 40960 tokens"}}'), 'context_window'],
      ['A2: 429 + context_length_exceeded', classifyQiniuError(429, '{"error":{"message":"context_length_exceeded: reduce the length"}}'), 'context_window'],
      ['C: 400 + too many tokens', classifyQiniuError(400, '{"error":{"message":"you sent too many tokens"}}'), 'context_window'],
      ['C2: 400 + input tokens exceed', classifyQiniuError(400, '{"error":{"message":"input tokens exceed the maximum"}}'), 'context_window'],
      // —— 不变式 2：401/403 状态码压过额度/限流文案（P1 修复的核心格）——
      ['B: 401 + quota exhausted', classifyQiniuError(401, '{"error":{"message":"quota exhausted, please top up"}}'), 'auth'],
      ['B2: 403 + insufficient balance', classifyQiniuError(403, '{"error":{"message":"insufficient balance"}}'), 'auth'],
      ['I: 401 + rate limit wording', classifyQiniuError(401, '{"error":{"message":"rate limit reached"}}'), 'auth'],
      ['F: 401 invalid api key', classifyQiniuError(401, '{"error":{"message":"invalid api key"}}'), 'auth'],
      // —— 其余按文案语义 ——
      ['D: 502 + insufficient quota', classifyQiniuError(502, 'upstream insufficient quota'), 'quota'],
      ['E: 429 plain rate limit', classifyQiniuError(429, '{"error":{"message":"Too Many Requests"}}'), 'rate_limit'],
      ['G: 400 invalid parameter', classifyQiniuError(400, '{"error":{"message":"invalid parameter"}}'), 'invalid_request'],
      ['H: 402 balance not enough', classifyQiniuError(402, '{"error":{"message":"balance not enough"}}'), 'quota'],
    ]
    const flips = rows.filter(([, actual, expected]) => actual.kind !== expected)
    // 逐格点名（不是只数数量）：哪一格翻转，报哪一格。
    expect(flips.map(([n, a, e]) => `${n}: got=${a.kind} want=${e}`)).toEqual([])
  })
})
