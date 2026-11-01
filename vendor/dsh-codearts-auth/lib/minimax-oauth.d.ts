/**
 * MiniMax Code 的 OAuth **设备码 + PKCE** 登录流程。
 *
 * ## 为什么用设备码而不是本地回调
 *
 * 官方桌面端就是这么登的（asar `@mavis/oauth-core`），我们复刻它：
 * 申请设备码 → 用户在浏览器完成授权 → 我们轮询换 token。
 * **不起本地监听端口**（与 Qoder 同型，与 buddy/lobsterai 不同）。
 *
 * ## ⚠️ 最容易踩的坑：`pending` 是 **HTTP 200**
 *
 * OAuth 标准的设备码轮询用 **400 + `error=authorization_pending`** 表示「还在等」，
 * 而 MiniMax 的账号服务用 **200 + `status=pending`**。
 * 只认标准形态会**立刻抛错**，用户来不及授权。
 * 故**两种形态都必须认**（asar `oauth-client.js:70-114` 也是分开处理的）。
 */
import { type MinimaxProduct } from './minimax-product.js';
import { type MinimaxCredential } from './minimax.js';
/** 用户拒绝授权。 */
export declare class MinimaxLoginCancelledError extends Error {
    constructor(message?: string);
}
/** 设备码过期。 */
export declare class MinimaxLoginExpiredError extends Error {
    constructor(message?: string);
}
/** 设备码授权会话。 */
export interface MinimaxDeviceAuthorization {
    deviceCode: string;
    codeVerifier: string;
    userCode: string;
    verificationUri: string;
    /** 含 `user_code` 的完整授权链接（**优先用它**，用户点开即完成）。 */
    verificationUriComplete: string;
    expiresInSec: number;
    /** ⚠️ 单位是**秒**（asar 里有一处 `/1000` 换算，仅用于 `user_code` 轮询分支）。 */
    intervalSec: number;
}
/** 构造设备码请求体（PKCE S256）。 */
export declare function buildMinimaxDeviceCodeBody(codeChallenge: string, product?: MinimaxProduct): URLSearchParams;
/** 构造轮询请求体。 */
export declare function buildMinimaxPollBody(auth: MinimaxDeviceAuthorization, product?: MinimaxProduct): URLSearchParams;
/** 构造续期请求体。 */
export declare function buildMinimaxRefreshBody(refreshToken: string, product?: MinimaxProduct): URLSearchParams;
/** 解析设备码响应；形状不对返回 undefined。 */
export declare function parseMinimaxDeviceAuthorization(payload: unknown): MinimaxDeviceAuthorization | undefined;
/**
 * 解析令牌响应（轮询与续期共用）。
 *
 * 硬校验（照 asar `parseTokenGrant`，不满足即抛）：
 * - `access_token` 非空
 * - `refresh_token` 非空（缺失时回退上一个）
 * - `token_type.toLowerCase() === 'bearer'`
 * - `expires_in` 是正数
 * - **`scope` 必须含产品声明的 scope**（默认 `agent.default`）
 */
export declare function parseMinimaxTokenGrant(payload: unknown, previousRefreshToken?: string, product?: MinimaxProduct): MinimaxCredential;
/** 生成 PKCE code_verifier / code_challenge。 */
export declare function createMinimaxPkce(): {
    codeVerifier: string;
    codeChallenge: string;
};
/** 申请设备码。 */
export declare function startMinimaxDeviceAuthorization(fetcher?: typeof fetch, product?: MinimaxProduct): Promise<MinimaxDeviceAuthorization>;
/** 轮询选项。 */
export interface PollMinimaxOptions {
    fetcher?: typeof fetch;
    /** 可注入的 sleep（测试用）。 */
    sleep?: (ms: number) => Promise<void>;
    /** 可注入的时钟（测试用）。 */
    now?: () => number;
    signal?: AbortSignal;
    product?: MinimaxProduct;
}
/**
 * 轮询直到拿到令牌。
 *
 * ⚠️ **两种「还在等」的形态都要认**（见文件头注释）。
 */
