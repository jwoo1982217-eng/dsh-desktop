import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { MagicrewAuth } from '../../src/magicrew-auth.js'
import { MagicrewService } from '../../src/magicrew.js'
import { MAGICREW_GATEWAY_TOKENS_PATH, MAGICREW_POINTS_PATH } from '../../src/magicrew-product.js'
import { UNUSABLE } from '../../src/aggregate-core.js'
import type { CreditBalance } from '../../src/credits.js'

/**
 * ⚠️⚠️ **一切「未来日期」必须推到 2099**（2026-10-29 日期炸弹）。
 *
 * `magicrewExpiry` 用 `expiresAt > now` **跳过已过期批次** ⇒ 报文里写死
 * `2026-11-20` 的用例会在那天**自己变红**，代码一行没改。
 * 双保险：① 日期推到 2099；② 每个用过时钟的用例都注入固定 `now`
 * （`MagicrewServiceOptions.now`）⇒ 不再依赖真实时钟。
 */
const FIXED_NOW = Date.UTC(2099, 0, 1, 0, 0, 0)
/** `2099-12-31 23:59:59`（**无时区**）按 UTC+8 解释 ⇒ `2099-12-31T15:59:59Z`。 */
const FAR_FUTURE = Date.UTC(2099, 11, 31, 15, 59, 59)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 标准 SSE 假响应（`data: <line>` + 空行分隔，与上游逐字同形）。 */
function sseResponse(lines: string[]): Response {
  const body = lines.map((line) => `data: ${line}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

/**
 * ⚠️ 登录实现的宿主是 `MagicrewAuth`（K1：`account.create` 只拿得到 `JetHubAuths`），
 * `MagicrewService.login` 只是薄委托 ⇒ 这两条用例必须注入一个真实 auth 实例。
 * 凭据库给一个**永远读不到**的替身：这两条只关心登录/签发的两次请求与 warn。
 */
function makeAuth(opts: { fetchImpl: typeof fetch, warn?: (m: string) => void }) {
  const ctx = new Context()
  ctx.provide('credentials', {
    async resolve() { return undefined },
    async set() {},
    async unset() {},
  } as never)
  return new MagicrewAuth(ctx, opts)
}

const CHAT_OPTIONS = {
  provider: 'magicrew',
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
} as unknown as GenerateOptions

/** 一份最小可用余额报文（折算只需要 `remaining` 与 `deductionEndTime`）。 */
function balanceWith(remaining: number, deductionEndTime: number): CreditBalance {
  return {
    total: remaining,
    expiredTotal: 0,
    packages: [{
      name: '限时积分',
      unit: '积分',
      remaining,
      total: remaining,
      used: 0,
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
      deductionEndTime,
    }],
  }
}

describe('magicrew 服务入口', () => {
  /**
   * ⚠️ 「手机号 + 密码」登录已**整体删除**（2026-10-29 用户纠正）：上游
   * `phone_password` 端点确实存在，但 magpie 参考实现里那个 `login()` 零调用者
   * （未采用的探索代码），真实入口是短信（要先解旋转验证码 ⇒ 要识图模型）。
   * ⇒ 本家只走「读本机浏览器登录态」与「网页版登录」两条无门槛的路。
   *
   * 原来这里的两条用例（登录两次请求 / 签发失败不吞结果）已随实现一起删除；
   * 等价的「读到登录态后**必须签发一次** key（否则每请求 AUTH 的幽灵账号）」与
   * 「签发失败不吞导入结果」由 `magicrew-local-browser.spec.ts` 覆盖 —— 那里
   * 用注入的临时浏览器目录，**不碰用户真实浏览器**。
   */
  it('★ 已不再暴露手机号+密码登录（防回退）', () => {
    const service = new MagicrewService({ auth: makeAuth({ fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch }) })
    // 判据打在**能力**上：该成员不存在。写成「调它抛错」会让将来误加回来时
    // 也「只是抛错」，而这条用例的意图是「它根本不该存在」。
    expect(Object.hasOwn(service as unknown as Record<string, unknown>, 'login')).toBe(false)
  })

  it('refresh 没有 refresh_token 时原样返回且零请求（jwt 仍能拉目录/积分）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    const service = new MagicrewService({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const credential = { jwt: 'j.w.t', organizationCode: 'org1' }
    await expect(service.refresh(credential)).resolves.toBe(credential)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('★ refresh 是纯凭据变换：一次 PUT、凭据进新凭据出、不改入参、不碰账号池', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({
      code: 1000,
      data: { api_key: 'mgw_new', api_key_expires_at: 1_793_209_072_000, refresh_token: 'rt_new' },
    }))
    const service = new MagicrewService({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const before = {
      jwt: 'j.w.t',
      organizationCode: 'org1',
      apiKey: 'mgw_old',
      apiKeyExpiresAt: 1,
      refreshToken: 'rt_old',
      refreshTokenExpiresAt: 42,
      phone: '13011112222',
    }
    const after = await service.refresh(before)
    // api_key 两件套被换掉、refresh_token 被**轮换**（一次性）；其余字段原样保留
    // （`refreshTokenExpiresAt` 上游续期不下发 ⇒ 必须保住旧值，不能抹成 undefined）。
    expect(after).toEqual({
      ...before,
      apiKey: 'mgw_new',
      apiKeyExpiresAt: 1_793_209_072_000,
      refreshToken: 'rt_new',
    })
    // 纯变换 ⇒ 入参不被就地改写（同一份凭据可能被别处持有）。
    expect(before.apiKey).toBe('mgw_old')
    expect(before.refreshToken).toBe('rt_old')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    // ⚠️ 断言引用**同一定义处**（`MAGICREW_GATEWAY_TOKENS_PATH`）而不是把路径抄一遍。
    expect(String(url)).toContain(MAGICREW_GATEWAY_TOKENS_PATH)
    expect(init?.method).toBe('PUT')
    // 续期只带 refresh_token（带 JWT 反而会在 JWT 过期时把可续变成不可续）。
    expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: 'rt_old' })
  })

  it('★ balance 复用注入的 fetchImpl 并透出原语的余额（不是 0、不是同义重复）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1000,
      data: {
        total_points: 4321,
        expiring_quota_details: [{ remaining_points: 120, expires_at: '2099-12-31 23:59:59' }],
      },
    }))
    const service = new MagicrewService({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const balance = await service.balance({ jwt: 'j.w.t', organizationCode: 'org1' })
    // ⚠️ 判据打在「注入的 fetch 被真调用」上：`fetchImpl` 在服务里是 `private`，
    //    若 `balance()` 不把它交给原语（退回全局 fetch），外部就无法桩掉网络。
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(MAGICREW_POINTS_PATH)
    expect(balance?.total).toBe(4321)
    expect(balance!.packages).toHaveLength(2)
    expect(balance?.packages[0]!.remaining).toBe(120)
  })

  it('balance 取数失败 ⇒ undefined（调用方不得当 0）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 500, message: '内部错误' }))
    const service = new MagicrewService({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(service.balance({ jwt: 'j.w.t', organizationCode: 'org1' }))
      .resolves.toBeUndefined()
  })

  // ── ① adapter 注入点必须真的透到适配器 ────────────────────────────────────
  //    否则适配器退回它自己的缺省：`resolveCredential` = 「永远没有凭据」⇒ 每条
  //    请求抛 `AUTH`；`fetchRemoteModels` 缺省 ⇒ 目录只有静态兜底（静默）。
  it('★ resolveCredential 注入后透到适配器（否则每请求抛「账号未登录」而用户已登录）', async () => {
    const resolveCredential = vi.fn(async () => ({
      jwt: 'j.w.t',
      organizationCode: 'org1',
      apiKey: 'mgw_injected',
    }))
    const fetchImpl = vi.fn(async () => sseResponse(['[DONE]']))
    const service = new MagicrewService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveCredential,
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of service.adapter.stream(CHAT_OPTIONS)) chunks.push(chunk)
    expect(resolveCredential).toHaveBeenCalled()
    // 判据打在**行为**上：请求头里的 api_key 只能是注入的凭据给的
    // （适配器缺省 `async () => undefined` 会在这里之前就抛 `LlmError(AUTH)`）。
    const init = fetchImpl.mock.calls[0]![1] as { headers?: Record<string, string> }
    expect(init.headers?.authorization).toBe('Bearer mgw_injected')
    expect(init.headers?.['organization-code']).toBe('org1')
  })

  it('★ fetchRemoteModels 注入后透到适配器（否则目录只有静态兜底，静默）', async () => {
    const fetchRemoteModels = vi.fn(async () => [
      { id: 'zz-injected-only', name: '注入模型', vision: false },
    ])
    const service = new MagicrewService({ fetchRemoteModels })
    const models = await service.adapter.listModels('magicrew')
    expect(fetchRemoteModels).toHaveBeenCalledTimes(1)
    expect(models.map((model) => model.id)).toContain('zz-injected-only')
  })

  it('★ expiry 委托折算原语并自带取数腿（无共享读数时只发一次请求）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 1000,
      data: {
        total_points: 500,
        // ⚠️ 日期推到 2099（2026-11-27 那版是日期炸弹，见文件头常量）。
        expiring_quota_details: [{ remaining_points: 120, expires_at: '2099-12-31 23:59:59' }],
      },
    }))
    const service = new MagicrewService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // ⚠️ 固定时钟 ⇒ 该批次恒「未过期」，用例不再随真实时间变红。
      now: () => FIXED_NOW,
    })
    const value = await service.expiry({ jwt: 'j.w.t', organizationCode: 'org1' })
    // `expires_at` 无时区 ⇒ 按 UTC+8 解释：2099-12-31 23:59:59+08:00 = 15:59:59Z
    // （ⓘ 期望值用独立算式写出，不借被测实现的解析函数 ⇒ 否则是同义反复）。
    expect(value).toBe(FAR_FUTURE)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('expiry 有共享读数（context.cachedBalance）时不再自己发请求', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 1000, data: { total_points: 1 } }))
    const service = new MagicrewService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED_NOW,
    })
    const value = await service.expiry(
      { jwt: 'j.w.t', organizationCode: 'org1' },
      { cachedBalance: async () => balanceWith(7, FAR_FUTURE) },
    )
    expect(value).toBe(FAR_FUTURE)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('expiry 凭据里没有 jwt ⇒ UNUSABLE（不是 NEVER：NEVER 会把它排最前并当选）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    const service = new MagicrewService({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(service.expiry({ organizationCode: 'org1' })).resolves.toBe(UNUSABLE)
    await expect(service.expiry(undefined)).resolves.toBe(UNUSABLE)
    // 连余额都查不到 ⇒ 不该白花一次上游请求。
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
