/**
 * CodeArts 目录的**消耗倍率**展示（PR !133，2026-10-21）。
 *
 * ## 为什么单独成文件（而不是塞进 `llm-adapter.spec.ts`）
 *
 * 合并审计发现：PR !133 的**唯一用户可见改动**（把倍率拼进目录展示名）
 * **零测试覆盖** —— 把整段拼接换成 `const name = model.name`（等价回退到
 * PR 之前），`models.spec` / `llm-adapter.spec` / `model-catalog-parity.spec` /
 * `aggregate-adapter.spec` / `catalog-fresh-adapters.spec` 五个 spec
 * **全绿**（实测 357 条）。
 *
 * ⇒ 本文件补上那三条**能变红**的守卫。
 *
 * ## 三条守卫各自的「有牙」判据
 *
 * | 守卫 | 若把生产代码改坏 | 为什么有牙 |
 * |---|---|---|
 * | ① `listModels` 的 name 带倍率 | 删掉拼接 ⇒ name 变裸名 | 断言的是**拼接后的完整串** |
 * | ② `resolveModel` 的 name 是**裸名** | 删掉 `bareName` ⇒ 回退到带倍率的 name | 断言 `not.toContain(' · ')` |
 * | ③ 倍率形态是仓内口径 ` · x{n}` | 保留上游原串 ` · 0.7x` ⇒ 解析层读不到 | 断言形态 + 用 `priceFactorFromName` 实测解析值 |
 *
 * ⚠️ ③ 必须**同时**断言「形态」与「能被 `priceFactorFromName` 解析出来」——
 * 只断言形态的话，将来有人把仓内口径又改回 `0.7x`（形态断言会红，但
 * 若同时改了断言就会假绿）；只断言解析值的话，形态对不上但数字对的
 * 情况（如 `x 0.7` 带空格）就漏了。
 */
import { describe, expect, it } from 'vitest'
import { CodeArtsAdapter, codeartsRateSuffix } from '../../src/llm-adapter.js'
import { priceFactorFromName } from '../../src/aggregate-core.js'
import type { CodeArtsCredential } from '../../src/types.js'

const validCredential: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** 造一个只关心远端目录的适配器（凭据解析恒成功）。 */
function makeAdapter(remote: Array<{ id: string; name: string; rateLabel?: string }>) {
  return new CodeArtsAdapter({
    credentialRef: 'CODEARTS_ACCESS_TOKEN',
    resolveCredential: async () => validCredential,
    refresh: async () => {},
    fetchImpl: async () => new Response('not found', { status: 404 }),
    fetchRemoteModels: async () => remote,
  })
}

