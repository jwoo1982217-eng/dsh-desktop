# 插件详情页设置区规范

> 适用：DSH 插件（`dsh.client.platform = "web"`）
> 上游基线：`cb6ee35`
> 来源：本文每个数值都标了出处；来自 `dsh-project-groups`（DPG）与 `dsh-auto-expand`（AE）
> 两个已在生产使用的插件实测，或直接量自官方源码。**没有出处的值不写进本文。**

这份文档说明「插件详情页上属于某个包的设置区」这个入口：它是什么、怎么接上去、
接上去之后长什么样、会在哪里静默失败。

它**不**判断哪些控件属于「设置」、哪些属于「功能」—— 那是插件作者对自己产品的判断。

---

## 1. 入口

### 1.1 槽位契约

`packages/client/ui-plugin-manager/src/client/slot-contract.ts:142`：

```ts
/** A bundle's own configuration, keyed by the bundle's package name and
 *  rendered on the bundle's page between its description and its rows
 *  (`view: 'page'` only). */
'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
```

宿主交给组件的 props（同文件 `:26-31`）：

```ts
export interface PluginConfigViewProps {
  /** `summary` renders the one-liner alone, as text or inline nodes; `page` renders the form with its save control. */
  readonly view: 'summary' | 'page'
  /** Host-owned configuration values and write actions for this page's entry. */
  readonly form?: ConfigPageForm | undefined
}
```

**`view` 实际上只会是 `'page'`。** 全仓唯一调用点写死：

`PluginManagerPage.tsx:782` → `renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`

所以不必为 `view` 写分支。

`form` 是宿主自带的配置表单。若你的设置住自己的领域、走自己的 RPC，**忽略它**
（官方 `client-ui-voice-input` 就是这么做的）。

### 1.2 渲染位置与可见条件

`PluginManagerPage.tsx:779-785`：

```tsx
{configured
  ? (
    <section className={css.detailSection} data-plugin-config>
      {renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })}
    </section>
  )
  : null}
```

渲染位置：**侧栏 → 插件 → 本插件 → 描述之下、包含的组件之上**。

`configured` 的来源（`config-ledger.ts:51-52, 66`）：

```ts
const keysOf = (name) => new Set(ctx.slots.entries(name).flatMap(
  entry => entry.options.key === undefined ? [] : [entry.options.key]))
// …
bundles: keysOf('plugins.bundle.config'),
```

⇒ **注册即出现，注销即消失。** 没有第二种开关，也没有「已配置但隐藏」的状态。

### 1.3 key 撞车会替换，不会报错

上游槽位目录（`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:2296` 起）
对这个槽位标了：

```
replaceRisk: 'shadows-shipped-ui'
keyDomain:  'open: any string the owner dispatches (no compile-time key set)'
key 的 doc: 'Registering an already-occupied key replaces that occupant.'
```

⚠️ 这与 `settings.models.provider-card` **不同**：那个同 key 会抛错，这个会**静默替换**
占用者。所以 key 必须是本包独有的包名。

### 1.4 上游未在此槽位规定视觉

`docs/cookbook/adding-a-settings-card.zh.md`（72 行）讲的是 `configForms` 那条路 —— 在插件
`Config` schema 里声明 `Volatile<T>` 字段，宿主通过 `form.state` / `form.mutate` 提供编辑。
它**没有**提到 `plugins.bundle.config`，**也没有**任何间距 / 字体 / 禁用态规定。

本文第 2 节起的视觉规范，来源是第三节列出的两套实测实现与官方同容器内的其它卡片。

---

## 2. 接入

### 2.1 客户端注册

```js
ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
  name: 'plugins.bundle.config',
  key: '<本包 package.json 的 name>',
  locale: NS,                    // 可选：文案走 locale 时
  inject: () => ({ /* 交给组件的座位 */ }),
}, SettingsCard))
```

**三种 `inject` 形态，按设置数据住哪选：**

| 形态 | 适用 | 官方先例 |
|---|---|---|
| `inject: () => ({ rpcCall })` | 设置住本插件自己的领域，走自己的 RPC | 无官方先例；本文配套实现使用 |
| `inject: () => ({ hooks: { xxx }, setXxx })` | 设置是宿主可观察对象 | `client-ui-cot-translation/src/client/mount.ts:105` |
| `inject: () => actions`（直接给动作集合） | 一组动作函数，无 observable | `client-ui-voice-input/src/client/mount.ts:48` |

