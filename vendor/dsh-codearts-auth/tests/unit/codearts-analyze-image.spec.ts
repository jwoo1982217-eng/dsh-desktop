/**
 * `analyzeImage` 工具守卫（2026-10-21，用户诉求）。
 *
 * ## 为什么需要这个工具
 *
 * 用户原话：「继续做到 codearts 的只有文本的模型可以通过这个工具识图」，
 * 并明确「不需要直接选择 VL 模型（IDE 也不能选择）」。
 *
 * CodeArts 的文本模型（`glm-5.3` 等）**收不了图**（实测上游
 * `InferHub.001001020.406 The request model is not multimodal`），
 * 而 IDE 是两段式：挑一个 VL 模型看图 → 把文字交给主模型。
 *
 * ## ⚠️⚠️ 本文件守的最关键一件事：图片字节**不从 options.messages 拿**
 *
 * 纯文本模型发请求时，DSH 在 dispatch 前把图换成占位文字
 *（`dsh-llm/lib/index.js:2337`），适配器看到的已是文字。
 * 故工具必须从 `session.deriveMessages()`（**未投影**的派生历史）取 `attachment` 引用。
 *
 * ## 四条守卫
 *
 * | 守卫 | 若改坏 | 判据 |
 * |---|---|---|
 * | ① 只取**最后一条** user 消息的图 | 拿全历史 ⇒ 把上几轮的图也送去分析（答错图、费额度） | 造多轮带图历史，断言只拿到最后那轮 |
 * | ② 跳过 `offloaded` 块 | 送空图给上游 | 断言被排除 |
 * | ③ 路由判据：只给 codearts 的**文本**模型 | 给 VL 模型/别家也挂 ⇒ 多余往返或必然失败 | 四组输入逐格断言 |
 * | ④ 本轮没图时返回**可操作的文案** | 抛错或空串 ⇒ 模型不知道怎么办 | 断言含「重新附上」这类出路 |
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ANALYZE_IMAGE_DISABLE_ENV,
  ANALYZE_IMAGE_MAX_IMAGES,
  ANALYZE_IMAGE_TOOL,
  analyzeImageDisabledByEnv,
  collectTurnImages,
  imageDataUrl,
  installAnalyzeImage,
  runAnalyzeImage,
  shouldOfferAnalyzeImage,
  type AnalyzeImageDeps,
} from '../../src/analyze-image.js'
// ⚠️ 守卫 ⑪~⑬ 直接测共享序列化层（缺陷就在那一层，不在工具里）。
import { serializeMessages } from '../../src/openai-compat.js'
import {
  codeartsAcceptsImage,
  resetCodeartsImageModels,
  setCodeartsImageModels,
} from '../../src/codearts-vision.js'

/** 造一条带图的 user 消息。 */
function userWithImages(
  images: Array<{ id: string; offloaded?: boolean }>,
  text = '这是什么',
): { role: string; content: unknown[] } {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map((image) => ({
        type: 'image',
        ...image.offloaded === true ? { offloaded: true } : {},
        attachment: { attachmentId: image.id, mediaType: 'image/png', bytes: 8, width: 8, height: 8 },
      })),
    ],
  }
}

/** 造一个只提供 deriveMessages 的 exec。 */
function execWith(messages: readonly { role: string; content: unknown[] }[]) {
  return {
    signal: new AbortController().signal,
    agent: { session: { deriveMessages: () => messages } },
  }
}

