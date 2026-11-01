/**
 * `TOOL_ARGS_INVALID` 在**四条接入点**上的行为级守卫（Gitee IKQ8Y1）。
 *
 * ## ⚠️⚠️ 为什么必须有本文件（对抗审计实测的 P0）
 *
 * 第一版把新判据的四条门禁在**四个适配器里各写了一遍**，而测试只写在
 * `sse.spec.ts`（纯函数）与 `buddy-adapter.spec.ts`（buddy 一家）。审计用
 * **逐处删除**的变异验证打穿了这一点：
 *
 * | 变异 | 仓库自带测试 |
 * |---|---|
 * | 删掉 `openai-compat` 的新分支 | **10896 passed / 0 failed** |
 * | 删掉 `trae` 的新分支 | **573 passed / 0 failed** |
 * | 删掉 `lobsterai` 的新分支 | **573 passed / 0 failed** |
 *
 * ⇒ 三处接入点**零守卫**。其中 `openai-compat` 是**共享链路**（被多家 provider
 * 复用），覆盖面最宽，却一条适配器级用例都没有 —— 这是最该补的一条。
 *
 * 本文件对三条链路各锁**同一组基线**（与 `buddy-adapter.spec.ts` 那组逐格同构）：
 * 坏 JSON ⇒ `TOOL_ARGS_INVALID`；合法 ⇒ `tool-calls`；真截断 ⇒ `max-tokens`；
 * 有正文 ⇒ `max-tokens`；另有可用调用 ⇒ `max-tokens`；`finish=length` ⇒ `max-tokens`。
 *
 * ⚠️ 三条链路的 entry 形状不同（`consumeOpenAiSse` 是导出函数；trae / lobsterai
 * 走各自的 Adapter 类），故分三个 describe 各自构造，**不硬凑一个通用夹具** ——
 * 硬凑会让某一家的门禁在夹具里被绕过而用例仍是绿的。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { consumeOpenAiSse } from '../../src/openai-compat.js'
import { TraeAdapter } from '../../src/trae-adapter.js'
import { LobsteraiAdapter } from '../../src/lobsterai-adapter.js'
import { DEFAULT_MODEL, BuddyAdapter } from '../../src/buddy-adapter.js'
import { TOOL_ARGS_INVALID_CODE } from '../../src/sse.js'

/**
 * 逐字真实坏样本（Gitee IKQ8Y1；`content` 漏开引号、正文裸文本含真实换行）。
 * 与 `sse.spec.ts` / `buddy-adapter.spec.ts` 用的是**同一份**，故意不各写一遍。
 */
const REAL_BAD_ARGS =
  '{"content": 【m00055–m00067 · 撰写 vibe coding 指南与技能库查询】\n'
  + '- memory_procedure_list 查询「vibe coding 研究 检索 报告」→ 技能库无匹配（共 8 条）。\n'
  + '- 用 write 写出 `C:\\Users\\<user>\\Desktop\\dsh默认\\vibecoding-实践指南.md`…待用户决定。}'

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200 })
}

/** 从一次流里取 finish 结果；抛 `LlmError` 时折算成同形状。 */
async function finishOf(chunks: AsyncIterable<unknown>): Promise<Record<string, any>> {
  const out: Array<Record<string, any>> = []
  try {
    for await (const chunk of chunks) out.push(chunk as Record<string, any>)
  } catch (error) {
    const llm = error as LlmError
    return { kind: 'error', failure: { code: llm.code, message: llm.message } }
  }
  const finish = out.find(chunk => chunk.type === 'finish')
  expect(finish, '本步必须产出 finish 事件').toBeDefined()
  return finish!.reason as Record<string, any>
}

/**
 * 三条基线的**共同断言**（每条链路都必须逐格同结论）。
 *
 * ⚠️ 用一个函数而不是三处复制：这正是本文件要守的东西 ——
 * 「同一语义 N 套实现必然漂移」。
 */