`hooks` 隔间里的 observable 会被 `ui-slots` 的 `bindInjectSources` 绑定成 `useXxx`
选择器 hook —— 这是 cot-translation 的 `hooks.translationForm` 与 DPG 的
`target: clientNewSessionTarget` → `useTarget` 同一机制。

⚠️ **不要用 `ctx.get()` 判空后挂载。** `get()` 在 `apply` 时刻读，服务晚到就永久错过；
`ctx.inject(deps, cb)` 没有这个竞态，且子作用域随父 fiber 一并销毁（AE `index.ts:181`）。

### 2.2 `package.json` 的 `dsh.client.inject`

```json
"dsh": {
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-plugin-manager"]
  }
}
```

作用：声明后那个包的 bundle **先于**本插件到达（`dsh-client-modules` 的 `arriveGraphRow`）。
未声明时本插件可能先被物化，`slots.inject` 一直等服务 ⇒ 卡片永不出现，**且不报错**。

⚠️ **只声明真正必需的。** 把所有服务都塞进 `inject`，会让一个会来会走的服务
**gate 整个插件**（DPG 在 `index.ts:290` 附近记录了这条）。

### 2.3 类型声明

避免为了一个槽位的类型拖入整棵依赖树：

```ts
// src/client/contract/slot-declarations.ts
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 上游同名类型；用不到 `form` 时声明为空对象即可。 */
export interface PluginConfigViewProps {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps }
  }
}
```

⚠️ 上游若改变该槽位的 `kind` / `scope` / `owner`，本文件必须同步。

### 2.4 `ui-primitives` 是平台模块

`packages/client/web/src/platform.ts:8-15` 的 `PLATFORM_MODULES` 包含
`@deepseek-ai/dsh-client-ui-primitives`。而 `packages/client/AGENTS.md:82` 规定：

> **Baseline externals are implicit for every dynamic bundle.** Do not repeat entries from
> `PLATFORM_MODULES` in `dsh.client.external`.

⇒ 构建配置里把它标成 external 即可（与 `react` / `react-dom` 同款做法），
**不要**写进 `dsh.client.external`（那份清单只放基座之外的精确请求）。

### 2.5 构建产物格式

构建出的 `./client` 必须是 lazy-CJS factory：向 `__ModuleLoader__` 登记包名与一个
`factory(require)`（`packages/client/modules/README.zh.md`）。

```js
window.__ModuleLoader__.load({
  id: '<package.json 的 name>',
  factory: (require) => { /* … */ return module.exports }
})
```

⚠️ `id` 必须**逐字等于**包名，否则该 entry 永远 import 不到，启动即
`N entry did not activate`。

---

## 3. 视觉规范

### 3.1 容器：`.stack` 是必须的

```css
.stack {
  display: flex;
  flex-direction: column;
  gap: 0;          /* ← 关键：必须为 0 */
}
```

**为什么**（DPG `settings-card.module.css:3-21` 原文）：

> 官方 `detailSection` 容器给子元素 `gap: 12px`。卡片以前返回 Fragment（不生成元素）
> → 七个块成为容器的直接子元素 → 12px 应用在每对之间。实测：七块之间全 12px，
> 而官方插件卡片（`终端` / `网页搜索`）是 **0px** —— 它们把块包在内层 column 里，
> 容器只看到一个子元素。
>
> 那个 gap 在本文件里改不了（所有插件共用同一容器），所以唯一的办法是
> **不再当它的直接子元素**。

`gap: 12px` 本身见 `PluginManagerPage.module.css:1328` 的 `.detailSection`。

### 3.2 行的几何

```css
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
}

.rowText {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 48px;
}
```

| 值 | 出处 |
|---|---|
| `padding: 16px 0` | 官方设置行（`PermissionRow` / `PreferenceRow` 同款），DPG 实测 |
| `gap: 8px` | 同上 |
| 标题↔描述 `gap: 6px` | 官方插件卡（`终端`、`子智能体`）实测 |
| `padding-right: 48px` | 给右侧控件留位 |
| `min-width: 0` | 防长文本撑破 flex item |

