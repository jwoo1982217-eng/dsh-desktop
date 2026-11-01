import { describe, expect, it } from 'vitest'

import {
  centerBulkState,
  centerPendingProviderIds,
  centerSectionFor,
  centerTotals,
  providerMatchesQuery,
  providerModelSummary,
  visibleCenterSections,
} from '../../plugin-src/client/model-center.js'

const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, disabled: false, ...extra })
const ready = (models: unknown[]) => ({ phase: 'ready', models })

describe('providerModelSummary（单个供应商的统计）', () => {
  it('数出总数、已关闭数、已下架数', () => {
    const models = [
      model('a'),
      model('b', { disabled: true }),
      model('c', { dead: true }),
      model('d', { disabled: true, dead: true }),
    ]
    expect(providerModelSummary(models)).toEqual({ total: 4, disabled: 2, dead: 2 })
  })

  it('非数组按空表处理，不抛错（未加载时 models 可能是 null/undefined）', () => {
    expect(providerModelSummary(null)).toEqual({ total: 0, disabled: 0, dead: 0 })
    expect(providerModelSummary(undefined)).toEqual({ total: 0, disabled: 0, dead: 0 })
    expect(providerModelSummary({ length: 3 })).toEqual({ total: 0, disabled: 0, dead: 0 })
  })

  it('数组里的 null / 非对象元素不参与计数，也不炸', () => {
    expect(providerModelSummary([null, 1, 'x', model('a', { disabled: true })])).toEqual({
      total: 4,
      disabled: 1,
      dead: 0,
    })
  })
})

describe('providerMatchesQuery（供应商名命中）', () => {
  const provider = { id: 'workbuddy', label: 'WorkBuddy (国际版)' }

  it('label 与 id 都参与匹配，不区分大小写', () => {
    expect(providerMatchesQuery(provider, 'workbuddy')).toBe(true)
    expect(providerMatchesQuery(provider, 'WORKBUDDY')).toBe(true)
    expect(providerMatchesQuery(provider, '国际版')).toBe(true)
    expect(providerMatchesQuery(provider, ' 国际版  ')).toBe(true)
  })

  it('空词恒 false —— 空搜索不能让每一家都算「名字命中」', () => {
    // 若返回 true，状态筛选会被整体跳过（名字命中不参与搜索词过滤），
    // 「已关闭」筛选就会把全部模型放进来。
    expect(providerMatchesQuery(provider, '')).toBe(false)
    expect(providerMatchesQuery(provider, '   ')).toBe(false)
    expect(providerMatchesQuery(provider, null)).toBe(false)
    expect(providerMatchesQuery(provider, undefined)).toBe(false)
  })

  it('不相关词返回 false', () => {
    expect(providerMatchesQuery(provider, 'minimax')).toBe(false)
  })
})

