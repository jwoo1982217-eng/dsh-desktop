import { describe, expect, it } from 'vitest'
import { buildOpencodePayload, buildOpencodeTools, ensureFreeLaneShape } from '../../src/opencode-messages.js'
import { RESERVED_BUILTIN_TOOL_NAMES, RESERVED_TOOL_DESCRIPTION } from '../../src/opencode-official-tools.js'

const namesOf = (payload: Record<string, unknown>): string[] =>
  (payload.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)

const base = { model: 'big-pickle', messages: [{ role: 'user', content: '你好' }] }
const builtinNames = [...RESERVED_BUILTIN_TOOL_NAMES]

describe('buildOpencodeTools', () => {
  it('DSH 工具映射为 OpenAI function 形态，schema 不改写', () => {
    const parameters = { type: 'object' }
    expect(buildOpencodeTools([{ name: 'read', description: '读文件', parameters }]))
      .toEqual([{ type: 'function', function: { name: 'read', description: '读文件', parameters } }])
  })
  it('无工具时返回空数组', () => {
    expect(buildOpencodeTools(undefined)).toEqual([])
  })
  it('空描述不填空串', () => {
    expect(buildOpencodeTools([{ name: 'x', description: '', parameters: {} }])[0]!.function.description).toBeUndefined()
  })
})

describe('OpenCode V2 门禁', () => {
  it('补齐全套内置工具集，不注入显式 tool_choice:none', () => {
    const payload = buildOpencodePayload(base)
    // ⚠️ 2026-10-27：整套发送（形状的一部分），不只是 read。
    expect(namesOf(payload)).toEqual(builtinNames)
    expect(namesOf(payload)).toEqual(expect.arrayContaining(['edit', 'read', 'write', 'shell']))
    expect(payload.tool_choice).toBeUndefined()
    expect(payload.stream).toBe(true)
    expect(payload.stream_options).toEqual({ include_usage: true })
  })
  it('全部内置工具的顶层描述都换成禁止调用，参数 schema 原样保留', () => {
    const tools = buildOpencodePayload(base).tools as Array<{ function: { name: string; description?: string; parameters?: { type?: string } } }>
    for (const tool of tools) {
      expect(tool.function.description).toBe(RESERVED_TOOL_DESCRIPTION)
      expect(tool.function.parameters?.type).toBe('object')
    }
    expect(tools).toHaveLength(builtinNames.length)
    expect(tools.map((tool) => tool.function.name)).toEqual(builtinNames)
  })
  it('read 内置工具保留参数 schema，描述只提示禁止调用', () => {
    const tools = buildOpencodePayload(base).tools as Array<{ function: { name: string; description: string; strict: boolean; parameters: { required: string[]; properties: Record<string, { type: string; minimum?: number }>; additionalProperties: boolean } } }>
    const fn = tools.find((tool) => tool.function.name === 'read')!.function
    expect(fn.description).toBe(RESERVED_TOOL_DESCRIPTION)
    expect(fn.parameters.required).toEqual(['path'])
    expect(fn.parameters.properties.path!.type).toBe('string')
    expect(fn.parameters.properties.offset).toMatchObject({ type: 'integer', minimum: 0 })
    expect(fn.parameters.properties.limit).toMatchObject({ type: 'integer', minimum: 0 })
    expect(Object.keys(fn.parameters.properties)).toEqual(['path', 'offset', 'limit'])
    expect(fn.parameters.additionalProperties).toBe(false)
    expect(fn.strict).toBe(false)
  })
  it('全部客户端工具使用别名，保留原 schema 与描述', () => {
    const parameters = { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
    const tools = ['read', 'shell', 'edit', 'write', 'glob', 'grep'].map((name) => ({ name, description: '客户端工具', parameters }))
    const payload = buildOpencodePayload({ ...base, tools })
    const wire = payload.tools as Array<{ function: { name: string; parameters: unknown; description: string } }>
    expect(namesOf(payload)).toEqual([...tools.map((tool) => `dsh_${tool.name}`), ...builtinNames])
    for (const fn of wire.slice(0, tools.length).map((tool) => tool.function)) {
      expect(fn.parameters).toBe(parameters)
      expect(fn.description).toContain('客户端工具')
    }
    expect(payload.tool_choice).toBeUndefined()
  })
  it('客户端工具与内置工具同名时互不碰撞：客户端走 dsh_ 前缀', () => {
    const tools = ['read', 'shell', 'edit', 'write'].map((name) => ({ name, description: '' }))
    const names = namesOf(buildOpencodePayload({ ...base, tools }))
    expect(names.slice(0, tools.length)).toEqual(tools.map((tool) => `dsh_${tool.name}`))
    expect(names.slice(tools.length)).toEqual(builtinNames)
    expect(new Set(names).size).toBe(names.length)
  })
  it('长名字、规范化重名和已有别名不会碰撞', () => {
    const tools = ['read', 'dsh_read', 'dsh_read_1', 'a.b', 'a_b', 'x'.repeat(64), 'x'.repeat(63) + 'y']
      .map((name) => ({ name, description: '' }))
    const names = namesOf(buildOpencodePayload({ ...base, tools }))
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('dsh_read_2')
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })
  it('历史调用同步改名，调用 id、参数和结果正文保持原样，不修改入参', () => {
    const messages = [
      { role: 'user', content: 'read' },
      { role: 'assistant', tool_calls: [{ id: 'A', type: 'function', function: { name: 'read', arguments: '{"file_path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'A', content: 'read: file content' },
      { role: 'assistant', function_call: { name: 'read', arguments: '{}' } },
      { role: 'function', name: 'read', content: 'legacy result' },
    ]
    const input = { ...base, messages, tools: [{ name: 'read', description: '' }] }
    const snapshot = JSON.stringify(input)
    const payload = buildOpencodePayload(input)
    // ⚠️ 第一条**恒为**官方形态 system（见下方「业务字段」的用例），历史消息整体后移一位。
    expect(payload.messages).toEqual([
      payload.messages[0],
      messages[0],
      { ...messages[1], tool_calls: [{ id: 'A', type: 'function', function: { name: 'dsh_read', arguments: '{"file_path":"a"}' } }] },
      messages[2],
      { role: 'assistant', function_call: { name: 'dsh_read', arguments: '{}' } },
      { role: 'function', name: 'dsh_read', content: 'legacy result' },
    ])
    expect((payload.messages[0] as { role: string }).role).toBe('system')
    expect(JSON.stringify(input)).toBe(snapshot)
  })
  it('指定工具与 allowed_tools 选择同步改名', () => {
    const tools = [{ type: 'function', function: { name: 'read' } }]
    const next = ensureFreeLaneShape({ messages: [], tools, tool_choice: { type: 'function', function: { name: 'read' } } })
    expect(next.tool_choice).toEqual({ type: 'function', function: { name: 'dsh_read' } })
    const allowed = ensureFreeLaneShape({ messages: [], tools, tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'read' }] } })
    expect(allowed.tool_choice).toEqual({ type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'dsh_read' }] })
  })
  it('显式 none 移除客户端工具，不透传 none，响应层负责禁用语义', () => {
    const payload = ensureFreeLaneShape({ messages: [], tools: [{ type: 'function', function: { name: 'read' } }], tool_choice: 'none' })
    expect(namesOf(payload)).toEqual(builtinNames)
    expect(payload.tool_choice).toBeUndefined()
  })
  it('非 chat body 不改写', () => {
    const payload = { input: [] }
    expect(ensureFreeLaneShape(payload)).toBe(payload)
  })
})