**为什么复制而不 import**：client bundle 纯度门禁禁止跨插件 value 导入。
**官方自己也复制**（DPG `:23-28`）。

### 3.3 字体：四级层次

| 类 | 字号 / 字重 / 行高 | 颜色 token | 用途 |
|---|---|---|---|
| `.groupTitle` | **13 / 600 / 19.5px** | `label-primary` | 分组标题 |
| `.title` | **13 / 500 / 19.5px** | `label-primary` | 设置项名称 |
| `.cubeName` | **13 / 400 / 19.5px** | — | 卡片内名称 |
| `.desc` | **12 / 400 / 18px** | `label-tertiary` | 描述文字 |
| `.selector` | **13 / 500 / 19.5px** | `label-primary` | 下拉触发器（与 title 同级） |
| `.modalBody` | 14 / 400 / 22px | `label-primary` | 对话框正文 |

**600 vs 500 是「标题」与「行名」的分界**（DPG `:169-186` 原文）：

> 早期版本把 `.title` 和 `.groupTitle` 都设成 500，让「所有命名某物的文字看起来一样」。
> 那是本卡片自己的简化，**它压平了两个层级**。
>
> 官方插件卡（`子智能体`）的对比是：**h3 13px/600** 用于分节标题，
> **字段标签 13px/500**。**这一档字重差就是「标题」与「另一个行名称」的区别。**

`.cubeName` 用 400 的理由（DPG `:352-360`）：卡片内容在「被命名的东西」**内部**，
所以用更轻的字重把两个层级分开。

**颜色 token**（`ui-theme/src/design-platform.css`）：

| 用途 | token | 位置 |
|---|---|---|
| 主标签 | `--dsw-alias-label-primary` | — |
| 次级 | `--dsw-alias-label-secondary` | — |
| 三级 / 提示 | `--dsw-alias-label-tertiary` | — |
| 被门控（灰化） | `--dsw-alias-label-dimmed` | light `:217` / dark `:335` |

⚠️ DSH 原生就有 `label-dimmed`，**不必 `color-mix` 自算** —— 那是处理**卡片面**时的做法。

### 3.4 分组

```css
.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 0;
}

.groupHeading {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
```

三个标题↔描述间距（**8 / 6 / 4**）对应三种不同的布局关系，不是随意取的：

| 值 | 用在哪 | 为什么 |
|---|---|---|
| `8px` | `.group` 组内 | 标题与其引入的卡片之间、diff 行之间 |
| `6px` | `.rowText` 行内 | 行右侧还有控件，需要稍松 |
| `4px` | `.groupHeading` | 标题单独站在卡片上方，无右侧控件，更紧 |

⚠️ AE 第 406 行的判断值得注意：**页面顶部已有插件名与描述，再加分组标题是重复信息**；
只有多个互不相关的设置块时才需要分组。

### 3.5 线

```css
.rule {
  flex: none;
  margin: 0;                                   /* ← 关键 */
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
```

**`margin: 0` 是整个设计的核心**（DPG `:142-167` 原文）：

> 相邻两块各自 `padding: 16px 0` 已形成 32px 间隔，划线插在中间 →
> 「内容到线」16px、「线到内容」16px，内容到内容仍是 32px。
>
> 划线是**按构造居中**的：位置由两侧 padding 决定，不是由自己的 margin 决定。
> 要守的不变量是：上下两块的 padding 必须相同。

两个反面案例：

| 错误做法 | 后果 |
|---|---|
| 用 `border-bottom` 挂在相邻块上 | 那块自己的 padding 失衡 |
| 用 `margin: 16px 0` | 变成 64px 间隔，划线**加倍了间距**而非标记它 |

**卡片体通常不画分隔线**（DPG 2026-10-12 决定）：

> 官方插件卡片（`终端`、`网页搜索`）在共享容器里**根本不画分隔线**。
> 加上后，由于 `detailSection` 的 12px 间隔，规则看起来属于上面那块，而 12px 落在另一侧。

### 3.6 实线框 / 虚线框的语义区分

DPG `:643-684` 用**线的样式本身**承载语义：

