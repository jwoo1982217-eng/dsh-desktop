/**
 * Codely 适配器单测：**目录 + 推理**（推理自 2026-10-20 起驱动官方 CLI 子进程）。
 *
 * ## 为什么这几条
 *
 * - **远端优先 / 失败回退兜底表**：回退错就是「8 个真模型变成 0 个」或
 *   「拿编译期快照冒充实时目录」；
 * - **`listAllModels()` 必须同步且非空**：`provider.status` 与
 *   `ModelCatalogSource` 不 await（冷缓存下直接读），空数组会让面板把
 *   「已关闭」判成 `total === 0` 的另一种形态；
 * - **推理侧只锁「失败必须显式、绝不静默空流」**（CLI 没装 / 没登录 / 无输出 /
 *   非文本输入）+ 「增量必须逐块透传」。成功路径的文案细节不锁（CLI 版本会变），
 *   锁的是**形状**（block-start → delta… → block-end → finish）。
 */

import { describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { CodelyAdapter, type CodelyAdapterOptions } from '../../src/codely-adapter.js'
import { CODERLY } from '../../src/codely-product.js'
import type { CodelyCredential } from '../../src/codely-auth.js'
import { CODERLY_CLI_PATH_ENV, type CodelyCliChild, type CodelyCliSpawner } from '../../src/codely-cli.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** `/api/model-status` 的实测报文形状（简化：只留 models[]）。 */
const REMOTE_OK = JSON.stringify({
  scope: 'public',
  models: [
    { modelGroup: 'codely-basic', status: 'operational' },
    { modelGroup: 'KIMI-K3', status: 'outage' },
  ],
})

function fakeFetch(
  impl: () => { ok: boolean; status: number; text: () => Promise<string> },
): typeof fetch {
  return (async () => impl()) as unknown as typeof fetch
}

const CREDENTIAL: CodelyCredential = {
  access_token: 'access-token-abc',
  refresh_token: 'refresh-token-abc',
  obtained_at: Date.now(),
}

function adapterWith(options: Partial<Pick<CodelyAdapterOptions, 'fetchImpl'>> = {}): CodelyAdapter {
  return new CodelyAdapter({
    credentialProvider: async () => CREDENTIAL,
    ...options,
  })
}

/**
 * 假 CLI 子进程：把给定的 stdout / stderr 当成进程输出，并在读完后触发 exit。
 *
 * ⚠️ 为什么**必须**有 timeout 兜底：正常路径监听 stdout 的 `end`，但被 kill
 *    或 readline 提前关闭时它可能不来 ⇒ 没有兜底会让整条用例挂死到超时，
 *    失败信息变成一句无意义的 "test timed out"。
 */
/**
 * 喂给 `cliEnv` 的「惰性但真实存在」的可执行文件路径。
 *
 * ## ⚠️⚠️ 为什么必须有它（2026-10-22 合并审计修 —— 5 条用例在任何干净克隆上必红）
 *
 * `runCodelyCli` 在调用 **spawner 之前**先过 `resolveCodelyCliPath` 的 `existsSync`
 * 闸门（`codely-cli.ts:159-166`）：env `DSH_CODERLY_CLI_PATH` → 硬编码的
 * `D:\Program File\Tuanjie Cowork\...\codely.exe` → 都不存在就抛
 * 「未找到官方 Codely 客户端」。
 *
 * ⇒ `fakeCli()` 只替身了 `cliSpawner`、**没替身 `existsSync`** ⇒ 闸门先抛、
 *   替身永不被调用 ⇒ 5 条用例在**没装 Codely 桌面端**的机器（= 干净克隆 / CI）
 *   **100% 必红**。实测本机：`exists=false` ⇒ 5 failed / 9 passed。
 *
 * ⚠️ 决定性对照（实测）：`DSH_CODERLY_CLI_PATH=C:\Windows\System32\cmd.exe`
 *    跑**同一份代码** ⇒ **14/14 全绿**。
 *
 * ⚠️ 刻意用 `cmd.exe`（Windows 恒存在）而**不是**真实 `codely.exe`：spawner 已被
 *   替身 ⇒ 它**绝不会被真正执行**；若指向真客户端、而某条路径漏了替身，就会在
 *   仓库 cwd 里**真起一个 `--approval-mode yolo` 的 CLI 进程**去读写文件。
 */
const EXISTING_INERT_EXECUTABLE = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\cmd.exe'
  : '/bin/sh'

function fakeCli(options: {
  stdout?: string
  stderr?: string
  exitCode?: number
  spawnError?: Error
}): { spawner: CodelyCliSpawner; args: () => string[] | undefined; wasKilled: () => boolean } {
  let lastArgs: string[] | undefined
  let killed = false
  const spawner: CodelyCliSpawner = (_file, args, _opts) => {
    lastArgs = [...args]
    const stdout = Readable.from([options.stdout ?? ''])
    const stderr = Readable.from([options.stderr ?? ''])
    const handlers = new Map<string, ((...args: never[]) => void)[]>()
    const emit = (event: string, ...payload: never[]): void => {
      for (const cb of handlers.get(event) ?? []) cb(...payload)
    }
    const child = {
      stdout,
      stderr,
      on(event: string, cb: (...args: never[]) => void) {
        const list = handlers.get(event) ?? []
        list.push(cb)
        handlers.set(event, list)
        return child
      },
      kill() {
        killed = true
        stdout.destroy()
        stderr.destroy()
        emit('exit', null as never)
      },
    }
    if (options.spawnError !== undefined) {
      setImmediate(() => { emit('error', options.spawnError as never) })
    } else {
      const fire = (): void => { emit('exit', (options.exitCode ?? 0) as never) }
      stdout.on('end', fire)
      setTimeout(fire, 500)
    }
    return child as unknown as CodelyCliChild
  }
  return { spawner, args: () => lastArgs, wasKilled: () => killed }
}

describe('Codely 适配器：目录', () => {
  /**
   * 本团队**可访问**的兜底模型（`codely-*` 前缀）。
   *
   * ⚠️ 2026-10-20 实测：公共模型名（`DeepSeek-V4.1-Flash` / `GLM-5.3-FLASH` /
   *    `KIMI-K3`）对当前团队一律 `401 team_model_access_denied`，适配器已按
   *    id 前缀过滤（见 `catalogEntries` 的注释表）⇒ 兜底表 8 个只剩 5 个。
   */
  const accessibleFallback = CODERLY.fallbackModels.filter((m) =>
    m.id.toLowerCase().startsWith('codely-'))

  it('① 远端可用 ⇒ 用远端目录（不是编译期兜底表），且团队无权的模型被过滤', async () => {
    const adapter = adapterWith({ fetchImpl: fakeFetch(() => ({
      ok: true, status: 200, text: async () => REMOTE_OK,
    })) })
    const models = await adapter.listModels(CODERLY.id)
    // 远端给了 `codely-basic` + `KIMI-K3`；后者团队无权（401 team_model_access_denied）
    // ⇒ 目录里只应剩下前者。判据见 `catalogEntries` 的实测表。
    expect(models.map((m) => m.id)).toEqual(['codely-basic'])
  })

  it('② 远端非 200 ⇒ 回退兜底表（8 个实测模型）', async () => {
    const adapter = adapterWith({ fetchImpl: fakeFetch(() => ({
      ok: false, status: 500, text: async () => 'boom',
    })) })
    const models = await adapter.listModels(CODERLY.id)
    expect(models.length).toBe(accessibleFallback.length)
    expect(models.map((m) => m.id)).toContain('codely-core')
  })

  it('③ 远端不是 JSON ⇒ 回退兜底表（不抛错）', async () => {
    const adapter = adapterWith({ fetchImpl: fakeFetch(() => ({
      ok: true, status: 200, text: async () => '<html>维护中</html>',
    })) })
    await expect(adapter.listModels(CODERLY.id)).resolves.toHaveLength(
      accessibleFallback.length,
    )
  })

  it('④ 没有凭据 ⇒ 仍返回兜底表（目录读不到不抛错）', async () => {
    const adapter = new CodelyAdapter({ credentialProvider: async () => undefined })
    await expect(adapter.listModels(CODERLY.id)).resolves.toHaveLength(
      accessibleFallback.length,
    )
  })

  /**
   * ⑦ **没有凭据 ⇒ 零上游请求**。
   *
   * ⚠️ ④ 只断言了「结果仍是兜底表」，**没锁住请求数**：若实现改成「先打远端、
   * 失败再回退」，④ 照样绿，而用户会多收一个**注定 401 的请求**
   * （`/api/model-status` 要 Bearer，无凭据必然 401 —— 与本渠道推理那 401
   * 同形态，都是本仓库明令不发的东西）。
   *
   * ⇒ 本条把「无凭据 ⇒ 短路、直接回兜底表」钉成行为，不只是结果。
   */
  it('⑦ 没有凭据 ⇒ 零上游请求（无 Bearer 打目录端点注定 401）', async () => {
    let called = 0
    const adapter = new CodelyAdapter({
      credentialProvider: async () => undefined,
      fetchImpl: fakeFetch(() => {
        called += 1
        return { ok: false, status: 401, text: async () => 'unauthorized' }
      }),
    })
    await adapter.listModels(CODERLY.id)
    expect(called, '无凭据时不得打远端（那是注定 401 的请求）').toBe(0)
  })

  it('⑤ `listAllModels()` 同步且非空（冷缓存下 provider.status 直接读它）', () => {
    const adapter = new CodelyAdapter({})
    // ⚠️ 冷缓存下（从未跑过 `listModels`）也必须非空 —— `provider.status` 直接读它。
    expect(adapter.listAllModels().length).toBeGreaterThan(0)
  })


  it('⑥ `resolveModel` 对未知 id 也要给出非空名字', async () => {
    const adapter = new CodelyAdapter({})
    const resolved = await adapter.resolveModel(CODERLY.id, 'not-in-catalog')
    expect(resolved.name.length).toBeGreaterThan(0)
  })
})

/**
 * 推理：**驱动官方 CLI 子进程**（2026-10-20 接通）。
 *
 * ⚠️ 本组在签名密钥未取得的前提下成立：适配器自己**不发**推理 HTTP 请求
 * （那注定 401），而是让带合法签名逻辑的官方客户端去发，我们只消费输出。
 * 故这里没有「发请求」可断言，断言的是**输出转换与失败形态**。
 *
 * ⚠️ 历史提醒（防止有人把本组改回旧形态）：本组前身是「`stream()` 显式报
 * 错、零请求」两条 —— 通道接通后它们是**锁死已不存在形态的过时用例**，
 * 已按当时的注释约定删除（留着比没有更糟）。若将来改成自签 HTTP，
 * 应写「带 `X-Codely-Signature` 的真实请求」用例来替换，而不是复活旧断言。
 */
describe('Codely 适配器：推理（驱动官方 CLI）', () => {
  /** 收集一次 `stream()` 的全部 chunk。 */
  async function collect(adapter: CodelyAdapter, options: unknown): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(options as never)) chunks.push(chunk)
    return chunks
  }

  it('① 正常流：block-start → 若干 text-delta → block-end → finish', async () => {
    const { spawner } = fakeCli({
      stdout: [
        '{"type":"init","session_id":"s1","model":"codely-basic"}',
        '{"type":"message","role":"user","content":"hi","delta":false}',
        '{"type":"message","role":"assistant","content":"你","delta":true}',
        '{"type":"message","role":"assistant","content":"好","delta":true}',
        '{"type":"result","status":"success","stats":{"total_tokens":10,"duration_ms":2000}}',
      ].join('\n'),
    })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      cliEnv: { [CODERLY_CLI_PATH_ENV]: EXISTING_INERT_EXECUTABLE },
    })
    const chunks = await collect(adapter, {
      model: 'codely-basic',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(chunks.map((c) => c.type)).toEqual([
      'block-start', 'text-delta', 'text-delta', 'block-end', 'finish',
    ])
    // ⚠️ 增量必须逐块透传（不是只在末尾一次性给全文）：否则用户看不到流式。
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)).toEqual(['你', '好'])
    expect(chunks.at(-2)).toMatchObject({ type: 'block-end', block: { type: 'text', text: '你好' } })
  })

  it('② 多轮历史被文本化成单条 prompt（role 前缀，顺序不丢）', async () => {
    const { spawner, args } = fakeCli({ stdout: '' })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      cliEnv: { [CODERLY_CLI_PATH_ENV]: EXISTING_INERT_EXECUTABLE },
    })
    // 空 stdout ⇒ 无内容 ⇒ 抛 EMPTY_RESPONSE；本条只关心传给 CLI 的入参。
    await collect(adapter, {
      model: 'codely-basic',
      system: '你是助手',
      messages: [
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: '第二句' },
        { role: 'user', content: '第三句' },
      ],
    }).catch(() => {})
    const promptArg = args()?.find((a) => a.startsWith('--prompt=')) ?? ''
    expect(promptArg).toContain('system: 你是助手')
    expect(promptArg).toContain('user: 第一句')
    expect(promptArg).toContain('assistant: 第二句')
    expect(promptArg).toContain('user: 第三句')
    // ⚠️ 顺序：system 在最前，历史按原序。
    expect(promptArg.indexOf('system:')).toBeLessThan(promptArg.indexOf('user: 第一句'))
  })

  it('③ 图片等非文本输入 ⇒ 明确报 UNSUPPORTED_CONTENT（不静默丢弃）', async () => {
    const { spawner } = fakeCli({ stdout: '' })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      cliEnv: { [CODERLY_CLI_PATH_ENV]: EXISTING_INERT_EXECUTABLE },
    })
    await expect(collect(adapter, {
      model: 'codely-vl',
      messages: [{ role: 'user', content: [{ type: 'image', imageId: 'i1' }] }],
    })).rejects.toThrow(/只接受文本输入/)
  })

  it('④ CLI 未产出任何内容 ⇒ 报错，而不是返回空流', async () => {
    const { spawner } = fakeCli({ stdout: '' })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      cliEnv: { [CODERLY_CLI_PATH_ENV]: EXISTING_INERT_EXECUTABLE },
    })
    await expect(collect(adapter, {
      model: 'codely-basic',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/未产出任何内容/)
  })

  it('⑤ CLI 非 0 退出 ⇒ 报错且带上 stderr 尾部（不静默空流）', async () => {
    const { spawner } = fakeCli({ stdout: '', stderr: 'No credentials found', exitCode: 1 })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      cliEnv: { [CODERLY_CLI_PATH_ENV]: EXISTING_INERT_EXECUTABLE },
    })
    await expect(collect(adapter, {
      model: 'codely-basic',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/No credentials found/)
  })

  it('⑥ 找不到 CLI（环境变量指向不存在的路径）⇒ 报错并给出修法', async () => {
    const { spawner } = fakeCli({ stdout: '' })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      // ⚠️ 用一份**空** env：既避开本机默认路径存在这一事实，也避开环境变量
      //    泄漏导致的用例不稳定。
      cliEnv: { [CODERLY_CLI_PATH_ENV]: 'C:\\no\\such\\codely.exe' },
    })
    await expect(collect(adapter, {
      model: 'codely-basic',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(new RegExp(CODERLY_CLI_PATH_ENV))
  })

  it('⑦ 取消 ⇒ 杀掉子进程（不留孤儿进程）', async () => {
    const { spawner, wasKilled } = fakeCli({ stdout: '' })
    const adapter = new CodelyAdapter({
      cliSpawner: spawner,
      cliEnv: { [CODERLY_CLI_PATH_ENV]: EXISTING_INERT_EXECUTABLE },
    })
    const controller = new AbortController()
    const running = collect(adapter, {
      model: 'codely-basic',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    })
    controller.abort()
    // ⚠️ 先断言 kill、再等收尾：反过来写时，若实现卡在流上，用例会以
    //    「超时」结束而不是报出「没杀进程」，把真实原因盖掉。
    expect(wasKilled(), '取消时必须杀掉 CLI 子进程').toBe(true)
    await running.catch(() => {})
  })
})

