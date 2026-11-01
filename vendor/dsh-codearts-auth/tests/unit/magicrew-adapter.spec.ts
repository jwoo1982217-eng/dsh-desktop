/**
 * magicrew-adapter.spec.ts —— Magicrew 适配器**推理面 + 目录门**单测（任务 4c / 4d / 4e / 4f）
 *
 * 被测源码：`src/magicrew-adapter.ts`（`stream` / `fetchChat` / `requestBody` /
 * `wireMessages` / `imageUrlsOf` / `refresh` / `loadModels` / `fetchModels`）
 * + `src/magicrew-catalog.ts`（目录 GET 超时）+ `src/magicrew-auth.ts` 的
 * `fetchCatalogModels`（适配器注入面）。
 *
 * ── 零网络 / 零真实凭据 ───────────────────────────────────────────────────
 * 全部注入 `fetchImpl`（假 fetch），`resolveCredential` 走内存常量；不打
 * `i-magic-service.letsmagic.cn`，不读凭据库。
 *
 * ── 每条用例对应的规格 ────────────────────────────────────────────────────
 * | # | 规格 |
 * |---|---|
 * | 1 | `max_tokens` 低于 512 ⇒ 抬到 512 |
 * | 2 | 合法档位（`none`）⇒ 发 `reasoning_effort` |
 * | 3 | 非法档位（`ultra`）⇒ **不发**该字段（上游对非法值回 HTTP 400） |
 * | 4 | HTTP 200 + application/json + `{code:403,message:'token无效'}` ⇒ `AUTH` |
 * | 5 | SSE 正常流 ⇒ block-start / reasoning-delta / text-delta / usage / block-end / finish 顺序 |
 * | 6 | 工具**请求侧**：`options.tools` ⇒ OpenAI 信封（`{type:'function',function:{…}}`） |
 * | 7 | 工具**响应侧**：`delta.tool_calls` 增量 ⇒ `tool-call-delta`（4c 完全没接线） |
 * | 8 | 图片：有 `readImage` ⇒ `{type:'image_url',image_url:{url:'data:…base64,…'}}` |
 * | 9 | 图片：**无** `readImage` ⇒ 抛 `INVALID_REQUEST`，且**一个请求都不发**（不降级） |
 * | 10 | `body.stream === true`（只流式） |
 * | 11 | `MagicrewAuth.fetchCatalogModels` 用注入 fake fetch 拉目录并归一 |
 * | 12 | 目录 TTL 门：20 分钟内 `listModels` / `resolveModel` 只发一次目录 GET |
 * | 13 | 并发去重：同一 tick 的两个入口只发一次目录 GET |
 * | 14 | **多轮工具往返**（≤0.1.6 包裹形状）：tool-call ⇒ `tool_calls`、tool-result ⇒ `role:'tool'` |
 * | 15 | **多轮工具往返**（DSH 0.1.7 一等 `role:'tool'` 形状）同样配对 |
 * | 16 | **孤儿工具结果**（无对应 tool-call）⇒ 整体剔除，不进 wire |
 * | 17 | `options.system` ⇒ 前置 system 消息（不静默丢系统提示） |
 * | 18 | **未提供 `maxTokens` ⇒ 不发 `max_tokens`**（实测 512 会截断正文） |
 * | 19 | `maxTokens: 2048` ⇒ 原样下发（不被压到下限） |
 * | 20 | `stream_options.include_usage === true`（不要 usage 上游就不回） |
 * | 21 | `{code:403,"organization-code 不匹配"}` ⇒ `INVALID_REQUEST` 且保留上游原文 |
 * | 22 | **等响应头**超过 `chatHeaderTimeoutMs` ⇒ `TIMEOUT` |
 * | 23 | **目录 GET** 超过 `requestTimeoutMs` ⇒ 回退静态表 |
 * | 24 | `refresh()` ⇒ 无视 TTL 强制重拉（后台刷新器不再空转） |
 * | 25 | 目录失败后退避 60s，越过后退避恢复，`refresh()` 可越过 |
 *
 * ⚠️ `Response` 的 body 只能读一次 ⇒ 假 fetch 收的是**工厂**，不是实例。
 * ⚠️ SSE 断言以 **`consumeOpenAiSse`（共享件）** 的输出为准，不是 4c 手写版的
 *    输出 —— 后者已删除（一文件两套同义判据是本仓库红线）。
 * ⚠️ 消息序列化同理：4d 手写的 `toWireMessages` / `toWirePart` 已删除，14–17 号用例
 *    打的是**共享件 `serializeMessages`** 的产物（见 `openai-compat.ts:186`）。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LlmError, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { MagicrewAdapter, type MagicrewAdapterOptions } from '../../src/magicrew-adapter.js'
import { MagicrewAuth, type MagicrewCredential } from '../../src/magicrew-auth.js'
import { MAGICREW, MAGICREW_MODELS_PATH } from '../../src/magicrew-product.js'

const CREDENTIAL: MagicrewCredential = {
  jwt: 'jwt-fixture',
  organizationCode: '',
  apiKey: 'mgw-fixture-key',
}

const OPTIONS = {
  provider: 'magicrew',
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
} as unknown as GenerateOptions

/**
 * 带一张图片块的请求。
 *
 * ⚠️ `ImageBlock` 的字段是 `attachment`（`ImageAttachmentRef`），**没有** `data` /
 * `mediaType` —— 字节只能经注入的 `readImage` 读（照抄旧签名字段会 `TS2339`）。
 */