describe('业务字段', () => {
  /**
   * ⚠️ 2026-10-26：`messages` 现在**恒**带一条官方形态 system（真机实测：
   * 没有它上游免费档回 429，见 `src/opencode-official-prompt.ts` 的对照表）。
   * 故「保持原引用」这条不再成立 —— 改为「历史消息逐字节不变、整体后移一位」。
   */
  it('无工具、无 system 时历史消息仍原样，只在最前面插入官方 system', () => {
    const payload = buildOpencodePayload(base)
    expect(payload.model).toBe(base.model)
    expect(payload.messages.slice(1)).toEqual([...base.messages])
    expect(payload.system).toBeUndefined()
    const first = payload.messages[0] as { role: string; content: string }
    expect(first.role).toBe('system')
    // 门禁要的那一块必须在（缺它 ⇒ 429）。
    expect(first.content).toContain('<env>')
    expect(first.content).toContain('Working directory: ./')
    expect(first.content).toContain('Model ID: big-pickle')
  })
  it('DSH system 拼在官方提示词之后，仍在同一条 system 消息里', () => {
    const payload = buildOpencodePayload({ ...base, system: '系统提示' })
    const [first, ...rest] = payload.messages as Array<{ role: string; content: string }>
    expect(rest).toEqual([...base.messages])
    expect(payload.system).toBeUndefined()
    expect(first.role).toBe('system')
    // ⚠️ 顺序即判据：官方提示词在前（含 `<env>`），DSH 自己的提示原样在后面。
    expect(first.content.endsWith('系统提示')).toBe(true)
    expect(first.content.indexOf('<env>')).toBeLessThan(first.content.indexOf('系统提示'))
    // 不得出现两条 system（实测「官方提示词不在首位」⇒ 429）。
    expect((payload.messages as Array<{ role: string }>).filter((m) => m.role === 'system')).toHaveLength(1)
  })
  it('不擅自填默认输出预算，非法 maxTokens 不下发', () => {
    for (const maxTokens of [undefined, 0, -5, Number.NaN]) {
      expect(buildOpencodePayload({ ...base, maxTokens }).max_tokens).toBeUndefined()
    }
    expect(buildOpencodePayload({ ...base, maxTokens: 4096 }).max_tokens).toBe(4096)
  })
})
