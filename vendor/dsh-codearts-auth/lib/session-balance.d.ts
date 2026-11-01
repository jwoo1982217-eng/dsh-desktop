/**
 * 按 **sessionId** 做账号亲和 / 无 sessionId 时随机分摊的纯函数。
 *
 * ## 为什么需要它
 *
 * 账号池此前的 `getAvailableAccount()` 永远取「手动顺序第一个可用账号」：
 * 只要 1 号没撞限额，全部流量都压在它身上。对 ZCode 这种「一个会话会连续
 * 发很多轮请求」的 provider，用户希望：
 *
 * - **有 sessionId**：同一会话**优先**落到同一个账号（会话亲和），不同会话按
 *   sessionId 稳定分散到不同账号 —— ⚠️ 这个「优先」是有例外的：账号今日负载
 *   达阈值后会被沉底，正在跑的会话**会迁移一次**（见
 *   `rankAccountsBySessionWithOverflow` 的长注释，2026-10-31 审计订正）；
 * - **没有 sessionId**（本地 OpenAI 网关等一次性调用）：每次随机挑一个账号，
 *   把请求分摊开。
 *
 * ## 为什么用 rendezvous 哈希而不是 `hash % N`
 *
 * `hash(sessionId) % 账号数` 在账号数变化时会**整体重排**：某个账号临时进入
 * 限流（候选集从 5 个变 4 个）会让所有会话换号，限流恢复后又全部换回。
 * rendezvous 哈希给每个 `(session, account)` 算一个稳定分数、按分数排序取最高，
 * 账号集合变化时只有原本落在那个账号上的会话需要迁移，其余会话保持不动。
 *
 * ## 为什么随机回退用洗牌而不是「随机取一个」
 *
 * 随机取一个若刚好拿到凭据损坏 / 已被 `tried` 排除的账号，还要再抽一次；
 * 直接洗牌后顺序尝试，既均匀又不重复。
 */
/**
 * 「ZCode 会话负载均衡」的开关环境变量。
 *
 * ## 默认与判据（与 `DSH_RATE_LIMIT_SINK` 同型，**别写成 falsy 判断**）
 *
 * 默认**开启**（用户 2026-10-30 的原始需求）。留这道开关是因为它改变了选号
 * 语义：手动顺序不再决定谁先被用；若有人依赖「首位账号一直扛」的旧行为
 * （例如想让额度最充足的号先烧完），显式设 `0` / `false` / `off` / `no`
 * 即整体退回「手动顺序优先」的既有路径 —— 与关掉前逐字节同语义。
 *
 * ⚠️ 判据取「**显式写了** `0/false/off/no` 才算关」，未设置 / 空串 / 无法
 * 识别的值一律按默认开启 —— `Boolean(env[...])` 会把「未设置」误判成关闭
 * （`account-pool.ts` 的 `rateLimitSinkEnabled` 记过同型坑）。
 *
 * ⚠️ **与 `jet-hub-store.ts` 的 `sanitizeSessionBalanceEnabled` 是两套刻意
 * 不同的判据，不要「统一」**：本函数是 **env 替身回落**（字符串宽松，`'false'`
 * 算关 —— env 里没有类型，用户写了就是意图）；store 那份是**落盘数据判据**
 * （严格 `raw !== false` —— 脏字符串 ≠ 用户意图，宁可当启用）。生产路径恒走
 * store 那份（见 `credential-resolver.ts` ③ 的 poolSwitch 优先级），本函数
 * 只在「结构化替身池」可达。
 */
export declare const DSH_ZCODE_SESSION_BALANCE = "DSH_ZCODE_SESSION_BALANCE";
/** 当前是否启用「ZCode 会话负载均衡」（见 {@link DSH_ZCODE_SESSION_BALANCE}）。 */
export declare function sessionBalanceEnabled(env?: NodeJS.ProcessEnv): boolean;
/** 计算 `(scope, sessionId, accountId)` 的稳定分数（SHA-256 十六进制）。 */
export declare function sessionAccountScore(scope: string, sessionId: string, accountId: string): string;
/**
 * 按 sessionId 给账号做 **rendezvous 哈希**排序（分数从高到低）。
 *
 * - 同一个 sessionId + 同一批账号 ⇒ 结果逐字稳定（跨进程、跨重启一致）；
 * - 不同 sessionId 会得到不同顺序，从而把会话分散到不同账号；
 * - 账号集合增删时，只影响原本首选该账号的会话，其余顺序尽量保持。
 *
 * @param accounts - 候选账号（调用方已按 enabled / 模型限流 / tried 过滤）。
 * @param sessionId - 非空会话标识。
 * @param scope - 命名空间（传 provider id），避免不同 provider 的同名账号串味。
 * @returns 新数组，不修改入参。
 */