const IMAGE_OPTIONS = {
  provider: 'magicrew',
  model: 'deepseek-v4.1-flash',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '这是什么' },
      { type: 'image', attachment: { attachmentId: 'att-1' } },
    ],
  }],
} as unknown as GenerateOptions

/** 假 fetch + 直接暴露调用记录（vitest 的 `vi.fn` 已带 `mock.calls`）。 */
type FetchStub = typeof fetch & { mock: { calls: unknown[][] } }

function fakeFetch(makeResponse: () => Response): FetchStub {
  return vi.fn(async () => makeResponse()) as unknown as FetchStub
}

/** 标准 SSE 假响应（`data: <line>` + 空行分隔，与上游逐字同形）。 */
function sseResponse(lines: string[]): Response {
  const body = lines.map((line) => `data: ${line}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function makeAdapter(
  fetchImpl: FetchStub,
  extra: Partial<Omit<MagicrewAdapterOptions, 'fetchImpl' | 'resolveCredential'>> = {},
): MagicrewAdapter {
  return new MagicrewAdapter({
    fetchImpl,
    resolveCredential: async () => CREDENTIAL,
    ...extra,
  })
}

async function collect(adapter: MagicrewAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

/** 取出第 `call` 次请求的 JSON 请求体。 */
function sentBody(fetchImpl: FetchStub, call = 0): Record<string, unknown> {
  const init = fetchImpl.mock.calls[call]?.[1] as { body?: string } | undefined
  return JSON.parse(init?.body ?? '{}') as Record<string, unknown>
}

describe('MagicrewAdapter.requestBody', () => {
  it('max_tokens 低于 512 时抬到 512（64 会被 reasoning 吃满、正文为空）', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    await collect(makeAdapter(fetchImpl), { ...OPTIONS, maxTokens: 64 } as GenerateOptions)

    expect(sentBody(fetchImpl).max_tokens).toBe(512)
  })

  // ── 未提供预算时**不许发**该字段（2026-10-29 真账号实测，任务 4f） ────────
  it('★ 未提供 maxTokens ⇒ body 里**没有** max_tokens 这个键（不是 512）', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    await collect(makeAdapter(fetchImpl), OPTIONS)

    const body = sentBody(fetchImpl)
    // ⚠️⚠️ 真账号实测（让模型从 1 数到 400）：**不发**该字段 → `stop` + 1491 字符（完整）；
    //    `max_tokens: 512` → `length` + 916 字符（被截断）。
    //    而 `toEntry` 不声明 `maxTokens` ⇒ 普通对话里 `options.maxTokens` 就是 `undefined`
    //    ⇒ 修前 `Math.max(undefined ?? 0, 512)` 让**每一轮**都被截断。
    expect('max_tokens' in body).toBe(false)
    expect(body.max_tokens).toBeUndefined()
  })

  it('★ maxTokens 2048 ⇒ 原样下发 2048（不被压到下限 512）', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    await collect(makeAdapter(fetchImpl), { ...OPTIONS, maxTokens: 2048 } as GenerateOptions)

    expect(sentBody(fetchImpl).max_tokens).toBe(2048)
  })

  it('★ 显式要 usage：body.stream_options.include_usage === true', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    await collect(makeAdapter(fetchImpl), OPTIONS)

    // ⚠️ 实测：不发这个字段时上游**不回** usage 帧（三格请求全程 `n/a`）
    //    ⇒ 上下文占用条与 token 记账同时失去唯一输入。
    expect(sentBody(fetchImpl).stream_options).toEqual({ include_usage: true })
  })

  it('合法档位 none ⇒ 发 reasoning_effort: "none"', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    await collect(makeAdapter(fetchImpl), {
      ...OPTIONS,
      reasoningEffort: ReasoningEffortId('none'),
    } as GenerateOptions)

    expect(sentBody(fetchImpl).reasoning_effort).toBe('none')
  })

  it('非法档位 ultra ⇒ 不发该字段（上游对非法值回 HTTP 400）', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    await collect(makeAdapter(fetchImpl), {
      ...OPTIONS,
      reasoningEffort: ReasoningEffortId('ultra'),
    } as GenerateOptions)

    const body = sentBody(fetchImpl)
    expect('reasoning_effort' in body).toBe(false)
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('只流式：body.stream 恒为 true', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    await collect(makeAdapter(fetchImpl), OPTIONS)

    expect(sentBody(fetchImpl).stream).toBe(true)
  })
})

describe('MagicrewAdapter.stream 成败判据（业务码）', () => {
  it('HTTP 200 + application/json + {code:403,message:"token无效"} ⇒ 抛 AUTH（不是静默成功）', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ code: 403, message: 'token无效' }))

    let caught: unknown
    try {
      await collect(makeAdapter(fetchImpl), OPTIONS)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('AUTH')
    // ⚠️ 文案本身就是出路：必须是「key 失效」，不能退化成「未收到内容」。
    expect((caught as LlmError).message).toContain('api_key')
  })

  it('非 SSE 且不是死 key ⇒ 归 SERVER（保住上游原文片段）', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ code: 500, message: 'upstream exploded' }))

    let caught: unknown
    try {
      await collect(makeAdapter(fetchImpl), OPTIONS)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('SERVER')
    expect((caught as LlmError).message).toContain('upstream exploded')
  })

  // ── 业务码必须被**读**，且组织/配置类不得落 SERVER（可重试）或 AUTH（吞文案）──
  it('★ {code:403, message:"organization-code 不匹配"} ⇒ INVALID_REQUEST 且**保留上游原文**', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ code: 403, message: 'organization-code 不匹配' }))

    let caught: unknown
    try {
      await collect(makeAdapter(fetchImpl), OPTIONS)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LlmError)
    // ⚠️⚠️ 两条都不能走：
    //    - `SERVER` ⇒ 宿主当可重试 ⇒ **白重试 5 次**（修前正是这一格）；
    //    - `AUTH` ⇒ 宿主会连 message 一起换成「API 密钥无效」
    //      ⇒ `organization-code 不匹配` 这句**唯一出路**消失，用户只会反复重新登录。
    expect((caught as LlmError).code).toBe('INVALID_REQUEST')
    expect((caught as LlmError).message).toContain('organization-code 不匹配')
    // 业务码本身也要出现在文案里（排障时区分 403/401 的唯一线索）。
    expect((caught as LlmError).message).toContain('403')
  })
})

/**
 * ── 超时：两段各自有上限（任务 4f） ──────────────────────────────────────
 *
 * 修前 `chatHeaderTimeoutMs` 只喂给了 `consumeOpenAiSse` 的 `firstTokenTimeoutMs`
 * （那是**拿到响应头之后**的首 token 空闲超时）⇒「等头」这一段没有任何超时；
 * 而 `product.requestTimeoutMs` 在 `src/` 里**零读者**（目录 GET 同样裸奔）。
 */
describe('MagicrewAdapter 超时', () => {
  /**
   * 永不返回、只在 `signal` abort 时 reject 的 fetch（用来量「等」的那一段）。
   *
   * ⚠️ 刻意 reject 一个**普通** `Error`（不是 `signal.reason`）：真实的 undici 在
   * abort 时抛的是 `AbortError`（generic），而**把 generic 错误翻译成 `TIMEOUT`**
   * 正是 `fetchChat` 的 `if (headerController.signal.aborted) throw reason` 那条腿。
   * 若替身直接 reject `signal.reason`，那条腿删掉也照样绿（**假绿**）。
   */
  function hangingFetch(): FetchStub {
    return vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal === undefined) {
        reject(new Error('本用例要求 fetch 收到 signal'))
        return
      }
      signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
    })) as unknown as FetchStub
  }

  it('★ 等响应头超过 chatHeaderTimeoutMs ⇒ TIMEOUT（不再只靠 undici 默认 ~300s）', async () => {
    const fetchImpl = hangingFetch()
    const adapter = makeAdapter(fetchImpl, {
      product: { ...MAGICREW, chatHeaderTimeoutMs: 10 },
    })

    let caught: unknown
    try {
      await collect(adapter, OPTIONS)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('TIMEOUT')
    // ⚠️ 文案必须指出「等的是响应头」：超时的**相位**不同，自救方式也不同
    //    （等头 = 上游排队 / 网关卡；等字节 = 推理太久）。
    expect((caught as LlmError).message).toContain('响应头')
  })

  it('★ 目录 GET 超过 requestTimeoutMs ⇒ 回退静态表（目录是每条消息的前置请求）', async () => {
    const counter = { catalog: 0 }
    const fetchImpl = vi.fn(async (input: unknown, init?: { signal?: AbortSignal }) => {
      if (String(input).endsWith(MAGICREW_MODELS_PATH)) {
        counter.catalog += 1
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal === undefined) {
            reject(new Error('本用例要求 fetch 收到 signal'))
            return
          }
          signal.addEventListener('abort', () => reject(signal.reason))
        })
      }
      return sseResponse(['[DONE]'])
    }) as unknown as FetchStub
    const adapter = makeAdapter(fetchImpl, {
      now: () => 1_000_000,
      warn: () => {},
      product: { ...MAGICREW, requestTimeoutMs: 10 },
    })

    const models = await adapter.listModels(MAGICREW.id)

    expect(counter.catalog).toBe(1)
    // ⚠️ 超时**不是致命错**：必须回退静态兜底表，否则整个 provider 会从列表里消失
    //    （与「无账号」同形，用户完全无从发现）。
    expect(models.length).toBeGreaterThan(0)
  })
})

/**
 * ── 目录：`refresh` 转发 + 失败负缓存（任务 4f） ──────────────────────────
 */
describe('MagicrewAdapter 目录刷新与失败退避', () => {
  /** 按 URL 分流；`catalog` 分支可指定回成功 JSON 或业务错误。 */
  function routedFetch(counter: { catalog: number }, ok = true): FetchStub {
    return vi.fn(async (input: unknown) => {
      if (String(input).endsWith(MAGICREW_MODELS_PATH)) {
        counter.catalog += 1
        if (!ok) return jsonResponse({ code: 500, message: 'catalog exploded' })
        return jsonResponse({
          code: 1000,
          data: { models: [{ value: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', vision: true }] },
        })
      }
      return sseResponse(['[DONE]'])
    }) as unknown as FetchStub
  }

  it('★ refresh() ⇒ 无视 20 分钟 TTL 强制重拉（后台刷新器不再空转）', async () => {
    const counter = { catalog: 0 }
    const fetchImpl = routedFetch(counter)
    const adapter = makeAdapter(fetchImpl, { now: () => 1_000_000 })

    await adapter.listModels(MAGICREW.id)
    expect(counter.catalog).toBe(1)
    // TTL 内：不得重拉。
    await adapter.listModels(MAGICREW.id)
    expect(counter.catalog).toBe(1)

    // ⚠️⚠️ 这一格就是缺陷本体：`refresh` 是 **catalog 实例**上的成员，
    //    给 `createModelCatalog` 的 config 传回调**不会**变成适配器的成员；
    //    而 `index.ts` 的刷新器调的是 `adapter.refresh?.()` ⇒ 不转发即**静默空转**
    //    （`model-catalog-parity.spec.ts:747` 会点名失败）。
    // ⚠️ 时钟**没有**前进：证明它无视 TTL，而不是「刚好过期了」。
    await adapter.refresh()
    expect(counter.catalog).toBe(2)
  })

  it('★ 目录失败后 60s 内不再重发（否则每条消息都多一次超时请求）', async () => {
    const counter = { catalog: 0 }
    const fetchImpl = routedFetch(counter, false)
    let now = 1_000_000
    const adapter = makeAdapter(fetchImpl, { now: () => now, warn: () => {} })

    await adapter.listModels(MAGICREW.id)
    expect(counter.catalog).toBe(1)

    // ⚠️ 修前：失败时 `catalogAt` 仍是 0 ⇒ 下面这一次（以及之后**每条消息**）
    //    都会再发一次目录 GET + 一条 warn —— 一次上游抖动污染整段对话。
    await adapter.listModels(MAGICREW.id)
    expect(counter.catalog).toBe(1)

    // 仍在退避窗口内（差 1ms）⇒ 依然不重发。
    now += MAGICREW.catalogRetryMs - 1
    await adapter.listModels(MAGICREW.id)
    expect(counter.catalog).toBe(1)

    // 越过退避 ⇒ 必须重试（否则它永远不再恢复远端目录）。
    now += 2
    await adapter.listModels(MAGICREW.id)
    expect(counter.catalog).toBe(2)

    // ⚠️ 强制刷新也必须越过退避（两个时间戳都清零），否则「点刷新没反应」。
    await adapter.refresh()
    expect(counter.catalog).toBe(3)
  })
})

describe('MagicrewAdapter.stream SSE（共享 consumeOpenAiSse）', () => {
  it('reasoning_content + content + usage + [DONE] ⇒ reasoning/text 两块各占一个 index，收尾各有 block-end', async () => {
    const fetchImpl = fakeFetch(() => sseResponse([
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '想' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '一下' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: '你好' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: '！' }, finish_reason: 'stop' }] }),
      // ⚠️ usage 帧通常 `choices: []`（上游末尾单独一帧）。
      JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
      '[DONE]',
    ]))

    const chunks = await collect(makeAdapter(fetchImpl), OPTIONS)

    // ⚠️ 顺序与**共享件**一致：正文块先收尾、思考块后收尾（`consumeOpenAiSse` 的
    //    toolOrder → text → reasoning 次序）。4c 的手写版**没有** block-end。
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'block-start',
      'reasoning-delta',
      'reasoning-delta',
      'block-start',
      'text-delta',
      'text-delta',
      'usage',
      'block-end',
      'block-end',
      'finish',
    ])

    // 两个块必须各占一个 index（reasoning=0 / text=1），否则上层会把思考当正文。
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks[3]).toEqual({ type: 'block-start', index: 1, blockType: 'text' })
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: '想' })
    expect(chunks[4]).toEqual({ type: 'text-delta', index: 1, text: '你好' })

    // ⚠️ `usage` 形状由共享件决定：**没有** `totalTokens`（它不发这个字段）。
    expect(chunks[6]).toEqual({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 },
    })
    // block-end 是**权威覆盖**：上游没发块内容时由收尾一次性给全。
    expect(chunks[7]).toEqual({ type: 'block-end', index: 1, block: { type: 'text', text: '你好！' } })
    expect(chunks[8]).toEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: '想一下' } })
    expect(chunks[9]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  // ── 工具：请求侧信封 + 响应侧增量（4c 两条都没接） ──────────────────────
  it('工具请求侧：options.tools ⇒ OpenAI 信封（type/function.name/function.parameters）', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    const parameters = { type: 'object', properties: { path: { type: 'string' } } }
    await collect(makeAdapter(fetchImpl), {
      ...OPTIONS,
      tools: [{ name: 'read_file', description: '读文件', parameters }],
    } as unknown as GenerateOptions)

    const body = sentBody(fetchImpl)
    const tools = body.tools as Array<Record<string, unknown>>
    expect(Array.isArray(tools)).toBe(true)
    expect(tools[0]).toEqual({
      type: 'function',
      function: { name: 'read_file', description: '读文件', parameters },
    })
    // ⚠️ **反向判据**：DSH 的 `ToolSchema` 是扁平 `{name,description,parameters}`，
    //    直接下发会让上游 400 / 模型永不调用。这里必须**没有**顶层 `name`。
    expect('name' in tools[0]!).toBe(false)
  })

  it('工具响应侧：delta.tool_calls 分片 ⇒ tool-call-delta（名字一次给全、参数增量拼接）', async () => {
    const fetchImpl = fakeFetch(() => sseResponse([
      JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: { name: 'read_file', arguments: '{"path":' },
            }],
          },
        }],
      }),
      JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] },
        }],
      }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ]))

    const chunks = await collect(makeAdapter(fetchImpl), {
      ...OPTIONS,
      tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object' } }],
    } as unknown as GenerateOptions)

    // 关键判据：4c 的手写 readSse **完全不认** `tool_calls` ⇒ 这里一个
    // `tool-call-delta` 都不会有，工具永远不执行（症状：模型「答应了但不做」）。
    const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
    expect(deltas.length).toBe(2)
    expect(deltas[0]).toMatchObject({
      type: 'tool-call-delta',
      index: 0,
      id: 'call_1',
      name: 'read_file',
      argumentsDelta: '{"path":',
    })
    expect(deltas[1]).toMatchObject({
      type: 'tool-call-delta',
      index: 0,
      name: 'read_file',
      argumentsDelta: '"a.txt"}',
    })

    // 收尾：block-end 带**拼好的**参数（`ToolCallBlock.arguments` 是 JSON **字符串**，
    // 由 harness 自己 parse —— 这里把它反序列化成对象就是第二套判据）+ finish 报 tool-calls。
    const end = chunks.find((chunk) => chunk.type === 'block-end')
    expect(end).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  // ── 图片：**宁报错，不降级** ────────────────────────────────────────────
  it('图片：注入 readImage ⇒ 真读字节并拼 data URL 的 image_url 块', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    const readImage = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }))
    await collect(makeAdapter(fetchImpl, { readImage }), IMAGE_OPTIONS)

    // 注入的回调必须收到**附件引用本身**（接线层按它去读字节），不是 id 字符串。
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(readImage.mock.calls[0]?.[0]).toEqual({ attachmentId: 'att-1' })

    const messages = sentBody(fetchImpl).messages as Array<{ role: string, content: unknown }>
    // ⚠️⚠️ **顺序由共享件决定：图在前、文本在后**（4e 调整，原期望是「文本在前」）。
    //    共享 `serializeMessages` 的 `flushToolImages`（`openai-compat.ts:219`）恒按
    //    `[...图, ...文本]` 拼 parts —— 理由记在 Issue IKLIFH：图片必须与提问**同一
    //    条** user 消息，且两种先后顺序上游都能看见（判定的是「同条」而不是顺序）。
    //    这与「文本块 + 图片块」的入参顺序**无关**，不是本适配器能决定的。
    expect(messages[0]?.content).toEqual([
      // ⚠️ 上游**唯一**接受的形态（`{type:'image'}` 与裸 base64 都会被拒）。
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      { type: 'text', text: '这是什么' },
    ])
    // ⚠️ 反向判据：图与提问必须在**同一条**消息里（拆成两条上游就「看不见」图，
    //    症状是 HTTP 200 + 正文正常 + 只有答案是「我看不到图片」）。
    expect(messages.length).toBe(1)
  })

  it('图片：未注入 readImage ⇒ 抛 INVALID_REQUEST 且**不发请求**（绝不静默降级）', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))

    let caught: unknown
    try {
      await collect(makeAdapter(fetchImpl), IMAGE_OPTIONS)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('INVALID_REQUEST')
    // 文案必须指出「缺读图入口」这条出路（不能退化成「图片已省略」）。
    expect((caught as LlmError).message).toContain('读图入口')
    // ⚠️ **零请求**才是「不降级」的硬判据：修前这里会带着占位文字照样发出去，
    //    模型于是「看不到却以为看到了」（幻觉），而上游 HTTP 200、零报错。
    expect(fetchImpl.mock.calls.length).toBe(0)
  })
})

/**
 * ── 多轮工具往返（任务 4e 的核心） ─────────────────────────────────────────
 *
 * 4d 的 `toWirePart` 把 `tool-call` / `tool-result` / `reasoning` 三种块**映射成
 * 空文本占位** ⇒ wire 上既没有 `tool_calls` 也没有 `role:'tool'` ⇒ 模型看不到
 * 自己上一步的工具输出。DSH 是 coding agent，工具往返是核心功能。
 *
 * 现改用共享 `serializeMessages`（自带 `normalizeHarnessMessages` +
 * `resolveToolPairing`）⇒ 下面三条用例就是 4d 之后**仍缺失的那两格**。
 */
describe('MagicrewAdapter 消息序列化（共享 serializeMessages）', () => {
  /**
   * ⚠️ 两种历史形状都必须覆盖：
   * - ≤0.1.6：工具结果是 user 消息里的 `{type:'tool-result'}` **包裹块**；
   * - 0.1.7+：工具结果是**一等 `role:'tool'` 消息**（当前 DSH 的真实形态）。
   * 只测前者的话，`normalizeHarnessMessages` 那条腿坏了也全绿。
   */
  const TOOL_CALL = {
    type: 'tool-call',
    id: 'call_1',
    name: 'read',
    arguments: '{"path":"a.txt"}',
  }

  it('≤0.1.6 包裹形状：assistant ⇒ tool_calls，tool-result ⇒ role:"tool"（工具结果不再丢）', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    await collect(makeAdapter(fetchImpl), {
      provider: 'magicrew',
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '读文件' }] },
        { role: 'assistant', content: [TOOL_CALL] },
        {
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'call_1',
            content: [{ type: 'text', text: '文件内容' }],
          }],
        },
      ],
    } as unknown as GenerateOptions)

    const messages = sentBody(fetchImpl).messages as Array<Record<string, unknown>>

    // ① assistant 那条必须带 `tool_calls`（4d 修前这里是空 content，工具记录整条消失）。
    const assistant = messages.find((message) => message.role === 'assistant')
    const toolCalls = assistant?.tool_calls as Array<Record<string, unknown>>
    expect(Array.isArray(toolCalls)).toBe(true)
    expect((toolCalls[0]?.function as Record<string, unknown>).name).toBe('read')
    // ⚠️ 正文为空且有 tool_calls 时 `content` 必须是 `null`（OpenAI 规范）。
    expect(assistant?.content).toBeNull()

    // ② 工具结果必须落成独立的 `role:'tool'` 消息，且 id 配得上（4d 修前**零条**）。
    const toolMessage = messages.find((message) => message.role === 'tool')
    expect(toolMessage).toBeDefined()
    expect(toolMessage?.tool_call_id).toBe('call_1')
    expect(String(toolMessage?.content)).toContain('文件内容')
  })

  it('DSH 0.1.7 一等 role:"tool" 形状：同样配成 tool_calls + role:"tool"', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    await collect(makeAdapter(fetchImpl), {
      provider: 'magicrew',
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '读文件' }] },
        { role: 'assistant', content: [TOOL_CALL] },
        // ⚠️ 0.1.7 的 `toolCallId` 在**消息顶层**，`content` 是任意块数组。
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '文件内容' }] },
      ],
    } as unknown as GenerateOptions)

    const messages = sentBody(fetchImpl).messages as Array<Record<string, unknown>>
    const toolCalls = messages.find((message) => message.role === 'assistant')?.tool_calls as
      Array<Record<string, unknown>>
    expect((toolCalls[0]?.function as Record<string, unknown>).name).toBe('read')

    const toolMessage = messages.find((message) => message.role === 'tool')
    expect(toolMessage?.tool_call_id).toBe('call_1')
    expect(String(toolMessage?.content)).toContain('文件内容')
  })

  it('孤儿工具结果（无对应 tool-call）⇒ 整条剔除，但配对的那些照样保留', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    await collect(makeAdapter(fetchImpl), {
      provider: 'magicrew',
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '读文件' }] },
        { role: 'assistant', content: [TOOL_CALL] },
        {
          role: 'user',
          // 配对完整：`call_1` 对得上上面的 assistant tool-call。
          content: [{
            type: 'tool-result',
            toolCallId: 'call_1',
            content: [{ type: 'text', text: '文件内容' }],
          }],
        },
        {
          role: 'user',
          // ⚠️ `call_9` 没有任何 assistant `tool_calls` 指向它 ⇒ 孤儿。
          content: [{
            type: 'tool-result',
            toolCallId: 'call_9',
            content: [{ type: 'text', text: '孤儿结果' }],
          }],
        },
      ],
    } as unknown as GenerateOptions)

    const messages = sentBody(fetchImpl).messages as Array<Record<string, unknown>>

    // 共享件的既有语义：不成对的 call 与 result **两侧都剔**——只剔一侧上游照样 400。
    expect(messages.filter((message) => message.role === 'tool').length).toBe(1)
    const toolCalls = messages.find((message) => message.role === 'assistant')?.tool_calls as
      Array<Record<string, unknown>>
    expect(toolCalls.length).toBe(1)
    expect(toolCalls[0]?.id).toBe('call_1')
    // ⚠️ 用**全量 JSON** 断言，防止孤儿文本换一种形态（占位 / 正文）漏过去。
    expect(JSON.stringify(messages)).not.toContain('孤儿结果')
    expect(JSON.stringify(messages)).not.toContain('call_9')
    // ⚠️ 正向腿：只留反向断言（「没有孤儿」）的话，把整段消息序列化成空文本的
    //    变异也照样全绿 —— 那正是 4d 的形态。必须同时钉住「配对的还在」。
    expect(JSON.stringify(messages)).toContain('文件内容')
  })

  it('options.system ⇒ 前置一条 system 消息（否则整段系统提示静默丢失）', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['[DONE]']))
    await collect(makeAdapter(fetchImpl), {
      ...OPTIONS,
      system: '你是测试助手',
    } as GenerateOptions)

    const messages = sentBody(fetchImpl).messages as Array<Record<string, unknown>>
    // ⚠️ `serializeMessages` 只吃 `messages`，`options.system` 是独立入参 ⇒
    //    这条腿是**本适配器自己**接的（与 cline / loomy / raccoon 同形）。
    expect(messages[0]).toEqual({ role: 'system', content: '你是测试助手' })
    expect(messages[1]?.role).toBe('user')
  })
})

describe('MagicrewAdapter.loadModels 新鲜度门', () => {
  const TWENTY_MINUTES = 20 * 60 * 1000

  /** 按 URL 分流：目录 GET 记数，其余（推理 POST）回 SSE。 */
  function routedFetch(counter: { catalog: number }): FetchStub {
    return vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith(MAGICREW_MODELS_PATH)) {
        counter.catalog += 1
        return jsonResponse({
          code: 1000,
          data: { models: [{ value: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', vision: true }] },
        })
      }
      return sseResponse(['[DONE]'])
    }) as unknown as FetchStub
  }

  it('20 分钟内 listModels / resolveModel 都只发一次目录 GET；过期后才重拉', async () => {
    const counter = { catalog: 0 }
    const fetchImpl = routedFetch(counter)
    let now = 1_000_000
    const adapter = makeAdapter(fetchImpl, { now: () => now })

    await adapter.listModels(MAGICREW.id)
    // ⚠️ 这条是缺陷本体：修前（无 TTL 门）`resolveModel` 每次都会多一次目录 GET，
    //    而 `prepareCall` → `resolveModel` 是**每条消息**都走的路。
    await adapter.resolveModel(MAGICREW.id, 'deepseek-v4.1-flash')
    expect(counter.catalog).toBe(1)

    // 仍在 TTL 内（差 1ms）⇒ 不得重拉。
    now += TWENTY_MINUTES - 1
    await adapter.listModels(MAGICREW.id)
    expect(counter.catalog).toBe(1)

    // 越过 TTL ⇒ 必须重拉。
    now += 2
    await adapter.listModels(MAGICREW.id)
    expect(counter.catalog).toBe(2)
  })

  it('并发去重：同一 tick 的两个入口只发一次目录 GET', async () => {
    const counter = { catalog: 0 }
    const fetchImpl = routedFetch(counter)
    const adapter = makeAdapter(fetchImpl, { now: () => 1_000_000 })

    await Promise.all([
      adapter.listModels(MAGICREW.id),
      adapter.resolveModel(MAGICREW.id, 'deepseek-v4.1-flash'),
    ])

    expect(counter.catalog).toBe(1)
  })
})

/**
 * `MagicrewAuth.fetchCatalogModels` —— 适配器 `fetchRemoteModels` 的注入面。
 *
 * ⚠️ 该用例放在本文件而不是 `magicrew-auth-pool.spec.ts`：任务 4d 的提交**只允许**
 * 动这三个文件，而该方法的存在理由**只有**一条 —— 给适配器注入远端目录。
 * 参数是显式 `(jwt, organizationCode)` ⇒ 完全不必碰凭据库（零真实凭据）。
 */
describe('MagicrewAuth.fetchCatalogModels（适配器注入面）', () => {
  it('用注入 fake fetch 拉目录并归一（含 label 前导空格 trim / vision 严格布尔）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1000,
      data: {
        models: [
          // ⚠️ 上游真实形态带**前导空格**（见 `magicrew-catalog.ts` 的注释）。
          { value: 'deepseek-v4.1-flash', label: ' DeepSeek V4.1 Flash ', vision: true },
          // ⚠️ `vision` 非严格布尔 ⇒ 必须判 `=== true`，宽松判会误报能力。
          { value: 'glm-5.3', label: 'GLM 5.3', vision: 'true' },
        ],
      },
    }))
    const auth = new MagicrewAuth(new Context(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const models = await auth.fetchCatalogModels('jwt-fixture', 'org-fixture')

    expect(models).toEqual([
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', vision: true },
      { id: 'glm-5.3', name: 'GLM 5.3', vision: false },
    ])

    // 端点与认证头（jwt 走 Bearer；`organization-code` 国际站强制）。
    const url = String(fetchImpl.mock.calls[0]?.[0])
    expect(url.endsWith(MAGICREW_MODELS_PATH)).toBe(true)
    const init = fetchImpl.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined
    expect(init?.headers?.authorization).toBe('Bearer jwt-fixture')
    expect(init?.headers?.['organization-code']).toBe('org-fixture')
  })

describe('magicrew 倍率与免费标记（I2）', () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  it('★ 有倍率 ⇒ name 拼「（0.1×）」；input_points=0 ⇒ isFree', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes(MAGICREW_MODELS_PATH)) {
        return jsonResponse({
          code: 1000,
          data: { models: [
            { value: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', vision: true },
            { value: 'free-model', label: 'Free Model', vision: false },
          ] },
        })
      }
      // 倍率端点：deepseek 200 points ⇒ 0.1×；free-model 0 ⇒ 免费
      return jsonResponse({
        code: 1000,
        data: [
          { model_id: 'deepseek-v4.1-flash', billing_type: 'TextTokens', input_points: 200 },
          { model_id: 'free-model', billing_type: 'TextTokens', input_points: 0 },
        ],
      })
    })
    const adapter = new MagicrewAdapter({
      resolveCredential: async () => ({ jwt: 'j.w.t', organizationCode: 'org1' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const entries = await adapter.listModels()
    const paid = entries.find((e) => e.id === 'deepseek-v4.1-flash')!
    const free = entries.find((e) => e.id === 'free-model')!

    // 倍率进 name（展示用），bareName 保持干净
    expect(paid.name).toBe('DeepSeek V4.1 Flash（0.1×）')
    // ⚠️ 不断言 `bareName`：它是 `resolveModel` 的内部回退字段，
    //    `listModels()` 的输出层不带它（断言它会是恒 undefined 的假红）。
    // ⚠️ `isFree` 在 `CatalogEntry` 上，经 **`resolveModel`** 暴露
    //    （`listModels()` 只回 `id`/`name`，其它 8 家同款）⇒ 用它断言。
    //    免费标记只认 `input_points === 0`，**不能**从 `rate === 0` 反推。
    // ⚠️ `isFree` 只从 **`listAllModels()`** 出来（`model-catalog.ts:527/746` 的条目带它；
    //    `listModels()` 只回 id/name）⇒ 用前者断言。
    const all = adapter.listAllModels()
    expect(all.find((m) => m.id === 'free-model')?.isFree).toBe(true)
    // 付费那条：`input_points` 有值但不是 0 ⇒ `isFree` 缺席（不是 false）
    expect(all.find((m) => m.id === 'deepseek-v4.1-flash')?.isFree).toBeUndefined()
    // 免费那条的 name 也拼了「（0×）」——倍率是 0，与「未知」不同
    expect(free.name).toBe('Free Model（0×）')
  })

  it('★ 倍率端点失败 ⇒ 目录照常、name 不拼倍率（不能让装饰性信息拖垮目录）', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes(MAGICREW_MODELS_PATH)) {
        return jsonResponse({
          code: 1000,
          data: { models: [{ value: 'm1', label: 'M One', vision: false }] },
        })
      }
      throw new Error('倍率端点炸了')
    })
    const adapter = new MagicrewAdapter({
      resolveCredential: async () => ({ jwt: 'j.w.t', organizationCode: 'org1' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const entries = await adapter.listModels()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('M One')
    expect(entries[0]?.isFree).toBeUndefined()
  })
})

})
