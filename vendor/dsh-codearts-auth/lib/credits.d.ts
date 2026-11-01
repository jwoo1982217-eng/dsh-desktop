/**
 * WorkBuddy 每日签到（领取积分）客户端。
 *
 * 端点与格式均来自对 WorkBuddy 5.5.6 的逆向 + 真实请求实测（2026-09-14）：
 *
 *   状态查询  POST /v2/billing/meter/checkin-activity-status   body {}
 *   领取      POST /v2/billing/meter/daily-checkin             body {}
 *
 * 两个关键结论（实测）：
 *
 * 1. **必须用 checkin-activity-status，不能用 checkin-status**。后者返回的
 *    是占位数据（active:false、checkin_dates:null、claim_button_text:""），
 *    会让人误判为"活动未开启"。前者才是权威状态源。
 *
 * 2. **不需要 X-Device-Token（图灵盾）**。静态分析曾认为该头是主要门槛，
 *    但实测三种请求头组合调用状态接口全部 200，且完全不带该头的请求真实
 *    领取成功（code:0, credit:100）并可见状态翻转。因此不引入 native SDK。
 *
 * 幂等：重复领取返回 HTTP 400 + code 10001（"今天已签到，请明天再来"）。
 * 判定以响应体 code 为准 —— 不能只看 HTTP 状态。
 */
import type { BuddyCredential } from './buddy.js';
import type { BuddyProduct } from './product.js';
/** 签到状态查询端点（权威状态源）。 */
export declare const CHECKIN_ACTIVITY_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
/** 每日签到领取端点。 */
export declare const DAILY_CHECKIN_PATH = "/v2/billing/meter/daily-checkin";
/**
 * 积分余额查询端点。
 *
 * **两个产品通用**（2026-09-15 实测）：CodeBuddy 中国版
 * （copilot.tencent.com）与 WorkBuddy 国际版（www.workbuddy.ai）都实现该端点，
 * 请求头与响应结构完全一致，只有 baseURL 不同（随 `product.endpoint` 切换）。
 *
 * 这与签到能力形成对比 —— **签到**只有中国版有（国际版内核里连
 * `checkin-status` / `daily-checkin` 的字面量都不存在），但**积分余额查询
 * 两边都有**。两者是彼此独立的能力，不要因为"国际版没有签到"就推断
 * 它也查不到余额。
 *
 * 该端点不在 CLI 内核里（内核只硬编码了 `get-dosage-notify` 用量通知），
 * 是 IDE 前端直接调用的，故静态搜索内核找不到，只能用真实凭据实测发现。
 */
