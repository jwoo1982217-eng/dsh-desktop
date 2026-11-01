/**
 * Jet Hub 两处入口的**渲染与注册**（React 组件 + 槽注册）。
 *
 * 偏好状态与读写在同目录的 `panel-entry-store.js`（无 React 依赖，避免循环
 * import —— 插件详情页的卡片也要用同一份状态）。
 *
 * ## 为什么需要「两处入口二选一」
 *
 * Jet Hub 的主体是一整页（左边供应商列表，右边账号管理，外加备份/网关/用量
 * 这些页签）。它有两处进入路径，**渲染的是同一个 `JetHubPage` 组件、同一份
 * `rpcCall`，不存在两套实现**：
 *
 * - 主导航里的一行（`sidebar.panellist` 的 `jet-hub`），点它由宿主
 *   `layout.selectPanel('jet-hub')` 把页面渲染进中央主面板；
 * - 设置里的 `settings.section#jet-hub`（宿主 `SettingsRoot` 给左右内边距）
 *   —— ⚠️ 这一节**只在取值为 `'settings'` 时存在**，默认 `'sidebar'` 下它是注销的。
 *
 * 两条路径通向同一页 ⇒ 同时存在只是重复入口。卡片里的「面板入口」下拉让用户
 * 二选一：**严格互斥，任一时刻只有一个入口存在**。选 `'sidebar'` 时
 * `settings.section` 注销；选 `'settings'` 时主导航那一行注销。
 *
 * ⚠️ **注销 `settings.section` 是有意的**：设置弹层里不再有「Jet Hub」那一节。
 * 那也正是「仅侧栏」的字面含义 —— 想改回来随时可以去**插件详情页**的卡片里
 * 改（那张卡不随本下拉注销，见 `index.js` 的 `plugins.bundle.config` 注册）。
 *
 * ## 启动顺序
 *
 * 宿主偏好是异步读的，所以两处入口都**等这一读回来再注册**（读失败按「仅侧栏」
 * 兜底）—— 反过来先注册再撤销，会让改过入口的用户每次启动都闪一下。
 *
 * ## 注销侧栏行时的收尾
 *
 * 如果面板正停在 Jet Hub 上，要主动 `selectPanel(null)`，否则布局里会留着
 * 一个再也没有入口的 `activePanelId`（宿主的「返回会话」按钮会指向它）。
 */

import * as React from 'react';

import { JetHubPage } from './jet-hub.js';
// ⚠️ 2026-10-22 整页白屏事故的结构性补强（PR #10）：本文件注册的**两处槽位**
//    都直接渲染 `JetHubPage`，任一渲染期异常都会被 React 当成「整棵树出错」而
//    卸载整棵设置页/主面板（用户症状：「页面直接清空、切页无效、只能重启」）。
//    故两个入口都必须注册**包了边界的**组件，见 `error-boundary.js` 的文件头。
import { withErrorBoundary } from './error-boundary.js';
import {
  JET_HUB_PANEL_KEY,
  JET_HUB_SIDEBAR_ORDER,
  loadPanelEntry,
  panelEntryShowsSettings,
  panelEntryShowsSidebar,
  subscribePanelEntry,
} from './panel-entry-store.js';

/**
 * `settings.section`（设置弹层那一节）里渲染的 `JetHubPage`。
 *
 * ⚠️ **模块级常量**而不是每次注册时新建：组件身份必须稳定。槽位每次重渲染若拿到
 * 一个新组件类型，React 会卸载重挂整棵子树（页面里所有本地状态丢失）。
 */
const JetHubPageForSettings = withErrorBoundary(JetHubPage, { label: 'Jet Hub 设置页' });

/**
 * `main` 槽（中央主面板）里渲染的 `JetHubPage`。
 *
 * ⚠️ 与设置页那条**分开两个常量**：`withErrorBoundary` 的 `label` 要能区分
 * 「哪块坏了」（fallback 文案直接读它），而组件身份仍各自稳定。
 */
const JetHubPageForMain = withErrorBoundary(JetHubPage, { label: 'Jet Hub 面板' });

/**
 * 侧栏行的图标：六边形环 + 中心点。
 *
 * ⚠️ 只用纯 SVG 与 `currentColor`：宿主那一行是原生按钮，图标必须跟着主题色走，
 * 也不能依赖任何 UI 包（客户端模块不允许 require 宿主组件包）。
 *
 * ⚠️ 第一版画的是「五个圆点 + 辐条」，被用户当成「新建会话」的加号 —— 换成
 * 这个闭合六边形之后辨识度才够。
 *
 * @param {{ size?: number }} props 宿主传入的行高（缺省 16）
 */