describe('analyzeImage：从会话历史取图', () => {
  /**
   * 守卫 ①：**只取最后一条 user 消息**里的图。
   *
   * ⚠️ 这是有判别力的关键：如果实现「遍历全部历史」，用户在多轮对话里问
   * 「这张图是什么」时，前几轮的图会被一起送去分析 —— 既慢又费额度，
   * 且模型很可能对着第一张图回答（答错图）。
   */
  it('① 只取最后一条 user 消息的图（不把上几轮的图也送去分析）', () => {
    const messages = [
      { role: 'system', content: [{ type: 'text', text: 'SYS' }] },
      userWithImages([{ id: 'old-1' }, { id: 'old-2' }], '第一轮的图'),
      { role: 'assistant', content: [{ type: 'text', text: '好' }] },
      userWithImages([{ id: 'new-1' }], '第二轮的图'),
    ]
    const images = collectTurnImages(messages)
    expect(images.map((i) => i.attachmentId)).toEqual(['new-1'])
  })

  /**
   * 守卫 ②：**跳过 `offloaded` 块**。
   *
   * ⚠️ `offloaded` 是 DSH 为省 token 做的图片卸载，字节可能已不在本地。
   * 把它送去分析只会得到一张空图（上游可能报错，也可能让模型编造）。
   */
  it('② 跳过被 offload 的图片块（字节可能已不在本地）', () => {
    const messages = [
      userWithImages([{ id: 'gone', offloaded: true }, { id: 'here' }]),
    ]
    expect(collectTurnImages(messages).map((i) => i.attachmentId)).toEqual(['here'])
  })

  /** 守卫 ②b：最后一条 user 消息**没图**时，不往前翻（避免拿上一轮凑数）。 */
  it('②b 最后一条 user 消息没有图时返回空（不拿上一轮的图凑数）', () => {
    const messages = [
      userWithImages([{ id: 'old' }], '上一轮'),
      { role: 'user', content: [{ type: 'text', text: '纯文字提问' }] },
    ]
    expect(collectTurnImages(messages)).toEqual([])
  })
})

describe('analyzeImage：路由判据', () => {
  /**
   * 守卫 ③：**只给 codearts 的、收不了图的模型**挂这个工具。
   *
   * 四格逐格断言，缺一格都可能放过真缺陷：
   * - 别家 provider → 不挂（它们图片直发上游）；
   * - codearts + VL 模型 → 不挂（自己就能看，挂上是多余往返）；
   * - codearts + 文本模型 → **挂**（这正是本工具的用途）；
   * - 路由不可判定 → 不挂（宁可少个工具，也不挂个用不了的）。
   */
  it('③ 只给 codearts 的纯文本模型挂（四格）', () => {
    const accepts = (id: string) => id === 'kimi-k2.6-vl'
    // 别家 provider
    expect(shouldOfferAnalyzeImage('buddy', 'glm-5.3', accepts)).toBe(false)
    // codearts + VL 模型
    expect(shouldOfferAnalyzeImage('codearts', 'kimi-k2.6-vl', accepts)).toBe(false)
    // codearts + 文本模型 ← 本工具的用途
    expect(shouldOfferAnalyzeImage('codearts', 'glm-5.3', accepts)).toBe(true)
    // 路由不可判定
    expect(shouldOfferAnalyzeImage(undefined, 'glm-5.3', accepts)).toBe(false)
    expect(shouldOfferAnalyzeImage('codearts', undefined, accepts)).toBe(false)
    expect(shouldOfferAnalyzeImage('codearts', '', accepts)).toBe(false)
  })

  /** 守卫 ③b：用**真实的** codearts 能力判据时，glm-5.3 命中、VL 模型不命中。 */
  it('③b 默认判据下 glm-5.3 需要工具、kimi-k2.6-vl 不需要', () => {
    expect(shouldOfferAnalyzeImage('codearts', 'glm-5.3')).toBe(true)
    expect(shouldOfferAnalyzeImage('codearts', 'kimi-k2.6-vl')).toBe(false)
    expect(shouldOfferAnalyzeImage('codearts', 'Qwen3-VL-235B')).toBe(false)
  })

  /**
   * 守卫 ③c：**「能收图」与「不需要识图工具」是两回事**（2026-10-26 报障）。
   *
   * `kimi-k3` 这类新一代多模态主模型两头都沾：目录标了 `supports_images` ⇒ 能直接
   * 收图；但它**不是**专用 VL 模型 ⇒ 仍然要挂 `analyzeImage`。
   *
   * 旧判据写作 `!accepts(model)`（「收不了图才挂」）—— 对老模型恰好等价，
   * 一遇到 `kimi-k3` 就判成「不需要工具」，于是它只有直发、没有识图工具可用。
   *
   * ⚠️ 有牙：把 `shouldOfferAnalyzeImage` 改回 `!accepts(model)` ⇒ 第 2 条断言变红。
   */
  it('③c 能收图但非专用 VL 的模型仍要挂工具（kimi-k3）', () => {
    try {
      setCodeartsImageModels(['kimi-k3'])
      expect(codeartsAcceptsImage('kimi-k3'), '前提：它确实能收图').toBe(true)
      expect(
        shouldOfferAnalyzeImage('codearts', 'kimi-k3'),
        '能收图 ≠ 不需要工具：仍须挂 analyzeImage',
      ).toBe(true)
      // 专职 VL 模型仍然不挂（它们自己就是拿来识图的）
      expect(shouldOfferAnalyzeImage('codearts', 'kimi-k2.6-vl')).toBe(false)
      expect(shouldOfferAnalyzeImage('codearts', 'Qwen3-VL-235B')).toBe(false)
    } finally {
      // ⚠️ 能力集合是模块级单例，不清理会泄漏到别的测试文件
      resetCodeartsImageModels()
    }
  })
})