/**
 * ★★ **HTTP 推理路径的 chunk 形状**（2026-10-22 对抗审计补 —— 此前**整片零覆盖**）。
 *
 * ## 为什么必须用真实 `BlockAssembler` 而不是断言 chunk 序列
 *
 * 本文件原有 5 条推理用例**全走 CLI 路径**（注入了 `cliSpawner`），HTTP 路径的
 * 输出形状**一条都没断言** ⇒ 对抗审计的 7 条变异（工具 index、不下发 tools、
 * finish 分类、停滞续拉、跳过 `hasUsableToolName`…）**全部 51 passed 全绿**。
 *
 * ⇒ 判据必须是「**把适配器产出的 chunk 真的喂给 `BlockAssembler`，看它组装出什么**」，
 *   而不是断言 chunk 长什么样 —— 因为缺陷恰恰出在「chunk 看起来没问题，但
 *   Assembler 按 index 幂等把它吞了」。
 *   ⚠️ 这个手法本仓 `aggregate-adapter.spec.ts:2024` 已经用过（并实测证伪过一版判据）。
 *
 * ## 修的那个真缺陷（P0）
 *
 * 上游 `delta.tool_calls[].index` 是**工具自己的** 0 起序号，而正文固定 `index: 0`、
 * 推理固定 `1`；`BlockAssembler` 的 `block-start` **只在 index 未见过时建 partial**
 * （且不更新 `blockType`）⇒ 同 index 的第二种块被**整条吞掉**。
 *
 * 修复前实测：
 * | 形态 | 组装结果 |
 * |---|---|
 * | 正文 + 1 工具 | `[text]` ← **工具消失** |
 * | 正文 + 2 工具 | `[text, tool(c1)]` ← **丢 c0** |
 * | 只有 1 工具 | `[tool]` ✅ |
 *
 * ⚠️ 而 `finish` 仍报 `tool-calls` ⇒ 宿主以为调了工具、blocks 里一个都没有
 *   ⇒ 回合停住、工具永不执行。
 */