| 样式 | 含义 |
|---|---|
| `0.5px solid` + `bg-base` 填充 | 装**内容**（`.injectionText`） |
| `0.5px dashed`，无填充 | 标记「**内容本该在这里，并说明为什么不在**」（`.injectionOff`） |

> 实线框装内容，虚线框标记一个内容**本该占据**的位置并说明它为什么不在。

### 3.7 开关：官方 `Switch`

官方契约（`ui-primitives/src/Switch.tsx:7-26`）两个可选参数，门控场景**两个都要用**：

| 参数 | 用途 |
|---|---|
| `disabled` | 拒绝输入；`Switch.module.css:23` 里是 `cursor: default` + `opacity: 0.5` |
| `title` | **「为什么这个开关被锁住」** 的悬停文本（官方原文：`usually why the toggle is locked`） |

### 3.8 下拉：`Menu`，不是原生 `<select>`

```css
.selector {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-module-platform);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 19.5px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.selector:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.selector:disabled { cursor: default; opacity: 0.5; }
```

**为什么不用原生 `<select>`**：官方语音输入卡用了原生 `<select>`，但它的**弹出层由操作系统
绘制、CSS 管不到** → **深色主题下弹白底**（DPG 用户截图实测）。
`Menu` 自带主题浮层、勾选态、键盘导航。

```tsx
<Menu
  open={open}
  onClose={() => setOpen(false)}
  items={OPTIONS.map(o => ({ id: o.id, label: o.label }))}
  selectedId={selected}
  onSelect={(id) => { setOpen(false); onChange(id) }}
  align="end"
  portal                                    {/* ← 必须 */}
  anchor={<button type="button" className={css.selector}
            aria-haspopup="menu" aria-expanded={open}
            onClick={() => setOpen(v => !v)}>
            {label}<IconChevronDownOutlineRegular className={css.chevron} />
          </button>}
/>
```

**`portal` 必须开**：卡片在插件页的滚动 detail 列里，就地展开的列表会被 `overflow` 裁剪。

DPG 实测的弹出层填充：

| 主题 | 填充 |
|---|---|
| light | `rgba(248,249,250,0.58)` |
| dark | `rgba(67,69,74,0.45)` |

### 3.9 变暗：三种对象，三种做法

| 对象 | 做法 | 为什么不能用另一种 |
|---|---|---|
| **纯文本标签** | `color: var(--dsw-alias-label-dimmed)` | 用 `opacity` 会让元素成为**独立合成层** |
| **带背景的控件** | `opacity: .5`（`Switch`）/ `.4`（`SegmentedControl`） | 官方对带背景控件就是这么做的 |
| **卡片面** | `color-mix(in srgb, <token> 40%, <base>)` | 逐项预乘 40%，因为 opacity 会连边框一起乘 |

**为什么文本不能用 `opacity`**（DPG `:266-293` 原文）：

> `opacity: .4` 让卡片成为独立合成层。点击页面上任何 `Switch`（有动画，会提升/降级层）时，
> 卡片会以不同底色重新合成一帧 —— 实测为一单位亮度下跌，**表现为闪烁**。颜色不会创建图层。

**`color-mix` 的两条规则**：

```css
/* 不透明 token → 混 bg-base，得到不透明结果 */
color: color-mix(in srgb, var(--dsw-alias-label-primary) 40%, var(--dsw-alias-bg-base));
/* 已有 alpha 的 token（边框）→ 混 transparent，缩放 alpha */
border-color: color-mix(in srgb, var(--dsw-alias-border-l4) 40%, transparent);
```

⚠️ **选中态必须混 `bg-base` 而非 `transparent`**（DPG `:295-307` 实测）：

```
0.4*53 + 0.6*21 = 33.8 → 34
0.4*54 + 0.6*21 = 34.2 → 34
0.4*56 + 0.6*23 = 36.2 → 36
```

混 `transparent` 会留一个 alpha 值被**二次合成**，那一轮舍入让它差一个单位
（实测 33,34,35 而原始绘制的是 34,34,36）。

**每项从自身 token 变暗，不要整体继承**：警告色必须仍是警告色，只是淡了
（`.cube:disabled .cubeWarn` 用 `state-warn-primary` 混 40%，不是统一换成灰）。

### 3.10 门控写法（三条一起做）

DPG `settings-card.tsx:459-475` 是范本：

