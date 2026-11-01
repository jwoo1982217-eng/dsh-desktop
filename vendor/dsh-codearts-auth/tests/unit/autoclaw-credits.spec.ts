import { describe, expect, it, vi } from 'vitest'
import { AUTOCLAW } from '../../src/autoclaw-product.js'
import {
  AUTOCLAW_CLAIM_REFRESH_TIMEOUT_MS,
  AUTOCLAW_DAILY_CLAIM_PATH,
  AUTOCLAW_LEDGER_MAX_PAGES,
  AUTOCLAW_LEDGERS_PATH,
  AUTOCLAW_WALLETS_PATH,
  claimAutoclawDailyQuota,
  fetchAutoclawBalanceDetailed,
  fetchAutoclawCreditBalance,
  fetchAutoclawLedgerEntries,
  parseAutoclawLedgerBatches,
  parseAutoclawWallets,
} from '../../src/autoclaw-credits.js'
import { createProviderCredits } from '../../src/provider-credits.js'
import { AutoclawAuth } from '../../src/autoclaw-auth.js'
import { Context } from '@deepseek-ai/cordis'
import { DAILY_POOL_NAMES, findDailyPool, splitCreditsByExpiry } from '../../plugin-src/client/credit-expiry.js'
import { readFileSync } from 'node:fs'
import type { AutoclawCredential } from '../../src/autoclaw.js'

