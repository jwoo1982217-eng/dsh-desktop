/**
 * 「渠道余额 → 最早失效时刻」的**唯一口径**。
 *
 * ## 为什么单独一个文件（而不是并进 `aggregate-core.ts` / `aggregate-adapter.ts`）
 *
 * | 候选位置 | 为什么不行 |
 * |---|---|
 * | `aggregate-adapter.ts` | `auto-adapter.ts` 的 `expiryOf` 要复用它 ⇒ 依赖方向变成 `auto-adapter → aggregate-adapter`（**层次颠倒**，聚合适配器是更上层的东西） |
 * | `aggregate-core.ts` | 该文件定位是**纯逻辑**（哨兵 / 排序 / 倍率解析，模块头明写、零 import），而本模块要发网络请求 ⇒ 把 IO 混进纯函数模块，且 `aggregate-core.spec.ts` 这个纯函数单测会**被迫加载网络模块** |
 * | ✅ 本文件 | 单一职责；两个适配器都依赖它，方向正确 |
 *
 * ## ⚠️ 六个 `*Expiry` 是**搬移**进来的，不是复制
 *
 * 它们原先私有在 `auto-adapter.ts` 里（`private async buddyExpiry` 等）。Task 7
 * 把 `expiryOf` 改成委托本模块的 {@link createExpiryProbe} 后，若原处再留一份，
 * 就成了**同一语义两套实现**——本仓库对此有明确的红线记录（AGENTS.md 首条判据：
 * `buddy-growth.ts` 因两处对同一字段给出相反判据而产生**静默失效**：不报错、
 * 不崩溃、单测能过，只是把「没做到」说成「做到了」）。
 * Task 3 已用同样手法处理过 `pickSoonestProvider` / `priceFactorFromName`。
 *
 * ⚠️ 计数是**六**不是四（2026-10-08 更正）：Task 7 搬来时是四个
 *（buddy / loomy / codeArts / zcode），2026-10-07 又补了 `lobsteraiExpiry` 与
 * `traeExpiry`（用户质疑后核实加入）—— 旧注释一直没跟着改。
 *
 * ## ⚠️ 依赖方向（2026-10-08 起 import `provider-runtime.ts`）
 *
 * 本模块**只**依赖底座，不依赖任何聚合侧模块（见上表：依赖聚合适配器就是
 * **层次颠倒**）。`provider-runtime.ts` 只 import `provider-registry.ts`（纯数据）
 * 与 `account-pool.ts`（**仅类型**），**不** import 本文件 ⇒ **无环**。
 * ⚠️ 别在这里 import `aggregate-adapter.ts` / `auto-adapter.ts`。
 *
 * @module src/aggregate-expiry.ts
 */
import type { AccountPool } from './account-pool.js';
import { type ExpiryProbe } from './aggregate-core.js';
import type { BuddyCredential } from './buddy.js';
import { CODEBUDDY } from './product.js';
import type { LoomyCredential } from './loomy.js';
import type { CodeArtsCredential } from './types.js';
import type { ZcodeCredential } from './zcode.js';
import type { CreditBalance } from './credits.js';
import type { LobsteraiProduct } from './lobsterai-product.js';
import type { LobsteraiCredential } from './lobsterai.js';
import type { TraeProduct } from './trae-product.js';
import type { TraeCredential } from './trae.js';
import { MODELSCOPE } from './modelscope-product.js';
import type { ModelscopeCredential } from './modelscope.js';
import { AUTOCLAW } from './autoclaw-product.js';
import type { AutoclawCredential } from './autoclaw.js';
import type { AccioCredential } from './accio.js';
import { ASTUDIO } from './astudio-product.js';
import type { AstudioCredential } from './astudio.js';
import type { OfficeAceCredential } from './officeace-auth.js';
import type { QoderProduct } from './qoder-product.js';
import type { QoderCredential } from './qoder.js';
import type { MinimaxProduct } from './minimax-product.js';
import type { MinimaxCredential } from './minimax.js';
import { type ProviderExpiryContext } from './provider-runtime.js';
/**
 * 真实临期探针：**每个渠道折算成一个「最早失效时刻」**。
 *
 * ## 逐渠道判据（口径与 `jet-hub-auto` 完全一致，故复用同一套端点）
 *
 * | provider | 判据 | 依据 |
 * |---|---|---|
 * | buddy / workbuddy / **lobsterai** / **trae** | 有效资源包 `deductionEndTime` 的最小值（**共享** `sharedPackageExpiry`）；**无 `remaining > 0` 的有效包 ⇒ `UNUSABLE`** | `credits.ts` / `lobsterai-credits.ts` / `trae-credits.ts` |
 * | loomy | `daily > 0` → 当日 24:00；否则 `permanent > 0 ? NEVER : UNUSABLE` | 命名池，无时间戳 |
 * | codearts | **`NEVER`（长期）** | ⚠️ **报文无任何时间字段**（实测三字段全空）⇒ 不臆造 |
 * | zcode | 各桶 `expiresAt`（秒）最小值；**有余额但无到期时间 → 当日**；余额为 0 → `UNUSABLE`；**企业版（`enterprise`）→ `NEVER`** | `zcode-upstream.ts` |
 * | 其余（qoder / qodercn / cline / raccoon / minimax / gemini / opencode） | **本插件未接入** → `UNUSABLE` | 见设计文档 §9.1 |
 *
 * ## ⚠️ 未接入的渠道必须返回 `UNUSABLE`，**不能**返回 `NEVER`
 *
 * `NEVER` 的语义是「可用、只是无临期额度」，它**参与排序且可当选**。若把一个
 * 尚未实现的渠道折算成 `NEVER`，它会以「永久积分」的身份参与轮换 —— 而我们对
 * 它的余额**一无所知**（可能早就用尽了），结果是请求被发到一个没额度的渠道。
 * ⇒ 未接入 = `UNUSABLE` = 剔除。**宁可少一个候选，不可把未知当可用。**
 *
 * ## 为什么只探「一个代表账号」
 *
 * 渠道**内部**的换号由各适配器每次请求现做（buddy/loomy 走余额选号器，其余走
 * `getAvailableAccount` + 429 换号）。本层只回答「这个渠道现在能不能用、它的
 * 临期额度大概什么时候作废」，不替它们选账号。
 *
 * ## ⚠️ 取代表账号时必须带**真实 modelId**
 *
 * `getAvailableAccount` 对空 `modelId` 会**跳过限流过滤**（`account-pool.ts`），
 * 于是取回的是「手动序第一个启用账号」——**哪怕它此刻正在限流**。后果是多账号
 * 池里临期额度被完全忽略。故这里先取一个真实模型 id 再取号。
 *
 * ⚠️ `AbortError` **不得**折算成 `UNUSABLE`：用户取消请求时看到「请先登录」
 * 是误导（真实缺陷，PR !69 审计实测）。
 */
