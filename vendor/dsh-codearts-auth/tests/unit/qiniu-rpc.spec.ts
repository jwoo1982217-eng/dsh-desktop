/**
 * qiniu 专用 RPC（`qiniu.addAccount` / `qiniu.setApiKey`）的守卫。
 *
 * ## 锁的四件事
 *
 * ① **形状闸门不绑死 `sk-` 前缀**（opencode Issue IKPLRU 实测过：上游换发前缀后
 *    旧闸门把新 Key 全数拒收，用户一个账号都加不进来）；
 * ② 重复 Key **必须复用**同一账号（否则同一个额度桶被当成两个，限额时一起跳过）；
 * ③ 改 Key 导致 id 变化时**先建后删**（反过来若新建失败，用户连旧账号一起丢）；
 * ④ 不认识的方法返回 `undefined` 而不是错误信封（否则别家的方法名会被误判成
 *    「格式错误」而不是「没这个方法」）。
 */

import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  handleQiniuRpc,
  isQiniuAccountRef,
  qiniuSlotNamesOf,
} from '../../src/qiniu-rpc.js'

const KEY_A = 'qiniu-AAAAAAAAAAAAAAA1111'
const KEY_B = 'qiniu-BBBBBBBBBBBBBBBB2222'

interface FakeAccount { id: string; enabled: boolean; credentialRef: string; nickname?: string }

/** 记账用的最小 ctx / pool 替身：记录调用顺序，便于断言「先建后删」。 */
function makeHarness(seed: FakeAccount[] = []) {
  const accounts: FakeAccount[] = [...seed]
  const credentials = new Map<string, string>()
  const ops: string[] = []
  const ctx = {
    credentials: {
      set: async (ref: string, value: string) => { credentials.set(String(ref), value); ops.push('cred:' + String(ref)) },
    },
  }
  const pool = {
    listAccountsByProvider: (provider: string) => (provider === 'qiniu' ? accounts : []),
    addAccount: async (entry: FakeAccount) => { accounts.push(entry); ops.push('add:' + entry.id) },
    removeAccount: async (id: string) => {
      const at = accounts.findIndex((a) => a.id === id)
      if (at >= 0) accounts.splice(at, 1)
      ops.push('remove:' + id)
    },
  }
  return { ctx, pool, accounts, credentials, ops }
}

describe('qiniuSlotNamesOf：id 与 ref 由 Key 尾 8 位派生', () => {
  it('同 Key 恒得同一组 id/ref（重复添加因此能去重）', () => {
    const a = qiniuSlotNamesOf(KEY_A)
    expect(qiniuSlotNamesOf(KEY_A)).toEqual(a)
    expect(qiniuSlotNamesOf(KEY_B).id).not.toBe(a.id)
  })

  it('★★ 末 8 位含 `.`/`-` 的 Key ⇒ ref 仍是合法标识符（否则 credentialRef 直接抛）', () => {
    // 形状闸 `KEY_PATTERN` 放行 `[A-Za-z0-9_.-]`（刻意不绑死前缀），而宿主
    // `credentialRef()` 只认 `/^[A-Za-z_][A-Za-z0-9_]*$/`。旧实现直接拼尾段
    // ⇒ `QINIU_ACCOUNT_BBB-CCDD` 一进 credentialRef 就抛
    //   `credential ref "…" must match /^[A-Za-z_][A-Za-z0-9_]*$/`
    // ⇒ 任何这样的 Key 都加不进账号，用户只看到一句英文正则。
    // 判据必须打到**真 credentialRef()** 上：用 Map 替身会吞掉这个 TypeError
    // （这正是本缺陷此前全绿的成因）。
    for (const apiKey of [
      'QQQQQQQQQQQQQQQ.bbb-ccdd',
      'WWWWWWWWWWWWWWW.XYZ-9999',
      'EEEEEEEEEEEEEEE_______', // 纯下划线尾段：合法标识符，不该被归一化
    ]) {
      const { id, refName } = qiniuSlotNamesOf(apiKey)
      expect(refName, `「${apiKey}」派生出的 ref 不是合法标识符`)
        .toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
      expect(() => credentialRef(refName), '真 credentialRef 抛错 ⇒ 账号永远加不进来').not.toThrow()
      expect(credentialRef(refName)).toBe(refName)
      // id 侧不受影响（id 不是标识符，允许带 `-`）
      expect(id).toBe('qiniu-' + apiKey.slice(-8).toLowerCase())
    }
  })

  it('★★ 归一化后同名但 Key 不同的两条不得撞成同一个 ref（撞了会互相覆盖凭据）', () => {
    // `…bbb-ccdd`（要归一化）与 `…bbb_ccdd`（本来就合法）归一化后裸尾段相同；
    // 若归一化那条只剥字符不加哈希，两条会得到同一个 ref ⇒ 后加的 Key 覆盖
    // 前一条的凭据（账号还在，但连的已经是另一个 Key）。哈希腿就是为这一格加的。
    const dashed = qiniuSlotNamesOf('QQQQQQQQQQQQQQQ.bbb-ccdd')
    const underscored = qiniuSlotNamesOf('WWWWWWWWWWWWWWW.bbb_ccdd')
    expect(dashed.refName).not.toBe(underscored.refName)
    // ⚠️ 反过来：**尾 8 位完全相同的两条 Key 仍复用同一账号**（按尾段派生是本
    //    设计的一部分，不是缺陷）—— 这一格刻意断言相等，防止把去重逻辑改坏。
    expect(qiniuSlotNamesOf('AAAAAAA_bbb_ccdd').refName)
      .toBe(qiniuSlotNamesOf('BBBBBBB_bbb_ccdd').refName)
  })

  it('★ 尾段本来就合法的 Key ⇒ ref 逐字节不变（保护存量凭据引用）', () => {
    // 老账号的 credentialRef 是 `QINIU_ACCOUNT_<尾8大写>`；若把合法尾段也
    // 加上哈希后缀，全部存量账号会被当成新账号另建一条（凭据不再被引用）。
    expect(qiniuSlotNamesOf(KEY_A).refName).toBe('QINIU_ACCOUNT_' + KEY_A.slice(-8).toUpperCase())
  })

  it('★ ref 前缀必须是 QINIU（jet-hub-store 的 REF_PREFIX_TO_PROVIDER 靠它反推）', () => {
    const { id, refName } = qiniuSlotNamesOf(KEY_A)
    expect(refName.startsWith('QINIU_ACCOUNT_'), 'REFIX 前缀漏登记 ⇒ 账号在 state.json 缺失时静默消失')
      .toBe(true)
    expect(isQiniuAccountRef(refName)).toBe(true)
    expect(id).toBe('qiniu-' + KEY_A.slice(-8).toLowerCase())
  })
})