export declare const USER_RESOURCE_PATH = "/v2/billing/meter/get-user-resource";
/** 签到活动状态（字段名已转为 camelCase）。 */
export interface CheckinStatus {
    /** 活动是否进行中。false 时不应尝试领取 */
    active: boolean;
    /** 今日是否已签到 —— 领取判定的权威依据 */
    todayCheckedIn: boolean;
    /** 连续签到天数 */
    streakDays: number;
    /** 每日可领积分 */
    dailyCredit: number;
    /** 今日已领积分 */
    todayCredit: number;
    /** 今日是否为连续奖励日 */
    isStreakDay: boolean;
    /** 累计已领积分 */
    totalCredits: number;
    /** 已签到日期列表（如 ["2026-09-14"]） */
    checkinDates: string[];
    /** 活动名（如「开学季」） */
    activityName: string;
    /** 主题名（如「Buddy加油站」） */
    themeName: string;
    /** 活动结束时间 */
    endTime: string;
    /**
     * 该账号**需要用户先去别处操作**才能参与签到（如未开通活动）。
     *
     * 与 {@link ClaimOutcome} 的同名字段同义 —— 见那里的详细说明。
     */
    actionRequired?: boolean;
}
/**
 * 一次领取的结果。
 *
 * ## `actionRequired`：把「需要用户操作」变成**显式语义**，而不是藏在文案里
 *
 * **真实缺陷（用户报障，2026-09-26）**：用本插件经 GitHub 授权**新注册**的
 * Qoder 账号尚未在 Qoder 侧开通每日领取，一键签到只说「当前没有可领取的活动」，
 * 用户不知道该怎么办。后端其实已给出可操作文案，但汇总行只显示计数
 * 「N 个活动未开启」，**用户看不到那条提示**。
 *
 * 修法不仅是在 UI 里多显示一句 message —— 那会让「这条 inactive 需要用户操作」
 * 这一语义**只存在于中文文案里**，前端（纯 JS，无类型检查）只能靠
 * 「有没有 message」去猜。故补一个**显式可选字段**：
 *
 * - 置 `true` 时，调用方应在结果里**单独、醒目地**展示该 message
 *   （它是给用户的行动指引，混在计数行里会被读漏）；
 * - 不置或 `false` 时按普通 `inactive` 处理（如「今天活动暂未开始」）；
 * - **可选**字段，故另外五个 provider（与所有既有调用方）无需改动，
 *   与 `src/trae-credits.ts` 用 `ClaimOutcome & { … }` 追加字段的先例同型。
 *
 * ⚠️ 与 `checkin-all.js`/`jet-hub.js` 的约定：前端判 `actionRequired === true`
 * **而不是**判 message 是否非空、更不是判文案内容 —— 后者会随措辞变化而失效。
 *
 * ## ⚠️ `coversToday`：把「这次的结果算不算**今天这一轮**」变成显式语义
 *
 * **真实缺陷（2026-10-02 审查 PR !33 定位）**：`already-claimed` 这个 kind
 * **天然有歧义** —— 它只说明「服务端认为没有可领的了」，而「没有可领的」在某些
 * 渠道里**不等于**「今天这条已领」。典型是 Qoder：活动**每日 10:00（UTC+8）
 * 才刷新**（服务端原文：「每日 10:00（UTC+8）刷新，领取后 30 天有效」）。
 * 于是上午 9 点那次查询看到的是**昨天**那条 `CLAIMED`，返回
 * `already-claimed`；上层若拿它当「今天已处理」的凭证记档，当天 10 点刷新后
 * 就再也不会去领 —— **每天静默漏掉 100 积分**。
 *
 * 修法不靠给每个渠道配一张「刷新时刻表」（那必然漂移），而是让**产出方自己
 * 回答**「我这条结果覆盖的是不是今天这一轮」：
 * - `coversToday` 缺省视为 `true` ⇒ 绝大多数渠道（每日签到语义）一行不用改；
 * - 观察到的是「刷新前的那一轮」时置 `false`。
 * 于是记账方（`auto-checkin.ts` 的 `shouldMarkToday`）根本不需要知道任何渠道的
 * 日界细节，只要数「有几条能证明今天已被处理」。
 *
 * ⚠️ 判据只能由**看得见该渠道刷新语义的那一层**给出（当前是 `qoder-credits.ts`），
 * 不要在汇总层用猜测补 —— 那正是本缺陷的成因。
 */
