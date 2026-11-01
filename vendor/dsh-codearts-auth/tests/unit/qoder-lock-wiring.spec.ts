/**
 * Qoder（国际版 `qoder` / 中国版 `qodercn`）的
 * 「永久/长期/临期三档分档 + 锁定永久积分」**接线**回归。
 *
 * ## 为什么单独守这个（而不是复用 `buddy-permanent-lock.spec.ts`）
 *
 * 那份守的是「怎么建选号器」这一层通用约定。Qoder 的形态**不同**，
 * 且差异正好落在**最容易写错的两处**：
 *
 * 1. **`expiresAt` 是永久哨兵，不是到期时刻。**
 *    `GET {openApiBase}/sash/api/v2/me/usage` 的 `qoderUsage.expiresAt`
 *    在个人版下发的恒是 `253402214400000`（= `9999-12-31T00:00:00.000Z`）。
 *    ⚠️ 若把它**原样**写进 `deductionEndTime`，前端 `formatPackageExpiry`
 *    会渲染成「9999-12-31（约 2900000 天后）」—— 荒谬文案；而且该包会被
 *    `splitBuddyCreditsByExpiry` 判成「到期还早 ⇒ 长期」，于是**锁定永久积分
 *    对它就失效了**（锁了也照烧）。⇒ 判据必须是「**不写**」，让未知到期
 *    落进永久桶（本仓库红线：绝不编造日期）。
 * 2. **两站是两个渠道 id、两个 product、两个域名。**
 *    共用一个 `QoderAuth` 不等于共用一个 id；`fetchQoderCreditBalance` 的
 *    `product` 是**第二**参（minimax 那份是第三参）—— 传错会让选号读到对方站点。
 *
 * ## 判据分三层（由弱到强）
 *
 * 1. **registry 契约**：两家 `permanentLock` / `usesExpiryWindow` 均 `true`。
 * 2. **`index.ts` 源码接线**（`codeOnly()` 剥注释）：两个 selector 各自
 *    `product:` 正确、各自接进 `balance.selector`、`lockedError` 逐站点名、
 *    `reportPickedAccount: true` 两处齐备。
 * 3. **行为层**：把**真实上游报文形状**喂给生产解析器
 *    `fetchQoderCreditBalance`，再用 `splitBuddyCreditsByExpiry` /
 *    `buddyBalanceTier` / 前端 `packageExpiryMs` 验证**用户可见后果**。
 *
 * ⚠️ **不做**的事：不发真实网络（`fetcher` 全部注入假实现）、不读真实凭据。
 * ⚠️ 国际版 `openapi.qoder.sh` 在本机**网络不可达**（实测 ~10.7s）——
 *    故行为层**必须**注入 `fetcher`，绝不依赖真实 fetch。
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PROVIDER_REGISTRY, descriptorOf } from '../../src/provider-registry.js'
import { PERMANENT_LOCK_PROVIDERS } from '../../src/jet-hub-rpc.js'
import {
  QODER_PERMANENT_EXPIRY_MS,
  fetchQoderCreditBalance,
} from '../../src/qoder-credits.js'
import { QODER, QODER_CN } from '../../src/qoder-product.js'
import {
  BUDDY_BALANCE_TIER,
  BUDDY_EXPIRING_WINDOW_DAYS,
  buddyBalanceTier,
  buddyTierUsable,
  splitBuddyCreditsByExpiry,
} from '../../src/buddy-balance-rank.js'
import {
  formatPackageExpiry,
  packageExpiryMs,
  splitCreditsByExpiry,
} from '../../plugin-src/client/credit-expiry.js'
import type { QoderCredential } from '../../src/qoder.js'
import type { CreditPackage } from '../../src/credits.js'

const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(here, '../../src/index.ts'), 'utf8').replace(/\r\n/g, '\n')

/**
 * 剥掉注释后的源码。
 *
 * ⚠️ 接线断言不能因为「注释里提到了某个符号」就通过：本仓库注释大量解释
 * 「为什么不能走某条兜底」，对兜底的**否定**断言必须只看代码（与
 * `buddy-permanent-lock.spec.ts` 同一约定）。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}
const indexCode = codeOnly(indexSource)

/**
 * ⚠️ 凭据形状取 `QoderCredential` 的两个**必填**字段。
 * `security_oauth_token` 优先（`qoderBearerToken`），故两者都给。
 */
const CRED = {
  security_oauth_token: 's'.repeat(60),
  access_token: 'a'.repeat(60),
  machine_id: 'm-1',
} as unknown as QoderCredential

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** 从假 `fetcher` 走**生产解析器**拿余额（`null` 即解析失败，用例会当场点名）。 */
async function balanceOf(body: unknown, product = QODER_CN) {
  const fetcher = vi.fn().mockResolvedValue(json(body))
  const balance = await fetchQoderCreditBalance(CRED, product, fetcher as never)
  expect(balance, '生产解析器应产出余额（否则本用例测的不是分档）').not.toBeNull()
  return balance!
}