/**
 * **已接入临期折算**的渠道 id。
 *
 * ## ⚠️ 为什么必须导出（审计轮次二实测证伪的缺陷）
 *
 * 聚合层的目录会**广告**出所有能推导出规范名的虚拟模型 —— 包括**候选全来自
 * 未接入渠道**的那些。但那些候选一律被折算成 `UNUSABLE`（正确，见上方注释），
 * 于是用户选中它拿到的是：
 *
 * ```
 * MISSING_CREDENTIAL | 「xxx」当前没有任何可用候选（渠道被关闭、模型被关、
 *                      或所有渠道都无可用账号）
 * ```
 *
 * ⇒ 把「**该渠道的临期折算尚未实现**」谎报成「**你没登录 / 渠道被关**」——
 * 正是本仓库反复修的那类误导性报错。实测（探针）：只接 `cline`（未接入）时
 * `listModels('aggregate')` 仍返回 `['auto','deepseek-v4-1-flash','muse-spark-1-3']`。
 *
 * ⇒ 聚合目录只播报「**至少有一个已接入候选**」的虚拟模型；`auto` 不受影响
 *（它的池跨全部渠道，任一已接入渠道有账号就能路由）。
 *
 * ## ⚠️⚠️ 为什么它必须是**编译期常量**，不能从 runtime 派生（2026-10-08 设计复审）
 *
 * 本清单回答的是「**这个渠道接入了临期折算吗**」—— 那是一个**编译期事实**
 *（本文件有没有为它写折算原语）。而 `ProviderRuntime.expiry` 回答的是另一个问题：
 * 「**运行时该调哪个原语**」。两者**不是同一件事**，故不能互为派生源。
 *
 * 具体后果（**实测**，不是推断）：本清单在源码里有 **4 个**消费点 ——
 * 3 处在 `aggregate-adapter.ts` 的过滤（探测过滤 / 候选过滤 / 虚拟模型过滤），
 * 1 处是本文件的「未接入」短路。而**既有测试**里有两个大批量的构造点：
 * **29 处**临期探针工厂调用、**86 处** `AggregateAdapter` 构造 —— 那些文件
 * **一次都不调 `apply()`**（`aggregate-expiry` / `aggregate-wiring` /
 * `zcode-expiry-exhausted` 三份的 `apply` 命中**都不是真实调用**：实测分别是
 * 3 / 0 / 0 处，有命中的那份全是注释里的字）。
 * ⚠️ **计数口径**（便于复核，2026-10-08 实测）：在 `tests/unit` 里 grep
 * 「工厂名 + 左括号」共 36 处，减去 `expiry-runtime-parity.spec.ts` 自己的 7 处
 * ⇒ **既有 29 处**；grep「`new` + `AggregateAdapter` + 左括号」共 86 处
 *（全在既有文件）。⚠️ 本仓库的注释刻意**不写出左括号**，否则注释自己会被
 * 下一次 grep 计进去（自指），数字就再也复核不出来。
 * 而 runtime 注册只发生在 `apply()` ⇒ 派生版本在这些场景下**恒为空数组**，于是：
 *
 * | 后果 | 严重度 |
 * |---|---|
 * | `refreshCatalog` 把所有虚拟模型过滤掉 ⇒ **聚合 provider 的模型列表整个变空** | 致命 |
 * | 上述 29 + 86 处构造点大面积变红 | 高 |
 *
 * ⚠️ **不要**把它说成「生产路径也会变空」—— 那是**没有证据**的推断，已实测证伪：
 * `src/index.ts` 里聚合适配器确实在 runtime 注册**之前**创建（`registerAggregateLlm`
 * 调用早于 `registerProviderRuntime` 那段循环），但 `catalog-prewarm` 的首次预热是
 * `queueMicrotask` 排的，而 `apply()` 是**同步**函数 ⇒ 微任务在 `apply()` **整体
 * 返回之后**才跑，那时注册（同步段内）早已完成。
 * 实测（`node -e` 复现同一时序）：`sync-A → registration → sync-B → microtask → prewarm`。
 * ⇒ 派生版本在**生产**启动窗口内其实是安全的；**决定性证据是上面那两组实测计数**
 * （29 处探针 + 86 处适配器构造，全都不调 `apply()`），不是「生产会挂」。
 *
 * ⇒ 保持常量。它与 runtime 的一致性由
 * `tests/unit/expiry-runtime-parity.spec.ts` 的「**清单 == runtime 里挂了
 * `expiry` 域的渠道集合**」锁死（真跑 `apply()`）—— 那条锁的是真实会发生的漂移
 *「有人加了 runtime 注册却忘了加清单」（或反之），**不是**同义反复。
 */
export declare const WIRED_EXPIRY_PROVIDERS: readonly string[];
/**
 * 临期折算结果的**缓存时长**（毫秒）。用户 2026-10-07 要求加缓存，TTL 由用户在
 * 60 / 90 / 120 中选定 —— **取 60**。
 *
 * ## 为什么是 60
 *
 * - 与既有的 {@link BUDDY_BALANCE_CACHE_TTL_MS}（余额选号器，`60_000`）**同值** ——
 *   两处节奏一致，不会出现「选号用 30 秒前的数据、排序用 90 秒前的」这种分叉；
 * - 临期判据的最小粒度是**天**（资源包到期以天计）⇒ 60 秒滞后在语义上无害；
 * - 最短 ⇒ 用户改完渠道侧配置后最坏等待最短。90/120 只省极少量请求
 *  （面板与排序都不是高频路径），却让「刚登录的账号不出现在排序里」的窗口更长。
 */
