import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCodelyBalanceDetailed, CODELY_USAGE_SUMMARY_PATH, type CodelyCredential } from '../../src/codely-credits.js'
import { CODELY_API_BASE } from '../../src/codely-auth.js'

/**
 * ⚠️ Codely 积分解析的**行为级**测试。
 *
 * ## 守什么（每条都对应一个真实形态或真实缺陷形态）
 *
 * - **字符串数字**：实测 `remaining_points:"2400"` 是字符串 —— 只认 number
 *   会让所有真账号显示「查询失败」；
 * - **逐桶映射**：`details[]` 与 zcode 的 buckets 同型，多桶账号**不能只取
 *   第一桶**（丢桶 = 数字对不上）；
 * - **绝不显示 0**：缺字段 / 全桶读不到 = 「读数格式变了」，0 的语义是「已用光」；
 * - **401 ≠ 网络失败**：用户动作完全不同（重新登录 vs 查网络）。
 */

const CRED: CodelyCredential = {
  access_token: 'AT',
  refresh_token: 'RT',
  obtained_at: 0,
}

/** 安装固定响应的替身 fetch；返回 vi.fn 以便断言调用参数。 */
function stubFetch(status: number, body: string | unknown): ReturnType<typeof vi.fn> {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const mock = vi.fn(async () => new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchCodelyBalanceDetailed（usage/summary 解析）', () => {
  it('★ 实测形状：字符串数字 + 单桶 details（2026-10-19 真响应逐字）', async () => {
    const fetchMock = stubFetch(200, {
      remaining_points: '2400',
      is_exhausted: false,
      details: [{ type: 'gift_credit', remaining_points: '2400', exhausted: false }],
    })
    const { balance, error } = await fetchCodelyBalanceDetailed(CRED)
    expect(error).toBeUndefined()
    expect(balance?.total).toBe(2400)
    expect(balance?.packages).toHaveLength(1)
    expect(balance?.packages[0]).toMatchObject({
      name: '赠送积分',
      remaining: 2400,
      unit: 'credit',
      active: true,
    })
    // 请求确实打到了自己的端点（路径由 URL 契约保证 —— 这里核对的
    // 是「fetch 收到的 URL 含真路径」）。
    expect(String(fetchMock.mock.calls[0]?.[0] as URL)).toBe(
      `${CODELY_API_BASE}${CODELY_USAGE_SUMMARY_PATH}`,
    )
  })

  it('★ 多桶：逐桶成包，汇总与逐桶之和自洽', async () => {
    stubFetch(200, {
      remaining_points: '3000',
      is_exhausted: false,
      details: [
        { type: 'gift_credit', remaining_points: '2400', exhausted: false },
        { type: 'paid_credit', remaining_points: '600', exhausted: false },
      ],
    })
    const { balance } = await fetchCodelyBalanceDetailed(CRED)
    expect(balance?.packages).toHaveLength(2)
    // 未知桶类型不猜名字：原样 type（绝不编造官方中文假名）。
    expect(balance?.packages[0]).toMatchObject({ name: '赠送积分', remaining: 2400 })
    expect(balance?.packages[1]).toMatchObject({ name: 'paid_credit', remaining: 600 })
    expect(balance?.total).toBe(3000)
  })

  it('★ 缺 details：顶层汇总单桶兜底（不是 0、不是失败）', async () => {
    stubFetch(200, { remaining_points: '800', is_exhausted: false })
    const { balance } = await fetchCodelyBalanceDetailed(CRED)
    expect(balance?.total).toBe(800)
    expect(balance?.packages).toHaveLength(1)
    expect(balance?.packages[0].remaining).toBe(800)
  })

  it('★ exhausted 桶：active=false（如实呈现，不丢桶）', async () => {
    stubFetch(200, {
      remaining_points: '0',
      is_exhausted: true,
      details: [{ type: 'gift_credit', remaining_points: '0', exhausted: true }],
    })
    const { balance } = await fetchCodelyBalanceDetailed(CRED)
    // ⚠️ 真 0（exhausted）必须如实显示 0 —— 与「读不到不显示 0」相反。
    expect(balance?.total).toBe(0)
    expect(balance?.packages[0]).toMatchObject({ remaining: 0, active: false })
  })

  it('★ details 全桶读不到：报「读数格式变了」，绝不显示 0', async () => {
    stubFetch(200, {
      remaining_points: 'oops',
      details: [{ type: 'gift_credit', remaining_points: null }],
    })
    const { balance, error } = await fetchCodelyBalanceDetailed(CRED)
    expect(balance).toBeNull()
    expect(error).toContain('没有可读的积分数字')
    expect(error).toContain('上游可能改版')
  })

  it('★ 空串数字不翻成 0（Number("") === 0 陷阱）', async () => {
    stubFetch(200, { remaining_points: '  ', details: [] })
    const { balance, error } = await fetchCodelyBalanceDetailed(CRED)
    expect(balance).toBeNull()
    expect(error).toContain('上游可能改版')
  })

  it('★ 401：指向重新登录，而非笼统失败', async () => {
    stubFetch(401, { error: 'Unauthorized' })
    const { balance, error } = await fetchCodelyBalanceDetailed(CRED)
    expect(balance).toBeNull()
    expect(error).toContain('401')
    expect(error).toContain('重新')
  })

  it('★ 非 JSON 响应：带 HTTP 状态与报文摘要', async () => {
    stubFetch(200, '<html>SPA</html>')
    const { balance, error } = await fetchCodelyBalanceDetailed(CRED)
    expect(balance).toBeNull()
    expect(error).toContain('不是 JSON')
    expect(error).toContain('SPA')
  })

  it('★ 网络失败：可读原因（不是原始 fetch 错误）', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('fetch failed')
    })
    const { balance, error } = await fetchCodelyBalanceDetailed(CRED)
    expect(balance).toBeNull()
    expect(error).toContain('网络请求失败')
  })

  it('★ 空凭据：不发起请求直接报「未完成登录」', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { balance, error } = await fetchCodelyBalanceDetailed({ access_token: '', refresh_token: '', obtained_at: 0 })
    expect(balance).toBeNull()
    expect(error).toContain('未完成登录')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
