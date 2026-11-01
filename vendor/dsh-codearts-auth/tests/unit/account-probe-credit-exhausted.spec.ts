/**
 * `account-probe.ts` 的**额度耗尽（14018）**两条腿（Gitee IKQ6HJ）。
 *
 * ## ⚠️⚠️ 为什么必须有本文件（对抗审计实测的 P0）
 *
 * 本 issue 有两半：推理腿写冷却（`buddy-adapter.ts`）+ 探测腿回写冷却
 * （`account-probe.ts`）。第一版只给**推理腿**写了用例，探测腿的那两条改动
 * **零守卫** —— 审计用变异验证实测：
 *
 * | 变异 | 结果 |
 * |---|---|
 * | 把探测腿的 `creditExhaustedResetAtMs()` 换回 `parsed?.resetTimeMs`（修复前行为） | **10904 条用例全绿** |
 * | 把「额度已耗尽（不是频率限流）」文案档删成 `仍受限：…` | 5 个相关 spec **全绿** |
 *
 * ## 为什么不能复用 `deps.probe` 注入点
 *
 * `retestAccount(pool, id, { probe })` 的 `probe` 注入会**整个绕过**
 * `probeWithAdapter` —— 而被测代码正是 `probeWithAdapter` 里的那段。用注入点
 * 写出来的用例只能证明「注入的东西被调用了」，是**恒真**的。
 *
 * ⇒ 本文件走**真实链路**：注册真实的 `probeById` runtime + 替换
 * `globalThis.fetch` 让适配器收到我们构造的 14018 报文。
 *
 * ⚠️ 注册的是**生产那张表**（`src/index.ts` 的 `probeById`），不是在测试里重写
 * 一份 —— 与 `account-probe-adapter.spec.ts` 同一条纪律。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  creditExhaustedResetAtMs,
  explicitRateResetAtMs,
} from '../../src/llm-adapter.js'
import { nextUtc8DayStartMs } from '../../src/model-queue.js'
import type { ProbePool } from '../../src/account-probe.js'
import type { ProviderAccountEntry } from '../../src/types.js'

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

/** 「14018 码 + 服务端声明了显式重置时刻」——锁两条腿同源的那一格。 */
const WITH_EXPLICIT_RESET = JSON.stringify({
  code: 14018,
  msg: 'Credits exhausted. Your quota will reset at 2099-12-31 23:59:59 UTC+8',
})

const MODEL = 'deepseek-v4.1-flash'

function makeEntry(): ProviderAccountEntry {
  return {
    id: 'workbuddy-1',
    provider: 'workbuddy',
    credentialRef: 'WORKBUDDY_ACCOUNT_WORKBUDDY_1',
    enabled: true,
    nickname: 'probe-target',
    modelRateLimits: { [MODEL]: Date.now() + 60_000 },
  } as never
}

/** 最小池替身：记录 `updateModelRateLimit` 的写入，供断言实际落库的时刻。 */
function makePool(): ProbePool & { writes: Array<{ modelId: string; resetAtMs: number }> } {
  const entry = makeEntry()
  const writes: Array<{ modelId: string; resetAtMs: number }> = []
  return {
    writes,
    findAccount: () => entry,
    listAccountsByProvider: () => [entry],
    resolveCredentialForAccount: async () => ({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_at: String(Date.now() + 7_200_000),
      token_type: 'Bearer',
      scope: '',
      domain: 'www.workbuddy.ai',
    }) as never,
    clearModelRateLimits: async () => 0,
    updateModelRateLimit: async (_accountId: string, modelId: string, resetAtMs: number) => {
      writes.push({ modelId, resetAtMs })
    },
  } as never
}

beforeEach(async () => {
  const [{ probeById }, { registerProviderRuntime, clearProviderRuntimes }, { descriptorOf }] =
    await Promise.all([
      import('../../src/index.js'),
      import('../../src/provider-runtime.js'),
      import('../../src/provider-registry.js'),
    ])
  clearProviderRuntimes()
  for (const [id, probe] of Object.entries(probeById)) {
    const descriptor = descriptorOf(id)
    if (descriptor !== undefined) registerProviderRuntime({ descriptor, probe })
  }
})

