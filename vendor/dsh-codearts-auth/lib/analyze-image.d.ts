/**
 * `analyzeImage` —— 让**纯文本模型**也能"看图"的工具（2026-10-21）。
 *
 * ## 为什么需要它（用户诉求）
 *
 * CodeArts 的模型分两类（`/v1/model/builtin` 的 `supports_images` 实测）：
 * `kimi-k2.6-vl` / `Qwen3-VL-235B` 能收图，而 `glm-5.3` / `GLM-5.2` /
 * `openpangu-*` / `deepseek-v4.1-flash` **收不了**（上游原文
 * `InferHub.001001020.406 The request model is not multimodal`）。
 *
 * 用户明确要求：「继续做到 codearts 的只有文本的模型可以通过这个工具识图」，
 * 且「不需要直接选择 VL 模型（IDE 也不能选择）」。
 *
 * ## 与 IDE 同构的两段式
 *
 * 本机 IDE 内核日志实测：
 *
 * ```
 * [fetchMultimodalModelId] Success, selected multimodal model: kimi-k2.6-vl,
 *                          candidates: kimi-k2.6-vl, Qwen3-VL-235B   ← 11 次采样恒定
 * ```
 *
 * 即 IDE 也是「挑一个 VL 模型去服务 `analyzeImage` 工具」，主模型（文本）只读文字结果。
 * 本模块复刻这条路：主模型调工具 → 我们拿图片字节 → 发给 `kimi-k2.6-vl` → 返回文字。
 *
 * ## ⚠️⚠️ 最关键的约束：图片字节**不能**从 `options.messages` 里拿
 *
 * 纯文本模型发请求时，DSH 会在 **dispatch 之前**把图换成占位文字
 *（`dsh-llm/lib/index.js:2337` 的 `projectImagesForTextModel` →
 * `[image omitted because this model accepts text only; attachment sha256:…]`）。
 * ⇒ 适配器 `stream()` 里看到的已经是**文字**，图片字节早就不在了。
 *
 * 故本工具必须**自己去会话历史里取**：`session.deriveMessages()` 返回的是
 * **未投影**的派生历史（`dsh-session/lib/types/index.d.ts:344`），
 * `image` 块上的 `attachment` 引用完整保留，再经 `ctx.attachments.readImage()`
 * 读字节。
 *
 * ## 工具只在「当前路由是 codearts 且该模型收不了图」时才该存在
 *
 * 否则会给别家 provider 塞一个用不了的工具（它们的图片本来就直发上游）。
 * 判据见 {@link shouldOfferAnalyzeImage}。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis';
import { codeartsVisionModel } from './llm-adapter.js';
import { ANALYZE_IMAGE_TOOL, shouldOfferAnalyzeImage } from './codearts-vision.js';
export { ANALYZE_IMAGE_TOOL, shouldOfferAnalyzeImage };
/** 单次调用最多分析几张图（防止模型一次塞几十张把上游打爆）。 */
export declare const ANALYZE_IMAGE_MAX_IMAGES = 8;
/** `exec` 里本模块用到的字段（宿主会传完整对象，这里只声明读到的部分）。 */
interface AnalyzeExec {
    readonly signal: AbortSignal;
    readonly agent?: {
        readonly session?: {
            deriveMessages?: () => readonly {
                readonly role: string;
                readonly content: readonly unknown[];
            }[];
        };
    };
}
/** 会话历史里的一张图（引用 + 展示元数据）。 */
interface SessionImage {
    readonly attachmentId: string;
    readonly mediaType: string;
}
/**
 * 从会话派生历史里收集**当前这一轮**的图片引用。
 *
 * ⚠️ 只取**最后一条 user 消息**里的图：用户问「这张图是什么」时，指的是他刚发的那张。
 * 取全部历史会把之前对话里的图也一起送去分析（既慢又费额度，还会让模型答错图）。
 *
 * ⚠️ **不处理 `offloaded` 块**：那是 DSH 为省 token 做的图片卸载，字节可能已不在
 * 本地。这类块直接跳过 —— 让模型收到「有几张图但我拿不到」比送一张空图更诚实。
 *
 * @param messages - `session.deriveMessages()` 的结果
 * @returns 图片引用列表（可能为空）
 */
export declare function collectTurnImages(messages: readonly {
    readonly role: string;
    readonly content: readonly unknown[];
}[]): SessionImage[];
/**
 * 把图片字节拼成上游接受的 data URL。
 *
 * ⚠️ 形态必须与 `codeartsImagePart` 一致（`image_url` 对象套 url）——
 * 实测另外三种形态全部被拒（见 `llm-adapter.ts` 的 `codeartsImagePart` 注释）。
 */