describe('CodeArts 目录的消耗倍率展示（PR !133）', () => {
  /**
   * 守卫 ①：`listModels` 的展示名**带倍率**。
   *
   * ⚠️ 上游 `/v1/model/builtin` 的 `ratio_display` 原串是 `0.7x`
   * （**x 在数字后**），而仓内口径是 ` · x{n}`（**x 在数字前**）。
   */
  it('① listModels 的 name 带倍率，且形态是仓内口径「 · x{n}」', async () => {
    const adapter = makeAdapter([
      { id: 'GLM-5.2', name: 'GLM-5.2', rateLabel: '0.7x' },
      { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', rateLabel: '0.18x' },
    ])
    const models = await adapter.listModels('codearts')
    const glm = models.find((m) => m.id === 'GLM-5.2')
    const flash = models.find((m) => m.id === 'deepseek-v4.1-flash')
    // ⚠️ 断言**完整串**：删掉拼接就会红（`toContain(' · ')` 恒真形态不采纳）。
    expect(glm?.name).toBe('GLM-5.2 · x0.7')
    expect(flash?.name).toBe('deepseek-v4.1-flash · x0.18')
  })

  /**
   * 守卫 ②：`resolveModel` 的 name 是**裸名**（不含倍率）。
   *
   * ⚠️ 骨架的取值是 `entry?.bareName ?? entry?.name ?? model`
   * （`src/model-catalog.ts:640`）⇒ 省略 `bareName` 就回退到带倍率的 `name`。
   *
   * ⚠️ 本家比别家更严重：倍率**随时间变**（错峰档）⇒ 同一个模型的
   * `resolveModel().name` 一天变两次。
   */
  it('② resolveModel 的 name 是裸名（不含倍率）', async () => {
    const adapter = makeAdapter([
      { id: 'GLM-5.2', name: 'GLM-5.2', rateLabel: '0.7x' },
    ])
    const resolved = await adapter.resolveModel('codearts', 'GLM-5.2')
    // ⚠️ 不是 `toBe('GLM-5.2')`（那会连「模型名本身变了」也一起放过），
    // 而是「不带倍率分隔符」—— 与 loomy / raccoon 的既有口径一致。
    expect(resolved.name).toBe('GLM-5.2')
    expect(resolved.name).not.toContain(' · ')
  })

  /**
   * 守卫 ③：目录里的倍率**能被聚合的倍率解析口读出来**。
   *
   * ⚠️ 这是 PR !133 最贵的一条：上游原串 ` · 0.18x` 解析不出来
   * （`priceFactorFromName` 的正则把 `[×x]?` 放在数字**之前**）⇒
   * codearts 候选价格恒为 `Infinity` ⇒ 聚合「同临期档内倍率升序」
   * 永远挑不到它。
   */
  it('③ 目录名里的倍率能被 priceFactorFromName 解析出来（聚合挑得到 codearts）', async () => {
    const adapter = makeAdapter([
      { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', rateLabel: '0.09x' },
    ])
    const models = await adapter.listModels('codearts')
    const name = models.find((m) => m.id === 'deepseek-v4.1-flash')?.name ?? ''
    // ⚠️ **实测解析值**，不是断言字符串形态 —— 这才是下游真正读的东西。
    expect(priceFactorFromName(name)).toBe(0.09)
    // 反向对照：上游原串形态解析不出来（证明这条守卫真的在测「形态转换」）。
    expect(priceFactorFromName('deepseek-v4.1-flash · 0.09x')).toBe(Number.POSITIVE_INFINITY)
  })

  /**
   * 守卫 ④：**无倍率**时保持裸名（不拼占位值）。
   *
   * ⚠️ 上游 `credit` 为空 / 没有 `ratio_display` 时**不落倍率** ⇒
   * 目录名必须与 PR 之前**逐字相同**。
   */
  it('④ 没有倍率时 name 与 PR 之前逐字相同（不拼占位值）', async () => {
    const adapter = makeAdapter([
      { id: 'GLM-5.2', name: 'GLM-5.2' },
    ])
    const models = await adapter.listModels('codearts')
    expect(models.find((m) => m.id === 'GLM-5.2')?.name).toBe('GLM-5.2')
  })
})

describe('codeartsRateSuffix（上游原串 → 仓内口径）', () => {
  it('认得出上游的「数字在前、x 在后」形态', () => {
    expect(codeartsRateSuffix('0.7x')).toBe('x0.7')
    expect(codeartsRateSuffix('0.18x')).toBe('x0.18')
    expect(codeartsRateSuffix('0.09x')).toBe('x0.09')
    expect(codeartsRateSuffix('1x')).toBe('x1')
    expect(codeartsRateSuffix(' 0.7x ')).toBe('x0.7')
  })

  it('认不出就返回 undefined（不编造、不用占位值冒充）', () => {
    // ⚠️ 上游若改形态（也改成 `x0.7`）⇒ 认不出 ⇒ 不显示倍率
    // （保守方向：少显示好过显示一个错的数）。
    expect(codeartsRateSuffix('x0.7')).toBeUndefined()
    expect(codeartsRateSuffix('0.7')).toBeUndefined()
    expect(codeartsRateSuffix('免费')).toBeUndefined()
    expect(codeartsRateSuffix('')).toBeUndefined()
  })

  it('转换后的串能被 priceFactorFromName 解析回原值（往返保真）', () => {
    for (const display of ['0.7x', '0.18x', '0.09x', '1x']) {
      const suffix = codeartsRateSuffix(display)!
      expect(priceFactorFromName(`M · ${suffix}`)).toBe(Number(display.replace('x', '')))
    }
  })
})
