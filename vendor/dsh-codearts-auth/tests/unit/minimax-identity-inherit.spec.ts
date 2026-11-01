/**
 * `minimax-identity-inherit.spec.ts` —— 续期**不得**丢掉身份字段（2026-10-24）。
 *
 * ## 这条守卫防的是什么
 *
 * `refreshMinimaxCredential` → `parseMinimaxTokenGrant` 只构造令牌五件套
 * （`access_token` / `refresh_token` / `token_type` / `expires_at` / `scope`），
 * **不认识** `nickname` / `user_id`。而续期结果会被 `ctx.credentials.set`
 * **整体覆盖**旧凭据 ⇒ 每续期一次丢一次：
 *
 * | 字段 | 丢失后果 |
 * |---|---|
 * | `nickname` | 账号卡片退回内部 id `minimax-xxxx`（IKP8UA 复发） |
 * | `user_id` | **同账号去重失去唯一判据** ⇒ 一个号可以无限建卡、各持一份 token |
 *
 * 续期由 **60s 巡检 + 请求前预判 + 401 强刷**驱动（远比 30 分钟一轮频繁）、
 * `SELF_HEAL_REFRESHABLE_PROVIDERS` 还会在积分查询前补一次 ⇒ 这个丢失**必然发生**，不是边角情况。
 *
 * 本机实测（2026-10-24）：`.credentials.yaml` 里三份 `MINIMAX_*` 凭据**零份**
 * 带 `user_id`、仅一份带 `nickname`。
 *
 * ## 判据为什么打在「落盘后的凭据内容」上
 *
 * 断言 `inheritMinimaxIdentity` 这个纯函数本身只是同义反复；真正的行为是
 * 「续期一次之后，凭据里身份还在」。故这里的核心用例**真跑**一次
 * `refreshAccountCredential`，再读回落盘值。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { inheritMinimaxIdentity } from '../../src/minimax.js'
import { MINIMAX } from '../../src/minimax-product.js'
import type { MinimaxCredential } from '../../src/minimax.js'

const here = dirname(fileURLToPath(import.meta.url))

/** 本地极简解析（避免 import `minimax-auth.ts` —— 它顶层依赖 cordis）。 */
function parseCred(raw: string): MinimaxCredential | undefined {
  try {
    const v = JSON.parse(raw) as MinimaxCredential
    return typeof v?.access_token === 'string' && v.access_token.length > 0 ? v : undefined
  } catch {
    return undefined
  }
}

/** 带完整身份的旧凭据（模拟「刚登录完」的落盘形态）。 */
const WITH_IDENTITY: MinimaxCredential = {
  access_token: 'mmoat_' + 'a'.repeat(54),
  refresh_token: 'mmort_' + 'b'.repeat(54),
  token_type: 'Bearer',
  expires_at: String(Date.now() + 3600_000),
  scope: 'agent.default',
  nickname: 'MiniMax523348',
  user_id: 'RZwmwvOBJEGE',
}

