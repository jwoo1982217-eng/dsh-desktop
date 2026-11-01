import { describe, expect, it, vi, afterEach } from 'vitest'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { CODELY_API_BASE, decodeCodelyJwtExpMs } from '../../src/codely-auth.js'

/**
 * ⚠️ Codely（Unity 团结引擎）登录的**行为级**测试。
 *
 * ## 守什么
 *
 * `account.create` 的 codely 分支是**真网络流程**（设备码三步），不是
 * `auth.startLogin` 服务实例——本文件用**替身 fetch** 按端点路由响应，
 * 真跑 `registerJetHubRpc` 的 handler，覆盖三条链路：
 *
 * 1. **成功**：initiate → poll(authorized) → exchange → userinfo，
 *    断言 loginUrl 用 `verification_uri_complete`、占位条目先登记、
 *    凭据 JSON 落盘（含昵称）、账号条目回填昵称、`login.poll` 终态 `done:true`；
 * 2. **失败（denied）**：轮询到 `denied` 终态 ⇒ `result` 拒绝 ⇒
 *    `login.poll` 立刻报 `done:true, success:false`（三态契约，IKLI7J），
 *    且**不**留幽灵账号（占位条目被 failLogin 清掉）；
 * 3. **登录端点不可达**：initiate 本身失败 ⇒ `account.create` 直接报错，
 *    **不**登记占位条目（否则又是一条幽灵账号）。
 *
 * ## 为什么不走全局 stub 的 shortcut
 *
 * `login.poll` 的「凭据已落地 ⇒ done:true」是**通用判定**（先查终态失败表、
 * 再查占位条目、再 `credentials.resolve`），不按 provider 分支 —— 它对
 * codely 是否生效只能靠真跑端点验证，源码断言测不出「分支登记顺序错了
 * 导致轮询永远 pending」这类缺陷。
 */

interface FetchCall { url: string; init: RequestInit }

type FetchResponder = (url: string, init: RequestInit) => Response | Promise<Response>

