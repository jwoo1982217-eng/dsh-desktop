/**
 * Codely 的**请求级换号 + 冷却**（2026-10-20 接上）。
 *
 * ## 为什么要有这份用例（用户报障）
 *
 * 积分用完时上游回 **HTTP 402 `budget_exceeded`**，而适配器当时把它归成
 * `SERVER` ⇒ 宿主按「可重试的服务端错误」在**同一个死账号**上退避重试 5 次
 * （截图里 5/5 × 7541ms），然后整轮失败 —— 而池里明明还有别的账号。
 *
 * ## 锁住的四条行为
 *
 * ① 402 / 预算耗尽 ⇒ **换号重发**（不是重试、也不是直接失败）；
 * ② 失败账号**立刻记账**（含最后一个），否则下次仍选中它 ⇒ 又撞一次墙；
 * ③ 冷却时刻按语义分流：402/预算 → UTC+8 次日 0 点，429 → 1h；
 * ④ 非账号级失败（500 等）**不换号**（换了也撞同一堵墙，白烧整池）。
 *
 * ## 关于「假池的两条腿」（与 `accio-account-rotation.spec.ts` 同规格）
 *
 * ⚠️ 替身**必须**同样实现 `exclude` 与 `modelRateLimits` 过滤：少一条腿，
 * 「漏传 `tried`」或「modelId 传空串」这类缺陷在测试里就**看不出来**（该家实测过）。
 */

import { describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CodelyAdapter, isCodelyRotatableFailure } from '../../src/codely-adapter.js'
import { nextUtc8DayStartMs } from '../../src/model-queue.js'
import type { CodelyCredential } from '../../src/codely-auth.js'

const MODEL = 'codely-basic'

const cred = (token: string): CodelyCredential =>
  ({ access_token: token, refresh_token: `refresh-${token}`, obtained_at: 0 }) as never

/** 一次成功的 SSE 流（`data:` 帧 + `[DONE]`，与 `codely-adapter.ts` 的解析口径一致）。 */
const sseOk = (text = 'ok') => () => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
  + 'data: [DONE]\n\n',
  { status: 200 },
)

/**
 * 真实 402 报文（用户报障截图同形）。
 *
 * ⚠️ `cost` 参数（2026-10-24 加）是用来**区分两种预算耗尽**的：
 *
 * | 调用 | 报文 | 语义 |
 * |---|---|---|
 * | 各账号都 `budgetExceeded()`（不传参） | 逐字**相同** | **团队级** —— 换号无用 |
 * | 各账号 `budgetExceeded(1.5)` / `(2.5)` | 逐字**不同** | **账号级** —— 换号有用 |
 *
 * 缺省值保持原样 ⇒ 不传参的既有调用点仍然描述团队级场景，语义不变。
 */
const budgetExceeded = (cost = 54.708759999999994) => new Response(JSON.stringify({
  error: {
    message: `Budget has been exceeded! Current cost: ${cost}, Max budget: -1.0.`,
    type: 'budget_exceeded',
    param: null,
    code: '402',
  },
}), { status: 402 })

const rateLimited = () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })

