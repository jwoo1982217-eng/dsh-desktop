/**
 * ★★ MiniMax **续期机制重构**的行为级守卫（2026-10-27 审计后补）。
 *
 * ## 为什么必须有这个文件
 *
 * 子审计员在独立 worktree 里跑了 56 个变异，其中最硬的一条是：
 *
 * > 把 **M1（`renewJitterMs` 恒 0）+ M26（`index.ts` 两站巡检接线删掉）
 * > + M16（60s 预判改回旧判据）+ M40（journal 永不写盘）同时注入**、tsc 干净后
 * > 跑全量 ⇒ `3 failed / 11025 passed`，**与基线逐字相同**。
 *
 * 也就是说：**把「拆掉全池同秒过期」这件 PR 存在的唯一理由整个拆掉，
 * 测试报告一个字都不变。** 本文件专治这一格。
 *
 * ## 覆盖的机制（每条都做过变异验证，见各 `it` 的注释）
 *
 * | 机制 | 修前状态 | 变异（改坏后） |
 * |---|---|---|
 * | `renewJitterMs` 错峰散列 | `tests/` 零命中 | `() => 0` ⇒ **必须红** |
 * | `startRenewPatrol` 首轮 / 幂等 / stop / 防重入 | 零命中 | 删任一 ⇒ **必须红** |
 * | `stopRenewPatrol`（fiber 卸载回收） | **不存在**（审计补的） | 不 clear ⇒ **必须红** |
 * | `isMinimaxExpiringWithin` 临期预判 | 零命中 | 改 fail-closed / 常量→0 ⇒ **必须红** |
 * | `grantWithSalvage` 第 1 层重试 + 层级合并 | 零命中 | 删重试 / 断层级 ⇒ **必须红** |
 * | `refreshAccountCredential` 的单飞（去重） | 只覆盖了 `renewEntry` | 改回「等完再发」⇒ **必须红** |
 * | journal 落盘 / 不注入不写盘 | 零命中 | 删 `journalHome` ⇒ **必须红** |
 *
 * ⚠️ 铁律：不发真实网络（`fetch` 全注入）、不写真实用户目录（`journalHome`
 *   显式指向临时目录；不传时探测「绝不写盘」）、不读真实凭据。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MinimaxAuth, parseMinimaxCredential, renewJitterMs } from '../../src/minimax-auth.js'
import { MINIMAX } from '../../src/minimax-product.js'
import { appendMinimaxJournal } from '../../src/minimax-refresh-journal.js'
import { isMinimaxExpiringWithin, isMinimaxExpired } from '../../src/minimax.js'

const temps: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  temps.length = 0
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

/** 一条可续期的凭据（`remainingMs` 决定它还剩多久）。 */
function credential(remainingMs: number, extra: Record<string, unknown> = {}) {
  return {
    access_token: 'A'.repeat(60),
    refresh_token: 'R'.repeat(60),
    token_type: 'Bearer',
    expires_at: String(Date.now() + remainingMs),
    scope: 'agent.default',
    ...extra,
  }
}

