/**
 * 各 provider 的**临期折算能力实现表** —— `ProviderRuntime.expiry` 域的唯一真源。
 *
 * ## 它解决什么
 *
 * 重构前，`src/aggregate-expiry.ts` 的 `credentialExpiry(provider, credential)`
 * 是一个 7-case `switch`，而**每个分支体都只是「调一个原语」**
 *（`buddyExpiry` / `loomyExpiry` / `codeArtsExpiry` / `zcodeExpiry` /
 * `lobsteraiExpiry` / `traeExpiry`）—— 与 `account.refresh` 的 13 个同构 case
 * 完全同型。那 7 个分支体里**没有一行协议逻辑**，只有「选哪个原语」。
 *
 * ## ⚠️ 为什么单独一个文件（而不是把表内联在 `index.ts`）
 *
 * 内联在 `index.ts` 里时，**单测无法复用**那张表：`createExpiryProbe` /
 * `AggregateAdapter` 有几十处用例直接构造（**不调 `apply()`**），它们要验证
 * 折算**值**（TTL 缓存、取全部账号、`clear()` 等）就必须让 runtime 里有真实实现。
 * 若那些用例各写一份自己的表，就出现**同一语义两套判据** —— 本仓库首条红线
 *（`buddy-growth.ts` 因两处对同一字段给出相反判据而静默失效）。
 * ⇒ 表放在这里，`src/index.ts` 与单测**共用同一份**。
 *
 * ⚠️ 与 `createProviderCredits` / `createProviderOnboarding` 同款理由
 *（那两张表也是「工厂在 src、生产与单测共用」）。
 *
 * ## ⚠️ 边界：本表只做「选哪个原语」，**不**抽象原语本身
 *
 * 各家 `*Expiry` 函数（判据不同、量纲不同）原样保留在 `aggregate-expiry.ts`，
 * 本表只是把它们挂到一张可查的表上（设计文档 §3.5.3 / §3.6）。
 * `buddy` 与 `workbuddy` **共用** `buddyExpiry`、只换 product 配置 ——
 * 与 `BuddyProduct` 驱动其余差异同款，避免同族分叉。
 *
 * ## ⚠️ 只覆盖**已接入临期折算**的渠道（刻意不在此写数字：权威是
 * `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`，抄一份必然漂移）
 *
 * 未接入的渠道（`qoder` / `qodercn` / `cline` / `raccoon` / `minimax` /
 * `gemini` / `opencode`）**刻意缺席**：它们的余额响应没有跨账号的到期口径
 *（见 `aggregate-expiry.ts` 的逐渠道判据表）。缺席的**运行时后果**是
 * `credentialExpiry` 返回 `UNUSABLE`（该候选本轮被剔除）。
 *
 * ## ⚠️⚠️ **但「哪些虚拟模型可以播报」不由本表派生**（2026-10-08 设计复审更正）
 *
 * 那由 `aggregate-expiry.ts` 的**编译期常量** `WIRED_EXPIRY_PROVIDERS` 决定。
 * 两者回答的是**两个不同的问题**：本表答「**运行时**该调哪个原语」（要到
 * `apply()` 注册时才填充），那个常量答「这个渠道**接入了**折算吗」（编译期事实：
 * 源码里有没有为它写折算原语）—— 不是同一件事，故不能互为派生源。
 *
 * ⇒ **别把那个常量改成本表的派生值**（它看起来像一份冗余的手抄清单，其实不是）。
 * 它在源码里有 **5 个**消费点：`aggregate-adapter.ts` 的**四处**过滤
 *（探测排序 / 面板候选 / 虚拟模型播报 / 选择器价格后缀）加 `aggregate-expiry.ts`
 * 的「未接入」短路（⚠️ **轮换候选**的闸门正是这处短路，不是那四处过滤）；
 * 更要紧的是它被**大量不调 `apply()`** 的既有测试消费（实测：在 `tests/unit` 里
 * grep「临期探针工厂名 + 左括号」共 36 处，减去 `expiry-runtime-parity.spec.ts`
 * 自己的 7 处 ⇒ **既有 29 处**；grep「`new` + `AggregateAdapter` + 左括号」共
 * **86 处**。⚠️ 注释刻意不写出左括号，否则注释自己会被下一次 grep 计进去）——
 * 派生版本在那些场景下**恒为空数组**，`refreshCatalog` 会把**所有虚拟模型过滤掉**、
 * 聚合 provider 的模型列表**整个变空**。
 * 两者的一致性由 `tests/unit/expiry-runtime-parity.spec.ts` 真跑 `apply()` 锁死。
 */
import type { ProviderRuntime } from './provider-runtime.js';
/** 一个渠道的临期折算实现（`ProviderRuntime.expiry` 的非空形态）。 */
export type ProviderExpiry = NonNullable<ProviderRuntime['expiry']>;
/**
 * 建表所需的**装配层依赖**（可选 —— 省略时行为与升级前一致）。
 *
 * ⚠️ 为什么不像 `createProviderCredits` 那样必填：本表有**几十处既有单测**
 *    直接 `createProviderExpiry()` 建表验折算值（`aggregate-expiry.spec.ts` /
 *    `officeace-expiry.spec.ts` / `zcode-expiry-exhausted.spec.ts` / …），
 *    给它们全部补参数是无收益的机械改动。省略时不传该 deps 的那几家
 *    （目前只有 minimax 系需要它）走各自「无 xff」的回落路径 ——
 *    那与中国版的实际行为**完全一致**，只对国际站少一层绕行。
 */
