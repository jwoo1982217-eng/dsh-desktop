/**
 * Qiniu（七牛云）的凭据结构、过期判定、请求头与模型 id 处理。
 *
 * ## 凭据形态
 *
 * 七牛云用的是**长期 API Key**（AI 大模型推理控制台的「API Key」页生成，官方
 * 文档明示**以 `sk-` 开头**；完整长度与字符集官方未给约束），**没有 refresh 端点** ——
 * 与 ZCode / Loomy 同属「凭据是静态材料」那一类，与 codearts / buddy / qoder /
 * trae / cline / raccoon / minimax / gemini 的 OAuth 续期链**不同源**。
 *
 * 本插件的统一形态（与其余 16 家一致）：**一条账号一份 JSON 凭据**，
 * 存在 `ctx.credentials` 里、由 `credentialRef` 关联；账号索引进 `AccountPool`。
 * 故这里不引入任何「裸字符串 / 数组号池」的历史形态 —— 那种形态只适合反代，
 * 而本插件没有反代：推理一律经 `ctx.llm` 上的适配器走。
 *
 * ## ⚠️ 字段名必须是 `access_token`
 *
 * `AccountPool.findAccountIdByCredential` 对**非 codearts** 的 provider
 * 统一取 `access_token` 作身份标识（`src/account-pool.ts:1271`）：
 *
 * ```ts
 * const identifierKey = provider === 'codearts' ? 'access_key_id' : 'access_token'
 * ```
 *
 * 若这里改名成 `api_key`（opencode 那种写法），限流记录的账号归属会**恒匹配
 * 失败且静默** —— 重测/重置按钮清不掉任何标记。故**沿用 `access_token`**。
 *
 * `docs/adding-a-new-provider.md` 的检查清单把这条写成了硬性要求：
 * 「非 `codearts` 的 provider 凭据含 `access_token` 字段」。
 *
 * @module src/qiniu.ts
 */

import { QINIU } from './qiniu-product.js'

/** 一份可持久化的七牛云凭据。 */
export interface QiniuCredential {
  /**
   * API Key（身份本体）。
   *
   * ⚠️ 字段名 **必须**是 `access_token`（见模块头），不要改成 `api_key`。
   */
  access_token: string
  /** 展示名。 */
  nickname?: string
  /**
   * 毫秒时间戳字符串（若上游给出过有效期）。
   *
   * ⚠️ 七牛云的 API Key **默认长期有效**，实测控制台可设「永久」。故本字段通常
   * **缺失** —— `isQiniuExpired` 因此对缺省值判**未过期**（见下）。
   */
  expires_at?: string
  /** 账号标识（若可获得；七牛云不提供，保留仅为兼容导入的备份）。 */
  user_id?: string
}

/**
 * 解析凭据里的过期时刻（毫秒）。
 *
 * ⚠️ **读取时兼容秒级时间戳**（`> 1e12` 视为毫秒，否则视为秒）——
 * 与 `src/buddy.ts` 的 `credentialExpiresAtMs` 同一约定。不兼容会让
 * 「上游/历史误写成秒」的值被当成 1970 年 ⇒ **恒判已过期**、无谓续期。
 *
 * @returns 毫秒时间戳；字段缺失或不可解析时 `undefined`。
 */
export function qiniuCredentialExpiresAtMs(
  credential: QiniuCredential | undefined,
): number | undefined {
  const raw = credential?.expires_at
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  // 秒级（10 位）与毫秒级（13 位）的分界取 1e12。
  return parsed > 1e12 ? parsed : parsed * 1000
}

/**
 * 凭据是否已过期。
 *
 * ⚠️⚠️ **没有 `expires_at` 时恒返回 `false`（= 未过期），这不是省事。**
 *
 * 七牛云的 API Key 默认长期有效，凭据里因此通常**根本没有过期时间**。若把
 * 「读不到」判成「已过期」，后果是：
 * - 界面每张账号卡片都会显示红色「有效期：已过期」；
 * - 续期定时器每轮都把它挑出来（本 provider 又没有 refresh 端点可调）；
 * - 用户以为账号坏了，实际一切正常。
 *
 * 与 Loomy 同口径：「读不到就说读不到」，不把未知当失效。
 * 真正的失效由**上游 401** 反映（适配器按需给出可读文案）。
 */
export function isQiniuExpired(credential: QiniuCredential | undefined): boolean {
  const expiresAt = qiniuCredentialExpiresAtMs(credential)
  if (expiresAt === undefined) return false
  return expiresAt <= Date.now()
}

/**
 * 凭据是否**具备可续期的材料**。
 *
 * ⚠️ **恒为 `false`**，且这是**诚实标记而非状态**：七牛云没有任何 refresh 端点，
 * API Key 只能由用户回控制台重新生成。标 `true` 会让 UI 显示「可自动续期」
 * ——一个永远不会发生的承诺（与 Loomy 的 `isLoomyRefreshable` 同因）。
 *
 * 账号落池时 `refreshable` 必须写 `false`（见 `qiniu-rpc.ts`）。
 */
