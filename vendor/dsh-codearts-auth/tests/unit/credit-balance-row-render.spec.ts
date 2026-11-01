import { describe, expect, it, vi } from 'vitest'

/**
 * 积分行（`CreditBalanceRow`）的**运行时**渲染守卫。
 *
 * ## 为什么必须有这一条（真实事故，2026-10-27）
 *
 * 给积分行加「hover 看全文」时，把 `hoverTitle` 的声明放在了
 * `quotaDetail` 之后，而它引用的 `poolSplitText` / `namedPoolText` /
 * `accioResetNote` 声明在**更下面** ⇒ `const` 的 TDZ（暂时性死区）让渲染期抛：
 *
 *     Cannot access 'poolSplitText' before initialization
 *
 * 症状是**整个 Jet Hub 设置页被错误边界拦住**（用户看到一整块红字），
 * 而当时：
 * - `pnpm build:client` 通过（TDZ 是运行时错误，不是语法错误）；
 * - `pnpm test` **11018 条全绿**；
 * - `tests/unit/jet-hub-tdz.spec.ts` 也绿 —— 因为它只调 `JetHubPage(...)`
 *   顶层，而本组件要等账号列表加载完、渲染卡片时才执行，**TDZ 藏在子组件里**。
 *
 * ⇒ 本文件用替身 React **真正调用** `CreditBalanceRow(...)`。
 * 这是本仓库（无 react / 无 DOM）里唯一能拦住这类缺陷的层次。
 *
 * ## ⚠️ 为什么每个 provider 都要过一遍
 *
 * TDZ 只在**被求值到**的那一行炸。`poolSplitText` 只在 `provider !== 'accio'`
 * 时求值、`namedPoolText` 只在 `provider === 'accio'` 时求值 ⇒
 * 只测一个 provider 会漏掉另一条分支（这正是初版事故能溜过去的原因之一）。
 */

const reactStub = {
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useLayoutEffect: () => {},
  // ⚠️ 返回 null 而不是真实元素：这里只要**求值过程**跑完（TDZ 与取值都在
  //    参数求值阶段发生），不需要 DOM 树。
  createElement: () => null,
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
}

vi.mock('react', () => reactStub)

/** 造一个最小可渲染的余额对象。 */
function balanceOf({ total = 1670.57, packages = [] } = {}) {
  return { total, packages, expiredTotal: 0 }
}

/** 三个资源包：基础（带到期）+ 赠送（无到期）+ 独立池。 */
const PACKAGES = [
  {
    name: '基础积分包', unit: 'credit', remaining: 500, total: 500, used: 0,
    active: true, cycleStartTime: '', cycleEndTime: '',
    expiredTime: new Date(Date.now() + 3 * 86400_000).toISOString(),
    deductionEndTime: Date.now() + 3 * 86400_000,
  },
  {
    name: '赠送积分包', unit: 'credit', remaining: 1170.57, total: 2000, used: 829.43,
    active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '',
  },
  {
    name: '星火专属', unit: 'credit', remaining: 1200, total: 1200, used: 0,
    active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '',
  },
]

describe('CreditBalanceRow 运行时渲染（TDZ 回归）', () => {
  /**
   * ⚠️ 判据是**不抛错**，不是「渲染出什么」：
   *    TDZ 会在函数体执行到那一行时抛 ReferenceError，直接冒到用例层。
   *    用 `expect(...).not.toThrow()` 会把异常吞成一条「通过」的假象 ——
   *    与 `jet-hub-tdz.spec.ts` 同款纪律，这里直接调用让异常冒出来。
   */
  const render = (props: Record<string, unknown>) => {
    const Row = moduleUnderTest.__creditBalanceRowForTest
    expect(typeof Row, 'CreditBalanceRow 未被导出（测试钩子丢了）').toBe('function')
    return (Row as (p: Record<string, unknown>) => unknown)(props)
  }

  let moduleUnderTest: typeof import('../../plugin-src/client/jet-hub.js')

  /** 惰性加载一次：`vi.mock('react')` 必须先于模块求值生效。 */
  const load = async () => {
    moduleUnderTest ??= await import('../../plugin-src/client/jet-hub.js')
    return moduleUnderTest
  }

  it('★★ 默认 provider（走 poolSplitText 那条分支）不抛 TDZ', async () => {
    await load()
    expect(() => render({
      balance: balanceOf({ packages: PACKAGES }),
      error: undefined,
      loading: false,
      windowDays: 15,
      provider: 'codearts',
    })).not.toThrow()
  })

  it('★★ accio（走 namedPoolText / accioResetNote 那条分支）不抛 TDZ', async () => {
    await load()
    // ⚠️ accio 的池名含「每日积分」，会走到 `formatNamedPoolLine` 与
    //    `accioResetSeconds` 两条只在 accio 下求值的路径。
    const accioPackages = [
      {
        name: '每日积分', unit: 'credit', remaining: 199, total: 200, used: 1,
        active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '',
      },
      {
        name: '每月积分', unit: 'credit', remaining: 0, total: 0, used: 0,
        active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '',
      },
    ]
    expect(() => render({
      balance: balanceOf({ total: 199, packages: accioPackages }),
      error: undefined,
      loading: false,
      windowDays: 15,
      provider: 'accio',
    })).not.toThrow()
  })

  it('★★ loomy（池名分桶 + 独立池）不抛 TDZ', async () => {
    await load()
    expect(() => render({
      balance: balanceOf({ packages: PACKAGES }),
      error: undefined,
      loading: false,
      windowDays: 15,
      provider: 'loomy',
    })).not.toThrow()
  })

  it('★★ 带操作按钮（三列布局）不抛 TDZ', async () => {
    await load()
    const actions = reactStub.createElement('div', null)
    expect(() => render({
      balance: balanceOf({ packages: PACKAGES }),
      error: undefined,
      loading: false,
      windowDays: 15,
      provider: 'codearts',
      actions,
    })).not.toThrow()
  })

  it('★★ loading / 查询失败两种早退分支也不抛', async () => {
    await load()
    expect(() => render({
      balance: null, error: undefined, loading: true, windowDays: 15, provider: 'codearts',
    })).not.toThrow()
    expect(() => render({
      balance: null, error: '查询失败', loading: false, windowDays: 15, provider: 'codearts',
    })).not.toThrow()
  })

  it('参考：TDZ 的等价形态必须能被本判据区分（反向验证）', () => {
    // ⚠️ 证明「不抛错」这条判据不是同义反复：真 TDZ 一定抛 ReferenceError。
    const bad = () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const lineText = [laterValue]
      const laterValue = 'declared-after-use'
      return lineText
    }
    expect(() => bad()).toThrow(ReferenceError)
  })
})
