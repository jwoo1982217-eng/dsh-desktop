/**
 * Qiniu（七牛云 AI）产品配置与错误分类。
 *
 * ## 协议形态：OpenAI 兼容网关（无厂商私有信封）
 *
 * 七牛云 AI 通过 https://api.qnaigc.com/v1 提供标准 OpenAI 兼容接口：
 * - 鉴权：`Authorization: Bearer <API Key>`；
 * - chat：`POST /chat/completions`（SSE 流式）；
 * - 目录：`GET /models`（返回 `data: [{id, object, owned_by, created, context_length, max_tokens}]`，
 *   **实测免鉴权也回 200** ⇒ 凭据有效性不能靠「目录能读到」判定）；
 * - API Key **长期有效**、**无 refresh 端点**；
 * - **无余额/额度查询端点**（余额只在登录后的网页控制台可见）。
 *
 * 与 modelscope（魔搭）是同一范式：静态 API Key + OpenAI 兼容 + 无 refresh +
 * 无余额端点。因此本 provider 逐字镜像 modelscope 的接入结构（见
 * docs/adding-a-new-provider.md 的「路径 B 全新脉系」）。
 *
 * ## ⚠️ 模型 id 由平台动态下发，兜底表 = 远端快照（**非空**，2026-10-30 修订）
 *
 * 七牛云官方明令「模型 id 由 qiniu.com/ai/models 下发」，会随平台增删变化。
 * 因此**初版**曾把兜底模型表（QINIU_FALLBACK_MODELS）刻意置空 —— 但实测证明
 * 那条路线有毒：`listAllModels()` 冷缓存恒 `[]` ⇒ `models.total === 0` ⇒
 * 面板把该渠道**误显示为「已关闭且无模型可关」**（与 modelscope 那条
 * 「provider 显示已关闭、模型却仍可选用」相反方向的矛盾态）。
 * 现行做法：兜底表 = 远端快照 `QINIU_REMOTE_SNAPSHOT` 映射出的**非空**表
 * （2026-10-29 直连 `/v1/models` 的 77 条实测，见下方「实测目录形状」），
 * 远端可用时仍**完全采信远端**；快照只承接「远端不可用且无缓存」的兜底。
 *
 * ## 实测目录形状（2026-10-29 直连 https://api.qnaigc.com/v1/models，HTTP 200）
 *
 * - id 是**两种形态混合**：新模型带厂商命名空间前缀（`moonshotai/kimi-k3`、
 *   `deepseek/deepseek-v4-pro-0813`、`qwen/qwen3.8-max`、`z-ai/glm-5.3`、
 *   `minimax/minimax-m3.1-flash`、`qiniu/conatus-free` …），老模型是裸名
 *   （`deepseek-v3`、`kimi-k2`、`glm-4.5`、`qwen-turbo`、`MiniMax-M1` …）。
 *   两种都要原样透传：**不得**自己做 `/` 拆分或归一（FAQ Q6 明确要求 model
 *   字段与模型广场的「API model 参数」逐字一致，否则找不到模型）。
 * - 每条带 `context_length` 与 `max_tokens`（部分为 0）⇒ 上下文窗口有权威来源，
 *   这正是快照表只需记 `[id, context_length]` 两列的底气（远端给窗口，不需要本地猜）。
 * - **不下发模态**（无 `modalities` / `input_modalities` 字段）。
 *
 * @module src/qiniu-product.ts
 */
