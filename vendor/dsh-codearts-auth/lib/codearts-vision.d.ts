/**
 * codearts 的**视觉能力事实** + `analyzeImage` 的**可见性判据**（无依赖叶子模块）。
 *
 * ## ⚠️ 为什么这些事实要独立成一个叶子模块
 *
 * 本模块有两个消费者，而它们在依赖图上**分居两侧**：
 *
 * 1. `analyze-image.ts`（工具层）—— 注册工具、并在执行期判「当前路由还用不用得着它」；
 * 2. `llm-register-compat.ts`（**适配器注册期**包装）—— 逐请求把该工具从
 *    **非 codearts 路由**的工具表里摘掉（2026-10-23 真实报障的修法，见下）。
 *
 * 第 2 个点若直接从 `llm-adapter.ts` 取谓词就会**成环**
 *（`llm-register-compat → llm-adapter → llm-register-compat`）⇒ 把「事实」
 * 下沉到这个**不 import 任何模块**的叶子，`llm-adapter.ts` 再反向 re-export
 * 保持既有导入路径不变（全仓只有这一处定义，不是第二套同义判据）。
 *
 * ## ⚠️⚠️ 为什么必须「按路由摘掉」，而不只是修 schema（真实报障，2026-10-23）
 *
 * 用户对 **codebuddy / workbuddy** 发消息**每轮必失败**：
 *
 * ```
 * 本轮运行失败workbuddy: 工具定义不合规，请新建任务重试 invalid function call parameters
 * INVALID_REQUEST
 * ```
 *
 * 取证链（会话 `session-8e5481b1` / `session-0a073d28`，2026-10-23）：
 *
 * | 证据 | 内容 |
 * |---|---|
 * | 落盘 `request/header` | 280 个工具里**唯一**一个 `parameters` 不是 `{type:'object',…}` 的就是 `analyzeImage`（当时是 `{}`） |
 * | **同会话对照** | 同一份 283 工具清单：`qoder` / `codearts` / `loomy` 全部正常产出，只有 `workbuddy` / `buddy` 硬 400 |
 * | 上游原文 | `{"code":11129,"msg":"invalid function call parameters","displayTips":{"zh":"工具的参数结构不符合当前模型要求，被服务端拒绝…"}}` |
 * | **真机 A/B** | 同账号同消息，只改那一个 schema：`{}` → **400**；`{type:'object',properties:{}}` → **200**（两站各自复现） |
 * | **整份清单** | 280 个工具原样 → **400**；只把 `analyzeImage` 换成正确形状 → **200** ⇒ 清单里没有第二个不合规定义 |
 *
 * ⇒ 「空 schema」是**传输缺陷**（已在 `analyze-image.ts` 修掉），而「别家根本不该看到
 * 这个工具」是**作用域缺陷**（本模块负责）。两者都要修：只修 schema 的话，腾讯之外的
 * 严格上游、以及模型误调用（执行期必然抛「不属于 codearts」）仍然会发生。
 *
 * ## ⚠️⚠️⚠️ 同一个根因在**三个**上游复现，错误码/文案/失败形态各不相同（2026-10-23 实测）
 *
 * 用户先报 buddy/workbuddy，随后报 TRAE 的 `4027`。**那是同一个缺陷**，只是各家的
 * 校验器说法不同 —— 而**失败形态**的差异会直接改变排查难度：
 *
 * | 渠道 | 错误码 | 文案 | HTTP | 藏在哪 |
 * |---|---|---|---|---|
 * | buddy `copilot.tencent.com` | `11129` | `invalid function call parameters` | **400** | HTTP 体 |
 * | workbuddy `www.workbuddy.ai` | `11129` | 同上（`displayMsg.zh` = 工具定义不合规） | **400** | HTTP 体 |
 * | **trae** | **`4027`** | **`tools.0.function.parameters must be a JSON Schema of type object`** | **200** | **流内**（`event:progress_notice` 之后） |
 *
 * 三条可推广的教训：
 *
 * 1. **`tools.0` 不是「第 0 个工具有问题」的通例，而是「问题工具恰好排在第 0 位」** ——
 *    本仓工具按名排序，`analyzeImage` 恰在首位 ⇒ 换 20 个 provider 它都是
 *    `tools.0`。排查时**必须**先解出 `tools.N` 是哪个工具，别被 `0` 误导成
 *    「工具表整体非法」。
 * 2. **只看 HTTP 码会把 TRAE 这类误判成成功**：它的 4027 是 HTTP 200 + 流内错误，
 *    与本仓 TRAE 那条「流内 `code=4006` 不得归 SERVER」（见
 *    `docs/agent-notes/providers-trae.md`）**同一形态** ⇒ 判「成功」必须看流是否
 *    产出了正文，而不是状态码。
 * 3. **判别力来自「只改那一个变量」**：TRAE 上同样跑了 A/B（原样清单 → 逐字复现 4027；
 *    只把 `analyzeImage` 换成 `{type:'object',properties:{}}` → 正常收尾），
 *    并复核了作用域摘除后**实发 279/280 且未修清单也不再被拒**。
 *
 * ⚠️ 与 TRAE 的既有笔记不冲突：`providers-trae.md` 记的是 `4001`（auth）/
 * `4006`（体积超限）两个码，`4027`（工具定义不合规）是**第三个**，此前无记载。
 *
 * ## ⚠️⚠️ 为什么不是「按 agent 作用域 restrict」—— 时序上做不到
 *
 * `dsh-tools` 确实有 `restrict({deny:[…]})`（按调用者作用域收窄**全局**工具），
 * 但它在 `dsh-agent-loop` 里**永远晚一步**：
 *
 * - `preStep()` 先 `systemPrompt.assemble(...)`（**工具表在这一次组装里就固化了**），
 *   之后才派发 `agent/pre-step` 瀑布 ⇒ 在 pre-step 里 restrict 影响的是**下一步**；
 * - `agent/request` 瀑布更晚（其文档原文：「On step admission, this runs **after
 *   assembly**」）；
 * - 而「用户刚选的新模型」只存在于 `dsh-api-session-controller` 的
 *   `modelSelection` 投影里（`{lastUsed, pending}`），插件侧读不到 ⇒
 *   组装那一刻拿不到「即将使用」的路由。
 *
 * 结果就是「从 codearts 切到 buddy 的**第一步**仍然会 400」—— 正是用户报的这个症状。
 * 故判据下沉到**适配器层逐请求求值**：那里 `options.provider` / `options.model`
 * 就是**本次请求的真实路由**，零时序、零状态、零竞态，且与本插件注册的**全部 20 个
 * 渠道**（含 buddy 系）同时生效。
 *
 * ⚠️ 已知边界（如实登记）：**非本插件注册的 provider**（harness 自带的官方 deepseek /
 * anthropic 等）不经过我们的包装 ⇒ 它们仍会在工具表里看到 `analyzeImage`（那些上游
 * 不校验工具定义、也不会因此失败，但模型可能误调用并被执行期判据拒绝）。
 * harness 目前**没有**「按路由呈现工具」的机制：官方 `read_image` 的做法同样是
 * 「全局注册 + 执行期断言」（见 `analyze-image.ts` 的 `assertImageCapableRoute` 同款）。
 *
 * ⚠️ 另一处已知边界：**聚合渠道**（`aggregate`）路由 id 不是 `codearts`，故即便它
 * 轮换到 codearts 的文本模型，本工具也会被摘掉 —— 这与修前的**执行期判据一致**
 *（`shouldOfferAnalyzeImage` 同样只认 `provider === 'codearts'`），不是新引入的回归。
 *
 * @module
 */
