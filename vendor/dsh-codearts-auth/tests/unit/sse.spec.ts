import { LlmError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  classifyToolArguments,
  hasUsableToolName,
  isTruncatedArguments,
  normalizeToolArguments,
  readWithIdleTimeout,
  resolveToolPairing,
  TOOL_ARGS_INVALID_CODE,
  toolArgsInvalidFailure,
} from '../../src/sse.js'

/** 构造一个永不产出数据的流（模拟半开的 SSE 连接）。 */
function hangingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() { /* 永不 enqueue / close */ } })
}

/** 构造一个立即产出指定数据后结束的流。 */
function oneShotStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe('readWithIdleTimeout', () => {
  // 回归：后端掐断 SSE 连接后若对端既不发数据也不关连接（半开连接），
  // 裸 reader.read() 会永久挂起，generator 永不返回，harness 当前步骤
  // 既不出结果也不报错——web 端发送按钮置灰、后续"继续"指令无响应。
  it('rejects with a retryable TIMEOUT instead of hanging forever', async () => {
    const reader = hangingStream().getReader()
    const error = await readWithIdleTimeout(reader, 20, 'buddy').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('TIMEOUT')
    expect(String((error as LlmError).message)).toContain('buddy: sse chunk timeout')
  })

  it('labels the first-token phase distinctly from the chunk phase', async () => {
    const reader = hangingStream().getReader()
    const error = await readWithIdleTimeout(reader, 20, 'buddy', undefined, 'first-token')
      .catch((e: unknown) => e)
    expect(String((error as LlmError).message)).toContain('first-token timeout')
  })

  it('passes data through when the stream delivers promptly', async () => {
    const reader = oneShotStream(['hello', ' world']).getReader()
    const first = await readWithIdleTimeout(reader, 1_000, 'buddy')
    expect(first.done).toBe(false)
    expect(new TextDecoder().decode(first.value)).toBe('hello')
    const second = await readWithIdleTimeout(reader, 1_000, 'buddy')
    expect(second.done).toBe(false)
    expect(new TextDecoder().decode(second.value)).toBe(' world')
    expect((await readWithIdleTimeout(reader, 1_000, 'buddy')).done).toBe(true)
  })

  // 用户取消必须优先于超时：否则中断任务时会被误报成 TIMEOUT 并触发重试。
  it('surfaces user abort over the timeout', async () => {
    const controller = new AbortController()
    const reader = hangingStream().getReader()
    controller.abort(new Error('user cancelled'))
    const error = await readWithIdleTimeout(reader, 1_000, 'buddy', controller.signal)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('user cancelled')
  })
})

describe('isTruncatedArguments', () => {
  // 空串是**合法**的无参数调用，不是截断。
  it('treats an empty payload as a legitimate no-argument call', () => {
    expect(isTruncatedArguments('')).toBe(false)
    expect(isTruncatedArguments('   ')).toBe(false)
  })

  // 并行工具调用丢分片时剩下的路径中段/尾部——必须判定为截断以触发重试。
  it('detects argument fragments lost mid-stream', () => {
    expect(isTruncatedArguments('\\deveco-code-rust\\crates\\deveco')).toBe(true)
    expect(isTruncatedArguments('o-llm\\src\\provider\\buddy.rs"}')).toBe(true)
    expect(isTruncatedArguments('{"command": "ls -')).toBe(true)
  })

  it('accepts complete JSON payloads', () => {
    expect(isTruncatedArguments('{}')).toBe(false)
    expect(isTruncatedArguments('{"file_path":"a.rs"}')).toBe(false)
  })

  // 能解析但类型不对属于模型输出有误，交给 schema 校验回传，不应触发重试。
  it('does not flag parseable non-object payloads as truncated', () => {
    expect(isTruncatedArguments('null')).toBe(false)
    expect(isTruncatedArguments('[1,2]')).toBe(false)
    expect(isTruncatedArguments('42')).toBe(false)
  })
})

