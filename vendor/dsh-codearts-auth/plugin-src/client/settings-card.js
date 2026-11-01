/**
 * 本插件在**插件详情页**上的自有设置卡片。
 *
 * ## 槽位
 *
 * 宿主插件页声明 `plugins.bundle.config` —— 一个按**包名**分派的 keyed 槽，
 * 渲染在该页的描述与「包含的组件」之间（`PluginManagerPage.tsx` 的
 * `<section data-plugin-config>`）。注册在 `index.js`，`key` 必须是本包名：
 * `config-ledger.ts` 把这个槽的 key 投影成「已配置」标志，**key 不匹配则整段
 * 不渲染且无任何报错**。
 *
 * ## 为什么不用 `form`
 *
 * 槽位还提供 `PluginConfigViewProps.form`（宿主配置表单）。本卡无视它：这个偏好
 * 住本插件自己的领域（`state.json`），走自己的 RPC，与官方 `client-ui-voice-input`
 * 无视 `form` 用自己 Remote 的做法同款。
 *
 * ## 结构
 *
 * 最外层 `.dim-jh-cardStack`（`display:flex; flex-direction:column; gap:0`）
 * 是**必须**的：官方 `detailSection` 给直接子元素 `gap: 12px`，官方插件卡
 * （终端 / 网页搜索）都把块包在内层 column 里，容器只看到一个子元素。
 * 间距由每块自己的 `padding` 提供。
 *
 * 卡片体**不画分隔线** —— 官方插件卡在共享容器里也不画。
 */

import * as React from 'react';

import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives';

import {
  loadPanelEntry,
  panelEntry,
  panelEntryReadFailed,
  setPanelEntry,
  subscribePanelEntry,
} from './panel-entry-store.js';

/**
 * 两个选项（**唯一**真源：标签与取值都从这里来）。
 *
 * ⚠️ `id` 必须与宿主 `PANEL_ENTRY_VALUES` 逐字一致 —— 那边是写入侧的校验表，
 * 这里写错会被宿主以 `bad-request` 拒绝。
 */
const OPTIONS = [
  { id: 'sidebar', label: '仅侧栏' },
  { id: 'settings', label: '仅设置页' },
];

/** 下拉标签。 */
const CARD_TITLE = '面板入口';

/** 正常态描述：一句话讲清互斥语义。 */
const CARD_DESC = '决定 Jet Hub 出现在哪里。两个入口是同一个页面，任一时刻只保留一个。';

/**
 * 读取失败时的描述。
 *
 * ⚠️ 只换文案、**不禁用**控件：一次读取抖动不该让用户失去「重新选一次」这条
 * 自救路径（与页头那些开关同一取向）。
 */
const CARD_DESC_READ_FAILED = '⚠️ 未能读取当前设置，下面显示的是默认值。重新选一次即可写回。';

/**
 * 写入失败时的描述。
 *
 * ⚠️ **必须与读失败分开**（2026-10-24 复核 I5）：两者曾共用一条文案，于是写失败
 * 时用户看到「未能读取当前设置…显示的是默认值」——既不准（显示的可能就是已知的
 * 真实值），也把他引向错误的排查方向（去怀疑读取，而实际是写入被拒）。
 */
const CARD_DESC_WRITE_FAILED = '⚠️ 刚才那次没有保存成功，下面仍是原来的设置。请再选一次。';

/**
 * 取当前应当显示的取值：`null`（还没读到）按仅侧栏显示。
 *
 * @returns {'sidebar' | 'settings'}
 */
function currentEntry() {
  return panelEntry() ?? 'sidebar';
}

/**
 * 插件详情页上的「面板入口」设置卡。
 *
 * @param {{ rpcCall?: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown> }} props
 *   槽位通过 `inject: () => ({ rpcCall })` 交入，与 `settings.section` 同构。
 */