describe('centerSectionFor（单个分组的展示态）', () => {
  const provider = { id: 'workbuddy', label: 'WorkBuddy' }

  it('未加载：models 为空、loaded=false、hit 恒 true', () => {
    // 未加载的组必须留在列表里 —— 隐藏掉的话，用户搜索时就再也找不到
    // 自己还没展开过的那家（它根本没机会被匹配）。
    const section = centerSectionFor(provider, undefined, { query: 'zzz', status: 'all' })
    expect(section.loaded).toBe(false)
    expect(section.phase).toBe('idle')
    expect(section.models).toEqual([])
    expect(section.hit).toBe(true)
  })

  it('已加载且无筛选：全部模型都在，hit=true（0 个模型也要露出来报「没有可用模型」）', () => {
    const section = centerSectionFor(provider, ready([model('a'), model('b', { disabled: true })]), {})
    expect(section.loaded).toBe(true)
    expect(section.models.map(m => m.id)).toEqual(['a', 'b'])
    expect(section.hit).toBe(true)

    const empty = centerSectionFor(provider, ready([]), {})
    expect(empty.hit).toBe(true)
    expect(empty.summary.total).toBe(0)
  })

  it('按搜索词只留命中的模型', () => {
    const models = [model('glm-5.3'), model('deepseek-v4.1-flash')]
    const section = centerSectionFor(provider, ready(models), { query: 'glm' })
    expect(section.models.map(m => m.id)).toEqual(['glm-5.3'])
    expect(section.hit).toBe(true)
  })

  it('有筛选且一个都没命中：hit=false（整组隐藏）', () => {
    const section = centerSectionFor(provider, ready([model('glm-5.3')]), { query: 'minimax-only' })
    expect(section.models).toEqual([])
    expect(section.hit).toBe(false)
  })

  it('★ 供应商名命中时展示该家全部模型（只再按状态筛），而不是「名字里带该词的模型」', () => {
    const models = [model('glm-5.3'), model('deepseek-v4.1-flash'), model('kimi-k3', { disabled: true })]
    const section = centerSectionFor(provider, ready(models), { query: 'WorkBuddy', status: 'all' })
    expect(section.nameHit).toBe(true)
    expect(section.models.map(m => m.id)).toEqual(['glm-5.3', 'deepseek-v4.1-flash', 'kimi-k3'])

    const onlyDisabled = centerSectionFor(provider, ready(models), { query: 'WorkBuddy', status: 'disabled' })
    expect(onlyDisabled.models.map(m => m.id)).toEqual(['kimi-k3'])
  })

  /**
   * ★★ **供应商名命中时不得因「状态筛选」把整家隐掉**（2026-10-21 合并审计发现）。
   *
   * ⚠️ `nameHit` 使该家的模型全部参与展示（只再按状态筛）；但若该家**没有**
   * 已关闭的模型、而用户选的恰好是「已关闭」过滤器 ⇒ `models` 为空
   * ⇒ 原判据（`models.length > 0`）会把**整家隐掉**
   * ⇒ 用户明明搜到了这家，它却消失了 —— 而这正是本屏**最核心的用法**
   * （跨供应商找「已关闭的模型」）。
   */
  it('★★ 供应商名命中 + 状态筛不到任何模型 ⇒ 该组仍须可见（hit=true）', () => {
    const models = [model('glm-5.3')] // 全部是「已打开」
    const section = centerSectionFor(provider, ready(models), { query: 'WorkBuddy', status: 'disabled' })
    expect(section.nameHit).toBe(true)
    expect(section.models, '（对照）状态筛确实没留下任何模型').toEqual([])
    expect(
      section.hit,
      '★★ 用户搜到了这家 ⇒ 该组必须仍在列表里（否则跨供应商找「已关闭的模型」无从下手）',
    ).toBe(true)
  })

  it('状态筛选生效：enabled / disabled 各留一半', () => {
    const models = [model('a'), model('b', { disabled: true })]
    expect(centerSectionFor(provider, ready(models), { status: 'enabled' }).models.map(m => m.id)).toEqual(['a'])
    expect(centerSectionFor(provider, ready(models), { status: 'disabled' }).models.map(m => m.id)).toEqual(['b'])
  })

  it('error 态：把错误文案带出去，不把它当成「0 个模型」', () => {
    const section = centerSectionFor(provider, { phase: 'error', models: [], error: '上游 502' }, {})
    expect(section.loaded).toBe(false)
    expect(section.error).toBe('上游 502')
    expect(section.hit).toBe(true)
  })
})

