/**
 * Qiniu 适配器的**行为**守卫（模型目录 / 解析 / 轮换 / 错误码 / 风控闸门）。
 *
 * ## 每条判据各自打一种「实测过、无守卫时全绿」的缺陷
 *
 * ① 无槽位 ⇒ 抛 `MISSING_CREDENTIAL`（不是空结果，否则 provider 分组静默消失且无提示）；
 * ② 窗口未知 ⇒ **不下发** `context`（0 会让自动压缩抛 TargetPressureConfigError）；
 * ③ 模态未知 ⇒ `['text']`（未知当支持会让模型对图片幻觉出答案）；
 * ④ 上下文超限 ⇒ **不换号、不写冷却标记**（否则用户只是消息太长却被封账号一整天）；
 * ⑤ 额度错必须用字面量 `QUOTA_EXCEEDED`（harness 的 `'QUOTA'` 会吞掉 message）；
 * ⑥ HTTP 200 + `text/html` 风控页 ⇒ 报 `SERVER`（否则退化成「额度用尽」，排障方向全错）；
 * ⑦ abort ⇒ 立刻抛（否则取消后仍继续换号发请求、最后报「额度用尽」）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { QiniuAdapter, classifyQiniuFailure, qiniuRetryAfterMs } from '../../src/qiniu-adapter.js'
import { QINIU } from '../../src/qiniu-product.js'

const KEY = 'qiniu-testkey-0123456789abcdef'

/** 把若干 SSE 文本行做成一个 ReadableStream（模拟上游响应体）。 */
function sseStream(rows: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const row of rows) controller.enqueue(enc.encode(row))
      controller.close()
    },
  })
}

const okSse = () => new Response(sseStream([
  'data: {"choices":[{"delta":{"content":"你好"}}]}\n',
  'data: [DONE]\n',
]), { status: 200, headers: { 'content-type': 'text/event-stream' } })

const drain = async (iterator: AsyncIterable<unknown>) => {
  const out: unknown[] = []
  for await (const chunk of iterator) out.push(chunk)
  return out
}

afterEach(() => { vi.unstubAllGlobals() })

describe('无槽位：诚实的 MISSING_CREDENTIAL', () => {
  it('★ 没有可用账号 ⇒ 抛 MISSING_CREDENTIAL，而不是空结果', async () => {
    const adapter = new QiniuAdapter({ slots: async () => [], product: QINIU } as never)
    let code: string | undefined
    try {
      await drain(adapter.stream({ model: 'deepseek-v3', messages: [{ role: 'user', content: 'hi' }] } as never))
    } catch (error) { code = (error as { code?: string }).code }
    expect(code, '空结果会让 provider 分组静默消失，用户不知道要加账号').toBe('MISSING_CREDENTIAL')
  })
})

