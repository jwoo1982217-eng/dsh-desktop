/**
 * Magicrew（超级麦吉）provider 的**产品常量与静态兜底表**。
 *
 * ## 协议速览（2026-10-28 本机实发实测，详见设计规格 §1）
 *
 * | 用途 | 方法 | 地址 | 认证 |
 * |---|---|---|---|
 * | 登录（**不采用**） | POST | `<host>/api/v1/sessions` | 无（`type: 'phone_password'`） |
 * | 登录（**短信**，未接线） | POST | `/v4/user/send-sms` + `/v4/user/login` | 无（`type: 'phone_captcha'`） |
 * | 签/续 gateway key | POST/PUT | `<host>/api/v1/model-gateway/tokens` | JWT（POST）/ refresh_token（PUT） |
 * | 目录 | GET | `<host>/api/v1/flows/models` | JWT |
 * | 计费 | POST | `<host>/api/v1/products/model-points` | JWT |
 * | 积分 | GET | `<host>/api/v1/quota/points/total` | JWT |
 * | 推理 | POST | `<host>/v1/chat/completions` | `mgw_` api_key |
 *
 * ## ⚠️ 登录方式：**不接手机号密码**
 *
 * `POST /api/v1/sessions` 的 `phone_password` 端点确实存在（magpie 的 `api.mjs` 实测过 200），
 * 但参考实现里那个 `login()` **零调用者** —— 它是未被采用的探索代码；真实入口是
 * **短信验证码**（先解「旋转验证码」⇒ 要识图模型）。⇒ 本插件只走两条**无门槛**的路：
 * 读本机浏览器登录态（`mode: 'local-browser'`）与开窗网页登录（`mode: 'browser'`）。
 *
 * ## ⚠️ 两条实测出来的硬约束（都不在文档里，是发请求才知道的）
 *
 * 1. **api_key 与 organizationCode 必须配对**：用错配的 key 会得到
 *    **HTTP 200 + `{"code":403,"message":"token无效"}`** —— 错误藏在 body 里，
 *    只判 `res.ok` 会误判成功。
 * 2. **`expires_at` 无时区**（`2026-11-27 13:47:42`）⇒ 按 **UTC+8** 解释。
 *
 * ## ⚠️ 本文件必须零 `node:*` 依赖
 *
 * 与 `provider-registry.ts` 同因：它可能被客户端产物（esbuild）引用。
 */

/** 一条静态兜底模型。远端目录**不返回** ctx 与档位 ⇒ 只能由本表提供。 */
export interface MagicrewFallbackModel {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens?: number
  /** 实测上游认 7 档，但强度不被区分 ⇒ 只声明「关闭 / 开启」两档。 */
  readonly reasoningEfforts?: readonly string[]
  readonly defaultReasoningEffort?: string
  readonly supportsImage?: boolean
}

export interface MagicrewProduct {
  /** provider id。国内 `magicrew`、国际 `magicrewintl`（全小写、无连字符）。 */
  readonly id: 'magicrew' | 'magicrewintl'
  readonly site: 'cn' | 'intl'
  readonly displayName: string
  /** 业务 API 与模型网关共用同一个 host（与 magpie 侧 `SITES` 一致）。 */
  readonly host: string
  /** 网页 origin（`Origin` 头必带，缺了偶发 403）。 */
  readonly webOrigin: string
  /**
   * 网关是否**强制**要求 `organization-code`。
   *
   * 实测：国内站不强制（缺了仍 200）；国际站缺了回 **HTTP 500 + 22 字节裸文本**
   * （不是 JSON，极易被误判成「网关挂了」）。
   */
  readonly needsOrgOnGateway: boolean
  readonly defaultCredentialRef: string
  readonly requestTimeoutMs: number
  readonly chatHeaderTimeoutMs: number
  /**
   * 目录 GET 失败后的**退避窗口**（负缓存）。
   *
   * ⚠️ 没有它时「失败」在 TTL 门里**不是一种状态**（`catalogAt` 仍是 0）⇒
   * 每条消息都会再发一次目录 GET + 一条 warn：一次上游抖动就会让整段对话
   * 每轮多一次超时请求。成功即清零，故正常路径不受影响。
   */
  readonly catalogRetryMs: number
  /** SSE 两字节之间的上限。推理模型可能长时间无输出。 */
  readonly chunkTimeoutMs: number
  readonly fallbackModels: readonly MagicrewFallbackModel[]
}