const MOCK_CREDENTIAL: AutoclawCredential = {
  access_token: 'test_access_token_1234567890',
  refresh_token: 'test_refresh_token_1234567890',
  device_id: 'test-device-uuid-999',
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 真实的 /agent-assetmgr/api/v2/wallets 响应样例（实测数据结构）。 */
const MOCK_WALLETS_PAYLOAD = {
  code: 0,
  msg: 'SUCCESS',
  time: 1792165659918,
  trace: 'test-trace-id',
  data: {
    schema_version: 'wallets.v2',
    total_balance: 32365,
    wallets: [
      {
        public_wallet_type: 'reward',
        display_name: '奖励积分',
        balance: 32365,
        balance_view: '3.2w',
        display: true,
        priority: 10,
      },
      {
        public_wallet_type: 'daily',
        display_name: '每日积分',
        balance: 0,
        balance_view: '0',
        display: false,
        priority: 20,
      },
      {
        public_wallet_type: 'subscription',
        display_name: '签约积分',
        balance: 0,
        balance_view: '0',
        display: false,
        priority: 30,
      },
      {
        public_wallet_type: 'fuel_pack',
        display_name: '加油包积分',
        balance: 0,
        balance_view: '0',
        display: false,
        priority: 40,
      },
      {
        public_wallet_type: 'other',
        display_name: '其他积分',
        balance: 0,
        balance_view: '0',
        display: false,
        priority: 50,
      },
    ],
  },
}

describe('parseAutoclawWallets', () => {
  it('只保留服务端 display=true 的可见池，其余（display=false）按官方客户端同款过滤', () => {
    const packages = parseAutoclawWallets(MOCK_WALLETS_PAYLOAD.data.wallets)
    // ⚠️ 夹具是真实响应：4 个隐藏池 display=false（官方 main.cjs readWallets
    //    只保留 display === true）。旧断言期望 5 个全出 ⇒ 正是「每日 0」红字的根源。
    expect(packages).toHaveLength(1)

    expect(packages[0]).toMatchObject({
      name: '奖励积分',
      remaining: 32365,
      total: 32365,
      active: true,
      unit: '积分',
    })
    // ⚠️ 「每日红 + 刷新倒计时」按池名匹配（DAILY_POOL_NAMES 含「每日积分」），
    //    是 Loomy 当日重置池的语义；AutoClaw 的每日签到积分按批次到期（见流水批次
    //    分组），隐藏池被滤掉后不再渲染红色「每日 0」。
    expect(packages.some((p) => p.name === '每日积分')).toBe(false)
  })

  it('缺失 display_name 时按 public_wallet_type 回退默认中文标签', () => {
    const raw = [
      // ⚠️ 夹具必须显式带 `display: true`：现在解析器按官方口径
      //    `wallet.display === true` **严格**判断，缺字段即不可见
      //    （本用例考的是 `display_name` 回退，不是 `display`）。
      { public_wallet_type: 'fuel_pack', display_name: '', balance: 500, display: true, priority: 1 },
      { public_wallet_type: 'daily', display_name: '', balance: 100, display: true, priority: 2 },
    ]
    const packages = parseAutoclawWallets(raw)
    expect(packages[0]!.name).toBe('加油包积分')
    expect(packages[0]!.remaining).toBe(500)
    expect(packages[1]!.name).toBe('每日积分')
    expect(packages[1]!.remaining).toBe(100)
  })

  it('传入非数组或空数组时安全返回空数组', () => {
    expect(parseAutoclawWallets(null)).toEqual([])
    expect(parseAutoclawWallets({})).toEqual([])
    expect(parseAutoclawWallets('invalid')).toEqual([])
  })
})

describe('fetchAutoclawBalanceDetailed & fetchAutoclawCreditBalance', () => {
  it('正常请求返回余额并携带正确的查询参数与请求头', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(MOCK_WALLETS_PAYLOAD))
    const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(result.error).toBeUndefined()
    expect(result.balance).not.toBeNull()
    expect(result.balance!.total).toBe(32365)
    // ⚠️ display=false 的隐藏池被滤掉（见 parseAutoclawWallets 的守卫），
    //    且本桩对流水 URL 回钱包载荷（无 entries）⇒ 批次为空 ⇒ 回退钱包包。
    expect(result.balance!.packages).toHaveLength(1)
    expect(result.balance!.expiredTotal).toBe(0)

    // ⚠️ 两次调用：先钱包、再流水（临期桶数据源）。流水响应没有 entries
    //    （本桩对所有 URL 回同一载荷）⇒ 批次为空 ⇒ 回退钱包包，形状不变。
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_WALLETS_PATH}?biz_app_id=autoclaw`)
    expect(init.method).toBe('GET')

    const headers = init.headers as Record<string, string>
    expect(headers['X-Auth-Appid']).toBe(AUTOCLAW.appId)
    expect(headers['X-Auth-TimeStamp']).toBeDefined()
    expect(headers['X-Auth-Sign']).toBeDefined()
    expect(headers['X-Authorization']).toBe(`Bearer ${MOCK_CREDENTIAL.access_token}`)
  })

  it('access_token 缺失时本地快速拦截，返回提示而不发起网络请求', async () => {
    const fetcher = vi.fn()
    const result = await fetchAutoclawBalanceDetailed({ access_token: '' }, {
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(result.balance).toBeNull()
    expect(result.error).toContain('未登录或凭据缺失')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('服务端返回 code 410000 时，返回明确的登录失效重新登录提示', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      code: 410000,
      msg: '用户未登录，请重新登录',
    }))
    const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(result.balance).toBeNull()
    expect(result.error).toContain('登录凭据失效，请重新登录')
  })

  it('HTTP 状态非 200 或网络请求异常时不崩溃并返回错误原因', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('Gateway Error', { status: 502 }))
    const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result.balance).toBeNull()
    expect(result.error).toContain('HTTP 502')

    const netFetcher = vi.fn().mockRejectedValue(new Error('Network connection timeout'))
    const netResult = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      fetcher: netFetcher as unknown as typeof fetch,
    })
    expect(netResult.balance).toBeNull()
    expect(netResult.error).toContain('Network connection timeout')
  })

  it('fetchAutoclawCreditBalance 与 fetchAutoclawBalanceDetailed 行为一致', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(MOCK_WALLETS_PAYLOAD))
    const balance = await fetchAutoclawCreditBalance(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(balance).not.toBeNull()
    expect(balance!.total).toBe(32365)
  })
})

describe('claimAutoclawDailyQuota', () => {
  /** 造一个按 URL 分流的 fetcher（领取接口 / 钱包接口各返回不同响应）。 */
  function makeFetcher(opts: {
    claimData: Record<string, unknown>
    walletTotal?: number
    /** 让 refresh 端点失败（用来验证「刷新失败仍能签到」的降级路径）。 */
    refreshFails?: boolean
  }) {
    return vi.fn().mockImplementation((url: string) => {
      if (String(url).includes(AUTOCLAW_WALLETS_PATH)) {
        const total = opts.walletTotal ?? 100
        return Promise.resolve(jsonResponse({
          code: 0,
          msg: 'SUCCESS',
          data: {
            schema_version: 'wallets.v2',
            total_balance: total,
            wallets: [{
              public_wallet_type: 'reward',
              display_name: '奖励积分',
              balance: total,
              display: true,
              priority: 10,
            }],
          },
        }))
      }
      /**
       * ★ `claimAutoclawDailyQuota` 在签到**之前**会先调 refresh（= 登录事件）。
       * 必须显式应答它：否则真实生产路径上的「先刷新再签到」序列在测试里
       * 会退化成「刷新连续失败 + 降级」，测的就不是生产行为了。
       */
      if (String(url).includes('/userapi/v1/refresh') || String(url).includes('/userapi/v1/agent-refresh')) {
        if (opts.refreshFails) {
          return Promise.resolve(jsonResponse({ code: 401, msg: 'refresh token invalid' }))
        }
        return Promise.resolve(jsonResponse({
          code: 0,
          msg: 'SUCCESS',
          data: {
            /**
             * ⚠️ 值刻意**低熵、短**（`stub-at` / `stub-rt`）：
             * `repo-pii-guard.spec.ts` 的「凭据字段名 + 高熵字面量」判据会把
             * `refresh_token: '<长串>'` 当成**疑似真实凭据**报红。
             * 构造样例要像样例，不要长得像密钥。
             */
            access_token: 'stub-at',
            refresh_token: 'stub-rt',
            expires_in: 3600,
            expires_at: Date.now() + 3_600_000,
          },
        }))
      }
      return Promise.resolve(jsonResponse({ code: 0, msg: 'SUCCESS', data: opts.claimData }))
    })
  }

  it('daily_check_in_completed_on_request 为 true 时返回 claimed，并带说明文案', async () => {
    // ⚠️⚠️ 上游**不返回**领到多少（2026-10-17 真机取证：data 只有
    //   `{ uid, daily_check_in_completed_on_request }`）。
    //   ⇒ `credit` 只能是 0，但**必须**附说明文案，
    //     否则界面显示「签到成功，+0 积分」会被读成「白签了一次」。
    // ⚠️ 为什么不在 claim 内部量余额差：那要在领取**前**多读一次钱包，
    //   而 `already-claimed`（最常见的日常路径）也会白付这次请求。
    //   取舍见 `autoclaw-credits.ts` 的注释。
    const fetcher = makeFetcher({
      claimData: { uid: 'user_123', daily_check_in_completed_on_request: true },
    })

    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(outcome.kind).toBe('claimed')
    expect(outcome.kind === 'claimed' && outcome.credit).toBe(0)
    // ⚠️ 这条才是防「+0 被误解」的判据。
    expect((outcome as { delayedMessage?: string }).delayedMessage).toContain('上游不返回积分数量')

    /**
     * ⚠️ 现在是**两次**请求：refresh（登录事件）+ 领取。
     *
     * 不再读钱包 —— 那一点仍要守住（见下面的 wallets 断言）。
     */
    expect(fetcher).toHaveBeenCalledTimes(2)
    const urls = fetcher.mock.calls.map((c) => String(c[0]))
    expect(urls.filter((u) => u.includes(AUTOCLAW_WALLETS_PATH))).toHaveLength(0)

    // ★ 关键顺序：refresh 必须**先于**领取（服务端在签发 token 时记「登录」）
    const claimIdx = urls.findIndex((u) => u.includes(AUTOCLAW_DAILY_CLAIM_PATH))
    const refreshIdx = urls.findIndex((u) => u.includes('/userapi/v1/refresh'))
    expect(refreshIdx).toBeGreaterThanOrEqual(0)
    expect(refreshIdx).toBeLessThan(claimIdx)

    const [url, init] = fetcher.mock.calls[claimIdx] as [string, RequestInit]
    expect(url).toBe(`${AUTOCLAW.apiBase}${AUTOCLAW_DAILY_CLAIM_PATH}`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      source_id: 'autoclaw',
      device_id: MOCK_CREDENTIAL.device_id,
    })
    /**
     * ★★ 领取必须用**刷新后的** token：那正是「登录事件」在服务端的凭据。
     * 用原 token 会在服务端看来仍是「未登录的新请求」，活动奖励不发
     * （2026-10-27 真机对照：同一账号，仅差这一次 refresh，结果差 10000 积分）。
     */
    const claimHeaders = init.headers as Record<string, string>
    expect(claimHeaders.Authorization).toContain('stub-at')
  })

  it('⚠️ 凭据没有 device_id 时**不得**回落到固定常量（会共用假设备号）', async () => {
    // 修复前回落到 `'dsh-autoclaw-device-001'` —— 所有调用方共用同一个假设备号，
    // 上游风控会把不同用户识别成同一台设备刷接口。
    const fetcher = makeFetcher({
      claimData: { uid: 'user_123', daily_check_in_completed_on_request: false },
    })
    const noDevice: AutoclawCredential = {
      access_token: 'test_access_token_1234567890',
      refresh_token: 'test_refresh_token_1234567890',
    }
    await claimAutoclawDailyQuota(noDevice, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })
    /**
     * ⚠️⚠️ **必须按 URL 取那一次调用，不能用 `mock.calls[0]`**
     * （2026-10-27 审计 P2-3，实测的静默漂移）：
     * 签到腿现在**先发 refresh 再发 claim** ⇒ `calls[0]` 已经是 **refresh** 请求，
     * 而本用例的受测对象是 claim 请求。原写法之所以没红，只是因为
     * `deviceId` 两条腿共用同一个局部变量 —— **侥幸**，不是判据正确。
     */
    const calls = fetcher.mock.calls as [string, RequestInit][]
    const claimCall = calls.find((c) => String(c[0]).includes(AUTOCLAW_DAILY_CLAIM_PATH))
    expect(claimCall, '找不到 claim 请求').toBeDefined()
    const body = JSON.parse(claimCall![1].body as string)
    expect(body.device_id, '不该是那个固定常量').not.toBe('dsh-autoclaw-device-001')
    // ⚠️ 必须是 UUID 形态（随机造的），不是写死的字符串。
    expect(body.device_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    // 两腿必须用**同一个** device_id（服务端按设备记登录，见 `refresh` 的请求体判据）。
    const refreshCall = calls.find((c) => String(c[0]).includes('/userapi/v1/refresh'))
    if (refreshCall !== undefined) {
      const refreshBody = JSON.parse(refreshCall[1].body as string)
      expect(refreshBody.device_id, '两条腿用了不同的设备号 ⇒ 登录事件挂在另一个设备上').toBe(body.device_id)
    }
  })

  it('daily_check_in_completed_on_request 为 false 时返回 already-claimed', async () => {
    const fetcher = makeFetcher({
      claimData: { uid: 'user_123', daily_check_in_completed_on_request: false },
    })

    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(outcome).toEqual({
      kind: 'already-claimed',
      message: '今日已完成签到',
    })
    // ⚠️ 这条路径**不该**读钱包（省请求）。
    const urls = fetcher.mock.calls.map((c) => String(c[0]))
    expect(urls.filter((u) => u.includes(AUTOCLAW_WALLETS_PATH))).toHaveLength(0)
  })

  /**
   * ★★ **刷新（登录事件）先于签到**（2026-10-27 真机取证）。
   *
   * 用户报障原文：「说的登录就有」（官方活动「1 亿 Tokens 登录即领」领不到）。
   *
   * 根因：官方客户端（`main.cjs` 的 `claimDailyCreditsOnSignIn`）监听**登录状态**，
   * 一进入 `authenticated` 就调一次 `user-info`；服务端把「**签发 token**」当作登录，
   * 之后那次 `user-info` 才发放 `autoclaw_user_active_reward_*`。
   * 本插件此前只用存量 token 调 `user-info` ⇒ 服务端眼里从没登录过 ⇒ 奖励不发。
   *
   * 真机对照（同一账号、同一端点）：存量 token → 只有每日签到；
   * `refresh` → `user-info` ⇒ **立刻 +10000 积分**。
   */
  it('★ 领取前先刷新 token（服务端据此认定「登录」并发放活动奖励）', async () => {
    const fetcher = makeFetcher({
      claimData: { uid: 'user_123', daily_check_in_completed_on_request: true },
    })

    await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })

    const urls = fetcher.mock.calls.map((c) => String(c[0]))
    const refreshIdx = urls.findIndex((u) => u.includes('/userapi/v1/refresh'))
    const claimIdx = urls.findIndex((u) => u.includes(AUTOCLAW_DAILY_CLAIM_PATH))
    expect(refreshIdx, '必须先发 refresh').toBeGreaterThanOrEqual(0)
    expect(refreshIdx, 'refresh 必须早于领取').toBeLessThan(claimIdx)

    // refresh 的请求体要带 refresh_token 与同一个 device_id（服务端按设备记登录）
    const [, refreshInit] = fetcher.mock.calls[refreshIdx] as [string, RequestInit]
    const refreshBody = JSON.parse(refreshInit.body as string)
    expect(refreshBody.refresh_token).toBe(MOCK_CREDENTIAL.refresh_token)
    expect(refreshBody.source_id).toBe('autoclaw')
    /**
     * ⚠️ 补上**注释已经声称、但此前没有断言**的那一条（2026-10-27 审计 P2-3）：
     * 注释写着「与同一个 device_id」，而代码只断言了 `refresh_token` 与
     * `source_id` ⇒ 刷新腿换用别的设备号也照样绿，而服务端**按设备记登录**
     * ⇒ 登录事件会挂到另一个设备上。
     */
    expect(refreshBody.device_id, '刷新腿必须带调用方给的 device_id').toBe(MOCK_CREDENTIAL.device_id)
  })

  /**
   * ⚠️★ **刷新失败绝不阻断签到**。
   *
   * 取舍理由：签到（每日额度）是既有价值，活动奖励是**增量**。
   * 若把「登录事件」失败升级成签到失败，等于用一个新功能打坏一个老功能 ——
   * 而 refresh 失败在生产上并不罕见（token 过期、上游抖动）。
   */
  it('★ 刷新失败时降级用原 token 继续签到（不把新功能变成新的故障点）', async () => {
    const fetcher = makeFetcher({
      claimData: { uid: 'user_123', daily_check_in_completed_on_request: true },
      refreshFails: true,
    })

    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(outcome.kind, '刷新失败不得让签到失败').toBe('claimed')

    const calls = fetcher.mock.calls as [string, RequestInit][]
    const claimCall = calls.find((c) => String(c[0]).includes(AUTOCLAW_DAILY_CLAIM_PATH))
    expect(claimCall).toBeDefined()
    // 用的仍是**原** token（没有可用的新 token）
    expect((claimCall![1].headers as Record<string, string>).Authorization)
      .toContain(MOCK_CREDENTIAL.access_token)
  })

  it('凭据里没有 refresh_token 时跳过刷新，只发签到请求', async () => {
    const fetcher = makeFetcher({
      claimData: { uid: 'user_123', daily_check_in_completed_on_request: true },
    })

    await claimAutoclawDailyQuota(
      { ...MOCK_CREDENTIAL, refresh_token: '' },
      { product: AUTOCLAW, fetcher: fetcher as unknown as typeof fetch },
    )

    const urls = fetcher.mock.calls.map((c) => String(c[0]))
    expect(urls.filter((u) => u.includes('/refresh'))).toHaveLength(0)
    expect(urls.filter((u) => u.includes(AUTOCLAW_DAILY_CLAIM_PATH))).toHaveLength(1)
  })

  it('请求失败或网络异常时不抛错，返回 failed 状态', async () => {
    /**
     * ⚠️ 用 `mockImplementation` 而不是 `mockResolvedValue`：`claim` 现在会先发
     * refresh 再发签到，**两次读同一个 `Response` 对象**会抛
     * `Body is unusable`（body 只能读一次）。真实上游每次都返回新对象，
     * 故这里每次调用现造一个 —— mock 必须贴合真实形状，否则测的是 mock 的 bug。
     */
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      code: 5001,
      msg: '签到服务繁忙',
    })))

    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.message).toContain('签到服务繁忙')
    }

    const netErrFetcher = vi.fn().mockRejectedValue(new Error('Connection abort'))
    const netOutcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      fetcher: netErrFetcher as unknown as typeof fetch,
    })
    expect(netOutcome.kind).toBe('failed')
    if (netOutcome.kind === 'failed') {
      expect(netOutcome.message).toContain('Connection abort')
    }
  })
})

describe('临期桶：display 过滤与流水批次（2026-10-17 用户要求「像 buddy 一样红临期加倒计时」）', () => {
  /**
   * ⚠️⚠️ **PR 原文声称的取证来源 `scripts/probe-autoclaw-expiry.mjs` 在本仓库不存在**，
   *   且 `docs/audit/pr111-autoclaw-audit.md` 明确记载钱包接口
   *   `/agent-assetmgr/api/v2/wallets` 的 `wallets[]` **没有任何时间字段**。
   *   ⇒ 下面这份夹具是**形状示例**，不是可复核的真机取证，不得当作实测证据。
   *   ⚠️ 更要紧的是：夹具里 `amount` 是**历史发放额**，而 P0 缺陷正是
   *   「拿发放额当剩余额」⇒ 用户消耗过积分后批次和必然 ≠ `total_balance`
   *   ⇒ 用例④ 之所以能守恒，靠的是「这个账号从未消耗过积分」这一偶然条件。
   */
  const LEDGER_PAGE = {
    code: 0,
    msg: 'SUCCESS',
    data: {
      entries: [
        {
          id: '1', asset_type: 'point', wallet_type: 'earned', wallet_scope: 'campaign',
          mutation_type: 'credit', amount: 20000, source: 'campaign',
          description: 'AutoClaw 用户登录奖励积分，7天有效',
          metadata: { description: 'AutoClaw 用户登录奖励积分，7天有效' },
          occurred_at: '2026-10-15T13:44:21Z', wallet_expires_at: 1_798_885_461,
        },
        {
          id: '2', asset_type: 'point', wallet_type: 'earned', wallet_scope: 'annual',
          mutation_type: 'credit', amount: 200, source: 'manual',
          description: '每日签到',
          metadata: { description: '每日签到' },
          occurred_at: '2026-10-17T13:44:43Z', wallet_expires_at: 1_798_885_483,
        },
        {
          id: '3', asset_type: 'point', wallet_type: 'earned', wallet_scope: 'campaign',
          mutation_type: 'credit', amount: 500, source: 'campaign',
          description: '已过期批次', occurred_at: '2026-10-01T00:00:00Z',
          wallet_expires_at: 1_700_000_000,
        },
      ],
    },
  }

  it('① 服务端 display=false 的隐藏池被丢弃（红色「每日 0」的根源）', () => {
    const raw = {
      total_balance: 20700,
      wallets: [
        { public_wallet_type: 'reward', display_name: '奖励积分', balance: 20700, display: true, priority: 10 },
        // ⚠️⚠️ **隐藏池余额刻意取非 0（8888）**：这是本用例「有牙」的唯一原因。
        //   原先夹具里隐藏池余额恰好全是 0 ⇒ 把过滤器换成「按 balance === 0 剔除」
        //   （一个同样合理、同样让隐藏池不出现在输出里的实现）**依然全绿** ⇒
        //   该断言对「判据是 display」零判别力。
        //   余额非 0 时，「按余额过滤」立刻变红 ⇒ 判据被真正钉在 display 上。
        { public_wallet_type: 'daily', display_name: '每日积分', balance: 8888, display: false, priority: 20 },
        { public_wallet_type: 'other', display_name: '其他积分', balance: 7777, display: false, priority: 50 },
      ],
    }
    const packages = parseAutoclawWallets(raw.wallets)
    expect(packages, '官方客户端同款过滤（main.cjs readWallets：wallet.display === true）').toHaveLength(1)
    expect(packages[0]!.name).toBe('奖励积分')
    // ⚠️ 隐藏池余额非 0 仍被丢弃 ⇒ 判据是 display，不是余额。
    expect(packages.some((p) => p.name === '每日积分')).toBe(false)
    expect(packages.some((p) => p.name === '其他积分')).toBe(false)
  })

  it('①b display 字段**缺失**必须判为不可见（官方是严格 `=== true`）', () => {
    // ⚠️ 原实现 `typeof cast.display === 'boolean' ? cast.display : true` 在字段缺失时
    //   fail-open ⇒「每日积分」池原样回归 ⇒ **原报障症状（红色「每日 0」）逐字复现**。
    const raw = [
      { public_wallet_type: 'reward', display_name: '奖励积分', balance: 20700, display: true, priority: 10 },
      { public_wallet_type: 'daily', display_name: '每日积分', balance: 0, priority: 20 },
    ]
    const packages = parseAutoclawWallets(raw)
    expect(packages.map((p) => p.name)).toEqual(['奖励积分'])
    expect(packages.some((p) => p.name === '每日积分'), '缺字段不得 fail-open').toBe(false)
  })

  it('② 流水批次 → 逐包 deductionEndTime（毫秒），已过期批次丢弃，守恒口径', () => {
    const batches = parseAutoclawLedgerBatches(LEDGER_PAGE.data.entries, 1_798_800_000_000)
    // 已过期（第 3 条）丢弃；两条未过期按到期时刻各自成包，升序。
    expect(batches).toHaveLength(2)
    expect(batches[0]!.name).toContain('登录奖励')
    expect(batches[0]!.remaining).toBe(20000)
    expect(batches[0]!.deductionEndTime).toBe(1_798_885_461_000)
    expect(batches[1]!.name).toBe('每日签到')
    expect(batches[1]!.remaining).toBe(200)
    expect(batches[1]!.deductionEndTime).toBe(1_798_885_483_000)
    // 守恒：批次之和 == 钱包总额（fetch 层以此决定采用批次还是回退）。
    expect(batches.reduce((s, p) => s + p.remaining, 0)).toBe(20200)
  })

  it('③ 无到期字段的发放归永久桶（不带 deductionEndTime）', () => {
    const batches = parseAutoclawLedgerBatches([
      { mutation_type: 'credit', amount: 300, description: '永久赠送' },
      { mutation_type: 'credit', amount: 100, wallet_expires_at: 1_798_885_461, description: '限时' },
    ], 1_798_800_000_000)
    expect(batches).toHaveLength(2)
    const perm = batches.find((p) => p.deductionEndTime === undefined)
    expect(perm?.remaining).toBe(300)
    expect(batches.find((p) => p.deductionEndTime !== undefined)?.remaining).toBe(100)
  })

  it('④ 守恒成立 ⇒ 用批次包（临期桶可渲染）；不守恒 ⇒ 回退钱包包（不给错数）', async () => {
    const walletsPayload = {
      code: 0, msg: 'SUCCESS',
      data: {
        total_balance: 20200,
        wallets: [{ public_wallet_type: 'reward', display_name: '奖励积分', balance: 20200, display: true, priority: 10 }],
      },
    }
    // 守恒：批次之和 20200 == total_balance ⇒ 采用批次包。
    const okFetcher = vi.fn((url: string | URL) => {
      const u = String(url)
      if (u.includes(AUTOCLAW_LEDGERS_PATH)) return jsonResponse(LEDGER_PAGE)
      return jsonResponse(walletsPayload)
    })
    const ok = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, { fetcher: okFetcher as unknown as typeof fetch })
    expect(ok.balance!.total).toBe(20200)
    expect(ok.balance!.packages).toHaveLength(2)
    expect(ok.balance!.packages.every((p) => p.deductionEndTime !== undefined)).toBe(true)

    // 不守恒（钱包报 99999）⇒ 回退钱包包：宁缺临期，不错数。
    const mismatchPayload = { ...walletsPayload, data: { ...walletsPayload.data, total_balance: 99999 } }
    const badFetcher = vi.fn((url: string | URL) => {
      const u = String(url)
      if (u.includes(AUTOCLAW_LEDGERS_PATH)) return jsonResponse(LEDGER_PAGE)
      return jsonResponse(mismatchPayload)
    })
    const bad = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, { fetcher: badFetcher as unknown as typeof fetch })
    expect(bad.balance!.total).toBe(99999)
    expect(bad.balance!.packages).toHaveLength(1)
    expect(bad.balance!.packages[0]!.name).toBe('奖励积分')
  })

  it('⑤ 流水不可达 ⇒ 回退钱包包，且**真被问过**流水端点（三条失败腿各自独立）', async () => {
    // ⚠️⚠️ 原用例只断言「packages 长度为 1」—— 而「守恒不成立」同样产出长度 1，
    //   两条路径**不可区分** ⇒ 该断言对「流水是否真失败」零判别力
    //   （它唯一有牙的是 `total === 20700`，而那与「守恒」「流水失败」都无关）。
    //   现拆成三条**可区分**的腿，并额外断言「回退时一个带到期时间的包都没有」
    //   （防「半批次」漏红档）。
    const walletsPayload = {
      code: 0, msg: 'SUCCESS',
      data: {
        total_balance: 20700,
        wallets: [{ public_wallet_type: 'reward', display_name: '奖励积分', balance: 20700, display: true, priority: 10 }],
      },
    }
    const build = (ledgerResponse: () => unknown) => {
      const fetcher = vi.fn((url: string | URL) =>
        String(url).includes(AUTOCLAW_LEDGERS_PATH)
          ? ledgerResponse()
          : jsonResponse(walletsPayload),
      )
      return fetcher
    }
    const assertFallback = async (fetcher: ReturnType<typeof build>, why: string) => {
      const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
        fetcher: fetcher as unknown as typeof fetch,
      })
      expect(result.error, why).toBeUndefined()
      expect(result.balance!.total, why).toBe(20700)
      expect(result.balance!.packages, why).toHaveLength(1)
      // ⚠️ 有牙：回退必须是**纯钱包包**（无任何 deductionEndTime），
      //   否则「半批次」会静默漏出红色临期档。
      expect(result.balance!.packages.every((p) => p.deductionEndTime === undefined), why).toBe(true)
      // ⚠️ 有牙：必须**真被问过**流水端点（原用例完全没断言这条链首）。
      expect(
        fetcher.mock.calls.some((c) => String(c[0]).includes(AUTOCLAW_LEDGERS_PATH)),
        `流水端点必须真被请求：${why}`,
      ).toBe(true)
    }

    // 腿①：HTTP 200 但业务 code ≠ 0
    await assertFallback(build(() => jsonResponse({ code: 500, msg: 'boom' })), '腿① 业务失败')
    // 腿②：HTTP 非 2xx（`if (!resp.ok) return all`）
    await assertFallback(
      build(() => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }) as unknown as Response),
      '腿② HTTP 失败',
    )
    // 腿③：传输异常 / 预算耗尽（fetcher reject）
    const rejectFetcher = vi.fn((url: string | URL) =>
      String(url).includes(AUTOCLAW_LEDGERS_PATH)
        ? Promise.reject(new Error('Connection abort'))
        : Promise.resolve(jsonResponse(walletsPayload)),
    )
    const rejected = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      fetcher: rejectFetcher as unknown as typeof fetch,
    })
    expect(rejected.error, '腿③ 网络异常不得让整份余额失败').toBeUndefined()
    expect(rejected.balance!.total, '腿③ 网络异常').toBe(20700)
    expect(rejected.balance!.packages.every((p) => p.deductionEndTime === undefined), '腿③ 网络异常').toBe(true)
  })
})

/**
 * ★★ **PR 115 审计守卫**（本仓库两轮独立审计 + inline 变异验证后新增）。
 *
 * ## 为什么单独成块
 *
 * PR 原有的 5 条用例存在**两类问题**，本块逐条补上「有牙」的写法：
 * ① 部分断言对被测判据**零判别力**（换成同样合理的另一套实现仍全绿）；
 * ② 本 PR 引入的新行为**零守卫**（翻页上界、部分页失败、批次包落档…）。
 *
 * ⚠️ 本仓库反复踩过的坑：**「用例全绿」不等于「守卫有牙」**。
 *   每条下方都写明「什么样的变异能让它变红」，无牙的写法一律不写进去。
 */
describe('★ PR115 审计守卫：审计发现的七处缺陷逐条钉死', () => {
  const NOW_MS = 1_798_800_000_000
  const NOW_SEC = 1_798_800_000
  /** 距 NOW 7 天后到期的秒（用于构造真正的**临期**批次）。 */
  const SOON_SEC = NOW_SEC + 7 * 86400

  function jsonResponse(payload: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response
  }

  /** 只有一个可见池的钱包载荷。 */
  function walletsOf(total: number, wallets?: unknown[]): unknown {
    return {
      code: 0,
      msg: 'SUCCESS',
      data: {
        total_balance: total,
        wallets: wallets ?? [
          { public_wallet_type: 'reward', display_name: '奖励积分', balance: total, display: true, priority: 10 },
        ],
      },
    }
  }

  // ── P0：amount 是「历史发放额」，不是「剩余额」 ──────────────────────
  it('P0 消耗过积分后批次和 ≠ 总额 ⇒ 必须回退钱包包（不得输出错误分档）', async () => {
    // 上游事实：领 20000，之后消耗 19500（走独立 debit 行）。钱包剩 500。
    // 「拿发放额当剩余额」的实现会算出批次和 20000 ⇒ 若它**恰好**被当守恒通过
    // （例如被改成无条件采用批次包），就会给用户报「20000 积分，其中 20000 临期」
    // —— 而真实只剩 500。本用例锁死「必须回退」。
    const ledger = {
      code: 0,
      data: {
        entries: [
          { mutation_type: 'credit', amount: 20000, wallet_expires_at: SOON_SEC, description: '登录奖励' },
          { mutation_type: 'debit', amount: 19500, description: '模型调用' },
        ],
      },
    }
    const fetcher = vi.fn((url: string | URL) =>
      String(url).includes(AUTOCLAW_LEDGERS_PATH) ? jsonResponse(ledger) : jsonResponse(walletsOf(500)),
    )
    const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result.balance!.total).toBe(500)
    // ⚠️ 守恒不成立 ⇒ 必须回退钱包包，且**不得**出现任何带到期时间的包。
    expect(result.balance!.packages.every((p) => p.deductionEndTime === undefined)).toBe(true)
    expect(result.balance!.packages[0]!.remaining).toBe(500)
  })

  // ── P0 补强：真正的临期批次必须能渲染成红色临期 + 倒计时 ────────────
  it('P0-b 守恒成立且批次真在窗口内 ⇒ 必落「临期」档并带出倒计时时刻', () => {
    // ⚠️⚠️ **这是 PR 完全缺失的那条守卫**：原用例只断言 `deductionEndTime`
    //   被算出来，**从不把它喂给客户端的 `splitCreditsByExpiry`**。
    //   而 PR 的验收夹具到期时刻距**真实当前** ~76.7 天 ⇒ 落在 15 天窗口外 ⇒
    //   即便 PR 全绿，实际也只会渲染黄色「长期」，永远不是红色「临期+倒计时」
    //   —— 而那正是用户诉求本体。
    const batches = parseAutoclawLedgerBatches(
      [{ mutation_type: 'credit', amount: 8888, wallet_expires_at: SOON_SEC, description: '7天有效奖励' }],
      NOW_MS,
    )
    expect(batches).toHaveLength(1)
    expect(batches[0]!.deductionEndTime).toBe(SOON_SEC * 1000)

    // 真正喂给客户端判据（唯一权威的三档分桶实现）。
    const split = splitCreditsByExpiry(batches, 15, NOW_MS)
    expect(split).not.toBeNull()
    expect(split!.expiring, '7 天内到期必须落红色临期桶').toBe(8888)
    expect(split!.longTerm).toBe(0)
    expect(split!.permanent).toBe(0)
    // 倒计时时刻就是这一批的到期时刻。
    expect(split!.earliestExpiringAt).toBe(SOON_SEC * 1000)
  })

  it('P0-c 长期批次（超出窗口）必须落「长期」档而不是「临期」', () => {
    // 守恒口径下的对称格：防止「什么批次都算临期」这种更糙的实现蒙混过关。
    const batches = parseAutoclawLedgerBatches(
      [{ mutation_type: 'credit', amount: 8888, wallet_expires_at: NOW_SEC + 90 * 86400, description: '90天' }],
      NOW_MS,
    )
    const split = splitCreditsByExpiry(batches, 15, NOW_MS)
    expect(split!.expiring).toBe(0)
    expect(split!.longTerm).toBe(8888)
    expect(split!.earliestExpiringAt, '长期桶不得产出倒计时').toBeNull()
  })

  // ── P1：批次包名不得命中「当日池」名单（否则整段三档被短路） ──────────
  it('P1 批次包名命中当日池名单时被加后缀，绕开 formatPoolSplitLine 的抢先 return', () => {
    // 客户端链路：usage-badge.js 先算 formatPoolSplitLine，非 null 就**直接返回**，
    // 根本走不到 splitCreditsByExpiry ⇒ 红色临期 + 倒计时整段消失。
    for (const name of DAILY_POOL_NAMES) {
      const batches = parseAutoclawLedgerBatches(
        [
          { mutation_type: 'credit', amount: 20000, wallet_expires_at: SOON_SEC, description: '常规奖励' },
          { mutation_type: 'credit', amount: 200, wallet_expires_at: SOON_SEC + 86400, description: name },
        ],
        NOW_MS,
      )
      expect(batches.length, `${name} 那一笔必须独立成包`).toBe(2)
      const hit = batches.find((p) => p.name.includes(name))
      expect(hit, '该包必须存在').toBeDefined()
      expect(hit!.name, `批次包名必须与当日池「${name}」区分开`).not.toBe(name)
      // ⚠️ 决定性断言：整份 packages **不得**被 findDailyPool 命中。
      expect(findDailyPool(batches), `批次包命中 DAILY_POOL_NAMES（${name}）`).toBeNull()
      // 且仍能正常落三档（未被短路）。
      const split = splitCreditsByExpiry(batches, 15, NOW_MS)
      expect(split!.expiring, '不得因池名被短路掉临期档').toBe(20200)
    }
  })

  it('P1-b 宿主侧当日池名单副本与客户端权威定义逐字一致', () => {
    // ⚠️ 宿主侧 `src/**`（TS）与客户端 `plugin-src/client/**`（JS）**不共享模块图**
    //   ⇒ 只能各存一份。这条守卫就是那份副本的同步锁：
    //   改客户端 `DAILY_POOL_NAMES` 而忘了改宿主侧 ⇒ 本条变红。
    const src = readFileSync(
      new URL('../../src/autoclaw-credits.ts', import.meta.url),
      'utf8',
    )
    const m = src.match(/DAILY_POOL_NAMES_HOST_COPY[^=]*=\s*\[([^\]]*)\]/)
    expect(m, '未找到宿主侧 DAILY_POOL_NAMES_HOST_COPY').not.toBeNull()
    const hostCopy = (m![1].match(/'([^']+)'/g) ?? []).map((s) => s.slice(1, -1))
    expect(hostCopy, '宿主侧副本必须与客户端 DAILY_POOL_NAMES 逐字相同').toEqual([...DAILY_POOL_NAMES])
  })

  // ── P1：所有钱包都隐藏时不得凭空造包 ────────────────────────────────
  it('P1-c 全部钱包 display=false 且 total=0 ⇒ 不得凭空造出「奖励积分」包', async () => {
    const fetcher = vi.fn((url: string | URL) =>
      String(url).includes(AUTOCLAW_LEDGERS_PATH)
        ? jsonResponse({ code: 500 })
        : jsonResponse(walletsOf(0, [
            { public_wallet_type: 'daily', display_name: '每日积分', balance: 0, display: false, priority: 20 },
            { public_wallet_type: 'other', display_name: '其他积分', balance: 0, display: false, priority: 50 },
          ])),
    )
    const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result.balance!.total).toBe(0)
    expect(result.balance!.packages, '零余额不得凭空造包').toHaveLength(0)
  })

  it('P1-d 全部钱包 display=false 但 total>0 ⇒ 兜底包保留总额信息', async () => {
    // 有余额却一个可见池都没有：总额读数是对的，兜底包是合理的
    //（否则合计行会空着）。这两格必须分开判，不能一刀切。
    const fetcher = vi.fn((url: string | URL) =>
      String(url).includes(AUTOCLAW_LEDGERS_PATH)
        ? jsonResponse({ code: 500 })
        : jsonResponse(walletsOf(9000, [
            { public_wallet_type: 'daily', display_name: '每日积分', balance: 0, display: false, priority: 20 },
          ])),
    )
    const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result.balance!.total).toBe(9000)
    expect(result.balance!.packages).toHaveLength(1)
    expect(result.balance!.packages[0]!.remaining).toBe(9000)
  })

  // ── P2：永久桶包名哨兵 ────────────────────────────────────────────
  it('P2 永久桶按描述分列（首条真名恰为默认名时不得被下一条顶掉）', () => {
    // 原实现：单一累加器 + `if (permanentLabel === '其他积分') permanentLabel = name`
    // 哨兵判据退化 ⇒ 第一条真名恰为「其他积分」时哨兵不被替换，被下一条顶掉。
    const batches = parseAutoclawLedgerBatches(
      [
        { mutation_type: 'credit', amount: 100, description: '其他积分' },
        { mutation_type: 'credit', amount: 700, description: '活动永久赠送' },
      ],
      NOW_MS,
    )
    expect(batches.length, '两种来源必须分成两包').toBe(2)
    const byName = Object.fromEntries(batches.map((p) => [p.name, p.remaining]))
    expect(byName['其他积分'], '第一笔 100 不得被并进第二笔').toBe(100)
    expect(byName['活动永久赠送']).toBe(700)
  })

  it('P2-b 同名永久发放仍合并（同来源不该被拆成一堆包）', () => {
    const batches = parseAutoclawLedgerBatches(
      [
        { mutation_type: 'credit', amount: 100, description: '注册奖励' },
        { mutation_type: 'credit', amount: 50, description: '注册奖励' },
      ],
      NOW_MS,
    )
    expect(batches).toHaveLength(1)
    expect(batches[0]!.remaining).toBe(150)
  })

  // ── P2：负数（冲正/退款）不得并入批次 ───────────────────────────────
  it('P2-c 负数 amount（冲正/退款）一律丢弃，不得产出负 remaining', () => {
    const batches = parseAutoclawLedgerBatches(
      [
        { mutation_type: 'credit', amount: 1000, wallet_expires_at: SOON_SEC, description: '奖励' },
        { mutation_type: 'credit', amount: -300, wallet_expires_at: SOON_SEC, description: '冲正' },
      ],
      NOW_MS,
    )
    expect(batches).toHaveLength(1)
    expect(batches[0]!.remaining, '负数不得把批次压低').toBe(1000)
    expect(batches.every((p) => p.remaining > 0), '不得产出 remaining <= 0 的包').toBe(true)
    // ⚠️ 客户端会静默 skip `remaining <= 0` ⇒ 若放行，合计与总额就悄悄脱钩。
    const split = splitCreditsByExpiry(batches, 15, NOW_MS)
    expect(split!.expiring, '客户端侧合计必须与批次和一致').toBe(1000)
  })

  // ── 2026-10-20 净额口径：debit / expire 必须参与扣减 ───────────────
  //
  // ⚠️⚠️ 用户报障「积分全显示成永久」的根因：原实现只累加 `credit`
  //    ⇒ 批次和恒 = **历史发放额**，用户一有消耗就不守恒
  //    ⇒ `fetchAutoclawBalanceDetailed` 的守恒校验恒不成立
  //    ⇒ 永远回退钱包包 ⇒ **逐批次分档（临期红 + 倒计时）永不出现**。
  //    实测 `debit` 条目同样携带 `wallet_expires_at`，可精确归入批次。
  it('★ debit（消耗）按 wallet_expires_at 精确扣减所属批次', () => {
    const batches = parseAutoclawLedgerBatches(
      [
        { mutation_type: 'credit', amount: 1000, wallet_expires_at: SOON_SEC, description: '签到' },
        { mutation_type: 'debit', amount: -300, wallet_expires_at: SOON_SEC, description: '模型消耗' },
      ],
      NOW_MS,
    )
    expect(batches).toHaveLength(1)
    expect(batches[0]!.remaining, '★ 不扣消耗 ⇒ 批次和永远是历史发放额，分档永不出现').toBe(700)
    expect(batches[0]!.deductionEndTime).toBe(SOON_SEC * 1000)
  })

  it('★ expire（过期）同样按批次扣减', () => {
    const batches = parseAutoclawLedgerBatches(
      [
        { mutation_type: 'credit', amount: 1000, wallet_expires_at: SOON_SEC, description: '签到' },
        { mutation_type: 'expire', amount: -400, wallet_expires_at: SOON_SEC, description: '过期回收' },
      ],
      NOW_MS,
    )
    expect(batches[0]!.remaining).toBe(600)
  })

  it('★ 批次被消耗完（净额 ≤ 0）⇒ 整包丢弃，不产出死包', () => {
    const batches = parseAutoclawLedgerBatches(
      [
        { mutation_type: 'credit', amount: 500, wallet_expires_at: SOON_SEC, description: '签到' },
        { mutation_type: 'debit', amount: -500, wallet_expires_at: SOON_SEC, description: '用光' },
      ],
      NOW_MS,
    )
    // ⚠️ 客户端会静默 skip `remaining <= 0` ⇒ 留着它会让合计与总额脱钩。
    expect(batches, '★ 净额 ≤ 0 的批次不得发出').toHaveLength(0)
  })

  it('★ 负数 debit 是消耗（要扣），负数 credit 是冲正（不扣）—— 两者语义相反', () => {
    // ⚠️ 这条钉住精确的边界：不能一刀切丢掉所有负数。
    const withDebit = parseAutoclawLedgerBatches(
      [
        { mutation_type: 'credit', amount: 1000, wallet_expires_at: SOON_SEC },
        { mutation_type: 'debit', amount: -200, wallet_expires_at: SOON_SEC },
      ],
      NOW_MS,
    )
    const withNegativeCredit = parseAutoclawLedgerBatches(
      [
        { mutation_type: 'credit', amount: 1000, wallet_expires_at: SOON_SEC },
        { mutation_type: 'credit', amount: -200, wallet_expires_at: SOON_SEC },
      ],
      NOW_MS,
    )
    expect(withDebit[0]!.remaining, 'debit 要扣').toBe(800)
    expect(withNegativeCredit[0]!.remaining, '负 credit 是冲正，不扣').toBe(1000)
  })

  // ── P2：metadata.description 为空串 ───────────────────────────────
  it('P2-d metadata.description 为空串时回退到顶层 description（不是通用兜底名）', () => {
    // `??` 不落空串 ⇒ 原实现会把 name 打成「积分发放」，白白丢掉真实描述。
    const batches = parseAutoclawLedgerBatches(
      [
        {
          mutation_type: 'credit',
          amount: 500,
          metadata: { description: '   ' },
          description: '真实描述',
          source: 'campaign',
        },
      ],
      NOW_MS,
    )
    expect(batches[0]!.name).toBe('真实描述')
  })

  // ── P2：翻页上界 + 部分页失败 ─────────────────────────────────────
  it('P2-e 翻页被钳在 AUTOCLAW_LEDGER_MAX_PAGES 上界内', async () => {
    // 上游永远返回 next_cursor ⇒ 无界实现会无限翻页。
    const fetcher = vi.fn(() =>
      jsonResponse({
        code: 0,
        data: {
          entries: [{ mutation_type: 'credit', amount: 1, wallet_expires_at: SOON_SEC, description: 'x' }],
          next_cursor: 'more',
        },
      }),
    )
    await fetchAutoclawLedgerEntries(MOCK_CREDENTIAL, { fetcher: fetcher as unknown as typeof fetch })
    expect(fetcher).toHaveBeenCalledTimes(AUTOCLAW_LEDGER_MAX_PAGES)
  })

  it('P2-f 中途某页失败 ⇒ 返回已拿到的部分（不抛错、不吞掉整份余额）', async () => {
    let calls = 0
    const fetcher = vi.fn(() => {
      calls += 1
      if (calls === 1) {
        return jsonResponse({
          code: 0,
          data: {
            entries: [{ mutation_type: 'credit', amount: 42, wallet_expires_at: SOON_SEC, description: '第一页' }],
            next_cursor: 'p2',
          },
        })
      }
      // 第 2 页 HTTP 500 ⇒ 必须返回已拿到的第 1 页，而不是抛错。
      return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    const entries = await fetchAutoclawLedgerEntries(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.amount).toBe(42)
  })

  it('P2-g 整段翻页共用一份时间预算（不得每页各自 arm 一次）', async () => {
    // 原实现每页各 arm 一次 15s ⇒ 钱包 1 + 流水 5 = 最坏 90s，超过徽标 60s 轮询周期。
    const signals: (AbortSignal | null | undefined)[] = []
    const fetcher = vi.fn((_url: string | URL, init?: RequestInit) => {
      signals.push(init?.signal)
      return jsonResponse({
        code: 0,
        data: { entries: [], next_cursor: 'more' },
      })
    })
    await fetchAutoclawLedgerEntries(MOCK_CREDENTIAL, { fetcher: fetcher as unknown as typeof fetch })
    const real = signals.filter((s): s is AbortSignal => s instanceof AbortSignal)
    expect(real.length).toBeGreaterThan(1)
    expect(new Set(real).size, '整段翻页必须共用同一个 signal').toBe(1)
  })

  // ── P2：total === 0 时不必去拉流水 ─────────────────────────────────
  it('P2-h 总额为 0 时不请求流水端点', async () => {
    const fetcher = vi.fn(() => jsonResponse(walletsOf(0)))
    await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, { fetcher: fetcher as unknown as typeof fetch })
    expect(
      fetcher.mock.calls.some((c) => String(c[0]).includes(AUTOCLAW_LEDGERS_PATH)),
      '零余额时不该发流水请求',
    ).toBe(false)
  })

  // ── ★ 2026-10-20 审计补：净额口径的「取数腿」与「判据腿」 ──────────────
  //
  // ⚠️ 原 43 条用例**全部直接喂 entries**（绕过了取数），于是：
  //    · `flow_direction: 'all'` 改回 `'income'`（= 修前形态）⇒ 43 全绿；
  //    · 容差改回 `batchSum === total`（= 要修的 bug 本身）⇒ 43 全绿。
  //    净额解析器有牙，但「取数」与「守恒判据」这两条腿**零覆盖**
  //    ⇒ 零件有牙、总成无牙。

  it('★ 流水请求必须带 flow_direction=all（否则 debit/expire 根本取不回来）', async () => {
    const urls: string[] = []
    const fetcher = vi.fn((url: string | URL) => {
      const u = String(url)
      urls.push(u)
      if (u.includes(AUTOCLAW_LEDGERS_PATH)) return jsonResponse({ code: 0, data: { entries: [] } })
      return jsonResponse(walletsOf(100))
    })
    await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, { fetcher: fetcher as unknown as typeof fetch })

    const ledgerUrl = urls.find((u) => u.includes(AUTOCLAW_LEDGERS_PATH))
    expect(ledgerUrl, '★ 必须真发过流水请求').toBeDefined()
    const query = new URL(ledgerUrl!).searchParams
    expect(
      query.get('flow_direction'),
      '★ 必须是 all —— 改回 income 就拿不到 debit/expire ⇒ 批次和恒等于历史发放额 ⇒ 分档永不出现',
    ).toBe('all')
  })

  it('★ 守恒容差：差 14 / 20842（0.07%）必须**采用**批次包（原严格相等会回退）', async () => {
    // 这正是 PR 实测的那组数：批次和 20856 vs 钱包 20842，差 14。
    // ⚠️ 现有守恒夹具都是**精确相等**（20200 == 20200）⇒ 容差被整条删掉也全绿。
    const SOON = NOW_SEC + 5 * 86400
    const ledger = {
      code: 0,
      data: {
        entries: [
          { mutation_type: 'credit', amount: 20856, wallet_expires_at: SOON, description: '批次' },
        ],
      },
    }
    const fetcher = vi.fn((url: string | URL) =>
      String(url).includes(AUTOCLAW_LEDGERS_PATH) ? jsonResponse(ledger) : jsonResponse(walletsOf(20842)))
    const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(
      result.balance!.packages.some((p) => p.deductionEndTime !== undefined),
      '★ 差 0.07% 必须落在容差内 ⇒ 采用批次包（否则用户看到的「全是永久」原样复现）',
    ).toBe(true)
  })

  it('★ 守恒容差的反向：偏差过大必须**回退**钱包包（不得放过真错数）', async () => {
    // ⚠️ 反向夹具是必须的：只有「采用」那一条的话，把容差改成 `<= total*10`
    //    也全绿 —— 那等于取消了安全网。
    //
    // ⚠️ 量级要选对：容差是 `max(100, total×1%)`，**100 的下限**在小额账户上
    //    会占很大比例（审计实测：total=200 时容差 100 = 总额 50%）。
    //    ⇒ 反向夹具必须让「差额 > max(100, 1%)」，用 10000 量级：
    //    容差 = 100，差额 500（5%）⇒ 必然超。
    const SOON = NOW_SEC + 5 * 86400
    const ledger = {
      code: 0,
      data: {
        entries: [
          { mutation_type: 'credit', amount: 10500, wallet_expires_at: SOON, description: '批次' },
        ],
      },
    }
    const fetcher = vi.fn((url: string | URL) =>
      String(url).includes(AUTOCLAW_LEDGERS_PATH) ? jsonResponse(ledger) : jsonResponse(walletsOf(10000)))
    const result = await fetchAutoclawBalanceDetailed(MOCK_CREDENTIAL, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(
      result.balance!.packages.every((p) => p.deductionEndTime === undefined),
      '★ 差 500 > 容差 100 ⇒ 必须回退钱包包（宁可没有临期档，也不给错数）',
    ).toBe(true)
    expect(result.balance!.packages[0]!.remaining).toBe(10000)
  })
})

describe('src/provider-credits.ts autoclaw 接线注册', () => {
  it('autoclaw 注册了 fetchBalanceDetailed 和 claim，且 precheckStatus 为 false', async () => {
    const table = createProviderCredits()
    const autoclawCredits = table.autoclaw

    expect(autoclawCredits).toBeDefined()
    expect(autoclawCredits?.fetchBalanceDetailed).toBeTypeOf('function')
    expect(autoclawCredits?.claim).toBeTypeOf('function')
    expect(autoclawCredits?.precheckStatus).toBe(false)
  })
})

/**
 * ★★ **登录后自动领取每日积分**（2026-10-17 新增）
 *
 * ## 为什么需要这组守卫
 *
 * 桌面端源码里有 `claimDailyCreditsOnSignIn(account, dailyCredits)`：
 * 账号状态刚变为 `authenticated` 时触发 `dailyCredits.claim()`。
 * ⇒ 这就是「登录即领」的**真实机制** —— 不是登录的副作用，而是登录后紧跟
 * 一次 `POST /userapi/v1/user-info`。
 *
 * ⚠️ 用户实测过的症状：纯插件登录后新账号**没有积分**（推理回 402
 * 「积分不足,请充值」），而在 IDE 里登录同一账号就有 —— 差别正是这一次调用。
 */
describe('★★ 登录后自动领取每日积分（对齐桌面端 claimDailyCreditsOnSignIn）', () => {
  class FakeCredentials {
    readonly store = new Map<string, string>()
    async resolve(ref: string) {
      const value = this.store.get(ref)
      return value === undefined ? undefined : { value }
    }
    async describe(ref: string) {
      return { configured: this.store.has(ref), writable: true }
    }
    async set(ref: string, value: string) { this.store.set(ref, value) }
    async unset(ref: string) { this.store.delete(ref) }
  }

  /** 造 ctx + 记录调用顺序的 fetcher。 */
  function setup(opts: { claimData?: Record<string, unknown>; claimFails?: boolean } = {}) {
    const ctx = new Context()
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    ctx.provide('commands', { register: () => () => {} } as never)
    const calls: string[] = []
    const fetcher = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes(AUTOCLAW_DAILY_CLAIM_PATH)) {
        calls.push('claim')
        if (opts.claimFails) return Promise.reject(new Error('claim network down'))
        return Promise.resolve(jsonResponse({
          code: 0,
          msg: 'SUCCESS',
          data: opts.claimData ?? { uid: 'u1', daily_check_in_completed_on_request: true },
        }))
      }
      if (u.includes('/userapi/v1/agent-login')) {
        calls.push('login')
        return Promise.resolve(jsonResponse({
          code: 0,
          msg: 'SUCCESS',
          data: {
            user_id: 'u1',
            user_name: 'tester',
            access_token: 'AT_123',
            refresh_token: 'RT_456',
            account_type: 'personal',
          },
        }))
      }
      calls.push('other')
      return Promise.resolve(jsonResponse({ code: 0, data: {} }))
    })
    const service = new AutoclawAuth(ctx, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })
    return { service, credentials, calls, fetcher }
  }

  it('★ 登录成功后**自动**调一次领取接口（这是「登录即领」的机制）', async () => {
    const { service, calls } = setup()
    const res = await service.loginWithCode('13015225433', '123456', 'AUTOCLAW_ACCOUNT_TEST')
    expect(res.ok).toBe(true)
    // ⚠️ 顺序必须是 login → claim（先拿凭据才能领）。
    expect(calls.filter((c) => c === 'login' || c === 'claim')).toEqual(['login', 'claim'])
  })

  it('★ 凭据必须在领取**之前**落盘（领取要用刚写入的凭据）', async () => {
    const { service, credentials } = setup()
    await service.loginWithCode('13015225433', '123456', 'AUTOCLAW_ACCOUNT_TEST')
    // ⚠️ 若顺序反了，领取时读不到凭据 ⇒ 线上恒失败但单测可能仍绿。
    expect(credentials.store.has('AUTOCLAW_ACCOUNT_TEST')).toBe(true)
    const written = JSON.parse(credentials.store.get('AUTOCLAW_ACCOUNT_TEST')!)
    expect(written.access_token).toBe('AT_123')
  })

  it('⚠️⚠️ 领取失败**绝不反噬登录**（凭据已落盘且可用）', async () => {
    // ⚠️ 这是本组最重要的一条：若把领取失败上抛，用户会以为「登录失败」
    //   而反复重新登录 —— 比「没领到积分」更糟。
    const { service, credentials } = setup({ claimFails: true })
    const res = await service.loginWithCode('13015225433', '123456', 'AUTOCLAW_ACCOUNT_TEST')
    expect(res.ok, '领取失败时登录仍须成功').toBe(true)
    expect(credentials.store.has('AUTOCLAW_ACCOUNT_TEST'), '凭据仍须落盘').toBe(true)
  })

  it('⚠️ 领取返回业务错误（code!=0）也不反噬登录', async () => {
    const ctx = new Context()
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    ctx.provide('commands', { register: () => () => {} } as never)
    const fetcher = vi.fn().mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes(AUTOCLAW_DAILY_CLAIM_PATH)) {
        return Promise.resolve(jsonResponse({ code: 400001, msg: '请求数据有问题' }))
      }
      return Promise.resolve(jsonResponse({
        code: 0,
        data: { user_id: 'u1', access_token: 'AT', refresh_token: 'RT' },
      }))
    })
    const service = new AutoclawAuth(ctx, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })
    const res = await service.loginWithCode('13015225433', '123456', 'AUTOCLAW_ACCOUNT_TEST')
    expect(res.ok).toBe(true)
  })

  it('⚠️ 登录失败时**不得**调领取（没有凭据可领）', async () => {
    const ctx = new Context()
    const credentials = new FakeCredentials()
    ctx.provide('credentials', credentials as never)
    ctx.provide('commands', { register: () => () => {} } as never)
    const calls: string[] = []
    const fetcher = vi.fn().mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes(AUTOCLAW_DAILY_CLAIM_PATH)) { calls.push('claim'); return Promise.resolve(jsonResponse({ code: 0, data: {} })) }
      calls.push('login')
      return Promise.resolve(jsonResponse({ code: 10001, msg: '验证码错误' }))
    })
    const service = new AutoclawAuth(ctx, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
    })
    const res = await service.loginWithCode('13015225433', '000000', 'AUTOCLAW_ACCOUNT_TEST')
    expect(res.ok).toBe(false)
    expect(calls, '登录失败时不该调领取').not.toContain('claim')
    expect(credentials.store.size).toBe(0)
  })
})

