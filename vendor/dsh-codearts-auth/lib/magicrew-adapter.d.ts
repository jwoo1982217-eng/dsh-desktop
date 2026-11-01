/**
 * Magicrew（超级麦吉）的 `LlmAdapter` 实现 —— 推理面 + 目录面。
 *
 * ## 只做**流式**
 *
 * 实测（2026-10-28）非流式也能用（正常 JSON），但本实现**只走流式**：
 * 用户明确要求，且流式才能把 `reasoning_content` 分片及时交给上层。
 * ⚠️ magpie 的 `internals.md` 说「非流式被 11101 拒」是**旧记录、已被本轮实发否定**。
 *
 * ## 成功判据是**业务码**，不是 HTTP 状态
 *
 * 实测：用错配的 api_key 会得到 **HTTP 200 + `{"code":403,"message":"token无效"}`**
 * （content-type 是 `application/json` 而不是 `text/event-stream`）。
 * ⇒ 进流之前**必须先看 content-type**，否则会把这段 JSON 当 SSE 读、报「没收到任何内容」。
 *
 * ## 当前进度
 *
 * 目录面 + 推理面均已接线：静态表兜底 + 远端目录 + `createModelCatalog` 共享骨架。
 *
 * ## ⚠️ SSE 解析必须走共享件，**不得**在本文件手写
 *
 * 4c 曾在这里手写 `readSse` —— 那是**重复实现**（本仓库红线：一份文件里两套同义判据），
 * 而且手写版**没有**工具调用增量、`reasoning` 别名、两级超时、流内错误帧分类。
 * 现统一走 `openai-compat.ts:600` 的 {@link consumeOpenAiSse}（qoder / astudio /
 * officeace 等 8 家共用），`tool-call-delta` 因此才真正接上线。
 *
 * ## 消息序列化同样**走共享件**，不得手写
 *
 * 4c/4d 曾在这里手写 `toWireMessages` / `toWirePart` —— 与 SSE 那次同构的重复
 * 实现。它的实际后果不是「少几个字段」，而是**多轮工具往返丢工具结果**：
 * `tool-call` / `tool-result` / `reasoning` 三种块被映射成空文本占位 ⇒ wire 上
 * 既没有 `tool_calls` 也没有 `role:'tool'` ⇒ 模型看不到自己上一步的工具输出
 * （DSH 是 coding agent，工具往返是核心功能）。
 * 现统一走 `openai-compat.ts:186` 的 {@link serializeMessages}：它自带 harness
 * 消息形状归一（DSH 0.1.7 的一等 `role:'tool'`）、`resolveToolPairing`（工具
 * call/result 配对 + 孤儿剔除 + 空名调用剔除）与工具结果图片提升。
 *
 * ## 图片：**宁报错，不降级**
 *
 * 目录里的模型声明了 image 模态 ⇒ 用户发图时「把图换成占位文字」会让模型
 * **以为看到了**（幻觉），正是本仓库明令禁止的「省略 / 降级 = 放行」。
 * 故这里只有两条路：经注入的 `readImage` **真读字节**内联
 * （`data:<mime>;base64,…`），或抛 `INVALID_REQUEST`（未配置读图入口）。
 * 任务 6 会在 `index.ts` 桥接 `ctx.attachments.readImage`。
 */
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AccountPool } from './account-pool.js';
import { type MagicrewProduct } from './magicrew-product.js';
import { type MagicrewCredential } from './magicrew-auth.js';
import { type MagicrewCatalogModel } from './magicrew-catalog.js';
/**
 * 内联一张图片为**原始字节**的注入点（由接线层桥接 `ctx.attachments.readImage`）。
 *
 * ⚠️ 契约与 `accio-adapter.ts:304` / `buddy-adapter.ts` 一致：**读不到返回 `undefined`**
 * （不是抛错、也不是返回空）—— 由本适配器统一判成 `INVALID_REQUEST`。
 */