export declare function rankAccountsBySession<T extends {
    id: string;
}>(accounts: readonly T[], sessionId: string, scope: string): T[];
/**
 * Fisher–Yates 洗牌（不改入参）。
 *
 * `random` 可注入，供单测固定序列；生产缺省 `Math.random`。
 */
export declare function shuffleAccounts<T>(accounts: readonly T[], random?: () => number): T[];
/**
 * 「账号今日负载」读数（供溢出均衡用）。
 *
 * 只取选号真正需要的**一个**字段：今日请求笔数。
 *
 * ⚠️ 初版还带一个 `outputTokens`（「今日输出 token 合计」），但**全仓没有任何读点**
 * —— 溢出的判据只看请求笔数。2026-10-31 审计实测它是死字段后删除：留着会让
 * 「只取选号真正需要的两个字段」这句注释与实现不符，也会诱导后来者以为 token 量
 * 参与排序。
 *
 * 数据源是 token-ledger 的日聚合（`readTokenLedgerDayMap()`），**纯内存读、
 * 零网络请求** —— 选号在推理关键路径上，绝不能在这里发余额请求。
 * 实测代价：真实 8 个桶 ≈ 0.9 µs/次，最坏 500 桶 ≈ 85 µs/次（与日键数量无关）。
 */
export interface AccountLoadReading {
    /** 该账号今日（UTC+8 日界）的请求笔数（含失败）。 */
    requests: number;
}
/**
 * 会话负载均衡的**溢出阈值**环境变量（账号今日请求数）。
 *
 * ## 它解决的问题（2026-10-31 用户报障「每个账号的负载并不太均衡」）
 *
 * 会话亲和的账号负载 ≈ **会话长度**（一个跑整天的会话把它哈希到的那个账号独自
 * 吃满，没有会话落上的账号整天空闲）。本机真实账本实测：
 * `2026-10-31` 六个有量账号为 `1233 / 459 / 8 / 7 / 7 / 7`（总量 1721，
 * 单号占 **71.6%**，max/mean = **4.30**）。
 *
 * ## 语义：这是「**上限（cap）**」，不是「均衡器」，更不是「已有会话保持亲和」
 *
 * - 账号今日请求数 ≥ 阈值 ⇒ 在该次的排序里**整组沉底**；
 * - 因此 **新会话**会落到未超载的账号上；
 * - ⚠️ 但本模块**无状态**（见 `rankAccountsBySessionWithOverflow` 的长注释）：
 *   一个**正在跑的会话**，一旦它所在账号越过阈值，它的**下一次请求就会迁移**到
 *   别的账号 —— 本修法正是靠这次迁移把长会话摊开的。**不要**在别处声称
 *   「已有会话保持亲和 / 已开的会话不换号」。
 * - 全员超载 ⇒ 退回纯哈希序（照常发请求让上游自己限流，不硬失败）。
 *
 * ## 为什么阈值是**绝对量**而不是「当日总量的相对量」（实测否决）
 *
 * 初版设想过 `max(下限, ceil(k × 当日累计 / 账号数))`，**实测否决**：
 * 阈值随总量上涨会把「已超载」的账号重新变回 fresh ⇒ 会话反复弹回原号。
 * 真实场景（8 号池 / 1691 请求 / 1 个超长会话 + 1 个中等会话）实测：
 *
 * | 策略 | max/mean | 会话中途换号 |
 * |---|---|---|
 * | 关闭溢出 | 5.83 | 0 |
 * | 固定 300 | **1.42** | **5** |
 * | 相对 `max(200, 1.2×均值)` | 1.20 | **204** |
 * | 相对 `max(200, 1.5×均值)` | 1.50 | **428** |
 *
 * ⇒ 相对量用 8 倍以上的换号次数只换来一点点更平的分摊，**不划算**，故保留绝对阈值。
 *
 * ## 默认值 300 的来源（真实账本，不是拍脑袋）
 *
 * 固定上限 C 的最终比值上界是 `C ÷ 当日均匀量`。按本机有量的 4 天倒推：
 * `10-25`（总量 759 / 4 号 / 峰值 412 / 错误率 13.3%）与 `10-31`（1721 / 峰值
 * 1233）要压到 ≈1.5 以内 ⇒ `C ≤ 300`；而 `10-24`（峰值 398 / 均值 310）本就
 * 接近均匀，300 只会引发极少量迁移。
 *
 * ⚠️ 初版默认 **600** 实测**几乎不生效**：4 天里 3 天峰值 < 600 ⇒ 一个号都不会
 * 沉底 ⇒ 零效果；且 PR 正文举证的 `322/322/306/156/34`（峰值 322）同样 < 600
 * ⇒ **对它自己描述的报障也零效果**。600 在 10-31 只把 max/mean 从 5.83 压到 2.84。
 *
 * ## 已知边界（如实登记，不掩饰）
 *
 * - **小池 + 高量**：2 个号各 850 次、阈值 300 ⇒ 两个号长期都超载 ⇒ `fresh` 为空
 *   ⇒ 退回哈希序 ⇒ **不生效**（此时不均衡度本身也只有 ≤2.0，可接受）。
 * - **大池 + 高量**：20 个号均分 86 ⇒ 单号很难到 300 ⇒ **不生效**。
 *   需要更激进时用环境变量下调（本仓库实测 5~8 号池最合适）。
 * - 阈值按 **UTC+8 日界** 归零，跨日那一刻所有账号重新变 fresh。
 */
