/**
 * `plugin-src/client/panel-entry.js` 的**行为级**接线守卫。
 *
 * ## 为什么必须有这个文件（原守卫被对抗审计打穿）
 *
 * 原来只有**源码文本**断言（`toContain` / `toMatch`）。2026-10-24 对抗审计实测
 * 打穿 3 条（全部属于本文件范围），手法与后果：
 *
 * | 手法 | 后果 | 原文本断言 |
 * |---|---|---|
 * | 局部 `const JetHubPageForMain = JetHubPage` 遮蔽模块级常量（+2 行） | 两处边界**全拆** | **全绿** |
 * | `if (false)` 供货锚点 + 真注册换成裸组件 | 保护被拆除 | **全绿** |
 * | 常量下沉到组件体内（每次渲染新建类） | 面板内**所有本地状态每帧丢失** | **全绿** |
 *
 * 共同根因：文本匹配**不做作用域/绑定分析**（本仓库 `if(false)` 教训的同族）。
 *
 * ⇒ 改为**行为级**：真 import 本模块、用替身 React + 假 `ctx` 跑一遍注册，
 * 然后直接问两个问题：
 *   1. 注册进去的组件**能不能捕获渲染期异常**（而不是「源码里出现过某个字面量」）；
 *   2. 连续两次渲染拿到的是不是**同一个**组件类型（而不是「有 const 声明」）。
 *
 * 这样无论源码怎么写（别名、内联、局部遮蔽、死分支诱饵），判据都打在**运行结果**上。
 *
 * ## 与 `panel-entry.spec.ts` 的分工（并存，不互相替代）
 *
 * 那份是 master 的源码文本断言，守的是**结构约定**（按枚举互斥增删、注册当下
 * 先 sync 一次、main 不被条件包裹）。本文件守的是**行为契约**（注册进去的真的
 * 是边界、身份真的稳定、label 真的配对）。
 *
 * ## 替身的诚实边界（勿高估本文件）
 *
 * 替身**不实现** React 的协调协议：`setState` 是同步浅合并、`componentDidCatch`
 * 不会被自动调用、没有「整棵树卸载」这个概念。所以本文件**无法**证明
 * 「React 真的会调 `getDerivedStateFromError`」或「兄弟节点存活」——
 * 那两条只有真机（Chromium + 真 react-dom）能证（2026-10-24 对抗审计已做）。
 * 本文件能证明的是：**接线层注册进去的确实是边界组件、且身份稳定**。
 */
import { describe, expect, it, vi } from 'vitest'

// ── 替身 React：必须在 `vi.mock` 工厂可见，故用 vi.hoisted ──
const fakeReact = vi.hoisted(() => {
  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(partial) {
      const next = typeof partial === 'function' ? partial(this.state) : partial
      this.state = { ...this.state, ...next }
    }
  }
  // ⚠️ children 必须独立于 props 的空值判断：本仓库大量使用
  //    `createElement('div', null, child)`（无属性但有子节点）。
  const createElement = (type, props, ...children) => ({
    type,
    props: {
      ...(props === null || props === undefined ? {} : props),
      children: children.length > 0 ? children : undefined,
    },
  })
  return { Component, createElement }
})

vi.mock('react', () => ({ ...fakeReact, default: fakeReact }))

/** 被保护的组件：渲染期一定抛错（这是「边界必须拦住」的输入）。 */
vi.mock('../../plugin-src/client/jet-hub.js', () => ({
  JetHubPage: function JetHubPage() {
    throw new TypeError("Cannot read properties of undefined (reading 'length')")
  },
}))

vi.mock('../../plugin-src/client/panel-entry-store.js', () => ({
  JET_HUB_PANEL_KEY: 'jet-hub',
  JET_HUB_SIDEBAR_ORDER: 50,
  loadPanelEntry: () => Promise.resolve(),
  panelEntryShowsSettings: () => true,
  panelEntryShowsSidebar: () => true,
  subscribePanelEntry: () => () => {},
}))

const { registerJetHubPanelEntries } = await import('../../plugin-src/client/panel-entry.js')