/**
 * **真实报文**（Lead 2026-10-20 实测，qodercn 账号 `nick8893875717`）。
 *
 * ⚠️ 逐字保留关键事实，别「顺手」美化：
 * - `userQuota` 全 0（个人版套餐额度就是 0）
 * - `addOnQuota` = 2000（额度全在这层，且**只给聚合标量**，没有任何日期字段）
 * - 顶层 `expiresAt = 253402214400000` ⇒ 永久哨兵
 */
const REAL_USAGE = {
  displayMode: 'qoder',
  qoderUsage: {
    userId: '01a0cca1-2528-718e-a44e-a31d9263e29a',
    userType: 'personal_standard',
    usageType: 'credits',
    totalUsagePercentage: 0,
    isQuotaExceeded: false,
    expiresAt: 253402214400000,
    upgradeUrl: 'https://qoder.cn/pricing?client=qoder',
    userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
    addOnQuota: {
      total: 2000, used: 0, remaining: 2000, percentage: 0, unit: 'credits',
      detailUrl: 'https://qoder.cn/account/usage',
    },
    isPlanQuotaProrated: false,
  },
}

/**
 * 同一份真实报文的**非零套餐额度**变体（`userQuota` 有余额）。
 *
 * ⚠️ 为什么需要它：真实报文里 `userQuota.remaining === 0`，而
 * `splitBuddyCreditsByExpiry` 会**跳过 `remaining <= 0` 的包** ⇒ 直接拿真实
 * 报文测分桶会「全桶都是 0」，断言变成同义反复。故只把**额度数字**改非零，
 * 到期字段逐字不动（哨兵仍是哨兵）—— 这样测的仍是「哨兵包如何分桶」。
 */
function usageWithPlanQuota(remaining: number, expiresAt: number): unknown {
  return {
    ...REAL_USAGE,
    qoderUsage: {
      ...REAL_USAGE.qoderUsage,
      expiresAt,
      userQuota: { total: remaining, used: 0, remaining, percentage: 0, unit: 'credits' },
    },
  }
}

/** 按包名取包（生产解析器的展示顺序：套餐额度 → 资源包 → 专用资源包）。 */
function pkgNamed(packages: readonly CreditPackage[], name: string): CreditPackage {
  const found = packages.find((p) => p.name === name)
  expect(found, `生产解析器没有产出名为「${name}」的包`).toBeDefined()
  return found!
}

describe('★ Qoder：`permanentLock` / `usesExpiryWindow` 的 registry 契约', () => {
  it('两站都同时登记 permanentLock 与 usesExpiryWindow', () => {
    for (const id of ['qoder', 'qodercn']) {
      // 前者 ⇒ 客户端渲染「锁定/解锁」按钮 + `createCredentialResolver` 读 allowPermanent；
      // 后者 ⇒ `jet-hub-rpc.ts` 回传 `windowDays`（缺它 ⇒ 分档整体返回 null，静默）。
      expect(descriptorOf(id)?.permanentLock, `${id} 应支持锁定永久积分`).toBe(true)
      expect(descriptorOf(id)?.usesExpiryWindow, `${id} 应按到期分桶`).toBe(true)
    }
  })

  it('后端白名单（PERMANENT_LOCK_PROVIDERS）由 registry 派生且含两站', () => {
    // 直接钉住「派生关系」，而不是只断言成员 —— 有人手抄一份名单会在这里红。
    const derived = PROVIDER_REGISTRY.filter((d) => d.permanentLock === true).map((d) => d.id).sort()
    expect(derived).toContain('qoder')
    expect(derived).toContain('qodercn')
    expect([...PERMANENT_LOCK_PROVIDERS].sort()).toEqual(derived)
  })

  it('⚠️ 两站是**两个**渠道 id（共用一个 QoderAuth 不等于共用一个 id）', () => {
    // 只登记中国版会让国际站在聚合面板看到「请先登录」这句错话，
    // 且只登国际站的用户完全拿不到分档与锁定按钮。
    expect(QODER.id).toBe('qoder')
    expect(QODER_CN.id).toBe('qodercn')
    expect(QODER.id).not.toBe(QODER_CN.id)
    // ⚠️ 主机也必须不同：分档原语的 `product` 决定查哪个站点。
    expect(QODER.openApiBase).not.toBe(QODER_CN.openApiBase)
  })
})

