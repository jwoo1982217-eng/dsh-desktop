import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「面板入口」客户端状态（`plugin-src/client/panel-entry-store.js`）回归。
 *
 * ## 为什么单独测这一个模块
 *
 * 插件详情页的卡片与两处槽位注册**共用同一份状态**，而真正的坑全在
 * 「宿主说不清 / 说不到」时该往哪边兜底：
 *
 * - 读取失败时**必须按「仅侧栏」兜底** —— 一次 RPC 卡住不该把两处入口同时
 *   撤掉，否则用户会以为插件坏了；但失败标记要留下，卡片好显示降级文案；
 * - 写回失败时**必须把错误抛出去** —— 静默改本地状态会造成「下拉看着改了、
 *   重启后又变回来」，这类缺陷只有跨进程重启才暴露；
 * - 回包形状不对（不是两个枚举值之一）按失败处理，**不猜**宿主的意图。
 *
 * ## 状态是模块级的
 *
 * 每个用例都用 `vi.resetModules()` + 动态 import 换一份新模块实例，否则上一
 * 用例留下的 `entry` 会把失败路径掩盖成「本来就该这么显示」。
 */

/** 造一个按端点回话的 `rpcCall` 替身，并记录收到的参数。 */
function makeRpc(handlers: {
  get?: () => Promise<unknown>
  set?: (payload: unknown) => Promise<unknown>
}) {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const rpc = async (endpoint: string, payload: unknown) => {
    calls.push({ endpoint, payload })
    if (endpoint === 'panelEntry.get') {
      return handlers.get ? handlers.get() : { entry: 'sidebar' }
    }
    if (endpoint === 'panelEntry.set') {
      return handlers.set ? handlers.set(payload) : payload
    }
    throw new Error(`未预期的端点 ${endpoint}`)
  }
  return { rpc, calls }
}

type StoreModule = typeof import('../../plugin-src/client/panel-entry-store.js')

async function freshModule(): Promise<StoreModule> {
  vi.resetModules()
  return import('../../plugin-src/client/panel-entry-store.js')
}

