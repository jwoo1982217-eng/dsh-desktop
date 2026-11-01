/**
 * MiniMax / 国际站**同账号去重**的守卫（2026-10-25 合并审计补修）。
 *
 * ## 为什么这个文件必须存在
 *
 * 审计实测：`!147` 加的整块去重**零守卫** —— 把它整块删掉，全量 445 个 spec
 * / 10791 条用例**全绿**（`tests/` 里对 `findAccountIdByIdentityField` 的引用只
 * 出现在 officeace 与 zcode 两个文件）。也就是说：这段「防止一个号无限建卡」的
 * 逻辑可以完全消失而无人察觉。
 *
 * ## 守的四条不变量（对应 `dedupeMinimaxAccount` 的四种结局）
 *
 * | # | 不变量 | 违反的后果（审计实测/推断） |
 * |---|--------|--------------------------|
 * | 1 | 命中**启用**原卡 ⇒ 新卡停用、**凭据转写回原卡**、清掉重复卡凭据 | 两条续期链 ⇒ refresh_token 轮换时互相作废（本 PR 要治的症状） |
 * | 2 | 命中**已停用**原卡 ⇒ **反转**（新卡可用、原卡标重复并停用） | 两张卡全停用 ⇒ `getAvailableAccount()` 返回 null，而 `login.poll` 报成功 ⇒ 零可用号 |
 * | 3 | 拿不到 `user_id` / 读池失败 ⇒ **不做任何破坏性动作** | 删号、清凭据都是不可逆的（「读不到 ≠ 没有」） |
 * | 4 | 凭据转写**失败**时绝不清重复卡的凭据 | 唯一活凭据被销毁，该号彻底不可用 |
 *
 * ⚠️ 全部判据都是**行为级**：真跑 `dedupeMinimaxAccount`，断言凭据库与账号池
 * 的最终形态（含「哪个 ref 里还有值」），而不是源码文本。
 */

import { describe, expect, it, vi } from 'vitest'

import { dedupeMinimaxAccount, type MinimaxDedupDeps } from '../../src/minimax-dedup.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ProviderAccountEntry } from '../../src/types.js'

/* ────────────────────────── 替身 ────────────────────────── */

interface Harness {
  deps: MinimaxDedupDeps
  entries: ProviderAccountEntry[]
  store: Map<string, string>
  warns: string[]
  updates: Array<{ id: string; patch: Record<string, unknown> }>
}

function makeHarness(options: {
  entries: Array<Partial<ProviderAccountEntry> & { id: string; credentialRef: string }>
  credentials: Record<string, string>
  identityIndex?: Record<string, string>
  lookupThrows?: boolean
  copyThrows?: boolean
}): Harness {
  const entries = options.entries.map(entry => ({
    provider: 'minimax',
    enabled: true,
    refreshable: true,
    ...entry,
  })) as ProviderAccountEntry[]
  const store = new Map<string, string>(Object.entries(options.credentials))
  const warns: string[] = []
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  const deps: MinimaxDedupDeps = {
    pool: {
      findAccountIdByIdentityField: async (_provider, _field, identity) => {
        if (options.lookupThrows === true) throw new Error('池不可用')
        return options.identityIndex?.[identity] ?? ''
      },
      findAccount: (id: string) => entries.find(entry => entry.id === id),
      updateAccount: async (id, patch) => {
        updates.push({ id, patch: patch as Record<string, unknown> })
        const target = entries.find(entry => entry.id === id)
        if (target !== undefined) Object.assign(target, patch)
      },
    },
    credentials: {
      resolve: async ref => {
        const value = store.get(String(ref))
        return value === undefined ? undefined : { value }
      },
      set: async (ref, value) => {
        if (options.copyThrows === true && String(ref).includes('KEEP')) throw new Error('写凭据失败')
        store.set(String(ref), value)
      },
      unset: async ref => { store.delete(String(ref)) },
    },
    logger: { warn: message => { warns.push(String(message)) } },
  }
  return { deps, entries, store, warns, updates }
}

const FRESH = JSON.stringify({
  access_token: 'mmoat_NEW',
  refresh_token: 'rt_NEW',
  nicknock: undefined,
  nickname: 'MiniMax909127',
  user_id: 'ZDxY6oEjmoaX',
})