/**
 * ⚠️⚠️ **刷新轮换出的 `refresh_token` 必须落盘**（2026-10-27 审计 P0，两路独立命中）。
 *
 * ## 缺陷
 *
 * `refreshAutoclawToken` 会解析并返回轮换后的 `refresh_token`，而签到腿原先
 * **只取 `access_token`、把 `refresh_token` 直接丢弃**。若服务端按 OAuth 2.1 RTR
 * 一次性轮换，丢弃就等于**每天烧掉一次续期能力**：旧 token 立即作废 ⇒ 此后每轮
 * 刷新的 401 被静默降级 ⇒ 活动奖励永不再发；而自愈读到盘上的死 token 会抛
 * `RefreshTokenExpiredError` ⇒ 账号被标 `refreshable:false` ⇒ 用户被要求重登，
 * **而重登拿到的 token 又会在下一次签到时被同样烧掉**。
 *
 * ⚠️ 判据不是「谁会轮换」，而是**同仓库两套口径**：`autoclaw-auth.ts` 那条续期腿
 * **会** `credentials.set` 落盘，而这条新腿不落 —— 同一字段两种约定。
 *
 * ⚠️ 轮换本身在本仓库**无任何可复核取证**（`providers-autoclaw.md` 把它登记为
 * 「未测」），所以本组用例同时锁住**两条分支**：真的轮换 → 必须落盘；
 * 没有落盘出口 → **必须出声**（不得静默）。
 */