export function JetHubSidebarIcon({ size }) {
  const px = typeof size === 'number' && size > 0 ? size : 16;
  return React.createElement(
    'svg',
    {
      width: px,
      height: px,
      viewBox: '0 0 16 16',
      fill: 'none',
      xmlns: 'http://www.w3.org/2000/svg',
      'aria-hidden': 'true',
    },
    React.createElement('path', {
      d: 'M8 1.7 13.5 4.85v6.3L8 14.3 2.5 11.15v-6.3z',
      stroke: 'currentColor',
      strokeWidth: 1.35,
      strokeLinejoin: 'round',
    }),
    React.createElement('circle', { cx: 8, cy: 8, r: 1.7, fill: 'currentColor' }),
  );
}

/**
 * 「侧栏」面板本体：Jet Hub 页 + 一圈内边距。
 *
 * 设置页的宿主自己给了 `padding: 0 24px 24px`（`SettingsRoot`），而 `main` 槽的
 * 宿主（中央面板）只负责顶部那条 28px 的标题带、左右下**不留白** —— 所以这里
 * 补左右下三边，并叠上宿主的顶部清障变量（`--dsh-frame-top-clearance`）。
 * 与插件市场页同款做法，只是市场页里各自的大块另有内边距。
 *
 * @param {{ rpcCall?: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown> }} props
 */
export function JetHubMainPanel({ rpcCall, chatGptCall, isolatedLoginCall }) {
  if (typeof rpcCall !== 'function') return null;
  return React.createElement(
    'div',
    { className: 'dim-jh-panelHost', 'data-plugin': 'dsh-providers-hub' },
    React.createElement(JetHubPageForMain, { rpcCall, chatGptCall, isolatedLoginCall }),
  );
}

/**
 * 注册 Jet Hub 的三处槽位，并让两处入口随「面板入口」偏好增删。
 *
 * 调用点：`plugin-src/client/index.js` 的 `apply()`。
 *
 * ⚠️ **不要**把本函数整体包进 `ctx.effect` —— 槽注册本身就是可撤销的
 * （`ctx.slots.register` 返回 disposer），多包一层只会在热替换时留下双份注册。
 *
 * @param {any} ctx 客户端插件上下文（需要 `slots` 与可选的 `layout`）
 * @param {(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>} rpcCall
 */
