/**
 * Codely 每日签到原语单测（`claimCodelyDailyCheckIn`）。
 *
 * ## 为什么这几条
 *
 * 签到是**写操作**，最危险的错误形态有三种，各锁一条：
 * - **没签却报成功**（`can_check_in:false` 被当成功 —— trae 因此吃过真实报障
 *   「显示成功但 +0 积分」）⇒ 用例 ②；
 * - **重复发执行请求**（`PROCESSING` / `CREDIT_PENDING` 受理中态再打一次
 *   `check-in`）⇒ 用例 ③（断言只发了 `init`，没发执行）；
 * - **编造数额**（上游不在执行响应里返回「领到多少」，数额只能从 `init` 的
 *   `levels[].reward_summary` 解析）⇒ 用例 ①⑧。
 */

import { describe, expect, it } from 'vitest'
import {
  CODELY_CHECKIN_INIT_PATH,
  CODELY_CHECKIN_PATH,
  claimCodelyDailyCheckIn,
} from '../../src/codely-credits.js'
import type { CodelyCredential } from '../../src/codely-auth.js'

const CREDENTIAL: CodelyCredential = {
  access_token: 'access-token-abc',
  refresh_token: 'refresh-token-abc',
  obtained_at: Date.now(),
}

type Responder = () => { status: number; body: string }

/** 按 path 分发的 fake fetch，并记录每次请求的路径（断言「发了哪些请求」用）。 */
function makeFetcher(routes: Readonly<Record<string, Responder>>) {
  const calls: string[] = []
  const fetcher = (async (url: unknown) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '') as string
    calls.push(path)
    const route = routes[path]
    if (route === undefined) {
      return { ok: false, status: 404, text: async () => 'not found' } as unknown as Response
    }
    const { status, body } = route()
    return { ok: status < 400, status, text: async () => body } as unknown as Response
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

/** `init` 的实测报文形状（简化：只留判据字段）。 */
function initState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    month: '2026-10',
    activity_status: 'ACTIVE',
    check_in_status: 'READY',
    check_in_count: 19,
    max_count: 31,
    can_check_in: true,
    levels: [
      { level: 19, status: 'COMPLETED', reward_summary: '+300' },
      { level: 20, status: 'CURRENT', reward_summary: '+300' },
      { level: 21, status: 'LOCKED', reward_summary: '+300' },
    ],
    ...overrides,
  })
}

function checkInState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    check_in_status: 'COMPLETED',
    check_in_count: 20,
    ...overrides,
  })
}

describe('Codely 每日签到', () => {
  it('① can_check_in ⇒ 执行签到并报成功，数额取 CURRENT 级的 reward_summary', async () => {
    const { fetcher, calls } = makeFetcher({
      [CODELY_CHECKIN_INIT_PATH]: () => ({ status: 200, body: initState() }),
      [CODELY_CHECKIN_PATH]: () => ({ status: 200, body: checkInState() }),
    })
    const outcome = await claimCodelyDailyCheckIn(CREDENTIAL, { fetcher })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 300 })
    expect(calls).toEqual([CODELY_CHECKIN_INIT_PATH, CODELY_CHECKIN_PATH])
  })

  it('② 已签到（can_check_in:false）⇒ already-claimed，且不发执行请求', async () => {
    const { fetcher, calls } = makeFetcher({
      [CODELY_CHECKIN_INIT_PATH]: () => ({
        status: 200,
        body: initState({ can_check_in: false, check_in_status: 'COMPLETED' }),
      }),
      [CODELY_CHECKIN_PATH]: () => ({ status: 200, body: checkInState() }),
    })
    const outcome = await claimCodelyDailyCheckIn(CREDENTIAL, { fetcher })
    expect(outcome).toMatchObject({ kind: 'already-claimed' })
    // ⚠️ 关键断言：没有第二次请求（trae 的「显示成功但 +0 积分」同源教训）。
    expect(calls).toEqual([CODELY_CHECKIN_INIT_PATH])
  })

  it('③ 受理中（can_check_in:false + PROCESSING）⇒ already-claimed，不重发执行', async () => {
    const { fetcher, calls } = makeFetcher({
      [CODELY_CHECKIN_INIT_PATH]: () => ({
        status: 200,
        body: initState({ can_check_in: false, check_in_status: 'PROCESSING' }),
      }),
      [CODELY_CHECKIN_PATH]: () => ({ status: 200, body: checkInState() }),
    })
    const outcome = await claimCodelyDailyCheckIn(CREDENTIAL, { fetcher })
    expect(outcome).toMatchObject({ kind: 'already-claimed' })
    expect(calls).toEqual([CODELY_CHECKIN_INIT_PATH])
  })

  it('④ 活动未开始（activity PENDING）⇒ inactive，文案用上游语义', async () => {
    const { fetcher } = makeFetcher({
      [CODELY_CHECKIN_INIT_PATH]: () => ({
        status: 200,
        body: initState({ activity_status: 'PENDING' }),
      }),
    })
    const outcome = await claimCodelyDailyCheckIn(CREDENTIAL, { fetcher })
    expect(outcome).toMatchObject({ kind: 'inactive', message: '本月活动尚未开始' })
  })

  it('⑤ 签到暂不可用（UNAVAILABLE）⇒ failed 且透传上游 error 原文', async () => {
    const { fetcher } = makeFetcher({
      [CODELY_CHECKIN_INIT_PATH]: () => ({
        status: 200,
        body: initState({ check_in_status: 'UNAVAILABLE', error: '积分系统维护中' }),
      }),
    })
    const outcome = await claimCodelyDailyCheckIn(CREDENTIAL, { fetcher })
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect(outcome.kind === 'failed' && outcome.message).toContain('积分系统维护中')
  })

  it('⑥ 执行请求非 200 ⇒ failed（不编造成功）', async () => {
    const { fetcher } = makeFetcher({
      [CODELY_CHECKIN_INIT_PATH]: () => ({ status: 200, body: initState() }),
      [CODELY_CHECKIN_PATH]: () => ({ status: 500, body: 'boom' }),
    })
    const outcome = await claimCodelyDailyCheckIn(CREDENTIAL, { fetcher })
    expect(outcome).toMatchObject({ kind: 'failed' })
  })

  it('⑦ 没有凭据 ⇒ failed 且零请求', async () => {
    const { fetcher, calls } = makeFetcher({})
    const outcome = await claimCodelyDailyCheckIn(
      { access_token: '', refresh_token: '', obtained_at: 0 },
      { fetcher },
    )
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect(calls).toEqual([])
  })

  it('⑧ reward_summary 解析不出 ⇒ claimed credit 0 + delayedMessage（0 不代表没领到）', async () => {
    const { fetcher } = makeFetcher({
      [CODELY_CHECKIN_INIT_PATH]: () => ({
        status: 200,
        body: initState({
          levels: [{ level: 20, status: 'CURRENT', reward_summary: '+???' }],
        }),
      }),
      [CODELY_CHECKIN_PATH]: () => ({ status: 200, body: checkInState() }),
    })
    const outcome = await claimCodelyDailyCheckIn(CREDENTIAL, { fetcher })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 0 })
    expect(outcome.kind === 'claimed' && outcome.delayedMessage).toContain('未返回本次积分数额')
  })
})
