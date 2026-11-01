/**
 * ★★ `account.update` 的 **patch 白名单**守卫（2026-10-25 合并审计 P2 修法）。
 *
 * ## 缺陷
 *
 * `RpcUpdateAccountRequest.patch` 在**类型**上只有
 * `nickname / enabled / expiresAt / refreshable` 四个键，但它是**无 schema 校验的
 * 客户端载荷**。改前整份 `req.patch` 被原样转发给 `AccountPool.updateAccount`，
 * 而后者是 `{...entry, ...patch}` ⇒ `{qoderProxy:'ftp://host:21'}` 会**原样展开进池**，
 * 绕过 `sanitizeAccounts` 的代理 scheme 闸（`jet-hub-store.ts` 的那个唯一闸门）。
 *
 * 实测后果：落池后该账号的 `qoderProxyFor()` 返回 `ftp://host:21`，此后
 * `qoderFetchForAccount` 恒抛「代理地址无效 — 不支持的协议 ftp」⇒ **该账号永久不可用**，
 * 而面板上只能看到「失败」、看不出原因。
 *
 * ## 判据（为什么必须是行为级）
 *
 * 断言**池里的最终形态**（`entry.qoderProxy` 不存在）**且**合法字段确实生效
 * —— 只断言「代码里有白名单」抓不住「白名单写了但没用它的返回值」。
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { AccountPool } from '../../src/account-pool.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'

interface Harness {
  pool: AccountPool
  call: (method: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>
  warns: string[]
}

function makeHarness(): Harness {
  const warns: string[] = []
  let handler: ((req: Request) => Promise<Response>) | undefined
  const ctx = new Context() as never as Record<string, unknown>
  const provide = (ctx as { provide: (n: string, v: unknown) => void }).provide.bind(ctx)
  const store = new Map<string, string>()
  provide('credentials', {
    resolve: async (ref: unknown) => {
      const value = store.get(String(ref))
      return value === undefined ? undefined : { value, source: 'fake' }
    },
    describe: async () => ({ configured: true, writable: true }),
    set: async (ref: unknown, value: string) => { store.set(String(ref), value) },
    unset: async (ref: unknown) => { store.delete(String(ref)) },
  })
  provide('commands', { register: () => () => {}, definitions: [] })
  provide('llm', {
    registerConfigurableProviders: () => ({ replace() {} }),
    registerAdapter: () => ({ replace() {} }),
    listModels: async () => [],
  })
  const state: { value: unknown } = { value: undefined }
  provide('settings', {
    register() {
      return { get: () => state.value, replace: (v: unknown) => { state.value = v } }
    },
    describe() { return [] },
  })
  ;(ctx as unknown as Record<string, unknown>).logger = {
    warn: (message: unknown) => { warns.push(String(message)) },
    info: () => {}, error: () => {}, debug: () => {},
  }
  ;(ctx as unknown as Record<string, unknown>).connection = {
    fetch: {
      register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
        if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
      },
    },
  }
  ;(ctx as unknown as Record<string, unknown>).inject = (_deps: string[], cb: (c: unknown) => void) => cb(ctx)

  const pool = new AccountPool(ctx as never)
  registerJetHubRpc(
    ctx as never, pool,
    {
      codearts: {} as never, buddy: {} as never, workbuddy: {} as never,
      lobsterai: {} as never, qoder: {} as never, qodercn: {} as never,
      trae: {} as never, cline: {} as never, loomy: {} as never,
      raccoon: {} as never, minimax: {} as never, zcode: {} as never,
      gemini: {} as never, officeace: {} as never,
    } as never,
    undefined,
  )
  if (handler === undefined) throw new Error('handler 未注册')

  const call = async (method: string, payload: unknown) => {
    const response = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
    }
    return body.result
  }
  return { pool, call, warns }
}

describe('★★ account.update：patch 必须白名单化（否则代理字段绕过 scheme 闸）', () => {
  it('★★ 载荷夹带 qoderProxy 时：池里不得出现该字段，合法字段照常生效', async () => {
    const h = makeHarness()
    await h.pool.addAccount({
      id: 'qoder-1',
      provider: 'qoder',
      nickname: '旧名字',
      enabled: true,
      credentialRef: 'QODER_ACCOUNT_1',
      refreshable: true,
      createdAt: Date.now(),
    })

    const result = await h.call('account.update', {
      accountId: 'qoder-1',
      // ⚠️ 这两个键里只有 nickname 是**契约内**的；qoderProxy 是夹带的。
      patch: { nickname: '新名字', qoderProxy: 'ftp://host:21' },
    })
    expect(result.ok).toBe(true)

    const entry = h.pool.findAccount('qoder-1')
    expect(entry?.nickname, '合法字段必须照常生效（白名单不得把整个 patch 丢掉）').toBe('新名字')
    expect(
      entry?.qoderProxy,
      '★ 非法代理被写进池 ⇒ 该账号此后取 fetcher 恒抛「不支持的协议 ftp」= 永久不可用',
    ).toBeUndefined()
    // 忽略的字段必须留痕（否则 UI 打错字时无人察觉）
    expect(h.warns.join('\n'), '静默忽略不可接受：这类字段必须走专用端点').toContain('qoderProxy')
  })

  it('★ 合法 patch（enabled）照常生效 —— 别把白名单做成「什么都不更新」', async () => {
    const h = makeHarness()
    await h.pool.addAccount({
      id: 'qoder-2',
      provider: 'qoder',
      nickname: 'n',
      enabled: true,
      credentialRef: 'QODER_ACCOUNT_2',
      refreshable: true,
      createdAt: Date.now(),
    })
    const result = await h.call('account.update', { accountId: 'qoder-2', patch: { enabled: false } })
    expect(result.ok).toBe(true)
    expect(h.pool.findAccount('qoder-2')?.enabled).toBe(false)
  })
})

describe('★★ account.create 的 qoderProxy 必须过 normalizeProxy（否则账号永久不可用）', () => {
  it('★★ 非法 scheme ⇒ 拒绝整轮登录、给可操作原因、不留幽灵条目', async () => {
    const h = makeHarness()
    const result = await h.call('account.create', {
      provider: 'qoder',
      qoderProxy: 'ftp://host:21',
    })
    // ① 必须**拒绝**（不能静默降级直连：用户明确想走代理，静默直连会让他以为配好了）
    expect(result.ok, '非法代理被接受 ⇒ 该账号此后每次取 fetcher 都抛「不支持的协议 ftp」').toBe(false)
    expect(result.error?.message ?? '', '错误文案必须说清是代理地址的问题').toContain('代理地址无效')
    // ② 不得留下「有账号但配置非法」的幽灵卡片
    expect(h.pool.listAccountsByProvider('qoder')).toHaveLength(0)
  })

  it('★ 合法代理照常接受（别把闸做成「一律拒绝」）', async () => {
    const h = makeHarness()
    const result = await h.call('account.create', {
      provider: 'qoder',
      qoderProxy: 'http://127.0.0.1:7897',
    })
    // 后续 startLogin 没有桩 ⇒ 会抛错并删条目；这里只断言**不是**被代理闸挡下。
    expect(result.error?.message ?? '').not.toContain('代理地址无效')
  })
})
