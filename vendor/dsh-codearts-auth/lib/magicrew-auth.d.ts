/**
 * Magicrew 的三层凭证与续期。
 *
 * ## 三层凭证（有效期完全不同，实测 2026-10-28）
 *
 * | 层 | 有效期 | 用途 | 续期方式 |
 * |---|---|---|---|
 * | 网页 JWT | 30 天 | 业务 API（目录/计费/积分） | 手机号+密码重登 |
 * | `mgw_` api_key | **2 小时** | 模型网关（推理） | `PUT /tokens` |
 * | refresh_token | 7 天，**一次性轮换** | 换 api_key | 同上，**必须串行** |
 *
 * ## ⚠️ 两条不能违反的规则（magpie 侧真实事故换来的，AGENTS.md 坑 #3 / #4）
 *
 * 1. **签新 key 会吊销旧 key** ⇒ 绝不在热路径上签发。只允许「登录」与「续期」两个入口。
 * 2. **refresh_token 只能有一个出口** ⇒ 只允许本文件的 `refreshMagicrewKey` 持有，
 *    别的模块不得自持第二份（分叉的后果是两处 token 不一致、用户莫名掉登录）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { AccountPool } from './account-pool.js';
import { type MagicrewBrowserLogin } from './magicrew-browser-login.js';
import { type MagicrewProfile } from './magicrew-profile.js';
import { type MagicrewProduct } from './magicrew-product.js';
/** 一个账号的完整凭据。**不存密码**（JWT 30 天 + refresh_token 自滚，存密码得不偿失）。 */
export interface MagicrewCredential {
    /** 网页 JWT（业务 API 用）。 */
    jwt: string;
    /** 组织码 —— **必须与 apiKey 配对**（错配会得到 HTTP 200 + `code:403`）。 */
    organizationCode: string;
    /** 模型网关 key（2 小时）；缺失时可通过 refreshToken 救回。 */
    apiKey?: string;
    apiKeyExpiresAt?: number;
    /** 换 key 用，一次性轮换。 */
    refreshToken?: string;
    refreshTokenExpiresAt?: number;
    /** 手机号（仅展示，不参与鉴权）。 */
    phone?: string;
    /**
     * 上游昵称（**仅展示**；登录时取自 {@link fetchMagicrewProfile}）。
     *
     * ⚠️ 与 `phone` 同级：卡片的展示名按 `nickname → 脱敏手机号 → displayName` 判
     * （见 {@link magicrewDisplayNickname}），它**不参与**任何鉴权。
     *
     * ⚠️ 可选字段，**老凭据里没有它** —— 这是刻意的向后兼容：没有本字段时展示判据
     * 逐字节回到改动前的行为。
     */
    nickname?: string;
}
/**
 * 把账号池里的 `unknown` 收窄成 {@link MagicrewCredential}。
 *
 * 判据：**`jwt` 是唯一必需字段**（业务 API 全靠它；api_key 缺失可由 refresh_token 救回，
 * 而 jwt 缺失意味着连目录都拉不到）⇒ 此时返回 `undefined`（账号不可用）。
 */
export declare function parseMagicrewCredential(raw: unknown): MagicrewCredential | undefined;
/**
 * 凭据指纹（**按 jwt 算**）—— 用于「同一账号是否已存在」的判重。
 *
 * ⚠️ 不能用 `apiKey`：它 2 小时一换，会把同一个账号认成新账号。
 * jwt 的 payload 在 30 天内稳定（`refresh` 不改它）。
 */
