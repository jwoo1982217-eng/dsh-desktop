import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  MinimaxAuth,
  MinimaxRefreshTokenExpiredError,
  parseMinimaxCredential,
} from '../../src/minimax-auth.js'

const CRED = {
  access_token: 'a'.repeat(60),
  refresh_token: 'r'.repeat(60),
  token_type: 'Bearer',
  expires_at: String(Date.now() + 3_600_000),
  scope: 'agent.default',
}

/** 造一个 JSON `Response`。 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 一次**成功**的续期响应（形状满足 `parseMinimaxTokenGrant` 的硬校验：
 * `token_type` 必须 Bearer、`expires_in` 必须正数、`scope` 必须含 `agent.default`）。
 */
function refreshOk(overrides: Record<string, unknown> = {}): Response {
  return json({
    access_token: 'n'.repeat(60),
    refresh_token: 'r2'.repeat(30),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'agent.default',
    ...overrides,
  })
}

/** 取凭据 ref 的键名（`credentialRef(name)` 返回 `{ name }` 形态）。 */
function keyOf(ref: unknown): string {
  if (typeof ref === 'string') return ref
  if (ref !== null && typeof ref === 'object' && 'name' in ref) {
    return String((ref as { name: unknown }).name)
  }
  return String(ref)
}

/**
 * 造一个**真实** `Context`。
 *
 * ⚠️ brief 里的 `new MinimaxAuth({} as never, ...)` 以及 refreshAll 段的**裸对象 ctx**
 * 在运行期**跑不起来**：cordis 的 `Service` 构造函数会执行
 * `ctx.reflect.provide(name, this, ...)`，裸对象没有 `reflect`，直接
 * `TypeError: Cannot read properties of undefined (reading 'provide')`。
 * 故这里与 `tests/unit/cline-auth.spec.ts` 同法：用真实 `Context` +
 * `ctx.provide('credentials', ...)`。**断言本身逐字未动。**
 */
function makeContext(
  credentials: {
    resolve?: (ref: unknown) => Promise<{ value: string } | undefined>
    set?: (ref: unknown, value: string) => Promise<void>
  } = {},
): Context {
  const ctx = new Context()
  ctx.provide('credentials', {
    resolve: async () => undefined,
    set: async () => {},
    ...credentials,
  } as never)
  return ctx
}

describe('parseMinimaxCredential', () => {
  it('解析合法凭据', () => {
    expect(parseMinimaxCredential(JSON.stringify(CRED))?.access_token).toBe(CRED.access_token)
  })

  it('⚠️ 缺 access_token 时返回 undefined（它是账号池的匹配依据）', () => {
    expect(parseMinimaxCredential(JSON.stringify({ ...CRED, access_token: undefined })))
      .toBeUndefined()
  })

  it('非法 JSON 返回 undefined 而不抛错', () => {
    expect(parseMinimaxCredential('{not json')).toBeUndefined()
  })
})