/**
 * codearts 的 provider id。
 *
 * ⚠️ 这个字面量在 `llm-adapter.ts` 里以 `PROVIDER` 具名 re-export —— 全仓
 * **只有这一处定义**（两条腿不一致会让「摘掉」与「断言」分叉）。
 */
export declare const CODEARTS_PROVIDER = "codearts";
/**
 * `analyzeImage` 的工具名。
 *
 * 与 IDE 的同名工具保持一致 —— 模型在 IDE 语境下已熟悉这个名字，
 * 换名会让它在已有对话历史里找不到对应关系。
 */
export declare const ANALYZE_IMAGE_TOOL = "analyzeImage";
/**
 * 能**原生收图**的 codearts 模型（`/v1/model/builtin` 的 `supports_images` 实测）。
 *
 * | 模型 | `supports_images` | `model_category` |
 * |---|---|---|
 * | `kimi-k2.6-vl` / `Qwen3-VL-235B` | **true** | 图片理解 |
 * | `glm-5.3` / `GLM-5.2` / `openpangu-*` / `deepseek-v4.1-flash` | false | 文本生成 |
 *
 * 其余模型发图必被上游拒：
 * `{"error_code":"InferHub.001001020.406","error_msg":"The request model is not multimodal"}`。
 *
 * ## ⚠️ 本表已降级为**兜底**，权威来源是远端目录（2026-10-26 修）
 *
 * 上游会**持续新增/替换**多模态模型，而这张静态表**不会自己更新** ⇒ 新模型
 * 一旦上线就必然被判成「不能收图」：`codeartsAcceptsImage` 返回 false ⇒
 * `inputModalities` 声明成 `['text']` ⇒ DSH 在**图片入库阶段**就拒掉，请求根本
 * 发不到上游。真实报障：`kimi-k3` 官方支持图片，但本表里没有它。
 *
 * ⇒ 现由 {@link setCodeartsImageModels} 把远端目录里 `supports_images: true` 的
 * id 灌进来，判据取**并集**（目录 ∪ 本表）。
 */