describe('resolveToolPairing', () => {
  // 回归（严重）：工具执行失败后结果从未写回，孤儿 tool_calls 随每次请求
  // 重放，导致后端对之后**每一条**用户消息都返回 400——整条会话报废。
  it('drops a tool call that never received a result', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'Grep', arguments: '' }] },
      { role: 'user', content: 'continue' },
    ])
    expect(keepCallIds.has('c1')).toBe(false)
    expect(keepResultIds.has('c1')).toBe(false)
  })

  it('drops the whole batch when only some calls got results', () => {
    const { keepCallIds } = resolveToolPairing([
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
      ] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] },
    ])
    expect(keepCallIds.has('c1')).toBe(false)
    expect(keepCallIds.has('c2')).toBe(false)
  })

  it('keeps a fully answered round-trip', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
      ] },
      { role: 'user', content: [
        { type: 'tool-result', toolCallId: 'c1', content: [] },
        { type: 'tool-result', toolCallId: 'c2', content: [] },
      ] },
    ])
    expect(keepCallIds.has('c1')).toBe(true)
    expect(keepCallIds.has('c2')).toBe(true)
    expect(keepResultIds.has('c1')).toBe(true)
    expect(keepResultIds.has('c2')).toBe(true)
  })

  // 孤儿结果（没有对应 tool_call）同样会让后端 400，必须剔除。
  it('drops a result whose tool call is missing', () => {
    const { keepResultIds } = resolveToolPairing([
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'ghost', content: [] }] },
    ])
    expect(keepResultIds.has('ghost')).toBe(false)
  })

  it('tolerates sessions without any tool traffic', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
    expect(keepCallIds.size).toBe(0)
    expect(keepResultIds.size).toBe(0)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 回归（真实缺陷，2026-09-23 用户报障）：**名称为空的 tool_call** 必须剔除。
  //
  // 根因链（全部有实测证据，见 `resolveToolPairing` 的注释与
  // `scripts/confirm-empty-tool-name.ts`）：
  //   ① qoder 偶发一个**完全没有 name 字段**的 tool-call 分片；
  //   ② 适配器早期把它落成 `name:''` 的块，harness 执行得到 `unknown tool ""`，
  //      并把这条坏块**持久化进会话历史**；
  //   ③ 用户切到 workbuddy 后，坏块被每次请求原样重放 →
  //      **HTTP 400 code 11133 model_param_invalid**，会话彻底报废。
  //
  // 实测最小复现（wire 上的 `function.name` → 结果）：
  //   `"read"` / `"unknown_tool"` → 200（上游**只校验非空，不校验存在性**）
  //   `""` / `null` / 缺失          → **400 code 11133**
  // ─────────────────────────────────────────────────────────────────────────
  it('drops a tool call whose name is an empty string', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'bad', name: '', arguments: '{}' },
      ] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'bad', content: [] }] },
    ])
    expect(keepCallIds.has('bad')).toBe(false)
    expect(keepResultIds.has('bad')).toBe(false)
  })

  it('drops a tool call whose name is missing or null', () => {
    const { keepCallIds } = resolveToolPairing([
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'a', arguments: '{}' },
        { type: 'tool-call', id: 'b', name: null, arguments: '{}' },
        { type: 'tool-call', id: 'c', name: '   ', arguments: '{}' },
      ] },
      { role: 'user', content: [
        { type: 'tool-result', toolCallId: 'a', content: [] },
        { type: 'tool-result', toolCallId: 'b', content: [] },
        { type: 'tool-result', toolCallId: 'c', content: [] },
      ] },
    ])
    expect([...keepCallIds]).toEqual([])
  })

  // 关键：一个坏块**不得连累**同批的合法调用 —— 实测线上形态正是
  // 「一个无名 call + 一个合法 pwsh」，若整批丢弃会白白损失一次有效调用。
  it('keeps usable calls in a batch that also contains an unnamed one', () => {
    const { keepCallIds, keepResultIds } = resolveToolPairing([
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'bad', name: '', arguments: '{}' },
        { type: 'tool-call', id: 'good', name: 'pwsh', arguments: '{"command":"ls"}' },
      ] },
      { role: 'user', content: [
        { type: 'tool-result', toolCallId: 'bad', content: [] },
        { type: 'tool-result', toolCallId: 'good', content: [] },
      ] },
    ])
    expect(keepCallIds.has('bad')).toBe(false)
    expect(keepCallIds.has('good')).toBe(true)
    expect(keepResultIds.has('bad')).toBe(false)
    expect(keepResultIds.has('good')).toBe(true)
  })
})

