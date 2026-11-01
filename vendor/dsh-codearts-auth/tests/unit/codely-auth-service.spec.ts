/**
 * `CodelyAuth`（续期服务）的契约与行为守卫。
 *
 * ## 为什么必须有这份文件（2026-10-22 对抗审计 A5，P1）
 *
 * 审计当时 `CodelyAuth` 是**全仓零实例化**的死代码（`grep "new CodelyAuth"` 零命中），
 * 而 `provider-registry.ts` / `jet-hub-rpc.ts` 的接线清单却逐字写着
 * 「续期实现**已就绪**，推理与目录都不依赖它」。实测它有**两处**必然失败：
 *
 * 1. **编译期 TS2322**：`refreshAll(pool, refreshOne)` 是 2 参，而契约
 *    `JetHubAuthLike.refreshAll(pool)` 是 1 参 ⇒ 下一个人照文档接线时
 *    第一步就是编译红；
 * 2. **运行期 TypeError**：`index.ts` 的注册循环**提供不了** `refreshOne`
 *    ⇒ 按 `refreshAll: (pool) => auth.refreshAll(pool)` 包装调用必抛
 *    `refreshOne is not a function`，而它被外层逐 provider 的 `try` 吞成
 *    一条 warn ⇒ **续期恒不发生且日志几乎零字**（officeace 那条
 *    「把同步池当 Promise」完全同型）。
 *
 * ## 两条判据的性质不同，都要有
 *
 * - **契约判据**（`satisfies JetHubAuthLike`）：编译期就挡住签名漂移；
 * - **行为判据**（真跑 `refreshAll`）：挡住「签名对了但内部逻辑不做事」——
 *   本仓库记过多次「只断言不抛错 ⇒ 读了池但不续期仍全绿」。
 */

import { describe, expect, it, vi } from 'vitest'

import { Context } from '@deepseek-ai/cordis'

import { CodelyAuth, refreshCodelyCredential } from '../../src/codely-auth-service.js'
import type { JetHubAuthLike } from '../../src/jet-hub-rpc.js'
import type { CodelyCredential } from '../../src/codely-auth.js'

/**
 * ★ **契约判据**：`CodelyAuth` 必须能当 `JetHubAuthLike` 用。
 *
 * ⚠️ 这一句是**编译期**判据 —— 修复前它会直接 TS2322（`Expected 2 or more
 * arguments, but got 1`）。`tsc -p tsconfig.tests.json` 会跑到这里
 * （`pretest` 就是它）。
 *
 * ⚠️ 别把它改成 `as unknown as` 之类的断言：那就把判据变成恒真了，
 * 而本文件存在的**唯一理由**就是挡这条签名漂移。
 */
const contractCheck: JetHubAuthLike = new CodelyAuth(new Context(), {})

/** 假凭据库：记录写回，供行为判据断言。 */
function makeCredentialStore(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial))
  const writes: Array<{ ref: string; value: string }> = []
  return {
    store: {
      resolve: async (ref: string) => {
        const value = values.get(ref)
        return value === undefined ? undefined : { value }
      },
      set: async (ref: string, value: string) => {
        values.set(ref, value)
        writes.push({ ref, value })
      },
    },
    writes,
    values,
  }
}

/** 造一份 Codely 凭据（JWT 的 exp 用 base64url 编出来，`expiryMsOf` 才解得出）。 */
function makeCredential(token = 'OLD-ACCESS', refreshToken = 'REFRESH-1'): CodelyCredential {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
  return {
    access_token: `${token}.${payload}.sig`,
    refresh_token: refreshToken,
    obtained_at: Date.now() - 1000,
  } as never
}

