/**
 * 「添加 Qiniu (七牛云) 账号」弹窗。
 *
 * ## 为什么单独成文件（而不是复用 `OpencodeKeyModal` / `ModelscopeKeyModal`）
 *
 * 三个 provider 都是「手工粘贴 API Key」，但**契约不同**，混用会出错：
 *
 * | | opencode | modelscope | qiniu |
 * |---|---|---|---|
 * | RPC 方法 | `opencode.addAccount` | `modelscope.addAccount` | `qiniu.addAccount` |
 * | Key 形状 | `sk-…` / `oc_sk_…`（不绑前缀） | `ms-…` | 无固定前缀（`/^[A-Za-z0-9_.-]{16,}$/`） |
 * | 第二个入口 | 匿名通道（`public`） | **没有** | **没有** |
 *
 * 复用同一个组件就要在内部按 provider 分三处支 —— 而这正是
 * `new-account.js` 那套「判据方向相反的两个人容易只改一处」的老问题。
 * 独立组件把差异摊在文件边界上，代价只是约 90 行重复的脚手架。
 *
 * ## ⚠️⚠️ 必须是组件、不能当普通函数直接调用
 *
 * 本组件内部有 `useState`。若在 ProviderPanel 的渲染过程中**直接函数调用**，它的
 * hook 会被算进 ProviderPanel —— 于是「弹窗开」与「弹窗关」两次渲染的 hook 数量
 * 不同，React 抛 #310（"Rendered more hooks than during the previous render"），
 * **整个设置页白屏**。与 `OpencodeProxyModal` 上方记录的真实事故（2026-10-02）
 * 完全同型。
 *
 * ## ⚠️ 为什么不用 `window.prompt`
 *
 * DSH 客户端跑在**沙箱**环境里，`prompt()` 直接抛 `prompt() is not supported`
 * （真机报障 2026-10-01）。本仓库其余交互一律自绘 modal。
 *
 * ## 为什么输入框内容不进 React state
 *
 * API Key 是凭据。放进 `useState` 会让它随每次父组件重渲染经过整棵组件树，
 * 也可能被 devtools 的组件树检查器读到 —— 与「Key 存 credentials、不进明文」
 * 的口径不符。故用 `inputRef` + DOM 读值。只有**错误信息**进 state。
 *
 * ⚠️ **不要把这个 JSDoc 的 `@param` 留在模块头里**：客户端有一道
 * `tsc --checkJs` 的**未声明变量闸**（`tests/unit/credits-capabilities.spec.ts`
 * 的「plugin-src/client 下没有未声明变量」）。模块头没有宿主函数，tsc 会把
 * `@param props { error, busy, … }` 里的 `error` 当成**类型名**去解析，
 * 报 `TS2552: Cannot find name 'error'` —— 而那道闸的失败文案是
 * 「会崩掉整个设置页」，排障方向被完全带偏（modelscope 同款踩过）。
 * `@param` 一律贴在**函数自己的** JSDoc 上（见下方 `QiniuKeyModal`）。
 */

// ⚠️ 必须用**命名空间导入**（与 jet-hub.js 逐字一致）：`react` 在 esbuild
// 配置里是 external，默认导入 `import React from 'react'` 在 CJS 产物里
// 会变成 `undefined`，渲染时炸「React.createElement is not a function」。
import * as React from 'react'

/**
 * Qiniu (七牛云) 的 API Key 申请页。
 *
 * 真实入口（2026-10-29 查证）：七牛云控制台 →「AI 大模型推理」→「API Key」。
 * ⚠️ 必须与宿主侧 `src/qiniu-rpc.ts` / `src/qiniu-adapter.ts` 的报错文案指向**同一处**
 *    —— 两处不一致会让用户在「弹窗说去 A、报错说去 B」之间来回，而两边都不算错，
 *    只是无法照做（modelscope 同款要求）。
 */
const TOKEN_URL = 'https://portal.qiniu.com/ai-inference/api-key'

/**
 * 弹窗组件本体（**组件**，用 `React.createElement(QiniuKeyModal, props)` 渲染）。
 *
 * @param props `{ error, busy, inputRef, onSubmit(value), onClose }`
 */
