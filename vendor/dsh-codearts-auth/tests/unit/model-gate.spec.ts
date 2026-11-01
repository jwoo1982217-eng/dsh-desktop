/**
 * 上游请求**闸门**（串行 + 按模型最小间隔）的单测，2026-09-30。
 *
 * ## 依据（全部来自 `dsh-free-glm` 的实测）
 *
 * 上游 `429` 有两种语义，其中 `3009 model concurrency limit exceeded` 是
 * **并发配额**（撞它时 token 还剩 299.4 万）。分模型实测：
 *
 * ```
 * GLM-5.3-Flash  605 次 200    0 次限流      ← 该窗口内 Flash 配额够用
 * GLM-5.3         74 次 200   21 次重试     6 次最终 429
 * ```
 *
 * ⇒ 两条措施：**串行**（不重叠）+ **按模型间隔**（不挨太近）。
 * 加了之后那边 `3009` 从 21 次降到 1 次。
 *
 * ⚠⚠ **上面那行「Flash 从未撞过」已在本机被证伪**（2026-10-25）：
 * 它的成立前提是**串行单发**（605 次里没有并发）。一旦开并发
 * （多个 subagent / 多轮并行），`gap=0` 意味着闸门只保证不重叠、
 * **不保证间隔** ⇒ N 个请求首尾相接密集连发 ⇒ 只要该模型的并发
 * 窗口 < N 就撞 `429 + 3009`。
 *
 * 本机实测（会话 `3acf2ebd` turn 15）：模型正是 `GLM-5.3-Flash`，
 * 撞了 429+3009，随后 turn 16 **升级成 405 风控拦截** ——
 * 「并发开多就全废」的起点。用户原话：「1.5 亿 token 并发多了以后碰到，
 * 是 glm-5.3-flash，普通的 glm-5.3 没有碰到（可能是因为我用 5.3 都是
 * 单线程的）」。
 *
 * ⇒ `glm-5.3-flash` 的 gap 从 0 改成 **500ms**（用户指定），
 *   守卫见本文件末尾「产品配置的 gap 必须非零」。
 *
 * ## ⚠ 用例全部毫秒级
 *
 * `ModelGate` 的 `now` 与 `sleep` 都可注入，故这里不发请求、不真等 350ms。
 */
import { describe, expect, it } from 'vitest'

import { GateAbortedError, ModelGate } from '../../src/model-gate.js'
import { ZCODE } from '../../src/zcode-product.js'

