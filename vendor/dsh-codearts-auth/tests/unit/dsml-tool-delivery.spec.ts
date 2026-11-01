/**
 * `dsml-tool-delivery.spec.ts` —— 防回归：**每个**适配器都必须下发工具定义。
 *
 * ## 真实事故（2026-10-13）
 *
 * OfficeAce 通道下 `deepseek-v4.1-flash` 输出：
 *
 * ```
 * <｜DSML｜ calls><｜DSML｜ invoke name="bash">...</｜DSML｜ invoke></｜DSML｜ calls>
 * ```
 *
 * 标记**单竖线、完全「规范」**，但宿主解析器只认 `<｜DSML｜tool_calls>`
 * （见 dsml.ts 的 `DSML_TOOL_CALLS_OPEN`）—— 于是整段当正文显示、
 * **工具从未执行**（日志佐证：该 assistant 消息只有 reasoning+text 两块，
 * 没有任何 `tool/call` 记录）。
 *
 * 根因排查：`officeace-adapter.ts` 里 `tools` **零命中**——适配器既不发
 * `tools` 字段、也不注入 DSML schema 提示。15 个适配器中**只有它**漏了。
 * 模型在零协议指引下凭训练印象臆造了 `calls` 这种不存在的语法。
 *
 * 即：**不是模型把标记写坏了，是没人告诉它正确的写法**。
 * 归一化（sse.ts）只能修「双竖线」笔误，修不了「协议没下发」。
 *
 * 本文件锁的就是**工具定义必须下发**这件事。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDsmlSystemPrompt, DSML_TOOL_CALLS_CLOSE, DSML_TOOL_CALLS_OPEN, isDeepseekV4Model, needsDsmlToolMode } from '../../src/dsml.js'

const SRC_DIR = join(process.cwd(), 'src')

function adapters(): string[] {
  return readdirSync(SRC_DIR).filter((f) => f.endsWith('-adapter.ts'))
}

describe('工具定义下发（防回归：15 个适配器，只有 officeace 曾漏）', () => {
  it('① 除聚合/路由类外，每个适配器都必须处理 tools', () => {
    // aggregate / auto 是路由层（转发给别的适配器），自身不需要 tools。
    // ⚠️⚠️ **codely 已从豁免中撤销**（2026-10-22 对抗审计 M-5）。
    //    旧豁免理由写的是「推理网关要求 HMAC 签名、密钥未取得 ⇒ 不发请求」，
    //    而那条**已被同一个 PR 自己证伪**：`codely-sign.ts` 已把 SECRET 硬编码、
    //    与官方 npm 包逐字节对拍通过，端到端实测 200。它**确实发推理请求**
    //    （且会带 tools）⇒ 豁免已失效，必须撤销。
    //    ⚠️ 这正是本仓库记过的豁免腐坏形态：「写了一个豁免 + 一句当时真、
    //    后来假的理由」⇒ 它会静默地一直豁免下去（同时实测：把
    //    `codely-adapter.ts` 的 tools 下发真删掉，本文件 7 条仍全绿）。
    //    ⚠️ 保留的两个豁免是**路由层**（它们转发给别的适配器，自身不组装 tools）。
    const exempt = new Set(['aggregate-adapter.ts', 'auto-adapter.ts', 'opencode-hybrid-adapter.ts'])
    const missing = adapters().filter((f) => {
      if (exempt.has(f)) return false
      return !/\btools\b/.test(readFileSync(join(SRC_DIR, f), 'utf8'))
    })
    expect(
      missing,
      `以下适配器完全没处理 tools（2026-10-13 事故根因）：${missing.join(', ')}`,
    ).toEqual([])
  })

  it('② officeace 必须把 tools 放进请求体或注入 DSML 提示（二选一）', () => {
    const c = readFileSync(join(SRC_DIR, 'officeace-adapter.ts'), 'utf8')
    const sendsToolsField = /tools:\s*toolsPayload|tools:\s*wireTools|tools\b/.test(c)
    const injectsDsml = /buildDsmlSystemPrompt/.test(c)
    expect(
      sendsToolsField || injectsDsml,
      'officeace 既未发 tools 字段、也未注入 DSML 提示 ⇒ 模型会臆造语法',
    ).toBe(true)
  })

  it('③ officeace 对 deepseek-v4 系模型必须注入 DSML（走流式，规避网关断连）', () => {
    const c = readFileSync(join(SRC_DIR, 'officeace-adapter.ts'), 'utf8')
    expect(c).toContain('needsDsmlToolMode')
    expect(c).toContain('buildDsmlSystemPrompt')
  })
})

describe('DSML 协议常量（必须与解析器一致）', () => {
  it('④ 开闭标签必须是 tool_calls，不是 calls', () => {
    // ⚠️ 这两行的**逐字**内容决定模型输出能否被解析。`calls` 是模型臆造的
    //    错误写法，解析器不认 —— 常量若被改成 calls，工具调用全部失效。
    expect(DSML_TOOL_CALLS_OPEN).toBe('<｜DSML｜tool_calls>')
    expect(DSML_TOOL_CALLS_CLOSE).toBe('</｜DSML｜tool_calls>')
  })

  it('⑤ 解析器常量与提示词常量同源（不得两处各写一份）', () => {
    // llm-adapter 的 parseDsmlToolCalls 用这两个常量做匹配，提示词用它们
    // 教模型 —— 若分叉，模型学到的和解析器认的对不上。
    const llm = readFileSync(join(SRC_DIR, 'llm-adapter.ts'), 'utf8')
    expect(llm).toContain("from './dsml.js'")
    // 解析器侧不得再有硬编码的本地副本
    expect(llm).not.toMatch(/const DSML_TOOL_CALLS_OPEN\s*=/)
  })

  it('⑥ 提示词必须示范正确的 tool_calls 语法', () => {
    const prompt = buildDsmlSystemPrompt([{
      type: 'function',
      function: { name: 'bash', description: 'run', parameters: { type: 'object' } },
    }])
    expect(prompt).toContain(DSML_TOOL_CALLS_OPEN)
    expect(prompt).toContain(DSML_TOOL_CALLS_CLOSE)
    // 不得出现「没 tool_ 前缀」的错误示范
    expect(prompt).not.toMatch(/<｜DSML｜\s*calls>/)
    expect(prompt).toContain('bash')
  })

  it('⑦ OfficeAce 的 -flash 变体也要走 DSML（同经网关，断连风险一致）', () => {
    expect(isDeepseekV4Model('deepseek-v4-flash')).toBe(true)
    expect(needsDsmlToolMode('deepseek-v4.1-flash', [])).toBe(true)
    expect(needsDsmlToolMode('deepseek-v4-pro', [])).toBe(true)
    // 非 v4 不该被误伤
    expect(needsDsmlToolMode('kimi-k2.6', [])).toBe(false)
  })
  /**
   * ★★ **codely 必须真的把 `tools` 放进请求体**（2026-10-22 对抗审计 M-15）。
   *
   * ## 为什么上面那条（源码文本判据）不够
   *
   * 上面用 `readFileSync(...).includes('tools')` —— 实测：把 `codely-adapter.ts` 里
   * **真正下发 tools 的那段** 整体删掉（改成恒不发），本文件 7 条
   * **仍然全绿** —— 因为 `tools` 这个词还在别的地方出现（注释、
   * `options.tools?.length` 判据、`forceToolChoice` 分支…）。本仓库已将这种
   * 「源码文本断言」列为红线（`if (false)` 短路就能骗过）。
   *
   * ## 判据
   *
   * 真跑一次 `stream()`，**拉下真实请求体**看 `tools` / `tool_choice` 在不在。
   * 反向对照：不传 `tools` 的纯聊天请求不得带这两个字段（否则上游可能因空工具集报错）。
   */
  it('★★ codely：带工具时请求体必须真有 tools；纯聊天时不得有', async () => {
    const { CodelyAdapter } = await import('../../src/codely-adapter.js')
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/api-token/cli-api-key')) {
        return new Response(JSON.stringify({ cli_api_key: 'sk-x' }), { status: 200 })
      }
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })}\n\n`
        + 'data: [DONE]\n\n',
        { status: 200 },
      )
    }) as never
    const make = () => new CodelyAdapter({
      credentialProvider: async () => ({ access_token: 't', refresh_token: 'r' } as never),
      fetchImpl,
    } as never)
    const drain = async (opts: Record<string, unknown>) => {
      bodies.length = 0
      for await (const _c of make().stream(opts as never)) { /* drain */ }
      return bodies[0]
    }

    const WITH_TOOLS = [{ name: 'write_file', description: 'w', parameters: { type: 'object', properties: {} } }]
    const withTools = await drain({ model: 'codely-flash', messages: [{ role: 'user', content: 'go' }], tools: WITH_TOOLS })
    // ① 决定性断言：`tools` 必须真的在请求体里
    expect(withTools?.tools, 'codely 带工具时必须下发 tools（否则模型只能把调用写进正文）')
      .toBeDefined()
    expect(Array.isArray(withTools!.tools), 'tools 必须是数组').toBe(true)
    expect((withTools!.tools as unknown[]).length, '下发的工具数必须与传入一致').toBe(1)

    // ② 反向对照：纯聊天不得带 tools / tool_choice
    const chatOnly = await drain({ model: 'codely-flash', messages: [{ role: 'user', content: 'hi' }] })
    expect('tools' in (chatOnly ?? {}), '纯聊天不得发 tools').toBe(false)
    expect('tool_choice' in (chatOnly ?? {}), '纯聊天不得发 tool_choice').toBe(false)
  })
})