describe('analyzeImage：执行路径', () => {
  /**
   * 守卫 ④：本轮没图时返回**可操作的文案**（不抛错、不返回空串）。
   *
   * ⚠️ 这条文案是**给模型看的出路**：让它去请用户重新发图，
   * 而不是反复重试这个工具（本仓对「文案本身就是出路」的错误一贯如此处理）。
   */
  it('④ 本轮没有图片时返回可操作的文案，而不是抛错或空串', async () => {
    const deps: AnalyzeImageDeps = {
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      describe: async () => '（不该被调用）',
    }
    const result = await runAnalyzeImage(execWith([{ role: 'user', content: [{ type: 'text', text: '你好' }] }]), deps)
    expect(result).toContain('没有找到图片')
    expect(result).toContain('重新附上')
  })

  /** 守卫 ⑤：**正常路径**把 data URL 交给 describe，并把结果原样返回。 */
  it('⑤ 有图时把 data URL 交给识图模型，并返回它的文字', async () => {
    let seen: readonly string[] = []
    let seenPrompt = ''
    const deps: AnalyzeImageDeps = {
      readImage: async () => ({ data: new Uint8Array([0x89, 0x50]), mediaType: 'image/png' }),
      describe: async (urls, prompt) => { seen = urls; seenPrompt = prompt; return '图里有一只猫' },
    }
    const result = await runAnalyzeImage(execWith([userWithImages([{ id: 'a' }])]), deps)
    expect(result).toBe('图里有一只猫')
    expect(seen).toHaveLength(1)
    // ⚠️ 必须是 data URL（上游只认这个形态，见 `codeartsImagePart` 的注释）。
    expect(seen[0]!.startsWith('data:image/png;base64,')).toBe(true)
    // 提示词要求「看不清就说看不清」，抑制 VL 模型编造（本仓有过幻觉实例）。
    expect(seenPrompt).toContain('不要编造')
  })

  /** 守卫 ⑥：**单张读失败不拖垮整次调用**，但要在结果里如实点名。 */
  it('⑥ 部分图片读不到字节时仍分析其余，并如实点名缺了几张', async () => {
    let calls = 0
    const deps: AnalyzeImageDeps = {
      readImage: async () => {
        calls += 1
        if (calls === 1) throw new Error('附件已被清理')
        return { data: new Uint8Array([1]), mediaType: 'image/png' }
      },
      describe: async () => '描述',
    }
    const result = await runAnalyzeImage(execWith([userWithImages([{ id: 'a' }, { id: 'b' }])]), deps)
    expect(result).toContain('描述')
    expect(result).toContain('1 张读不到字节')
  })

  /** 守卫 ⑦：**全部**读不到时给出明确出路（而不是把空数组交给上游）。 */
  it('⑦ 全部图片都读不到字节时不让上游白跑一趟', async () => {
    let describeCalled = false
    const deps: AnalyzeImageDeps = {
      readImage: async () => { throw new Error('nope') },
      describe: async () => { describeCalled = true; return '' },
    }
    const result = await runAnalyzeImage(execWith([userWithImages([{ id: 'a' }])]), deps)
    expect(describeCalled).toBe(false)
    expect(result).toContain('重新发送图片')
  })

  /** 守卫 ⑧：超过单次上限时**拒绝**（防止模型一次塞几十张把上游打爆）。 */
  it('⑧ 超过单次图片上限时拒绝并给出出路', async () => {
    const deps: AnalyzeImageDeps = {
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: 'image/png' }),
      describe: async () => '描述',
    }
    const many = Array.from({ length: ANALYZE_IMAGE_MAX_IMAGES + 1 }, (_, i) => ({ id: `i${i}` }))
    await expect(runAnalyzeImage(execWith([userWithImages(many)]), deps))
      .rejects.toThrow(/超过单次上限/)
  })

  /** 守卫 ⑨：`imageDataUrl` 形态（上游只认 base64 data URL）。 */
  it('⑨ imageDataUrl 产出 base64 data URL', () => {
    expect(imageDataUrl(new Uint8Array([0xff, 0x00]), 'image/webp'))
      .toBe('data:image/webp;base64,/wA=')
  })

  /** 工具名与 IDE 同名（模型在 IDE 语境下已熟悉）。 */
  it('⑩ 工具名是 analyzeImage（与 IDE 同名）', () => {
    expect(ANALYZE_IMAGE_TOOL).toBe('analyzeImage')
  })
})