/** 收集 `ctx` 上的槽位注入与注册，供测试手动驱动。 */
function makeCtx() {
  const injections = []
  const registrations = []
  const ctx = {
    slots: {
      inject(slot, callback) {
        injections.push({ slot, callback })
        return () => {}
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    // `panel-entry.js` 用它拿 `layout` 的作用域副本（拿不到就跳过）。
    inject(_deps, callback) {
      const scope = { layout: undefined }
      const stop = callback(scope)
      return typeof stop === 'function' ? stop : () => {}
    },
  }
  return { ctx, injections, registrations }
}

/** 跑一遍注册器，并**手动驱动**两处入口的 inject 回调（宿主才会这么做）。 */
function registerAll() {
  const harness = makeCtx()
  registerJetHubPanelEntries(harness.ctx, () => Promise.resolve())
  for (const { slot, callback } of harness.injections) {
    // 侧栏那一处是 `subscribePanelEntry` 驱动，回调体不注册东西；驱动它无害。
    if (slot === 'main' || slot === 'settings.section') callback()
  }
  return harness.registrations
}

/** 按 React 语义展开一层元素描述：class 组件实例化后调 render，函数组件直接调。 */
function renderElement(element) {
  if (element === null || element === undefined) return null
  if (typeof element !== 'object') return element
  const { type, props } = element
  if (typeof type === 'function') {
    if (type.prototype && typeof type.prototype.render === 'function') {
      return new type(props).render()
    }
    return type(props)
  }
  return element
}

/** 递归收集替身元素树里的全部文本。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && node.props) collectText(node.props.children, out)
  return out
}

/**
 * 从 `main` 槽注册的 `JetHubMainPanel` 里取出**真正被渲染的组件**。
 *
 * `JetHubMainPanel` 返回 `div > <边界组件>`；这里取 `div` 的第一个子元素类型。
 * ⚠️ 若源码把边界换成了裸 `JetHubPage`（或局部遮蔽成裸组件），取到的就是那个
 * **没有 `getDerivedStateFromError` 的**函数组件 —— 正是判据要抓的。
 */
function mainSlotComponent(mainPanel) {
  const element = mainPanel({ rpcCall: () => Promise.resolve() })
  expect(element, 'main 槽在 rpcCall 是函数时不该返回 null').not.toBeNull()
  const children = element.props.children
  expect(Array.isArray(children) && children.length > 0, 'main 槽没有渲染出任何子组件').toBe(true)
  return children[0].type
}

/** 断言某组件**真的是**错误边界，并返回它的 fallback 文本（供 label 断言）。 */
function assertIsBoundary(component, what) {
  expect(typeof component, `${what} 不是组件`).toBe('function')
  expect(
    typeof component.getDerivedStateFromError,
    `${what} 没有 getDerivedStateFromError —— 它是个**裸组件**，渲染期异常会卸载整棵树`,
  ).toBe('function')

  const instance = new component({ rpcCall: () => Promise.resolve() })
  // 触发一次「渲染期抛错 → React 调 getDerivedStateFromError → 再 render」。
  const error = new TypeError('wiring-probe')
  instance.setState(component.getDerivedStateFromError(error))
  const fallback = instance.render()
  expect(fallback, `${what} 没有产出 fallback 元素`).not.toBeNull()
  expect(fallback.type, `${what} 的 fallback 不是元素`).not.toBe(component)

  const text = collectText(fallback).join(' | ')
  expect(text, `${what} 的 fallback 没有「已拦住」提示`).toContain('已拦住')
  return text
}

describe('panel-entry 接线（行为级）', () => {
  it('⚠️ 注册器确实注册了两处入口（前置：否则下面的断言全是空转）', () => {
    const registrations = registerAll()
    const names = registrations.map((r) => r.spec.name).sort()
    expect(names, '没有注册到 main —— 接线断了').toContain('main')
    expect(names, '没有注册到 settings.section').toContain('settings.section')
  })

  /**
   * ⚠️⚠️ 挡「影子常量」「死分支诱饵」：不管源码把 `JetHubPageForMain` 写成什么，
   * 只要运行期渲染出来的**不是边界**，这条就红。
   */
  it('⚠️⚠️ main 槽渲染的组件**真的是**错误边界（挡住局部遮蔽与死分支诱饵）', () => {
    const registrations = registerAll()
    const main = registrations.find((r) => r.spec.name === 'main')
    expect(main, 'main 槽没有注册').toBeTruthy()

    const component = mainSlotComponent(main.component)
    const text = assertIsBoundary(component, 'main 槽渲染的组件')
    expect(text, "main 槽的 label 必须是「Jet Hub 面板」").toContain('Jet Hub 面板')
  })

  /**
   * ⚠️⚠️ 挡「常量下沉」：`JetHubMainPanel` 每次渲染都必须拿到**同一个**组件类型。
   *
   * 下沉到函数体内时每次调用 `withErrorBoundary` 都会新建类 ⇒ React 视为换了一个
   * 组件类型 ⇒ 卸载重挂整棵子树 ⇒ 面板内所有本地状态（表单、选中项…）每帧丢失。
   */
  it('⚠️⚠️ main 槽的组件身份稳定（连续两次渲染必须是同一个组件类型）', () => {
    const registrations = registerAll()
    const main = registrations.find((r) => r.spec.name === 'main')
    const first = mainSlotComponent(main.component)
    const second = mainSlotComponent(main.component)
    expect(
      first,
      '两次渲染拿到了不同的组件类型 —— 常量被下沉到了组件体内（React 会卸载重挂整棵树，本地状态全丢）',
    ).toBe(second)
  })

  it('⚠️⚠️ settings.section 注册的组件**真的是**错误边界，且 label 配对正确', () => {
    const registrations = registerAll()
    const settings = registrations.find((r) => r.spec.name === 'settings.section')
    expect(settings, 'settings.section 没有注册').toBeTruthy()

    const text = assertIsBoundary(settings.component, 'settings.section 注册的组件')
    expect(text, "settings.section 的 label 必须是「Jet Hub 设置页」").toContain('Jet Hub 设置页')
  })

  /**
   * ⚠️ **label 必须与槽位一一配对**（2026-10-24 审计打穿：把两个 label 互换后
   * 原文本断言 17/17 全绿）。label 是 fallback 里**唯一**区分「哪块坏了」的信息，
   * 互换会让用户在设置页看到「Jet Hub 面板渲染失败」而跑去错的地方排查。
   *
   * 这条与上面两条的区别：上面是「各自正确」，这条是「**不交叉**」——
   * 挡住「两个都用了同一个 label」这种同时满足上面两条的写法。
   */
  it('⚠️ 两处槽位的 label 不交叉（设置页不得自称面板、反之亦然）', () => {
    const registrations = registerAll()
    const main = registrations.find((r) => r.spec.name === 'main')
    const settings = registrations.find((r) => r.spec.name === 'settings.section')

    const mainText = assertIsBoundary(mainSlotComponent(main.component), 'main')
    const settingsText = assertIsBoundary(settings.component, 'settings')

    expect(mainText, 'main 槽自称了设置页').not.toContain('Jet Hub 设置页')
    expect(settingsText, 'settings.section 自称了面板').not.toContain('Jet Hub 面板')
  })
})