export declare const CODEARTS_VL_MODELS: readonly string[];
/**
 * 灌入远端目录里**能收图**的模型 id（由 `models.ts` 在目录拉取成功后调用）。
 *
 * ## ⚠️ 为什么用「注入」而不是让本模块 import 目录
 *
 * 本模块是**无依赖叶子**（理由见模块头：两侧消费者分居依赖图两端，import 会成环）。
 * 目录在 `models.ts` 里，而 `models.ts` 反过来依赖本模块的判据 ⇒ 只能由
 * `models.ts` **单向**把结果灌进来，本模块绝不反向 import。
 *
 * ## ⚠️ 「只增不减」由**本函数**兑现，不是调用方（2026-10-31 审计 P2 修）
 *
 * **空集不清空**：`ids` 归一化后为空、而当前已有非空集合时，**保持原集合不变**。
 * 理由：`builtinModels: []`（或 AgentCenter 列表为空）可能是「请求成功但该账号
 * 无下发」的合法状态，也可能只是上游该端点**临时**漏发 —— 无论哪种，把它当成
 * 「确认全部下架」去清空，都会让所有目录派生的多模态模型瞬间失去收图能力，
 * 只剩静态表两个兜底；而「真的全部下架」的代价只是发图被上游 406 拒（改动前
 * 的既有行为）。两害相权，宁可陈旧、不清空。
 *
 * ⚠️ 调用方**仍然**负责「请求失败不调用」（`models.ts` 在 `snapArr === undefined`
 * 时跳过）—— 本函数只兑现「成功但空 ⇒ 不清空」这半边。
 *
 * @param ids - 远端 `supports_images === true` 的模型 id（原始大小写均可）
 */
export declare function setCodeartsImageModels(ids: Iterable<string>): void;
/**
 * 清掉已灌入的目录集合（**仅供单测隔离**）。
 *
 * ⚠️ 生产不要调用：那会让判据退回静态表，等于把动态能力关掉。
 */