/** Qiniu（七牛云 AI）的产品配置（字段围绕 OpenAI 兼容协议）。 */
export interface QiniuProduct {
    readonly id: 'qiniu';
    /**
     * 展示名。
     *
     * ⚠️ 必须与客户端 `plugin-src/client/jet-hub.js` 的 `PROVIDERS` 里
     *   `qiniu` 那条的 `label` **逐字一致**。
     */
    readonly displayName: string;
    /** OpenAI 兼容 base URL，**含 `/v1`**，且**不带**尾斜杠。 */
    readonly baseUrl: string;
    /** 对话端点（拼在 baseUrl 之后）。 */
    readonly chatPath: string;
    /** 模型目录端点（拼在 baseUrl 之后）。 */
    readonly modelsPath: string;
    /** 等首个 token 的空闲超时（毫秒）。 */
    readonly chatHeaderTimeoutMs: number;
    /** 两次 chunk 之间的空闲超时（毫秒）。 */
    readonly chunkTimeoutMs: number;
    /** 模型目录请求超时（毫秒）。 */
    readonly catalogTimeoutMs: number;
    /**
     * 单凭据回退 ref。
     *
     * 取 `QINIU_ACCESS_TOKEN`：与 modelscope 的 `MODELSCOPE_ACCESS_TOKEN`
     * 同口径（静态 API Key 的默认单凭据 ref）。
     */
    readonly defaultCredentialRef: string;
}
export declare const QINIU: QiniuProduct;
/** 兜底模型目录条目。 */
export interface QiniuFallbackModel {
    /** 上游真实模型 id（以远端 /models 下发为准）。 */
    id: string;
    /** 展示名（缺省时用 id）。 */
    name: string;
    /**
     * 上下文窗口（DSH 以它 × 0.8 作压缩阈值）。
     *
     * ⚠️ `0` 是「**不知道**」哨兵，**不是**合法窗口 —— `resolveModel` 判
     * `> 0` 才下发 `context`。
     */
    contextWindow: number;
    /** 是否支持图片输入（**声明支持就必须真支持**，本仓库硬约定）。 */
    supportsImage: boolean;
    /** 支持的思考档位（上游 wire 值）；**为空时不声明 `reasoning`**。 */
    efforts?: readonly string[];
}
export declare const QINIU_FALLBACK_MODELS: readonly QiniuFallbackModel[];
/** 该模型是否为本地兜底表里登记过的。 */
export declare function isKnownQiniuModel(id: string): boolean;
export type QiniuErrorKind = 'rate_limit' | 'quota' | 'auth' | 'server' | 'transport' | 'invalid_request' | 'context_window';
export interface QiniuErrorInfo {
    kind: QiniuErrorKind;
    /** 服务端要求的等待时长（毫秒）；仅在限流类错误上产出。 */
    retryAfterMs?: number;
    /** 面向用户的可读描述（**禁止**裸 JSON）。 */
    detail: string;
}
/**
 * 把一次失败的 HTTP 响应归类为语义化错误。
 *
 * ## ⚠️ 顺序即优先级
 *
 * 1. **上下文超限排在限流/额度之前**：归 quota 会让账号被封到次日零点；
 * 2. **⚠️ 401/403 先判，恒归 `auth`**（2026-10-31 对抗审计 M1a 打穿后修）：
 *    状态码与额度文案并存时（网关侧故障常在报文里捎带 `insufficient quota`
 *    类提示）**以状态码为准** —— 认证类是**账号态**、不是模型冷却，落 quota
 *    会被 `markLimited` 写成 UTC+8 次日零点冷却，把认证故障放大成封池
 *    （loomy 2026-10-06「全池被封」事故同型，不变式见
 *    `docs/agent-notes/providers-loomy-raccoon-minimax.md` §分类两条不变式 1）。
 *    原「网关额度耗尽可能回 401/403，故额度先判」的注释方向反了：宁可漏判
 *    额度（不换号）不可误判成封号。
 * 3. **限流/额度之后**才是传输/形状/服务端；
 * 4. **400 单独归 `invalid_request`**：形状问题与账号无关，白重试 5 次无益；
 * 5. `retry-after` 由响应头给出（`retry-after.ts`，0 是合法值）。
 *
 * @param status  HTTP 状态码；传输层失败传 0。
 * @param body    响应体原文（调用方**必须先读一次体**再调本函数）。
 * @param headers 响应头。
 */
export declare function classifyQiniuError(status: number, body: string, headers?: Readonly<Record<string, string>>): QiniuErrorInfo;
//# sourceMappingURL=qiniu-product.d.ts.map