/**
 * 面板级错误边界（2026-10-22 整页白屏事故的结构性补强）。
 *
 * ## 为什么必须有这一层
 *
 * 那次事故的**直接**原因是 `probeNotice` 被写成裸字符串，渲染端读
 * `.details.length` 抛 `TypeError`（源头已修，见 `notice-shape.js`）。
 *
 * 但用户的**症状描述**比「提示文案不对」严重得多：
 *
 * > 「魔塔社区的令牌我一保存，页面直接清空，切换页面无效，只能重启 dsh」
 *
 * 「页面清空 + 切页无效 + 只能重启」不是那个 TypeError 造成的 —— 是**没有错误
 * 边界**造成的：React 18 的默认行为是「渲染期抛错 ⇒ 卸载整棵树」。本插件的
 * `settings.section` 直接注册 `JetHubPage`，于是任何一个渲染期异常都会让
 * **整个设置页（连同侧栏）**消失，用户除了重启没有别的出路。
 *
 * ⇒ 两件事必须分开修：
 * 1. **那个 TypeError 的源头**（`notice-shape.js` + 两处调用点）—— 让它不再发生；
 * 2. **错误的影响半径**（本文件）—— 让将来任何一次同类失误只坏掉这一个面板。
 *
 * ⚠️ 第 2 条**不能**被用来解释「所以第 1 条可以不做」：边界只是止损，
 * 它会让 bug **更难发现**（用户看到一块报错而不是崩溃），不是修复。
 *
 * ## 为什么是 class 而不是 hook
 *
 * React 至今没有函数组件版的错误捕获 API（`componentDidCatch` /
 * `getDerivedStateFromError` 只在 class 上）。这不是风格选择。
 *
 * ## 为什么 fallback 里要显示错误原文
 *
 * 只显示「出错了」等于把这次事故的可诊断性再降一级 —— 用户当时连一句报错都
 * 没看到。这里把 `error.message` 原样露出（它是**渲染期异常消息**，不是凭据：
 * 本插件的凭据从不下发到客户端，见 `jet-hub-rpc.ts` 的 `enrichAccountIdentity`），
 * 用户截个图就能定位。
 *
 * ## ⚠️⚠️ 能力边界 —— **这些它拦不住**（别把它当万能兜底）
 *
 * 错误边界只捕获**渲染期**异常（子组件渲染、constructor、生命周期方法）。
 * 以下四类**完全不受保护**，发生时仍会卸载整棵树或直接崩掉：
 *
 * 1. **事件回调里的异常**（`onClick` / `onChange` 等）—— React 不把它们算作
 *    渲染期异常，`getDerivedStateFromError` / `componentDidCatch` **不会被调用**
 *    （2026-10-24 真机实测：`window.onerror` 触发、容器内容不变、边界零介入）；
 * 2. **异步回调 / `await` 之后的异常**（Promise、`setTimeout`、订阅回调）——
 *    真机实测同样零介入；
 * 3. **模块求值期（import 时）的异常** —— 那时 React 还没开始渲染；
 *    本文件被 import 时求值 `React.Component` 就属于这一类；
 * 4. **渲染进程级崩溃** —— 发生在 React 之外。
 *
 * ⇒ 反向推论同样重要：**不要把取数/解析逻辑挪进渲染路径**、**不要依赖边界去
 * 接住异步流程里的错误**。它在这里的职责只有一个：把「一次失误 = 白屏」降级成
 * 「一次失误 = 一块报错」。
 *
 * ## ⚠️⚠️ fallback 自身必须**永不抛错**（2026-10-24 对抗审计，真机实证）
 *
 * fallback 里要读 `error.message`、还要 `String(error)` —— **这两步都可能抛**：
 *
 * - `error.message` 可能是**抛错的 getter**；
 * - `String(error)` 对 `Object.create(null)` 抛
 *   `TypeError: Cannot convert object to primitive value`。
 *
 * 一旦 fallback 自身抛错，React 会**再卸一次树** ⇒ 边界在「错误值不可字符串化」
 * 时**与没有边界完全等价**（真机实测容器被清空、兄弟节点一并消失）——
 * 而那恰恰是它存在的唯一场景。⇒ 文案计算全部收进 `describeThrown()`。
 *
 * @module plugin-src/client/error-boundary.js
 */
import * as React from 'react';

/**
 * 「没有错误」的**专用哨兵**。
 *
 * ⚠️⚠️ **不能用 `null`**（2026-10-24 对抗审计实测的真缺陷）：`null` 同时是
 * 「初始态」和**合法抛出值**，`getDerivedStateFromError(null)` 返回
 * `{ error: null }` ⇒ `render()` 会认为「没出错」⇒ 边界**不产出 fallback**。
 * 真机实测（Chromium + react-dom）：抛 `null` 的子组件让**整个容器被清空**、
 * 兄弟节点一并消失 —— **与没有边界同形**，即原始 P0 症状原样复发。
 *
 * `Symbol` 不会与真实错误值撞车（`Symbol()` 每次调用都是唯一值），
 * 所以这个判据是可靠的。
 */
const NO_ERROR = Symbol('jet-hub:no-error');