/** 安装按 URL 路由的替身 fetch，并记录全部调用（断言请求体形状用）。 */
function installFetch(responder: FetchResponder): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    return responder(url, init ?? {})
  }
  vi.stubGlobal('fetch', fake)
  return { calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const INITIATE_BODY = {
  auth_request_token: 'tok-0',
  user_code: 'ABCD-1234',
  verification_uri: `${CODELY_API_BASE}/auth/device/verify`,
  verification_uri_complete: `${CODELY_API_BASE}/auth/device/verify?auth_request_token=tok-0`,
  interval: 0,
  expires_in: 900,
}

class FakeCredentials {
  readonly store = new Map<string, string>()
  async resolve(ref: string) {
    const value = this.store.get(ref)
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async set(ref: string, value: string) { this.store.set(ref, value) }
}

/**
 * 搭一个可驱动 `account.create` / `login.poll` 的 harness。
 *
 * ⚠️ `auths` 必须是 `JetHubAuths` 的**全键**占位（接口字段全必填）；
 * 本测试只走 codely 分支，占位实例不会被调用。
 */
function setup() {
  const credentials = new FakeCredentials()
  const added: Array<Record<string, unknown>> = []
  const updated: Array<[string, Record<string, unknown>]> = []
  const removed: string[] = []
  const pool = {
    addAccount: async (entry: Record<string, unknown>) => { added.push(entry) },
    updateAccount: async (id: string, patch: Record<string, unknown>) => { updated.push([id, patch]) },
    removeAccount: async (id: string) => { removed.push(id) },
    listAllAccounts: async () => added.filter((a) => !removed.includes(a.id as string)),
    // ⚠️ `account.list` 的自愈回填测试需要它返回本 provider 的条目
    //    （真池按 provider 过滤，这里 entry.provider 已逐字写对，等价）。
    listAccounts: async () => added.filter((a) => !removed.includes(a.id as string)),
    // ⚠️ `failLogin` 的安全判据（「读不到池 ⇒ 宁可不删」）走 `findAccount`：
    //    缺这个方法时它判 'unknown'、**刻意不删占位条目** —— 失败路径的
    //    「不留幽灵账号」断言会假红。
    findAccount: (id: string) => added.find((a) => a.id === id && !removed.includes(id)),
  }
  let handler: ((req: Request) => Promise<Response>) | undefined
  const ctx = {
    connection: {
      fetch: {
        register: (spec: { path: string; fetch: (req: Request) => Promise<Response> }) => {
          if (spec.path === JET_HUB_API_PATH) handler = spec.fetch
        },
      },
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    credentials,
    get: () => undefined,
    inject: (_deps: string[], cb: (c: unknown) => void) => { cb(ctx) },
  }
  const auths = {
    codearts: {}, buddy: {}, workbuddy: {}, lobsterai: {}, qoder: {}, qodercn: {},
    trae: {}, cline: {}, loomy: {}, raccoon: {}, minimax: {}, minimaxintl: {},
    zcode: {}, gemini: {}, officeace: {}, accio: {}, autoclaw: {}, modelscope: {},
  }
  registerJetHubRpc(ctx as never, pool as never, auths as never)

  const call = async (method: string, payload: unknown): Promise<{
    ok: boolean
    value?: Record<string, unknown>
    error?: { code?: string; message?: string }
  }> => {
    // `registerJetHubRpc` 用 `ctx.inject` 惰性注册端点，先让出一轮微任务。
    await new Promise((resolve) => setTimeout(resolve, 0))
    const res = await handler!(new Request('http://localhost/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'r1', method: 'jet-hub',
        payload: { method, payload },
      }),
    }))
    return (await res.json() as { result: { ok: boolean; value?: Record<string, unknown>; error?: { code?: string; message?: string } } }).result
  }
  return { call, credentials, added, updated, removed }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Codely 登录（account.create 设备码三步 + login.poll 通用判定）', () => {
  it('★ 成功：loginUrl 用 verification_uri_complete，凭据落盘含昵称，poll 终态 done', async () => {
    installFetch((url) => {
      if (url.endsWith('/auth/device/initiate')) return jsonResponse(INITIATE_BODY)
      if (url.includes('/auth/device/poll')) {
        return jsonResponse({ status: 'authorized', authorization_code: 'auth-code-1', interval: 0 })
      }
      if (url.endsWith('/auth/device/exchange')) {
        return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1' })
      }
      if (url.endsWith('/auth/external/me')) return jsonResponse({ username: 'unity-user', email: 'u@e.com' })
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { call, credentials, added, updated } = setup()

    const created = await call('account.create', { provider: 'codely' })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    expect(created.value?.loginUrl).toBe(INITIATE_BODY.verification_uri_complete)
    // 占位条目先登记（refreshable:false —— 续期链路未接线）。
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ provider: 'codely', credentialRef: expect.stringMatching(/^CODELY_ACCOUNT_/), refreshable: false })
    const accountId = created.value?.accountId as string

    // 等后台轮询链（poll → exchange → me → credentials.set → pool.update）跑完。
    await vi.waitFor(() => {
      expect(updated.length, `updated=${JSON.stringify(updated)}`).toBe(1)
    })
    expect(updated[0][0]).toBe(accountId)
    expect(updated[0][1].nickname).toBe('unity-user')

    // 凭据 JSON 已落盘（键是 credentialRef(refName) 的完整形态，测试只看值）。
    const stored = [...credentials.store.values()].at(-1)
    expect(stored).toBeDefined()
    const parsed = JSON.parse(stored!) as Record<string, unknown>
    expect(parsed).toMatchObject({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      nickname: 'unity-user',
    })

    // 通用 login.poll：凭据已落地 ⇒ 终态成功。
    const poll = await call('login.poll', { accountId })
    expect(poll).toMatchObject({ ok: true, value: { done: true, success: true } })
  })

  it('★ exchange 请求体是 snake_case authorization_code（协议契约）', async () => {
    const { calls } = installFetch((url) => {
      if (url.endsWith('/auth/device/initiate')) return jsonResponse(INITIATE_BODY)
      if (url.includes('/auth/device/poll')) {
        return jsonResponse({ status: 'authorized', authorization_code: 'auth-code-2', interval: 0 })
      }
      if (url.endsWith('/auth/device/exchange')) return jsonResponse({ access_token: 'at', refresh_token: 'rt' })
      if (url.endsWith('/auth/external/me')) return jsonResponse({ username: 'x' })
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { call } = setup()
    await call('account.create', { provider: 'codely' })
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/auth/device/exchange'))).toBe(true)
    })
    const exchange = calls.find((c) => c.url.endsWith('/auth/device/exchange'))
    expect(JSON.parse(String(exchange?.init.body))).toEqual({ authorization_code: 'auth-code-2' })
  })

  it('★ denied：result 拒绝 ⇒ login.poll 立刻报终态失败，不留幽灵账号', async () => {
    installFetch((url) => {
      if (url.endsWith('/auth/device/initiate')) return jsonResponse(INITIATE_BODY)
      if (url.includes('/auth/device/poll')) {
        return jsonResponse({ status: 'denied', error_description: 'user denied the request' })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { call, added, removed } = setup()
    const created = await call('account.create', { provider: 'codely' })
    expect(created.ok).toBe(true)
    const accountId = created.value?.accountId as string

    await vi.waitFor(() => {
      // failLogin 是「先同步写记录、再异步删条目」—— 用 removed 兜底等待。
      expect(removed).toContain(accountId)
    })
    expect(added).toHaveLength(1)

    const poll = await call('login.poll', { accountId })
    expect(poll).toMatchObject({ ok: true, value: { done: true, success: false } })
    expect(String(poll.value?.error)).toContain('denied')
  })

  it('★ initiate 不可达：account.create 直接失败，不登记占位条目', async () => {
    installFetch(() => {
      throw new Error('network unreachable')
    })
    const { call, added } = setup()
    const created = await call('account.create', { provider: 'codely' })
    expect(created.ok).toBe(false)
    expect(String(created.error?.message)).toContain('Codely')
    expect(added).toHaveLength(0)
  })
})

/**
 * 造一个三段式 JWT（header.payload.signature，base64url，无签名校验 ——
 * decodeCodelyJwtExpMs 只读 payload 的 exp claim）。
 */
function makeJwt(claims: Record<string, unknown>): string {
  const enc = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}.sig`
}

describe('decodeCodelyJwtExpMs（JWT exp 解码）', () => {
  it('★ 标准 JWT：秒级 exp → 毫秒', () => {
    expect(decodeCodelyJwtExpMs(makeJwt({ sub: '22497', exp: 1823953673, iat: 1792417673 })))
      .toBe(1823953673 * 1000)
  })
  it('★ 非 JWT（如占位串）：undefined，绝不编造', () => {
    expect(decodeCodelyJwtExpMs('at-1')).toBeUndefined()
  })
  it('★ payload 缺 exp / exp 非法：undefined', () => {
    expect(decodeCodelyJwtExpMs(makeJwt({ sub: 'x' }))).toBeUndefined()
    expect(decodeCodelyJwtExpMs(makeJwt({ exp: 'soon' }))).toBeUndefined()
    expect(decodeCodelyJwtExpMs(makeJwt({ exp: 0 }))).toBeUndefined()
  })
  it('★ payload 不是合法 JSON：undefined', () => {
    expect(decodeCodelyJwtExpMs('h.!!!.s')).toBeUndefined()
  })
})

describe('Codely 有效期（expiresAt 回填 + account.list 自愈）', () => {
  it('★ 新登录：access_token 是 JWT ⇒ 凭据带 expires_at、池条目回填 expiresAt', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    installFetch((url) => {
      if (url.endsWith('/auth/device/initiate')) return jsonResponse(INITIATE_BODY)
      if (url.includes('/auth/device/poll')) {
        return jsonResponse({ status: 'authorized', authorization_code: 'code-exp', interval: 0 })
      }
      if (url.endsWith('/auth/device/exchange')) {
        return jsonResponse({ access_token: makeJwt({ exp, type: 'access' }), refresh_token: 'rt' })
      }
      if (url.endsWith('/auth/external/me')) return jsonResponse({ username: 'u' })
      throw new Error(`unexpected fetch: ${url}`)
    })
    const { call, credentials, updated } = setup()
    const created = await call('account.create', { provider: 'codely' })
    const accountId = created.value?.accountId as string
    await vi.waitFor(() => {
      expect(updated.length).toBe(1)
    })
    expect(updated[0][1].expiresAt).toBe(exp * 1000)
    const parsed = JSON.parse([...credentials.store.values()].at(-1)!) as Record<string, unknown>
    expect(parsed.expires_at).toBe(new Date(exp * 1000).toISOString())
    // account.list 直接能看到（不再依赖自愈）。
    const list = await call('account.list', { provider: 'codely' })
    const entry = (list.value?.accounts as Array<Record<string, unknown>>).find((a) => a.id === accountId)
    expect(entry?.expiresAt).toBe(exp * 1000)
  })

  it('★ 旧凭据（无 expires_at）自愈：account.list 解码 JWT exp 并写回池', async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200
    installFetch(() => {
      throw new Error('unexpected fetch during self-heal test')
    })
    const { call, credentials, updated, added } = setup()
    // 模拟修复前落盘的旧凭据与池条目（凭据只有 obtained_at，条目无 expiresAt）。
    const refName = 'CODELY_ACCOUNT_OLDCRED'
    // ⚠️ credentialRef 对完整 ref 是恒等映射（实测），故直接用 refName 作键。
    credentials.store.set(refName, JSON.stringify({
      access_token: makeJwt({ exp, type: 'access' }),
      refresh_token: 'rt',
      obtained_at: Date.now() - 1000,
    }))
    added.push({ id: 'codely-old', provider: 'codely', credentialRef: refName, enabled: true })

    const list = await call('account.list', { provider: 'codely' })
    expect(list.ok).toBe(true)
    const entry = (list.value?.accounts as Array<Record<string, unknown>>)[0]
    expect(entry?.expiresAt).toBe(exp * 1000)
    // 自愈必须写回池（一次性，之后走正常回填）。
    expect(updated).toContainEqual(['codely-old', { expiresAt: exp * 1000 }])
  })

  it('★ 两层都拿不到（非 JWT 旧凭据）：跳过，不写 NaN / 0', async () => {
    installFetch(() => { throw new Error('unexpected fetch') })
    const { call, credentials, updated, added } = setup()
    const refName = 'CODELY_ACCOUNT_NOJWT'
    credentials.store.set(refName, JSON.stringify({
      access_token: 'at-not-a-jwt', refresh_token: 'rt', obtained_at: 1,
    }))
    added.push({ id: 'codely-nojwt', provider: 'codely', credentialRef: refName, enabled: true })
    const list = await call('account.list', { provider: 'codely' })
    const entry = (list.value?.accounts as Array<Record<string, unknown>>)[0]
    expect(entry?.expiresAt).toBeUndefined()
    expect(updated).toHaveLength(0)
  })
})