/** 与真实 `AccountPool` 同形的替身：`exclude` + `modelRateLimits` 两条腿都在。 */
function makePool(records: Array<{ id: string; credential?: CodelyCredential }>) {
  const picks: Array<{ model: string; exclude: string[] }> = []
  const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
  /** 回滚记录：适配器判定为团队级后清掉的冷却标记。 */
  const clears: Array<{ accountId: string; modelIds: string[] }> = []
  const limits = new Map<string, Record<string, number>>()
  const accounts = records.map((r) => ({ id: r.id, credential: r.credential ?? cred(`TOK-${r.id}`) }))
  const pool = {
    getAvailableAccount: async (
      _provider: string,
      modelId: string,
      exclude?: ReadonlySet<string>,
    ): Promise<{ entry: { id: string; credentialRef: string }; credential: CodelyCredential } | null> => {
      picks.push({ model: modelId, exclude: [...(exclude ?? [])] })
      for (const account of accounts) {
        if (exclude?.has(account.id)) continue
        // ⚠️ 与真实池同形：空 modelId 短路、不过滤
        if (modelId.length > 0) {
          const resetAt = limits.get(account.id)?.[modelId]
          if (typeof resetAt === 'number' && Date.now() < resetAt) continue
        }
        return { entry: { id: account.id, credentialRef: `REF_${account.id}` }, credential: account.credential }
      }
      return null
    },
    updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
      marks.push({ accountId, modelId, resetAtMs })
      limits.set(accountId, { ...(limits.get(accountId) ?? {}), [modelId]: resetAtMs })
    },
    /**
     * 与真实 `AccountPool` 同形：清冷却标记，返回清除条数。
     *
     * ⚠️ 替身**必须**提供这个：适配器判定团队级后要用它**回滚**已记的预算账。
     *    缺了它，实现侧的 `try/catch` 会把失败静默吞掉 ⇒ 回滚到底有没有发生
     *    变得不可观测，这条链就成了「看起来对、其实没做事」。
     */
    clearModelRateLimits: async (accountId: string, modelIds?: readonly string[]) => {
      const current = limits.get(accountId)
      if (current === undefined) return 0
      const targets = modelIds === undefined
        ? Object.keys(current)
        : modelIds.filter((m) => Object.prototype.hasOwnProperty.call(current, m))
      clears.push({ accountId, modelIds: targets })
      for (const m of targets) delete current[m]
      if (Object.keys(current).length === 0) limits.delete(accountId)
      return targets.length
    },
    /** 预置某账号处于冷却中（模拟「上一轮已被 402 标记」）。 */
    preset: (accountId: string, modelId: string, resetAtMs: number) => {
      limits.set(accountId, { ...(limits.get(accountId) ?? {}), [modelId]: resetAtMs })
    },
  }
  return { pool, picks, marks, clears }
}

interface Harness {
  adapter: CodelyAdapter
  /** 每次**推理**请求带的 `Authorization`（可反查用的是哪个账号的 key）。 */
  chatAuth: string[]
  chatCalls: () => number
}

function makeAdapter(opts: {
  pool?: unknown
  chatQueue: Array<Response | (() => Response)>
  credentialProvider?: () => Promise<CodelyCredential | undefined>
}): Harness {
  const chatAuth: string[] = []
  let chatCalls = 0
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (url.includes('/api/api-token/cli-api-key')) {
      // ⚠️ key 必须按**该账号的 access_token** 派生，才能在推理侧反查账号身份。
      const token = String(headers.Authorization ?? '').replace(/^Bearer\s+/i, '')
      return new Response(JSON.stringify({ cli_api_key: `sk-${token}`, user_id: 1 }), { status: 200 })
    }
    chatCalls += 1
    chatAuth.push(String(headers.Authorization ?? ''))
    const next = opts.chatQueue.shift()
    if (next === undefined) throw new Error('unexpected chat request')
    return typeof next === 'function' ? next() : next
  })
  const adapter = new CodelyAdapter({
    ...opts.credentialProvider === undefined ? {} : { credentialProvider: opts.credentialProvider },
    ...opts.pool === undefined ? {} : { accountPool: opts.pool as never },
    fetchImpl: fetchImpl as never,
  })
  return { adapter, chatAuth, chatCalls: () => chatCalls }
}

/** 跑一次 `stream()`；返回 chunk 或抛出的错误。 */
async function run(adapter: CodelyAdapter): Promise<{ chunks: StreamChunk[]; error?: unknown }> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream({
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) {
      chunks.push(chunk)
    }
    return { chunks }
  } catch (error) {
    return { chunks, error }
  }
}