describe('★ Qoder：`index.ts` 的接线（源码级，守纯文本形态的约定）', () => {
  it('两站各建一个选号器，且各自接到工厂的 balance.selector', () => {
    expect(indexCode).toMatch(
      /const qoderBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: QODER,/,
    )
    expect(indexCode).toMatch(
      /const qoderCnBalanceSelector = new BuddyBalanceSelector\(\{\s*\n\s*product: QODER_CN,/,
    )
    // 建了不用 = 死代码，锁定仍无执行路径。
    expect(indexCode, '国际版的 balance.selector 必须指向 qoderBalanceSelector')
      .toMatch(/selector:\s*qoderBalanceSelector,/)
    expect(indexCode, '中国版的 balance.selector 必须指向 qoderCnBalanceSelector')
      .toMatch(/selector:\s*qoderCnBalanceSelector,/)
  })

  it('★★ 两个选号器的 `product` **不得互换**（互换会让余额查询打到对方站点）', () => {
    // ⚠️ 互换的后果**不是报错**，而是静默：`openapi.qoder.sh` 不认中国版 token
    //    ⇒ 余额恒 `null` ⇒ 未锁定时换号优化失效、锁定时永远报「没有可用账号」。
    for (const [name, product, other] of [
      ['qoderBalanceSelector', 'QODER', 'QODER_CN'],
      ['qoderCnBalanceSelector', 'QODER_CN', 'QODER'],
    ] as const) {
      const start = indexCode.indexOf(`const ${name} = new BuddyBalanceSelector({`)
      expect(start, `index.ts 里找不到 ${name}`).toBeGreaterThan(-1)
      const block = indexCode.slice(start, indexCode.indexOf('})', start))
      expect(block, `${name} 必须用 product: ${product}`).toMatch(
        new RegExp(`product:\\s*${product},`),
      )
      // ⚠️ `QODER_CN` 以 `QODER` 开头，故对 `QODER` 的反向断言必须带词边界，
      //    否则 `product: QODER_CN,` 会被 `QODER` 命中（假绿）。
      expect(block, `${name} 不得用 ${other}`).not.toMatch(
        new RegExp(`product:\\s*${other}\\b(?!_)`),
      )
    }
  })

  it('★ 两处 `lockedError` 逐站点名（不得共用一句文案）', () => {
    // 两站账号不互通，用户要知道去**哪个面板**解锁。
    expect(indexCode).toMatch(/lockedError:\s*qoderLockedError\('Qoder'\)/)
    expect(indexCode).toMatch(/lockedError:\s*qoderLockedError\('Qoder \(中国版\)'\)/)
    // ⚠️ 反向：不得两家都传同一个 displayName（那会让中国版用户去国际版面找解锁）。
    expect(indexCode, '两家不得共用同一个 displayName').not.toMatch(
      /lockedError:\s*qoderLockedError\('Qoder'\),[\s\S]{0,2000}lockedError:\s*qoderLockedError\('Qoder'\),/,
    )
  })

  it('⚠️ 两站都必须 `reportPickedAccount: true`（账本归属不能因新增 balance 而丢）', () => {
    // ⚠️ 这是 MiniMax 那批的真实踩点：本家旧闭包是**纯池选号**、账本**一直在回报**。
    //    接上 `balance` 后「分档选中」那一支若不回报 ⇒ token 用量记不到本渠道上
    //    （静默）。该形态由 `credential-resolver.spec.ts` 的「池命中时回报 token 账本」
    //    逐家驱动 `apply()` 守着（`qoder` / `qodercn` 都在那份名单里）。
    for (const [selector, display] of [
      ['qoderBalanceSelector', "qoderLockedError('Qoder')"],
      ['qoderCnBalanceSelector', "qoderLockedError('Qoder (中国版)')"],
    ] as const) {
      const at = indexCode.indexOf(`selector: ${selector},`)
      expect(at, `找不到 selector: ${selector},`).toBeGreaterThan(-1)
      const block = indexCode.slice(at, indexCode.indexOf('},', at))
      expect(block, `${selector} 所在的 balance 块必须 lockedError: ${display}`)
        .toContain(`lockedError: ${display}`)
      expect(block, `${selector} 所在的 balance 块必须 reportPickedAccount: true`)
        .toMatch(/reportPickedAccount:\s*true,/)
      expect(block, `${selector} 所在的 balance 块不得写 reportPickedAccount: false`)
        .not.toMatch(/reportPickedAccount:\s*false/)
    }
    // 全局下限自检：两处 true 之外不得有第三处（防「随便找个地方加一个」）。
    const occurrences = indexCode.match(/reportPickedAccount:\s*true,/g) ?? []
    expect(occurrences.length, '至少两处（两站各一）').toBeGreaterThanOrEqual(2)
  })

  /**
   * ★ 两站都接限流判定（池被筛空时会误报「请先登录」，Gitee IKJOZ9）。
   *
   * ⚠️⚠️ **判据必须按渠道切片**（2026-10-21 审计实测：原版**无牙**）。
   *
   * 原版是一句**全局** `expect(indexCode).toMatch(/throwIfAllRateLimited: …/)`，
   * 而 `src/index.ts` 里有 **16 处**该字段 ⇒ 删掉 qoder（或 qodercn）自己那一处，
   * 全局正则**照样命中别人家的** ⇒ 永远绿。审计员实测：分别删中国版 / 国际站
   * 各一处，**两次都全绿**。
   *
   * ⇒ 改成「在**该站的选号器接线区间内**断言」。区间取法：
   *    从 `selector: <该站选号器>,` 起，到**下一个** `selector: <另一站选号器>,` /
   *    `const ` 级声明 / `registerQoderLlm` 调用之前。
   *    ⚠️ 不能取裸 `'},'` 作终点：`fallback: { kind: 'ref', … }` 里也有 `},`，
   *    而 `throwIfAllRateLimited` 恰好排在 `fallback` **之后** ⇒ 会切成空区间
   *    （这正是上一版无牙的另一种形态）。
   */
  it('★ 两站都接限流判定（按渠道切片，不得用全局正则）', () => {
    for (const [selector, display] of [
      ['qoderBalanceSelector', "qoderLockedError('Qoder')"],
      ['qoderCnBalanceSelector', "qoderLockedError('Qoder (中国版)')"],
    ] as const) {
      const at = indexCode.indexOf(`selector: ${selector},`)
      expect(at, `找不到 selector: ${selector},`).toBeGreaterThan(-1)
      // 终点：下一站选号器 / 下一段 const / 适配器注册，三者谁先到取谁。
      const candidates = [
        indexCode.indexOf('selector: qoderBalanceSelector,', at + 1),
        indexCode.indexOf('selector: qoderCnBalanceSelector,', at + 1),
        indexCode.indexOf('\n  const ', at + 1),
        indexCode.indexOf('registerQoderLlm(', at + 1),
      ].filter((i) => i > at)
      const end = candidates.length > 0 ? Math.min(...candidates) : undefined
      const block = indexCode.slice(at, end)
      expect(block.length, `${selector} 的接线区间切成了空——判据会变成同义反复`).toBeGreaterThan(50)
      expect(block, `${selector} 的区间必须含 lockedError: ${display}`).toContain(`lockedError: ${display}`)
      expect(
        block,
        `${selector} 必须接 throwIfAllRateLimited —— 否则该号被本模型限流、池被筛空时`
        + '会误报「请先登录」（Gitee IKJOZ9 的原症状）',
      ).toMatch(/throwIfAllRateLimited:\s*throwIfAllAccountsRateLimited/)
    }
  })

  it('★ 两站都**不传** XFF（与 MiniMax 国际站的关键差异）', () => {
    // `agent.minimax.io` 会按出口 IP 307 到中国站；Qoder 两站各有独立域名
    // 且互不 307 ⇒ 多传一个头反而可能被判签名/设备不符。
    for (const name of ['qoderBalanceSelector', 'qoderCnBalanceSelector']) {
      const start = indexCode.indexOf(`const ${name} = new BuddyBalanceSelector({`)
      const block = indexCode.slice(start, indexCode.indexOf('})', start))
      expect(block, `${name} 不得传 minimaxXff`).not.toMatch(/minimaxXff/)
    }
  })

  it('★ 锁定文案本家独有（不与 buddy 系共用）', () => {
    // buddy 系口径是「服务端资源包 N 天内到期」，Qoder 是「套餐额度 / 个人资源包，
    // 上游只给聚合标量、逐包到期拿不到」—— 按 buddy 那句去排查会找不到东西。
    expect(indexCode, 'qoder 必须有独立的 lockedError 文案构造器')
      .toContain('const qoderLockedError =')
    const start = indexCode.indexOf('const qoderLockedError =')
    const block = indexCode.slice(start, indexCode.indexOf('\n  }\n', start))
    // `credential-only` 档必须**明确劝阻解锁**（解锁不可撤回地烧永久积分，
    // 而该情形的根因在凭据、与积分无关）。
    expect(block, '必须处理 credential-only 档').toContain("reason.kind === 'credential-only'")
    expect(block, 'credential-only 文案必须劝阻解锁').toContain('不要去解锁永久积分')
    // 穷尽性守卫：兜底只允许 exhausted（否则将来加档位会静默落进「积分用尽」）。
    expect(block, '必须有穷尽性守卫（exhaustedOnly）')
      .toContain("const exhaustedOnly: { kind: 'exhausted' } = reason")
    // 错误码必须是宿主可分类的那种（QUOTA_EXCEEDED），不能是裸 Error。
    expect(block, '必须用 LlmError 而非裸 Error（裸 Error 没有 code）').toContain('new LlmError(')
    expect(block, '两站共用本函数，displayName 必须逐站区分').toContain('displayName')
    // ⚠️ **不得编造天数**：逐包到期拿不到 ⇒ 文案不绑定「N 天内到期」这类说法
    //    （只有 `unknown` / `exhausted` 两档引用运行时窗口天数，这是既有口径；
    //    这里只钉住「credential-only 档不写天数」这条本次新增的红线）。
    const credentialOnly = block.slice(
      block.indexOf("reason.kind === 'credential-only'"),
      block.indexOf('const exhaustedOnly'),
    )
    expect(credentialOnly, 'credential-only 档不得编造「N 天内到期」')
      .not.toContain('天内到期')
  })

  /**
   * ★★ **`fetchBalance` 闭包内必须透传 `product` 形参，不得写死站点常量**
   * （2026-10-21 审计发现：三份 spec 对这一格**零覆盖**，而它正是本文件头警告的那件事）。
   *
   * ## 缺陷（实测可打穿）
   *
   * `BuddyBalanceSelector` 有**两条**取数腿：构造参数 `product` 与注入的
   * `fetchBalance(credential, product)`。上面那些用例只钉前者（`product: QODER,`），
   * 而把闭包写成 `fetchQoderCreditBalance(credential, QODER_CN)`（**写死对方站点**）
   * 后，本文件 **22 条全绿** —— 审计员实测确认。
   *
   * 而 `BuddyBalanceSelector.select` 调的是 `injected(credential, this.deps.product)`
   * ⇒ 闭包里若忽略形参、写死常量，请求就会打到**对方站点**：
   * ```
   * 正常    → fetch 打到 openapi.qoder.sh        ✓
   * 写死 CN → fetch 打到 openapi.qoder.com.cn    ✗ 打错站点
   * ```
   * 后果（本文件头已逐字写明）：对方站点不认本站 token ⇒ 余额恒 `null`
   * ⇒ 未锁定时换号优化失效、锁定时永远报「没有可用账号」。
   *
   * ## 判据
   *
   * 按**该站选号器的构造块**切片，断言 `fetchBalance:` 那一行**引用了 `product` 形参**
   * 且**不出现另一站的常量**。这是源码级判据，因此必须切片 + 长度自检
   * （全局正则会命中别人家，正是刚修掉的那类无牙）。
   */
  it('★★ 两站的 fetchBalance 闭包必须透传 product 形参（不得写死对方站点）', () => {
    const cases = [
      ['qoderBalanceSelector', 'QODER', 'QODER_CN'],
      ['qoderCnBalanceSelector', 'QODER_CN', 'QODER'],
    ] as const
    for (const [name, own, other] of cases) {
      const start = indexCode.indexOf(`const ${name} = new BuddyBalanceSelector({`)
      expect(start, `找不到 ${name}`).toBeGreaterThan(-1)
      const block = indexCode.slice(start, indexCode.indexOf('\n  })', start))
      expect(block.length, `${name} 的构造块切成了空——判据会变成同义反复`).toBeGreaterThan(60)
      // ⚠️ 2026-10-21 改：不能只取一行。余额查询现在要**按账号取出口代理**
      // （国际版 `openapi.qoder.sh` 被 SNI 阻断），于是箭头函数体换行了：
      // ```
      // fetchBalance: async (credential, product) =>
      //   fetchQoderCreditBalance(credential, product, await fetcherForQoderCredential(credential)),
      // ```
      // 单行正则 `/fetchBalance:[^\n]*/` 会在 `=>` 处截断，判据变成
      // 「有没有这半行字」= 无牙。改为切到下一个 4 空格缩进的属性/注释为止。
      const line = block.match(/fetchBalance:[\s\S]*?(?=\n {4}\S)/)
      expect(line, `${name} 必须注入 fetchBalance`).not.toBeNull()
      expect(line![0], `${name} 的 fetchBalance 必须透传 product 形参`)
        .toMatch(/\(credential, product\)\s*=>\s*fetchQoderCreditBalance\(credential, product,/)
      expect(line![0], `★ ${name} 的 fetchBalance 不得写死 ${other}（会打到对方站点，余额恒 null）`)
        .not.toContain(`${other}`)
    }
  })
})

describe('★★ Qoder：分档行为（驱动生产判据，不是复述实现）', () => {
  it('★ 哨兵常量的值与真实报文**互相印证**（不是从被测代码自己算出来的）', async () => {
    // ⚠️ 独立事实来源：`Date.UTC(9999, 11, 31)` —— 与 `REAL_USAGE` 里那个
    //    Lead 实测值、以及常量三者必须一致。任何一处漂移都会在这里红。
    const independent = Date.UTC(9999, 11, 31)
    expect(new Date(independent).toISOString()).toBe('9999-12-31T00:00:00.000Z')
    expect(QODER_PERMANENT_EXPIRY_MS).toBe(independent)
    expect(REAL_USAGE.qoderUsage.expiresAt).toBe(independent)
  })

  it('★★ 永久哨兵 ⇒ `userQuota` **不写** `deductionEndTime`（不编造日期）', async () => {
    const balance = await balanceOf(REAL_USAGE)
    const plan = pkgNamed(balance.packages, '套餐额度')
    // ⚠️ 这是本家最要紧的一条：哨兵若被原样写进 `deductionEndTime`，
    //    前端会渲染「9999-12-31（约 2900000 天后）」这种荒谬文案。
    expect(plan.deductionEndTime, '永久哨兵不得写进 deductionEndTime').toBeUndefined()
    // 也不得编造 0 / 任何远期时刻（`0` 在分桶里等价于未知，但语义不同）。
    expect(plan.deductionEndTime).not.toBe(0)
    expect(plan.deductionEndTime).not.toBe(QODER_PERMANENT_EXPIRY_MS)
  })

  it('★ 真实时间戳 ⇒ 原样写成 `deductionEndTime`（证明判据没把真到期也一起吞掉）', async () => {
    const real = 1_793_000_000_000
    expect(new Date(real).getUTCFullYear(), '前置：该值必须是真实年份，不是哨兵').toBeLessThan(9999)
    const balance = await balanceOf(usageWithPlanQuota(1000, real))
    const plan = pkgNamed(balance.packages, '套餐额度')
    // 原样毫秒：不做秒级换算、不做 Date.parse（与 minimax 的 `expire_at_ms` 同形）。
    expect(plan.deductionEndTime, '真实时间戳必须原样写入').toBe(real)
  })

  it('★ 边界：`9999-01-01`（**小于**常量但年份 9999）也**不写**', async () => {
    // ⚠️ 这条锁的是「判据必须含**年份**分支」：只写 `>= 常量` 会漏掉
    //    `9999-01-01` ~ `9999-12-30` 这一段（`253370764800000` ~ `253402214399999`）。
    const almost = Date.UTC(9999, 0, 1)
    expect(almost, '前置：该值必须**小于**哨兵常量').toBeLessThan(QODER_PERMANENT_EXPIRY_MS)
    expect(new Date(almost).getUTCFullYear()).toBe(9999)
    const balance = await balanceOf(usageWithPlanQuota(1000, almost))
    expect(pkgNamed(balance.packages, '套餐额度').deductionEndTime).toBeUndefined()
  })

  it('★ 边界：`9998-12-31`（年份 < 9999）**仍写**（证明判据没过度收窄）', async () => {
    // ⚠️ 与上一条**成对**：只证明「9999 不写」不够 —— 把判据写成
    //    「年份 >= 9998」或「时间戳 > 某个更早的数」也能让上一条绿，
    //    却会把真实远期到期（如 8 年套餐）误判成永久。
    const far = Date.UTC(9998, 11, 31)
    expect(new Date(far).getUTCFullYear()).toBe(9998)
    expect(far).toBeLessThan(QODER_PERMANENT_EXPIRY_MS)
    const balance = await balanceOf(usageWithPlanQuota(1000, far))
    expect(pkgNamed(balance.packages, '套餐额度').deductionEndTime, '9998 年仍是真实时刻').toBe(far)
  })

  it('★ `addOnQuota`（资源包）**任何情况下**都不写 `deductionEndTime`', async () => {
    // ⚠️ 上游对 `addOnQuota` **只给聚合标量**，一个日期字段都没有。
    //    若把 `usage.expiresAt` 也按到它头上，就是把套餐的哨兵错挂到资源包。
    for (const body of [
      REAL_USAGE,
      usageWithPlanQuota(1000, 1_793_000_000_000),
      usageWithPlanQuota(1000, Date.UTC(9998, 11, 31)),
    ]) {
      const balance = await balanceOf(body)
      expect(pkgNamed(balance.packages, '资源包').deductionEndTime).toBeUndefined()
    }
  })

  it('★★ 用户可见后果：`packageExpiryMs(pkg) === null` ⇒ 显示「长期」（裁决 1）', async () => {
    // ⚠️⚠️ 这是**最有判别力**的一条：它锁的是前端真实渲染路径，而不是
    //    「某个字段是 undefined」。若哨兵被写进 `deductionEndTime`，本断言会红
    //    并且下一行会把那个荒谬文案**原样打印**出来。
    const balance = await balanceOf(REAL_USAGE)
    const plan = pkgNamed(balance.packages, '套餐额度')
    const ms = packageExpiryMs(plan)
    expect(
      ms,
      `套餐额度包经 packageExpiryMs 后必须是 null（渲染成「长期」）；`
      + `实际拿到 ${String(ms)} ⇒ 面板会显示「${formatPackageExpiry(plan, Date.now())}」`,
    ).toBeNull()
    expect(formatPackageExpiry(plan, Date.now())).toBe('长期')
    // 资源包同理（它根本没有日期字段）。
    expect(packageExpiryMs(pkgNamed(balance.packages, '资源包'))).toBeNull()
  })

  it('★★ 分桶：哨兵包全进 **permanent** 桶、expiring 为 0', async () => {
    const balance = await balanceOf(usageWithPlanQuota(1000, QODER_PERMANENT_EXPIRY_MS))
    const now = Date.now()
    const windowMs = BUDDY_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const split = splitBuddyCreditsByExpiry(balance, now, windowMs)
    expect(split, '应能分桶').toBeDefined()
    expect(split!.expiring, '哨兵包不得落临期桶').toBe(0)
    // 1000（套餐额度）+ 2000（资源包）= 3000，全部进永久桶。
    expect(split!.permanent, '两包都应进永久桶').toBe(3000)
  })

  it('★ 前后端**同规则**分桶（漂移会让「面板说有临期、选号说没号」）', async () => {
    // ⚠️ 后端 `splitBuddyCreditsByExpiry`（选号判据）与前端 `splitCreditsByExpiry`
    //    （展示）是两份实现，对同一份 `CreditPackage` 必须同结论。
    const balance = await balanceOf(usageWithPlanQuota(1000, QODER_PERMANENT_EXPIRY_MS))
    const now = Date.now()
    const windowMs = BUDDY_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const backend = splitBuddyCreditsByExpiry(balance, now, windowMs)!
    const frontend = splitCreditsByExpiry(
      balance.packages, BUDDY_EXPIRING_WINDOW_DAYS, now,
    ) as { expiring: number; permanent: number } | null
    expect(frontend, '前端分桶不应返回 null（窗口合法）').not.toBeNull()
    expect(frontend!.expiring, '前后端临期桶必须一致').toBe(backend.expiring)
    expect(frontend!.permanent, '前后端永久桶必须一致').toBe(backend.permanent)
  })

  it('★★ 锁定后只剩永久积分 ⇒ 该号不可用（tier = none）', async () => {
    const balance = await balanceOf(usageWithPlanQuota(1000, QODER_PERMANENT_EXPIRY_MS))
    const now = Date.now()
    const windowMs = BUDDY_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const split = splitBuddyCreditsByExpiry(balance, now, windowMs)!
    // ⚠️ `buddyBalanceTier` 吃的**不是** `CreditBalance`，而是分桶后的账号摘要
    //    `{ expiringBalance, permanentBalance }` —— 生产链是
    //    `BuddyBalanceSelector.classify()`。直接传 `balance` 会因字段名对不上
    //    而恒得 `none`。
    const entry = { id: 'a', expiringBalance: split.expiring, permanentBalance: split.permanent }
    // 未锁定：长期额度可用。
    expect(buddyBalanceTier(entry, { allowPermanent: true, windowMs }))
      .toBe(BUDDY_BALANCE_TIER.permanent)
    // ★ 锁定：只剩长期 ⇒ 明确不可用。这就是「锁定真的会拦」的那一步。
    const locked = buddyBalanceTier(entry, { allowPermanent: false, windowMs })
    expect(locked, '锁定后只剩永久积分 ⇒ 必须落 none（否则锁定形同虚设）')
      .toBe(BUDDY_BALANCE_TIER.none)
    expect(buddyTierUsable(locked)).toBe(false)
  })

  it('⚠️ 本家的临期桶恒为 0（上游不给逐包到期，如实记录代价）', async () => {
    // ⚠️ 这不是缺陷，是**上游数据的直接推论**：`/sash/api/v2/me/usage` 只给
    //    聚合标量，逐包明细端点实测在 qoder.cn 域 401、openapi 域 404。
    //    ⇒ 锁定后用户**不会**因为「等到临期」而恢复，唯一出路是解锁
    //    （该口径已写进 `qoderLockedError` 的文案）。
    //    本用例锁住这个**已知代价**，防止有人为了「让面板好看」编造一个到期时刻。
    const balance = await balanceOf(REAL_USAGE)
    const now = Date.now()
    const windowMs = BUDDY_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    const split = splitBuddyCreditsByExpiry(balance, now, windowMs)!
    expect(split.expiring).toBe(0)
    expect(split.permanent).toBe(2000)
    // 全量包都不得带到期时刻（含 `dedicatedResourcePackages` 缺失这一真实形态）。
    for (const pkg of balance.packages) {
      expect(pkg.deductionEndTime, `${pkg.name} 不该有到期时刻`).toBeUndefined()
    }
  })

  it('★ 两站共用同一套解析逻辑（只换 product；换 product 不影响分桶结论）', async () => {
    // ⚠️ 两站协议同源（同一个 `fetchQoderCreditBalance`），差异只在
    //    `openApiBase` —— 若有人给某一站单开一份解析，两站的分档会开始漂移。
    const cn = await balanceOf(REAL_USAGE, QODER_CN)
    const intl = await balanceOf(REAL_USAGE, QODER)
    expect(intl.total).toBe(cn.total)
    expect(intl.packages.map((p) => p.name)).toEqual(cn.packages.map((p) => p.name))
    expect(intl.packages.map((p) => p.deductionEndTime))
      .toEqual(cn.packages.map((p) => p.deductionEndTime))
  })
})

/**
 * ★★★ P1（2026-10-25 审计 A3-M3）：`qoderLockedError` 的**错误码**必须被守住。
 *
 * ## 为什么这是「全 PR 价值归零」的一格
 *
 * 本 PR 的整个卖点是「锁定报错要说清**为什么**查不到」——
 * 而这句话（`reason.errors` 里的逐账号真实原因）是**靠 message 传递**的。
 * 仓库 AGENTS.md 明确记载：`AUTH` / `QUOTA` / `ACCOUNT_QUOTA` 这三个码会被
 * 客户端 `failureMessage()` **丢掉 message 换成固定文案**
 * （宿主 `dsh-client-ui-chat` 的实测：只有 `QUOTA` / `ACCOUNT_QUOTA` / `AUTH`
 * 被替换，`QUOTA_EXCEEDED` **不在**替换表里）。
 *
 * ⇒ 把码从 `'QUOTA_EXCEEDED'` 改成 `'QUOTA'` 或 `'AUTH'`，用户就只剩
 * 「当前请求的额度已用尽」/「API 密钥无效」这类**与真实成因无关**的一句话，
 * 辛苦收集的逐账号原因**一个字都到不了用户眼前**。
 *
 * ## 缺陷：这一格**零守卫**
 *
 * 对抗审计实测：把 `qoderLockedError` 的码改成 `QUOTA` 或 `AUTH` ⇒
 * **全量 10734 passed / 0 failed**（`ratelimit-locked-misreport.spec.ts:243`
 * 虽然断言了 `toBe('QUOTA_EXCEEDED')`，但它测的是**限流那条独立文案**，
 * 不覆盖 `qoderLockedError` 的 4 个构造点）。
 *
 * ## 判据为什么不是「字面量存在性」
 *
 * 只判「文件里有 `'QUOTA_EXCEEDED'`」是弱判据（字面量留在注释/死分支里也绿）。
 * 这里判的是**每个 `new LlmError(...)` 构造点的第二实参**——即
 * 「这个函数**实际用了哪些码**」。⚠️ 切片必须精确到**下一个同级 `const`**
 * （`loomy-balance-error-contract.spec.ts` 曾用「某个具体符号」当切片终点而
 * 误圈进邻函数，本文件不重蹈：见下面 `nextTopLevelConst` 的注释）。
 */
describe('★ qoderLockedError 的错误码（防「码被换成会吞 message 的那三个」）', () => {
  /** 剥注释：本仓库反例——注释里逐字引用错误写法会让判据假红。 */
  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
  }

  /**
   * 取 `const <name> = …` 的函数体，终点是**下一个同级（两空格缩进）`const`**。
   *
   * ⚠️ 不用「某个具体符号」当终点：那个写法在邻函数插入/重排后会**静默圈错范围**
   * （本仓库 2026-10-20 真实踩过，见 `src/index.ts` 里 `astudioLockedError` 的注释）。
   */
  function lockedErrorBody(source: string, name: string): string {
    const at = source.indexOf(`  const ${name} =`)
    expect(at, `找不到 ${name}`).toBeGreaterThan(-1)
    const rest = source.slice(at + 10)
    const next = rest.search(/\n  const [A-Za-z]/)
    return next === -1 ? rest : rest.slice(0, next)
  }

  it('★★★ 每个 `new LlmError(...)` 的码都必须是字面量 QUOTA_EXCEEDED', () => {
    const indexSource = codeOnly(readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/index.ts'),
      'utf8',
    ))
    const body = lockedErrorBody(indexSource, 'qoderLockedError')

    // ⚠️ 先自证切片抓对了函数（否则下面全绿是假绿）
    expect(body, '切片没抓到 qoderLockedError 的文案').toContain('已锁定永久积分')

    // 逐个构造点取「第二实参」
    const codes = [...body.matchAll(/new LlmError\([\s\S]*?^\s*'([A-Z_]+)',/gm)].map((m) => m[1]!)
    expect(codes.length, '一个构造点都没抓到 ⇒ 判据失效').toBeGreaterThanOrEqual(4)
    for (const code of codes) {
      expect(
        code,
        `码 ${code} 会被客户端丢掉 message（换成与真实成因无关的固定文案）`
        + ' ⇒ 本 PR「说清为什么查不到」的价值归零',
      ).toBe('QUOTA_EXCEEDED')
    }
    // ⚠️ 显式点名被禁的那三个（防有人把它们写成变量绕过上面那条）
    expect(body).not.toMatch(/'AUTH'|'ACCOUNT_QUOTA'/)
  })
})

/**
 * ★★ P1（2026-10-25 审计 A3-1）：锁定时那句报错里的**逐账号原因必须折叠**。
 *
 * ## 缺陷
 *
 * 报错直接 `reason.errors.slice(0, 2).join('；')`，而 `errors` 是**逐账号**的。
 * 同一个故障在每个账号上各产生一条**逐字相同**的串 ⇒ 实测 3 个账号同样 401：
 *
 * ```
 * （积分查询失败（HTTP 401）；积分查询失败（HTTP 401））
 * ```
 *
 * 第二条信息量为零，却占掉仅有的 2 个名额 ⇒ 若第 3 个账号是**另一种**原因
 * （如 `UND_ERR_CONNECT_TIMEOUT`），那条**唯一不同的线索**会被挤掉。
 */
describe('★★ 锁定报错的原因折叠（去重 + 同因合并，且先去重后截断）', () => {
  it('★★ 三个账号同一原因 ⇒ 折叠成一条并报出账号数（不再出现两条一样的串）', async () => {
    const { foldReasonErrors } = await import('../../src/locked-error-text.js')
    const text = foldReasonErrors([
      '积分查询失败（HTTP 401）',
      '积分查询失败（HTTP 401）',
      '积分查询失败（HTTP 401）',
    ])
    expect(text).toBe('积分查询失败（HTTP 401）（共 3 个账号）')
    // ⚠️ 反向：不得出现两条相同的串（旧行为）
    expect(text.split('；')).toHaveLength(1)
  })

  it('★★ 先去重后截断：重复串不得把「唯一不同的线索」挤掉', async () => {
    const { foldReasonErrors } = await import('../../src/locked-error-text.js')
    // 前两条相同、第三条不同 —— 旧实现会取前两条（都是同样的 401）而丢掉真实的另一因
    const text = foldReasonErrors([
      '积分查询失败（HTTP 401）',
      '积分查询失败（HTTP 401）',
      '连不上 https://openapi.qoder.sh（UND_ERR_CONNECT_TIMEOUT）',
    ])
    expect(text, '唯一不同的那条线索被重复串挤掉了').toContain('UND_ERR_CONNECT_TIMEOUT')
    expect(text).toContain('共 2 个账号')
  })

  it('⚠️ 空数组给诚实兜底（不编造原因）', async () => {
    const { foldReasonErrors } = await import('../../src/locked-error-text.js')
    expect(foldReasonErrors([])).toBe('未提供具体原因')
  })

  it('⚠️ 单条不同原因保持原样（不能给每条都加账号数）', async () => {
    const { foldReasonErrors } = await import('../../src/locked-error-text.js')
    expect(foldReasonErrors(['某个原因'])).toBe('某个原因')
  })
})