describe('CodelyAuth 契约', () => {
  it('★★ 能满足 JetHubAuthLike（修复前 refreshAll 是 2 参 ⇒ TS2322）', () => {
    // ⚠️ 这里刻意只做「存在性 + 形状」断言：真正的判别力在上面的
    //    `const contractCheck: JetHubAuthLike = new CodelyAuth(new Context(), {})`（编译期）。
    expect(typeof contractCheck.refreshAccountCredential).toBe('function')
    expect(typeof contractCheck.refreshAll).toBe('function')
    // ⚠️ `refreshAll.length` 必须是 **1**（`(pool)`）—— 写成 2 就是旧契约。
    expect(
      contractCheck.refreshAll.length,
      'refreshAll 必须只接受 1 个参数（pool）；2 参会让 JetHubAuthLike 接线编译失败',
    ).toBe(1)
  })
})

describe('CodelyAuth 续期行为', () => {
  it('★★ refreshAll(pool) 必须真的遍历池并逐号续期（不是只读池不做事）', async () => {
    const cred1 = makeCredential('A1')
    const cred2 = makeCredential('A2')
    const { store, writes } = makeCredentialStore({
      REF_A: JSON.stringify(cred1),
      REF_B: JSON.stringify(cred2),
    })
    // ⚠️ 必须返回**合法 JWT**：`expiryMsOf` 解不出 `exp` 就会给
    //    `writebackExpiry(accountId, undefined)` ⇒ 界面「有效期」停在旧值。
    //    用裸串（如 'NEW-ACCESS'）会让这条判据变成**恒假**。
    const futureJwt = (): string => {
      const exp = Math.floor(Date.now() / 1000) + 7200
      const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
      return `NEW.${payload}.sig`
    }
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ access_token: futureJwt(), refresh_token: 'REFRESH-1' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const expiryWrites: Array<{ accountId: string; ms: number | undefined }> = []
    const auth = new CodelyAuth(new Context(), {
      credentials: store,
      fetcher: fetchImpl as never,
      writebackExpiry: async (accountId, ms) => { expiryWrites.push({ accountId, ms }) },
    })

    // 与真实 `AccountPool.listAccountsByProvider` 同形（同步返回数组）。
    const pool = {
      listAccountsByProvider: (provider: string) => (provider === 'codely'
        ? [
            { id: 'acc-a', credentialRef: 'REF_A' },
            { id: 'acc-b', credentialRef: 'REF_B' },
          ]
        : []),
    }

    await auth.refreshAll(pool)

    // ① 决定性断言：两个号都**真发了续期请求**（只读池不做事会得到 0 次）
    expect(fetchImpl, 'refreshAll 必须为每个账号真发一次续期请求').toHaveBeenCalledTimes(2)
    // ② 两个号的凭据都被写回
    expect(writes.map((w) => w.ref).sort()).toEqual(['REF_A', 'REF_B'])
    // ③ 池里的有效期被回写（否则界面「有效期」停在旧值 —— officeace 同款缺陷）
    expect(expiryWrites.map((w) => w.accountId).sort()).toEqual(['acc-a', 'acc-b'])
    expect(expiryWrites.every((w) => typeof w.ms === 'number' && w.ms > Date.now())).toBe(true)
  })

  it('★ 空池 / 读池抛错 ⇒ 静默返回（一个渠道的池抖动不该让整轮续期炸掉）', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const auth = new CodelyAuth(new Context(), { credentials: makeCredentialStore({}).store, fetcher: fetchImpl as never })

    // 空池
    await expect(auth.refreshAll({ listAccountsByProvider: () => [] })).resolves.toBeUndefined()
    // 读池抛错（同步抛）
    await expect(auth.refreshAll({
      listAccountsByProvider: () => { throw new Error('pool read failed') },
    })).resolves.toBeUndefined()
    // 池形状完全不对（undefined / 缺方法）
    await expect(auth.refreshAll(undefined)).resolves.toBeUndefined()
    await expect(auth.refreshAll({})).resolves.toBeUndefined()

    expect(fetchImpl, '池有问题时不得白发续期请求').not.toHaveBeenCalled()
  })

  it('★ 单个账号续期失败不影响其余账号', async () => {
    const { store, writes } = makeCredentialStore({
      REF_BAD: JSON.stringify(makeCredential('BAD', 'REFRESH-BAD')),
      REF_OK: JSON.stringify(makeCredential('OK', 'REFRESH-OK')),
    })
    let call = 0
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as { refresh_token?: string }
      // 第一个号（BAD）失败，第二个成功
      if (body.refresh_token === 'REFRESH-BAD') return new Response('nope', { status: 401 })
      return new Response(JSON.stringify({ access_token: 'NEW', refresh_token: 'REFRESH-OK' }), { status: 200 })
    })
    const auth = new CodelyAuth(new Context(), { credentials: store, fetcher: fetchImpl as never })
    await auth.refreshAll({
      listAccountsByProvider: () => [
        { id: 'acc-bad', credentialRef: 'REF_BAD' },
        { id: 'acc-ok', credentialRef: 'REF_OK' },
      ],
    })
    expect(call, '两个号都要被尝试').toBe(2)
    expect(writes.map((w) => w.ref), '只有成功的那个号被写回').toEqual(['REF_OK'])
  })
})