/**
 * ⚠️⚠️ **已拼好的 `image_url` 块必须能穿过序列化层**（2026-10-22 真实缺陷）。
 *
 * ## 缺陷经过（真机验收时发现，不是审计想出来的）
 *
 * `analyzeImage` 的识图请求由**插件自己**构造：`describeWithVision` 把图片拼成
 * 上游要的 `{type:'image_url', image_url:{url}}` 后交给 `adapter.stream()`。
 * 而共享序列化器 `userContentParts` 当时**只认 harness 原生**
 * `{type:'image', attachment}`（去 `imageUrls` 表里查字节），对 `image_url`
 * **零命中** ⇒ 该块被**静默丢弃**。
 *
 * 症状极具误导性：HTTP 200、正文正常、上游无任何报错，只是 VL 模型回答
 * 「我看不到图片」—— 因为图确实没发出去。
 *
 * 另有一处同因的门禁：`serializeMessages` 里 `imageUrls === undefined` 时
 * **整段跳过** `userContentParts`，而识图请求**不传** `imageUrls` ⇒ 即使认了
 * `image_url` 也走不到。两处必须同修。
 *
 * ## 为什么原有用例没抓到
 *
 * 它们只测 `{type:'image', attachment}` 这条路（配 `imageUrls` 表）。
 * 「已拼好的块」是**另一条入口**，没有断言 ⇒ 缺陷从缝里漏过。
 */