export declare function magicrewCredentialFingerprint(jwt: string): string;
/**
 * 展示昵称：**上游昵称 → 手机号脱敏（`130****2222`） → 渠道名**。
 *
 * ## ⚠️ 优先级为什么是这个顺序（真机报障 2026-10-29）
 *
 * 原先只有后两条腿，而**浏览器登录**（本机浏览器导入 / 网页版登录）落库的凭据里
 * **没有 `phone`** ⇒ 卡片恒显示 `product.displayName`（=「超级麦吉」），
 * 而用户自己的昵称是 `Nick`（上游 `/api/v1/contact/accounts/me/users` 实测返回）。
 * ⇒ 登录时把昵称写进凭据（{@link MagicrewAuthOptions.profileFetcher}），这里优先用它。
 *
 * ## ⚠️⚠️ 向后兼容是硬约束：老凭据（无 `nickname`）必须逐字节不变
 *
 * 老凭据没有 `nickname` ⇒ 第一腿不成立，后两腿的判据与顺序**一字未改**：
 * 11 位手机号仍出脱敏号、其余仍回落 `displayName`。这个「老凭据」格是本次改动
 * 最重要的用例（改坏它 = 所有存量账号的卡片一起变样）。
 *
 * ⚠️ 昵称判据用 `trim()` 只为**判空**（全空白不算昵称），返回值**原样**给出去 ——
 * 上游昵称里的空格是上游的事，展示层不替它改写。
 */
export declare function magicrewDisplayNickname(credential: MagicrewCredential, product?: MagicrewProduct): string;
/**
 * 账号卡片上「有效期」该取哪个时刻（`undefined` = 如实显示「未知」）。
 *
 * ## 判据
 *
 * 1. `apiKeyExpiresAt` 有值 ⇒ 用它（精确，且续期成功后被不断刷新）；
 * 2. 否则用 **JWT 的 `exp`**（本家**登录会话**的寿命，实测 30 天、可离线解出）；
 * 3. 都拿不到 ⇒ `undefined`（**不编造** —— 卡片如实显示「未知」，不写 0/NaN）。
 *
 * ## ⚠️⚠️ 为什么不能只取 `apiKeyExpiresAt`（真机报障：卡片「有效期 未知」）
 *
 * `mgw_` key 只有 **2 小时**且会自动续期，而**浏览器登录**落库的凭据里
 * **根本没有 `apiKeyExpiresAt` 这个字段**（实测 `~/.dsh/.credentials.yaml` 只有
 * `apiKey`/`jwt`/`organizationCode`/`refreshToken`）⇒ `account.create` 写池时那一格
 * 是 `{}` ⇒ 卡片恒显示「未知」。
 *
 * ⚠️ 反过来也不能只用 JWT exp：JWT 过期（30 天）之后 `refresh_token` 仍可能有效，
 * `apiKeyExpiresAt` 是「更近的真相」⇒ 两条腿**各管一段**，顺序不能换。
 *
 * ⚠️ JWT 解不出来时 `jwtTimes` 返回 `exp = 0`（**不猜**）⇒ 这里同样返回 `undefined`。
 */
export declare function magicrewExpiresAtMs(credential: MagicrewCredential): number | undefined;
/**
 * 取账号资料（昵称）的**小超时**：6 秒。
 *
 * ⚠️⚠️ 这个值刻意**远短于** `product.requestTimeoutMs`（30 秒，业务 API 口径）：
 * 资料只用来给卡片取个昵称，而它挂在**登录**这条用户正盯着屏幕等的路径上 ——
 * 30 秒的静默等待与「点了登录没反应」同形。
 *
 * 兑现方式：调用方把 `product.requestTimeoutMs` **换成这个值**再交给
 * `fetchMagicrewProfile`（它的 `AbortSignal.timeout(product.requestTimeoutMs)` 是
 * 唯一超时出口，不为「小超时」另开一个参数 —— 两处超时门是漂移源）。
 */
export declare const MAGICREW_PROFILE_TIMEOUT_MS = 6000;
/** 签发结果（三层凭证的第 2、3 层）。 */
export interface MagicrewGatewayKey {
    readonly apiKey: string;
    readonly refreshToken?: string;
    readonly apiKeyExpiresAt?: number;
    readonly refreshTokenExpiresAt?: number;
}
/**
 * 用登录 JWT 签发一把 `mgw_` key（2 小时）。
 *
 * ⚠️⚠️ **签新 key 会吊销旧 key**（magpie 坑 #3）⇒ 本函数**只允许**在
 * 「登录成功」与「续期」两个入口调用，**绝不在热路径**（推理前）调用。
 * 热路径上签一次，正在并发的另一次请求立刻拿到死 key（症状：偶发「token无效」，
 * 而重试又能成 —— 极难复现的那种）。
 */