export interface ClaimOutcomeCommon {
    /**
     * 本次结果是否**覆盖「今天」这一轮**（缺省 `true`）。
     *
     * 置 `false` 表示「看到的是刷新前/上一轮的痕迹」，据此**不得**认定今天
     * 已处理（见上方缺陷说明）。
     */
    coversToday?: boolean;
}
export type ClaimOutcome = (ClaimOutcomeCommon & {
    kind: 'claimed';
    credit: number;
    streakDays: number;
    isStreakDay: boolean;
    delayedMessage?: string;
    /**
     * ★ `credit` 的单位（2026-10-03 新增）。
     *
     * ⚠ **缺省按「积分」处理** ⇒ 其余 provider 行为逐字不变。
     *   ZCode 下发 `unit_type: "token"`（实测），1 亿 token 若按积分显示
     *   就是错的 ⇒ 它显式传 `unit: token`。
     *   展示侧用 `formatUnits(credit, unit)` / `unitLabel(unit)`。
     */
    unit?: 'token' | 'credit';
}) | (ClaimOutcomeCommon & {
    kind: 'already-claimed';
    message: string;
}) | (ClaimOutcomeCommon & {
    kind: 'inactive';
    message: string;
    actionRequired?: boolean;
}) | (ClaimOutcomeCommon & {
    kind: 'failed';
    code: number;
    message: string;
});
/**
 * 积分资源包（`get-user-resource` 响应里 `Accounts[]` 的一项）。
 *
 * ## 一个账号为什么有多个包
 *
 * 每个包是**一份独立的积分授予**（套餐 + 若干运营活动赠包），各自有独立的
 * 计量周期与到期时间。实测某 CodeBuddy 账号有 5 个包：1 个体验版套餐 +
 * 4 份「国内运营裂变包」，其中 2 份已过期、1 份本周期已耗尽、2 份可用。
 * 所以界面上「5 个资源包」不等于 5 份额度，需要区分有效与失效。
 *
 * ## 两个 "Remain" 字段的口径差异（关键）
 *
 * 响应里同时有两个剩余值，**含义完全不同**：
 *
 * | 字段                     | 含义                     | 实测（体验版包） |
 * |--------------------------|--------------------------|------------------|
 * | `CapacityRemain`         | 该包的**终身**剩余       | 500              |
 * | `CycleCapacityRemain`    | 该包**本计费周期**剩余   | 0                |
 *
 * IDE 顶部的 "Credits Balance" 用的是**周期口径**（`CycleCapacityRemain`）：
 * 实测该账号终身口径求和为 655.67，而 IDE 显示 155.67 —— 差额 500 正是那个
 * 「终身还剩 500、但本周期已一分不剩」的体验版包。用错字段会让数字凭空多出
 * 一大截，且用户无从核对。
 */
