import { describe, expect, it, vi } from 'vitest'
import {
  CODEARTS_OPS_CHANNEL,
  CODEARTS_PACKAGE_INFO_PATH,
  CODEARTS_SNAP_ENGINE_URL,
  claimCodeArtsDailyCheckin,
  fetchCodeArtsAccountInfo,
  fetchCodeArtsAccountInfoDetailed,
  fetchCodeArtsOpsActivities,
  findDailyCheckinActivity,
} from '../../src/codearts-credits.js'
import type { CodeArtsCredential } from '../../src/types.js'

/**
 * `src/codearts-credits.ts` 的单元测试。
 *
 * 全部用桩 fetcher，**不发任何真实网络请求**（与 tests/unit 的既有约定一致）。
 * 重点覆盖三类容易出错的地方：
 *
 * 1. **两种响应信封**：`ops/*` 是 `{code,message,data}`，而 `statistics/plugin`
 *    是**裸对象**。只支持其中一种会让另一端点恒判失败。
 * 2. **账户类型不是门禁**：`is_credit_package=false` 的体验版账号实测照样能签到
 *    （活动列表说了算）；账户类型只用来修饰「没有可领取活动」时的文案。
 * 3. **幂等**：`claimable` / `status` 预检 + 服务端重复领取业务码 `40001`
 *    都要判成「今天已领取」，不能报 failed。
 */

const CREDENTIAL: CodeArtsCredential = {
  access_key_id: 'AKTEST',
  secret_access_key: 'SKTEST',
  security_token: 'STTEST',
  expires_at: '2099-01-01T00:00:00.000Z',
}