```tsx
<div className={locked === undefined ? css.title : `${css.title} ${css.gated}`}>{title}</div>
<div className={locked === undefined ? css.desc : `${css.desc} ${css.gated}`}>
  {locked === undefined ? description : locked.text}     {/* ← 描述换成「由谁控制」 */}
</div>
<Switch
  checked={checked}                    /* ← 保留原值，不强制 false */
  onChange={onChange}
  label={title}
  disabled={locked !== undefined}
  {...locked === undefined ? {} : { title: locked.hint }}
/>
```

三条各自防的问题：

| 做法 | 不做会怎样 |
|---|---|
| 标签 + 描述加 `.gated` | 屏幕上是「灰开关 + 黑字」，读起来像破了 |
| 描述换成「由「X」控制，现已关闭」 | 灰掉的控件没有解释，用户不知道该去开哪个 |
| `checked` 保留原值 | 用户重新打开上层开关后，之前的选择被悄悄丢弃 |

### 3.11 焦点环

```css
/* 独立控件 */
outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary);
outline-offset: 1px;

/* 行内控件（半径会被裁剪） */
outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
outline-offset: -2px;
```

DPG `:611-615` 原文：

> The ring is drawn inside, because the row's own radius would clip it.

⚠️ 用共享 token `--dsw-focus-ring-width`，**不要写字面 `2px`**。理由（DPG `:454-456`）：

> a hard-coded width here would diverge from them the moment the theme changes the ring.

---

## 4. 已知陷阱

| # | 陷阱 | 后果 | 出处 |
|---|---|---|---|
| 1 | **key 与包名不一致** | 整段不渲染，**且无任何报错** | `config-ledger.ts:51`；DPG 实测 |
| 2 | **key 撞车** | **静默替换**占用者，不抛错 | `slot-catalog.ts` `replaceRisk` |
| 3 | **`dsh.client.inject` 漏声明** | bundle 可能先到，卡片永不出现且不报错 | AE `index.ts:181` |
| 4 | **`inject` 声明过宽** | 一个会来会走的服务 **gate 整个插件** | DPG `index.ts:290` 附近 |
| 5 | **卡片返回 Fragment** | 所有块被容器的 `gap:12px` 接管 | DPG `:3-21` |
| 6 | **`opacity` 用于文本变暗** | 独立合成层 → 开关动画时**亮度闪烁** | DPG `:266-293` |
| 7 | **选中态混 `transparent`** | 二次合成，差一个单位 | DPG `:295-307` |
| 8 | **`.rowActive` 被 `.row:hover` 盖掉** | 鼠标指着选中行时它看起来**不选中了** | DPG `:488-499` |
| 9 | **嵌套 `<button>`** | React 报 validateDOMNesting，**浏览器探针会因 console error 失败** | DPG `:414-423` |
| 10 | **`menuitem` 用在非 menu 容器** | 无障碍失效；单选列表应用 `listbox` + `option` | DPG `:461-465` |
| 11 | **门控文案里嵌标题原文** | 改标题后界面显示一个**已不存在的开关名** | AE 警示 |
| 12 | **原生 `<select>`** | 深色主题下弹白底（OS 绘制） | DPG 用户截图实测 |

### 陷阱 8 的展开

```css
/* ❌ 会被 .row:hover 盖掉（class + pseudo-class 特异性更高） */
.rowActive { background: var(--dsw-alias-bg-module-platform); }

/* ✅ 匹配特异性后靠顺序取胜 */
.rowActive,
.rowActive:hover { background: var(--dsw-alias-bg-module-platform); }
```

### 陷阱 9 的展开

卡片本身就是 `<button>`（整卡可点）时，卡内不能再有 `<button>`。
DPG 的 `.cubeAction` 因此是 `span` + `role="button"` 的形态：

> A `span`, not a `button`, because the card itself is a button and nesting one is invalid —
> React logs a validateDOMNesting error for it, and the browser probes fail on console errors.

---

## 5. 验证

### 5.1 只断言「注册成功」等于没验

陷阱 1 的失败模式是**静默不渲染**，注册调用本身不会报错。验证必须**驱动页面**：

```js
const sections = await page.locator('[data-plugin-config]').count()
// 期望 > 0
```

### 5.2 反向对照：证明探针不是恒真

