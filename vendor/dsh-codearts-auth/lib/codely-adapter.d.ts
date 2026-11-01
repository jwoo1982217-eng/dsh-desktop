/**
 * Codely 适配器：**目录 + 推理**都已接通。
 *
 * ## ⚠️ 现状（2026-10-20 修订）：推理默认 **HTTP 自签直连**，CLI 子进程只是测试兜底
 *
 * 签名已完全还原（`codely-sign.ts`；与官方 npm 包源码逐字节对拍通过，
 * `scripts/verify-codely-signature.mjs` 可复现）⇒ 推理走 HTTP + SSE，
 * **不需要任何客户端**。仅当测试注入 `cliSpawner` 时才走下方描述的 CLI 路径
 * （保留它是为了 `codely-cli.ts` 的调用点与既有用例）。
 *
 * ## 历史存档：当时为什么「驱动官方 CLI」而不是自己发 HTTP
 *
 * 推理网关 `https://codely-litellm.tuanjie.cn/v1/chat/completions` 要求
 * `X-Codely-Signature`（HMAC-SHA256），签名密钥藏在官方客户端的编译产物里 ——
 * 2026-10-20 已穷尽以下手段，均未取得：
 *
 * 1. 二进制 64 位 hex 常量枚举（ASCII 412 + UTF-16 28 个）；
 * 2. 运行时进程内存 64 位 hex 枚举（425 个）；
 * 3. 进程内存 32 字节滑动窗口全量扫描（833MB × 三种派生假设）；
 * 4. 签名盐值附近 ±256KB 步长 1 精细扫描；
 * 5. 决定性实验：同 ts / 同 path 下把官方签名换成自算签名 → 401，官方 → 200。
 *
 * ⇒ 结论是「协议与端点都对，只差密钥」。与其发一个注定 401 的请求（那正是
 * 本仓库明令禁止的静默失效），不如**让官方客户端自己签名**：它带着合法凭据与
 * 签名逻辑，我们只消费它的输出（同 `qoder-machine.ts` 的既有取舍）。
 * 驱动层在 `src/codely-cli.ts`（含实测报文与代价说明）。
 *
 * ## 已知代价（用户 2026-10-20 拍板接受）
 *
 * - （仅 CLI 路径）**依赖本机安装** Tuanjie Cowork CLI（`DSH_CODERLY_CLI_PATH` 可覆盖）；
 * - （仅 CLI 路径）**凭据是 CLI 自己的登录态**，不是本插件账号池的那份 ⇒ 该路径
 *   没有换号；**HTTP 路径已接上请求级换号 + 冷却**（`streamViaHttp` 的换号循环：
 *   402/预算耗尽 → UTC+8 次日解冻，429 → 1h；探测适配器已挂 ⇒ 可手动「重测/重置」）；
 * - **每次请求起一个进程**（实测端到端 ~3.1s）；
 * - **`--approval-mode yolo`**：CLI 可读写文件、执行命令（用户选的「更接近
 *   官方 CLI」体验；改成 `ask` 即只读）。
 *
 * ## 目录为什么能直接接（不需要签名）
 *
 * `GET /api/model-status` 只要 Bearer access_token（实测 200，8 个模型组），
 * 签名只用于推理网关 ⇒ 目录侧是完整、真实、可验证的能力。骨架复用共享实现
 * `createModelCatalog`（与 trae / cline 等家同款）：门控 → 远端优先、失败回退
 * 兜底表 → 黑名单 → 三态回填。
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { AccountPool } from './account-pool.js';
import { type CodelyCredential } from './codely-auth.js';
import { type CodelyCliApprovalMode, type CodelyCliSpawner } from './codely-cli.js';
/** 远端目录条目（只取用得到的字段，其余忽略）。 */
export interface CodelyRemoteModel {
    /** 模型 id（`/api/model-status` 的 `modelGroup`）。 */
    id: string;
    /** 运行状态（`operational` / `degraded` / `outage`；未知形态不猜）。 */
    status?: string;
}
/**
 * 「换号有用」的失败形态（cline / accio 同语义）：
 *
 * - **402** / 报文含 `budget_exceeded`：积分或团队预算耗尽 —— 等待不会恢复，
 *   换号（或签到 / 充值）才有用；
 * - **429**：限流 —— 换号可能立即恢复。
 *
 * ## ⚠️ 两条腿对 429 的处置**故意不同**，这不是 bug（2026-10-24 澄清）
 *
 * | 端点 | 429 含义 | 处置 |
 * |---|---|---|
 * | **推理** `POST /v1/chat/...` | 账号级 RPM / TPM 超发 | 换号 + 记 1 小时冷却 |
 * | **换发** `GET cli_api_key` | **网关全局**限流 | 归 `transient`，**不换号、不记账** |
 *
 * 换发侧的 429 换号也没用（撞的是同一个网关），所以不记账；推理侧换号确实有用，
 * 所以记账。写成两处口径是为了各自正确，不是忘了统一 —— 详见
 * `codely-auth.ts` 的 `CodelyCliApiKeyResult` 注释。
 *
 * ⚠️ 401/403 **不**换号：Codely 的 401 绝大多数是「团队无权访问该模型」
 * （换账号也撞同一个团队策略，见 `streamViaHttp` 里的取证表），真凭据失效
 * 在换发 `cli_api_key` 那一步就已拦下。
 */