export declare function resetCodeartsImageModels(): void;
/**
 * `analyzeImage` 用哪个 VL 模型。
 *
 * ⚠️ 取 `kimi-k2.6-vl` 的**依据是 IDE 自己的选择**（不是我们猜的）：本机内核日志
 * `builtin-model-service` 实测 11 次采样全部是
 * `[fetchMultimodalModelId] Success, selected multimodal model: kimi-k2.6-vl,
 *  candidates: kimi-k2.6-vl, Qwen3-VL-235B` ⇒ IDE 恒定选它，我们跟随。
 */
export declare const CODEARTS_VISION_MODEL = "kimi-k2.6-vl";
/**
 * 该模型能否原生收图（大小写不敏感 —— 上游目录里两种写法都出现过）。
 *
 * 判据 = **远端目录 ∪ 静态表**（目录未加载时只剩静态表）：
 *
 * 1. 先查 {@link setCodeartsImageModels} 灌进来的目录集合 ⇒ 上游新上的多模态
 *    模型（如 `kimi-k3`）**自动跟随**，无需改代码；
 * 2. 再查 {@link CODEARTS_VL_MODELS} ⇒ 目录未加载成功过时的兜底。
 *
 * ## ⚠️ 为什么取**并集**而不是「目录加载后以目录为准」
 *
 * 以目录为准的话，只要上游某天**不再下发** `supports_images` 字段（或改成
 * `false`），`kimi-k2.6-vl` 就会**从能收图变成不能** ⇒ `analyzeImage` 借它识图
 * 的整条链路当场失效，而症状是「工具莫名其妙不工作了」。
 *
 * 取并集的代价：上游**真的下线**某个静态表里的模型时，本判据仍会说它能收图，
 * 发图会被上游 406 拒 —— **但那正是改动前的行为**，不引入新故障。两害相权，
 * 宁可保留旧行为、也不新增一条静默失效路径。
 */
export declare function codeartsAcceptsImage(modelId: string): boolean;
/** `analyzeImage` 用哪个 VL 模型（当前恒定返回 {@link CODEARTS_VISION_MODEL}）。 */
export declare function codeartsVisionModel(): string;
/**
 * 该模型是不是**专用 VL 模型**（自己就是拿来识图的那个）。
 *
 * ## ⚠️ 与 {@link codeartsAcceptsImage} 是**两个不同的概念**（2026-10-26）
 *
 * 很容易混为一谈，但混了就会出事：
 *
 * | | 含义 | 用途 |
 * |---|---|---|
 * | `codeartsAcceptsImage` | 这个模型**能不能收图** | `inputModalities`、发图闸门 |
 * | `codeartsIsVisionModel` | 这个模型是不是**专职识图的 VL 模型** | 要不要给它挂 `analyzeImage` |
 *
 * 上游新一代多模态主模型（如 `kimi-k3`）**两头都沾**：它能收图（目录
 * `supports_images: true`），但它**不是**专用 VL 模型 —— 它的主业是当主模型。
 * 若用「能收图」当作「不该挂工具」的判据，这类模型就会**拿不到识图工具**，
 * 症状是「模型明明支持图片，却没有 analyze_image 可用」。
 *
 * ⇒ 挂不挂工具只看「是不是专职 VL」，与「能不能收图」**解耦**。
 */