function expectBaseline(cases: {
  badArgs: Record<string, any>
  legal: Record<string, any>
  truncated: Record<string, any>
  withProse: Record<string, any>
  withUsableCall: Record<string, any>
  withEmptyObjectArgs: Record<string, any>
  finishedByLength: Record<string, any>
}): void {
  // ① 坏 JSON（结构闭合但非法）+ 零正文 + 无可用调用 ⇒ 独立错误码
  expect(cases.badArgs.kind, '坏 JSON 应报 error').toBe('error')
  expect(cases.badArgs.failure.code).toBe(TOOL_ARGS_INVALID_CODE)
  expect(cases.badArgs.failure.message).toContain('compress')
  expect(cases.badArgs.failure.message).not.toContain('已达到输出 token 上限')
  // ② 合法 JSON ⇒ tool-calls（不回归）
  expect(cases.legal.kind).toBe('tool-calls')
  // ③ 真截断（分片丢失）⇒ max-tokens（不得被新码抢走）
  expect(cases.truncated.kind).toBe('max-tokens')
  // ④ 有正文 ⇒ max-tokens（保住内容，error 路径不落 assistant/message）
  expect(cases.withProse.kind).toBe('max-tokens')
  // ⑤ 另有参数可解析的可用调用 ⇒ max-tokens（不一起作废）
  expect(cases.withUsableCall.kind).toBe('max-tokens')
  // ⑥ 另一调用的参数是**空对象 `{}`** ⇒ 也算可用调用 ⇒ max-tokens。
  //
  // ⚠️⚠️ 本格是**对抗审计实测的 P1**（第一版漏了它）：`isUsableToolArguments`
  // 曾用 `normalizeToolArguments(raw) !== '{}'` 比字面量，而后者对合法对象返回
  // **trim 后的原文** ⇒ `'{}'` 被判「不可用」而 `'{ }'` 判「可用」（语义相同、
  // 结论相反 ⇒ 自证比错对象）。后果：坏块 + 一个参数为 `{}` 的合法无参调用
  // 会报 **`TOOL_ARGS_INVALID`**（不在可重试集合 ⇒ 硬失败），而本该报
  // max-tokens 保住那个调用。`{}` 是无参工具最常见的形态，触发面不小。
  expect(cases.withEmptyObjectArgs.kind, '空对象参数的调用也是可用调用').toBe('max-tokens')
  // ⑦ finish=length ⇒ max-tokens（上游已宣告截断，新码必须让位）
  expect(cases.finishedByLength.kind).toBe('max-tokens')
}

/* ─────────────────────────── openai-compat（共享链路）─────────────────────────── */