describe('analyzeImage：已拼好的 image_url 必须穿过序列化层（真实缺陷）', () => {
  const url = 'data:image/png;base64,iVBORw0KGgo='

  /**
   * 守卫 ⑪：**不传 `imageUrls`**（识图请求的真实形态）时，`image_url` 块仍要到达 wire。
   *
   * ⚠️ 判据是「wire 里出现了那个 url」，不是「没报错」——后者恒真。
   */
  it('⑪ 不传 imageUrls 时 image_url 块仍出现在 wire 里', () => {
    const wire = serializeMessages([{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url } },
        { type: 'text', text: '这是什么颜色？' },
      ],
    }])
    const userMessage = wire.find((m) => m['role'] === 'user') as { content: unknown }
    const parts = userMessage.content as Array<{ type: string; image_url?: { url?: string }; text?: string }>
    expect(Array.isArray(parts)).toBe(true)
    // ⚠️ 判别力就在这里：块被丢弃时 parts 里只剩 text。
    expect(parts.some((p) => p.type === 'image_url' && p.image_url?.url === url)).toBe(true)
    expect(parts.some((p) => p.type === 'text' && p.text === '这是什么颜色？')).toBe(true)
  })

  /**
   * 守卫 ⑫：**原生 `{type:'image'}` 路径逐字节不变**（回归）。
   *
   * ⚠️ 修 ⑪ 时动了 `imageUrls === undefined` 那条门禁，必须证明老路径没被带坏。
   */
  it('⑫ 原生 image 块（配 imageUrls）仍产出 image_url', () => {
    const wire = serializeMessages([{
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png' } },
        { type: 'text', text: '看图' },
      ],
    }], new Map([['att-1', url]]))
    const userMessage = wire.find((m) => m['role'] === 'user') as { content: unknown }
    const parts = userMessage.content as Array<{ type: string; image_url?: { url?: string } }>
    expect(parts.some((p) => p.type === 'image_url' && p.image_url?.url === url)).toBe(true)
  })

  /**
   * 守卫 ⑬：**纯文本消息仍是字符串形态**（上游会 400 拒收包装形态）。
   *
   * ⚠️ 这条防的是「为了修图片而把所有消息都包装成 parts」——实测上游
   * `model_param_invalid` 400 拒收整个请求。
   */
  it('⑬ 纯文本 user 消息仍保持字符串 content（不因本次修复被包装）', () => {
    const wire = serializeMessages([{ role: 'user', content: [{ type: 'text', text: '只有文字' }] }])
    const userMessage = wire.find((m) => m['role'] === 'user') as { content: unknown }
    expect(typeof userMessage.content).toBe('string')
    expect(userMessage.content).toBe('只有文字')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 工具注册：`output.schema` 必须过宿主的真实校验器（Gitee IKPZW7）
// ────────────────────────────────────────────────────────────────────────────

const requireFromTest = createRequire(import.meta.url)

/**
 * 定位宿主的 `@deepseek-ai/dsh-tools`。
 *
 * 搜索顺序（命中即返回）：① 本仓库依赖树；② 全局安装；③ 用户 profile
 * （共享层在前、逐 profile 层在后 —— 本机实测宿主包在 `profiles/node_modules`）。
 *
 * ⚠️ 本仓库 devDependencies **不含** `dsh-tools`（见模块头「本插件不依赖该包」），
 * 故干净克隆 / CI 下定位不到 ⇒ 本组用例整体 skip，**不是**通过。
 *
 * @returns 该包 `lib/index.js` 的绝对路径；找不到则 `null`。
 */
function locateDshTools(): string | null {
  const candidates: string[] = []
  try {
    const pkg = requireFromTest.resolve('@deepseek-ai/dsh-tools/package.json')
    candidates.push(join(dirname(pkg), 'lib', 'index.js'))
  } catch {
    // 未从本仓库解析到，继续看别处
  }
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? homedir()
  const dshHome = process.env['DSH_HOME'] ?? join(home, '.dsh')
  const roots = [
    join(dirname(process.execPath), 'node_modules'),
    join(dshHome, 'profiles', 'node_modules'),
    ...['web', 'desktop', 'tui', 'headless', 'default'].map(p => join(dshHome, 'profiles', p, 'node_modules')),
    // 全局 `@deepseek-ai/dsh` 自带一层 `node_modules/@deepseek-ai/*`
    join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
  ]
  for (const root of roots) {
    const entry = join(root, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
    if (existsSync(entry)) candidates.push(entry)
  }
  return candidates.find(p => existsSync(p)) ?? null
}

const dshToolsEntry = locateDshTools()

/**
 * 从真实安装位置 import 宿主的 `dsh-tools`。
 *
 * ⚠️ 用**绝对 file URL**：该包在仓库外，Vite 的模块图解析对裸标识符不适用。
 */
async function importDshTools(): Promise<{
  assertSupportedJsonSchema: (schema: unknown) => void
  validateJsonSchemaValue: (schema: unknown, value: unknown, path: string) => string[]
}> {
  return await import(/* @vite-ignore */ pathToFileURL(dshToolsEntry!).href) as never
}

/** `installAnalyzeImage` 捕获到的工具字面量（只取本组断言用到的字段）。 */
interface CapturedTool {
  name: string
  parameters: unknown
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => unknown }
}

/**
 * 用**真实宿主校验器**跑一次注册，返回捕获到的工具。
 *
 * ⚠️ 这里刻意**复刻 `ToolRuntime.register()` 的校验顺序**（`dsh-tools/lib/index.js`
 * 的 `register()`：先查 `output { schema, render }` 形状，再
 * `assertSupportedJsonSchema(output.schema)`，然后才 insert）。复刻的理由是本插件
 * 不依赖该包、拿不到 `ToolRuntime` 实例；但**校验器本身是宿主那一份真货**，
 * 不是手写的近似判据 —— 手写正则/结构断言抓不到「关键字放在错类型的节点上」。
 *
 * @param assertSupported - 宿主的 `assertSupportedJsonSchema`
 * @returns 捕获到的工具字面量
 * @throws 宿主校验器抛出的 `JsonSchemaError`（原样，不吞）
 */
/** 跑一次接线、返回捕获到的工具（**不**跑宿主 schema 校验）。 */
function registerCapturing(log?: { info?: (message: string) => void }): CapturedTool | undefined {
  let captured: CapturedTool | undefined
  const scope = {
    tools: {
      register(tool: CapturedTool) {
        const output = tool.output
        if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
          throw new TypeError(`tool "${tool.name}" must declare output { schema, render, presentationMeta? }`)
        }
        captured = tool
      },
    },
    attachments: {},
  }
  const ctx = {
    inject(_deps: string[], callback: (s: unknown) => void) { callback(scope) },
  }
  installAnalyzeImage(
    ctx as never,
    { readImage: async () => ({ data: new Uint8Array(), mediaType: 'image/png' }), describe: async () => 'x' },
    () => undefined,
    log,
  )
  return captured
}

function registerWithRealValidator(
  assertSupported: (schema: unknown) => void,
): CapturedTool {
  let captured: CapturedTool | undefined
  const scope = {
    tools: {
      register(tool: CapturedTool) {
        const output = tool.output
        if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
          throw new TypeError(`tool "${tool.name}" must declare output { schema, render, presentationMeta? }`)
        }
        assertSupported(output.schema)
        captured = tool
      },
    },
    attachments: {},
  }
  const ctx = {
    inject(_deps: string[], callback: (s: unknown) => void) { callback(scope) },
  }
  installAnalyzeImage(
    ctx as never,
    { readImage: async () => ({ data: new Uint8Array(), mediaType: 'image/png' }), describe: async () => 'x' },
    () => undefined,
    { info: () => undefined },
  )
  if (captured === undefined) throw new Error('installAnalyzeImage 没有注册任何工具')
  return captured
}