export declare function issueMagicrewGatewayKey(params: {
    jwt: string;
    organizationCode: string;
    product?: MagicrewProduct;
    fetchImpl?: typeof fetch;
}): Promise<MagicrewGatewayKey>;
/**
 * 用 refresh_token 换新的 api_key。**不需要登录态**（JWT 过期也能续）。
 *
 * ⚠️⚠️ refresh_token 是**一次性**的（每换一次就轮换）⇒ 调用方**必须串行**，
 * 并发两次会让其中一个的 token 立即失效（表现为「账号突然掉登录」，而重登又好了）。
 *
 * ⚠️ **本函数是全仓唯一持有 refresh_token 的地方**（magpie 坑 #4）：
 * 别处再存一份就会分叉。
 */
export declare function refreshMagicrewKey(params: {
    refreshToken: string;
    product?: MagicrewProduct;
    fetchImpl?: typeof fetch;
}): Promise<MagicrewGatewayKey>;
/**
 * 判断一个错误是否是「api_key 失效」（应当续期重试，而不是判账号死）。
 *
 * ⚠️ 只判**消息文本**：上游把鉴权失败装在业务码里（HTTP 200 + `code:403` +
 * `message:"token无效"`）⇒ 状态码根本不是判据。
 *
 * ⚠️ **刻意不把 HTTP 401 / 403 塞进来**：那两类是**传输层**的失败（可能是网关抖动、
 * 出口 IP 被拦、甚至 `organization-code` 错配），把它们当成「key 失效」会触发续期
 * ⇒ 而续期**会吊销当前 key** ⇒ 一次误判就把本来能用的凭据烧掉。
 */
export declare function isMagicrewApiKeyDeadError(error: unknown): boolean;
/**
 * 一个账号的**续期内存态**（per-ref，由 `MagicrewAuth.states` 强持）。
 *
 * ⚠️ 它不是凭据的副本，而是「下次该拿哪个 refresh_token 去换」的唯一答案：
 * 轮换成功后立即就地更新，因此它可能比凭据库**新**（写回还没发生/失败）。
 */
