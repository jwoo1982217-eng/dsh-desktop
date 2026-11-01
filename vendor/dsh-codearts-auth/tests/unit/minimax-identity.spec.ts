/**
 * ★★ **MiniMax 账号身份读取**（Gitee issue IKP8UA）。
 *
 * ## 缺陷
 *
 * `minimax` / `minimaxintl` 登录后账号卡片只显示插件生成的内部 id
 * （`minimax-6395cf64`、`MiniMax 国际版 minimaxintl-7c2a157d`），多账号时
 * **完全无法分辨哪个是哪个号**。
 *
 * 根因两层叠加：
 * ① 登录响应体只有 5 个字段（`access_token` / `expires_in` / `refresh_token` /
 *    `scope` / `token_type`），**无任何身份信息**；
 * ② 昵称判据依赖「解 JWT 取 sub」，而 MiniMax 的 `access_token` **不是 JWT**
 *    （`mmoat_` 前缀、60 字符、**0 个点**）⇒ `decodeJwtSub` 恒 undefined
 *    ⇒ 昵称恒退化为内部 id。
 *
 * ## 真机实测（2026-10-23，本机两站真实凭据）
 *
 * `GET {apiHost}/v1/api/user/info?device_platform=web&biz_id=3` + 仅 Bearer：
 *
 * | 站点 | 结果 |
 * |---|---|
 * | 国内站 `agent.minimax.cn` | 200、`statusInfo.code=0`、`name="MiniMax909127"` |
 * | 国际站 `agent.minimax.io` | 200、`code=0`、`name="8fsmz"`（**必须带海外 XFF**） |
 *
 * ## ⚠️⚠️ 两站的「参数缺失」失败形态**完全不同**（本文件的核心判据来源）
 *
 * | 情形 | 国内站 | 国际站 |
 * |---|---|---|
 * | 缺 `biz_id=3` | 200、`code=1200019`、`userInfo` **整块缺失** | 200、**`code=0`**、但 `name=""`、`userID` 变成**另一个值**、`realUserID="0"` |
 * | 缺 `device_platform=web` | 400、`code=2` | 400、`code=2` |
 *
 * ⇒ **判据不能只看 `statusInfo` 无错码**：国际站缺 `biz_id` 时 `code` 就是 `0`，
 *   只看它会把「空名字 + 错 userID」当成功。判据必须落在 **`name` 非空**上。
 *
 * ## ⚠️⚠️ 国际站必须带 `X-Forwarded-For`（本文件第二组用例守它）
 *
 * `agent.minimax.io` 对**所有**路径按来源 IP 国别返 `307 → agent.minimaxi.com`：
 * 大陆出口**恒 307**，而跨 origin 跟随会**剥掉 `Authorization`** ⇒ 第二跳无凭据
 * ⇒ **401**。实测（2026-10-23）：
 *
 * ```
 * 仅 Bearer            → 307 → agent.minimaxi.com → 401
 * XFF=114.114.114.114  → 307 → 同上 → 401      ← 中国 IP 照样被踢
 * XFF=8.8.8.8          → 200（不重定向）name="8fsmz"      ✅
 * XFF=1.1.1.1          → 200（不重定向）name="8fsmz"      ✅
 * ```
 *
 * ⇒ 必须走 `minimaxFetch`（它保凭据跟随 + 传输级重试），且头必须经
 *   `minimaxHeadersFor`（国际站才附 XFF）。
 */
import { describe, expect, it, vi } from 'vitest'
import { fetchMinimaxUserIdentity, MINIMAX_USERINFO_PATH } from '../../src/minimax-identity.js'
import { MINIMAX, MINIMAX_INTL } from '../../src/minimax-product.js'
import type { MinimaxCredential } from '../../src/minimax-product.js'

const CRED: MinimaxCredential = {
  access_token: 'mmoat_test_token',
  refresh_token: 'mmort_test',
  token_type: 'Bearer',
  scope: 'agent.default',
} as MinimaxCredential

/** 造一个 200 + JSON 的响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 国内站的**正确**响应（真机形态）。 */
const CN_OK = {
  statusInfo: { code: 0, httpCode: 0, message: '成功' },
  data: { userInfo: { name: 'MiniMax909127', userID: 'ZDxY6oEjmoaX', realUserID: '560979762519912454', subUserName: 'MiniMax909127' } },
}

/** 国际站的**正确**响应（真机形态）。 */
const INTL_OK = {
  statusInfo: { code: 0, httpCode: 0, message: 'Success' },
  data: { userInfo: { name: '8fsmz', userID: 'AbBjbOpomqmm', realUserID: '567709184945057792', subUserName: '' } },
}