// ── 端点路径 ────────────────────────────────────────────────────────────
export const MAGICREW_SESSIONS_PATH = '/api/v1/sessions'
export const MAGICREW_GATEWAY_TOKENS_PATH = '/api/v1/model-gateway/tokens'
export const MAGICREW_MODELS_PATH = '/api/v1/flows/models'
export const MAGICREW_MODEL_POINTS_PATH = '/api/v1/products/model-points'
export const MAGICREW_POINTS_PATH = '/api/v1/quota/points/total'
export const MAGICREW_CHAT_PATH = '/v1/chat/completions'

/** 账号池凭据 ref 前缀（`jet-hub-store.ts` 的前缀表必须同步）。 */
export const MAGICREW_ACCOUNT_PREFIX = 'MAGICREW_ACCOUNT_'

/**
 * 思考档位：**只有两档**。
 *
 * 实测（2026-10-28，`deepseek-v4.1-flash`，`max_tokens=1024`，解题类提问）：
 *
 * | 载荷 | `reasoning_tokens` |
 * |---|---|
 * | 裸请求（不发该字段） | 54（**默认就在思考**） |
 * | `none` | **0**（真关闭，正文变成完整推导 1311 字符） |
 * | `minimal` / `low` / `medium` / `high` / `xhigh` / `max` | 72 / 91 / 87 / 51 / 77 / 88 |
 * | 非法值 | HTTP 400（`must be one of: none, minimal, low, medium, high, xhigh, max`） |
 *
 * ⇒ 上游**接受** 7 档，但 `reasoning_tokens` **不单调**（51~91 波动）⇒ 强度**不被区分**。
 * 声明 7 档会让用户以为能调强度（假的）；一档都不声明则用户**无法关闭思考**。
 * ⇒ 只声明 `none`（关）与 `high`（开）。
 *
 * ⚠️ 上行前必须按本集合过滤：上游对非法值回 **400**，目录腐坏会给出非法值。
 */
export const MAGICREW_REASONING_EFFORTS: readonly string[] = Object.freeze(['none', 'high'])
export const MAGICREW_DEFAULT_EFFORT = 'high'

/**
 * `max_tokens` 下限。
 *
 * 实测（`max_tokens=64`，图片提问）：`mimo-v2.6-flash` 正常答出 "Red"，
 * 而 `deepseek-v4.1-flash` / `glm-5.3-flash` 的 `finish_reason` 是 **`length`**、
 * `content` 是**空串**（64 个 token 被 reasoning 吃满）。
 * ⇒ 用户看到「模型不回复」，而上游 HTTP 200、零报错。
 */
export const MAGICREW_MIN_MAX_TOKENS = 512

/**
 * **目录里没有该 id 时**的兜底上下文窗口。
 *
 * ⚠️ 给大不给小：给 1M 而实际 128K ⇒ 上游超限报错（用户看得见）；
 * 给 256K 而实际 1M ⇒ agent 主动拒绝本可处理的对话（**静默的能力损失**）。
 *
 * 参考 codearts 的真实报障：`contextWindow === undefined` 时
 * `dsh-client-ui-conversation` 的 `contextOccupancy()` 返回 `null`、
 * `ContextMeter` 整条不渲染 ⇒ 用户看不到占用条，自动压缩阈值也失去唯一输入。
 */
export const MAGICREW_FALLBACK_CONTEXT_WINDOW = 1_048_576

/**
 * 27 条静态兜底模型 —— **2026-10-28 逐条取自本机真实账号的目录快照**
 * （`~/.cache/magpie/magicrew-models-magicrew.json` 的 `limit.context` 与
 * `capabilities.input.image`）。
 *
 * ⚠️⚠️ **本表必然腐坏，已实测证明**（同一模型在两个时间点不同）：
 *
 * | 模型 | magpie `internals.md`（10-27） | 本机快照（10-28） |
 * |---|---|---|
 * | `glm-5.3-flash` | 262,144 | **327,680** |
 * | `deepseek-v4-flash` | 1,048,576 | **1,000,000** |
 *
 * ⇒ 设计上本表只作**兜底**：远端能给的（名称 / `vision` / 价格）一律以远端为准，
 * 只有 ctx 与档位（远端**两个端点都不返回**）才用本表。
 *
 * ⚠️ `glm-5.2` **刻意不在表内**：该账号的 27 条目录里没有它
 * （magpie 的 README 提到过，但那是另一个账号的可见集合）⇒ 不编造。
 */