export interface ProviderExpiryDeps {
    /**
     * MiniMax 国际站的 `X-Forwarded-For` 绕行头（**惰性**读，用户随时可改）。
     *
     * ⚠️ **必须惰性**：与 `createProviderCredits` 的同名字段同因 —— 注册时固化
     *    成一个字符串会让「改设置后不生效」。
     * ⚠️ 省略 ⇒ `minimaxExpiry` 收 `undefined` ⇒ **中国版行为不变**，
     *    国际站在被地理分流到中国站时折算失败（那正是 IKMEVG 的形态）。
     */
    readonly minimaxXff?: () => string | undefined;
    /**
     * MiniMax **国际站**的按账号 fetcher（PR !145 审计 P0 修法）。
     *
     * ## ⚠️⚠️ 为什么必须有它
     *
     * `agent.minimax.io` 按出口 IP 国别分流：大陆出口直连恒 307 到中国站，中国站
     * 不认国际站 token ⇒ 401。而**聚合轮换的候选可见性由折算决定**
     *（`aggregate-expiry.ts` 的 `credentialExpiry` 拿不到读数 ⇒ `UNUSABLE`
     * ⇒ 该候选被 `rankCandidates` 剔除）⇒ 没接这条腿时，用户配好代理、
     * 对话能用了，但**该渠道仍从聚合轮换里静默消失**，且零报错。
     *
     * PR !145 的注释自己点了这个症状，却只把 fetcher 接进了选号器
     *（`BuddyBalanceSelector`）与适配器 —— **折算路径一行没改**。
     *
     * ⚠️ 与 {@link minimaxXff} 的关系：**两者互补**。XFF 只是「声明」一个海外 IP
     *（上游不认该头即失效），本字段是**真正**换出口。
     *
     * ⚠️ 必须**惰性**调用（按 `accountId` 现取）：账号可能随时在面板里改代理。
     */
    readonly minimaxIntlFetchFor?: (accountId: string) => typeof fetch;
    /**
     * Qoder（**两站共用**）的按账号 fetcher（2026-10-25 审计 A2-17，B2 判「合入前必须补」）。
     *
     * ## ⚠️⚠️ 为什么必须有它（与 {@link minimaxIntlFetchFor} 同因，但**本 PR 漏接了**）
     *
     * Qoder **国际版**全部端点在墙外被 SNI 阻断，唯一出路是 per-账号出口代理。
     * 那套代理在 `618a090` 里接了**四条腿**：推理、原生搜索、余额选号、登录/续期/目录。
     * 但**折算路径一行没改** —— `qoderExpiry` 内部调
     * `fetchQoderCreditBalance(credential, product)`（**不带 fetcher**）⇒ 走全局 `fetch`
     * ⇒ 墙外环境下折算**恒失败** ⇒ `aggregate-expiry` 拿到 `undefined`
     * ⇒ 该渠道折算成 `UNUSABLE` ⇒ 被 `rankCandidates` 剔除
     * ⇒ **用户在聚合轮换列表里永远看不到 qoder / qodercn**，且**零报错、零日志**；
     * 而面板（走选号器那条腿）看起来完全正常。
     *
     * ⚠️ 这不是「与本 PR 无关的既有缺口」：`index.ts` 明写
     * 「`credits` 与 `expiry` 是两个独立消费域……**两条腿缺一不可**，
     * 这正是本仓库记过 6 次的那类静默陷阱」，而本 PR 恰好只接了 credits 一侧。
     * {@link minimaxIntlFetchFor} 的注释也逐字点了同一个症状
     * （「只把 fetcher 接进了选号器与适配器 —— 折算路径一行没改」）。
     *
     * ⚠️ 与 {@link minimaxIntlFetchFor} **分开两个键**而不是共用一个：两家的解析器
     *    是不同实例（`minimaxIntlFetchForAccount` / `qoderFetchForAccount`），
     *    合成一个会让「只接了一家」静默通过。
     * ⚠️ 必须**惰性**调用（按 `accountId` 现取）：账号可能随时在面板里改代理。
     */
    readonly qoderFetchFor?: (accountId: string) => typeof fetch;
}
/**
 * 构造「id → 临期折算」的表。
 *
 * ⚠️ 返回**新对象**（不是模块级单例）：调用方（`index.ts` 与单测）各自持有一份，
 * 互不影响；表本身是**无状态**的（每个值只是一层转发闭包），故无共享状态风险。
 */
export declare function createProviderExpiry(deps?: ProviderExpiryDeps): Readonly<Record<string, ProviderExpiry>>;
//# sourceMappingURL=provider-expiry.d.ts.map