function refreshResponse(): Response {
  return new Response(JSON.stringify({
    access_token: 'mmoat_' + 'n'.repeat(54),
    refresh_token: 'mmort_' + 'r'.repeat(54),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'agent.default',
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 造真 Context + 可读写的内存凭据存储。 */
function makeContext(initial: MinimaxCredential): {
  ctx: Context
  read: () => string | undefined
} {
  const store = new Map<string, string>()
  store.set('MINIMAX_ACCOUNT_TEST', JSON.stringify(initial))
  const registry = new Map<string, unknown>()
  const ctx = new Context() as never as Context
  const credentials = {
    resolve: async (ref: unknown) => {
      const name = typeof ref === 'string' ? ref : String((ref as { name?: unknown })?.name ?? '')
      const value = store.get(name)
      return value === undefined ? undefined : { value }
    },
    set: async (ref: unknown, value: string) => {
      const name = typeof ref === 'string' ? ref : String((ref as { name?: unknown })?.name ?? '')
      store.set(name, value)
    },
  }
  registry.set('credentials', credentials)
  ;(ctx as unknown as { provide: (n: string, v: unknown) => void }).provide('credentials', credentials)
  ;(ctx as unknown as { provide: (n: string, v: unknown) => void }).provide('logger', {
    warn: () => {}, info: () => {}, debug: () => {},
  })
  return {
    ctx,
    read: () => store.get('MINIMAX_ACCOUNT_TEST'),
  }
}

describe('inheritMinimaxIdentity：纯函数判据', () => {
  it('新凭据已有的字段以新凭据为准（不被旧值覆盖）', () => {
    const merged = inheritMinimaxIdentity(
      { ...WITH_IDENTITY, access_token: 'new', nickname: '新名字' },
      WITH_IDENTITY,
    )
    expect(merged.nickname).toBe('新名字')
  })

  it('新凭据缺身份时从旧凭据继承（nickname + user_id 都要）', () => {
    const merged = inheritMinimaxIdentity(
      { access_token: 'new', refresh_token: 'nr', token_type: 'Bearer', scope: 'agent.default' },
      WITH_IDENTITY,
    )
    expect(merged.nickname).toBe('MiniMax523348')
    expect(merged.user_id).toBe('RZwmwvOBJEGE')
  })

  it('旧凭据也没有身份时不凭空造字段', () => {
    const merged = inheritMinimaxIdentity(
      { access_token: 'new' },
      { access_token: 'old' },
    )
    expect('nickname' in merged).toBe(false)
    expect('user_id' in merged).toBe(false)
  })
})

/**
 * ⚠️ 下面这格需要 `@deepseek-ai/cordis`（`MinimaxAuth extends Service`）。
 * 依赖不齐时**必须 SKIP 而不是 PASS**（仓库铁律：无依赖时 SKIP，不许让「没跑」冒充「通过」）。
 *
 * ⚠️⚠️ 探针必须是 `await import()`（2026-10-25 审计实测）：改前用的
 * `import.meta.resolve(...)` 在 Vite SSR 下**恒抛** `TypeError`
 *（`__vite_ssr_import_meta__.resolve is not a function`）⇒ 恒 `false` ⇒
 * 这两条**最承重**的行为用例**永久 SKIP**，而本机 cordis 其实是装着的、
 * 用例体自己的 `await import('@deepseek-ai/cordis')` 也一直能成功 ——
 * 探针与用例体用不同加载方式，就会得出「依赖不齐」的错误结论。
 */
const cordisAvailable = await (async (): Promise<boolean> => {
  try {
    await import('@deepseek-ai/cordis')
    return true
  } catch {
    return false
  }
})()

describe('★★ 真跑一次续期：落盘凭据里身份必须还在（行为判据）', () => {
  it.skipIf(!cordisAvailable)('★★ refreshAccountCredential 之后 nickname 与 user_id 都还在', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const store = new Map<string, string>()
    store.set('MINIMAX_ACCOUNT_TEST', JSON.stringify(WITH_IDENTITY))
    const credentials = {
      resolve: async (ref: unknown) => {
        const name = typeof ref === 'string' ? ref : String((ref as { name?: unknown })?.name ?? '')
        const value = store.get(name)
        return value === undefined ? undefined : { value }
      },
      set: async (ref: unknown, value: string) => {
        const name = typeof ref === 'string' ? ref : String((ref as { name?: unknown })?.name ?? '')
        store.set(name, value)
      },
    }
    const ctx = new Context() as never as Record<string, unknown>
    ;(ctx as { provide: (n: string, v: unknown) => void }).provide('credentials', credentials)
    ;(ctx as { provide: (n: string, v: unknown) => void }).provide('logger', {
      warn: () => {}, info: () => {}, debug: () => {},
    })

    const { MinimaxAuth } = await import('../../src/minimax-auth.js')
    const auth = new MinimaxAuth(ctx as never, {
      fetchImpl: (async () => refreshResponse()) as unknown as typeof fetch,
      sleep: async () => {},
    })
    await auth.refreshAccountCredential('MINIMAX_ACCOUNT_TEST')

    const raw = store.get('MINIMAX_ACCOUNT_TEST')
    const after = parseCred(raw as string)
    expect(after, '续期后的凭据必须仍能解析').toBeDefined()
    expect(after?.access_token, '令牌必须是新的（否则本用例可能压根没续期）')
      .not.toBe(WITH_IDENTITY.access_token)
    expect(after?.nickname, '★ nickname 丢了 ⇒ 账号卡片退回内部 id（IKP8UA 复发）')
      .toBe('MiniMax523348')
    expect(after?.user_id, '★★ user_id 丢了 ⇒ 同账号去重失去唯一判据')
      .toBe('RZwmwvOBJEGE')
  })

  it('分支前提自检：续期响应本身**不含**身份字段（否则上面那格恒真、无牙）', async () => {
    const body = await refreshResponse().json() as Record<string, unknown>
    expect(
      'nickname' in body || 'user_id' in body,
      '⚠️ 若上游将来在续期响应里回身份字段，本组用例会变成恒真 —— 届时判据要改',
    ).toBe(false)
  })

  it('产品配置自检：测试用的 provider 是 minimax 而非国际版（ref 前缀别串）', () => {
    expect(MINIMAX.id).toBe('minimax')
  })

  /**
   * ★★ **不依赖 cordis 的接线断言**（上面那格 skip 时的**唯一**守卫）。
   *
   * ## 为什么必须有它（变异实测）
   *
   * 把 `refreshCredentialFor` 里的 `return inheritMinimaxIdentity(...)` 改成
   * `return refreshed`（= 本缺陷原样复发）后跑本文件：**全绿** ——
   * 因为行为格在没装 cordis 的环境里被 `skipIf` 跳过了。
   * 「skip 掉的用例」与「通过的用例」在报告里都是绿的 ⇒ 缺陷逃逸。
   *
   * ⇒ 补一条**纯源码**断言，它在任何环境都能跑。
   * ⚠️ 但它只是替代品，不是等价物：真正的行为判据仍是上面那格（完整安装时生效）。
   */
  it('★★ 续期出口必须调用 inheritMinimaxIdentity（缺 cordis 时的唯一守卫）', () => {
    const src = readFileSync(resolve(here, '../../src/minimax-auth.ts'), 'utf8')
    /** 取某个方法的方法体（到下一个 `\n  /**` 或 8KB 封顶，避免被别处同名字样满足）。 */
    const bodyOf = (signature: string): string => {
      const start = src.indexOf(signature)
      expect(start, `minimax-auth.ts 找不到 ${signature}（改名/搬走了？）`).toBeGreaterThan(-1)
      const end = src.indexOf('\n  /**', start + signature.length)
      return src.slice(start, end > start ? end : start + 8000)
    }

    // ⚠️ 2026-10-27 rebase 适配：本地重构把「继承」收口到**唯一的 grant 出口**
    //    `grantOnce`，中间多了一层抢救（`grantWithSalvage`：非终态重试 + 旧 RT
    //    回退）。判据随之**沿链**走 —— 钉住的东西没变：把
    //    `return inheritMinimaxIdentity(refreshed, credential)` 改回
    //    `return refreshed`，本用例仍精确变红。
    const grant = bodyOf('private async grantOnce(')
    expect(
      grant,
      '★★ 续期没有继承身份字段 ⇒ 每续期一次就丢 nickname/user_id'
      + '（去重失效 + 卡片退回内部 id），且巡检/请求路径都会续期 ⇒ 必然复发',
    ).toContain('inheritMinimaxIdentity(')
    expect(grant, '★ 继承必须作用在**新**凭据与**旧**凭据之间').toMatch(
      /inheritMinimaxIdentity\(\s*refreshed\s*,\s*credential\s*\)/,
    )

    // ★ 链路自证：这两跳任一被删，「继承」就永远到不了续期路径，而上面两条
    //   （只看 `grantOnce` 本体）**仍然全绿** ⇒ 必须逐跳钉住。
    expect(bodyOf('async refreshCredentialFor('), '★ refreshCredentialFor 必须走抢救链')
      .toMatch(/return this\.grantWithSalvage\(/)
    expect(bodyOf('private async grantWithSalvage('), '★ 抢救链必须落到唯一 grant 出口')
      .toContain('this.grantOnce(')
  })
})

/**
 * ★★ **第 5 条续期路径**：`refresh()`（无参、单凭据兜底）。
 *
 * ## 为什么必须单独钉住（2026-10-25 合并审计）
 *
 * PR !147 的说明写的是「收口在**唯一**出口 `refreshCredentialFor`」，但
 * `src/index.ts` 的 `getAvailableAccount()` 返回空时走的是 `minimax.refresh()`
 * —— 而「返回空」恰好是**同账号去重把两张卡都停用**之后的形态。该路径此前直接
 * `set(refreshMinimaxCredential(...))`，实测续期后落盘只剩令牌五件套
 * （`nickname` / `user_id` 双双消失）⇒ IKP8UA 复发 + 去重失去判据，
 * 且巡检/请求路径都会续期 ⇒ 必然复现。
 *
 * ⚠️ 判据必须看**落盘内容**（不是看函数有没有调用继承）：只断言「调了」的写法
 * 在「调了但没用返回值」时仍然绿。
 */
describe('★★ refresh()：单凭据兜底路径也必须继承身份', () => {
  it.skipIf(!cordisAvailable)('★★ refresh() 之后 nickname 与 user_id 都还在（落盘判据）', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const store = new Map<string, string>()
    store.set(MINIMAX.defaultCredentialRef, JSON.stringify(WITH_IDENTITY))
    const ctx = new Context() as never as Record<string, unknown>
    ;(ctx as { provide: (n: string, v: unknown) => void }).provide('credentials', {
      resolve: async (ref: unknown) => {
        const name = typeof ref === 'string' ? ref : String((ref as { name?: unknown })?.name ?? '')
        const value = store.get(name)
        return value === undefined ? undefined : { value }
      },
      set: async (ref: unknown, value: string) => {
        const name = typeof ref === 'string' ? ref : String((ref as { name?: unknown })?.name ?? '')
        store.set(name, value)
      },
    })
    ;(ctx as { provide: (n: string, v: unknown) => void }).provide('logger', {
      warn: () => {}, info: () => {}, debug: () => {},
    })

    const { MinimaxAuth } = await import('../../src/minimax-auth.js')
    const auth = new MinimaxAuth(ctx as never, {
      fetchImpl: (async () => refreshResponse()) as unknown as typeof fetch,
      sleep: async () => {},
    })
    await auth.refresh()

    const after = parseCred(store.get(MINIMAX.defaultCredentialRef) as string)
    expect(after, '续期后的凭据必须仍能解析').toBeDefined()
    expect(after?.access_token, '令牌必须是新的（否则本用例压根没续期）')
      .not.toBe(WITH_IDENTITY.access_token)
    expect(after?.nickname, '★ refresh() 路径丢了 nickname ⇒ 账号卡片退回内部 id')
      .toBe('MiniMax523348')
    expect(after?.user_id, '★★ refresh() 路径丢了 user_id ⇒ 同账号去重失去唯一判据')
      .toBe('RZwmwvOBJEGE')
  })
})

/**
 * ★★ **存量账号的 `user_id` 自愈**（2026-10-25 合并审计打穿）。
 *
 * ## 缺陷
 *
 * `user_id` 全仓只有 `persistLogin` 一处写入（只写**新**账号）。而 PR 之前登录的
 * 存量凭据**没有** `user_id`（本机三份 `MINIMAX_ACCOUNT_*` 实测零份带它）⇒
 * `findAccountIdByIdentityField` 对缺失字段是**跳过**（不是「不匹配」）⇒
 * 同账号去重对存量用户**永不触发**，一个号照旧可无限建卡。
 *
 * 唯一能给存量账号补身份的地方是启动自愈 `repairAccountNicknames` —— 它本来
 * 就已经把 `identity.userId` 拿到手，却只写了 `nickname`（`identity.userId` 被丢弃）。
 *
 * ## 判据
 *
 * 真跑一次 `repairAccountNicknames`，断言**落盘凭据里出现 `user_id`**。
 * ⚠️ 不能只断言「调用了某个函数」：这条缺陷的形态正是「数据拿到了但没写下去」。
 */
describe('★★ 存量账号自愈：repairAccountNicknames 必须把 user_id 写进凭据', () => {
  it.skipIf(!cordisAvailable)('★★ 凭据里原本没有 user_id ⇒ 修完后必须有', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const store = new Map<string, string>()
    // 存量形态：有 nickname、**没有** user_id。
    store.set('MINIMAX_ACCOUNT_OLD', JSON.stringify({
      access_token: 'mmoat_' + 'o'.repeat(54),
      refresh_token: 'mmort_' + 'r'.repeat(54),
      token_type: 'Bearer',
      expires_at: String(Date.now() + 3_600_000),
      scope: 'agent.default',
      nickname: 'MiniMax523348',
    }))
    const ctx = new Context() as never as Record<string, unknown>
    const provide = (ctx as { provide: (n: string, v: unknown) => void }).provide.bind(ctx)
    provide('credentials', {
      resolve: async (ref: unknown) => {
        const name = typeof ref === 'string' ? ref : String((ref as { name?: unknown })?.name ?? '')
        const value = store.get(name)
        return value === undefined ? undefined : { value }
      },
      set: async (ref: unknown, value: string) => {
        const name = typeof ref === 'string' ? ref : String((ref as { name?: unknown })?.name ?? '')
        store.set(name, value)
      },
    })
    provide('logger', { warn: () => {}, info: () => {}, debug: () => {} })

    const { MinimaxAuth } = await import('../../src/minimax-auth.js')
    const identity = {
      name: 'MiniMax523348',
      userId: 'RZwmwvOBJEGE',
    }
    const auth = new MinimaxAuth(ctx as never, {
      // 身份端点回真实形态（`data.userInfo.userID`），**不发真实网络**。
      fetchImpl: (async () => new Response(JSON.stringify({
        data: { userInfo: { name: identity.name, userID: identity.userId } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
      sleep: async () => {},
    })

    const pool = {
      listAccounts: async () => [{
        id: 'minimax-old',
        provider: 'minimax',
        credentialRef: 'MINIMAX_ACCOUNT_OLD',
        nickname: 'MiniMax523348',
        enabled: true,
        refreshable: true,
      }],
      updateAccount: async () => {},
    }
    await auth.repairAccountNicknames(pool as never)

    const after = parseCred(store.get('MINIMAX_ACCOUNT_OLD') as string)
    expect(after?.user_id, '★★ 存量凭据仍没有 user_id ⇒ 同账号去重对它永不触发（PR 的前提场景没被覆盖）')
      .toBe('RZwmwvOBJEGE')
    expect(after?.nickname).toBe('MiniMax523348')
    expect(after?.access_token, '自愈只补身份，绝不能动令牌').toBeTruthy()
  })
})