export function isQiniuRefreshable(_credential?: QiniuCredential): boolean {
  return false
}

/** 凭据的身份串（限流记录归属用；取不到时返回空串）。 */
export function qiniuIdentityOf(credential: QiniuCredential | undefined): string {
  return typeof credential?.access_token === 'string' ? credential.access_token : ''
}

/**
 * 把 API Key 打码成 `前 4 位…尾 4 位`（UI 一律用它，**绝不**展示明文）。
 *
 * ## ⚠️ 为什么取**尾 4** 位
 *
 * 与 `qiniuSlotNamesOf`（账号 id 由**尾 8 位**派生）同一口径 ⇒ 用户在
 * 「账号 id」「凭据 ref」「卡片上的打码」三处看到的是同一段指纹，能互相核对。
 *
 * ⚠️ 形状不合法的**返回空串**而不是回显原文 —— 打码函数绝不能成为「把任意
 * 输入原样显示」的通道（否则用户粘贴了一段错误文本时会被整串上屏）。
 *
 * ## ⚠️ 形状闸门**刻意不绑死 `sk-` 前缀**
 *
 * 七牛云官方文档（《批量创建API Key》 developer.qiniu.com/aitokenapi/13392）
 * 明示 Key「以 `sk-` 开头」，OpenClaw 配置指南示例亦为 `sk-...`；但**长度与
 * 字符集官方从未给出约束**。故闸门按与上游命名无关的共性判据
 * 「≥16 位 + 仅 `[A-Za-z0-9_.-]`」，不写死前缀 —— 本仓库 opencode 的
 * Issue IKPLRU 实测过绑死前缀的代价：上游换发 `oc_sk_…` 后 `^sk-` 闸门让
 * 新 Key **全数拒收**，用户一个账号都加不进来。当前正则天然放行 `sk-…`。
 */
export function maskQiniuKey(key: string | undefined | null): string {
  if (typeof key !== 'string') return ''
  const trimmed = key.trim()
  // ⚠️ 与 `KEY_PATTERN`（qiniu-rpc.ts）同款形状：前缀 + 至少 16 位。
  if (!/^[A-Za-z0-9_.-]{16,}$/.test(trimmed)) return ''
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`
}

/**
 * 构造发往七牛云的请求头。
 *
 * `Content-Type: application/json` + `Authorization: Bearer <key>`，另加 `Accept`。
 *
 * ## ⚠️ Accept 必须**按用途区分**
 *
 * `/models` 与 `/chat/completions` 共用 `text/event-stream` 在部分平台上会让
 * 目录端点回 **406**（本仓库实测过 ChatAnywhere）⇒ 该上游模型列表**永远失败**，
 * 且后果隐蔽（拉不到时上层静默跳过该上游，它提供的模型全部缺失）。
 * 七牛云本身未实测到 406，但判据不该依赖「某平台碰巧不校验」这种易变外部事实。
 *
 * @param apiKey  API Key（空串时仍产出合法头，由调用方先判「有没有凭据」）。
 * @param accept  `'application/json'`（列举模型）或 `'text/event-stream'`（对话）。
 */
export function qiniuHeaders(
  apiKey: string,
  accept: 'application/json' | 'text/event-stream' = 'text/event-stream',
): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept,
    authorization: `Bearer ${apiKey}`,
  }
}

/** 对话端点全 URL。 */
export function qiniuChatUrl(product = QINIU): string {
  return `${product.baseUrl}${product.chatPath}`
}

/** 模型目录端点全 URL。 */
export function qiniuModelsUrl(product = QINIU): string {
  return `${product.baseUrl}${product.modelsPath}`
}

/**
 * 归一化模型 id。
 *
 * 七牛云的 `/v1/models` 返回的是**带命名空间前缀**的真实 id
 * （例：`deepseek-ai/DeepSeek-V4.1-Flash`），必须**原样**发给上游 ——
 * 剥掉 `deepseek-ai/` 会得到 404（"model not found"）。
 *
 * ⚠️ 本函数**只做去空白**，**刻意不做**任何前缀剥离/大小写归一。
 * 存在的意义是：把「调用方忘了 trim」这类失误收敛到一处，并让
 * 「不剥前缀」这条判据有一处可被单测点名的地方。
 * （对照：`canonical-models.ts` 的归一化是**给聚合分组用**的，绝不能回流到
 * 发请求的 model 字段上 —— 那是 qoder 那条「id 是内部代号」教训的同族。）
 */
export function normalizeQiniuModelId(raw: string): string {
  return raw.trim()
}
