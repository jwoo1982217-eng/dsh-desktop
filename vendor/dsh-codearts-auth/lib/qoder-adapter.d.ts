/**
 * Qoder LLM 适配器。
 *
 * ## 两条推理路径
 *
 * Qoder 有**两套**推理端点，认**两套不同的模型名** —— 这是本项目
 * 最容易踩的坑，务必分清：
 *
 * | 路径 | 端点 | 模型名 | 说明 |
 * |---|---|---|---|
 * | **加密（本适配器默认）** | `api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1` | **目录 key**（`qfmodel` / `dmodel`） | 客户端真实链路；body 由 `src/qoder-wasm.ts` 加密；能拿到 Qwen3.8 系列 |
 * | 公开 | `api2-v2.qoder.sh/model/v1/chat/completions` | 通用名（`qwen-flash`） | 标准 OpenAI；但目录 key 一律 `Unsupported model` |
 *
 * **真实缺陷**（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止」。
 * 根因是早期把**目录 key 发给了公开端点** → `invalid_model_error`，
 * 而错误帧又被解析器静默吞掉。
 *
 * ⚠️ `api2.qoder.sh`（加密）与 `api2-v2.qoder.sh`（公开）**不是同一个 host**，
 * 混用会 404。
 *
 * OpenAI 协议层的通用逻辑（消息序列化、SSE 消费、错误归类）复用
 * `src/openai-compat.ts`；加密端点的响应信封由 `src/qoder-envelope.ts` 剥离。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AccountPool } from './account-pool.js';
import { type QoderCredential } from './qoder.js';
import { type QoderInferMessage, type QoderInferTool } from './qoder-wasm.js';
import { type NativeSource } from './native-search-contract.js';
import { type QoderFallbackModel, type QoderModelPromotion, type QoderProduct } from './qoder-product.js';
import { type ImageRequestTarget } from './image-budget.js';
import { BILLING_BUSINESS_CODE, BILLING_BUSINESS_CODES, QUEUE_BUSINESS_CODE, QUEUE_MAX_ATTEMPTS, QUEUE_MAX_DELAY_MS, isBillingBusinessCode, isQueueBusinessCode, looksLikeBillingError, nextUtc8DayStartMs, parseQueueError, queueDelayMs, type QueueInfo } from './model-queue.js';
/**
 * ⚠️ **向后兼容的再导出**：排队解析的实现已移到 `src/model-queue.ts`
 * （因为 SSE 消费器也要用，而它不能被本模块反向 import —— 会成环）。
 * 这里保留同名导出，避免既有调用方与测试失效。
 */
export { BILLING_BUSINESS_CODE as QODER_BILLING_CODE, BILLING_BUSINESS_CODES as QODER_BILLING_CODES, QUEUE_BUSINESS_CODE as QODER_QUEUE_CODE, QUEUE_MAX_ATTEMPTS as QODER_QUEUE_MAX_ATTEMPTS, QUEUE_MAX_DELAY_MS as QODER_QUEUE_MAX_DELAY_MS, isBillingBusinessCode, isQueueBusinessCode, looksLikeBillingError, nextUtc8DayStartMs, parseQueueError as parseQoderQueueError, queueDelayMs as qoderQueueDelayMs, type QueueInfo as QoderQueueInfo, };
/**
 * 上游**供应商侧瞬时故障**的文案判据（`provider_error` 这一类）。
 *
 * ## 为什么需要它（真实报障，2026-10-21）
 *
 * 用户贴出：
 * ```
 * aggregate: qodercn（dfmodel）上游失败：
 *   qoder: Error in upstream response (provider_error/model_error) code=SERVER
 * ```
 * 池里有 **2 个** `qodercn` 账号，但第二个**从未被尝试** —— 因为该错误落
 * `SERVER`，而本适配器的切号判据只有「额度」一类（见 {@link isQuotaExceededError}）。
 *
 * ## 判据为什么是「码值 + 文案」双通道
 *
 * 单认码值不够：本仓库在额度类上记过两次同型教训（`110` 漏判 → 补
 * `looksLikeBillingError`；`112` 又漏判 → 补 `pricingUrl`，见
 * `model-queue.ts:182-191` 的 IKKJFH 记录）。上游换码值/换文案是常态，
 * 只认一条腿必然再漏一次。
 *
 * 单认文案也不够：`provider_error` 是**结构字段**（`code` 字段的值），
 * 而文案 `Error in upstream response` 也可能出现在别的语境里。
 *
 * ⇒ 两条腿都认，任一命中即算（与 `isBillingBusinessCode || looksLikeBillingError`
 * 的既有形态**逐字同构**，不引入第三种判据风格）。
 *
 * ## ⚠️ 词表必须**窄**
 *
 * `provider_error` 是 Qoder 报文的**结构字段值**，不是自然语言；
 * `upstream` 类短语只认「明确的错误短语」。泛词（`error` / `failed` /
 * `upstream` 单词）会命中正常正文（模型恰好讨论「上游失败」），一律不收。
 *
 * ⚠️ **不收 `model_error`**：它是 `openai-compat.ts:929` 的**拼接产物**
 * （`[code, type].join('/')`），单独出现时可能来自任何 `SERVER` 错误，
 * 收它等于把整个 `SERVER` 都算进来 —— 那正是本判据要避免的过宽。
 *
 * ## ⚠️⚠️ 网关 5xx 也必须收（2026-10-25 审计 P1，B1-1）
 *
 * 上面那张词表**只认 `provider_error` 那类短语**。但对抗审计扫了本机全部
 * **1374 个会话 / 163 条真实 qoder 失败**，按形态计数后发现真正**主导**的是
 * 另外两种，而它们都落 `other` ⇒ **不换号**、还因终态是 `SERVER`
 * （在宿主 `DEFAULT_RETRYABLE_CODES` 里）**白重试 5 次**：
 *
 * | 真实形态 | 次数 |
 * |---|---|
 * | `qoder: <html>…504 Gateway Time-out…</html>` | **74** |
 * | `First Token Timeout or Upstream Timeout (504/model_error)` | **6** |
 * | `Error in upstream response (provider_error/model_error)` | 16 |
 *
 * ⇒ 本 PR 原以为的核心目标（16 次）其实不是主导形态；把网关 5xx 一并收进来
 * 才真正覆盖了「登录 N 个账号 ≠ N 倍可用性」这个缺陷。
 *
 * ⚠️ 仍然要**窄**：只收「明确的网关/上游故障短语」——
 * `gateway time-out` / `bad gateway` / `service unavailable` /
 * `(first token|upstream) timeout`。**不收**泛化的 `server error` /
 * `timeout` / `upstream connection reset`：那些可能是请求侧或本地网络问题，
 * 收进来会让 400 参数错也变成可换号（白烧整池）。
 * ⚠️ 顺序不变：**额度腿优先**（见 `classifyQoderFailure`），
 * 故「504 + billing 文案」仍归 `quota`。
 */
