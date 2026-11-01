/**
 * Qiniu（七牛云 AI）产品配置与错误分类。
 *
 * ## 协议形态：OpenAI 兼容网关（无厂商私有信封）
 *
 * 七牛云 AI 通过 https://api.qnaigc.com/v1 提供标准 OpenAI 兼容接口：
 * - 鉴权：`Authorization: Bearer <API Key>`；
 * - chat：`POST /chat/completions`（SSE 流式）；
 * - 目录：`GET /models`（返回 `data: [{id, object, owned_by, created, context_length, max_tokens}]`，
 *   **实测免鉴权也回 200** ⇒ 凭据有效性不能靠「目录能读到」判定）；
 * - API Key **长期有效**、**无 refresh 端点**；
 * - **无余额/额度查询端点**（余额只在登录后的网页控制台可见）。
 *
 * 与 modelscope（魔搭）是同一范式：静态 API Key + OpenAI 兼容 + 无 refresh +
 * 无余额端点。因此本 provider 逐字镜像 modelscope 的接入结构（见
 * docs/adding-a-new-provider.md 的「路径 B 全新脉系」）。
 *
 * ## ⚠️ 模型 id 由平台动态下发，兜底表 = 远端快照（**非空**，2026-10-30 修订）
 *
 * 七牛云官方明令「模型 id 由 qiniu.com/ai/models 下发」，会随平台增删变化。
 * 因此**初版**曾把兜底模型表（QINIU_FALLBACK_MODELS）刻意置空 —— 但实测证明
 * 那条路线有毒：`listAllModels()` 冷缓存恒 `[]` ⇒ `models.total === 0` ⇒
 * 面板把该渠道**误显示为「已关闭且无模型可关」**（与 modelscope 那条
 * 「provider 显示已关闭、模型却仍可选用」相反方向的矛盾态）。
 * 现行做法：兜底表 = 远端快照 `QINIU_REMOTE_SNAPSHOT` 映射出的**非空**表
 * （2026-10-29 直连 `/v1/models` 的 77 条实测，见下方「实测目录形状」），
 * 远端可用时仍**完全采信远端**；快照只承接「远端不可用且无缓存」的兜底。
 *
 * ## 实测目录形状（2026-10-29 直连 https://api.qnaigc.com/v1/models，HTTP 200）
 *
 * - id 是**两种形态混合**：新模型带厂商命名空间前缀（`moonshotai/kimi-k3`、
 *   `deepseek/deepseek-v4-pro-0813`、`qwen/qwen3.8-max`、`z-ai/glm-5.3`、
 *   `minimax/minimax-m3.1-flash`、`qiniu/conatus-free` …），老模型是裸名
 *   （`deepseek-v3`、`kimi-k2`、`glm-4.5`、`qwen-turbo`、`MiniMax-M1` …）。
 *   两种都要原样透传：**不得**自己做 `/` 拆分或归一（FAQ Q6 明确要求 model
 *   字段与模型广场的「API model 参数」逐字一致，否则找不到模型）。
 * - 每条带 `context_length` 与 `max_tokens`（部分为 0）⇒ 上下文窗口有权威来源，
 *   这正是快照表只需记 `[id, context_length]` 两列的底气（远端给窗口，不需要本地猜）。
 * - **不下发模态**（无 `modalities` / `input_modalities` 字段）。
 *
 * @module src/qiniu-product.ts
 */

import { retryAfterMsFromRecord } from './retry-after.js'

/** Qiniu（七牛云 AI）的产品配置（字段围绕 OpenAI 兼容协议）。 */
export interface QiniuProduct {
  readonly id: 'qiniu'
  /**
   * 展示名。
   *
   * ⚠️ 必须与客户端 `plugin-src/client/jet-hub.js` 的 `PROVIDERS` 里
   *   `qiniu` 那条的 `label` **逐字一致**。
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
   * 单凭据回退 ref。
   *
   * 取 `QINIU_ACCESS_TOKEN`：与 modelscope 的 `MODELSCOPE_ACCESS_TOKEN`
   * 同口径（静态 API Key 的默认单凭据 ref）。
   */
  readonly defaultCredentialRef: string
}