describe('Codely 适配器：HTTP 推理的 chunk 形状（真实 BlockAssembler 组装）', () => {
  /** 造一个 `fetch` 替身：换发 cli_api_key 返 200，推理端点返给定 SSE 帧。 */
  function sseFetch(frames: readonly string[]): typeof fetch {
    return (async (url: string) => {
      if (String(url).includes('/api/api-token/cli-api-key')) {
        return {
          ok: true,
          status: 200,
          async json() { return { cli_api_key: 'sk-test', user_id: 1 } },
        }
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame))
          controller.close()
        },
      })
      return { ok: true, status: 200, body, headers: new Headers() }
    }) as unknown as typeof fetch
  }

  /** 走完整 `stream()`，把 chunk 收下来喂真实 `BlockAssembler`。 */
  async function assemble(frames: readonly string[]): Promise<Array<{ type: string; id?: string }>> {
    // ⚠️ `BlockAssembler` 从包**公开入口**导出（`lib/index.js`）—— 子路径
    //    `@deepseek-ai/dsh-llm/lib/types/assembler.js` 被 `package.json` 的
    //    `exports` 封了，vite 静态分析会在解析阶段就报 Missing specifier。
    const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
    const adapter = new CodelyAdapter({
      credentialProvider: async () => CREDENTIAL,
      fetchImpl: sseFetch(frames),
    })
    const asm = new (BlockAssembler as never as { new (): { push(c: unknown): void; assembled(): { blocks: unknown[] } } })()
    for await (const chunk of adapter.stream({
      model: 'codely-basic',
      messages: [{ role: 'user', content: '跑两个命令' }],
      tools: [{ name: 'run', description: 'x', parameters: { type: 'object', properties: {} } }],
    } as never)) {
      asm.push(chunk)
    }
    const { blocks } = asm.assembled()
    // ⚠️ `BlockAssembler.assemble()` 产出的 tool-call 块字段是 `id` / `name` /
    //    `arguments`（**不是** `toolCallId`）—— 见 `assembler.js` 的 `assemble()`。
    return blocks as Array<{ type: string; id?: string }>
  }

  const dataFrame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

  it('★★ 正文 + 1 个工具 ⇒ 工具**不得**被正文吞掉（原缺陷：tools 静默消失）', async () => {
    const blocks = await assemble([
      dataFrame({ choices: [{ delta: { content: '跑两个命令。' } }] }),
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'run', arguments: '{}' } }] } }] }),
      dataFrame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ])
    const types = blocks.map((b) => b.type)
    expect(types, '正文必须在').toContain('text')
    expect(types, '⚠️⚠️ 工具调用不得被正文的 index 吞掉').toContain('tool-call')
    expect(blocks.find((b) => b.type === 'tool-call')?.id).toBe('c0')
  })

  it('★★ 正文 + 2 个工具 ⇒ 两个工具都在（原缺陷：丢第一个）', async () => {
    const blocks = await assemble([
      dataFrame({ choices: [{ delta: { content: '跑两个命令。' } }] }),
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'run', arguments: '{}' } }] } }] }),
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'run', arguments: '{}' } }] } }] }),
      dataFrame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ])
    const ids = blocks.filter((b) => b.type === 'tool-call').map((b) => b.id)
    expect(ids, '⚠️⚠️ 两个工具都必须组装出来（原缺陷丢第一个）').toEqual(['c0', 'c1'])
  })

  it('★ 只有 1 个工具、没有正文 ⇒ 仍正常（这一格原本就是对的，防回归）', async () => {
    const blocks = await assemble([
      dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'run', arguments: '{}' } }] } }] }),
      dataFrame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ])
    expect(blocks.filter((b) => b.type === 'tool-call').map((b) => b.id)).toEqual(['c0'])
  })
})