describe('hasUsableToolName', () => {
  // ⚠️ 这条判据**不能**写成 `String(name).length > 0`：`undefined` / `null`
  // 经 String() 会变成 `"undefined"` / `"null"` 这类**非空**字符串，
  // 于是「缺名字」被误判成「有名字」，原样发给上游照样 400。
  it('rejects every value that is not a non-empty string', () => {
    expect(hasUsableToolName('read')).toBe(true)
    expect(hasUsableToolName('')).toBe(false)
    expect(hasUsableToolName('   ')).toBe(false)
    expect(hasUsableToolName(undefined)).toBe(false)
    expect(hasUsableToolName(null)).toBe(false)
    expect(hasUsableToolName(42)).toBe(false)
    expect(hasUsableToolName({})).toBe(false)
  })
})

describe('normalizeToolArguments', () => {
  // 回归：无参数工具（如 list_dir）只下发一个空 arguments 分片，拼接结果
  // 为空串，harness 解析时报 `"arguments" must be an object` 并卡住会话。
  it('turns an empty argument payload into an empty object', () => {
    expect(normalizeToolArguments('')).toBe('{}')
    expect(normalizeToolArguments('   ')).toBe('{}')
  })

  // 回归：SSE 流被截断时只收到半截 JSON，同样必须归一化为 {}。
  it('turns truncated JSON into an empty object', () => {
    expect(normalizeToolArguments('{"command": "ls -')).toBe('{}')
    expect(normalizeToolArguments('{"a":')).toBe('{}')
  })

  it('rejects non-object JSON payloads', () => {
    expect(normalizeToolArguments('null')).toBe('{}')
    expect(normalizeToolArguments('[1, 2]')).toBe('{}')
    expect(normalizeToolArguments('42')).toBe('{}')
    expect(normalizeToolArguments('"a string"')).toBe('{}')
  })

  // 关键区分：不可解析的残缺 JSON 不能被 normalizeToolArguments 当成"空参数"
  // 补成 {}——那会伪造合法外观，掩盖真正的分片丢失。它由 isTruncatedArguments
  // 单独识别，交由 max-tokens 触发重试。
  it('leaves truncated JSON for the truncation detector rather than faking {}', () => {
    const truncated = '\\deveco-code-rust\\crates\\deveco'
    expect(normalizeToolArguments(truncated)).toBe('{}')
    // 因此必须由截断检测器单独判定，不能只看归一化结果。
    expect(isTruncatedArguments(truncated)).toBe(true)
  })

  it('preserves well-formed object arguments verbatim', () => {
    expect(normalizeToolArguments('{"command": "ls -la"}')).toBe('{"command": "ls -la"}')
    expect(normalizeToolArguments('{}')).toBe('{}')
    // 嵌套对象与数组值都应保留。
    expect(normalizeToolArguments('{"files": ["a.ts", "b.ts"], "opts": {"depth": 2}}'))
      .toBe('{"files": ["a.ts", "b.ts"], "opts": {"depth": 2}}')
  })
})

/**
 * 工具参数的**三态**分类（Gitee IKQ8Y1）。
 *
 * ## 真实缺陷
 *
 * `isTruncatedArguments` 只做 `JSON.parse`，把**两种完全不同的病理**混成一个
 * `true`：流被掐断（参数半截）与模型语法写坏（结构闭合但非法）。四个适配器
 * 都把它并进 `max-tokens` ⇒ DSH 客户端那句**固定 i18n**「已达到输出 token 上限」
 * 把真实病因吞掉（实测受害轮次 `outputTokens` 只用了 2516/128000）。
 *
 * ## ⚠️ 本组用例的坏样本是**逐字真实报文**
 *
 * 采自会话 `session-e2199832` / `session-b61246db`（跨 2 天、两个不同工作区、
 * 同一工具 `compress`、同一失败字符位）：`content` 漏了开引号、正文是裸文本
 * 且含真实换行 ⇒ `JSON.parse` 在第 13 个字符失败，而末尾 `}` 配平、引号成对。
 * **不要**为了好写而换成人工构造的样本 —— 那条判据正是从「结构闭合」推导出来的。
 */