/**
 * 把任意抛出值安全地转成一行可读文本。**保证不抛**（这是它的全部契约）。
 *
 * 三级降级：`error.message` → `String(error)` → 固定文案。
 * ⚠️ 前两级各自包一层 `try`：报错 getter 与无原型对象都会在这里抛
 * （见文件头「fallback 自身必须永不抛错」）。
 *
 * @param {unknown} error 被 `throw` 出来的任意值
 * @returns {string} 一定可渲染的文本
 */
function describeThrown(error) {
  // ① `Error` 是最常见的形状；`message` 非空串才有信息量。
  //    ⚠️ 读取 `.message` 本身就可能抛（getter），所以整个判断都在 try 里。
  try {
    if (error !== null && error !== undefined
      && typeof error.message === 'string' && error.message.length > 0) {
      return error.message;
    }
  } catch {
    // 抛错的 getter：忽略，继续走 ②
  }
  // ② 退到 `String(error)`。⚠️ `Object.create(null)` 等无原型的值会抛。
  try {
    return String(error);
  } catch {
    return '（抛出值无法转为文本，请查看控制台）';
  }
}

/**
 * 包一层错误边界，返回可注册到槽位的组件。
 *
 * ⚠️ **调用方必须在模块级持有返回值**（不要每次 render 新建）：本工厂每次调用
 * 都产生一个**新的类**，而组件身份必须稳定 —— 否则槽位每次重渲染都换一个组件
 * 类型，React 会把整棵子树卸载重挂（面板内所有本地状态丢失）。
 *
 * @template {object} P
 * @param {React.ComponentType<P>} Inner 被保护的组件。
 * @param {{ label?: string } | null | undefined} [options] `label` 用于 fallback
 *   文案（标明是哪块坏了）。⚠️ 显式允许 `null`：默认参数只覆盖 `undefined`，
 *   传 `null` 时若直接读 `.label` 会在**工厂期**抛 TypeError（2026-10-24 审计）。
 * @returns {React.ComponentType<P>}
 */
export function withErrorBoundary(Inner, options) {
  const label = options !== null && typeof options === 'object'
    && typeof options.label === 'string' && options.label.length > 0
    ? options.label
    : '这个面板';

  class PanelErrorBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: NO_ERROR };
    }

    static getDerivedStateFromError(error) {
      return { error };
    }

    componentDidCatch(error, info) {
      // ⚠️ 只打日志，不向上抛：向上抛会让宿主再卸一次树，边界就白加了。
      //    `componentStack` 是定位「哪个组件」的唯一线索。
      console.error(`[jet-hub] ${label}渲染失败，已拦住（页面其余部分继续可用）：`, error, info?.componentStack);
    }

    render() {
      const error = this.state.error;
      if (error === NO_ERROR) return React.createElement(Inner, this.props);
      const message = describeThrown(error);
      return React.createElement('div', {
        className: 'dim-jh-probeNotice',
        'data-tone': 'error',
        role: 'alert',
        style: { margin: '16px' },
      },
        React.createElement('div', null, `${label}渲染失败，已拦住 —— 其余页面仍可正常使用，不必重启。`),
        React.createElement('div', { style: { marginTop: '6px', fontFamily: 'monospace', fontSize: '12px' } }, message),
        // ⚠️ **必须给出可自我恢复的出路**（2026-10-25 审计 A3-2）。
        //
        // 本 fallback 是**粘性**的：没有 `key`、也没有 `componentDidUpdate`
        // 重置 ⇒ 同一实例一旦进 error 就永远显示 fallback（数据恢复了也不回来）。
        // 审计实测：数据恢复后仍显示 fallback，只有**新建实例**才恢复。
        //
        // 而用户其实**不必重启**：宿主 `SettingsPanel` 在 `open === false` 时整棵
        // 不挂载、`main` 是 keyed 槽 ⇒「关掉设置再打开」/「切走再切回」都能恢复。
        // 但**这条路径不可发现** —— 用户看到一块报错，不知道关掉再打开就能好。
        //
        // ⇒ 两件事：①给一个**就地重试**（`setState` 回 `NO_ERROR`，子树随即重挂载，
        // 比让用户摸索「关掉再打开」快得多）；②把那条路径**写出来**当兜底。
        React.createElement('div', { style: { marginTop: '8px' } },
          React.createElement('button', {
            type: 'button',
            className: 'dim-jh-btn',
            onClick: () => {
              // ⚠️ 只重置错误状态，**不**清其它 state：子树会重新渲染，
              //    若缺陷仍在就再进一次 error（可接受，用户能再点一次）。
              this.setState({ error: NO_ERROR });
            },
          }, '重试'),
          React.createElement('span', { style: { marginLeft: '8px', opacity: 0.75 } },
            '也可以关掉这一节再重新打开（或切到别的页面再切回来）来恢复。')),
        React.createElement('div', { style: { marginTop: '6px' } },
          '这是插件的缺陷，不是你操作错了。把上面这行报错连同「当时点了什么」一起反馈即可。'));
    }
  }

  PanelErrorBoundary.displayName = `withErrorBoundary(${Inner.displayName || Inner.name || 'Component'})`;
  return PanelErrorBoundary;
}