function args(overrides: Partial<Parameters<typeof dedupeMinimaxAccount>[1]> = {}) {
  return {
    providerId: 'minimax',
    newAccountId: 'minimax-new',
    newCredentialRefName: 'MINIMAX_ACCOUNT_NEW',
    identity: 'ZDxY6oEjmoaX',
    nickname: 'MiniMax909127',
    expiresAtMs: 1_700_000_000_000,
    refreshable: true,
    ...overrides,
  }
}

/* ────────────────── 一、正常重复：转写 + 清重复凭据 ────────────────── */

describe('★★ 命中启用原卡：新卡停用、凭据转写回原卡、清掉重复卡凭据', () => {
  it('★★ 三种后果同时断言（停用 / 转写 / 清除），少任何一条都不算修好', async () => {
    const h = makeHarness({
      entries: [
        { id: 'minimax-old', credentialRef: 'MINIMAX_ACCOUNT_KEEP' },
        { id: 'minimax-new', credentialRef: 'MINIMAX_ACCOUNT_NEW' },
      ],
      credentials: {
        MINIMAX_ACCOUNT_KEEP: JSON.stringify({ access_token: 'mmoat_OLD', user_id: 'ZDxY6oEjmoaX' }),
        MINIMAX_ACCOUNT_NEW: FRESH,
      },
      identityIndex: { ZDxY6oEjmoaX: 'minimax-old' },
    })

    const result = await dedupeMinimaxAccount(h.deps, args())

    expect(result.outcome).toBe('duplicate')
    expect(result.retainedAccountId).toBe('minimax-old')
    // ① 新卡停用 + 改名（不删条目 —— 删掉会让 login.poll 把成功显示成失败）
    const created = h.entries.find(entry => entry.id === 'minimax-new')!
    expect(created.enabled).toBe(false)
    expect(created.nickname).toContain('重复，已停用')
    // ② 新鲜凭据真的搬到了保留卡（不是只把新卡停用了事）
    const kept = h.store.get('MINIMAX_ACCOUNT_KEEP')
    expect(kept, '保留卡上还是旧凭据 ⇒ 两条续期链仍然存在（refresh_token 轮换会互相作废）')
      .toBe(FRESH)
    // ③ 重复卡的凭据被清掉（否则它停用了仍会被续期调度器续期）
    expect(h.store.get('MINIMAX_ACCOUNT_NEW'), '重复卡凭据没清 ⇒ 同一账号两条续期链').toBeUndefined()
    // ④ 保留卡承接「可续期 + 新到期时刻」
    expect(h.entries.find(entry => entry.id === 'minimax-old')!.expiresAt).toBe(1_700_000_000_000)
  })
})

/* ────────────────── 二、反转腿：原卡被用户停用 ────────────────── */

describe('★★ 命中已停用原卡：必须反转，否则零可用号', () => {
  it('★★ 反转后新卡可用、原卡标重复并停用（不是两张都停用）', async () => {
    const h = makeHarness({
      entries: [
        { id: 'minimax-old', credentialRef: 'MINIMAX_ACCOUNT_KEEP', enabled: false },
        { id: 'minimax-new', credentialRef: 'MINIMAX_ACCOUNT_NEW', enabled: true },
      ],
      credentials: {
        MINIMAX_ACCOUNT_KEEP: JSON.stringify({ access_token: 'mmoat_OLD', user_id: 'ZDxY6oEjmoaX' }),
        MINIMAX_ACCOUNT_NEW: FRESH,
      },
      identityIndex: { ZDxY6oEjmoaX: 'minimax-old' },
    })

    const result = await dedupeMinimaxAccount(h.deps, args())

    expect(result.outcome).toBe('reversed')
    expect(result.retainedAccountId).toBe('minimax-new')
    // ⚠️ 核心：必须恰好有一张可用卡（改前是 0 张 ⇒ getAvailableAccount() 返回 null）
    const enabled = h.entries.filter(entry => entry.enabled === true)
    expect(enabled.map(entry => entry.id), '反转失败：池里零可用卡，而 login.poll 仍报登录成功')
      .toEqual(['minimax-new'])
    // 原卡标重复并停用（用户能看出这张作废了）
    const old = h.entries.find(entry => entry.id === 'minimax-old')!
    expect(old.enabled).toBe(false)
    expect(old.nickname).toContain('重复，已停用')
    // 反转形态下凭据本来就留在新卡：**不得**清它
    expect(h.store.get('MINIMAX_ACCOUNT_NEW')).toBe(FRESH)
  })
})

