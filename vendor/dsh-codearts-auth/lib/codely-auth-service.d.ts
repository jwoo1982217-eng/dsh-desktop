/**
 * Codely 的 auth 服务对象（供 `JetHubAuths` 与 `auth.refreshAll` 接线）。
 *
 * ## 为什么需要它
 *
 * `channel: true` 会把 Codely 纳入三张派生判据（应有 auth / 应可续期 /
 * 应进聚合目录）。其中「续期分派」要求 `authOf(auths, 'codely')` 返回一个
 * **带 `refreshAccountCredential` 的对象**，否则该渠道永不自动续期且日志零字
 * （issue IKKHL5 的形态）。
 *
 * ## 续期语义（2026-10-20 实测）
 *
 * Codely 有两层凭证：
 * - `access_token`：登录态（JWT，约 365 天），**可续期** ——
 *   `POST /auth/refresh {refresh_token}` → `{access_token, refresh_token}`，
 *   ⚠️ `refresh_token` **不轮换**（连续三次调用返回同值，实测）；
 * - `cli_api_key`：推理用（`sk-…`），**每次调用换发、无需缓存**
 *   （`fetchCodelyCliApiKey`）⇒ 本服务**不续期它**。
 *
 * ⇒ 「续期」只刷新 `access_token`，成功后写回凭据库。
 */
import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
/** 凭据库最小接口（与 `readCodelyCredential` 同形）。 */
interface CredentialStoreLike {
    resolve(ref: string): Promise<{
        value?: string;
    } | undefined>;
    set(ref: string, value: string): Promise<void>;
}
/**
 * 用 `refresh_token` 换新的 `access_token`。
 *
 * ⚠️ 不需要 Bearer（实测：只带 JSON 头 + 身份头即可）；
 * ⚠️ 失败返回 `undefined`（调用方在续期路径上，抛错会被误报成"凭据失效"）。
 */
export declare function refreshCodelyCredential(refreshToken: string, options?: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
}): Promise<{
    accessToken: string;
    refreshToken: string;
} | undefined>;
/**
 * Codely 的 auth 服务（`JetHubAuths.codely` 的值）。
 *
 * 刻意只做「续期 access_token + 写回凭据库」两件事：`cli_api_key` 是派生品、
 * 每请求换发，不需要缓存，也不需要回写池（池里的 `expiresAt` 跟随 access_token）。
 *
 * ## ⚠️⚠️ 为什么必须 `extends Service`（2026-10-22 A6）
 *
 * 它原来是个裸类（不继承 `Service`），而本仓库的“按 id 取 auth 实例”路径
 * 均按 `${product.id}Auth` **服务名**从 `ctx` 上取（`account.refresh` 的分派、
 * `jet-hub-rpc-auth-wiring.spec` 的逐家点名、`provider-runtime` 的内存注册…）。
 * 不继承 `Service` 就意味着 cтx 上永远没有 `codelyAuth` ⇒ 下游全部取不到。
 *
 * ⚠️ 注意服务名是 **`codelyAuth`**（全小写，与 provider id 同形），不是
 * `CodelyAuth`：其余 13 家都是 `${product.id}Auth`，写成大写开头会让
 * `AUTH_SERVICE` 表与实际服务名不一致。
 */
export declare class CodelyAuth extends Service {
    private readonly options;
    constructor(ctx: Context, options?: {
        credentials?: CredentialStoreLike;
        fetcher?: typeof fetch;
        /** 回写池条目有效期（可选；缺省不写，保持"尽力而为"）。 */
        writebackExpiry?: (accountId: string, expiresAtMs: number | undefined) => Promise<void>;
    });
    /**
     * 记一条 warn。
     *
     * ⚠️ 为什么裹这么多可选链 + try：cordis 的 `ctx.logger` 在测试桩里可能整个不存在，
     *    而这里只是想留一条排查线索 —— 因为打日志把续期流程打崩，比不打日志糟得多。
     */
    private warn;
    /**
     * 续期某一个账号（守卫要求的方法）。
     *
     * @param refName 凭据 ref（`codely.account.<id>` 之类，直接交给凭据库）
     * @param _accountId 池里的账号 id（用于可选的池回写）
     *
     * ## ⚠️ 三处早退拆成**四条** warn（2026-10-24 补，2026-10-31 审计修正计数）
     *
     * 原来都是裸 `return`：凭据库没注入、读不到凭据、凭据在但没有 refresh_token、
     * 上游续期失败 —— 四种**性质完全不同**的原因在现象上完全一致 ——
     * 「续期永远不发生，日志零字」。这正是 A1/A5 那一轮要治的失效形态
     * （静默失败比报错更难查）。别家在同类早退会把账号标成不可续期
     * （`cline-auth.ts`）或至少记 warn（`modelscope-auth.ts`）。
     * ⚠️ 四条 warn 有行为守卫（`codely-auth-service.spec.ts` 的
     * 「续期早退必须留痕」describe），删掉任一调用点会红。
     */
    refreshAccountCredential(refName: string, _pool: unknown, accountId: string): Promise<void>;
    /**
     * 批量续期（`JetHubAuthLike.refreshAll` 契约的**单参**形式）。
     *
     * ## ⚠⚠ 为什么是单参（2026-10-22 对抗审计 A5 修）
     *
     * 旧签名是 `refreshAll(pool, refreshOne)`（2 个参数），而契约
     * （`src/jet-hub-rpc.ts` 的 `JetHubAuthLike`）要求的是 `refreshAll(pool)`（**1 个**）
     * —— 而且 `index.ts` 的注册循环根本**提供不了** `refreshOne`。
     *
     * 两条硬证据（实测）：
     * - **编译期**：把本类当 `JetHubAuthLike` 使用直接 **TS2322**（`Target signature
     *   provides too few arguments. Expected 2 or more, but got 1`）；
     * - **运行期**：按 `refreshAll: (pool) => auth.refreshAll(pool)` 包一层调用就招
     *   `TypeError: refreshOne is not a function`，而该异常会被外层逐 provider
     *   的 `try` 吞成一条 warn ⇒ **续期恒不发生且日志几乎零字**（officeace 那条「把同步池当 Promise」同型）。
     *
     * ⇒ 改法：与 `accio-auth.ts` / 其余各家**同一形状** —— 内部自己遍历池、逐个调
     *   `refreshAccountCredential`（那就是本类自己的方法）。
     *
     * ⚠️ 读池抛错 / 空池 ⇒ 静默返回（一个渠道的池抖动不该让整轮续期炸掉）。
     * ⚠️ 必须逐个走 `refreshAccountCredential`（**不能直接调裸函数**）：否则池里的
     *   `expiresAt` 不回写，界面有效期停在旧值（officeace 记过同款缺陷）。
     */
    refreshAll(pool: unknown): Promise<void>;
}
export {};
//# sourceMappingURL=codely-auth-service.d.ts.map