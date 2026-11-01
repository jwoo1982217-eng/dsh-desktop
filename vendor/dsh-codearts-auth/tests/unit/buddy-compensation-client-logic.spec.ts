import { describe, expect, it, vi } from 'vitest'
import {
  isClaimable,
  isClaimed,
  scanCompensation,
  toCompensationState,
  claimAllCompensation,
  compensationHeadline,
  compensationHint,
  shouldShowCompensation,
} from '../../plugin-src/client/compensation-panel-logic.js'
import { unwrapRpcResult } from '../../plugin-src/management-rpc.mjs'

/**
 * buddy 限时补偿积分**客户端逻辑**的行为测试。
 *
 * ## ⚠️⚠️ 这份用例的存在理由：锁住 `rpcCall` 的真实契约（P0 的回归网）
 *
 * PR !106 初版把 `rpcCall` 的返回值当成 `{ok, value}`，于是
 * ① 状态查询恒得「0 待领」、② 领取循环恒 `continue`、③ 领取"成功"被记成失败
 * —— 而当时 **26 条测试全绿**（面板 spec 是纯源码文本断言，从不执行逻辑）。
 *
 * ⇒ 这里**真的用 `unwrapRpcResult` 驱动**本模块的函数，
 *    任何重新引入 `res.ok` 判据的改动都会让下面这些用例变红。
 */

/** 一条「有补偿待领」的状态（形状 = `RpcBuddyCompensationStatusResponse` 的 value）。 */
const ACTIVE = { claimed: false, active: true, creditNum: 500, validityPeriod: 1, endTime: '2026-10-22 23:59:59' }
const CLAIMED = { claimed: true, active: false, creditNum: 500, endTime: '2026-10-22 23:59:59' }
const NONE = { claimed: false, active: false, creditNum: 0 }

const ACCOUNTS = [
  { id: 'a1', nickname: '账号A' },
  { id: 'a2', nickname: '账号B' },
]

/**
 * 造一个**与生产同款**的 `rpcCall`：宿主返回 `{ok, value|error}`，
 * 客户端侧经过 `unwrapRpcResult` —— 成功得 value（无 ok 字段），失败抛错。
 */
function makeRpcCall(handlers) {
  const seen = []
  const rpcCall = async (endpoint, payload) => {
    seen.push({ endpoint, payload })
    const raw = handlers[endpoint]?.(payload)
    return unwrapRpcResult(raw)
  }
  return { rpcCall, seen }
}

describe('补偿面板逻辑：可领取判据', () => {
  it('active + 未领 + 有额度 ⇒ 可领', () => {
    expect(isClaimable(ACTIVE)).toBe(true)
  })
  it('已领取 ⇒ 不可领', () => expect(isClaimable(CLAIMED)).toBe(false))
  it('活动结束 ⇒ 不可领（哪怕额度字段仍留着历史值）', () => {
    expect(isClaimable({ claimed: false, active: false, creditNum: 500 })).toBe(false)
  })
  it('额度为 0 ⇒ 不可领', () => {
    expect(isClaimable({ claimed: false, active: true, creditNum: 0 })).toBe(false)
  })
  it('⚠️ 畸形输入（undefined/null）⇒ 不可领，不抛错', () => {
    expect(isClaimable(undefined)).toBe(false)
    expect(isClaimable(null)).toBe(false)
  })
  it('isClaimed 只认显式 true', () => {
    expect(isClaimed(CLAIMED)).toBe(true)
    expect(isClaimed(ACTIVE)).toBe(false)
    expect(isClaimed(undefined)).toBe(false)
  })
})