export declare function pollMinimaxDeviceToken(auth: MinimaxDeviceAuthorization, options?: PollMinimaxOptions): Promise<MinimaxCredential>;
/**
 * 续期。
 *
 * ⚠️⚠️ **失败必须抛结构化错误**（2026-10-27 审计修）：
 * 修前是裸 `new Error('MiniMax 续期失败：' + error)` —— 状态码只在文案里，
 * 而上游的终态判据只能靠 message 正则，于是 `503` 报文里出现 `expired`
 * 就把健康账号判死（详见 `refresh-failure.ts` 模块头的三条实测）。
 * 现在用 {@link refreshFailureFromResponse} 把 `status` + OAuth `error` 带出来，
 * 判据读结构化字段而不是捞词。
 *
 * ⚠️ **传输层失败原样上抛**（不包装）：`fetch` 抛的 `TypeError('fetch failed')`
 * 真因在 `cause` 链上（`certificate has expired` 等），包装会丢 cause
 * ⇒ 判据的「先排传输层」那一步失效。`isRefreshTransportFailure` 沿 cause 链读码。
 */
export declare function refreshMinimaxCredential(refreshToken: string, fetcher?: typeof fetch, product?: MinimaxProduct): Promise<MinimaxCredential>;
/**
 * 把上游 `/oauth2/device/authorize` 的 `login_url` **钉死**成「只允许回到本授权页」，
 * 并解析成绝对 URL。
 *
 * ## 上游给了什么（实测形态，2026-10-24）
 *
 * ```
 * GET /oauth2/device/authorize?user_code=QJNX-CZXV      # 不带 cookie
 * 401 {"error":"login_required",
 *      "login_url":"/unified-login?login_redirect=%2Foauth-authorize%3Fclient_id%3Dmcode-public%26user_code%3DQJNX-CZXV"}
 * ```
 *
 * 即上游**已经**把 `login_redirect` 拼好了。那本函数为什么还要重拼一遍？因为
 * 直接把服务端字符串塞进 `window.open` 等于**信任上游拼一个跳转目标**（开放重定向
 * 的经典面）。这里的判据是**白名单**而不是「看起来像」：
 *
 * 1. `login_url` 必须解析到**本站 origin**（否则返回 `undefined`，调用方退回原授权页）；
 * 2. 路径必须是 `/unified-login`；
 * 3. 其 `login_redirect` 必须是**本站**的 `/oauth-authorize` 且 `user_code` **等于**
 *    我们这次请求的那个 —— 三者齐备才接受；任一不满足就**自己拼**一份干净的。
 *
 * ⚠️ 最终产出的 `login_redirect` 由**本函数**重新编码（`URLSearchParams`），
 * 不拼接上游原文，避免二次编码/注入。
 *
 * @param loginUrl 上游下发的 `login_url`（可能是相对路径）。
 * @param accountHost 站点 origin（`product.accountHost`）。
 * @param expectedUserCode 本次的设备码 `user_code`（必须与回跳目标里的一致）。
 * @returns 绝对 URL；任何一项判据不过都返回 `undefined`（**不抛错**）。
 */
export declare function resolveMinimaxForcedLoginUrl(loginUrl: unknown, accountHost: string, expectedUserCode: string): string | undefined;
/**
 * 本地兜底拼法：不请求上游，直接合成「统一登录 → 授权页」的链接。
 *
 * ⚠️ 只在 {@link fetchMinimaxForcedLoginUrl} 失败时用。它**不依赖**上游把
 * `login_redirect` 拼对，故比「原样信任服务端字符串」更安全；代价是**少了
 * 上游那一跳的判据**（若将来 login_redirect 的语义变了，这里会静默失效）。
 * ⇒ 两条路径都在 `tests/unit/minimax-forced-login.spec.ts` 里各锁一条。
 */
export declare function buildMinimaxForcedLoginUrl(accountHost: string, userCode: string): string | undefined;
/**
 * 向服务端要一次「保证需要登录」的链接（**不触碰任何凭据**）。
 *
 * 请求刻意**不带 `credentials`/cookie**（Node 侧本来也没有 cookie jar），
 * 因此服务端恒回 `401 login_required` + `login_url` —— 这正是上游「切换账号」
 * 按钮背后的那一次请求。
 *
 * ⚠️ **任何失败都返回兜底链接**（`buildMinimaxForcedLoginUrl`），绝不抛错：
 * 拿不到「强制重新登录」不该让整个登录流程失败，退回原授权页即可。
 * 兜底也失败（`accountHost` 非法 / `user_code` 空）时才返回 `undefined`。
 *
 * @param authorization 本次设备码授权（用它的 `userCode` 与站点）。
 * @param fetcher 注入的 fetch（单测用）。
 * @param product 产品配置（决定 `accountHost`）。
 */
export declare function fetchMinimaxForcedLoginUrl(authorization: MinimaxDeviceAuthorization, fetcher?: typeof fetch, product?: MinimaxProduct): Promise<string | undefined>;
//# sourceMappingURL=minimax-oauth.d.ts.map