describe('Codely 请求级换号 + 冷却', () => {
  it('★ 402 积分耗尽 ⇒ 换到第二个账号重发（不再同一账号重试 5 次）', async () => {
    const { pool, marks } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ])
    const { adapter, chatAuth, chatCalls } = makeAdapter({ pool, chatQueue: [budgetExceeded(), sseOk()] })
    const { chunks, error } = await run(adapter)

    expect(error).toBeUndefined()
    expect(chatCalls(), '两次推理请求：一次的 402 + 换号后成功').toBe(2)
    // ⚠️ 决定性断言：第二次请求必须换成**另一个账号**的 key（不是同一个死账号重试）。
    expect(chatAuth).toEqual(['Bearer sk-TOK-A', 'Bearer sk-TOK-B'])
    // 失败账号必须被记账（否则下次请求仍会先选中它）。
    expect(marks.map((m) => m.accountId)).toEqual(['acc-1'])
    expect(marks[0]?.modelId).toBe(MODEL)
    // 402/预算 ⇒ 精确到 **UTC+8 次日 0 点**（比「大于 now」更严：它同时排除了
    // 「记成 1h 档」与「记成某个随手的时间」；且与时区/当前时刻无关，永不腐坏）
    expect(marks[0]?.resetAtMs).toBe(nextUtc8DayStartMs())
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)).toEqual(['ok'])
  })

  it('★ 整池耗尽 ⇒ QUOTA_EXCEEDED（绝不归 SERVER）+ 每个失败账号都被记账', async () => {
    const { pool, marks } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ])
    // ⚠️ 两个账号的 `Current cost` 不同 ⇒ 报文逐字不同 ⇒ **账号级**预算耗尽，
    //    换号有用，所以两个都得记账（这是本用例要钉的语义）。
    //    若这里写成两次 `budgetExceeded()`（报文相同），语义就变成团队级了 ——
    //    那种场景由下面「团队预算耗尽」那条用例覆盖。
    const { adapter, chatCalls } = makeAdapter({ pool, chatQueue: [budgetExceeded(1.5), budgetExceeded(2.5)] })
    const { error } = await run(adapter)

    expect((error as { code?: string }).code, '402 必须归 QUOTA_EXCEEDED：'
      + '归 SERVER 会让宿主退避重试 5 次（每次都注定失败）').toBe('QUOTA_EXCEEDED')
    expect(String((error as Error).message)).toMatch(/已轮换 2 个账号/)
    expect(String((error as Error).message), '必须指路到「签到」这个唯一有效动作').toMatch(/签到/)
    expect(chatCalls(), '两个账号各发一次，换不到第三个就停').toBe(2)
    // ⚠️ 关键：**两个**都要记账（只记第一个 = minimax「8 号只记 7」的同型缺陷）
    expect(marks.map((m) => m.accountId)).toEqual(['acc-1', 'acc-2'])
  })

  it('★ 团队预算耗尽 ⇒ 第 2 个号就停止，且后续账号不被连坐记账', async () => {
    const { pool, marks, clears } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
      { id: 'acc-3', credential: cred('TOK-C') },
    ])
    // ⚠️ 三个账号返回**逐字相同**的预算报文 ⇒ 团队级：换号撞的是同一堵墙。
    const { adapter, chatCalls } = makeAdapter({
      pool,
      chatQueue: [budgetExceeded(), budgetExceeded(), budgetExceeded()],
    })
    const { error } = await run(adapter)

    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
    // 决定性①：第 2 个号撞同一份报文就停，不去试第 3 个。
    expect(chatCalls(), '团队级：撞同一份报文的第 2 个号之后立即停止').toBe(2)
    // 决定性②：**只记第 1 个**。第 2 个号没被记账 —— 它本身是好的，只是撞了团队墙；
    //          把它记进冷却表等于把一个好号封到次日 0 点（本次修复的核心）。
    expect(marks.map((m) => m.accountId), '第 2 个号不得被连坐记账').toEqual(['acc-1'])
    // 决定性③：第 1 个号在判定**之前**就被记账了（判定只能在第 2 个号之后发生），
    //    所以它必须被**回滚** —— 否则「团队级不连坐」只做了一半：撞同一堵墙的
    //    好号里，第一个仍然被封到次日 0 点，只因为它排在第一位。
    expect(clears.map((c) => c.accountId), '第 1 个号已记的账必须被回滚').toEqual(['acc-1'])
    expect(clears[0]?.modelIds, '回滚只针对本次模型，不得清掉该账号的其它冷却').toHaveLength(1)
    // 文案必须挑明是团队层面、换号无用，否则用户会去做一个注定无效的动作。
    expect(String((error as Error).message), '需说明是团队层面').toMatch(/团队/)
    expect(String((error as Error).message), '团队级不该再建议签到（领的是个人积分）').not.toMatch(/签到/)
  })

  it('★ 报文带 request_id / 浮点尾差 ⇒ 归一化后仍判团队级（2026-10-31 对抗审计 1D 修）', async () => {
    const { pool, marks, clears } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ])
    // ⚠️⚠️ 本用例与「团队预算耗尽」的差别只在**报文不再逐字相同**：
    //    每份报文带不同的 `request_id`（LiteLLM problem/json 实测逐次易变），
    //    `cost` 是同一数值的两种序列化尾差。逐字比对会让团队级判定**静默永不
    //    触发**（两号报文必然不等）⇒ 退化回修复前「整池封到次日 0 点」。
    //    判据必须先归一化（剥 request_id + 抹浮点尾差）再比。
    const withNoise = (cost: string, requestId: string) => new Response(JSON.stringify({
      error: {
        message: `Budget has been exceeded! Current cost: ${cost}, Max budget: -1.0.`,
        type: 'budget_exceeded',
        param: null,
        code: '402',
      },
      request_id: requestId,
      instance: '/v1/chat/completions',
    }), { status: 402 })
    const { adapter, chatCalls } = makeAdapter({
      pool,
      chatQueue: [withNoise('54.708759999999994', 'req-aaa'), withNoise('54.70876', 'req-bbb')],
    })
    const { error } = await run(adapter)

    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
    expect(chatCalls(), '归一化后骨架一致 ⇒ 第 2 个号即停').toBe(2)
    expect(marks.map((m) => m.accountId), '第 2 个号不被连坐记账').toEqual(['acc-1'])
    expect(clears.map((c) => c.accountId), '第 1 个号的账被回滚').toEqual(['acc-1'])
    expect(String((error as Error).message)).toMatch(/团队/)
  })

  it('★ 连续性反例：A 402(X) → B 429 → C 402(X) ⇒ 不判团队级，三个号都记账（2026-10-31 审计补牙）', async () => {
    const { pool, marks } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
      { id: 'acc-3', credential: cred('TOK-C') },
    ])
    // ⚠️⚠️ 「团队级判定要求**真正连续**」的另一半：非预算轮次（429）必须清空
    //    lastBudgetDetail。删掉清空分支 ⇒ C 拿 A 的报文比对成功 ⇒ 误判团队级、
    //    提前 break、C 不记账 —— 而真实情况是 B 只是被限流、池里还有可用号。
    //    本用例钉住：429 插在两个相同 402 之间**必须打断**连续性。
    const { adapter, chatCalls } = makeAdapter({
      pool,
      chatQueue: [budgetExceeded(), rateLimited(), budgetExceeded()],
    })
    const { error } = await run(adapter)

    expect((error as { code?: string }).code, '三个号各撞各的墙 ⇒ 仍是 QUOTA_EXCEEDED').toBe('QUOTA_EXCEEDED')
    expect(chatCalls(), '不得在 C 号提前停止（429 打断了连续性）').toBe(3)
    expect(marks.map((m) => m.accountId), '三个号全部记账（C 是真预算耗尽，必须记）')
      .toEqual(['acc-1', 'acc-2', 'acc-3'])
    expect(String((error as Error).message), '不是团队级 ⇒ 不得出现团队级专属文案'
      + '（账号级文案本身含「团队预算」四字，判据必须钉团队级独有那句）')
      .not.toMatch(/团队层面|换号无用|均已回滚/)
  })

  it('★ 换号预算上限：账号再多也只试 5 个（不得无限换号）', async () => {
    const accounts = Array.from({ length: 8 }, (_, i) => ({ id: `acc-${i}`, credential: cred(`TOK-${i}`) }))
    const { pool, marks } = makePool(accounts)
    const { adapter, chatCalls } = makeAdapter({
      pool,
      // ⚠️ 8 个账号各自 `Current cost` 不同 ⇒ 都是**账号级**预算耗尽 ⇒ 换号有用
      //    ⇒ 应当一直换到 5 个上限。若这里 8 份报文逐字相同（团队级），适配器会
      //    在第 2 个号就停止（那是下面「团队预算耗尽」用例的预期，不是这条的）。
      chatQueue: Array.from({ length: 8 }, (_, i) => budgetExceeded(i + 1)),
    })
    const { error } = await run(adapter)

    expect(chatCalls(), 'CODERLY_MAX_ROTATE = 5').toBe(5)
    expect(marks.length, '5 个试过的账号都要记账').toBe(5)
    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
  })

  it('★ 冷却中的账号被跳过（初始选号就绕开它）', async () => {
    const { pool, marks } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ])
    // 模拟：acc-1 上一轮已被 402 标记，处于冷却期。
    pool.preset('acc-1', MODEL, Date.now() + 3_600_000)
    const { adapter, chatAuth, chatCalls } = makeAdapter({ pool, chatQueue: [sseOk()] })
    const { error } = await run(adapter)

    expect(error).toBeUndefined()
    expect(chatAuth, '冷却中的 acc-1 不得被选中').toEqual(['Bearer sk-TOK-B'])
    expect(chatCalls()).toBe(1)
    expect(marks.length, '成功路径不写任何冷却标记').toBe(0)
  })

  it('★ 429 限流 ⇒ 记 1 小时冷却并换号（与 402 的「次日解冻」分流）', async () => {
    const { pool, marks } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ])
    const { adapter, chatAuth } = makeAdapter({ pool, chatQueue: [rateLimited(), sseOk()] })
    const { error } = await run(adapter)

    expect(error).toBeUndefined()
    expect(chatAuth).toEqual(['Bearer sk-TOK-A', 'Bearer sk-TOK-B'])
    // ⚠️ 1 小时档（±10s 容差），绝不能是「次日 0 点」那一档
    expect(marks[0]?.resetAtMs).toBeGreaterThan(Date.now() + 3_500_000)
    expect(marks[0]?.resetAtMs).toBeLessThan(Date.now() + 3_650_000)
  })

  it('非账号级失败（500）⇒ SERVER 且不换号（换了也撞同一堵墙）', async () => {
    const { pool, marks, picks } = makePool([
      { id: 'acc-1', credential: cred('TOK-A') },
      { id: 'acc-2', credential: cred('TOK-B') },
    ])
    const { adapter, chatCalls } = makeAdapter({
      pool,
      chatQueue: [new Response('upstream boom', { status: 500 })],
    })
    const { error } = await run(adapter)

    expect((error as { code?: string }).code).toBe('SERVER')
    expect(chatCalls(), '500 只发一次：换号无益').toBe(1)
    expect(marks.length, '500 不写冷却标记').toBe(0)
    // ⚠️ 换号查询只在「可换号失败」时发生（500 不该触发第二次选号）
    expect(picks.length, '仅初始选号一次').toBe(1)
  })

  it('无账号池（旧桩路径）⇒ 402 仍归 QUOTA_EXCEEDED，且不重试（单次请求）', async () => {
    const { adapter, chatCalls } = makeAdapter({
      credentialProvider: async () => cred('TOK-A'),
      chatQueue: [budgetExceeded()],
    })
    const { error } = await run(adapter)

    expect((error as { code?: string }).code, '无池也要正确归类 —— 归类与换号是两件事').toBe('QUOTA_EXCEEDED')
    expect(String((error as Error).message)).toMatch(/预算已用尽/)
    expect(chatCalls(), '无池 ⇒ 无换号能力，只发一次').toBe(1)
  })

  it('★ 换号判类（可换号 vs 不换号）', () => {
    expect(isCodelyRotatableFailure(402, '')).toBe(true)
    expect(isCodelyRotatableFailure(429, '')).toBe(true)
    // 报文里有 `budget_exceeded` 也认（上游偶发以其它状态码带该语义）
    expect(isCodelyRotatableFailure(200, '{"error":{"type":"budget_exceeded"}}')).toBe(true)
    // ⚠️ 401/403 不换号：Codely 的 401 绝大多数是「团队无权访问该模型」，
    //    换账号撞的是同一个团队策略。
    expect(isCodelyRotatableFailure(401, '')).toBe(false)
    expect(isCodelyRotatableFailure(403, '')).toBe(false)
    expect(isCodelyRotatableFailure(500, '')).toBe(false)
  })
})