describe('classifyToolArguments（三态：ok / truncated / invalid）', () => {
  /**
   * 真实坏样本（Gitee IKQ8Y1，逐字；含真实换行）。
   *
   * `{"content": 【m00055–m00067 · 撰写 vibe coding 指南与技能库查询】` —— `content`
   * 的值**没有开引号**，正文是裸文本。
   */
  const REAL_BAD =
    '{"content": 【m00055–m00067 · 撰写 vibe coding 指南与技能库查询】\n'
    + '- memory_procedure_list 查询「vibe coding 研究 检索 报告」→ 技能库无匹配（共 8 条）。\n'
    + '- 用 write 写出 `C:\\Users\\<user>\\Desktop\\dsh默认\\vibecoding-实践指南.md`…待用户决定。}'

  it('★ 真实坏样本判 invalid（不是 truncated）', () => {
    // 先自证样本确实是「结构闭合但非法」——否则下面的断言是恒真的。
    expect(() => JSON.parse(REAL_BAD)).toThrow()
    expect(REAL_BAD.trim().endsWith('}')).toBe(true)
    expect(classifyToolArguments(REAL_BAD)).toBe('invalid')
  })

  it('同一内容的合法版本判 ok', () => {
    expect(classifyToolArguments(JSON.stringify({ content: 'abc\ndef' }))).toBe('ok')
    expect(classifyToolArguments('{"command":"ls -la"}')).toBe('ok')
    expect(classifyToolArguments('{}')).toBe('ok')
  })

  it('空串判 ok（无参数工具只下发空分片，这是合法的）', () => {
    expect(classifyToolArguments('')).toBe('ok')
    expect(classifyToolArguments('   ')).toBe('ok')
    // 与既有 `isTruncatedArguments` 的语义对齐（它也对空串返回 false）。
    expect(isTruncatedArguments('')).toBe(false)
  })

  it('★ 从合法 JSON 的**任意位置**切断都判 truncated（分片丢失不得被误判成 invalid）', () => {
    // 这是 issue 验收标准第 4 条的反向守卫：`session-23851745` 那种
    // 「并行下发丢分片、只剩路径中段与尾部」必须仍判 truncated。
    const full = '{"a":"b\\"c","d":["e",1,{"f":true}],"g":null}'
    const classes = new Set<string>()
    for (let i = 1; i < full.length; i += 1) {
      const kind = classifyToolArguments(full.slice(0, i))
      classes.add(kind)
      // 任何前缀都不得被定罪成「模型写坏了」——那会给出错误的处置建议。
      expect(kind, `前缀长度 ${i}: ${JSON.stringify(full.slice(0, i))}`).not.toBe('invalid')
    }
    // 且**确实**覆盖到 truncated 这一格（防「全部返回 ok」这种假绿）。
    expect(classes.has('truncated')).toBe(true)
  })

  it('★ 分片丢失的真实形态（只剩路径中段与尾部）判 truncated', () => {
    // 采自 `sse.ts` 注释记录的 session-23851745：两个并行 `read` 都丢了
    // `{"file_path": "…` 前缀。
    expect(classifyToolArguments('om/Desktop/x.md"}')).toBe('truncated')
    expect(classifyToolArguments('\\deveco-code-rust\\crates\\deveco')).toBe('truncated')
  })

  it('末尾仍有 } 但引号奇数 ⇒ fail-safe 判 truncated（不给错误的定罪）', () => {
    // 模型写坏但**没**以 `}` 收尾（多打一个引号）时无法与「截在字符串中间」
    // 区分 ⇒ 宁可继续报 max-tokens。这是 issue 里明确要求的 fail-safe 方向。
    expect(classifyToolArguments('{"a":"b}')).toBe('truncated')
  })

  it('括号深度转负 ⇒ 前面缺了开括号 ⇒ truncated', () => {
    expect(classifyToolArguments('a"}')).toBe('truncated')
    expect(classifyToolArguments('1]}')).toBe('truncated')
  })

  it('两个对象相连 {...}{...} ⇒ invalid（结构各自闭合，但整体非法）', () => {
    // 这是 `openai-compat.ts` 记录过的真实形态：DSML 与上游下标撞车导致
    // 参数被 `+=` 拼成两段相连的非法 JSON。判 invalid 而非 truncated 是**刻意的**：
    // 它不是「被掐断」，重跑一次的形态大概率为同一份坏输出。
    expect(classifyToolArguments('{"a":1}{"b":2}')).toBe('invalid')
  })

  it('字符串里含未转义换行 ⇒ invalid（模型把正文直接塞进字符串）', () => {
    expect(classifyToolArguments('{"a":"line1\nline2"}')).toBe('invalid')
  })

  it('转义处理：`\\"` 与 `\\\\` 不得翻转字符串状态（否则括号统计错位）', () => {
    // 合法样本：一个「转义引号」+ 一个「转义反斜杠」，都能正常解析 ⇒ ok。
    expect(classifyToolArguments('{"a":"b\\"c"}')).toBe('ok')
    expect(classifyToolArguments('{"a":"b\\\\"}')).toBe('ok')
    // 坏样本：括号在字符串**外**不配平 —— 若转义腿写错（把 `\"` 当成字符串
    // 边界），统计会错位而给出 ok/truncated 的反向结论。
    expect(classifyToolArguments('{"a":"b\\"c"}')).toBe('ok')
    expect(classifyToolArguments('{"a":"\\"}{')).toBe('truncated')
  })
})

