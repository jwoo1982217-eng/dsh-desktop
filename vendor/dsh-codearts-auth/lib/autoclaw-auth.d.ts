/**
 * AutoClaw 认证服务。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type AutoclawProduct } from './autoclaw-product.js';
import { type AutoclawCredential } from './autoclaw.js';
import { type SendAutoclawCodeResult, type LoginAutoclawWithCodeResult, type StartedAutoclawSmsLoginFlow } from './autoclaw-oauth.js';
import { AccountPool } from './account-pool.js';
/**
 * 计算一条凭据的**账号身份**（同账号判据）。
 *
 * ⚠️ 抽成具名导出是为了让守卫能直接钉住它（`autoclawIdentityForTest` 同体）——
 *    这段逻辑踩过两次真机缺陷（同一账号被重复添加 3 次、积分重复累加），
 *    必须能被单测独立覆盖，而不是只能通过整条登录链路间接验证。
 *
 * ⚠️⚠️ **字段优先级**（2026-10-19 三次真机报障后定稿）：
 *      1. `credential.user_id` —— 服务端 `user-profile` 的 UUID 主键；
 *      2. `readUserIdFromJwt(access_token)` —— 老凭据没落该字段时兜底；
 *      3. `access_token` —— 两者都取不到时退化（宁可退化，不要「无身份」）。
 *
 *     ⚠️ 1 与 2 属**两个 id 空间**（UUID ↔ `numericUserId`）：同一账号可能
 *        一部分 ref 落在 1、另一部分落在 2 ⇒ 分裂成两组、去重白做
 *        （用户三次报障「怎么还是在啊」的直接原因）。
 *        彻底统一由 `autoclawSelfHeal` 在启动时调 `user-profile` 补 UUID 完成；
 *        本函数只在「来不及补齐」的窗口内保证不会没有身份。
 */