describe('visibleCenterSections（整页分组）', () => {
  const providers = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' },
  ]

  it('保持 providers 的声明顺序，不做重排', () => {
    const states = { a: ready([model('x')]), b: ready([model('y')]), c: ready([model('z')]) }
    expect(visibleCenterSections(providers, states, {}).map(s => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('未加载的组即使有搜索词也保留（用户要知道还有哪家可展开）', () => {
    const states = { a: ready([model('glm')]) }
    const out = visibleCenterSections(providers, states, { query: 'glm' })
    // a 命中、b/c 未加载 ⇒ 都留下（未加载无法判断，隐藏了就再也「搜不到」）
    expect(out.map(s => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('已加载但一个都没命中的组隐藏；顺序仍是 providers 的声明顺序', () => {
    // c 已加载且 0 个模型 —— 有筛选时没有东西可展示，隐藏是合理的。
    const states = { b: ready([model('glm')]), c: ready([]) }
    const out = visibleCenterSections(providers, states, { query: 'glm' })
    expect(out.map(s => s.id)).toEqual(['a', 'b'])
  })

  it('states 传 null / 非对象时全部当未加载，不抛错', () => {
    expect(visibleCenterSections(providers, null, {}).map(s => s.id)).toEqual(['a', 'b', 'c'])
    expect(visibleCenterSections(providers, 'oops', {}).map(s => s.id)).toEqual(['a', 'b', 'c'])
    expect(visibleCenterSections(null, {}, {})).toEqual([])
  })
})

describe('centerTotals（跨分组总览）', () => {
  /**
   * ⚠️⚠️ **签名是 `(providers, states)`，不是 `(sections)`**
   * （2026-10-21 合并审计发现：原实现吃**筛选后**的 sections ⇒ 有筛选时
   * 「已读取 N / M 家」恒显示 0 —— 而两家其实都读过了）。
   */
  const providers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('只统计已加载的组', () => {
    const states = {
      a: ready([model('a1'), model('a2', { disabled: true })]),
      b: { phase: 'idle', models: [] },
      c: ready([model('c1')]),
    }
    expect(centerTotals(providers, states)).toEqual({ loaded: 2, total: 3, disabled: 1 })
  })

  it('一个都没加载时是 0/0/0 —— 界面据此写「已读取 0 / N 家」，不能谎报「全部已打开」', () => {
    expect(centerTotals(providers, { a: { phase: 'idle', models: [] } }))
      .toEqual({ loaded: 0, total: 0, disabled: 0 })
  })

  it('非数组与缺字段都安全', () => {
    expect(centerTotals(null, {})).toEqual({ loaded: 0, total: 0, disabled: 0 })
    expect(centerTotals(undefined, undefined)).toEqual({ loaded: 0, total: 0, disabled: 0 })
    expect(centerTotals([{ id: 'a' }], { a: { phase: 'ready' } }))
      .toEqual({ loaded: 1, total: 0, disabled: 0 })
  })

  /**
   * ★★ **有筛选时「已读取 N / M 家」不得恒显示 0**（2026-10-21 合并审计发现）。
   *
   * ⚠️ 原实现吃 `visibleCenterSections(...)` 的返回值 —— 而它**已经把
   * `hit === false` 的组整组剔掉** ⇒ 用户输入任意不匹配的搜索词 ⇒
   * 顶部立刻变成「已读取 0 / 2 家」。
   */
  it('★★ 有筛选时仍统计全部已加载的组（不因搜索词而归零）', () => {
    const states = {
      a: ready([model('a1')]),
      b: ready([model('b1')]),
    }
    const all = [{ id: 'a' }, { id: 'b' }]
    // ⚠️ 走**真实调用路径**：centerTotals(providers, states)，不是手搓的 section 数组。
    const filtered = visibleCenterSections(all, states, { query: 'zzz', status: 'all' })
    expect(filtered, '（对照）搜索词不匹配时可见组为 0').toEqual([])
    expect(
      centerTotals(all, states),
      '★★ 「已读取 N / M 家」必须统计全部已加载的组，不受筛选影响',
    ).toEqual({ loaded: 2, total: 2, disabled: 0 })
  })
})

describe('centerPendingProviderIds（加载全部时补哪些）', () => {
  const providers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

  it('idle / loading / error 都要补，ready 跳过', () => {
    const states = { a: ready([]), b: { phase: 'error' }, c: { phase: 'loading' } }
    expect(centerPendingProviderIds(providers, states)).toEqual(['b', 'c', 'd'])
  })

  it('空 id 不参与（PROVIDERS 元素缺 id 时不该发出无效 provider 参数）', () => {
    expect(centerPendingProviderIds([{ id: '' }, { id: 'a' }], {})).toEqual(['a'])
  })

  it('states 传 null 时全部待加载', () => {
    expect(centerPendingProviderIds(providers, null)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('centerBulkState（整家「全开 / 全关」按钮的禁用判据）', () => {
  /**
   * ⚠️⚠️ **必须排除 dead 条目**（2026-10-21 合并审计发现）。
   *
   * 服务端的写入集（`fullCatalogIds` 的并集）**不含** dead 模型
   * （被 `withDeadModelPruning` 剔除），而客户端的 `summary.total` **含** dead
   * （`model.list` 把 dead 表里的 id 补回目录）⇒ 用 `total` 比较会让
   * 「全关」按钮**永不禁用**，而点下去服务端走幂等短路、界面一个数字都不变
   * ⇒ 观感为「按钮坏了」。
   */
  it('★★ 除 dead 外全部已关闭 ⇒ 「全关」按钮必须禁用', () => {
    const models = [
      model('a', { disabled: true }),
      model('b', { disabled: true }),
      model('c', { dead: true }),
    ]
    // ⚠️ 对照：旧判据（用含 dead 的 total）会算出 disabled(2) < total(3) ⇒ 不禁用。
    expect(centerBulkState(models)).toEqual({ allDisabled: true, noneDisabled: false })
  })

  it('全部已打开 ⇒ 「全开」按钮禁用、「全关」可用', () => {
    const models = [model('a'), model('b', { dead: true })]
    expect(centerBulkState(models)).toEqual({ allDisabled: false, noneDisabled: true })
  })

  it('空列表 ⇒ 两个按钮都可用（没有模型可管时不宣称「已全开/已全关」）', () => {
    expect(centerBulkState([])).toEqual({ allDisabled: false, noneDisabled: false })
    expect(centerBulkState(null)).toEqual({ allDisabled: false, noneDisabled: false })
  })

  it('dead 是唯一条目 ⇒ 同样不算「已全关」（它不受开关控制）', () => {
    expect(centerBulkState([model('x', { dead: true })]))
      .toEqual({ allDisabled: false, noneDisabled: false })
  })
})