export const QINIU: QiniuProduct = {
  id: 'qiniu',
  // ⚠️ 与客户端 PROVIDERS 的 label 逐字一致。
  displayName: 'Qiniu (七牛云)',
  baseUrl: 'https://api.qnaigc.com/v1',
  chatPath: '/chat/completions',
  modelsPath: '/models',
  // 与 modelscope 同档的流式超时常量（保守值）。
  chatHeaderTimeoutMs: 60_000,
  chunkTimeoutMs: 120_000,
  catalogTimeoutMs: 15_000,
  defaultCredentialRef: 'QINIU_ACCESS_TOKEN',
}

/** 兜底模型目录条目。 */
export interface QiniuFallbackModel {
  /** 上游真实模型 id（以远端 /models 下发为准）。 */
  id: string
  /** 展示名（缺省时用 id）。 */
  name: string
  /**
   * 上下文窗口（DSH 以它 × 0.8 作压缩阈值）。
   *
   * ⚠️ `0` 是「**不知道**」哨兵，**不是**合法窗口 —— `resolveModel` 判
   * `> 0` 才下发 `context`。
   */
  contextWindow: number
  /** 是否支持图片输入（**声明支持就必须真支持**，本仓库硬约定）。 */
  supportsImage: boolean
  /** 支持的思考档位（上游 wire 值）；**为空时不声明 `reasoning`**。 */
  efforts?: readonly string[]
}

/**
 * 兜底模型表（**2026-10-29 直连 `GET https://api.qnaigc.com/v1/models` 的实测快照**）。
 *
 * ## ⚠️ 为什么这里必须有一张表（而不是「官方说别写死」就置空）
 *
 * 官方 FAQ Q6 的要求是「请求里的 `model` 必须与模型广场的 API model 参数逐字一致」，
 * 这禁止的是**拆分/归一 id**，并不禁止本地留一份离线快照。而置空的代价是实测出来的：
 *
 * - `listAllModels()` **冷缓存**恒为 `[]` ⇒ `provider.status` 的 `models.total` 恒 0
 *   ⇒ 设置页把整个 provider 误显示为「已关闭」（判据是
 *   `closed = total > 0 && disabled === total`），且**模型选择器里没有任何模型可关**
 *   （`tests/unit/refresh-targets-derived.spec.ts` 的 ⑧、
 *   `tests/unit/model-catalog-parity.spec.ts` 的 (j) 会直接点名）。
 *
 * ⇒ 保留一张「远端下发过的」快照，且**远端永远优先**：`loadQiniuCatalog` 一旦拉到远端
 *   就用远端结果覆盖它（含窗口，七牛云实测每条都带 `context_length`）。
 *
 * ## 窗口值 = 远端 `context_length`（逐条照抄，不四舍五入、不猜）
 *
 * ## ⚠️ `supportsImage` 全表 `false`：**不是**「这些模型都不收图」，而是「没实测过」
 *
 * 本仓库硬约定「声明支持就必须真支持」（accio 那轮实测：漏报 false 会让模型对图片
 * **幻觉出答案**，HTTP 200 且不报错）。目录里确实有 VL 系（`qwen-vl-max-2025-01-25`、
 * `doubao-1.5-vision-pro`、`qwen3-vl-30b-a3b-thinking`、
 * `deepseek/deepseek-v4-flash-vision-exp` …），但**七牛云侧未做读图实测** ⇒
 * 一律如实记 `false`；实测通过后把该条改成 `true` 并**在提交信息里附取证**。
 *
 * ## ⚠️ 思考档位未声明
 *
 * 七牛云官方支持 `reasoning_effort: low|medium|high`，但**目录不下发**每个模型支持哪几档
 * ⇒ 全表不写 `efforts`（等于「不声明 `reasoning`」）。给一份「看起来能选、实则被上游
 * 静默忽略」的档位列表是更糟的谎（providers-accio.md §7 的教训）。
 */
