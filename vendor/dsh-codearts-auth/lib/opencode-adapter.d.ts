/**
 * OpenCode Zen 模型适配器（账号槽 + 匿名槽平权混合池）。
 *
 * ## 平权轮换语义（设计文档 §5）
 *
 * 槽序列 = `[账号槽…（账号池手动顺序）] + [匿名槽（固定末位）]`。
 * 免费模型下**全序列**参与轮换；收费模型只由账号槽承载（匿名槽被剔除）。
 * 匿名殿后**只是位置，不是特权降级** —— 判据见 {@link pickSlot}。
 *
 * ## 身份即 key + IP + 随机会话
 *
 * opencode CLI 发往 Zen 的请求**没有机器指纹**（1.18.22 源码逐行核对），
 * 故「换一台 PC」在协议层等价于「换一个 key（账号）或换一个出口 IP（代理）」；
 * 指纹派生的作用是**防关联**与满足形状门禁，不参与配额计算。
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import { type OpencodeErrorKind, type OpencodeFallbackModel } from './opencode-product.js';
import { listIdentitySlots, type IdentitySlot } from './opencode-auth.js';
/** 目录条目（远端与兜底共用的输出形状）。 */
export interface OpencodeCatalogEntry extends OpencodeFallbackModel {
}
/** 清空目录缓存（RPC 的「刷新目录」与单测隔离用）。 */
export declare function clearOpencodeCatalogCache(): void;
/** 远端目录拉取（注入以便单测离线）。 */
export type OpencodeCatalogFetcher = (slot: IdentitySlot, signal?: AbortSignal) => Promise<Response>;
/**
 * 拉取远端目录，失败回退静态兜底。
 *
 * @param ttlMs 命中内存缓存的窗口；测试传 0 强制每次都拉。
 *
 * ⚠️ 缓存按**槽 id** 分开存：不同账号的目录可能不同（付费可见性、
 * 地区封锁），共用一份缓存会让新加的账号迟迟看不到付费模型。
 */