/**
 * ★★ **远端目录「读到了但被团队前缀过滤成空」必须回退兜底表**（2026-10-22 对抗审计 P1）。
 *
 * ## 修的那个真缺陷
 *
 * `catalogEntries()` 只判 `remoteModels === undefined` 才用兜底表，**没有**
 * 「远端读到但过滤后为空」这条腿 ⇒ 上游改命名、或该团队只被授权公共模型时，
 * 过滤结果 `[]` ⇒ **兜底表永不生效** ⇒ `listModels()` / `listAllModels()` 双双返回空。
 *
 * 实测（远端下发 `[{modelGroup:'DeepSeek-V4.1-Flash'},{modelGroup:'GLM-5.3-FLASH'}]`）：
 * 修复前 `listModels = []`、`listAllModels = []`；而「远端下发空数组」那格是正确回退的
 * ⇒ **「读到了但过滤后为空」与「模型全下架」同形**，面板显示「0 个模型」，
 * 与本仓反复记录的「空返回与无账号同形」完全同型，且**无日志无报错**。
 */
describe('Codely 适配器：远端目录全被团队前缀过滤掉 ⇒ 回退兜底表', () => {
  it('★★ 远端只下发公共模型 ⇒ 目录不得为空（回退兜底表 + 留一行 warn）', async () => {
    const warnings: string[] = []
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/api/model-status')) {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              scope: 'public',
              models: [
                { modelGroup: 'DeepSeek-V4.1-Flash', status: 'operational' },
                { modelGroup: 'GLM-5.3-FLASH', status: 'operational' },
              ],
            })
          },
        }
      }
      return { ok: false, status: 404, async text() { return '' } }
    }) as unknown as typeof fetch
    const adapter = new CodelyAdapter({
      credentialProvider: async () => CREDENTIAL,
      fetchImpl,
      warn: (message: string) => { warnings.push(message) },
    })

    // ⚠️ 先触发一次目录读取（远端「成功」但不含任何 codely-* 前缀）。
    await adapter.listModels({} as never).catch(() => undefined)
    const all = adapter.listAllModels()
    expect(all.length, '⚠️⚠️ 目录不得为空（原缺陷：过滤成空后兜底表不生效）').toBeGreaterThan(0)
    expect(all.every((m) => m.id.toLowerCase().startsWith('codely-')), '回退的必须是兜底表里的 codely-* 模型').toBe(true)
    expect(warnings.some((w) => w.includes('过滤')), '必须留一行 warn（否则线上「0 个模型」且无日志）').toBe(true)
  })
})