describe('qiniu.addAccount', () => {
  it('★ 合法 Key：写凭据（字段名 access_token）+ 落池（refreshable:false）', async () => {
    const h = makeHarness()
    const result = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.addAccount', { apiKey: KEY_A }) as any
    expect(result.ok).toBe(true)
    expect(result.value.existed).toBe(false)
    const { id, refName } = qiniuSlotNamesOf(KEY_A)
    expect(result.value.accountId).toBe(id)
    // ⚠️ 字段名必须是 access_token（AccountPool 身份反查按它取，改成 api_key 会静默匹配失败）。
    const stored = JSON.parse([...h.credentials.values()][0]!)
    expect(stored.access_token).toBe(KEY_A)
    const entry = h.accounts.find((a) => a.id === id)!
    expect(entry.credentialRef).toBe(refName)
    expect(entry.enabled).toBe(true)
    expect(entry.refreshable, '七牛云没有 refresh 端点 ⇒ 标 true 是永不发生的承诺').toBe(false)
  })

  it('★★ 同一 Key 加两次 ⇒ 复用同一账号（existed:true），不落第二份', async () => {
    const h = makeHarness()
    await handleQiniuRpc(h.ctx, h.pool, 'qiniu.addAccount', { apiKey: KEY_A })
    const second = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.addAccount', { apiKey: KEY_A }) as any
    expect(second.value.existed).toBe(true)
    expect(h.accounts.length, '同 Key 被当成两个账号 ⇒ 同一份额度被重复计入').toBe(1)
  })

  it('★ 形状不合法 ⇒ bad-request，且不写凭据不落池', async () => {
    const h = makeHarness()
    for (const apiKey of ['', 'short', 'has space in it 1234', 'sk-中文中文中文中文']) {
      const result = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.addAccount', { apiKey }) as any
      expect(result.ok, `「${apiKey}」不该通过形状闸门`).toBe(false)
      expect(result.error.code).toBe('bad-request')
    }
    expect(h.accounts).toEqual([])
    expect(h.credentials.size).toBe(0)
  })

  it('★ 形状闸门不绑死 sk- 前缀（上游换发前缀时不得把新 Key 全数拒收）', async () => {
    const h = makeHarness()
    const oc = 'zz_newprefix_abcdefghijklmnop1234'
    const result = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.addAccount', { apiKey: oc }) as any
    expect(result.ok, 'Issue IKPLRU：绑死 ^sk- 会让换发前缀的新 Key 一个都加不进来').toBe(true)
  })
})