describe('面板入口客户端状态', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('还没读到宿主偏好时按「仅侧栏」兜底', async () => {
    const store = await freshModule()
    // ⚠️ `null` 与 `'sidebar'` 都必须让侧栏行可见：读值还没回来时不能先藏起来，
    // 否则每次启动侧栏都会闪一下（见 panel-entry.js 文件头「启动顺序」）。
    expect(store.panelEntry()).toBeNull()
    expect(store.panelEntryShowsSidebar()).toBe(true)
    expect(store.panelEntryShowsSettings()).toBe(false)
    expect(store.panelEntryReadFailed()).toBe(false)
  })

  it('宿主给出 settings 后：设置节可见、侧栏行不可见，并通知一次', async () => {
    const store = await freshModule()
    const seen: boolean[] = []
    store.subscribePanelEntry(() => seen.push(store.panelEntryShowsSettings()))

    await store.loadPanelEntry(makeRpc({ get: async () => ({ entry: 'settings' }) }).rpc)

    expect(store.panelEntry()).toBe('settings')
    expect(store.panelEntryShowsSettings()).toBe(true)
    expect(store.panelEntryShowsSidebar()).toBe(false)
    expect(seen).toEqual([true])
  })

  it('⚠️ 读取失败不得把入口藏掉，但要留下失败标记', async () => {
    const store = await freshModule()
    const { rpc } = makeRpc({
      get: async () => {
        throw new Error('宿主没响应')
      },
    })

    await store.loadPanelEntry(rpc)

    // 方向不能反：失败兜底成「两处都没入口」会让用户以为插件没装，而他什么都没改。
    expect(store.panelEntryShowsSidebar()).toBe(true)
    expect(store.panelEntryReadFailed()).toBe(true)
  })

  it('回包形状不对（不是两个枚举值之一）按读取失败处理，不猜宿主的意图', async () => {
    const store = await freshModule()
    const { rpc } = makeRpc({ get: async () => ({ entry: 'off' }) })

    await store.loadPanelEntry(rpc)

    expect(store.panelEntryShowsSidebar()).toBe(true)
    expect(store.panelEntryReadFailed()).toBe(true)
  })

  it('失败之后一次成功读取会清掉失败标记', async () => {
    const store = await freshModule()
    await store.loadPanelEntry(makeRpc({
      get: async () => {
        throw new Error('宿主没响应')
      },
    }).rpc)
    expect(store.panelEntryReadFailed()).toBe(true)

    await store.loadPanelEntry(makeRpc({ get: async () => ({ entry: 'sidebar' }) }).rpc)
    expect(store.panelEntryReadFailed()).toBe(false)
  })

  /**
   * ⚠️⚠️ **冷启动握手期的首读超时必须能被重试救回来**（2026-10-27 真机报障）。
   *
   * 真实形态：本插件是 web profile 里 60+ 个客户端插件之一，`apply()` 早于
   * `connection` 握手完成，而 `connection.rpc.call()` 在 socket 就绪前**不本地
   * 失败**、只是一直不 settle ⇒ 5s 超时信号到点。旧实现一次失败就把偏好永久
   * 降级成「仅侧栏」，并在控制台留一条 `TimeoutError: signal timed out`。
   *
   * 判据必须打在**行为**上：第一轮抛错、第二轮答上 → 值落地、失败标记不挂、
   * **且一次 warn 都不打**（那条噪音正是用户报障）。
   */
  it('⚠️⚠️ 首读超时会被重试救回来：第二轮答上就不打 warn、不挂失败标记', async () => {
    const store = await freshModule()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let sent = 0
    const rpc = async () => {
      sent += 1
      if (sent === 1) {
        const timeout = new Error('signal timed out')
        timeout.name = 'TimeoutError'
        throw timeout
      }
      return { entry: 'settings' }
    }

    expect(await store.loadPanelEntry(rpc)).toBe('settings')
    expect(sent, '第一轮失败后必须真的再发一轮').toBe(2)
    expect(store.panelEntry()).toBe('settings')
    expect(store.panelEntryReadFailed()).toBe(false)
    expect(warn, '一轮瞬时超时不该在控制台留噪音').not.toHaveBeenCalled()
  })

  it('⚠️⚠️ 全部轮次都失败时才报一次 warn，并留下失败标记', async () => {
    const store = await freshModule()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let sent = 0
    const rpc = async () => {
      sent += 1
      throw new Error('宿主没响应')
    }

    expect(await store.loadPanelEntry(rpc)).toBe('sidebar')
    expect(sent, '应当把每一轮重试都发出去').toBe(3)
    expect(warn, `warn 只该在全部轮次失败后打一次，实际 ${warn.mock.calls.length} 次`).toHaveBeenCalledTimes(1)
    expect(store.panelEntryReadFailed(), '全部失败后必须留下失败标记').toBe(true)
    expect(store.panelEntryShowsSidebar(), '失败兜底方向不能反').toBe(true)
  })

  it('写入时把 { entry } 发给宿主，并以宿主返回值更新状态', async () => {
    const store = await freshModule()
    const { rpc, calls } = makeRpc({ set: async () => ({ entry: 'settings' }) })

    const confirmed = await store.setPanelEntry(rpc, 'settings')

    expect(calls.at(-1)).toEqual({ endpoint: 'panelEntry.set', payload: { entry: 'settings' } })
    expect(confirmed).toBe('settings')
    expect(store.panelEntry()).toBe('settings')
  })

  it('⚠️ 写回失败必须抛错且不改本地状态（否则「改掉后重启又变回默认」）', async () => {
    const store = await freshModule()
    const { rpc } = makeRpc({
      set: async () => {
        throw new Error('宿主拒绝')
      },
    })

    await expect(store.setPanelEntry(rpc, 'settings')).rejects.toThrow('宿主拒绝')
    expect(store.panelEntry()).toBeNull()
    expect(store.panelEntryShowsSidebar()).toBe(true)
  })

  it('⚠️ 宿主回包缺 entry 或给了非法值时抛错，不把「没回答」当成「照办」', async () => {
    const store = await freshModule()

    await expect(store.setPanelEntry(makeRpc({ set: async () => ({}) }).rpc, 'settings'))
      .rejects.toThrow('entry')
    await expect(store.setPanelEntry(makeRpc({ set: async () => ({ entry: 'off' }) }).rpc, 'settings'))
      .rejects.toThrow('entry')
    expect(store.panelEntry()).toBeNull()
  })

  it('⚠️ 并发读取只发一次请求（两处槽位同时等这一读）', async () => {
    // 侧栏行与设置节在 `apply` 时各调一次 loadPanelEntry；不去重就要多打一次
    // 宿主 RPC，而且两次回包顺序不同还会多广播一次无谓重渲染。
    const store = await freshModule()
    let sent = 0
    const rpc = async () => {
      sent += 1
      return { entry: 'sidebar' }
    }

    await Promise.all([store.loadPanelEntry(rpc), store.loadPanelEntry(rpc)])

    expect(sent).toBe(1)
  })

  it('⚠️⚠️ rpcCall **同步**抛错后不得让 inflight 永久泄漏（复核 C2）', async () => {
    // 真实缺陷形态：清理逻辑原先挂在 async 体的 finally 里，而
    // `inflight = task` 在 IIFE 之后才赋值 —— 同步抛错时 finally 先跑被置空，
    // 随后又被覆盖成一个**已 settle** 的 Promise，此后每次读取都复用它、
    // 再也不发请求，也永远读不到宿主的新值。
    const store = await freshModule()
    let sent = 0
    // ⚠️ 故意是**普通函数**（不是 async），这样 rpcCall 会同步抛错。
    const throwing = () => {
      sent += 1
      throw new Error('同步炸了')
    }

    // 第一次：失败并留下失败标记。
    // ⚠️ 现在一次 `loadPanelEntry` 会**有界重试**（连接握手期的一次超时不该
    //    永久降级偏好，见 panel-entry-store.js 的 PANEL_ENTRY_READ_ATTEMPTS），
    //    所以这里按「全部轮次都真的发出去了」计数。
    expect(await store.loadPanelEntry(throwing)).toBe('sidebar')
    expect(store.panelEntryReadFailed()).toBe(true)
    expect(sent, '每次 loadPanelEntry 应当把每一轮重试都真的发出去').toBe(3)

    // 第二次：必须**真的再发一次请求**，而不是复用那个已 settle 的旧 Promise。
    expect(await store.loadPanelEntry(throwing)).toBe('sidebar')
    expect(sent, 'inflight 泄漏了：第二次读取没有真正发出请求').toBe(6)
  })

  it('⚠️ 一次失败的读取之后，后续成功读取能恢复（inflight 已正确清空）', async () => {
    const store = await freshModule()
    const throwing = () => {
      throw new Error('同步炸了')
    }
    await store.loadPanelEntry(throwing)
    expect(store.panelEntryReadFailed()).toBe(true)

    await store.loadPanelEntry(makeRpc({ get: async () => ({ entry: 'settings' }) }).rpc)

    expect(store.panelEntry()).toBe('settings')
    expect(store.panelEntryReadFailed()).toBe(false)
  })

  /**
   * ⚠️⚠️ **读请求必须带超时信号，且老内核也有兜底**（2026-10-24 审计 M1）。
   *
   * 原实现：缺 `AbortSignal.timeout`（`build.mjs` 的 `target: ['chrome100']`，
   * 该 API 是 Chrome 103+）时 `readSignal()` 返回 `undefined` ⇒ **超时保护
   * 整个消失** ⇒ 宿主 RPC 永不 settle 时读取永久挂起，叠加 `inflight` 复用
   * ⇒ 此后永远读不到宿主真实值。
   *
   * ⚠️ 判据必须**真的把原生 API 摘掉**再调，不能只断言源码里有 `AbortController`
   *    —— 那种查字面量的写法对「忘了写兜底分支」完全失明。
   */
  it('⚠️⚠️ 原生 AbortSignal.timeout 缺失时，读取仍带自建超时信号', async () => {
    const store = await freshModule()
    const realTimeout = (AbortSignal as unknown as { timeout?: unknown }).timeout
    expect(typeof realTimeout, '本环境的 AbortSignal.timeout 不是函数，用例前提不成立').toBe('function')

    // 模拟老内核：把原生 API 摘掉。
    ;(AbortSignal as unknown as { timeout?: unknown }).timeout = undefined
    try {
      let receivedSignal: unknown = 'NOT-CALLED'
      const rpc = async (_endpoint: string, _payload: unknown, signal?: unknown) => {
        receivedSignal = signal
        return { entry: 'sidebar' }
      }
      await store.loadPanelEntry(rpc as never)
      // 关键：不能是 undefined（那正是原实现的缺陷形态）。
      expect(receivedSignal, '缺原生 API 时没有自建超时 ⇒ 读取可无限悬挂')
        .not.toBeUndefined()
      expect(receivedSignal).not.toBe('NOT-CALLED')
      expect((receivedSignal as AbortSignal).aborted, '自建信号应当尚未触发').toBe(false)
    } finally {
      ;(AbortSignal as unknown as { timeout?: unknown }).timeout = realTimeout
    }
  })

  it('⚠️⚠️ 慢读回包不得把用户刚写入的值倒灌回旧值（复核 I3）', async () => {
    // 时序：读请求在飞（慢）→ 用户选「仅设置页」写入成功 → 那个慢读回包带着
    // **写之前**的 'sidebar' 到达 → 若无防倒灌，它会覆盖回 sidebar，
    // 界面表现为「刚改完又自己跳回去了」。
    const store = await freshModule()
    let releaseRead
    const slowRead = new Promise((resolve) => {
      releaseRead = resolve
    })
    const rpc = async (endpoint, payload) => {
      if (endpoint === 'panelEntry.get') {
        await slowRead
        // ⚠️ 这个回包携带的是**写入之前**的宿主状态。
        return { entry: 'sidebar' }
      }
      return { entry: payload.entry }
    }

    // 发起慢读（不 await），随后完成一次写入。
    const inflightRead = store.loadPanelEntry(rpc)
    await store.setPanelEntry(rpc, 'settings')
    expect(store.panelEntry()).toBe('settings')

    // 让慢读回包落地，它不该把值倒灌回 sidebar。
    releaseRead()
    await inflightRead

    expect(store.panelEntry(), '慢读回包倒灌了用户刚写入的值').toBe('settings')
  })

  it('退订之后不再收到通知（槽位撤销后不得再被旧监听器碰）', async () => {    const store = await freshModule()
    const seen: boolean[] = []
    const unsubscribe = store.subscribePanelEntry(() => seen.push(true))

    await store.loadPanelEntry(makeRpc({ get: async () => ({ entry: 'settings' }) }).rpc)
    unsubscribe()
    await store.loadPanelEntry(makeRpc({ get: async () => ({ entry: 'sidebar' }) }).rpc)

    expect(seen).toEqual([true])
  })

  it('⚠️ 两个订阅者（主面板与详情页卡片）必须收到同一份状态', async () => {
    // 主面板与设置弹层可能同时挂着页面实例，两处读的必须是同一份进程内状态；
    // 否则会出现「卡片显示仅侧栏、侧栏行却消失了」这种自相矛盾的界面。
    const store = await freshModule()
    const a: boolean[] = []
    const b: boolean[] = []
    store.subscribePanelEntry(() => a.push(store.panelEntryShowsSidebar()))
    store.subscribePanelEntry(() => b.push(store.panelEntryShowsSidebar()))

    await store.loadPanelEntry(makeRpc({ get: async () => ({ entry: 'settings' }) }).rpc)

    expect(a).toEqual([false])
    expect(b).toEqual([false])
    expect(store.panelEntryShowsSidebar()).toBe(false)
    expect(store.panelEntryShowsSettings()).toBe(true)
  })
})