export declare function looksLikeUpstreamProviderError(text: string): boolean;
/**
 * Qoder 的失败类别。
 *
 * 语义表（照 `accio-adapter.ts:1596-1605` 的「类别 → 动作」表逐格搬，
 * 本仓库已有 6 家同款：accio / minimax / loomy / raccoon / trae / lobsterai）：
 *
 * | 类别 | 判据 | 换号 | 写冷却 |
 * |---|---|---|---|
 * | `quota`    | `QUOTA_EXCEEDED` / 110 / 112 / pricingUrl | ✅ | ✅ 至 UTC+8 当日 24:00 |
 * | `rate`     | `RATE_LIMIT` / 429 | ✅ | ✅ 1h（{@link QODER_RATE_LIMIT_COOLDOWN_MS}） |
 * | `auth`     | `AUTH` / 401 / 403 | ✅ | ❌ **绝不** |
 * | `upstream` | `SERVER` **且** {@link looksLikeUpstreamProviderError} | ✅ | ❌ **绝不** |
 * | `other`    | 其余（400 参数错、风控页、空响应…） | ❌ | ❌ |
 * | `transport`| **不来自 {@link classifyQoderFailure}**：由适配器在 `fetch` 抛
 *               传输错误时（`sendEncrypted`）**直接传入** | ✅ | ❌ **绝不**
 *              （连不上是出口/网络问题，写冷却会把健康号封到当天 24 点） |
 *
 * ## ⚠️ `transport` 是**内部入参**，不是分类结果
 *
 * {@link classifyQoderFailure} **永不返回** `'transport'`（实测：喂
 * `('TRANSPORT', <含 UND_ERR 的 detail>)` 得 `'other'`）。原因：这条类别只在
 * 「建连/首包」这条腿上有意义，而 `fetch` 的传输错误在进入任何分类器**之前**
 * 就已被 `sendEncrypted` 包成 `LlmError(code='TRANSPORT')` 并直接送进换号分支。
 *
 * ⚠️ **SSE 中途**的 `sse transport error` 因此**不换号**（被归 `other`）——
 * 那是刻意的：那时正文可能已吐了一半，换号重发会重复内容。
 *
 * ## ⚠️ `auth` / `upstream` 只换号、绝不写冷却
 *
 * `auth` 那条是 2026-10-06「全池被封」事故换来的不变式：上游网关对**全池**
 * 回 401 时，若每个号都被写长冷却，**一个请求就能把整个 provider 封一天**。
 *
 * `upstream` 走同一条纪律，理由不同但方向一致：`provider_error` 是上游
 * **供应商侧**的瞬时故障，与「这个账号的额度/状态」**无关**。写冷却等于把
 * 一次上游抖动记成「该账号今日此模型已用完」—— 那要**一整天**才恢复，
 * 而实际上换个号（或等几秒重发）大概率就好了。
 *
 * ## ⚠️ 与 `isQuotaExceededError` 的关系
 *
 * 后者是**额度专用**判据（含文案兜底），保留原样不动（既有调用方与测试
 * 依赖它）。本函数是**更宽**的分类入口，额度也在其中。
 */
export type QoderFailureClass = 'quota' | 'rate' | 'auth' | 'upstream' | 'other' | 'transport';
/**
 * 单次 `stream()` 里，**传输级失败**最多允许的额外尝试次数（不含首发）。
 *
 * ## 为什么要有上限（而不是「换到没号为止」）
 *
 * 每一次尝试都要等一个 **10 秒 connect 超时**（undici 默认 `connectTimeout`，
 * 实测 10,713ms）。若不设上限：5 个账号 × 10s = 50s，而宿主对 `TRANSPORT` 还有
 * 5 次重试（`DEFAULT_RETRYABLE_CODES`，退避 500ms→10s）⇒ 最坏 6 × 50s ≈ 5 分钟
 * 才报错，用户只看到「卡住」。
 *
 * ## 为什么不「同号退避重试」
 *
 * 同号重试只对瞬时的 socket 重置有意义，而那件事**宿主已经在做**（`TRANSPORT`
 * 在 `DEFAULT_RETRYABLE_CODES` 里，5 次、退避 500ms→10s）。再叠一层只是把
 * 「完全离线」的最坏耗时成倍放大（10s → 30s/轮），换不来任何新路径。
 *
 * ⇒ 每次重试**必须换一个账号**（换号 = 换出口：每账号可配独立代理，见 `618a090`
 * 「国际版 SNI 阻断下唯一出路」）；换不到号就**立即抛原错误**，交给宿主退避。
 * 预算只给 **2** 次 ⇒ 单轮最坏 3 发 ≈ 30s（宿主再退避重试 5 次的总时长仍可控）。
 */
export declare const QODER_TRANSPORT_MAX_RETRIES = 2;
/**
 * 把一次传输失败的**可操作信息**拼成一句话（沿 `cause` 链取更深几层）。
 *
 * ## 为什么必须拼（issue IKR5ZD，2026-10-28）
 *
 * 用户看到的只有 `qoder: transport error: fetch failed` —— 而真正能定位问题的
 * 东西全在 `cause` 链里：
 *
 * ```
 * TypeError: fetch failed
 *   └ cause: UND_ERR_CONNECT_TIMEOUT
 *            Connect Timeout Error (attempted address: 1.2.3.4:443, timeout: 10000ms)
 * ```
 *
 * 「连到哪个 IP / 是超时还是被重置 / 超时多少毫秒」直接决定处置方式
 *（换 IP、换出口代理、改超时），缺了它这条报错**等于没有信息**。
 *
 * ⚠️ 链长有界（4 层）+ 去重，避免自引用 `cause` 造成死循环。
 * ⚠️ 结果经 {@link maskProxyPassword} 脱敏：代理故障的 message 里可能带 userinfo。
 */