/**
 * ★★ **换发 `cli_api_key` 失败必须换号**（2026-10-22 对抗审计 P0）。
 *
 * ## 修的那个真缺陷
 *
 * `fetchCodelyCliApiKey` 在**任何非 2xx**（含 401/403/429/5xx）**与网络异常**时
 * 一律返回 `undefined`（`codely-auth.ts` 的 `!res.ok` 早退 + `catch` 兜底）
 * ⇒ 「换发失败」会命中**远超「token 过期」**的情形。
 *
 * 原实现对它**直接 `throw`**：既不换号、也不 `continue` ⇒ **池里明明还有能用的号，
 * 一个都不试**。实测（池 2 个号，acc-1 过期 / acc-2 正常）：
 * ```
 * 修复前：CALLS=["exchange:EXPIRED"]                     ERROR=PERMISSION_DENIED
 * 修复后：CALLS=["exchange:EXPIRED","exchange:GOOD","chat"]  → 正常出字
 * ```
 *
 * ## 为什么这条必须单独写（既有 8 条换号用例全都抓不到）
 *
 * 它们把 `makeAdapter` 里的换发端点**恒桩成 200**（`sk-${token}`）⇒ 换发失败这条腿
 * **永不进入**。我实测：把修复回退成 `throw` 后，既有 8 条**一条都不红**。
 */
