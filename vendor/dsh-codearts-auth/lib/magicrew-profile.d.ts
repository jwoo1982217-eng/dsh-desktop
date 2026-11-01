/**
 * Magicrew（超级麦吉）**账号资料**：昵称 / 真实姓名 / 手机号。
 *
 * ## 为什么必须有这个模块（真机报障 2026-10-29）
 *
 * 账号卡片把「超级麦吉」当昵称显示，而用户自己的昵称是 `Nick`。原因不在渲染层：
 * `magicrewDisplayNickname` 只能看到凭据里的 `phone`，而**浏览器登录**那条腿落库的
 * 凭据里既没有 `phone` 也没有任何展示名 ⇒ 恒回落 `product.displayName`（=「超级麦吉」）。
 *
 * 昵称只在上游这一个端点里，所以登录时得**主动取一次**（见 `magicrew-auth.ts` 的
 * `withProfileNickname`）。
 *
 * ## 报文（用户真实凭据实测，2026-10-29）
 *
 * ```http
 * GET {host}/api/v1/contact/accounts/me/users
 * authorization: Bearer <jwt>
 * organization-code: <org>          ← ⚠️ **两个头都要**，缺一个读不到
 * ```
 *
 * ```json
 * { "code": 1000, "data": { "items": [
 *   { "nickname": "Jet", "real_name": "Jet", "phone": "…", "status": … }
 * ] } }
 * ```
 *
 * ⚠️⚠️ **`/api/v1/contact/accounts/me`（不带 `/users`）实测 404** —— 别用那个地址。
 *
 * ## ⚠️ 两种形状都要认（`data.items` 不保证是数组）
 *
 * 参考实现 magpie 的 `fetchWho`（`api.mjs:518-529`）写的是
 * `body?.data?.items ?? body?.data ?? {}` ⇒ 上游可能把**单个对象**直接放在 `items`，
 * 也可能把条目直接放在 `data`。三者都认，且**都不猜**：一个都取不到就抛。
 *
 * ## ⚠️ 取名字的优先级与 magpie 不同（刻意）
 *
 * magpie 的展示优先级是 `phone || email || nickname || real_name`（它要的是「人能认出的
 * 一串字符」）；本模块的产物是**卡片昵称的唯一来源**，故只保留「真实名字」这一路：
 * `nickname → real_name`，**不含 phone**（脱敏手机号由 `magicrewDisplayNickname`
 * 在**没有昵称时**兜底，两处合起来才等于 magpie 的那条链 —— 且它比 magpie 更克制：
 * 不会把一个 10 位本地号当昵称显示）。
 *
 * ⚠️ 上游的 `phone` 是**本地号码（实测 10 位）**，不是 11 位 ⇒ **不要**把它写进
 * `MagicrewCredential.phone`：那条字段的消费者是 `magicrewDisplayNickname` 的
 * 11 位脱敏判据（`/^\d{11}$/`），填进去只会得到一个错位的掩码串。
 */
import { type MagicrewProduct } from './magicrew-product.js';
/** 账号资料端点（⚠️ **带 `/users`**；不带的那条实测 404）。 */
export declare const MAGICREW_PROFILE_PATH = "/api/v1/contact/accounts/me/users";
/** 一个账号的资料。三个字段都归一成字符串（缺失 = 空串，不编造）。 */
export interface MagicrewProfile {
    /** 展示昵称（`nickname`，缺失时回落 `real_name`）。 */
    readonly nickname: string;
    /** `real_name`（上游可能不返回 ⇒ 空串）。 */
    readonly realName: string;
    /** 上游本地号码（**10 位**，仅展示参考；本插件不写进凭据）。 */
    readonly phone: string;
}
/**
 * 读本账号的资料。**拿不到 ⇒ 抛**（不静默降级成「没有昵称」）。
 *
 * ⚠️ 失败语义刻意是**抛**（`magicrew-credits.ts` 的两处取数是「返回 undefined / 空对象」）：
 * 那个契约属于「不该挡住列表」的**展示**取数；这里是**登录**路径上的一次主动取数，
 * 调用方（`MagicrewAuth.withProfileNickname`）必须能区分「上游说没有昵称」与
 * 「我们根本没读到」—— 后者要留痕（本仓库已记过「静默停摆、功能上线起一次都没成功过」
 * 的教训），前者只该安静回落。
 */
export declare function fetchMagicrewProfile(params: {
    jwt: string;
    organizationCode: string;
    product: MagicrewProduct;
    fetchImpl?: typeof fetch;
}): Promise<MagicrewProfile>;
//# sourceMappingURL=magicrew-profile.d.ts.map