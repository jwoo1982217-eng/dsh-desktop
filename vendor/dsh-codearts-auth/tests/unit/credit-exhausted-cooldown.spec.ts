/**
 * 额度耗尽（`14018 Credits exhausted`）的共享判据与冷却终点（Gitee IKQ6HJ）。
 *
 * ## 真实缺陷
 *
 * `14018` 与频率限流**共用 HTTP 429**，但两者恢复机制相反：
 * | | 频率限流 | 额度耗尽 |
 * |---|---|---|
 * | 恢复 | 时间到了就好（分钟级滚动） | **等次日配额 / 充值** |
 * | 冷却终点 | 服务端时刻，否则 +1h | **UTC+8 当日 24:00** |
 *
 * 上游 14018 报文里**一个时间字段都没有**，故旧实现必然落进 1 小时兜底 ⇒
 * 账号每小时被重新选中一次、必然再失败一次。
 *
 * ## ⚠️ 这些判据为什么必须放在共享层（`llm-adapter.ts`）
 *
 * `account-probe.ts`（重测回写）与 `buddy-adapter.ts`（推理记账）**都要用同一个
 * 终点**；而探测层不得反向依赖某个渠道的适配器 ——
 * `tests/unit/account-probe-adapter.spec.ts` 普遍 `vi.mock('../../src/buddy-adapter.js')`，
 * 形成依赖后那个 mock 会把该函数一起变成 `undefined`（本 issue 记录的真实陷阱）。
 */
import { describe, expect, it } from 'vitest'
import {
  CREDIT_EXHAUSTED_BUSINESS_CODE,
  creditExhaustedResetAtMs,
  explicitRateResetAtMs,
  isCreditExhausted,
  isRateLimited,
  parseRateLimitError,
  RATE_LIMIT_FALLBACK_MS,
} from '../../src/llm-adapter.js'
import { nextUtc8DayStartMs } from '../../src/model-queue.js'

/** 上游逐字报文（`www.workbuddy.ai`，HTTP 429）—— **没有任何时间字段**。 */
const REAL_14018 = JSON.stringify({
  error: {
    data: {
      code: 14018,
      msg: 'Credits exhausted. Please visit the link below to purchase add-on packs '
        + 'and get more credits: https://www.codebuddy.ai/profile/usage ',
      requestId: '5f0cfd4f-77d3-406d-b1ab-445090c0a535',
    },
  },
})

describe('isCreditExhausted', () => {
  it('★ 真实报文（码在嵌套 error.data.code 里）判 true', () => {
    // ⚠️ 这条腿**不可省**：只看顶层 `code` 会让码值判据在这家恒不命中，
    // 只剩英文文案腿 —— 上游一改文案就静默失效。
    expect(isCreditExhausted(REAL_14018)).toBe(true)
    expect(CREDIT_EXHAUSTED_BUSINESS_CODE).toBe(14018)
  })

  it('扁平形态 / 字符串码同样认', () => {
    expect(isCreditExhausted(JSON.stringify({ code: 14018, msg: 'x' }))).toBe(true)
    expect(isCreditExhausted(JSON.stringify({ code: '14018', msg: 'x' }))).toBe(true)
  })

  it('★ 嵌套码值腿必须独立有牙（对抗审计实测 M5 假绿）', () => {
    // ⚠️ 真实报文是 `{"error":{"data":{"code":14018,...}}}`（码在**第二层**），
    // 但它同时也带英文文案 "Credits exhausted" ⇒ **文案腿会独立命中**，
    // 于是「只保留顶层 code」的变异下所有用例仍然全绿（实测 M5：0 条红）。
    // ⇒ 必须用**没有英文文案**的报文单独锁住码值腿，否则那一条腿永远没有守卫。
    const nestedData = JSON.stringify({ error: { data: { code: 14018 } } })
    const nestedError = JSON.stringify({ error: { code: 14018 } })
    // 前提：这两份报文都**不含**任何文案线索（否则测的又是文案腿）。
    expect(nestedData).not.toContain('exhausted')
    expect(nestedError).not.toContain('exhausted')
    expect(isCreditExhausted(nestedData), '第二层 error.data.code').toBe(true)
    expect(isCreditExhausted(nestedError), '第一层 error.code').toBe(true)
  })

  it('★ 三条腿逐一独立：只有码值腿能救的报文必须命中', () => {
    // 表驱动：每份报文都**只**留一条线索，删掉任一腿都会有一格红。
    const cases: Array<[string, string]> = [
      ['仅嵌套码值（无文案）', JSON.stringify({ error: { data: { code: 14018 } } })],
      ['仅顶层码值（无文案）', JSON.stringify({ code: 14018 })],
      ['仅英文文案（无码值）', 'credits exhausted'],
      ['仅中文文案（无码值）', '额度已用尽'],
    ]
    for (const [label, body] of cases) {
      expect(isCreditExhausted(body), label).toBe(true)
    }
  })


  it('★ 不误伤：频率限流 6004 / 模型饱和 14003 / 上下文超长 11115 都判 false', () => {
    // 这三条是**行为分叉**的邻居：误判会让「发太快」或「模型忙」拿到一整天的冷却。
    expect(isCreditExhausted(JSON.stringify({ code: 6004, msg: '频率限制' }))).toBe(false)
    expect(isCreditExhausted(JSON.stringify({ code: 14003, msg: 'too many requests' }))).toBe(false)
    expect(isCreditExhausted(JSON.stringify({
      code: 11115,
      msg: 'prompt is too long: 1061554 tokens > 1048576 maximum',
    }))).toBe(false)
  })

  it('★ `insufficient` 单独出现不算额度耗尽（上下文措辞会被误伤）', () => {
    // 同类误伤在 classifyLoomyFailure / classifyRaccoonFailure 各踩过一次。
    expect(isCreditExhausted('the context window is insufficient for this model')).toBe(false)
    expect(isCreditExhausted(JSON.stringify({
      code: 400, msg: 'insufficient permissions to access this resource',
    }))).toBe(false)
  })

  it('空串与纯文本错误页', () => {
    expect(isCreditExhausted('')).toBe(false)
    // 网关包装过的纯文本 / HTML 错误页：文案腿必须生效。
    expect(isCreditExhausted('<html>502 Credits exhausted</html>')).toBe(true)
  })

  it('中文「额度/积分/余额 + 不足/耗尽/用尽」的确定性组合', () => {
    expect(isCreditExhausted('额度已用尽')).toBe(true)
    expect(isCreditExhausted('积分不足')).toBe(true)
    expect(isCreditExhausted('余额耗尽')).toBe(true)
    // 反向：只有「额度」两个字（正文讨论额度）不得命中。
    expect(isCreditExhausted('你的额度是按日结算的')).toBe(false)
  })
})

