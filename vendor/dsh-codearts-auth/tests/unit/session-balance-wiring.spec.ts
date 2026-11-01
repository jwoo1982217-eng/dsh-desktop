/**
 * ZCode 会话负载均衡的**接线**回归：`accountSelection: 'session-balance'` 必须
 * 真的把 DSH 的 `sessionId` 传到池，而不是只停在纯函数里。
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createCredentialResolver, type ResolverPool } from '../../src/credential-resolver.js'
import { ZcodeAdapter } from '../../src/zcode-adapter.js'
import { ZCODE } from '../../src/zcode-product.js'

const PRODUCT = { id: 'zcode', displayName: 'ZCode (智谱)' }

function resolverPoolWithSession(): ResolverPool<{ token: string }> & {
  sessionCalls: Array<{ sessionId: string | undefined; exclude: string[] }>
} {
  const sessionCalls: Array<{ sessionId: string | undefined; exclude: string[] }> = []
  return {
    sessionCalls,
    listAccountsByProvider: () => [],
    permanentLocked: () => false,
    getAvailableAccount: async () => {
      throw new Error('session-balance 不应回落到手动顺序的 getAvailableAccount')
    },
    getAvailableAccountForSession: async (_provider, _modelId, sessionId, exclude) => {
      sessionCalls.push({ sessionId, exclude: [...(exclude ?? [])] })
      return { entry: { id: 'zcode-a', credentialRef: 'R' }, credential: { token: 'A' } }
    },
  }
}

describe('createCredentialResolver · session-balance 接线', () => {
  it('把 sessionId 传给池的 getAvailableAccountForSession', async () => {
    const pool = resolverPoolWithSession()
    const resolve = createCredentialResolver({ pool }, {
      product: PRODUCT,
      readCredential: async () => undefined,
      fallback: { kind: 'custom', resolve: async () => undefined },
      accountSelection: 'session-balance',
    })
    const credential = await resolve('GLM-5.3-Flash', 'session-xyz')
    expect(credential).toEqual({ token: 'A' })
    expect(pool.sessionCalls).toEqual([{ sessionId: 'session-xyz', exclude: [] }])
  })

  it('⚠️ `picked` 出参腿必须真的写入（2026-10-31 对抗审计 M6 补牙）', async () => {
    // ⚠️ 变异实测无牙后补：编排内部 `report()` 的 `selection.accountId` 腿被砍掉
    // （只剩进程级 `reportAccount`）时，既有用例全绿 —— 但那条腿正是 PR164 的
    // 承重动机：`deps.reportAccount` 是**进程级**回调（zcode 写
    // `activeZcodeAccountId` Map），多会话并发会互相覆盖 ⇒ 适配器把失败记到
    // 别的账号头上。本用例**不传** `reportAccount`（进程级腿缺席），
    // 只断言出参腿：变异后 `picked.accountId` 恒 undefined ⇒ 红。
    const pool = resolverPoolWithSession()
    const resolve = createCredentialResolver({ pool }, {
      product: PRODUCT,
      readCredential: async () => undefined,
      fallback: { kind: 'custom', resolve: async () => undefined },
      accountSelection: 'session-balance',
    })
    const picked: { accountId?: string } = {}
    await resolve('GLM-5.3-Flash', 'session-xyz', picked)
    expect(picked.accountId, 'picked 出参未写入 ⇒ 多会话并发时失败记账归属错账号')
      .toBe('zcode-a')
  })

  it('池没有 session 方法时回落 getAvailableAccount（兼容旧测试桩）', async () => {
    const calls: string[] = []
    const pool: ResolverPool<{ token: string }> = {
      listAccountsByProvider: () => [],
      permanentLocked: () => false,
      getAvailableAccount: async () => {
        calls.push('manual')
        return { entry: { id: 'zcode-a', credentialRef: 'R' }, credential: { token: 'A' } }
      },
    }
    const resolve = createCredentialResolver({ pool }, {
      product: PRODUCT,
      readCredential: async () => undefined,
      fallback: { kind: 'custom', resolve: async () => undefined },
      accountSelection: 'session-balance',
    })
    await resolve('GLM-5.3-Flash', 'session-xyz')
    expect(calls).toEqual(['manual'])
  })
})

describe('ZcodeAdapter 把 sessionId 继续往下传', () => {
  it('resolveCredentialOrThrow 调 resolveCredential 时带 model / sessionId，并取回本次账号 id', async () => {
    const resolveCredential = vi.fn(async (
      _modelId?: string,
      _sessionId?: string,
      picked?: { accountId?: string },
    ) => {
      if (picked !== undefined) picked.accountId = 'zcode-a'
      return { zcode_jwt: 'jwt', device_mid: 'mid' }
    })
    const adapter = new ZcodeAdapter({
      credentialRef: 'ZCODE_CREDENTIAL' as never,
      resolveCredential,
      refresh: async () => {},
      product: ZCODE,
    })
    const result = await (adapter as unknown as {
      resolveCredentialOrThrow: (options: { model: string; sessionId: string }) => Promise<{
        credential: { zcode_jwt: string }
        accountId: string | undefined
      }>
    }).resolveCredentialOrThrow({ model: 'GLM-5.3-Flash', sessionId: 'session-xyz' })
    expect(result.credential.zcode_jwt).toBe('jwt')
    expect(result.accountId).toBe('zcode-a')
    expect(resolveCredential).toHaveBeenCalledWith('GLM-5.3-Flash', 'session-xyz', expect.anything())
  })

  it('switchAccountOnQuota 用 getAvailableAccountForSession 并带 sessionId', async () => {
    const sessionCalls: Array<{ sessionId: string | undefined; exclude: string[] }> = []
    const pool = {
      updateModelRateLimit: async () => {},
      getAvailableAccountForSession: async (
        _provider: string,
        _model: string,
        sessionId: string | undefined,
        exclude: ReadonlySet<string>,
      ) => {
        sessionCalls.push({ sessionId, exclude: [...exclude] })
        return { entry: { id: 'zcode-b' }, credential: { zcode_jwt: 'jwt-B', device_mid: 'mid-B' } }
      },
    }
    const adapter = new ZcodeAdapter({
      credentialRef: 'ZCODE_CREDENTIAL' as never,
      resolveCredential: async () => ({ zcode_jwt: 'jwt-A', device_mid: 'mid-A' }),
      refresh: async () => {},
      product: ZCODE,
      accountPool: pool as never,
    })
    const next = await (adapter as unknown as {
      switchAccountOnQuota: (
        options: { model: string; sessionId: string },
        tried: Set<string>,
        activeAccountId: string | undefined,
      ) => Promise<{ accountId: string } | undefined>
    }).switchAccountOnQuota({ model: 'GLM-5.3-Flash', sessionId: 'session-xyz' }, new Set(['zcode-a']), 'zcode-a')
    expect(next?.accountId).toBe('zcode-b')
    expect(sessionCalls).toEqual([{ sessionId: 'session-xyz', exclude: ['zcode-a'] }])
  })

  it('★ refresh 后二次 resolveCredential 也带 sessionId（P2-4 补牙）', async () => {
    // ⚠️ 2026-10-31 对抗审计补牙：`resolveCredentialOrThrow` 的 refresh 分支
    // （凭据 undefined ⇒ refresh ⇒ 二次 resolve）丢 `options.sessionId` 时既有
    // 用例全绿 —— wiring 只测首次调用。会话亲和必须覆盖 refresh 后的重取，
    // 否则「凭据过期 + refresh」之后的请求静默退回随机分摊。
    const calls: Array<{ model?: string; sessionId?: string; pickedGiven: boolean }> = []
    const adapter = new ZcodeAdapter({
      credentialRef: 'ZCODE_CREDENTIAL' as never,
      resolveCredential: vi.fn(async (
        _modelId?: string,
        sessionId?: string,
        picked?: { accountId?: string },
      ) => {
        calls.push({ model: _modelId, sessionId, pickedGiven: picked !== undefined })
        if (calls.length === 1) return undefined // 触发 refresh 分支
        if (picked !== undefined) picked.accountId = 'zcode-r'
        return { zcode_jwt: 'jwt', device_mid: 'mid' }
      }),
      refresh: async () => {},
      product: ZCODE,
    })
    const result = await (adapter as unknown as {
      resolveCredentialOrThrow: (options: { model: string; sessionId: string }) => Promise<{ credential: { zcode_jwt: string } }>
    }).resolveCredentialOrThrow({ model: 'GLM-5.3-Flash', sessionId: 'session-refresh' })
    expect(result.credential.zcode_jwt).toBe('jwt')
    expect(calls).toHaveLength(2)
    expect(calls[0], '首次调用').toMatchObject({ sessionId: 'session-refresh', pickedGiven: true })
    expect(calls[1], 'refresh 后的二次调用必须同样带 sessionId 与出参（变异 M31 丢 sessionId 时此格 undefined ⇒ 红）')
      .toMatchObject({ sessionId: 'session-refresh', pickedGiven: true })
  })
})

/**
 * ⚠️ **装配点唯一性自检**（2026-10-31 对抗审计 P1-1 补牙）。
 *
 * ## 为什么必须存在
 *
 * 对抗审计实测：把 `src/index.ts` 里 zcode 的 `accountSelection:'session-balance'`
 * **删掉**、或**复制进 qoder 的 resolver 配置**，535+ 条测试全绿 —— PR 自述的
 * 「其余 provider 手动序语义逐字节不变」没有任何牙齿。扩散的后果是静默的：
 * qoder 等渠道的「手动顺序优先」被改成随机洗牌，无报错。
 *
 * 判据与 `credential-resolver.spec.ts` 的 `indexSource` 自检同款（装配事实只能
 * 源码自检；行为由上面的替身用例守）。
 */