/** 国际站**缺 `biz_id`** 的响应：`code` 仍是 0，但 name 空、userID 是另一个值。 */
const INTL_MISSING_BIZ = {
  statusInfo: { code: 0, httpCode: 0, message: 'Success' },
  data: { userInfo: { name: '', userID: 'KkrRQ1Jw', realUserID: '0', subUserName: '' } },
}

/** 国内站**缺 `biz_id`** 的响应：错误码 + userInfo 整块缺失。 */
const CN_MISSING_BIZ = {
  statusInfo: { code: 1200019, httpCode: 0, message: '服务端开小差了，请稍后再试' },
}

describe('★★ MiniMax 账号身份读取（issue IKP8UA）', () => {
  it('★★ 国内站：取到 name（真机形态）', async () => {
    const fetcher = vi.fn(async () => jsonResponse(CN_OK))
    const identity = await fetchMinimaxUserIdentity(CRED, fetcher as never, MINIMAX)
    expect(identity?.name, '国内站必须取到账号名').toBe('MiniMax909127')
  })

  it('★★ 国际站：取到 name（真机形态）', async () => {
    const fetcher = vi.fn(async () => jsonResponse(INTL_OK))
    const identity = await fetchMinimaxUserIdentity(CRED, fetcher as never, MINIMAX_INTL)
    expect(identity?.name, '国际站必须取到账号名').toBe('8fsmz')
  })

  /**
   * ★★ **本文件最重要的一条**：国际站缺 `biz_id` 时 `code=0` 却数据是错的。
   *
   * 判据若只看 `statusInfo` 无错码 ⇒ 会把 `name=""` 当好数据放行 ⇒ 用户看到
   * 一个**空账号名**（比内部 id 更糟）。
   */
  it('★★ 国际站缺 biz_id（code=0 但 name 空）⇒ 必须判为取不到，不得返回空名', async () => {
    const fetcher = vi.fn(async () => jsonResponse(INTL_MISSING_BIZ))
    const identity = await fetchMinimaxUserIdentity(CRED, fetcher as never, MINIMAX_INTL)
    expect(
      identity,
      '★★ 空 name 被当成有效身份 ⇒ 账号卡片会显示空白（比内部 id 更糟）',
    ).toBeUndefined()
  })

  it('★★ 国内站缺 biz_id（错误码 + userInfo 整块缺失）⇒ 取不到', async () => {
    const fetcher = vi.fn(async () => jsonResponse(CN_MISSING_BIZ))
    const identity = await fetchMinimaxUserIdentity(CRED, fetcher as never, MINIMAX)
    expect(identity, '错误码响应不得被当成有效身份').toBeUndefined()
  })

  it('★ 401（国际站无 XFF 被 307 到中国站后）⇒ 取不到，且不抛错', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 401 }))
    await expect(
      fetchMinimaxUserIdentity(CRED, fetcher as never, MINIMAX_INTL),
    ).resolves.toBeUndefined()
  })

  it('★ 网络抛错 ⇒ 取不到，且不抛错（昵称是展示信息，不得阻塞登录）', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNRESET') })
    await expect(
      fetchMinimaxUserIdentity(CRED, fetcher as never, MINIMAX),
    ).resolves.toBeUndefined()
  })

  it('★ 非 JSON 响应 ⇒ 取不到（不得抛错）', async () => {
    const fetcher = vi.fn(async () => new Response('<html>502</html>', { status: 200 }))
    await expect(
      fetchMinimaxUserIdentity(CRED, fetcher as never, MINIMAX),
    ).resolves.toBeUndefined()
  })

  /**
   * ★★ **两个必需 query 参数必须都发出**（真机实测：缺任一都会失败）。
   */
  it('★★ 请求 URL 必须同时带 device_platform=web 与 biz_id=3', async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (url: string) => { calls.push(String(url)); return jsonResponse(CN_OK) })
    await fetchMinimaxUserIdentity(CRED, fetcher as never, MINIMAX)
    expect(calls[0], '端点路径不对').toContain(MINIMAX_USERINFO_PATH)
    expect(calls[0], '缺 device_platform ⇒ 400 code=2').toContain('device_platform=web')
    expect(calls[0], '缺 biz_id ⇒ 200 但数据错').toContain('biz_id=3')
  })

  /**
   * ★★ **只对国际站附 XFF**（给国内站附 = 伪造来源，纯增风险）。
   */
  it('★★ 国际站带 XFF 时必须附上该头', async () => {
    const seen: Array<Record<string, string>> = []
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init.headers as never).entries()))
      return jsonResponse(INTL_OK)
    })
    await fetchMinimaxUserIdentity(CRED, fetcher as never, MINIMAX_INTL, '8.8.8.8')
    expect(
      seen[0]?.['x-forwarded-for'] ?? seen[0]?.['X-Forwarded-For'],
      '★★ 国际站漏 XFF ⇒ 恒 307 到中国站 ⇒ 401（真机实测）',
    ).toBe('8.8.8.8')
  })

  it('★ 国内站即使传了 XFF 也不得附该头', async () => {
    const seen: Array<Record<string, string>> = []
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init.headers as never).entries()))
      return jsonResponse(CN_OK)
    })
    await fetchMinimaxUserIdentity(CRED, fetcher as never, MINIMAX, '8.8.8.8')
    const hasXff = Object.keys(seen[0] ?? {}).some((k) => k.toLowerCase() === 'x-forwarded-for')
    expect(hasXff, '★ 给国内站附 XFF 是伪造来源（且无用）').toBe(false)
  })

  it('★ 响应里的 userID 也一并返回（供排障，非展示名）', async () => {
    const fetcher = vi.fn(async () => jsonResponse(CN_OK))
    const identity = await fetchMinimaxUserIdentity(CRED, fetcher as never, MINIMAX)
    expect(identity?.userId).toBe('ZDxY6oEjmoaX')
  })
})
/**
 * ★★ **登录回填**：`persistLogin` 必须把读到的身份写进凭据与昵称（issue 修法 ②）。
 *
 * ## 为什么放在 `persistLogin` 内部而不是 RPC 层
 *
 * RPC 层已经有 7 处 `pool.updateAccount({ nickname })`，而**自愈**路径
 * （`repairAccountNicknames`，修法 ③）也走凭据 —— 若身份查询只写在 RPC 分支里，
 * 自愈就得再写一份（「同一语义两套判据」）。⇒ 收口在凭据落盘这一处，
 * 两条路径共用。
 *
 * ## 判据
 *
 * - 查到了 ⇒ 凭据里带 `nickname`、返回值带 `nickname`（供 RPC 写池）；
 * - **查不到 ⇒ 一律不影响登录**（返回值不带 `nickname`，凭据照常落盘）。
 */
