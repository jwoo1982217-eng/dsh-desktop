/**
 * MiniMax Code 认证服务。
 *
 * 登录走 **OAuth 设备码 + PKCE**（见 `minimax-oauth.ts`），
 * 续期走 `refresh_token` grant。
 *
 * ⚠️ **`refreshAll` 只按 `refreshable` 过滤，不看 `enabled`**
 * （AGENTS.md「续期不得按 enabled 过滤」的真实缺陷教训）。
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { AccountPool } from './account-pool.js';
import { type ExpiryAccessors } from './expiry-sync.js';
import { type MinimaxProduct } from './minimax-product.js';
import { type MinimaxJournalTrigger } from './minimax-refresh-journal.js';
import { type MinimaxCredential, type MinimaxModelEntry } from './minimax.js';
import { type MinimaxDeviceAuthorization } from './minimax-oauth.js';
/**
 * 过期信息提取器（供共享实现 `refreshAccountWithReconcile` 用）。
 *
 * ⚠️ `identityOf` 的语义是「**凭据内容**」（这里是 access_token）而**不是** ref 名
 * —— 传 ref 名会恒匹配失败且**静默无报错**（`src/expiry-sync.ts` 记录的坑）。
 *
 * ⚠️ `refreshableOf` 提供时共享实现会据此写池里的 `refreshable`。
 * MiniMax **确实有** refresh 端点，故提供它是**诚实**的
 *（与 Loomy 相反 —— 那边恒 false 故刻意不提供）。
 */
export declare const MINIMAX_EXPIRY_ACCESSORS: ExpiryAccessors<MinimaxCredential>;
/** refresh_token 已失效，需要重新登录。 */
export declare class MinimaxRefreshTokenExpiredError extends Error {
    constructor(message: string);
}
/** 解析凭据 JSON；形状不对返回 undefined（不抛错）。 */
export declare function parseMinimaxCredential(value: string): MinimaxCredential | undefined;
/**
 * 按账号 id 算一个**确定性**的续期抖动（0 ≤ x < span）。
 *
 * ⚠️ 必须确定性（不能每次随机）：同一条账号的续期时刻要在**周期之间稳定**，
 * 否则「错峰」退化为「洗牌」。djb2 足够 —— 这里不需要密码学强度。
 *
 * ⚠️ **导出仅供测试**（2026-10-27 审计修）：本函数是「拆掉全池同秒过期」的
 * **唯一机制**，而修前它在 `tests/` 下**零命中** —— 把它改成 `() => 0`
 * 全量测试**一个字都不变**（实测）。导出让守卫能直接打它的取值域与确定性。
 */