describe('fetchModels', () => {
  it('⚠️ 远端优先，且用 region/buildEnv 查询参数', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: '1.0',
      ttlSeconds: 300,
      providers: [{
        providerId: 'minimax',
        config: {
          models: {
            'MiniMax-M3.1-Flash-Preview': {
              name: 'M3.1-Flash-Preview',
              limit: { context: 512_000, output: 128_000 },
              context_window_options: [512_000, 1_000_000],
              modalities: { input: ['text', 'image'] },
              effort_options: ['default', 'max'],
              default_effort: 'default',
            },
          },
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    // 直接测纯函数路径：通过注入的 fetcher 观察 URL
    const models = await (auth as unknown as {
      fetchModelsWith: (c: unknown) => Promise<readonly unknown[]>
    }).fetchModelsWith(CRED)

    const url = String(fetcher.mock.calls[0]?.[0])
    expect(url).toContain('region=cn')
    expect(url).toContain('buildEnv=prod')
    expect(url).toContain('/mavis/api/v1/models')
    const first = models[0] as { id: string; contextWindow: number }
    expect(first.id).toBe('MiniMax-M3.1-Flash-Preview')
    expect(first.contextWindow).toBe(1_000_000)
  })

  it('⚠️ 远端失败时回退兜底表（不抛错、不空列表）', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'))
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const models = await (auth as unknown as {
      fetchModelsWith: (c: unknown) => Promise<readonly { id: string }[]>
    }).fetchModelsWith(CRED)
    expect(models.map((m) => m.id)).toEqual([
      'MiniMax-M3.1-Flash-Preview', 'MiniMax-M3', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.7',
    ])
  })

  it('⚠️ 远端响应缺 minimax provider 时回退兜底表', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: '1.0', ttlSeconds: 300, providers: [{ providerId: 'other', config: { models: {} } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const models = await (auth as unknown as {
      fetchModelsWith: (c: unknown) => Promise<readonly { id: string }[]>
    }).fetchModelsWith(CRED)
    expect(models).toHaveLength(4)
  })

  /**
   * ⚠ **接线契约**：适配器判「这次拿到目录了吗」靠的是「返回空数组」，故
   * 接线必须用 `fetchRemoteModelsOnly()`。若误用 `fetchModels()`（失败时回吐
   * 兜底表），判据永不命中 ⇒ 兜底表被当成远端结果永久缓存，用户登录 / 网络
   * 恢复后再也不会重拉。下面三条把两种语义钉死，防止以后有人「顺手统一」。
   */
  const only = (auth: MinimaxAuth, pool?: unknown): Promise<readonly { id: string }[]> =>
    (auth as unknown as {
      fetchRemoteModelsOnly: (p?: unknown) => Promise<readonly { id: string }[]>
    }).fetchRemoteModelsOnly(pool)

  it('★ fetchRemoteModelsOnly 在远端失败时返回空数组（不回吐兜底表）', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'))
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(CRED) }),
    }), { fetchImpl: fetcher as never })
    expect(await only(auth)).toEqual([])
  })

  it('★ fetchRemoteModelsOnly 在未登录时返回空数组（不发请求）', async () => {
    const fetcher = vi.fn()
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    expect(await only(auth)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('★ fetchRemoteModelsOnly 在远端成功时原样返回', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({
      providers: [{
        providerId: 'minimax',
        config: {
          models: {
            'MiniMax-M3': { name: 'MiniMax-M3', limit: { context: 512_000, output: 128_000 } },
          },
        },
      }],
    }))
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(CRED) }),
    }), { fetchImpl: fetcher as never })
    expect((await only(auth)).map((m) => m.id)).toEqual(['MiniMax-M3'])
  })
})

