/**
 * 0.1.7 消息形状双兼容：序列化等价性回归。
 *
 * 核心不变式：**同一份语义数据，按 0.1.5 形状与 0.1.7 形状分别喂入，
 * 序列化输出必须逐字节等价**。
 *
 * 这条不变式比"逐个断言字段"更强 —— 它直接锁住"0.1.7 不会让工具调用丢失"
 * 这一修复目标，且对实现方式保持中立。
 *
 * ## ⚠️ 2026-10-21：`codearts` 不再有自己的 `serializeMessages`
 *
 * 接图片时发现 `llm-adapter.ts` 有一份**只处理文本**的私有 `serializeMessages`
 *（注释还写着「其余非文本块（图片）被丢弃」）。若在它上面再加一条图片腿，就会
 * 变成「同一语义两套实现」—— 而共享实现已经把 12 家的坑（工具结果内嵌图片
 * 提升为独立 user 消息、空 Map 不降级、`[image unavailable]` 占位符、递归深度
 * 与 `collectImages` 对齐）全部踩过。故**删除私有那份，改用 `openai-compat.ts`**。
 *
 * ⚠️⚠️ 于是本文件原来那条「CodeArts 与 OpenAI-compat 互相对拍」的断言**失效**了：
 * 两者现在是**同一个函数**，`f(x) === f(x)` 恒真 ⇒ 变成同义反复（本仓纪律：
 * 恒真断言必须删掉或改判据，不能留着充数）。
 * ⇒ 改法是：**不再假装有两份实现**，直接断言 CodeArts 的 wire 产物结构
 *   （工具调用与结果都在、文本没丢）。这比原来更强 —— 原断言在「两边同时为空」
 *   时会假通过，现在的断言逐个点名必须存在的东西。
 */
import { describe, expect, it } from 'vitest'
import { serializeMessages as serializeCodeArts } from '../../src/llm-adapter.js'
import { resolveToolPairing } from '../../src/sse.js'

/**
 * 一段带两次工具调用与两个结果的历史。
 *
 * `shape` 决定工具结果的承载方式：
 * - `legacy`：0.1.5，包裹在 user 消息的 `tool-result` 块里；
 * - `tool-role`：0.1.7，一等 `tool` 消息（`toolCallId`/`isError` 在顶层）。
 */
function history(shape: 'legacy' | 'tool-role'): Array<Record<string, unknown>> {
  const head: Array<Record<string, unknown>> = [
    { role: 'system', content: [{ type: 'text', text: 'SYS' }] },
    { role: 'user', content: [{ type: 'text', text: 'TASK' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'working' },
        { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"file_path":"a.ts"}' },
        { type: 'tool-call', id: 'call_b', name: 'grep', arguments: '{"pattern":"x"}' },
      ],
    },
  ]
  const results = [
    { id: 'call_a', text: 'FILE A' },
    { id: 'call_b', text: 'MATCH B' },
  ]
  const tail = shape === 'legacy'
    ? results.map(result => ({
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: result.id,
        content: [{ type: 'text', text: result.text }],
        isError: false,
      }],
    }))
    : results.map(result => ({
      role: 'tool',
      toolCallId: result.id,
      content: [{ type: 'text', text: result.text }],
      isError: false,
      source: { kind: 'tool', callId: result.id },
    }))
  return [...head, ...tail]
}

describe('resolveToolPairing 跨形状等价', () => {
  // 真实缺陷的判据：0.1.7 形状下若结果为 0，assistant 的 tool_calls 会被
  // 整体剔除，模型完全看不到自己调用过什么 —— 表现为提前结束或循环思考。
  it('keeps every tool call under both shapes', () => {
    const legacy = resolveToolPairing(history('legacy'))
    const toolRole = resolveToolPairing(history('tool-role'))
    expect(legacy.keepCallIds.size).toBe(2)
    expect(toolRole.keepCallIds.size).toBe(legacy.keepCallIds.size)
    expect(toolRole.keepResultIds.size).toBe(legacy.keepResultIds.size)
  })

  it('keeps the exact same call ids under both shapes', () => {
    const legacy = resolveToolPairing(history('legacy'))
    const toolRole = resolveToolPairing(history('tool-role'))
    expect([...toolRole.keepCallIds].sort()).toEqual([...legacy.keepCallIds].sort())
  })

  it('still drops orphan tool calls (regression guard for the original defense)', () => {
    // 原有防线不能被削弱：无结果的调用必须仍被剔除，否则后端 400。
    const messages = history('tool-role').filter(message =>
      !(message.role === 'tool' && message.toolCallId === 'call_b'))
    const { keepCallIds } = resolveToolPairing(messages)
    expect(keepCallIds.size).toBe(0)
  })
})

describe('serializeMessages 跨形状等价（CodeArts 走共享实现）', () => {
  it('produces identical CodeArts wire bodies', () => {
    expect(serializeCodeArts(history('tool-role'))).toEqual(serializeCodeArts(history('legacy')))
  })

  /**
   * ⚠️ 原来这里还有一条「OpenAI-compat 也等价」的断言 —— 合并实现后它与上一条
   * **完全同义**（同一个函数、同一份输入），删掉。
   * 判据的判别力由下面两条「逐个点名」的断言承担。
   */
  it('emits both tool calls and both tool results under 0.1.7', () => {
    // 直接断言"没丢东西"，避免等价性测试因两边同时为空而假通过。
    const wire = serializeCodeArts(history('tool-role'))
    const assistant = wire.find(message => message.role === 'assistant') as { tool_calls?: unknown[] }
    expect(assistant.tool_calls).toHaveLength(2)
    const toolMessages = wire.filter(message => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages.map(message => (message as { tool_call_id: string }).tool_call_id).sort())
      .toEqual(['call_a', 'call_b'])
  })

  it('preserves tool result text under 0.1.7', () => {
    const wire = serializeCodeArts(history('tool-role'))
    const texts = wire
      .filter(message => message.role === 'tool')
      .map(message => String((message as { content: unknown }).content))
    expect(texts).toEqual(['FILE A', 'MATCH B'])
  })
})