export declare function renewJitterMs(accountId: string, spanMs: number): number;
/** 认证服务选项。 */
export interface MinimaxAuthOptions {
    /** 产品配置；默认 {@link MINIMAX}。 */
    product?: MinimaxProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `minimaxAuth`）。 */
    serviceName?: string;
    /** 注入的 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
    /**
     * 按**账号 id** 取该账号的出口（MiniMax 国际站代理支持）。
     *
     * ## 为什么要有它
     *
     * `agent.minimax.io` 按**出口 IP 国别**分流，大陆来源恒被 307 到中国站 ⇒
     * 报出与「凭据失效」**逐字同形**的 401（issue IKMEVG）。既有的
     * `X-Forwarded-For` 只是**声明**一个海外 IP，真正换出口要靠代理。
     *
     * ⚠️ 优先级：`fetchImpl`（单测替身）> `fetchFor(accountId)`（生产代理）>
     * 全局 `fetch`。与 `GeminiAuth` 的同名字段**逐字同构**（同一份判据，只换
     * 产品语义）。
     *
     * ⚠️ 只在**国际站实例**上注入（中国站直连才是最优，出海反而更慢且可能被
     * 引到国际站）。未注入时本字段 `undefined` ⇒ `fetcherFor()` 恒走既有路径，
     * **行为逐字节不变**。
     */
    fetchFor?: (accountId: string) => typeof fetch;
    /** 注入的 sleep（测试用）。 */
    sleep?: (ms: number) => Promise<void>;
    /**
     * 续期/身份 journal 的落盘根目录（`$DSH_HOME`；2026-10-24 本地试验版）。
     *
     * ⚠️ **必须由接线层显式传入**（`index.ts` 传 `resolveJetHubHome(ctx)`）：
     * 不传（单测 / 旧接线）⇒ **绝不写盘** —— 否则单测会把日志写进用户真实的
     * `~/.dsh/jet-hub/`。见 `minimax-refresh-journal.ts` 的模块头。
     */
    journalHome?: string;
}
/** 登录流程句柄。 */
export interface StartedMinimaxLoginFlow {
    /** 用户点开的授权链接（**含 user_code**）。 */
    loginUrl: string;
    /**
     * 「保证走一遍登录」的链接（**可能为 undefined**）。
     *
     * ## 为什么登录链接需要两个版本（2026-10-24，用户报障「一打开就自带旧 session」）
     *
     * `loginUrl` 里的 `user_code` **不含身份**，身份全在浏览器 cookie ⇒ 用已有
     * 会话的浏览器打开就直接复用旧账号（上游不认任何 `prompt=*` 强制参数，实测）。
     * 本字段是上游「切换账号」按钮的等价物：`/unified-login?login_redirect=<授权页>`，
     * 由 {@link fetchMinimaxForcedLoginUrl} 用**无 cookie** 的服务端请求换来，
     * 登录完自动回到授权页放行**新**账号。
     *
     * ⚠️ 它**不依赖**无痕窗口能力 ⇒ 在「手机/远端浏览器经隧道访问、宿主没有你的
     * 浏览器」这种部署里，这是**唯一**生效的路径。
     * ⚠️ 可选字段：拿不到时调用方退回 {@link loginUrl}（行为与从前逐字节相同）。
     */
    forcedLoginUrl?: string;
    /** 授权完成后的凭据。 */
    result: Promise<MinimaxCredential>;
    /** 放弃本次登录。 */
    close: () => void;
}
/** MiniMax Code 认证服务。 */
export declare class MinimaxAuth extends Service {
    private readonly options;
    /** 本实例所属的产品配置。 */
    readonly product: MinimaxProduct;
    /** 本实例默认读写的凭据 ref 名称。 */
    readonly credentialRefName: string;
    private lastRefreshError;
    /**
     * 每 ref **单飞**闸门：巡检 / 请求路径 / 401 强刷可能同时想续同一个账号，
     * 并发轮换同一 RT = 双方都在用一把正在被作废的钥匙（轮换式令牌的
     * 致命竞态）。同 ref 的并发调用都等同一份 Promise。
     * ⚠️ 值类型放宽为 `unknown`：`refreshAccountCredential`（lead-aware 流程）
     * 与 `renewEntry`（margin 流程）的返回形状不同，汇合方各自解读。
     */
    private readonly renewInFlight;
    /** 60s 专属巡检定时器（{@link startRenewPatrol}；重复调用幂等）。 */
    private patrolTimer;
    /** 巡检防重入：一轮没跑完时跳过本轮（refreshAllCredentials 级别的教训）。 */
    private patrolBusy;
    /**
     * 巡检是否已被显式停止（{@link stopRenewPatrol}）。
     *
     * ⚠️ 与 `patrolTimer === undefined` **不是**同一件事：定时器可以被清掉，
     * 而**在飞的那一轮**（可能正卡在某个 `await grant` 上）仍会继续往下跑。
     * 本标志让它在下一个账号之前退出，避免「已卸载的实例继续轮换一次性 RT」。
     */
    private patrolStopped;
    /**
     * 判明「RT 已死」后的**冷却截止时刻**（key = 凭据 ref 名）。
     *
     * ⚠️ 见 {@link MINIMAX_TERMINAL_COOLDOWN_MS} 的 doc：压住「对确定已死的 RT
     * 每 60s 重打 + 试 3 代历史」的无效流量（实测 5 分钟 20 次上游请求）。
     * ⚠️ **凭据一变立即清除**（在 {@link renewEntryInner} 里比较当前 RT 与
     * 冷却时记下的那把），保证「重新登录即可立刻恢复」。
     */
    private readonly terminalCooldownUntil;
    /** 冷却时记下的那把 RT（用于「凭据一变即解除冷却」的判据）。 */
    private readonly terminalCooldownToken;
    /** journal 落盘根目录（`journalHome` 选项；undefined = 不写，见模块注释）。 */
    private readonly journalHome;
    constructor(ctx: Context, options?: MinimaxAuthOptions);
    private get fetchImpl();
    /**
     * 取**某个账号**该走的 fetcher（MiniMax 国际站代理支持）。
     *
     * ⚠️⚠️ **必须按账号现取，不能在构造/循环外固化**：本类在一轮流程里可能换号
     * （目录取号走 `getAvailableAccount`、续期按 ref 逐个走），出口必须跟着换 ——
     * 固化一份会让「换了号却仍走旧账号的出口」，症状是「配了代理还是被分流」
     * 且**零报错**，属最难查的一类静默失效。
     *
     * ⚠️ 优先级：`fetchImpl`（单测替身）> `fetchFor(accountId)`（生产代理）>
     * 全局 `fetch`。未注入 `fetchFor`（中国站实例 / 旧接线）⇒ 恒走既有路径，
     * **行为逐字节不变**。
     *
     * ⚠️ 空账号 id（`''`）= 直连：`fetchFor` 的解析器按「空 id = 没配代理」处理
     * （见 `minimax-proxy.ts`）—— 拿不到账号时不该去查一个空 id。
     */
    private fetcherFor;
    /** 申请设备码（供 RPC 提前拿到 loginUrl）。 */
    fetchDeviceAuthorization(accountId?: string): Promise<MinimaxDeviceAuthorization>;
    /**
     * 两步式登录：**立即**返回 `loginUrl`，后台轮询。
     *
     * ⚠️ 不能在这里阻塞等授权完成 —— 前端 `window.open` 只在
     * transient activation 窗口内有效（见 AGENTS.md「两步式登录」）。
     *
     * @param options.accountId 本次登录**将要落在哪个账号条目上**（可选）。
     *
     * ## ⚠️⚠️ 为什么登录也必须知道账号 id（换 token 的那一步要出海）
     *
     * 设备码申请与轮询换 token 都发生在**凭据落盘之前**，此时凭据还在内存里、
     * 账号池里也**只有那条占位条目**认得这个账号 ⇒ 代理只能按 `accountId`
     * 从池里读（`minimaxIntlProxy`）。不带 ⇒ 国际站在大陆网络下**登录恒失败**，
     * 而用户**没法给一个还不存在的账号配代理**（面板的「代理」按钮按
     * `accountId` 打开）⇒ **死锁**（与 Gemini 的 IKLTZ2 审计 P2-1 同型）。
     *
     * 触发路径很常见：refresh_token 失效时面板明示的既定动作就是「删号重登」，
     * 而重登造的是**全新 id** ⇒ 旧号上的代理配置必然丢失。
     *
     * ⚠️ 不传时是空串 = 直连，与既有行为**逐字节一致**（`fetcherFor('')`）。
     */
    startLogin(options?: {
        accountId?: string;
    }): Promise<StartedMinimaxLoginFlow>;
    /**
     * 落盘凭据（登录成功后调用）。
     *
     * ⚠️ 返回 `accountId` 供调用方构造展示名。
     *
     * ## ⚠️⚠️ 2026-10-23（Gitee IKP8UA）：这里**补查一次账号身份**
     *
     * MiniMax 的 `access_token` **不是 JWT**（`mmoat_` 前缀、60 字符、0 个点），
     * 登录响应体也**不含任何身份字段** ⇒ 原昵称判据（`decodeJwtSub`）恒 undefined
     * ⇒ 账号卡片恒显示插件内部 id（`minimax-6395cf64`），多账号无法分辨。
     *
     * ⇒ 落盘前查一次 `GET /v1/api/user/info`（见 `minimax-identity.ts`），
     *   把读到的 `name` 写进**凭据**（供自愈路径读）并**返回**给调用方写进账号池。
     *
     * ## 为什么收口在这里，而不是 RPC 分支
     *
     * 登录路径与**启动自愈**（`repairAccountNicknames`）都要身份 —— 若只写在 RPC
     * 那一段，自愈就得再写一份（「同一语义两套判据」）。收口在凭据落盘处，
     * 两条路径共用一份实现。
     *
     * ## 三条纪律
     *
     * 1. **查不到不影响登录**：身份是展示信息，失败一律 `undefined`
     *    （与 qoder 的 `fetchQoderUserNickname` 同原则）；
     * 2. **显式传入的 `nickname` 优先**（调用方可能有更权威的来源）；
     * 3. **国际站必须带池里的 XFF**：`agent.minimax.io` 对大陆出口恒 307 到
     *    `agent.minimaxi.com`，跨 origin 跟随会剥掉 `Authorization` ⇒ 401
     *    （真机实测：无 XFF 时国际站身份**永远**拿不到）。
     *
     * @param options.accountId 落盘到**哪个账号条目**（可选，供代理取出口）。
     *   ⚠️ 它是唯一能让「换 token 之后的身份查询」走对出口的来源 —— 此刻凭据
     *   刚落盘、按凭据反查账号 id 那条路还没建立（与 `startLogin` 同因）。
     */
    persistLogin(credential: MinimaxCredential, options: {
        refName: string;
        nickname?: string;
        accountId?: string;
    }): Promise<{
        accountId?: string;
        nickname?: string;
        userId?: string;
    }>;
    /** 解析默认单凭据。 */
    private resolveDefaultCredential;
    /**
     * 续期**默认单凭据**。
     *
     * ⚠️⚠️ **这是第 5 条续期路径，且必须同样继承身份**（2026-10-25 合并审计）：
     * PR !147 声称「收口在**唯一**出口 `refreshCredentialFor`」，但本方法在生产上
     * **可达**（`src/index.ts` 的 `getAvailableAccount()` 返回空时就走这里 ——
     * 而「返回空」正是去重把两张卡都停用后的形态），且它此前直接
     * `set(refreshMinimaxCredential(...))` ⇒ `nickname` / `user_id` **双双消失**
     * （实测：续期后落盘只剩令牌五件套）。后果是 IKP8UA（昵称退回内部 id）+
     * 去重失去唯一判据，**每 30 分钟一轮**，必然复现。
     *
     * ⇒ 与 `refreshCredentialFor` 共用同一个纯函数 `inheritMinimaxIdentity`。
     */
    refresh(): Promise<void>;
    /**
     * 续期**指定 ref**（RPC `account.refresh` / adapter 401 强刷 / 积分自愈）。
     *
     * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref。
     * ⚠️ **走共享实现 `refreshAccountWithReconcile`** —— 它保证「凭据仍有效」时
     * 也把池值对账（见 `refreshAll` 的注释）。
     *
     * ⚠️⚠️ **并入单飞闸门**（`renewInFlight`，与 `renewEntry`/巡检共用同一把锁）。
     * 语义是**去重**（命中即在飞任务就等它、**不再发第二份**），不是「串行化」
     * —— 后者会让并发 N 条各烧一把一次性 RT（2026-10-27 审计打穿的 P0，
     * 详见方法体内那段注释）。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 批量处理：**2026-10-24 本地试验版改为只对账（reconcile-only），不发 grant**。
     *
     * ## 为什么砍掉这里的轮换（三方源码审计结论）
     *
     * 旧形态：全局 30min tick 走到这里 + `REFRESH_LEAD_MS`=1h + access TTL≈1h
     * ⇒ **每个 tick、每个可续期账号都命中刷新窗口**（~48 次轮换/天/账号），
     * 且循环顺序执行使全部账号的过期时刻焊死在同一秒窗 —— 一次系统性失败
     * 就是全池同时报废（用户实测「一失效就是一大片」）。
     *
     * 新分工：
     * - **轮换**交给 ① 60s 专属巡检（{@link startRenewPatrol}，5min margin +
     *   账号散列抖动）与 ② 请求路径兜底（adapter 预判 + 401 强刷）——
     *   官方 `oauth-core` 本就是按需制，定时批量轮换是本插件自加的；
     * - **本方法只做对账**：把凭据里的真实 `expiresAt` 镜像回池（UI 读池值），
     *   保持「凭据被别处更新过而索引没跟上」的自愈能力
     *   （`src/expiry-sync.ts` 模块头记录的缺陷反面）。
     *
     * ⚠️ 纪律保持：**不看 `enabled`**（停用只影响自动选号）；单账号失败不拖住其余。
     *
     * ⚠️⚠️ **不再按池里的 `refreshable` 过滤**（2026-10-27 审计修）。
     *
     * 修前是 `if (!entry.refreshable) continue`。而那个布尔是**每轮由凭据对账
     * 出来的镜像**，不是「曾被服务端拒绝过」的案底（`AGENTS.md`：「账号池的
     * `refreshable` 只是凭据材料的镜像」；`docs/adding-a-new-provider.md:132-135`
     * 把「不看 `refreshable`」列为**红线**，并给了事故原话：
     * 「自动续期没工作、重启也没用」）。
     *
     * 拿它当门禁 ⇒ 任何一次误标都是**单向门**：定时那轮跳过它、启动首轮也跳过它。
     * 而**写成 `refreshable:false` 的唯一来源**正是本文件（终态判定），一旦
     * 判据偶发误判（见 `refresh-failure.ts` 的三条实测），账号就再也回不来。
     *
     * ⇒ 现在**读凭据本体**判材料（`isMinimaxRefreshable(credential)`）：
     *   凭据里 `refresh_token` 为空才标 `refreshable:false`；否则照常对账。
     *   读凭据只是**本地存储访问**，不花网络也不花额度 —— 拿它当门禁「省请求」
     *   是错省，省下的是自愈能力。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /**
     * 续期给定凭据（供 `refreshAccountWithReconcile` 的 `refresh` 回调）。
     *
     * ⚠️ **不落盘** —— 落盘由共享实现的 `save` 回调负责。
     *
     * 2026-10-24 起走 {@link grantWithSalvage}：非终态失败同 RT 重试一次、
     * 终态失败先回退历史代际 RT —— 语义对单凭据路径同样成立。
     *
     * @param accountId 该凭据属于哪个账号（可选，供代理取出口）。
     *   ⚠️ 与推理路径同因：国际站的续期端点也在 `agent.minimax.io` 上，
     *   大陆出口直连会 307 ⇒ 续期恒失败而 UI 只显示「已过期」。
     */
    refreshCredentialFor(credential: MinimaxCredential, accountId?: string): Promise<MinimaxCredential>;
    /**
     * **单次 grant**（含终态分类 + 历史代际维护）。
     *
     * - 服务端判 RT 已死（`invalid_grant|expired|revoked`）⇒ 包成终态错误抛出；
     * - 成功 ⇒ 组装新凭据：**旧 RT 压入历史栈**（新→旧、去重、截 3 条），
     *   再交给 `inheritMinimaxIdentity` **继承全部非令牌字段**（`nickname` / `user_id` /
     *   `previous_refresh_tokens`）—— 续期响应只带令牌五件套，手工透传每加一个字段就漏一个。
     */
    private grantOnce;
    /**
     * grant + **两层抢救**（2026-10-24 本地试验版）。
     *
     * ## 抢救顺序（**循环内合并**，不是两层互斥）
     *
     * 1. **非终态失败**（网络断/超时/5xx）⇒ 隔 1.5s **同 RT 重试一次**：
     *    覆盖「服务端还没处理就断了」的情形；
     * 2. 重试若转**终态**，说明服务端已经轮换过（响应丢失）⇒ 必须继续落到
     *    **历史代际回退**；
     * 3. **终态** ⇒ 依次回退 **历史代际 RT**（`previous_refresh_tokens`，
     *    新→旧最多 3 把）：上游若只作废被用的那条而非整族，就能救回 ——
     *    全失败才抛终态（调用方标记需重登）。**实验特性**：上游语义未证实，
     *    全失败只是多花几次注定失败的请求，无新增风险；每次抢救结果都进 journal。
     *
     * ⚠️⚠️ **修前的层级断裂（2026-10-27 审计打穿）**：
     * 修前是 `catch { if (终态) { …历史… } else { sleep; return grantOnce() } }`
     * —— 第 1 层的重试若抛**终态**，那个异常会**直接冒出去**，历史代际**一次都不试**。
     * 实测：首轮网络错→重试终态时 RT 序列 `['DEAD_RT','DEAD_RT']`（`OLD_RT_1`
     * 从未被试）；而对照组「首轮即终态」是 `['DEAD_RT','OLD_RT_1']`（救回成功）。
     *
     * 而「响应丢失」正是本特性**最主要的**设计场景（PR 描述的根因③），
     * 也就是说抢救链在它最该生效的形态下**恰好失效**。⇒ 改成单一循环：
     * 不管终态是第几次抛出的，都过一遍历史代际。
     */
    private grantWithSalvage;
    /**
     * **按账号条目续期**（2026-10-24 本地试验版的核心入口）。
     *
     * ## 与 `refreshAccountCredential` 的分工
     *
     * | 入口 | 用途 | margin |
     * |---|---|---|
     * | 本方法 | 60s 巡检 / 请求路径兜底 | 5min + 账号抖动（`force` 时无窗口） |
     * | `refreshAccountCredential` | RPC `account.refresh` / adapter `refresh()` | 既有 1h lead（用户点了就是要刷） |
     *
     * ## 三条纪律（缺一都是事故）
     *
     * 1. **单飞**（`renewInFlight`）：巡检 / 兜底 / 强刷并发想续同一个账号时，
     *    只允许一份 grant 在天上 —— 并发轮换同一 RT 是轮换式令牌的致命竞态；
     * 2. **CAS 落盘**：grant 前后**重读凭据**，`access_token` 变了说明期间
     *    有别人写过（登录 / RPC 续期）⇒ **丢弃本次结果**（别人写的是更新的
     *    会话，覆盖回去等于把新钥匙换成旧的）；
     * 3. **全量 journal**：每次 grant 记 `{trigger, result, error, latencyMs,
     *    newExpiresAt}` —— 试验期验收全靠它。
     */
    renewEntry(pool: AccountPool, entry: {
        id: string;
        credentialRef: string;
        refreshable?: boolean;
        expiresAt?: number;
    }, opts?: {
        marginMs?: number;
        force?: boolean;
        trigger?: MinimaxJournalTrigger;
    }): Promise<{
        renewed: boolean;
        credential?: MinimaxCredential;
        superseded?: boolean;
    }>;
    private renewEntryInner;
    /**
     * **60s 专属续期巡检**（重复调用幂等；生命周期由接线层的 `ctx.effect` 回收）。
     *
     * ## 为什么不塞进全局 30min 调度器
     *
     * 30min 粒度配 5min margin 会出现「上一轮看着还够、下一轮 token 已死」的
     * 空窗；而全局调度器是十三个 provider 共用的，为 MiniMax 一家改粒度会
     * 波及全部。故 MiniMax 自带 60s 定时器，margin 内（5min + 账号抖动）才发
     * grant —— 轮换次数从 ~48 次/天/账号降到 ~24-32 次，且**各账号时刻互不相同**。
     *
     * ⚠️ **立即先跑一轮**（与 `MultiAccountRefreshScheduler.start` 同理由）：
     * 宿主重启后不该等满 60s 才开始补。
     *
     * ⚠️⚠️ **必须由 {@link stopRenewPatrol} 回收**（2026-10-27 审计打穿）：
     * 修前只有 `setInterval` + `unref`、**没有 clear 路径**，而 `unref` 只解决
     * 「不阻止进程退出」，**不解决「fiber 卸载后仍在跑」**。
     *
     * 实测：`fiber.dispose()` 之后推进 130s ⇒ 巡检 tick **照跑**（+3 次），
     * 而旧实例读的是**共享的 credentials 后端**（不是快照）⇒ 它会继续对**新池**
     * 发 grant。插件热重载/`apply()` 重入时旧实例没死 + 新实例已起 ⇒ **两个实例
     * 并发轮换同一批一次性 RT**，输家拿到 `invalid_grant` 并把好号标死。
     * 这恰好是本 PR 自己声称要修的「并发轮换」形态。
     *
     * ⇒ 接线层必须 `ctx.effect(() => () => auth.stopRenewPatrol())`（两站各一条），
     *   由 `index.ts` 负责；`lifecycle-cleanup` 那组守卫逐站点名。
     */
    startRenewPatrol(pool: AccountPool): void;
    /**
     * 停止续期巡检（**幂等**；由接线层的 `ctx.effect` 在 fiber 卸载时调用）。
     *
     * ⚠️⚠️ 这是 2026-10-27 审计补的**唯一** clear 路径。修前整个类没有它，
     * 而 `unref()` 只保证「不阻止进程退出」，不保证「fiber 卸载后停手」——
     * 实测 dispose 后巡检仍对新池发 grant（详见 {@link startRenewPatrol} 的注释）。
     *
     * ⚠️ 同时置 `patrolStopped`：**在飞的那一轮**（可能正卡在某个 await 上）
     * 也会在下一个账号前退出，不再继续轮换。
     */
    stopRenewPatrol(): void;
    /**
     * 拉取远端模型目录（给定凭据）。
     *
     * ⚠️ **测试专用入口**（无需账号池）：`fetchModels` 是它的薄包装。
     *
     * @param accountId 用**哪个账号**的出口（可选，供代理取）。
     */
    fetchModelsWith(credential: MinimaxCredential, accountId?: string): Promise<readonly MinimaxModelEntry[]>;
    /**
     * 拉取**裸**远端目录：拿到就是拿到，拿不到一律 `undefined`（**不**回退兜底表）。
     *
     * 这是全插件唯一一处真正解析远端模型目录的地方；两个公开入口的差别只在
     * 「拿不到时回吐什么」：
     * - {@link fetchModelsWith} / {@link fetchModels} ⇒ **展示侧**语义，回退兜底表；
     * - {@link fetchRemoteModelsOnly} ⇒ **接线侧**语义，回 `[]`。
     *
     * ⚠ 把这个区分做在**这里**（而不是让接线自己去比对结果与兜底表）是刻意的：
     * 兜底表内容可以被改写，若远端下发的恰好与兜底表相同，「比较内容」的判据会把
     * 一次成功的拉取误判为失败。只有「解析函数返回了几个条目」这个**内部事实**
     * 能可靠区分两者。
     *
     * @param accountId 用**哪个账号**的出口（可选，供代理取）。
     *   ⚠️ 目录端点也在 `agent.minimax.io` 上：大陆出口直连恒 307 ⇒ 整个
     *   provider 会从模型选择器里**消失**（issue IKMEVG 的另一症状面）。
     */
    private fetchRawModels;
    /** 拉取远端模型目录（账号池版本）。 */
    fetchModels(pool?: AccountPool): Promise<readonly MinimaxModelEntry[]>;
    /**
     * 目录拉取用哪份凭据：账号池优先，其次插件自存的默认凭据。
     *
     * ⚠️ **同时返回账号 id**（代理支持）：目录端点也在 `agent.minimax.io` 上，
     * 国际站必须走该账号的出口才拿得到。单凭据回退时 id 是空串（= 直连），
     * 与既有行为一致。
     */
    private resolveModelsCredential;
    /**
     * 只取**真远端**目录；未登录 / 上游失败 / 解析出 0 条 ⇒ `[]`。
     *
     * ⚠ 与 {@link fetchModels} 的区别是**不回退兜底表**，专供适配器与本地桥使用。
     *
     * 为什么必须有这条：适配器判「这次拿到目录了吗」的判据是「返回空数组」。
     * 若接线用 `fetchModels()`（失败时回吐兜底表），那个判据**永不命中**
     * ⇒ 兜底表被当成远端结果写进 `remoteModels` 并永久缓存，用户登录 /
     * 网络恢复后**再也不会重拉**（连失败冷却都不会开），只能重启 DSH。
     * 「回退兜底表」这件事只应由**展示侧**（适配器）做一次。
     *
     * 日志语义与 {@link fetchModelsWith} 一致（失败 / 解析 0 条都留 warn），
     * 只是**不**把兜底表当结果返回。
     */
    fetchRemoteModelsOnly(pool?: AccountPool): Promise<readonly MinimaxModelEntry[]>;
    /**
     * ★★ **启动自愈：补齐存量账号的显示名**（Gitee issue IKP8UA 修法 ③）。
     *
     * ## 为什么必须有这条
     *
     * 只改登录路径**不会自愈存量账号** —— 用户已有的账号（本机实测 7 条）
     * 昵称早已是插件内部 id 且已落盘。不给这条腿，用户要**删号重登**才看得到真名。
     *
     * ## 形态照 `gemini-auth.ts` 的同名方法（那是本仓库最规范的一份）
     *
     * | 纪律 | 理由 |
     * |---|---|
     * | 逐账号 `try/catch` | 单账号失败不得拖住其余（本方法是启动期循环，一个挂住会连累后面全部） |
     * | **只在确实变化时**写池 | `updateAccount` 是整体 replace，每次启动都写 = 平白落盘 |
     * | 失败**不告警**（只用 debug） | 老账号 token 可能早已过期，拿不到是常态，不该刷 warn |
     * | 查不到就**保持原样** | 绝不退回用池 id 重算昵称（那是本 issue 的缺陷本身） |
     *
     * ⚠️ **国际站必须带池里的 XFF**：否则恒 307 → 401（真机实测），
     *    自愈对国际站账号将**永远**失败且看起来「和国内站一样在跑」。
     *
     * @returns 被修复的账号 id（供接线层记日志/计数）。
     */
    repairAccountNicknames(pool: AccountPool): Promise<string[]>;
}
/**
 * 解析远端目录响应。
 *
 * 校验（照 asar `parseSnapshot`）：`providers[]` 含 `providerId === 'minimax'`、
 * `config.models` 是非空对象；逐条经 {@link normalizeMinimaxModel} 归一。
 */
export declare function parseMinimaxModelsPayload(payload: unknown): readonly MinimaxModelEntry[];
//# sourceMappingURL=minimax-auth.d.ts.map