export declare function transportErrorDetail(error: unknown): string;
/**
 * 把一次失败归类。
 *
 * @param code - `LlmError.code`（拿不到时传 `''`）。
 * @param text - 上游原文 / 错误 message（供文案腿使用；无则传 `''`）。
 */
export declare function classifyQoderFailure(code: string, text: string): QoderFailureClass;
/**
 * 该类别是否值得**换下一个账号**重试。
 *
 * ⚠️ `other` 为 false 的理由与 minimax / loomy / accio 同款：400 参数错、
 * 风控拦截页、空响应这些是**请求本身或环境**的问题，换号只会白烧整池。
 */
export declare function shouldRotateQoderAccount(cls: QoderFailureClass): boolean;
/**
 * 该类别是否**写冷却标记**。
 *
 * ⚠️ **`auth` / `upstream` / `transport` 恒 false**（见 {@link QoderFailureClass}
 * 的语义表）。`transport` 尤其不能记：连不上是**出口/网络**的问题，写冷却会把
 * 一个可能完全健康的账号封到当天 24 点 —— 那正是「换了号还是超时、第二天才好」
 * 这类最难查的症状（issue IKR5ZD 的处置必须避开它）。
 * 这条是「一个请求封死整池」与「坏账号永远轮不到」之间的取舍点。
 */
export declare function recordsQoderRateLimit(cls: QoderFailureClass): boolean;
/** 本适配器注册的 provider 路由名（历史常量，等价于 `QODER.id`）。 */
export declare const PROVIDER = "qoder";
/**
 * 该模型在 UI 上可选的思考档位（复刻客户端 `gU()` 的行为）。
 *
 * 三条口径：
 * 1. `efforts` 原样取用（目录顺序保持 —— 官方客户端也按对象键序渲染）；
 * 2. `supportsDisable` 为真时**追加** `none`（即「关闭思考」）；
 *    客户端 `gU()`：`… || e.includes('none') ? e : [...e, 'none']`。
 * 3. 两者皆无 → 返回空数组，调用方**不声明 `reasoning`**
 *    （UI 显示「当前模型未提供推理等级」，对应 IDE 的「不支持」）。
 *
 * ⚠️ **`qmodel` / `qmodel_latest` 这类「有 `disabled` 但无 `efforts`」的模型
 * 会得到 `['none']`** —— 即只提供「关闭思考」一项。这是**远端事实**
 * （用户 2026-09-28 确认「上面两个没有思考档位就是关闭的意思」），
 * **不要**给它们补默认档位。
 */
export declare function qoderEffortsFor(model: QoderFallbackModel): string[];
/**
 * 把 DSH 的工具 schema 映射成加密端点认的 `tools[]`。
 *
 * 形态取自客户端 `$Hc(A)`：
 * `{type:'function', function:{name, description?, parameters?}}` ——
 * `description` / `parameters` **缺省时该键不出现**（不是填空串/空对象）。
 *
 * ⚠️ 这是 `options.tools` 的**唯一出口**。适配器若不下发它，模型在 wire 上
 * 看不到任何函数定义，只能用正文里的 XML 文本臆造工具调用 —— 用户报障
 * 「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」的根因。
 *
 * @param tools - DSH 的 `GenerateOptions.tools`（可能缺席）。
 * @returns 可直接写入请求体顶层 `tools` 的数组；无工具时为空数组。
 */
export declare function buildQoderTools(tools: readonly {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}[] | undefined): QoderInferTool[];
/** {@link buildQoderHistory} 的入参：DSH 序列化后的 wire 消息（OpenAI 形态）。 */
interface QoderWireMessage {
    role?: unknown;
    content?: unknown;
    tool_calls?: unknown;
    tool_call_id?: unknown;
}
/**
 * 把 `serializeMessages` 的 wire 消息转成加密端点的 `messages[]`。
 *
 * ## 真实缺陷（本次修复）
 *
 * 早期实现写成「只保留 `content` 为字符串的消息」：
 *
 * ```ts
 * messages.filter((m) => typeof m.content === 'string')
 * ```
 *
 * 这有两个后果，都会让**多步工具调用**彻底坏掉：
 * 1. assistant 带工具调用时 `content` 是 **`null`**（OpenAI 规范）→ 整条消息
 *    被丢弃，模型**看不到自己调用过什么**；
 * 2. `role:'tool'` 消息的 `tool_call_id` 被一并丢掉 → 工具结果无法与调用配对。
 *
 * 于是模型只能反复重调同一个工具或凭空编造结果 —— 与 TRAE 那条已记录的
 * 同型缺陷（「消息序列化漏做 → 模型看不到工具调用与结果」）完全一致。
 *
 * 形态对齐客户端：assistant 挂 `tool_calls`，`role:'tool'` 挂 `tool_call_id`。
 */