export type MagicrewReadImage = (attachment: unknown) => Promise<{
    data: Uint8Array;
    mediaType: string;
} | undefined>;
export interface MagicrewAdapterOptions {
    readonly product?: MagicrewProduct;
    readonly fetchImpl?: typeof fetch;
    readonly warn?: (message: string) => void;
    readonly now?: () => number;
    readonly accountPool?: AccountPool;
    readonly resolveCredential?: () => Promise<MagicrewCredential | undefined>;
    readonly fetchRemoteModels?: () => Promise<readonly MagicrewCatalogModel[]>;
    /**
     * 读图入口（任务 6 在 `index.ts` 桥接 `ctx.attachments.readImage`）。
     *
     * ⚠️ **缺省时遇到图片块必须抛错**，绝不降级成占位文字：目录里 vision 模型
     * 声明了 image 模态，用户发图后模型「看不到但以为看到了」= 幻觉，
     * 且症状是 HTTP 200 + 正文正常 + 上游零报错，几乎无法归因。
     */
    readonly readImage?: MagicrewReadImage;
}
export declare class MagicrewAdapter extends LlmAdapter {
    private readonly product;
    private readonly fetchImpl;
    private readonly warnImpl;
    private readonly nowImpl;
    private readonly resolveCredentialImpl;
    /**
     * 倍率表（model_id → inputPoints/outputPoints），由 loadModelPoints 填充。
     * 懒加载、失败静默：装饰性信息，拉不到就当没有，绝不影响目录本身。
     */
    private modelPoints;
    private readonly fetchRemoteModelsImpl;
    private readonly readImageImpl;
    private readonly catalog;
    private remote;
    private catalogAt;
    /** 上次**失败**的时间戳（负缓存用；0 = 从未失败）。 */
    private catalogFailedAt;
    private catalogInFlight;
    constructor(options?: MagicrewAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * `prepareCall` shim（PR !66 要求必须包）：解析出的 model 与本次 stream 属于同一代。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /** 同步全量目录（Jet Hub 的「显示列表」用）。 */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    /**
     * 强制重拉目录（`index.ts` 的 20 分钟后台刷新器与本文件的 `refresh` 一致）。
     *
     * ⚠️⚠️ **必须显式转发**（2026-10-29 审查发现）：`refresh` 是
     * `createModelCatalog` 返回的 **catalog 实例**上的成员，给 `config.refresh`
     * 传回调**不会**自动变成适配器的成员。而刷新器调的是 `adapter.refresh?.()`
     * ⇒ 不转发时它**静默跳过**（日志为真、实际零请求），与
     * `astudio-adapter.ts:444` 记的是同一个坑。`model-catalog-parity.spec.ts:747`
     * 会对「catalog 有 refresh 而适配器没有」的家**点名失败**。
     */
    refresh(): Promise<void>;
    /**
     * 一次推理 —— **只走流式**（用户明确要求；`requestBody` 恒 `stream: true`）。
     *
     * ⚠️⚠️ **成败判据是业务码，不是 HTTP 状态**：用错配的 api_key 会得到
     * `HTTP 200 + {"code":403,"message":"token无效"}`，`content-type` 是
     * `application/json` 而不是 `text/event-stream`。⇒ 进流之前**必须先看 content-type**，
     * 否则会把这段 JSON 当 SSE 读，症状退化成「没收到任何内容块」，与真因相距很远。
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 发推理请求并**只对「等响应头」这一段**设上限。
     *
     * ⚠️⚠️ 为什么必须单独一段（2026-10-29 审查）：`chatHeaderTimeoutMs` 此前只被喂给
     * `consumeOpenAiSse` 的 `firstTokenTimeoutMs`，而那是**拿到响应头之后**的首 token
     * 空闲超时 ⇒「等头」这一段**没有任何超时**，只靠 undici 默认（约 300s）。
     * 症状：网关卡在排队时用户看到一个「永远转圈、停止按钮也不一定立刻生效」的会话。
     * 而 `product.requestTimeoutMs` 在 `src/` 里当时**零读者**。
     *
     * ⚠️ 拿到响应头**立即** `clearTimeout`（`finally` 里）：这条定时器只管「等头」，
     * 绝不能误杀后面的长回答（推理模型可能长时间只吐 reasoning）。
     * 与 `opencode-adapter.ts:671` 的先例同形（独立 `AbortController` +
     * `AbortSignal.any` 合并调用方 signal + 超时后**抛出 controller 的 reason**）。
     */
    private fetchChat;
    private requestBody;
    /**
     * wire 消息 = 共享件 {@link serializeMessages} 的产物（+ `options.system`）。
     *
     * ⚠️⚠️ **不得在本文件另写一份**（本仓库红线：一文件两套同义判据）。手写版
     * （4d 的 `toWireMessages` / `toWirePart`）的实测后果不是「少几个字段」，而是
     * **多轮工具往返丢工具结果**：`tool-call` / `tool-result` / `reasoning` 三种块
     * 被映射成空文本占位 ⇒ wire 上既无 `tool_calls` 也无 `role:'tool'` ⇒
     * **模型看不到自己上一步的工具输出**（工具往复是 DSH 的核心功能）。
     *
     * ⚠️ **`options.system` 不在 `messages` 里**（它是「一次性调用方」的独立入参，
     * 见 `GenerateOptions.system` 的注释），`serializeMessages` 只吃 `messages`
     * ⇒ 必须自己前置成 system 消息，否则整段系统提示**静默丢失**。
     * 与 `cline-adapter.ts:868` / `loomy-adapter.ts:996` / `raccoon-adapter.ts:690`
     * 同形（前置在数组最前面，先于 `messages` 里可能已有的 system 消息）。
     */
    private wireMessages;
    /**
     * 收集图片附件 → 读字节 → `attachmentId → data URL` 映射（`serializeMessages` 的第二参）。
     *
     * ⚠️⚠️ **key 的语义**：共享件的消费点是 `userContentParts`
     * （`openai-compat.ts:113`）—— 它用 `block.attachment.attachmentId` 去查表。
     * 而 `collectImages`（同一文件 `:155`）收集时写入的 key **就是** `attachmentId`，
     * value 是**附件引用对象本身**（正是 `readImage` 的入参）⇒ 两条腿天然同源，
     * 不需要另造 id、也不需要把 ref 反解成字节。
     *
     * ⚠️ 返回 `undefined` 表示「整个请求没有图片」：`serializeMessages` 会走**纯文本**
     * 老路径（字符串形态 `content`）。返回**空 Map** 是另一种语义（「有图但读不到」），
     * 会把 user 消息升级成 parts 并留 `[image unavailable]` 占位 —— 那正是本适配器
     * **刻意不做**的降级（见下一条）。
     *
     * ⚠️ **缺读图入口 / 读不到字节 ⇒ 抛 `INVALID_REQUEST`，绝不降级成占位文字**
     * （4d 的策略原样保留）。占位符会让模型「看不到却以为看到了」= 幻觉，且症状是
     * HTTP 200 + 正文正常 + 上游零报错，几乎无法归因。
     * ⚠️ 未配置 vs 读不到是**两种不同的缺口**，文案必须分开（否则用户无从自救）。
     */
    private imageUrlsOf;
    private toEntry;
    private loadEntries;
    private syncEntries;
    private staticModels;
    private loadModels;
    /** 真正的拉取（含注入拉取器 + 生产路径两级回退），由 {@link loadModels} 去重与门控。 */
    private fetchModels;
    /**
     * 拉一次倍率表（products/model-points）并缓存。
     * 失败静默：倍率是装饰性信息，让它的失败冒泡会让整份目录回退到静态表。
     * 空目录直接跳过（没有 id 可问，白花一次请求）。
     */
    private loadModelPoints;
    /** 记一次目录**成功**：刷新时间戳并清掉失败退避（只此一处，避免两套写法）。 */
    private rememberModels;
}
//# sourceMappingURL=magicrew-adapter.d.ts.map