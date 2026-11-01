/**
 * opencode 账号的「设置出口代理」弹窗。
 *
 * ## 三类输入（设计文档 §3）
 *
 * - **本地代理客户端端口**：`http://127.0.0.1:7897`（Clash / mihomo 混合端口等）
 * - **HTTP(S) 代理**：`http[s]://host:port`，可带 `user:pass@`
 * - **SOCKS5**：`socks5://host:port`，可带认证
 *
 * 空 = 清除（账号回到「与其它无代理账号共享本机出口」）。
 *
 * ## 为什么在「同一 IP」这件事上要专门解释
 *
 * 一个 NAT 后的多台 PC 共享同一个公网出口 IP，而 OpenCode Zen 的匿名通道
 * **按出口 IP 限流** —— 所以「多账号」本身并不能把配额分开：不给代理时，
 * 所有账号（连同匿名通道）都在**同一个配额桶**里。这就是本弹窗存在的理由，
 * 提示语必须说清这一点，否则用户会以为「加了号就等于多了额度」。
 *
 * ⚠️ 本文件是**纯展示层**：合法性判断在宿主侧 `src/opencode.ts` 的
 * `normalizeProxy`。前端只做输入形态的便利解析（补 scheme、给端口预设），
 * 避免前后端两套规则漂移 —— 用户填错时以宿主返回的中文理由为准。
 */

// ⚠️ 必须用**命名空间导入**（与 jet-hub.js 逐字一致）：`react` 在 esbuild
// 配置里是 external，默认导入 `import React from 'react'` 在 CJS 产物里
// 会变成 `undefined`，渲染时炸「React.createElement is not a function」。
import * as React from 'react'

/** 常见本地代理端口预设（点一下就填好，省得手打）。 */
const LOCAL_PORT_PRESETS = [
  { port: 7897, label: '7897', url: 'http://127.0.0.1:7897', hint: 'Clash / mihomo 混合端口' },
  { port: 7890, label: '7890', url: 'http://127.0.0.1:7890', hint: 'Clash 旧版 HTTP 端口' },
  { port: 1080, label: '1080', url: 'socks5://127.0.0.1:1080', hint: 'SOCKS5' },
  { port: 10808, label: '10808', url: 'socks5://127.0.0.1:10808', hint: 'SOCKS5（v2rayN 等）' },
]

/** 从已存的 URL 反推初始选项卡。 */
function guessMode(url) {
  if (!url) return 'local'
  if (url.startsWith('socks5')) return 'socks5'
  if (url.includes('127.0.0.1') || url.includes('localhost')) return 'local'
  return 'http'
}

const MODES = [
  { id: 'local', label: '本地代理端口', hint: '本机已跑着 Clash / v2rayN 之类，直接填它的端口' },
  { id: 'http', label: 'HTTP(S)', hint: '形如 http://user:pass@host:port' },
  { id: 'socks5', label: 'SOCKS5', hint: '形如 socks5://user:pass@host:port' },
]

/**
 * 出口代理弹窗（**组件**，用 `React.createElement(OpencodeProxyModal, props)` 渲染）。
 *
 * ## ⚠️⚠️ 必须是组件、不能当普通函数直接调用（真实事故 2026-10-02）
 *
 * 本组件内部有 `useState`。若在 ProviderPanel 的渲染过程中**直接函数调用**
 * （`renderOpencodeProxyModal(props)`），它的 hook 会被算进 ProviderPanel ——
 * 于是「弹窗开」与「弹窗关」两次渲染的 hook 数量不同，React 抛 #310
 * （"Rendered more hooks than during the previous render"），**整个设置页白屏**。
 *
 * 仓库其它弹窗（`ModelListPanel` / `BackupPanel` / `ClineQuotaPanel`）都写成
 * `function Xxx() { ... }` + `React.createElement(Xxx, props)`，正是为此。
 *
 * @param props { ctx: { rpc(payload) }, accountId, current, onClose }
 */
