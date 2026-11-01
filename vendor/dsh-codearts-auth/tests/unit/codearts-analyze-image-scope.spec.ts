/**
 * `analyzeImage` 的**路由作用域**守卫（2026-10-23 真实报障的修法）。
 *
 * ## 报障与修法（一句话）
 *
 * 该工具只服务 codearts 的纯文本模型，但工具注册是**进程全局**的 ⇒ 它进入了
 * **每一家**渠道发给上游的工具表；腾讯两站严格校验工具定义，于是
 * buddy/workbuddy 每轮 `400 invalid function call parameters`。
 * 真机 A/B：整份 280 工具清单原样 400、只把这个工具从表里摘掉就 200。
 * 取证链见 `src/codearts-vision.ts` 模块头与 `src/llm-adapter.ts` 的 `codeartsImagePart` 注释。
 *
 * ## 为什么这些用例走**注册期包装**而不是纯函数
 *
 * 缺陷曾经藏在「生产路径不走的那条腿」上（本仓老教训：只包 `stream` 会让包装
 * 在生产完全不生效、单测却全绿）。故这里**按 dsh-llm 的真实调用链驱动**：
 * `adapter.prepareCall(provider, model)` → `call.stream(options)`，
 * 并额外覆盖「直接调裸 `adapter.stream`」的诊断脚本路径。
 *
 * ## 三条纪律（本组用例逐条覆盖）
 *
 * 1. **该保留时对象身份不变**（宿主会拿工具表做「是否变化」判据，浅拷贝会造成假变化）；
 * 2. **只摘这一个工具**，其余（尤其官方 `read_image`）逐字透传；
 * 3. **路由取真实请求的 provider**：`options.provider` 优先、`prepareCall` 实参兜底
 *    （旧版宿主不带 options.provider 时不至于退回「注册 id[0]」而误摘）。
 */
import { describe, expect, it, vi } from 'vitest'
import { registerAdapterIdempotent } from '../../src/llm-register-compat.js'
import {
  ANALYZE_IMAGE_TOOL,
  stripAnalyzeImageTool,
  withAnalyzeImageScoping,
} from '../../src/codearts-vision.js'

const TOOLS = [
  { name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } },
  { name: ANALYZE_IMAGE_TOOL, description: '识图', parameters: { type: 'object', properties: {} } },
  { name: 'read_image', description: '官方识图', parameters: { type: 'object', properties: {} } },
] as const

/** 造一个把「实际收到的 options」记录下来的适配器替身。 */
function recordingAdapter(seen: unknown[]): Record<string, unknown> {
  const record = (options: unknown) => {
    seen.push(options)
    // ⚠️ 真的 yield 一次：记账包装 `recordThroughStream` 会**消费**这条流，
    //    空流迭代器不会被推进 → options 永不被观察到（这正是本组第一版
    //    「接线普查」用例失败的原因：`seen[0]` 是 undefined）。
    return (async function* () { yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } })()
  }
  return {
    // ⚠️ 这几个成员不是可选：记账包装与失效剔除包装都会读它们，缺一个就在注册期抛
    //    （形状参照 `tests/unit/token-ledger-wiring.spec.ts` 的真实替身）。
    providerInfo() { return { id: 'codearts', name: 'codearts' } },
    providerRetryPolicy() { return undefined },
    async listModels() { return [] },
    async resolveModel() { return { provider: 'codearts', id: 'm', name: 'm' } },
    async prepareCall() {
      return { config: { provider: 'codearts', model: 'x' }, stream: record }
    },
    stream: record,
  }
}

