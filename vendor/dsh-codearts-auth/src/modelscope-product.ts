/**
 * ModelScope（魔搭，阿里达摩院）产品配置与错误分类。
 *
 * ## 这个 provider 从哪来（与上游其余 provider 的关系）
 *
 * 本仓库是 gitee `iJetLi/deepseek-harness-codearts` 的 fork。上游 0.2.0-rc.3
 * **没有** modelscope / chatanywhere 两个 provider —— 它们是**本地 fork 独有的
 * 反代上游**（旧实现见 `dsh-codearts-auth@0.1.0` 的 `src/proxy/remote-upstream.ts`，
 * 由一个端口 8787 的 OpenAI 兼容反代按 priority 轮换）。2026-10-09 切到上游后
 * 这两个能力整体消失，本文件把 modelscope 一路按上游的**标准 provider 模式**
 * 补回来（而不是把旧 fork 的整套反代搬回来）。
 *
 * ## 数据来源（逐条可追溯）
 *
 * | 事实 | 取值 | 出处 |
 * |---|---|---|
 * | base URL | `https://api-inference.modelscope.cn/v1` | 旧 fork `src/proxy/upstream-config.ts:51` |
 * | chat 路径 | `/chat/completions` | 旧 fork `src/proxy/remote-upstream.ts:429` |
 * | models 路径 | `/models` | 旧 fork `src/proxy/remote-upstream.ts:268` |
 * | 鉴权头 | `Authorization: Bearer <apiKey>` | 旧 fork `src/proxy/remote-upstream.ts:238` |
 * | 请求内容类型 | `Content-Type: application/json` | 同上 L236 |
 * | 流式 | `stream: true` 恒开，SSE | 旧 fork `src/proxy/remote-upstream.ts:376` |
 * | 模型名 | 带命名空间前缀，如 `deepseek-ai/DeepSeek-V4.1-Flash` | 旧 fork `src/domain/models/catalog.ts:277` |
 * | 关思考参数 | `reasoning_effort: "none"` / `enable_thinking: false` / `thinking: {type:"disabled"}` | 旧 fork `src/proxy/remote-upstream.ts:77` |
 * | 视觉能力 | `deepseek-v4.1-flash` 实测可收图 | 旧 fork `src/proxy/remote-upstream.ts:87-91` |
 * | 额度 | 平台**无余额 API**，余额只在登录后的网页上 | 旧 fork `src/overview.ts:70-76` |
 *
 * ## ⚠️ 一个已实测的 400（本 provider 最容易踩的坑）
 *
 * 旧 fork 曾把 DSH 的扁平工具 schema `{name, description, parameters}` **原样**
 * 转发给 modelscope，结果**每次请求都被 400 拒绝**：
 *
 * ```
 * upstream: modelscope  status: 400
 * {"error":{"code":"invalid_parameter_error",
 *           "message":"'type' is a required property - 'tools.0'"}}
 * ```
 *
 * 后果极隐蔽：反代把它当「上游不可用」静默跳过，魔搭积分**一次都没消耗**，
 * 用户完全看不出来（见旧 fork `src/proxy/remote-upstream.ts:386-395` 与
 * `src/proxy/openai-map.ts:242`）。
 * ⇒ 本实现必须走 `{type:'function', function:{…}}` 包装（见
 * `src/modelscope-messages.ts`），与仓库其余 OpenAI 兼容 provider 同口径。
 *
 * @module src/modelscope-product.ts
 */

import { retryAfterMsFromRecord } from './retry-after.js'

