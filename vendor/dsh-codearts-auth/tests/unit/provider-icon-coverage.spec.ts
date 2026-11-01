import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../helpers/strip-comments.js'

/**
 * 供应商图标覆盖：凡是列出**供应商**或**模型**的地方，行首都要有那家的图标。
 *
 * 用户 2026-10-26 要求：「给所有页面供应商和模型左侧 + 供应商图标」。
 *
 * ⚠️ 这个改动最危险的失效模式是**静默的**：`ProviderLogo` 在找不到 provider
 *    时 `return null`（这是对的 —— 未知 provider 不该炸）。于是「忘了把
 *    provider 传进 ModelToggle」这种漏接**不会报错、不会白屏**，只是那一处
 *    列表从此没有图标，肉眼还要逐页翻才能发现。
 *    故钉子全部钉在「**传参是否到位**」上，而不是「组件内有没有画图标」。
 *
 * 组件无法在本仓库单测里渲染（react 不在依赖内），故只能做源码文本断言。
 */

function source(relative: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(resolve(here, '../..', relative), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * ⚠️ 必须剥注释后再断言：本次改动**在注释里大量讨论 ProviderLogo**
 *    （解释为什么图标要放行首、为什么尺寸要就地收窄）。直接在原文上做字面
 *    搜索会命中注释而恒绿 —— 本仓库记过这类「注释诱饵」不止一次。
 */
function hubCode(): string {
  return stripComments(source('plugin-src/client/jet-hub.js'))
}

/**
 * 样式表整体是一个 JS 模板字符串。这里**刻意不 stripComments** ——
 * `stripComments` 按 JS 语法工作，会把模板字符串里合法的 CSS 注释一起吃掉，
 * 也可能误伤 CSS 内容；而下面的断言用的是**完整规则串**，
 * 注释里不可能出现同样的一整串（注释只写类名，不写整条声明）。
 */
function styleSource(): string {
  return source('plugin-src/client/jet-hub-styles.js')
}

/** 取 `React.createElement(ModelToggle, { ... })` 的全部调用体。 */
function modelToggleCalls(code: string): string[] {
  return [...code.matchAll(/React\.createElement\(ModelToggle,\s*\{([\s\S]*?)\}\)/g)]
    .map(m => m[1]!)
}

describe('供应商图标 · 覆盖率', () => {
  it('ProviderLogo 对未知 provider 返回 null（容错，不得抛错或画空框）', () => {
    const code = hubCode()
    const at = code.indexOf('function ProviderLogo(')
    expect(at, 'ProviderLogo 不见了').toBeGreaterThan(-1)
    const body = code.slice(at, code.indexOf('function formatTime(', at))
    expect(body, '未知 provider 必须返回 null —— 图标是装饰，不该让整行炸掉')
      .toMatch(/if\s*\(!p\)\s*return null/)
  })

  it('ProviderLogo 的 img 带尺寸与空 alt（装饰图，文字标签在旁边）', () => {
    const code = hubCode()
    const at = code.indexOf('function ProviderLogo(')
    const body = code.slice(at, code.indexOf('function formatTime(', at))
    // 无尺寸会让首帧按原图大小撑开、图片到位后再跳一下。
    expect(body, 'img 缺 width/height ⇒ 行高会先抖一下').toMatch(/width:\s*20,\s*height:\s*20/)
    // alt 必须是空串（装饰图）而不是省略 —— 省略时读屏会念出文件名。
    expect(body, 'img 的 alt 必须是空串').toMatch(/alt:\s*''/)
  })

  it('★ ModelToggle 必须接 provider 入参（漏了图标就恒不渲染，且不报错）', () => {
    const code = hubCode()
    const sig = /function ModelToggle\(\{([^}]*)\}\)/.exec(code)
    expect(sig, 'ModelToggle 签名变了，本表要跟上').not.toBeNull()
    expect(sig![1], 'ModelToggle 不再解构 provider ⇒ 行首图标恒为 null（静默失效）')
      .toMatch(/(^|,)\s*provider\s*(,|$)/)
  })

  it('★ ModelToggle 行首确实渲染了 ProviderLogo', () => {
    const code = hubCode()
    const at = code.indexOf('function ModelToggle(')
    expect(at).toBeGreaterThan(-1)
    const body = code.slice(at, code.indexOf('\nfunction ', at + 10))
    expect(body, 'ModelToggle 里没有 ProviderLogo').toMatch(/React\.createElement\(ProviderLogo,\s*\{\s*provider\s*\}/)
  })

  it('★★ 所有 ModelToggle 调用点都必须把 provider 传进去（漏一处那处就没图标）', () => {
    const calls = modelToggleCalls(hubCode())
    expect(calls.length, 'ModelToggle 的调用点数量变了 —— 新增/删除列表时本表要跟上')
      .toBe(2)
    calls.forEach((body, i) => {
      expect(body, `第 ${i + 1} 个 ModelToggle 调用没传 provider ⇒ 那份列表没有图标`)
        .toMatch(/(^|\n)\s*provider[,:]/)
    })
  })

  it('★ 模型中心按「分组所属供应商」取图标，不得串成同一枚', () => {
    const code = hubCode()
    const at = code.indexOf('section.models.map(model => React.createElement(ModelToggle')
    expect(at, '模型中心那段调用找不到了').toBeGreaterThan(-1)
    const body = code.slice(at, at + 600)
    expect(body, '模型中心横跨全部供应商，图标必须按 section.id 取；若写成别的变量，'
      + '整份列表会顶着同一枚图标')
      .toMatch(/provider:\s*section\.id/)
  })

  it('★ 供应商弹窗的每一行也要有图标（左栏有、弹窗没有 = 同一份清单两种长相）', () => {
    const code = hubCode()
    // ⚠️ 锚点必须用**调用形态**（`'dim-jh-modelId' }, providerRowSummary(row))`）：
    //    光写 `providerRowSummary(row)` 会先命中第 5864 行的函数**定义**
    //    `function providerRowSummary(row) {`，从那儿往前 900 字符取到的是
    //    毫不相干的代码（本表初版就踩了这个坑，断言实际在看 downloadJson）。
    const anchor = code.indexOf("'dim-jh-modelId' }, providerRowSummary(row))")
    expect(anchor, '供应商弹窗的行结构变了（找不到 providerRowSummary 的调用点）').toBeGreaterThan(-1)
    const block = code.slice(Math.max(0, anchor - 900), anchor)
    expect(block, '供应商弹窗的行首没有 ProviderLogo —— 弹窗里认供应商只能靠读名字')
      .toMatch(/React\.createElement\(ProviderLogo,\s*\{\s*provider:\s*row\.id\s*\}/)
  })

  it('★ 网关清单的卡片标题也要有图标（标题就是供应商名）', () => {
    const code = hubCode()
    const at = code.indexOf('function GatewayCards(')
    expect(at, 'GatewayCards 不见了').toBeGreaterThan(-1)
    const body = code.slice(at, code.indexOf('\nfunction ', at + 10))
    expect(body, '网关卡片标题没有供应商图标')
      .toMatch(/React\.createElement\(ProviderLogo,\s*\{\s*provider:\s*card\.provider\s*\}\)/)
    // ⚠️ 图标必须在**按钮内部**（`dim-jh-gatewayCardToggle` 的子节点），
    //    而不是按钮旁边的兄弟节点 —— 否则窄屏换行会把图标与标题拆开。
    const toggleAt = body.indexOf("className: 'dim-jh-gatewayCardToggle'")
    expect(toggleAt, '卡片标题按钮的结构变了').toBeGreaterThan(-1)
    const afterToggle = body.slice(toggleAt)
    const providerLogoAt = afterToggle.indexOf('React.createElement(ProviderLogo')
    const countAt = afterToggle.indexOf("className: 'dim-jh-gatewayCardCount'")
    expect(providerLogoAt, '图标不在标题按钮内').toBeGreaterThan(-1)
    expect(countAt, '找不到卡片计数节点，本表的相对位置判据失效').toBeGreaterThan(-1)
    expect(providerLogoAt, '图标跑到了按钮外面（应在按钮的 children 里、计数之前）')
      .toBeLessThan(countAt)
  })

  it('★ 聚合页的候选行也要有图标（这一页正是逐条比较渠道的地方）', () => {
    const code = hubCode()
    const at = code.indexOf('const renderCandidate = (model, candidate')
    expect(at, 'renderCandidate 不见了').toBeGreaterThan(-1)
    const body = code.slice(at, code.indexOf('const renderModel = (model)', at))
    expect(body, '聚合候选行没有供应商图标 —— 整列同一字色，认渠道只能读名字')
      .toMatch(/React\.createElement\(ProviderLogo,\s*\{\s*provider:\s*candidate\.provider\s*\}\)/)
    // ⚠️ 图标必须在**行标签之前**：这行的排布是 拖动柄 · 标签(flex:1) · 到期 · 开关，
    //    图标若插到标签之后会落进被 flex:1 挤扁的区域、或被 ellipsis 连带裁掉。
    const logoAt = body.indexOf('React.createElement(ProviderLogo')
    const labelAt = body.indexOf("className: 'dim-jh-aggCandidateLabel'")
    expect(labelAt, '找不到候选行标签，本表的相对位置判据失效').toBeGreaterThan(-1)
    expect(logoAt, '图标不在行标签之前 —— 这行标签是 flex: 1，图标会被挤到右边去')
      .toBeLessThan(labelAt)
  })

  it('左栏 rail 的图标不得在这次重构里被弄丢', () => {
    const code = hubCode()
    expect(code, '左栏 rail 的供应商图标没了 —— 这是最早就有的一处，属回归')
      .toMatch(/React\.createElement\(ProviderLogo,\s*\{\s*provider:\s*p\.id\s*\}/)
  })
})

describe('供应商图标 · 行内尺寸', () => {
  it('★ 模型行里的图标必须就地收窄（基类 30px 是给左栏 48px 按钮的）', () => {
    const css = styleSource()
    expect(css, '缺 22px 收窄规则 ⇒ 30px 图标配 7px padding 会把行高撑开')
      .toContain('.dim-jh-modelRow > .dim-jh-providerIcon { flex: none; width: 22px; height: 22px;')
  })

  it('★ 图标必须 flex: none（否则被长模型名挤成一条线）', () => {
    const css = styleSource()
    const rule = /\.dim-jh-modelRow > \.dim-jh-providerIcon \{([^}]*)\}/.exec(css)
    expect(rule, '找不到行内图标规则').not.toBeNull()
    expect(rule![1], '没有 flex: none ⇒ 同行的 modelInfo 是 flex: 1 1 auto，会把图标压扁')
      .toMatch(/flex:\s*none/)
  })

  it('行内 img 也要跟着缩小（只缩容器会露出大片空白）', () => {
    const css = styleSource()
    expect(css).toContain('.dim-jh-modelRow > .dim-jh-providerIcon img { width: 15px; height: 15px; }')
  })

  it('已关闭的模型：图标与文字一起降透明度', () => {
    const css = styleSource()
    expect(css, '只淡文字不淡图标 ⇒ 图标看着「亮着但不可用」，与整行状态矛盾')
      .toContain('.dim-jh-modelRow[data-disabled="true"] > .dim-jh-providerIcon { opacity: 0.5; }')
  })

  it('基类尺寸不得被改动（左栏 rail 与两处弹窗共用同一枚 class）', () => {
    const css = styleSource()
    expect(css, '基类 .dim-jh-providerIcon 必须仍是 30px —— 改它会把左栏按钮一起改掉')
      .toContain('.dim-jh-providerIcon { width: 30px; height: 30px;')
  })

  it('★ 网关卡片头的图标必须压回文字流（基类是 block-level 的 grid）', () => {
    const css = styleSource()
    const rule = /\.dim-jh-gatewayCardToggle > \.dim-jh-providerIcon \{([^}]*)\}/.exec(css)
    expect(rule, '缺网关卡片头的图标规则 ⇒ 30px 的 grid 会在标题前后各断一行')
      .not.toBeNull()
    expect(rule![1], '必须改成 inline-grid：`.dim-jh-gatewayCardToggle` 不是 flex 容器')
      .toMatch(/display:\s*inline-grid/)
    expect(rule![1], '缺 vertical-align ⇒ 图标会顶在文字上沿').toMatch(/vertical-align:\s*-?\d+px/)
  })

  it('★ 聚合候选行的图标必须收窄（30px 会把 28px 的行撑到 40px）', () => {
    const css = styleSource()
    expect(css, '缺聚合候选行的图标收窄规则')
      .toContain('.dim-jh-aggCandidate > .dim-jh-providerIcon { flex: none; width: 18px; height: 18px;')
  })
})

/**
 * ★★ **图标数据通路**必须真的接上（2026-10-27 对抗审计 P1-2）。
 *
 * ## 缺陷
 *
 * 本文件原先只断言「调用点把 `provider` 传进去了」，**没有任何一条**断言
 * 「`provider` 传进去之后真的能取到图标」。实测两个变异都逃得过（37/37 全绿）：
 *
 * 1. 把生产代码的 `icon: PROVIDER_ICONS[d.id]` 改成 `icon: undefined`
 *    ⇒ **全站 5 处图标同时变成 `<img src={undefined}>`**，而本 spec 与
 *    `provider-registry.spec.ts` **一条都不红**；
 * 2. 从 `PROVIDER_ICONS` 删掉一个 provider ⇒ 变红，但红在**旧的**
 *    `provider-registry.spec.ts`（键集合相等），本 spec 仍 17 passed。
 *
 * ⇒ 「新增 provider 忘配图标」由 `provider-registry.spec.ts` 守；
 *   **「取图标的这一行断了」此前无人守** —— 那正是本组补的。
 *
 * ⚠️ 本文件的头部注释写着「组件无法在本仓库单测里渲染（react 不在依赖内），
 * 故只能做源码文本断言」——**这个前提已被本仓库自己证伪**
 * （`tests/unit/jet-hub-panel-wiring.spec.ts` 用 `vi.mock('react', …)` +
 * 真实 `await import(...)` 跑过运行时渲染；同款见 `jet-hub-tdz.spec.ts`）。
 * 保留文本断言的真正理由是「成本」而不是「做不到」，别拿错误前提正当化它。
 */
describe('供应商图标 · 数据通路（不只接线）', () => {
  it('★★ PROVIDERS 的 icon 必须来自 PROVIDER_ICONS（写成 undefined 会全站静默无图标）', () => {
    const code = hubCode()
    // 逐字定位那一行映射，避免「文本里出现过 PROVIDER_ICONS」这种恒真判据
    const line = code.match(/icon:\s*([^,\n]+)/)
    expect(line, 'PROVIDERS 里找不到 icon 字段').toBeTruthy()
    expect(
      line![1]!.trim(),
      'PROVIDERS 的 icon 不再从 PROVIDER_ICONS 取 ⇒ 全部 ProviderLogo 会拿到 undefined，'
      + '渲染成 <img src={undefined}>（静默，无报错）',
    ).toMatch(/^PROVIDER_ICONS\[/)
  })

  it('★★ PROVIDER_ICONS 必须覆盖 PROVIDER_REGISTRY 的每一个 id（含新增 provider）', () => {
    // ⚠️ 注册表在**服务端**（`src/provider-registry.ts`），不是客户端文件 ——
    //    第一版写成 `plugin-src/client/provider-registry.js` 直接 ENOENT。
    const registry = source('src/provider-registry.ts')
    const ids = [...registry.matchAll(/^\s+id:\s*'([^']+)'/gm)].map(m => m[1]!)
    expect(ids.length, 'PROVIDER_REGISTRY 里没解析出 id ⇒ 本用例会恒真').toBeGreaterThan(10)

    const icons = source('plugin-src/client/provider-icons.js')
    const missing = ids.filter((id) => !new RegExp(`(?:^|[\\s,{])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(icons))
    expect(
      missing,
      '这些 provider 没有图标条目 ⇒ 它们的列表行会静默缺图标（ProviderLogo 返回 null）',
    ).toEqual([])
  })
})