export function OpencodeProxyModal({ ctx, accountId, current, onClose }) {
  const [mode, setMode] = React.useState(guessMode(current))
  const [url, setUrl] = React.useState(current || '')
  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [error, setError] = React.useState('')
  const [result, setResult] = React.useState(null)

  const close = () => { if (onClose) onClose() }

  const save = async (value) => {
    setBusy(true)
    setError('')
    try {
      await ctx.rpc({ method: 'opencode.setProxy', payload: { accountId, proxy: value } })
      close()
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setError('')
    setResult(null)
    try {
      const r = await ctx.rpc({ method: 'opencode.testProxy', payload: { proxy: url } })
      setResult(r)
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const activeHint = (MODES.find((m) => m.id === mode) || {}).hint || ''

  return React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    onClick: (e) => { if (e.target === e.currentTarget) close() },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      style: { maxWidth: '520px' },
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' }, '设置出口代理'),
        React.createElement('span', { className: 'dim-jh-modalSubtitle' },
          current ? '当前：已配置' : '当前：直连（本机出口）'),
      ),
      // ⚠️ 这段提示是本功能的存在理由，必须说清「多账号 ≠ 多配额」。
      React.createElement('p', { className: 'dim-jh-modalHint' },
        'OpenCode 的免费通道按出口 IP 限流。不设代理时，本账号与其它未设代理的账号'
        + '（以及匿名通道）共用同一个出口，也就是共用同一份额度；设置代理后该账号走独立出口。'),
      // ⚠️ 内容必须放进 modalBody（flex:1; min-height:0; overflow-y:auto），
      // 否则弹窗较高时内容会被裁掉（见 jet-hub.js 既有 modal 的注释）。
      React.createElement('div', { className: 'dim-jh-modalBody' },
        React.createElement('div', { className: 'dim-jh-fieldRow' },
          MODES.map((m) => React.createElement('label', { key: m.id, className: 'dim-jh-radio' },
            React.createElement('input', {
              type: 'radio',
              name: 'opencode-proxy-mode',
              checked: mode === m.id,
              onChange: () => {
                setMode(m.id)
                setError('')
                setResult(null)
              },
            }),
            m.label,
          )),
        ),
        React.createElement('p', { className: 'dim-jh-hint' }, activeHint),
        mode === 'local' && React.createElement('div', { className: 'dim-jh-presetRow' },
          LOCAL_PORT_PRESETS.map((p) => React.createElement('button', {
            key: p.port,
            type: 'button',
            className: 'dim-jh-btn',
            title: p.hint,
            onClick: () => { setUrl(p.url); setError(''); setResult(null) },
          }, p.label)),
        ),
        React.createElement('input', {
          className: 'dim-jh-input',
          placeholder: mode === 'socks5' ? 'socks5://user:pass@host:port' : 'http://user:pass@host:port',
          value: url,
          // ⚠️ 含认证信息时用 password 类型：代理口令不该裸显在屏幕上。
          type: url.includes('@') ? 'password' : 'text',
          onChange: (e) => { setUrl(e.target.value); setResult(null) },
        }),
        result && React.createElement('p', { className: 'dim-jh-hint' },
          `出口 IP ${result.exitIp}（${result.country || '未知地区'}）· ${result.latencyMs}ms`),
        error && React.createElement('p', { className: 'dim-jh-error' }, error),
      ),
      React.createElement('div', { className: 'dim-jh-modalActions' },
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: testing || busy || url.trim().length === 0,
          onClick: test,
        }, testing ? '测试中…' : '测试连接'),
        // 只有已配置过才显示「清除」：没配过就没有可清除的东西。
        current ? React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: busy,
          onClick: () => save(''),
        }, '清除代理') : null,
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn dim-jh-btnPrimary',
          disabled: busy || url.trim().length === 0,
          onClick: () => save(url),
        }, '保存'),
        React.createElement('button', { type: 'button', className: 'dim-jh-btn', onClick: close }, '取消'),
      ),
    ),
  )
}