describe('refreshAll', () => {
  /**
   * ★★ **判据是「凭据里还有没有 refresh_token」，不是池里的 `refreshable`**。
   *
   * ## 口径变更（2026-10-27 审计修）
   *
   * 修前本用例锁的是「`refreshable:false` 的条目**必须被跳过**」——
   * 那条断言正是**单向门**本体的守卫：`refreshable` 是每轮由凭据对账出来的
   * **镜像**，而写 `false` 的唯一来源是终态判定。一旦判据偶发误判（上游 5xx
   * 报文里出现 `expired`、限流文案、证书过期），账号就再也回不来：
   * 定时那轮跳过它、启动首轮也跳过它（`AGENTS.md`：「自动续期没工作、重启也没用」）。
   *
   * `docs/adding-a-new-provider.md:132-135` 把「不看 `refreshable`」列为**红线**，
   * 且 `healExpiredAccountBeforeBalance`（`jet-hub-rpc.ts`）**刻意不判**它 ——
   * 本 PR 却在 `refreshAll` 与巡检里各复制了一份。
   *
   * ⇒ 现在断言反过来：池说 `refreshable:false` 但**凭据里有 `refresh_token`**
   * 时，仍然必须被处理（并借 `syncAccountExpiry` 把镜像纠正回 `true`）。
   */
  it('⚠️ 不看池里的 refreshable（读凭据本体），也不看 enabled', async () => {
    const updated: { id: string; patch: unknown }[] = []
    const pool = {
      listAccounts: async () => [
        { id: 'a1', credentialRef: 'MINIMAX_ACCOUNT_A1', refreshable: true, enabled: false, expiresAt: 0 },
        // ⚠️ 误标：池说不可续期，但凭据里 `refresh_token` 完好
        { id: 'a2', credentialRef: 'MINIMAX_ACCOUNT_A2', refreshable: false, enabled: true, expiresAt: 0 },
      ],
      updateAccount: async (id: string, patch: unknown) => { updated.push({ id, patch }) },
      findAccountIdByCredential: async () => 'a1',
    }
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(CRED) }),
      set: async () => {},
    }), { fetchImpl: (async () => refreshOk()) as never })
    await auth.refreshAll(pool as never)
    // a1 虽然 enabled:false 但凭据可续期，必须被处理
    expect(updated.some((u) => u.id === 'a1'), 'enabled:false 不得阻止凭据续期/对账').toBe(true)
    // ★ a2 池标 refreshable:false，但凭据里 refresh_token 完好 ⇒ **必须仍被处理**
    expect(updated.some((u) => u.id === 'a2'), '★ 误标 refreshable:false 不得变成单向门').toBe(true)
  })

  it('★ 凭据里确实没有 refresh_token ⇒ 才标 refreshable:false（权威判据）', async () => {
    const updated: { id: string; patch: unknown }[] = []
    const pool = {
      listAccounts: async () => [
        { id: 'a1', credentialRef: 'MINIMAX_ACCOUNT_A1', refreshable: true, enabled: true, expiresAt: 0 },
      ],
      updateAccount: async (id: string, patch: unknown) => { updated.push({ id, patch }) },
      findAccountIdByCredential: async () => 'a1',
    }
    const auth = new MinimaxAuth(makeContext({
      // 凭据形状合法但**没有** refresh_token
      resolve: async () => ({ value: JSON.stringify({ ...CRED, refresh_token: '' }) }),
      set: async () => {},
    }), { fetchImpl: (async () => { throw new Error('不应发请求') }) as never })
    await auth.refreshAll(pool as never)
    expect(
      updated.some((u) => u.id === 'a1' && (u.patch as { refreshable?: boolean }).refreshable === false),
      '凭据材料才是权威：没有 refresh_token 必须标死',
    ).toBe(true)
  })

  it('★ 凭据读不到 / 解析失败时**不得**标 refreshable:false（那是存储问题，不是服务端拒绝）', async () => {
    const updated: { id: string; patch: unknown }[] = []
    const pool = {
      listAccounts: async () => [
        { id: 'a1', credentialRef: 'MINIMAX_ACCOUNT_A1', refreshable: true, enabled: true, expiresAt: 0 },
      ],
      updateAccount: async (id: string, patch: unknown) => { updated.push({ id, patch }) },
      findAccountIdByCredential: async () => 'a1',
    }
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => undefined,
      set: async () => {},
    }), { fetchImpl: (async () => { throw new Error('不应发请求') }) as never })
    await auth.refreshAll(pool as never)
    expect(
      updated.some((u) => (u.patch as { refreshable?: boolean }).refreshable === false),
      '读不到凭据不得改池标记（否则又是单向门）',
    ).toBe(false)
  })

  it('⚠️ 凭据仍在有效期内时只对账池值、不发续期请求（共享实现的行为）', async () => {
    // 凭据 1 小时后过期 → shouldRefreshNow 为 true；改成 3 小时后过期则不刷
    const fresh = { ...CRED, expires_at: String(Date.now() + 3 * 3_600_000) }
    const updated: { id: string; patch: unknown }[] = []
    const pool = {
      listAccounts: async () => [
        { id: 'a1', credentialRef: 'MINIMAX_ACCOUNT_A1', refreshable: true, enabled: true, expiresAt: 1 },
      ],
      updateAccount: async (id: string, patch: unknown) => { updated.push({ id, patch }) },
      findAccountIdByCredential: async () => 'a1',
    }
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(fresh) }),
      set: async () => {},
    }), { fetchImpl: (() => { throw new Error('不应发请求') }) as never })
    await auth.refreshAll(pool as never)
    // 池值 expiresAt=1 与凭据不一致 → 必须对账回写
    expect(updated.some((u) => u.id === 'a1')).toBe(true)
  })

  it('⚠️ reconcile-only：按账号条目自身的 credentialRef 读凭据对账，但不写凭据（写权在巡检 renewEntry）', async () => {
    const read: string[] = []
    const written: string[] = []
    const updated: { id: string; patch: unknown }[] = []
    const pool = {
      listAccounts: async () => [
        { id: 'a1', credentialRef: 'MINIMAX_ACCOUNT_A1', refreshable: true, enabled: true, expiresAt: 0 },
      ],
      updateAccount: async (id: string, patch: unknown) => { updated.push({ id, patch }) },
      findAccountIdByCredential: async () => 'a1',
    }
    const auth = new MinimaxAuth(makeContext({
      resolve: async (ref) => { read.push(keyOf(ref)); return { value: JSON.stringify(CRED) } },
      set: async (ref) => { written.push(keyOf(ref)) },
    }), { fetchImpl: (async () => refreshOk()) as never })
    await auth.refreshAll(pool as never)
    // 对账读的是**自己条目**的 ref（写错 ref 会读错账号）
    expect(read).toEqual(['MINIMAX_ACCOUNT_A1'])
    // ⚠️ 2026-10-24 reconcile-only：refreshAll 不发 grant ⇒ **不写凭据** ——
    //    凭据的写权收口在 renewEntry（60s 巡检 / 请求路径兜底）。
    expect(written).toEqual([])
    // 但池镜像必须对账（entry.expiresAt=0 → 凭据真实值），否则 UI 恒显「已过期」
    expect(updated.some((u) => u.id === 'a1')).toBe(true)
  })

  it('⚠️ reconcile-only：凭据已过期也**不发请求**（轮换权已移交 60s 巡检）', async () => {
    const expired = { ...CRED, expires_at: String(Date.now() - 1_000) }
    const fetcher = vi.fn()
    const pool = {
      listAccounts: async () => [
        { id: 'a1', credentialRef: 'MINIMAX_ACCOUNT_A1', refreshable: true, enabled: true, expiresAt: 0 },
      ],
      updateAccount: async () => {},
      findAccountIdByCredential: async () => 'a1',
    }
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(expired) }),
      set: async () => {},
    }), { fetchImpl: fetcher as never })
    await auth.refreshAll(pool as never)
    // ⚠️ 这是本次重构的**核心断言**：定时批量轮换必须消失，轮换只由
    //    60s 巡检（renewEntry）与请求路径兜底承担（官方 oauth-core 即按需制）。
    expect(fetcher).not.toHaveBeenCalled()
  })
})