export interface MagicrewRefreshState {
    refreshToken?: string;
    apiKey?: string;
    apiKeyExpiresAt?: number;
    /**
     * **上次写回失败时，凭据库里那条已被消费的旧 token**（`undefined` = 库与内存一致）。
     *
     * 用途有两个，都不可省：
     * 1. `stateOf` 用存储值刷新内存态时**跳过它**；
     * 2. `refreshAll` 的 lead-time 门**放行**（见 `refreshAll` 内的注释）。
     *
     * ⚠️⚠️ 为什么必须有（单向门）：refresh_token 一次性轮换。若「轮换成功 → `store.set`
     * 抛错」（磁盘满 / 凭据库被锁），内存已是新 token、存储仍是旧 token。下一轮
     * `stateOf` 若照「存储优先」把内存改回那条**上游已消费**的旧 token，续期从此
     * 必然失败 ⇒ 只能重新登录。
     *
     * ⚠️⚠️ **登记点必须跟着「写回失败」走，不能放在「轮换成功」处**：库里的值可以被
     * **别的写入方**改（备份导入 / 合并写入同一 ref / 另一实例 / 复用同一 ref 的重登），
     * 那条路径的通式是「两次瞬时失败**夹一次外部写入**」——
     * `t1` 轮换 rtA→rtB 失败（marker=rtA）→ `t2` 外部写入 rtL（`stateOf` 采纳，正确）
     * → `t3` 轮换 rtL→rtC 又失败，但「只记第一条」的守卫让 marker 仍是 rtA ⇒
     * `t4` 存储值 rtL ≠ marker rtA ⇒ 把**已消费的 rtL** 抬回内存 ⇒ 门重开。
     * 改成「失败时无条件记下**当时读到的库值**（`credential.refreshToken`）」后，
     * marker 恒与库同步：每次失败重新上膛、成功即清空 ⇒ 上面每一轮都闭合。
     */
    staleRefreshToken?: string;
}
/**
 * 一次性 refresh_token 的**串行续期器**。
 *
 * ⚠️⚠️ 为什么必须串行：refresh_token **一次性轮换**（每换一次就作废旧的）。
 * 两个并发请求会拿同一个 token 去换 ⇒ 第二个必然失败，而**前一个已经把新 token
 * 写回了** ⇒ 表面上「莫名掉登录」，实际是竞态。
 *
 * ⚠️ 这里刻意做成「共享同一个 state 对象」而不是闭包变量：调用方（`MagicrewAuth`）
 * 持有那份 state，续期成功后**就地更新** `refreshToken`，下一轮才有得用。
 *
 * 并发到来时**后来的等前一个的结果**（而不是各发一次）—— `SerialQueue` 保证
 * 「同一刻只有一个 PUT 在飞」，`inFlight` 保证**同一次续期只真发一次请求**。
 *
 * ⚠️⚠️ `inFlight` **必须按 `state` 分键**（`WeakMap`），不能是一个裸变量：
 * 本实例由 `MagicrewAuth` 构造时**只创建一份**、被全部账号共用，裸变量会让
 * 「账号 A 续期中、账号 B 同时要续期」变成**B 直接拿到 A 的新 key**
 * （`fetch` 只发一次、B 的凭据被写成 A 的 `mgw_` 密钥 ⇒ 跨账号串号，
 * 症状是 B 偶发「token无效」而 A 一切正常）。同一个 `state` 才该去重。
 */