/**
 * Gemini 账号的「设置出口代理」弹窗（Gitee issue IKLTZ2）。
 *
 * ## ⚠️ 为什么不能直接复用 {@link OpencodeProxyModal}
 *
 * 两者**形态相同、语义不同**，而 UI 上必须说清的那句提示语也**完全不同**：
 *
 * - opencode：「不设代理 = 与其它账号共用同一出口 IP = 共用同一份额度」
 *   （存在理由是**分份额度**）；
 * - Gemini：「不设代理 = 这个面板在墙外可能**根本连不上**」（存在理由是
 *   **能不能连通**）。
 *
 * 复用一个组件却按 provider 换文案，等于把两套语义塞进一个函数 ——
 * 正是本仓库反复记录的那类漂移（同一判据两份实现）。故独立成组件，
 * **复用**输入形态预设（`LOCAL_PORT_PRESETS`），**不复用**组件。
 *
 * ## ⚠️ 「测试连接」打的是 Google 而不是出口 IP 服务

 * 见宿主侧 `src/gemini-rpc.ts` 的模块头：用出口 IP 服务会产生**假阳性**
 * （代理能通 ip-api 却被 Google 拒），用户看到绿色以为配好了，面板依然失败。
 *
 * ⚠️ 同样必须用 `React.createElement` 渲染（hook 计数事故，见上方
 * {@link OpencodeProxyModal} 的说明）。
 *
 * @param props { ctx: { rpc(payload) }, accountId, current, onClose }
 */
export function GeminiProxyModal({ ctx, accountId, current, onClose }) {
  const [mode, setMode] = React.useState(guessMode(current))
  const [url, setUrl] = React.useState(current || '')
  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [error, setError] = React.useState('')
  const [result, setResult] = React.useState(null)

  const close = () => { if (onClose) onClose() }

  const save = async (value) => {
    setBusy(true)
    setError('')
    try {
      await ctx.rpc({ method: 'gemini.setProxy', payload: { accountId, proxy: value } })
      close()
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setError('')
    setResult(null)
    try {
      const r = await ctx.rpc({ method: 'gemini.testProxy', payload: { proxy: url } })
      setResult(r)
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const activeHint = (MODES.find((m) => m.id === mode) || {}).hint || ''

  return React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    onClick: (e) => { if (e.target === e.currentTarget) close() },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      style: { maxWidth: '520px' },
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' }, '设置 Gemini 出口代理'),
        React.createElement('span', { className: 'dim-jh-modalSubtitle' },
          current ? '当前：已配置' : '当前：直连（本机出口）'),
      ),
      // ⚠️ 这段提示是本功能的存在理由，且必须**诚实**：不说清「系统代理不生效」，
      // 用户会以为自己开着 Clash 系统代理就万事大吉（浏览器能用 ≠ 插件能用）。
      React.createElement('p', { className: 'dim-jh-modalHint' },
        'Google 的登录与接口都在墙外。浏览器能打开授权页，是因为浏览器读系统代理；'
        + '插件进程不读，所以「浏览器授权成功、面板里账号却一直不出现」是同一个原因。'
        + '设置这里的代理后，该账号的登录、续期、积分与对话都会走它。'),
      React.createElement('div', { className: 'dim-jh-modalBody' },
        React.createElement('div', { className: 'dim-jh-fieldRow' },
          MODES.map((m) => React.createElement('label', { key: m.id, className: 'dim-jh-radio' },
            React.createElement('input', {
              type: 'radio',
              name: 'gemini-proxy-mode',
              checked: mode === m.id,
              onChange: () => {
                setMode(m.id)
                setError('')
                setResult(null)
              },
            }),
            m.label,
          )),
        ),
        React.createElement('p', { className: 'dim-jh-hint' }, activeHint),
        mode === 'local' && React.createElement('div', { className: 'dim-jh-presetRow' },
          LOCAL_PORT_PRESETS.map((p) => React.createElement('button', {
            key: p.port,
            type: 'button',
            className: 'dim-jh-btn',
            title: p.hint,
            onClick: () => { setUrl(p.url); setError(''); setResult(null) },
          }, p.label)),
        ),
        React.createElement('input', {
          className: 'dim-jh-input',
          placeholder: mode === 'socks5' ? 'socks5://user:pass@host:port' : 'http://user:pass@host:port',
          value: url,
          // ⚠️ 含认证信息时用 password 类型：代理口令不该裸显在屏幕上。
          type: url.includes('@') ? 'password' : 'text',
          onChange: (e) => { setUrl(e.target.value); setResult(null) },
        }),
        // ⚠️ **不说「出口 IP」**：这里测的是「能不能连上 Google」，
        // 回显 HTTP 状态码（400 也是通的，见宿主侧注释）。
        result && React.createElement('p', { className: 'dim-jh-hint' },
          `已连通 Google（HTTP ${result.status}）· ${result.latencyMs}ms`),
        error && React.createElement('p', { className: 'dim-jh-error' }, error),
      ),
      React.createElement('div', { className: 'dim-jh-modalActions' },
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: testing || busy || url.trim().length === 0,
          onClick: test,
        }, testing ? '测试中…' : '测试连接'),
        // 只有已配置过才显示「清除」：没配过就没有可清除的东西。
        current ? React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: busy,
          onClick: () => save(''),
        }, '清除代理') : null,
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn dim-jh-btnPrimary',
          disabled: busy || url.trim().length === 0,
          onClick: () => save(url),
        }, '保存'),
        React.createElement('button', { type: 'button', className: 'dim-jh-btn', onClick: close }, '取消'),
      ),
    ),
  )
}

