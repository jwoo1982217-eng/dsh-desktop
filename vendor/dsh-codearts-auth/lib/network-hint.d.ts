/**
 * 「连不上」的**统一判据**与**可操作提示**（跨 provider 共用一份）。
 *
 * ## 为什么要有这个文件
 *
 * 本仓库有多个 provider 的端点在墙外（Gemini 全部、Qoder 国际版、…）。
 * 它们失败时的**用户可见形态完全同形**：undici 把一切传输层失败压成一句
 * `TypeError: fetch failed`，真因（`UND_ERR_CONNECT_TIMEOUT` / `ENOTFOUND` …）
 * 只挂在 `cause` 链上。若各 provider 各写一份判据，必然出现：
 *
 * - 码表不一致 ⇒ 同一故障在一处报「代理」、在另一处报「凭据失效」；
 * - 文案不一致 ⇒ 用户从 A 渠道学会的处理方式在 B 渠道失效。
 *
 * 本仓库的红线是「**同一语义两套判据**」（见 `astudio-credits.ts` 的注释）——
 * 故判据与码表**只此一份**，文案由调用方按 provider 定制。
 *
 * ## ⚠️ 判据必须读 `cause` 链上的**错误码**，不能读 `message`
 *
 * `message` 恒为 `fetch failed`，用它判会把**所有**传输失败（含 5xx 之后的
 * 读体失败、代理认证失败）都算成「出不去」，于是真·服务端故障被误报成
 * 「你需要配代理」——比不报还糟。
 *
 * ## ⚠️ 这类错误**不要**归 `AUTH` / `QUOTA`
 *
 * 那两类码会连 message 一起吞掉（Issue IKLBSH 的复发形态），恰好把唯一
 * 指路文案吃掉。只能在「展示层」把它当**可读失败原因**返回。
 */
/**
 * 「出不去」的错误码表 —— **全仓唯一一份**。
 *
 * - `UND_ERR_CONNECT_TIMEOUT` / `UND_ERR_SOCKET`：undici 连不上（墙外典型形态，
 *   实测 Qoder 国际版 10.7s 后报这个）。
 * - `ENOTFOUND`：DNS 解析不到。
 * - `ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH`：明确连不上。
 * - `ECONNRESET`：**刻意收进来**。实测 qoder 国际版经 `node:https` 走时是
 *   `ECONNRESET`（19.2s），SNI 阻断的另一种表现；漏掉它会让同一台机器的
 *   同一故障在 fetch / https 两条路上得到相反结论。
 *
 * ⚠️ 与 `refresh.ts` 的 `isUnreachableNetworkError` **刻意不同**：那个是
 * 「是否拉长重试间隔」的判据，收 `ECONNRESET` 会把正常业务的重连也拉长到
 * 30 分钟。两者语义不同，**不合并**（见该函数的注释）。
 */
export declare const NETWORK_BLOCKED_CODE_RE: RegExp;
/**
 * 沿 `cause` 链收集全部错误码（去重、保序）。
 *
 * @returns 形如 `['UND_ERR_CONNECT_TIMEOUT']`；一个都没有时返回空数组
 *   （**不是** `undefined` —— 调用方据此区分「有码但不在表里」与「无码」）。
 */
export declare function collectCauseCodes(error: unknown): string[];
/**
 * 一个**失败目标**（`host` + 可选 `port`）。
 *
 * ⚠️ 存在的理由见 {@link collectRefusedTargets}。
 */
export interface NetworkTarget {
    /** 主机名或 IP（IPv6 已剥掉方括号）。 */
    host: string;
    /** 端口；报文里没带时为 `undefined`（如 `getaddrinfo ENOTFOUND host`）。 */
    port?: number;
}
/**
 * 沿 `cause` 链收集**失败目标**（去重、保序）。
 *
 * ## ⚠️ 为什么需要一个「目标」判据，而不只是一个布尔
 *
 * `ECONNREFUSED 127.0.0.1:7897` 与「墙外连不上」在
 * {@link NETWORK_BLOCKED_CODE_RE} 里是**同一类**（都算「出不去」），但**处置
 * 完全相反**：
 *
 * - 被拒绝的地址是**用户自己填的代理入口** ⇒ 那个端口上根本没有程序在监听
 *   ⇒ 该做的是「启动代理软件 / 核对地址与端口」；
 * - 被拒绝 / 解析不到的是**目标站点** ⇒ 该做的是「换出口 / 换网络」。
 *
 * 只用一个布尔判据必然把两者混成同一句话。**真实报障（2026-10-22）**：
 * 本机 Clash Verge 没启动、7897 无人监听，插件提示的却是「国际版在本机被
 * SNI 阻断（TCP 能连、TLS 握手被丢），必须配出口代理或改用中国版」——
 * 用户于是去查网络、换账号，而正确动作是「把代理软件打开」。
 * ⇒ 判据（本函数）只此一份，**处置分道**在调用方（见 `qoder-rpc.ts` 的 `testProxy`）。
 *
 * @returns 形如 `[{host:'127.0.0.1', port:7897}]`；读不到任何目标时返回**空数组**
 *   （不是 `undefined` —— 调用方据此区分「确实没有目标信息」与「取不到」）。
 */