/** ModelScope 的产品配置（字段全部围绕它的 OpenAI 兼容协议）。 */
export interface ModelscopeProduct {
  readonly id: 'modelscope'
  /**
   * 展示名。
   *
   * ⚠️ 必须与客户端 `plugin-src/client/jet-hub.js` 的 `PROVIDERS` 里
   * `modelscope` 那条的 `label` **逐字一致** —— 跨文件一致性由
   * `tests/unit/modelscope-client-panel.spec.ts` 锁死（与 raccoon / opencode /
   * gemini 同款约定）。
   */
  readonly displayName: string
  /** OpenAI 兼容 base URL，**含 `/v1`**，且**不带**尾斜杠。 */
  readonly baseUrl: string
  /** 对话端点（拼在 baseUrl 之后）。 */
  readonly chatPath: string
  /** 模型目录端点（拼在 baseUrl 之后）。 */
  readonly modelsPath: string
  /** 等首个 token 的空闲超时（毫秒）。 */
  readonly chatHeaderTimeoutMs: number
  /** 两次 chunk 之间的空闲超时（毫秒）。 */
  readonly chunkTimeoutMs: number
  /** 模型目录请求超时（毫秒）。 */
  readonly catalogTimeoutMs: number
  /**
   * **魔粒余额**端点的完整 URL（2026-10-17 带真实 Key 实测）。
   *
   * ⚠️⚠️ **刻意是完整 URL 而非「拼在 baseUrl 之后」的 path**：它**不在**
   *    `baseUrl`（`api-inference.modelscope.cn/v1`）那个 host 上，而在
   *    `www.modelscope.cn` 的 **`/openapi/v1/`** 前缀下 ⇒ 用 path 拼装会得到
   *    一个 404 的错误地址。
   *
   * 实测（三条认证形态各验一次，这是本仓库「目录能读 ≠ 凭据有效」纪律的同款要求）：
   * | 认证 | 结果 |
   * |---|---|
   * | `Authorization: Bearer <ms-key>` | **200**，返回 `total_balance` |
   * | 网页会话 cookie | 200，同一数值 |
   * | 无凭据 | **401 `InvalidAuthentication`** |
   * ⇒ 它**真的在校验凭据**（不是公开端点），且**API Key 就够**。
   *
   * ⚠️ 找它的过程值得留档：本仓库与 PR 作者都曾判定「魔搭没有额度查询 API」，
   *    那批探测只试过 `/api/` 与 `/v1/` 两个前缀，而真端点在 **`/openapi/`**；
   *    它还**不在**前端主 bundle 的静态路径表里（藏在按需 chunk）⇒ 只能靠
   *    抓真实网络请求（CDP）定位。详见 `docs/agent-notes/providers-modelscope.md`。
   */
  readonly balanceUrl: string
  /** 余额请求超时（毫秒）。 */
  readonly balanceTimeoutMs: number
  /**
   * 单凭据回退 ref。
   *
   * ⚠️ **不再是旧 fork 的 `PROXY_UPSTREAM_MODELSCOPE`**。那个前缀属于旧 fork 的
   * 「反代上游」命名空间（`credentialRefForUpstream()` 的机械推导），在上游
   * 0.2.0-rc.3 里**整套反代都不存在**（`git grep PROXY_UPSTREAM upstream/master`
   * 零命中），保留它只会凭空造出一个『同时支持两种模式』的假象。
   * 取 `MODELSCOPE_ACCESS_TOKEN` 的理由见 `tests/unit/modelscope-credential-ref.spec.ts`。
   */
  readonly defaultCredentialRef: string
}

export const MODELSCOPE: ModelscopeProduct = {
  id: 'modelscope',
  // ⚠️ 与客户端 PROVIDERS 的 label 逐字一致；长度也刻意控制在不撑破 rail 的
  // 范围内（该 label 是本表新增里较长的，但仍短于既有最长的
  // 'WorkBuddy (国际版)' 与 'Gemini Code Assist'）。
  displayName: 'ModelScope (魔搭)',
  baseUrl: 'https://api-inference.modelscope.cn/v1',
  chatPath: '/chat/completions',
  modelsPath: '/models',
  // 与本仓库其余 provider 的流式超时常量同档（保守值）。
  chatHeaderTimeoutMs: 60_000,
  chunkTimeoutMs: 120_000,
  catalogTimeoutMs: 15_000,
  // ⚠️ 余额端点在**另一个 host**且前缀是 `/openapi/`（不是 `/api/`、也不是 `/v1/`）——
  //    见字段注释里的实测矩阵与「怎么找到它」的留档。
  balanceUrl: 'https://www.modelscope.cn/openapi/v1/magicubes/balance',
  balanceTimeoutMs: 15_000,
  defaultCredentialRef: 'MODELSCOPE_ACCESS_TOKEN',
}

