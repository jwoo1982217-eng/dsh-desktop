/**
 * ★★ AutoClaw 的 **401 按需续期**：行为级守卫（两站各一组）。
 *
 * ## 为什么必须重写这一组（2026-10-27 两轮审计的共同结论）
 *
 * 原先这组在 `autoclaw-lock-wiring.spec.ts` 里是**源码文本断言**
 * （`readFileSync` + `toMatch(/refresh:\s*async\s*\(\)\s*=>\s*\{/)` 等四条）。
 * 红队逐字复刻判据后实测，以下五种**假接线全部绿**：
 *
 * | 假接线 | 为什么骗过文本断言 |
 * |---|---|
 * | 片段塞进**字符串字面量** | `toContain` 只找子串 |
 * | **行尾** `//` 冒充（`codeOnly` 只剥整行 `//`） | 剥注释不覆盖行尾 |
 * | `if (false) { …真接线… }` | 字面量在死分支里照样存在 |
 * | `if (Math.random() >= 0) return` 恒早退 | 真实现变成 no-op，文本一字不少 |
 * | 整块塞进 `false ? … : async () => {}` | 同上 |
 *
 * 而它守的是**本 PR 的核心接线**，一旦漏接，用户看到的就是固定文案
 * 「API 密钥无效」（`AUTH` 被客户端替换 message）。
 *
 * ## 本文件的判据（**打行为**，不打源码文本）
 *
 * 真跑 `apply()`，**两个账号**（A 在前、B 在后，手动序 A 优先）：
 *
 * 1. 让 `resolveCredential` 选中 **B**（模拟「余额分档把 B 排前面」——
 *    真实成因，见 `credential-resolver.ts` 的 `pickBuddyAccount`）；
 * 2. 让第一次请求返回 **401**（上游 AT 过期）；
 * 3. 断言**被续期的是 B**，而**不是** A。
 *
 * 这一条同时守住了三件此前都被打穿的事：
 * - PR154 的「续错号」（修前续的是 `getAvailableAccount` 的 A）；
 * - 「续了但重发仍用旧 token」（修前重发前会**重新选号**）；
 * - 「两站各一条」（国际版同一组，用 `AUTOCLAW_INTL` 的 ref 前缀）。
 *
 * ⚠️ 铁律：**不发真实网络**（`fetch` 全部注入）、**不读真实凭据**
 * （`FakeCredentials` 内存后端）、`DSH_JET_HUB_STATE_DIR` 逐文件隔离。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { apply } from '../../src/index.js'
import { AUTOCLAW, AUTOCLAW_INTL } from '../../src/autoclaw-product.js'

const dirs: string[] = []

beforeEach(() => {
  // ⚠️ 必须隔离：`apply()` 会真的装配账号池与 journal 落盘点。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-autoclaw-401-'))
  dirs.push(dir)
  process.env.DSH_JET_HUB_STATE_DIR = dir
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

/** 内存凭据后端（与 `trae-model-id-selection.spec` 的 `FakeCredentials` 同款）。 */
class FakeCredentials {
  private store = new Map<string, string>()
  private key(ref: unknown): string {
    return typeof ref === 'string' ? ref : String((ref as { name?: string })?.name ?? ref)
  }
  async resolve(ref: unknown) {
    const value = this.store.get(this.key(ref))
    return value === undefined ? undefined : { value, source: 'fake' }
  }
  async describe(ref: unknown) {
    const configured = this.store.has(this.key(ref))
    return { configured, source: configured ? 'fake' : undefined, writable: true }
  }
  async set(ref: unknown, value: string) { this.store.set(this.key(ref), value) }
  async unset(ref: unknown) { this.store.delete(this.key(ref)) }
  /** 直接读回（断言落盘内容用）。 */
  raw(ref: string): unknown {
    const value = this.store.get(ref)
    return value === undefined ? undefined : JSON.parse(value)
  }
}

class FakeCommands {
  register(): () => void { return () => {} }
}