describe('AutoClaw 签到：刷新轮换必须落盘（2026-10-27 审计 P0）', () => {
  /** 造一个「刷新会轮换 refresh_token」的服务端桩。 */
  function makeRotatingFetcher(rotatedRefresh: string, opts?: { failRefresh?: boolean }) {
    return vi.fn(async (url: string) => {
      if (String(url).includes('/userapi/v1/refresh') || String(url).includes('/agent-refresh')) {
        if (opts?.failRefresh === true) {
          return jsonResponse({ code: 401, msg: 'refresh token invalid' })
        }
        return jsonResponse({
          code: 0,
          msg: 'SUCCESS',
          data: {
            access_token: 'stub-at-rotated',
            refresh_token: rotatedRefresh,
            expires_in: 3600,
            expires_at: Date.now() + 3_600_000,
          },
        })
      }
      return jsonResponse({ code: 0, msg: 'SUCCESS', data: { uid: 'u', daily_check_in_completed_on_request: true } })
    })
  }

  it('★★ 服务端轮换了 refresh_token ⇒ 必须调用 persist 落盘（不得丢弃）', async () => {
    const fetcher = makeRotatingFetcher('stub-rt-ROTATED')
    const persisted: AutoclawCredential[] = []
    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
      persist: async (next) => { persisted.push(next) },
    })

    expect(outcome.kind).toBe('claimed')
    expect(persisted, '轮换出的 refresh_token 被丢弃了 ⇒ 账号续期能力会被逐日烧掉').toHaveLength(1)
    expect(persisted[0]!.refresh_token).toBe('stub-rt-ROTATED')
    // 用新 token 领（登录事件的凭据）
    const calls = fetcher.mock.calls as [string, RequestInit][]
    const claimCall = calls.find((c) => String(c[0]).includes(AUTOCLAW_DAILY_CLAIM_PATH))
    expect((claimCall![1].headers as Record<string, string>).Authorization).toContain('stub-at-rotated')
  })

  it('★ 服务端返回**同一个** refresh_token ⇒ 不必落盘（不做多余写入）', async () => {
    const fetcher = makeRotatingFetcher(MOCK_CREDENTIAL.refresh_token)
    let persistCalls = 0
    await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
      persist: async () => { persistCalls += 1 },
    })
    expect(persistCalls, '没轮换却写了盘 ⇒ 多余 I/O 且会覆盖并发写者').toBe(0)
  })

  it('★★ 轮换但**没有落盘出口** ⇒ 必须 warn 出声（绝不静默）', async () => {
    const fetcher = makeRotatingFetcher('stub-rt-ROTATED')
    const warns: string[] = []
    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
      warn: (m) => { warns.push(m) },
    })
    expect(outcome.kind).toBe('claimed')
    expect(
      warns.some((w) => w.includes('轮换') || w.includes('落盘')),
      '轮换被静默丢弃 ⇒ 用户/维护者都无从发现账号正在失去续期能力',
    ).toBe(true)
  })

  it('★ 轮换落盘失败 ⇒ 不得打断签到，但必须 warn', async () => {
    const fetcher = makeRotatingFetcher('stub-rt-ROTATED')
    const warns: string[] = []
    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
      persist: async () => { throw new Error('store boom') },
      warn: (m) => { warns.push(m) },
    })
    expect(outcome.kind, '落盘失败不得把签到变成失败').toBe('claimed')
    expect(warns.some((w) => w.includes('落盘失败'))).toBe(true)
  })

  it('★★ 非字符串 refresh_token（备份导入的脏值）⇒ 不得抛异常、不得发刷新请求', async () => {
    // ⚠️ 这是本 PR 引入的**回归**：修复前这条路径根本不读 refresh_token，
    //    那种凭据本来能正常签到。原 `cleanToken` 只挡 falsy ⇒
    //    `42.replace` 抛 `TypeError`，且调用写在 claim 的 try **之外**
    //    ⇒ 异常逃到 RPC 层，用户看到一句毫无出路的内部错误。
    for (const dirty of [42, {}, [], true, { token: 'x' }]) {
      const fetcher = makeRotatingFetcher('stub-rt-ROTATED')
      const outcome = await claimAutoclawDailyQuota(
        { ...MOCK_CREDENTIAL, refresh_token: dirty as unknown as string },
        { product: AUTOCLAW, fetcher: fetcher as unknown as typeof fetch },
      )
      expect(outcome.kind, `refresh_token=${JSON.stringify(dirty)} 时签到被连坐`).toBe('claimed')
      const urls = fetcher.mock.calls.map((c) => String(c[0]))
      expect(urls.filter((u) => u.includes('/refresh')).length, '脏 refresh_token 不该发出刷新请求').toBe(0)
      expect(urls.filter((u) => u.includes(AUTOCLAW_DAILY_CLAIM_PATH)).length).toBe(1)
    }
  })

  it('★★ 刷新失败必须 warn（原先裸 catch 吞掉 ⇒ outcome 与成功逐字相同）', async () => {
    const fetcher = makeRotatingFetcher('x', { failRefresh: true })
    const warns: string[] = []
    const outcome = await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
      warn: (m) => { warns.push(m) },
    })
    expect(outcome.kind).toBe('claimed')
    expect(
      warns.some((w) => w.includes('登录事件刷新失败')),
      '刷新失败零日志 ⇒ 用户永远不知道活动奖励其实没发（而那正是本次改动的唯一理由）',
    ).toBe(true)
  })

  it('★★ 刷新腿必须用**短超时**（原为 2×60s ⇒ 最坏 135s）', async () => {
    // 判据打在「实际请求的超时预算」上，而不是事后计时（后者要么慢要么脆）。
    const spy = vi.spyOn(AbortSignal, 'timeout')
    try {
      const fetcher = makeRotatingFetcher('stub-rt-ROTATED')
      await claimAutoclawDailyQuota(MOCK_CREDENTIAL, {
        product: AUTOCLAW,
        fetcher: fetcher as unknown as typeof fetch,
      })
      const budgets = spy.mock.calls.map((c) => Number(c[0]))
      expect(budgets, '刷新腿的超时预算').toContain(AUTOCLAW_CLAIM_REFRESH_TIMEOUT_MS)
      // 且必须显著小于默认的 60s（否则两个端点各 60s ⇒ 光刷新就 120s）
      expect(AUTOCLAW_CLAIM_REFRESH_TIMEOUT_MS).toBeLessThan(15_000)
    } finally {
      spy.mockRestore()
    }
  }, 20_000)
})