describe('index.ts 的 accountSelection 装配点唯一性', () => {
  const indexSource = readFileSync(fileURLToPath(new URL('../../src/index.ts', import.meta.url)), 'utf8')
  const code = indexSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')

  it('★ 装配点恰好 1 个，且锚定在 zcode 装配块内', () => {
    const count = (code.match(/getAvailableAccountForSession<ZcodeCredential>/g) ?? []).length
    expect(count, `装配点 ${count} 个（应为 1）——删掉 = zcode 静默退回手动序；>1 = 别的渠道被静默改成随机分摊`).toBe(1)
    // 锚定在 zcode 装配块内：accountSelection 行必须出现在「ZCode 用户要求」注释
    // 与 registerZcodeLlm 的 zcode resolver 段附近（±60 行内有 zcode 标识）。
    const at = code.indexOf("getAvailableAccountForSession<ZcodeCredential>")
    const context = code.slice(Math.max(0, at - 2000), at + 2000)
    expect(
      /zcode/i.test(context),
      '唯一装配点不在 zcode 装配块附近 —— 被搬走/复制到别家了',
    ).toBe(true)
  })

  it('★ 负向：主流手动序渠道的 resolver 块不含该键（扩散即红）', () => {
    // 对抗审计 M11e/M26 的真实攻击面：复制进 qoder 的 createCredentialResolver 配置。
    // 判据：每个「product: X,」 resolver 配置块（X ≠ ZCODE）内不得出现 accountSelection。
    const blocks = [...code.matchAll(/createCredentialResolver<[^>]+>\(/g)].map(m => m.index!)
    expect(blocks.length, 'index.ts 里找不到 createCredentialResolver 调用点（结构漂移，请人工复核判据）').toBeGreaterThan(0)
    for (const start of blocks) {
      const block = code.slice(start, start + 4000)
      const productMatch = block.match(/product:\s*([A-Z_]+),/)
      if (productMatch === undefined || productMatch[1] === 'ZCODE') continue
      const end = block.indexOf('balance:', 0) > 0 ? block.indexOf('balance:') : Math.min(block.length, 3000)
      const head = block.slice(0, end)
      expect(
        /accountSelection/.test(head),
        `product=${productMatch[1]} 的 resolver 配置含 accountSelection ⇒ 该渠道被静默改成会话随机分摊`,
      ).toBe(false)
    }
  })
})