describe('analyzeImage 的路由作用域：纯函数 stripAnalyzeImageTool', () => {
  it('codearts + 文本模型 ⇒ 原样返回（同一对象引用，宿主不会看到假变化）', () => {
    const options = { provider: 'codearts', model: 'deepseek-v4.1-flash', tools: TOOLS as unknown as { name: string }[] }
    expect(stripAnalyzeImageTool(options)).toBe(options)
  })

  it('codearts + VL 模型 ⇒ 也摘掉（它自己就能看图，这个工具对它只是多余的一次往返）', () => {
    const options = { provider: 'codearts', model: 'kimi-k2.6-vl', tools: TOOLS as unknown as { name: string }[] }
    expect(stripAnalyzeImageTool(options).tools?.map((t) => t.name)).toEqual(['read', 'read_image'])
  })

  it('codearts + VL 模型（大小写变体）同样摘掉', () => {
    const options = { provider: 'codearts', model: 'KIMI-K2.6-VL', tools: TOOLS as unknown as { name: string }[] }
    expect(stripAnalyzeImageTool(options).tools?.map((t) => t.name)).toEqual(['read', 'read_image'])
  })

  it('非 codearts 路由 ⇒ 摘掉该工具，且**只**摘这一个', () => {
    const options = { provider: 'workbuddy', model: 'deepseek-v4.1-flash', tools: TOOLS as unknown as { name: string }[] }
    const next = stripAnalyzeImageTool(options)
    expect(next).not.toBe(options)
    expect(next.tools?.map((t) => t.name)).toEqual(['read', 'read_image'])
  })

  it('工具表里本来就没有它 ⇒ 原样返回（不做「空操作」的浅拷贝）', () => {
    const tools = [{ name: 'read' }, { name: 'read_image' }] as { name: string }[]
    const options = { provider: 'buddy', model: 'space-bunny', tools }
    expect(stripAnalyzeImageTool(options)).toBe(options)
  })

  it('路由不可解析 ⇒ 不摘（拿不准就别动工具表）', () => {
    const names = TOOLS.map((t) => t.name)
    // ⚠️ `shouldOfferAnalyzeImage` 对「provider 不是 codearts」也返回 false，而
    //    `stripAnalyzeImageTool` 把「不可解析」与「非 codearts」**合并**成同一格：
    //    对注册期包装而言这是**逐条等价**的 —— 拿不到 provider 的那一条永远来自
    //    某个具体 provider 的适配器，而包装会先用 `prepareCall` 实参把它填上。
    //    （若将来出现「provider 为空也真的要发给上游」的路径，这里会红。）
    const onlyModel = { model: 'deepseek-v4.1-flash', tools: TOOLS as unknown as { name: string }[] }
    expect(stripAnalyzeImageTool(onlyModel).tools?.map((t) => t.name)).toEqual(['read', 'read_image'])
    const onlyProvider = { provider: 'codearts', tools: TOOLS as unknown as { name: string }[] }
    expect(stripAnalyzeImageTool(onlyProvider).tools?.map((t) => t.name)).toEqual(['read', 'read_image'])
    // 同一次调用两次结果一致（纯函数，无隐藏状态）
    expect(stripAnalyzeImageTool(onlyModel)).toEqual(stripAnalyzeImageTool(onlyModel))
    // 工具表缺席时也照摘不误（不得凭空造出 tools 字段）
    expect(stripAnalyzeImageTool({ provider: 'buddy', model: 'm' }).tools).toBeUndefined()
    expect(names).toEqual(['read', ANALYZE_IMAGE_TOOL, 'read_image'])
  })
})

