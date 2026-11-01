import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { fetchAuthState, getAccount, refreshToken } from '../../src/buddy-oauth.js'
import { CODEBUDDY, WORKBUDDY } from '../../src/product.js'
import { providerFromIssuer } from '../../plugin-src/client/backup-convert.js'

const token = {
  accessToken: 'existing-access', refreshToken: 'existing-refresh', domain: 'www.codebuddy.cn',
  expiresAt: String(Date.now() + 3_600_000), refreshExpiresAt: '', tokenType: 'Bearer', scope: '',
}
const credential = {
  access_token: token.accessToken, refresh_token: token.refreshToken, domain: token.domain,
  expires_at: token.expiresAt,
}
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data }))

describe('国内 WorkBuddy 账号协议', () => {
  it('登录入口使用国内 WorkBuddy 的 platform 与账号协议请求体', async () => {
    const fetcher = vi.fn(async () => response({ state: 'new-state', authUrl: 'https://www.workbuddy.cn/login/?state=new-state' }))
    await fetchAuthState(fetcher)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://www.workbuddy.cn/v2/plugin/auth/state?platform=workbuddy')
    expect(new Headers(init.headers).get('X-Domain')).toBe('www.workbuddy.cn')
    expect(new Headers(init.headers).get('User-Agent')).toContain('WorkBuddy/')
    expect(init.body).toBe('{}')
    expect(CODEBUDDY.id).toBe('buddy')
    expect(CODEBUDDY.defaultCredentialRef).toBe('BUDDY_ACCESS_TOKEN')
  })

  it('用当前账号端点读取身份，不再请求旧 login/account 或发送 state', async () => {
    const fetcher = vi.fn(async () => response({ uid: 'u1', nickname: 'n', type: 'personal' }))
    await expect(getAccount('private-state', token, { fetcher, pollIntervalMs: 0 })).resolves.toMatchObject({ uid: 'u1' })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://www.workbuddy.cn/v2/plugin/account')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer existing-access')
    expect(new Headers(init.headers).get('X-Domain')).toBe(token.domain)
    expect(new Headers(init.headers).has('X-No-User-Id')).toBe(false)
  })

  it('已有国内凭据可走账号协议续期，保留签发域与 refresh_token', async () => {
    const fetcher = vi.fn(async () => response(token))
    await refreshToken(credential, fetcher)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(url).toBe('https://www.workbuddy.cn/v2/plugin/auth/token/refresh')
    expect(headers.get('X-Domain')).toBe(token.domain)
    expect(headers.get('X-Refresh-Token')).toBe(token.refreshToken)
    expect(headers.get('X-Auth-Refresh-Source')).toBe('plugin')
    expect(init.body).toBe('{}')
  })

  it('转 API 使用国内账号端点与现有凭据，用户消息逐字保留', async () => {
    const fetcher = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n'))
    const refresh = vi.fn(async () => {})
    const adapter = new BuddyAdapter({ credentialRef: credentialRef('BUDDY_ACCOUNT_EXISTING'), resolveCredential: async () => credential, refresh, fetchImpl: fetcher })
    for await (const _ of adapter.stream({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: [{ type: 'text', text: '原消息保持：你好' }] }], signal: new AbortController().signal } as never)) { /* 消费完整流。 */ }
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://www.workbuddy.cn/v2/chat/completions')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer existing-access')
    expect(JSON.parse(init.body as string).messages.at(-1).content).toBe('原消息保持：你好')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('国际版保留原登录协议与端点', async () => {
    const fetcher = vi.fn(async () => response({ uid: 'intl', type: 'personal' }))
    await getAccount('intl-state', token, { fetcher, pollIntervalMs: 0, product: WORKBUDDY })
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toBe('https://www.workbuddy.ai/v2/plugin/login/account?state=intl-state')
  })

  it('国内 WorkBuddy 备份归入 buddy，国际版归入 workbuddy', () => {
    expect(providerFromIssuer('https://www.workbuddy.cn/auth/realms/copilot')).toBe('buddy')
    expect(providerFromIssuer('https://www.codebuddy.cn/auth/realms/copilot')).toBe('buddy')
    expect(providerFromIssuer('https://www.workbuddy.ai/auth/realms/copilot')).toBe('workbuddy')
  })
})