/**
 * 「设置 Qoder 出口代理」弹窗（**组件**，用 `React.createElement` 渲染）。
 *
 * ## 为什么需要它（真实报障 2026-10-21）
 *
 * Qoder **国际版**（`openapi.qoder.sh`）在本机被 **SNI 阻断**：TCP 443 能握手
 * （93ms），但 TLS ClientHello 被丢弃 ⇒ `fetch` 恒 10.7s `UND_ERR_CONNECT_TIMEOUT`。
 * 余额端点与推理通道**同时**失败，于是三层症状叠在一起：
 *
 * 1. 对话：`TRANSPORT: fetch failed`；
 * 2. 面板：两张卡片的积分行转 11 秒然后报「连不上 …」；
 * 3. 聚合：锁定状态下永远报「无法确认是否有可用账号」。
 *
 * 而**中国版**（`openapi.qoder.com.cn`）直连 160ms 就通 ⇒ 出口只能**按账号**配。
 * 在此之前 Qoder 是唯一有墙外端点却**没有** per-账号代理按钮的渠道
 * （opencode / Gemini 都有），用户唯一的出路是导出 `HTTPS_PROXY` 再重启 DSH。
 *
 * ## 为什么独立成组件（不是给 GeminiProxyModal 加个参数）
 *
 * 与 {@link GeminiProxyModal} 拆出来的理由同源：两家的「不设代理会怎样」
 * 语义不同 —— Gemini 是「全部端点都在墙外，一定连不上」，Qoder 是
 * **「只有国际版在墙外，中国版不设反而更快」**。复用一个组件按 provider
 * 换文案，就是把两套语义塞进一个函数（本仓库反复记录的那类漂移）。
 * **复用**输入形态预设（`LOCAL_PORT_PRESETS`），**不复用**组件。
 *
 * ## ⚠️ 「测试连接」按 provider 分别探测
 *
 * 宿主侧 `qoder.testProxy` 接受 `provider`，打的是该站自己的余额端点
 * （`{openApiBase}/sash/api/v2/me/usage`）。401 也算通 —— 它证明
 * TCP + TLS + 代理握手全过。只按国际版探测会让中国版用户看到「连不上」，
 * 那是**探测目标错了**，不是代理配错了。
 *
 * @param props { ctx: { rpc(payload) }, accountId, current, provider, onClose }
 *   `provider` 缺省为 `'qoder'`（国际版）。
 */