export interface CreditPackage {
    /** 包名（如 'Bonus Pack' / 'CodeBuddy个人体验版'） */
    name: string;
    /** 额度单位（'credit' / 'credits'） */
    unit: string;
    /** 本计费周期剩余额度（IDE 展示口径，精确值含小数） */
    remaining: number;
    /** 本计费周期总额度（精确值） */
    total: number;
    /** 本计费周期已用额度（精确值） */
    used: number;
    /**
     * 该包是否仍然有效。
     *
     * 判定：服务端 `Status !== 3`（实测 3 = 已过期）且未过 `ExpiredTime`。
     * 失效包仍会出现在 `Accounts[]` 里（额度可能非 0），UI 需要能区分出来，
     * 否则用户会以为那些额度还能用。
     */
    active: boolean;
    /** 计量周期开始时间（服务端本地时间字符串，可能为空） */
    cycleStartTime: string;
    /** 计量周期结束时间（服务端本地时间字符串，可能为空） */
    cycleEndTime: string;
    /** 该包自身的失效时间（可能为空 = 无固定失效时间） */
    expiredTime: string;
    /**
     * 该包的**扣费截止时间**（毫秒时间戳；实测缺失或 0 = 服务端未下发）。
     *
     * ⚠️ **这才是「这批积分什么时候作废」的字段**，与 `expiredTime` 不是一回事：
     * 实测（2026-09-29，两站各取真实账号）有效包的 `ExpiredTime` **一律为空串**，
     * 它只在包**真正失效之后**由服务端回填（此时 `Status` 已变 3、余额已归零）；
     * 而 `DeductionEndTime` 在包还有效时就有值，且两站的实测分布差距极大：
     *
     * | 包 | `DeductionEndTime` 距今 | `CycleEndTime` 距今 |
     * |---|---|---|
     * | WorkBuddy「Bonus Pack」 | 9 天 | 9 天 |
     * | WorkBuddy「Free Plan Subscription」 | **3008 天** | 2 天 |
     * | CodeBuddy「拉新权益包 / 国内运营裂变包」 | 17～208 天 | 同左或更长 |
     * | CodeBuddy「个人体验版」 | 3008 天 | 已到期 |
     *
     * ⇒ 判「会不会近期作废」**只能用本字段**：套餐（订阅）包的周期虽短，
     * 扣费截止却在 8 年后，取 `CycleEndTime` 会把每月刷新的套餐误判成快作废。
     *
     * ⚠️ 可选字段：其余 provider 的余额解析器（loomy / qoder / trae / …）不产出它，
     * 依赖方必须把 `undefined` 当作「到期时间未知」而不是「已过期」。
     */
    deductionEndTime?: number;
    /**
     * 本包中**即将到期**的额度（可选；`undefined` = 上游未按包下发该口径）。
     *
     * ## 为什么需要它（`expiringTotal` 不够）
     *
     * CodeArts 的赠送积分包（签到/活动）**没有逐笔到期时刻**，但上游会在
     * 该分类 metric 上给一个 `package_credit_expiring_amount` 标量，说明
     * 「这 25000 分里有 2000 即将到期」。
     *
     * 只把这个数放在 `CreditBalance.expiringTotal` 上，分档就会把**整包 25000
     * 都算进永久桶**，然后旁边补一句「另有 2000 即将到期」—— 数字自相矛盾
     * （用户 2026-10-20 报障：「2000+500临期不应该是2500嘛」）。
     *
     * ⇒ 拆到包上：临期桶 += `expiringRemaining`，永久桶 += `remaining - expiringRemaining`。
     *
     * ## ⚠️ 与 `deductionEndTime` 的关系
     *
     * 两者**互斥**：
     * - 有 `deductionEndTime`（基础包，随套餐周期）⇒ 按真实时刻分档，不读本字段；
     * - 无 `deductionEndTime` 但有本字段（赠送包）⇒ 进临期桶，但**没有倒计时**
     *   （上游不给日期，绝不编一个）。
     *
     * ## ⚠️ 实测校验（2026-10-20，两个真实账号）
     *
     * `总额 expiring - 赠送 expiring = 0` ⇒ 总额那个标量**就是各分类之和**，
     * 故逐包读取不会重复计数；`CreditBalance.expiringTotal` 保留为总额口径
     * 用于交叉校验。
     */
    expiringRemaining?: number;
}
/**
 * 这个包是不是**独立池**（不参与主池合计、也不能当通用积分消耗）。

 * ## 为什么需要它（2026-10-21 合并审计发现）

 * AStudio（讯飞 AstronStudio）的服务端给**两个互不相通**的池：主池
 * （会员 / 购买 / 赠送）与「星火池」。上游自己写明了星火池「不参与主池合计」，

 * `src/astudio-credits.ts` 的 `buildAstudioBalance` 据此把它起名为
 * `星火积分（独立池，不参与主池合计）`。

 * ## ⚠️⚠️ 为什么判据必须在**宿主侧**（本文件）而不是各处分写

 * PR !134 只在**客户端**（`plugin-src/client/credit-expiry.js`）把独立池从

 * 三档里摘出，后端选号侧（`src/buddy-balance-rank.ts` 的

 * `splitBuddyCreditsByExpiry`）**完全不看 `pkg.name`** ⇒ **两侧口径分叉**：

 * 同一份数据，前端说「永久 0」，后端说「永久 25000」。

 * ⇒ 用户可见症状（**阻断级**）：AStudio 账号只剩星火池时，

 * 面板显示「另有 25000 专属（不计入）」而三档一行不渲染（看起来「没积分」），

 * 但后端把 25000 算成**临期** ⇒ `buddyBalanceTier` 判 `expiring` ⇒

 * **锁定永久积分时该账号仍被判「可用」** ⇒ 选号把请求发给一个只有专属池的

 * 账号 ⇒ 上游按主池计费 ⇒ 请求失败。

 * ## ⚠️ 为什么用「池名含『独立池』」而不是 provider 白名单

 * 池名是**运行时字符串**，而本文件（宿主侧）与客户端（`plugin-src/client/`）

 * **不共享模块图**（见 AGENTS.md）⇒ 两处各存一份判据必然漂移。

 * ⇒ 判据收敛到**本文件一份**，客户端那份由**单测锁死**（见

 * `tests/unit/credit-expiry.spec.ts` 的「独立池判据必须两侧同源」段）。

 * ⚠️ 这条判据依赖**池名** ⇒ 上游/本仓改池名会让它静默失效 ⇒ 那条同步锁

 * 就是为此存在（改池名会让它当场变红）。

 * @param pkg - 资源包（`name` 缺失/非字符串一律当「不是独立池」）。

 * @returns 是独立池则为 `true`。

 */