/**
 * ★★ **停滞续拉不得让「流式正文」与「落盘正文」分叉**（2026-10-22 对抗审计 A2，P0）。
 *
 * ## 修的三条真缺陷（同一处代码）
 *
 * ① 每层递归各有一份局部 `text` / `started` ⇒ 每层都发 `block-start(0)` 并追加
 *    `text-delta(0)`，而 `block-end` 只带**最后一层**的局部 `text`。而
 *    `BlockAssembler` 的 `block-end` 是 **first-close-wins**（`partial.block` 已存在
 *    就忽略）⇒ 最终 blocks 只有最后一段。
 *    实测（修复前）：流式累计 `"我先看看。已改好。已改好。已改好。"`，
 *    落盘 `"已改好。"` —— 用户截图/复制的内容与重开会话看到的不一致。
 * ② 第一轮正文**永久丢失**（它只出现在流里，从未进入任何 `block-end`），
 *    而注释还写着「第一轮已下发的正文**保留**」。
 * ③ 续拉请求**不带**上一轮 assistant 正文 ⇒ 模型看不到自己刚说过什么，
 *    只能重新生成（这也是 ① 的重复文本成因）。
 *
 * ## 判据为什么用**真实 `BlockAssembler`**（不是自己拼字符串）
 *
 * 「流式累计」与「组装结果」是否一致，只有真组装器说了算 —— 它的
 * `block-start` 幂等 + `block-end` first-close-wins 语义正是本缺陷的放大器。
 * 自己拼字符串会得到一个**恒真**的断言（两边都是我写的）。
 */