/**
 * ★★ **renewEntry**（2026-10-24 本地试验版：60s 巡检 / 精准续期 / 401 强刷
 * 共用的核心入口）。
 *
 * ## 守的纪律（缺一都是事故）
 *
 * - **margin**：剩余有效期远超 margin 时绝不发请求（轮换次数 = 风险预算）；
 * - **写回自己的 ref**：per-ref 读写（「续错账号」的老缺陷防线，语义从
 *   refreshAll 迁移到这里）；
 * - **previous_refresh_tokens**：旧 RT 压栈（新→旧、去重、截 3 条）；
 * - **CAS**：grant 前后重读凭据，被别人写过就丢弃（绝不覆盖更新的会话）；
 * - **单飞**：同 ref 并发只发一份 grant；
 * - **终态**：当前 RT 死了先回退历史代际，全失败才标 `refreshable:false`。
 */
describe('renewEntry（2026-10-24 本地试验版）', () => {
  const ENTRY = { id: 'a1', credentialRef: 'MINIMAX_ACCOUNT_A1', refreshable: true } as const

  /**
   * 造一个**可变凭据存储** + 真实 Context 的续期环境。
   *
   * ⚠️ `journalHome` 刻意不传 ⇒ journal **绝不写盘**（单测不得污染用户 `~/.dsh`）。
   */
  function makeRenewEnv(options: {
    store: Map<string, string>
    fetcher: typeof fetch
    sleep?: (ms: number) => Promise<void>
  }) {
    const written: Array<{ ref: string; value: string }> = []
    const updated: Array<{ id: string; patch: unknown }> = []
    const ctx = new Context()
    ctx.provide('credentials', {
      resolve: async (ref: unknown) => {
        const value = options.store.get(keyOf(ref))
        return value === undefined ? undefined : { value }
      },
      set: async (ref: unknown, value: string) => {
        const name = keyOf(ref)
        written.push({ ref: name, value })
        options.store.set(name, value)
      },
    } as never)
    const auth = new MinimaxAuth(ctx, {
      fetchImpl: options.fetcher as never,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    })
    const pool = {
      listAccounts: async () => [ENTRY],
      updateAccount: async (id: string, patch: unknown) => { updated.push({ id, patch }) },
      findAccountIdByCredential: async () => 'a1',
    }
    return { auth, pool, written, updated }
  }

  it('⚠️ 剩余远超 margin ⇒ 不发请求（轮换次数是风险预算）', async () => {
    const store = new Map([['MINIMAX_ACCOUNT_A1', JSON.stringify(CRED)]]) // 1h 后过期
    const fetcher = vi.fn()
    const { auth, pool } = makeRenewEnv({ store, fetcher })
    const out = await auth.renewEntry(pool, ENTRY, { marginMs: 5 * 60_000, trigger: 'patrol' })
    expect(out.renewed).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('⚠️ 已过期 ⇒ 发 grant、写回**自己的 ref**、池镜像更新、旧 RT 压入历史栈', async () => {
    const expired = { ...CRED, expires_at: String(Date.now() - 1_000) }
    const store = new Map([['MINIMAX_ACCOUNT_A1', JSON.stringify(expired)]])
    const fetcher = vi.fn(async () => refreshOk())
    const { auth, pool, written, updated } = makeRenewEnv({ store, fetcher })
    const out = await auth.renewEntry(pool, ENTRY, { marginMs: 5 * 60_000, trigger: 'patrol' })
    expect(out.renewed, '临期账号必须真的续期').toBe(true)
    // 写回**自己的 ref**（续错账号的老缺陷防线，语义从 refreshAll 迁到这里）
    expect(written.map((w) => w.ref)).toEqual(['MINIMAX_ACCOUNT_A1'])
    const payload = JSON.parse(written[0]!.value) as {
      access_token: string
      previous_refresh_tokens?: string[]
    }
    expect(payload.access_token).toBe('n'.repeat(60))
    expect(payload.previous_refresh_tokens, '旧 RT 必须压入历史栈（断链抢救的弹药）')
      .toEqual([CRED.refresh_token])
    expect(updated.some((u) => u.id === 'a1'), '池镜像必须跟着更新（UI 读池值）').toBe(true)
  })

  it('⚠️ 单飞：同 ref 并发只发一份 grant', async () => {
    const expired = { ...CRED, expires_at: String(Date.now() - 1_000) }
    const store = new Map([['MINIMAX_ACCOUNT_A1', JSON.stringify(expired)]])
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetcher = vi.fn(async () => { await gate; return refreshOk() })
    const { auth, pool } = makeRenewEnv({ store, fetcher })
    const first = auth.renewEntry(pool, ENTRY, { marginMs: 5 * 60_000, trigger: 'patrol' })
    const second = auth.renewEntry(pool, ENTRY, { marginMs: 5 * 60_000, trigger: 'patrol' })
    release()
    await Promise.all([first, second])
    expect(fetcher, '巡检/兜底/强刷并发想续同一账号时，只允许一份 grant 在天上').toHaveBeenCalledTimes(1)
  })

  it('⚠️ CAS：grant 期间凭据被别人改写 ⇒ 不覆盖新会话（但把本次新 RT 压进历史栈）', async () => {
    const expired = { ...CRED, expires_at: String(Date.now() - 1_000) }
    const store = new Map([['MINIMAX_ACCOUNT_A1', JSON.stringify(expired)]])
    const fetcher = vi.fn(async () => {
      // ⚠️ grant 在天上时「别的写入方」落盘了一份新会话 —— 模拟登录并发。
      store.set('MINIMAX_ACCOUNT_A1', JSON.stringify({
        ...CRED,
        access_token: 'b'.repeat(60),
        expires_at: String(Date.now() + 3_600_000),
      }))
      return refreshOk()
    })
    const { auth, pool, written } = makeRenewEnv({ store, fetcher })
    const out = await auth.renewEntry(pool, ENTRY, { marginMs: 5 * 60_000, trigger: 'patrol' })
    expect(out.renewed).toBe(false)
    expect(out.superseded, '必须判为「被别人抢先」而不是「续期成功」').toBe(true)
    /**
     * ★★ 判据变更（2026-10-27 审计修）：**不再断言「一次都不写」**。
     *
     * 修前这里写 `expect(written).toEqual([])`，理由是「覆盖回去等于把新钥匙
     * 换成旧钥匙」—— 那个**方向**是对的，但「一个字节都不落盘」在一次性 RT
     * 语义下有**净损失**：本次 grant **已在上游完成轮换**，丢弃而**不压栈** =
     * 那把新 RT 成为孤儿，抢救链的弹药反而少了一把（实测 `MINE_NEW_RT` 永久消失）。
     *
     * ⇒ 现在允许**恰好一次**写盘，但内容必须满足两条硬约束：
     *   ① **令牌材料不得被覆盖**（`access_token` / `refresh_token` 仍是别人那份）；
     *   ② 只多一个 `previous_refresh_tokens`，且含本次新拿到的 RT。
     */
    /**
     * ⚠️⚠️ **判据必须收紧到「恰好一次 + 必含新 RT」**（2026-10-27 第二轮审计修）。
     *
     * 修前是 `toBeLessThanOrEqual(1)` **外面再套一个 `if (written.length === 1)`**
     * —— 那个 `if` 让「一次都不写」也全绿 ⇒ 审计员实测**删掉补弹药逻辑后
     * 64 条用例全绿**，即这条守卫**无牙**。
     *
     * 真实现的 CAS 分支确实写**恰好一次**（审计员用自己的探针复核过
     * `written.length = 1`）⇒ 收紧成 `toBe(1)` 不会造成假红，
     * 却能精确抓住「补弹药被删掉」这个回归。
     */
    expect(written.length, '★ CAS 分支必须**恰好写一次**（补弹药）；0 次 = 补弹药被删、2 次 = 整份覆盖').toBe(1)
    const finalValue = store.get('MINIMAX_ACCOUNT_A1') as string
    const finalCredential = JSON.parse(finalValue) as {
      access_token: string
      refresh_token?: string
      previous_refresh_tokens?: string[]
    }
    expect(finalCredential.access_token, '★ 别人的新 access_token 不得被覆盖').toBe('b'.repeat(60))
    expect(finalCredential.refresh_token, '★ 别人的新 refresh_token 不得被覆盖').toBe(CRED.refresh_token)
    expect(
      finalCredential.previous_refresh_tokens ?? [],
      '★ 本次轮换出来的新 RT 必须压进历史栈（否则孤儿 + 弹药变少）',
      // ⚠️ `refreshOk()` 的 `refresh_token` 是 `'r2'.repeat(30)`（不是 access_token 那个）
    ).toContain('r2'.repeat(30))
  })

  it('⚠️ 终态：当前 RT invalid_grant → 回退历史代际 RT 成功 ⇒ 凭据救回', async () => {
    const dead = {
      ...CRED,
      expires_at: String(Date.now() - 1_000),
      previous_refresh_tokens: ['old-rt-1'],
    }
    const store = new Map([['MINIMAX_ACCOUNT_A1', JSON.stringify(dead)]])
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body)
      // 当前 RT 已死；上一代 RT 仍活着（上游只作废被用的那条的假说成立形态）
      return body.includes('old-rt-1') ? refreshOk() : json({ error: 'invalid_grant' }, 400)
    })
    const { auth, pool, written } = makeRenewEnv({ store, fetcher })
    const out = await auth.renewEntry(pool, ENTRY, { marginMs: 5 * 60_000, trigger: 'patrol' })
    expect(out.renewed, '★ 旧代际救回 = 账号免于重登（本特性的全部意义）').toBe(true)
    const payload = JSON.parse(written[0]!.value) as { access_token: string }
    expect(payload.access_token).toBe('n'.repeat(60))
  })

  it('⚠️ 终态全失败（无历史代际）⇒ 抛终态错误 + 池标 refreshable:false', async () => {
    const dead = { ...CRED, expires_at: String(Date.now() - 1_000) }
    const store = new Map([['MINIMAX_ACCOUNT_A1', JSON.stringify(dead)]])
    const fetcher = vi.fn(async () => json({ error: 'invalid_grant' }, 400))
    const { auth, pool, updated } = makeRenewEnv({ store, fetcher })
    await expect(
      auth.renewEntry(pool, ENTRY, { marginMs: 5 * 60_000, trigger: 'patrol' }),
    ).rejects.toBeInstanceOf(MinimaxRefreshTokenExpiredError)
    expect(
      updated.some((u) => u.id === 'a1' && (u.patch as { refreshable?: boolean }).refreshable === false),
      '全失败必须标记需重登（与旧 refreshAll 终态行为一致）',
    ).toBe(true)
  })
})

