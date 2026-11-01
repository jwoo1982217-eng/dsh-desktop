/**
 * MiniMax **国际站**的账号出口代理端点。
 *
 * ## 缺陷背景
 *
 * `agent.minimax.io` 按**出口 IP 所在国家**分流：中国大陆来源会被 307 到中国站
 * `agent.minimaxi.com`，而中国站不认国际站 token ⇒ 与「凭据失效」**逐字同形**
 * 的 401（issue IKMEVG）。既有的 `X-Forwarded-For` 只**声明**一个海外 IP
 * （上游不信任该头即失效），真正换出口要靠代理。
 *
 * ## 为什么单独成文件（而不是塞进 `jet-hub-rpc.ts` 的 `switch`）
 *
 * ① **前缀分流**：`minimaxintl.*` 需要与 `opencode.*` / `gemini.*` 一样在主
 *    switch **之前**被试一次（理由见 `opencode-rpc.ts` 模块头：Jet Hub 只有
 *    一条 RPC 通道，主 switch 的 `default` 会把不认识的方法报成
 *    `unknown method`，**不让路**）；
 * ② **形状同构**：setProxy / testProxy 与 opencode / gemini 的同名端点
 *    **逐字段同构**，抄第三份会漂移（AGENTS.md 的第一条红线）。
 *
 * ⚠️ 但**实现不复用它们的分派表**：那两份绑的是各自的池字段与 provider id，
 * 本家要写 `setMinimaxIntlProxy` / `minimaxintl`。复用的是**判据与措辞**
 * （`normalizeProxy` / `describeFetchError`），不是那份表。
 *
 * ## ⚠️⚠️ 「测试连接」的判据：必须能区分「通」与「通了但仍在大陆」
 *
 * 这里**不**照抄 opencode 打出口 IP 服务（那只能证明代理本身可用），也**不**
 * 照抄 gemini 只判「拿到 HTTP 状态码」（那对本家是不够的）：
 *
 * - 本家的失败模式不是「连不上」，而是**连得上却被 307 到中国站**；
 * - 若只报「HTTP 307 = 通」，用户看到绿色以为配好了，实际照样 401 ——
 *   这正是 gemini 模块头记的那种**假阳性**。
 *
 * ⇒ 探测打**国际站自己的目录端点**（公开，无 token 也回 200），并且用
 * `redirect: 'manual'` **不跟随**，以便观测 `Location`：
 *
 * | 观测 | 结论 |
 * |---|---|
 * | 非 3xx 的 HTTP 响应 | ✅ 出口已在海外（未被分流） |
 * | 3xx 且 `Location` 指向 `*.minimaxi.com`（中国站） | ⚠️ 代理能通，但出口**仍被判为大陆** |
 * | 拿不到任何 HTTP 响应 | ❌ 代理不通 |
 *
 * ⚠️ 为什么用目录端点：它无需凭据即可回 200（本机实测），所以「测试」按钮
 * 不消耗任何凭据、也不会烧掉用户的 refresh_token —— 本仓库在 MiniMax 上
 * 有过「诊断脚本对真实凭据发起 refresh 而烧掉账号」的事故，此后凡是探测
 * 一律不得碰凭据。
 */
import type { Context } from '@deepseek-ai/cordis';
export interface RpcMinimaxIntlProxyRequest {
    accountId: string;
    proxy: string;
}
export interface RpcMinimaxIntlProxyResponse {
    proxy: string;
    label: string;
}
export interface RpcMinimaxIntlTestProxyRequest {
    proxy: string;
}
export interface RpcMinimaxIntlTestProxyResponse {
    /** 目标端点回的 HTTP 状态码（任何状态码都证明链路通）。 */
    status: number;
    latencyMs: number;
    /**
     * 出口**是否仍被判定为中国大陆**（上游把请求 307 到了中国站）。
     *
     * ⚠️ `true` 时本端点**仍然返回成功**（连接是通的）—— 但 UI 必须把它
     * 显示成警告而不是绿色：这是用户真正想问的那个问题的答案。
     */
    geoRouted: boolean;
}
/** 账号池的最小依赖面（结构化类型，避免绑定具体类）。 */
export interface MinimaxIntlPoolLike {
    setMinimaxIntlProxy(accountId: string, proxy: string): Promise<void>;
}
/**
 * 处理一个 `minimaxintl.*` RPC 方法。
 *
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（同 `opencode-rpc.ts` 的契约：
 *          对未知方法回信封会把别的 provider 的方法名误判成「格式错误」）。
 */
export declare function handleMinimaxIntlRpc(_ctx: Context, pool: MinimaxIntlPoolLike, method: string, payload: unknown): Promise<unknown>;
//# sourceMappingURL=minimax-rpc.d.ts.map