export declare function isCodelyRotatableFailure(status: number, body: string): boolean;
export interface CodelyAdapterOptions {
    /**
     * 取当前账号的凭据（**目录只读，不扣积分**）。
     *
     * ⚠️ 由接线层注入：适配器自己不知道账号池与凭据库。缺省（未注入）时
     *    目录走兜底表 —— 面板仍有 8 个模型，只是那份是编译期快照。
     */
    credentialProvider?: () => Promise<CodelyCredential | undefined>;
    /**
     * 读取图片附件的原始字节（内联为 `data:` URL 用）。
     *
     * 由接线层注入 `makeReadImage(ctx)`（`ctx.attachments.readImage` 的桥接）。
     * 未注入时收到图片会报 `UNSUPPORTED_CONTENT`，**不静默丢图**。
     *
     * ⚠️ 上游**确实收图**（2026-10-20 实测：`codely-basic` 收到 1×1 PNG 的
     *    `image_url` 后答出「这张图是粉红色」，而 `codely-vl` 反而 400
     *    `invalid_parameter_error`）⇒ 图片通路必须接通，不能靠"模型不支持"搪塞。
     */
    readImage?: (attachment: unknown) => Promise<{
        data: Uint8Array;
        mediaType: string;
    } | undefined>;
    /** 覆盖默认的 fetch（测试注入）。 */
    fetchImpl?: typeof fetch;
    /** 账号池（目录门控 + 黑名单；缺它则无「已登录」门控，目录恒可见）。 */
    accountPool?: AccountPool;
    /** 目录可用后回调 —— 接线层注入 `broadcastCatalogChanged(ctx)`。 */
    onCatalogLoaded?: () => void;
    /**
     * 告警出口（接线层注入 `ctx.logger.warn`；缺省静默）。
     *
     * ⚠️ 2026-10-22 对抗审计加：目录「远端读到但被团队前缀过滤成空」这一格必须留
     *    一行 warn —— 否则线上表现为「面板 0 个模型」，**无日志无报错**。
     */
    warn?: (message: string) => void;
    /**
     * 推理用的官方 CLI 路径（缺省按 `DSH_CODERLY_CLI_PATH` → 默认安装路径解析）。
     * 测试注入；生产不传。
     */
    cliPath?: string;
    /** 审批模式，缺省 `yolo`（用户 2026-10-20 拍板；`ask` 为只读）。 */
    cliApprovalMode?: CodelyCliApprovalMode;
    /** CLI 的工作目录（工具在此目录内工作），缺省 `process.cwd()`。 */
    cliCwd?: string;
    /** 注入的 spawner（测试用）；缺省真 `spawn`。 */
    cliSpawner?: CodelyCliSpawner;
    /** 环境变量源（测试用）；缺省 `process.env`。 */
    cliEnv?: NodeJS.ProcessEnv;
}
export declare class CodelyAdapter extends LlmAdapter {
    private readonly options;
    /** 远端目录缓存；`undefined` = 还没读到（此时用兜底表）。 */
    private remoteModels;
    /** 目录闸门：并发去重 + 失败冷却（依据见 `remote-catalog-gate.ts`）。 */
    private readonly catalogGate;
    private readonly catalog;
    constructor(options?: CodelyAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    /** ⚠️ 必须同步（`provider.status` 与 `ModelCatalogSource` 不 await）。 */
    listAllModels(): readonly {
        id: string;
        name: string;
    }[];
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk>;
    }>;
    /**
     * 推理：驱动官方 CLI 子进程，把它的增量输出转成 harness 的 StreamChunk。
     *
     * ⚠️ 出错一律**抛**，绝不返回空流 —— 静默空流会让上层显示「模型没说话」，
     * 而真实原因是 CLI 没装 / 没登录 / 模型不被允许（autoclaw 与 officeace 都
     * 记过同款静默失效）。
     */
    /**
     * 推理入口：**HTTP 直连网关**（2026-10-20 起默认，不需要任何客户端）。
     *
     * ⚠️ 仅当测试注入了 `cliSpawner` 时才走旧的 CLI 路径 —— 那是为了保住
     * `codely-cli.ts` 的调用点（零调用点 = 本仓库记过的陷阱）与既有 14 条用例；
     * **生产永远走 HTTP**。
     */
    stream(options: GenerateOptions): AsyncGenerator<StreamChunk>;
    /**
     * HTTP + SSE 真流式（签名见 `codely-sign.ts`；换发见 `codely-auth.ts`）。
     *
     * ## 选号与换号（2026-10-20 接上，与 cline / accio 同款）
     *
     * - **有账号池** ⇒ 初始选号走 `getAvailableAccount`（手动顺序 + 自动跳过
     *   限流中账号），失败后进入下面的换号循环重发；`credentialProvider` 退为
     *   池缺席时的兜底（旧测试桩路径）。
     * - **无池** ⇒ 无换号能力（`currentAccountId` 为空 ⇒ 记账 / 换号自然跳过）。
     *
     * ⚠️ 池回传的凭据是**裸 `JSON.parse`** ⇒ 使用前必须收窄
     *    （`usableCodelyCredential`），坏条目不掐断流程。
     */
    /**
     * **跨轮共享的正文块状态**（2026-10-22 对抗审计 A2，P0 修复的核心件）。
     *
     * ## 为什么必须跨轮共享
     *
     * 停滞续拉（`stalled` 分支）会**递归**再发一次请求。旧实现每层各有一份
     * 局部的 `text` / `started` ⇒ 三个真缺陷：
     *
     * 1. **流式正文 ≠ 落盘正文**（实测）：每层都 `yield block-start(0)` + 追加
     *    `text-delta(0)`，而 `block-end` 只带**最后一层**的局部 `text`。
     *    `BlockAssembler` 的 `block-end` 是 **first-close-wins**（`partial.block`
     *    已存在就忽略）⇒ 最终 blocks 只有最后一段，而用户屏幕上看到的是**全部**
     *    拼接（实测 `"我先看看。已改好。已改好。已改好。"` vs 落盘 `"已改好。"`）。
     * 2. **第一轮正文永久丢失**：它只出现在流里，从未进入任何 `block-end`。
     *    注释还写着「第一轮已下发的正文**保留**」—— 与实现相反。
     * 3. **续拉不带历史**：`retryOptions.messages` 只追加一条 user 提示，没有把
     *    上一轮已产出的 assistant 正文加进去 ⇒ 模型不知道自己刚说过什么，只能
     *    重新生成一遍 —— 这既是重复文本的成因，也让「续拉」退化成「重发」。
     *
     * ## 共享之后的不变式
     *
     * - `block-start(0)` **整条流只发一次**（`started` 跨轮）；
     * - `block-end(0)` 只在**不再续拉**的那一层发，且 `text` 用**累积全文**；
     * - 续拉请求把 `text` 作为 `assistant` 消息带上（见 `stalled` 分支）。
     */
    private streamViaHttp;
    /**
     * 旧的 CLI 驱动路径（仅测试注入 `cliSpawner` 时使用，生产不走）。
     *
     * ## ⚠️ 与 `streamViaHttp` 的**行为差异**（2026-10-24 显式记录）
     *
     * 这条路径**不具备** HTTP 路径的请求级能力，别照着 HTTP 那套去理解它：
     *
     * | 能力 | HTTP 路径 | 本路径 |
     * |---|---|---|
     * | 换发 `cli_api_key` | ✅ | ❌ 不换发 |
     * | 从池选号 / 换号重试 | ✅（上限 `CODERLY_MAX_ROTATE`） | ❌ 不选号，无换号 |
     * | 失败记账（`updateModelRateLimit`） | ✅ | ❌ 完全不记账 |
     * | 目录前置校验 | ✅ | ❌ |
     * | 停滞续拉 | ✅ | ❌ 一次跑完 |
     *
     * ⇒ **别拿这条路径去验证换号 / 冷却 / 团队级判定**：它压根不走那些分支，
     *   在那里写断言会得到「看起来通过了、其实什么都没测」的假绿。那些行为请走
     *   `codely-rotation.spec.ts`（注入的是 HTTP 路径）。
     *
     * 保留它的唯一理由：保住 `codely-cli.ts` 的调用点（零调用点是本仓库记过的
     * 陷阱）与既有用例。生产由 `stream()` 的 `cliSpawner === undefined` 挡住，
     * 永远走 HTTP。
     */
    private streamViaCli;
    private loadCatalogEntries;
    /**
     * 目录出口（`loadCatalog` 与 `syncCatalog` 都走这里 ⇒ 过滤只需一处）。
     *
     * ## ⚠️ 为什么必须筛掉「目录里有、但团队无权访问」的模型（2026-10-20 实测）
     *
     * `/api/model-status` 下发的是**全局目录**，团队授权在网关侧**另判**。同一账号实
     * 测（`tmp-probe-models` 逐模型打 `/v1/chat/completions`）：
     *
     * | 模型 | 结果 |
     * |---|---|
     * | `codely-core` / `codely-basic` / `codely-flash` / `codely-air` / `codely-vl` | **200** |
     * | `DeepSeek-V4.1-Flash` / `GLM-5.3-FLASH` / `KIMI-K3` | **401 `team_model_access_denied`** |
     *
     * 上游原文：`team not allowed to access model. This team can only access
     * models=['alias-only-proxy-models']`。即 `codely-*` 是本渠道**自有别名**
     * （前缀 = provider id），公共模型名需要团队额外授权。
     *
     * **不过滤的后果**（真实报障 2026-10-20「不然怎么使用」）：用户在选择器里选
     * `DeepSeek-V4.1-Flash` ⇒ 每一轮都 `401` 直接失败，且目录里看着它是"可用"的。
     *
     * ⚠️ **这不是「临时故障隐藏模型」**（仓库反对那种隐藏：会让「模型消失」与
     *    「模型下架」同形）—— 团队授权是**确定性**的、短期不变，隐藏是**准确表达**。
     * ⚠️ **若某账号被授权了公共模型**：放宽下面这一行判据即可（目录仍从远端拉全量，
     *    这里只是**出口**过滤，恢复时不必改数据源）。
     * ⚠️ 判据只能按**前缀**：上游没有任何接口能查「本团队可用模型」，`/api/model-status`
     *    只给全局目录。
     */
    private catalogEntries;
    /**
     * 转成共享骨架的中间结构。
     *
     * ⚠️ **不声明 `contextWindow` / `maxTokens` / `inputModalities`**：
     *    上游 `/api/model-status` 只给运行状态，没有任何能力元数据；本仓库
     *    红线是「未知即不声明」（编造窗口会让自动压缩按错误阈值决策）。
     * ⚠️ 也不把 `status` 写进 `name`：见 `codely-product.ts` 的说明。
     */
    /**
     * 转成共享骨架的中间结构。
     *
     * ## `inputModalities`：**逐模型**按实测声明（2026-10-20，真凭据 10 次请求）
     *
     * | 模型 | 工具 | 推理 | 图片 |
     * |---|---|---|---|
     * | `codely-basic` | ✅ | ❌ 无 | ✅ |
     * | `codely-flash` | ✅ | ✅ | ✅ |
     * | `codely-air` | ✅ | ✅ | ✅ |
     * | `codely-core` | ✅ | ✅ | ❌ `400 Model only supports text` |
     * | `codely-vl` | ✅ | ✅ | ❌ `400 invalid_parameter_error` |
     *
     * ⚠️ **`codely-vl` 名字带 vl 却不收 `image_url`** —— 这张表就是权威，别按名字猜。
     *
     * ⚠️ 三态语义（见 `model-catalog.ts` 的 `CatalogEntry.inputModalities`）：
     *    `['text']` 是**明确声明不支持**（DSH 会把图片投影成文本占位，用户不会
     *    白等一个注定 400 的请求）；**省略** = 「未知」⇒ 宿主放行图片 ⇒ 仍然 400。
     *    两者后果不同，**不能合并**。
     *
     * ⚠️ 判据是**模型 id 白名单**：`/api/model-status` 只给运行状态，没有任何模态
     *    元数据。上游若调整能力，只改 {@link CODERLY_IMAGE_MODELS} 一处。
     */
    private toCatalogEntry;
    private ensureRemoteModels;
    /** 拉取远端目录；读不到（无凭据 / 非 200 / 非 JSON）返回 `undefined`。 */
    private fetchRemoteModels;
}
/** 在 `ctx.llm` 上注册 Codely provider 路由（幂等，返回**原始适配器实例**）。 */
export declare function registerCodelyLlm(ctx: Context, options?: CodelyAdapterOptions): CodelyAdapter;
//# sourceMappingURL=codely-adapter.d.ts.map