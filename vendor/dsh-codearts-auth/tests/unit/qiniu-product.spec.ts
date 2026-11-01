/**
 * Qiniu（七牛云）产品配置 + 错误分类的守卫。
 *
 * ## 锁的三件事（每条都对应一类真实事故形态）
 *
 * ① `baseUrl` 必须**含 `/v1` 且不带尾斜杠**：拼 URL 的 `qiniuChatUrl()` 是裸字符串
 *    拼接，多一个斜杠就是 `//chat/completions`（上游回 404，且报错里看不出是双斜杠）。
 * ② 兜底表是 **2026-10-29 直连 `/v1/models` 的实测快照**（77 条，窗口逐条照抄
 *    `context_length`），且**必须与远端「同一套 id、不拆分不归一」** —— 官方 FAQ Q6
 *    明令 `model` 字段要与模型广场的「API model 参数」逐字一致；`moonshotai/kimi-k3`
 *    这类带厂商前缀的 id **原样保留**，剥前缀/小写化都会让请求 400。
 *    ⚠️ 但快照**永远不是权威**：远端拉到就整体覆盖（见 `loadQiniuCatalog`）；
 *    快照只服务「冷缓存 / 拉取失败」两格，缺了它会让 `listAllModels()` 恒空
 *    ⇒ 设置页把整个 provider 误判成「已关闭」（model-catalog-parity 的 (j) 守卫）。
 * ③ 错误分类的**顺序**：`context_window` 排在 `rate_limit`/`quota` 之前。
 *    顺序错了的后果不是「分类不准」，而是**用户被封账号一整天**（超限被判额度）。
 */

import { describe, expect, it } from 'vitest'
import {
  QINIU,
  QINIU_FALLBACK_MODELS,
  classifyQiniuError,
  isKnownQiniuModel,
} from '../../src/qiniu-product.js'
import { qiniuChatUrl, qiniuHeaders, qiniuModelsUrl } from '../../src/qiniu.js'

describe('QINIU 产品常量', () => {
  it('★ baseUrl 含 /v1 且不带尾斜杠，两条端点因此不会出现双斜杠', () => {
    expect(QINIU.baseUrl).toBe('https://api.qnaigc.com/v1')
    expect(QINIU.baseUrl.endsWith('/')).toBe(false)
    expect(qiniuChatUrl()).toBe('https://api.qnaigc.com/v1/chat/completions')
    expect(qiniuModelsUrl()).toBe('https://api.qnaigc.com/v1/models')
    // 反向自检：拼接结果里不得出现 '//'（协议名之后的那个除外）。
    expect(qiniuChatUrl().slice('https://'.length)).not.toContain('//')
  })

  it('id 是纯小写 ASCII（provider-registry 的 id 约定）且 displayName 与客户端一致', () => {
    expect(QINIU.id).toBe('qiniu')
    expect(/^[a-z]+$/.test(QINIU.id), 'id 必须纯小写字母').toBe(true)
    // ⚠️ 客户端 `plugin-src/client/jet-hub.js` 的 PROVIDERS[qiniu].label 必须逐字相同，
    //    否则面板标题与对话里的 provider 名不一致（用户会以为装错了）。
    expect(QINIU.displayName).toBe('Qiniu (七牛云)')
  })

  it('凭据 ref 是 QINIU_ACCESS_TOKEN（与 jet-hub-store 的 REF 前缀表同口径）', () => {
    expect(QINIU.defaultCredentialRef).toBe('QINIU_ACCESS_TOKEN')
  })
})

describe('兜底模型表：远端实测快照（不写死，但要有保底）', () => {
  it('★ 表非空且规模与直连实测一致（2026-10-29 /v1/models 去重后 77 条）', () => {
    // ⚠️ 判据写成「恰好 77」是有意的：这条表的唯一合法性来自「它逐条抄自远端」。
    //    随手加/删一条而不重新抓取，说明有人在凭印象编 id —— 那正是官方 FAQ Q6
    //    禁止的形态（model 必须与模型广场的「API model 参数」逐字一致）。
    //    远端增减模型时：重跑 `curl https://api.qnaigc.com/v1/models` 重新生成，
    //    并把这里的数字一起改。
    expect(QINIU_FALLBACK_MODELS).toHaveLength(77)
    const ids = QINIU_FALLBACK_MODELS.map((m) => m.id)
    expect(new Set(ids).size, 'id 必须唯一（重复会让目录出现同名两项）').toBe(ids.length)
    expect(ids.some((id) => id.trim() !== id), 'id 不得带首尾空白').toBe(false)
  })

  it('★ 带厂商前缀的 id 必须原样保留（剥前缀 ⇒ 请求 400）', () => {
    const ids = QINIU_FALLBACK_MODELS.map((m) => m.id)
    // 这两条是实测存在且**必须带前缀**的形态；归一化会把它们打挂。
    expect(ids).toContain('moonshotai/kimi-k3')
    expect(ids).toContain('deepseek/deepseek-v4.1-flash')
    // 反向：表里不该出现「被剥掉厂商前缀」的孤儿形态（如只剩 `kimi-k3`）。
    expect(ids).not.toContain('kimi-k3')
  })

  it('★ 窗口逐条来自远端 context_length（含最小值 40000，不许被后续兜底改写）', () => {
    // 窗口 0 是「不知道」哨兵（`toCatalogEntry` 按 >0 才下发 `context`），
    // 本表实测没有 0（最小是 qwen3-30b-a3b / qwen3-32b 的 40_000），
    // 因此这里钉两端：最小值与最大值都必须是远端原值，不能被「看起来更合理」的数替换。
    const windows = QINIU_FALLBACK_MODELS.map((m) => m.contextWindow)
    expect(Math.min(...windows), '远端最小 context_length').toBe(40_000)
    expect(Math.max(...windows), '远端最大 context_length').toBe(1_048_576)
    const k3 = QINIU_FALLBACK_MODELS.find((m) => m.id === 'moonshotai/kimi-k3')
    expect(k3?.contextWindow, 'kimi-k3 远端 context_length=1048576').toBe(1_048_576)
    const v41 = QINIU_FALLBACK_MODELS.find((m) => m.id === 'deepseek/deepseek-v4.1-flash')
    expect(v41?.contextWindow, 'deepseek-v4.1-flash 远端=1000000').toBe(1_000_000)
  })

  it('★ 全表 supportsImage=false、不声明 efforts —— 「未实测」不是「支持」', () => {
    // 硬约定：目录里声明「支持图片」而实际不支持，模型会对图片**幻觉**出答案
    // （accio 那轮实测过）。七牛云 /v1/models 不下发 modalities ⇒ 一条都不能声明。
    expect(QINIU_FALLBACK_MODELS.every((m) => m.supportsImage === false)).toBe(true)
    expect(QINIU_FALLBACK_MODELS.every((m) => m.efforts === undefined)).toBe(true)
  })

  it('isKnownQiniuModel：表内 true、表外 false、空串 false', () => {
    expect(isKnownQiniuModel('moonshotai/kimi-k3')).toBe(true)
    expect(isKnownQiniuModel('glm-4.5')).toBe(true)
    // 表外（含被剥前缀的形态）：必须 false，否则「未知模型」的告警会失效。
    expect(isKnownQiniuModel('kimi-k3')).toBe(false)
    expect(isKnownQiniuModel('qiniu-not-a-real-model')).toBe(false)
    expect(isKnownQiniuModel('')).toBe(false)
  })
})