describe('analyzeImage 的路由作用域：注册期包装（按真实调用链驱动）', () => {
  it('生产路径 prepareCall → call.stream：codearts 保留、非 codearts 摘掉', async () => {
    const seen: unknown[] = []
    const proxy = withAnalyzeImageScoping(['workbuddy'], recordingAdapter(seen))

    const call = await (proxy.prepareCall as (p: string, m: string) => Promise<{ stream: (o: unknown) => unknown }>)(
      'workbuddy',
      'deepseek-v4.1-flash',
    )
    await call.stream({ provider: 'workbuddy', model: 'deepseek-v4.1-flash', tools: TOOLS as unknown as { name: string }[] })
    expect((seen[0] as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['read', 'read_image'])

    const codeartsCall = await (proxy.prepareCall as (p: string, m: string) => Promise<{ stream: (o: unknown) => unknown }>)(
      'codearts',
      'deepseek-v4.1-flash',
    )
    await codeartsCall.stream({ provider: 'codearts', model: 'deepseek-v4.1-flash', tools: TOOLS as unknown as { name: string }[] })
    expect((seen[1] as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['read', ANALYZE_IMAGE_TOOL, 'read_image'])
  })

  it('诊断脚本路径（直接调裸 adapter.stream）也摘（两处口径必须一致）', async () => {
    const seen: unknown[] = []
    const proxy = withAnalyzeImageScoping(['buddy'], recordingAdapter(seen))
    const it1 = (proxy.stream as (o: unknown) => AsyncIterable<unknown>)({
      provider: 'buddy', model: 'space-bunny', tools: TOOLS as unknown as { name: string }[],
    })
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    for await (const _ of it1) { /* 触发一次迭代即可 */ }
    expect((seen[0] as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['read', 'read_image'])
  })

  it('options.provider 缺席时回退到 prepareCall 实参（旧版宿主 ⇒ 不误摘 codearts）', async () => {
    const seen: unknown[] = []
    const proxy = withAnalyzeImageScoping(['codearts'], recordingAdapter(seen))
    const call = await (proxy.prepareCall as (p: string, m: string) => Promise<{ stream: (o: unknown) => unknown }>)(
      'codearts',
      'deepseek-v4.1-flash',
    )
    // 刻意**不带** provider：旧版宿主只给 model
    await call.stream({ model: 'deepseek-v4.1-flash', tools: TOOLS as unknown as { name: string }[] })
    expect((seen[0] as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['read', ANALYZE_IMAGE_TOOL, 'read_image'])
  })

  it('其余成员原样透传、且方法调用时 this 落在原对象（私有字段可读）', async () => {
    class Base {
      readonly #secret = 'ok'
      readSecret(): string { return this.#secret }
      plain(): string { return 'plain' }
    }
    const original = new Base()
    const proxy = withAnalyzeImageScoping(['buddy'], original)
    // Proxy 上的 `this.#secret` 会抛 TypeError —— 这里证明绑定没坏
    expect(proxy.readSecret()).toBe('ok')
    expect(proxy.plain()).toBe('plain')
    // 函数身份稳定（下游按身份缓存时不会每次拿到新函数）
    expect(proxy.readSecret).toBe(proxy.readSecret)
    expect(original).toBeInstanceOf(Base)
  })

  it('每个渠道的注册都被包上（接线普查：registerAdapterIdempotent 是唯一入口）', async () => {
    // ⚠️ 这一格要过**真实注册入口**，于是替身必须满足记账/失效剔除两层包装读到的
    //    全部成员（`providerInfo` / `providerRetryPolicy` / `listModels` /
    //    `prepareCall`），否则会在注册期就抛 —— 那正是「接线写错立刻炸」而非
    //    静默失效的期望形态（形状参照 tests/unit/token-ledger-wiring.spec.ts）。
    const seen: unknown[] = []
    const raw = recordingAdapter(seen)
    const registered: unknown[] = []
    const fakeLlm = {
      registerConfigurableProviders: () => undefined,
      registerAdapter: (providers: readonly string[], adapter: unknown) => {
        registered.push(providers.join(','), adapter)
        return () => undefined
      },
    }
    registerAdapterIdempotent(fakeLlm, ['workbuddy'], raw)
    expect(registered[0]).toBe('workbuddy')
    // 注册进去的那个对象必须是**包装后**的（能摘），而不是裸适配器
    const proxy = registered[1] as { prepareCall: unknown }
    const call = await (proxy.prepareCall as (p: string, m: string) => Promise<{ stream: (o: unknown) => AsyncIterable<unknown> }>)(
      'workbuddy',
      'm',
    )
    for await (const _ of call.stream({ provider: 'workbuddy', model: 'm', tools: TOOLS as unknown as { name: string }[] })) { /* 驱动 */ }
    expect((seen[0] as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['read', 'read_image'])

    // 反向对照（这格不能是恒真）：codearts 路由经**同一条**注册路径必须保留该工具
    const seen2: unknown[] = []
    const registered2: unknown[] = []
    registerAdapterIdempotent({
      registerConfigurableProviders: () => undefined,
      registerAdapter: (_providers: readonly string[], adapter: unknown) => {
        registered2.push(adapter)
        return () => undefined
      },
    }, ['codearts'], recordingAdapter(seen2))
    const call2 = await (registered2[0] as { prepareCall: (p: string, m: string) => Promise<{ stream: (o: unknown) => AsyncIterable<unknown> }> })
      .prepareCall('codearts', 'm')
    for await (const _ of call2.stream({ provider: 'codearts', model: 'm', tools: TOOLS as unknown as { name: string }[] })) { /* 驱动 */ }
    expect((seen2[0] as { tools: { name: string }[] }).tools.map((t) => t.name))
      .toEqual(['read', ANALYZE_IMAGE_TOOL, 'read_image'])
  })
})