describe('补偿面板逻辑：扫描汇总（P0 回归网）', () => {
  it('★ 正常返回时**能算出待领数与合计**（初版恒为 0）', async () => {
    const { rpcCall } = makeRpcCall({
      'account.list': () => ({ ok: true, value: { accounts: ACCOUNTS } }),
      'buddy.compensationStatus': () => ({ ok: true, value: ACTIVE }),
    })
    const scan = await scanCompensation(ACCOUNTS, (id) => rpcCall('buddy.compensationStatus', { accountId: id }))
    // ⚠️ 这条在初版会得到 claimableCount=0 —— 因为初版判的是 `res.ok === true`，
    //    而解包后的对象**没有 ok 字段**。
    expect(scan.claimableCount).toBe(2)
    expect(scan.total).toBe(1000)
    expect(scan.endTime).toBe('2026-10-22 23:59:59')
    expect(scan.errorCount).toBe(0)
  })

  it('★ **单个账号失败不中断整批**（初版第一次抛错就把循环掀了）', async () => {
    const { rpcCall } = makeRpcCall({
      'buddy.compensationStatus': (payload) => (payload.accountId === 'a1'
        ? { ok: false, error: { code: 'bad-request', message: '凭据不可用，请先重新登录该账号' } }
        : { ok: true, value: ACTIVE }),
    })
    const scan = await scanCompensation(ACCOUNTS, (id) => rpcCall('buddy.compensationStatus', { accountId: id }))
    // a1 失败、a2 成功 —— 两个都查到了
    expect(scan.scanned).toBe(2)
    expect(scan.errorCount).toBe(1)
    expect(scan.firstError).toContain('凭据不可用')
    expect(scan.claimableCount).toBe(1)
    expect(scan.total).toBe(500)
  })

  it('★ 全部失败时错误**透出**到卡片文案', async () => {
    const scan = await scanCompensation(ACCOUNTS, async () => { throw new Error('上游拒绝（业务码 40301）：活动已结束') })
    const state = toCompensationState(scan)
    expect(state.error).toContain('活动已结束')
    expect(compensationHeadline(state)).toContain('查询失败')
  })

  it('★ 部分失败**不**把卡片打成错误态（大部分结论是可靠的）', async () => {
    const { rpcCall } = makeRpcCall({
      'buddy.compensationStatus': (payload) => (payload.accountId === 'a1'
        ? { ok: false, error: { code: 'bad-request', message: '凭据不可用' } }
        : { ok: true, value: ACTIVE }),
    })
    const scan = await scanCompensation(ACCOUNTS, (id) => rpcCall('buddy.compensationStatus', { accountId: id }))
    const state = toCompensationState(scan)
    expect(state.error).toBeNull()
    expect(state.errorCount).toBe(1)
    // 副文案**必须**如实说明有几个账号没查到（不能静默少算）
    expect(compensationHint(state)).toContain('1 个账号查询失败')
  })

  it('已领取的账号计入 claimedCount，不计入 total', async () => {
    const { rpcCall } = makeRpcCall({
      'buddy.compensationStatus': (payload) => ({ ok: true, value: payload.accountId === 'a1' ? CLAIMED : ACTIVE }),
    })
    const scan = await scanCompensation(ACCOUNTS, (id) => rpcCall('buddy.compensationStatus', { accountId: id }))
    expect(scan.claimedCount).toBe(1)
    expect(scan.claimableCount).toBe(1)
    expect(scan.total).toBe(500)
  })
})

describe('补偿面板逻辑：领取编排（P0 回归网）', () => {
  it('★ 领取成功后**不被记成失败**（初版恒记「未知错误」）', async () => {
    const claimedIds = []
    const { rpcCall } = makeRpcCall({
      'buddy.compensationStatus': () => ({ ok: true, value: ACTIVE }),
      // ⚠️ 宿主成功时 value 是**空对象** `{}`（RpcBuddyClaimCompensationResponse）
      'buddy.claimCompensation': () => ({ ok: true, value: {} }),
    })
    const result = await claimAllCompensation(
      ACCOUNTS,
      (id) => rpcCall('buddy.compensationStatus', { accountId: id }),
      async (id) => { claimedIds.push(id); await rpcCall('buddy.claimCompensation', { accountId: id }) },
    )
    expect(result.failures).toEqual([])
    expect(result.claimed).toEqual(['账号A', '账号B'])
    expect(claimedIds).toEqual(['a1', 'a2'])
  })

  it('★ 领取失败**带真实原因**，且不中断其余账号', async () => {
    const { rpcCall } = makeRpcCall({
      'buddy.compensationStatus': () => ({ ok: true, value: ACTIVE }),
      'buddy.claimCompensation': (payload) => (payload.accountId === 'a1'
        ? { ok: false, error: { code: 'bad-request', message: '上游拒绝（业务码 40901）：已领取过' } }
        : { ok: true, value: {} }),
    })
    const result = await claimAllCompensation(
      ACCOUNTS,
      (id) => rpcCall('buddy.compensationStatus', { accountId: id }),
      (id) => rpcCall('buddy.claimCompensation', { accountId: id }),
    )
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain('账号A')
    expect(result.failures[0]).toContain('已领取过')
    expect(result.claimed).toEqual(['账号B'])
  })

  it('★ 领取前**重新查状态**（不拿面板挂载时的陈旧读数）', async () => {
    const queried = []
    const { rpcCall } = makeRpcCall({
      'buddy.compensationStatus': () => ({ ok: true, value: ACTIVE }),
      'buddy.claimCompensation': () => ({ ok: true, value: {} }),
    })
    await claimAllCompensation(
      ACCOUNTS,
      (id) => { queried.push(id); return rpcCall('buddy.compensationStatus', { accountId: id }) },
      (id) => rpcCall('buddy.claimCompensation', { accountId: id }),
    )
    expect(queried).toEqual(['a1', 'a2'])
  })

  it('★ 状态不可知 ⇒ **不发写操作**（宁可不领，不可盲领）', async () => {
    const onClaim = vi.fn()
    const result = await claimAllCompensation(
      ACCOUNTS,
      async () => { throw new Error('凭据不可用') },
      onClaim,
    )
    expect(onClaim).not.toHaveBeenCalled()
    expect(result.claimed).toEqual([])
    expect(result.failures).toEqual([])
  })

  it('已领取 / 无额度的账号**不发**领取请求', async () => {
    const onClaim = vi.fn()
    const { rpcCall } = makeRpcCall({
      'buddy.compensationStatus': (payload) => ({ ok: true, value: payload.accountId === 'a1' ? CLAIMED : NONE }),
    })
    await claimAllCompensation(
      ACCOUNTS,
      (id) => rpcCall('buddy.compensationStatus', { accountId: id }),
      onClaim,
    )
    expect(onClaim).not.toHaveBeenCalled()
  })
})