describe('refreshCodelyCredential', () => {
  it('★ refresh_token 不轮换：响应缺该字段时沿用旧值（实测上游不轮换）', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'NEW-ACCESS' }),
      { status: 200 },
    ))
    const next = await refreshCodelyCredential('OLD-REFRESH', { fetcher: fetchImpl as never })
    expect(next?.accessToken).toBe('NEW-ACCESS')
    expect(next?.refreshToken, '响应缺 refresh_token 时必须沿用旧值，不得变成空串').toBe('OLD-REFRESH')
  })

  it('★ 空 refresh_token ⇒ 直接返回 undefined（不发请求）', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const next = await refreshCodelyCredential('', { fetcher: fetchImpl as never })
    expect(next).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('★ 失败（401 / 非 JSON / 网络异常）一律 undefined，不抛错', async () => {
    const unauthorized = await refreshCodelyCredential('R', {
      fetcher: (async () => new Response('nope', { status: 401 })) as never,
    })
    expect(unauthorized).toBeUndefined()
    const notJson = await refreshCodelyCredential('R', {
      fetcher: (async () => new Response('not json', { status: 200 })) as never,
    })
    expect(notJson).toBeUndefined()
    const network = await refreshCodelyCredential('R', {
      fetcher: (async () => { throw new Error('ECONNRESET') }) as never,
    })
    expect(network).toBeUndefined()
  })

  it('★ 续期请求必须带超时（与 A3 同一纪律：不能永久挂住）', async () => {
    let seenSignal: unknown
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal
      return new Response(JSON.stringify({ access_token: 'X' }), { status: 200 })
    })
    // ⚠️ 只断言 `toBeDefined()` **没有锁住任何东西**：传一个**永不超时**的
    //    `new AbortController().signal` 也照样变绿，而那恰恰是本用例要防的事
    //    （上游挂住 ⇒ 续期链永久卡住）。⇒ 拦住 `AbortSignal.timeout` 看实参。
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    try {
      await refreshCodelyCredential('R', { fetcher: fetchImpl as never })

      expect(seenSignal).toBeInstanceOf(AbortSignal)
      expect((seenSignal as AbortSignal).aborted, '刚发出时不该是已中止状态').toBe(false)
      expect(timeoutSpy, '必须真的调用 AbortSignal.timeout 挂上超时').toHaveBeenCalledTimes(1)
      const ms = timeoutSpy.mock.calls[0]?.[0]
      expect(typeof ms).toBe('number')
      expect(ms, '超时期限必须是正数毫秒（0 / 负数等于立刻超时）').toBeGreaterThan(0)
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('★ 传入外部 signal 时仍要叠加超时（不能只听调用方的）', async () => {
    let seenSignal: unknown
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal
      return new Response(JSON.stringify({ access_token: 'X' }), { status: 200 })
    })
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    try {
      const outer = new AbortController()
      await refreshCodelyCredential('R', { fetcher: fetchImpl as never, signal: outer.signal })

      // 若实现是「有外部 signal 就原样透传」，超时就丢了 —— 而调用方的 signal
      // 通常来自上层请求，它可能永远不中止。
      expect(timeoutSpy, '叠加超时：调用方 signal 之外还要另挂一个 timeout').toHaveBeenCalledTimes(1)
      expect(seenSignal, '应是组合后的 signal，不得原样透传调用方那个').not.toBe(outer.signal)
    } finally {
      timeoutSpy.mockRestore()
    }
  })
})

