/**
 * Qoder 免费模型**跳过永久积分锁定**的回归（`src/qoder-adapter.ts` + `src/index.ts`）。
 *
 * ## 为什么单独守这个
 *
 * 用户报障 2026-10-21：开着「锁定永久积分」，用**免费模型**（中国版
 * `Qwen3.8-Flash` / `DeepSeek-Flash`，国际版 `Qwen3.8-Max` / `Qwen3.8-Flash`）
 * 请求，却报：
 *
 * > Qoder (中国版)：没有可用账号。已锁定永久积分，而当前账号的额度都属于
 * > **长期 / 永久**那一类 ⋯ 请在 Jet Hub 面板**解锁**永久积分后继续使用
 *
 * 那句话本身**自相矛盾**：免费模型既不扣临时也不扣永久积分，说它「额度都属于
 * 永久」毫无意义；而且它把用户推向「解锁永久积分」—— 那是**不可逆地烧钱**。
 *
 * ## 根因（接线缺失，不是算法错）
 *
 * `src/credential-resolver.ts:368` 的免费短路**只在 `plan.isFreeModel` 存在时**
 * 才可能命中。本家的两处 `balance:` 装配从未传这个钩子 ⇒ 免费模型与付费模型
 * 走同一条余额分档路 ⇒ 锁定期间被 `allowPermanent=false` 一并拦下。
 *
 * 与 buddy 的同名缺陷（`tests/unit/buddy-free-model-lock.spec.ts`）**同一个洞**，
 * 只是那次修的是 buddy / workbuddy / trae 三家，本家当时还没接 `balance`。
 *
 * ## 两条必须同时成立的约定
 *
 * 1. **确定免费才放开**：`isFreeModel` 只在目录明确 `is_free` 时返回 true。
 *    把付费模型误判成免费会绕开锁定、**真烧掉永久积分且不可撤回** ——
 *    这是本补丁最危险的失效方向，故边界用例逐条锁死。
 * 2. **免费路径仍受模型级限流约束**：免费不等于无视限流标记。
 *
 * ## ⚠️ 为什么用行为级用例而不是源码文本断言
 *
 * 文本断言只能证明「源码里有一行把免费信号交给编排」，行为级断言证明**它真的
 * 生效**。本缺陷正是「解析层已经产出 `isFree`、装配层漏了」—— 只看解析层源码
 * 的断言会全绿（`qoder-adapter.ts:966` 透出 `isFree` 这件事早就有了）。
 *
 * ⚠️ **注释里不重写被钉住的方法名以外的锚点原文**：那类核对会 grep 的字符串，
 * 写进注释会让核对**假命中**（与 `raccoon-wiring.spec.ts` 同约定）。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { apply } from '../../src/index.js'

/** 中国版与国际版都是 Qoder 家族，两站必须各自接上（装配是两份，容易只改一份）。 */
const QODER_PROVIDERS = ['qoder', 'qodercn'] as const

