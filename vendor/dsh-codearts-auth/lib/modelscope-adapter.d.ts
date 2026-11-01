/**
 * ModelScope（魔搭）LLM 适配器。
 *
 * ## 协议形态：**标准 OpenAI 兼容**，无任何厂商私有信封
 *
 * 与 qoder（WASM 签名 + 加密体）、trae（SOLO 双层转换）、gemini（字母序双层
 * 信封）不同，魔搭就是标准 OpenAI 协议 —— 这正是它能**大面积复用共享抽象**的
 * 原因：
 *
 * | 复用点 | 来源 |
 * |---|---|
 * | 消息序列化（含 0.1.7 形状归一化、工具配对剔除、图片 parts） | `openai-compat.ts` 的 `serializeMessages` |
 * | 图片引用收集 | `openai-compat.ts` 的 `collectImages` |
 * | SSE 消费（思考字段、工具增量合并、截断判定） | `openai-compat.ts` 的 `consumeOpenAiSse` |
 * | 幂等注册 + Token 记账 + 失效模型剔除 | `llm-register-compat.ts` 的 `registerAdapterIdempotent` |
 * | 附件字节桥接 | 接线层的 `makeReadImage` / `makeReadImageRequest` |
 *
 * **本文件不重复实现上述任何一条** —— 旧 fork 那份 `remote-upstream.ts` 曾把
 * 消息序列化与 SSE 解帧各写一遍（且与另外两份实现**不一致**，实测漏掉了
 * `prompt_tokens_details.cached_tokens`，导致魔搭承接的步长永远显示「缓存命中 0」，
 * 见旧 fork `src/transport/usage.ts:4-8`）。这里直接走共享实现，从根本上避免分叉。
 *
 * ## 轮换语义：「类别 → 动作」表（不照抄循环骨架）
 *
 * AGENTS.md 有一节专门讲这个（2026-10-06 的事故：照抄循环骨架、漏抄分支语义表，
 * 导致全池 6 个账号各被封 24h）。本适配器的表：
 *
 * | 类别 | 换号？ | 写限流标记？ | 抛什么 |
 * |---|---|---|---|
 * | `auth`（401/403） | 换 | **不写** | 全试完则抛 `AUTH`（保留服务端原文） |
 * | `rate_limit`（429） | 换 | **写**（服务端给了 `retry-after` 就用它，否则指数退避、封顶 30 分钟） | 全试完抛 `QUOTA_EXCEEDED` |
 * | `quota`（额度耗尽） | 换 | **写**（当日 24h） | 同上 |
 * | `invalid_request`（400/422） | **不换** | 不写 | 直接抛 `BAD_REQUEST` |
 * | `server`（5xx） | 换 | **不写**（不是配额问题） | 全试完抛原错误 |
 * | `transport`（网络） | 换 | **不写** | 全试完抛原错误 |
 *
 * ⚠️ **认证类绝不写限流标记**：魔搭的网关在异常时可能对全池回 401，
 * 若按「凡可换号就写冷却」处理，一个请求内就能把整池账号全部标记掉
 * （正是 2026-10-06 事故的形态）。
 *
 * ## ⚠️ 已产出内容的流不重放
 *
 * 轮换只在**尚未 yield 任何 chunk** 时发生。一旦开始产出，再失败只能上抛 ——
 * 否则用户会看到两份重复输出（`openai-compat` 的模块头有同款说明）。
 *
 * @module src/modelscope-adapter.ts
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { AccountPool } from './account-pool.js';
import { type ModelscopeErrorInfo, type ModelscopeErrorKind, type ModelscopeProduct } from './modelscope-product.js';
/** 目录条目（远端与兜底共用的输出形状）。 */
export interface ModelscopeCatalogEntry {
    id: string;
    name: string;
    contextWindow: number;
    supportsImage: boolean;
    efforts?: readonly string[];
}
/** 清空目录缓存（RPC 的「刷新目录」与单测隔离用）。 */
export declare function clearModelscopeCatalogCache(): void;
/** 远端目录拉取（注入以便单测离线）。 */
export type ModelscopeCatalogFetcher = (apiKey: string, signal?: AbortSignal) => Promise<Response>;
/** 拉目录时的凭据提供者（返回 undefined 表示无可用账号）。 */
export type ModelscopeCredentialProvider = () => Promise<{
    apiKey: string;
} | undefined>;
/**
 * 解析远端 `GET /v1/models` 的响应体。
 *
 * ## ⚠️ 三个字段都**尽力而为**，拿不到就回落到兜底表的值
 *
 * 实测（旧 fork 反代）：魔搭的 `/v1/models` 返回标准 OpenAI 目录形状
 * `{ data: [{ id, object, created, owned_by }] }`，
 * **不一定**带窗口/模态信息。故：
 *
 * - `context_window` / `limit.context` 两个来源都试 —— 拿不到时**从兜底表按
 *   id 查**（查到就用，查不到留 `0` 哨兵）。⚠️ **绝不编造数字**：
 *   `contextWindow` 是 DSH 自动压缩阈值的输入，编一个会让压缩在错误的位置触发
 *   （opencode 的 issue IKJJ68 同因）；
 * - `modalities.input` 含 `image` 才算支持图片；拿不到时同样回落到兜底表 ——
 *   本仓库的硬约定是「**声明支持就必须真支持**」，故**未知一律按不支持**处理
 *   （除兜底表里明确记着支持的）；
 * - 窗口/模态**都只认「远端明确给出」或「兜底表明确记着」**，不猜。
 */