/** 造一个可变凭据存储 + 真 `Context`。 */
function makeEnv(options: {
  store: Map<string, string>
  fetcher?: typeof fetch
  journalHome?: string
  sleep?: (ms: number) => Promise<void>
}) {
  const writes: string[] = []
  const ctx = new Context()
  ctx.provide('credentials', {
    resolve: async (ref: unknown) => {
      const value = options.store.get(String(ref))
      return value === undefined ? undefined : { value }
    },
    set: async (ref: unknown, value: string) => {
      writes.push(String(ref))
      options.store.set(String(ref), value)
    },
    describe: async () => ({ source: 'file' }),
  } as never)
  const auth = new MinimaxAuth(ctx, {
    product: MINIMAX,
    ...(options.fetcher === undefined ? {} : { fetchImpl: options.fetcher as never }),
    ...(options.journalHome === undefined ? {} : { journalHome: options.journalHome }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  })
  return { auth, writes }
}

/** 上游 grant 成功的响应。 */
function grantOk(n = 1): Response {
  return new Response(JSON.stringify({
    access_token: 'B'.repeat(58) + String(n).padStart(2, '0'),
    refresh_token: `RT-NEW-${n}`,
    token_type: 'bearer',
    expires_in: 3600,
    scope: 'agent.default',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

// ─────────────────────────────────────────────────────────────
// ① 错峰散列：PR「拆掉全池同秒过期」的**唯一机制**
// ─────────────────────────────────────────────────────────────

describe('★★ renewJitterMs：错峰散列（PR 的核心卖点，修前零用例）', () => {
  const SPAN = 10 * 60_000

  it('★ 确定性：同一账号两次算出的抖动必须相同（否则错峰退化成洗牌）', () => {
    for (const id of ['minimax-5aac2759', 'minimaxintl-6d76168a', 'acct-1']) {
      expect(renewJitterMs(id, SPAN), `${id} 两次结果不一致`).toBe(renewJitterMs(id, SPAN))
    }
  })

  it('★ 取值域：必须落在 [0, span) 且为**非负整数**', () => {
    for (const id of ['a', 'minimax-00000000', 'minimax-ffffffff', 'x'.repeat(80)]) {
      const jitter = renewJitterMs(id, SPAN)
      expect(Number.isInteger(jitter), `${id} 的抖动不是整数：${jitter}`).toBe(true)
      // ⚠️ 负值会让续期阈值**变小**（错峰方向翻转）—— `Math.abs(-2147483648)` 的经典坑
      expect(jitter, `${id} 的抖动为负：${jitter}`).toBeGreaterThanOrEqual(0)
      expect(jitter, `${id} 的抖动越界：${jitter}`).toBeLessThan(SPAN)
    }
  })

  it('★★ 真散开：一批账号必须落在**多个不同**的桶里（`() => 0` 会在这里死）', () => {
    /**
     * ⚠️ 判据用「**不同取值的个数**」而不是「两两不等」：djb2 对
     * 「只差末位」的 id 会给出极近的值（实测 `…0a` 与 `…0b` 都 ≈6.66min），
     * 「两两不等」是**过强**的断言，会把一个可接受实现判红。
     */
    const ids = Array.from({ length: 40 }, (_, i) => `minimax-${(i * 2654435761 % 0xffffffff).toString(16)}`)
    const distinct = new Set(ids.map((id) => renewJitterMs(id, SPAN)))
    expect(
      distinct.size,
      `40 个账号只算出 ${distinct.size} 种抖动 ⇒ 错峰失效（恒 0 或近似常数）`,
    ).toBeGreaterThan(20)
  })

  it('★ 跨度必须覆盖大半个窗口（不能都挤在 0 附近）', () => {
    /**
     * ⚠️ id 必须**形状接近生产**（`minimax-` + 8 位随机 hex）且有足够长度差异：
     * djb2 对「只差末位字符」的输入会给出极近的值（实测 `…0a`/`…0b` 都是 6.66min），
     * 用递增数字造 40 个 id 会让跨度断言假红。
     */
    const ids = Array.from({ length: 40 }, (_, i) => {
      // 确定性伪随机（不用 Math.random，保证用例可复现）
      const hex = ((i * 2654435761) ^ (i * 40503) ^ (i << 13)) >>> 0
      return `minimax-${hex.toString(16).padStart(8, '0')}`
    })
    const values = ids.map((id) => renewJitterMs(id, SPAN))
    const spread = Math.max(...values) - Math.min(...values)
    expect(spread, `抖动跨度只有 ${(spread / 60_000).toFixed(1)} 分钟 ⇒ 错峰几乎不存在`)
      .toBeGreaterThan(SPAN * 0.5)
  })

  it('边界：span = 0 / 负数 / NaN ⇒ 恒 0（不崩、不 NaN）', () => {
    // ⚠️ `% 0` 是 NaN，而 NaN 会让续期阈值变 NaN ⇒ `expiresAt - now > NaN`
    //    恒 false ⇒ **每轮都续**（巡检退化成全量轮换）。这是零除的真实后果。
    expect(renewJitterMs('a1', 0)).toBe(0)
    expect(renewJitterMs('a1', -1)).toBe(0)
    expect(renewJitterMs('a1', Number.NaN)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────
// ② 巡检：首轮 / 幂等 / 防重入 / stop
// ─────────────────────────────────────────────────────────────

describe('★★ startRenewPatrol / stopRenewPatrol（修前零用例）', () => {
  const REF = 'MINIMAX_ACCOUNT_P1'

  it('★ 立即先跑一轮（宿主重启后不该等满 60s）', async () => {
    const store = new Map([[REF, JSON.stringify(credential(-60_000))]])
    let grants = 0
    const { auth } = makeEnv({
      store,
      fetcher: (async () => { grants += 1; return grantOk() }) as never,
    })
    const pool = {
      listAccounts: async () => [{ id: 'p1', credentialRef: REF, refreshable: true, enabled: true }],
      updateAccount: async () => {},
    } as never
    auth.startRenewPatrol(pool)
    // ⚠️ 不给任何时间推进：首轮必须是**同步发起**的
    await vi.waitFor(() => { expect(grants, '巡检没有立即跑首轮').toBeGreaterThan(0) })
    auth.stopRenewPatrol()
  })

  it('★★ 幂等：重复 start 只装**一个**定时器（否则热重载会叠加 N 条）', async () => {
    /**
     * ⚠️ 判据必须**推进假时钟看 tick 次数**，不能只断言「首轮跑了一次」——
     * 首轮是 `void tick()` 直接调的，与装了几个定时器**无关** ⇒
     * 那样写的话「幂等删掉」照样绿（实测变异 M-巡检幂等失效 = GREEN）。
     */
    vi.useFakeTimers()
    const store = new Map([[REF, JSON.stringify(credential(10 * 3_600_000))]])
    const { auth } = makeEnv({ store, fetcher: (async () => grantOk()) as never })
    let listCalls = 0
    const pool = {
      listAccounts: async () => { listCalls += 1; return [] },
      updateAccount: async () => {},
    } as never
    auth.startRenewPatrol(pool)
    auth.startRenewPatrol(pool)
    auth.startRenewPatrol(pool)
    await vi.advanceTimersByTimeAsync(10)
    const afterStart = listCalls
    expect(afterStart, '首轮未跑').toBeGreaterThan(0)
    // 推进一个完整周期：**只能**多 1 轮（装了 3 个定时器 ⇒ +3）
    await vi.advanceTimersByTimeAsync(60_000)
    expect(
      listCalls - afterStart,
      `一个周期内跑了 ${listCalls - afterStart} 轮 ⇒ startRenewPatrol 不幂等（装了多个定时器）`,
    ).toBe(1)
    auth.stopRenewPatrol()
  })

  it('★★ 防重入：一轮没跑完时**跳过**本轮（不叠加并发）', async () => {
    /**
     * ⚠️ 判据必须看「同一时刻的并发轮数」+「tick 是否被跳过」：
     * 只断言 `peak <= 1` 在 patrolBusy 删掉后**仍成立**（因为每轮是 await 串行的），
     * 实测变异 M-patrolBusy 删 = GREEN。真正的差别是**listAccounts 的调用次数**：
     * 有闸门时，一轮未完的那次 tick 直接 return（不读池）。
     */
    vi.useFakeTimers()
    const store = new Map([[REF, JSON.stringify(credential(-60_000))]])
    let listCalls = 0
    let concurrent = 0
    let peak = 0
    const { auth } = makeEnv({
      store,
      fetcher: (async () => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        // 让本轮跨过多个 tick 周期
        await new Promise((r) => setTimeout(r, 200_000))
        concurrent -= 1
        return grantOk()
      }) as never,
    })
    const pool = {
      listAccounts: async () => {
        listCalls += 1
        return [{ id: 'p1', credentialRef: REF, refreshable: true, enabled: true }]
      },
      updateAccount: async () => {},
    } as never
    auth.startRenewPatrol(pool)
    await vi.advanceTimersByTimeAsync(10)
    const afterStart = listCalls
    // 首轮在飞（要 200s）——推进 3 个周期，这 3 次 tick 都应被闸门挡掉
    await vi.advanceTimersByTimeAsync(180_000)
    expect(
      listCalls - afterStart,
      '★ 一轮未跑完时仍在读池/开新一轮 ⇒ patrolBusy 防重入失效（同一账号会被并发续期）',
    ).toBe(0)
    expect(peak, '同一账号被并发续期').toBeLessThanOrEqual(1)
    auth.stopRenewPatrol()
  })

  it('★★ stopRenewPatrol 必须真的停掉定时器（fiber 卸载后不得继续轮换）', async () => {
    vi.useFakeTimers()
    const store = new Map([[REF, JSON.stringify(credential(-60_000))]])
    let grants = 0
    const { auth } = makeEnv({
      store,
      fetcher: (async () => { grants += 1; return grantOk() }) as never,
    })
    let listCalls = 0
    const pool = {
      listAccounts: async () => {
        listCalls += 1
        // ⚠️ 每轮都"续得动"：让 grants 能随 tick 增长（否则续一次就够 1h 不再续）
        store.set(REF, JSON.stringify(credential(-60_000)))
        return [{ id: 'p1', credentialRef: REF, refreshable: true, enabled: true }]
      },
      updateAccount: async () => {},
    } as never
    auth.startRenewPatrol(pool)
    await vi.advanceTimersByTimeAsync(10)
    const afterStart = listCalls
    expect(afterStart, '首轮未跑').toBeGreaterThan(0)

    auth.stopRenewPatrol()
    await vi.advanceTimersByTimeAsync(10)
    const atStop = listCalls
    await vi.advanceTimersByTimeAsync(300_000)  // 推进 5 分钟 ⇒ 本该有 5 个 tick
    expect(
      listCalls - atStop,
      '★ stop 之后巡检仍在 tick（定时器未清理）⇒ 热重载后两套巡检并发轮换一次性 RT',
    ).toBe(0)
    expect(grants - 0).toBeGreaterThan(0)  // 自检：确认停之前真的跑过

    /**
     * ⚠️ **额外一条：清定时器那一层必须独立可观测**。
     *
     * 上一条断言只证明「停了之后不再读池」，而 `patrolStopped` 单独就能做到
     * 这一点（tick 开头 return）⇒ 若把 `clearInterval` 删掉、只留置位，
     * 上一条**仍然绿**（实测变异 `M-stop 不清定时器` = GREEN）。
     *
     * 但「定时器没清」有独立后果：**它还在事件循环里每 60s 醒一次**
     * （`unref` 只是不阻止退出，不回收）。热重载多次 ⇒ 这一堆空转定时器
     * 会持续累积，且每次醒都碰一次已卸载实例的 `this`（在极端情况下若
     * `patrolStopped` 被未来改动去掉，它们会立刻重新开始轮换）。
     *
     * ⇒ 判据：`stop` 之后 `patrolTimer` 必须为 `undefined`。这是类的私有状态，
     *   但它是**这一层防护唯一可观测的现象**；用结构化读（不经 getter）断言，
     *   避免为测试专门开一个 API（那会让「忘了清」也能靠 getter 假装清过）。
     */
    const timerAfterStop = (auth as unknown as { patrolTimer?: unknown }).patrolTimer
    expect(
      timerAfterStop,
      '★ stop 之后定时器句柄仍存在 ⇒ clearInterval 没被调用（空转定时器会随热重载累积）',
    ).toBeUndefined()

    /**
     * ⚠️⚠️ **最强那一层：定时器必须真的从事件循环里消失**。
     *
     * 只看 `patrolTimer === undefined` 抓不到「把 `clearInterval` 删掉、只把字段
     * 置空」这种写法（实测变异 `M-stop 不清定时器` 就一直绿）—— 字段清了，
     * 但**句柄仍挂在事件循环里每 60s 醒一次**。
     *
     * ⇒ 用假时钟的 `vi.getTimerCount()`（实测：`clearInterval` 后归 0、
     *   只丢引用仍是 1）。⚠️ **必须是绝对判据 `toBe(0)`**：
     *   拿 `stop` 前的计数当上界是恒真的（那个定时器本身就在计数里）。
     */
    await vi.advanceTimersByTimeAsync(180_000)
    expect(
      vi.getTimerCount(),
      '★ 定时器仍在事件循环里（clearInterval 未调用）—— 它每 60s 醒一次空转，热重载会累积',
    ).toBe(0)
  })

  it('★★ stop 必须让**在飞的那一轮**在下一个账号前退出（只清定时器不够）', async () => {
    /**
     * ⚠️ 这条守的是 `patrolStopped` 这一格 —— 只 `clearInterval` **不够**：
     * 在飞的一轮可能正卡在某个 `await grant` 上，它醒来后会继续 for 循环，
     * 把**剩余账号**全部轮换一遍。而那时 fiber 已经卸载了（实例被 dispose），
     * 它读的却是**共享的** credentials 后端 ⇒ 会真的对上游发 grant。
     *
     * 实测：删掉 `this.patrolStopped = true` 后，本用例必须红。
     */
    vi.useFakeTimers()
    const REF_A = 'MINIMAX_ACCOUNT_INFLIGHT_A'
    const REF_B = 'MINIMAX_ACCOUNT_INFLIGHT_B'
    const store = new Map([
      [REF_A, JSON.stringify(credential(-60_000))],
      [REF_B, JSON.stringify(credential(-60_000))],
    ])
    /** A 的 grant 要等很久 —— 给我们时间在它飞的时候调 stop。 */
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => { releaseA = r })
    const renewedAccounts: string[] = []
    const { auth } = makeEnv({
      store,
      sleep: async () => {},
      fetcher: (async (_url: string, init: RequestInit) => {
        const rt = new URLSearchParams(String(init.body)).get('refresh_token') ?? ''
        const which = rt.includes('AAAA') ? 'A' : 'B'
        renewedAccounts.push(which)
        if (which === 'A') await gateA
        return grantOk(renewedAccounts.length)
      }) as never,
    })
    // ⚠️ 让两条账号的 RT 可区分
    store.set(REF_A, JSON.stringify(credential(-60_000, { refresh_token: 'RT-AAAA' })))
    store.set(REF_B, JSON.stringify(credential(-60_000, { refresh_token: 'RT-BBBB' })))
    const pool = {
      listAccounts: async () => [
        { id: 'a', credentialRef: REF_A, refreshable: true, enabled: true },
        { id: 'b', credentialRef: REF_B, refreshable: true, enabled: true },
      ],
      updateAccount: async () => {},
    } as never
    auth.startRenewPatrol(pool)
    // 让首轮跑到 A 的 grant（卡在 gate 上）
    await vi.advanceTimersByTimeAsync(10)
    expect(renewedAccounts, '首轮没跑到 A').toContain('A')
    expect(renewedAccounts, '首轮不该在 stop 前就到 B').not.toContain('B')

    auth.stopRenewPatrol()   // ← 在 A 飞的时候停
    releaseA()               // 放行 A
    await vi.advanceTimersByTimeAsync(10)

    expect(
      renewedAccounts,
      '★ stop 之后在飞的那一轮仍继续轮换剩余账号 ⇒ 已卸载实例会继续对上游换钥匙'
      + `（实际续了 ${renewedAccounts.join(',')}）`,
    ).not.toContain('B')
  })

  it('★ stop 幂等：连调两次不抛', () => {
    const { auth } = makeEnv({ store: new Map() })
    auth.stopRenewPatrol()
    auth.stopRenewPatrol()
  })
})

// ─────────────────────────────────────────────────────────────
// ③ 临期预判：60s 窗口（PR 从 isMinimaxExpired 改过来的那条腿）
// ─────────────────────────────────────────────────────────────

describe('★★ isMinimaxExpiringWithin：请求前预判（修前零用例）', () => {
  it('剩余 30s ⇒ 该续（true）；剩余 120s ⇒ 不该续（false）', () => {
    expect(isMinimaxExpiringWithin(credential(30_000) as never, 60_000)).toBe(true)
    expect(isMinimaxExpiringWithin(credential(120_000) as never, 60_000)).toBe(false)
  })

  it('★ 边界：剩余**恰好** 60s ⇒ 该续（`<=` 而非 `<`）', () => {
    expect(isMinimaxExpiringWithin(credential(60_000) as never, 60_000)).toBe(true)
  })

  it('★ 与旧判据的差别：剩余 30s 时旧判据说"不用续"（这就是 PR 要修的）', () => {
    const soon = credential(30_000)
    expect(isMinimaxExpired(soon as never), '旧判据在 30s 时认为没过期').toBe(false)
    expect(isMinimaxExpiringWithin(soon as never, 60_000), '新判据必须说"该续"').toBe(true)
  })

  it('★★ fail-open：读不到过期时间（缺字段 / 非法串 / 非 JWT）⇒ 该续（true）', () => {
    // 真实 `access_token` 是 `mmoat_` 前缀、非 JWT ⇒ 解不出 exp
    const noExpiry = { access_token: 'mmoat_' + 'a'.repeat(54), refresh_token: 'r' }
    expect(isMinimaxExpiringWithin(noExpiry as never, 60_000)).toBe(true)
    expect(isMinimaxExpiringWithin({ ...noExpiry, expires_at: 'not-a-number' } as never, 60_000)).toBe(true)
    expect(isMinimaxExpiringWithin({ ...noExpiry, expires_at: '' } as never, 60_000)).toBe(true)
  })

  it('已过期（负数剩余）⇒ 该续', () => {
    expect(isMinimaxExpiringWithin(credential(-1) as never, 60_000)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// ④ 抢救链：第 1 层重试 + **层级合并**（修前的层级断裂）
// ─────────────────────────────────────────────────────────────

describe('★★ grantWithSalvage：两层抢救（修前零用例 + 层级断裂）', () => {
  const REF = 'MINIMAX_ACCOUNT_S1'
  const ENTRY = { id: 's1', credentialRef: REF, refreshable: true, expiresAt: 0 }

  it('★ 第 1 层：非终态失败 ⇒ 隔一会儿**同 RT 重试一次**', async () => {
    const store = new Map([[REF, JSON.stringify(credential(-60_000))]])
    const sleeps: number[] = []
    let calls = 0
    const { auth } = makeEnv({
      store,
      sleep: async (ms) => { sleeps.push(ms) },
      fetcher: (async () => {
        calls += 1
        if (calls === 1) throw new TypeError('fetch failed')  // 网络抖动
        return grantOk()
      }) as never,
    })
    const pool = { listAccounts: async () => [], updateAccount: async () => {} } as never
    const out = await auth.renewEntry(pool, ENTRY, { force: true, trigger: 'patrol' })
    expect(out.renewed, '网络抖动后重试一次应当救回').toBe(true)
    expect(calls, '必须恰好两次上游请求（原 + 重试）').toBe(2)
    expect(sleeps.length, '重试前必须有一次退避 sleep').toBe(1)
    expect(sleeps[0], '退避时长必须是常量 1.5s').toBe(1_500)
  })

  it('★★ 层级合并：首轮网络错 → 重试转终态 ⇒ **仍要试历史代际**（修前断在这里）', async () => {
    const store = new Map([[REF, JSON.stringify(credential(-60_000, {
      refresh_token: 'RT-DEAD',
      previous_refresh_tokens: ['RT-OLD-1'],
    }))]])
    const tried: string[] = []
    let calls = 0
    const { auth } = makeEnv({
      store,
      sleep: async () => {},
      fetcher: (async (_url: string, init: RequestInit) => {
        const rt = new URLSearchParams(String(init.body)).get('refresh_token') ?? '?'
        tried.push(rt)
        calls += 1
        if (calls === 1) throw new TypeError('fetch failed')          // 首轮：网络错
        if (rt === 'RT-DEAD') {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
        }
        return grantOk(1)                                            // 旧代际仍有效
      }) as never,
    })
    const pool = { listAccounts: async () => [], updateAccount: async () => {} } as never
    const out = await auth.renewEntry(pool, ENTRY, { force: true, trigger: 'patrol' })
    expect(
      out.renewed,
      '★ 重试转终态后没有回退历史代际 ⇒ 抢救链在「响应丢失」形态（本特性的主场景）下失效',
    ).toBe(true)
    expect(tried, '必须试过历史代际').toContain('RT-OLD-1')
  })

  it('★ 终态全失败（无历史代际）⇒ 抛终态 + 池标 refreshable:false', async () => {
    const store = new Map([[REF, JSON.stringify(credential(-60_000))]])
    const updates: Array<{ id: string; patch: unknown }> = []
    const { auth } = makeEnv({
      store,
      sleep: async () => {},
      fetcher: (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as never,
    })
    const pool = {
      listAccounts: async () => [],
      updateAccount: async (id: string, patch: unknown) => { updates.push({ id, patch }) },
    } as never
    await expect(auth.renewEntry(pool, ENTRY, { force: true })).rejects.toThrow(/refresh_token/)
    expect(
      updates.some((u) => u.id === 's1' && (u.patch as { refreshable?: boolean }).refreshable === false),
      '全失败必须标需重登',
    ).toBe(true)
  })

  it('★★ 终态判据不得把 5xx / 429 判成终态（修前会把好号标死）', async () => {
    for (const [label, status, body] of [
      ['503 + token expired', 503, { error: 'token expired' }],
      ['429 + key expired soon', 429, { error: 'rate limited, key expired soon' }],
    ] as const) {
      const store = new Map([[REF, JSON.stringify(credential(-60_000))]])
      const updates: Array<{ id: string; patch: unknown }> = []
      const { auth } = makeEnv({
        store,
        sleep: async () => {},
        fetcher: (async () => new Response(JSON.stringify(body), { status })) as never,
      })
      const pool = {
        listAccounts: async () => [],
        updateAccount: async (id: string, patch: unknown) => { updates.push({ id, patch }) },
      } as never
      await auth.renewEntry(pool, ENTRY, { force: true }).catch(() => undefined)
      expect(
        updates.some((u) => (u.patch as { refreshable?: boolean }).refreshable === false),
        `★ ${label} 被判成终态 ⇒ 一次网关抖动/限流就把健康账号标成"需重登"（单向门，永不自愈）`,
      ).toBe(false)
    }
  })

  it('★★ 传输层证书过期不得判成终态（修前 `certificate has expired` 命中 `expired` 词）', async () => {
    const store = new Map([[REF, JSON.stringify(credential(-60_000))]])
    const updates: Array<{ id: string; patch: unknown }> = []
    const { auth } = makeEnv({
      store,
      sleep: async () => {},
      fetcher: (async () => {
        const err = new TypeError('fetch failed')
        // undici 把真因压在 cause 上
        ;(err as unknown as { cause?: unknown }).cause = new Error('certificate has expired')
        throw err
      }) as never,
    })
    const pool = {
      listAccounts: async () => [],
      updateAccount: async (id: string, patch: unknown) => { updates.push({ id, patch }) },
    } as never
    await auth.renewEntry(pool, ENTRY, { force: true }).catch(() => undefined)
    expect(
      updates.some((u) => (u.patch as { refreshable?: boolean }).refreshable === false),
      '★ 证书过期被当成 RT 失效 ⇒ 代理/证书抖动一次就要求用户重新登录',
    ).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────
// ⑤ 单飞：`refreshAccountCredential` 必须**去重**（不是串行化）
// ─────────────────────────────────────────────────────────────

describe('★★ refreshAccountCredential 的单飞（修前是"等完再发一份"）', () => {
  const REF = 'MINIMAX_ACCOUNT_F1'

  it('★★ 并发 5 次 `refreshAccountCredential` ⇒ 只发 1 份 grant', async () => {
    const store = new Map([[REF, JSON.stringify(credential(10 * 60_000))]])
    let grants = 0
    const { auth } = makeEnv({
      store,
      fetcher: (async () => {
        grants += 1
        await new Promise((r) => setTimeout(r, 20))
        return grantOk(grants)
      }) as never,
    })
    const pool = {
      listAccounts: async () => [],
      updateAccount: async () => {},
      findAccountIdByCredential: async () => 'f1',
    } as never
    await Promise.all(Array.from({ length: 5 }, () =>
      auth.refreshAccountCredential(REF, pool, 'f1').catch(() => undefined)))
    expect(
      grants,
      '★ 并发 N 次 ⇒ N 份 grant（一次性 RT 下必然互废，输家还会把好号标死）',
    ).toBe(1)
  })

  it('★★ `renewEntry` 与 `refreshAccountCredential` 并发 ⇒ 也只发 1 份', async () => {
    const store = new Map([[REF, JSON.stringify(credential(-60_000))]])
    let grants = 0
    const { auth } = makeEnv({
      store,
      fetcher: (async () => {
        grants += 1
        await new Promise((r) => setTimeout(r, 20))
        return grantOk(grants)
      }) as never,
    })
    const pool = {
      listAccounts: async () => [{ id: 'f1', credentialRef: REF, refreshable: true, enabled: true }],
      updateAccount: async () => {},
      findAccountIdByCredential: async () => 'f1',
    } as never
    await Promise.all([
      auth.refreshAccountCredential(REF, pool, 'f1').catch(() => undefined),
      auth.renewEntry(pool, { id: 'f1', credentialRef: REF, refreshable: true, expiresAt: 0 }, { force: true }).catch(() => undefined),
    ])
    expect(grants, '★ 两条入口共用一把锁 ⇒ 合计只能 1 份 grant').toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────
// ⑥ journal：落盘 / 不注入不写盘 / 轮转
// ─────────────────────────────────────────────────────────────

describe('★★ journal（新文件 74 行，修前零用例）', () => {
  it('★ 注入 journalHome ⇒ 成功续期落一条 grant；**不注入 ⇒ 绝不写盘**', async () => {
    const home = tempDir('mm-journal-')
    const REF = 'MINIMAX_ACCOUNT_J1'
    const store = new Map([[REF, JSON.stringify(credential(-60_000))]])
    const { auth } = makeEnv({
      store,
      journalHome: home,
      fetcher: (async () => grantOk()) as never,
    })
    const pool = { listAccounts: async () => [], updateAccount: async () => {} } as never
    await auth.renewEntry(pool, { id: 'j1', credentialRef: REF, refreshable: true, expiresAt: 0 }, { force: true })

    const file = join(home, 'jet-hub', 'refresh-journal.jsonl')
    await vi.waitFor(() => {
      expect(() => readFileSync(file, 'utf8'), 'journal 没有落盘').not.toThrow()
    })
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.length, '一次续期应恰好一条').toBe(1)
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(entry.kind).toBe('grant')
    expect(entry.result).toBe('ok')
    expect(entry.trigger).toBe('patrol')
    expect(entry.accountId).toBe('j1')
    // ⚠️ 敏感值绝不能进日志
    expect(JSON.stringify(entry), 'journal 里出现了 token 原文').not.toContain('AAAA')
    expect(JSON.stringify(entry), 'journal 里出现了 token 原文').not.toContain('RT-NEW')
  })

  it('★ 未注入 journalHome ⇒ 目录里零文件（不得写进用户真实 ~/.dsh）', async () => {
    const home = tempDir('mm-journal-none-')
    const REF = 'MINIMAX_ACCOUNT_J2'
    const store = new Map([[REF, JSON.stringify(credential(-60_000))]])
    const { auth } = makeEnv({ store, fetcher: (async () => grantOk()) as never })
    const pool = { listAccounts: async () => [], updateAccount: async () => {} } as never
    await auth.renewEntry(pool, { id: 'j2', credentialRef: REF, refreshable: true, expiresAt: 0 }, { force: true })
    expect(readdirSync(home), '未注入 home 却写了盘').toEqual([])
  })

  it('★ 超过 5MB ⇒ 轮转到 `.old`（不轮转会让文件无限增长）', async () => {
    const home = tempDir('mm-journal-rot-')
    const dir = join(home, 'jet-hub')
    // 先写一个「已超限」的文件
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'refresh-journal.jsonl')
    writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 10))

    appendMinimaxJournal(home, {
      ts: Date.now(), provider: 'minimax', accountId: 'r1', kind: 'grant', trigger: 'patrol', result: 'ok',
    })
    await vi.waitFor(() => {
      const names = readdirSync(dir)
      expect(names, '超限后没有生成 .old').toContain('refresh-journal.jsonl.old')
      expect(names, '超限后新文件应只有本次那条').toContain('refresh-journal.jsonl')
    })
  })

  it('★ 写盘失败必须**静默**（观测设施不得反噬续期主路径）', () => {
    // 把 home 指向一个**文件**路径 ⇒ mkdir 必然失败
    const fakeHome = join(tempDir('mm-journal-err-'), 'not-a-dir')
    writeFileSync(fakeHome, 'x')
    expect(() => {
      appendMinimaxJournal(fakeHome, {
        ts: Date.now(), provider: 'minimax', accountId: 'e1', kind: 'grant', trigger: 'patrol', result: 'ok',
      })
    }).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────
// ⑦ 解析：`parseMinimaxCredential` 对未知字段透明（`previous_refresh_tokens` 靠它）
// ─────────────────────────────────────────────────────────────

describe('★★ 巡检的 margin 必须来自「5min + 账号抖动」，不能是 0（修前零用例）', () => {
  const REF = 'MINIMAX_ACCOUNT_MG'

  it('★★ 剩余 4 分钟（< 5min margin）⇒ 巡检必须续', async () => {
    vi.useFakeTimers()
    const store = new Map([[REF, JSON.stringify(credential(4 * 60_000))]])
    let grants = 0
    const { auth } = makeEnv({
      store,
      fetcher: (async () => { grants += 1; return grantOk() }) as never,
    })
    const pool = {
      listAccounts: async () => [{ id: 'mg', credentialRef: REF, refreshable: true, enabled: true }],
      updateAccount: async () => {},
    } as never
    auth.startRenewPatrol(pool)
    await vi.advanceTimersByTimeAsync(10)
    auth.stopRenewPatrol()
    expect(grants, '★ 剩余 4 分钟却没续 ⇒ 巡检 margin 失效（=0 时这个账号会被漏）。').toBe(1)
  })

  it('★★ 剩余时间落在「margin + 抖动」区间内 ⇒ 只有**一部分**账号被续（margin 的判别式）', async () => {
    /**
     * ⚠️⚠️ 这一格才是「margin 常量」的**判别式**，构造必须精确。
     *
     * 上一格（剩余 4min 必须续）在 `margin = 0` 时**仍然通过**（0 也会续临期账号），
     * 而「剩余 14min ⇒ 一个都不该续」在 `margin = 0` 时**只红一半**
     * （`renewed.size === 0` 与 `< ids.length` 都成立 ⇒ 变异逃逸，实测 GREEN）。
     *
     * ⇒ 必须选一个**落在阈值区间内部**的剩余时间，让正常实现只续**一部分**：
     * 实测这批 id 的阈值分布是 `5.4 / 5.7 / 6.3 / 7.0 / 8.2 / 9.4 / 9.6 / 11.8 / 12.0 / 14.2`（分钟）
     * ⇒ **剩余 8 分钟**时：阈值 < 8 的那部分会续，其余不续 ⇒
     *   - 正常实现：`0 < renewed < 全部`（**既能抓到 `margin=0` 的全续，也能抓到 margin 过大时的全不续**）；
     *   - `margin = 0`：全部续（红）；
     *   - `margin = 1h`：全部不续（红）；
     *   - `jitter span = 0`：全部阈值 5min ⇒ 8min 全不续（红）。
     */
    vi.useFakeTimers()
    const ids = Array.from({ length: 12 }, (_, i) => `minimax-${(i * 2654435761 >>> 0).toString(16)}`)
    const store = new Map(ids.map((_, i) => [
      `MINIMAX_ACCOUNT_MG${i}`,
      // ⚠️ 每条账号用**各自的** refresh_token（否则 renewed 是 Set、全部去重成 1 个）
      JSON.stringify(credential(8 * 60_000, { refresh_token: `RT-MG-${i}` })),
    ]))
    const renewed = new Set<string>()
    const { auth } = makeEnv({
      store,
      fetcher: (async (_url: string, init: RequestInit) => {
        const rt = new URLSearchParams(String(init.body)).get('refresh_token') ?? ''
        renewed.add(rt)
        return grantOk(renewed.size)
      }) as never,
    })
    const pool = {
      listAccounts: async () => ids.map((id, i) => ({
        id, credentialRef: `MINIMAX_ACCOUNT_MG${i}`, refreshable: true, enabled: true,
      })),
      updateAccount: async () => {},
    } as never
    auth.startRenewPatrol(pool)
    await vi.advanceTimersByTimeAsync(10)
    auth.stopRenewPatrol()
    /**
     * ⚠️⚠️ 判据必须是**精确计数**，不能是 `0 < x < 12` 那种区间断言。
     *
     * 实测这 12 个 id 在「剩余 8 分钟」下的续期个数：
     * | margin | 续期数 |
     * |---|---|
     * | **5min（正确值）** | **7** |
     * | 0（退化） | 1 |
     * | 1h（放大） | 12 |
     * | jitter span = 0 | 0 |
     *
     * ⇒ 区间断言 `0 < x < 12` 只抓住后两行，**`margin=0` 从 7 掉到 1 照样绿**
     *   （实测变异 W2 = GREEN）。精确计数才同时钉住四个方向。
     *
     * ⚠️ 若将来改了 `MINIMAX_RENEW_MARGIN_MS` / 抖动跨度（这是**有意的**行为变更），
     *   本数字要随之更新 —— 它是一张「口径快照」，不是恒真式。
     */
    expect(
      renewed.size,
      '★ 「剩余 8 分钟 × 12 个账号」只该续 7 个（margin 5min + 抖动 0-10min）；'
      + '数字变了说明 margin / 抖动跨度被改动',
    ).toBe(7)
  })

  it('★★ 剩余 60 分钟（远超 margin + 抖动上限 15min）⇒ 巡检**不得**续（否则轮换次数暴涨）', async () => {
    vi.useFakeTimers()
    const store = new Map([[REF, JSON.stringify(credential(60 * 60_000))]])
    let grants = 0
    const { auth } = makeEnv({
      store,
      fetcher: (async () => { grants += 1; return grantOk() }) as never,
    })
    const pool = {
      listAccounts: async () => [{ id: 'mg', credentialRef: REF, refreshable: true, enabled: true }],
      updateAccount: async () => {},
    } as never
    auth.startRenewPatrol(pool)
    // 推进 20 分钟（=> 20 个 tick），远不够 45min 的阈值
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    auth.stopRenewPatrol()
    expect(
      grants,
      '★ 剩余 60 分钟就开始续 ⇒ margin 失效（轮换次数会重新逼近 48 次/天，PR 的目标不成立）',
    ).toBe(0)
  })
})

describe('★ parseMinimaxCredential：未知字段必须透传（抢救链依赖它）', () => {
  it('`previous_refresh_tokens` 不得被解析吞掉', () => {
    const parsed = parseMinimaxCredential(JSON.stringify({
      access_token: 'a', refresh_token: 'r', previous_refresh_tokens: ['old-1', 'old-2'],
    }))
    expect(parsed?.previous_refresh_tokens).toEqual(['old-1', 'old-2'])
  })
})

// ─────────────────────────────────────────────────────────────
// ⑧ `refreshAll` 只对账：不得发 grant（PR 的核心改动）
// ─────────────────────────────────────────────────────────────

describe('★★ refreshAll 只对账（PR 的核心改动）', () => {
  const REF = 'MINIMAX_ACCOUNT_R1'

  it('★★ 凭据已过期 2 小时 ⇒ 仍然**不发任何 grant**（轮换权已移交巡检）', async () => {
    const store = new Map([[REF, JSON.stringify(credential(-2 * 3_600_000))]])
    let grants = 0
    const { auth } = makeEnv({
      store,
      fetcher: (async () => { grants += 1; return grantOk() }) as never,
    })
    const pool = {
      listAccounts: async () => [{ id: 'r1', credentialRef: REF, refreshable: true, enabled: true, expiresAt: 0 }],
      updateAccount: async () => {},
      findAccountIdByCredential: async () => 'r1',
    } as never
    await auth.refreshAll(pool)
    expect(grants, '★ refreshAll 又发 grant 了 ⇒ 30min tick 全量轮换的老形态回来了').toBe(0)
  })

  it('★ 但仍要把凭据里的真实有效期镜像回池（否则 UI 恒显「已过期」）', async () => {
    const store = new Map([[REF, JSON.stringify(credential(3 * 3_600_000))]])
    const updates: Array<{ id: string; patch: unknown }> = []
    const { auth } = makeEnv({ store, fetcher: (async () => grantOk()) as never })
    const pool = {
      listAccounts: async () => [{ id: 'r1', credentialRef: REF, refreshable: true, enabled: true, expiresAt: 0 }],
      updateAccount: async (id: string, patch: unknown) => { updates.push({ id, patch }) },
      findAccountIdByCredential: async () => 'r1',
    } as never
    await auth.refreshAll(pool)
    expect(
      updates.some((u) => u.id === 'r1' && typeof (u.patch as { expiresAt?: number }).expiresAt === 'number'),
      '池镜像没有更新 ⇒ UI 永远显示「已过期」',
    ).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// ⑨ 生命周期闭环：stop 之后**重新 start** 必须恢复巡检
// ─────────────────────────────────────────────────────────────

describe('★★ 巡检的 stop → start 闭环（`patrolStopped` 不得粘滞）', () => {
  const REF = 'MINIMAX_ACCOUNT_RS'

  it('★★ stop 之后再 start ⇒ 巡检必须恢复（否则永久静默空转）', async () => {
    /**
     * ⚠️ 缺陷形态（2026-10-27 自审发现）：修前 `startRenewPatrol` 只判
     * `patrolTimer !== undefined`，而 `stopRenewPatrol` 会把 `patrolStopped`
     * 置 `true` —— **粘滞**。于是 stop → start 拿到一个**永久空转的定时器**：
     * tick 每次第一行就 return，巡检再也不续期，而 `patrolTimer` 又非空
     * ⇒ 连幂等短路都挡住后续 start。症状是「账号再也不自动续期、日志零字」。
     *
     * 生产当前不可达（每次 `apply()` 都 `new MinimaxAuth`），但它是一颗哑弹：
     * 任何「实例复用 / 把 start 挪进 ctx.effect / 用例间共享实例」的改动都会踩上。
     */
    vi.useFakeTimers()
    const store = new Map([[REF, JSON.stringify(credential(-60_000))]])
    let grants = 0
    const { auth } = makeEnv({
      store,
      fetcher: (async () => { grants += 1; return grantOk(grants) }) as never,
    })
    const pool = {
      listAccounts: async () => {
        // 每轮都「临期」，让 grants 能随 tick 增长
        store.set(REF, JSON.stringify(credential(-60_000)))
        return [{ id: 'rs', credentialRef: REF, refreshable: true, enabled: true }]
      },
      updateAccount: async () => {},
    } as never

    auth.startRenewPatrol(pool)
    await vi.advanceTimersByTimeAsync(10)
    expect(grants, '首轮未跑').toBeGreaterThan(0)

    auth.stopRenewPatrol()
    const atStop = grants
    await vi.advanceTimersByTimeAsync(120_000)
    expect(grants, 'stop 之后仍在续期（clearInterval 未生效）').toBe(atStop)

    // ★ 重新 start
    auth.startRenewPatrol(pool)
    await vi.advanceTimersByTimeAsync(10)
    expect(
      grants,
      '★ stop 之后重新 start 却不再续期 ⇒ `patrolStopped` 粘滞，巡检永久静默空转',
    ).toBeGreaterThan(atStop)
    auth.stopRenewPatrol()
  })
})

// ─────────────────────────────────────────────────────────────
// ⑩ 第二轮审计修的四格（每条都对应一处实测击穿）
// ─────────────────────────────────────────────────────────────

describe('★★ 终态冷却：判明 RT 已死后不得每 60s 重打（第二轮审计打穿）', () => {
  const REF = 'MINIMAX_ACCOUNT_COOL'

  /** 造一个「RT 确定已死」的账号（当前 + 3 代历史全部 invalid_grant）。 */
  function deadAccount() {
    return credential(-60_000, {
      refresh_token: 'RT-DEAD',
      previous_refresh_tokens: ['RT-O1', 'RT-O2', 'RT-O3'],
    })
  }

  it('★★ 首轮之后 5 分钟内不得再打任何上游请求（修前 +=20 次）', async () => {
    vi.useFakeTimers()
    const store = new Map([[REF, JSON.stringify(deadAccount())]])
    let grants = 0
    const { auth } = makeEnv({
      store,
      sleep: async () => {},
      fetcher: (async () => {
        grants += 1
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      }) as never,
    })
    const pool = {
      listAccounts: async () => [{ id: 'cool', credentialRef: REF, refreshable: true, enabled: true }],
      updateAccount: async () => {},
    } as never
    auth.startRenewPatrol(pool)
    await vi.advanceTimersByTimeAsync(10)
    const afterFirst = grants
    // 首轮：当前值 2 次尝试 + 3 代历史各 1 次 = 最多 5 次（实测 4 次）
    expect(afterFirst, '首轮应当试过当前值与历史代际').toBeGreaterThan(1)

    await vi.advanceTimersByTimeAsync(5 * 60_000)   // 5 分钟 = 5 个 tick
    expect(
      grants - afterFirst,
      '★ 死号在冷却期内仍被重打 ⇒ 无效流量（修前实测 5 分钟 20 次）',
    ).toBe(0)
    auth.stopRenewPatrol()
  })

  it('★★ 凭据一变（重新登录）⇒ 冷却立即解除（不得把人锁死）', async () => {
    vi.useFakeTimers()
    const store = new Map([[REF, JSON.stringify(deadAccount())]])
    let grants = 0
    const { auth } = makeEnv({
      store,
      sleep: async () => {},
      fetcher: (async () => {
        grants += 1
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      }) as never,
    })
    const pool = {
      listAccounts: async () => [{ id: 'cool', credentialRef: REF, refreshable: true, enabled: true }],
      updateAccount: async () => {},
    } as never
    auth.startRenewPatrol(pool)
    await vi.advanceTimersByTimeAsync(10)
    auth.stopRenewPatrol()
    expect(grants, '首轮应当打过上游').toBeGreaterThan(0)

    // ⚠️ 模拟「用户重新登录」：盘上换成一把全新的 RT
    store.set(REF, JSON.stringify(credential(-60_000, { refresh_token: 'RT-BRAND-NEW' })))
    grants = 0
    await auth.renewEntry(
      pool as never,
      { id: 'cool', credentialRef: REF, refreshable: true, expiresAt: 0 },
      { force: true, trigger: 'forced' } as never,
    ).catch(() => undefined)
    expect(
      grants,
      '★ 换了新凭据却仍被冷却挡住 ⇒ 用户重新登录后必须重启插件才能恢复',
    ).toBeGreaterThan(0)
  })
})

describe('★★ 抢救链：重试**仍是非终态**时也必须试历史代际（第二轮审计打穿）', () => {
  const REF = 'MINIMAX_ACCOUNT_SV2'

  it('★★ 首轮网络错 → 重试 503 ⇒ 仍要试历史代际（修前直接抛、跳过全部历史）', async () => {
    /**
     * ⚠️ 这是「响应丢失」这一设计主场景的另一半：服务端已轮换、回程丢了，
     * 表现为**网络类失败**；重试一次仍非终态时，历史代际才是唯一出路。
     * 修前 `throw error` 在这一格直接冒出去 ⇒ 历史代际一次不被试
     * （审计实测试过的 RT = `["RT-CUR","RT-CUR"]`，且新增守卫 37/37 全绿）。
     */
    const store = new Map([[REF, JSON.stringify(
      credential(-60_000, { refresh_token: 'RT-CUR', previous_refresh_tokens: ['RT-OLD'] }),
    )]])
    const tried: string[] = []
    let n = 0
    const { auth } = makeEnv({
      store,
      sleep: async () => {},
      fetcher: (async (_url: string, init: RequestInit) => {
        n += 1
        const rt = new URLSearchParams(String(init.body)).get('refresh_token') ?? '?'
        tried.push(rt)
        if (n === 1) throw new TypeError('fetch failed')                       // 首轮：网络错
        if (rt === 'RT-CUR') {
          return new Response(JSON.stringify({ error: 'service unavailable' }), { status: 503 })  // 重试：仍非终态
        }
        return grantOk(1)                                                      // 历史代际：成功
      }) as never,
    })
    const pool = { listAccounts: async () => [], updateAccount: async () => {} } as never
    const out = await auth.renewEntry(pool, { id: 'sv2', credentialRef: REF, refreshable: true, expiresAt: 0 }, {
      force: true,
      trigger: 'patrol',
    } as never)
    expect(tried, '★★ 必须试过历史代际（修前这一格跳过全部历史）').toContain('RT-OLD')
    expect(out.renewed, '历史代际有效 ⇒ 应当救回').toBe(true)
  })

  it('★ 没有历史代际时，非终态仍如实抛出（不得吞掉网络错误）', async () => {
    const store = new Map([[REF, JSON.stringify(credential(-60_000, { refresh_token: 'RT-ONLY' }))]])
    const { auth } = makeEnv({
      store,
      sleep: async () => {},
      fetcher: (async () => { throw new TypeError('fetch failed') }) as never,
    })
    const pool = { listAccounts: async () => [], updateAccount: async () => {} } as never
    await expect(
      auth.renewEntry(pool, { id: 'sv2', credentialRef: REF, refreshable: true, expiresAt: 0 }, {
        force: true,
        trigger: 'patrol',
      } as never),
    ).rejects.toThrow(/fetch failed/)
  })
})

describe('★★ `refresh()`（默认单凭据路径）也必须走单飞（第二轮审计打穿）', () => {
  // ⚠️ `refresh()` 走的是**产品声明的默认单凭据 ref**（不是 `MINIMAX_ACCOUNT_*`）
  const REF = 'MINIMAX_ACCESS_TOKEN'

  it('★★ 并发 2 次 `refresh()` ⇒ 只发 1 份 grant（修前「同时在飞峰值 2」）', async () => {
    /**
     * ⚠️ 两个入口：
     * - 有池时 `index.ts` 的 refresh 闭包走 `refreshAccountCredential`；
     * - **池里取不到号时它退到 `refresh()`**（本方法的默认单凭据路径）。
     * 修前 `refresh()` 自己直接 `refreshMinimaxCredential` + `set`，**完全在
     * `renewInFlight` 之外** ⇒ 并发两次就各烧一把一次性 RT。
     */
    const store = new Map([[REF, JSON.stringify(credential(10 * 60_000, { refresh_token: 'RT-S' }))]])
    let grants = 0
    const { auth } = makeEnv({
      store,
      fetcher: (async () => {
        grants += 1
        await new Promise((r) => setTimeout(r, 20))
        return grantOk(grants)
      }) as never,
    })
    await Promise.all([auth.refresh(), auth.refresh()])
    expect(
      grants,
      '★ 单凭据路径绕过单飞 ⇒ 两路各消费一次一次性 refresh_token（输家 invalid_grant）',
    ).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────
// ⑪ CAS 的 fail-open（第二轮审计打穿：重读失败退回旧快照）
// ─────────────────────────────────────────────────────────────

describe('★★ repairAccountNicknames 的 CAS：重读失败时**绝不写盘**', () => {
  const REF = 'MINIMAX_ACCOUNT_CASF'

  it('★★ 写前重读失败（resolve 返回空）⇒ 一个字节都不写（否则覆盖他处新 RT）', async () => {
    /**
     * ⚠️⚠️ 修前是 `const base = latestCredential ?? credential` —— 那一行等于
     * 「重读失败 ⇒ 用**我们手里那份旧凭据**展开整体 `set`」，**恰好又回到**
     * 该段注释要修的那个缺陷（用旧快照覆盖别人的新会话）。
     * 审计实测：盘上已是 `NEW_RT`、第二次 `resolve` 失败 ⇒ 落盘被写回 `OLD_RT`
     * ⇒ 一次性 RT 语义下**账号报废**。
     */
    const store = new Map([[REF, JSON.stringify(credential(-60_000, {
      refresh_token: 'RT-OLD', nickname: 'old-name',
    }))]])
    let resolves = 0
    const writes: string[] = []
    const ctx = new Context()
    ctx.provide('credentials', {
      resolve: async (ref: unknown) => {
        resolves += 1
        // ⚠️ 第 1 次 = 进循环时读凭据；第 2 次 = 写盘前的重读 ⇒ 让它失败
        if (resolves >= 2) return undefined
        return { value: store.get(String(ref)) }
      },
      set: async (ref: unknown, value: string) => {
        writes.push(JSON.parse(value).refresh_token)
        store.set(String(ref), value)
      },
      describe: async () => ({ source: 'file' }),
    } as never)
    const auth = new MinimaxAuth(ctx, {
      product: MINIMAX,
      sleep: async () => {},
      fetchImpl: (async (url: string) => {
        if (String(url).includes('user')) {
          return new Response(JSON.stringify({
            statusInfo: { code: 0 }, data: { userInfo: { name: 'NEW_N', userID: 'u9' } },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return grantOk(1)
      }) as never,
    })
    const entry = { id: 'casf', credentialRef: REF, refreshable: true, enabled: true, nickname: 'old-name' }
    const pool = {
      listAccounts: async () => [entry],
      listAccountsByProvider: () => [entry],
      updateAccount: async () => {},
      findAccountIdByCredential: async () => 'casf',
    } as never
    await auth.repairAccountNicknames(pool)
    expect(
      writes,
      '★★ 重读失败却仍写了盘 ⇒ `base` 退回了旧快照，把他处刚轮换的新 token 覆盖成旧的',
    ).toEqual([])
    expect(
      (JSON.parse(store.get(REF) as string) as { refresh_token: string }).refresh_token,
      '盘上必须仍是原值（未被旧快照覆盖）',
    ).toBe('RT-OLD')
  })

  it('★ 对照：重读成功时必须在**最新那份**上合并身份字段', async () => {
    const store = new Map([[REF, JSON.stringify(credential(-60_000, {
      refresh_token: 'RT-OLD', nickname: 'old-name',
    }))]])
    let resolves = 0
    const ctx = new Context()
    ctx.provide('credentials', {
      resolve: async (ref: unknown) => {
        resolves += 1
        if (resolves === 2) {
          // ⚠️ 模拟「他处刚轮换」：重读拿到的是新令牌材料
          store.set(String(ref), JSON.stringify(credential(-60_000, {
            refresh_token: 'RT-NEW-BY-OTHER', nickname: 'old-name',
          })))
        }
        return { value: store.get(String(ref)) }
      },
      set: async (ref: unknown, value: string) => { store.set(String(ref), value) },
      describe: async () => ({ source: 'file' }),
    } as never)
    const auth = new MinimaxAuth(ctx, {
      product: MINIMAX,
      sleep: async () => {},
      fetchImpl: (async (url: string) => {
        if (String(url).includes('user')) {
          return new Response(JSON.stringify({
            statusInfo: { code: 0 }, data: { userInfo: { name: 'NEW_N', userID: 'u9' } },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return grantOk(1)
      }) as never,
    })
    const entry = { id: 'casf', credentialRef: REF, refreshable: true, enabled: true, nickname: 'old-name' }
    const pool = {
      listAccounts: async () => [entry],
      listAccountsByProvider: () => [entry],
      updateAccount: async () => {},
      findAccountIdByCredential: async () => 'casf',
    } as never
    await auth.repairAccountNicknames(pool)
    const final = JSON.parse(store.get(REF) as string) as { refresh_token: string; nickname?: string; user_id?: string }
    expect(final.refresh_token, '★ 他处轮换的新 RT 必须保住').toBe('RT-NEW-BY-OTHER')
    expect(final.nickname, '身份字段要补在最新那份上').toBe('NEW_N')
    expect(final.user_id).toBe('u9')
  })
})

// ─────────────────────────────────────────────────────────────
// ⑫ 测试环境不得写进真实用户目录（实测污染后补的防线）
// ─────────────────────────────────────────────────────────────

describe('★★ 测试环境拒写真实用户目录（本轮实测污染后补）', () => {
  it('★★ `NODE_ENV=test` 且 home 指向 `~/.dsh` ⇒ 一个字节都不写', async () => {
    /**
     * ## 事故
     *
     * 本轮审计期间 `~/.dsh/jet-hub/refresh-journal.jsonl` **真的出现了** ——
     * 内容是用户**真实账号**（`minimaxintl-6d76168a`）的一条 `result:'error'`
     * 记录，`latencyMs: 2001`（说明**真的向上游发了续期请求**）。
     * 成因是某个非 `setupFiles` 路径（e2e / 临时探针）没隔离
     * `DSH_JET_HUB_STATE_DIR`，而 `journalHome` 由 `index.ts` 无条件注入。
     *
     * ⚠️ 这类污染的后果不是报错，而是「在用户真实数据目录留下测试痕迹」；
     * 若那个账号的 `refresh_token` 是一次性的，**测试会真的把它烧掉**。
     */
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const realHome = join(homedir(), '.dsh')
      const probe = join(realHome, 'jet-hub', 'refresh-journal.jsonl')
      const before = existsSync(probe) ? statSync(probe).mtimeMs : 0
      appendMinimaxJournal(realHome, {
        ts: Date.now(), provider: 'minimax', accountId: 'should-not-write',
        kind: 'grant', trigger: 'patrol', result: 'ok',
      })
      // fire-and-forget ⇒ 给一拍
      await new Promise((resolve) => { setTimeout(resolve, 60) })
      const after = existsSync(probe) ? statSync(probe).mtimeMs : 0
      expect(
        after,
        '★★ 测试环境下写进了真实用户目录 ⇒ 审计探针会污染用户数据（且可能烧掉一次性 RT）',
      ).toBe(before)
      expect(warn.mock.calls.some((c) => String(c[0]).includes('拒写真实用户目录'))).toBe(true)
    } finally {
      process.env.NODE_ENV = original
      warn.mockRestore()
    }
  })

  it('★ 对照：临时目录照常写（防线不得把正常观测也挡掉）', async () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'
    const home = tempDir('mm-journal-tmp-')
    try {
      appendMinimaxJournal(home, {
        ts: Date.now(), provider: 'minimax', accountId: 'tmp-ok',
        kind: 'grant', trigger: 'patrol', result: 'ok',
      })
      const file = join(home, 'jet-hub', 'refresh-journal.jsonl')
      await vi.waitFor(() => {
        expect(() => readFileSync(file, 'utf8'), '临时目录也必须能写').not.toThrow()
      })
    } finally {
      process.env.NODE_ENV = original
    }
  })
})