describe('CodelyAuth 续期早退必须留痕（2026-10-31 审计补牙：warn 零断言缺口）', () => {
  /**
   * 造一个可观测 logger 的 cordis Context 桩。
   *
   * ⚠️ 真实 `Context` 的 `logger` 形状由宿主注入，测试桩里可能整个缺失 ——
   *    本主题修复的正是「早退静默、日志零字」，所以守卫必须能观测 warn 调用。
   *    直接在 Context 实例上挂 `logger.warn`（cordis 的属性访问是动态的）。
   */
  function makeContextWithLogger(): { ctx: Context; warns: string[] } {
    const warns: string[] = []
    const ctx = new Context()
    Object.assign(ctx, { logger: { warn: (message: string) => { warns.push(message) } } })
    return { ctx, warns }
  }

  it('★ credentials 未注入 ⇒ warn 且跳过（接线错误必须显眼，不得日志零字）', async () => {
    const { ctx, warns } = makeContextWithLogger()
    const auth = new CodelyAuth(ctx, {})
    await auth.refreshAccountCredential('REF_X', undefined, 'acc-1')
    expect(warns.length, '必须恰好一条 warn').toBe(1)
    expect(warns[0]).toMatch(/credentials 未注入/)
    expect(warns[0]).toMatch(/acc-1/)
  })

  it('★ 读不到凭据 ⇒ warn；有凭据但无 refresh_token ⇒ 另一条 warn（两种账号级问题分档）', async () => {
    const { ctx, warns } = makeContextWithLogger()
    const { store } = makeCredentialStore({
      REF_GONE: JSON.stringify(makeCredential('GONE', '')),
    })
    const auth = new CodelyAuth(ctx, { credentials: store })
    // 读不到凭据
    await auth.refreshAccountCredential('REF_MISSING', undefined, 'acc-gone')
    expect(warns.length).toBe(1)
    expect(warns[0]).toMatch(/读不到凭据/)
    expect(warns[0]).toMatch(/REF_MISSING/)
    // 有凭据但 refresh_token 为空 —— 另一条早退，文案必须区分
    await auth.refreshAccountCredential('REF_GONE', undefined, 'acc-empty')
    expect(warns.length).toBe(2)
    expect(warns[1]).toMatch(/没有 refresh_token/)
    expect(warns[1]).toMatch(/acc-empty/)
  })

  it('★ 上游续期失败（返回 undefined）⇒ warn 留痕且不记账', async () => {
    const { ctx, warns } = makeContextWithLogger()
    const { store } = makeCredentialStore({
      REF_DEAD: JSON.stringify(makeCredential('DEAD', 'REFRESH-DEAD')),
    })
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }))
    const auth = new CodelyAuth(ctx, { credentials: store, fetcher: fetchImpl as never })
    await auth.refreshAccountCredential('REF_DEAD', undefined, 'acc-dead')
    expect(fetchImpl, '必须真发过续期请求（先排除「没请求就早退」的假路径）').toHaveBeenCalledTimes(1)
    expect(warns.length, '上游失败必须留痕').toBe(1)
    expect(warns[0]).toMatch(/续期失败/)
    expect(warns[0]).toMatch(/acc-dead/)
  })

  it('★ 续期成功路径不得产生任何 warn（防「凡早退都加 warn」顺手污染成功路）', async () => {
    const { ctx, warns } = makeContextWithLogger()
    const { store } = makeCredentialStore({
      REF_OK: JSON.stringify(makeCredential('OK', 'REFRESH-OK')),
    })
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'NEW', refresh_token: 'REFRESH-OK' }),
      { status: 200 },
    ))
    const auth = new CodelyAuth(ctx, { credentials: store, fetcher: fetchImpl as never })
    await auth.refreshAccountCredential('REF_OK', undefined, 'acc-ok')
    expect(warns, '成功路径零 warn').toEqual([])
  })
})