export function QiniuKeyModal({ error, busy, inputRef, onSubmit, onClose }) {
  const submit = () => {
    const value = inputRef && inputRef.current ? inputRef.current.value : ''
    // 空串 = 没填就点确认：静默关弹窗，不报错。
    // ⚠️ 与 opencode 的语义**不同**：那边空串意味着「用免费通道」，
    // 这边空串只是「什么都没做」—— qiniu 没有匿名通道，硬报错反而吓人。
    if (String(value).trim() === '') {
      if (onClose) onClose()
      return
    }
    onSubmit(value)
  }
  return React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    onClick: (e) => { if (e.target === e.currentTarget && !busy && onClose) onClose() },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      style: { maxWidth: '520px' },
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' }, '添加 Qiniu (七牛云) 账号'),
      ),
      // ⚠️ 内容必须放进 modalBody（flex:1; min-height:0; overflow-y:auto），
      // 否则弹窗较高时内容会被裁掉（见 jet-hub.js 既有 modal 的注释）。
      React.createElement('div', { className: 'dim-jh-modalBody' },
        React.createElement('p', { className: 'dim-jh-modalHint' },
          '在 ' + TOKEN_URL + ' 生成 API Key 后粘贴到下方。'),
        // ⚠️ Key 形状宽松：至少 16 位，可含字母、数字与 _ . -（无固定前缀）。
        React.createElement('p', { className: 'dim-jh-hint' },
          'Key 至少 16 位字符，可含字母、数字与 _ . -（无固定前缀）。'),
        React.createElement('div', { className: 'dim-jh-formRows' },
          React.createElement('input', {
            ref: inputRef,
            className: 'dim-jh-input',
            // ⚠️ password 类型：API Key 是凭据，不该在屏幕上裸显。
            type: 'password',
            placeholder: 'API Key（≥16 位）',
            autoFocus: true,
            // Enter 直接提交：粘贴 Key 后最自然的动作就是回车。
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            },
          }),
        ),
        // ⚠️ 错误留在弹窗内：把整个账号列表切成错误态会让用户刚填的 Key
        // 与错误信息一起消失，只能刷新重试。
        error
          ? React.createElement('p', { className: 'dim-jh-error', role: 'alert' }, '添加失败：' + error)
          : null,
      ),
      React.createElement('div', { className: 'dim-jh-modalActions' },
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn dim-jh-btnPrimary',
          disabled: busy,
          onClick: submit,
        }, busy ? '添加中…' : '添加'),
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: busy,
          onClick: () => { if (onClose) onClose() },
        }, '取消'),
      ),
    ),
  )
}

/**
 * 「编辑 Qiniu (七牛云) 账号的 API Key」弹窗。
 *
 * ## 为什么需要它（不能靠「删除后重建」）
 *
 * 账号 id 与 credentialRef 都由 **Key 派生**（见宿主侧 qiniu 实现）⇒ 换一把 Key
 * 就等于**换一条账号**。若没有这个弹窗，用户填错 Key 或想换 Key 时只能删掉重建，
 * **会丢失昵称与停用状态**。
 *
 * ⚠️ 也正因如此，本弹窗**必须提示**「Key 变了账号标识也会变」—— 否则用户改完
 * 发现账号「不见了」，会以为数据丢了（modelscope 同款报障）。
 *
 * ## ⚠️ 与上面「添加」弹窗**刻意不合并**
 *
 * 两者动作语义不同（新增 vs 替换）、按钮文案不同、成功后的处理也不同（替换可能
 * 要刷新面板）。合并就要在内部按 mode 分支——而这正是本文件模块头反对的
 * 「同一个组件里按 provider/模式分支，容易只改一处」。
 *
 * ## ⚠️ 明文 Key 绝不整串上屏
 *
 * 输入框 `type: 'password'`；卡片上只显示**宿主算好的打码串**（`qiniuKeyMask`）——
 * ⚠️ 客户端**不自己**打码，避免与宿主 `maskQiniuKey` 两份实现漂移。
 *
 * @param props `{ error, busy, currentMasked, inputRef, onSubmit(value), onClose }`
 */
export function QiniuKeyEditModal({ error, busy, currentMasked, inputRef, onSubmit, onClose }) {
  const submit = () => {
    const value = inputRef && inputRef.current ? inputRef.current.value : ''
    // 空串 = 没填就点确认：静默关弹窗，不报错（不制造无谓的失败提示）。
    if (String(value).trim() === '') {
      if (onClose) onClose()
      return
    }
    onSubmit(value)
  }
  return React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    onClick: (e) => { if (e.target === e.currentTarget && !busy && onClose) onClose() },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      style: { maxWidth: '520px' },
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' }, '编辑 API Key'),
      ),
      React.createElement('div', { className: 'dim-jh-modalBody' },
        React.createElement('p', { className: 'dim-jh-modalHint' },
          '在 ' + TOKEN_URL + ' 生成 API Key 后粘贴到下方。'
          + (currentMasked ? '当前：' + currentMasked : '当前：尚未设置')),
        React.createElement('div', { className: 'dim-jh-formRows' },
          React.createElement('input', {
            ref: inputRef,
            className: 'dim-jh-input',
            // ⚠️ password 类型：API Key 是凭据，不该在屏幕上裸显。
            type: 'password',
            placeholder: 'API Key（≥16 位）',
            autoFocus: true,
            disabled: !!busy,
            // Enter 直接提交：粘贴 Key 后最自然的动作就是回车。
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            },
          }),
        ),
        React.createElement('p', { className: 'dim-jh-modalHint' },
          '注意：换一把 Key 会同时更换该账号的标识（它由 Key 派生），'
          + '昵称与停用状态会保留。同一把 Key 只对应一个账号。'),
        // ⚠️ 错误留在弹窗内：把账号列表切成错误态会让用户刚填的 Key
        // 与错误信息一起消失，只能刷新重试。
        error
          ? React.createElement('p', { className: 'dim-jh-error', role: 'alert' }, '保存失败：' + error)
          : null,
      ),
      React.createElement('div', { className: 'dim-jh-modalActions' },
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn dim-jh-btnPrimary',
          disabled: !!busy,
          onClick: submit,
        }, busy ? '保存中…' : '保存'),
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: !!busy,
          onClick: () => { if (onClose) onClose() },
        }, '取消'),
      ),
    ),
  )
}