class FakeLlm {
  readonly adapterByProvider = new Map<string, unknown>()
  registerConfigurableProviders(): { replace: () => void } { return { replace: () => {} } }
  registerAdapter(providers: string[], adapter: unknown): { replace: () => void } {
    for (const provider of providers) this.adapterByProvider.set(provider, adapter)
    return { replace: () => {} }
  }
}

interface TestCtx extends Context {
  accountPool: { addAccount(entry: Record<string, unknown>): Promise<void> }
  credentials: FakeCredentials
  llm: FakeLlm
}

function boot(): TestCtx {
  const ctx = new Context() as TestCtx
  ctx.provide('credentials', new FakeCredentials() as never)
  ctx.provide('commands', new FakeCommands() as never)
  ctx.provide('llm', new FakeLlm() as never)
  apply(ctx as never)
  return ctx
}

/** 造一条可续期的 AutoClaw 凭据（AT 未过期，避免走"预判"路径）。 */
function credentialOf(token: string) {
  return {
    access_token: token,
    refresh_token: `rt-${token}`,
    expires_at: Date.now() + 3_600_000,
  }
}

/**
 * 在一站上驱动「选 B → 401 → 续期 → 重发」，返回观察到的调用序列。
 *
 * @param product 站点（决定 provider id 与 ref 前缀）
 * @param serviceName 该站 auth 的 cordis 服务名（`autoclawAuth` / `autoclawintlAuth`）
 */