export declare const EXPIRY_CACHE_TTL_MS = 60000;
/**
 * **单渠道折算的总预算**（毫秒）。
 *
 * ## 为什么必须封顶
 *
 * 本函数内部 `for (const item of credentials)` **串行**折算，而单账号折算自带
 * 30 s 级的上游超时（各 `*Expiry` 自己的 `*_REQUEST_TIMEOUT_MS`）⇒ 单渠道最坏
 * 耗时 = **账号数 × 单账号超时**。账号池随用户增删账号线性增长，于是「发一条
 * 消息 / 打开面板」的等待被账号数线性放大。
 *
 * ## ⚠️ 本仓库的**具体取证**（上游 86e3591 把它删了，本仓库保留）
 *
 * 上游删掉下面这段的理由，是**他们那份仓库里 `buddy` / `workbuddy` 查无实据**
 * （`PROVIDER_REGISTRY` 只有 20 个 id、`src/` 下无 `buddy-*.ts`）。
 * **该理由在本仓库不成立**：这两家就在下面的 {@link WIRED_EXPIRY_PROVIDERS} 里，
 * 也都在 `provider-expiry.ts` 的 `createProviderExpiry()` 里（`buddyFamilyExpiry`）
 * ⇒ 走 `buddyExpiry` → `fetchCreditBalance`（`credits.ts` 的
 * `REQUEST_TIMEOUT_MS = 30_000`）。故这条**真实故障**证据在本仓库成立，按
 * 「如实登记真实故障证据」保留：
 *
 * - 用户报障「重启后配置一直加载不出来」；同机实测 `session/modelCatalog`
 *   冷启动 **290 000 / 222 000 / 54 000 ms**（中位 **222 秒**），而同一时刻
 *   `settings/describe` 只要 **68 ms** ⇒ 事件循环没被堵，是本函数在逐账号串行等上游；
 * - 该机账号池 **workbuddy 7 个号 + buddy 8 个号** ⇒ 最坏 `7×30 + 8×30 = 450 s`；
 * - 账号数在 2026-10-17 23:00 到 10-18 00:30 之间从 **17 涨到 31**
 *   ⇒ 用户感受到「昨天还能忍、今天撞墙」。
 *
 * ⚠️ 顺带订正上游 commit message 里一条**在本仓库为假**的断言：它说
 * `credits.ts` 的 `REQUEST_TIMEOUT_MS`「在 `createProviderExpiry()` 里没有消费者
 * （死路径）」—— 本仓库里 `fetchCreditBalance` **正是** buddy 系的消费者。
 *
 * ## ⚠️⚠️ 它封的是哪条路径（别读错 —— 这里已误判过两次）
 *
 * 本探针的消费者只有**两处**，且都**不在**目录加载路径上：
 *
 * | 消费者 | 何时跑 |
 * |---|---|
 * | `aggregate-adapter.ts` 的 `candidatesFor` | **发消息**（`prepareCall`） |
 * | `aggregate-adapter.ts` 的 `describeExpiryOrder` | 面板「按临期排序」（用户点按钮） |
 *
 * ⚠️ `buildModelCatalog` / `resolveModel` / `listModels` / `refreshCatalog`
 * **一律不调本探针**（前者走 `coldModelInfo` + 后台刷新，后两者只读各渠道目录）
 * ⇒ **本预算不会缩短模型选择器的冷启动耗时**。想改善那条路径要动的是
 * `AGGREGATE_BACKGROUND_REFRESH_TIMEOUT_MS` 与 `catalogForListModels`，不是这里。
 * 把因果链写成「修 `modelCatalog` 冷启动」是**错的**（2026-10-22 审计实测：
 * 那四个方法体里 `expiryProbe` 出现 0 次）。
 *
 * ## 为什么是 8 秒
 *
 * - `candidatesFor` 是**发消息**路径（用户按了发送正在等），超过 10 秒已可认为卡死；
 * - 正常情况下一个渠道折算远低于 8 秒（本仓库排障日志里 codearts / trae / zcode
 *   均在 1.2 秒内）—— 8 秒只截断「上游在超时边缘」的渠道；
 * - 被截断的渠道按**保守方向**处理，与本文件铁律
 *   「宁可少一个候选，不可把未知当可用」一致。
 *
 * ## ⚠️⚠️ 预算**按账号均分**，不是「先到先得」（2026-10-22 审计打穿后改）
 *
 * 初版是「首号吃满整个预算，耗尽就 `break`」。实测后果：某渠道的**第一个**账号
 * 稳定慢于 8 秒 ⇒ 后面所有账号**每一轮都轮不到** ⇒ 每轮都 `UNUSABLE` ⇒ 还被
 * `cacheAndReturn` 缓存 60 秒 ⇒ 该渠道在聚合轮换里**永久不可见**。
 * 那正是上一版注释自称要避免的故障，被自己的实现从另一个入口做了出来
 *（`listAvailableCredentials` 的顺序 = `readAccounts()` 固定顺序，无轮转 ⇒ 每轮
 * 都是同一个「首号」）。
 *
 * ⇒ 现在每个账号只拿「**剩余预算 ÷ 剩余账号数**」（见循环处的 `perAccountMs`）：
 * 总时长仍 ≤ 本预算，但**每个账号都有一次机会**。
 *
 * ⚠️ 截断**不是**把结果写成 `NEVER`：那会让一个我们其实没查清的渠道以
 *   「永久可用」身份参与排序。已成功折算的账号仍按**真实观测值**返回
 *   （如实登记：那是**部分观测**，不是全量）；一个都没成时才 `UNUSABLE`。
 */
export declare const EXPIRY_PROBE_BUDGET_MS = 8000;
/**
 * 单账号可用的**最低预算下限**（毫秒）。
 *
 * ## 为什么必须有下限（2026-10-22 审计打穿后补）
 *
 * 预算按「剩余预算 ÷ 剩余账号数」均分后，账号一多，每份就会小到不可用：
 * 8 秒 ÷ 31 个账号 = **258 ms**，而正常的折算实测在 350 ms ~ 1.2 s 之间 ⇒
 * **每个账号都会被自己的那份截断** ⇒ 整渠道 `UNUSABLE`，等于把「账号多」直接
 * 变成「渠道不可见」。那与 {@link EXPIRY_PROBE_BUDGET_MS} 要解决的问题同型。
 *
 * ⇒ 每份取 `max(下限, 均分)`：宁可让本渠道**略微超出**总预算，也不让任何一个
 * 账号因为「排得靠后」或「账号太多」而被跳过。超出量有界（≤ 账号数 × 下限），
 * 且只在「前几个账号各自吃满自己那份」的病态情形下才叠加。
 *
 * ⚠️ 取值理由：1.2 秒是实测里最慢的正常渠道（trae）的耗时量级 ⇒ 取 1.5 秒留余量。
 * 再小会让正常渠道被误截断；再大则「账号多」时总耗时增长过快。
 */
export declare const EXPIRY_PROBE_MIN_SLICE_MS = 1500;
/**
 * `createExpiryProbe` 的返回类型：临期探针 **+ 缓存失效入口**。
 *
 * ⚠️ 为什么是**交叉类型**而不是改 `ExpiryProbe` 本身：那个类型定义在
 * `aggregate-core.ts`（必须是**零 import** 的纯逻辑底座），而它只描述「给定渠道
 * 返回最早失效时刻」这一件事。缓存是**实现细节**，不该渗进底座类型。
 *
 * ⚠️ 为什么要暴露 `clear`：见 `createExpiryProbe` 返回处与 `src/index.ts`
 * 装配处的长注释 —— 缓存原先**没有任何失效通道**，导致刚登录的账号
 * 最长 60 秒对路由不可见（用户拿到误导性的「没有任何可用候选」）。
 */
