import { describe, expect, it, vi } from 'vitest'

/**
 * 积分行 **hover 全文**的内容与结构守卫（用户 2026-10-27 两轮报障的回归）。
 *
 * ## 事故一：hover 显示的是「名词解释」而不是数字
 *
 * 用户原话：「悬浮没显示后续的详细积分，而是解释名词」。
 *
 * 根因：HTML 的 `title` 是**子元素优先** —— 鼠标落在子元素上时浏览器显示子元素
 * 自己的 title，父级 `dd` 的 title 根本没机会出现。而积分行里分桶文字
 * （永久/长期/临期）、独立池、accio 倒计时三处原先各自挂着「名词解释」
 * ⇒ 用户 hover 到最想看的那些数字上，看到的全是定义。
 *
 * 修法：三处说明全部并入父级 `hoverTitle`，**子元素一律不挂 title**。
 *
 * ## 事故二：hover 全文缺行内被截断的内容
 *
 * 行内是 `nowrap + ellipsis`，被截掉的内容只能从 title 读到 —— 故 title 的
 * 第一段必须是**行内那一整行**，不能只有资源包明细。
 *
 * ⚠️ 本文件用替身 React 真正调用 `CreditBalanceRow`，并**捕获**它构造的
 * 元素树来断言 title 的实际取值（而不是断言源码里出现了哪些字面量）。
 */

/** 捕获到的元素树节点。 */
interface Node { type: unknown; props: Record<string, any>; children: unknown[] }

const created: Node[] = []

const reactStub = {
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useLayoutEffect: () => {},
  Fragment: 'Fragment',
  StrictMode: 'StrictMode',
  createElement(type: unknown, props: Record<string, any> | null, ...children: unknown[]) {
    const node: Node = { type, props: props ?? {}, children }
    created.push(node)
    return node
  },
}

vi.mock('react', () => reactStub)

let mod: typeof import('../../plugin-src/client/jet-hub.js')

async function load() {
  mod ??= await import('../../plugin-src/client/jet-hub.js')
  return mod
}

/** 渲染一次并返回根节点。 */
async function renderRow(props: Record<string, unknown>): Promise<Node> {
  await load()
  created.length = 0
  const Row = mod.__creditBalanceRowForTest as unknown as (p: Record<string, unknown>) => Node
  return Row(props)
}