/**
 * ⚠️⚠️ **Gitee IKPZW7**：`output.schema` 曾把 `required: true` 写在
 * `type: 'string'` 的子节点上（`properties.description`）。
 *
 * ## 为什么原有 15 条用例全绿却漏掉它
 *
 * 它们**没有一条调用 `installAnalyzeImage`** —— 全部只测纯函数
 * （`collectTurnImages` / `shouldOfferAnalyzeImage` / `runAnalyzeImage` /
 * `imageDataUrl`）。工具字面量是**注册那一刻**才被宿主校验的，而不测注册就永远
 * 看不到这条错误。典型「守卫看着有牙、实际没咬到」。
 *
 * ## 缺陷后果（本机实测）
 *
 * 宿主 `dsh-tools/lib/index.js` 的 `checkSchemaNode()` 有一张「关键字 → 允许类型」
 * 对照表，其中 `required: ['object']`；逐节点检查后抛
 * `JsonSchemaError: unsupported JSON schema: schema.properties.description.required
 * is not supported on type "string"` ⇒ `tools.register()` 抛错 ⇒ 该 `ctx.inject`
 * 子插件整体失败 ⇒ **`analyzeImage` 静默消失**（其余渠道与调度器不受影响，
 * 因为 `installAnalyzeImage` 是独立注入的）。
 *
 * ## 判别力
 *
 * 判据打在**宿主那一份真校验器**上：把 `required` 挪回 `properties.description`
 * 内部，第 ⑭ 条立刻变红（实测：`JsonSchemaError: … is not supported on type "string"`）。
 * 若只断言「`required` 是数组」这类结构形状，错位的写法也能通过 ⇒ 那是恒真断言。
 */