export declare function createMagicrewRefreshOnce(deps: {
    fetchImpl?: typeof fetch;
    product?: MagicrewProduct;
}): (state: MagicrewRefreshState) => Promise<MagicrewGatewayKey | undefined>;
/** `MagicrewAuth` 的注入项（测试全套可注入）。 */
export interface MagicrewAuthOptions {
    readonly product?: MagicrewProduct;
    readonly fetchImpl?: typeof fetch;
    /** 告警出口；缺省走 `ctx.logger?.warn`（单测注入以便断言「不许静默」）。 */
    readonly warn?: (message: string) => void;
    /**
     * 注入的凭据库。⚠️：**形状必须与宿主 `ctx.credentials` 一致**。
     *
     * 实测（`astudio-auth.ts:395-399`）它是三个方法、值是**字符串**：
     *
     * ```ts
     * resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
     * set(ref: CredentialRef, value: string): Promise<void>
     * unset(ref: CredentialRef): Promise<void>
     * ```
     *
     * ⇒ 序列化要自己做（`JSON.stringify` / `JSON.parse`），且 ref 要过
     * `credentialRef(refName)` 转一下（从 `@deepseek-ai/dsh-credentials` 导入）。
     * ⚠️ 别自己发明 `read` / `write` 两个方法名 —— 那与宿主接口不匹配，`ctx.credentials` 直接風在类型上。
     */
    readonly store?: {
        resolve(ref: CredentialRef): Promise<{
            value: string;
        } | undefined>;
        set(ref: CredentialRef, value: string): Promise<void>;
        unset(ref: CredentialRef): Promise<void>;
    };
    /**
     * 注入的浏览器 User Data 根目录（**单测专用**，见 `magicrew-local-browser.ts`）。
     *
     * ⚠️⚠️ 缺省时扫**真实**浏览器目录 —— 单测若不注入就会读到开发机上用户的真实
     * 登录态（用例结果随机器而变，还会泄漏真实凭据）。本字段存在的唯一目的就是
     * 「用例传临时目录」。
     */
    readonly browserRoots?: readonly string[];
    /**
     * 网页版登录的**会话工厂**（注入点，单测专用 —— 绝不真起浏览器）。
     *
     * ## ⚠️⚠️ 为什么必须是 auth 层的注入点（而不是让单测调 `startMagicrewBrowserLogin`）
     *
     * `loginViaBrowser` 是**完整的一条登录腿**（开窗 → 等用户 → 签发 key → 落库），
     * 而它最容易错的两个判据都在**外面**：① 签发的**次数**（多签一次就吊销了在用的
     * key）；② 写回的 ref（写错就是「凭据在、账号读不到」）。这两条只有把整条腿
     * 跑一遍才能断言 —— 若工厂不可注入，用例就只能真起一个浏览器窗口（本仓库已
     * 记过两次「单测弹出真实浏览器窗口」的污染）。
     *
     * ⚠️ 缺省 = `startMagicrewBrowserLogin`（真起浏览器）。**不要**把它换成
     * 「测试里也安全」的假实现：那样生产路径就再没有用例覆盖了。
     */
    readonly browserLoginFactory?: (options?: {
        product?: MagicrewProduct;
        timeoutMs?: number;
    }) => Promise<MagicrewBrowserLogin>;
    /**
     * 账号资料（昵称）取数器 —— **注入点，单测专用**（缺省 = {@link fetchMagicrewProfile}）。
     *
     * ⚠️ 为什么需要注入：两条登录腿都会在签发 key 之后取一次昵称，而那是**第二次网络
     * 往返**。不注入的话，「取昵称成功写进凭据」「取昵称失败不挡登录且留痕」这两条
     * 判据就只能靠真发请求或靠数 fetch 调用次数来断言（后者对 URL 极其敏感）。
     *
     * ⚠️ 缺省**必须**是真的取数器（不要塞一个「测试也安全」的空实现）：昵称这条路
     * 是本任务的正题，缺省假实现会让生产路径没有用例覆盖。
     */
    readonly profileFetcher?: (params: {
        jwt: string;
        organizationCode: string;
        product: MagicrewProduct;
    }) => Promise<MagicrewProfile>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        magicrewAuth: MagicrewAuth;
    }
}
/**
 * 账号池侧的续期入口（`index.ts` 的 `auths.magicrew` 用它）。
 *
 * ## ⚠️ 四条铁律（照 `AstudioAuth` 的既有口径，全部来自真实事故）
 *
 * 1. **续期成功后必须把新 `expiresAt` 写回账号池** —— 否则凭据续好了、
 *    界面纹丝不动，用户没有任何自救手段（issue !IKIRTT）。
 * 2. **`refreshAll` 只按凭据材料过滤**：不看 `enabled`（停用只影响自动选号，
 *    与「凭据该不该保持新鲜」无关 —— 按它过滤会让停用期间的 token 一路放到失效，
 *    用户重新启用后拿到死凭据），也不看池里的 `refreshable`（那是**对账结果**，
 *    拿它当门禁会把一次瞬时失败固化成**单向门**）。
 * 3. **串行**：走 {@link createMagicrewRefreshOnce}，不要自己 `await refreshMagicrewKey`。
 * 4. ⚠️⚠️ **`refreshAll` 必须带 lead-time 过滤**（`shouldRefreshNow(apiKeyExpiresAt)`），
 *    且**只有**这一层带：本家 `mgw_` key TTL 仅 **2 小时**、调度器 **30 分钟**一轮
 *    （`src/index.ts` 的 `REFRESH_INTERVAL_MS`），无条件续期等于每 2 小时窗口
 *    **白签 4 次**，而**签新 key 会吊销旧 key**（本文件头第 1 条硬约束）⇒ 轮换瞬间
 *    在途的推理请求可能拿到刚被吊销的 key。其余轮换型 provider 同样走
 *    `src/expiry-sync.ts:112` 的 `shouldRefreshNow`。
 *    ⚠️ 但**不能**把它挪进 {@link refreshAccountCredential}：那是
 *    `account.refresh`（用户点了按钮就要刷）的入口 —— 加进去等于按钮变哑的。
 *    ⚠️ 唯一的例外是**写回失败态**（`MagicrewRefreshState.staleRefreshToken` 非空）：
 *    此时凭据库里的 `expiresAt` 是上一轮的陈旧值，按它判会把这个账号的自愈推迟到
 *    库里那个时刻进入 lead 窗口（≤1 小时）⇒ `refreshAll` 对这类账号**跳过 lead-time 门**。
 */