describe('resolveModel / listModels：能力声明的诚实性', () => {
  it('★ 窗口未知（0 哨兵）⇒ 不下发 context（否则自动压缩阈值算不出来）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}', { status: 200 })))
    const adapter = new QiniuAdapter({
      slots: async () => [{ id: 'a1', apiKey: KEY }],
      product: QINIU,
    } as never)
    const resolved = await adapter.resolveModel('qiniu', 'deepseek-v3')
    expect(resolved.id).toBe('deepseek-v3')
    expect(resolved.context, '0 当合法窗口 ⇒ TargetPressureConfigError（压缩阈值必须正整数）').toBeUndefined()
    expect(resolved.inputModalities).toEqual(['text'])
    // ⚠️ 档位为空时**不声明** reasoning（声明空数组会让 UI 出现没有档位的空选择器）。
    expect(resolved.reasoning).toBeUndefined()
    // ⚠️ 不下发 defaultMaxTokens：那等于我们替用户决定每轮按上限请求。
    expect(resolved.defaultMaxTokens).toBeUndefined()
  })

  it('★ model id 原样透传（不剥厂商前缀、不改大小写）', async () => {
    const adapter = new QiniuAdapter({ slots: async () => [], product: QINIU } as never)
    const resolved = await adapter.resolveModel('qiniu', '  moonshotai/kimi-k3  ')
    expect(resolved.id, '剥掉前缀 ⇒ 上游 404 model not found').toBe('moonshotai/kimi-k3')
  })

  it('★ model id 原样透传（下划线/大写样本：对抗审计 M4 归一化变异的补牙）', async () => {
    // ⚠️ 对抗审计实测：既有样本（moonshotai/kimi-k3、deepseek-v3）都不含 `_`
    // 与大写，归一化变异（`replace(/_/g,'-')` + toLowerCase）后 69 条全绿。
    // 上游 FAQ Q6 要求 model 与模型广场「API model 参数」**逐字**一致，
    // 含 `_` 或大写的真实 id（如 `Qwen/Qwen2.5-72B-Instruct` 形态）一旦被
    // 归一就 404 —— 故用含两类的样本断言上行请求里的 model 逐字节相等。
    let sentModel: string | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sentModel = String(JSON.parse(String(init?.body)).model)
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    }))
    const adapter = new QiniuAdapter({ slots: async () => [{ id: 'a1', apiKey: KEY }], product: QINIU } as never)
    await drain(adapter.stream({ model: 'Qwen/Qwen2.5_72B-Instruct', messages: [{ role: 'user', content: 'hi' }] } as never))
    expect(sentModel, '归一化回流上行 ⇒ 上游 404（FAQ Q6 逐字一致要求）').toBe('Qwen/Qwen2.5_72B-Instruct')
    vi.unstubAllGlobals()
  })

  it('★ 没有可用账号时 listModels 返回空（provider 分组隐藏，不是报错）', async () => {
    const adapter = new QiniuAdapter({ slots: async () => [], product: QINIU } as never)
    await expect(adapter.listModels('qiniu')).resolves.toEqual([])
  })

  it('listAllModels 必须**同步**返回数组（写成 async 会让消费者抛 all is not iterable）', () => {
    const adapter = new QiniuAdapter({ slots: async () => [], product: QINIU } as never)
    const all = adapter.listAllModels()
    expect(Array.isArray(all), '返回 Promise ⇒ TypeError: all is not iterable（minimax 的同款真实缺陷）')
      .toBe(true)
  })
})

