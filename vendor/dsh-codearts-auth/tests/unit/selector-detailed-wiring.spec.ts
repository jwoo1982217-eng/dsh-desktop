/**
 * **选号器的 `fetchBalanceDetailed` 接线**（真实报障 2026-10-21，Qoder）。
 *
 * ## 本文件锁死什么
 *
 * 锁定时那次报错里说「为什么查不到」的能力，全靠在 `src/index.ts` 给每个
 * `BuddyBalanceSelector` 实例接上 `fetchBalanceDetailed`。
 *
 * ## 为什么必须单独一个 spec
 *
 * 缺陷形态是**纯接线遗漏**：`fetchBalanceDetailed` 是**可选**字段，漏接时
 * `tsc` 零报错、运行时不报错，症状只是**报错文案降级**（从「连不上
 * `openapi.qoder.sh`，请配代理」退成「凭据失效或响应异常」）。
 *
 * ⚠️ 实测（2026-10-21 变异验证）：删掉 `src/index.ts` 里 qoder / astudio /
 *    minimax / autoclaw 的接线后，`buddy-balance-selector.spec.ts` **41 条全绿、
 *    零牙** —— 那些用例直接构造 `new BuddyBalanceSelector({...})`，证明的是
 *    **选号器支持**这个能力，完全不覆盖**生产是否接了**。
 *
 * ⇒ 必须**读真实源码 + 遍历生产接线表**（与 `balance-cache-wiring.spec.ts`
 *   的「本表即清单 + 集合相等」同一范式）。
 */
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../src')

/**
 * ⚠️ **必须剥注释**（2026-10-25 审计 A3-3）。
 *
 * 本文件的判据是「`(?)` 块里有没有 `fetchBalanceDetailed:` 这个键」。若读**未剥注释**
 * 的源码，把整行**注释掉**、只把字面量留在注释里，判据照样命中 ⇒
 * 实测该绕过能让本文件 **47 passed 全绿**。同族范本
 * （`loomy-balance-error-contract.spec.ts:30`）一直是剥的，本文件漏了。
 */
const INDEX = stripComments(readFileSync(resolve(SRC, 'index.ts'), 'utf8'))

/** 剥掉注释（接线断言不该因为「注释里提到了某个符号」而通过）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * ★★ **本表即清单**：`src/index.ts` 里所有 `new BuddyBalanceSelector({...})`
 * 实例的变量名，以及它**是否必须**接 `fetchBalanceDetailed`。
 *
 * ⚠️⚠️ 新增一个选号器实例时必须加进本表（否则下面的集合比对会红）。
 * ⚠️ `mustDetailed: false` 是**有意的豁免**，必须写清理由 —— 默认全都该接：
 *    `fetchBalance` 的 `null` 把四种失败抹成同一格，任何接了锁定开关的渠道
 *    都会在锁定时报出那句无从下手的概括文案。
 */
const SELECTORS: ReadonlyArray<{
  /** `const <name> = new BuddyBalanceSelector({` 里的 `<name>` */
  name: string
  /** 是否必须接 `fetchBalanceDetailed` */
  mustDetailed: boolean
  /** 不接时的理由（`mustDetailed: true` 时留空） */
  exemptReason?: string
}> = [
  // buddy 系两家：`fetchCreditBalance` 只返回 `CreditBalance | null`，
  // 上游就没有「带原因」的变体 ⇒ 无法接（不是漏接）。
  { name: 'buddyBalanceSelector', mustDetailed: false, exemptReason: 'CodeBuddy 的 `fetchCreditBalance` 只返回 `CreditBalance | null`，上游没有带原因的变体可接' },
  { name: 'workbuddyBalanceSelector', mustDetailed: false, exemptReason: '同上（WorkBuddy 与 CodeBuddy 共用 `fetchCreditBalance`）；⚠️ 本家也未接锁定开关以外的东西' },
  { name: 'lobsteraiBalanceSelector', mustDetailed: false, exemptReason: 'LobsterAI 的 `requestJson` 只给 ok/body，失败原因在解析层就被压平了，无 Detailed 变体' },
  { name: 'traeBalanceSelector', mustDetailed: false, exemptReason: 'TRAE 的 `postJson` 只给 ok/body，且失败一律返回 null，无 Detailed 变体' },
  { name: 'qoderBalanceSelector', mustDetailed: true },
  { name: 'qoderCnBalanceSelector', mustDetailed: true },
  { name: 'minimaxBalanceSelector', mustDetailed: true },
  { name: 'minimaxIntlBalanceSelector', mustDetailed: true },
  { name: 'autoclawBalanceSelector', mustDetailed: true },
  { name: 'autoclawIntlBalanceSelector', mustDetailed: true },
  { name: 'astudioBalanceSelector', mustDetailed: true },
]