describe('qiniu.setApiKey', () => {
  it('★ 同一条 Key：只刷凭据，renamed:false，账号数不变', async () => {
    const h = makeHarness()
    const added = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.addAccount', { apiKey: KEY_A }) as any
    const result = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.setApiKey', {
      accountId: added.value.accountId,
      apiKey: KEY_A,
    }) as any
    expect(result.ok).toBe(true)
    expect(result.value.renamed).toBe(false)
    expect(h.accounts.length).toBe(1)
    // ⚠️ 打码串绝不回传明文。
    expect(result.value.masked).not.toBe(KEY_A)
    expect(result.value.masked).toContain('…')
  })

  it('★★ Key 变了 ⇒ i d随尾段变：先建后删，且删除在新建之后', async () => {
    const h = makeHarness()
    const added = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.addAccount', { apiKey: KEY_A }) as any
    const oldId = added.value.accountId
    h.ops.length = 0
    const result = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.setApiKey', {
      accountId: oldId,
      apiKey: KEY_B,
    }) as any
    expect(result.ok).toBe(true)
    expect(result.value.renamed).toBe(true)
    expect(result.value.accountId).toBe(qiniuSlotNamesOf(KEY_B).id)
    // ⚠️ 顺序必须是「先建后删」：反过来若新建失败，用户连旧账号一起丢（删除不可逆）。
    const addAt = h.ops.findIndex((o) => o.startsWith('add:'))
    const removeAt = h.ops.findIndex((o) => o.startsWith('remove:'))
    expect(addAt, '没有新建').toBeGreaterThanOrEqual(0)
    expect(removeAt, '旧账号没有被移除 ⇒ 两个账号共用一份凭据的错象').toBeGreaterThan(addAt)
    expect(h.accounts.map((a) => a.id)).toEqual([qiniuSlotNamesOf(KEY_B).id])
  })

  it('★ 停用状态与昵称**继承**旧的（改 Key 不该顺手启用/改名）', async () => {
    const h = makeHarness()
    const added = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.addAccount', {
      apiKey: KEY_A,
      nickname: '我的号',
    }) as any
    // 手动把账号改成停用，模拟用户在面板上关掉它。
    h.accounts[0]!.enabled = false
    await handleQiniuRpc(h.ctx, h.pool, 'qiniu.setApiKey', {
      accountId: added.value.accountId,
      apiKey: KEY_B,
    })
    const next = h.accounts[0]!
    expect(next.enabled, '用户特意关掉的账号被改 Key 顺手启用了').toBe(false)
    expect(next.nickname).toBe('我的号')
  })

  it('★ 目标 Key 已对应另一账号 ⇒ 报错，不动任何状态', async () => {
    const h = makeHarness()
    const a = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.addAccount', { apiKey: KEY_A }) as any
    await handleQiniuRpc(h.ctx, h.pool, 'qiniu.addAccount', { apiKey: KEY_B })
    const before = JSON.stringify(h.accounts)
    const result = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.setApiKey', {
      accountId: a.value.accountId,
      apiKey: KEY_B,
    }) as any
    expect(result.ok).toBe(false)
    expect(JSON.stringify(h.accounts), '报错路径不得留下半改状态').toBe(before)
  })

  it('账号不存在 / 缺 accountId ⇒ bad-request', async () => {
    const h = makeHarness()
    const noId = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.setApiKey', { apiKey: KEY_A }) as any
    expect(noId.ok).toBe(false)
    const missing = await handleQiniuRpc(h.ctx, h.pool, 'qiniu.setApiKey', {
      accountId: 'qiniu-nope',
      apiKey: KEY_A,
    }) as any
    expect(missing.ok).toBe(false)
  })
})

describe('方法归属', () => {
  it('★★ 不认识的方法返回 undefined（不是错误信封），让主 switch 继续匹配', async () => {
    const h = makeHarness()
    // ⚠️ 回信封的后果：别的 provider 的方法名会被判成「格式错误」而不是「没这个方法」。
    await expect(handleQiniuRpc(h.ctx, h.pool, 'modelscope.addAccount', {})).resolves.toBeUndefined()
    await expect(handleQiniuRpc(h.ctx, h.pool, 'account.create', {})).resolves.toBeUndefined()
  })
})
describe('★ 端到端：经真实 registerJetHubRpc 驱动（守卫 handleMethod 的改道）', () => {
  it('★★ qiniu.addAccount 不再回 unknown method（改道必须排在主 switch 之前）', async () => {
    const { registerJetHubRpc, JET_HUB_API_PATH } = await import('../../src/jet-hub-rpc.js')
    let handler: ((request: Request) => Promise<Response>) | undefined
    const ctx = {
      connection: {
        fetch: {
          register: (config: { path: string; fetch: (r: Request) => Promise<Response> }) => {
            if (config.path === JET_HUB_API_PATH) handler = config.fetch
          },
        },
      },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      credentials: {
        resolve: async () => undefined,
        describe: async () => ({ configured: false }),
        set: async () => {},
      },
      get: () => undefined,
      inject: (_deps: string[], cb: (c: unknown) => void) => { cb(ctx) },
    }
    const pool = {
      listAccountsByProvider: () => [],
      addAccount: async () => {},
      listAllAccounts: async () => [],
      listAccounts: async () => [],
      updateAccount: async () => {},
    }
    registerJetHubRpc(ctx as never, pool as never, { qiniu: {} } as never)
    expect(handler, 'jet-hub 的 fetch 通道没有注册').toBeDefined()
    const res = await handler!(new Request('http://127.0.0.1/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r1',
        method: 'jet-hub',
        payload: { method: 'qiniu.addAccount', payload: { apiKey: KEY_A } },
      }),
    }))
    const body = await res.json() as { result: { ok: boolean; error?: { message?: string } } }
    expect(
      body.result.ok,
      'qiniu.addAccount 未被改道（落进主 switch 的 default ⇒ unknown method）：'
      + (body.result.error?.message ?? ''),
    ).toBe(true)
  })
})
