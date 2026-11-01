/**
 * `qoder.testProxy` 失败文案的**脱敏**守卫（2026-10-25 合并审计 P1 修法）。
 *
 * ## 为什么从 `qoder-proxy.spec.ts` 里拆出来（这不是风格洁癖）
 *
 * 原 ⑨ 与 ⑤ 在**同一个文件**里，而 ⑤ 用
 * `vi.resetModules() + vi.doMock('../../src/opencode-proxy.js')` 装了一个 throwing
 * stub，`afterEach` 只 `vi.doUnmock(...)` 而**没有** `resetModules()` ⇒
 * ⑨ 的 `await import('../../src/qoder-rpc.js')` 拿到的是**绑着 ⑤ 最后一个 stub**
 * 的缓存实例（那个 stub 的 cause 是 `ECONNRESET 127.0.0.1:7897`，属于「目标站点」
 * 一类）⇒ `targetsProxyEntry` 为假 ⇒ 走「站点文案」那条腿 ⇒
 * `${url}` **根本没被渲染**。
 *
 * ⇒ 实测：把 `（${url}）` 明文加回去（= 完整退回修复前形态），
 *   **整文件 + 全量 437 文件 / 10791 用例 0 红**；而 `-t` 过滤单跑则精确变红。
 *   这类「只在整文件跑法下假绿」的守卫比没有守卫更糟（它给出安全的错觉）。
 *
 * ## 本文件的判据（三条缺一不可）
 *
 * | # | 断言 | 作用 |
 * |---|---|---|
 * | 1 | 文案里**不得**出现明文口令 | 这是缺陷本体 |
 * | 2 | 文案里**必须**出现脱敏后的 `label`（`http://bob:***@host:port`） | 证明真的走了「代理入口」那条腿 —— 否则断言 1 可能只是「根本没渲染 URL」 |
 * | 3 | 文案里必须点明「代理没有在监听」 | 证明归因没被写成「目标站点被 SNI 阻断」 |
 *
 * ⚠️ 全程只连 **127.0.0.1**（本机 loopback，无监听）—— 本文件**不发**任何外网请求。
 * ⚠️ mock 写在模块作用域（`vi.mock` 会被提升），故不存在「先被别人 mock 过、
 *    自己拿到脏实例」的窗口。
 */

import { describe, expect, it, vi } from 'vitest'

/** 代理入口被拒（端口没人监听）—— 以 `cause` 链的形式给出，与 undici 真实形态一致。 */
const refused = Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7897'), {
    code: 'ECONNREFUSED', address: '127.0.0.1', port: 7897,
  }),
})

vi.mock('../../src/opencode-proxy.js', () => ({
  proxyFetch: () => { throw refused },
  buildProxyDispatcher: () => ({}),
  closeAllProxyDispatchers: async () => {},
  proxyCacheSize: () => 0,
  resolveConnectPort: () => 443,
  buildSocks5Handshake: () => new Uint8Array(),
}))

const { handleQoderRpc } = await import('../../src/qoder-rpc.js')

describe('★★ qoder.testProxy 的失败文案：口令不得回显，但原因必须说清', () => {
  it('★★ 代理入口被拒时：文案不含明文口令，且仍保留可执行的下一步', async () => {
    const res = await handleQoderRpc(
      {} as never,
      { setQoderProxy: vi.fn() },
      'qoder.testProxy',
      { proxy: 'http://bob:hunter2@127.0.0.1:7897' },
    )
    const text = JSON.stringify(res)

    // ① 缺陷本体：任何字段都不得回显明文口令。
    expect(text, `失败文案回显了明文口令：${text.slice(0, 300)}`).not.toContain('hunter2')
    // ② **非空泛性判据**：必须真的走到了「代理入口」这条腿（否则 ① 可能只是没渲染）。
    expect(text, '文案里没有脱敏后的 label ⇒ 走的不是「代理入口被拒」那条分支，本用例对缺陷无感')
      .toContain('bob:***@127.0.0.1:7897')
    // ③ 归因必须分道：不得说成「目标站点连不上」。
    expect(text, '把「代理没启动」说成了站点的事 ⇒ 用户会去查网络/换账号').toContain('没有在监听')
  })
})