describe('★★ MinimaxAuth.persistLogin 回填身份（登录路径）', () => {
  /**
   * 造一个**真实 cordis Context**（照 `tests/unit/minimax-auth.spec.ts` 的
   * `makeContext` 同法）。
   *
   * ⚠️ 不能用裸对象当 ctx：cordis 的 `Service` 构造函数会执行
   * `ctx.reflect.provide(...)`，裸对象直接抛
   * `TypeError: Cannot read properties of undefined (reading 'provide')`。
   */
  async function makeAuth(options: {
    identityResponse?: unknown
    identityThrows?: boolean
    product?: typeof MINIMAX
    xff?: string
  } = {}) {
    const { Context } = await import('@deepseek-ai/cordis')
    const { MinimaxAuth } = await import('../../src/minimax-auth.js')
    const written: Array<{ ref: string; value: string }> = []
    const ctx = new Context() as never as {
      provide: (name: string, value: unknown) => void
    }
    ctx.provide('credentials', {
      set: async (ref: unknown, value: string) => { written.push({ ref: String(ref), value }) },
      resolve: async () => undefined,
      describe: async () => ({ configured: false, writable: true }),
    })
    ctx.provide('accountPool', { minimaxXff: () => options.xff } as never)
    const auth = new (MinimaxAuth as never as new (c: unknown, o: unknown) => {
      persistLogin: (c: unknown, o: { refName: string; nickname?: string }) => Promise<{ nickname?: string }>
    })(ctx, {
      product: options.product ?? MINIMAX,
      fetchImpl: options.identityThrows === true
        ? async () => { throw new Error('boom') }
        : async () => jsonResponse(options.identityResponse ?? CN_OK),
    })
    return { auth, written }
  }

  it('★★ 查到身份 ⇒ 返回值带 nickname，且写进凭据', async () => {
    const { auth, written } = await makeAuth()
    const result = await auth.persistLogin(CRED, { refName: 'MINIMAX_ACCOUNT_X' })
    expect(result.nickname, '★★ 查到了却没回填 ⇒ 账号卡片仍显示内部 id').toBe('MiniMax909127')
    const payload = JSON.parse(written[0]!.value) as { nickname?: string }
    expect(payload.nickname, '凭据里也要写（自愈路径读它）').toBe('MiniMax909127')
  })

  it('★ 查不到 ⇒ 不带 nickname，但凭据照常落盘（不得阻塞登录）', async () => {
    const { auth, written } = await makeAuth({ identityResponse: { statusInfo: { code: 1200019 } } })
    const result = await auth.persistLogin(CRED, { refName: 'MINIMAX_ACCOUNT_X' })
    expect(result.nickname, '查不到时不得编造昵称').toBeUndefined()
    expect(written.length, '★ 身份查询失败不得影响凭据落盘').toBe(1)
  })

  it('★ 身份查询抛错 ⇒ 登录仍成功（凭据照常落盘）', async () => {
    const { auth, written } = await makeAuth({ identityThrows: true })
    const result = await auth.persistLogin(CRED, { refName: 'MINIMAX_ACCOUNT_X' })
    expect(result.nickname).toBeUndefined()
    expect(written.length, '★ 身份查询抛错不得让登录失败').toBe(1)
  })

  it('★ 调用方显式给 nickname 时以调用方为准（不覆盖）', async () => {
    const { auth } = await makeAuth()
    const result = await auth.persistLogin(CRED, { refName: 'MINIMAX_ACCOUNT_X', nickname: '用户自定义' })
    expect(result.nickname, '显式传入的昵称优先').toBe('用户自定义')
  })

  it('★★ 国际站：身份查询必须带上池里的 XFF（否则恒 307 → 401）', async () => {
    const seen: Array<Record<string, string>> = []
    const { Context } = await import('@deepseek-ai/cordis')
    const { MinimaxAuth } = await import('../../src/minimax-auth.js')
    const ctx = new Context() as never as { provide: (n: string, v: unknown) => void }
    ctx.provide('credentials', {
      set: async () => {}, resolve: async () => undefined,
      describe: async () => ({ configured: false, writable: true }),
    })
    ctx.provide('accountPool', { minimaxXff: () => '8.8.8.8' } as never)
    const auth = new (MinimaxAuth as never as new (c: unknown, o: unknown) => {
      persistLogin: (c: unknown, o: { refName: string }) => Promise<{ nickname?: string }>
    })(ctx, {
      product: MINIMAX_INTL,
      fetchImpl: async (_url: string, init: RequestInit) => {
        seen.push(Object.fromEntries(new Headers(init.headers as never).entries()))
        return jsonResponse(INTL_OK)
      },
    })
    const result = await auth.persistLogin(CRED, { refName: 'MINIMAXINTL_ACCOUNT_X' })
    expect(
      seen[0]?.['x-forwarded-for'],
      '★★ 国际站漏池里的 XFF ⇒ 身份查询恒 401 ⇒ 昵称永远拿不到',
    ).toBe('8.8.8.8')
    expect(result.nickname).toBe('8fsmz')
  })
})

