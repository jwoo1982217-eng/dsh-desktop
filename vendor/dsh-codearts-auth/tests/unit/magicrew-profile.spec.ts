/**
 * magicrew-profile.spec.ts —— 超级麦吉**账号资料**取数（昵称来源）单测
 *
 * 被测源码：`src/magicrew-profile.ts`（`fetchMagicrewProfile`）。
 *
 * ── 零网络（硬约束）──────────────────────────────────────────────────────
 * 全部走注入 `fetchImpl`：替身只回 fixture 信封，**永远不打** `i-magic-service.letsmagic.cn`。
 *
 * ── 这个模块为什么值得单独一组用例 ──────────────────────────────────────
 * 它是卡片昵称的**唯一**来源（真机报障 2026-10-29：卡片显示「超级麦吉」而用户叫 `Nick`）。
 * 三条最容易静默失效的地方：
 * ① `organization-code` 头漏发（实测缺了读不到本账号资料，而报文仍是 200）；
 * ② `data.items` 的形状（数组 / 单个对象 / 根本没有 `items`）—— 少认一种就是
 *    「换个上游版本就静默没有昵称」；
 * ③ 失败必须**抛**（不是返回空串）：调用方靠 `throw` 才能区分「上游说没有昵称」
 *    与「我们根本没读到」，后者要留痕。
 */

import { describe, expect, it } from 'vitest'

import { MAGICREW_PROFILE_PATH, fetchMagicrewProfile } from '../../src/magicrew-profile.js'
import { MAGICREW } from '../../src/magicrew-product.js'

/** 记下每次请求的 url / method / headers，并回一个给定响应。 */
function recorder(response: Response | (() => Response)) {
  const calls: { url: string, method: string, headers: Record<string, string> }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init.method ?? 'GET'),
      headers: (init.headers ?? {}) as Record<string, string>,
    })
    return typeof response === 'function' ? response() : response.clone()
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 上游信封（`code:1000` = ok）。 */
function envelope(data: unknown): Response {
  return jsonResponse({ code: 1000, data })
}

const JWT = 'header.payload.signature'
const ORG = 'org-fixture'

describe('fetchMagicrewProfile：请求形状', () => {
  it('★ 打到**带 `/users`** 的那个端点，且 `authorization` 与 `organization-code` **两个头都在**', async () => {
    const { calls, fetchImpl } = recorder(envelope({ items: [{ nickname: 'Nick' }] }))

    await fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl })

    expect(calls).toHaveLength(1)
    // ⚠️ 不带 `/users` 的那条路径**实测 404**（本模块头注释里记着），写错了这里会红。
    expect(calls[0]?.url).toBe(`${MAGICREW.host}${MAGICREW_PROFILE_PATH}`)
    expect(MAGICREW_PROFILE_PATH).toBe('/api/v1/contact/accounts/me/users')
    // ⚠️ 两个头**都**是判据：缺 `organization-code` 时上游不给本账号的资料（实测）。
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${JWT}`)
    expect(calls[0]?.headers['organization-code']).toBe(ORG)
  })

  it('⚠️ `organizationCode` 为空串时**不发**该头（不发空值，与姐妹模块同口径）', async () => {
    const { calls, fetchImpl } = recorder(envelope({ items: [{ nickname: 'Nick' }] }))

    await fetchMagicrewProfile({ jwt: JWT, organizationCode: '', product: MAGICREW, fetchImpl })

    expect(calls[0]?.headers['organization-code']).toBeUndefined()
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${JWT}`)
  })
})