/** 构造一个返回固定 JSON 的桩 fetcher，并记录请求。 */
function jsonFetcher(
  handler: (url: string, init: RequestInit | undefined) => { status?: number; body: unknown },
): { fetcher: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const { status = 200, body } = handler(url, init)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

/** 一个 `statistics/plugin` 的裸对象响应（积分账户）。 */
function packageInfoBody(options: {
  isCredit?: boolean
  isToken?: boolean
  metrics?: unknown[]
  /** 套餐周期结束日（顶层 `end_date`，纯日期）。省略则不带该字段。 */
  endDate?: string
} = {}): Record<string, unknown> {
  return {
    package: {
      package_name_cn: '码道个人专业版',
      package_name_en: 'CodeArts Agent Pro',
      spec_code: 'codearts.agent.professional',
      status: 'normal',
      is_credit_package: options.isCredit ?? true,
      is_token_package: options.isToken ?? false,
    },
    ...options.endDate === undefined ? {} : { end_date: options.endDate },
    metrics: options.metrics ?? [
      { name: 'usageTotalPackageCredit', package_credit_amount: 5000, package_credit_used: 1200, package_credit_remain: 3800 },
      { name: 'usageBasicPackageCredit', package_credit_amount: 3000, package_credit_used: 1200, package_credit_remain: 1800 },
      { name: 'usageBonusPackageCredit', package_credit_amount: 2000, package_credit_used: 0, package_credit_remain: 2000 },
      { name: 'usageTokenChatMessages', usage_token_num: 10, package_token_amount: 100 },
    ],
  }
}

/** 一个 `ops/delivery` 的带信封响应。 */
function deliveryBody(items: unknown[]): Record<string, unknown> {
  return { code: 0, message: 'success', data: { items } }
}

describe('fetchCodeArtsAccountInfo（账户类型检测）', () => {
  it('识别积分计费账户（is_credit_package = true）', async () => {
    const { fetcher } = jsonFetcher(() => ({ body: packageInfoBody() }))
    const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    expect(info).not.toBeNull()
    expect(info?.isCreditPackage).toBe(true)
    expect(info?.isTokenPackage).toBe(false)
    expect(info?.packageName).toBe('码道个人专业版')
  })

  it('识别 Token 计费账户（活动范围外）', async () => {
    const { fetcher } = jsonFetcher(() => ({
      body: packageInfoBody({ isCredit: false, isToken: true }),
    }))
    const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    expect(info?.isCreditPackage).toBe(false)
    expect(info?.isTokenPackage).toBe(true)
  })

  it('解析裸对象信封（statistics/plugin 没有 data 包装）', async () => {
    // 这条守住「两种信封都要支持」：若误按 ops/* 的 {code,data} 解析，
    // package 会取不到，isCreditPackage 恒为 false —— 表现为「所有账号都
    // 不是积分账户」，静默且极难发现。
    const { fetcher } = jsonFetcher(() => ({ body: packageInfoBody() }))
    const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    expect(info?.specCode).toBe('codearts.agent.professional')
    expect(info?.credit?.total).toBe(3800)
  })

  it('余额取总额 metric，不累加分类明细', async () => {
    // 分类（基础 1800 + 赠送 2000 = 3800）恰好等于总额，但那是巧合；
    // 若实现累加分类，一旦服务端下发「已用/冻结」类分类就会翻倍。
    const { fetcher } = jsonFetcher(() => ({
      body: packageInfoBody({
        metrics: [
          { name: 'usageTotalPackageCredit', package_credit_amount: 5000, package_credit_used: 1200, package_credit_remain: 3800 },
          { name: 'usageBasicPackageCredit', package_credit_amount: 3000, package_credit_used: 1200, package_credit_remain: 1800 },
          { name: 'usageBonusPackageCredit', package_credit_amount: 2000, package_credit_used: 0, package_credit_remain: 2000 },
        ],
      }),
    }))
    const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    expect(info?.credit?.total).toBe(3800)
  })

  it('无任何 credit metric 时 credit 为 undefined（≠ 余额为 0）', async () => {
    const { fetcher } = jsonFetcher(() => ({
      body: packageInfoBody({ metrics: [{ name: 'usageTokenChatMessages', usage_token_num: 1 }] }),
    }))
    const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    expect(info?.credit).toBeUndefined()
  })

  /**
   * ## 「即将到期」额度（`package_credit_expiring_amount`）
   *
   * 用户 2026-10-20 报障（附华为云「套餐及积分包」网页截图）：
   * 「CodeArts 积分也有到期时间，也应当有三档分档与永久锁功能」。
   *
   * **实测结论：做不出三档分档**。`statistics/plugin` 只下发一个**聚合标量**
   * `package_credit_expiring_amount`，不说哪几笔、不说哪天到期：
   *
   * ```
   * {"name":"usageTotalPackageCredit","package_credit_amount":25500,
   *  "package_credit_remain":25500,"package_credit_expiring_amount":2000}
   * {"name":"usageBonusPackageCredit","package_credit_amount":25000,
   *  "package_credit_remain":25000,"package_credit_expiring_amount":2000}
   * ```
   *
   * 逐包/逐笔端点在上游**不存在**：探了 85+ 个候选路径全 404，且解包
   * `D:\CodeArts\resources\app.asar` 后全量枚举只有 27 条 `/v1/*` 路径，
   * 其中唯一的积分端点是 `/v1/ops/credit/usage?type=msg|session`，
   * 返回 `{credits, cacheHitRatio}` —— 是**单次对话消耗**，不是余额明细。
   *
   * ⇒ 只如实透出这个标量（`expiringTotal`），**不**伪造 `deductionEndTime`
   * 去凑三档。下面三条用例把这三个边界钉死。
   */
  describe('即将到期额度（expiringTotal）', () => {
    it('取总额 metric 上的标量，不累加分类（否则凭空翻倍）', async () => {
      // 实测真实响应：总额与赠送**同时**带 2000。累加会得到 4000。
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 25500, package_credit_used: 0, package_credit_remain: 25500, package_credit_expiring_amount: 2000 },
            { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
            { name: 'usageBonusPackageCredit', package_credit_amount: 25000, package_credit_used: 0, package_credit_remain: 25000, package_credit_expiring_amount: 2000 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      expect(info?.credit?.expiringTotal, '只能取一次总额 metric 上的值').toBe(2000)
      expect(info?.credit?.total).toBe(25500)
    })

    it('缺失该字段时 expiringTotal 为 undefined（≠ 0）', async () => {
      // 基础包/按需包都没有这个键；没有它 = 上游没给这个口径，
      // 而不是「有 0 分即将到期」。混用会让界面多出一句「0 即将到期」。
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      expect(info?.credit?.expiringTotal).toBeUndefined()
      expect(info?.credit?.total).toBe(500)
    })

    it('值为 0 时也不写该字段（无临期额度与无此口径等价呈现）', async () => {
      // 实测第二个账号：expiring=0 且总额/赠送都在。
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 6500, package_credit_used: 0, package_credit_remain: 6500, package_credit_expiring_amount: 0 },
            { name: 'usageBonusPackageCredit', package_credit_amount: 6000, package_credit_used: 0, package_credit_remain: 6000, package_credit_expiring_amount: 0 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      expect(info?.credit?.expiringTotal).toBeUndefined()
    })

    it('★ 绝不伪造 deductionEndTime 去凑三档分档', async () => {
      // 这是本改动的**核心约束**：三档分档（永久/长期/临期）与「锁定永久积分」
      // 都读 `packages[].deductionEndTime`。上游不给逐包到期时刻 ⇒ 该字段必须
      // 保持 undefined（= 到期时间未知 ⇒ 落永久桶），而不是拿套餐 end_date
      // 或「即将到期」标量去编一个日期。编了会让永久锁按假日期做决策。
      //
      // ⚠️ 2026-10-20 更新：**基础积分包**现在**合法地**带 `deductionEndTime`
      //    （取自套餐周期 `end_date`，那是真实存在的到期时刻）。故断言改为
      //    「只有基础包有，赠送/按需包没有」。
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          endDate: '2026-10-27',
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 25500, package_credit_used: 0, package_credit_remain: 25500, package_credit_expiring_amount: 2000 },
            { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
            { name: 'usageBonusPackageCredit', package_credit_amount: 25000, package_credit_used: 0, package_credit_remain: 25000, package_credit_expiring_amount: 2000 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      const packages = info?.credit?.packages ?? []
      expect(packages.length).toBeGreaterThan(0)
      for (const pkg of packages) {
        if (pkg.name === '基础积分包') {
          expect(pkg.deductionEndTime, '基础包随套餐周期到期，应有确切时刻').toBe(Date.parse('2026-10-27'))
          expect(pkg.expiredTime, '基础包的 expiredTime 应与 deductionEndTime 同源').toBe('2026-10-27T00:00:00.000Z')
        } else {
          expect(pkg.deductionEndTime, `${pkg.name} 不得有编造的到期时间`).toBeUndefined()
          expect(pkg.expiredTime, `${pkg.name} 的 expiredTime 应为空串`).toBe('')
        }
      }
    })
  })

  /**
   * ## ★ 赠送包的「即将到期」拆到包上（`expiringRemaining`）
   *
   * 用户 2026-10-20 报障（逐字）：`2000+500临期不应该是2500嘛`。
   *
   * 报障前的实现：把 2000 只放在 `CreditBalance.expiringTotal`，分档仍把
   * 赠送包整包 25000 算进永久桶 ⇒ 卡片显示「永久 25000 · 临期 500」
   * 旁边再补一句「另有 2000 即将到期」，三个数字互相矛盾。
   *
   * 正确做法：拆到包上 —— 临期桶 += `expiringRemaining`，
   * 永久桶 += `remaining - expiringRemaining` ⇒ 临期 = 500 + 2000 = 2500。
   *
   * ⚠️ 实测依据：`总额 expiring - 赠送 expiring = 0` ⇒ 总额那个标量
   * 就是各分类之和，逐包读取不会重复计数。
   */
  describe('赠送包即将到期额度（expiringRemaining）', () => {
    it('★ 赠送包带上自己那部分 expiring（基础包不带 —— 它已有真实时刻）', async () => {
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          endDate: '2026-10-27',
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 25500, package_credit_used: 0, package_credit_remain: 25500, package_credit_expiring_amount: 2000 },
            { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
            { name: 'usageBonusPackageCredit', package_credit_amount: 25000, package_credit_used: 0, package_credit_remain: 25000, package_credit_expiring_amount: 2000 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      const byName = new Map((info?.credit?.packages ?? []).map((p) => [p.name, p]))
      expect(byName.get('赠送积分包')?.expiringRemaining).toBe(2000)
      expect(byName.get('基础积分包')?.expiringRemaining, '基础包有真实到期时刻，不该再读标量').toBeUndefined()
      expect(info?.credit?.expiringTotal, '总额口径保留用于交叉校验').toBe(2000)
    })

    it('★ 各包 expiringRemaining 之和 == expiringTotal（不重复计数）', async () => {
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          endDate: '2026-10-27',
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 25500, package_credit_used: 0, package_credit_remain: 25500, package_credit_expiring_amount: 2000 },
            { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
            { name: 'usageBonusPackageCredit', package_credit_amount: 25000, package_credit_used: 0, package_credit_remain: 25000, package_credit_expiring_amount: 2000 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      const sum = (info?.credit?.packages ?? [])
        .reduce((acc, p) => acc + (p.expiringRemaining ?? 0), 0)
      expect(sum).toBe(info?.credit?.expiringTotal)
    })

    it('expiring 超过 remain 时夹到 remain（不让三档合计超过 total）', async () => {
      // 上游若给超（不该发生），宁可少算临期也不让「永久 + 临期」超包。
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 100, package_credit_used: 0, package_credit_remain: 100, package_credit_expiring_amount: 999 },
            { name: 'usageBonusPackageCredit', package_credit_amount: 100, package_credit_used: 0, package_credit_remain: 100, package_credit_expiring_amount: 999 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      const bonus = info?.credit?.packages.find((p) => p.name === '赠送积分包')
      expect(bonus?.expiringRemaining).toBe(100)
    })

    it('expiring 为 0 时不写该字段（≠ 写 0）', async () => {
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 6500, package_credit_used: 0, package_credit_remain: 6500, package_credit_expiring_amount: 0 },
            { name: 'usageBonusPackageCredit', package_credit_amount: 6000, package_credit_used: 0, package_credit_remain: 6000, package_credit_expiring_amount: 0 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      expect(info?.credit?.packages.find((p) => p.name === '赠送积分包')?.expiringRemaining).toBeUndefined()
      expect(info?.credit?.expiringTotal).toBeUndefined()
    })
  })

  /**
   * ## 套餐周期（`end_date`）→ 基础积分包的 `deductionEndTime`
   *
   * 用户 2026-10-20 追加要求：`套餐积分也应当设置临期`。
   *
   * 依据：华为官方计费文档 + 截图实测 —— 个人订阅套餐 2026/09/26 → 2026/10/26
   * 23:59，**基础积分包 500 分同期作废**（截图里那一行「个人订阅套餐 500 分」
   * 的到期时间正是套餐结束日）。故基础包有确切到期时刻，可参与三档分档。
   *
   * ⚠️ **但绝不能套到赠送/按需包上**：签到积分逐笔「发放日 +30 天」
   * （每条各不相同），按需包按消费实时结算。套套餐周期就是编造。
   */
  describe('套餐周期 → 基础积分包到期时间', () => {
    it('★ 基础包带上套餐 end_date 的毫秒值', async () => {
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          endDate: '2026-10-27',
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 25500, package_credit_used: 0, package_credit_remain: 25500 },
            { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
            { name: 'usageBonusPackageCredit', package_credit_amount: 25000, package_credit_used: 0, package_credit_remain: 25000 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      const basic = info?.credit?.packages.find((p) => p.name === '基础积分包')
      expect(basic?.deductionEndTime).toBe(Date.parse('2026-10-27'))
    })

    it('★ 赠送包 / 按需包**不**套套餐周期（各自到期规则不同）', async () => {
      // 签到积分是逐笔「发放日 +30 天」，按需包实时结算 —— 都不随套餐周期作废。
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          endDate: '2026-10-27',
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 25500, package_credit_used: 0, package_credit_remain: 25500 },
            { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
            { name: 'usageOnDemandPackageCredit', package_credit_amount: 100, package_credit_used: 0, package_credit_remain: 100 },
            { name: 'usageBonusPackageCredit', package_credit_amount: 25000, package_credit_used: 0, package_credit_remain: 25000 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      const byName = new Map((info?.credit?.packages ?? []).map((p) => [p.name, p]))
      expect(byName.get('赠送积分包')?.deductionEndTime).toBeUndefined()
      expect(byName.get('按需积分包')?.deductionEndTime).toBeUndefined()
      expect(byName.get('基础积分包')?.deductionEndTime).toBe(Date.parse('2026-10-27'))
    })

    it('缺 end_date 时基础包也不带到期时间（不猜）', async () => {
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
            { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      const basic = info?.credit?.packages.find((p) => p.name === '基础积分包')
      expect(basic?.deductionEndTime).toBeUndefined()
      expect(basic?.expiredTime).toBe('')
    })

    it('end_date 无法解析时也不带到期时间（不拿 now 兜底）', async () => {
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          endDate: 'not-a-date',
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
            { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      expect(info?.credit?.packages.find((p) => p.name === '基础积分包')?.deductionEndTime).toBeUndefined()
    })
  })

  /**
   * ## ★ 汇总包不进 `packages`（否则三档分档凭空翻倍）
   *
   * 真实响应里 `usageTotalPackageCredit` 是「基础 + 按需 + 赠送」的**汇总行**，
   * 与三个分类是同一批积分的两种视图。把两者一起 push 会让 `packages` 求和
   * **翻倍**（实测 2026-10-20：总包 25500 + 基础 500 + 赠送 25000 = 51000，
   * 而 `total` 是 25500）。
   *
   * 那不只是数字难看：三档分档是按 `packages` 逐包累加的，重复计数会让
   * 「永久桶」凭空多出一倍 ⇒ 锁定时误判「还有大量永久额度」而继续烧临期额度。
   */
  describe('汇总包去重', () => {
    it('★ packages 求和等于 total（不含汇总行）', async () => {
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          endDate: '2026-10-27',
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 25500, package_credit_used: 0, package_credit_remain: 25500 },
            { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
            { name: 'usageBonusPackageCredit', package_credit_amount: 25000, package_credit_used: 0, package_credit_remain: 25000 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      const credit = info?.credit
      expect(credit?.total).toBe(25500)
      const sum = (credit?.packages ?? []).reduce((acc, p) => acc + p.remaining, 0)
      expect(sum, '分类求和必须等于总额，重复计数会让三档分档翻倍').toBe(25500)
    })

    it('汇总行不出现在 packages 里（按名字断言）', async () => {
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 25500, package_credit_used: 0, package_credit_remain: 25500 },
            { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 0, package_credit_remain: 500 },
            { name: 'usageBonusPackageCredit', package_credit_amount: 25000, package_credit_used: 0, package_credit_remain: 25000 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      const names = (info?.credit?.packages ?? []).map((p) => p.name)
      expect(names).not.toContain('总积分包')
      expect(names).toContain('基础积分包')
      expect(names).toContain('赠送积分包')
    })

    it('只有汇总行时 total 仍正确、packages 为空', async () => {
      // 边界：上游只给了汇总、没给任何分类（或分类额度全为 0 被过滤）。
      const { fetcher } = jsonFetcher(() => ({
        body: packageInfoBody({
          metrics: [
            { name: 'usageTotalPackageCredit', package_credit_amount: 800, package_credit_used: 0, package_credit_remain: 800 },
          ],
        }),
      }))
      const info = await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
      expect(info?.credit?.total).toBe(800)
      expect(info?.credit?.packages).toEqual([])
    })
  })

  it('查询失败返回 null（与「非积分账户」严格区分）', async () => {
    const { fetcher } = jsonFetcher(() => ({ status: 500, body: { message: 'boom' } }))
    expect(await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)).toBeNull()
  })

  it('凭据缺少 AK/SK 时不发请求', async () => {
    const { fetcher, calls } = jsonFetcher(() => ({ body: packageInfoBody() }))
    const broken = { ...CREDENTIAL, access_key_id: '' }
    expect(await fetchCodeArtsAccountInfo(broken, fetcher)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('请求带签名头与 Agent-Type（服务端路由所需）', async () => {
    const { fetcher, calls } = jsonFetcher(() => ({ body: packageInfoBody() }))
    await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('authorization')).toContain('SDK-HMAC-SHA256')
    expect(headers.get('x-security-token')).toBe('STTEST')
    expect(headers.get('agent-type')).toBe('PromptCenter')
    expect(calls[0]?.url).toBe(`${CODEARTS_SNAP_ENGINE_URL}${CODEARTS_PACKAGE_INFO_PATH}`)
  })

  /**
   * ⚠️ 真实缺陷（用户报障）：界面显示「积分：账户信息查询失败」。
   *
   * 根因是 `Agent-Type` / `X-Language` 被当作 `signRequestHuawei` 的
   * `extraHeaders` 传入了 —— 于是它们进入 canonical request 与 SignedHeaders，
   * 服务端回
   * `401 {"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}`。
   * 把这两个头改为**签名后追加**即恢复正常（实测同一端点 200 并返回真实积分）。
   *
   * 正确做法与 `src/models.ts` 的 `fetchSignedGet` 一致，其参数注释明确写着
   * 「签名后追加的头（不参与 SDK-HMAC-SHA256 签名计算）」。
   *
   * 本用例直接解析 Authorization 头里的 `SignedHeaders=`，锁死这一点：
   * 只断言「头存在」是不够的（那正是原测试的漏洞 —— 头存在但位置错了）。
   */
  it('Agent-Type / X-Language 不得出现在 SignedHeaders 中（签名后追加）', async () => {
    const { fetcher, calls } = jsonFetcher(() => ({ body: packageInfoBody() }))
    await fetchCodeArtsAccountInfo(CREDENTIAL, fetcher)
    const auth = new Headers(calls[0]?.init?.headers).get('authorization') ?? ''
    const match = /SignedHeaders=([^,]+)/.exec(auth)
    expect(match, 'Authorization 缺少 SignedHeaders').not.toBeNull()
    const signed = match![1]!.toLowerCase()
    expect(
      signed,
      'Agent-Type 出现在 SignedHeaders 里：它必须在签名之后追加，'
      + '否则服务端验签失败（APIG.0301），积分查询恒报「账户信息查询失败」。',
    ).not.toContain('agent-type')
    expect(signed, 'X-Language 不得参与签名').not.toContain('x-language')
    // 但这两个头**必须**仍然随请求发出（服务端路由依赖它们）。
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('agent-type')).toBe('PromptCenter')
    expect(headers.get('x-language')).toBe('zh-cn')
  })

  it('非 2xx 响应带出服务端错误码与原因（不能只报 HTTP 状态）', async () => {
    // 真实 401 响应体形如：
    // {"error_code":"APIG.0301","error_msg":"...verify ak sk signature fail"}
    // 只回「HTTP 401」会让「签名头位置错」「AK 限流」「凭据过期」这些
    // 处置方式完全不同的问题看起来一模一样。
    const { fetcher } = jsonFetcher(() => ({
      status: 401,
      body: { error_code: 'APIG.0301', error_msg: 'verify ak sk signature fail' },
    }))
    const result = await fetchCodeArtsAccountInfoDetailed(CREDENTIAL, fetcher)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('401')
      expect(result.message).toContain('APIG.0301')
      expect(result.message).toContain('verify ak sk signature fail')
    }
  })
})

describe('fetchCodeArtsOpsActivities（活动列表）', () => {
  /**
   * ⚠️ 真实缺陷（用户报障）：点「一键领取积分」后显示「1 个活动未开启，
   * 1 个失败」——积分实际**没有**领到。
   *
   * 两个解析错误叠加，都源于**用了臆想的字段类型/名字**而非真实响应：
   *
   * 1. `campaignId` 服务端下发的是**数字**（实测 `1`），而实现用只接受
   *    字符串的 `readString` 解析 → 恒为空串 → 领取被判
   *    `failed`「活动缺少 campaignId，无法领取」。
   * 2. 可领积分的字段名是 **`benefitAmount`**（实测 `1000`），实现读的是
   *    `amount`（服务端不返回）→ 恒为 0。
   *
   * 早期用例之所以没抓到，正是因为它喂的是**编造的** `campaignId: 'c-1'`
   * 与 `amount: 1000`。下面这条用真实响应形状（见 2026-09-18 实测抓包），
   * 并附完整字段以便日后核对。
   */
  it('解析真实响应形状：数字 campaignId 与 benefitAmount', async () => {
    // 真实 item 的字段集合（实测，仅截去 displayConfig/extra 的长内容）。
    const realItem = {
      campaignId: 1,
      title: '每日签到领1000 积分',
      type: 'USER_LOGIN',
      benefitAmount: 1000,
      benefitUnit: 'CREDIT',
      pageUrl: '/v1/ops/pages/1',
      claimable: true,
      status: 'ELIGIBLE',
      description: '每日签到领取1000积分',
      pendingCount: 1,
      pendingTotalAmount: 1000,
    }
    const { fetcher } = jsonFetcher(() => ({ body: deliveryBody([realItem]) }))
    const activities = await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)

    expect(activities?.[0]?.campaignId, '数字 campaignId 必须转成字符串').toBe('1')
    expect(activities?.[0]?.amount, 'benefitAmount 才是可领积分数').toBe(1000)
    expect(activities?.[0]?.type).toBe('USER_LOGIN')
    expect(activities?.[0]?.claimable).toBe(true)
  })

  it('不可领取的活动 status 为 null 时不抛错', async () => {
    // 实测：STUDENT_CERTIFIED 项的 status 是 null（不是字符串）。
    const { fetcher } = jsonFetcher(() => ({
      body: deliveryBody([
        { campaignId: 2, type: 'STUDENT_CERTIFIED', title: '学生认证', benefitAmount: 4000, claimable: false, status: null },
      ]),
    }))
    const activities = await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)
    expect(activities?.[0]?.status).toBe('')
    expect(activities?.[0]?.campaignId).toBe('2')
  })

  it('campaignId 为对象等非标量时不产出 [object Object]', async () => {
    // 防御：非标量 ID 应当留空（进而被判 failed），而不是把
    // `[object Object]` 当作 campaignId 发给服务端。
    const { fetcher } = jsonFetcher(() => ({
      body: deliveryBody([{ campaignId: { nested: true }, type: 'USER_LOGIN', claimable: true, status: 'ELIGIBLE' }]),
    }))
    const activities = await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)
    expect(activities?.[0]?.campaignId).toBe('')
  })

  it('解析 items 并读取 claimable / campaignId', async () => {
    const { fetcher } = jsonFetcher(() => ({
      body: deliveryBody([
        { campaignId: 'c-1', type: 'USER_LOGIN', title: '每日签到得积分', claimable: true, status: 'ENTRY', amount: 1000 },
        { campaignId: 'c-2', type: 'INVITE_USER', title: '邀请好友', claimable: false, status: 'ENTRY' },
      ]),
    }))
    const activities = await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)
    expect(activities).toHaveLength(2)
    expect(activities?.[0]?.campaignId).toBe('c-1')
    expect(activities?.[0]?.claimable).toBe(true)
    expect(activities?.[0]?.amount).toBe(1000)
  })

  it('channel=IDE 是必需 query 参数', async () => {
    const { fetcher, calls } = jsonFetcher(() => ({ body: deliveryBody([]) }))
    await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)
    expect(calls[0]?.url).toContain(`channel=${CODEARTS_OPS_CHANNEL}`)
  })

  it('业务码非 0 视为失败（不能把失败当空列表）', async () => {
    // 若把 code!==0 当成功，会把「活动服务异常」显示成「今天没有活动」。
    const { fetcher } = jsonFetcher(() => ({ body: { code: 500, message: '服务异常' } }))
    expect(await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)).toBeNull()
  })

  it('items 缺失返回 null（与空活动列表区分）', async () => {
    const { fetcher } = jsonFetcher(() => ({ body: { code: 0, data: {} } }))
    expect(await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)).toBeNull()
  })

  it('findDailyCheckinActivity 只挑 USER_LOGIN，不误领邀请/新人活动', () => {
    const activities = [
      { campaignId: 'a', type: 'INVITE_USER', title: '邀请', claimable: true, status: 'ENTRY', amount: 0 },
      { campaignId: 'b', type: 'USER_LOGIN', title: '每日签到', claimable: true, status: 'ENTRY', amount: 1000 },
    ]
    expect(findDailyCheckinActivity(activities)?.campaignId).toBe('b')
    expect(findDailyCheckinActivity([])).toBeUndefined()
  })
})

describe('claimCodeArtsDailyCheckin（领取）', () => {
  /** 组合一个「账户信息 + 活动列表 + 领取」三段的桩 fetcher。 */
  function claimFetcher(options: {
    isCredit?: boolean
    isToken?: boolean
    items?: unknown[]
    claimBody?: unknown
    claimStatus?: number
  }) {
    return jsonFetcher((url) => {
      if (url.includes(CODEARTS_PACKAGE_INFO_PATH)) {
        return { body: packageInfoBody({ isCredit: options.isCredit, isToken: options.isToken }) }
      }
      if (url.includes('/v1/ops/delivery')) {
        return { body: deliveryBody(options.items ?? [
          { campaignId: 'c-1', type: 'USER_LOGIN', title: '每日签到', claimable: true, status: 'ENTRY', amount: 1000 },
        ]) }
      }
      if (url.includes('/v1/ops/claim')) {
        return { status: options.claimStatus ?? 200, body: options.claimBody ?? { code: 0, data: { id: null, credit: 1000 } } }
      }
      if (url.includes('/v1/ops/confirm')) {
        return { body: { code: 0, data: {} } }
      }
      return { status: 404, body: {} }
    })
  }

  it('正常领取成功', async () => {
    const { fetcher } = claimFetcher({})
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') expect(outcome.credit).toBe(1000)
  })

  /**
   * 真实缺陷回归：用**真实响应形状**走完整领取流程。
   *
   * 早期实现用 `readString` 读数字 `campaignId` → 空串 → 直接判
   * `failed`「活动缺少 campaignId，无法领取」，用户看到「1 个失败」。
   * 本用例断言领取请求**真的发出**且 body 里的 campaignId 正确。
   */
  it('数字 campaignId 也能正常领取（真实响应形状）', async () => {
    const { fetcher, calls } = claimFetcher({
      items: [{
        campaignId: 1,
        title: '每日签到领1000 积分',
        type: 'USER_LOGIN',
        benefitAmount: 1000,
        benefitUnit: 'CREDIT',
        claimable: true,
        status: 'ELIGIBLE',
      }],
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)

    expect(
      outcome.kind,
      '数字 campaignId 未被解析：领取会以「缺少 campaignId」失败',
    ).toBe('claimed')
    const claimCall = calls.find((call) => call.url.includes('/v1/ops/claim'))
    expect(claimCall, '未发出领取请求').toBeDefined()
    expect(JSON.parse(String(claimCall?.init?.body))).toEqual({
      campaignId: '1',
      channel: CODEARTS_OPS_CHANNEL,
    })
  })

  it('领取响应不含积分数时回退到活动的 benefitAmount', async () => {
    // 实测活动条目的 benefitAmount=1000；领取响应若不带金额，
    // 应当用它兜底，而不是显示 +0。
    const { fetcher } = claimFetcher({
      items: [{
        campaignId: 1, type: 'USER_LOGIN', benefitAmount: 1000,
        claimable: true, status: 'ELIGIBLE',
      }],
      claimBody: { code: 0, data: { id: null } },
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') expect(outcome.credit).toBe(1000)
  })

  it('Token 计费账户（体验版）有可领取活动时照样领取 —— isCreditPackage 不是门禁', async () => {
    // 真实缺陷回归（2026-10-08 第三重根因）：体验版账号
    // （spec=codearts.agent.trial、is_credit_package=false、is_token_package=true）
    // 的 statistics/plugin 里没有任何积分 metric，但同一凭据下
    // GET /v1/ops/delivery 明确返回 USER_LOGIN 且 claimable:true，
    // POST /v1/ops/claim 实测 HTTP 200 并真发 1000 积分。
    // 旧的 `!isCreditPackage ⇒ inactive` 提前返回是假阴性：凭据修好了也永远
    // 显示「Token 计费账户，不在积分活动范围」，用户永远看不到签到成功。
    const { fetcher, calls } = claimFetcher({ isCredit: false, isToken: true })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(
      outcome.kind,
      'isCreditPackage=false 的账号被提前判 inactive：签到永远领不到',
    ).toBe('claimed')
    expect(calls.some((call) => call.url.includes('/v1/ops/claim'))).toBe(true)
  })

  it('非积分非 Token 账户有可领取活动时同样领取', async () => {
    const { fetcher } = claimFetcher({ isCredit: false, isToken: false })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('claimed')
  })

  it('Token 计费账户且无每日签到活动 → inactive，文案指出账户类型', async () => {
    // 账户类型降级为**文案修饰**：服务端确实没给每日签到活动时，
    // 用 isTokenPackage 给出比「未找到每日签到活动」更具体的原因。
    const { fetcher, calls } = claimFetcher({
      isCredit: false,
      isToken: true,
      items: [{ campaignId: 'c-9', type: 'INVITE_USER', title: '邀请', claimable: true, status: 'ENTRY' }],
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('inactive')
    if (outcome.kind === 'inactive') {
      expect(outcome.message).toBe('Token 计费账户，不在积分活动范围')
    }
    expect(calls.some((call) => call.url.includes('/v1/ops/claim'))).toBe(false)
  })

  it('积分账户且无每日签到活动 → inactive「未找到每日签到活动」', async () => {
    const { fetcher } = claimFetcher({
      items: [{ campaignId: 'c-9', type: 'INVITE_USER', title: '邀请', claimable: true, status: 'ENTRY' }],
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('inactive')
    if (outcome.kind === 'inactive') {
      expect(outcome.message).toBe('未找到每日签到活动')
    }
  })

  it('重复领取的业务码 40001 判为 already-claimed（不是 failed）', async () => {
    // 实测：领取成功后活动列表的 claimable 会在一段时间内仍是 true，
    // 再发一次 POST /v1/ops/claim ⇒ HTTP 200
    // {"code":40001,"message":"尚未到达权益刷新时间，暂时无法领取","data":null}。
    // 这是「今天已经领过」，不是故障；判成 failed 会让用户看到一个并不存在的错误。
    const { fetcher } = claimFetcher({
      claimBody: { code: 40001, message: '尚未到达权益刷新时间，暂时无法领取', data: null },
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('already-claimed')
    if (outcome.kind === 'already-claimed') {
      expect(outcome.message).toBe('今天已领取')
    }
  })

  it('其它业务码仍判为 failed 并带出服务端文案（40001 不是万能兜底）', async () => {
    const { fetcher } = claimFetcher({ claimBody: { code: 40002, message: '活动已结束' } })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.code).toBe(40002)
  })

  it('已领取状态（CLAIMED）判为 already-claimed，且不发领取请求', async () => {
    const { fetcher, calls } = claimFetcher({
      items: [{ campaignId: 'c-1', type: 'USER_LOGIN', title: '每日签到', claimable: false, status: 'CLAIMED' }],
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('already-claimed')
    expect(calls.some((call) => call.url.includes('/v1/ops/claim'))).toBe(false)
  })

  it('不可领取但状态未知判为 inactive', async () => {
    const { fetcher } = claimFetcher({
      items: [{ campaignId: 'c-1', type: 'USER_LOGIN', title: '每日签到', claimable: false, status: 'PENDING' }],
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('inactive')
  })

  it('无每日签到活动判为 inactive', async () => {
    const { fetcher } = claimFetcher({
      items: [{ campaignId: 'c-9', type: 'INVITE_USER', title: '邀请', claimable: true, status: 'ENTRY' }],
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('inactive')
  })

  it('领取响应 id 非 null 时补发 confirm', async () => {
    // 漏掉 confirm 会让积分停在「待确认」而不入账（IDE 的行为即如此）。
    const { fetcher, calls } = claimFetcher({ claimBody: { code: 0, data: { id: 'benefit-1', credit: 1000 } } })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('claimed')
    expect(calls.some((call) => call.url.includes('/v1/ops/confirm'))).toBe(true)
  })

  it('id 为 null 时不发 confirm', async () => {
    const { fetcher, calls } = claimFetcher({ claimBody: { code: 0, data: { id: null, credit: 1000 } } })
    await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(calls.some((call) => call.url.includes('/v1/ops/confirm'))).toBe(false)
  })

  it('confirm 失败不影响 claimed 结论', async () => {
    // 积分已进入待确认态；报 failed 会让用户以为没领到而重复点击。
    const calls: string[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes(CODEARTS_PACKAGE_INFO_PATH)) {
        return Response.json(packageInfoBody())
      }
      if (url.includes('/v1/ops/delivery')) {
        return Response.json(deliveryBody([
          { campaignId: 'c-1', type: 'USER_LOGIN', title: '每日签到', claimable: true, status: 'ENTRY', amount: 1000 },
        ]))
      }
      if (url.includes('/v1/ops/claim')) {
        return Response.json({ code: 0, data: { id: 'benefit-1', credit: 1000 } })
      }
      return new Response('nope', { status: 500 })
    }) as unknown as typeof fetch
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('claimed')
  })

  it('领取业务失败判为 failed 并带出服务端文案', async () => {
    const { fetcher } = claimFetcher({
      claimBody: { code: 4001, message: '活动已结束' },
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.code).toBe(4001)
      expect(outcome.message).toBe('活动已结束')
    }
  })

  it('账户信息查询失败判为 failed（不是 inactive）', async () => {
    const fetcher = (async () => new Response('bad', { status: 502 })) as unknown as typeof fetch
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('failed')
  })

  it('活动列表查询失败判为 failed（不是 inactive）', async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes(CODEARTS_PACKAGE_INFO_PATH)) return Response.json(packageInfoBody())
      return new Response('bad', { status: 502 })
    }) as unknown as typeof fetch
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('failed')
  })

  it('缺少 campaignId 时判为 failed 且不发领取请求', async () => {
    const { fetcher, calls } = claimFetcher({
      items: [{ type: 'USER_LOGIN', title: '每日签到', claimable: true, status: 'ENTRY' }],
    })
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('failed')
    expect(calls.some((call) => call.url.includes('/v1/ops/claim'))).toBe(false)
  })

  it('领取请求是 POST 且带 campaignId 与 channel', async () => {
    const { fetcher, calls } = claimFetcher({})
    await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    const claimCall = calls.find((call) => call.url.includes('/v1/ops/claim'))
    expect(claimCall?.init?.method).toBe('POST')
    expect(JSON.parse(String(claimCall?.init?.body))).toEqual({
      campaignId: 'c-1',
      channel: CODEARTS_OPS_CHANNEL,
    })
  })

  it('网络异常不抛出，转为 failed 且保留底层原因（逐账号批量处理要求）', async () => {
    // collectClaimResults 逐个账号调用本函数；抛出会中断整批。
    // 同时底层错误消息必须保留 —— 压成笼统文案会让排查失去线索。
    const fetcher = (async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    const outcome = await claimCodeArtsDailyCheckin(CREDENTIAL, fetcher)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.message).toContain('socket hang up')
  })
})

describe('签名请求的查询串参与签名', () => {
  it('带 query 的 delivery 请求签名覆盖 query（否则服务端验签失败）', async () => {
    // sign.ts 的 canonicalRequest 含 query 段；这里只需确认请求确实带了 query
    // 且签名头存在 —— 真实验签由 e2e 覆盖。
    const { fetcher, calls } = jsonFetcher(() => ({ body: deliveryBody([]) }))
    await fetchCodeArtsOpsActivities(CREDENTIAL, fetcher)
    const headers = new Headers(calls[0]?.init?.headers)
    expect(calls[0]?.url).toContain('?channel=IDE')
    expect(headers.get('authorization')).toMatch(/SignedHeaders=.*host/)
    expect(vi.isMockFunction(fetcher)).toBe(false)
  })
})
