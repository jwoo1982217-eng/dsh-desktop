/**
 * AutoClaw LLM 适配器。
 *
 * 把 DSH 的 `LlmAdapter` 调用转发到智谱 AutoClaw 桌面端代理网关。
 * 遵循 OpenAI Chat Completions 协议，并实施必要的 406 绕过前缀校验与动态签名。
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { type AutoclawProduct } from './autoclaw-product.js';
import { type AutoclawCredential } from './autoclaw.js';
export interface AutoclawAdapterOptions {
    /** 凭据获取函数。支持按模型选号。 */
    resolveCredential?: (modelId?: string) => Promise<AutoclawCredential | undefined>;
    /** 凭据获取函数（旧兼容）。 */
    credentialProvider?: () => Promise<AutoclawCredential | undefined>;
    /** 探测凭据函数。 */
    probeCredential?: () => Promise<AutoclawCredential | undefined>;
    /** 覆盖默认的 fetch（测试注入）。 */
    fetchImpl?: typeof fetch;
    /**
     * 凭据续期回调。
     *
     * ## ⚠️⚠️ 签名为什么带参数（2026-10-27 审计修的 P1）
     *
     * 修前是**零参** `refresh()`，调用方（`index.ts`）只能自己再问池要一个账号
     * （`pool.getAvailableAccount(provider, '')`）。而请求实际用的凭据来自
     * `resolveCredential` → `createCredentialResolver`，本家接了
     * `balance: { kind: 'buddy' }` ⇒ **用哪个号由余额分档决定**，与
     * `getAvailableAccount` 的「手动序第一个」**是两套规则**：
     *
     * | 判据 | 分档（请求用） | `getAvailableAccount`（续期用） |
     * |---|---|---|
     * | 排序 | 按到期档位（`pickBuddyAccount`） | 用户手动序第一个 |
     * | 限流过滤 | 按**真 modelId** | 传 `''` ⇒ **整体短路**（`account-pool.ts` 的 `modelId.length === 0`） |
     *
     * 实测（真跑 `createCredentialResolver` + 复刻池逻辑）：请求用 B 号，
     * 续期却续 A 号 ⇒ **续了 A、重发仍用 B 的旧 token** ⇒ 401 原样复现，
     * 而 A 被白轮换一把 RT。端到端三次请求的结果是 `["AUTH","AUTH","AUTH"]`。
     *
     * ⇒ 现在把**本次实际用的凭据**交给回调，并允许它**直接返回续好的新凭据**：
     *   ① 续的必定是刚才那次请求用的那个号（不再二次选号）；
     *   ② 重发用的就是返回值，**不再** `resolveCredential`（那会重新选号，
     *      即使续对了也可能挑回另一个号）。
     *
     * ⚠️ 返回值保持**可选**（`void | AutoclawCredential`）：既有的零参实现、
     *   `probeById` 里的 `refresh: async () => {}` 都仍然合法 —— 返回 `undefined`
     *   时退回旧行为（重新 `resolveCredential`），不破坏任何调用方。
     */
    refresh?: (used?: AutoclawCredential) => Promise<void | AutoclawCredential>;
    /**
     * 账号池（**黑名单、关闭意图、目录门控的唯一数据源**）。
     *
     * ⚠️⚠️ **2026-10-23 迁移**：本家此前手写 `listModels`，黑名单与关闭意图靠
     * `disabledModels` / `providerClosed` 两个**选项回调**传进来。那两个字段
     * 已随迁移删除 —— 现在统一由共享骨架（`model-catalog.ts`）从本池读取。
     *
     * ⚠️ 省略时（单测 / 嵌入方）行为退回「不过滤、不判关闭意图」；
     * **生产接线必须传**（`index.ts` 负责，且 `ikp8of-provider-closed.spec.ts`
     * 会逐家点名）。
     */
    accountPool?: import('./account-pool.js').AccountPool;
    /**
     * 读取图片附件字节（**图片通路必需**，2026-10-17 审计 P0 修复）。
     *
     * ⚠️ `zai_auto-fast` 的 `supportsImage: true` 有实测依据
     * （`docs/autoclaw-models.md:42`：AutoClaw 体系内唯一支持图文多模态的通道），
     * 而 `resolveModel` 已据此向宿主声明 `['text','image']` ⇒ 宿主**不投影**
     * 图片、**原样**下发（`dsh-llm/lib/index.js:2311`）⇒ 适配器必须真能收图，
     * 否则用户贴图后必然失败（**声明即承诺**）。
     *
     * ⚠️ **缺省时带图请求抛 `UNSUPPORTED_CONTENT`**（与 modelscope / opencode /
     *   loomy 同约定）：不静默丢图，否则用户以为模型看到了图。
     *   `src/index.ts` 必须注入，否则这条路径恒抛。
     */
    readImage?: (ref: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 目录加载完成通知。 */
    onCatalogLoaded?: () => void;
    /**
     * 告警出口（2026-10-18 审计 P0 新增，与 `astudio-adapter.ts` 同型）。
     *
     * ⚠️ 存在的理由是**丢弃思考档位必须留痕**：上游对非法档位回 200 并按最贵
     * 那档跑，若静默丢弃，用户付了 `max` 的钱却在 UI 上看到「未思考」——
     * 没有日志就等于把账算到模型头上。
     */
    warn?: (message: string) => void;
    /** 产品配置。 */
    product?: AutoclawProduct;
}
export declare class AutoclawAdapter extends LlmAdapter {
    private readonly options;
    private readonly product;
    private readonly warnImpl;
    /**
     * 共享目录骨架（`model-catalog.ts`）——**黑名单 / 关闭意图 / 目录门控 /
     * 映射**的唯一实现处（2026-10-23 迁移，见 `listModels` 的注释）。
     */
    private readonly skeletonCatalog;
    private announced;
    /**
     * 远端模型规格缓存（2026-10-17 审计 P1 修复）。
     *
     * ⚠️ **必须有**：修复前远端只在 `listModels` 里被读一次，而
     *   `resolveModel`（宿主每次请求前都调、也是**能力声明的唯一来源**）
     *   读的是编译期兜底表 ⇒ 远端值算出来就被丢掉。
     * ⚠️ 缓存失效判据用 **`undefined` 表示「已知无远端信息」** 而非「未取过」，
     *   避免远端挂掉时每次请求都重打一次（那会让上游限流）。
     */
    private remoteMeta;
    private remoteMetaFetched;
    private remoteMetaInFlight;
    constructor(options?: AutoclawAdapterOptions);
    private resolveCredential;
    private probeCredential;
    /**
     * 取远端模型规格（**带进程内缓存 + 在飞去重**）。
     *
     * ⚠️ 为什么必须缓存（2026-10-17 审计 P1 修复）：`resolveModel` 是宿主
     *   **每次请求前**都调的（能力声明的唯一来源），若每次都打远端 ⇒ 每轮会话
     *   多一个上游往返，且远端一限流就把全部请求拖慢。
     * ⚠️ 在飞去重是必需的：`resolveModel` 与 `listModels` 会被并发调用
     *   （宿主预热目录时），没有它就会同时打两个请求。
     */
    private loadRemoteMeta;
    /**
     * 把远端校正值套到兜底表的一条上（**只覆盖远端确实给了的字段**）。
     *
     * ⚠️ 拿不到远端信息时**原样返回兜底条目** —— 绝不编造数值（本仓库红线）。
     */
    private entryOf;
    get provider(): string;
    getProviderInfo(id: string): Promise<{
        id: string;
        name: string;
    }>;
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
     * 迁移前本方法**手写**了四件事：判 `providerClosed`、过滤 `disabledModels`、
     * 凭据探活门控、手工 map 成 `LlmModelInfo`。其中「关闭意图 / 黑名单 /
     * `provider` 回填」与其余 13 家**逐字同义** ⇒ 各写一份正是 Gitee IKP8OF
     * 那类漂移缺陷的温床。
     *
     * 现在那三条由骨架承担，**本家独有的两条**放进 `loadCatalog`
     * （`loadCatalogEntries`）：
     * - **凭据探活门控**（`probeCredential()` 拿不到凭据 ⇒ 隐藏整个分组）；
     * - 探活成功后**真读远端规格**（`loadRemoteMeta()`）+ 广播（`announceLater`）。
     *
     * ⚠️ **门控口径变更（刻意，已与用户确认）**：骨架额外要求「账号池里有已登录
     * 账号」（`providerCatalogVisible`）。对本家而言这比原来的单凭据探活更贴近
     * 用户预期 —— 池里没有账号时那个 provider 本就没有可用号，显示出来只会让
     * 用户选中一个必然失败的模型。
     */
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    /**
     * 异步读目录并转成骨架的中间结构。
     *
     * ⚠️⚠️ **本家独有门控全在这里**：
     * ① 凭据探活（拿不到 ⇒ `[]` ⇒ 隐藏分组）；
     * ② 探活成功 ⇒ 真读远端规格并广播（原 `listModels` 的主体）。
     */
    private loadCatalogEntries;
    /** **同步**全量目录（`listAllModels()` 用；同样读已缓存的远端校正值）。 */
    private syncCatalogEntries;
    /**
     * 本家私有形状 → 骨架的 `CatalogEntry`（**唯一**转换点）。
     *
     * ⚠️⚠️ **必须复用 `entryOf` + `inputModalitiesOf`，不得硬编码 `['text']`**
     * （2026-10-17 审计 P0 修复）。原写法全模型一刀切 `['text']`，而
     * `resolveModel` 按 `supportsImage` 给 `['text','image']` ⇒ **同一模型在两个
     * 入口对宿主说了两套相反的话**：
     *   • 宿主拿 `resolveModel` 那份做**请求前门禁**（不声明 image 就把图片投影成占位符）
     *   • `listModels` 那份进模型选择器与聚合目录
     * ⇒ 对 `zai_auto-fast`（`supportsImage: true`）用户在选择器看到「支持图片」，
     *   而门禁放行后 `stream()` 必然抛错。
     * ⚠️ 走 `entryOf`（**远端校正后**的条目）⇒ 远端若改模态，两处仍**同向**。
     */
    private toCatalogEntry;
    /**
     * 拉取并解析远端模型规格（**失败/形状不认识一律返回 `undefined`**）。
     *
     * ⚠️ **永不抛错**：目录是只读展示面，远端挂掉不该让它整个失败 ——
     *   回落兜底表即可（与原实现的可用性一致）。
     */
    private fetchRemoteModelMeta;
    private announceLater;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /**
     * 解析消息里的图片附件为 data URL（2026-10-17 审计 P0 修复新增）。
     *
     * ⚠️ **按模型判定，不是按 provider 一刀切**（原实现是 provider 级拒绝）：
     *   `zai_auto-fast` 的 `supportsImage: true` 有实测依据
     *   （`docs/autoclaw-models.md:42`），其余三个是纯文本 ⇒ 同一 provider 内
     *   **必须**存在两条通路。判据与 `resolveModel` 同源（`inputModalitiesOf`），
     *   杜绝「声明与实现各说一套」。
     *
     * ⚠️ **模型不支持图片时抛 `UNSUPPORTED_CONTENT`** 而不是静默丢弃 ——
     *   静默丢图会让用户以为模型看到了图（本仓库 Qoder 图片事故的教训）。
     *   ⚠️ 抛**带码**的 `LlmError`（原写法是裸 `Error` ⇒ 宿主归 `'UNKNOWN'`）。
     *
     * ⚠️ 附件字节读不出来时**不写入该条**：`serializeMessages` 遇到缺失会产出
     *   `[image unavailable]` 占位，至少让模型知道「这里本该有张图但没拿到」。
     */
    private resolveImageUrls;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk>;
    }>;
    stream(options: GenerateOptions): AsyncGenerator<StreamChunk>;
}
/**
 * 在 `ctx.llm` 上注册 AutoClaw provider 路由与适配器。
 */
export declare function registerAutoclawLlm(ctx: Context, options: AutoclawAdapterOptions): AutoclawAdapter;
//# sourceMappingURL=autoclaw-adapter.d.ts.map