export function QoderProxyModal({ ctx, accountId, current, provider, onClose }) {
  const isCn = provider === 'qodercn'
  const [mode, setMode] = React.useState(guessMode(current))
  const [url, setUrl] = React.useState(current || '')
  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [error, setError] = React.useState('')
  const [result, setResult] = React.useState(null)

  const close = () => { if (onClose) onClose() }

  const save = async (value) => {
    setBusy(true)
    setError('')
    try {
      await ctx.rpc({ method: 'qoder.setProxy', payload: { accountId, proxy: value } })
      close()
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setError('')
    setResult(null)
    try {
      const r = await ctx.rpc({
        method: 'qoder.testProxy',
        // ⚠️ 必须把 provider 带上去：两站主机不同，探测错站点的结果是假阴性。
        payload: { proxy: url, provider: isCn ? 'qodercn' : 'qoder' },
      })
      setResult(r)
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const activeHint = (MODES.find((m) => m.id === mode) || {}).hint || ''

  return React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    onClick: (e) => { if (e.target === e.currentTarget) close() },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      style: { maxWidth: '520px' },
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' },
          isCn ? '设置 Qoder（中国版）出口代理' : '设置 Qoder 出口代理'),
        React.createElement('span', { className: 'dim-jh-modalSubtitle' },
          current ? '当前：已配置' : '当前：直连（本机出口）'),
      ),
      // ⚠️ 提示必须**分站诚实**：国际版在中国大陆基本连不上，中国版不设代理
      // 反而更快。写成一句通用话术会让中国版用户白配一条代理（多一跳、更慢），
      // 也会让国际版用户以为「不设置也能凑合」。
      React.createElement('p', { className: 'dim-jh-modalHint' },
        isCn
          ? '中国版（openapi.qoder.com.cn）通常直连就通，不设代理反而少一跳。'
            + '只有在直连被限速或需要固定出口时才需要配这里。'
          : 'Qoder 国际版（openapi.qoder.sh）在中国大陆被阻断：TCP 能连、TLS 握手被丢，'
            + '表现为「转十秒然后 fetch failed」。插件进程不读系统代理，'
            + '所以浏览器能用 ≠ 这里能用。设置代理后，该账号的登录、续期、'
            + '积分与对话都会走它；也可以改用中国版账号（直连即可）。'),
      React.createElement('div', { className: 'dim-jh-modalBody' },
        React.createElement('div', { className: 'dim-jh-fieldRow' },
          MODES.map((m) => React.createElement('label', { key: m.id, className: 'dim-jh-radio' },
            React.createElement('input', {
              type: 'radio',
              name: 'qoder-proxy-mode',
              checked: mode === m.id,
              onChange: () => {
                setMode(m.id)
                setError('')
                setResult(null)
              },
            }),
            m.label,
          )),
        ),
        React.createElement('p', { className: 'dim-jh-hint' }, activeHint),
        mode === 'local' && React.createElement('div', { className: 'dim-jh-presetRow' },
          LOCAL_PORT_PRESETS.map((p) => React.createElement('button', {
            key: p.port,
            type: 'button',
            className: 'dim-jh-btn',
            title: p.hint,
            onClick: () => { setUrl(p.url); setError(''); setResult(null) },
          }, p.label)),
        ),
        React.createElement('input', {
          className: 'dim-jh-input',
          placeholder: mode === 'socks5' ? 'socks5://user:pass@host:port' : 'http://user:pass@host:port',
          value: url,
          // ⚠️ 含认证信息时用 password 类型：代理口令不该裸显在屏幕上。
          type: url.includes('@') ? 'password' : 'text',
          onChange: (e) => { setUrl(e.target.value); setResult(null) },
        }),
        // ⚠️ **不说「出口 IP」**：这里测的是「能不能连上该站的余额端点」，
        // 回显 HTTP 状态码（401 也是通的 —— 没带 Token 而已，见宿主侧注释）。
        result && React.createElement('p', { className: 'dim-jh-hint' },
          `已连通 ${result.host || (isCn ? 'openapi.qoder.com.cn' : 'openapi.qoder.sh')}`
          + `（HTTP ${result.status}）· ${result.latencyMs}ms`),
        error && React.createElement('p', { className: 'dim-jh-error' }, error),
      ),
      React.createElement('div', { className: 'dim-jh-modalActions' },
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: testing || busy || url.trim().length === 0,
          onClick: test,
        }, testing ? '测试中…' : '测试连接'),
        // 只有已配置过才显示「清除」：没配过就没有可清除的东西。
        current ? React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: busy,
          onClick: () => save(''),
        }, '清除代理') : null,
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn dim-jh-btnPrimary',
          disabled: busy || url.trim().length === 0,
          onClick: () => save(url),
        }, '保存'),
        React.createElement('button', { type: 'button', className: 'dim-jh-btn', onClick: close }, '取消'),
      ),
    ),
  )
}