export declare function buildQoderHistory(messages: readonly QoderWireMessage[]): QoderInferMessage[];
/** `QoderAdapter` 的构造选项。 */
export interface QoderAdapterOptions {
    /** 默认凭据 ref（仅用于类型/日志，实际解析走 `resolveCredential`）。 */
    credentialRef: CredentialRef;
    /** 从凭据存储解析凭据。 */
    resolveCredential: (modelId?: string) => Promise<QoderCredential | undefined>;
    /** 静默续期凭据。 */
    refresh: () => Promise<void>;
    /** 多账号池（用于限流时切换账号与模型黑名单）。 */
    accountPool?: AccountPool;
    /**
     * 补齐凭据缺失的 **`uid`**（加密推理必需）。
     *
     * ⚠️ 为什么需要这个钩子：`uid` 是后加的字段，**在此之前的旧凭据里没有它**，
     * 而 `generate_runtime_auth_fields` 依赖它派生 `encrypt_user_info`。
     * 缺 uid 时 WASM 产出**签名无效**的请求 → 服务端回
     * `Signature invalid (101)`（真实缺陷，用户报障）。
     *
     * 传入旧凭据，实现应调一次 userinfo 取 `id`、**回写凭据存储**，
     * 并返回补好 uid 的新凭据；无法补齐时返回 undefined。
     *
     * 未提供该钩子、且凭据缺 uid 时，会**明确报错**而不是发出必然失败的请求。
     */
    resolveUid?: (credential: QoderCredential) => Promise<QoderCredential | undefined>;
    /**
     * 读取图片附件的原始字节（内联为 data URL 用）。
     *
     * 由调用方桥接 `ctx.attachments.readImage(ref)`；未提供时收到图片会报
     * `UNSUPPORTED_CONTENT`（而不是静默丢弃）。
     */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /**
     * 读取图片附件的**请求版本**（按像素预算与字节目标缩放后的字节）。
     *
     * ⚠️ 与 {@link readImage} 的错误契约**相反**：不可用时必须返回 `undefined`
     * 而不是抛错 —— 缩放是优化，不能因为"想缩图"把一次本来能成功的请求打死。
     * 判据与回退都在共享的 `projectRequestImage` 里（buddy / raccoon 用同一份）。
     *
     * 背景（issue !IKITT9）：qoder 撞的是**请求体体积**上限（实测 8 张原图能过、
     * 15 张 ≈57 MiB 直接 `TRANSPORT: fetch failed`），与腾讯的图片 token 预算
     * 是两种约束，但同样只能靠缩放解决。
     */
    readImageRequest?: (attachment: unknown, target: ImageRequestTarget) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 产品配置；默认 {@link QODER}。 */
    product?: QoderProduct;
    /** 注入的 fetch（测试用）。 */
    fetchImpl?: typeof fetch;
    /**
     * **按账号**取出口代理的 fetcher（真实报障 2026-10-21）。
     *
     * ⚠️ 国际版 `openapi.qoder.sh` 在本机被 SNI 阻断（TLS ClientHello 被丢，
     * 而 TCP 443 握手正常），实测两个真实账号的**推理通道**同样 10.7s
     * `TRANSPORT: fetch failed` ⇒ 整个渠道没有实际推理能力。中国版
     * （`openapi.qoder.com.cn`）直连 434ms 就通 ⇒ 只能按账号配。
     *
     * ⚠️ **为什么是「按账号取」而不是构造期一份常量**：适配器在一轮请求内会
     * **换号**（`switchAccountOnQuota`，见额度/限流/上游故障三条分支），出口必须
     * 跟着 `activeAccountId` 换 —— 固化会让换号后**仍走旧账号的出口**，
     * 症状是「换了号还是超时」且**无任何报错**，属最难查的一类静默失效。
     *
     * ⚠️ 不传 ⇒ 恒直连（与既有行为逐字一致，所有单测不受影响）。
     */
    fetchFor?: (accountId: string) => typeof fetch;
    /**
     * 当前生效账号的 id（额度受限时用于**标记该账号**）。
     *
     * ⚠️ 做成**回调**而不是构造期常量：账号会在 `refreshAll` / 限流切换 /
     * Jet Hub 手动启停后变化，构造期快照会标记到**已经不再使用**的账号上。
     * 未提供时跳过标记（仍会尝试切号），不会因此崩。
     */
    currentAccountId?: () => string | undefined;
    /**
     * 注入的休眠实现（**测试用**）。
     *
     * 排队重试要真等（最长 10s × 180 次），单测不能真睡 —— 注入后即可断言
     * 「等了几次、每次多久」，并在毫秒级完成。
     */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /**
     * 「远端模型目录已落地」的回调。
     *
     * ⚠️ **必须由接线层注入 `broadcastCatalogChanged(ctx)`**（`registerQoderLlm`
     * 已代劳）：DSH 客户端把目录缓存在 `status === 'ready'` 即短路的 store 里，
     * 只有收到 `llm/adapters-updated` 才重读 ⇒ 远端目录异步落地后不广播，
     * 模型选择器会**永久**停留在冷启动那份兜底表上（`catalog-broadcast.ts` 记着
     * 这条真实症状：设置页 5 个模型、对话框只剩 2 个）。
     */
    onCatalogLoaded?: () => void;
    /**
     * 目录读取失败的告警出口（缺省静默）。
     *
     * ⚠️ 与「失败即回退兜底表」配套：回退是**静默**的，没有这条日志就没有
     * 任何证据表明上游目录取不到（只剩「倍率不更新」这种无信息的症状）。
     */
    warn?: (message: string) => void;
    /** 注入的时钟（测试用；缺省 `Date.now`）。 */
    now?: () => number;
    /**
     * 拉取**远端模型目录**（由接线层注入 `QoderAuth.fetchModels(pool)`）。
     *
     * ## ⚠️ 为什么是「注入一个取数函数」而不是适配器自己解析凭据
     *
     * 适配器手上的取凭据入口是 `resolveCredential`，而它**有副作用**：
     * 选中账号时会 `reportAccount(id)`（接线层据此维护「本次实际使用的账号」，
     * 供额度报错时标记）。目录请求是**周期性**的 —— 20 分钟刷新器可能在一次
     * 聊天请求选号之后跑到，把那个记录**改写成目录用的账号** ⇒ 额度标记落到
     * 无辜账号上（真实后果见 `index.ts` 的 `activeQoderAccountId` 注释）。
     *
     * 故与其余 11 家同形：由 auth 服务做**只读**取号 + 拉取，适配器只拿结果。
     *
     * 省略时**不发远端请求**（恒用兜底表）—— 纯测试/未接线场景的安全默认。
     */
    fetchRemoteModels?: () => Promise<readonly QoderFallbackModel[]>;
}
/** Qoder 模型适配器。使用 Bearer access_token 鉴权，仅支持 SSE。 */
export declare class QoderAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly fetchImpl;
    /**
     * 按账号取出口 fetcher（`undefined` = 恒直连）。
     *
     * ⚠️ 与 `fetchImpl` **并存不是替代**：`fetchImpl` 是单测替身（优先级最高），
     * 本字段是生产代理。两者的优先级在 {@link fetcherForAccount} 里定死。
     */
    private readonly fetchFor;
    /**
     * 出口 fetcher 是否被**单测替身**顶掉了（= 注入的 `fetchImpl` 不等于全局 `fetch`）。
     *
     * ⚠️ 为什么用「`!==` 全局 `fetch`」而**不是**在构造期记一个
     * `options.fetchImpl !== undefined` 布尔：`ratelimit-misreport-behavior.spec.ts`
     * 这类既有用例是**构造后直接 `adapter.fetchImpl = 替身`** 的（拿不到构造参数），
     * 构造期布尔对它恒为 false ⇒ 实现落到 `fetchFor` / 全局 `fetch` ⇒ 真发网络，
     * 全量跑起来表现为 `expected 'TRANSPORT' to be 'QUOTA_EXCEEDED'`（本轮实测）。
     * 而「引用不等于全局 `fetch`」这一判据**同时覆盖**「构造期注入」与「事后赋值」。
     *
     * ⚠️ 也不能只把两个分支调序了事 —— `fetchImpl` 在构造期已被 `?? fetch` 填满，
     * 靠判空无法区分「注入」与「默认」。
     *
     * ⚠️ 残余弱点（如实登记）：调用方注入一份**恰好等于全局 `fetch` 的引用**时会被
     * 判成「未注入」—— 但那时两种语义**没有可观察差异**，不构成缺陷。
     */
    private get hasInjectedFetchImpl();
    /**
     * ⚠️ **2026-10-08 Task 7b：三个方法收敛到共享骨架** `createModelCatalog`。
     * 原先 `listModels` / `resolveModel` / `listAllModels` 各写一遍骨架，
     * 现在只剩 `toCatalogEntry`（本家私有形状 + 静态表判据 + 倍率格式）。
     */
    private readonly catalog;
    /**
     * **远端**模型目录缓存（成功拉取后保留 20 分钟）。
     *
     * ⚠️ 2026-10-20 前本家**恒用编译期兜底表**（一次远端请求都不发），
     * 上游改价/改免费额度/上下架模型都不会反映 —— 用户报障
     * 「DeepSeek-Flash 上游已经 0×（免费）了，插件还显示 0.1」。
     * 现在远端优先、兜底表只作回退（见 `src/qoder-catalog.ts`）。
     */
    private remoteModels;
    /**
     * 上次**成功**读到远端目录的时刻（0 = 从未成功过）。
     *
     * ⚠️ 与 `remoteModels` **并存**、不是替代：前者存「有哪些模型」，
     * 本字段存「何时读到的」（只有前者的目录永不刷新）。
     */
    private catalogAt;
    /** 目录加载闸门：并发去重 + 失败/空结果冷却。 */
    private readonly catalogGate;
    /**
     * **静态兜底表专用**的第二套骨架（只在 `resolveModel` 的并集回退里用）。
     *
     * ⚠️ 存在的唯一理由：`resolveModel` 与 `listModels` 共用 `loadCatalog()`，
     * 而前者要「远端 ∪ 静态表」、后者要「远端独占」。故把静态表也包成一套
     * `ModelCatalog`，让**骨架自己的装配逻辑**（裸名/context/reasoning）
     * 复用到回退路径上，而不是在适配器里重写一遍。
     * `loadCatalog` / `syncCatalog` 都是同步静态表 ⇒ 零网络。
     */
    private readonly fallbackCatalog;
    constructor(options: QoderAdapterOptions);
    /**
     * 可中止的休眠；信号中止时立即 resolve（不抛错，由调用方检查 signal）。
     *
     * ⚠️ **必须响应 `signal`**：排队等待最长可达 30 分钟，用户中途取消会话时
     * 不能让 generator 卡在 `setTimeout` 里 —— 那会表现为「点了停止但没反应」。
     */
    private sleep;
    /**
     * 复用本适配器**同一套**选号编排解析凭据（供插件内部的原生搜索使用）。
     *
     * ## 为什么需要这个转发方法
     *
     * `options` 是构造器的 `private readonly`，插件其余模块从外部读
     * `adapter.options.resolveCredential` 会**编译失败**（`strict: true`）。
     * 而原生搜索**必须**与聊天链路用同一个 `resolveCredential` 实例 ——
     * 另建一份会让「enabled 过滤 / 模型级限流 / 免费判定 / 余额分档 / 池兜底 /
     * 账本回报」这六步在两条链路上漂移（与 `BuddyAdapter.resolveCredentialFor`
     * 同款理由）。
     *
     * ⚠️ `modelId` **必须透传**：它同时决定模型级限流过滤与免费判定，
     * 吞掉会让搜索选到聊天链路不会选的号（例如正在限流期的号）。
     *
     * @param modelId - 本次请求的模型 id（取自当前会话路由）。
     * @returns 选中账号的凭据；无可用账号时为 `undefined`。
     */
    resolveCredentialFor(modelId: string | undefined): Promise<QoderCredential | undefined>;
    /**
     * 原生搜索：执行**一次单 query**，返回投影成官方 `sources[]` 形态的结果。
     *
     * ## 协议（全部来自官方客户端源码 + 真机实测，2026-10-14）
     *
     * | 项 | 值 |
     * |---|---|
     * | host | 本产品的 `encryptedInferBase`（CN `gateway.qoder.com.cn`；国际实测 `center.qoder.sh` / `api2.qoder.sh` 均可） |
     * | path | `/api/v1/webSearch/oneSearch` |
     * | body | `{ payload: JSON.stringify({query, timeRange:'NoLimit', contents:{...}}), encodeVersion:'1' }` |
     * | 信封 | body 由 **WASM 加密**；请求头由 `prepareRequest` 生成（含 `Authorization: Bearer COSY.<载荷>.<签名>`） |
     * | 响应 | `{ requestId, pageItems: [{title, link, snippet, publishedTime, hostname, hostLogo}], searchInformation }` |
     *
     * 官方客户端对应实现（`qoder-worker-runtime` 的 `tPl` / `APl` / `$rA`）：
     * ```js
     * let n = i.prepareRequest(A, e, "POST", "auth", t, void 0)
     * return { url: n.url, headers: kc(n.headers), body: n.body ?? t, free: () => n.free() }
     * ```
     *
     * ## ⚠️ 三个必须遵守的点
     *
     * 1. **`QoderEncryptedInfer` 每次建、每次 `dispose()`**：`gluePromise` 是进程级
     *    单例，`QoderContext` 是 wasm 堆上的 Rust 对象，不释放会让堆只增不减，
     *    长上下文会话最终以裸 `RuntimeError: unreachable` 暴毙（真实事故史见
     *    `qoder-wasm.ts` 文件头）。用 `try/finally` 而非顺序调用。
     * 2. **`publishedTime` / `hostname` / `hostLogo` 一律丢弃**：官方 output schema
     *    有 `additionalProperties: false`，多传字段会让 `createSuccessResult` 抛
     *    `ToolOutputError`，**整条调用失败**（不是少一条结果）。
     *    ⚠️ **但 `publishedTime` 其实有对应字段**（PR95 审计修正）：官方
     *    `dsh-tool-web` 的 output schema 与 seam 的 `WebSearchSource` **都**声明了
     *    可选的 `publishedAt?: string`（语义就是「provider 给的发布时间戳」）。
     *    原注释把三个字段一锅端说成「schema 不允许」，那对 `hostname` /
     *    `hostLogo` 成立，对 `publishedTime` **不成立**。
     *    ⚠️ **本次仍照原样丢弃**：接它需要先确认 Qoder 的 `publishedTime` 确实是
     *    ISO-8601 字符串（seam 的类型注释如此声明，但我们**没有真机取证**），
     *    而接错的后果是整条调用失败（`ToolOutputError`）—— 收益（多一列时间）远
     *    小于风险。**待办**：取一次真实响应确认格式后再接。
     * 3. **`X-Session-ID` 用随机 UUID**：实测不传也能 200，但官方客户端会带；
     *    这里跟随官方行为。它与账号无关，只是会话标识。
     * 4. **自己 arm 一份 20s 预算**（PR95 审计修正）：只透传 `signal` 会让
     *    `NativeSearchCodes.timeout` / `aborted` 在本路径永不产生，而契约注释却
     *    声称「各适配器 20s 预算小于官方 30s」⇒ 注释与实现不符。
     *
     * @param query - 单个查询串（已由工具层 trim + 去重）。
     * @param credential - `resolveCredentialFor` 的返回值（本方法自己收窄）。
     * @param signal - 取消信号（工具层传多 query 的 batch signal）。
     */
    searchOnce(query: string, credential: unknown, signal: AbortSignal): Promise<NativeSource[]>;
    /**
     * 描述本适配器拥有的 provider 路由。
     *
     * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
     * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
     * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
     * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
     */
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 按 id 取**当前**目录条目（远端优先，回退编译期兜底表）。
     *
     * ⚠️ **不能用构造期的静态索引**：只存在于远端的模型（如 `fast`）查静态表会得到
     * 「未知」，而本方法与 `stream()` 都把它当**能力判据**用 —— `accio` 记过同款教训
     * （把「未知」当「明确不支持」会让能力**静默变窄**：图片被拒、档位消失）。
     */
    /**
     * 按 id 取条目，供**能力/元数据**判据使用：**远端优先，未命中回退编译期兜底表**。
     *
     * ## ⚠️⚠️ 为什么必须是「两份目录的并集」，而不是只用远端
     *
     * 第一版把它写成 `catalogSource().find(...)`（远端落地后静态表完全不参与），
     * 被独立审计打穿（缺陷 1，已复现）：**远端目录是「按账号」下发的**，
     * 一个免费额度号只拿到 2 条；此时静态表里其它 15 条模型会被判成「未知」
     * ⇒ `inputModalitiesFor` 报 `['text']` ⇒ `stream()` **硬拒图片**
     * （`UNSUPPORTED_CONTENT`），同时 `resolveModel` 的 name 退化成裸 id、
     * `context`/`reasoning` 消失、请求体的 `display_name`/`max_input_tokens`/
     * `is_reasoning` 一并退化。
     *
     * | 场景 | 只查远端（第一版） | 并集（现行） |
     * |---|---|---|
     * | `dmodel` + 远端大目录 | ✅ | ✅ 远端优先 |
     * | `dmodel` + 远端只剩 2 条（免费号） | ❌ 硬拒图片 + 元数据退化 | ✅ 回退静态表 |
     * | `fast`（只在远端有） | ✅ | ✅ 远端命中 |
     *
     * ⚠️ **菜单（`listModels`）仍以远端为准** —— 这条并集只作用于
     * 「能力/元数据判据」，不改变「有哪些模型可选」。本仓同型铁律见
     * `docs/agent-notes/client-ui.md` 的「判『某个 id 在不在目录里』时两个目录
     * 来源必须取并集」（Issue IKJW33）：让**能力**判据取并集，让**可选项**保持单一来源。
     */
    private catalogModel;
    /**
     * 模型接受的输入模态。
     *
     * 按**模型**判定（目录条目的 `supportsImage`），不是按 provider 一刀切。
     * 未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
     * 也不要报一个服务端不认的模态（请求会失败）。
     *
     * ⚠️ 判据取自 `catalogModel()`（**远端 ∪ 静态表**）—— 只取远端会让
     * 「按账号收缩的目录」把静态表里已知的模型判成未知（见该方法的表）。
     */
    private inputModalitiesFor;
    /**
     * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率/免费标记）。
     *
     * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
     * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名与倍率随之丢失
     * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
     *
     * ⚠️ **2026-10-08 Task 7b**：骨架（含上面这条理由）已上移到共享实现
     * `src/model-catalog.ts`，此处只剩委托。
     *
     * ⚠️ **2026-10-08 复审**：本方法上方原先还压着**一段无主的 JSDoc**
     * （以「模型目录。」开头、讲「Qoder 的模型列表端点需要 WASM 签名」）——
     * 它本来是某个已被删掉的方法的文档，删方法时留下了壳。
     * 它与紧邻的本块连在一起看像「同一个方法有两套互相矛盾的文档」。
     * 已删除。
     *
     * ⚠️ **那段旧文档里「恒用产品兜底表、不发网络请求」这句已于 2026-10-20 作废**：
     * 本家现在与其余 12 家同形 —— 远端优先（`src/qoder-catalog.ts`）、
     * 兜底表只作回退。见 `catalogSource()` 的注释。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    /**
     * 把本家目录条目（**远端优先**，回退兜底表）转成共享骨架的中间结构。
     *
     * ⚠️ 远端条目经 `src/qoder-catalog.ts` 归一成与兜底表**同形**的结构后才到这里
     * ⇒ 倍率/档位/能力三条判据对两条来源**完全同源**（不会出现「远端少了某个
     * 字段于是倍率不显示」这类分叉）。
     */
    private toCatalogEntry;
    /**
     * 该条目的思考档位。
     *
     * ⚠️ **`reasoning` 是「思考强度」选择器出现在模型菜单里的唯一入口**
     * （composer 读 `resolveModel().reasoning`）。此前本适配器**只声明了
     * `context`，从不声明 `reasoning`** → 中国版/国际版全都看不到档位选择器，
     * 尽管目录早已下发 `thinking_config`（用户报障「qoder中国版可以设置思考档位，
     * 我们应该按照他的设置给出可设置的档位选择」）。
     */
    private reasoningForEntry;
    /**
     * 目录来源：**远端优先**，未落地时回退编译期兜底表。
     *
     * ⚠️ 回退不是「优化」而是**必需**：纯插件用户（或上游目录接口故障时）
     * 若目录为空，DSH 的 `buildModelCatalog` 会把该 provider 判成「没有模型」
     * 而**整个隐藏**（`providerCatalogVisible` 之外的第二层门）。
     */
    private catalogSource;
    /** 同步视图（`listAllModels()` 与 `CatalogEntry` 转换共用）。 */
    private syncCatalogEntries;
    /** 编译期兜底表的条目视图（第二套骨架专用；同步、零网络）。 */
    private fallbackEntries;
    private loadCatalogEntries;
    /**
     * 该模型是否**消耗 0 积分**（免费额度模型）。
     *
     * ## 为什么必须有这个方法（真实报障 2026-10-21）
     *
     * 用户开着「锁定永久积分」，用**免费模型**（CN `Qwen3.8-Flash` / `DeepSeek-Flash`、
     * 国际版 `Qwen3.8-Max` / `Qwen3.8-Flash`）请求，却报「没有可用账号 ⋯ 当前账号的
     * 额度都属于长期 / 永久」。
     *
     * 根因：`src/credential-resolver.ts:368` 的免费短路**只在 `plan.isFreeModel`
     * 存在时**才可能命中。本家装配层（`src/index.ts` 的两处 `balance:`）**从未传
     * `isFreeModel`** ⇒ 免费模型与付费模型走同一条余额分档路 ⇒ 锁定期间被
     * `allowPermanent=false` 一并拦下。报出的错误还**自相矛盾**：免费模型既不扣
     * 临时也不扣永久积分，说它「额度都是永久的」毫无意义。
     *
     * 这与 buddy / trae 的成文教训是同一个（`credential-resolver.ts:359-365` 的
     * 长注释记录了 buddy 那次报障）：**保护永久积分的闸门不该拦免费模型**。
     *
     * ## 判据：只认目录里明确的 `isFree`
     *
     * - 两条来源（远端目录 / 编译期兜底表）**同源**：`src/qoder-catalog.ts` 的
     *   `qoderRemoteModelToFallback()` 已把远端 `is_free` 归一成 `isFree` 并透出
     *   （`:425`），与兜底表的 `isFree: true` 是同一个字段 ⇒ 不存在「远端少了字段
     *   于是判不出免费」这种分叉。
     * - ⚠️ **不用 `priceFactor === 0` 代替**：`priceFactor` 是「计费倍率」，它等于 0
     *   与「这个模型免费」在本家是两条独立信号（CN `dfmodel` 就是
     *   `priceFactor: 0` + `isFree: true`，而国际版 `qmodel_38max` 是
     *   `isFree: true` + `priceFactor: 0.2` —— **免费但倍率非 0**）。用倍率推断免费
     *   会漏掉后者、并把倍率解析失败（undefined）误判成免费。
     * - **只在确定免费时返回 true**：查不到目录 / 解析失败一律 false。方向保守 ——
     *   宁可多走一次余额门（用户至多多一次网络请求），也不要把付费模型误判成免费
     *   （那会**真的烧掉永久积分**，是不可逆损失）。与 `BuddyAdapter.isFreeModel`
     *   同一约定。
     * - ⚠️ 远端目录懒加载，**必须先 `await ensureRemoteModels()`**：否则「直接进
     *   会话」等路径尚未加载目录，会静默退回被拦截的行为（trae 的同款教训见
     *   `TraeAdapter.isFreeModel` 的注释）。
     *
     * @param modelId - 模型 id（目录 key，如 `qfmodel`）。
     * @returns true 仅当目录明确标记 `is_free`。
     */
    isFreeModel(modelId: string | undefined): Promise<boolean>;
    /**
     * 懒加载远端模型目录（**每 20 分钟**一次；失败/空结果走闸门冷却）。
     *
     * 三条口径与其余 12 家逐字同构：
     * 1. 入口用 `isCatalogFreshFor`（多一条「用户刚改设置⇒立即失效」的正交腿）；
     * 2. 并发去重与失败冷却交给 `RemoteCatalogGate`（同一份实现，不自己写判据）；
     * 3. **只在成功时**记 `catalogAt`（失败也记会让一次网络抖动把 TTL 上界刷掉，
     *    下一轮要再等满 20 分钟才发现上游没恢复）。
     */
    private ensureRemoteModels;
    /**
     * 真发一次远端目录请求（失败返回空数组，由闸门记冷却）。
     *
     * ⚠️ **不在这里解析凭据**：取数是接线层注入的 `fetchRemoteModels`
     *（= `QoderAuth.fetchModels(pool)`），它只做池的**只读**读取。
     * 理由见 `QoderAdapterOptions.fetchRemoteModels` 的长注释
     *（走 `resolveCredential` 会把「本次实际使用的账号」改写成目录用的账号）。
     */
    private loadRemoteModels;
    private nowImpl;
    /**
     * ★ **后台目录刷新入口**（`src/index.ts` 的 `refreshOf` 调 `adapter.refresh?.()`）。
     *
     * ⚠️⚠️ **必须显式转发** `catalog.refresh`：`ModelCatalog` 上的成员**不会**
     * 自动变成适配器的成员（`dead-model-store.ts` 的 `pruned()` Proxy 只透传
     * **适配器自己的**成员）。漏转发 ⇒ 刷新器「已武装」却对本家**空转**，
     * 且**零日志** —— 这条陷阱在 `accio-adapter.ts` 有逐字记录（`be42b25` 踩过）。
     * ⚠️ 与 `options.refresh`（HTTP 401 后的**凭据**续期）**不是同一件事**，
     * 两者同名纯属巧合，**不得合并**。
     */
    refresh(): Promise<void>;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * 解析模型元信息（**能力/元数据的并集回退**，见 `catalogModel()` 的表）。
     *
     * ## ⚠️ 为什么这里要路由到两套目录
     *
     * `resolveModel` 与 `listModels` **共用** `loadCatalog()`，但两者的正确口径不同：
     * - `listModels`（**菜单**）必须**只**给当前账号真能用的模型 ⇒ 远端独占；
     * - `resolveModel`（**元数据**）必须认识「可能正在被使用、但不在当前账号菜单里」
     *   的模型（会话开着、目录随账号收缩）⇒ 远端 ∪ 静态表。
     *
     * 故：远端目录认识该 id 就照旧走它（新值优先）；不认识而静态表有，就交给
     * **静态表专用的第二个骨架实例** —— 复用骨架自己的装配逻辑（裸名 / context /
     * reasoning 三态），**不在这里重写一遍**（那会是同一语义的第二套判据）。
     */
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
     * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
     * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
     * `registration.adapter.prepareCall is not a function`。
     * 与 `BuddyAdapter` / `LobsteraiAdapter` 同款 shim。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 失败后：**按类别决定「写不写冷却」，然后切下一个账号**。
     *
     * ## 用户要求（2026-09-27，额度类）
     *
     * > qoder 碰到当日额度受限应该像 workbuddy/codebuddy 一样，设置一个模型受限时间
     * > （他们是返回错误中带时间，qoder 和 qodercn 需要自己设置当日 24:00 受限）
     * > 然后切换账号池中的下一个可用模型
     *
     * ## 2026-10-21 扩展：不再只服务「额度」一类
     *
     * 用户真实报障：池里 2 个 `qodercn` 账号，上游回
     * `provider_error`（归 `SERVER`）时**第二个账号从未被尝试** —— 因为旧实现
     * 把「写冷却」和「换号」绑死，且只有额度一条判据。
     *
     * ⇒ 拆成两张表（照 `accio` / `minimax` / `loomy` / `raccoon` / `trae` 的
     * 既有范式，见 {@link classifyQoderFailure} 的语义表）：
     * - {@link shouldRotateQoderAccount} 决定**换不换**；
     * - {@link recordsQoderRateLimit} 决定**记不记**。
     *
     * ## ⚠️ 与 buddy/CodeArts 的**关键差异**
     *
     * 它们的错误文案里**带重置时间**（`parseRateLimitError` 从中解析）；
     * Qoder 的额度**不带** —— 故这里用 {@link nextUtc8DayStartMs} **自己算**
     * 「UTC+8 当日 24:00」。**不能**复用 `parseRateLimitError`：它会因解析不到
     * 时间而退回「1 小时后」（`Date.now() + 3_600_000`），那对**按自然日**结算的
     * 额度是错的 —— 会让标记过早失效，用户 1 小时后再撞一次同样的墙。
     *
     * @param activeAccountId - **当前正在使用的**账号 id（见下）。
     * @param cls - 失败类别（决定写不写冷却）。**必填**：给出默认值会让调用方
     *   忘记传时静默退化成「一律记额度冷却」—— 那正是 2026-10-10「全池被封」的形态。
     * @returns 新凭据；无可用账号时 `undefined`（调用方如实抛出原错误）。
     */
    private switchAccountOnQuota;
    /**
     * 排队等待（HTTP 层与 SSE 层**共用**）。
     *
     * 两处形态必须走同一套判据，否则会再次出现「只修了一条路径」的缺陷。
     */
    private waitForQueue;
    /**
     * 确保凭据带 **`uid`**（加密推理必需），必要时经注入钩子补齐。
     *
     * ⚠️ 缺 uid 时**不能静默用空串发请求** —— 那样 WASM 会产出签名无效的
     * 请求，服务端回 `Signature invalid (101)`，用户看到的是「签名错误」
     * 而非「凭据不完整」，极难定位（真实缺陷）。这里宁可明确报错。
     */
    private ensureUid;
    /** 发送一次**加密**推理请求（`agent_chat_generation`）。
     *
     * @param fetcher 本次要走的 fetcher（由调用方按**当前生效账号**现取）。
     *   ⚠️ **必须由调用方传**而不是方法内自己取：换号后出口要跟着换，
     *   而 `this` 上没有任何字段能反映「循环里当前是哪个账号」。
     */
    private sendEncrypted;
}
/**
 * 判断当前是否落在错峰折扣窗口内（本地推算）。
 *
 * ⚠️ **为什么不直接用目录的 `promotion.active`**：那是**目录下发那一刻**的
 * 快照，客户端长时间不重启就会过期 —— 用它会让用户在窗口外看到折后价
 * （按折扣价预期、实际按原价计费），或窗口内看不到折扣。
 * 窗口本身（`windowStart`/`windowEnd`）稳定，故按当前时间**本地推算**。
 *
 * 窗口按 **UTC+8** 计（目录 `timezone: Asia/Singapore`，与用户所在时区一致）；
 * 支持跨零点（如 22:00–08:00）。窗口字段缺失时回退到目录的 `active`。
 */
