/**
 * Codely 的 auth 服务对象（供 `JetHubAuths` 与 `auth.refreshAll` 接线）。
 *
 * ## 为什么需要它
 *
 * `channel: true` 会把 Codely 纳入三张派生判据（应有 auth / 应可续期 /
 * 应进聚合目录）。其中「续期分派」要求 `authOf(auths, 'codely')` 返回一个
 * **带 `refreshAccountCredential` 的对象**，否则该渠道永不自动续期且日志零字
 * （issue IKKHL5 的形态）。
 *
 * ## 续期语义（2026-10-20 实测）
 *
 * Codely 有两层凭证：
 * - `access_token`：登录态（JWT，约 365 天），**可续期** ——
 *   `POST /auth/refresh {refresh_token}` → `{access_token, refresh_token}`，
 *   ⚠️ `refresh_token` **不轮换**（连续三次调用返回同值，实测）；
 * - `cli_api_key`：推理用（`sk-…`），**每次调用换发、无需缓存**
 *   （`fetchCodelyCliApiKey`）⇒ 本服务**不续期它**。
 *
 * ⇒ 「续期」只刷新 `access_token`，成功后写回凭据库。
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  CODELY_API_BASE,
  CODELY_HTTP_TIMEOUT_MS,
  CODELY_USER_AGENT_HEADER,
  readCodelyCredential,
  type CodelyCredential,
} from './codely-auth.js'

/** 凭据库最小接口（与 `readCodelyCredential` 同形）。 */
interface CredentialStoreLike {
  resolve(ref: string): Promise<{ value?: string } | undefined>
  set(ref: string, value: string): Promise<void>
}

/**
 * 用 `refresh_token` 换新的 `access_token`。
 *
 * ⚠️ 不需要 Bearer（实测：只带 JSON 头 + 身份头即可）；
 * ⚠️ 失败返回 `undefined`（调用方在续期路径上，抛错会被误报成"凭据失效"）。
 */