export function JetHubPanelEntryCard({ rpcCall }) {
  const [entry, setEntry] = React.useState(currentEntry);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  /**
   * 「读失败」标记来自 store（它是模块级共享状态）。
   *
   * ⚠️ 与下面的 `writeFailed` **必须分开**（2026-10-24 复核 I5）：两者曾共用一个
   * 标记，于是**写失败**时描述会变成「未能读取当前设置，下面显示的是默认值」——
   * 既不准确（值可能是已知的真实值、不是默认值），也把用户引向错误的排查方向。
   */
  const [readFailed, setReadFailed] = React.useState(() => panelEntryReadFailed());
  /** 「写失败」标记：本组件自己的状态，不共享（写失败是这一张卡的事）。 */
  const [writeFailed, setWriteFailed] = React.useState(false);
  /**
   * 最新一次写入意图。
   *
   * ⚠️ `busy` 只能挡住 `<button>`（它挂了 `disabled`）；`Menu` 的 `onSelect`
   * 在菜单关闭后仍会被触发，所以**闸门必须也写在回调里**（2026-10-24 复核 I4）：
   * 两次快速选择会发两次 `panelEntry.set`，谁后回谁定终值，可能与用户最后一次
   * 点击不一致。
   */
  const busyRef = React.useRef(false);

  // 与两处槽位注册共用同一份进程内状态：任何一侧改完，卡片一起更新
  // （主面板与设置弹层可能同时挂着两个 JetHubPage 实例）。
  React.useEffect(() => subscribePanelEntry(() => {
    setEntry(currentEntry());
    setReadFailed(panelEntryReadFailed());
  }), []);

  // ⚠️ 挂载时**自己读一次**，不能只依赖 `panel-entry.js` 那两处。
  //
  // 那两处只在「对应槽位被 inject」时才跑；若宿主某天不再提供其中一个槽位
  // （或本插件只在详情页被打开、两处 inject 都还没触发），卡片就会永远停在
  // 默认值上，而下拉显示的却是「仅侧栏」——用户会以为自己的设置丢了。
  // store 的 `loadPanelEntry` 自带并发去重，这次调用不会多打一次 RPC。
  React.useEffect(() => {
    if (typeof rpcCall !== 'function') return;
    void loadPanelEntry(rpcCall).then(() => {
      setEntry(currentEntry());
      setReadFailed(panelEntryReadFailed());
    });
  }, [rpcCall]);

  const selectedLabel = OPTIONS.find((option) => option.id === entry)?.label ?? OPTIONS[0].label;

  const choose = React.useCallback(async (next) => {
    if (typeof rpcCall !== 'function') return;
    // ⚠️ 重入闸门：`busy` 挡不住 `Menu.onSelect`，必须在这里判。
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await setPanelEntry(rpcCall, next);
      // ⚠️ **不做乐观更新**：以宿主返回值（落盘后重读）为准，store 会在成功时
      // 广播，上面那个订阅回调随之把 setEntry 拉正。
      setWriteFailed(false);
    } catch (caught) {
      console.error('[jet-hub] 切换面板入口失败:', caught);
      // 回滚到宿主的实际状态，别停在用户点出来的位置上。
      setEntry(currentEntry());
      setWriteFailed(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [rpcCall]);

  return React.createElement('div', { className: 'dim-jh-cardStack' },
    React.createElement('div', { className: 'dim-jh-cardRow' },
      React.createElement('div', { className: 'dim-jh-cardRowText' },
        React.createElement('div', { className: 'dim-jh-cardTitle' }, CARD_TITLE),
        React.createElement('div', { className: 'dim-jh-cardDesc' },
          // 两种失败各有各的说法：读失败说「读到的是默认值」，写失败说「刚才那次没存上」。
          writeFailed ? CARD_DESC_WRITE_FAILED
            : readFailed ? CARD_DESC_READ_FAILED
              : CARD_DESC)),
      React.createElement(Menu, {
        open,
        onClose: () => setOpen(false),
        items: OPTIONS.map((option) => ({ id: option.id, label: option.label })),
        selectedId: entry,
        onSelect: (id) => {
          setOpen(false);
          // ⚠️ 重入闸门在 `choose` 里（`busy` 挡不住这里，见 busyRef 的说明）。
          void choose(id);
        },
        align: 'end',
        // ⚠️ **必须开**：卡片在插件页的滚动 detail 列里，就地展开的列表会被
        //    overflow 裁剪（两个参考实现都踩过并留了这条注释）。
        portal: true,
        anchor: React.createElement('button', {
          type: 'button',
          className: 'dim-jh-cardSelector',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          disabled: busy,
          onClick: () => setOpen((value) => !value),
        },
          selectedLabel,
          React.createElement(IconChevronDownOutlineRegular, { className: 'dim-jh-cardChevron' })),
      })));
}