export declare function codeartsIsVisionModel(modelId: string): boolean;
/**
 * 判断**当前路由**该不该看到 `analyzeImage`。
 *
 * 判据三条，缺一不可：
 * 1. 路由 provider 是 `codearts`（别家的图片直发上游，不需要这个中转）；
 * 2. 该模型**不是专用 VL 模型**（专职识图的模型自己就能看，给它这个工具是多余的）；
 * 3. 路由信息可解析（拿不到就**不挂** —— 宁可少一个工具，也不要挂一个用不了的）。
 *
 * ## ⚠️ 第 2 条曾用「**收不了图**」当判据，是错的（2026-10-26 修）
 *
 * 那时写作 `!accepts(model)`。对老模型（文本模型 `glm-5.3` 收不了图 ⇒ 挂；
 * VL 模型 `kimi-k2.6-vl` 收得了 ⇒ 不挂）**恰好等价**，所以一直没暴露。
 *
 * 但上游新一代多模态主模型（如 `kimi-k3`）**能收图却不是专用 VL 模型** ⇒
 * `!accepts` 判成「不需要工具」⇒ 它**拿不到 `analyzeImage`**，症状是
 * 「官方说支持图片，却只有直发、没有识图工具可用」。
 *
 * ⇒ 改用 {@link codeartsIsVisionModel}：只看「是不是专职识图的 VL」，
 *   与「能不能收图」**解耦**。文本模型照旧挂，`kimi-k3` 这类也挂，
 *   只有 `kimi-k2.6-vl` / `Qwen3-VL-235B` 这类专职 VL 不挂。
 *
 * ⚠️ 本函数是**唯一定义处**：工具注册（`analyze-image.ts`）、执行期断言、
 * 以及注册期逐请求摘除（{@link withAnalyzeImageScoping}）三处共用它。
 *
 * @param provider - 路由的 provider id
 * @param model - 路由的 model id
 * @param isVision - 「该模型是否专用 VL 模型」的判据（默认用 codearts 的实现；注入以便单测）
 */
export declare function shouldOfferAnalyzeImage(provider: string | undefined, model: string | undefined, isVision?: (id: string) => boolean): boolean;
/** {@link stripAnalyzeImageTool} 读到的字段（`GenerateOptions` 的最小形状）。 */
export interface AnalyzeImageScopedOptions {
    readonly provider?: string;
    readonly model?: string;
    readonly tools?: readonly {
        readonly name?: unknown;
    }[];
}
/**
 * 把一个**不该看到 `analyzeImage` 的路由**的工具表里那一项摘掉（纯函数）。
 *
 * ⚠️ 三条纪律：
 * 1. **不原地改**调用方的对象与数组（工具表可能被宿主复用/比对）；只在真的要摘时
 *    才产生新对象；
 * 2. **该保留时返回同一个对象**（引用相等）—— 身份不变才不会让宿主的
 *    「工具表是否变化」判据产生假变化；
 * 3. **只动这一个名字**，其余工具（含 `read_image`）逐字透传。
 *
 * @param options - 本次 dispatch 的请求参数
 * @returns 原对象（保留）或摘掉该项后的浅拷贝
 */
export declare function stripAnalyzeImageTool<T extends AnalyzeImageScopedOptions>(options: T): T;
/**
 * 把「非 codearts 路由的工具表里摘掉 `analyzeImage`」包到适配器上（**注册期**接线）。
 *
 * ## ⚠️ 为什么包在 `prepareCall` 返回的 `call.stream`（与 `dead-model-store` 同款）
 *
 * 宿主的生产路径是 `prepareCall(provider, model, signal)` → `call.stream(options)`；
 * 只包适配器自己的 `stream` 会被这条路绕开（PR !66 的教训：包装适配器必须包
 * `prepareCall`）。同时**也**包一份裸 `stream`：单测/诊断脚本（如
 * `scripts/dump-buddy-wire.mts`）会直接调它，两条口径必须一致。
 *
 * ⚠️ 路由取 `options.provider ?? prepareCall 的第一实参 ?? 注册的 ids[0]`：
 * dispatch 时的 `options.provider` 最贴近真实路由（`dsh-llm` 会带上），
 * `prepareCall` 的实参是次优来源（多路由适配器上它只是「本实例注册的其中之一」）。
 *
 * @param providers - 该注册持有的路由集合（用于兜底归属）
 * @param adapter - 原始适配器实例
 * @returns 包装后的适配器（**同一个实例身份要求**由调用方保证：这里返回 Proxy）
 */
export declare function withAnalyzeImageScoping<T extends object>(providers: readonly string[], adapter: T): T;
//# sourceMappingURL=codearts-vision.d.ts.map