export function registerJetHubPanelEntries(ctx, rpcCall, local = {}) {
  // `main` key **无条件**注册：入口切到「仅设置页」之后，用户仍可能在切换前
  // 把面板停在 Jet Hub 上，少了这个 key 宿主 `layout.selectPanel('jet-hub')`
  // 会抛「未注册的 panel」。它只提供渲染体，**不是**入口。
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: JET_HUB_PANEL_KEY,
    inject: () => ({ rpcCall, ...local }),
  }, JetHubMainPanel));

  // 布局服务只用于「侧栏行被撤销时取消选中」。它不在本插件的 inject 声明里
  // （那是硬依赖，缺了整条插件都不激活），所以用 ctx.inject 拿作用域副本；
  // 拿不到就跳过。
  let layout;
  ctx.inject(['layout'], (scoped) => {
    layout = scoped.layout;
    return () => {
      layout = undefined;
    };
  });

  /** 当前面板若是 Jet Hub，就撤销选中。 */
  const deselectIfActive = () => {
    try {
      if (layout?.panelInfo?.getSnapshot?.()?.activePanelId !== JET_HUB_PANEL_KEY) return;
      layout.selectPanel(null);
    } catch (caught) {
      console.warn('[jet-hub] 撤销侧栏入口时取消选中失败', caught);
    }
  };

  // ── 入口一：主导航里的那一行 ──
  ctx.slots.inject('sidebar.panellist', () => {
    /** 当前侧栏行的 disposer；`undefined` = 还没注册（或已撤销）。 */
    let stopRow;

    /**
     * 按目标状态增删侧栏行。**幂等**：订阅回调与首次读值可能各来一次，
     * 重复调用不会重复注册。
     *
     * @param {boolean} visible
     */
    const sync = (visible) => {
      if (visible && stopRow === undefined) {
        stopRow = ctx.slots.register({
          name: 'sidebar.panellist',
          id: JET_HUB_PANEL_KEY,
          order: JET_HUB_SIDEBAR_ORDER,
          label: () => 'Jet Hub',
        }, JetHubSidebarIcon);
        return;
      }
      if (!visible && stopRow !== undefined) {
        const stop = stopRow;
        stopRow = undefined;
        stop();
        deselectIfActive();
      }
    };

    const unsubscribe = subscribePanelEntry(() => sync(panelEntryShowsSidebar()));

    /**
     * ⚠️⚠️ **注册当下必须先按当前取值同步一次**（2026-10-24 审计 M1，P1 真缺陷）。
     *
     * 原来这里**没有**这一行，只靠 ①`subscribePanelEntry` 回调（要 `publish()`
     * 先发生）②`loadPanelEntry().then(...)`。而读值未 settle 前 `sync` 从未被
     * 调用 ⇒ **两处入口一个都不注册**，界面空白，用户以为插件坏了。
     *
     * 「`null` 期间按仅侧栏兜底」这句话写在 `panelEntryShowsSidebar` 的谓词里，
     * 但谓词只在 `sync` **被调用时**求值 —— 不调用等于兜底不执行。**谓词层成立、
     * 接线层不成立**，而 store 的单测只看谓词，看不见这个缺口。
     *
     * 触发条件：`readSignal()` 在缺 `AbortSignal.timeout` 时返回 `undefined`
     * （`build.mjs` 的 `target: ['chrome100']`，该 API 是 Chrome 103+）⇒ 读取
     * 可无限悬挂；叠加 `inflight` 复用 ⇒ 一次悬挂让后续每次读取都复用永不
     * settle 的 Promise，**永久**两处皆无。
     *
     * ⇒ 先同步一次（`null` ⇒ 注册侧栏行），再等宿主读值回来纠正。
     */
    sync(panelEntryShowsSidebar());

    // 读到宿主偏好之后再同步一次：它可能把上面那次「兜底的注册」纠正成撤销。
    //
    // ⚠️ `disposed` 守卫**必需**：本槽位被宿主 dispose 之后，在飞的那次读取仍会
    //    resolve，那时再调 `sync` 就会往一个已销毁的作用域里重新注册（热替换时
    //    留下双份注册，表现为侧栏出现两行）。
    let disposed = false;
    void loadPanelEntry(rpcCall).then(() => {
      if (!disposed) sync(panelEntryShowsSidebar());
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (stopRow !== undefined) {
        const stop = stopRow;
        stopRow = undefined;
        stop();
      }
    };
  });

  // ── 入口二：设置弹层里的那一节 ──
  //
  // ⚠️ 与上面那条**互斥**：选「仅侧栏」时本槽位整条注销，设置弹层里不再有
  //    「Jet Hub」一节。这是下拉语义的直接后果，不是缺陷。
  //
  // ⚠️ **弹层不会卡住、× 也不会消失**（2026-10-24 审计纠正，两轮都指出这处）：
  //    那个 × 由 `SettingsPanel` 自己渲染（`dsh-client-ui-settings-general` 的
  //    `className: …close` / `onClick: onClose`），**不属于** `settings.section`
  //    这一节 ⇒ 本行此前写的「关闭按钮随之消失」是**事实错误**。
  //    另外 `SettingsPanel` 的 `const active = rows.find(r => r.id === activeId)?.id
  //    ?? rows[0]?.id` ⇒ 本节注销时会**回落到首节**，所以弹层既不空白也不卡住，
  //    只是内容会静默跳走（同样无提示，属可接受）。
  ctx.slots.inject('settings.section', () => {
    /** 当前设置节的 disposer；`undefined` = 还没注册（或已撤销）。 */
    let stopSection;

    /**
     * 按目标状态增删设置节。同样是**幂等**的。
     *
     * @param {boolean} visible
     */
    const sync = (visible) => {
      if (visible && stopSection === undefined) {
        stopSection = ctx.slots.register({
          name: 'settings.section',
          id: JET_HUB_PANEL_KEY,
          order: 50,
          label: () => 'Jet Hub',
          inject: () => ({ rpcCall, ...local }),
        }, JetHubPageForSettings);
        return;
      }
      if (!visible && stopSection !== undefined) {
        const stop = stopSection;
        stopSection = undefined;
        stop();
      }
    };

    const unsubscribe = subscribePanelEntry(() => sync(panelEntryShowsSettings()));

    /**
     * ⚠️ 注册当下也先同步一次（与侧栏行同款，2026-10-24 审计 M1）。
     *
     * 与侧栏行的差别：`null`（还没读到）时 `panelEntryShowsSettings()` 返回
     * **false** ⇒ 这次 `sync(false)` 是**空操作**，不会错误地放出设置节。
     * 但若模块状态里**已有**上次读到的值（热替换 / 二次 inject），这一行就能
     * 立刻把设置节放对位置，不必等一次网络往返。
     */
    sync(panelEntryShowsSettings());

    // ⚠️ 与侧栏行相反：`panelEntry()` 为 `null`（还没读到）时本函数返回 false，
    //    所以首次读值**必须**等回来再判 —— 否则「仅设置页」的用户每次启动都
    //    会看到设置节晚一拍出现。
    // ⚠️ `disposed` 守卫同侧栏行那条：dispose 之后在飞的读取仍会 resolve。
    let disposed = false;
    void loadPanelEntry(rpcCall).then(() => {
      if (!disposed) sync(panelEntryShowsSettings());
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (stopSection !== undefined) {
        const stop = stopSection;
        stopSection = undefined;
        stop();
      }
    };
  });
}