describe('TOOL_ARGS_INVALID · openai-compat（共享链路，覆盖面最宽）', () => {
  const frame = (delta: unknown, finish: string | null = null): string =>
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`
  const tool = (name: string, args: string, index = 0): string =>
    frame({ tool_calls: [{ index, id: `call_${index}`, function: { name, arguments: args } }] })

  async function consume(chunks: readonly string[]): Promise<Record<string, any>> {
    return finishOf(consumeOpenAiSse(
      sseResponse(chunks),
      {},
      { label: 'test', maxTokens: 128_000 } as never,
    ))
  }

  it('★ 六条基线逐格同结论（删掉本链路的新分支会让本用例变红）', async () => {
    expectBaseline({
      badArgs: await consume([tool('compress', REAL_BAD_ARGS), frame({}, 'tool_calls'), 'data: [DONE]\n\n']),
      legal: await consume([tool('compress', '{"content":"x"}'), frame({}, 'tool_calls'), 'data: [DONE]\n\n']),
      truncated: await consume([tool('read', '{"file_path": "C:\\a\\'), frame({}, 'tool_calls'), 'data: [DONE]\n\n']),
      withProse: await consume([frame({ content: '正文' }), tool('compress', REAL_BAD_ARGS), frame({}, 'tool_calls'), 'data: [DONE]\n\n']),
      withUsableCall: await consume([
        tool('compress', REAL_BAD_ARGS, 0),
        tool('read', '{"file_path":"a.md"}', 1),
        frame({}, 'tool_calls'), 'data: [DONE]\n\n',
      ]),
      // ⚠️ 空对象参数（无参工具最常见形态）⇒ 也是可用调用 ⇒ 应报 max-tokens。
      // 本格是对抗审计实测的 P1 补丁：判据曾把 `{}` 误判「不可用」（详见
      // `sse.ts` 的 `isUsableToolArguments` 注释）。
      withEmptyObjectArgs: await consume([
        tool('compress', REAL_BAD_ARGS, 0),
        tool('list_dir', '{}', 1),
        frame({}, 'tool_calls'), 'data: [DONE]\n\n',
      ]),
      finishedByLength: await consume([tool('compress', REAL_BAD_ARGS), frame({}, 'length'), 'data: [DONE]\n\n']),
    })
  })

  it('★ 断流（无 finish_reason 也无 [DONE]）⇒ max-tokens 而非 TOOL_ARGS_INVALID', async () => {
    // 断流时参数坏更可能是分片丢失；报「模型语法写坏」会是错误归因。
    const reason = await consume([tool('compress', REAL_BAD_ARGS)])
    expect(reason.kind).toBe('max-tokens')
  })

  it('★ ok 语义污染：参数为 123 的另一调用不得算「可用」（否则退化成 tool-calls）', async () => {
    const reason = await consume([
      tool('compress', REAL_BAD_ARGS, 0),
      tool('read', '123', 1),
      frame({}, 'tool_calls'), 'data: [DONE]\n\n',
    ])
    // `123` 是合法 JSON 但不是可执行参数包 ⇒ 仍应报 TOOL_ARGS_INVALID。
    expect(reason.kind).toBe('error')
    expect(reason.failure.code).toBe(TOOL_ARGS_INVALID_CODE)
  })
})

/* ─────────────────────────────── TRAE ─────────────────────────────── */

describe('TOOL_ARGS_INVALID · trae', () => {
  const CREDENTIAL_REF = credentialRef('TRAE_JWT')

  /**
   * TRAE 的 wire 是 **SSE 事件帧**（`event: <name>` + `data: <json>`），不是 OpenAI
   * 的 `choices` 结构 —— 见 `src/trae.ts` 的 `parseTraeSSELine`：
   * `output`（带 `response` / `tool_calls`）/ `done`（带 `finish_reason`）/ `error`。
   * ⚠️ 第一版本用例写成「一行一个 JSON 对象」，整条链路一个事件都解析不出来，
   * 用例以 `finish` 缺失的方式假红 —— 夹具写错时**必须先怀疑夹具**。
   */
  const frame = (event: string, data: unknown): string =>
    `event: ${event}
data: ${JSON.stringify(data)}

`
  // ⚠️ `index` 必须可区分：固定写 0 会让「坏块 + 另一可用调用」被合并成**同一个**
  // 块（参数被拼接成 `}{…`）⇒ 变成「单块坏参数」，测的就不是「另有可用调用」那格了。
  const tool = (name: string, args: string, index = 0): string => frame('output', {
    tool_calls: [{ index, id: `call_${index}`, function: { name, arguments: args } }],
  })
  const finish = (reason: string): string => frame('done', { finish_reason: reason })
  const text = (value: string): string => frame('output', { response: value })

  async function consume(chunks: readonly string[]): Promise<Record<string, any>> {
    const adapter = new TraeAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => ({
        access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000), uid: 'u',
        machine_id: 'MID', device_id: 'DID',
      }) as never,
      refresh: async () => {},
      // ⚠️ TRAE 的 `stream()` 开头会 `await this.ensureRemoteModels()`（要按目录决定
      // 走哪个通道）；不注入就会真的发一次网络请求 ⇒ 用例变成随机真值。
      // 空目录即可：本组只测 finish 归类，与通道选择无关。
      fetchRemoteModels: async () => [],
      fetchImpl: async () => sseResponse(chunks),
    } as never)
    return finishOf(adapter.stream({
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never))
  }

  it('★ 六条基线逐格同结论（删掉本链路的新分支会让本用例变红）', async () => {
    expectBaseline({
      badArgs: await consume([tool('compress', REAL_BAD_ARGS), finish('tool_calls')]),
      legal: await consume([tool('compress', '{"content":"x"}'), finish('tool_calls')]),
      truncated: await consume([tool('read', '{"file_path": "C:\\a\\'), finish('tool_calls')]),
      withProse: await consume([text('正文'), tool('compress', REAL_BAD_ARGS), finish('tool_calls')]),
      withUsableCall: await consume([
        tool('compress', REAL_BAD_ARGS, 0), tool('read', '{"file_path":"a.md"}', 1), finish('tool_calls'),
      ]),
      // ⚠️ 空对象参数（无参工具最常见形态）⇒ 也是可用调用 ⇒ 应报 max-tokens。
      // 本格是对抗审计实测的 P1 补丁：判据曾把 `{}` 误判「不可用」（详见
      // `sse.ts` 的 `isUsableToolArguments` 注释）。
      withEmptyObjectArgs: await consume([
        tool('compress', REAL_BAD_ARGS, 0),
        tool('list_dir', '{}', 1),
        finish('tool_calls'),
      ]),
      finishedByLength: await consume([tool('compress', REAL_BAD_ARGS), finish('length')]),
    })
  })
})

/* ───────────────────────────── LobsterAI ───────────────────────────── */

describe('TOOL_ARGS_INVALID · lobsterai', () => {
  const CREDENTIAL_REF = credentialRef('LOBSTERAI_ACCESS_TOKEN')
  const frame = (delta: unknown, finish: string | null = null): string =>
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`
  const tool = (name: string, args: string, index = 0): string =>
    frame({ tool_calls: [{ index, id: `call_${index}`, function: { name, arguments: args } }] })

  async function consume(chunks: readonly string[]): Promise<Record<string, any>> {
    const adapter = new LobsteraiAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => ({
        access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
      }) as never,
      refresh: async () => {},
      fetchImpl: async () => sseResponse(chunks),
      product: undefined,
    } as never)
    return finishOf(adapter.stream({
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never))
  }

  it('★ 六条基线逐格同结论（删掉本链路的新分支会让本用例变红）', async () => {
    expectBaseline({
      badArgs: await consume([tool('compress', REAL_BAD_ARGS), frame({}, 'tool_calls'), 'data: [DONE]\n\n']),
      legal: await consume([tool('compress', '{"content":"x"}'), frame({}, 'tool_calls'), 'data: [DONE]\n\n']),
      truncated: await consume([tool('read', '{"file_path": "C:\\a\\'), frame({}, 'tool_calls'), 'data: [DONE]\n\n']),
      withProse: await consume([frame({ content: '正文' }), tool('compress', REAL_BAD_ARGS), frame({}, 'tool_calls'), 'data: [DONE]\n\n']),
      withUsableCall: await consume([
        tool('compress', REAL_BAD_ARGS, 0),
        tool('read', '{"file_path":"a.md"}', 1),
        frame({}, 'tool_calls'), 'data: [DONE]\n\n',
      ]),
      // ⚠️ 空对象参数（无参工具最常见形态）⇒ 也是可用调用 ⇒ 应报 max-tokens。
      // 本格是对抗审计实测的 P1 补丁：判据曾把 `{}` 误判「不可用」（详见
      // `sse.ts` 的 `isUsableToolArguments` 注释）。
      withEmptyObjectArgs: await consume([
        tool('compress', REAL_BAD_ARGS, 0),
        tool('list_dir', '{}', 1),
        frame({}, 'tool_calls'), 'data: [DONE]\n\n',
      ]),
      finishedByLength: await consume([tool('compress', REAL_BAD_ARGS), frame({}, 'length'), 'data: [DONE]\n\n']),
    })
  })
})