/** 兜底模型目录条目。 */
export interface ModelscopeFallbackModel {
  /** 上游真实模型 id（**带命名空间前缀**，如 `deepseek-ai/…`）。 */
  id: string
  /** 展示名（缺省时用 id）。 */
  name: string
  /**
   * 上下文窗口（DSH 以它 × 0.8 作压缩阈值）。
   *
   * ⚠️ `0` 是「**不知道**」哨兵，**不是**合法窗口 —— `resolveModel` 判
   * `> 0` 才下发 `context`，因为 DSH 的自动压缩会拿它算阈值，0 会抛
   * `TargetPressureConfigError`（与 opencode 的同款缺陷同因）。
   */
  contextWindow: number
  /** 是否支持图片输入（**声明支持就必须真支持**，本仓库硬约定）。 */
  supportsImage: boolean
  /** 支持的思考档位（上游 wire 值）；**为空时不声明 `reasoning`**。 */
  efforts?: readonly string[]
}

/**
 * 兜底模型表。
 *
 * ## 它解决什么（2026-10-17 实测后大幅扩表）
 *
 * 魔搭的 `/v1/models` **只下发 4 个字段**（实测：`id` / `object` / `owned_by` /
 * `created`）—— **既没有 `context_window`，也没有 `modalities.input`**：
 *
 *     远端条目的全部字段: id, object, owned_by, created
 *     窗口相关字段: （无 —— 远端不下发任何窗口信息）
 *
 * ⇒ 原先只登记 2 个模型的后果是：**其余 34 个模型的 `contextWindow` 全落成 0**
 * （0 是「不知道」哨兵，`resolveModel` 判 `> 0` 才下发 `context`）
 * ⇒ 用户看到 34 个模型「没有上下文窗口信息」，而 DSH 的自动压缩阈值算不出来。
 * ⇒ 故按 2026-10-17 用户指示扩表到**远端实测的 36 个**。
 *
 * ## ⚠️⚠️ 每个窗口值的**出处分两类**（不许混为一谈）
 *
 * | 类别 | 取值 | 依据 |
 * |---|---|---|
 * | **① 仓库已有实测** | `1_048_576` / `1_000_000` | 本仓库其它渠道对**同一模型**的实测结论（见各项注释里的出处） |
 * | **② 无先例** | `512_000` | **未实测**的保守占位（用户 2026-10-17 指示） |
 *
 * ⚠️ **②类不是实测值**：魔搭上游不返回窗口字段，而逐个实测 17 个模型的真实
 * 上限成本过高（用户明示「没实测也不用测了」）⇒ 取一个**偏保守**的中间值，
 * 宁可低估窗口（提前触发压缩）也不要高估（DSH 以为能装 1M、实际被上游截断）。
 *
 * ⚠️ **实测旁证（仅对 V4.1 Flash）**：喂约 **100 万 tokens** 输入返回 200
 * （`finish_reason: length` 只是**输出**被截断，不是输入超限）⇒ 原来的
 * `128_000` 明显偏保守。⚠️ 但这**不是**「服务端声明的官方上限」，只是
 * 「这个量级能用」。
 *
 * ## 远端可用时**完全采信远端**
 *
 * 不做 Buddy 那样的「以兜底表为准」裁剪 —— 魔搭的模型池由平台侧随时增删，
 * 本地表必然滞后。⚠️ 本表只在**远端拉取失败**时生效。
 */
