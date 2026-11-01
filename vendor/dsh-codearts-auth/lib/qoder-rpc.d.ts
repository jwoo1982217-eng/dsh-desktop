/**
 * Qoder 的**账号出口代理**端点（真实报障 2026-10-21）。
 *
 * ## 缺陷背景
 *
 * Qoder 国际版全部端点（`openapi.qoder.sh`）在本机被 **SNI 阻断** ——
 * TCP 443 能握手（93ms），但 TLS ClientHello 被丢弃，`fetch` 恒 10.7s
 * `UND_ERR_CONNECT_TIMEOUT`。而**中国版**（`openapi.qoder.com.cn`）直连
 * 只要 160ms 就通。
 *
 * ⇒ 出口只能**按账号**配。配不了代理的症状是三层叠在一起：
 * ① 推理 `TRANSPORT: fetch failed`；② 余额恒 `null`（面板「一直读取中」二十秒
 * 后报「积分查询失败」）；③ 锁定状态下永远报「无法确认是否有可用账号」。
 * 三层里没有一层能让用户猜到「这个渠道在墙外」。
 *
 * ## 为什么单独成文件（而不是塞进 `jet-hub-rpc.ts` 的 `switch`）
 *
 * 与 `gemini-rpc.ts` 逐字同因：
 * ① **前缀分流**：`qoder.*` 需要与 `opencode.*` / `gemini.*` 一样在主 switch
 *    **之前**被试一次（Jet Hub 只有一条 RPC 通道，主 switch 的 `default`
 *    会把不认识的方法报成 `unknown method`，**不让路**）；
 * ② **形状同构**：setProxy / testProxy 与 opencode / Gemini 的同名端点
 *    **逐字段同构**，抄三份必漂移（AGENTS.md 第一条红线）。
 *
 * ⚠️ 但**实现不复用 `handleGeminiRpc`**：它绑的是 `setGeminiProxy` /
 * `GEMINI.id`，而 Qoder 要写 `setQoderProxy` / `product.id`（见 `AccountPool`
 * 里两套方法的注释：语义不同，不可合并）。复用的是**判据与措辞**
 * （`normalizeProxy` / `describeFetchError`），不是那份分派表。
 *
 * ## ⚠️ 为什么「测试代理」打的是 Qoder 自己的余额端点
 *
 * Gemini 那份打 `oauth2.googleapis.com/token`（任何请求都回 HTTP，拿到状态码
 * 即证明链路通）。这里**更进一步**打 `QODER_USAGE_PATH`：它需要真 Bearer
 * 才回 200，但不带 Token 也会回 **401** —— 同样证明「TCP + TLS + 代理握手
 * 全通」，且**目标一定是用户真正要访问的那台主机**。
 *
 * ⚠️ 用出口 IP 服务（`ip-api.com`）会产生假阳性：代理能通 ip-api 却仍被
 * 上游拒（DNS 污染 / 分流规则）⇒ 用户点「测试连接」看到绿色以为配好了，
 * 面板依然失败。opencode 打 ip-api 是因为它要展示出口地区，目的不同。
 */
import type { Context } from '@deepseek-ai/cordis';
export interface RpcQoderProxyRequest {
    accountId: string;
    proxy: string;
}
export interface RpcQoderProxyResponse {
    proxy: string;
    label: string;
}
export interface RpcQoderTestProxyRequest {
    proxy: string;
    /**
     * 要探测哪一站；省略时按 {@link QODER}（国际版）。
     *
     * ⚠️ **必须可指定**：两站的主机不同，而国际版被墙、中国版直连就通。
     * 只按国际版探测会让中国版用户看到「连不上」—— 那是探测目标错了，
     * 不是代理配错了。
     */
    provider?: string;
}
export interface RpcQoderTestProxyResponse {
    /** 目标端点回的 HTTP 状态码（证明链路通；401 也是「通」）。 */
    status: number;
    latencyMs: number;
    /** 探测打的主机，回给用户看一眼（两站不同）。 */
    host: string;
}
/** 账号池的最小依赖面（结构化类型，避免绑定具体类）。 */
export interface QoderPoolLike {
    setQoderProxy(accountId: string, proxy: string): Promise<void>;
}
/**
 * 处理一个 `qoder.*` RPC 方法。
 *
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（同 `opencode-rpc.ts` /
 *          `gemini-rpc.ts` 的契约：对未知方法回信封会把别的 provider 的
 *          方法名误判成「格式错误」）。
 */
export declare function handleQoderRpc(_ctx: Context, pool: QoderPoolLike, method: string, payload: unknown): Promise<unknown>;
//# sourceMappingURL=qoder-rpc.d.ts.map