/* ───────────────────────────── buddy（既有组已覆盖，此处只锁 length）───────────────────────────── */

describe('TOOL_ARGS_INVALID · buddy 的 length/断流让位', () => {
  const CREDENTIAL_REF = credentialRef('BUDDY_ACCESS_TOKEN')
  const frame = (delta: unknown, finish: string | null = null): string =>
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`
  const tool = (name: string, args: string): string =>
    frame({ tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: args } }] })

  async function consume(chunks: readonly string[]): Promise<Record<string, any>> {
    const adapter = new BuddyAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => ({
        access_token: 'AT', refresh_token: 'RT', expires_at: String(Date.now() + 7_200_000),
        token_type: 'Bearer', scope: '', domain: 'copilot.tencent.com',
      }) as never,
      refresh: async () => {},
      fetchImpl: async () => sseResponse(chunks),
    } as never)
    return finishOf(adapter.stream({
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }] as never,
      signal: new AbortController().signal,
    } as never))
  }

  it('★ 坏 JSON + finish=length ⇒ max-tokens（上游已宣告截断，新码必须让位）', async () => {
    // ⚠️ 这条是审计打穿的真回归：第一版报出了 TOOL_ARGS_INVALID，
    // 而 issue 原文明确要求「真烧满额度时不该被新码抢走」。
    const reason = await consume([tool('compress', REAL_BAD_ARGS), frame({}, 'length')])
    expect(reason.kind).toBe('max-tokens')
  })

  it('★ 坏 JSON + 断流 ⇒ max-tokens（更可能是分片丢失，不该给模型定罪）', async () => {
    const reason = await consume([tool('compress', REAL_BAD_ARGS)])
    expect(reason.kind).toBe('max-tokens')
  })
})