export declare function promotionActiveNow(promotion: QoderModelPromotion, now: Date): boolean;
/**
 * 生成模型选择器里显示的名字。
 *
 * 形态（**与 TRAE / buddy 三 provider 统一**）：
 *
 * ```
 * Qwen3.8-Flash · 免费            ← priceFactor = 0
 * Qwen3.8-Max · x0.5→x0.2        ← 折扣窗口内：原价→折后价
 * Qwen3.8-Max · x0.5             ← 窗口外：只有原价
 * Sonus · x8                     ← 无促销
 * ```
 *
 * ⚠️ **倍率必须写进 `name` 而不是 `description`**：composer 的模型切换菜单
 * 只渲染 `name`（见 dsh-client-ui-model-selection 的 ModelSelect：
 * `children: model.name`），`description` 仅用于 `/model` 弹窗。
 *
 * ⚠️ **折扣统一用「原价→折后价」箭头**，不再附中文角标（如「错峰 4 折」）：
 * ① 旧形态只有折后价，看不出原价与折扣幅度；② 角标与数字**冗余**
 * （0.2/0.5 本就是 4 折）。TRAE（`x0.4→x0.2`）与 buddy（`x0.79→x0.50`）
 * 早就是这个形态，本次把 Qoder 对齐过去。
 *
 * ⚠️ 折后价**不直接采信目录的 `priceFactor`**：它是采集时刻的生效价，
 * 窗口切换后即失真。改为按 `beforePromotionPriceFactor × discountFactor`
 * 本地推算（实测三条全部吻合），窗口外则用原价。
 */
export declare function qoderDisplayName(model: QoderFallbackModel, now?: Date): string;
/**
 * 在 `ctx.llm` 上注册 Qoder provider 路由与适配器。
 *
 * 路由名与展示名由产品配置驱动，得到 `qoder`。
 *
 * ⚠️ 刻意**不**向 DSH 声明可配置 provider（`registerConfigurableProviders`）——
 * 详见 `llm-register-compat.ts` 模块头。
 */
export declare function registerQoderLlm(ctx: Context, options: QoderAdapterOptions): QoderAdapter;
//# sourceMappingURL=qoder-adapter.d.ts.map