export declare function imageDataUrl(data: Uint8Array, mediaType: string): string;
/**
 * 判断是否该给当前路由挂这个工具。
 *
 * ⚠️ **实现已下沉到 `codearts-vision.ts`**（`shouldOfferAnalyzeImage`），因为注册期
 * 包装需要同一份判据而不能 import 本文件。本函数保留为**转出**，既有调用方不变。
 *
 * 判据三条，缺一不可：
 * 1. 路由 provider 是 `codearts`（别家的图片直发上游，不需要这个中转）；
 * 2. 该模型**收不了图**（VL 模型自己就能看，给它这个工具是多余的）；
 * 3. 路由信息可解析（拿不到就**不挂** —— 宁可少一个工具，也不要挂一个用不了的工具）。
 *
 * @param provider - 当前会话路由的 provider id
 * @param model - 当前会话路由的 model id
 * @param acceptsImage - 「该模型能否收图」的判据（默认用 codearts 的实现；注入以便单测）
 */
/** 识图依赖（注入以便单测；生产由 {@link installAnalyzeImage} 从 ctx 取）。 */
export interface AnalyzeImageDeps {
    /** 读图片字节（`ctx.attachments.readImage`）。 */
    readImage(attachment: unknown): Promise<{
        data: Uint8Array;
        mediaType: string;
    }>;
    /**
     * 用 VL 模型跑一次识图，返回文字描述。
     *
     * ⚠️ 由接线层注入（而不是本模块直接调 llm 服务）：本模块不依赖 `dsh-llm`，
     * 且调用参数（provider/model/signal）的形状属于宿主契约，集中在一处更好维护。
     */
    describe(imageDataUrls: readonly string[], prompt: string, signal: AbortSignal): Promise<string>;
}
/**
 * 执行一次识图：收集本轮的图 → 读字节 → 交给 VL 模型 → 返回文字。
 *
 * @param exec - 工具执行上下文（取会话历史与取消信号）
 * @param deps - 识图依赖
 * @returns 给模型看的文字结果
 */
export declare function runAnalyzeImage(exec: AnalyzeExec, deps: AnalyzeImageDeps): Promise<string>;
/**
 * 临时禁用开关的环境变量名。
 *
 * ⚠️ **这是应急闸，不是长期配置**（2026-10-23 应用户要求加）：
 * 设成 `1` / `true` / `yes` 时**根本不注册**该工具（而不是「注册了但请求时摘除」）。
 * 用途：① 线上出问题时能立刻把嫌疑项摘干净；② 验证「工具数是否是慢的成因」。
 * 长期形态仍以 {@link installAnalyzeImage} 的无条件注册 + 逐请求作用域摘除为准。
 */
export declare const ANALYZE_IMAGE_DISABLE_ENV = "DSH_DISABLE_ANALYZE_IMAGE";
/** 读该开关（`1` / `true` / `yes` 大小写不敏感 ⇒ 禁用）。 */
export declare function analyzeImageDisabledByEnv(env?: Readonly<Record<string, string | undefined>>): boolean;
/**
 * 把 `analyzeImage` 注册到宿主。
 *
 * ## ⚠️ 为什么用 `ctx.inject(['tools', 'attachments'])`
 *
 * 两个服务缺一不可：`tools` 用来注册，`attachments` 用来读图片字节。
 * 缺任一个都**不注册**（而不是注册一个会报错的工具）—— 本仓纪律：
 * 「装不上的能力不要露出来」。
 *
 * ## ⚠️ 工具是否出现是**逐次求值**的
 *
 * `describe` 由调用方注入，且是否挂载由 {@link shouldOfferAnalyzeImage} 决定；
 * 用户在会话里切模型时，工具列表会随 `tools` 服务重新求值 —— 故这里把
 * 「当前路由能不能用」的判据放进工具**自身的 execute** 里再判一次，
 * 避免「工具挂上了但当前模型换了」时给出一个奇怪的失败。
 *
 * @param ctx - 插件上下文
 * @param deps - 识图依赖
 * @param routeOf - 读当前会话路由（provider/model）；返回 undefined 表示不可判定
 * @param log - 可选日志（禁用时记一条，便于事后确认是「闸关着」而不是「注册失败」）
 */
export declare function installAnalyzeImage(ctx: Context, deps: AnalyzeImageDeps, routeOf: (exec: AnalyzeExec) => {
    provider?: string;
    model?: string;
} | undefined, log?: {
    info?: (message: string) => void;
}): void;
/** 识图时使用的 VL 模型（转发，便于接线层与单测共用一处）。 */
export { codeartsVisionModel };
//# sourceMappingURL=analyze-image.d.ts.map