export async function refreshCodelyCredential(
  refreshToken: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ accessToken: string; refreshToken: string } | undefined> {
  if (refreshToken.length === 0) return undefined
  const fetcher = options.fetcher ?? fetch
  try {
    const res = await fetcher(`${CODELY_API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-User-Agent': CODELY_USER_AGENT_HEADER,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      // ⚠️⚠️ **必须带超时**（2026-10-22 A3 同类：续期端点也漏了）。
      //    续期路径由定时器 + 积分自愈双触发，上游挂住时这一层会**永久卡住**。
      signal: options.signal === undefined
        ? AbortSignal.timeout(CODELY_HTTP_TIMEOUT_MS)
        : AbortSignal.any([options.signal, AbortSignal.timeout(CODELY_HTTP_TIMEOUT_MS)]),
    })
    if (!res.ok) return undefined
    const payload = await res.json().catch(() => undefined) as
      | { access_token?: unknown; refresh_token?: unknown }
      | undefined
    const accessToken = payload?.access_token
    if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined
    // ⚠️ 响应里的 refresh_token 与传入的相同（不轮换），缺省时沿用旧值
    const nextRefresh = typeof payload?.refresh_token === 'string' && payload.refresh_token.length > 0
      ? payload.refresh_token
      : refreshToken
    return { accessToken, refreshToken: nextRefresh }
  } catch {
    return undefined
  }
}

/**
 * Codely 的 auth 服务（`JetHubAuths.codely` 的值）。
 *
 * 刻意只做「续期 access_token + 写回凭据库」两件事：`cli_api_key` 是派生品、
 * 每请求换发，不需要缓存，也不需要回写池（池里的 `expiresAt` 跟随 access_token）。
 *
 * ## ⚠️⚠️ 为什么必须 `extends Service`（2026-10-22 A6）
 *
 * 它原来是个裸类（不继承 `Service`），而本仓库的“按 id 取 auth 实例”路径
 * 均按 `${product.id}Auth` **服务名**从 `ctx` 上取（`account.refresh` 的分派、
 * `jet-hub-rpc-auth-wiring.spec` 的逐家点名、`provider-runtime` 的内存注册…）。
 * 不继承 `Service` 就意味着 cтx 上永远没有 `codelyAuth` ⇒ 下游全部取不到。
 *
 * ⚠️ 注意服务名是 **`codelyAuth`**（全小写，与 provider id 同形），不是
 * `CodelyAuth`：其余 13 家都是 `${product.id}Auth`，写成大写开头会让
 * `AUTH_SERVICE` 表与实际服务名不一致。
 */
export class CodelyAuth extends Service {
  constructor(
    ctx: Context,
    private readonly options: {
      credentials?: CredentialStoreLike
      fetcher?: typeof fetch
      /** 回写池条目有效期（可选；缺省不写，保持"尽力而为"）。 */
      writebackExpiry?: (accountId: string, expiresAtMs: number | undefined) => Promise<void>
    } = {},
  ) {
    super(ctx, 'codelyAuth')
  }

  /**
   * 记一条 warn。
   *
   * ⚠️ 为什么裹这么多可选链 + try：cordis 的 `ctx.logger` 在测试桩里可能整个不存在，
   *    而这里只是想留一条排查线索 —— 因为打日志把续期流程打崩，比不打日志糟得多。
   */
  private warn(message: string): void {
    try {
      this.ctx?.logger?.warn?.(`[codely-auth] ${message}`)
    } catch { /* 日志不可用不得影响续期 */ }
  }

  /**
   * 续期某一个账号（守卫要求的方法）。
   *
   * @param refName 凭据 ref（`codely.account.<id>` 之类，直接交给凭据库）
   * @param _accountId 池里的账号 id（用于可选的池回写）
   *
   * ## ⚠️ 三处早退拆成**四条** warn（2026-10-24 补，2026-10-31 审计修正计数）
   *
   * 原来都是裸 `return`：凭据库没注入、读不到凭据、凭据在但没有 refresh_token、
   * 上游续期失败 —— 四种**性质完全不同**的原因在现象上完全一致 ——
   * 「续期永远不发生，日志零字」。这正是 A1/A5 那一轮要治的失效形态
   * （静默失败比报错更难查）。别家在同类早退会把账号标成不可续期
   * （`cline-auth.ts`）或至少记 warn（`modelscope-auth.ts`）。
   * ⚠️ 四条 warn 有行为守卫（`codely-auth-service.spec.ts` 的
   * 「续期早退必须留痕」describe），删掉任一调用点会红。
   */
  async refreshAccountCredential(
    refName: string,
    _pool: unknown,
    accountId: string,
  ): Promise<void> {
    const store = this.options.credentials
    if (store === undefined) {
      // 这是**接线错误**（构造时没注入 credentials），不是账号问题 —— 它会让本实例的
      // 续期功能整体失效，必须显眼。不抛是因为抛会打断宿主整个续期轮次。
      this.warn(`credentials 未注入，本实例续期功能整体不可用（账号 ${accountId} 已跳过）`)
      return
    }
    const current = await readCodelyCredential(refName, store)
    if (current === undefined) {
      this.warn(`账号 ${accountId} 读不到凭据（ref=${refName}），跳过续期`)
      return
    }
    if (current.refresh_token.length === 0) {
      // 属**账号级**问题：这个号没有 refresh_token，只能重新登录，续期救不了。
      this.warn(`账号 ${accountId} 没有 refresh_token，无法续期，需重新登录`)
      return
    }
    const next = await refreshCodelyCredential(current.refresh_token, {
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
    })
    if (next === undefined) {
      // 三种原因同形：401（令牌彻底失效）/ 网络异常 / 上游协议变更。不记账、不锁号
      // （与换发侧 A1 的 `transient` 处理同纪律），但必须留痕，否则无从判断是哪一种。
      this.warn(`账号 ${accountId} 续期失败（上游返回空；可能为 401 / 网络异常 / 协议变更），未记账`)
      return
    }
    const updated: CodelyCredential = {
      ...current,
      access_token: next.accessToken,
      refresh_token: next.refreshToken,
      obtained_at: Date.now(),
    }
    try {
      await store.set(refName, JSON.stringify(updated))
    } catch { /* 写回失败不阻断续期流程 */ }
    if (this.options.writebackExpiry !== undefined) {
      await this.options.writebackExpiry(accountId, expiryMsOf(next.accessToken)).catch(() => {})
    }
  }

  /**
   * 批量续期（`JetHubAuthLike.refreshAll` 契约的**单参**形式）。
   *
   * ## ⚠⚠ 为什么是单参（2026-10-22 对抗审计 A5 修）
   *
   * 旧签名是 `refreshAll(pool, refreshOne)`（2 个参数），而契约
   * （`src/jet-hub-rpc.ts` 的 `JetHubAuthLike`）要求的是 `refreshAll(pool)`（**1 个**）
   * —— 而且 `index.ts` 的注册循环根本**提供不了** `refreshOne`。
   *
   * 两条硬证据（实测）：
   * - **编译期**：把本类当 `JetHubAuthLike` 使用直接 **TS2322**（`Target signature
   *   provides too few arguments. Expected 2 or more, but got 1`）；
   * - **运行期**：按 `refreshAll: (pool) => auth.refreshAll(pool)` 包一层调用就招
   *   `TypeError: refreshOne is not a function`，而该异常会被外层逐 provider
   *   的 `try` 吞成一条 warn ⇒ **续期恒不发生且日志几乎零字**（officeace 那条「把同步池当 Promise」同型）。
   *
   * ⇒ 改法：与 `accio-auth.ts` / 其余各家**同一形状** —— 内部自己遍历池、逐个调
   *   `refreshAccountCredential`（那就是本类自己的方法）。
   *
   * ⚠️ 读池抛错 / 空池 ⇒ 静默返回（一个渠道的池抖动不该让整轮续期炸掉）。
   * ⚠️ 必须逐个走 `refreshAccountCredential`（**不能直接调裸函数**）：否则池里的
   *   `expiresAt` 不回写，界面有效期停在旧值（officeace 记过同款缺陷）。
   */
  async refreshAll(pool: unknown): Promise<void> {
    let accounts: readonly { id: string; credentialRef: string }[] = []
    try {
      const listed = (pool as { listAccountsByProvider?: (id: string) => unknown } | undefined)
        ?.listAccountsByProvider?.('codely')
      const resolved = await listed
      if (Array.isArray(resolved)) {
        accounts = resolved as { id: string; credentialRef: string }[]
      }
    } catch {
      return
    }
    for (const account of accounts) {
      // ⚠️ 单个失败不影响其余账号（与各家同款）。
      await this.refreshAccountCredential(account.credentialRef, pool, account.id).catch(() => undefined)
    }
  }
}

/** 从 JWT 的 `exp` 取毫秒（失败返回 undefined，不编造）。 */
function expiryMsOf(jwt: string): number | undefined {
  const parts = jwt.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' && payload.exp > 0 ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}