describe('fetchMagicrewProfile：`data.items` 的三种形状都要认', () => {
  it('★ 数组形状 ⇒ 取第一个条目', async () => {
    const { fetchImpl } = recorder(envelope({
      items: [
        { nickname: 'Nick', real_name: 'Nick', phone: '1380000000' },
        { nickname: '别人' },
      ],
    }))

    await expect(fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl }))
      .resolves.toEqual({ nickname: 'Nick', realName: 'Nick', phone: '1380000000' })
  })

  it('★ `items` **不是数组**（单个对象）⇒ 照样认（magpie 的 `?? body?.data ?? {}` 兜底那一格）', async () => {
    const { fetchImpl } = recorder(envelope({ items: { nickname: 'Nick', real_name: 'Nick' } }))

    await expect(fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl }))
      .resolves.toEqual({ nickname: 'Nick', realName: 'Nick', phone: '' })
  })

  it('★ `items` 整个缺失 ⇒ 把 `data` 自己当条目', async () => {
    const { fetchImpl } = recorder(envelope({ nickname: 'Nick', real_name: 'Nick', phone: '1380000000' }))

    await expect(fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl }))
      .resolves.toEqual({ nickname: 'Nick', realName: 'Nick', phone: '1380000000' })
  })

  it('★ 条目里**没有 `nickname`** ⇒ 回落 `real_name`（降级，不抛）', async () => {
    const { fetchImpl } = recorder(envelope({ items: [{ real_name: 'Nick', phone: '1380000000' }] }))

    await expect(fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl }))
      .resolves.toEqual({ nickname: 'Nick', realName: 'Nick', phone: '1380000000' })
  })

  it('★ 条目里只有 `phone` ⇒ 昵称为空串（**由展示层**回落脱敏号，不在这里编造）', async () => {
    const { fetchImpl } = recorder(envelope({ items: [{ phone: '1380000000' }] }))

    await expect(fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl }))
      .resolves.toEqual({ nickname: '', realName: '', phone: '1380000000' })
  })
})

describe('fetchMagicrewProfile：拿不到就抛（不静默降级）', () => {
  it('⚠️ 非 200（404）⇒ 抛，且报文里带状态码', async () => {
    const { fetchImpl } = recorder(new Response('<!doctype html>not found', { status: 404 }))

    await expect(fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl }))
      .rejects.toThrow(/HTTP 404/)
  })

  it('⚠️ 200 但**不是 JSON** ⇒ 抛，且报文里带响应片段（不静默返回空昵称）', async () => {
    const { fetchImpl } = recorder(new Response('upstream is down', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }))

    await expect(fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl }))
      .rejects.toThrow(/返回的不是 JSON/)
  })

  it('⚠️ 业务码非 1000 ⇒ 抛**上游原文**（`token无效` 这类文案本身就是出路）', async () => {
    const { fetchImpl } = recorder(jsonResponse({ code: 403, message: 'token无效' }))

    await expect(fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl }))
      .rejects.toThrow('token无效')
  })

  it('⚠️ 字面量 `null`（合法 JSON）⇒ 抛可读错误（不能在 null 上取属性）', async () => {
    const { fetchImpl } = recorder(jsonResponse(null))

    await expect(fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl }))
      .rejects.toThrow(/返回的不是对象/)
  })

  it('⚠️ `items` 是**空数组** ⇒ 抛（不返回空昵称假装成功）', async () => {
    const { fetchImpl } = recorder(envelope({ items: [] }))

    await expect(fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl }))
      .rejects.toThrow(/账号资料为空/)
  })

  it('⚠️ 条目里三个字段一个都没有 ⇒ 抛（形状变了要看得见，不能静默变成「没有昵称」）', async () => {
    const { fetchImpl } = recorder(envelope({ items: [{ status: 1 }] }))

    await expect(fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl }))
      .rejects.toThrow(/没有任何可用字段/)
  })

  it('⚠️ 传输层抛错**原样往上传**（不吞成「没有昵称」）', async () => {
    const fetchImpl = (async () => {
      throw new Error('fetch failed')
    }) as unknown as typeof fetch

    await expect(fetchMagicrewProfile({ jwt: JWT, organizationCode: ORG, product: MAGICREW, fetchImpl }))
      .rejects.toThrow('fetch failed')
  })
})