/**
 * 「这个键**真的**接线了吗」—— 不只看键名存在（2026-10-25 审计 A3-3）。
 *
 * ## ⚠️⚠️ 为什么「键存在」不够
 *
 * 实测三种绕过都能让旧判据（`/\bfetchBalanceDetailed\s*:/`）全绿：
 *
 * | 绕过 | 形态 | 为什么逃得掉 |
 * |---|---|---|
 * | 值假 | `fetchBalanceDetailed: undefined as never` | 键名在，值不是函数 |
 * | 注释掉 | 整行删掉、字面量留在注释里 | 判据扫到注释（现已剥注释） |
 * | 死条件展开 | `...(false ? { fetchBalanceDetailed } : {})` | 键名在文本里 |
 *
 * ⇒ 判据改成「键后面**不是** `undefined` / `false` / `null` / 空」，且
 * 「该块里**不得**出现 `?...{}...:` 这种把键藏进死分支的展开形态」。
 * ⚠️ 仍**不是**行为级（那要真跑 `apply()` 并构造锁定场景，见
 * `permanent-lock-execution.spec.ts` 的 B 段范式）；本函数只把「文本级」
 * 从「键名在不在」提升到「键名 + 值形态」。
 */
function isReallyWired(block: string, key: string): boolean {
  // ① 键后面必须跟一个**看着像值**的东西（不能是 undefined / false / null / 空）
  const m = new RegExp(`\\b${key}\\s*:\\s*([^,\\n}]*)`).exec(block)
  if (m === null) return false
  const value = m[1]!.trim()
  if (value.length === 0) return false
  if (/^(?:undefined|false|null)\b/.test(value)) return false
  // ② 不得把键藏进**死条件展开**（`...(false ? {...} : {})` 之类）
  const spread = new RegExp(`\\.\\.\\.\\s*\\(?\\s*(?:false|0)\\s*\\?`).test(block)
  if (spread && block.includes(key)) return false
  return true
}

/** 取 `const <name> = new BuddyBalanceSelector({…})` 的对象字面量正文（大括号配平）。 */
function selectorBlockOf(name: string): string | undefined {
  const marker = `const ${name} = new BuddyBalanceSelector({`
  const at = INDEX.indexOf(marker)
  if (at < 0) return undefined
  const open = at + marker.length - 1
  let depth = 0
  for (let i = open; i < INDEX.length; i += 1) {
    if (INDEX[i] === '{') depth += 1
    else if (INDEX[i] === '}') {
      depth -= 1
      if (depth === 0) return INDEX.slice(open, i + 1)
    }
  }
  return undefined
}