async function driveStation(
  product: typeof AUTOCLAW | typeof AUTOCLAW_INTL,
  serviceName: string,
): Promise<{
  renewedRefs: string[]
  requestTokens: string[]
  finalChunks: number
}> {
  const ctx = boot()
  /** A 在前、B 在后：`getAvailableAccount`（手动序）会选 A。 */
  const refA = `${product.id === AUTOCLAW.id ? 'AUTOCLAW' : 'AUTOCLAWINTL'}_ACCOUNT_AAAA1111`
  const refB = `${product.id === AUTOCLAW.id ? 'AUTOCLAW' : 'AUTOCLAWINTL'}_ACCOUNT_BBBB2222`
  for (const [id, ref] of [['acct-a', refA], ['acct-b', refB]] as const) {
    await ctx.accountPool.addAccount({
      id,
      provider: product.id,
      nickname: id,
      enabled: true,
      credentialRef: ref,
      createdAt: 0,
      refreshable: true,
    })
    await ctx.credentials.set(
      credentialRef(ref),
      JSON.stringify(credentialOf(`AT-${id}`)),
    )
  }

  /**
   * ⚠️ **强制「分档选中 B」**：把该站 auth 的 `renewCredentialForRef` /
   * `refreshAccountCredential` 换成记录器，并让 `getAvailableAccount` 返回 A
   * —— 若适配器仍走 `getAvailableAccount`，续的就是 A（红）。
   *
   * 同时把 `resolveCredential` 的选号结果钉到 B：`apply()` 装出来的适配器
   * 已捕获了原始 `resolveCredential`，故这里改为**直接驱动适配器**时
   * 用 `credentialProvider` 覆盖不可行 ⇒ 改用「让 B 的凭据先被选中」的等价做法：
   * 把 A 停用（`getAvailableAccount` 只看 `enabled`，分档候选也筛 `enabled`，
   * 但 B 仍是唯一可用号）。真正的分叉由**下面的 A 账号重新启用后仍不被续**
   * 来验证（见 `renewedRefs`）。
   */
  const auth = (ctx as unknown as Record<string, unknown>)[serviceName] as {
    renewCredentialForRef: (ref: string, pool?: unknown, id?: string) => Promise<unknown>
    refreshAccountCredential: (ref: string, pool?: unknown, id?: string) => Promise<void>
  }
  const renewedRefs: Array<{ ref: string; id?: string }> = []
  /**
   * ⚠️ 只**记录**并返回一份"续好的"凭据（不发网络）：这样断言的是
   * 「接线把哪个账号交给了续期」，而续期本身的行为由
   * `autoclaw-auth` 自己的用例覆盖。
   *
   * ⚠️ 必须同时替换 `renewCredentialForRef` 与 `refreshAccountCredential`：
   * 生产闭包调的是前者（要拿返回值重发），但若有人改回后者，也应当被观察到。
   */
  auth.renewCredentialForRef = async (ref: string, pool?: unknown, id?: string) => {
    void pool
    renewedRefs.push({ ref, ...(id === undefined ? {} : { id }) })
    return credentialOf(`AT-renewed-${id ?? ref}`)
  }
  auth.refreshAccountCredential = async (ref: string, pool?: unknown, id?: string) => {
    void pool
    renewedRefs.push({ ref, ...(id === undefined ? {} : { id }) })
  }

  /**
   * ⚠️ 先让 `resolveCredential` 选中 **B**（否则两条选号规则都选 A，
   * 「续错号」这个缺陷根本不会暴露）。
   *
   * 生产成因是**余额分档**（`balance: { kind: 'buddy' }` 按到期档位排序），
   * 而 `getAvailableAccount` 走**用户手动序**。这里用最直接的等价做法：
   * 把 B 挪到池的首位（= 用户的拖拽顺序），A 挪到后面 ⇒
   * - `getAvailableAccount`（修前闭包）会选 **B** —— 所以还必须让 B 的
   *   **凭据读不出来**，才能复现「闭包选中的号 ≠ 请求用的号」。
   *
   * 更简单且**不依赖池内部实现**的造法：直接用 `credentialProvider`
   * 覆盖适配器的取凭据函数，钉死返回 B 的凭据 ⇒ 请求必用 B，而任何
   * 「问池要号」的实现都会拿到 A（手动序第一）。
   */
  const adapter = ctx.llm.adapterByProvider.get(product.id) as unknown as {
    options: {
      resolveCredential?: (modelId?: string) => Promise<unknown>
      refresh?: (used?: unknown) => Promise<unknown>
    }
    stream: (options: unknown) => AsyncIterable<unknown>
  }
  expect(adapter, `${product.id} 未注册适配器`).toBeDefined()
  /** ⚠️ 钉死：本次请求**一定**用 B 的凭据（模拟分档选中 B）。 */
  adapter.options.resolveCredential = async () => credentialOf('AT-acct-b')

  /** 记录每次**聊天端点**请求带的 Bearer（目录请求单独走，不计入）。 */
  const requestTokens: string[] = []
  let chatCalls = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const href = String(url)
    /**
     * ⚠️ **必须按 URL 分流**：本家有两个端点，且**认证头是相反的**
     * （`autoclaw-model-config` 只认 `Authorization`、`chat/completions` 只认
     * `X-Authorization`）。若对**所有**请求都回 401，目录那次也会 401 ⇒
     * 适配器回落兜底表、`stream()` 一次都不发 ⇒ 用例会以「没续期」假红。
     */
    if (!href.includes('/chat/completions')) {
      // 目录端点：给一个形状正确的空目录（适配器回落兜底表）。
      return new Response(JSON.stringify({ models: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    chatCalls += 1
    const headers = init.headers as Record<string, string>
    const bearer = headers['X-Authorization'] ?? headers['Authorization'] ?? ''
    requestTokens.push(bearer)
    if (chatCalls === 1) {
      // 第一次：AT 过期 ⇒ 401（上游的 invalid token 形态）
      return new Response(JSON.stringify({ code: 401, msg: 'invalid token' }), { status: 401 })
    }
    // 重发：成功，给一条正常的 SSE
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  })

  let finalChunks = 0
  try {
    for await (const chunk of adapter.stream({
      model: 'zai_glm-5.3-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      void chunk
      finalChunks += 1
    }
  } catch {
    // 失败也照常返回已观测到的数据（断言会指出是哪一条）
  }
  return { renewedRefs, requestTokens, finalChunks }
}

describe.each([
  ['autoclaw（国内版）', AUTOCLAW, 'autoclawAuth', 'AUTOCLAW_ACCOUNT_BBBB2222'],
  ['autoclawintl（国际版）', AUTOCLAW_INTL, 'autoclawintlAuth', 'AUTOCLAWINTL_ACCOUNT_BBBB2222'],
] as const)('★★ %s：401 按需续期（行为级）', (_label, product, serviceName, expectedRef) => {  it('★ 401 后必须续「本次实际用的那个账号」，并**用新凭据重发**', async () => {
    const { renewedRefs, requestTokens, finalChunks } = await driveStation(product, serviceName)

    // ① 确实续期了（不是「静默不续」）
    expect(renewedRefs.length, '401 后没有任何续期动作 ⇒ 401 不续期不重发 ⇒ 报「API 密钥无效」')
      .toBeGreaterThan(0)

    // ② ★★ 续的是「本次用的那个」而不是池里第一个
    //    ⚠️ 修前这里会是 `AUTOCLAW_ACCOUNT_AAAA1111`（`getAvailableAccount` 的手动序）
    expect(renewedRefs.map((item) => item.ref), '★ 续错号：续的不是本次请求用的那个账号')
      .toContain(expectedRef)
    // 并且必须带上该账号的 id（否则新 `expiresAt` 写不回池，UI 恒显「已过期」）
    expect(renewedRefs.some((item) => item.id === 'acct-b'), '★ 未传 entry.id ⇒ 池镜像不更新')
      .toBe(true)

    // ③ ★★ 重发必须带**新** token（修前重发前会 `resolveCredential` 重新选号 ⇒ 仍是旧值）
    expect(requestTokens.length, '401 之后必须重发一次').toBeGreaterThanOrEqual(2)
    expect(requestTokens[0], '第一次请求应带初始 token').toContain('AT-acct-b')
    expect(requestTokens[requestTokens.length - 1], '★ 重发必须用续期后的新 token')
      .not.toBe(requestTokens[0])

    // ④ 最终请求成功（证明重发真的走通了，而不是"续了但还是 401"）
    expect(finalChunks, '续期后的重发没有产出任何内容块').toBeGreaterThan(0)
  })
})

/**
 * ★★ **per-ref 单飞（去重）**：同一 ref 并发续期只能有**一份** grant。
 *
 * ## 为什么必须有（2026-10-27 审计的 P0）
 *
 * `AutoclawAuth.refreshAccountCredential` 修前**没有任何并发保护**
 * （全仓 autoclaw 唯一的 in-flight 表在 `autoclaw-credits.ts`，不覆盖这条腿）。
 * 实测同一 ref 并发 3 次 ⇒ **3 份 grant，三份都用同一把 RT**。
 *
 * 而 RT 是一次性轮换的：3 份里 2 份必然 `invalid_grant`；上游处理序 ≠ 本地
 * 完成序时盘上还可能留**已作废的 RT** ⇒ 账号报废。且 PR154 补上请求级续期后，
 * DSH 每轮并发发「主回复 + 标题 + 压缩」三条请求 ⇒ 每次过期边界**必然**撞车。
 *
 * ⚠️ 判据必须打 `refreshAccountCredential` / `renewCredentialForRef` 的**真实**
 * 实现（不替换它），否则测的是替身而不是闸门。
 */
describe.each([
  ['autoclaw（国内版）', AUTOCLAW, 'autoclawAuth'],
  ['autoclawintl（国际版）', AUTOCLAW_INTL, 'autoclawintlAuth'],
] as const)('★★ %s：per-ref 单飞（去重）', (_label, product, serviceName) => {
  it('★ 同一 ref 并发 5 次 ⇒ 只发 1 份 grant', async () => {
    const ctx = boot()
    const refName = `${product.id === AUTOCLAW.id ? 'AUTOCLAW' : 'AUTOCLAWINTL'}_ACCOUNT_DEDUP01`
    await ctx.credentials.set(
      credentialRef(refName),
      JSON.stringify(credentialOf('AT-dedup')),
    )
    const auth = (ctx as unknown as Record<string, unknown>)[serviceName] as {
      refreshAccountCredential: (ref: string, pool?: unknown, id?: string) => Promise<void>
    }
    /** 记录真正打上游的次数（refresh 端点）。 */
    let grants = 0
    vi.stubGlobal('fetch', async (url: string) => {
      // 本家续期会**依次试两个端点**；无论哪个都算"一份 grant"
      if (String(url).includes('/userapi/v1/')) {
        grants += 1
        // 加一点延迟，让并发真正重叠（否则第一份瞬间完成、后面的复用它）
        await new Promise((r) => setTimeout(r, 20))
        return new Response(JSON.stringify({
          code: 0,
          data: { access_token: `AT-new-${grants}`, refresh_token: 'rt-new', expires_in: 3600 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const pool = { listAccounts: async () => [], updateAccount: async () => {} } as never

    await Promise.all(Array.from({ length: 5 }, () =>
      auth.refreshAccountCredential(refName, pool, 'dedup01').catch(() => undefined)))

    /**
     * ⚠️ 一份 grant = 1 次端点调用（第一个端点成功就不再试第二个）。
     *   并发 5 次若各发一份 ⇒ 5（甚至 10）。要求**恰好 1**。
     */
    expect(
      grants,
      '★ 并发 5 次 ⇒ 多份 grant（一次性 RT 下必然互废，输家还会把好号标死）',
    ).toBe(1)
  })
})

/**
 * ★★ **第二轮审计修的四格**（每条都对应一处红队实测击穿）。
 *
 * 这一组守的是「绕过单飞闸门 + 单向门 + 终态不重读」这三件事 ——
 * 红队实测它们会让**一把上游仍有效的好钥匙被标成「需重新登录」**，
 * 触发面是「每次宿主重启/升级时启动首轮 `refreshAll` 与用户第一条消息并发」。
 */
describe.each([
  ['autoclaw（国内版）', AUTOCLAW, 'autoclawAuth'],
  ['autoclawintl（国际版）', AUTOCLAW_INTL, 'autoclawintlAuth'],
] as const)('★★ %s：refreshAll 必须走单飞闸门（第二轮审计打穿）', (_label, product, serviceName) => {
  /** 造一个「池里有、凭据完好」的账号，返回 ref。 */
  async function seed(ctx: TestCtx, id: string, token: string): Promise<string> {
    const prefix = product.id === AUTOCLAW.id ? 'AUTOCLAW' : 'AUTOCLAWINTL'
    const ref = `${prefix}_ACCOUNT_${id.toUpperCase()}`
    await ctx.accountPool.addAccount({
      id, provider: product.id, nickname: id, enabled: true,
      credentialRef: ref, createdAt: 0, refreshable: true,
    })
    await ctx.credentials.set(credentialRef(ref), JSON.stringify(credentialOf(token)))
    return ref
  }

  it('★★ `refreshAll` 与「401 续期」并发 ⇒ 只发 1 份 grant（不得两路各烧一次 RT）', async () => {
    const ctx = boot()
    const ref = await seed(ctx, 'dupall', 'AT-all')
    const auth = (ctx as unknown as Record<string, unknown>)[serviceName] as {
      refreshAll: (pool: unknown) => Promise<void>
      renewCredentialForRef: (ref: string, pool?: unknown, id?: string) => Promise<unknown>
    }
    let grants = 0
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/userapi/v1/')) {
        grants += 1
        // 延迟让并发真正重叠
        await new Promise((r) => setTimeout(r, 20))
        return new Response(JSON.stringify({
          code: 0,
          data: { access_token: `AT-new-${grants}`, refresh_token: `RT-new-${grants}`, expires_in: 3600 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const pool = {
      listAccounts: async () => [{ id: 'dupall', credentialRef: ref, refreshable: true, enabled: true }],
      updateAccount: async () => {},
    }
    await Promise.all([
      auth.refreshAll(pool),
      auth.renewCredentialForRef(ref, pool, 'dupall').catch(() => undefined),
    ])
    expect(
      grants,
      '★ `refreshAll` 绕过了单飞闸门 ⇒ 两路各拿同一把一次性 RT 打上游（输家 invalid_grant，好号被标死）',
    ).toBe(1)
  })

  it('★★ 池标 `refreshable:false` 但凭据完好 ⇒ `refreshAll` 仍必须处理（单向门）', async () => {
    const ctx = boot()
    const ref = await seed(ctx, 'door2', 'AT-door')
    const auth = (ctx as unknown as Record<string, unknown>)[serviceName] as {
      refreshAll: (pool: unknown) => Promise<void>
    }
    let grants = 0
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/userapi/v1/')) {
        grants += 1
        return new Response(JSON.stringify({
          code: 0,
          data: { access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 3600 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    // ⚠️ 池说不可续期（误标），但凭据里 refresh_token 完好
    const pool = {
      listAccounts: async () => [{ id: 'door2', credentialRef: ref, refreshable: false, enabled: true }],
      updateAccount: async () => {},
    }
    await auth.refreshAll(pool as never)
    expect(
      grants,
      '★ 误标 `refreshable:false` 变成了单向门（`AGENTS.md` 明文红线：它是凭据材料的镜像，不是案底）',
    ).toBeGreaterThan(0)
  })

  it('★★ 终态报错但凭据已被他处轮换 ⇒ 不得把好号标死（判终态前必须重读）', async () => {
    /**
     * ⚠️⚠️ **必须走 `refreshAll`**（而不是 `renewCredentialForRef`）—— 只有前者的
     * catch 才会调 `updateAccount({refreshable:false})`，即「标死」这个**可观测后果**
     * 发生在 `refreshAll` 里。我第一版观察 `renewCredentialForRef` 的返回值 ⇒
     * 它是**假绿**（实测：把重读整段删掉，用例仍绿）。
     *
     * ⚠️ 这也是红队的复现路径：401 那条腿先发、`refreshAll` 后发（或反之），
     * 本路拿的是**旧快照** ⇒ 上游回 401 ⇒ 若不重读就误判「这把 RT 死了」。
     */
    const ctx = boot()
    const ref = 'AUTOCLAW_ACCOUNT_REREAD2'
    await ctx.accountPool.addAccount({
      id: 'reread2', provider: AUTOCLAW.id, nickname: 'reread2', enabled: true,
      credentialRef: ref, createdAt: 0, refreshable: true,
    })
    await ctx.credentials.set(credentialRef(ref), JSON.stringify(credentialOf('AT-old')))
    const auth = (ctx as unknown as Record<string, unknown>)[serviceName] as {
      refreshAll: (pool: unknown) => Promise<void>
    }
    const updates: Array<{ id: string; patch: unknown }> = []
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/userapi/v1/')) {
        /**
         * ⚠️ 模拟并发那一路已成功：**先**把盘上换成新凭据，**再**回终态报文
         * ⇒ 我们手上那份快照已成旧值。若不重读，就会以为「这把 RT 死了」。
         */
        await ctx.credentials.set(credentialRef(ref), JSON.stringify(credentialOf('AT-rotated-by-other')))
        /**
         * ⚠️⚠️ **必须是「确定性拒绝」的形态**（`HTTP 400` + 业务码信封），
         * 不能用 `401` —— 按 `refresh-failure.ts` 的分类器，`401` 是**非终态**
         * （客户端认证问题，不说明这把 RT 死了）⇒ 走不到 `RefreshTokenExpiredError`
         * ⇒ 也就测不到「标死」这条腿（我第一版用 401 ⇒ **假绿**，实测确认）。
         */
        return new Response(JSON.stringify({ code: 400, msg: 'Invalid token' }), { status: 400 })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const pool = {
      listAccounts: async () => [{ id: 'reread2', credentialRef: ref, refreshable: true, enabled: true }],
      updateAccount: async (id: string, patch: unknown) => { updates.push({ id, patch }) },
    }
    await auth.refreshAll(pool)
    expect(
      updates.some((item) => (item.patch as { refreshable?: boolean }).refreshable === false),
      '★★ 他处已把凭据轮换成功，本路却因拿旧快照打而报终态 ⇒ 误标好号'
      + '（`refreshable:false` 是单向门 ⇒ 永不自愈、用户被要求重新登录）',
    ).toBe(false)
  })
})

/**
 * ★★ **接线与错误通道**的守卫（第二轮审计：这几格此前**零守卫**）。
 *
 * 审计实测「删掉 `index.ts` 两站的 `startRenewPatrol` 整段、或删掉 `ctx.effect`
 * 回收、或把 `catch` 改回静默、或让 `refresh()` 绕过单飞」时，**全量测试
 * 一个字都不变**。本组逐格钉住它们。
 */
describe('★★ AutoClaw：错误通道必须留痕、单飞必须覆盖全部入口', () => {
  it('★★ `refresh()`（单凭据路径）也必须走单飞：并发 2 次 ⇒ 只 1 份 grant', async () => {
    const ctx = boot()
    // ⚠️ 单凭据路径的 ref 是产品声明的 `defaultCredentialRef`（不是 `AUTOCLAW_ACCESS_TOKEN`）
    const ref = 'AUTOCLAW_ACCOUNT_DEFAULT'
    await ctx.credentials.set(credentialRef(ref), JSON.stringify(credentialOf('AT-single')))
    const auth = (ctx as unknown as Record<string, unknown>).autoclawAuth as {
      refresh: () => Promise<void>
    }
    let grants = 0
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/userapi/v1/')) {
        grants += 1
        await new Promise((r) => setTimeout(r, 20))
        return new Response(JSON.stringify({
          code: 0,
          data: { access_token: `AT-n${grants}`, refresh_token: `RT-n${grants}`, expires_in: 3600 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await Promise.all([auth.refresh(), auth.refresh()])
    expect(
      grants,
      '★ 单凭据路径绕过单飞 ⇒ 两路各烧一次一次性 RT（红队实测「峰值 2」）',
    ).toBe(1)
  })

  it('★★ 401 重发的失败必须留 warn（不得静默 ⇒ 「一次上游都不发 + 日志零字」）', async () => {
    const ctx = boot()
    const ref = 'AUTOCLAW_ACCOUNT_WARN1'
    await ctx.accountPool.addAccount({
      id: 'warn1', provider: AUTOCLAW.id, nickname: 'warn1', enabled: true,
      credentialRef: ref, createdAt: 0, refreshable: true,
    })
    await ctx.credentials.set(credentialRef(ref), JSON.stringify(credentialOf('AT-warn')))
    const adapter = ctx.llm.adapterByProvider.get(AUTOCLAW.id) as unknown as {
      options: {
        resolveCredential?: (modelId?: string) => Promise<unknown>
        refresh?: (used?: unknown) => Promise<unknown>
      }
      stream: (options: unknown) => AsyncIterable<unknown>
    }
    adapter.options.resolveCredential = async () => credentialOf('AT-warn')
    /** ⚠️ 让 refresh **抛错**（模拟「反查不到账号」那条腿）。 */
    adapter.options.refresh = async () => {
      throw new Error('autoclaw: 401 后无可续期的账号（池里没有本次使用的凭据…）')
    }
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/chat/completions')) {
        return new Response(JSON.stringify({ code: 401, msg: 'invalid token' }), { status: 401 })
      }
      return new Response(JSON.stringify({ models: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    })
    /** ⚠️ 捕获 adapter 的 warn 出口。 */
    const warnings: string[] = []
    const original = (adapter as unknown as { warnImpl?: (m: string) => void })
    void original
    // ⚠️ 直接替换私有出口（与生产同一条通道）——`warnImpl` 是 readonly 字段，
    //    这里用结构化赋值（测试专用，不改生产类型）。
    ;(adapter as unknown as { warnImpl: (m: string) => void }).warnImpl =
      (message: string) => { warnings.push(message) }
    try {
      for await (const _chunk of adapter.stream({
        model: 'zai_glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }],
      })) { void _chunk }
    } catch { /* 401 会抛出，无需断言这一层 */ }
    expect(
      warnings.some((message) => message.includes('续期')),
      '★ 401 重发失败被静默吞掉 ⇒ 日志零字、用户只看到「API 密钥无效」',
    ).toBe(true)
  })
})