describe('Codely 换号：换发 cli_api_key 失败也必须换号', () => {
  /** 让**指定账号**的换发失败（其余正常）。 */
  function adapterWithExpiredExchange(
    pool: unknown,
    expiredToken: string,
    chatQueue: Array<Response | (() => Response)>,
  ): { adapter: CodelyAdapter; exchangeAuth: string[]; chatAuth: string[] } {
    const exchangeAuth: string[] = []
    const chatAuth: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      const auth = String(headers.Authorization ?? '')
      if (url.includes('/api/api-token/cli-api-key')) {
        exchangeAuth.push(auth)
        // ⚠️ 只让这一个号的换发失败 —— 模拟「该账号 access_token 已过期」。
        if (auth === `Bearer ${expiredToken}`) return new Response('expired', { status: 401 })
        return new Response(JSON.stringify({ cli_api_key: `sk-${auth.replace(/^Bearer\s+/i, '')}`, user_id: 1 }), { status: 200 })
      }
      chatAuth.push(auth)
      const next = chatQueue.shift()
      if (next === undefined) throw new Error('unexpected chat request')
      return typeof next === 'function' ? next() : next
    })
    const adapter = new CodelyAdapter({
      accountPool: pool as never,
      fetchImpl: fetchImpl as never,
    })
    return { adapter, exchangeAuth, chatAuth }
  }

  it('★★ 首号换发 401 ⇒ **换到第二个号**并成功出字（原缺陷：直接抛、池里好号不被尝试）', async () => {
    const { pool } = makePool([
      { id: 'acc-1', credential: cred('EXPIRED') },
      { id: 'acc-2', credential: cred('GOOD') },
    ])
    const { adapter, exchangeAuth, chatAuth } = adapterWithExpiredExchange(pool, 'EXPIRED', [sseOk()])
    const { chunks, error } = await run(adapter)

    expect(error, '⚠️ 池里有能用的号，不得报错').toBeUndefined()
    // ⚠️ 决定性断言：两个号的换发都被试过（而不是只试第一个就抛）。
    expect(exchangeAuth, '两个号的换发都必须被尝试').toEqual(['Bearer EXPIRED', 'Bearer GOOD'])
    // ⚠️ 推理必须用**第二个号**换发出来的 key（不是死号）。
    expect(chatAuth, '推理必须换成 acc-2 的 key').toEqual(['Bearer sk-GOOD'])
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)).toEqual(['ok'])
  })

  it('★ 所有号都换发失败 ⇒ PERMISSION_DENIED 且文案给可执行的出路（不是「点续期」死路）', async () => {
    const { pool } = makePool([
      { id: 'acc-1', credential: cred('BAD-1') },
      { id: 'acc-2', credential: cred('BAD-2') },
    ])
    const { exchangeAuth, adapter } = adapterWithExpiredExchange(pool, 'BAD-1', [])
    // acc-2 也让它失败：再包一层
    const both = adapterWithExpiredExchange(pool, 'BAD-1', [])
    void adapter
    void both
    void exchangeAuth
    // 用「两个号都坏」的夹具重跑（上面那个 helper 只坏一个，故这里手工构造）
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/api-token/cli-api-key')) return new Response('nope', { status: 401 })
      throw new Error('不该发推理请求')
    })
    const bad = new CodelyAdapter({ accountPool: pool as never, fetchImpl: fetchImpl as never })
    const { error } = await run(bad)
    expect(error, '全都换发失败 ⇒ 必须报错（不静默）').toBeDefined()
    expect(String((error as { code?: string }).code)).toBe('PERMISSION_DENIED')
    // ⚠️ 文案必须给**可逆**的出路，且**明确劝阻删号**（2026-10-22 A1 修）：
    //    删号不可逆，而「换发端点拒了」不等于「凭据在本地坏了」。
    expect(String((error as Error).message)).toContain('重测')
    expect(String((error as Error).message)).toContain('不要急着删除账号')
  })
})