afterEach(async () => {
  vi.unstubAllGlobals()
  const { clearProviderRuntimes } = await import('../../src/provider-runtime.js')
  clearProviderRuntimes()
})

/** 让适配器的 `fetch` 收到指定报文（不发真实网络请求）。 */
function stubFetch(body: string, status: number): void {
  vi.stubGlobal('fetch', async () => new Response(body, { status }))
}

describe('account-probe 的额度耗尽（14018）回写腿', () => {
  it('★ 探测腿写下的终点 = 自然日（不是 1 小时兜底）', async () => {
    stubFetch(REAL_14018, 429)
    const { retestAccount } = await import('../../src/account-probe.js')
    const pool = makePool()

    const before = Date.now()
    const result = await retestAccount(pool, 'workbuddy-1')

    // 报文里没有时间字段 ⇒ 终点必须是 UTC+8 当日 24:00。
    expect(pool.writes, '必须真的回写了一次').toHaveLength(1)
    const written = pool.writes[0]!.resetAtMs
    expect(written).toBeGreaterThanOrEqual(nextUtc8DayStartMs(before))
    expect(written).toBeLessThanOrEqual(nextUtc8DayStartMs(Date.now()))
    // ⚠️ 反向对照（**不是恒真**）：必须**不等于** 1 小时兜底。
    // 若只有上面那条，在当天 23:00 之后跑时会与 +1h 接近而失去判别力。
    expect(Math.abs(written - (before + 3_600_000)), '不得落回 1 小时兜底')
      .toBeGreaterThan(60_000)
    expect(result.stillLimited).toHaveLength(1)
  })

  it('★ 文案档：额度耗尽必须与「仍受限」分开措辞', async () => {
    stubFetch(REAL_14018, 429)
    const { retestAccount } = await import('../../src/account-probe.js')
    const pool = makePool()

    const result = await retestAccount(pool, 'workbuddy-1')
    const message = result.stillLimited[0]!.message ?? ''
    // 真实出路是「等次日配额或充值」，不是「稍后再试」。
    expect(message).toContain('额度已耗尽')
    expect(message).toContain('不是频率限流')
    expect(message).not.toContain('仍受限：')
    // ⚠️ 文案**不得**断言「已按 …… 设置」：池的「只接受更长」语义会让写入被
    // 静默忽略，那时文案就是假话（对抗审计实测）。
    expect(message).not.toContain('已按')
  })

  it('★ 两条腿同源：服务端给了显式时刻时，探测腿与推理腿写同一个值', async () => {
    // 推理腿的表达式（`buddy-adapter.ts`）：explicit ?? 自然日。
    const inference = explicitRateResetAtMs(WITH_EXPLICIT_RESET) ?? creditExhaustedResetAtMs()
    stubFetch(WITH_EXPLICIT_RESET, 429)
    const { retestAccount } = await import('../../src/account-probe.js')
    const pool = makePool()

    await retestAccount(pool, 'workbuddy-1')

    expect(pool.writes).toHaveLength(1)
    // 第一版探测腿**只有自然日那一半** ⇒ 同一条报文算出两个解禁时刻，
    // 用户点一次「重测」就看到时间跳变（实测 2099 vs 2026-10-25）。
    expect(pool.writes[0]!.resetAtMs, '两条腿必须存同一个时刻').toBe(inference)
  })

  it('★ 不回归：普通限流且无时刻 ⇒ 「仍受限」档（不得被额度档抢走）', async () => {
    stubFetch(JSON.stringify({ code: 6004, msg: '频率限制' }), 429)
    const { retestAccount } = await import('../../src/account-probe.js')
    const pool = makePool()

    const result = await retestAccount(pool, 'workbuddy-1')
    const message = result.stillLimited[0]!.message ?? ''
    expect(message).toContain('仍受限')
    expect(message).not.toContain('额度已耗尽')
  })
})