export declare class MagicrewAuth extends Service {
    readonly product: MagicrewProduct;
    private readonly fetchImpl;
    private readonly warnImpl;
    private readonly store;
    /** 注入的浏览器 User Data 根目录（单测）；`undefined` = 扫真实浏览器目录。 */
    private readonly browserRoots;
    /** 网页版登录的会话工厂（单测注入；缺省真起浏览器）。 */
    private readonly browserLoginFactory;
    /** 账号资料（昵称）取数器（单测注入；缺省真发一次 GET）。 */
    private readonly profileFetcher;
    private readonly refreshOnce;
    /** 每账号一份在途状态（含最新 refresh_token）。 */
    private readonly states;
    /**
     * 登录态是否活跃。`stop()` / `logout()` 置 false，**阻止在途续期回写**。
     *
     * ⚠️ 为什么必须有：续期是**异步**的（一次网络往返）。用户中途登出或插件被停用时，
     * 那个在途请求回来若照常 `store.set` + `pool.updateAccount`，就会把凭据写回
     * 一个**已被删除/已登出**的账号（症状：删了账号又「复活」，或登出后仍能调用）。
     * 照 `astudio-auth.ts` 的同款（`:429` / `:926` / `:936`）。
     */
    private active;
    constructor(ctx: Context, options?: MagicrewAuthOptions);
    /**
     * 给凭据补上**上游昵称**（`credential.nickname`）。
     *
     * ## 调用时机：签发 gateway key **之后**
     *
     * 两条登录腿都在这之后调它。刻意放在签发那段的 `try/catch` **外面**：昵称只需要
     * `jwt` + `organizationCode`，与「key 签发成功没有」无关 —— 放在里面会让
     * 「签发失败（网关抖动）」顺带把昵称也丢掉，而那种情况下卡片本可以显示对的名字。
     *
     * ## ⚠️⚠️ 失败**不挡登录**，但**必须留痕**
     *
     * 昵称只是展示名：取不到时卡片回落「脱敏手机号 / 渠道名」，登录本身完全不受影响。
     * 但**不许静默** —— 本仓库记过「静默停摆、功能上线起一次都没成功过」的教训
     * （本文件里 `importFromLocalBrowser` / `loginViaBrowser` 的签发失败走同一条纪律）。
     *
     * ⚠️ 代价受 {@link MAGICREW_PROFILE_TIMEOUT_MS}（6 秒）约束，不给登录加长等待。
     */
    private withProfileNickname;
    /**
     * 读本账号的**展示昵称** —— `account.list` 的自愈回填用（2026-10-30）。
     *
     * ## 为什么要有这个公开入口（而不是让 RPC 层直接调 `fetchMagicrewProfile`）
     *
     * ⚠️ 必须与登录走**同一个注入点**（{@link MagicrewAuthOptions.profileFetcher}）：
     *    ① 单测要能注入假取数器（否则「回填」那条腿只能真发网络 ⇒ 不可测）；
     *    ② 超时与告警纪律只有这一份 —— 另起一条调用链必然与登录那条分叉
     *      （本仓库「一语义一套判据」的红线）。
     *
     * ⚠️ 读不到 ⇒ `undefined`，**不抛**：回填是尽力而为，调用方（`account.list`）
     *    不该因为一个展示名取不到而让整个列表失败。
     * ⚠️ 但仍然**留痕**（与 {@link withProfileNickname} 同一条纪律：不许静默 ——
     *    本仓库记过「静默停摆、功能上线起一次都没成功过」的教训）。
     */
    readProfileNickname(credential: {
        jwt: string;
        organizationCode: string;
    }): Promise<string | undefined>;
    /** 告警出口（`warnImpl` 优先，否则宿主 logger）。 */
    private warn;
    /**
     * 续期**指定账号**并写回账号池。
     *
     * ⚠️ `pool` 与 `accountId` **必须都传**（issue !IKIRTT 的修法）。
     */
    refreshAccountCredential(refName: string, pool: AccountPool, accountId: string): Promise<void>;
    /**
     * 批量续期该 provider 的**全部账号**（`src/index.ts` 的定时器/首轮入口）。
     *
     * ⚠️ 过滤口径见类注释第 2、4 条：**不看** `enabled` / `refreshable`，
     * **但要看 lead-time**（`shouldRefreshNow`）。
     */
    refreshAll(pool: AccountPool): Promise<void>;
    /** 登出：置非活跃，**阻止在途续期回写**（否则会把凭据写回一个已删的账号）。 */
    /**
     * 从本机浏览器读取已登录的凭据（**不开窗口**）。读不到 ⇒ `undefined`。
     *
     * ## 为什么需要它
     *
     * magicrew 没有 OAuth 回调：用户在自己浏览器里登录成功后，插件**收不到任何通知**
     * （那是另一个浏览器）。而凭据本来就明文躺在 Chromium 系的
     * `<User Data>/<Default|Profile N>/Local Storage/leveldb/` 里
     * ⇒ 直接读文件即可，既不用开窗口也不用让用户粘任何东西。
     *
     * ## 语义上这就是一次「登录」
     *
     * 读到 jwt 之后**签发一次 `mgw_` key**（与 {@link login} 同一条腿）：不签的话
     * 池里会出现一个「有账号、每请求都抛 `AUTH`」的幽灵条目（适配器缺 api_key 时
     * 恒抛「账号未登录或缺少 api_key」），用户只会看到「明明导入成功却不回复」。
     * 签发失败**不吞掉导入结果**（jwt 能拉目录 / 积分，api_key 可由续期或重登救回），
     * 但**不许静默** —— 走 `warn`（与 {@link login} 一字不差的纪律）。
     *
     * ⚠️ 签新 key 会吊销旧 key 是本家硬约束（模块头第 1 条）。这里等同「重新登录」，
     * 故仍在允许的范围内；但**不要在热路径上重试本方法**。
     *
     * ⚠️ 写回的 ref 是 {@link MagicrewProduct.defaultCredentialRef}（**不是**某个
     * `MAGICREW_ACCOUNT_*`）：账号 id / ref 由 `account.create` 分配，本方法只管
     * 「把这台机器上已登录的那份凭据取回来并落库」。
     */
    /** 手机原生登录回传/用户导入；只返回凭据，归属 ref 由 RPC 决定。 */
    importManualCredential(raw: unknown): Promise<MagicrewCredential>;
    importFromLocalBrowser(): Promise<MagicrewCredential | undefined>;
    /**
     * **网页版登录**：开一个独立 profile 的浏览器窗口 → 等用户在里面登完 →
     * 把凭据取回来（并签发一次 `mgw_` key）。
     *
     * ## 三条登录路径里的第 ② 条
     *
     * | # | 路径 | 门槛 | 方法 |
     * |---|---|---|---|
     * | ① | 本机浏览器已登录态 | 零 | {@link importFromLocalBrowser} |
     * | ② | **网页版登录（本方法）** | 低（开窗，用户自己登） | 本方法 |
     * | ③ | 手机号 + 密码 | 要密码 + 上游风控 | **已下线**（见 `jet-hub-rpc.ts`） |
     *
     * ② 存在的理由：①在「用户从没在本机浏览器登过这个站」「用户用的是另一个
     * profile」两种情形下读不到，而它与「没登录」在结果上同形；③要用户交出密码、
     * 且参考实现里那条 `phone_password` 是**零调用者**的探索代码。
     * ② 是唯一「用户看着官方页面自己登、凭据自然落盘」的路径。
     *
     * ## ⚠️⚠️ 成功后**必须**签发一次 `mgw_` key（与 ① 同一条腿）
     *
     * 本仓库适配器在 `credential.apiKey` 缺失时**恒抛** `AUTH`
     * 「超级麦吉账号未登录或缺少 api_key，请重新登录」⇒ 只落 jwt 的池条目 =
     * 「登录成功但每请求都不回复」的**幽灵账号**，用户只会以为插件坏了。
     * 派生细节逐条同 {@link importFromLocalBrowser}（签发失败**不吞掉**结果、
     * 只 warn —— jwt 能拉目录 / 积分，api_key 可由续期救回）。
     *
     * ## 返回 `undefined` 的两种情形（都**不是**错误）
     *
     * 1. 用户在 `timeoutMs` 内没登完（关掉了窗口 / 还在输密码）；
     * 2. 用户在等的时候插件被停用（{@link stop}）—— 见下面的 `isStopped` 闸门。
     *
     * ⚠️ 调用方**不得**把 `undefined` 当失败弹错：那是**正常的「还没登完」**。
     * 真正失败（浏览器起不来 / 签发网络异常）才抛错，且文案可读。
     *
     * ⚠️ `close()` 在 `finally` 里 —— 不调就会留下一个可见的浏览器窗口 + 200-400MB
     * 的进程树（`ChromiumSession.dispose()` 里那套 `taskkill /T` 才是唯一正确的收法）。
     */
    loginViaBrowser(options?: {
        timeoutMs?: number;
    }): Promise<MagicrewCredential | undefined>;
    /**
     * 读本机浏览器里的凭据（纯读，无网络）。
     *
     * ⚠️⚠️ **先试网页 origin、再试 API host**：localStorage 的 key 是
     * `_https://<origin>\x00\x01<name>`，而 magicrew 的网页在 `www.letsmagic.cn`、
     * API 在 `i-magic-service.letsmagic.cn`（`product.host`）—— 用户登录发生在
     * **网页**那个 origin 上 ⇒ 只按 `product.host` 找会**恒读不到**（且完全静默）。
     * 两个都试，谁命中用谁。
     */
    private readLocalBrowserCreds;
    /** 候选站点 host（网页 origin 优先，见 {@link readLocalBrowserCreds}）。 */
    private localBrowserHostnames;
    logout(): Promise<void>;
    /** 插件被停用时调用（与 {@link logout} 同因）。 */
    stop(): void;
    /**
     * 拉目录（供适配器注入 `fetchRemoteModels`）。
     *
     * ⚠️ 任务 3b 刻意省略过它（当时 `magicrew-catalog.ts` 还不存在），4a 该文件已落地
     * ⇒ 4d 加回。**参数是显式的 `jwt` + `organizationCode`**（不是「读当前凭据」）：
     * 目录是**按账号**下发的，调用方必须能指定用哪个账号的 jwt；这也让单测可以
     * 完全不碰凭据库（零真实凭据）。
     *
     * ⚠️ 动态 `import()` 是刻意的：`magicrew-catalog.ts` 只在**真的拉目录**时才需要，
     * 而本文件在插件启动路径上。
     */
    fetchCatalogModels(jwt: string, organizationCode: string): Promise<readonly import("./magicrew-catalog.js").MagicrewCatalogModel[]>;
    /** 读当前凭据（账号池未提供 ref 时用默认 ref）。 */
    currentCredential(refName?: string): Promise<MagicrewCredential | undefined>;
    /** 凭据库：注入的替身优先，否则用宿主 `ctx.credentials`（与 `astudio-auth.ts:451` 同款）。 */
    private storeFor;
    /** 取（或建）某 ref 的续期状态 —— 让最新 refresh_token 在内存里只有一份。 */
    private stateOf;
}
//# sourceMappingURL=magicrew-auth.d.ts.map