/**
 * MiniMax **国际站**账号的「设置出口代理」弹窗。
 *
 * ## ⚠️ 为什么不能直接复用 {@link OpencodeProxyModal} / {@link GeminiProxyModal}
 *
 * 三家**形态相同、语义不同**，而 UI 上必须说清的那句「不设置会怎样」也
 * **完全不同**：
 *
 * - opencode：「不设代理 = 与其它账号共用同一出口 IP = 共用同一份额度」；
 * - Gemini：「不设代理 = 墙外服务可能**根本连不上**」；
 * - **minimaxintl：「不设代理 ≠ 连不上，而是**连得上却被转到中国站**」
 *   —— 上游按出口 IP 国别分流，大陆来源恒 307 到 `agent.minimaxi.com`，
 *   而中国站不认国际站 token ⇒ 与「凭据失效」**逐字同形**的 401。
 *
 * 复用一个组件却按 provider 换文案，等于把三套语义塞进一个函数 ——
 * 正是本仓库反复记录的那类漂移。故独立成组件，**复用**输入形态预设
 * （`LOCAL_PORT_PRESETS`），**不复用**组件。
 *
 * ## ⚠️⚠️ 「测试连接」的回显必须区分「通」与「通了但仍在大陆」
 *
 * 这是本家与另两家**唯一实质不同**的一格：另两家只要拿到 HTTP 响应就算通，
 * 而本家拿到 HTTP 响应**也可能仍是被分流**（307 到中国站）。宿主侧
 * `minimaxintl.testProxy` 因此额外回 `geoRouted`，这里必须显示成
 * **警告**而不是绿色 —— 否则用户看到「已连通」以为配好了，实际照样 401。
 *
 * ⚠️ 复用了 `src/minimax-rpc.ts` 的探测端点（国际站公开目录端点，无 token 也
 * 回 200）⇒ 点「测试连接」**不消耗任何凭据**，不会烧掉用户的 refresh_token
 * （本仓库在 MiniMax 上有过「诊断脚本对真实凭据 refresh 而烧账号」的事故）。
 *
 * ⚠️ 同样必须用 `React.createElement` 渲染（hook 计数事故，见上方
 * {@link OpencodeProxyModal} 的说明）。
 *
 * @param props { ctx: { rpc(payload) }, accountId, current, onClose }
 */