export declare function loadOpencodeCatalog(fetchCatalog: OpencodeCatalogFetcher, slot: IdentitySlot, ttlMs?: number): Promise<readonly OpencodeCatalogEntry[]>;
export interface OpencodeAdapterOptions {
    /** 取当前槽序列（账号池顺序 + 匿名槽末位）。 */
    identitySlots: () => Promise<readonly IdentitySlot[]>;
    /** 拉远端目录；缺省时直接用兜底表。 */
    fetchRemoteCatalog?: OpencodeCatalogFetcher;
    /**
     * 账号池（**黑名单、关闭意图的唯一数据源**）。
     *
     * ⚠️⚠️ **2026-10-23 迁移**：本家此前手写 `listModels`，黑名单与关闭意图靠
     * `disabledModels` / `providerClosed` 两个**选项回调**传进来。那两个字段
     * 已随迁移删除 —— 现在统一由共享骨架（`model-catalog.ts`）从本池读取。
     *
     * ⚠️ 省略时（单测 / 嵌入方）行为退回「不过滤、不判关闭意图」；
     * **生产接线必须传**（`index.ts` 负责，且有守卫逐家点名）。
     */
    accountPool?: import('./account-pool.js').AccountPool;
    /** 记录受限的副作用（切槽时由接线层提供）。 */
    markLimited?: (slotId: string, modelId: string, resetAtMs: number) => Promise<void>;
    /** 诊断日志。 */
    warn?: (message: string) => void;
    /**
     * 附件字节读取。**只有声明了 image 模态的模型才需要**。
     *
     * ⚠️ 缺省时带图请求会抛 `UNSUPPORTED_CONTENT`（见 `resolveImageUrls`），
     * 而不是把图片静默丢掉（Qoder 图片丢失事故的教训）。
     */
    readImage?: (ref: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
}
/**
 * 按「平权」规则选一个可用槽。
 *
 * ⚠️ **收费模型跳过匿名槽**：匿名凭证（字面量 `public`）只被服务端认作
 * 免费通道，送付费模型必然 401/403。
 *
 * @param excluded 已试过的槽 id（`tried` 集合）——保证每个槽最多试一次。
 */
export declare function pickSlot(slots: readonly IdentitySlot[], modelId: string, excluded: ReadonlySet<string>): IdentitySlot | undefined;
/**
 * 把「错误语义 + 服务端给的延迟」换算成该槽该模型的受限时长（相对 now 的毫秒数）。
 *
 * ⚠️ **服务端给了就用它的**，且 **0 是合法值**（「立即解除」而非「未知」）：
 * 必须用 `retryAfterMs === undefined` 判空，写成 `?? default` 之外的任何
 * falsy 判据都会把 0 静默换成 1 小时 —— 那会让刚恢复的账号继续被跳过。
 * ⚠️ 没给才退避：`free_usage_limit` 按当日 24h（与 qoder 的「当日额度」同思路），
 * `rate_limit` 指数退避并封顶 30 分钟（否则单次阻塞可能数小时，UI 无法区分
 * 「在等」与「卡死」）。
 */
export declare function opencodeRetryAfterMs(kind: OpencodeErrorKind, retryAfterMs: number | undefined, attempt: number): number;
export declare class OpencodeAdapter extends LlmAdapter {
    private readonly options;
    /**
     * 共享目录骨架（`model-catalog.ts`）——**黑名单 / 关闭意图 / 目录门控 /
     * 模态回填 / 映射**的唯一实现处（2026-10-23 迁移，见 `listModels` 的注释）。
     */
    private readonly skeletonCatalog;
    constructor(options: OpencodeAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    private catalog;
    /**
     * 完整目录（**同步**返回数组）。
     *
     * ⚠️ **绝不能写成 async**：`jet-hub-rpc.ts` 的 `ModelCatalogSource`
     * 接口是同步的且消费者**不 await**（`catalog = [...all]`），
     * 返回 Promise 会抛 `TypeError: all is not iterable`
     * （minimax 的同款真实缺陷，见 `minimax-adapter.ts` 的注释）。
     */
    listAllModels(): readonly {
        id: string;
        name: string;
        isFree?: boolean;
    }[];
    /**
     * 模型选择器的目录 —— **委托共享骨架**（`model-catalog.ts`）。
     *
     * ## ⚠️⚠️ 2026-10-23 迁移（用户要求：实体 provider 一律走共享骨架）
     *
     * 迁移前本方法**手写**了四件事：判 `providerClosed`、槽位门控、
     * 「只有匿名身份时只给免费模型」、过滤 `disabledModels` + 手工 map。
     * 其中「关闭意图 / 黑名单 / 模态回填 / `provider` 回填」与其余 13 家
     * **逐字同义** ⇒ 各写一份正是 Gitee IKP8OF 那类漂移缺陷的温床。
     *
     * 现在那四条由骨架承担，**本家独有的两条**放进 `loadCatalog`
     * （`loadCatalogEntries`）：
     * - 无任何槽位 ⇒ 返回 `[]`（隐藏 provider 分组）；
     * - **只有匿名身份时只给免费模型**（用户定稿的可见性口径）。
     *
     * ⚠️ 模态仍走 `inputModalitiesOf`（**远端能力表**），在 `toCatalogEntry` 里。
     */
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * 异步读目录并转成骨架的中间结构。
     *
     * ⚠️⚠️ **本家独有门控全在这里**（迁移前它们散在 `listModels` 里）：
     * ① 无任何槽位 ⇒ `[]`；② 只有匿名身份 ⇒ 只留免费模型。
     *
     * ⚠️ **顺序约束**（2026-10-17 对抗审计实测澄清）：能力表注入发生在
     * `catalog()` 内层（经 `loadOpencodeCatalog`），故这里**不需要**再前置读一次。
     * 若将来 `catalog()` 出现**不经过 `loadOpencodeCatalog`** 的路径，
     * 该约束会重新失效 —— 那时必须在这里补回并同时补一条能抓住它的守卫。
     */
    private loadCatalogEntries;
    /**
     * **同步**全量目录（`listAllModels()` 用）。
     *
     * ⚠️ 与 `loadCatalogEntries` 同一套转换口径（否则「设置页看到的」与
     * 「选择器看到的」会分叉）；差别只在不打网络：这里用兜底表。
     */
    private syncCatalogEntries;
    /** 本家私有形状 → 骨架的 `CatalogEntry`（**唯一**转换点）。 */
    private toCatalogEntry;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /**
     * 平权轮换：失败按「语义」标记该槽 → 换下一槽重发。
     *
     * ⚠️ 三条硬规则（每条都对应一类真实缺陷）：
     *
     * 1. `tried` **跨迭代保留** —— 每次迭代重置会让两个槽之间无限来回
     *    （qoder 实测：标记记录是 `['acct-A','acct-A']` 而非 `['acct-A','acct-B']`）。
     * 2. **已交付内容的流不重放** —— 重放会让用户看到重复输出。
     * 3. 收费模型**不经匿名槽**（匿名凭证只认免费模型，见 `pickSlot`）。
     */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 解析消息里的图片附件为 data URL。
     *
     * ⚠️ **模型不支持图片时直接抛 UNSUPPORTED_CONTENT**（而不是静默丢弃）——
     * 静默丢弃会让用户以为模型看到了图（Qoder 图片事故的教训）。
     * ⚠️ 附件字节读不出来时写入**空 Map**：`openai-compat` 的
     * `userContentParts` 遇到缺失会产出 `[image unavailable]` 占位，
     * 至少让模型知道「这里本该有张图但没拿到」，而不是消息里凭空少一块。
     */
    private resolveImageUrls;
    /** 用指定槽发一次请求（轮换循环的复用单元）。 */
    protected streamVia(slot: IdentitySlot, options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 传输层：先用 Bun 指纹发，**模块加载不到时**才回退常规 fetch。
     *
     * ## 为什么免费与付费共用这一条（不分叉）
     *
     * 两者的请求形状**逐字节相同**，差别只在「用哪个槽 / key 能不能过免费判定」
     * （见 `pickSlot`）。传输层若按付费/免费分叉，等于凭一个未经证实的假设
     * 分两套判据 —— 本仓库的红线。实测旁证：付费模型名 + 匿名 key 回的是
     * **401 `AuthError`**（鉴权层拒绝，不是门禁层），说明两条通道的门禁位置不同，
     * 但都受益于「更像官方客户端」。
     *
     * ## 回退的边界（只这一种）
     *
     * 只接 {@link BunTlsUnavailableError}：它意味着**请求还没发出去**
     * （模块解析失败），重发不会产生双份副作用。其它错误一律原样抛给轮换层 ——
     * 把 401/429 也回退会让同一次失败既记账又重发。
     *
     * ## ⚠️ 这里**刻意不调 `warn`**
     *
     * 回退是**静默**的。理由：本方法在 `streamVia` 里逐请求调用，而
     * `warn` 在本仓库是**协议层诊断**的通道 —— 响应层剔调用时的用例用
     * `toHaveBeenCalledTimes(1)` 精确计数（`opencode-stream.spec.ts` 多处）。
     * 传输层往里插一条会让那些计数变成 2、把「剔除留痕」的判据淹成噪音。
     * 可观测性改由 {@link bunTlsUnavailableReason} 对外暴露，由接线层
     * （`index.ts`）在**启动期**读一次并记日志。
     */
    private fetchWithBunFingerprint;
}
/** 在 `ctx.llm` 上注册 opencode 路由。 */
export declare function registerOpencodeLlm(ctx: Context, options: OpencodeAdapterOptions): OpencodeAdapter;
export { listIdentitySlots };
//# sourceMappingURL=opencode-adapter.d.ts.map