const MAGICREW_FALLBACK_MODELS: readonly MagicrewFallbackModel[] = Object.freeze([
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_048_576, supportsImage: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, supportsImage: true },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 1_048_576, supportsImage: true },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max', contextWindow: 1_000_000, supportsImage: true },
  // ⚠️ 本 id **带连字符**（上游原样），与 qwen3.5-flash 那批的不带连字符不同形态。
  //    `canonical-models.ts` 需要一条 overrides 把它并到 `qwen3-8-flash`（任务 7）。
  { id: 'qwen-3.8-flash', name: 'Qwen3.8 Flash', contextWindow: 1_048_576, supportsImage: true },
  { id: 'qwen3.5-flash', name: 'Qwen3.5 Flash', contextWindow: 1_000_000, supportsImage: true },
  { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', contextWindow: 262_144, supportsImage: true },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', contextWindow: 262_144, supportsImage: true },
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', contextWindow: 1_000_000, supportsImage: true },
  { id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 512_000, supportsImage: true },
  { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', contextWindow: 1_000_000, supportsImage: true },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7', contextWindow: 262_100, supportsImage: true },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5', contextWindow: 204_800, supportsImage: true },
  { id: 'minimax-m2.1', name: 'MiniMax M2.1', contextWindow: 204_800, supportsImage: true },
  { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 327_680, supportsImage: false },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 327_680, supportsImage: true },
  { id: 'glm-5.1', name: 'GLM 5.1', contextWindow: 200_000, supportsImage: false },
  { id: 'glm-5-turbo', name: 'GLM 5 Turbo', contextWindow: 200_000, supportsImage: true },
  { id: 'glm-5', name: 'GLM 5', contextWindow: 204_800, supportsImage: false },
  { id: 'glm-4.7', name: 'GLM 4.7', contextWindow: 204_800, supportsImage: false },
  { id: 'glm-4.6', name: 'GLM 4.6', contextWindow: 204_800, supportsImage: false },
  { id: 'glm-4.5', name: 'GLM 4.5', contextWindow: 131_072, supportsImage: false },
  { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', contextWindow: 1_048_576, supportsImage: true },
  { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', contextWindow: 1_048_576, supportsImage: false },
  { id: 'doubao-seed-2.0-pro', name: 'Seed 2.0 Pro', contextWindow: 256_000, supportsImage: true },
  { id: 'doubao-seed-2.0-code', name: 'Seed 2.0 Code', contextWindow: 256_000, supportsImage: true },
  { id: 'doubao-seed-2.0-lite', name: 'Seed 2.0 Lite', contextWindow: 256_000, supportsImage: true },
].map((model) => Object.freeze({
  ...model,
  reasoningEfforts: MAGICREW_REASONING_EFFORTS,
  defaultReasoningEffort: MAGICREW_DEFAULT_EFFORT,
})))

export const MAGICREW: MagicrewProduct = Object.freeze({
  id: 'magicrew',
  site: 'cn',
  // ⚠️ 与客户端 `PROVIDER_REGISTRY` 的 label 语义一致（rail 宽度算式依赖长度）。
  displayName: '超级麦吉',
  host: 'https://i-magic-service.letsmagic.cn',
  webOrigin: 'https://www.letsmagic.cn',
  needsOrgOnGateway: false,
  defaultCredentialRef: 'MAGICREW_ACCESS_TOKEN',
  requestTimeoutMs: 30_000,
  chatHeaderTimeoutMs: 60_000,
  // 失败后 60s 内不再重发目录 GET（一次抖动不该让它每轮都试一次）。
  catalogRetryMs: 60_000,
  // ⚠️ 必须够长：推理模型可能长时间只吐 reasoning、两次字节之间静默 >45s。
  chunkTimeoutMs: 300_000,
  fallbackModels: MAGICREW_FALLBACK_MODELS,
})

/** 按 id 取静态兜底条目；未登记返回 `undefined`（**不编造**）。 */
export function magicrewFallbackModelOf(
  modelId: string,
): MagicrewFallbackModel | undefined {
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined
  return MAGICREW_FALLBACK_MODELS.find((model) => model.id === modelId)
}