const QINIU_REMOTE_SNAPSHOT: ReadonlyArray<readonly [string, number]> = [
  ['meituan/longcat-flash-lite', 256_000],
  ['qwen3-vl-30b-a3b-thinking', 128_000],
  ['doubao-1.5-pro-32k', 128_000],
  ['doubao-1.5-thinking-pro', 128_000],
  ['doubao-1.5-vision-pro', 128_000],
  ['glm-4.5', 131_072],
  ['kimi-k2', 128_000],
  ['qwen-turbo', 1_000_000],
  ['qwen-vl-max-2025-01-25', 128_000],
  ['qwen2.5-vl-72b-instruct', 128_000],
  ['qwen3-235b-a22b', 128_000],
  ['qwen3-30b-a3b', 40_000],
  ['qwen3-235b-a22b-instruct-2507', 262_144],
  ['qwen3-235b-a22b-thinking-2507', 262_144],
  ['qwen3-coder-480b-a35b-instruct', 262_000],
  ['doubao-seed-1.6', 256_000],
  ['doubao-seed-1.6-flash', 256_000],
  ['doubao-seed-1.6-thinking', 256_000],
  ['qwen3-next-80b-a3b-thinking', 131_072],
  ['qwen3-next-80b-a3b-instruct', 131_072],
  ['z-ai/glm-4.6', 200_000],
  ['moonshotai/kimi-k2-thinking', 256_000],
  ['z-ai/glm-4.7', 200_000],
  ['qwen3-30b-a3b-thinking-2507', 126_000],
  ['tencent/hy3-preview', 262_144],
  ['qwen/qwen3.6-27b', 262_100],
  ['nvidia/nemotron-3-ultra-550b-a55b0-free', 1_000_000],
  ['moonshotai/kimi-k3-free', 1_048_576],
  ['z-ai/glm-5.1', 200_000],
  ['moonshotai/kimi-k2.6', 262_000],
  ['qwen/qwen3.7-max', 1_000_000],
  ['minimax/minimax-m3', 1_000_000],
  ['moonshotai/kimi-k2.7-code', 262_144],
  ['z-ai/glm-5.2', 1_000_000],
  ['qwen/qwen3.7-plus', 1_000_000],
  ['bytedance/doubao-seed-2-1-pro', 256_000],
  ['bytedance/doubao-seed-2-1-turbo', 256_000],
  ['stepfun/step-3.7-flash', 256_000],
  ['moonshotai/kimi-k3', 1_048_576],
  ['deepseek/deepseek-v4-flash-20260731', 1_000_000],
  ['qwen/qwen3.8-max', 1_000_000],
  ['deepseek/deepseek-v4-pro-0813', 1_000_000],
  ['z-ai/glm-5.3', 1_000_000],
  ['deepseek/deepseek-v4-flash-vision-exp', 1_000_000],
  ['qwen/qwen3.8-flash-next', 1_000_000],
  ['z-ai/glm-5.3-flash', 1_000_000],
  ['tencent/hy4-preview', 1_000_000],
  ['deepseek/deepseek-v4.1-flash', 1_000_000],
  ['qwen/qwen3.7-flash', 1_000_000],
  ['xiaomi/mimo-v2.6-pro', 1_000_000],
  ['xiaomi/mimo-v2.6-flash', 1_000_000],
  ['bytedance/doubao-seed-2-1-lite', 1_024_000],
  ['deepseek/deepseek-v4.1-flash-1017', 1_000_000],
  ['minimax/minimax-m3.1-flash', 1_000_000],
  ['qiniu/conatus-free', 1_000_000],
  ['moonshotai/kimi-k3.1-pro', 1_048_576],
  ['moonshotai/kimi-k3.1-pro-highspeed', 1_048_576],
  ['doubao-seed-2.0-code', 256_000],
  ['doubao-seed-2.0-pro', 256_000],
  ['minimax/minimax-m2.5-highspeed', 204_800],
  ['MiniMax-M1', 1_000_000],
  ['doubao-seed-2.0-mini', 256_000],
  ['minimax/minimax-m2', 200_000],
  ['moonshotai/kimi-k2.5', 256_000],
  ['minimax/minimax-m2.5', 204_800],
  ['minimax/minimax-m2.7', 204_800],
  ['doubao-seed-2.0-lite', 256_000],
  ['qwen3.5-397b-a17b', 256_000],
  ['qwen-max-2025-01-25', 128_000],
  ['qwen3-32b', 40_000],
  ['qwen3-max-preview', 256_000],
  ['qwen3-30b-a3b-instruct-2507', 128_000],
  ['minimax/minimax-m2.1', 204_800],
  ['z-ai/glm-5', 200_000],
  ['qwen3-max', 262_144],
  ['qwen/qwen3.6-plus', 1_000_000],
  ['qwen/qwen3.5-plus', 1_000_000],
]

