/**
 * MiniMax 账号身份读取（Gitee issue IKP8UA）。
 *
 * ## 为什么不从 token 里解
 *
 * MiniMax 的 `access_token` **不是 JWT**（`mmoat_` 前缀、60 字符、**0 个点**），
 * 而原昵称判据走的是 `decodeJwtSub(accessToken)` ⇒ **恒 undefined** ⇒
 * 账号卡片恒退化为插件内部 id（`minimax-6395cf64`），多账号时无法分辨。
 *
 * 登录响应体本身也**不含身份**（实测字段全集：`access_token` / `expires_in` /
 * `refresh_token` / `scope` / `token_type`）⇒ 必须**另查一个端点**。
 *
 * ## 端点（真机实测定位，2026-10-23）
 *
 * ```
 * GET {apiHost}/v1/api/user/info?device_platform=web&biz_id=3
 * Authorization: Bearer <access_token>
 * ```
 *
 * 只需 Bearer —— **不需要**官方客户端那套 `yy` / `x-timestamp` / `x-signature` 签名头。
 *
 * ## ⚠️⚠️ 判据为什么落在 `name` 非空，而不是 `statusInfo` 无错码
 *
 * 两站的**参数缺失失败形态完全不同**（实测矩阵）：
 *
 * | 情形 | 国内站 | 国际站 |
 * |---|---|---|
 * | 参数齐全 | 200、`code=0`、`name="MiniMax909127"` | 200、`code=0`、`name="8fsmz"` |
 * | **缺 `biz_id=3`** | 200、`code=1200019`、`userInfo` **整块缺失** | 200、**`code=0`**、但 `name=""`、`userID` 变成**另一个值**、`realUserID="0"` |
 * | 缺 `device_platform=web` | 400、`code=2` | 400、`code=2` |
 *
 * ⇒ 只看 `statusInfo.code === 0` 时，**国际站缺 `biz_id` 会被判成功**，
 *   而它给出的是空名字 —— 显示空白比显示内部 id 更糟。
 * ⇒ 故判据是 **`userInfo.name` 非空**（且 `statusInfo` 无错码，作为国内站那道）。
 *
 * ## ⚠️⚠️ 国际站必须带 `X-Forwarded-For`
 *
 * `agent.minimax.io` 对**所有**路径按请求来源 IP 的**国别**返 `307 → agent.minimaxi.com`
 * （Akamai 判定，见 `src/minimax.ts` 的 `withMinimaxXff`）。大陆出口**恒 307**，
 * 而 fetch 跨 origin 跟随会剥掉 `Authorization` ⇒ 第二跳无凭据 ⇒ **401**。
 *
 * 实测（2026-10-23，本机真实国际站凭据）：
 *
 * ```
 * 仅 Bearer            → 307 → agent.minimaxi.com → 401
 * XFF=114.114.114.114  → 307 → 同上 → 401        ← 中国 IP 照样被踢
 * XFF=8.8.8.8 / 1.1.1.1 → 200（不重定向）name="8fsmz"   ✅
 * ```
 *
 * ⇒ 传输必须走 `minimaxFetch`（它保凭据跟随重定向 + 传输级重试），
 *   头必须经 `minimaxHeadersFor`（**只对国际站**附 XFF）。
 *
 * ⚠️ **拿不到身份不是错误**：昵称是展示信息，失败一律返回 `undefined`，
 *    由调用方退回内部 id（与 qoder 的 `fetchQoderUserNickname` 同原则）。
 */
import type { MinimaxCredential } from './minimax.js';
import type { MinimaxProduct } from './minimax-product.js';
/**
 * 身份端点的路径（**不带 query**）。
 *
 * ⚠️ 两个 query 参数是**必需**的，缺任一都会失败（真机逐项消融实测，12 组）：
 * - 缺 `device_platform=web` ⇒ **400 / `code=2`**（`userID参数错误`）；
 * - 缺 `biz_id=3` ⇒ 200 但**数据是错的**（见模块头的矩阵）。
 *
 * 而 `app_id` / `version_code` / `is_desktop` / `client` / `unix` 均可省。
 */
export declare const MINIMAX_USERINFO_PATH = "/v1/api/user/info";
/** 读到的账号身份。 */
export interface MinimaxUserIdentity {
    /** 展示用账号名（**保证非空** —— 空名一律判为「没读到」）。 */
    name: string;
    /** 上游 `userID`（排障用；不用于展示，因为它同样不可读作人话）。 */
    userId?: string;
}
/**
 * 解析身份响应。
 *
 * ⚠️ 形状容忍（两站/两种信封都见过）：业务载荷在 `data.userInfo`，
 *    但**不排除**将来平铺到顶层 `userInfo` ⇒ 两处都看，**先 `data` 后顶层**
 *    （与 `minimax-credits.ts` 的 `unwrapEnvelopeData` 同取向）。
 *
 * ⚠️ **`statusInfo` 有非零 `code` ⇒ 直接判取不到**：国内站缺 `biz_id` 就是
 *    靠这一条拦住的（`code=1200019` 且 `userInfo` 整块缺失）。
 *    而国际站那条 `code=0` 的坏数据由下面的 **`name` 非空** 拦住 ——
 *    两道判据缺一不可（各挡一个站）。
 */
export declare function parseMinimaxUserIdentity(payload: unknown): MinimaxUserIdentity | undefined;
/**
 * 读一次账号身份。
 *
 * @param credential 凭据（只需 `access_token`）。
 * @param fetcher 注入的 fetch（单测用；缺省全局）。
 * @param product 产品（决定 `apiHost` 与**是否附 XFF**）。
 * @param xff 国际站绕地理分流用的来源 IP（用户设置值；国内站**忽略**）。
 * @returns 身份；**任何失败都返回 `undefined`**（不抛错）。
 */
export declare function fetchMinimaxUserIdentity(credential: MinimaxCredential, fetcher: typeof fetch | undefined, product: MinimaxProduct, xff?: string): Promise<MinimaxUserIdentity | undefined>;
//# sourceMappingURL=minimax-identity.d.ts.map