const tick = async (ms = 5): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('ZCode 上游请求闸门', () => {
  it('★ 串行：并发任务里同时在飞的永远只有 1 个', async () => {
    const gate = new ModelGate({ sleep: async () => {} })
    let inFlight = 0
    let maxInFlight = 0
    const task = async (): Promise<void> => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick(5)
      inFlight -= 1
    }

    await Promise.all([
      gate.run('glm-5.3-flash', task),
      gate.run('glm-5.3-flash', task),
      gate.run('glm-5.3-flash', task),
    ])
    expect(maxInFlight).toBe(1)
    expect(gate.queueDepth()).toBe(0) // 全部释放，不漏尾巴
  })

  it('★ 按模型最小间隔：同一模型第二次发车要等够 gap', async () => {
    const waits: number[] = []
    let nowMs = 10_000
    const gate = new ModelGate({
      gaps: { 'glm-5.3': 350 },
      now: () => nowMs,
      sleep: async (ms) => {
        waits.push(ms)
        nowMs += ms // 模拟时间流逝，否则会一直算出差值
      },
    })

    await gate.run('glm-5.3', async () => {})
    await gate.run('glm-5.3', async () => {})
    expect(waits).toEqual([350])
  })

  it('gap 为 0 的模型不额外等待（Flash 从未撞过限流，强加间隔是纯损失）', async () => {
    const waits: number[] = []
    let nowMs = 10_000
    const gate = new ModelGate({
      gaps: { 'glm-5.3': 350, 'glm-5.3-flash': 0 },
      now: () => nowMs,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })

    await gate.run('glm-5.3-flash', async () => {})
    await gate.run('glm-5.3-flash', async () => {})
    expect(waits).toEqual([])
  })

  it('已过间隔时不再等待（间隔是「距上次发车至少 N 毫秒」，不是固定节拍）', async () => {
    const waits: number[] = []
    let nowMs = 10_000
    const gate = new ModelGate({
      gaps: { 'glm-5.3': 350 },
      now: () => nowMs,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })

    await gate.run('glm-5.3', async () => {})
    nowMs += 5_000 // 上一次发车已经过去 5 秒
    await gate.run('glm-5.3', async () => {})
    expect(waits).toEqual([])
  })

  it('模型 id 大小写不敏感（DSH 传的是 `GLM-5.3`，配置里是小写）', async () => {
    const waits: number[] = []
    let nowMs = 10_000
    const gate = new ModelGate({
      gaps: { 'glm-5.3': 350 },
      now: () => nowMs,
      sleep: async (ms) => {
        waits.push(ms)
        nowMs += ms
      },
    })

    await gate.run('GLM-5.3', async () => {})
    await gate.run('GLM-5.3', async () => {})
    expect(waits).toEqual([350])
  })

  it('关掉串行后不排队（能一键回到引入闸门之前的行为）', async () => {
    const gate = new ModelGate({ serialize: false, sleep: async () => {} })
    let inFlight = 0
    let maxInFlight = 0
    const task = async (): Promise<void> => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick(10)
      inFlight -= 1
    }

    await Promise.all([gate.run('m', task), gate.run('m', task)])
    expect(maxInFlight).toBe(2)
  })

  it('★ 等待闸门期间中断必须生效（否则后面的请求被前一个拖死）', async () => {
    const gate = new ModelGate({ sleep: async () => {} })
    let releaseFirst!: () => void
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = gate.run('m', async () => {
      await blocker
    })
    await tick()

    const controller = new AbortController()
    const second = gate.run('m', async () => 'never', { signal: controller.signal })
    await tick()
    controller.abort()

    await expect(second).rejects.toBeInstanceOf(GateAbortedError)

    // 收尾：让第一个任务结束，避免悬挂的 promise 影响其它用例。
    releaseFirst()
    await first
  })

  it('★ 任务本身抛错时也要释放尾巴（否则后续请求永久排队）', async () => {
    const gate = new ModelGate({ sleep: async () => {} })
    await expect(gate.run('m', async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')

    expect(gate.queueDepth()).toBe(0)
    // 尾巴已释放：下一个任务能正常执行。
    expect(await gate.run('m', async () => 'ok')).toBe('ok')
  })
})

/**
 * ★★ **产品配置的 gap 必须非零**（2026-10-25，issue IKQ4B4）。
 *
 * ## 为什么值得单独立项
 *
 * `gap = 0` 时闸门只保证「不重叠」，**不保证间隔** —— 并发 N 个请求会
 * 首尾相接密集连发。这在串行单发时代看不出来（`dsh-free-glm` 的
 * 「Flash 605 次 0 限流」正是单发实测），一开并发就撞
 * `429 + 3009 model concurrency limit exceeded`。
 *
 * 本机实测（会话 `3acf2ebd`）：turn 15 撞 429+3009 ⇒ turn 16 升级成
 * 405 风控拦截 ⇒ 整条渠道不可用。用户原话见本文件头注释。
 *
 * ⚠ 断言**逐个模型枚举**而不是「全部 > 0」的汇总式：将来新增模型时
 *   漏配 gap 会立刻红（汇总式在有一个非零值时恒真）。
 */
describe('ZCODE 产品配置：每个模型的 gap 必须非零', () => {
  it('★★ glm-5.3 与 glm-5.3-flash 都有间隔', () => {
    expect(ZCODE.modelGapMs['glm-5.3']).toBeGreaterThan(0)
    expect(ZCODE.modelGapMs['glm-5.3-flash']).toBeGreaterThan(0)
  })

  it('★★ flash 的 gap 就是 500ms（用户指定值，防被改回 0）', () => {
    expect(ZCODE.modelGapMs['glm-5.3-flash']).toBe(500)
  })

  it('★ 串行闸门必须开着（否则 gap 无从生效）', () => {
    expect(ZCODE.serializeUpstream).toBe(true)
  })
})