describe('creditExhaustedResetAtMs', () => {
  it('★ 恒等于 UTC+8 当日 24:00（不是 +24h，更不是 +1h）', () => {
    // 注入一个确定的时刻：2026-10-25 23:50 UTC+8 = 15:50 UTC。
    const lateNight = Date.UTC(2026, 9, 25, 15, 50, 0)
    const reset = creditExhaustedResetAtMs(lateNight)
    expect(reset).toBe(nextUtc8DayStartMs(lateNight))
    // ⚠️ 这一格是 IKL80H 那起事故的核心：滑动 24h 会让 23:50 烧光的账号
    // 被封到**次日 23:50**，而正确终点只差 10 分钟。
    expect(reset - lateNight).toBeLessThanOrEqual(10 * 60_000)
    expect(reset).toBe(Date.UTC(2026, 9, 25, 16, 0, 0))
  })

  it('★ 严格大于注入时刻（否则标记写进去立刻过期、等于没写）', () => {
    for (const hourUtc of [0, 6, 12, 15, 15.9, 16, 20, 23]) {
      const now = Date.UTC(2026, 9, 25, 0, 0, 0) + hourUtc * 3_600_000
      expect(creditExhaustedResetAtMs(now)).toBeGreaterThan(now)
    }
  })
})

describe('explicitRateResetAtMs', () => {
  it('★ 服务端给了时刻就取它（嵌套 msg 也要认）', () => {
    const body = JSON.stringify({
      error: { data: { code: 6004, msg: 'your usage will reset at 2099-12-31 23:59:59 UTC+8' } },
    })
    expect(explicitRateResetAtMs(body)).toBe(Date.parse('2099-12-31 23:59:59 UTC+8'))
  })

  it('★ 没给时刻返回 undefined（**不兜底** —— 兜底是 parseRateLimitError 的职责）', () => {
    expect(explicitRateResetAtMs(REAL_14018)).toBeUndefined()
    expect(explicitRateResetAtMs('')).toBeUndefined()
    expect(explicitRateResetAtMs('not json')).toBeUndefined()
  })

  it('★ 与 parseRateLimitError 的分工：后者必然给时刻（含兜底）', () => {
    // 同一条 14018 报文：explicit 说「上游没给」，parse 说「那就 1 小时兜底」。
    // 两者**刻意不同**：混用会让 14018 继续落进 1 小时（本 issue 的缺陷形态）。
    expect(explicitRateResetAtMs(REAL_14018)).toBeUndefined()
    const parsed = parseRateLimitError(REAL_14018, 'm', 429)
    expect(parsed).not.toBeNull()
    expect(parsed!.resetTimeMs - Date.now()).toBeLessThanOrEqual(RATE_LIMIT_FALLBACK_MS)
  })
})

describe('与既有判据的边界（不得回归）', () => {
  it('★ 14018 仍是「可换号」的失败（isRateLimited 必须继续判 true）', () => {
    // 本 issue 只改**冷却终点**，不改「是否换号」：池里其它账号额度独立、可用。
    expect(isRateLimited(REAL_14018, 429)).toBe(true)
  })

  it('★ 三个判据互不吞并（同一报文在各自判据下结论稳定）', () => {
    // 表驱动的「一格一行」：任何一格翻转都说明有人动错了判据。
    const cases: Array<[string, string, boolean, boolean]> = [
      ['14018 额度耗尽', REAL_14018, true, true],
      ['6004 频率限流', JSON.stringify({ code: 6004, msg: '频率限制' }), false, true],
      ['14003 模型饱和', JSON.stringify({ code: 14003, msg: 'too many requests' }), false, true],
      ['11115 上下文超长', JSON.stringify({ code: 11115, msg: 'prompt is too long' }), false, false],
    ]
    for (const [label, body, credit, rate] of cases) {
      expect(isCreditExhausted(body), `${label} · isCreditExhausted`).toBe(credit)
      expect(isRateLimited(body, rate ? 429 : 400), `${label} · isRateLimited`).toBe(rate)
    }
  })
})
