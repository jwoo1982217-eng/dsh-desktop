/**
 * OpenCode V2 chat 请求：内置工具集 + 官方形态提示词 + 客户端工具双向别名。
 * 上游把内置工具集（名字 + 参数 schema）当形状门禁的一部分；描述会被替换成
 * 「禁止调用」，不参与判定。客户端工具（包括 read/shell/edit/write）全部走
 * `dsh_` 别名隔离，参数、调用 ID、正文与结果不改写。
 *
 * ## ⚠️⚠️ 2026-10-26：system 必须带「官方形态提示词」（真机实测）
 *
 * 改前本文件的 system 只是把 DSH 自己的提示词原样塞成第一条消息。配上
 * Bun 传输层指纹之后逐格对照（同一份 TLS 参数、同一套头、同一个出口）：
 *
 * | system 内容 | 结果 |
 * |---|---|
 * | 官方提示词（含 `<env>` 块）+ DSH system | **200** |
 * | 只有 DSH system（改前形态） | **429 `FreeUsageLimitError`** |
 * | 官方提示词但截掉前半 | **429** |
 * | 官方提示词只留尾部 `<env>` 块 | **200** |
 *
 * ⇒ 门禁要三样**同时**成立：Bun 的 TLS 指纹、提示词里有 `<env>`
 * （至少 `Working directory`）、tools 含整套内置工具（其中 `read` 是必需项）。
 * 模板与渲染在 `opencode-official-prompt.ts`；**DSH 自己的提示词仍原样保留在
 * 官方提示词之后**（不改写、不删除，`mergeSystemWithOfficialPrompt`）。
 */
import { mergeSystemWithOfficialPrompt, renderOpencodeOfficialPrompt } from './opencode-official-prompt.js'
import { officialBuiltinTools } from './opencode-official-tools.js'

export interface OpencodeHarnessTool {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

export interface OpencodeWireTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }
}

/** 只做 DSH → OpenAI 格式转换，别名统一在请求边界分配。 */
export function buildOpencodeTools(tools: readonly OpencodeHarnessTool[] | undefined): OpencodeWireTool[] {
  return (tools ?? []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description.length > 0 ? { description: tool.description } : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    },
  }))
}

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : undefined
}

function renameCall(value: unknown, names: ReadonlyMap<string, string>): unknown {
  const call = record(value)
  const fn = record(call?.function)
  const alias = typeof fn?.name === 'string' ? names.get(fn.name) : undefined
  return alias === undefined ? value : { ...call, function: { ...fn, name: alias } }
}

function renameChoice(value: unknown, names: ReadonlyMap<string, string>): unknown {
  const choice = record(renameCall(value, names))
  if (!Array.isArray(choice?.tools)) return choice ?? value
  return {
    ...choice,
    tools: choice.tools.map((tool: unknown) => {
      const next = record(renameCall(tool, names))
      const alias = typeof next?.name === 'string' ? names.get(next.name) : undefined
      return alias === undefined ? next ?? tool : { ...next, name: alias }
    }),
  }
}

function renameMessage(value: unknown, names: ReadonlyMap<string, string>): unknown {
  const message = record(value)
  if (message === undefined) return value
  let next = message
  if (Array.isArray(message.tool_calls)) {
    next = { ...next, tool_calls: message.tool_calls.map((call: unknown) => renameCall(call, names)) }
  }
  const fn = record(message.function_call)
  const alias = typeof fn?.name === 'string' ? names.get(fn.name) : undefined
  if (alias !== undefined) next = { ...next, function_call: { ...fn, name: alias } }
  if (message.role === 'function' && typeof message.name === 'string' && names.has(message.name)) {
    next = { ...next, name: names.get(message.name) }
  }
  return next
}

export interface OpencodeRequestShape {
  payload: RecordValue
  /** 上游别名 → DSH 原名，仅存在于本次请求，绝不写入会话。 */
  toolAliases: ReadonlyMap<string, string>
  toolsDisabled: boolean
}

/**
 * 客户端工具的上游别名前缀。
 *
 * ⚠️ **唯一定义处**：响应层的剔除判据要用它区分「我们自己的产物」（`dsh_` 开头 ⇒
 * 别名表或历史重命名可能有缺陷）与「模型幻觉的名字」—— 两处各写一份字面量
 * 会在改前缀时静默漂移（本仓库已登记「一文件两套同义判据」这条判据）。
 */
export const ALIAS_PREFIX = 'dsh_'