describe('refreshCredentialFor', () => {
  it('⚠️ 续期申请必须带上旧的 refresh_token（丢失会让账号在下次续期时报废）', async () => {
    const fetcher = vi.fn().mockResolvedValue(refreshOk())
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const next = await auth.refreshCredentialFor({
      access_token: 'a'.repeat(60),
      refresh_token: 'old-refresh-token',
    })
    // 请求体里必须出现旧 refresh_token（服务端靠它轮换）
    const body = String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    expect(body).toContain('refresh_token=old-refresh-token')
    expect(next.refresh_token).toBe('r2'.repeat(30))
  })

  it('⚠️ 响应缺 refresh_token 时要沿用旧值（不能续成无 refresh_token 的残疾凭据）', async () => {
    const fetcher = vi.fn().mockResolvedValue(refreshOk({ refresh_token: undefined }))
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const next = await auth.refreshCredentialFor({
      access_token: 'a'.repeat(60),
      refresh_token: 'old-refresh-token',
    })
    expect(next.refresh_token).toBe('old-refresh-token')
  })

  it('⚠️ refresh_token 失效时抛 MinimaxRefreshTokenExpiredError（name 精确，供调度器判终态）', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({ error: 'invalid_grant' }, 400),
    )
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const error = await auth.refreshCredentialFor({
      access_token: 'a'.repeat(60),
      refresh_token: 'dead',
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MinimaxRefreshTokenExpiredError)
    // ⚠️ `name` **必须**是 `'RefreshTokenExpiredError'`（不是本类名）——
    // `src/refresh.ts:23` 的 `RefreshScheduler` 终态判据就是按这个字符串比较的。
    // 写成 `'MinimaxRefreshTokenExpiredError'` 会让该分支恒不命中，
    // 退化成靠 message 正则兜底，文案一改即无限重试。
    expect((error as Error).name).toBe('RefreshTokenExpiredError')
    // 与项目级判据同源：用 refresh.ts 的逻辑验证它**确实**被判为终态。
    expect((error as Error).name === 'RefreshTokenExpiredError').toBe(true)
  })

  it('⚠️ 新凭据的 expires_at 必须由响应 expires_in 自算（access_token 非 JWT，解不出来）', async () => {
    const before = Date.now()
    const fetcher = vi.fn().mockResolvedValue(refreshOk({ expires_in: 7200 }))
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const next = await auth.refreshCredentialFor({
      access_token: 'a'.repeat(60),
      refresh_token: 'old-refresh-token',
    })
    const expiresAt = Number(next.expires_at)
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7_200_000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 7_200_000 + 5_000)
  })
})