describe.skipIf(dshToolsEntry === null)('analyzeImage：工具注册必须过宿主真实 schema 校验（IKPZW7）', () => {
  /** 防止「宿主包没定位到 → 整组静默 skip」被误读成「验证通过」。 */
  it('宿主 dsh-tools 已定位（否则本组整体 skip，不是通过）', () => {
    expect(dshToolsEntry).not.toBeNull()
    expect(existsSync(dshToolsEntry!)).toBe(true)
  })

  /**
   * 守卫 ⑭：**注册本身不得抛错**，且 `output.schema` 能过宿主的
   * `assertSupportedJsonSchema`。
   *
   * ⚠️ 这条是缺陷的**直接判据** —— 缺陷态下它抛 `JsonSchemaError`。
   */
  it('⑭ 注册成功：output.schema 过宿主 assertSupportedJsonSchema（缺陷态此处抛 JsonSchemaError）', async () => {
    const { assertSupportedJsonSchema } = await importDshTools()
    const tool = registerWithRealValidator(assertSupportedJsonSchema)
    expect(tool.name).toBe('analyzeImage')
    // 再独立校验一次：证明「注册成功」不是因为桩放宽了校验。
    expect(() => assertSupportedJsonSchema(tool.output.schema)).not.toThrow()
  })

  /**
   * 守卫 ⑮：**`required` 的位置与语义都对**。
   *
   * 两件事必须同时成立，缺任一条都不是正确修法：
   * 1. 位置：`required` 在 **object 根节点**上、是 `['description']`，而
   *    `properties.description` 里**没有** `required` 这个键（错位写法在这里被点名）；
   * 2. 语义：宿主的 `validateJsonSchemaValue()` 真按它判 —— 缺 `description`
   *    报 `missing required property`，`description` 不是字符串报类型错，
   *    正常值零违规。
   *
   * ⚠️ 只断言第 1 条是不够的：把 `required` 删干净（而不是挪对位置）也能通过位置
   * 断言，但工具就变成「可以返回空对象」—— 第 2 条把这条路堵住。
   */
  it('⑮ required 在 object 根节点、且真被宿主校验器执行（缺字段即违规）', async () => {
    const { assertSupportedJsonSchema, validateJsonSchemaValue } = await importDshTools()
    const tool = registerWithRealValidator(assertSupportedJsonSchema)
    const schema = tool.output.schema

    // ① 位置：根节点是 object，required 是字符串数组且只点名 description。
    expect(schema['type']).toBe('object')
    expect(schema['required']).toEqual(['description'])
    // ② 位置：子节点里**不得**出现 required（缺陷就是写在这）。
    const properties = schema['properties'] as Record<string, Record<string, unknown>>
    expect(properties['description']).toEqual({ type: 'string' })
    expect(Object.hasOwn(properties['description']!, 'required')).toBe(false)

    // ③ 语义：宿主校验器真按 required 判（不是「声明了但没人读」）。
    expect(validateJsonSchemaValue(schema, { description: '一只猫' }, '')).toEqual([])
    expect(validateJsonSchemaValue(schema, {}, ''))
      .toContain('missing required property "description"')
    expect(validateJsonSchemaValue(schema, { description: 1 }, ''))
      .toContain('"description" must be a string')
    // ④ `additionalProperties: false` 仍在（多返回字段要被拒，避免模型塞垃圾）。
    expect(schema['additionalProperties']).toBe(false)
    expect(validateJsonSchemaValue(schema, { description: 'x', extra: 1 }, '')).toHaveLength(1)
  })

  /**
   * 守卫 ⑯：`parameters` 必须是**完整的空对象 schema**，且既过宿主校验、也过上游校验。
   *
   * ⚠️⚠️ **这一格在 2026-10-23 被推翻重写**，原因值得记住：
   *
   *   - **旧版断言 `toEqual({})` 是错的**，它把一个真实缺陷**钉死**了：注释写着
   *     「空对象就是正确形态、别顺手补齐」，依据是宿主校验器
   *     `assertSupportedJsonSchema({})` 不抛错 ⇒ **19 条全绿，而 buddy/workbuddy
   *     每轮 400**。
   *   - **「宿主接受」≠「上游接受」**：空 `{}` 过得了宿主那一格，但腾讯两站
   *     （`copilot.tencent.com` / `www.workbuddy.ai`）会校验工具定义并回
   *     `{"code":11129,"msg":"invalid function call parameters"}`。
   *     真机 A/B（`scripts/probe-buddy-tool-schema.mts`，两站各自复现）：
   *     `{}` → 400，`{type:'object',properties:{}}` → 200；整份 280 工具清单只改
   *     这一处就从 400 变 200。
   *
   * ⇒ 所以这里**两个判据都要有**：宿主那一格（证明注册不会中断）**与**
   * 「声明了 object 类型」（证明上游会收）。缺任一条都抓不住这次的回归 ——
   * 只保留宿主那格 = 旧版的假绿。
   */
  it('⑯ parameters 是完整的空对象 schema：既过宿主校验、也满足上游的 object 类型要求', async () => {
    const { assertSupportedJsonSchema } = await importDshTools()
    const tool = registerWithRealValidator(assertSupportedJsonSchema)

    // ① 本工具**不接受任何参数**（图片从会话历史取）⇒ 必须是零属性的 object。
    expect(tool.parameters).toEqual({ type: 'object', properties: {} })
    // ② 过宿主校验（否则 `tools.register()` 中断、工具静默消失）。
    expect(() => assertSupportedJsonSchema(tool.parameters)).not.toThrow()
    // ③ 声明了 object 类型 —— 这一格**只能由真实上游报文固定**，单测锁不住
    //    「腾讯到底收哪种形状」（见文件头与 scripts/probe-buddy-tool-schema.mts）。
    expect((tool.parameters as { type: string }).type).toBe('object')
    // ④ 反向对照：`{}`（旧版形状）**不满足**这一格 —— 若哪天实现退回空对象，
    //    这一格会红，而不是再次「19 条全绿 + 上游 400」。
    expect(({} as { type: string }).type).not.toBe('object')
  })
})