export function MinimaxIntlProxyModal({ ctx, accountId, current, onClose }) {
  const [mode, setMode] = React.useState(guessMode(current))
  const [url, setUrl] = React.useState(current || '')
  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [error, setError] = React.useState('')
  const [result, setResult] = React.useState(null)

  const close = () => { if (onClose) onClose() }

  const save = async (value) => {
    setBusy(true)
    setError('')
    try {
      await ctx.rpc({ method: 'minimaxintl.setProxy', payload: { accountId, proxy: value } })
      close()
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setError('')
    setResult(null)
    try {
      const r = await ctx.rpc({ method: 'minimaxintl.testProxy', payload: { proxy: url } })
      setResult(r)
    } catch (err) {
      setError(err && err.message ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const activeHint = (MODES.find((m) => m.id === mode) || {}).hint || ''

  return React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    onClick: (e) => { if (e.target === e.currentTarget) close() },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      style: { maxWidth: '520px' },
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' }, '设置 MiniMax 国际站出口代理'),
        React.createElement('span', { className: 'dim-jh-modalSubtitle' },
          current ? '当前：已配置' : '当前：直连（本机出口）'),
      ),
      // ⚠️ 这段提示是本功能的存在理由，且必须**诚实**：本家的失败不是「连不上」
      // 而是「连上了却被转到中国站」，与另两家的措辞不同，别照抄。
      React.createElement('p', { className: 'dim-jh-modalHint' },
        '国际站（agent.minimax.io）按出口 IP 所在国家分流：中国大陆来源会被转到中国站，'
        + '而中国站不认国际站账号 ⇒ 报出与「凭据失效」一模一样的错误，凭据本身却是好的。'
        + '设置这里的代理后，该账号的登录、续期、积分与对话都会走它。'),
      // ⚠️ 必须说清与 XFF 的关系：两者可叠加，但 XFF 是兜底而非替代。
      React.createElement('p', { className: 'dim-jh-hint' },
        '另有「MiniMax 国际站分流设置」（X-Forwarded-For）：它只是**声明**一个海外 IP，'
        + '上游不认即失效；本设置是**真正**换出口，两者可叠加。'),
      React.createElement('div', { className: 'dim-jh-modalBody' },
        React.createElement('div', { className: 'dim-jh-fieldRow' },
          MODES.map((m) => React.createElement('label', { key: m.id, className: 'dim-jh-radio' },
            React.createElement('input', {
              type: 'radio',
              name: 'minimaxintl-proxy-mode',
              checked: mode === m.id,
              onChange: () => {
                setMode(m.id)
                setError('')
                setResult(null)
              },
            }),
            m.label,
          )),
        ),
        React.createElement('p', { className: 'dim-jh-hint' }, activeHint),
        mode === 'local' && React.createElement('div', { className: 'dim-jh-presetRow' },
          LOCAL_PORT_PRESETS.map((p) => React.createElement('button', {
            key: p.port,
            type: 'button',
            className: 'dim-jh-btn',
            title: p.hint,
            onClick: () => { setUrl(p.url); setError(''); setResult(null) },
          }, p.label)),
        ),
        React.createElement('input', {
          className: 'dim-jh-input',
          placeholder: mode === 'socks5' ? 'socks5://user:pass@host:port' : 'http://user:pass@host:port',
          value: url,
          // ⚠️ 含认证信息时用 password 类型：代理口令不该裸显在屏幕上。
          type: url.includes('@') ? 'password' : 'text',
          onChange: (e) => { setUrl(e.target.value); setResult(null) },
        }),
        result && React.createElement('p', {
          className: 'dim-jh-hint',
          // ⚠️⚠️ **被分流时不能显示成正常的绿**：那是用户真正想问的答案。
          style: result.geoRouted ? { color: 'var(--dim-warn, #d9a441)' } : undefined,
        }, result.geoRouted
          ? `代理可用，但出口仍被判定为中国大陆（HTTP ${result.status}）· ${result.latencyMs}ms`
            + ' —— 换个海外出口的代理再试'
          : `出口已在海外，未被分流（HTTP ${result.status}）· ${result.latencyMs}ms`),
        error && React.createElement('p', { className: 'dim-jh-error' }, error),
      ),
      React.createElement('div', { className: 'dim-jh-modalActions' },
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: testing || busy || url.trim().length === 0,
          onClick: test,
        }, testing ? '测试中…' : '测试连接'),
        // 只有已配置过才显示「清除」：没配过就没有可清除的东西。
        current ? React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn',
          disabled: busy,
          onClick: () => save(''),
        }, '清除代理') : null,
        React.createElement('button', {
          type: 'button',
          className: 'dim-jh-btn dim-jh-btnPrimary',
          disabled: busy || url.trim().length === 0,
          onClick: () => save(url),
        }, '保存'),
        React.createElement('button', { type: 'button', className: 'dim-jh-btn', onClick: close }, '取消'),
      ),
    ),
  )
}

/**
 * 「添加 OpenCode 账号」弹窗（**组件**，用 `React.createElement(OpencodeKeyModal, props)` 渲染）。
 *
 * ## ⚠️⚠️ 同样是组件，不能直接函数调用
 *
 * 见上方 {@link OpencodeProxyModal} 的说明：直接调用会让本组件的 `useState`
 * 被算进 ProviderPanel，React 抛 #310 并让整个设置页白屏（真实事故 2026-10-02）。
 *
 * ## ⚠️ 为什么不用 `window.prompt`
 *
 * DSH 客户端跑在**沙箱**环境里，`prompt()` 直接抛
 * `prompt() is not supported`（真机报障 2026-10-01：
 * 「添加账号失败：prompt() is not supported」）。本仓库其余交互一律
 * 自绘 modal（见 `jet-hub.js` 的 BackupPanel），这里保持一致。
 *
 * ## 为什么输入框内容不进 React state
 *
 * API key 是凭据。放进 `useState` 会让它随每次父组件重渲染经过整棵组件树，
 * 也可能被 devtools 的组件树检查器读到 —— 与「key 存 credentials、
 * 不进明文」的口径不符。故用 `inputRef` + DOM 读值。
 * 只有**错误信息**进 state（它需要触发重渲染显示）。
 *
 * @param props { error, busy, inputRef, onSubmit(value), onSubmitAnonymous(), onClose }
 */