export declare function isExclusiveCreditPool(pkg: {
    name?: string;
} | null | undefined): boolean;
/**
 * 独立池在**池名**里的标记（宿主侧唯一持有点）。

 * ⚠️ 客户端那份在 `plugin-src/client/credit-expiry.js`（两侧不共享模块图），

 * 由单测锁死一致 —— 改这里必须同步改那边，否则守卫会红。

 */
export declare const EXCLUSIVE_POOL_NAME_MARK = "\u72EC\u7ACB\u6C60";
/** 账号的积分余额汇总。 */
export interface CreditBalance {
    /** 非可累加的来源配额如实展示；不把不同周期配额折算为 Token 总数。 */
    sourceQuota?: {
        label: string;
        text: string;
    };
    /** 已领取的待生效额度说明，不计入 total。 */
    pendingNote?: string;
    /**
     * 当前可用总余额（各**有效**包的本周期剩余之和）。
     *
     * 这个口径与 IDE 顶部的 "Credits Balance" 一致，用户可直接核对。
     *
     * 刻意不用服务端的 `TotalDosage`：它是**终身口径**且取整（实测同一响应里
     * TotalDosage=655 而 IDE 显示 155.67），既口径不对又有截断误差。
     */
    total: number;
    /** 各资源包明细（含已失效的，由 `active` 区分） */
    packages: CreditPackage[];
    /**
     * 已失效包里的剩余额度合计。
     *
     * 单独给出而不是并进 `total`：这些额度服务端仍会返回，但实际不可用于扣费。
     * UI 可以据此提示「另有 N 已失效」，既不误导也不丢信息。
     */
    expiredTotal: number;
    /**
     * `total` 中**即将到期**的额度（可选；`undefined` = 上游未下发该口径）。
     *
     * ## 为什么需要这个字段（而不是只靠 `packages[].deductionEndTime`）
     *
     * 绝大多数 provider 的到期信息是**逐包**的（CodeBuddy 的 `DeductionEndTime`、
     * AStudio 的 `*NextExpireTime`、MiniMax 的 `expire_at_ms`），故分档
     * （永久 / 长期 / 临期）只需读 `packages` 即可。
     *
     * **CodeArts 只能部分做到**（实测 2026-10-20，两个真实账号）：
     *
     * - **基础积分包**随套餐周期到期（响应顶层 `end_date`）⇒ 有确切时刻，
     *   已写进 `packages[].deductionEndTime`，可正常参与三档分档。
     * - **赠送积分包**（签到/活动，逐笔「发放日 +30 天」）与**按需包**没有
     *   逐包到期字段，只有 `package_credit_expiring_amount` 这个**聚合标量**
     *   告诉你「有 N 分即将到期」，但**不说**是哪几笔、**不说**哪天到期。
     *   逐包/逐笔明细端点在上游不存在（探了 85+ 个候选全 404，且解包
     *   `D:\CodeArts\resources\app.asar` 后全量枚举只有 27 条 `/v1/*` 路径，
     *   其中唯一的积分端点是 `/v1/ops/credit/usage`，返回的是**单次对话消耗**
     *   `{credits, cacheHitRatio}`，不是余额明细）。
     *
     * ⇒ 赠送/按需那部分**没有确切日期**，但上游给了「其中 N 即将到期」的
     * 标量，已拆到 `packages[].expiringRemaining`（进临期桶、无倒计时）。
     * 本字段保留为**总额口径**用于交叉校验（= 各包 `expiringRemaining` 之和）。
     * **不要**为了让它看起来和别家一样而臆造 `deductionEndTime`
     * —— 那会让「永久锁」按一个编造的日期做决策。
     *
     * ## ⚠️ 时间窗口未知
     *
     * 华为**没有**定义「即将到期」是未来多少天内（字段名里没有、官方计费文档
     * 也没有）。故 UI 文案必须原样说「即将到期」，**不得**写成「30 天内到期」
     * 之类 —— 那是编造。
     *
     * ## ⚠️ 与 `expiredTotal` 的方向相反
     *
     * `expiredTotal` 是「已经失效、不可用」；本字段是「仍然可用、但快失效」。
     * 两者互斥，不会同时有值。
     */
    expiringTotal?: number;
    /**
     * ⚠️⚠️ **本次读数是「降级结果」**（可选；`true` = 明细不可达、`packages` 是兜底包）。
     *
     * ## 为什么需要它（2026-10-21 二轮审计发现，P1）
     *
     * 某些渠道的余额有**两条数据源**：一个总额端点（必成）+ 一个明细端点（可能失败）。
     * 明细失败时实现会**静默回退**到「钱包包」——总额正确，但**逐包到期时刻全部丢失**
     * （回退包没有 `deductionEndTime`）。
     *
     * 而 `splitBuddyCreditsByExpiry` 对「没有到期时刻」的判据是**永久桶**（保守方向，
     * 对「真·永久积分」是对的）。⇒ 一次明细抖动会让「有临期积分的账号」被判成
     * **只剩永久积分** ⇒ 锁定状态下报「积分都已用尽」—— 那句会把用户推向
     * **不可撤回的解锁**（本仓库红线级误导）。
     *
     * 实测复现（AutoClaw，`autoclaw-credits.ts` 的 `catch {}` 回退）：
     * ```
     * 流水正常   → pkgs=[{每日签到, 5000, end:…}]  split={expiring:5000} tier=expiring  ✅
     * 流水 500   → pkgs=[{奖励积分, 5000, 无 end}]  split={permanent:5000} tier=none     ❌
     * ```
     * 同一账号、同一余额，只因明细端点抖动，结论从「可用」翻成「积分都已用尽」。
     *
     * ⇒ 本字段让**选号层**能区分「确实只剩永久积分」与「读不到明细」：
     * 降级时不应断言 `exhausted`，而应报 `unknown`（「无法确认」）。
     *
     * ⚠️ 语义边界：`true` **不表示失败** —— 总额仍然可信（可正常展示余额），
     *    只是**逐包到期信息不可用**。故它不能替代 `error`（后者表示「连总额都没拿到」）。
     */
    degraded?: boolean;
}
/**
 * 查询签到活动状态。
 * 使用 checkin-activity-status（权威源，非 checkin-status）。
 * 网络失败、响应非法或业务码非 0 时返回 null。
 */