describe('refreshAccountCredential', () => {
  it('⚠️ 未给 accountId 时按 access_token 反查账号（传 ref 名会恒匹配失败且静默）', async () => {
    const fresh = { ...CRED, expires_at: String(Date.now() + 3 * 3_600_000) }
    const seen: Array<[string, string]> = []
    const pool = {
      updateAccount: async () => {},
      findAccountIdByCredential: async (provider: string, identity: string) => {
        seen.push([provider, identity])
        return 'a1'
      },
    }
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(fresh) }),
      set: async () => {},
    }), { fetchImpl: (() => { throw new Error('不应发请求') }) as never })
    await auth.refreshAccountCredential('MINIMAX_ACCOUNT_A1', pool as never)
    expect(seen).toEqual([['minimax', fresh.access_token]])
  })

  it('⚠️ 不给账号池时退化为「直接续期 + 落盘到同一个 ref」', async () => {
    const written: Array<[string, string]> = []
    const auth = new MinimaxAuth(makeContext({
      resolve: async () => ({ value: JSON.stringify(CRED) }),
      set: async (ref, value) => { written.push([keyOf(ref), value]) },
    }), { fetchImpl: (async () => refreshOk()) as never })
    await auth.refreshAccountCredential('MINIMAX_ACCOUNT_A1')
    expect(written).toHaveLength(1)
    expect(written[0]?.[0]).toBe('MINIMAX_ACCOUNT_A1')
    expect(JSON.parse(String(written[0]?.[1])).access_token).toBe('n'.repeat(60))
  })
})