export function OpencodeKeyModal({ error, busy, inputRef, onSubmit, onSubmitAnonymous, onClose }) {
  const [mode, setMode] = React.useState('key')
  const submit = () => {
    if (mode === 'anonymous') {
      onSubmitAnonymous()
      return
    }
    // 空串 = 没填就点确认：静默关弹窗，不报错（免费通道本来就能用）。
    const value = inputRef && inputRef.current ? inputRef.current.value : ''
    if (String(value).trim() === '') return
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
        React.createElement('div', { className: 'dim-jh-modalTitle' }, '添加 OpenCode 账号'),
      ),
      // 两种身份：API key 账号 / 匿名通道（无需凭据）。
      React.createElement('div', { className: 'dim-jh-fieldRow' },
        [
          { id: 'key', label: 'API key 账号' },
          { id: 'anonymous', label: '匿名通道' },
        ].map((m) => React.createElement('label', { key: m.id, className: 'dim-jh-radio' },
          React.createElement('input', {
            type: 'radio',
            name: 'opencode-add-mode',
            checked: mode === m.id,
            onChange: () => setMode(m.id),
          }),
          m.label,
        )),
      ),
      mode === 'key'
        ? React.createElement(React.Fragment, null,
            React.createElement('p', { className: 'dim-jh-modalHint' },
              // ⚠️ 前缀**两种都要提**：opencode 2026-10-22 起签发 `oc_sk_…`
              // （Gitee IKPLRU），旧号手里仍是 `sk-…`；只写一种会让另一种的人
              // 以为自己的 key 不对。生成地址也从旧的 `/auth` 更正到控制台账号页。
              '在 opencode.ai/console/account 生成 API key 后粘贴到下方'
              + '（旧 key 形如 sk-…，新 key 形如 oc_sk_…）。'
              + '可启用付费模型，并为每个账号单独设置出口代理。'),
            // ⚠️ 内容必须在 modalBody 里（flex:1; min-height:0; overflow-y:auto），
            // 否则弹窗内容会被裁掉（见 jet-hub.js 既有 modal 的注释）。
            React.createElement('div', { className: 'dim-jh-modalBody' },
              React.createElement('div', { className: 'dim-jh-formRows' },
                React.createElement('input', {
                  ref: inputRef,
                  className: 'dim-jh-input',
                  // ⚠️ password 类型：API key 是凭据，不该在屏幕上裸显。
                  type: 'password',
                  placeholder: 'sk-… / oc_sk_…',
                  autoFocus: true,
                  // Enter 直接提交：粘贴 key 后最自然的动作就是回车。
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submit();
                    }
                  },
                }),
              ),
              // ⚠️ 错误留在弹窗内：把整个账号列表切成错误态会让用户刚填的 key
              // 与错误信息一起消失，只能刷新重试。
              error
                ? React.createElement('p', { className: 'dim-jh-error', role: 'alert' }, '添加失败：' + error)
                : null,
            ))
        : React.createElement('div', { className: 'dim-jh-modalBody' },
            React.createElement('p', { className: 'dim-jh-modalHint' },
              '匿名通道无需任何凭据（上游认字面量 public），用于免费模型。'
              + '可以添加多条，每条可单独设置出口代理。'),
            // ⚠️⚠️ **诚实说明指纹不增加配额**：匿名通道按出口 IP 限额
            // （实测：换 key、换伪装头、换指纹全部无效）。要多份额度只能给
            // 不同匿名通道配**不同代理**；指纹分离的价值是防关联。
            // 不说清楚的话，用户加 5 条匿名通道却只看到一份额度，会以为坏了。
            React.createElement('p', { className: 'dim-jh-hint' },
              '注意：匿名通道的额度按「出口 IP」计算。多条匿名通道若共用同一个出口，'
              + '额度不会增加；给它们分别配置不同代理，才会各自获得独立额度。'),
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