describe('stream：错误分派与错误码', () => {
  const makeAdapter = (opts: Record<string, unknown> = {}) => new QiniuAdapter({
    slots: async () => [{ id: 'a1', apiKey: KEY }],
    product: QINIU,
    warn: () => {},
    ...opts,
  } as never)

  it('★ 上下文超限：不换号、不写冷却标记，直接把原文抛出', async () => {
    const markLimited = vi.fn(async () => {})
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return new Response('this model maximum context length is 8192 tokens', { status: 400 })
    }))
    const adapter = makeAdapter({ markLimited })
    let message = ''
    let code: string | undefined
    try {
      await drain(adapter.stream({ model: 'deepseek-v3', messages: [{ role: 'user', content: 'hi' }] } as never))
    } catch (error) {
      message = (error as Error).message
      code = (error as { code?: string }).code
    }
    expect(markLimited, '超限写冷却标记 ⇒ 用户只是消息太长却被封账号一整天').not.toHaveBeenCalled()
    expect(calls, '超限换号无意义（请求本身太大），白发一次请求').toBe(1)
    expect(message.length).toBeGreaterThan(0)
    // ⚠️⚠️ 错误码也必须是 CONTEXT_WINDOW_EXCEEDED（2026-10-29 审计 P2）：
    //    七牛云超限回 **HTTP 400**，若落进 httpErrorCode(400) 就是 INVALID_REQUEST，
    //    而宿主 context-overflow 监听器第一行就是「code !== CONTEXT_WINDOW_EXCEEDED_CODE
    //    就 return next()」⇒ **自动压缩永不触发**，用户只看到「请求无效」。
    //    判据只断言 message 时这里恒绿（这正是本缺陷原先全绿的形态）。
    expect(code, '不是 CONTEXT_WINDOW_EXCEEDED ⇒ harness 压缩重试不跑，唯一有效动作被掩盖')
      .toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
  })

  it('★★ 额度错误必须用字面量 QUOTA_EXCEEDED（harness 的 QUOTA 会吞掉 message）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"资源包余额不足"}}', { status: 402 })))
    const adapter = makeAdapter()
    let code: string | undefined
    try {
      await drain(adapter.stream({ model: 'deepseek-v3', messages: [{ role: 'user', content: 'hi' }] } as never))
    } catch (error) { code = (error as { code?: string }).code }
    expect(code, "client 会把 'QUOTA' 换成通用文案、丢掉真实原因").toBe('QUOTA_EXCEEDED')
  })

  it('★ 429 限流：写冷却标记（用服务端 retry-after）后换下一个号', async () => {
    const markLimited = vi.fn(async () => {})
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => {
      seen.push('call')
      return new Response('too many requests', { status: 429, headers: { 'retry-after': '7' } })
    }))
    const adapter = makeAdapter({
      markLimited,
      slots: async () => [{ id: 'a1', apiKey: KEY }, { id: 'a2', apiKey: 'qiniu-otherkey-0000000000' }],
    })
    let code: string | undefined
    let message = ''
    try {
      await drain(adapter.stream({ model: 'deepseek-v3', messages: [{ role: 'user', content: 'hi' }] } as never))
    } catch (error) {
      code = (error as { code?: string }).code
      message = (error as Error).message
    }
    // ⚠️ 全池都被标记后由轮换循环**收口**：它不是把最后一个号的 429 透传，
    //    而是明确告知「所有账号对该模型均受限」（与其余 15 家同语义）。
    //    故这里断言的是**收口语义**，不是最后一发的 RATE_LIMIT。
    expect(markLimited, '每个号都要留下冷却标记，否则下一轮还会撞同两个号').toHaveBeenCalledTimes(2)
    expect(code, '全池耗尽的收口语义').toBe('QUOTA_EXCEEDED')
    expect(message).toContain('均受限')
    const [slotId, modelId, resetAtMs] = markLimited.mock.calls[0] as unknown as [string, string, number]
    expect(slotId).toBe('a1')
    expect(modelId).toBe('deepseek-v3')
    expect(resetAtMs - Date.now(), 'retry-after: 7 应换算成约 7000ms').toBeGreaterThan(6_000)
    expect(seen.length, '两个号都应被尝试').toBe(2)
  })

  it('★ 认证失败：换号但**不写**冷却标记，全试完透传原错误（码 AUTH）', async () => {
    const markLimited = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 })))
    const adapter = makeAdapter({
      markLimited,
      slots: async () => [{ id: 'a1', apiKey: KEY }, { id: 'a2', apiKey: 'qiniu-otherkey-0000000000' }],
    })
    let code: string | undefined
    try {
      await drain(adapter.stream({ model: 'deepseek-v3', messages: [{ role: 'user', content: 'hi' }] } as never))
    } catch (error) { code = (error as { code?: string }).code }
    expect(code, '认证失败不是额度问题').toBe('AUTH')
    expect(markLimited, '认证失败写冷却标记 ⇒ 一个请求就能把整池账号标记掉（2026-10-06 事故形态）')
      .not.toHaveBeenCalled()
  })

  it('★ invalid_request（400 形状问题）：**不换号**，直接抛 BAD_REQUEST', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return new Response('{"error":{"message":"invalid_parameter_error"}}', { status: 400 })
    }))
    const adapter = makeAdapter({
      slots: async () => [{ id: 'a1', apiKey: KEY }, { id: 'a2', apiKey: 'qiniu-otherkey-0000000000' }],
    })
    let code: string | undefined
    try {
      await drain(adapter.stream({ model: 'deepseek-v3', messages: [{ role: 'user', content: 'hi' }] } as never))
    } catch (error) { code = (error as { code?: string }).code }
    expect(code).toBe('BAD_REQUEST')
    expect(calls, '形状问题与账号无关，换号只会白打整池').toBe(1)
  })

  it('★★ HTTP 200 + text/html 风控页 ⇒ 报 SERVER（不得退化成「额度用尽」）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>blocked</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })))
    const adapter = makeAdapter()
    let code: string | undefined
    let message = ''
    try {
      await drain(adapter.stream({ model: 'deepseek-v3', messages: [{ role: 'user', content: 'hi' }] } as never))
    } catch (error) {
      code = (error as { code?: string }).code
      message = (error as Error).message
    }
    expect(code, `风控页被当成「额度用尽」⇒ 排障方向全错：${message}`).toBe('SERVER')
    expect(message).toContain('text/html')
  })

  it('★ 正常 SSE：产出正文内容块', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okSse()))
    const adapter = makeAdapter()
    const chunks = await drain(adapter.stream({
      model: 'deepseek-v3',
      messages: [{ role: 'user', content: 'hi' }],
    } as never))
    const text = (chunks as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    expect(text).toBe('你好')
  })

  it('★ 取消：abort 立刻抛，不继续换号发请求', async () => {
    const controller = new AbortController()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      controller.abort()
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    }))
    const adapter = makeAdapter({
      slots: async () => [{ id: 'a1', apiKey: KEY }, { id: 'a2', apiKey: 'qiniu-otherkey-0000000000' }],
    })
    let code: string | undefined
    try {
      await drain(adapter.stream({
        model: 'deepseek-v3',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      } as never))
    } catch (error) { code = (error as { code?: string }).code }
    expect(code, '取消被吞成「额度用尽」是 2026-10-17 审计 P2 的原始形态').not.toBe('QUOTA_EXCEEDED')
    expect(calls, '取消后仍换号再发 ⇒ 多打空请求').toBe(1)
  })
})