export declare function fetchCheckinStatus(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch): Promise<CheckinStatus | null>;
/**
 * 执行每日签到领取。
 *
 * 判定顺序：先看业务码是否属于「已领取 / 无资格 / 活动结束」这些非致命类别，
 * 再看是否成功，最后归为 failed。判定以响应体 code 为准（重复领取是 HTTP 400，
 * 只看状态码会把幂等情况误报为失败）。
 */
export declare function claimDailyCheckin(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch): Promise<ClaimOutcome>;
/**
 * 查询账号的积分余额（剩余 credits）。
 *
 * 两个产品通用（见 {@link USER_RESOURCE_PATH} 的说明）。网络失败、响应非法或
 * 业务码非 0 时返回 null —— 与 {@link fetchCheckinStatus} 同款语义，让调用方
 * 能把「查不到」与「余额为 0」区分开，不要把网络故障显示成 0 积分。
 *
 * 注意 `data` 是**双层嵌套**：`data.Response.Data.Accounts[]`。这与签到端点的
 * 单层 `data` 结构不同，是本接口最容易解析错的地方。
 */
export declare function fetchCreditBalance(credential: BuddyCredential, product: BuddyProduct, fetcher?: typeof fetch): Promise<CreditBalance | null>;
/**
 * 把额度规整为两位小数。
 *
 * 用 `Math.round(v * 100) / 100` 而不是 `toFixed` 后 parse：后者对
 * 负数与极大值的行为不一致，且返回字符串会污染数值类型。这里只处理
 * 服务端下发的正数额度，乘法取整足够且结果仍是 number。
 *
 * 导出供其它 provider 复用（`qoder-credits.ts`）：多包相加的浮点尾数噪声
 * 是所有 provider 的共同问题，各写一份必然分叉。
 */
