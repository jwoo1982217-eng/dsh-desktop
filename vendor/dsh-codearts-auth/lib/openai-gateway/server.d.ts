import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { type ApiKeySource } from './auth.js';
import type { AttachmentBridge, ImageLimits } from './images.js';
export interface GatewayLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
export interface LlmRuntimeLike {
    listProviders(): readonly {
        id: string;
    }[];
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
export interface OpenAiGatewayOptions {
    ctx?: Context;
    llm: LlmRuntimeLike;
    /**
     * 附件服务桥接（`ctx.attachments.saveImage`）。
     *
     * 缺失时收到图片会明确回「未装载附件服务」而不是静默丢图 —— 静默丢弃会让用户
     * 以为模型看到了图，而答案其实是基于文本生成的。
     */
    attachments?: AttachmentBridge;
    /** 图片限制；缺省用 `images.ts` 里附件服务的实测默认值。 */
    imageLimits?: ImageLimits;
    /**
     * 请求体上限（字节）；缺省 {@link BODY_LIMIT}。
     *
     * 存在的唯一理由是**可测**：默认上限是 300 MiB，真发一个超限请求既慢又吃内存，
     * 而「超限时客户端拿到的是 413 而不是连接重置」（Issue IKKUBJ）这条回归用例
     * 必须有真实 HTTP 往返才立得住。它不是面向用户的配置项，插件调用方不传。
     */
    maxBodyBytes?: number;
    home?: string;
    env?: NodeJS.ProcessEnv;
    logger?: GatewayLogger;
    /**
     * 「允许局域网访问」设置页开关（默认 `false`）。
     *
     * `true` 且 env 未显式给 `DSH_OPENAI_GATEWAY_HOST` 时绑定 `0.0.0.0`（全部
     * 网卡）——语义与安全边界见 `config.ts` 的 `ResolveGatewayConfigOptions`。
     */
    allowLan?: boolean;
}
export interface OpenAiGateway {
    start(): Promise<void>;
    /**
     * 关闭实例。
     *
     * @param options.drainActiveMs 允许**在途请求**跑完的窗口（毫秒）。
     *   - `0`（缺省）：立刻中断在途请求 —— **用户主动关网关**的语义（「我要它现在停」）；
     *   - `> 0`：先停接入、再等 `active` 排空到该上限，只有超时才 abort。
     *     **换绑/热重载**用它（见 {@link OpenAiGateway.detachListen} 的理由）。
     */
    close(options?: {
        drainActiveMs?: number;
    }): Promise<void>;
    /**
     * **只交出监听端口**，把在途请求留给后台排水（Gitee issue IKQODR 缺陷 2）。
     *
     * ## 为什么需要它
     *
     * `listen()` 的绑定地址在创建时定格，所以「允许局域网访问」翻转只能**重建实例**。
     * 而换绑原先是「先 `await close()`、再起新实例」⇒ 两者叠加出两个用户可见后果：
     *
     * 1. **在途流被当场砍断**（`close()` 第一行就 `abort()`，250ms 只够刷缓冲，
     *    实测一轮 6 帧的流只收到 3 帧就被 abort）；
     * 2. **空窗期下游全被拒**（实测换绑窗口内探测到 `ECONNREFUSED`）。
     *
     * 本方法把「交端口」与「关实例」拆开：
     * - `closeIdleConnections()`：清掉空闲 keep-alive（它们不承载在途响应，却会让
     *   close 回调等满 `keepAliveTimeout` 的 120s）；
     * - `close()`：**停止 accept、释放端口**（实测 Node 24：之后同端口可立即重新
     *   `listen()`，已建立的连接不受影响）；
     * - **不 abort**：在途响应继续跑，由后续 `close({ drainActiveMs })` 排水。
     *
     * ⇒ 换绑流程变成「旧实例 detachListen() → 新实例 start() 接管新连接 →
     *   旧实例后台排水」，**端口空窗期缩到近乎为零**，且不砍断在途请求。
     */
    detachListen(): void;
    address(): {
        host: string;
        port: number;
    };
    /**
     * 密钥来源（含本体与文件路径）。
     *
     * 刻意**只经由 `createOpenAiGateway()` 拿**（runtime 已持有实例），而不是
     * 另开一条读密钥的通道：多一个入口就多一处「读到的和网关在用的不是同一个」
     * 的可能，而那种偏差会表现为「设置页复制的 key 一律 401」。
     */
    apiKey: ApiKeySource;
}
/**
 * 请求体上限。
 *
 * ⚠️ **必须容得下自家图片声明所能产生的请求体**（Issue IKKUBJ）。原先的 16 MiB
 * 与 `DEFAULT_IMAGE_LIMITS` 自相矛盾：那里允许一条消息带 200 MiB 图片（**原始**
 * 字节），而 JSON 里图片以 base64 承载、膨胀 4/3 ⇒ 光图片就是 266.7 MiB。结果是
 * 「单张图片 20 MiB」这句声明在真实链路上**永不可达** —— 实测连 12 MiB 的图片
 * 都已经在读到 body 这一步就被拒，压根走不到图片体积校验。
 *
 * 300 MiB = 200 MiB 图片的 base64 形态（266.7 MiB）+ 约 35 MiB 余量给文本与
 * tools。取值上限由 `DEFAULT_IMAGE_LIMITS` 反推，故**改图片声明时必须回来核对**
 * —— `tests/unit/openai-gateway-server.spec.ts` 有一条纯算术用例锁住这个关系。
 */
export declare const BODY_LIMIT: number;
/**
 * `close()` 等待在途连接自行收尾的宽限窗口。
 *
 * ⚠️ 存在的理由（Issue #11 的根因）：`server.close()` 的回调**只在所有 socket
 * 都关掉之后**才触发，而 `controller.abort()` 只是让业务逻辑停止，**不会主动
 * 断连**。在途的 SSE 响应即使已经被 `end()`，对应的 socket 仍可能停在 keep-alive
 * 状态，要等 `keepAliveTimeout`（本网关设的是 120s）才被内核回收。
 *
 * 实测：翻「允许局域网访问」触发换绑时 `close()` 挂了 **121 秒**（= 120s + 1s），
 * 这期间网关已停、`running` 已是 `undefined`、且**一行日志都没有** —— 用户看到的
 * 就是「网关静默消失」，下游全部 connection refused。
 *
 * 取值：足够让刚被 abort 的流把已缓冲的帧刷给客户端（避免连接重置），又短到
 * 用户感知不到延迟。超时后由 `closeAllConnections()` 强制断开。
 *
 * ⚠️ **光有这个窗口不够**（2026-10-26 审计实测）：窗口期内若只是干等，它
 * **结构性 100% 失效** —— `= 0` 与 `= 250` 的客户端输出逐字节相同，每一次都
 * 走到强制断开。必须配合 {@link CLOSE_IDLE_POLL_MS} 的轮询才能真正「救下」
 * 正常收尾的连接。
 */
export declare const CLOSE_GRACE_MS = 250;
/**
 * 宽限期内**轮询 `closeIdleConnections()`** 的间隔。
 *
 * ⚠️⚠️ 存在的理由（2026-10-26 审计打穿「宽限窗口」的实现）：
 *
 * `server.close()` 在返回前会**自己**调一次 `closeIdleConnections()`，但那一刻
 * 响应通常还在写（`response.end()` 发生在 `close()` 之后几毫秒）⇒ socket 不算
 * idle ⇒ **那一次调用无效**。此后上一版代码再也不调，只能干等到
 * {@link CLOSE_GRACE_MS} 超时 ⇒ 每一次带在途连接的 close 都强制断开。
 *
 * 实测证据（审计 V1/V2）：`CLOSE_GRACE_MS = 0` 与 `= 250` 两种配置下，客户端
 * 收到的**字节数逐字节相同**（4979527B）、`err = null`、`ended = true`
 * ⇒ 250ms 是**纯延迟**，注释里「绝大多数情况在这里就完事」「避免连接重置」
 * 两句都不成立。
 *
 * 加上轮询后（审计 V3 实证）：每 20ms 扫一次 ⇒ 流一收尾 socket 立刻被回收
 * ⇒ `close()` 回调 **1ms** 就触发，**根本走不到强制断开**。
 *
 * 取值 20ms：远小于宽限窗口（250ms）⇒ 窗口内能扫 12 次，足够覆盖「流收尾 →
 * socket 变 idle」的任意时刻；又不会让定时器本身成为可测的 CPU 开销。
 */
export declare const CLOSE_IDLE_POLL_MS = 20;
/**
 * **换绑/热重载**时给在途请求的排水窗口（毫秒）。
 *
 * ⚠️ 存在的理由（Gitee issue IKQODR 缺陷 2）：原先 `close()` 第一行就
 * `controller.abort()`，250ms 宽限只够把已缓冲的帧刷出去，**不够任何一轮真实
 * 请求跑完**。实测：一轮 6 帧（每帧 100ms）的流，换绑时只收到 **3 帧**就被砍断，
 * 内容半截。
 *
 * 换绑与「用户主动关网关」是**两种不同语义**：
 * - 用户关网关：「我要它现在就停」⇒ 立刻中断是预期行为（`drainActiveMs: 0`）；
 * - 换绑/热重载：**用户没想中断任何请求**，只是改了监听地址 ⇒ 应当让在途请求
 *   跑完。而且因为端口已经交给新实例（`detachListen()`），让旧实例多活一会儿
 *   **没有任何用户可见成本** —— 它防的只是「一个已无人在读的请求永久占住实例」。
 *
 * 取值 10 分钟：外部 agent 一轮含多次工具调用、跑几十分钟很正常。这个值只决定
 * 「什么时候放弃等待并 abort」，不阻塞任何用户可见路径（新实例已接管）。
 */
export declare const CLOSE_DRAIN_ACTIVE_MS: number;
/**
 * 强制断开之后，等底层确认关闭的**上限**。
 *
 * ⚠️ 存在的理由（对抗审计发现的 P1）：`close()` 对外承诺「一定在有限时间内
 * 返回」，而「强制断开后等回调」那一步若没有上限，一旦底层不触发回调
 * （被 patch 的 server、异常 socket 状态、或 fallback 到 `closeIdleConnections`
 * 时它对在途 socket 无效），`close()` 就**永不返回**。
 *
 * 后果比原 bug 更糟：`close()` 的调用方是收敛队列 ⇒ 队列永久卡死 ⇒ **用户再也
 * 打不开网关，且没有自愈路径**（`disposeGatewayRuntime` 只挂在插件卸载上）。
 * 原 bug 至少 120s 后自愈。
 *
 * 取值 1000ms：强制断开是同步生效的，正常情况下回调在同一轮事件循环内就触发
 * （实测整个 close 是 266ms）；1 秒足够吸收调度抖动，又短到用户无感。
 */
export declare const CLOSE_DRAIN_MS = 1000;
export declare function createOpenAiGateway(options: OpenAiGatewayOptions): OpenAiGateway;
//# sourceMappingURL=server.d.ts.map