export const QINIU_FALLBACK_MODELS: readonly QiniuFallbackModel[] = QINIU_REMOTE_SNAPSHOT
  .map(([id, contextWindow]) => ({
    id,
    // 展示名直接用 id：远端不下发人类可读名，编一个反而与模型广场对不上（用户按名字搜不到）。
    name: id,
    contextWindow,
    supportsImage: false,
  }))

/** 该模型是否为本地兜底表里登记过的。 */
export function isKnownQiniuModel(id: string): boolean {
  return QINIU_FALLBACK_MODELS.some((m) => m.id === id)
}

export type QiniuErrorKind =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'server'
  | 'transport'
  | 'invalid_request'
  // ⚠️ 上下文窗口超限：既不是配额也不是限流 —— 不写冷却标记、不重试，
  //   直接把原文抛出去，让宿主走溢出压缩（与 modelscope 同款语义）。
  | 'context_window'

export interface QiniuErrorInfo {
  kind: QiniuErrorKind
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
 * ## ⚠️ 顺序即优先级
 *
 * 1. **上下文超限排在限流/额度之前**：归 quota 会让账号被封到次日零点；
 * 2. **⚠️ 401/403 先判，恒归 `auth`**（2026-10-31 对抗审计 M1a 打穿后修）：
 *    状态码与额度文案并存时（网关侧故障常在报文里捎带 `insufficient quota`
 *    类提示）**以状态码为准** —— 认证类是**账号态**、不是模型冷却，落 quota
 *    会被 `markLimited` 写成 UTC+8 次日零点冷却，把认证故障放大成封池
 *    （loomy 2026-10-06「全池被封」事故同型，不变式见
 *    `docs/agent-notes/providers-loomy-raccoon-minimax.md` §分类两条不变式 1）。
 *    原「网关额度耗尽可能回 401/403，故额度先判」的注释方向反了：宁可漏判
 *    额度（不换号）不可误判成封号。
 * 3. **限流/额度之后**才是传输/形状/服务端；
 * 4. **400 单独归 `invalid_request`**：形状问题与账号无关，白重试 5 次无益；
 * 5. `retry-after` 由响应头给出（`retry-after.ts`，0 是合法值）。
 *
 * @param status  HTTP 状态码；传输层失败传 0。
 * @param body    响应体原文（调用方**必须先读一次体**再调本函数）。
 * @param headers 响应头。
 */
export function classifyQiniuError(
  status: number,
  body: string,
  headers?: Readonly<Record<string, string>>,
): QiniuErrorInfo {
  const retryAfterMs = retryAfterMsFromRecord(headers)
  const detail = readableDetail(body)
  const lower = body.toLowerCase()

  // 上下文超限：必须排在 rate_limit / quota / auth 之前（见模块头）。
  if (
    lower.includes('maximum context length')
    || lower.includes('context length')
    || lower.includes('context window')
    || (lower.includes('context') && lower.includes('limit'))
    || lower.includes('context_length_exceeded')
    || lower.includes('reduce the length')
    || lower.includes('too many tokens')
    || lower.includes('input tokens exceed')
  ) {
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