/**
 * ★★ **启动自愈**（issue 修法 ③）：存量账号的昵称必须能被修正。
 *
 * ## 为什么这条不可省
 *
 * 只改登录路径**只影响新登录的账号**。用户已有的账号（本机实测 7 条）昵称
 * 早已是插件内部 id 且已落盘 —— 不给这条腿，用户必须**删号重登**才看得到真名。
 *
 * ## 判据
 *
 * - 有真名可查 ⇒ 写进池（且**只在变化时**写，防每次启动落盘）；
 * - 查不到 ⇒ **保持原样**（绝不退回用池 id 重算 —— 那正是本 issue 的缺陷）；
 * - 单账号失败 ⇒ 不中断其余。
 */
describe('★★ MinimaxAuth.repairAccountNicknames（存量自愈）', () => {
  async function makeAuthWith(options: {
    accounts: Array<{ id: string; credentialRef: string; nickname: string }>
    identityOf?: (token: string) => unknown
    product?: typeof MINIMAX
    xff?: string
  }) {
    const { Context } = await import('@deepseek-ai/cordis')
    const { MinimaxAuth } = await import('../../src/minimax-auth.js')
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
    const ctx = new Context() as never as { provide: (n: string, v: unknown) => void }
    // 凭据按 ref 区分，用 ref 里的字节造不同 token，便于分辨是哪个账号。
    ctx.provide('credentials', {
      resolve: async (ref: unknown) => {
        const name = String((ref as { id?: string })?.id ?? ref)
        return { value: JSON.stringify({ access_token: `token-${name}`, refresh_token: 'r', token_type: 'Bearer' }) }
      },
      set: async () => {},
      describe: async () => ({ configured: true, writable: true }),
    })
    ctx.provide('accountPool', { minimaxXff: () => options.xff } as never)
    const auth = new (MinimaxAuth as never as new (c: unknown, o: unknown) => {
      repairAccountNicknames: (pool: unknown) => Promise<string[]>
    })(ctx, {
      product: options.product ?? MINIMAX,
      fetchImpl: async (_url: string, init: RequestInit) => {
        const auth = new Headers(init.headers as never).get('authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        return jsonResponse((options.identityOf ?? (() => CN_OK))(token))
      },
    })
    const pool = {
      listAccounts: async () => options.accounts,
      updateAccount: async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }) },
    }
    return { auth, pool, updates }
  }

  it('★★ 存量账号（昵称为内部 id）⇒ 自愈成真名', async () => {
    const { auth, pool, updates } = await makeAuthWith({
      accounts: [{ id: 'minimax-5aac2759', credentialRef: 'MINIMAX_ACCOUNT_A', nickname: 'minimax-5aac2759' }],
    })
    const repaired = await auth.repairAccountNicknames(pool)
    expect(repaired, '存量账号必须被修复').toEqual(['minimax-5aac2759'])
    expect(updates[0]?.patch.nickname, '昵称必须改成真名').toBe('MiniMax909127')
  })

  it('★ 昵称已是真名 ⇒ 不重复写池（防每次启动平白落盘）', async () => {
    const { auth, pool, updates } = await makeAuthWith({
      accounts: [{ id: 'minimax-1', credentialRef: 'MINIMAX_ACCOUNT_A', nickname: 'MiniMax909127' }],
    })
    const repaired = await auth.repairAccountNicknames(pool)
    expect(repaired, '没变化就不该报「已修复」').toEqual([])
    expect(updates.length, '★ 没变化还写池 ⇒ 每次启动都落盘一次').toBe(0)
  })

  it('★★ 查不到身份 ⇒ 保持原样（绝不退回用池 id 重算）', async () => {
    const { auth, pool, updates } = await makeAuthWith({
      accounts: [{ id: 'minimax-1', credentialRef: 'MINIMAX_ACCOUNT_A', nickname: 'minimax-1' }],
      identityOf: () => ({ statusInfo: { code: 1200019 } }),
    })
    const repaired = await auth.repairAccountNicknames(pool)
    expect(repaired).toEqual([])
    expect(updates.length, '★★ 查不到时不得改动昵称').toBe(0)
  })

  it('★ 单账号抛错不得中断其余账号', async () => {
    let call = 0
    const { auth, pool, updates } = await makeAuthWith({
      accounts: [
        { id: 'minimax-a', credentialRef: 'MINIMAX_ACCOUNT_A', nickname: 'minimax-a' },
        { id: 'minimax-b', credentialRef: 'MINIMAX_ACCOUNT_B', nickname: 'minimax-b' },
      ],
      identityOf: () => {
        call += 1
        // 第一个账号失败，第二个成功。
        if (call === 1) throw new Error('boom')
        return CN_OK
      },
    })
    const repaired = await auth.repairAccountNicknames(pool)
    expect(repaired, '★ 第一个失败，第二个仍必须被修复').toEqual(['minimax-b'])
    expect(updates[0]?.id).toBe('minimax-b')
  })

  it('★★ 国际站自愈必须带池里的 XFF（否则恒 307 → 401，自愈永远失败）', async () => {
    const seen: string[] = []
    const { Context } = await import('@deepseek-ai/cordis')
    const { MinimaxAuth } = await import('../../src/minimax-auth.js')
    const ctx = new Context() as never as { provide: (n: string, v: unknown) => void }
    ctx.provide('credentials', {
      resolve: async () => ({ value: JSON.stringify({ access_token: 'tk', refresh_token: 'r', token_type: 'Bearer' }) }),
      set: async () => {}, describe: async () => ({ configured: true, writable: true }),
    })
    ctx.provide('accountPool', { minimaxXff: () => '8.8.8.8' } as never)
    const auth = new (MinimaxAuth as never as new (c: unknown, o: unknown) => {
      repairAccountNicknames: (p: unknown) => Promise<string[]>
    })(ctx, {
      product: MINIMAX_INTL,
      fetchImpl: async (_url: string, init: RequestInit) => {
        seen.push(new Headers(init.headers as never).get('x-forwarded-for') ?? '(无)')
        return jsonResponse(INTL_OK)
      },
    })
    await auth.repairAccountNicknames({
      listAccounts: async () => [{ id: 'minimaxintl-1', credentialRef: 'MINIMAXINTL_ACCOUNT_A', nickname: 'minimaxintl-1' }],
      updateAccount: async () => {},
    })
    expect(seen[0], '★★ 国际站自愈漏 XFF ⇒ 恒 401 ⇒ 昵称永远修不好').toBe('8.8.8.8')
  })
})