describe('Codely 停滞续拉：流式正文必须等于落盘正文', () => {
  /** 第 N 轮固定回一段短正文（触发 `stalled`：有工具 + 零调用 + 正文 < 500 字）。 */
  function adapterWithRounds(texts: string[], seenMessages: unknown[][]): CodelyAdapter {
    let round = 0
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/api-token/cli-api-key')) {
        return new Response(JSON.stringify({ cli_api_key: 'sk-x', user_id: 1 }), { status: 200 })
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: unknown[] }
      seenMessages.push(body.messages ?? [])
      const text = texts[Math.min(round, texts.length - 1)]!
      round += 1
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`
        + 'data: [DONE]\n\n',
        { status: 200 },
      )
    }) as never
    return new CodelyAdapter({
      credentialProvider: async () => ({ access_token: 't', refresh_token: 'r' } as never),
      fetchImpl,
    } as CodelyAdapterOptions)
  }

  const TOOLS = [{ name: 'write_file', description: 'w', parameters: { type: 'object', properties: {} } }]

  it('★★ 三轮都停滞 ⇒ 组装结果必须包含**全部**三轮正文（修复前只剩最后一轮）', async () => {
    const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
    const seen: unknown[][] = []
    const adapter = adapterWithRounds(['我先看看。', '已改好。', '已改好。', '已改好。'], seen)
    const assembler = new BlockAssembler()
    let streamed = ''
    for await (const chunk of adapter.stream({
      model: 'codely-flash',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
    } as never)) {
      assembler.push(chunk as never)
      if (chunk.type === 'text-delta') streamed += chunk.text
    }
    const blocks = (assembler as unknown as { blocks(): Array<{ type: string; text?: string }> }).blocks()
    const persisted = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')

    // ① 决定性断言：流式累计 == 落盘正文（修复前：前者 4 段、后者 1 段）
    expect(persisted, '流式正文与落盘正文必须逐字节一致（A2 原缺陷：只剩最后一轮）')
      .toBe(streamed)
    // ② 第一轮正文不得丢失（修复前它从未进入任何 block-end）
    expect(persisted, '第一轮正文「我先看看。」不得丢失').toContain('我先看看。')
    // ③ 整条流只能有一个 text 块（多轮各发 block-start(0) 是缺陷形态）
    expect(blocks.filter((b) => b.type === 'text').length, '整条流只能有一个 text 块').toBe(1)
  })

  it('★★ 续拉请求必须把上一轮 assistant 正文带进 messages（修复前不带 ⇒ 模型不知自己说过什么）', async () => {
    const seen: unknown[][] = []
    const adapter = adapterWithRounds(['我先看看。', '已改好。'], seen)
    for await (const _chunk of adapter.stream({
      model: 'codely-flash',
      messages: [{ role: 'user', content: 'go' }],
      tools: TOOLS,
    } as never)) { /* 消费完 */ }

    expect(seen.length, '必须真的发生了续拉（至少 2 轮）').toBeGreaterThanOrEqual(2)
    const second = seen[1] ?? []
    const hasAssistant = second.some((m) => {
      const role = (m as { role?: unknown }).role
      const content = (m as { content?: unknown }).content
      return role === 'assistant' && typeof content === 'string' && content.includes('我先看看。')
    })
    expect(hasAssistant, '第二轮 messages 必须含上一轮的 assistant 正文（A2 缺陷 ③）').toBe(true)
  })
})

/**
 * ★★ **推理与换发两个端点都必须带超时**（2026-10-22 对抗审计 A3）。
 *
 * ## 守的真缺陷
 *
 * `options.signal` 只在宿主**主动取消**时存在。用户不点「停止」时（最常见），
 * 两处 fetch 都**没有任何时限** ⇒ 上游半开连接 / 网关挂住 = 界面**永久转圈**，
 * 用户以为模型在思考。
 *
 * ⚠️ 而同文件其余 5 处（登录三步 / me / 目录 / 积分 / 签到）早就都带
 * `AbortSignal.timeout` —— 唯独「真正会长时间跑」的这两处漏了。
 * 这正是审计那轮「守卫只覆盖改动的那几行、不覆盖它依赖的调用链」的典型。
 *
 * ## 判据
 *
 * 直接读 `fetch` 的 `init.signal` —— 它是**唯一**可观测出口（超时本身不可测，
 * 除非真等 10 分钟）。同时断言两处的超时**不是同一个常量值**（推理必须更长）。
 */
describe('Codely 推理与换发必须带超时', () => {
  it('★★ 推理 POST 与换发 GET 都必须有 signal（用户不取消时也要有上限）', async () => {
    const signals: Array<{ url: string; signal: unknown }> = []
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    // ⚠️ try/finally（2026-10-31 审计 P3）：中途断言失败时 mockRestore 不执行，
    //    spy 会泄漏到整个文件（vitest 未开 restoreMocks）。与 auth-service 侧同款。
    try {
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        signals.push({ url, signal: init?.signal })
        if (url.includes('/api/api-token/cli-api-key')) {
          return new Response(JSON.stringify({ cli_api_key: 'sk-x' }), { status: 200 })
        }
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`
          + 'data: [DONE]\n\n',
          { status: 200 },
        )
      }) as never
      const adapter = new CodelyAdapter({
        credentialProvider: async () => ({ access_token: 't', refresh_token: 'r' } as never),
        fetchImpl,
      } as CodelyAdapterOptions)
      for await (const _chunk of adapter.stream({
        model: 'codely-flash',
        messages: [{ role: 'user', content: 'hi' }],
      } as never)) { /* 消费完 */ }

      const exchange = signals.find((s) => s.url.includes('/api/api-token/cli-api-key'))
      const chat = signals.find((s) => s.url.includes('/chat/completions'))
      expect(exchange, '必须真发过换发请求').toBeDefined()
      expect(chat, '必须真发过推理请求').toBeDefined()
      // ⚠️ 决定性断言：两处都必须有 signal（A3 原缺陷：两处都是 ABSENT）
      //
      // ⚠️ 只断言 `toBeDefined()` **锁不住任何东西**（与 `codely-auth-service.spec.ts`
      //    同型）：实现若改成传一个**永不超时**的 `new AbortController().signal`，
      //    这里照样全绿，而那正是本用例要防的 —— 上游挂住即永久转圈。
      //    ⇒ 拦住 `AbortSignal.timeout`，断言两处都真的挂了正数毫秒的超时。
      const timeoutCalls = timeoutSpy.mock.calls.map((args) => args[0])
      expect(timeoutCalls.length, '换发与推理各挂一次超时（不能只挂一处）').toBeGreaterThanOrEqual(2)
      for (const ms of timeoutCalls) {
        expect(ms, '超时期限必须是正数毫秒（0 / 负数等于立刻超时）').toBeGreaterThan(0)
      }
      for (const [name, entry] of [['换发', exchange], ['推理', chat]] as const) {
        expect(entry!.signal, `${name}请求必须带 signal`).toBeInstanceOf(AbortSignal)
        expect((entry!.signal as AbortSignal).aborted, `${name} signal 刚发出时不该是已中止`).toBe(false)
      }
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('★ 传入外部 signal 时仍要叠加超时（与 auth-service 侧同纪律；2026-10-31 对抗审计补）', async () => {
    const signals: Array<{ url: string; signal: unknown }> = []
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    try {
      const outer = new AbortController()
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        signals.push({ url, signal: init?.signal })
        if (url.includes('/api/api-token/cli-api-key')) {
          return new Response(JSON.stringify({ cli_api_key: 'sk-x' }), { status: 200 })
        }
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`
          + 'data: [DONE]\n\n',
          { status: 200 },
        )
      }) as never
      const adapter = new CodelyAdapter({
        credentialProvider: async () => ({ access_token: 't', refresh_token: 'r' } as never),
        fetchImpl,
      } as CodelyAdapterOptions)
      for await (const _chunk of adapter.stream({
        model: 'codely-flash',
        messages: [{ role: 'user', content: 'hi' }],
        signal: outer.signal,
      } as never)) { /* 消费完 */ }

      const chat = signals.find((s) => s.url.includes('/chat/completions'))
      expect(chat, '必须真发过推理请求').toBeDefined()
      // 实现是 AbortSignal.any([outer.signal, AbortSignal.timeout(ms)]) ⇒
      // 组合 signal ≠ 调用方 signal；换发与推理各挂一次 ⇒ spy 至少 2 次。
      expect(timeoutSpy.mock.calls.length, '外部 signal 之外仍要另挂 timeout（只透传 = 无上限）')
        .toBeGreaterThanOrEqual(2)
      expect(chat!.signal, '应是组合后的 signal，不得原样透传调用方那个').not.toBe(outer.signal)
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('★ 推理超时必须长于目录/登录那档（30s 撑不住正常长回答）', async () => {
    // 读源码常量：两个值不可相同（这是「共用一档」缺陷的判据）。
    const { readFileSync } = await import('node:fs')
    const adapterSrc = readFileSync(
      new URL('../../src/codely-adapter.ts', import.meta.url),
      'utf8',
    )
    const authSrc = readFileSync(
      new URL('../../src/codely-auth.ts', import.meta.url),
      'utf8',
    )
    const inference = /const CODELY_INFERENCE_TIMEOUT_MS = ([\d_]+)/.exec(adapterSrc)?.[1]
    const http = /export const CODELY_HTTP_TIMEOUT_MS = ([\d_]+)/.exec(authSrc)?.[1]
    expect(inference, '找不到 CODELY_INFERENCE_TIMEOUT_MS —— 判据锚点失效').toBeDefined()
    expect(http, '找不到 CODELY_HTTP_TIMEOUT_MS —— 判据锚点失效').toBeDefined()
    const inferenceMs = Number(inference!.replace(/_/g, ''))
    const httpMs = Number(http!.replace(/_/g, ''))
    expect(inferenceMs, '推理超时必须显著长于 30s 的目录/登录档（实测单次可跑数分钟）')
      .toBeGreaterThan(httpMs * 3)
  })
})

/**
 * ★★ **图片能力的两个出口必须同源**（2026-10-22 对抗审计 A4）。
 *
 * ## 守的真缺陷
 *
 * `toCatalogEntry`（目录腿）逐模型声明了实测能力，而
 * `unknownModelInputModalities`（`resolveModel` 对「目录里没有该 id」的兜底腿）
 * 恒报 `['text']`。两腿分叉 ⇒ **目录收缩时，实测能收图的模型被硬拒图片**：
 *
 * | 情形 | `resolveModel('codely-flash').inputModalities` |
 * |---|---|
 * | 目录里有它 | `['text','image']` ✅ |
 * | **目录收缩后不在** | `['text']` ❌（而它实测能收图） |
 *
 * DSH 对 `['text']` 的语义是**明确不支持**（把图投影成文本占位）⇒ 图**根本
 * 到不了适配器**，用户只看到「模型说它没看到图」。
 *
 * ⚠️ 这是 `docs/agent-notes/providers-codearts.md` 记过的**同一条形态**
 * （「只改 `toCatalogEntry` 恒无效」「`unknownModelInputModalities` 是第二条腿」）
 * —— codely 当时正好是**反过来的那一半**。
 *
 * ## 判据为什么必须「目录里没有它」
 *
 * 目录里有时走的是 `toCatalogEntry`（本来就对），**测不出**这个缺陷。
 * 必须先把远端目录收缩成一条，再 `resolveModel` 一个不在目录里但实测能收图的 id。
 */
describe('Codely 图片能力：目录腿与兜底腿必须同源', () => {
  function adapterWithShrunkCatalog(remoteIds: string[]): CodelyAdapter {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/api-token/cli-api-key')) {
        return new Response(JSON.stringify({ cli_api_key: 'sk-x' }), { status: 200 })
      }
      // 目录端点：只下发给定 id
      // ⚠️ 字段名必须是 `modelGroup`（上游原始报文形状，见 `codely-adapter.ts:1576`）
      //    —— 写成 `id` 会解析出 0 条 ⇒ 回退兜底表 ⇒ 「目录里没有它」这个前提不成立（判据会假绿）。
      return new Response(JSON.stringify({ models: remoteIds.map((modelGroup) => ({ modelGroup, status: 'active' })) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as never
    return new CodelyAdapter({
      credentialProvider: async () => ({ access_token: 't', refresh_token: 'r' } as never),
      fetchImpl,
    } as CodelyAdapterOptions)
  }

  it('★★ 目录收缩后，实测能收图的模型仍必须声明 image（修复前退化成 text）', async () => {
    // 远端只给 codely-core ⇒ codely-flash / codely-air 不在目录里
    const adapter = adapterWithShrunkCatalog(['codely-core'])
    await adapter.listModels().catch(() => undefined)

    for (const id of ['codely-flash', 'codely-air', 'codely-basic']) {
      // ⚠️ `resolveModel` 是 **(provider, model) 两个参数**（骨架签名）——
      //    只传一个会把 id 当成 provider、model 为 `undefined`，判据会**假绿**。
      const resolved = await adapter.resolveModel('codely', id).catch(() => undefined) as
        | { inputModalities?: readonly string[] }
        | undefined
      expect(resolved, `${id} 的 resolveModel 不该失败`).toBeDefined()
      expect(
        resolved!.inputModalities,
        `${id} 实测能收图（CODERLY_ABILITIES 白名单），目录里没有它时也必须声明 image —— `
        + '否则 DSH 把图投影成占位，图根本到不了适配器（A4 缺陷）',
      ).toContain('image')
    }
  })

  it('★ 反向对照：实测**不**收图的模型仍必须报 text（不得因为「同源」就一律放行）', async () => {
    const adapter = adapterWithShrunkCatalog(['codely-core'])
    await adapter.listModels().catch(() => undefined)

    for (const id of ['codely-core', 'codely-vl']) {
      // 实测：codely-core 回 400「Model only supports text」；codely-vl 收图反而 400
      // ⚠️ `resolveModel` 是 **(provider, model) 两个参数**（骨架签名）——
      //    只传一个会把 id 当成 provider、model 为 `undefined`，判据会**假绿**。
      const resolved = await adapter.resolveModel('codely', id).catch(() => undefined) as
        | { inputModalities?: readonly string[] }
        | undefined
      expect(resolved!.inputModalities, `${id} 实测不收图（拒图），必须报 text`).not.toContain('image')
    }
  })
})

/**
 * ★★ **`finish_reason` 的分类必须真的生效**（2026-10-22 对抗审计 M-13）。
 *
 * ## 守的真缺陷
 *
 * `finish_reason === 'length'` 必须报 `max-tokens`（让宿主知道“被截断了”，它会续写 / 压缩）。
 * 而实测：把该判据改成**恒假**，全部 28 条用例**仍然全绿** ——
 * 即「这件事根本没人守」。而它的真实后果是 2026-10-20 的报障：
 * 模型说「开始写游戏页面骨架：」后 12 秒静默结束、大段 HTML 没出来，
 * 而界面告诉用户的是“正常说完”。
 *
 * ## 判据为什么必须看 `finish.reason.kind`
 *
 * 它是唯一可观测出口（落盘与续写都由它驱动）。只断言“正文正确”是恒真的。
 */
describe('Codely finish_reason 分类', () => {
  function adapterWithFinish(finishReason: string | undefined): CodelyAdapter {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/api-token/cli-api-key')) {
        return new Response(JSON.stringify({ cli_api_key: 'sk-x' }), { status: 200 })
      }
      const choice: Record<string, unknown> = { delta: { content: 'ok' } }
      if (finishReason !== undefined) choice.finish_reason = finishReason
      return new Response(
        `data: ${JSON.stringify({ choices: [choice] })}\n\n` + 'data: [DONE]\n\n',
        { status: 200 },
      )
    }) as never
    return new CodelyAdapter({
      credentialProvider: async () => ({ access_token: 't', refresh_token: 'r' } as never),
      fetchImpl,
    } as CodelyAdapterOptions)
  }

  it('★★ length ⇒ max-tokens（宿主据此续写/压缩）', async () => {
    const kinds: unknown[] = []
    for await (const chunk of adapterWithFinish('length').stream({
      model: 'codely-flash', messages: [{ role: 'user', content: 'go' }],
    } as never)) {
      if (chunk.type === 'finish') kinds.push(chunk.reason.kind)
    }
    expect(kinds, 'finish_reason=length 必须报 max-tokens（否则用户只看到“说一半就没了”）')
      .toEqual(['max-tokens'])
  })

  it('★ stop ⇒ stop（不得把正常回答报成截断）', async () => {
    const kinds: unknown[] = []
    for await (const chunk of adapterWithFinish('stop').stream({
      model: 'codely-flash', messages: [{ role: 'user', content: 'go' }],
    } as never)) {
      if (chunk.type === 'finish') kinds.push(chunk.reason.kind)
    }
    expect(kinds).toEqual(['stop'])
  })
})

/**
 * ★★ **远端读到但为空 ≠ 成功**（2026-10-22 对抗审计 M-25）。
 *
 * `ensureRemoteModels` 的成功判据是 `models.length > 0`。把它去掉（空数组也算成功）
 * 后实测 **18 条全绿** ⇒ 无人守。而后果是：上游一旦返回空目录，
 * 模型选择器变成**一个模型都没有**（与「无账号」同形），而兜底表本可以兑底。
 */
describe('Codely 目录：远端空数组必须回退兜底表', () => {
  it('★★ 远端回 {models:[]} ⇒ listModels 仍有兜底表那几个模型', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/api-token/cli-api-key')) {
        return new Response(JSON.stringify({ cli_api_key: 'sk-x' }), { status: 200 })
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 })
    }) as never
    const adapter = new CodelyAdapter({
      credentialProvider: async () => ({ access_token: 't', refresh_token: 'r' } as never),
      fetchImpl,
    } as CodelyAdapterOptions)
    const models = await adapter.listModels()
    expect(
      models.length,
      '远端明明读到了但为空 ⇒ 必须回退兜底表（否则选择器一个模型都没有）',
    ).toBeGreaterThan(0)
  })

  /**
   * ⚠️⚠️ **上一条存在一层遮蔽（2026-10-22 自查发现）**：
   *
   * `catalogEntries()` 还有一道「**过滤后为空则回退兜底表**」的保底
   * （它本是为“远端全是公共模型”那个 P1 加的）；`listAllModels()` 走的
   * 也是同一条 `catalogEntries` ⇒ **两个公开出口都被遮蔽**。
   *
   * 实测：把 `ensureRemoteModels` 里的 `models.length === 0` 删掉（**空数组也算成功**），
   * 上一条仍然全绿 —— 因为空目录进了 `remoteModels`、过滤后为空、
   * 于是那道保底又把它兜回了兜底表。
   *
   * ## 判据为何改用 `onCatalogLoaded` 通知（两次订正后的结论）
   *
   * - 初版写「第二次 `listModels()` 应再请一次」—— 在**修复态**下就失败：
   *   `RemoteCatalogGate` 失败后**故意**置冷却防密集重试 ⇒ 那是设计正确行为；
   * - 二版写「计数 > 1」—— 与实际计数不符，**无牙**。
   *
   * ⇒ 用 **`onCatalogLoaded` 回调是否被调用**做判据：它**只在** `catalogGate.run`
   * 返回 `true`（真正落地了一份目录）时才发出 ⇒ 空数组若算成功就会
   * 多一次通知；算失败就一次也没有。这是行为判据（不读源码文本）。
   */
  it('★★ 远端空数组**不算读成功**（不得目录已加载）', async () => {
    let loaded = 0
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/api-token/cli-api-key')) {
        return new Response(JSON.stringify({ cli_api_key: 'sk-x' }), { status: 200 })
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 })
    }) as never
    const adapter = new CodelyAdapter({
      credentialProvider: async () => ({ access_token: 't', refresh_token: 'r' } as never),
      fetchImpl,
      onCatalogLoaded: () => { loaded += 1 },
    } as CodelyAdapterOptions)
    const models = await adapter.listModels()
    // ① 行为结果：必须回退兜底表（而不是 0 个模型）
    expect(models.length, '远端空数组 ⇒ 必须回退兜底表（否则选择器一个模型都没有）')
      .toBeGreaterThan(0)
    // ② 关键：空数组**不得**触发「目录已加载」通知
    expect(
      loaded,
      '空数组被当成「读成功」了 ⇒ 它应该算失败（否则一次抖动会把目录永久置空）',
    ).toBe(0)
  })
})
