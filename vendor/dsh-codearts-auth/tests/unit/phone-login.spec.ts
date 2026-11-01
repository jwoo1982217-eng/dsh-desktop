import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerJetHubRpc, JET_HUB_API_PATH } from '../../src/jet-hub-rpc.js'
import { AutoclawAuth } from '../../src/autoclaw-auth.js'
import { AUTOCLAW, AUTOCLAW_INTL } from '../../src/autoclaw-product.js'
import { probeAutoclawLocalCredential, startAutoclawSmsLoginFlow, startAutoclawZaiLoginFlow } from '../../src/autoclaw-oauth.js'
import { resolveAutoclawAppData, readMacAutoclawCredential } from '../../src/autoclaw-local-storage.js'
import { MagicrewAuth } from '../../src/magicrew-auth.js'
import { openPhoneNativeLogin } from '../../plugin-src/client/phone-native-login.js'
import { buildCreateAccountPayload } from '../../plugin-src/client/new-account.js'
import { openBrowser, openIncognitoWindow } from '../../src/login.js'

const { spawnProbe } = vi.hoisted(() => ({ spawnProbe: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: spawnProbe }))

const wireFetch = globalThis.fetch
const flows: Array<{ close(): Promise<void> }> = []
const hosts: Array<() => void> = []
const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } })
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const fixtureJwt = () => [JSON.stringify({ alg: 'HS256' }), JSON.stringify({ sub: 'phone' }), 'fixture-signature']
  .map(value => Buffer.from(value).toString('base64url')).join('.')
const until = async (check: () => boolean) => { for (let i = 0; i < 400; i++) { if (check()) return; await pause(10) } throw new Error('controlled login timed out') }

function host(magicFetch?: typeof fetch, oauthFetch?: typeof fetch) {
  const ctx = new Context()
  const disposers: Array<() => void> = []
  Object.assign(ctx, { effect: (callback: () => (() => void)) => { const cleanup = callback(); disposers.push(cleanup); return cleanup } })
  hosts.push(() => { for (const cleanup of disposers.reverse()) cleanup() })
  const creds = new Map<string, string>()
  Object.assign(ctx, { logger: { warn() {}, info() {}, debug() {}, error() {} } })
  const settings = new Map<string, unknown>()
  ctx.provide('settings', {
    register: (namespace: string) => ({ get: () => settings.get(namespace), replace: (value: unknown) => { settings.set(namespace, value) } }),
    describe: () => [],
  } as never)
  ctx.provide('credentials', {
    resolve: async (ref: string) => creds.has(ref) ? { value: creds.get(ref) } : undefined,
    describe: async () => ({ configured: true }), set: async (ref: string, value: string) => { creds.set(ref, value) },
    unset: async (ref: string) => { creds.delete(ref) },
  } as never)
  const pool = new AccountPool(ctx)
  const magicrew = new MagicrewAuth(ctx, { fetchImpl: magicFetch, profileFetcher: async () => ({ nickname: 'phone fixture' }) })
  const autoclaw = new AutoclawAuth(ctx)
  const autoclawintl = new AutoclawAuth(ctx, { product: AUTOCLAW_INTL, fetcher: oauthFetch })
  let route: ((req: Request) => Promise<Response>) | undefined
  Object.assign(ctx, { connection: { fetch: { register: (row: any) => { if (row.path === JET_HUB_API_PATH) route = row.fetch } } },
    inject: (_: unknown, callback: (context: Context) => void) => callback(ctx) })
  const auths = Object.fromEntries(['codearts','buddy','workbuddy','lobsterai','qoder','qodercn','trae','cline','loomy','raccoon','minimax','minimaxintl','zcode','gemini','officeace','accio','astudio','modelscope','qiniu'].map(id => [id, { scheduleRefresh() {} }]))
  registerJetHubRpc(ctx, pool, { ...auths, magicrew, autoclaw, autoclawintl } as never)
  const call = async (method: string, payload: unknown) => {
    const response = await route!(new Request('http://localhost/api/jet-hub', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'phone-fixture', method: 'jet-hub', payload: { method, payload } }) }))
    return (await response.json()).result
  }
  return { ctx, pool, creds, call, autoclaw, autoclawintl, magicrew }
}