export const MODELSCOPE_FALLBACK_MODELS: readonly ModelscopeFallbackModel[] = [
  // ── DeepSeek 系（仓库实测 1_048_576：officeace-product.ts 的 deepseek-v4.1-flash
  //    与 loomy-product.ts 的 deepseek-v4-flash-0731 均为该值）──
  {
    // ⚠️⚠️ **必须写当前在服务的日期快照 id**（Issue #12）：本表在**远端拉取失败**
    // 时会被直接当成「可调用的模型清单」暴露给用户（见 `loadCatalogEntries` 的
    // catch 分支与 `syncCatalogEntries`），所以表里的 id **必须真的能调**。
    //
    // 实测（报障者 yukinomon 取证，本仓库无外网无法独立复核）：
    //   - `deepseek-ai/DeepSeek-V4.1-Flash-1017` ⇒ HTTP 200，收图正常；
    //   - `deepseek-ai/DeepSeek-V4.1-Flash`（无后缀）⇒ **HTTP 400**
    //     `Model id : … , has no provider supported` ⇒ 已下线。
    //
    // 而魔搭**只下发 4 个字段**（无 `modalities`/`context_window`）⇒ 远端命中时
    // 能力判据仍回落到本表，靠 `findModelscopeFallback()` 的 `-` 边界前缀匹配
    // 把 `-1017` 及其后续快照归到本条目（最长前缀优先）。
    id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    name: 'DeepSeek-V4.1-Flash (魔搭)',
    contextWindow: 1_048_576,
    // ⚠️ 视觉能力有实测出处（旧 fork remote-upstream.ts:87-91：
    // 「modelscope / chatanywhere / deepseek 官方的 deepseek-v4.1-flash
    //   都有视觉能力（1×1 纯色 PNG 红/蓝/绿全答对）」；2026-10-17 本仓库
    //   复测 32×32 纯红 PNG → 模型答 `Red`，读图确实生效）。
    supportsImage: true,
    // ⚠️⚠️ **只有「关闭思考」是确证的一档**（2026-10-17 真机三档对照，每档 3 次）：
    //    `none` → reasoning 0/0/0（**稳定为 0**，「关闭」确实生效）；
    //    而 `medium`（中位数 1462）与 `high`（1734）**低于「不指定」的 1676**，
    //    差距远小于同档内波动（同档极差 460+）
    //    ⇒ **`medium`/`high` 被服务端静默忽略**（请求返 200，但不改变思考量）。
    //    ⚠️ 这正是仓库记过的判据（「能正常请求」≠「档位生效」，必须用服务端
    //    权威计数证明档位间有**可区分**的差距，见 providers-accio.md §7）。
    //    ⇒ 只声明确证的一档；给出手感档位会让用户以为能控思考量。
    efforts: ['none'],
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Pro',
    name: 'DeepSeek-V4-Pro (魔搭)',
    contextWindow: 1_048_576,
    // ⚠️ 视觉能力**未实测** ⇒ 按仓库硬约定「声明支持就必须真支持」记 false。
    //    ⚠️ 注意这与 accio-product.ts 里 DeepSeek V4 Pro 的 `supportsImage:false` 一致。
    supportsImage: false,
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    name: 'DeepSeek-V4-Flash-0731 (魔搭)',
    contextWindow: 1_048_576, // loomy-product.ts:322 的 deepseek-v4-flash-0731 实测值
    supportsImage: false,
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    name: 'DeepSeek-V4-Pro-0813 (魔搭)',
    contextWindow: 1_048_576,
    supportsImage: false,
  },

  // ── GLM / 智谱 系（仓库实测 1_048_576：officeace-product.ts:136 的 glm-5.3）──
  { id: 'ZhipuAI/GLM-5.2', name: 'GLM-5.2 (魔搭)', contextWindow: 1_048_576, supportsImage: false },
  { id: 'ZhipuAI/GLM-4.7-Flash', name: 'GLM-4.7-Flash (魔搭)', contextWindow: 1_048_576, supportsImage: false },

  // ── MiniMax 系（仓库实测 1_000_000：minimax-product.ts:149/162）──
  { id: 'MiniMax/MiniMax-M3', name: 'MiniMax-M3 (魔搭)', contextWindow: 1_000_000, supportsImage: false },
  // ⚠️⚠️ `M1-80k` 的**名字里就写着 80k** ⇒ 1M 显然是错的，但仓库**无该模型的
  //    实测值** ⇒ 按「② 无先例」口径给 512_000（保守）。实测成本对用户过高
  //    （用户 2026-10-17 明示「没实测也不用测了」）。
  { id: 'MiniMax/MiniMax-M1-80k', name: 'MiniMax-M1-80k (魔搭)', contextWindow: 512_000, supportsImage: false },

  // ── Qwen 系（仓库实测 1_048_576：cline-product.ts:189/198）──
  { id: 'Qwen/Qwen3.8-Flash-Next', name: 'Qwen3.8-Flash-Next (魔搭)', contextWindow: 1_048_576, supportsImage: false },
  { id: 'Qwen/Qwen3.8-27B', name: 'Qwen3.8-27B (魔搭)', contextWindow: 1_048_576, supportsImage: false },
  { id: 'Qwen/Qwen3.5-27B', name: 'Qwen3.5-27B (魔搭)', contextWindow: 1_048_576, supportsImage: false },
  { id: 'Qwen/Qwen3.5-35B-A3B', name: 'Qwen3.5-35B-A3B (魔搭)', contextWindow: 1_048_576, supportsImage: false },
  { id: 'Qwen/Qwen3.5-122B-A10B', name: 'Qwen3.5-122B-A10B (魔搭)', contextWindow: 1_048_576, supportsImage: false },
  { id: 'Qwen/Qwen3.5-397B-A17B', name: 'Qwen3.5-397B-A17B (魔搭)', contextWindow: 1_048_576, supportsImage: false },
  // ⚠️ 生图模型：声明 `supportsImage:false` 是**输入**维度（它们接受图片**输出**）。
  { id: 'Qwen/Qwen-Image-Edit', name: 'Qwen-Image-Edit (魔搭)', contextWindow: 1_048_576, supportsImage: false },
  { id: 'MusePublic/Qwen-Image-Edit', name: 'Qwen-Image-Edit (魔搭·镜像)', contextWindow: 1_048_576, supportsImage: false },
  { id: 'XGenerationLab/XiYanSQL-QwenCoder-32B-2412', name: 'XiYanSQL-QwenCoder-32B-2412 (魔搭)', contextWindow: 1_048_576, supportsImage: false },
  { id: 'XGenerationLab/XiYanSQL-QwenCoder-32B-2504', name: 'XiYanSQL-QwenCoder-32B-2504 (魔搭)', contextWindow: 1_048_576, supportsImage: false },

  // ── InternVL 系（仓库实测 1_048_576：cline-product.ts 同档口径）──
  // ⚠️⚠️ `supportsImage: false` 是**诚实标记**，不是「不支持」：InternVL 系列
  //    以视觉著称，**魔搭侧极可能支持**，但 2026-10-17 **未实测**
  //    （实测成本对用户过高，用户明示「没实测也不用测了」）。
  //    ⚠️ 按仓库硬约定「声明支持就必须真支持」+ accio 那轮的教训
  //    （漏报 false 会让模型对图片**幻觉出答案**：HTTP 200、不报错，比报错危险），
  //    ⇒ 未实测一律记 false。将来实测通过后再改。
  { id: 'OpenGVLab/InternVL3_5-241B-A28B', name: 'InternVL3.5-241B-A28B (魔搭)', contextWindow: 1_048_576, supportsImage: false },

  // ── ② 无仓库先例：保守占位 512_000（未实测，见表头说明）──
  { id: 'Shanghai_AI_Laboratory/Intern-S1', name: 'Intern-S1 (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'Shanghai_AI_Laboratory/Intern-S1-mini', name: 'Intern-S1-mini (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'Shanghai_AI_Laboratory/Intern-S2-Preview', name: 'Intern-S2-Preview (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'stepfun-ai/Step-3.7-Flash', name: 'Step-3.7-Flash (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'stepfun-ai/Step-3.5-Flash', name: 'Step-3.5-Flash (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'nex-agi/Nex-N2.5-Pro', name: 'Nex-N2.5-Pro (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'nex-agi/Nex-N2.5-mini', name: 'Nex-N2.5-mini (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'mistralai/Mistral-Large-Instruct-2407', name: 'Mistral-Large-Instruct-2407 (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'PaddlePaddle/ERNIE-4.5-300B-A47B-PT', name: 'ERNIE-4.5-300B-A47B (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'PaddlePaddle/ERNIE-4.5-21B-A3B-PT', name: 'ERNIE-4.5-21B-A3B (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT', name: 'ERNIE-4.5-VL-28B (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'PaddlePaddle/ERNIE-4.5-0.3B-PT', name: 'ERNIE-4.5-0.3B (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'MedAIBase/AntAngelMed', name: 'AntAngelMed (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'opencompass/CompassJudger-1-32B-Instruct', name: 'CompassJudger-1-32B (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'early-access/EA-29B-A4B', name: 'EA-29B-A4B (魔搭·早期体验)', contextWindow: 512_000, supportsImage: false },
  { id: 'meituan-longcat/LongCat-Flash-Lite', name: 'LongCat-Flash-Lite (魔搭)', contextWindow: 512_000, supportsImage: false },
  { id: 'ACE-Step/acestep-v15-xl-sft', name: 'ACE-Step-v15-xl (魔搭)', contextWindow: 512_000, supportsImage: false },
]

/** 该模型是否为本地兜底表里登记过的（远端目录爆炸时的收敛依据）。 */
export function isKnownModelscopeModel(id: string): boolean {
  return MODELSCOPE_FALLBACK_MODELS.some((m) => m.id === id)
}

/**
 * 剥掉 id 末尾的**日期快照后缀**（`-1017` / `-0731` / `-20251017` 等）。
 *
 * 判据：末尾一段是 **4 位或 8 位纯数字**时视为快照版本，剥掉它。
 *
 * ⚠️ 为什么是 4/8 位而不是「任意数字」：
 * - 魔搭实测的日期快照是 `-1017`（MMDD）与 `-20251017`（YYYYMMDD）两种；
 * - 若放宽到「任意位数字」，会把 `Qwen2.5-72B` 这类**参数规模**当成快照
 *   （`72`）而错误剥掉 ⇒ 完全不同族的模型被并到一起。
 * - `-V4.1` / `-235B` / `-32B` 这类含字母或点号的段**不动**。
 *
 * ⚠️ 只剥**一层**：`X-1017` → `X`，不递归（`X-1017-1101` 这种形态不存在，
 * 若真出现说明上游改了命名法，那时应当显式处理而不是靠递归猜）。
 */
function stripDateSnapshotSuffix(id: string): string {
  return id.replace(/-(?:\d{4}|\d{8})$/, '')
}

/**
 * 在兜底表里查一个 id，**支持日期快照后缀**（Issue #12）。
 *
 * ## 为什么需要它
 *
 * 魔搭的推理目录 `/v1/models` **只下发 4 个字段**（`id` / `object` / `owned_by` /
 * `created`）—— **没有 `modalities`、没有 `context_window`**。所以能力判据
 * **必然**回落到本兜底表。而魔搭会**定期换快照 id**：
 *
 * - 兜底表登记的是某个快照（如 `deepseek-ai/DeepSeek-V4.1-Flash-1017`）；
 * - 上游下个月可能换成 `…-1101`，或直接退回无后缀的 `…-Flash`；
 * - 精确查找在任一条缝里都**恒不命中** ⇒ 那个模型被判成纯文本
 *   （`supportsImage: false`）且 `contextWindow: 0`，而真机实测它能收图
 *   （32×32 纯红 PNG 答 `Red`）。
 *
 * ## 匹配规则（按优先级，四条）
 *
 * 1. **精确命中**：兜底表里真有这个 id ⇒ 直接用它；
 * 2. **剥快照后精确命中**：`id` 剥掉末尾日期段 == 某条目 `id` 剥掉日期段
 *    ⇒ 同族，用它。⚠️ 这一条是**双向**的（`X-1017` ↔ `X` 互相能认），
 *    所以兜底表登记的是快照还是无后缀**都不影响**；
 * 3. **`-` 边界前缀**：`id` 以 `m.id + '-'` 开头（旧快照被新快照包含的形态，
 *    例如表里是 `X`、远端给了 `X-1017`）—— 只认 `-` 边界，避免 `Foo` 误吞
 *    `Foobar`（那不是快照，是另一个模型）；
 * 4. **最长优先**：多个条目都命中时取 `m.id` 最长的，避免短 id 把更具体的
 *    条目盖掉。
 *
 * ⚠️ **只用于「兜底」，绝不覆盖远端明确声明**：调用方必须先看远端
 * `modalities` / `context_window`，只有它们缺失时才走这里。远端说「纯文本」
 * 就是纯文本 —— 本函数不能反向推翻它（否则就是「声明支持但实际不支持」的
 * 反方向错误，同样违反本仓库的硬约定）。
 *
 * @param id 归一化后的模型 id（`normalizeModelscopeModelId` 的结果）
 * @returns 命中的兜底条目；没命中返回 `undefined`
 */
export function findModelscopeFallback(
  id: string,
): ModelscopeFallbackModel | undefined {
  const exact = MODELSCOPE_FALLBACK_MODELS.find((m) => m.id === id)
  if (exact !== undefined) return exact
  const bare = stripDateSnapshotSuffix(id)
  let best: ModelscopeFallbackModel | undefined
  const consider = (candidate: ModelscopeFallbackModel): void => {
    if (best === undefined || candidate.id.length > best.id.length) best = candidate
  }
  for (const candidate of MODELSCOPE_FALLBACK_MODELS) {
    // ② 剥快照后同族（双向）
    if (stripDateSnapshotSuffix(candidate.id) === bare) {
      consider(candidate)
      continue
    }
    // ③ `-` 边界前缀（旧快照被新快照包含）
    if (id.startsWith(`${candidate.id}-`)) consider(candidate)
  }
  return best
}

export type ModelscopeErrorKind =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'server'
  | 'transport'
  | 'invalid_request'
  // ⚠️ **本 fork 独有**（2026-10-17 审计 P1 修复）：上下文窗口超限。
  //    此前缺这一类 ⇒ 超限报文被 `exceed` 关键词判成 quota ⇒ 账号被封到次日零点。
  //    语义上它既不是配额、也不是限流：**不该写任何冷却标记**。
  | 'context_window'

export interface ModelscopeErrorInfo {
  kind: ModelscopeErrorKind
  /** 服务端要求的等待时长（毫秒）；仅在限流类错误上产出。 */
  retryAfterMs?: number
  /** 面向用户的可读描述（**禁止**裸 JSON）。 */
  detail: string
}

/** 从错误体里抽出人可读片段（禁止把整坨 JSON 抛给用户）。 */
function readableDetail(body: string): string {
  const text = body.trim()
  if (text === '') return '（上游未返回错误详情）'
  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown; msg?: unknown }
    const nested = typeof data.error === 'object' && data.error !== null
      ? (data.error as { message?: unknown }).message
      : data.error
    const parts = [data.message, nested, data.msg]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON：直接截断原文
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

/**
 * 把一次失败的 HTTP 响应归类为语义化错误。
 *
 * ## ⚠️ 顺序即优先级（每条都来自本项目真实缺陷）
 *
 * 1. **⚠️ 401/403 先判，恒归 `auth`**（2026-10-31 对抗审计同批修，与 qiniu
 *    `classifyQiniuError` 同步）：状态码与额度文案并存时**以状态码为准** ——
 *    认证类是**账号态**、不是模型冷却，落 quota 会被 `markLimited` 写成
 *    UTC+8 次日零点冷却，把认证故障放大成封池（loomy 2026-10-06「全池被封」
 *    事故同型；不变式见 `docs/agent-notes/providers-loomy-raccoon-minimax.md`）。
 *    原「额度耗尽可能回 401/403 故额度先判」的方向反了：宁可漏判额度
 *    （不换号）不可误判成封号。
 * 2. **400 单独归 `invalid_request`**：魔搭对请求体形状极严格（见模块头的
 *    工具包装事故），把它归成 server/可重试会让 harness 白重试 5 次、
 *    每次都拿到同一个 400。
 * 3. `retry-after` 由**响应头**给出，解析实现收敛在 `src/retry-after.ts`
 *    （0 是合法值，判空必须用 `=== undefined`）。
 *
 * @param status  HTTP 状态码；传输层失败传 0。
 * @param body    响应体原文（调用方**必须先读一次体**再调本函数）。
 * @param headers 响应头。
 */
export function classifyModelscopeError(
  status: number,
  body: string,
  headers?: Readonly<Record<string, string>>,
): ModelscopeErrorInfo {
  const retryAfterMs = retryAfterMsFromRecord(headers)
  const detail = readableDetail(body)
  const lower = body.toLowerCase()

  // ⚠️⚠️ **上下文超限必须排在 `rate_limit` / `quota` 之前**
  // （2026-10-17 审计 P1 修复）。此前本函数**根本没有 `context_window` 这一类**，
  // 而 rate_limit 判据含 `throttl`、quota 判据含 `exceed` ⇒
  // 「maximum context length is 8192 tokens, prompt exceeds limit」被 quota 抢走、
  // 「context window exceeded」被 quota 抢走、「context limit throttling policy
  // exceeded」连 rate_limit 都抢走（实测三种报文各自被抢）。
  // ⚠️ **危害不是分类难看，而是账号被封**：quota ⇒ 轮换层调 `markLimited` ⇒
  // `modelscopeRetryAfterMs('quota', …)` ⇒ `nextUtc8DayStartMs()` ⇒ 给该账号的该
  // 模型写一个**到次日 UTC+8 零点**的冷却标记。用户只是发了一条超长消息
  // （长会话中途上下文涨过头极常见），却**丢掉一整个账号到第二天** ——
  // 与 `docs/agent-notes/providers-loomy-raccoon-minimax.md` 记的 loomy
  // 「23:50 烧光被封到次日 23:50」同族。
  // ⚠️ 另：归 `context_window` 同时**兼得「不重试」与「触发溢出压缩」**
  // （见 `docs/agent-notes/providers-trae.md`：超限必须归 CONTEXT_WINDOW_EXCEEDED，
  // 归 SERVER 会把巨型请求原样重发 5 次）。
  //
  // ⚠️⚠️ **必须排在 `status === 429` 之前吗？——不必，且刻意不这么做**：
  //    真发 429 时那一定是真的限流，必须让 rate_limit 生效。所以本判据**只认
  //    报文文本**、不含 `status` 条件；真 429 且文本含 context 措辞是**不可能**的
  //    组合（超限不会用 429 + context 文案），故文本优先是安全的。
  if (
    lower.includes('maximum context length')
    || lower.includes('context length')
    || lower.includes('context window')
    // ⚠️ `context limit` 这一格覆盖实测到的第三种措辞
    //（「context limit throttling policy exceeded」）：它既不含 `context length`
    // 也不含 `context window`，但**含 `throttl`** ⇒ 修复前会被 rate_limit 抢走。
    // ⚠️ 判据是 `context` 与 `limit` **同时**出现（不是单看 `limit`）——
    //    否则「rate limit」这类真限流报文会被误吞成 context_window。
    || (lower.includes('context') && lower.includes('limit'))
    || lower.includes('context_length_exceeded')
    || lower.includes('reduce the length')
    || lower.includes('too many tokens')
    || lower.includes('input tokens exceed')
  ) {
    // ⚠️ `retryAfterMs` **刻意不给**：超限不是配额问题，重试无意义、也无处可退。
    return { kind: 'context_window', detail }
  }
  // ⚠️ 认证先于额度/限流（不变式 1）：401/403 带额度文案 ⇒ 恒归 auth。
  if (status === 401 || status === 403) return { kind: 'auth', detail }
  if (
    status === 429
    || lower.includes('too many requests')
    || lower.includes('rate limit')
    || lower.includes('throttl')
  ) {
    return { kind: 'rate_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail }
  }
  if (
    status === 402
    || lower.includes('insufficient')
    || lower.includes('quota')
    || lower.includes('exceed')
    || lower.includes('balance')
    || lower.includes('魔粒')
  ) {
    return { kind: 'quota', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail }
  }
  if (
    status === 0
    || lower.includes('fetch failed')
    || lower.includes('terminated')
    || lower.includes('econnreset')
    || lower.includes('socket hang up')
    || lower.includes('getaddrinfo')
    || lower.includes('econnrefused')
  ) {
    return { kind: 'transport', detail }
  }
  if (status === 400 || status === 422) return { kind: 'invalid_request', detail }
  if (status >= 500) return { kind: 'server', detail }
  return { kind: 'server', detail }
}