在**旧 bundle** 上跑同一探针，确认它会失败。DPG 的实测记录：

> 旧 bundle 上 `[data-plugin-config]` **sections: 0**，3 项失败、其余优雅跳过。

### 5.3 主题双色验证

```js
await page.emulateMedia({ colorScheme: 'light' })   // 断言弹出层填充
await page.emulateMedia({ colorScheme: 'dark' })    // 断言弹出层填充
```

### 5.4 无浏览器环境时的最低限度

模拟 `__ModuleLoader__`，验证：

- bundle 是 closure-factory 格式，`load` 后能取到 id 与 factory
- factory 执行后导出 `{ apply, inject }`
- 平台模块全部 external，没有被重复打包（产物里的 `require()` 应只有
  `react` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives`）
- `apply` 在最小化 fake ctx 上不抛错

---

## 6. 两套实现的完整对照

| 维度 | DPG（`dsh-project-groups`） | AE（`dsh-auto-expand`） |
|---|---|---|
| 设置存储 | 自有 storage-domain + 自有 Remote/RPC | 官方 `configForms` |
| Host 半边 | 需要（大量逻辑） | 只需 `Config` schema + `settings.configure` |
| 卡片行数 | 864 行 | 277 行 |
| CSS 行数 | 774 行 | 126 行 |
| 槽位注册 | `inject: () => ({ hooks, setters })` | 无 inject，直接用模块级 observable |
| 分组标题 | 用 `.groupTitle` | **不用** |
| 下拉 | `Menu` + `portal` | `Menu` + `portal` |
| 输入框 | 无（仅 `type="file" hidden`） | 无 |
| 探针 | 361 行浏览器探针 + 反向对照 | `smoke-client.mjs` 结构校验 |

两者都没有文本输入框 —— 若你的设置需要文本输入，官方表单体系见
`docs/cookbook/adding-a-settings-card.zh.md` 与 `ui-primitives` 的
`SettingsValueField` / `SettingsForm`。

---

## 7. 本文不涉及

以下都是**插件作者对自己产品的判断**，不属于本规范的职责：

- 哪些控件属于「设置」、哪些属于「功能」
- 控件搬进设置区之后，原位置是否保留、是否留跳转入口
- 设置项应该暂存（点保存才写）还是立即生效
- 分组与标题怎么组织
- 具体设置项的名称与文案

---

## 附：索引

| 用途 | 路径 |
|---|---|
| 槽位契约 | `packages/client/ui-plugin-manager/src/client/slot-contract.ts:142` |
| 槽位目录（含 `replaceRisk`） | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:2296` |
| 渲染点与 `configured` 条件 | `packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:779-785` |
| ledger 投影 | `packages/client/ui-plugin-manager/src/client/config-ledger.ts:51-66` |
| `detailSection` 的 `gap` | `packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css:1328` |
| 平台模块表 | `packages/client/web/src/platform.ts:8-15` |
| external 规则 | `packages/client/AGENTS.md:82` |
| 客户端模块系统 | `packages/client/modules/README.zh.md` |
| 官方设置卡指南 | `docs/cookbook/adding-a-settings-card.zh.md` |
| 官方 `Switch` | `packages/client/ui-primitives/src/Switch.tsx:7-26` |
| 官方 `Menu` | `packages/client/ui-primitives/src/Menu.tsx` |
| 官方先例（actions） | `packages/experimental/client-ui-voice-input/src/client/mount.ts:48` |
| 官方先例（hooks） | `packages/experimental/client-ui-cot-translation/src/client/mount.ts:105` |
| DPG 卡片实现 | `dsh-project-groups/src/client/settings-card.tsx`（864 行） |
| DPG 卡片样式 | `dsh-project-groups/src/client/settings-card.module.css`（774 行） |
| AE 卡片实现 | `dsh-auto-expand/src/client/settings-card.tsx`（277 行） |
| AE 卡片样式 | `dsh-auto-expand/src/client/settings-card.module.css`（126 行） |
| AE 规范摘录 | `dsh-auto-expand/spec/SETTINGS-SPEC.md`（422 行） |
| AE 表单取舍 | `dsh-auto-expand/spec/SETTINGS-EXTENSION.md` §4（418 行） |

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