export declare function roundCredits(value: number): number;
/**
 * 把单位串归一到**展示口径**，返回 `'token'` 或 `'credit'`。
 *
 * ## 为什么需要它（真实缺陷，2026-10-03）
 *
 * 用户报障：WorkBuddy 国际版有**两个账号**，用量徽标却显示
 * `WorkBuddy (国际版) • 341.78积分 · 100积分`（两个数并排），账号再多就成一长串。
 *
 * 根因不在「多账号没法合计」，而在**服务端把同一个单位拼成两种写法**（实测逐包
 * 原值）：账号 `…01CC739A` 的包是 `CapacityUnit: 'credit'`（Bonus Pack 241.78）
 * 与 `'credits'`（Free Plan Subscription 100），账号 `…297957E1` 的是 `'credits'`。
 * 客户端的折叠态按**原始字符串**分组 ⇒ `credit` 与 `credits` 各成一组 ⇒ 两个
 * 账号落进两个分组，各自渲染一次「积分」标签。
 *
 * ⚠️ 口径：**分组键必须与展示名同源**。凡是展示层会显示成「积分」的单位串，就必须
 * 落进同一个分组。故分组前一律走本函数，`token` 与积分**不互相折算**（分两组）。
 *
 * ⚠️ 与客户端 `plugin-src/client/credits-format.js` 的 `normalizeUnit`
 * **必须逐字等价**：宿主算套餐读数、客户端算余额分组，两边不一致就会出现
 * 「套餐按一个单位、余额按另一个单位」的自相矛盾。一致性由
 * `tests/unit/usage-badge-client.spec.ts` 逐项比对锁死。
 *
 * ⚠️ **不要用它改写 `CreditPackage.unit`**：那里要保留服务端原值（设置页的逐包
 * 明细、`badgePlanFor` 的包名匹配都依赖它）。归一化只发生在「当分组键/展示名用」
 * 的那一步。
 */
export declare function normalizeCreditUnit(unit: string): 'token' | 'credit';
/** 领取额度的单位（与 {@link normalizeCreditUnit} 同域）。 */
export type ClaimUnit = 'token' | 'credit';
/**
 * 把任意值归一到 {@link ClaimUnit}（缺省 `credit`）。
 *
 * ⚠️ 存在的理由：`ClaimOutcome.unit` 是**可选**字段，且要面对 RPC 传来的
 * 未知值。直接用 `normalizeCreditUnit` 要求调用方先做 `typeof` 判断，
 * 每个消费点各写一遍必然漂移。
 */