describe('★★ 选号器必须接上 fetchBalanceDetailed（否则锁定时说不出为什么查不到）', () => {
  it('★★ 生产里的选号器实例必须全部收进本表（多一个 = 新实例零守卫，少一个 = 改名没跟上）', () => {
    const found = [...INDEX.matchAll(/const (\w+) = new BuddyBalanceSelector\(/g)].map((m) => m[1]!)
    // 集合相等：漏收与多收都红（与 balance-cache-wiring 的表同一纪律）。
    expect([...found].sort()).toEqual(SELECTORS.map((s) => s.name).sort())
  })

  it('★★ 每个 mustDetailed 的实例都必须真的接上（漏接 ⇒ 报错降级成概括文案）', () => {
    const missing: string[] = []
    for (const entry of SELECTORS) {
      const block = selectorBlockOf(entry.name)
      expect(block, `★ 找不到 ${entry.name} 的定义（改名了？本表要跟上）`).toBeDefined()
      const wired = isReallyWired(block!, 'fetchBalanceDetailed')
      if (entry.mustDetailed && !wired) missing.push(entry.name)
      // 豁免的实例**不得**接：接了说明上游已经补了带原因变体，本表要改成 mustDetailed。
      if (!entry.mustDetailed && wired) {
        throw new Error(`${entry.name} 已接 fetchBalanceDetailed，请把本表的 mustDetailed 改成 true`)
      }
    }
    expect(missing, `★ 以下选号器漏接 fetchBalanceDetailed：${JSON.stringify(missing)}`).toEqual([])
  })

  it('★ 豁免项必须写明理由（防止「懒得查」被写成豁免）', () => {
    for (const entry of SELECTORS) {
      if (entry.mustDetailed) continue
      expect(entry.exemptReason, `★ ${entry.name} 豁免却没写理由`).toBeTruthy()
      expect(entry.exemptReason!.length).toBeGreaterThan(6)
    }
  })

  it('★ 接了详细变体的都必须**同时**保留薄封装（分档器读 fetchBalance、报错读 Detailed）', () => {
    for (const entry of SELECTORS) {
      if (!entry.mustDetailed) continue
      const block = selectorBlockOf(entry.name)!
      expect(isReallyWired(block, 'fetchBalance'), `★ ${entry.name} 缺 fetchBalance`).toBe(true)
      expect(isReallyWired(block, 'fetchBalanceDetailed'), `★ ${entry.name} 缺 fetchBalanceDetailed`).toBe(true)
    }
  })

  /**
   * ★ 两站**必须各传自己的 product**（真实缺陷形态见 `qoderBalanceSelector` 的注释：
   * 互换的后果不是报错而是静默 —— 余额恒查不到）。
   *
   * 这条只看 `fetchBalanceDetailed` 那一行有没有把 `product` 透出去，
   * 不重复守 `fetchBalance` 那条腿（`qoder-lock-wiring.spec.ts` 已守）。
   */
  it('★ 详细变体必须透传各自的 product（两站不许共用一个）', () => {
    // ⚠️ 2026-10-21 起 Qoder 两家多传了第三参 `{ fetcher: … }`（per-账号出口
    // 代理）⇒ 正则把第三参写成**可选组**，本条的职责仍是「前两参是
    // `credential, product`」这一个判断。「fetcher 那层在位」由
    // `tests/unit/qoder-proxy.spec.ts` 单独守 —— 两处各守一件事，避免一处
    // 形态变动把两条不变式一起打红（也就分不清是哪条坏了）。
    const qoderDetailed = /fetchQoderBalanceDetailed\(credential, product(?:,[\s\S]*?\{\s*fetcher:[\s\S]*?\})?\)/
    const perProduct: Array<[string, RegExp]> = [
      ['qoderBalanceSelector', qoderDetailed],
      ['qoderCnBalanceSelector', qoderDetailed],
      // ⚠️ 2026-10-25（上游 `bdccce0` 起）：第二实参不再是裸 `fetch`，而是
      // **按账号取出口**的 `ctx?.fetchFor?.(ctx.accountId ?? '') ?? fetch` ——
      // 国际站余额端点也在 `agent.minimax.io` 上，大陆出口恒 307。
      // 本条职责仍是「**product 作为第三参透传**」（写死 `MINIMAX_INTL` 会让
      // 国际站余额恒查不到而静默剔除）；「fetchFor 那层真在位」由
      // `tests/unit/minimax-proxy.spec.ts` 的「credits 表 fetchBalanceDetailed
      // 按 call.accountId 取出口」**行为级**守着 —— 与上面 Qoder 的注释同一个分工。
      ['minimaxIntlBalanceSelector', /fetchMinimaxCreditBalanceDetailed\(\s*credential,\s*[\s\S]*?\bproduct,\s*pool\.minimaxXff\(\),?\s*\)/],
      ['autoclawIntlBalanceSelector', /fetchAutoclawBalanceDetailed\(credential, \{ product \}\)/],
      ['astudioBalanceSelector', /fetchAstudioBalanceDetailed\(credential, product === undefined \? \{\} : \{ product \}\)/],
    ]
    for (const [name, pattern] of perProduct) {
      const block = selectorBlockOf(name)!
      expect(block, `★ ${name} 的详细变体接线形态变了（本表要跟上）`).toMatch(pattern)
    }
  })

  /**
   * ★ **反例守卫**：`src/index.ts` 里不许再出现「选号路径直接调薄封装当唯一取数」
   * 这类**新增的未接详细变体**实例 —— 由上面的集合相等兜住。
   *
   * 但还有一条独立的坑：`minimaxIntl` 的详细变体**必须**带 `pool.minimaxXff()`。
   * 不给 xff 会让请求落到别的区域 ⇒ 余额恒查不到，而**症状与「真的没钱」一样**
   * （都是 `null`），只有这条源码断言能区分。
   */
  it('★ minimax 国际站的详细变体必须带 xff（漏了 ⇒ 余额恒查不到且症状与没钱相同）', () => {
    const block = selectorBlockOf('minimaxIntlBalanceSelector')!
    expect(block).toContain('pool.minimaxXff()')
    // 中国站不得带 xff（那是国际站的地理分流）。
    const cn = selectorBlockOf('minimaxBalanceSelector')!
    expect(cn).not.toContain('minimaxXff')
  })
})

/**
 * ★★ 判据**自证有牙**（2026-10-25 审计 A3-3）。
 *
 * ⚠️ 这三条是本文件最重要的部分：`isReallyWired` 是文本级判据，而文本级判据
 * 最常见的失败模式是「看起来在判，其实任何写法都能过」。实测旧判据
 * （`/\bfetchBalanceDetailed\s*:/`）对下面三种绕过**全部放行**（47 passed 全绿），
 * 而它们在运行时**都等于没接**：
 *
 * | 绕过 | 形态 | 运行时后果 |
 * |---|---|---|
 * | 值假 | `fetchBalanceDetailed: undefined as never` | 传了 `undefined` ⇒ 与没传等价 |
 * | 注释掉 | `// fetchBalanceDetailed: fn` | 键根本不存在 |
 * | 死条件展开 | `...(false ? { fetchBalanceDetailed } : {})` | 展开结果恒空 |
 *
 * ⇒ 用内联字符串直接喂判据，锁住「这三种必须被判为**没接**」。
 */
describe('★★ isReallyWired 判据自证（三种已知绕过必须全被判为「没接」）', () => {
  it('★★ 值假 / 注释掉 / 死条件展开 —— 三种都必须判为「没接」', () => {
    // ① 正常接线（必须判为「接了」—— 否则判据恒假、把好代码也拦住）
    expect(isReallyWired('{ fetchBalanceDetailed: realFn, }', 'fetchBalanceDetailed')).toBe(true)
    // ② 值假
    expect(isReallyWired('{ fetchBalanceDetailed: undefined as never, }', 'fetchBalanceDetailed')).toBe(false)
    expect(isReallyWired('{ fetchBalanceDetailed: undefined, }', 'fetchBalanceDetailed')).toBe(false)
    expect(isReallyWired('{ fetchBalanceDetailed: null, }', 'fetchBalanceDetailed')).toBe(false)
    expect(isReallyWired('{ fetchBalanceDetailed: false, }', 'fetchBalanceDetailed')).toBe(false)
    // ③ 死条件展开
    expect(
      isReallyWired('{ ...(false ? { fetchBalanceDetailed } : {}), }', 'fetchBalanceDetailed'),
      '死条件展开被判为已接线 —— 运行时展开恒空，等于没接',
    ).toBe(false)
    // ④ 键不存在
    expect(isReallyWired('{ fetchBalance: thinFn, }', 'fetchBalanceDetailed')).toBe(false)
    // ⑤ 键存在但值为空
    expect(isReallyWired('{ fetchBalanceDetailed: , }', 'fetchBalanceDetailed')).toBe(false)
  })

  it('★★ 剥注释后，注释里的键名不得让判据通过（A3-3 的第二种绕过）', () => {
    const commented = stripComments('{\n  // fetchBalanceDetailed: realFn,\n  fetchBalance: thinFn,\n}')
    expect(commented, '剥注释没生效 ⇒ 注释里的键名会让判据假绿').not.toContain('fetchBalanceDetailed')
    expect(isReallyWired(commented, 'fetchBalanceDetailed')).toBe(false)
  })
})