/**
 * ★★ **国际版的刷新腿必须打国际站**（2026-10-27 审计 P2-3）。
 *
 * ## 缺口
 *
 * 变异「刷新调用丢掉 `product`」⇒ PR 自己的 spec **49/49 全绿**
 * （审计实测），即**刷新腿的基址零守卫**。而 `autoclaw` 与 `autoclawintl`
 * 是「同一实现两个实例」，漏传 `product` 会走默认的**国内**基址 ——
 * 用户的国际账号刷新打到国内站，症状与「余额恒查不到（410000 用户未登录）」
 * 同形，**静默**。
 *
 * ⚠️ 这与 `provider-credits.ts` 里 `fetchBalanceDetailed` 那条腿的既有教训**同源**
 * （该文件逐字写着「必须显式传 `product: AUTOCLAW_INTL` —— 不传会走默认的国内
 * 基址……这是『同一实现两个实例』最容易踩的一处」）。余额腿有守卫，刷新腿此前没有。
 */
describe('AutoClaw 国际版：刷新腿必须打国际站（国际/国内基址不得混）', () => {
  it('★★ autoclawintl 的 refresh 与 claim 都必须打到国际站基址', async () => {
    const { AUTOCLAW_INTL } = await import('../../src/autoclaw-product.js')
    const urls: string[] = []
    /**
     * ⚠️ 必须**桩全局 fetch**：能力表里的 `claim` 只收 `(credential, entry, call)`，
     * **不接受注入 fetcher** ⇒ 走能力表时它回落到全局 `fetch`。
     * 这样才能覆盖 `provider-credits.ts` 那条「有没有把 product 传下去」的透传腿
     * —— 审计的变异正是打在那一行（丢掉 `product` ⇒ PR spec 49/49 全绿）。
     */
    const fetcher = vi.fn(async (url: string) => {
      urls.push(String(url))
      if (String(url).includes('/refresh')) {
        return jsonResponse({
          code: 0,
          msg: 'SUCCESS',
          data: {
            access_token: 'stub-at',
            refresh_token: 'stub-rt',
            expires_in: 3600,
            expires_at: Date.now() + 3_600_000,
          },
        })
      }
      return jsonResponse({ code: 0, msg: 'SUCCESS', data: { uid: 'u', daily_check_in_completed_on_request: true } })
    })
    vi.stubGlobal('fetch', fetcher)
    try {
      const credits = createProviderCredits()
      const impl = credits.autoclawintl as unknown as {
        claim?: (credential: unknown, entry: unknown, call: unknown) => Promise<{ kind: string }>
      }
      expect(typeof impl?.claim, 'autoclawintl 没有 claim 能力').toBe('function')

      const outcome = await impl.claim!(
        { ...MOCK_CREDENTIAL, device_id: 'dev-intl' },
        { id: 'a1', credentialRef: 'ref1' },
        { warn: () => {}, resolveCredential: async () => undefined, accountPool: {} },
      )
      expect(outcome.kind).toBe('claimed')

      expect(AUTOCLAW_INTL.apiBase, '前提失效：两站基址相同 ⇒ 本用例恒真').not.toBe(AUTOCLAW.apiBase)
      const refreshUrl = urls.find((u) => u.includes('/refresh'))
      expect(refreshUrl, '刷新腿根本没发请求').toBeDefined()
      expect(
        refreshUrl!.startsWith(AUTOCLAW_INTL.apiBase),
        `刷新腿打到了 ${refreshUrl} —— 漏传 product 会走国内默认基址，`
        + '国际账号的「登录事件」就挂到了国内站（静默，症状与「余额查不到 410000」同形）',
      ).toBe(true)
      const claimUrl = urls.find((u) => u.includes(AUTOCLAW_DAILY_CLAIM_PATH))
      expect(claimUrl, '签到腿根本没发请求').toBeDefined()
      expect(claimUrl!.startsWith(AUTOCLAW_INTL.apiBase)).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  }, 20_000)
})

/**
 * ★★★ **刷新腿必须单飞**（2026-10-27 自查实测，由落盘腿**自己**引入的竞态）。
 *
 * ## 缺陷
 *
 * 落盘腿让「刷新 → 写回新 `refresh_token`」成为一次**写操作**。而并发时两次刷新
 * 各自拿到一个新 token，写回的先后顺序**由网络抖动决定**，不由签发顺序决定 ⇒
 * **晚到的旧响应会把已作废的旧 token 覆盖回盘上**。
 *
 * 实测（宽限期服务端 + 只给第一次响应加 50ms 延迟）：
 * ```
 * 落盘序列 = ["RT-2","RT-1"] | 服务端最新有效 = RT-2
 * 最后落盘 = RT-1 | 它还有效吗 = false   ← 盘上留下作废 token
 * ```
 *
 * ⇒ 与 P0 同源同量级（下一次续期读到死 token ⇒ `RefreshTokenExpiredError` ⇒
 * 账号被标 `refreshable:false`）。本仓库**早就为同一形态**给自愈腿建了
 * `balanceHealInFlight` 去重表，并逐字写下「并发会让后写的把先写的新 token
 * 覆盖成已失效的旧 token」—— 这条新腿此前不在任何闸门之内。
 */
describe('AutoClaw 签到：刷新腿必须单飞（并发不得把旧 token 写回）', () => {
  it('★★ 两个并发 claim ⇒ **恰好一次** refresh、一次落盘，且落盘值仍然有效', async () => {
    let issued = 0
    let latest = 'stub-rt-0'
    const valid = new Set<string>([latest])
    const refreshCalls: string[] = []
    const writes: string[] = []

    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/userapi/v1/refresh')) {
        const offered = String(JSON.parse(String(init?.body ?? '{}')).refresh_token)
        refreshCalls.push(offered)
        if (!valid.has(offered)) return jsonResponse({ code: 401, msg: 'invalid' })
        issued += 1
        const mine = issued
        latest = `stub-rt-${mine}`
        valid.add(latest) // 宽限期：旧的不立刻作废，但只有最新的是"真正的"当前值
        // ⚠️ 第一次签发的响应故意慢：制造「先签发的后到」这一真实交错。
        if (mine === 1) await new Promise((r) => setTimeout(r, 50))
        return jsonResponse({
          code: 0, msg: 'SUCCESS',
          data: {
            access_token: `stub-at-${mine}`, refresh_token: latest,
            expires_in: 3600, expires_at: Date.now() + 3_600_000,
          },
        })
      }
      return jsonResponse({ code: 0, msg: 'SUCCESS', data: { uid: 'u', daily_check_in_completed_on_request: true } })
    })

    const cred = { ...MOCK_CREDENTIAL, refresh_token: 'stub-rt-0' }
    const run = () => claimAutoclawDailyQuota(cred, {
      product: AUTOCLAW,
      fetcher: fetcher as unknown as typeof fetch,
      persist: async (next) => { writes.push(next.refresh_token as string) },
      warn: () => {},
    })
    const [a, b] = await Promise.all([run(), run()])

    expect(a.kind).toBe('claimed')
    expect(b.kind).toBe('claimed')
    expect(refreshCalls, '并发发了多次 refresh ⇒ 会出现「后写的覆盖先写的」').toHaveLength(1)
    expect(writes, '并发写了多次 ⇒ 落盘顺序由网络抖动决定，可能存回已作废的旧值').toHaveLength(1)
    expect(
      writes.at(-1),
      `落盘的是 ${String(writes.at(-1))}，而服务端唯一有效的是 ${latest}`
      + ' ⇒ 下次续期会拿到 RefreshTokenExpiredError（账号级失效）',
    ).toBe(latest)
  })
})