export declare function claimUnitOf(unit: unknown): ClaimUnit;
/**
 * ★ 额度数值的**单位感知渲染**（宿主侧，2026-10-04）。
 *
 * ## 为什么宿主也需要格式化（真实缺陷，用户报障）
 *
 * 用户报障原文：
 * > 插件的这个一键签到，Zcode 获得的是 token 数量，但是这里显示成获得积分。
 * > 正文「…ZCode（智谱）+100000000（共 +100000100）」
 * > 应当显示为「…ZCode（智谱）+100Mtoken（共 +100Mtoken, +100积分）」
 *
 * 根因不在某一处文案，而在**汇总把不同量纲加成了一个标量**：
 * `computeClaimSummary` 把 1 亿 token 与 100 积分相加得 `totalCredit`，
 * 单位信息在这一层就丢了；下游无论怎么写都只能标一个「积分」。
 * 故修法是**让单位一路传到渲染层**（`totalByUnit`），而不是在文案里猜。
 *
 * ⚠️ 自动签到的逐渠道文字（`auto-checkin.ts` 的 `describeChannel` /
 * `describeRun`）是**宿主侧产出、落盘后原样展示**的字符串，没有机会交给
 * 客户端格式化 —— 故宿主必须自带一份。这与 `normalizeCreditUnit` 的处境
 * 同因（客户端 bundle 不能 import 宿主代码），一致性由
 * `tests/unit/claim-unit-parity.spec.ts` 逐项锁死。
 *
 * ⚠️ **积分不压缩、token 才压缩**：积分余额的现实量级是 `123456.78`
 * （IDE 顶部就是这个精度），压成 `123.46K` 会让用户无法与官方界面核对；
 * 而 token 动辄上亿，不压缩根本读不出量级。这与客户端
 * `credits-format.js` 的 `formatCredits` / `formatTokens` 口径逐字一致。
 */
/** 积分：整数不带小数位，有小数才保留两位（与客户端 `formatCredits` 一致）。 */
export declare function formatCreditAmount(value: number): string;
/** token：`>= 1e6` → `94.54M`；`>= 1e3` → `945.39K`；其余取整（与客户端 `formatTokens` 一致）。 */
export declare function formatTokenAmount(value: number): string;
/** 单位的展示名（与客户端 `unitLabel` 一致）。 */
export declare function claimUnitLabel(unit: ClaimUnit): string;
/**
 * 一个「数值 + 单位」的完整读数，如 `100.00MToken` / `800积分`。
 *
 * ⚠️ **数值与单位之间不留空格**：这是本仓库既有的展示惯例（用量徽标里
 * ZCode 的余额就渲染成 `94.54MToken`，见 `badge-model.js` 的 `readingOf`），
 * 也与用户在本次报障里给出的期望文案 `+100Mtoken` 同形。
 */
export declare function formatUnitAmount(value: number, unit: ClaimUnit): string;
/** 按单位分组的合计。**两个键恒存在**（无该单位的领取时为 0）。 */
export type ClaimTotalsByUnit = Record<ClaimUnit, number>;
/**
 * 把按单位分组的**领取所得**拼成一段文案：`+100.00MToken, +100积分`。
 *
 * ⚠️ **每个单位各带一个 `+`**（不是整段共用一个）：这是用户报障时给出的
 * 期望文案的形态 —— 原文「应当显示为 `…ZCode（智谱）+100Mtoken
 * （共 +100Mtoken, +100积分）`」。整段共用会渲染成 `+100Mtoken, 100积分`，
 * 第二个单位看起来像「不是本次领到的」。
 *
 * ⚠️ 函数名带 **Gains**：`+` 是「本次获得」的语义，**不要**拿它渲染余额
 * （余额没有 `+`）。这是把 `+` 放进本函数而不是留给调用方拼的理由 ——
 * 一旦调用方各拼各的，两处界面就会漂移（本仓库已有多次先例）。
 *
 * ⚠️ **顺序固定 token → credit**（不是字母序）：用户给的期望文案就是
 * token 在前。顺序固定也让渲染稳定，不因对象键序变化而抖动。
 *
 * ⚠️ 只列**非零**单位：给「本次没有 token 领取」的渠道渲染 `+0Token` 是噪音。
 * 全为零时返回 `null`，调用方据此**整段不渲染**（而不是渲染一个空括号）。
 */
export declare function formatClaimGains(totals: Partial<ClaimTotalsByUnit> | undefined): string | null;
//# sourceMappingURL=credits.d.ts.map