describe('resolveImageUrls：不支持图片时抛错而不是静默丢弃', () => {
  it('★ 模型未声明支持图片 ⇒ 抛 UNSUPPORTED_CONTENT', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}', { status: 200 })))
    const adapter = new QiniuAdapter({
      slots: async () => [{ id: 'a1', apiKey: KEY }],
      product: QINIU,
    } as never)
    let code: string | undefined
    try {
      await drain(adapter.stream({
        model: 'deepseek-v3',
        // ⚠️ 形态必须是 `attachment.attachmentId`（`collectImages` 只认这个形状）。
        messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }] }],
      } as never))
    } catch (error) { code = (error as { code?: string }).code }
    expect(code, '静默丢弃 ⇒ 用户以为模型看到了图（Qoder 图片事故）').toBe('UNSUPPORTED_CONTENT')
  })
})

describe('冷却时长换算', () => {
  it('★ 有 retry-after 就用它（0 是合法值，不得被 falsy 判据换成一小时）', () => {
    expect(qiniuRetryAfterMs('rate_limit', 0, 1, 1_000)).toBe(0)
    expect(qiniuRetryAfterMs('rate_limit', 5_000, 1, 1_000)).toBe(5_000)
    // 服务端再狠也不让单次阻塞超过 30 分钟。
    expect(qiniuRetryAfterMs('rate_limit', 99 * 60_000, 1, 0)).toBe(30 * 60_000)
  })

  it('★ 额度按 UTC+8 次日零点算（不是固定 24h：23:50 撞墙会被白等到次日 23:50）', () => {
    const now = Date.UTC(2026, 9, 29, 15, 50) // UTC 15:50 = UTC+8 23:50
    const ms = qiniuRetryAfterMs('quota', undefined, 1, now)
    expect(ms).toBe(10 * 60_000)
  })

  it('★ 其余按指数退避（60s → 120s → …，封顶 30 分钟）', () => {
    expect(qiniuRetryAfterMs('rate_limit', undefined, 1, 0)).toBe(60_000)
    expect(qiniuRetryAfterMs('rate_limit', undefined, 2, 0)).toBe(120_000)
    expect(qiniuRetryAfterMs('rate_limit', undefined, 99, 0)).toBe(30 * 60_000)
  })
})

describe('classifyQiniuFailure：从 LlmError 还原分类', () => {
  it('★ 读 failure.status 与 failure.providerRetryAfterMs（不是 error 自身的属性）', () => {
    const error = Object.assign(new Error('qiniu: HTTP 429 — too many requests'), {
      failure: { status: 429, providerRetryAfterMs: 590_000 },
    })
    const info = classifyQiniuFailure(error)
    expect(info.kind).toBe('rate_limit')
    expect(info.retryAfterMs, '读不到 providerRetryAfterMs ⇒ 白等多倍时间（opencode 实测 60000 vs 590000）')
      .toBe(590_000)
  })

  it('无 failure 字段时按 message 分类（且不抛）', () => {
    expect(classifyQiniuFailure(new Error('fetch failed')).kind).toBe('transport')
    // 非 Error 输入：按 `String(error)` 取文本，且 status 缺省 0 ⇒ transport。
    expect(classifyQiniuFailure('纯字符串').kind).toBe('transport')
  })
})