export declare function collectRefusedTargets(error: unknown): NetworkTarget[];
/**
 * 这次失败是否**发生在用户填的代理入口本身上**。
 *
 * ## ⚠️ 这个判据是「处置分道」的唯一依据
 *
 * 命中 ⇒ 代理软件没跑 / 地址写错（**不要**再说目标站点的事，用户会去查错的地方）；
 * 不命中 ⇒ 代理入口是通的，失败发生在「代理 → 目标主机」那一段（换节点或回直连）。
 *
 * ⚠️ **端口/主机任一不匹配都返回 `false`**：宁可退回通用文案，也不能把
 * 「目标站点连不上」误报成「你的代理没启动」—— 后者会让用户去关代理，
 * 而关掉代理可能让另一个本来能通的渠道一起断掉（比不报还糟）。
 *
 * @param error 原始异常。
 * @param proxyUrl 用户填的代理地址（**已归一化**，形如 `http://127.0.0.1:7897`）。
 */
export declare function targetsProxyEntry(error: unknown, proxyUrl: string): boolean;
/**
 * 这次失败是否属于「根本出不去」（需要代理 / 换网络）。
 *
 * @param error 原始异常。
 * @param aborted 是否是**自己 arm 的超时**真的触发了。
 *   ⚠️ 调用方必须真的读 `signal.aborted`（或自己 `try/catch` 时已知是自己
 *   abort），不能恒传 `false` —— `AbortSignal.timeout()` 触发的墙外连接超时
 *   **没有** `UND_ERR_*` 错误码（IKLTZ2 审计 P2-2 的实际教训）。
 */
export declare function isNetworkBlocked(error: unknown, aborted: boolean): boolean;
/** {@link networkBlockedHint} 的参数。 */
export interface NetworkBlockedHintParams {
    /** 原始异常。 */
    error: unknown;
    /** 是否是自己 arm 的超时真的触发了（见 {@link isNetworkBlocked}）。 */
    aborted: boolean;
    /**
     * 面向用户的**主体名**，如 `Google` / `Qoder`。
     * 会拼成「连不上 {subject}{（码）}：…」。
     */
    subject: string;
    /**
     * 出路说明 —— **这句话是本函数存在的理由**，必须可操作。
     *
     * ⚠️ 不得写「请联系管理员」这类无出路的废话；也不得许诺本插件没有的能力。
     *
     * ⚠️⚠️ **反过来：本插件已经有的能力必须写出来**（2026-10-25 审计 A2-10）。
     * 这句话原先举的例子是「Qoder 目前**没有**按账号配代理的按钮」—— 而
     * `618a090` 恰好**加了**那个按钮（`jet-hub.js` 的「代理」入口 / 弹窗）
     * ⇒ 例子本身成了过时误导：照它写的 remedy 会把用户指向「导出 HTTPS_PROXY」
     * 这条**全局**出路，而按账号代理正是为「只想让一家的流量走代理」才做的。
     * ⇒ 写 remedy 前先确认该 provider **现在**有没有代理入口。
     */
    remedy: string;
}
/**
 * 「连不上 {subject}」的用户可读提示（含根因码与出路）。
 *
 * @returns 命中「出不去」时返回提示语；否则返回 `undefined`
 *   （调用方用自己更精确的措辞，**不要**用本函数的文案兜底）。
 */
export declare function networkBlockedHint(params: NetworkBlockedHintParams): string | undefined;
//# sourceMappingURL=network-hint.d.ts.map