afterEach(async () => {
  for (const flow of flows.splice(0)) await flow.close()
  for (const cleanup of hosts.splice(0)) cleanup()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

describe('手机账号登录：真实RPC与受控官方协议', () => {
  it('Android不读取Mac/Windows本机文件，客户端载荷固定为SMS/web/OAuth', async () => {
    vi.stubEnv('DSH_PHONE_ANDROID', '1')
    vi.stubGlobal('window', { __dshPhonePresentation: true })
    expect(resolveAutoclawAppData('/fixture-desktop')).toBeUndefined()
    expect(await readMacAutoclawCredential('/fixture-desktop')).toBeUndefined()
    expect(await probeAutoclawLocalCredential({ customAppData: '/fixture-desktop' })).toBeUndefined()
    openBrowser('https://fixture.invalid/authorize')
    expect(openIncognitoWindow('https://fixture.invalid/authorize')).toBe(false)
    expect(spawnProbe).not.toHaveBeenCalled()
    expect(buildCreateAccountPayload('autoclaw', '', '', '', 'local')).toEqual({ provider: 'autoclaw', autoclawMode: 'sms' })
    expect(buildCreateAccountPayload('autoclawintl', '', '', '', 'local')).toEqual({ provider: 'autoclawintl', autoclawMode: 'oauth' })
    expect(buildCreateAccountPayload('astudio', '', '', 'local')).toEqual({ provider: 'astudio', astudioLoginMethod: 'web' })
    const h = host(); const probe = vi.spyOn(h.autoclaw, 'probeLocal')
    expect((await h.call('account.create', { provider: 'autoclaw', autoclawMode: 'local' })).ok).toBe(false)
    expect((await h.call('account.create', { provider: 'astudio', astudioLoginMethod: 'local' })).ok).toBe(false)
    expect((await h.call('account.create', { provider: 'magicrew', mode: 'local-browser' })).ok).toBe(false)
    expect(probe).not.toHaveBeenCalled(); expect(h.creds.size).toBe(0)
  })

  it('国内短信Carrier在手机不显示桌面入口，真实HTTP完成code交换', async () => {
    vi.stubEnv('DSH_PHONE_ANDROID', '1')
    const fetcher = vi.fn(async (url: any) => String(url).endsWith('agent-send-code') ? json({}) : json({ user_id: 'phone-sms-user', access_token: 'fixture-access', refresh_token: 'fixture-refresh' }))
    const flow = await startAutoclawSmsLoginFlow({ product: AUTOCLAW, fetchImpl: fetcher, deviceId: 'phone-device' }); flows.push(flow)
    const page = await (await wireFetch(flow.loginUrl)).text()
    expect(page).not.toContain('id="btnLocal"'); expect(page).toContain('手机验证码登录')
    expect((await wireFetch(new URL('/autoclaw/import-local', flow.loginUrl), { method: 'POST' })).status).toBe(400)
    const post = (endpoint: string, body: unknown) => wireFetch(new URL(endpoint, flow.loginUrl), { method: 'POST', body: JSON.stringify(body) })
    expect((await post('/autoclaw/send-code', { phone: '13800000000' })).status).toBe(200)
    expect((await post('/autoclaw/submit-code', { phone: '13800000000', code: '123456' })).status).toBe(200)
    expect((await flow.result).credential.user_id).toBe('phone-sms-user')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('国际Z.ai真实回调→交换→RPC own-ref保存，坏回调不写入、取消后不落库', async () => {
    vi.stubEnv('DSH_PHONE_ANDROID', '1')
    const seen: any[] = []
    const fetcher = vi.fn(async (_url: any, init: any) => { seen.push(JSON.parse(init.body)); return json({ user_id: 'intl-phone', access_token: 'fixture-intl-at', refresh_token: 'fixture-intl-rt', expires_in: 3600 }) })
    const h = host(undefined, fetcher)
    const start = vi.spyOn(h.autoclawintl, 'startLogin').mockImplementation(async () => {
      const flow = await startAutoclawZaiLoginFlow({ product: AUTOCLAW_INTL, fetchImpl: fetcher, callbackPorts: [0] }); flows.push(flow); return flow
    })
    vi.spyOn(h.autoclawintl, 'verifyCredentialSite').mockResolvedValue()
    const old = { id: 'intl-existing', provider: 'autoclawintl', nickname: 'existing', enabled: true, credentialRef: 'AUTOCLAWINTL_ACCOUNT_EXISTING', refreshable: true, createdAt: 1 }
    await h.pool.addAccount(old); h.creds.set(old.credentialRef, '{"unchanged":true}')
    const created = (await h.call('account.create', { provider: 'autoclawintl', autoclawMode: 'oauth' })).value
    const redirect = new URL(new URL(created.loginUrl).searchParams.get('redirect_uri')!)
    redirect.hostname = '127.0.0.1'
    expect((await wireFetch(redirect)).status).toBe(400); expect(h.creds.size).toBe(1)
    redirect.searchParams.set('code', 'fixture-code'); redirect.searchParams.set('state', 'opaque-official-state')
    expect((await wireFetch(redirect)).status).toBe(200)
    await until(() => h.creds.size === 2)
    const added = h.pool.findAccount(created.accountId)!
    expect(JSON.parse(h.creds.get(added.credentialRef)!)).toMatchObject({ user_id: 'intl-phone', access_token: 'fixture-intl-at' })
    expect(h.creds.get(old.credentialRef)).toBe('{"unchanged":true}')
    expect(seen[0]).toMatchObject({ code: 'fixture-code', state: 'opaque-official-state', navigate_uri: new URL(created.loginUrl).searchParams.get('redirect_uri') })
    expect((await h.call('login.poll', { accountId: created.accountId })).value.success).toBe(true)
    const cancelled = (await h.call('account.create', { provider: 'autoclawintl', autoclawMode: 'oauth' })).value
    expect((await h.call('login.cancel', { accountId: cancelled.accountId })).value.cancelled).toBe(true)
    expect(h.pool.findAccount(cancelled.accountId)).toBeUndefined(); expect(h.creds.size).toBe(2)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it.each(['buddy', 'workbuddy'])('%s官方页面授权后同state轮询落到手机自己的ref', async provider => {
    vi.stubEnv('DSH_PHONE_ANDROID', '1')
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: any) => {
      const url = new URL(String(input)); calls.push(url.href)
      if (url.pathname.endsWith('/auth/state')) return json({ state: `phone-${provider}`, authUrl: `https://${url.hostname}/login?state=phone-${provider}` })
      if (url.pathname.endsWith('/auth/token')) return json({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', domain: url.hostname, expiresAt: String(Date.now() + 3600000), tokenType: 'Bearer' })
      if (url.pathname.endsWith('/account')) return json({ uid: `phone-${provider}`, nickname: 'phone user', type: 'personal' })
      throw new Error('unexpected endpoint')
    })
    const h = host(); const created = (await h.call('account.create', { provider })).value
    expect(created.loginUrl).toContain(`state=phone-${provider}`)
    await until(() => h.creds.size === 1)
    const entry = h.pool.findAccount(created.accountId)!
    expect(JSON.parse(h.creds.get(entry.credentialRef)!)).toMatchObject({ access_token: 'fixture-access', user_id: `phone-${provider}` })
    expect(calls.some(url => url.includes(`auth/token?state=phone-${provider}`))).toBe(true)
    expect((await h.call('login.poll', { accountId: entry.id })).value.success).toBe(true)
  }, 10000)

  it('Orca与Magicrew原生回传只完成当前pending；坏格式/取消/迟到/串号均不写', async () => {
    vi.stubEnv('DSH_PHONE_ANDROID', '1')
    const jwt = fixtureJwt()
    const issue = vi.fn(async () => new Response(JSON.stringify({ code: 1000, data: { api_key: 'mgw_fixture', refresh_token: 'fixture-refresh' } })))
    const h = host(issue)
    const orca = (await h.call('account.create', { provider: 'orcaterm' })).value
    const magic = (await h.call('account.create', { provider: 'magicrew' })).value
    const oldRef = h.pool.findAccount(orca.accountId)!.credentialRef
    expect(h.creds.size).toBe(0)
    expect((await h.call('account.create', { provider: 'orcaterm', mode: 'manual', accountId: orca.accountId, credential: 'uin=fixture; skey=fixture-secret' })).ok).toBe(true)
    expect(h.pool.findAccount(orca.accountId)?.credentialRef).toBe(oldRef)
    expect(JSON.parse(h.creds.get(oldRef)!)).toMatchObject({ kind: 'web', uin: 'fixture', skey: 'fixture-secret' })
    expect((await h.call('login.poll', { accountId: orca.accountId })).value.success).toBe(true)
    expect(await h.call('account.create', { provider: 'magicrew', mode: 'manual', accountId: magic.accountId, credential: { jwt, organizationCode: 'fixture-org' } })).toMatchObject({ ok: true })
    const magicRef = h.pool.findAccount(magic.accountId)!.credentialRef
    expect(JSON.parse(h.creds.get(magicRef)!)).toMatchObject({ jwt, organizationCode: 'fixture-org', apiKey: 'mgw_fixture' }); expect(issue).toHaveBeenCalledOnce()
    expect((await h.call('account.create', { provider: 'magicrew', mode: 'manual', accountId: orca.accountId, credential: { jwt, organizationCode: 'fixture-org' } })).ok).toBe(false)
    const late = (await h.call('account.create', { provider: 'orcaterm' })).value
    await h.call('login.cancel', { accountId: late.accountId })
    expect((await h.call('account.create', { provider: 'orcaterm', mode: 'manual', accountId: late.accountId, credential: 'uin=late; skey=late' })).ok).toBe(false)
    expect(h.creds.size).toBe(2)
    expect((await h.call('account.create', { provider: 'magicrew', mode: 'manual', credential: { jwt } })).ok).toBe(false)
    expect(h.creds.size).toBe(2)
  })

  it('取消WorkBuddy时中止同state轮询，迟到token不能写入；取消后可重试', async () => {
    vi.stubEnv('DSH_PHONE_ANDROID', '1')
    let release!: () => void; let tokenRequested = false; let waiting = true
    vi.stubGlobal('fetch', async (input: any) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/auth/state')) return json({ state: 'fixture-state', authUrl: 'https://www.workbuddy.ai/login?state=fixture-state' })
      if (url.pathname.endsWith('/auth/token')) {
        tokenRequested = true
        if (waiting) await new Promise<void>(resolve => { release = resolve })
        return json({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', domain: url.hostname })
      }
      return json({ uid: 'fixture-retry', nickname: 'retry', type: 'personal' })
    })
    const h = host(); const first = (await h.call('account.create', { provider: 'workbuddy' })).value
    await until(() => tokenRequested)
    expect((await h.call('login.cancel', { accountId: first.accountId })).value.cancelled).toBe(true)
    waiting = false; release(); await pause(30)
    expect(h.creds.size).toBe(0); expect(h.pool.findAccount(first.accountId)).toBeUndefined()
    const second = (await h.call('account.create', { provider: 'workbuddy' })).value
    await until(() => h.creds.size === 1)
    expect(h.pool.findAccount(second.accountId)).toBeDefined()
  }, 10000)

  it('Magicrew签发失败不建号，恢复后可导入；签发期间取消不留迟到凭据', async () => {
    vi.stubEnv('DSH_PHONE_ANDROID', '1')
    const credential = { jwt: fixtureJwt(), organizationCode: 'fixture-org' }
    let release!: () => void; let held = false
    const issue = vi.fn().mockRejectedValueOnce(new Error('fixture failure')).mockImplementation(async () => {
      if (held) await new Promise<void>(resolve => { release = resolve })
      return new Response(JSON.stringify({ code: 1000, data: { api_key: 'mgw_fixture' } }))
    })
    const h = host(issue)
    expect((await h.call('account.create', { provider: 'magicrew', mode: 'manual', credential })).ok).toBe(false)
    expect(h.creds.size).toBe(0); expect(h.pool.listAccountsByProvider('magicrew')).toEqual([])
    expect((await h.call('account.create', { provider: 'magicrew', mode: 'manual', credential })).ok).toBe(true)
    expect(h.creds.size).toBe(1); expect(h.creds.has('MAGICREW_ACCESS_TOKEN')).toBe(false)
    const cancelled = (await h.call('account.create', { provider: 'magicrew' })).value
    held = true
    const completion = h.call('account.create', { provider: 'magicrew', mode: 'manual', accountId: cancelled.accountId, credential })
    await until(() => typeof release === 'function')
    await h.call('login.cancel', { accountId: cancelled.accountId }); release()
    expect((await completion).ok).toBe(false); expect(h.creds.size).toBe(1)
    expect(h.pool.findAccount(cancelled.accountId)).toBeUndefined()
  })

  it('JS原生桥核对accountId、一次保存；关闭后忽略迟到结果并取消本轮', async () => {
    const calls: any[] = []
    const win: any = { location: { href: '' } }
    const rpcCall = async (method: string, payload: unknown) => { calls.push({ method, payload }); return {} }
    const handle = openPhoneNativeLogin({ provider: 'orcaterm', accountId: 'pending-A', loginUrl: 'https://orcaterm.cloud.tencent.com/terminal', rpcCall, browserWindow: win })
    expect(win.location.href).toContain('dsh-phone://orcaterm/login?account=pending-A')
    const receive = win.__dshOrcaTermLogin
    await receive(JSON.stringify({ accountId: 'wrong-B', value: 'uin=x;skey=y' })); expect(calls).toHaveLength(0)
    await receive(JSON.stringify({ accountId: 'pending-A', value: 'uin=x;skey=y' }))
    await receive(JSON.stringify({ accountId: 'pending-A', value: 'uin=x;skey=y' })); expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'account.create', payload: { accountId: 'pending-A', mode: 'manual', provider: 'orcaterm' } })
    handle.close(); await receive({ accountId: 'pending-A', value: 'uin=late;skey=late' }); expect(calls).toHaveLength(1)
    const cancelled = openPhoneNativeLogin({ provider: 'magicrew', accountId: 'pending-C', loginUrl: 'https://www.letsmagic.cn/', rpcCall, browserWindow: win })
    const oldCallback = win.__dshMagicrewLogin; cancelled.close()
    await oldCallback({ accountId: 'pending-C', value: '{}' })
    expect(calls[1]).toEqual({ method: 'login.cancel', payload: { accountId: 'pending-C' } }); expect(calls).toHaveLength(2)
  })

  it.each([false, true])('原生写库期间取消：去重旧账号=%s，只撤回本轮值并恢复旧字节', async existing => {
    vi.stubEnv('DSH_PHONE_ANDROID', '1')
    const h = host()
    const credential = { jwt: fixtureJwt(), organizationCode: 'fixture-org', apiKey: 'mgw_new' }
    let previousId = '', previousRef = '', previousValue = ''
    if (existing) {
      previousId = (await h.call('account.create', { provider: 'magicrew', mode: 'manual', credential: { ...credential, apiKey: 'mgw_original' } })).value.accountId
      previousRef = h.pool.findAccount(previousId)!.credentialRef; previousValue = h.creds.get(previousRef)!
    }
    const pending = (await h.call('account.create', { provider: 'magicrew' })).value
    const originalSet = h.ctx.credentials.set.bind(h.ctx.credentials)
    let release!: () => void
    vi.spyOn(h.ctx.credentials, 'set').mockImplementationOnce(async (ref, value) => {
      await new Promise<void>(resolve => { release = resolve })
      await originalSet(ref, value)
    })
    const saving = h.call('account.create', { provider: 'magicrew', mode: 'manual', accountId: pending.accountId, credential })
    await until(() => typeof release === 'function')
    await h.call('login.cancel', { accountId: pending.accountId }); release()
    expect((await saving).ok).toBe(false)
    expect(h.pool.findAccount(pending.accountId)).toBeUndefined()
    expect(h.creds.size).toBe(existing ? 1 : 0)
    if (existing) { expect(h.creds.get(previousRef)).toBe(previousValue); expect(h.pool.findAccount(previousId)).toBeDefined() }
  })

  it('原生窗口在签发途中返回取消，也会取消后台且不把空值当凭据导入', async () => {
    const calls: any[] = []; const win: any = { location: { href: '' } }
    let release!: () => void; let cancelled = false
    const rpcCall = async (method: string, payload: unknown) => {
      calls.push({ method, payload })
      if (method === 'account.create') await new Promise<void>(resolve => { release = resolve })
    }
    const handle = openPhoneNativeLogin({ provider: 'magicrew', accountId: 'pending-X', loginUrl: 'https://www.letsmagic.cn/', rpcCall, browserWindow: win, onCancel: () => { cancelled = true } })
    const receive = win.__dshMagicrewLogin
    const saving = receive({ accountId: 'pending-X', value: '{"jwt":"fixture"}' })
    await receive({ accountId: 'pending-X', cancelled: true })
    expect(handle.closed).toBe(true); expect(cancelled).toBe(true)
    expect(calls.map(row => row.method)).toEqual(['account.create', 'login.cancel'])
    release(); await saving
    await receive({ accountId: 'pending-X', value: '{"jwt":"late"}' })
    expect(calls).toHaveLength(2)
  })
})
