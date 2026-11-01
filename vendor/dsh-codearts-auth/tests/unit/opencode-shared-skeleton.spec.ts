/**
 * ★★ **opencode 的目录必须由共享骨架接管**（2026-10-23 迁移规格）。
 *
 * ## 迁移前的手写形态（已删除）
 *
 * `OpencodeAdapter.listModels` 自己做了四件事：判 `providerClosed`、槽位门控、
 * 「只有匿名身份时只给免费模型」、过滤 `disabledModels` + 手工 map。
 * 前四件里「关闭意图 / 黑名单 / 模态回填 / provider 回填」与其余 13 家**逐字同义**，
 * 各写一份正是 Gitee IKP8OF 那类漂移缺陷的温床。
 *
 * ## 本文件守什么
 *
 * ① 迁移后**用户可见后果不变**：黑名单 / 关闭意图 / 匿名只有免费模型 / 无槽位即空；
 * ② **本家独有的可见性口径不得丢**（这是迁移最容易静默弄丢的一条）。
 *
 * ⚠️ 每条都带对照组，防「空数组断言恒真」。
 */
import { describe, expect, it } from 'vitest'
import { OpencodeAdapter, clearOpencodeCatalogCache } from '../../src/opencode-adapter.js'
import { OPENCODE, OPENCODE_FALLBACK_MODELS } from '../../src/opencode-product.js'
import type { IdentitySlot } from '../../src/opencode-auth.js'
import type { AccountPool } from '../../src/account-pool.js'

function makePool(options: {
  disabled?: readonly string[]
  closed?: boolean
} = {}): AccountPool {
  return {
    disabledModelsFor: () => new Set(options.disabled ?? []),
    providerClosedFor: () => options.closed ?? false,
  } as never
}

function accountSlot(): IdentitySlot {
  return { id: 'a1', kind: 'account', apiKey: 'sk-real-key' } as IdentitySlot
}

function anonymousSlot(): IdentitySlot {
  return { id: 'anon', kind: 'anonymous', apiKey: OPENCODE.anonymousKey } as IdentitySlot
}

function makeAdapter(
  pool: AccountPool,
  slots: readonly IdentitySlot[],
): OpencodeAdapter {
  clearOpencodeCatalogCache()
  return new OpencodeAdapter({
    product: OPENCODE,
    accountPool: pool,
    identitySlots: async () => slots,
    // ⚠️ 不给 `fetchRemoteCatalog` ⇒ 走兜底表（确定性、无网络）。
  } as never)
}

describe('★★ opencode 迁移到共享骨架：用户可见后果不变', () => {
  it('★★ 池里的黑名单模型不出现在 listModels，其余仍在', async () => {
    const target = OPENCODE_FALLBACK_MODELS[0]!
    const adapter = makeAdapter(makePool({ disabled: [target.id] }), [accountSlot()])
    const ids = (await adapter.listModels(OPENCODE.id)).map((m) => m.id)

    expect(ids.length, '对照失败：目录本就为空 ⇒ 本用例会假绿').toBeGreaterThan(0)
    expect(ids, '★ 池里的黑名单没生效 ⇒ 关掉的模型仍可选').not.toContain(target.id)
  })

  it('★★ 关闭整个供应商 ⇒ listModels 恒空', async () => {
    const open = await makeAdapter(makePool(), [accountSlot()]).listModels(OPENCODE.id)
    expect(open.length, '对照失败：未关闭时目录本就为空').toBeGreaterThan(0)

    const shut = await makeAdapter(makePool({ closed: true }), [accountSlot()])
      .listModels(OPENCODE.id)
    expect(shut, '★★ 关闭供应商后 opencode 仍播出模型 ⇒ 选择器里照样能选').toEqual([])
  })

  /**
   * ★★ **本家独有的可见性口径**：只有匿名身份时只给免费模型。
   *
   * ⚠️ 这是迁移最容易丢掉的一条（它不在骨架里，必须搬进 `loadCatalog`）。
   */
  it('★★ 只有匿名身份 ⇒ 只播免费模型（本家独有口径，迁移不得丢）', async () => {
    const adapter = makeAdapter(makePool(), [anonymousSlot()])
    const listed = await adapter.listModels(OPENCODE.id)
    const ids = listed.map((m) => m.id)

    const freeIds = OPENCODE_FALLBACK_MODELS.filter((m) => m.isFree).map((m) => m.id)
    const paidIds = OPENCODE_FALLBACK_MODELS.filter((m) => !m.isFree).map((m) => m.id)
    expect(freeIds.length, '兜底表里没有免费模型 ⇒ 本用例无法判别').toBeGreaterThan(0)
    expect(paidIds.length, '兜底表里没有付费模型 ⇒ 本用例无法判别').toBeGreaterThan(0)

    expect(ids.every((id) => freeIds.includes(id)), '★★ 匿名身份下播出了付费模型').toBe(true)
    expect(ids.length, '★★ 匿名身份下一条免费模型都没播 ⇒ 过滤过头').toBeGreaterThan(0)
  })

  it('★ 有账号身份 ⇒ 免费与付费都播（对照：上一条的过滤确有来源）', async () => {
    const ids = (await makeAdapter(makePool(), [accountSlot()])
      .listModels(OPENCODE.id)).map((m) => m.id)
    const paidIds = OPENCODE_FALLBACK_MODELS.filter((m) => !m.isFree).map((m) => m.id)
    expect(ids.some((id) => paidIds.includes(id)), '★ 有账号时付费模型也必须可见').toBe(true)
  })

  it('★ 无任何槽位 ⇒ 目录为空（隐藏 provider 分组，既有语义不得丢）', async () => {
    const listed = await makeAdapter(makePool(), []).listModels(OPENCODE.id)
    expect(listed, '★ 无槽位仍播模型 ⇒ 给出一个必然失败的模型选项').toEqual([])
  })

  it('★ 全量视图不套黑名单（设置页要看得到已关闭模型的开关）', async () => {
    const target = OPENCODE_FALLBACK_MODELS[0]!
    const adapter = makeAdapter(makePool({ disabled: [target.id] }), [accountSlot()])
    expect(adapter.listAllModels().map((m) => m.id)).toContain(target.id)
  })
})