describe('classifyQiniuError：顺序即优先级', () => {
  it('★★ 上下文超限必须排在限流之前（否则超限会被封账号一整天）', () => {
    // 同时含「context length」与「rate limit」的报文：顺序错了就归 rate_limit。
    const info = classifyQiniuError(
      400,
      'maximum context length is 128000 tokens -- rate limit note',
    )
    expect(info.kind, '超限被误判成限流 ⇒ 账号会被写一个到次日零点的冷却标记').toBe('context_window')
    expect(info.retryAfterMs, 'context_window 不该产出冷却时长').toBeUndefined()
  })

  it('★ 402 / 额度关键词归 quota，且带上服务端的 retry-after', () => {
    const info = classifyQiniuError(402, '{"error":{"message":"资源包余额不足"}}', {
      'retry-after': '120',
    })
    expect(info.kind).toBe('quota')
    expect(info.retryAfterMs).toBe(120_000)
  })

  it('★ retry-after: 0 是合法值（立即解除），不得被 falsy 判据换成默认值', () => {
    const info = classifyQiniuError(429, 'too many requests', { 'retry-after': '0' })
    expect(info.kind).toBe('rate_limit')
    expect(info.retryAfterMs, '0 被吞掉 ⇒ 白等一小时（retry-after.ts 记录过该教训）').toBe(0)
  })

  it('传输层失败（status 0 / fetch failed）归 transport', () => {
    expect(classifyQiniuError(0, '').kind).toBe('transport')
    expect(classifyQiniuError(0, 'TypeError: fetch failed').kind).toBe('transport')
  })

  it('400/422 → invalid_request；401/403 → auth；>=500 → server', () => {
    expect(classifyQiniuError(400, 'invalid model id').kind).toBe('invalid_request')
    expect(classifyQiniuError(422, 'unprocessable').kind).toBe('invalid_request')
    expect(classifyQiniuError(401, '{"error":{"message":"Invalid API Key","type":"authentication_error"}}').kind)
      .toBe('auth')
    expect(classifyQiniuError(403, 'forbidden').kind).toBe('auth')
    expect(classifyQiniuError(500, 'internal').kind).toBe('server')
    expect(classifyQiniuError(503, 'unavailable').kind).toBe('server')
  })

  it('★ detail 是人可读文本，不得把整坨 JSON 抛给用户', () => {
    const info = classifyQiniuError(401, '{"error":{"message":"Invalid API Key"}}')
    expect(info.detail).toBe('Invalid API Key')
    expect(info.detail).not.toContain('{')
    // 非 JSON 体：截断但保留原文。
    const long = 'x'.repeat(900)
    expect(classifyQiniuError(500, long).detail.length).toBeLessThanOrEqual(501)
    // 空体：给一句可读兜底，而不是空串。
    expect(classifyQiniuError(500, '   ').detail.length).toBeGreaterThan(0)
  })
})

describe('qiniuHeaders：Accept 按用途区分', () => {
  it('对话默认 text/event-stream，列举模型传 application/json', () => {
    // ⚠️ 字面量刻意不带 `sk-` 形态：仓库的 repo-pii-guard 会把 `sk-` + 16 位以上判成
    //    泄漏密钥；qiniu 的 KEY_PATTERN 是 `[A-Za-z0-9_.-]{16,}`，本来就不要求前缀。
    expect(qiniuHeaders('qiniu-fakekey-abcdefghij').accept).toBe('text/event-stream')
    expect(qiniuHeaders('qiniu-fakekey-abcdefghij', 'application/json').accept).toBe('application/json')
    const headers = qiniuHeaders('qiniu-fakekey-abcdefghij')
    expect(headers.authorization).toBe('Bearer qiniu-fakekey-abcdefghij')
    expect(headers['content-type']).toBe('application/json')
  })
})