export type ExpiryProbeWithCache = ExpiryProbe & {
    clear: () => void;
};
/** `createExpiryProbe` 的可选依赖（单测注入时钟用）。 */ export interface ExpiryProbeOptions {
    /** 当前时刻（毫秒）；默认 `Date.now`。 */
    now?: () => number;
    /** 缓存时长（毫秒）；默认 {@link EXPIRY_CACHE_TTL_MS}。 */
    ttlMs?: number;
    /**
     * 单渠道折算的**总预算**（毫秒）；默认 {@link EXPIRY_PROBE_BUDGET_MS}。
     *
     * `0` 表示**不封顶**（保留升级前行为，供需要精确结果的调用方与单测使用）。
     *
     * ## ⚠️⚠️ 非法值一律回落默认，绝不「静默劣化」（2026-10-22 审计打穿后修）
     *
     * 归一化见 {@link normalizeExpiryProbeBudget}。初版只判 `=== 0`，于是：
     *
     * | 传入 | 初版实际行为 |
     * |---|---|
     * | `Infinity`（「不封顶」最自然的直觉写法） | `setTimeout` 延迟溢出被 Node **钳成 1 ms** ⇒ 全部渠道瞬间 `UNUSABLE` |
     * | `NaN` / `1e10` / 字符串 `'0'` | 同上（`1e10` 与 `'0'` 也溢出） |
     * | `-1` | `deadline` 在过去 ⇒ **一个账号都不探** |
     *
     * ⇒ 只有**有限的非负数**才被采纳；其余（含 `Infinity`）一律回落默认值。
     * 想让预算「不限时」请传 `0`（那是本字段唯一登记的「不封顶」写法）。
     *
     * ⚠️ 这是**每渠道**预算，不是全局预算：`candidatesFor` 逐渠道 `await`，
     * 每个渠道独立计时 —— 一个渠道慢不会连坐其它渠道。
     */
    budgetMs?: number;
    /**
     * 该渠道的**全部目录模型 id**（可选的加强依赖，2026-10-12 加入）。
     *
     * ## 为什么需要它（zcode 的按模型额度）
     *
     * zcode 的余额是**按模型分桶**的（实测 8M = GLM-5.3 的 3M + GLM-5.3-Flash 的 5M），
     * 要把「某模型在这个账号上已尽」写成 `modelRateLimits` 标记，就必须知道
     * **该渠道的目录模型 id 有哪些、且大小写是什么**。
     *
     * ⚠️ **两侧大小写不同**（实测 `scripts/probe-zcode-model-id-casing.mjs`）：
     *
     * | 来源 | 形态 |
     * |---|---|
     * | 上游 `capabilities` | `model:glm-5.3`（**小写**） |
     * | DSH 目录 `modelId`（= 池过滤用的键） | `GLM-5.3`（**大写**） |
     *
     * 而池的过滤是 `a.modelRateLimits[modelId]` **精确匹配** ⇒ 拿小写去写
     * **永远不命中**，且没有任何报错（静默失效）。⇒ 必须传**目录那一套形态**的 id
     * （由 `zcode-entitlements.ts` 的 `exhaustedModelsOf` 保证：它直接回传进来
     * 的目录元素，而内部比对是大小写不敏感的）。
     *
     * ⚠️ **省略时的降级**：用 `firstModelIdOf` 那一个 id 当作全集（只覆盖第一个模型）。
     * 这让既有装配与几十处测试桩**零改动**即可工作 —— 见下方调用点。
     */
    catalogIdsOf?: (provider: string) => Promise<readonly string[]>;
    /**
     * 共享余额读数（**装配层注入**；省略 ⇒ 各实现方自己发请求，行为与升级前一致）。
     *
     * ⚠️ 返回 `undefined` 表示**本次没有共享读数可用**（未命中且取数失败）⇒
     *    实现方必须回落到自己发请求。**不得**用「抛错」表达「没有读数」：
     *    那会让折算把「缓存不可用」与「上游查询失败」混为一谈。
     * ⚠️ `credential` 由本工厂从**账号池条目**配对后回调（缓存按 `(provider, accountId)`
     *    去重，而取数原语需要凭据）。
     */
    balanceOf?: (provider: string, accountId: string, credential: unknown) => Promise<unknown>;
}
/**
 * 归一化 {@link ExpiryProbeOptions.budgetMs}（**纯函数，可直接单测**）。
 *
 * ## 为什么必须有它（2026-10-22 审计打穿）
 *
 * 初版只判 `budgetMs === 0`，其余值原样交给 `setTimeout`。而 `setTimeout` 的
 * 延迟是 **32 位有符号整数**，越界/`NaN` 会被 Node **钳成 1 ms**（并打一条
 * `TimeoutOverflowWarning` / `TimeoutNaNWarning` 到 stderr）。实测后果：
 *
 * | 传入 | 实测（3 账号全挂死） |
 * |---|---|
 * | `Infinity`（「不封顶」最自然的直觉写法） | 每个账号**瞬间** UNUSABLE（计时器 1 ms） |
 * | `NaN` / `1e10` / 字符串 `'0'` | 同上 |
 * | `-1` | `deadline` 在过去 ⇒ **0 次 fetch** |
 *
 * ⇒ 判据：**只有有限的非负数被采纳**；`0` 保留「不封顶」语义；其余一律回落
 * 默认值（`Infinity` 也回落 —— 想要不封顶请传 `0`，那是唯一登记的写法）。
 *
 * ⚠️ 上界 `2 ** 31 - 1` 是 `setTimeout` 自己的上限，超过它就会被钳成 1 ms ⇒
 *   必须在**这里**截断，而不是指望 `setTimeout` 帮忙。
 */
export declare function normalizeExpiryProbeBudget(raw: unknown): number;
/**
 * 算出「**当前这个账号**可以等多久」（**纯函数，可直接单测**）。
 *
 * ## 为什么把它抽出来（2026-10-22 变异验证的血泪）
 *
 * 这段算术原本内联在循环里，于是只能用**耗时**来判它有没有生效。实测：
 * 「去掉 `min(剩余预算, …)`」这个变异只让 31 个账号的耗时从 8.01 s 变成 9.05 s
 * —— 而**探测账号数两者完全相同**（都是 6 个）。⇒ 那条用例：
 * - 用 `toBeLessThan(预算 + 5s)` 时对变异**完全无牙**；
 * - 用 `toBeLessThan(预算 + 1.2s)` 时又会被 CI 抖动打成**时红时绿**。
 *
 * ⇒ 抽成纯函数后，判据变成**确定性的逐格算术**，与时钟无关。
 *
 * ## 口径：`min(剩余预算, max(下限, 均分))`
 *
 * | 项 | 作用 |
 * |---|---|
 * | `均分` = 剩余 ÷ 剩余账号数 | 让**每个账号都有机会**；快账号省下的预算自动滚给后面的 |
 * | `下限` = {@link EXPIRY_PROBE_MIN_SLICE_MS} | 账号多时均分会小到不可用（8 s ÷ 31 = 258 ms，而正常渠道实测 350 ms~1.2 s）⇒ 没它会把「账号多」直接变成「全被截断」 |
 * | **`min(剩余预算, …)`** | **总时长硬上界** —— 下限**不得**透支预算 |
 *
 * ⚠️ 第三项是必须的：我第一版漏了它，实测 31 个账号全挂跑了 **46.8 秒**（31 × 下限）。
 *
 * @param budgetMs - 已归一化的总预算；`0` 表示不封顶。
 * @param remainingMs - 本渠道**还剩多少预算**（可能为负 / `Infinity`）。
 * @param remainingAccounts - **含当前账号在内**还有几个没探。
 * @returns 当前账号可等待的毫秒数（`Infinity` = 不封顶）。
 */
export declare function expiryProbeSliceMs(budgetMs: number, remainingMs: number, remainingAccounts: number): number;
export declare function createExpiryProbe(pool: AccountPool, firstModelIdOf: (provider: string) => Promise<string | undefined>, options?: ExpiryProbeOptions): ExpiryProbeWithCache;
/** buddy 系：有效资源包 `deductionEndTime` 的最小值；无有效包 → NEVER。 */
export declare function buddyExpiry(product: typeof CODEBUDDY, credential: BuddyCredential, 
/**
 * 共享读数入口（2026-10-15，规格 §5.7 的「buddy 系四家吃同一份读数」）。
 *
 * ⚠️ 返回 `undefined` ⇒ **回落到自己发请求**（`fetchCreditBalance`）。
 *    折算的可用性**不得**依赖它 —— 否则「未接线」会变成「该渠道折算恒 UNUSABLE」
 *（静默少一个候选，本仓库复发过三次的形态）。
 */
cached?: () => Promise<CreditBalance | null | undefined>): Promise<number>;
/**
 * lobsterai：与 buddy **同形**（`CreditPackage.deductionEndTime` 由
 * `lobsterai-credits.ts` 从 ISO 8601 的 `expiresAt` 归一化而来）。
 *
 * ⚠️ 本渠道此前**不在** `WIRED_EXPIRY_PROVIDERS` 里，理由是
 * `auto-adapter.ts` 那句「其余 provider 没有跨账号的到期余额探测端点」——
 * **该理由对 lobsterai 不成立**（用户 2026-10-07 质疑后核实）。
 */