/** 深度遍历找所有 className 命中的节点。 */
function findAll(node: Node | null, className: string): Node[] {
  const out: Node[] = []
  const walk = (n: unknown) => {
    if (n === null || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const item = n as Node
    if (typeof item.props?.className === 'string' && item.props.className.split(/\s+/).includes(className)) {
      out.push(item)
    }
    item.children?.forEach(walk)
  }
  walk(node)
  return out
}

/**
 * 资源包夹具：**必须覆盖三档分桶**，否则断言「第一段含长期/临期」会假红。
 *
 * ⚠️ 三档的判据是「距 `deductionEndTime` 是否落在窗口内」（`windowDays`）：
 *   - 3 天后到期 + 窗口 15 天 ⇒ **临期**
 *   - 60 天后到期 + 窗口 15 天 ⇒ **长期**
 *   - 无 `deductionEndTime` ⇒ **永久**
 * 初版夹具三个包全无到期日 ⇒ 全部落进永久桶，于是「长期」「临期」两段
 * 根本不渲染（那不是缺陷，是夹具没造出该分支）。
 */
const DAY = 86400_000
const PACKAGES = [
  {
    // 临期：3 天后作废
    name: '基础积分包', unit: 'credit', remaining: 500, total: 500, used: 0,
    active: true, cycleStartTime: '', cycleEndTime: '',
    expiredTime: new Date(Date.now() + 3 * DAY).toISOString(),
    deductionEndTime: Date.now() + 3 * DAY,
  },
  {
    // 长期：60 天后才到期（窗口 15 天 ⇒ 不算临期）
    name: '活动赠送包', unit: 'credit', remaining: 700, total: 1000, used: 300,
    active: true, cycleStartTime: '', cycleEndTime: '',
    expiredTime: new Date(Date.now() + 60 * DAY).toISOString(),
    deductionEndTime: Date.now() + 60 * DAY,
  },
  {
    // 永久：服务端没给到期时间
    name: '赠送积分包', unit: 'credit', remaining: 470.57, total: 2000, used: 1529.43,
    active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '',
  },
]

const balanceOf = (total = 1670.57) => ({ total, packages: PACKAGES, expiredTotal: 0 })

describe('★★ hover 全文：必须是数字，不是名词解释', () => {
  it('★★★ 子元素一律不挂 title（否则会抢走父级的 hover 全文）', async () => {
    // ⚠️ 必须**逐 provider** 跑：title 的挂载点在不同分支里是不同元素。
    //    只测 codearts 会漏掉 **accio 的倒计时 span** —— 2026-10-28 审计实测：
    //    给它挂回 title 之后本用例仍 **9 passed**（无牙），而 accio 倒计时正是用户
    //    原始报障「悬浮显示名词解释」的三处之一。
    const CASES = [
      {
        label: 'codearts（三档分桶）',
        props: {
          balance: balanceOf(), error: undefined, loading: false,
          windowDays: 15, provider: 'codearts',
        },
      },
      {
        label: 'accio（倒计时）',
        props: {
          balance: {
            total: 199,
            packages: [{
              name: '每日积分', unit: 'credit', remaining: 199, total: 200, used: 1,
              active: true, cycleStartTime: '',
              cycleEndTime: new Date(Date.now() + 3 * 3600_000).toISOString(),
              expiredTime: '',
            }],
            expiredTotal: 0,
          },
          error: undefined, loading: false, windowDays: 15, provider: 'accio',
        },
      },
    ]
    for (const { label, props } of CASES) {
      const root = await renderRow(props)
      // 遍历整棵树：除根 dd 外，任何子节点都不许有 title。
      const dd = findAll(root, 'dim-jh-creditValue')[0]
      expect(dd, `${label}：找不到积分值节点`).toBeDefined()
      expect(dd!.props.title, `${label}：根节点必须有 hover 全文`).toBeTruthy()

      const offenders: string[] = []
      const walk = (n: unknown) => {
        if (n === null || typeof n !== 'object') return
        if (Array.isArray(n)) { n.forEach(walk); return }
        const item = n as Node
        if (item !== dd && typeof item.props?.title === 'string') {
          offenders.push(`${String(item.props.className ?? item.type)}: ${item.props.title.slice(0, 30)}`)
        }
        item.children?.forEach(walk)
      }
      walk(root)
      expect(
        offenders,
        `${label}：子元素挂了 title ⇒ 浏览器优先显示它，父级的 hover 全文永远看不到`
        + `（这正是「悬浮显示名词解释」那个报障的成因）：${offenders.join(' | ')}`,
      ).toEqual([])
    }
  })

  it('★★★ hover 全文第一段必须是行内那一整行（含被截断的分桶数字）', async () => {
    // ⚠️ 独立池单独一个夹具（`isExclusivePool` 认**池名含「独立池」**）。
    const withExclusive = [
      ...PACKAGES,
      {
        name: '星火积分（独立池，不参与主池合计）', unit: 'credit',
        remaining: 1200, total: 1200, used: 0,
        active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '',
      },
    ]
    const root = await renderRow({
      balance: { total: 2870.57, packages: withExclusive, expiredTotal: 0 },
      error: undefined, loading: false,
      windowDays: 15, provider: 'codearts',
    })
    const dd = findAll(root, 'dim-jh-creditValue')[0]!
    const title: string = dd.props.title
    // 主数值与三档分桶都要在**第一段**（\n\n 之前）。
    const firstBlock = title.split('\n\n')[0]!
    expect(firstBlock, '第一段缺主数值').toContain('2870.57')
    expect(firstBlock, '第一段缺永久分桶').toMatch(/永久/)
    expect(firstBlock, '第一段缺长期分桶').toMatch(/长期/)
    expect(firstBlock, '第一段缺临期分桶').toMatch(/临期/)
    expect(firstBlock, '第一段缺独立池').toMatch(/专属/)
  })

  it('★★ 名词解释仍保留，但排在数字**之后**', async () => {
    const root = await renderRow({
      balance: balanceOf(), error: undefined, loading: false,
      windowDays: 15, provider: 'codearts',
    })
    const title: string = findAll(root, 'dim-jh-creditValue')[0]!.props.title
    const blocks = title.split('\n\n')
    // 解释还在（不能因为「优先显示数字」就把定义丢掉）。
    const glossaryIdx = blocks.findIndex((b) => b.includes('永久 = 服务端未给到期时间'))
    expect(glossaryIdx, '名词解释被删了（它是原有功能，不该丢）').toBeGreaterThan(0)
    // 但必须在数字块之后。
    expect(glossaryIdx, '名词解释排到了数字前面 ⇒ 用户先看到定义').toBeGreaterThan(0)
    expect(blocks[0], '第一段必须是数字').not.toContain('永久 = 服务端未给到期时间')
  })

  it('★★★ 名词解释逐条成行（用户 2026-10-27：「名词解释也分下行吧」）', async () => {
    const root = await renderRow({
      balance: balanceOf(), error: undefined, loading: false,
      windowDays: 15, provider: 'codearts',
    })
    const title: string = findAll(root, 'dim-jh-creditValue')[0]!.props.title
    // 取出名词解释那一段（数字段与明细段之间）。
    const blocks = title.split('\n\n')
    const glossary = blocks.find((b) => b.includes('永久 = 服务端未给到期时间'))
    expect(glossary, '找不到名词解释段').toBeDefined()

    const lines = glossary!.split('\n')
    // 三档定义**各占一行**，不许再用分号拼成一句。
    const permanentLine = lines.find((l) => l.startsWith('永久 ='))
    const longTermLine = lines.find((l) => l.startsWith('长期 ='))
    const expiringLine = lines.find((l) => l.startsWith('临期 ='))
    expect(permanentLine, '永久定义必须独立成行（且以「永久 =」开头）').toBeDefined()
    expect(longTermLine, '长期定义必须独立成行（且以「长期 =」开头）').toBeDefined()
    expect(expiringLine, '临期定义必须独立成行（且以「临期 =」开头）').toBeDefined()
    // 反向钉子：同一行里不许再出现另一档的定义（那是「用分号拼成一段」的形态）。
    expect(permanentLine, '永久那一行里混进了长期定义 ⇒ 没有真正分行')
      .not.toContain('长期 =')
    expect(longTermLine, '长期那一行里混进了临期定义 ⇒ 没有真正分行')
      .not.toContain('临期 =')
  })

  it('★★ 逐条成行用单换行，不是段落分隔（避免 tooltip 里多空行）', async () => {
    const root = await renderRow({
      balance: balanceOf(), error: undefined, loading: false,
      windowDays: 15, provider: 'codearts',
    })
    const title: string = findAll(root, 'dim-jh-creditValue')[0]!.props.title
    const glossary = title.split('\n\n').find((b) => b.includes('永久 = 服务端未给到期时间'))!
    // ⚠️ \n\n 是段落分隔，会在三档之间多空一行、显得松散不成组。
    expect(glossary, '三档之间出现了空行（用了段落分隔而非单换行）')
      .not.toMatch(/永久 =[\s\S]*\n\n[\s\S]*长期 =/)
  })

  it('★★ 资源包明细排在最后', async () => {
    const root = await renderRow({
      balance: balanceOf(), error: undefined, loading: false,
      windowDays: 15, provider: 'codearts',
    })
    const title: string = findAll(root, 'dim-jh-creditValue')[0]!.props.title
    const blocks = title.split('\n\n')
    expect(blocks.length, 'hover 全文应有三段（数字 / 解释 / 明细）').toBeGreaterThanOrEqual(3)
    expect(blocks[blocks.length - 1], '最后一段应是资源包明细').toMatch(/资源包|基础积分包/)
  })

  it('★★ 没渲染独立池时，解释里也不该出现独立池说明（避免噪音）', async () => {
    const noExclusive = [PACKAGES[0]!, PACKAGES[1]!]
    const root = await renderRow({
      balance: { total: 1670.57, packages: noExclusive, expiredTotal: 0 },
      error: undefined, loading: false, windowDays: 15, provider: 'codearts',
    })
    const title: string = findAll(root, 'dim-jh-creditValue')[0]!.props.title
    expect(title, '没显示独立池却解释独立池 = 纯噪音').not.toContain('独立池')
  })

  it('★★ accio 的倒计时说明也并入 hover 全文', async () => {
    // ⚠️ 倒计时要 `cycleEndTime`（宿主把刷新时刻写进每日桶的这个字段，
    //    见 `accioResetSeconds`）；没有它则整行不渲染、说明也不该出现。
    const accioPackages = [
      {
        name: '每日积分', unit: 'credit', remaining: 199, total: 200, used: 1,
        active: true, cycleStartTime: '',
        cycleEndTime: new Date(Date.now() + 3 * 3600_000).toISOString(),
        expiredTime: '',
      },
    ]
    const root = await renderRow({
      balance: { total: 199, packages: accioPackages, expiredTotal: 0 },
      error: undefined, loading: false, windowDays: 15, provider: 'accio',
    })
    const dd = findAll(root, 'dim-jh-creditValue')[0]!
    const title: string = dd.props.title
    // 倒计时那一行原来挂着 ACCIO_DAILY_REWARD_NOTE，现在必须出现在 hover 全文里。
    expect(title, 'accio 的每日额度说明丢了').toMatch(/登录时|24 小时|不累积/)
    // 反向钉子：倒计时本身仍要在**行内**（它是最该一眼看到的信息）。
    const firstBlock = title.split('\n\n')[0]!
    expect(firstBlock, '倒计时必须在行内第一段').toMatch(/后刷新/)
  })

  it('★★ 余额为 0 时 title 仍是行内那个「0」，且绝不为空串', async () => {
    // ⚠️ 2026-10-28 审计修正：本用例原先叫「无任何内容时 title 为 undefined」，
    //    断言是 `title === undefined || String(title).length > 0` —— 后半段对任何
    //    非空 title 恒真，前半段又永远不成立（`lineText` 至少含主数值 `total`），
    //    ⇒ **整条恒真**，而且用例名与事实不符。
    //    真实行为：空包时行内只有一个「0」，title 就是 "0"（不是 undefined、也不是空串）。
    const root = await renderRow({
      balance: { total: 0, packages: [], expiredTotal: 0 },
      error: undefined, loading: false, windowDays: 15, provider: 'codearts',
    })
    const dd = findAll(root, 'dim-jh-creditValue')[0]!
    expect(dd.props.title, '空包时 title 必须仍是行内那个「0」').toBe('0')
    // 反向钉子：空串 title 会让浏览器弹一个空白 tooltip 框 —— 比没有更糟。
    expect(dd.props.title, 'title 不许是空串').not.toBe('')
  })
})