/**
 * 「工具参数不是合法 JSON」的错误码与文案（Gitee IKQ8Y1）。
 *
 * ⚠️ 判据必须打在**文案与码的字面约定**上：DSH 客户端对除
 * `AUTH` / `QUOTA` / `ACCOUNT_QUOTA` 外的码**原样透传 message**，故 message
 * 是「把真实原因送到用户眼前」的唯一通道。
 */
describe('toolArgsInvalidFailure', () => {
  it('★ 码必须是 TOOL_ARGS_INVALID（不是 max-tokens）', () => {
    const failure = toolArgsInvalidFailure([{ name: 'compress', chars: 4757 }])
    expect(failure.code).toBe(TOOL_ARGS_INVALID_CODE)
    expect(failure.code).not.toBe('max-tokens')
  })

  it('★ 文案必须含工具名与字符数，且显式否认「token 上限」与「网络中断」', () => {
    const failure = toolArgsInvalidFailure([{ name: 'compress', chars: 4757 }])
    expect(failure.message).toContain('compress')
    expect(failure.message).toContain('4757')
    // 「不是输出 token 上限」这句是**要害**：用户最可能的错误猜想有两条，
    // 一条来自 DSH 那句固定 i18n，一条来自常见的断流误判。
    expect(failure.message).toContain('不是输出 token 上限')
    expect(failure.message).toContain('不是网络中断')
    // ⚠️ 错误 message 是**纯文本**渲染：Markdown 强调符会原样显示成星号。
    expect(failure.message).not.toContain('**')
  })

  it('★ 文案**不得**出现「回答被截断」（那是 max-tokens 的固定 i18n 措辞）', () => {
    const failure = toolArgsInvalidFailure([{ name: 'compress', chars: 10 }])
    // issue 验收标准第 2 条：message 不含「回答被截断」字样。
    expect(failure.message).not.toContain('回答被截断')
    expect(failure.message).not.toContain('已达到输出 token 上限')
  })

  it('未命名工具回退成可读占位，不写 (undefined)', () => {
    const failure = toolArgsInvalidFailure([{ name: undefined, chars: 3 }])
    expect(failure.message).toContain('(未命名工具)')
    // 「String(undefined)」是本仓库记录过的真实缺陷形态之一。
    expect(failure.message).not.toContain('undefined')
  })

  it('多个坏块只列前 3 个并给总数（避免把提示刷成一面墙）', () => {
    const blocks = Array.from({ length: 5 }, (_, i) => ({ name: `tool${i}`, chars: i }))
    const failure = toolArgsInvalidFailure(blocks)
    expect(failure.message).toContain('tool0')
    expect(failure.message).toContain('tool2')
    expect(failure.message).not.toContain('tool3')
    expect(failure.message).toContain('5 个调用')
  })
})