export declare function lobsteraiExpiry(credential: LobsteraiCredential, product: LobsteraiProduct, 
/** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
cached?: () => Promise<CreditBalance | null | undefined>): Promise<number>;
/**
 * trae：与 buddy **同形**（`CreditPackage.deductionEndTime` 由
 * `trae-credits.ts` 从条目级秒级 `expire_time` 换算而来）。
 *
 * ⚠️ 同 lobsterai：此前被那句（不成立的）理由排除在白名单外。
 */
export declare function traeExpiry(credential: TraeCredential, product: TraeProduct, 
/** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
cached?: () => Promise<CreditBalance | null | undefined>): Promise<number>;
/**
 * ModelScope（魔搭）：**本 fork 独有**（2026-10-17）。
 *
 * ## 它属哪一类
 *
 * 「**有余额但不下发到期时间**」那一类 —— 判据直接复用
 * {@link sharedPackageExpiry}（逐格同构，不另写一套）：
 *
 * - `balance.packages` 里存在 `active === true && remaining > 0` 的包
 *   ⇒ 返回 `NEVER`（**长期可用，排最后，不剔除**）；
 * - 一个都没有（`available_balance === 0`）⇒ 返回 `UNUSABLE`（**剔除**）。
 *
 * ⚠️ 魔搭的 `/openapi/v1/magicubes/balance` 报文里**没有任何时间字段**
 * （实测：`{"total_balance":277,"available_balance":277,"frozen_amount":0}`）
 * ⇒ 必然走「有余额但无到期时间」这条，落到 `NEVER`。
 *
 * ## ⚠️⚠️ 与其它家的**根本差异**：额度耗尽**不会被自动跳过**
 *
 * buddy 系能折算出临期时刻、从而在耗尽前把账号剔出轮换；魔搭**做不到** ——
 * 它既没有「配额何时重置」字段（每日发放是平台侧行为，实测报文字段里没有），
 * 也无法查询余额之外的东西（`/api/v1/quota/status` 经实测是**任务奖励**、
 * 不是额度，详见 `modelscope-credits.ts`）。
 *
 * ⇒ **魔粒烧光时，聚合仍会把它排进轮换候选**，用户选中后才失败一次
 * （报额度用尽）。这是**已知且刻意接受**的代价，由用户在 2026-10-17 明确选择
 * （选项 B）：宁可在极端情况下多失败一次，也要让魔粒充足时能进轮换。
 * ⚠️ **不许用「猜一个每日 UTC+8 零点」来消除这个代价** —— 那会凭空造出一个
 * 上游从未承诺的重置时刻（本仓库红线「绝不编造数字」）。
 *
 * ## ⚠️ 为什么**不**直接复用 `fetchTraeCreditBalance` 那套的 `fetchBalance`
 *
 * 本家走 `fetchBalanceDetailed`（三种失败的用户动作不同，见
 * `modelscope-credits.ts`）⇒ 这里必须吃 `balance: null` 的那一支，
 * **不是** `fetchBalance` 的 `null`。
 */
export declare function modelscopeExpiry(credential: ModelscopeCredential, product: typeof MODELSCOPE, 
/** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
cached?: () => Promise<CreditBalance | null | undefined>): Promise<number>;
/**
 * AutoClaw（智谱）：**本 fork 独有**（2026-10-17 审计 P0 修复）。
 *
 * ## 它属哪一类
 *
 * 与 {@link modelscopeExpiry} **同格**：「**有余额但不下发到期时间**」——
 * `/agent-assetmgr/api/v2/wallets` 的 `wallets[]` 只有 `balance` /
 * `balance_view` / `priority` / `display`，**没有任何时间字段**
 * （见 `autoclaw-credits.ts` 的 `AutoclawWalletItem`）。
 * ⇒ 判据直接复用 `sharedPackageExpiry`（逐格同构，不另写一套）：
 * 有 `active === true && remaining > 0` 的包 ⇒ `NEVER`；一个都没有 ⇒ `UNUSABLE`。
 *
 * ## ⚠️⚠️ 已知且刻意接受的代价
 *
 * 积分烧光时**不会被提前剔出轮换** —— 平台既不下发「配额何时重置」，
 * 也没有别的额度端点可查 ⇒ 耗尽后仍会被选中并失败一次（报额度用尽）。
 * 与 modelscope 的代价**同型**（用户在 2026-10-17 已就魔搭明确接受这个取舍）。
 * ⚠️ **不许用「猜一个每日 UTC+8 零点」消除它** —— 那是凭空造一个上游从未
 * 承诺的重置时刻（本仓库红线「绝不编造数字」）。
 *
 * ## 为什么必须走 `cachedBalance`
 *
 * 聚合每轮折算会对同一账号反复提问；没有共享读数就会白发大量重复请求
 * （与 buddy / trae / modelscope 同款理由）。
 */
export declare function autoclawExpiry(credential: AutoclawCredential, product: typeof AUTOCLAW, 
/** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
cached?: () => Promise<CreditBalance | null | undefined>): Promise<number>;
/**
 * **Qoder**（`qoder` 国际版 / `qodercn` 中国版，**共用**本原语，只换 product）：
 * 与 **buddy 系同形**（`CreditPackage` 都带 `deductionEndTime`）⇒ 判据直接复用
 * `sharedPackageExpiry`，**不另写解析逻辑**（两站共用同一个原语，避免同族分叉）。
 *
 * ## ⚠️⚠️ **本家与其它「已接入」渠道的本质不同：上游不给逐包到期时刻**
 *
 * 2026-10-20 取证（两个真实 qodercn 账号，`GET /sash/api/v2/me/usage`）：
 *
 * | 字段 | 实测 | 是否带日期 |
 * |---|---|---|
 * | `userQuota`（套餐额度） | `{total:0,used:0,remaining:0}` | 只有顶层 `expiresAt`，且恒为**永久哨兵** |
 * | `addOnQuota`（资源包） | `{total:2000,…remaining:2000,detailUrl:…}` | **无任何日期字段，只给聚合标量** |
 * | `dedicatedResourcePackages` | `undefined`（本机账号） | **唯一**带真实逐包 `expiresAt`（字符串）的字段 |
 *
 * 顶层 `qoderUsage.expiresAt = 253402214400000`（`9999-12-31T00:00:00Z`）是
 * Qoder 给 `userQuota` 下发的**永久哨兵**、**不是**到期时刻。权威旁证是官方
 * 客户端 asar 的 `buildUsageItemGroups()`：`addOnQuota` 那一档**只渲染
 * used/total/remaining、不给任何日期**；只有 `userQuota.expiresAt` 走
 * `renewson`（「将于 {{date}} 刷新」= **订阅刷新**），
 * `dedicatedResourcePackages` 才走 `expiresOn`（「有效期至 {{date}}」）。
 *
 * ⇒ `qoder-credits.ts` 的 `toPackage()` 用常量
 * `QODER_PERMANENT_EXPIRY_MS` 识别哨兵并**不写** `deductionEndTime`
 * （写进去会让客户端 `formatPackageExpiry` 渲染出
 * `9999-12-31（约 2900000 天后）` 这种荒谬文案）。
 *
 * ## 折算结果（如实，不是打折）
 *
 * | 情形 | 折算值 | 依据 |
 * |---|---|---|
 * | 有余额但**无**逐包到期（本次实测的账号形态） | `NEVER`（长期：排最后但不剔除） | `sharedPackageExpiry` 的「有余额但无到期时间」那一档 |
 * | 有余额且有 `dedicatedResourcePackages` 的真实到期 | 该时刻（取最早那包） | 同上（`Math.min`） |
 * | 一个 `remaining > 0` 的有效包都没有 | `UNUSABLE`（剔除） | 同上 |
 * | 查询失败（含国际版不可达）/ 未登录 | `UNUSABLE` | 同上（`null` ⇒ 不猜） |
 *
 * ⚠️ **已知限制（必须如实标注）**：无 `dedicatedResourcePackages` 时
 * **临期桶恒为 0** —— 三档分档只剩「永久（未知到期）」一档 + 上游聚合标量。
 * 这**不是**缺陷，是「上游不下发 ⇒ 我们不编造」的必然结果（本仓库红线）。
 * 逐包明细端点已穷举失败：`/sash/api/v2/me/*` → 404；
 * `qoder.cn/api/v1/me/quotas/{key}/histories` →
 * `/api/v1/me/usages/big_model_credits/histories` → qoder.cn 下 **401**
 * （需浏览器登录态 cookie，插件 OAuth token 拿不到）、在 openapi 下 **404**。
 *
 * ## 为什么必须走 `cachedBalance`
 *
 * 聚合每轮折算会对同一账号反复提问；没有共享读数就会白发大量重复请求
 * （与 buddy / trae / modelscope / autoclaw / astudio / minimax 同款理由）。
 *
 * ⚠️ **不加 XFF 需求**：与 minimax 国际站不同，Qoder 没有已知的地理分流，
 * ⇒ **刻意不加** `minimaxXff` 那类透传参数（凭空多一个参数只会让人以为有分流）。
 */
export declare function qoderExpiry(credential: QoderCredential, product: QoderProduct, 
/** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
cached?: () => Promise<CreditBalance | null | undefined>, 
/**
 * 该账号的出口代理 fetcher（2026-10-25 审计 A2-17）。
 *
 * ⚠️⚠️ **折算路径不接代理 ⇒ 墙外环境下该渠道从聚合轮换里静默消失**：
 * 国际版整站在墙外被 SNI 阻断，只能用 per-账号代理出去。本 PR 把代理接进了
 * 推理/搜索/选号/登录四条腿，**折算这条漏了** ⇒ 折算恒失败 ⇒ `UNUSABLE`
 * ⇒ 被 `rankCandidates` 剔除，**零报错、零日志**，而面板看起来正常。
 *
 * 省略 ⇒ 回落全局 `fetch`（= 修复前的行为，供不需要代理的调用方使用）。
 */
fetcher?: typeof fetch): Promise<number>;
/**
 * astudio（讯飞 AstronStudio）：三池各带到期时间 ⇒ **可精确折算**，无已知代价。
 *
 * ## 与 autoclaw 的差别（为何这里能算出真实时刻）
 *
 * autoclaw 的钱包报文里**没有任何时间字段**（只有流水批次才带 `deductionEndTime`），
 * 故它只能「有余额即 `NEVER`」。astudio 的 `/points/balance` 实测直接下发
 * `{member,buy,activity}NextExpireTime`（形如 `"2026-11-20T01:50:14"`，
 * **不带时区的本地时间串**），已由 `astudio-credits.ts` 的
 * `astudioLocalTimeMs` 用 `Date.parse(raw.replace(' ', 'T'))` 归一化到
 * `packages[].deductionEndTime`（毫秒）⇒ 直接复用
 * `sharedPackageExpiry`（取**最早**到期的那一包 = `Math.min`）。
 *
 * ## 为什么走 `sharedPackageExpiry` 而不是自己遍历
 *
 * 它把三件容易写错的事收敛在一处：①异常按 `isAbortError` 分流（用户取消要
 * 继续抛，不能吞成 `UNUSABLE`）；②`null` ⇒ `UNUSABLE`；③**所有**候选都折算
 * 失败时（`anyConverted === false`）返回 `UNUSABLE` 而不是 `NEVER`
 * —— `NEVER` 意味着「永不过期」，会被聚合排在最后但仍然**可选中**，
 * 那是把「查不到」谎报成「长期有效」（本仓库红线）。
 *
 * ## 为什么必须走 `cachedBalance`
 *
 * 聚合每轮折算会对同一账号反复提问；没有共享读数就会白发大量重复请求
 * （与 buddy / trae / modelscope / autoclaw 同款理由）。
 */
export declare function astudioExpiry(credential: AstudioCredential, product: typeof ASTUDIO, 
/** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
cached?: () => Promise<CreditBalance | null | undefined>): Promise<number>;
/**
 * minimax（MiniMax Code，中国版 / 国际版共用本原语，只换 product）：
 * **每条积分明细各带自己的到期时刻** ⇒ 可精确折算，无已知代价。
 *
 * ## 与 astudio 的差别（字段形态，判据一致）
 *
 * | 渠道 | 到期字段 | 形态 | 是否需要归一化 |
 * |---|---|---|---|
 * | astudio | `{member,buy,activity}NextExpireTime` | **不带时区的本地时间串** | 需要（`Date.parse(raw.replace(' ','T'))`） |
 * | minimax | `details[].expire_at_ms` | **毫秒时间戳** | 不需要（直接是 epoch ms） |
 *
 * 两者最终都落到 `packages[].deductionEndTime`（毫秒）⇒ 折算口径逐格一致，
 * 都复用同一条 `sharedPackageExpiry`（取最早到期的那一包）。
 *
 * ## 为什么能算（此前判「不可折算」的依据已被实测推翻）
 *
 * 2026-10-20 用户报障「MiniMax Code 积分也有到期时间，也应当有相同功能」，
 * 并附 AStudio 面板截图作参照。实测（真实凭据，两站各取账号）确认：
 * `GET /minimax-cloud/api/v1/credit/details` 的**每条** `details[]` 都带
 * `expire_at_ms`（中国版 20/20 条、15/15 条全部有值），
 * 且到期时刻 = 发放日 + 30 天的零点（如 2026-10-20 发放 → 2026-11-19 到期）。
 *
 * ⚠️ 在此之前 `fetchMinimaxCreditBalance` 把 `packages` **硬编码成 `[]`**，
 * 聚合侧据此把本家归为「查不到到期时间」一类。那个结论**不是**
 * 「上游不下发」，而是「我们没解析」—— 这两件事在注释里被混同过，是本次
 * 报障的根因。
 *
 * ## 为什么必须走 `cachedBalance`
 *
 * 聚合每轮折算会对同一账号反复提问；没有共享读数就会白发大量重复请求
 * （与 buddy / trae / modelscope / autoclaw / astudio 同款理由）。
 */
export declare function minimaxExpiry(credential: MinimaxCredential, product: MinimaxProduct, 
/** 共享读数入口（见 {@link buddyExpiry} 的同名参数）。 */
cached?: () => Promise<CreditBalance | null | undefined>, 
/**
 * 国际站的 `X-Forwarded-For` 绕行头（见 `src/minimax.ts` 的 `withMinimaxXff`）。
 *
 * ⚠️ 必须透传：国际站按出口 IP 做地理分流，`agent.minimax.io` 会 307 到
 * 中国站，而**跟随后中国站不认国际站 token**（`401 invalid access token`，
 * 与「凭据真失效」逐字同形，issue IKMEVG）。不带 xff ⇒ 国际站账号的
 * 到期折算恒失败 ⇒ 该渠道在聚合轮换里被静默剔除。
 */
xff?: string, 
/**
 * 该账号的出口 fetcher（**仅国际站**需要，PR !145 审计 P0 修法）。
 *
 * ## ⚠️⚠️ 为什么折算路径也必须换出口
 *
 * 本函数是**聚合轮换候选可见性的闸门**：折算拿不到读数 ⇒ `sharedPackageExpiry`
 * 返回 `UNUSABLE` ⇒ `rankCandidates` 把该候选剔除。而
 * `agent.minimax.io` 按出口 IP 国别分流（大陆直连恒 307 → 中国站 → 401），
 * ⇒ 用户配好代理、对话能用了，**该渠道仍从轮换里静默消失**，零报错。
 *
 * PR !145 的注释点了这个症状，但只把 fetcher 接进了选号器与适配器 ——
 * 本函数当时仍是**裸 `fetch` 字面量**。
 *
 * ⚠️ 省略 ⇒ 全局 `fetch`，与修复前**逐字节等价**（中国版永远省略）。
 */
fetcher?: typeof fetch): Promise<number>;
/** loomy：有今日赠送 → 当日 24:00；只剩永久 → NEVER。 */
export declare function loomyExpiry(credential: LoomyCredential): Promise<number>;
/**
 * accio：与 **loomy 同形**（命名池、无逐包时间戳），但有一条更强的信息。
 *
 * ## 判据（2026-10-13 合并审计发现「聚合里看不到 accio」后补）
 *
 * | 情形 | 折算值 | 依据 |
 * |---|---|---|
 * | `每日积分 > 0` | **当日 24:00**（`nextUtc8DayStartMs()`） | 每日额度 24h 作废且**不累积** |
 * | 只剩 `每月积分` / `推荐积分` | `NEVER`（长期，排最后但不剔除） | 上游**没有**下发它们的到期时间 |
 * | 三类桶全为 0 | `UNUSABLE`（剔除） | 没有可烧的额度 |
 * | 查询失败 / 未登录 | `UNUSABLE` | 读不到就不猜 |
 *
 * ## ⚠️ 为什么用 `nextUtc8DayStartMs()` 而不是 `quota.refreshCountdownSeconds`
 *
 * `accio-credits.ts` 的 `accioQuotaResetIso` 能用倒计时算出**精确**的重置时刻，
 * 但那条路径的注释明确写着「`refreshCountdownSeconds` 只说**额度何时刷新**，
 * 与『这批积分何时作废』在 Accio 上**未被实测为同一时刻**」——
 * 故**刻意不写 `deductionEndTime`**（写进去就是编造）。
 *
 * ⇒ 本函数**尊重那个结论**：只在**有每日额度**时给一个「当日结束」的**保守上界**
 *（与 loomy 的 `daily > 0 → 当日 24:00` 逐字同判据），**不**把倒计时当到期时间用。
 * 语义上这是「临期优先」排序要的信息（今天就作废的排前面），而不是精确的作废时刻。
 *
 * ⚠️ **两家同形 ⇒ 判据必须逐格同构**（本仓库红线）：若将来 loomy 那一格改了
 *（例如上游开始下发真实到期时间），**这里要一起改**。
 */
export declare function accioExpiry(credential: AccioCredential): Promise<number>;
/**
 * officeace：与 **buddy 系同形**（订阅的每个积分桶都带 `expiresAt` ⇒ 归一化到
 * `deductionEndTime`），故折算口径与 `sharedPackageExpiry` **逐格一致**。
 *
 * ## 为什么单独一条原语（而不是直接复用 `sharedPackageExpiry`）
 *
 * 那个共享实现吃的是 `fetchBalance: () => Promise<CreditBalance | null>`，而
 * officeace 的余额入口是 {@link fetchSubscriptionSummary}：签名是
 * `(staleHours, ref, credential, credentials)`，且返回的是
 * `OfficeAceSubscriptionSummary`（不是 `CreditBalance`）—— 形状套不进那个泛型。
 * 这与 `qoder` / `opencode` 被排除在共享骨架外的理由同源（「形态不匹配就如实
 * 排除，不为凑齐 N 家而丢语义」）。
 *
 * ⚠️ **但判据必须与 `sharedPackageExpiry` 逐格同构**（本仓库红线）：
 *
 * | 情形 | 折算值 | 依据 |
 * |---|---|---|
 * | 有 `remaining > 0` 的有效桶，且**至少一个**给了到期时间 | 那些到期时间的**最小值** | 与 buddy 系同口径 |
 * | 有 `remaining > 0` 的有效桶，但**都没给**到期时间 | `NEVER`（长期，排最后但不剔除） | 服务端没下发 ⇒ 不臆造 |
 * | 一个 `remaining > 0` 的有效桶都没有 | `UNUSABLE`（剔除） | 没有可烧的额度 |
 * | 查询失败 / 未登录 / 只拿到缓存 | `UNUSABLE` | 读不到就不猜 |
 *
 * ## ⚠️ 为什么要带 `ref`（2026-10-13）
 *
 * `fetchSubscriptionSummary` 传了 `ref` 才走**云侧 V11 直读**；不传会回落到
 * 果办客户端的**全局单一 cookie**（只反映「当前登录在果办里的那一个账号」）
 * ⇒ 多账号下所有账号都折算成同一个余额（实测两个账号都显示 6500）。
 * 聚合的候选排序是**每账号**粒度，串号会让选号直接选错人。
 *
 * ⚠️ 未传 `ref` 时（老调用点）仍可工作，但只对单账号正确 —— 见
 * `ProviderExpiryContext` 是否携带 ref。
 */
export declare function officeaceExpiry(credential: OfficeAceCredential, ref?: string): Promise<number>;
/**
 * codearts：**积分账户的到期时间不可知 ⇒ 一律 `NEVER`（长期）**。
 *
 * ## ⚠️⚠️ 为什么不再算「当日 24:00」（真实缺陷，用户报障 2026-10-07）
 *
 * 用户看到聚合面板把 codearts 列为候选，问「codearts 中也没显示积分临期」。
 *
 * **实测探针**（本机两个真实账号，只读 GET `statistics/plugin`）：
 *
 * | 账号 | 类型 | `credit` |
 * |---|---|---|
 * | `A3E53911` | `isTokenPackage: true`（Token 计费） | `undefined`（无积分口径） |
 * | `82AD9D6E` | `isCreditPackage: true` | `22088.16`（**赠送**积分包） |
 *
 * 且 `packages[].cycleStartTime` / `cycleEndTime` / `expiredTime` **三个字段实测全空**
 * —— 与 `codearts-credits.ts` 的既有注释一致：「`statistics/plugin` **不下发**
 * 资源包的有效性/周期字段……如实置为有效、周期留空，**而不是臆造一个到期时间**」。
 *
 * ⇒ 旧实现（继承自 PR !69 的 `auto-adapter.ts` 折算表）写的是
 * 「有积分 ⇒ `nextUtc8DayStartMs()`（今日 24:00 作废）」—— 那**正是臆造**：
 * 接口没给过期时间，官方文档（README 引用）说的是签到积分「**自发放起 30 天内有效**」，
 * 两者都不是「今天 24:00」。
 *
 * **后果**：codearts 的失效时刻被算成「今天」⇒ 在「临期优先」排序里**永远排最前**，
 * 抢走了本该先用掉的**真正临期**额度（buddy 的资源包 / loomy 的当日赠送）。
 *
 * ⇒ 改为 `NEVER`（长期积分：排最后，但**不剔除** —— 没有临期额度时仍要用它）。
 * 与本仓库既有原则一致：**读不到就不猜**（`zcodeExpiry` 对「查不到」返回
 * `UNUSABLE` 而非 `NEVER`，也是同一条原则）。
 *
 * ⚠️ 两种「无到期信息」的情形在本函数里**合并处理**（都返回 `NEVER`）：
 * 有积分（到期未知）与无积分（Token 计费账户 / 余额为 0）。两者在排序上同为
 * 「不临期」，且**都不该被剔除** —— 账号本身是可用的。
 * 这与 `buddyExpiry` 的「无有效包 → NEVER」是同一口径。
 *
 * ⚠️ 若将来接口开始下发周期字段，应改为读真实值（`packages[].expiredTime` 等），
 * **不要**恢复成某个固定估算。
 *
 * ## ⚠️⚠️ 也**不要**因为「余额为 0」就改成 `UNUSABLE`（PR #81 审计实测，2026-10-07）
 *
 * 同一次用户报障里有人提议：把「余额 0」也算成当前不可用
 * （`credit.total > 0 ? 当日 : UNUSABLE`），理由是「额度已尽却仍被 auto 选中」。
 * **对本渠道该推理不成立**，实测三格反例。
 *
 * ⚠️ 下表第 2 列是**那个被拒的提议**会产生的后果（不是本函数现状 —— 本函数恒返回
 * `NEVER`，没有「当日」分支；「当日」是更早的旧实现，见上文的实测三格）：
 *
 * | 账户形态 | `credit` | 被拒提议的后果 | 本函数（现状） |
 * |---|---|---|---|
 * | 积分账户有余额 | `{ total: 22088.16 }` | 当日 24:00 ⇒ **抢走真正临期的额度** | `NEVER` |
 * | 积分账户余额 0 | `{ total: 0 }` | `UNUSABLE` | `NEVER`（账号仍可用） |
 * | **Token 计费账户** | **`undefined`** | `?? 0` ⇒ `UNUSABLE` ⇒ **可用账号被永久剔除** | `NEVER` |
 *
 * ⚠️ 第三格是**实打实的回归**：`isTokenPackage` 账户**没有积分口径**
 * （`codearts-credits.ts` 的 `CodeArtsAccountInfo.credit` 注释明写「`undefined`
 * 表示这个账户没有积分口径」，与 `{ total: 0 }` 严格区分），而这类账号**能正常
 * 推理**；且 codearts 有 benefit（免费额度）模型走 `maas_type: benefit`
 * （`isCodeArtsBenefitModelKnown` 按远端集合判定）——**积分余额 0 ≠ codearts 不可用**。
 *
 * ⚠️ 与 `loomyExpiry` 的 `permanent > 0 ? NEVER : UNUSABLE` **不是**同一口径：
 * 那里的 `permanent` 是 loomy **自己的永久积分余额**（0 就是真的没有额度）；
 * 这里的 `credit.total` 在 Token 账户下根本**不存在**，把它当 0 是**臆造**。
 * 「读不到就不猜」是本函数的立身之本，别用一个 `?? 0` 把它推翻。
 *
 * 真正该守的边界是**探测失败**（`!result.ok` ⇒ `UNUSABLE`，已有用例守住），
 * 而不是「探测成功但余额为 0」。
 */
export declare function codeArtsExpiry(credential: CodeArtsCredential): Promise<number>;
/**
 * ⚠️⚠️ **本函数读不到 benefit（免费额度）口径** —— 但缺口**不在本函数**（已修，2026-10-07）。
 *
 * ## 缺口是什么
 *
 * codearts 有**两套完全不同的额度口径**，而上面只读了其中一套：
 *
 * | 口径 | 来源 | `codeArtsExpiry` 读得到吗 |
 * |---|---|---|
 * | 签到积分（长期） | `statistics/plugin` 的 `credit.total` | ✓ 只有它 |
 * | **benefit 免费额度** | `InferHub` 报文（每日 1000 万 tokens，**按自然日**结算） | ✗ **读不到** |
 *
 * ## ⚠️ 但它**不需要**在本函数里补（这是本注释存在的唯一理由）
 *
 * benefit 耗尽**已经被记账**：`llm-adapter.ts` 命中 `InferHub.4291.200` 时调
 * `accountPool.updateModelRateLimit(currentAccountId, options.model, 次日 00:00)`，
 * 而账号池按 `entry.modelRateLimits[modelId]` 过滤候选
 *（`getAvailableAccount` / `listAvailableCredentials`）。
 *
 * ⇒ **正确的判据在选型层，不在折算层**：选型时必须按**候选自己将要派发的
 * `realId`** 去问账号池「这个模型上还有可用账号吗」。
 * `AggregateAdapter.filterByModelAvailability` 就是这一层（已实现）。
 *
 * ⚠️ **为什么必须单独做这一步**：折算取号用的模型键是**渠道目录第一个模型**
 *（`src/index.ts` 的 `firstModelIdOf`：`models[0]?.id`），而聚合层派发的是
 * **候选自己的 `realId`** —— 两者常常不是同一个模型 ⇒ 那个按 modelId 的过滤
 * 对聚合路径**整体失效**（实测探针确认）。auto 路径不存在这个问题：它的
 * `firstModelOf` 返回值就是实际派发的模型。
 *
 * ## ⚠️ 不要因此照 PR #81 的 `credit.total > 0 ? 当日 : UNUSABLE` 去改
 *
 * 那个修法**方向错**（见上方长注释：会剔除 Token 计费账号与「余额 0 但可用」的账号）。
 * 本函数的 `NEVER` 是「按签到积分口径查到的信息说它可用」，与 benefit 无关 ——
 * 两件事在**不同的层**解决，别把它们混在一处。
 *
 * ⚠️ 保留本注释的原因：读到这里的人会问「benefit 读不到怎么办」，答案在
 * `filterByModelAvailability`。别在这里再补一份折算（那会变成同一语义两套判据）。
 */
/**
 * zcode：各桶 `expiresAt`（秒）最小值；有余额但上游未给到期时间 → 当日 24:00。
 *
 * ## ⚠️⚠️ 余额为 0 ⇒ `UNUSABLE`（真实缺陷，用户报障 2026-10-07）
 *
 * **用户报障原文**：auto 选中了额度已尽的 zcode，请求直接失败：
 * `zcode: 账号在模型 "GLM-5.3" 上的额度已用尽或没有可用权益。QUOTA_EXCEEDED`
 *
 * 而 auto 的价值主张恰恰是「挑有额度、且快作废的那个」—— 折算错了就挑中一个
 * **根本不能用**的渠道，比不做 auto 更糟（用户看到的是「auto 坏了」，且每次
 * 重试都撞同一个渠道）。
 *
 * 旧实现最后一行是 `if (balance.remaining > 0 || claimablePlans.length > 0)
 * return nextUtc8DayStartMs()`，**`return NEVER`** 收尾。两个分支都会让一个
 * 余额为 0 的 zcode 被选中：
 *
 * | 形态 | 旧折算 | 后果 |
 * |---|---|---|
 * | 无桶 + 有可领活动（`claimablePlans`） | 当日 24:00 | **排最前**，优先选中 |
 * | 无桶 / 桶余额为 0，无可领 | `NEVER` | 排最后，但**不被剔除**（池里只剩它时必被选中） |
 *
 * ## 判据：**「可领」不等于「已拥有」**
 *
 * `claimablePlans`（`billing/preview` 的可领活动）表示**还能领**，不表示**已经有**。
 * zcode 的每日赠送额度**要先 claim 才进 `balances` 桶**（见 `zcode-upstream.ts`
 * 的「签到为什么要补激活上报」），没领就是**当前不可用** —— 这正是 zcode
 * 「需手动签到」的形态。用户去面板签到后余额进桶，下一轮探测自然重新纳入候选。
 *
 * ⚠️ **但有余额、只是上游没给 `expires_at` 时仍按当日折算**（保留旧行为）：
 * `zcode-upstream.ts` 的 `expiresAt: num(record.expires_at)` 在字段缺失时就是
 * `undefined`，而 `remaining_units` 齐全。此时账号**确实有额度**，把它判成
 * `UNUSABLE` 会丢掉一个可用渠道 —— 与本仓库「读不到就不猜，但也不误剔除」
 * 的既有口径一致（对照 `codeArtsExpiry` 对「查不到」与「查到但无到期概念」
 * 的严格区分）。故判据是 **`balance.remaining > 0`**（有余额）而不是
 * 「有任何一个桶带有效到期时间」。
 */
export declare function zcodeExpiry(credential: ZcodeCredential, context?: ProviderExpiryContext): Promise<number>;
//# sourceMappingURL=aggregate-expiry.d.ts.map