/**
 * 应急闸 `DSH_DISABLE_ANALYZE_IMAGE`（2026-10-23，用户要求「临时禁用」）。
 *
 * ## 为什么要「不注册」而不是「请求时摘除」
 *
 * 作用域摘除（`codearts-vision.ts`）只改**发给上游的 options**，harness 侧的
 * 工具表（落盘 `request/header` 里的那份）仍含该工具 ⇒ 用户在界面上看到的
 * `tools=281 / analyzeImage=true` 不变，无法用它验证「工具数是否是慢的成因」。
 * 应急闸走**注册期**：关闸时工具根本不存在，任何一侧都干净。
 */
describe('analyzeImage 的应急禁用闸', () => {
  it('闸关着 ⇒ 根本不注册，且**必须留一条日志**', () => {
    const lines: string[] = []
    const before = process.env[ANALYZE_IMAGE_DISABLE_ENV]
    process.env[ANALYZE_IMAGE_DISABLE_ENV] = '1'
    try {
      const captured = registerCapturing({ info: (m) => lines.push(m) })
      expect(captured, '闸关着时不得注册任何工具').toBeUndefined()
    } finally {
      if (before === undefined) delete process.env[ANALYZE_IMAGE_DISABLE_ENV]
      else process.env[ANALYZE_IMAGE_DISABLE_ENV] = before
    }
    // ⚠️ 这格是「关闸」与「注册静默失败」的**唯一**区别（本工具栽过一次：
    //    `tools.register()` 因 schema 不合法中断 ⇒ 工具消失、**日志零字**）。
    //    没有它，「工具不见了」与「闸关着」同形，无法排查。
    expect(lines.join('\n')).toContain(ANALYZE_IMAGE_DISABLE_ENV)
  })

  it('闸未设 / 取值不认 ⇒ 正常注册（不得把工具误关）', () => {
    const before = process.env[ANALYZE_IMAGE_DISABLE_ENV]
    try {
      for (const value of [undefined, '', '0', 'false', 'no', 'off']) {
        if (value === undefined) delete process.env[ANALYZE_IMAGE_DISABLE_ENV]
        else process.env[ANALYZE_IMAGE_DISABLE_ENV] = value
        expect(registerCapturing()?.name, `取值 ${JSON.stringify(value)} 应当照常注册`).toBe(ANALYZE_IMAGE_TOOL)
      }
    } finally {
      if (before === undefined) delete process.env[ANALYZE_IMAGE_DISABLE_ENV]
      else process.env[ANALYZE_IMAGE_DISABLE_ENV] = before
    }
  })

  it('取值判据：1/true/yes 大小写不敏感，其余（含 2/on）都不关', () => {
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'Yes']) {
      expect(analyzeImageDisabledByEnv({ [ANALYZE_IMAGE_DISABLE_ENV]: v }), `取值 ${JSON.stringify(v)} 应当关闸`).toBe(true)
    }
    for (const v of [undefined, '', '0', 'false', '2', 'on', 'enabled', 'no']) {
      expect(analyzeImageDisabledByEnv({ [ANALYZE_IMAGE_DISABLE_ENV]: v }), `取值 ${JSON.stringify(v)} 不该关闸`).toBe(false)
    }
    // 反向对照：老写法 `=== '1'` 会把 'true'/'yes' 判成「没关」⇒ 用户设了却仍在跑
    expect('true' === '1').toBe(false)
  })
})