export declare function autoclawIdentityOf(credential: AutoclawCredential): string;
/** @internal 守卫专用别名（与 {@link autoclawIdentityOf} 同一实现）。 */
export declare const autoclawIdentityForTest: typeof autoclawIdentityOf;
export declare class RefreshTokenExpiredError extends Error {
    constructor(message: string);
}
export interface AutoclawAuthOptions {
    readonly product?: AutoclawProduct;
    readonly serviceName?: string;
    readonly fetcher?: typeof fetch;
}
export interface AutoclawStatusResult {
    readonly loggedIn: boolean;
    readonly expiresAt?: number;
    readonly refreshable: boolean;
    readonly lastError?: string;
}
export declare class AutoclawAuth extends Service {
    private readonly options;
    readonly product: AutoclawProduct;
    readonly credentialRefName: string;
    private readonly scheduler;
    private refreshTokenInvalid;
    private lastRefreshError;
    private active;
    /**
     * 每 ref 的**单飞（去重）闸门**（2026-10-27 审计补）。
     *
     * 语义与 `MinimaxAuth.renewInFlight` **逐字同形**：命中在飞任务就 `await`
     * 并**直接返回它的结果**，绝不再发第二份 grant。
     *
     * ⚠️ key 用**原始 `refName` 实参**（与 minimax 同口径）：`credentialRef()`
     * 只做正则校验、**不做归一**（`@deepseek-ai/dsh-credentials` 的
     * `credentialRef` 是 `brandString`）。生产三条腿（adapter 401 / 面板按钮 /
     * 积分自愈）传的都是同一个 `entry.credentialRef` 字符串 ⇒ 无别名风险。
     */
    private readonly refreshInFlight;
    constructor(ctx: Context, options?: AutoclawAuthOptions);
    private get fetchImpl();
    /**
     * 探测本地是否有有效凭据（一键导入）。
     *
     * ⚠️ **按产品选 userData 目录**（2026-10-20）：国内版与国际版是同一客户端的
     * 两份构建（`isOversea` 构建期常量），但 userData 目录名不同：
     * - 国内：`AutoClaw-official`
     * - 国际：`AutoClaw-oversea-official`
     *
     * 原实现硬编码国内目录 ⇒ **国际版永远导入不到自己的凭据**。
     *
     * ⚠️⚠️ 目录名**不再在这里拼**（2026-10-20 审计 P0 后收口）：它已进
     *    `product.userDataDirName`，因为同一个目录名有**三个读点**
     *    （本函数 / `resolveDeviceId` / 登录页 `/autoclaw/import-local`），
     *    原先各写一份 ⇒ PR 只修了本函数，另两处照旧读国内目录。
     */
    probeLocal(): Promise<AutoclawCredential | undefined>;
    /**
     * 刷新指定的凭据对象。
     *
     * ⚠️⚠️ **终态判据已收口到共享实现 `src/refresh-failure.ts`**（2026-10-27 审计修）。
     *
     * 修前是 `msg.includes('Invalid token') || msg.includes('expired') || msg.includes('401')`
     * —— 与 `minimax-auth.ts` 逐字同形的第二份实现，三条实测把**健康账号**判死：
     * `503 {"error":"token expired"}`（网关抖动）、`429 "key expired soon"`（限流）、
     * 以及传输层的 `certificate has expired`（本仓库笔记记着检查代理约 50% 概率打断）。
     *
     * ⚠️ 尤其 `'401'` 这个**子串**判据：任何报文里带 `401` 三个字符都会命中，
     * 包括 `"request id 401xy"` 之类的无关内容。
     */
    refreshCredential(credential: AutoclawCredential): Promise<AutoclawCredential>;
    /**
     * 按凭据 ref 续期指定账号的凭据（**H2 契约入口，返回 `void`**）。
     *
     * ⚠️⚠️ **per-ref 单飞（去重）**（2026-10-27 审计修的 P0）：
     *
     * 修前本方法**没有任何并发保护**（全仓 autoclaw 唯一的 in-flight 表在
     * `autoclaw-credits.ts` 的 `inflightRefreshes`，**不覆盖这条腿**）。
     * 实测同一 ref 并发 3 次 ⇒ **3 份 grant，三份都用同一把 `RT-0`**。
     *
     * 而 RT 是**一次性轮换**的（本 PR 的前提）：3 份里 2 份必然 `invalid_grant`；
     * 更糟的是上游处理序 ≠ 本地完成序时，盘上可能留下**已作废的 RT** ⇒ 账号报废。
     * 这与 `docs/adding-a-new-provider.md:143-147` 的明文纪律冲突：
     * 「三条续期入口会并发消费同一份 `refresh_token` ⇒ 必须上 per-`credentialRef`
     * 的 `SerialQueue`」。
     *
     * ⚠️ 修 PR154 之前这条风险是「偶发」（401 根本不续期，只有定时器 / 面板 /
     *    积分自愈三条入口）；补上请求级续期后，DSH 每轮并发发「主回复 + 标题 +
     *    压缩」三条请求 ⇒ 每次过期边界**必然**撞车。
     *
     * ⚠️ 返回值刻意保持 `void`（`JetHubAuthLike` 契约），凭据由
     * {@link renewCredentialForRef} 返回给需要重发的调用方（适配器 401 重试）。
     * 两者**共用同一张在飞表** ⇒ 无论谁先发起，都只有一份 grant。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 同 {@link refreshAccountCredential}，但**返回续好的新凭据**。
     *
     * 适配器的 401 重试用它来「用同一份凭据重发」—— 避免
     * `resolveCredential` 重新选号（那会让「续对了号」也白费，见
     * `AutoclawAdapterOptions.refresh` 的签名说明）。
     */
    renewCredentialForRef(refName: string, pool?: AccountPool, accountId?: string): Promise<AutoclawCredential | undefined>;
    /**
     * 单飞闸门本体：命中在飞任务就**等它并返回同一份结果**，绝不再发第二份。
     *
     * ⚠️ 与 `MinimaxAuth.refreshAccountCredential` 逐字同形（那边修的是
     * 「等完再发一份」= 串行化而非去重，实测并发 5 次 ⇒ 5 份 grant）。
     */
    private renewViaFlight;
    private refreshAccountCredentialInner;
    /**
     * 批量续期本产品的所有账号。
     *
     * ⚠️⚠️ **2026-10-27 第二轮审计打穿的 P0**（两位审计员独立命中，红队给了并发复现）：
     *
     * 修前本方法**完全在单飞闸门之外** —— 它自己 `resolve` 凭据、自己调
     * `refreshCredential`、自己 `set`，**从不经过 {@link renewViaFlight}**。
     * 于是它与「请求路径 401 续期」并发时，两路各拿**同一把** RT 去打上游：
     *
     * ```
     * 实测（有状态上游、一次性轮换；401 路径先发、5ms 后 refreshAll 并发）：
     *   上游 in:RT-0 | in:RT-0 | out:200 grant(RT-0→RT-1) | out:200 code=401 Invalid token(RT-0)
     *   盘上 = {AT-1, RT-1}（上游仍有效）；池 update = [{…,refreshable:true},{refreshable:false}]
     *   ⇒ ★被标死 = 1（一个好号被误标成「需重新登录」）
     * ```
     *
     * 触发面极广：**每次宿主重启 / 升级**时，启动首轮 `refreshAll` 都会与
     * 用户的第一条消息并发。这恰好是本仓库在 `docs/adding-a-new-provider.md:143-147`
     * 列为红线的那条纪律（「三条续期入口会并发消费同一份 refresh_token」）。
     *
     * ⇒ 现在两条纪律同时到位：
     * 1. **每账号走 `renewViaFlight`**（与 401 路径共用同一张在飞表 ⇒ 去重）；
     * 2. **不再按池 `refreshable` 过滤**（`AGENTS.md` 明文红线：那个布尔是
     *    「每轮由凭据对账出来的镜像」，写 `false` 的唯一来源就是终态判定 ⇒
     *    拿它当门禁 = 误标一次永不自愈）；改读**凭据本体**，且「读不到凭据 /
     *    解析失败」**不写池标记**（那是存储问题，不是服务端拒绝这把 RT）。
     *
     * ⚠️ 与 `MinimaxAuth.refreshAll` 的差别：那家已改成**纯对账**（轮换交给巡检），
     *    本家没有专属巡检 ⇒ 这里的 `refreshAll` **仍是轮换的正规入口之一**，
     *    所以它必须走单飞闸门，而不是被降级成只对账。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /**
     * 刷新单凭据路径下的当前凭据。
     *
     * ⚠️⚠️ **同样必须走单飞闸门**（2026-10-27 第二轮审计打穿）：
     * 修前本方法直接 `refreshCredential` + `set`，与请求路径的 401 续期并发时
     * 会两路消费同一把一次性 RT（红队实测：minimax 侧该形态「并发 2 次 refresh()
     * ⇒ 同时在飞峰值 2」，有池路径则是 1）。
     *
     * ⚠️ 但它的 key 用的是**单凭据 ref**（`credentialRefName`），与多账号路径的
     * `entry.credentialRef` 不同 —— 这不是漏洞：单凭据路径的凭据就存在那个 ref 下，
     * 两条路的 key 天然分属不同命名空间（同一个账号不会既有池条目又走单凭据）。
     * 关键是**同一个 ref 的并发调用被同一张表去重**，这正是闸门要保证的。
     */
    refresh(): Promise<void>;
    private markRefreshTokenInvalid;
    /**
     * 获取当前单凭据状态。
     */
    status(): Promise<AutoclawStatusResult>;
    /**
     * **归属校验**：用**本产品自己的**基址探一次余额，确认这份凭据属于本站。
     *
     * ## 为什么必须存在（真实事故，2026-10-20）
     *
     * 旧代码把 `refName` 写死 `AUTOCLAW_ACCOUNT_*`、且读国内目录 ⇒ 国际版槽位里
     * 被塞进**国内版凭据**。用户看到的是「国际版卡片显示国内手机号、且已过期」
     * —— 而凭据本身能解出来、能落盘，**全流程无一处报错**。
     *
     * ⇒ 「能读到」不等于「读对了」。国内凭据打国际基址会 `410000 未登录`，
     *    反之亦然（实测）。
     *
     * ## ⚠️⚠️ 为什么抽成 public 方法（审计 P0 的直接产物）
     *
     * 凭据落盘有**两条腿**：
     * 1. `importLocalAccount()` —— 本类内部，原先就调它；
     * 2. `startLogin()` 的 `started.result` —— 登录页上的「⚡ 一键读取本机凭据」
     *    （`/autoclaw/import-local`）走这条，结果由 `jet-hub-rpc.ts` **直接
     *    `credentials.set`** ⇒ 原先把校验留在 `importLocalAccount` 里，
     *    这条腿**完全绕过**它。
     *
     * 审计实测：以 `product: AUTOCLAW_INTL` 起 flow 后请求该端点，被探测的
     * 路径是 `AutoClaw-official`（国内）⇒ 国内凭据进 `AUTOCLAWINTL_ACCOUNT_*`，
     * 零报错。
     *
     * ⇒ 校验必须**与落盘同址**、且能被两条腿各自调用。
     *
     * @param cred - 待落盘的凭据。
     * @throws 校验失败时抛出**指向性**错误（告诉用户去哪个客户端登录）。
     */
    verifyCredentialSite(cred: AutoclawCredential): Promise<void>;
    /**
     * 将本地探测到的凭据导入为账号。
     */
    importLocalAccount(pool: AccountPool, options?: {
        accountId?: string;
        refName?: string;
    }): Promise<{
        accountId: string;
        refName: string;
        credential: AutoclawCredential;
    }>;
    /**
     * 发送手机验证码（免桌面端快速登录模式）。
     */
    sendVerificationCode(phone: string): Promise<SendAutoclawCodeResult>;
    /**
     * 使用手机验证码登录并保存凭据（免桌面端快速登录模式）。
     */
    loginWithCode(phone: string, code: string, refName?: string): Promise<LoginAutoclawWithCodeResult>;
    /**
     * 启动 AutoClaw 登录授权流程（本地服务器承载独立登录页，支持短信验证码与一键本地导入）。
     */
    startLogin(_options?: {
        refName?: string;
    }): Promise<StartedAutoclawSmsLoginFlow>;
    /**
     * 构造 **Z.ai OAuth** 授权 URL（仅国际版 `autoclawintl` 用）。
     *
     * ## 为什么国际版必须走 OAuth 而不是短信
     *
     * 国际版**后端也接受短信**（实测 `/userapi/v1/agent-send-code` 在国际基址回
     * `code=0 SUCCESS`），但国际版账号是**邮箱 + OAuth 创建、没绑手机号**
     * （`account-profile.json`: `phone: null`），且**没有绑手机的端点**
     * （`agent-bind-phone` / `bind-phone` 等全 404）⇒ 短信对国际账号不可用。
     *
     * ## `state` 的处理：**不生成，透传**
     *
     * 官方 `state` 是不透明串（`aosi.<base64url JWT>`，含 `dh` / `nh` 等字段），
     * 由远端登录页生成。`dh = SHA256(deviceId)` 已破解，但 **`nh` 来源未知**。
     *
     * ⚠️ 实测：用**瞎编的** `state` 打 `/userapi/overseasv1/zai-oauth-login`，
     *    服务端回 `631001 User login error`（= 进了登录逻辑、code 无效），
     *    **不是**「state 无效」⇒ 服务端不硬校验 `state` 内容。
     *
     * ⇒ 本方法**只拼 `client_id` / `redirect_uri` / `response_type`**，
     *   `state` 留给授权页填，回调时原样透传给 {@link loginWithZaiCode}。
     *
     * @param redirectUri - 回调地址（`http://localhost:<port>/auth/callback-zai`）。
     */
    buildZaiAuthUrl(redirectUri: string): string;
    /**
     * 用 Z.ai 授权码换 token 并落盘（仅国际版）。
     *
     * ⚠️ 与 {@link loginWithCode}（短信）并列的**第二条登录腿**：
     *    - 短信：国内版；国际版短信端点通但账号没绑手机。
     *    - OAuth：国际版唯一可用路径。
     *
     * @param code - 回调 URL 里的 `code`。
     * @param state - 回调 URL 里的 `state`（**原样透传**，不解析）。
     * @param navigateUri - 与授权时**完全相同**的回调地址。
     * @param refName - 凭据 ref 名（登录成功后写它）。
     */
    loginWithZaiCode(code: string, state: string, navigateUri: string, refName: string): Promise<LoginAutoclawWithCodeResult>;
}
//# sourceMappingURL=autoclaw-auth.d.ts.map