describe('Qoder 免费模型跳过永久积分锁定', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  class FakeCredentials {
    private store = new Map<string, string>()
    private key(ref: unknown): string { return typeof ref === 'string' ? ref : String(ref) }
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
    accountPool: {
      addAccount(entry: Record<string, unknown>): Promise<void>
      setPermanentLocked(provider: string, locked: boolean): Promise<void>
    }
    credentials: FakeCredentials
    llm: FakeLlm
  }

  /**
   * 跑一次真实 `apply()`，并把 Qoder 适配器上的 `isFreeModel` 钉成给定值。
   *
   * ⚠️ **必须桩掉 `fetch`**：余额查询会打上游端点（本组不需要真实余额 ——
   * 免费短路生效时根本不会查余额；不生效时查失败 ⇒ 锁定时报「无法确认」，
   * 正是我们要区分的两条路径）。
   *
   * ⚠️ 钉住的方法是**适配器实例上的**：`resolveCredential` 闭包捕获的正是这个
   * 实例（`isFreeModel: (modelId) => qoderAdapter.isFreeModel(modelId)` 是延迟
   * 求值），故替换它的方法就改变了真实闭包看到的值。
   */
  function boot(free: boolean): TestCtx {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-qoder-free-'))
    dirs.push(dir)
    process.env.DSH_JET_HUB_STATE_DIR = dir
    vi.stubGlobal('fetch', async () => { throw new Error('单测不发网络') })

    const ctx = new Context() as TestCtx
    ctx.provide('credentials', new FakeCredentials() as never)
    ctx.provide('commands', new FakeCommands() as never)
    ctx.provide('llm', new FakeLlm() as never)
    apply(ctx as never)

    for (const provider of QODER_PROVIDERS) {
      const adapter = ctx.llm.adapterByProvider.get(provider) as
        { isFreeModel?: (m?: string) => Promise<boolean> } | undefined
      if (adapter !== undefined && typeof adapter.isFreeModel === 'function') {
        adapter.isFreeModel = async () => free
      }
    }
    return ctx
  }

  function resolveOf(ctx: TestCtx, provider: string): (modelId?: string) => Promise<unknown> {
    const adapter = ctx.llm.adapterByProvider.get(provider) as {
      options?: { resolveCredential?: (modelId?: string) => Promise<unknown> }
      resolveCredential?: (modelId?: string) => Promise<unknown>
    } | undefined
    if (adapter === undefined) throw new Error(`provider ${provider} 未注册`)
    const fn = adapter.options?.resolveCredential ?? adapter.resolveCredential
    if (typeof fn !== 'function') throw new Error(`provider ${provider} 没有 resolveCredential`)
    return fn.bind(adapter.options ?? adapter) as (modelId?: string) => Promise<unknown>
  }

  async function addAccount(ctx: TestCtx, provider: string, ref: string): Promise<string> {
    const id = `${provider}-test-${Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '')}`
    await ctx.accountPool.addAccount({
      id, provider, nickname: id, enabled: true, credentialRef: ref, createdAt: 0, refreshable: true,
    })
    return id
  }

  /** 真实形状的 Qoder 凭据（`buildQoderCredential` 的产出字段）。 */
  function qoderCredential(token: string): string {
    return JSON.stringify({
      access_token: token,
      refresh_token: 'rt-x',
      expires_at: Date.now() + 3_600_000,
      machine_id: 'm-1',
      uid: 'u-1',
    })
  }

  /**
   * ⚠️ **免费 + 锁定 ⇒ 必须取到凭据**（用户报障的那个场景）。
   *
   * 变异：删掉 `src/index.ts` 两处 `balance:` 里的 `isFreeModel:` 行 ⇒ 免费信号
   * 到不了编排 ⇒ 落进余额分档 ⇒ 余额查不到 ⇒ 锁定时抛「无法确认」⇒ 本条红。
   * 变异：只删其中一站 ⇒ 该站那一格红（`it.each` 保证两站各自被守）。
   */
  it.each(QODER_PROVIDERS)(
    '%s：锁定 + 免费模型 ⇒ 仍取到凭据（不被锁定误拦）',
    async (provider) => {
      const ctx = boot(true)
      await ctx.accountPool.setPermanentLocked(provider, true)
      const ref = `${provider.toUpperCase()}_ACCOUNT_FREE`
      await addAccount(ctx, provider, ref)
      await ctx.credentials.set(credentialRef(ref), qoderCredential('tok-free'))

      const credential = await resolveOf(ctx, provider)('qfmodel') as
        { access_token?: string } | undefined
      expect(credential, `${provider}：免费模型不该被「锁定永久积分」拦下`).toBeDefined()
      expect(credential?.access_token).toBe('tok-free')
    },
    30_000,
  )

  /**
   * ⚠️ **付费模型仍走锁定报错路径**（阳性对照 + 最危险的失效方向）。
   *
   * 把付费模型误判成免费会绕开锁定、**真烧掉永久积分且不可撤回**。
   * 变异：把 `isFreeModel` 的判据改成恒 `true` ⇒ 本条红。
   */
  it.each(QODER_PROVIDERS)(
    '%s：付费模型仍被锁定拦下（误判免费会真烧永久积分）',
    async (provider) => {
      const ctx = boot(false)
      await ctx.accountPool.setPermanentLocked(provider, true)
      const ref = `${provider.toUpperCase()}_ACCOUNT_PAID`
      await addAccount(ctx, provider, ref)
      await ctx.credentials.set(credentialRef(ref), qoderCredential('tok-paid'))

      const error = await resolveOf(ctx, provider)('dmodel')
        .then(() => undefined, (e: Error) => e)
      expect(error, '付费模型 + 锁定 + 余额查不到 ⇒ 必须抛错，绝不能交出凭据').toBeDefined()
      // 本家锁定时余额查不到 ⇒ 落 `unknown` 档（本机国际版网络不通时天天如此），
      // 文案由 `qoderLockedError` 的 unknown 分支提供。锚「无法确认」而非
      // 「没有可用账号」—— 后者是 `no-candidates` / `exhausted` 两档的措辞。
      expect(error?.message).toContain('无法确认是否有可用账号')
    },
    30_000,
  )

  /**
   * ⚠️ **免费不等于无视限流标记**：免费路径的候选仍按模型筛。
   *
   * ⚠️ `addAccount` 是**追加**（不是 upsert）⇒ 只能调一次并带上 `modelRateLimits`；
   * 调两次会得到两个同 id 账号，未限流的那个照样被选中，用例变成恒绿。
   *
   * 变异：把 `credential-resolver.ts` 免费分支的候选来源改成「不过滤
   * `modelRateLimits`」⇒ 被限流的账号仍被选中 ⇒ 本条红。
   */
  it('免费路径仍受模型级限流约束（唯一账号被该模型限流 ⇒ 取不到号）', async () => {
    const ctx = boot(true)
    await ctx.accountPool.setPermanentLocked('qodercn', true)
    const ref = 'QODERCN_ACCOUNT_RATELIMITED'
    const id = `qodercn-test-${Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '')}`
    await ctx.accountPool.addAccount({
      id, provider: 'qodercn', nickname: id, enabled: true, credentialRef: ref,
      createdAt: 0, refreshable: true, modelRateLimits: { qfmodel: Date.now() + 600_000 },
    })
    await ctx.credentials.set(credentialRef(ref), qoderCredential('tok-rl'))

    const outcome = await resolveOf(ctx, 'qodercn')('qfmodel')
      .then((v) => ({ kind: 'returned' as const, v }), () => ({ kind: 'threw' as const }))
    // 被限流的唯一账号被筛空 ⇒ 免费分支拿不到凭据 ⇒ 落余额分档 ⇒ 锁定 + 查不到 ⇒ 抛。
    // **绝不能**返回那个被限流账号的凭据。
    expect(outcome.kind, '免费不得绕开模型级限流标记').toBe('threw')
  }, 30_000)

  /**
   * ⚠️ **免费路径不得查询余额**（零网络）。
   *
   * 免费模型消耗 0 积分，没有「该烧哪个包」的选择问题 ⇒ 余额查询完全不必要。
   * 本家在**国际版网络不通时单账号要 10.7 秒**（`openapi.qoder.sh` 被阻断），
   * 白查一次余额就是白等 10.7 秒 —— 故这条不是洁癖，是用户可感知的延迟。
   *
   * 变异：删掉 `credential-resolver.ts` 的 `if (free)` 短路（或把免费判据恒
   * `false`）⇒ 落进余额分档 ⇒ 至少发一次请求 ⇒ 本条红。
   *
   * ⚠️ 与 `buddy-free-model-lock.spec.ts` 的同名组互补：那里证明「免费不被拦」，
   * 这里证明「免费连查都不查」。
   */
  it.each(QODER_PROVIDERS)(
    '%s：免费模型不查余额（零网络请求）',
    async (provider) => {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-qoder-free-net-'))
      dirs.push(dir)
      process.env.DSH_JET_HUB_STATE_DIR = dir
      let calls = 0
      vi.stubGlobal('fetch', async () => {
        calls += 1
        throw new Error('单测不发网络')
      })

      const ctx = new Context() as TestCtx
      ctx.provide('credentials', new FakeCredentials() as never)
      ctx.provide('commands', new FakeCommands() as never)
      ctx.provide('llm', new FakeLlm() as never)
      apply(ctx as never)
      for (const target of QODER_PROVIDERS) {
        const adapter = ctx.llm.adapterByProvider.get(target) as
          { isFreeModel?: (m?: string) => Promise<boolean> } | undefined
        if (adapter !== undefined && typeof adapter.isFreeModel === 'function') {
          adapter.isFreeModel = async () => true
        }
      }

      await ctx.accountPool.setPermanentLocked(provider, true)
      const ref = `${provider.toUpperCase()}_ACCOUNT_NONET`
      await addAccount(ctx, provider, ref)
      await ctx.credentials.set(credentialRef(ref), qoderCredential('tok-nonet'))

      const credential = await resolveOf(ctx, provider)('qfmodel')
      expect(credential, '免费模型必须取到凭据').toBeDefined()
      expect(calls, '免费模型不该发任何余额查询请求（国际版单账号 10.7 秒）').toBe(0)
    },
    30_000,
  )
})