export declare const DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS = "DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS";
/** 缺省溢出阈值（今日请求数）。取值依据见 {@link DSH_ZCODE_SESSION_BALANCE_OVERFLOW_REQUESTS}。 */
export declare const DEFAULT_OVERFLOW_REQUESTS = 300;
/** 当前生效的溢出阈值；`0` = 关闭溢出均衡（纯哈希亲和）。 */
export declare function overflowRequestsThreshold(env?: NodeJS.ProcessEnv): number;
/**
 * 按账号 id 索引「今日负载」读数。
 *
 * @param days - token-ledger 日聚合表（`readTokenLedgerDayMap()` 的返回）。
 * @param provider - provider id（只统计该渠道的桶）。
 * @param day - UTC+8 日键（`utc8DayKey(Date.now())`，由调用方传入以便单测）。
 */
export declare function accountLoadIndex(days: ReadonlyMap<string, ReadonlyMap<string, {
    requests: number;
    outputTokens: number;
}>>, provider: string, day: string): Map<string, AccountLoadReading>;
/**
 * 带**溢出**的会话排序：负载达阈值的账号沉底，其余按 rendezvous 序不变。
 *
 * ## 语义（三条）
 *
 * 1. **未超载**的账号之间：rendezvous 哈希序不变（跨请求稳定）；
 * 2. **已超载**的账号整组沉到最后 ⇒ **新会话**落到未超载账号上（负载分摊）；
 * 3. **全员超载**时退回纯哈希序（照常发请求让上游自己限流，不硬失败）。
 *
 * ⚠️ 这是**软溢出**而非硬排除：超载账号仍在候选里（排最后）。硬排除会让
 * 「5 个号全超载」时选不出号 —— 而此时正确动作是照常发请求让上游限流。
 *
 * ## ⚠️⚠️ 它**不是**「已有会话保持亲和」——这是初版的错误表述，已订正
 *
 * 本函数是**无状态纯函数**，而调用方（`AccountPool.getAvailableAccountForSession`）
 * **每个请求**都会重跑一次；池里**没有** `sessionId → accountId` 的记忆
 * （全库只有 provider 级的 `activeZcodeAccountId`，那是记账归属，不是亲和状态）。
 *
 * ⇒ **一个正在跑的会话，一旦它所在账号的今日请求数达阈值，它的下一次请求就会
 * 被排到别的账号上。** 本修法正是靠这次迁移把长会话的负载摊开的。
 *
 * 实测（8 号池 / 会话连跑 / 阈值 600）：第 **601** 次、第 **1201** 次各迁移一次；
 * 阈值低于当日均匀量时还会出现两种退化：①「**为 1 次请求换号**」（如
 * `a×148 → d×1 → e×37`），②「**越过阈值后又弹回原号**」（全员超载 ⇒ 退回哈希序）。
 *
 * 若将来确实需要硬亲和，必须新增 `Map<sessionId, accountId>` + TTL；而那样会让
 * 本修法对「长会话独占一个号」**重新失效**（两个目标互斥）—— 2026-10-31 审计
 * 记录在案：本 PR 选择了「摊平负载」，代价是会话跨越阈值时会迁移一次。
 *
 * @param accounts - 候选账号（调用方已按 enabled / 模型限流 / tried 过滤）。
 * @param sessionId - 非空会话标识。
 * @param scope - 命名空间（provider id）。
 * @param loads - 账号今日负载索引（缺账号 = 今日没跑过 = 负载 0）。
 * @param thresholdRequests - 溢出阈值（今日请求数）；`0` = 关闭溢出。
 * @returns 新数组，不修改入参。
 */
export declare function rankAccountsBySessionWithOverflow<T extends {
    id: string;
}>(accounts: readonly T[], sessionId: string, scope: string, loads: ReadonlyMap<string, AccountLoadReading>, thresholdRequests: number): T[];
//# sourceMappingURL=session-balance.d.ts.map