export declare function parseModelscopeCatalog(body: unknown): ModelscopeCatalogEntry[];
/**
 * 拉取远端目录，失败回退静态兜底。
 *
 * @param ttlMs 命中内存缓存的窗口；测试传 0 强制每次都拉。
 *
 * ⚠️ **必须有超时**（接线层给）：桌面版到外部域名的 fetch 可能**永不 settle**
 * （opencode 的真机事故 2026-10-02：没有超时 → `listModels` 永不返回 →
 * **模型列表与徽标同时空白**）。有超时则超时后回退兜底表，UI 立刻可用。
 */
export declare function loadModelscopeCatalog(fetchCatalog: ModelscopeCatalogFetcher, apiKey: string, ttlMs?: number, signal?: AbortSignal): Promise<readonly ModelscopeCatalogEntry[]>;
/** 一个可发起请求的槽（账号）。 */
export interface ModelscopeSlot {
    readonly id: string;
    readonly apiKey: string;
}
export interface ModelscopeAdapterOptions {
    /**
     * 单凭据回退 ref（无账号池条目时用）。
     *
     * ⚠️ 类型是 `unknown` 而不是品牌类型 `CredentialRef` —— 本适配器**不用它做
     * 解析**（凭据一律经 `slots()` 由接线层解析好传进来），保留这个字段只为与
     * 其余 15 个 `registerXxxLlm` 的选项形状一致，避免调用方误以为「不传就少了
     * 一条解析路径」。做成 `unknown` 可免去在适配器里 import 凭据模块的类型。
     */
    credentialRef?: unknown;
    /**
     * 取当前可用槽序列（按账号池的手动顺序）。
     *
     * @param modelId 目标模型。**推理路径必须传**，接线层据此过滤掉
     *   「该模型正处于限流窗口」的账号（与其余 15 家的 `getAvailableAccount` 同语义，
     *   见 `src/index.ts` 的 `throwIfAllAccountsRateLimited`）。
     *   ⚠️ **目录路径刻意不传**：目录要的是「这个渠道有哪些模型」，
     *   与「哪个账号此刻被限流」无关；传了会让被限流的账号把整个目录一起拖空。
     */
    slots: (modelId?: string) => Promise<readonly ModelscopeSlot[]>;
    /**
     * 账号池（**黑名单、关闭意图、目录门控的唯一数据源**）。
     *
     * ⚠️⚠️ **2026-10-23 迁移**：本家此前手写 `listModels`，黑名单与关闭意图靠
     * `disabledModels` / `providerClosed` 两个**选项回调**传进来。那两个字段
     * 已随迁移删除 —— 现在统一由共享骨架（`model-catalog.ts`）从本池读取，
     * 与其余实体 provider 同源。
     *
     * ⚠️ 省略时（单测 / 嵌入方）行为退回「不过滤、不判关闭意图」；
     * **生产接线必须传**（`index.ts` 负责，且 `modelscope-wiring.spec.ts` 会点名）。
     */
    accountPool?: AccountPool;
    /** 记录受限的副作用（切槽时由接线层提供）。 */
    markLimited?: (slotId: string, modelId: string, resetAtMs: number) => Promise<void>;
    /** 诊断日志。 */
    warn?: (message: string) => void;
    /**
     * 附件字节读取。**只有在模型被声明为支持图片时才会被调用**。
     *
     * ⚠️ 缺省时带图请求会抛 `UNSUPPORTED_CONTENT`（见 `resolveImageUrls`），
     * 而不是把图片静默丢掉（Qoder 图片丢失事故的教训：模型看不到图却照常回答，
     * 用户拿到的是幻觉结果）。
     */
    readImage?: (ref: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 拉远端目录；缺省时直接用兜底表。 */
    fetchRemoteCatalog?: ModelscopeCatalogFetcher;
    /** 产品配置；默认 {@link MODELSCOPE}。 */
    product?: ModelscopeProduct;
}
/**
 * 把「错误语义 + 服务端给的延迟」换算成该槽该模型的受限时长。
 *
 * ⚠️ **服务端给了就用它的**，且 **0 是合法值**（「立即解除」而非「未知」）：
 * 必须用 `=== undefined` 判空，写成任何 falsy 判据都会把 0 静默换成 1 小时
 * （`src/retry-after.ts` 的模块头记录了这条教训）。
 */
export declare function modelscopeRetryAfterMs(kind: ModelscopeErrorKind, retryAfterMs: number | undefined, attempt: number, 
/** 注入时钟（单测用）；默认 `Date.now()`。与仓库其它时间函数同约定。 */
nowMs?: number): number;
export declare class ModelscopeAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    /**
     * 最近一次成功解析出的目录快照（**仅供同步路径**读取）。
     *
     * ⚠️ 它不是缓存 —— 权威缓存仍是 `loadModelscopeCatalog` 那份带 TTL 的
     * （见 `catalog()` 的注释：在适配器上另立缓存会让目录永不过期）。
     * 这里只是把「上一次的结果」留给 `listAllModels()` 那个**必须同步**的调用者。
     */
    private lastCatalog?;
    /**
     * 共享目录骨架（`model-catalog.ts`）——**黑名单 / 关闭意图 / 模态回填 / 映射**
     * 的唯一实现处（2026-10-23 迁移，见 `listModels` 的注释）。
     */
    private readonly skeletonCatalog;
    constructor(options: ModelscopeAdapterOptions);
    /**
     * 异步读目录并转成骨架的中间结构（`CatalogEntry[]`）。
     *
     * ⚠️ **本家独有的门控放这里**：没有可用槽位时返回 `[]`
     * （骨架把它当「目录为空」⇒ `listModels` 吐空数组 ⇒ 隐藏整个 provider 分组，
     * 与本文件迁移前那条 `if (slots.length === 0) return []` 逐字等价）。
     */
    private loadCatalogEntries;
    /**
     * **同步**全量目录（`listAllModels()` 用）。
     *
     * ⚠️ 与 `loadCatalogEntries` 的差别只在「等不等远端」：这里读上一轮缓存，
     * 缓存为空时用兜底表并**顺手**触发一次后台预热（同步契约见 `listAllModels`）。
     */
    private syncCatalogEntries;
    /** 本家私有形状 → 骨架的 `CatalogEntry`（**唯一**转换点）。 */
    private toCatalogEntry;
    providerInfo(provider: string): LlmProviderInfo;
    /**
     * 完整目录（**同步**返回数组）。
     *
     * ⚠️ **绝不能写成 async**：`jet-hub-rpc.ts` 的 `ModelCatalogSource` 接口是
     * 同步的且消费者**不 await**（`catalog = [...all]`），返回 Promise 会抛
     * `TypeError: all is not iterable`（minimax 的同款真实缺陷）。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    /**
     * 同步取「已缓存的远端目录」；没有缓存则返回 undefined。
     *
     * ⚠️ 只读缓存、**绝不发起网络请求** —— 本方法在 UI 的同步路径上被调用
     * （`catalog = [...all]`，见 `jet-hub-rpc.ts` 的 `fullCatalogIds`）。
     */
    private snapshotCatalog;
    /** 后台预热一次目录；失败静默（兜底表已保证 UI 可用）。 */
    private warmCatalog;
    /** 当前生效的目录（远端优先，失败回退兜底）。 */
    private catalog;
    /**
     * 模型选择器的目录 —— **委托共享骨架**（`model-catalog.ts`）。
     *
     * ## ⚠️⚠️ 2026-10-23 迁移（用户要求：实体 provider 一律走共享骨架）
     *
     * 迁移前本方法是**手写**的，自己做了四件事：判 `providerClosed`、
     * 判 `providerCatalogVisible`、过滤 `disabledModels`、手工 map 成
     * `LlmModelInfo`。其中 ①③④ 与其余 13 家**逐字同义** —— 而「同义的两份实现」
     * 正是本仓库红线（`docs/agent-notes/misc.md` 的「一文件两套同义判据」），
     * 也是 Gitee IKP8OF 那类漂移缺陷的温床（各写一份 ⇒ 新入口漏接线就静默失效）。
     *
     * 现在四条全部由骨架承担，本方法只剩一行委托：
     * - 关闭意图 / 黑名单 / 模态回填 / `provider` 回填 ⇒ `createModelCatalog`；
     * - **本家独有的门控**（没有可用槽位时隐藏）⇒ 放进 `loadCatalog`
     *   （返回 `[]` 即「目录为空」，与骨架的既有语义一致）。
     */
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /**
     * 解析消息里的图片附件为 data URL。
     *
     * ⚠️ **模型不支持图片时直接抛 `UNSUPPORTED_CONTENT`**（而不是静默丢弃）——
     * 静默丢弃会让用户以为模型看到了图（Qoder 图片事故的教训）。
     * ⚠️ 附件字节读不出来时**不写入该条**：`openai-compat` 的
     * `userContentParts` 遇到缺失会产出 `[image unavailable]` 占位，
     * 至少让模型知道「这里本该有张图但没拿到」，而不是消息里凭空少一块。
     */
    private resolveImageUrls;
    /**
     * 轮换：失败按「语义」标记该槽 → 换下一槽重发。
     *
     * 三条硬规则（见模块头的表）：
     * 1. `tried` **跨迭代保留** —— 每次重置会让两个槽之间无限来回；
     * 2. **已交付内容的流不重放**；
     * 3. **认证类不写限流标记**（写它会放大成「全池被封」）。
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** 指定槽发一次请求（轮换循环的复用单元）。 */
    protected streamVia(slot: ModelscopeSlot, options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/**
 * 从 `LlmError` 还原成语义化分类。
 *
 * ⚠️ 事实挂在 `error.failure` 上（`LlmFailure` 契约），**不是**展开在 error
 * 自身 —— 早期版本误按「自身属性」读响应头，`retry-after` 因此永远读不到
 * （opencode 写单测时实测到：`expected 590000, got 60000`）。
 */
export declare function classifyModelscopeFailure(error: unknown): ModelscopeErrorInfo;
/** 在 `ctx.llm` 上注册 modelscope 路由。 */
export declare function registerModelscopeLlm(ctx: Context, options: ModelscopeAdapterOptions): ModelscopeAdapter;
//# sourceMappingURL=modelscope-adapter.d.ts.map