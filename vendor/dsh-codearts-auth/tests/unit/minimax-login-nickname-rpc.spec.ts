/**
 * ★★ **MiniMax 登录后昵称回填（RPC 层行为判据）** —— Gitee issue IKP8UA.
 *
 * ## 为什么必须有一条**行为**用例（这是补变异验证打穿的缺口）
 *
 * 2026-10-23 修 IKP8UA 时，本仓库对 minimax 的 RPC 层**只有源码文本断言**
 *（`minimax-rpc.spec.ts` 的头部注释明说「遵循既有惯例，不为本 provider 单独
 * 引入 RPC 行为测试」）。而那次改动的**核心一行**就在 RPC 层：
 *
 * ```ts
 * const nickname = result.nickname ?? (result.accountId === undefined ? … : …)
 * ```
 *
 * 实测：把 `result.nickname ??` 这半行删掉（退回「恒用内部 id」的原逻辑），
 * **全量 10382 条单测零红** —— 也就是说这半个修复**没有任何守卫**。
 * 这正是本仓库反复记录的形态（「守卫全绿不代表它有牙」）。
 *
 * ⇒ 补这条行为用例：真跑 `account.create` + 等后台登录落定，断言账号池里的
 *   `nickname` 是**上游真名**，而不是 `minimax-xxxx`。
 *
 * ## 判据为什么打在「池里的 nickname」上
 *
 * 那正是用户看到的东西（账号卡片 / 用量徽标都读它）。断言源码里有没有
 * `result.nickname` 只是同义反复 —— 而本仓库对源码文本判据的假绿已有多次记录。
 */
import { describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { JET_HUB_API_PATH, registerJetHubRpc } from '../../src/jet-hub-rpc.js'
import { MINIMAX } from '../../src/minimax-product.js'
import type { MinimaxCredential } from '../../src/minimax.js'

/** 登录成功后的凭据（真机形态：`mmoat_` 前缀、非 JWT）。 */
const CRED: MinimaxCredential = {
  access_token: 'mmoat_' + 'x'.repeat(54),
  refresh_token: 'mmort_' + 'y'.repeat(54),
  token_type: 'Bearer',
  scope: 'agent.default',
  expires_at: String(Date.now() + 3600_000),
} as MinimaxCredential

/** 上游身份响应（真机形态，见 `minimax-identity.ts` 的矩阵）。 */
const IDENTITY_OK = {
  statusInfo: { code: 0, httpCode: 0, message: '成功' },
  data: { userInfo: { name: 'MiniMax909127', userID: 'ZDxY6oEjmoaX' } },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 造一个能跑 `account.create` 的最小环境（真实 `AccountPool` + 真实 RPC handler）。
 *
 * ⚠️ `minimaxAuth` 用**真实 MinimaxAuth**（`Service` 需要真 cordis Context），
 *    只把网络换掉：设备码 / 令牌轮询 / 身份查询全部由注入的 `fetchImpl` 应答。
 */
async function setup(): Promise<{
  call: (method: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>
  pool: AccountPool
  nicknameOf: (id: string) => string | undefined
}> {
  const { Context } = await import('@deepseek-ai/cordis')
  const { MinimaxAuth } = await import('../../src/minimax-auth.js')

  let stored: Record<string, unknown> = { accounts: [], disabledModels: {} }
  const ctx = new Context() as never as {
    provide: (name: string, value: unknown) => void
    get: (name: string) => unknown
  }

  const credentials = {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
    set: async () => {},
    unset: async () => {},
  }
  ctx.provide('credentials', credentials)

  const pool = new AccountPool({
    get: (key: string) => key === 'settings'
      ? {
          register: () => ({
            get: () => stored,
            replace: async (value: Record<string, unknown>) => { stored = value },
          }),
        }
      : undefined,
    logger: { warn: () => {}, info: () => {} },
    credentials,
  } as never)

  ctx.provide('accountPool', pool)

  // 假的 net：设备码 → 令牌轮询立即成功 → 身份查询返回真名。
  const fakeFetch = async (url: string): Promise<Response> => {
    const u = String(url)
    // 身份端点（`/v1/api/user/info`）
    if (u.includes('/v1/api/user/info')) return jsonResponse(IDENTITY_OK)
    // 设备码
    if (u.includes('/oauth2/device/code')) {
      return jsonResponse({
        user_code: 'ABCD-1234',
        verification_uri: 'https://agent.minimax.cn/device',
        device_code: 'dev-code',
        expires_in: 600,
        interval: 1,
      })
    }
    // 令牌轮询：一次即成功
    if (u.includes('/oauth2/token')) {
      return jsonResponse({
        access_token: CRED.access_token,
        refresh_token: CRED.refresh_token,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'agent.default',
      })
    }
    return new Response('unexpected', { status: 404 })
  }

  const minimaxAuth = new MinimaxAuth(ctx as never, {
    fetchImpl: fakeFetch as never,
    // 轮询不要真等
    sleep: async () => {},
  })

  let handler: ((req: Request) => Promise<Response>) | undefined
  const rpcCtx = {
    get: (key: string) => {
      if (key === 'connection') {
        return {
          fetch: {
            register: (config: { path: string; fetch: typeof handler }) => {
              if (config.path === JET_HUB_API_PATH) handler = config.fetch
            },
          },
        }
      }
      if (key === 'credentials') return credentials
      if (key === 'llm') return { listModels: async () => [], resolveModelInfo: async () => ({}) }
      return undefined
    },
    inject: (_deps: string[], cb: (c: unknown) => void) => { cb(rpcCtx) },
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    emit: () => {},
  }

  registerJetHubRpc(rpcCtx as never, pool, {
    codearts: {}, buddy: {}, workbuddy: {}, lobsterai: {}, qoder: {}, qodercn: {},
    trae: {}, cline: {}, loomy: {}, raccoon: {}, minimax: minimaxAuth, zcode: {},
    gemini: {}, officeace: {}, minimaxintl: minimaxAuth, autoclaw: {}, accio: {},
    opencode: {},
  } as never)
  if (handler === undefined) throw new Error('RPC handler 未注册')

  return {
    pool,
    nicknameOf: (id: string) => pool.findAccount(id)?.nickname,
    call: async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'r1', method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    },
  }
}

/** 等后台登录落定（`account.create` 是 fire-and-forget 的 background 链）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('★★ MiniMax 登录后昵称回填（IKP8UA，RPC 层行为判据）', () => {
  it('★★ 登录成功后池里的 nickname 必须是上游真名，不是内部 id', async () => {
    const { call, nicknameOf, pool } = await setup()
    const created = await call('account.create', { provider: MINIMAX.id })
    expect(created.ok, `account.create 应成功：${created.error?.message ?? ''}`).toBe(true)
    const id = (created.value as { accountId: string }).accountId

    // 后台链：令牌轮询 → persistLogin（内含身份查询）→ 写池。
    await waitFor(() => nicknameOf(id) !== id)

    expect(
      nicknameOf(id),
      '★★ 昵称仍是内部 id ⇒ `result.nickname` 那条腿没接线（删掉它全量零红，'
      + '故本用例是它唯一的守卫）',
    ).toBe('MiniMax909127')
    // 账号确实在池里（不是被别的原因清理掉了）。
    expect(pool.findAccount(id), '账号必须真实存在').toBeDefined()
  })
})