/** 不修改调用者对象；每个请求仅调用一次，响应层必须使用返回的同一份映射。 */
function adaptPayload(payload: RecordValue): OpencodeRequestShape {
  const toolsDisabled = payload.tool_choice === 'none' || !Array.isArray(payload.tools) || payload.tools.length === 0
  const tools: OpencodeWireTool[] = toolsDisabled ? [] : (payload.tools as unknown[]).filter((tool): tool is OpencodeWireTool => {
    const fn = record(record(tool)?.function)
    return typeof fn?.name === 'string' && fn.name.length > 0
  })
  const present = new Set(tools.map((tool) => tool.function.name))
  const names = new Map<string, string>()
  for (const tool of tools) {
    const name = tool.function.name
    if (names.has(name)) continue
    const base = `${ALIAS_PREFIX}${name.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 60)
    let alias = base
    let suffix = 1
    while (present.has(alias)) {
      const tail = `_${suffix++}`
      alias = `${base.slice(0, 64 - tail.length)}${tail}`
    }
    present.add(alias)
    names.set(name, alias)
  }
  const clientTools = tools.map((tool) => ({
    ...tool,
    function: {
      ...tool.function,
      name: names.get(tool.function.name)!,
      description: `Client tool "${tool.function.name}"; use "${names.get(tool.function.name)}" for the client's "${tool.function.name}" operation. ${tool.function.description ?? ''}`,
    },
  }))
  const body = {
    ...payload,
    tools: [...clientTools, ...officialBuiltinTools()],
    stream: true,
    stream_options: { include_usage: true },
  } as RecordValue
  // ⚠️ 实测（2026-10-15，匿名通道 big-pickle/mimo/longcat）：V2 **接受**显式
  // `tool_choice:none`（HTTP 200），但后端**不执行**它 —— 同一句「读取 /tmp/a.txt」
  // 在 `tool_choice:none` 下照样产出 `read` 调用。故「不发 none」不是为了过门禁
  // （门禁只看 body 里 tools 的形状），而是因为发了也没有约束力、徒增一处分歧；
  // 禁用与保留工具的隔离**必须**由响应层逐调用强制（见 `opencode-stream.ts`）。
  if (toolsDisabled || payload.tool_choice == null) delete body.tool_choice
  else body.tool_choice = renameChoice(payload.tool_choice, names)
  if (names.size > 0 && Array.isArray(payload.messages)) {
    body.messages = payload.messages.map((message: unknown) => renameMessage(message, names))
  }
  return { payload: body, toolAliases: new Map([...names].map(([name, alias]) => [alias, name])), toolsDisabled }
}

/** 兼容既有纯 payload 调用；生产链路用 buildOpencodeRequest 同时取回响应映射。 */
export function ensureFreeLaneShape(payload: RecordValue): RecordValue {
  return Array.isArray(payload.messages) ? adaptPayload(payload).payload : payload
}

export interface OpencodePayloadInput {
  model: string
  messages: ReadonlyArray<RecordValue>
  system?: string
  tools?: readonly OpencodeHarnessTool[]
  temperature?: number
  maxTokens?: number
  reasoningEffort?: string
}

export function buildOpencodeRequest(input: OpencodePayloadInput): OpencodeRequestShape {
  return adaptPayload({
    model: input.model,
    // chat 协议没有顶层 system；**恒发**一条 system，且第一条消息必须是它
    // （⚠️ 实测：官方提示词在但不在首位 ⇒ 429）。内容 = 官方形态提示词 + DSH 自己的提示，
    // 两者用空行拼接；DSH 的提示**原样保留**，见 `opencode-official-prompt.ts`。
    messages: [
      { role: 'system', content: mergeSystemWithOfficialPrompt(renderOpencodeOfficialPrompt(input.model), input.system) },
      ...input.messages,
    ],
    tools: buildOpencodeTools(input.tools),
    ...typeof input.temperature === 'number' && Number.isFinite(input.temperature) ? { temperature: input.temperature } : {},
    // 不擅自使用模型上限作默认预算；仅在调用方明确指定时下发 max_tokens。
    ...Number.isSafeInteger(input.maxTokens) && (input.maxTokens ?? 0) > 0 ? { max_tokens: input.maxTokens } : {},
    ...typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0 ? { reasoning_effort: input.reasoningEffort } : {},
  })
}

export function buildOpencodePayload(input: OpencodePayloadInput): RecordValue {
  return buildOpencodeRequest(input).payload
}