describe('persistLogin / fetchModels', () => {
  it('⚠️ 默认凭据 ref 由产品配置派生，persistLogin 只写调用方给的 refName', async () => {
    const written: string[] = []
    const auth = new MinimaxAuth(makeContext({
      set: async (ref) => { written.push(keyOf(ref)) },
    }), {})
    expect(auth.credentialRefName).toBe('MINIMAX_ACCESS_TOKEN')
    const result = await auth.persistLogin({ ...CRED }, { refName: 'MINIMAX_ACCOUNT_X1', nickname: 'X1' })
    expect(written).toEqual(['MINIMAX_ACCOUNT_X1'])
    // ⚠️ **2026-10-23（Gitee IKP8UA）口径变更**：`persistLogin` 现在回传
    // `nickname`（供 RPC 层写账号池）。显式传入的 nickname 原样回传 ——
    // 这**不是**行为回退：返回值多一个字段，而调用方读的是 `result.nickname`
    // （缺省时才走三级回退）。
    //
    // 原断言是 `toEqual({})`，那是在「返回值只有 `accountId`」时代写的；
    // 现在 `accountId` 对它仍是 undefined（token 非 JWT），故只有 `nickname`。
    expect(result).toEqual({ nickname: 'X1' })
  })

  it('⚠️ fetchModels 从 getAvailableAccount 的 credential 字段取凭据（两层结构，不是 available.id）', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({
      providers: [{ providerId: 'minimax', config: { models: { 'MiniMax-M3': { name: 'M3' } } } }],
    }))
    const pool = {
      getAvailableAccount: async () => ({
        entry: { id: 'acc-1', credentialRef: 'MINIMAX_ACCOUNT_1' },
        credential: { access_token: 'from-pool' },
      }),
    }
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never })
    const models = await auth.fetchModels(pool as never)
    expect(models.map((m) => m.id)).toEqual(['MiniMax-M3'])
    const headers = (fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer from-pool')
  })
})

describe('startLogin', () => {
  it('⚠️ 立即返回含 user_code 的 loginUrl，后台轮询（不阻塞等授权完成）', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({
        device_code: 'd'.repeat(43),
        user_code: '98FJ-WYXZ',
        verification_uri: 'https://account.minimax.cn/oauth-authorize',
        verification_uri_complete: 'https://account.minimax.cn/oauth-authorize?user_code=98FJ-WYXZ',
        expires_in: 300,
        interval: 3,
      }))
      .mockResolvedValueOnce(json({ status: 'denied' }))
    const auth = new MinimaxAuth(makeContext(), { fetchImpl: fetcher as never, sleep: async () => {} })
    const flow = await auth.startLogin()
    expect(flow.loginUrl).toBe('https://account.minimax.cn/oauth-authorize?user_code=98FJ-WYXZ')
    await expect(flow.result).rejects.toThrow('用户取消了 MiniMax 授权')
    flow.close()
  })
})