/* ────────────────── 三、不做破坏性动作的三种情形 ────────────────── */

describe('★★ 拿不到身份 / 读池失败 / 同一个 id：一律不动作', () => {
  it('★★ 没有 user_id ⇒ 放弃去重（绝不猜），且一次池查询都不发', async () => {
    const h = makeHarness({
      entries: [{ id: 'minimax-old', credentialRef: 'MINIMAX_ACCOUNT_KEEP' }],
      credentials: { MINIMAX_ACCOUNT_KEEP: '{}', MINIMAX_ACCOUNT_NEW: FRESH },
    })
    const spy = vi.spyOn(h.deps.pool, 'findAccountIdByIdentityField')
    const result = await dedupeMinimaxAccount(h.deps, args({ identity: undefined }))
    expect(result.outcome).toBe('skipped-no-identity')
    expect(spy).not.toHaveBeenCalled()
    expect(h.updates).toHaveLength(0)
    expect(h.store.get('MINIMAX_ACCOUNT_NEW')).toBe(FRESH)
  })

  it('★★ 读池抛错 ⇒ 不做任何不可逆动作（不删号、不清凭据）', async () => {
    const h = makeHarness({
      entries: [{ id: 'minimax-old', credentialRef: 'MINIMAX_ACCOUNT_KEEP' }],
      credentials: { MINIMAX_ACCOUNT_KEEP: '{}', MINIMAX_ACCOUNT_NEW: FRESH },
      identityIndex: { ZDxY6oEjmoaX: 'minimax-old' },
      lookupThrows: true,
    })
    const result = await dedupeMinimaxAccount(h.deps, args())
    expect(result.outcome).toBe('error')
    expect(h.updates).toHaveLength(0)
    expect(h.store.get('MINIMAX_ACCOUNT_NEW'), '读池失败却把凭据清了 ⇒ 该号彻底不可用').toBe(FRESH)
    expect(h.warns.join('\n')).toContain('查重失败')
  })

  it('★ 查到的就是本次新建的那张 ⇒ 不算重复', async () => {
    const h = makeHarness({
      entries: [{ id: 'minimax-new', credentialRef: 'MINIMAX_ACCOUNT_NEW' }],
      credentials: { MINIMAX_ACCOUNT_NEW: FRESH },
      identityIndex: { ZDxY6oEjmoaX: 'minimax-new' },
    })
    const result = await dedupeMinimaxAccount(h.deps, args())
    expect(result.outcome).toBe('skipped-not-duplicate')
    expect(h.updates).toHaveLength(0)
  })
})

/* ────────────────── 四、转写失败时的数据保全 ────────────────── */

describe('★★ 凭据转写失败：宁可留两条链，也绝不销毁唯一活凭据', () => {
  it('★★ 转写抛错 ⇒ 仍停用重复卡，但**不清**它的凭据，并如实告警', async () => {
    const h = makeHarness({
      entries: [
        { id: 'minimax-old', credentialRef: 'MINIMAX_ACCOUNT_KEEP' },
        { id: 'minimax-new', credentialRef: 'MINIMAX_ACCOUNT_NEW' },
      ],
      credentials: {
        MINIMAX_ACCOUNT_KEEP: JSON.stringify({ access_token: 'mmoat_OLD' }),
        MINIMAX_ACCOUNT_NEW: FRESH,
      },
      identityIndex: { ZDxY6oEjmoaX: 'minimax-old' },
      copyThrows: true,
    })
    const result = await dedupeMinimaxAccount(h.deps, args())
    expect(result.outcome).toBe('duplicate')
    expect(h.store.get('MINIMAX_ACCOUNT_NEW'), '转写失败却清了重复凭据 ⇒ 唯一活凭据被销毁').toBe(FRESH)
    expect(h.entries.find(entry => entry.id === 'minimax-new')!.enabled).toBe(false)
    expect(h.warns.join('\n')).toContain('两条续期链')
  })
})