describe('补偿面板逻辑：文案如实性', () => {
  it('有待领 ⇒ 显示合计与截止时间', async () => {
    const state = toCompensationState(await scanCompensation(ACCOUNTS, async () => ACTIVE))
    expect(compensationHeadline(state)).toBe('DeepSeek 模型服务异常补偿：1000 积分待领取（2026-10-22 23:59:59 截止）')
    expect(compensationHint(state)).toContain('可领取账号 2 / 2 个')
  })

  it('⚠️ 无账号时**不谎报**「当前没有可领取」（说清是还没加账号）', async () => {
    const state = toCompensationState(await scanCompensation([], async () => ACTIVE))
    expect(compensationHeadline(state)).toBe('尚未添加 CodeBuddy 账号')
    expect(state.total).toBe(0)
  })

  it('全部已领取 ⇒ 主文案仍如实说已领取（但卡片本身会被隐藏）', async () => {
    const state = toCompensationState(await scanCompensation(ACCOUNTS, async () => CLAIMED))
    expect(compensationHeadline(state)).toBe('补偿积分已领取')
  })

  it('活动结束且无人领取 ⇒ 显示无可领取', async () => {
    const state = toCompensationState(await scanCompensation(ACCOUNTS, async () => NONE))
    expect(compensationHeadline(state)).toBe('当前没有可领取的补偿积分')
  })

  it('null 状态 ⇒ 空文案（卡片不渲染）', () => {
    expect(compensationHeadline(null)).toBe('')
    expect(compensationHint(null)).toBe('')
  })
})

describe('★ 领取后隐藏（用户 2026-10-26：「常驻改为领取后隐藏」）', () => {
  it('★★ 全部已领取 ⇒ 不渲染', async () => {
    const state = toCompensationState(await scanCompensation(ACCOUNTS, async () => CLAIMED))
    expect(state.claimedCount).toBe(2)
    expect(shouldShowCompensation(state), '领完之后还常驻一条「已领取」是纯占位').toBe(false)
  })

  it('★★ 活动结束且无人领 ⇒ 也不渲染（没有待办，也没有坏消息）', async () => {
    const state = toCompensationState(await scanCompensation(ACCOUNTS, async () => NONE))
    expect(shouldShowCompensation(state)).toBe(false)
  })

  it('★★ 没有账号 ⇒ 不渲染（账号区本身已空，再挂一张是重复提示）', async () => {
    const state = toCompensationState(await scanCompensation([], async () => ACTIVE))
    expect(shouldShowCompensation(state)).toBe(false)
  })

  it('有待领 ⇒ 渲染', async () => {
    const state = toCompensationState(await scanCompensation(ACCOUNTS, async () => ACTIVE))
    expect(shouldShowCompensation(state)).toBe(true)
  })

  it('查询失败 ⇒ 必须渲染（否则用户以为「没有补偿」，实际是没查到）', () => {
    const state = toCompensationState({
      scanned: 2, claimableCount: 0, claimedCount: 0, total: 0, endTime: null,
      errorCount: 2, firstError: '凭据失效',
    })
    expect(state.error).toBe('凭据失效')
    expect(shouldShowCompensation(state)).toBe(true)
  })

  it('★ error 单独非空时也必须渲染（不依赖 errorCount —— 那是两条独立判据）', () => {
    // ⚠️ 生产路径上 `toCompensationState` 只在 `errorCount > 0` 时透出 error
    //   ⇒ 这条分支目前是冗余的。但**冗余不等于可删**：它守的是「将来有人放宽
    //   toCompensationState 的 error 口径（比如改成部分失败也透出）时，
    //   卡片不会因为 errorCount 为 0 就静默不显示」。
    //   构造方式就是直接给 state，绕开 toCompensationState。
    expect(shouldShowCompensation({
      scanned: 2, claimableCount: 0, claimedCount: 0, total: 0, endTime: null,
      error: '凭据失效', errorCount: 0,
    })).toBe(true)
  })

  it('★ 部分账号没查到 ⇒ 渲染（结论不完整必须透出）', async () => {
    const state = toCompensationState({
      scanned: 2, claimableCount: 0, claimedCount: 1, total: 0, endTime: null,
      errorCount: 1, firstError: '超时',
    })
    expect(shouldShowCompensation(state)).toBe(true)
  })

  it('★★ 已领完时副文案不得再印「限时活动…活动已结束」', async () => {
    const state = toCompensationState(await scanCompensation(ACCOUNTS, async () => CLAIMED))
    expect(compensationHint(state), '这条说明只对「还没领」的人有意义').toBe('')
  })

  it('null ⇒ 不渲染', () => {
    expect(shouldShowCompensation(null)).toBe(false)
  })
})