/**
 * ★★ **换发失败必须按 `kind` 分档**（2026-10-22 对抗审计 A1，P0 修复的守卫）。
 *
 * ## 守的两条真缺陷（原实现同一处代码、两条用户可见后果）
 *
 * ① **一次网络抖动锁死整池**：旧实现把「网络异常 / 5xx / 401」全挤成同一个
 *    `undefined`，然后无条件 `updateModelRateLimit(…, nextUtc8DayStartMs())`
 *    ⇒ 一次 5 秒的 DNS 抖动让池里**每个**号被锁到 UTC+8 次日 0 点（实测 11.15h）。
 * ② **文案引导删号**：旧文案写「请**删除该账号**后重新新建」—— 删除不可逆，
 *    而凭据其实完好。
 *
 * ## 判据为什么打在「记账」与「错误码」上（而不是只断言不抛错）
 *
 * 只断言「抛错了」是**恒真**的（旧实现也抛）。有判别力的是：
 * - `marks`（池里真被写了几笔、时刻是多少）—— ① 的唯一可观测出口；
 * - `error.code` 与 `message` —— ② 的唯一可观测出口；
 * - `chatCalls` / `exchangeAuth` —— 证明「transient **不该**换号」。
 */
describe('Codely 换发失败分档：transient 不得锁号、不得引导删号', () => {
  /** 让换发端点按给定行为响应；推理端点记录调用。 */
  function adapterWithExchangeBehaviour(
    pool: unknown,
    exchange: () => Response | Promise<Response>,
  ): { adapter: CodelyAdapter; exchangeCalls: () => number; chatCalls: () => number } {
    let exchangeCalls = 0
    let chatCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/api-token/cli-api-key')) {
        exchangeCalls += 1
        return exchange()
      }
      chatCalls += 1
      return new Response('should not chat', { status: 500 })
    })
    const adapter = new CodelyAdapter({
      accountPool: pool as never,
      fetchImpl: fetchImpl as never,
    })
    return { adapter, exchangeCalls: () => exchangeCalls, chatCalls: () => chatCalls }
  }

  it('★★ 网络异常（fetch 抛 ECONNRESET）⇒ 零记账、SERVER、文案劝阻删号', async () => {
    const { pool, marks } = makePool([
      { id: 'acc-1', credential: cred('A') },
      { id: 'acc-2', credential: cred('B') },
    ])
    const { adapter, exchangeCalls } = adapterWithExchangeBehaviour(pool, () => {
      throw Object.assign(new Error('fetch failed'), { cause: new Error('read ECONNRESET') })
    })
    const { error } = await run(adapter)

    // ① 决定性断言：**一个号都不许被记账**（原缺陷：两个号全锁到次日 0 点）
    expect(marks, '网络抖动不得写任何限流标记（原缺陷：整池锁到次日 0 点）').toEqual([])
    // ② 错误码必须是 SERVER（宿主可重试），且不是 AUTH（会吞掉文案）
    expect(String((error as { code?: string }).code)).toBe('SERVER')
    const message = String((error as Error).message)
    expect(message, '文案必须说清是网络/上游问题').toContain('网络异常')
    expect(message, '文案必须明确劝阻删号').toContain('不要删除账号')
    expect(message, '文案不得再引导删号（旧缺陷）').not.toContain('删除该账号后重新')
    // ③ transient **不换号**：只试了第一个号（换号只会撞同一个上游故障）
    expect(exchangeCalls(), 'transient 不该换号（换了也是白烧整池）').toBe(1)
  })

  it('★★ 上游 500 ⇒ 零记账、SERVER（不得被当成「这个号今天不行了」）', async () => {
    const { pool, marks } = makePool([{ id: 'acc-1', credential: cred('A') }])
    const { adapter } = adapterWithExchangeBehaviour(pool, () => new Response('boom', { status: 500 }))
    const { error } = await run(adapter)

    expect(marks, '5xx 是上游故障，不得写账号级冷却').toEqual([])
    expect(String((error as { code?: string }).code)).toBe('SERVER')
    expect(String((error as Error).message)).toContain('上游 HTTP 500')
  })

  it('★ 换发端点 429 ⇒ transient（网关限流 ≠ 该号没额度）', async () => {
    const { pool, marks } = makePool([{ id: 'acc-1', credential: cred('A') }])
    const { adapter } = adapterWithExchangeBehaviour(pool, () => new Response('slow down', { status: 429 }))
    const { error } = await run(adapter)

    expect(marks, '换发端点的 429 是网关限流，不得写账号冷却').toEqual([])
    expect(String((error as { code?: string }).code)).toBe('SERVER')
  })

  it('★ 2xx 但缺 cli_api_key ⇒ malformed：零记账、SERVER（协议变更不是账号问题）', async () => {
    const { pool, marks } = makePool([{ id: 'acc-1', credential: cred('A') }])
    const { adapter } = adapterWithExchangeBehaviour(
      pool,
      () => new Response(JSON.stringify({ user_id: 1 }), { status: 200 }),
    )
    const { error } = await run(adapter)

    expect(marks, '协议变更不得写账号冷却').toEqual([])
    expect(String((error as { code?: string }).code)).toBe('SERVER')
    expect(String((error as Error).message)).toContain('cli_api_key')
  })

  it('★★ 反向对照：401 仍必须换号 + 记账（上一轮 P0 修复不得被本轮改坏）', async () => {
    const { pool, marks } = makePool([
      { id: 'acc-1', credential: cred('BAD') },
      { id: 'acc-2', credential: cred('GOOD') },
    ])
    const exchangeAuth: string[] = []
    const chatAuth: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      const auth = String(headers.Authorization ?? '')
      if (url.includes('/api/api-token/cli-api-key')) {
        exchangeAuth.push(auth)
        if (auth === 'Bearer BAD') return new Response('expired', { status: 401 })
        return new Response(JSON.stringify({ cli_api_key: `sk-${auth.replace(/^Bearer\s+/i, '')}` }), { status: 200 })
      }
      chatAuth.push(auth)
      return sseOk()()
    })
    const adapter = new CodelyAdapter({ accountPool: pool as never, fetchImpl: fetchImpl as never })
    const { error } = await run(adapter)

    expect(error, '池里有能用的号 ⇒ 不得报错').toBeUndefined()
    // ① 401 必须换号（两个号的换发都被试过）
    expect(exchangeAuth, '401 必须换到第二个号').toEqual(['Bearer BAD', 'Bearer GOOD'])
    // ② 401 必须记账（该号确实不可用）
    expect(marks.length, '401 必须记账（否则下次又选中它）').toBe(1)
    expect(marks[0]!.accountId).toBe('acc-1')
    // ③ 记账时刻必须是「次日 0 点」档（不是 1h，也不是不记）
    expect(marks[0]!.resetAtMs, '凭据类失败沿用 402 那档（UTC+8 次日 0 点）')
      .toBe(nextUtc8DayStartMs())
    // ④ 推理用的是第二个号的 key
    expect(chatAuth).toEqual(['Bearer sk-GOOD'])
  })
})
