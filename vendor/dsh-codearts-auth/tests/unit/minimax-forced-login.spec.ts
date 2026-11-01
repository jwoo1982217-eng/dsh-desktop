/**
 * `minimax-forced-login.spec.ts` —— MiniMax「链接自带旧 session」的修法守卫（2026-10-24）。
 *
 * ## 用户报障
 *
 * > 「jethub 插件的 minimaxcode 登录会导致旧 session 掉登录状态，
 * >  登录链接一打开就自带旧 session 登录态」
 *
 * ## 根因（实测，见 `minimax-product.ts` 的常量注释）
 *
 * `verification_uri_complete` 里的 `user_code` **不含身份**，身份全在浏览器
 * cookie。上游页面**不认**任何强制重新登录的参数（`prompt=login` /
 * `prompt=consent` / `prompt=select_account` / `force_login=1` / `relogin=1`
 * 五个在授权页 chunk 里命中数**全为 0**）。
 *
 * 上游自己的「切换账号」按钮走 `GET /oauth2/device/authorize`（**不带 cookie**）：
 *
 * ```
 * 401 {"error":"login_required",
 *      "login_url":"/unified-login?login_redirect=%2Foauth-authorize%3Fclient_id%3Dmcode-public%26user_code%3D…"}
 * ```
 *
 * ⇒ 宿主可以在**不依赖浏览器会话**的前提下合成「保证走一遍登录」的链接。
 *
 * ## 本文件锁的四格
 *
 * 1. `resolveMinimaxForcedLoginUrl` 的白名单判据（同站 / `/unified-login` /
 *    回跳必须是本站 `/oauth-authorize` 且 `user_code` 一致）；
 * 2. `fetchMinimaxForcedLoginUrl` **任何失败都退回**本地兜底链接（绝不抛错）；
 * 3. `startLogin` 真的把 `forcedLoginUrl` 带出来（可选字段，拿不到就**不填**）；
 * 4. RPC 分支无痕窗口**用的是 forcedLoginUrl**（不是 loginUrl）——
 *    「普通窗口回退路径」唯一能换号的就靠这一格。
 *
 * ⚠️ 本文件**不 import `src/login.js`**（它会真开窗；仓库守卫 ⑪ 会抓单测目录里的
 *    该 import）。第 4 格是**源码文本断言**，与 `codearts-incognito-login.spec.ts`
 *    同型。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MINIMAX } from '../../src/minimax-product.js'
import {
  buildMinimaxForcedLoginUrl,
  fetchMinimaxForcedLoginUrl,
  resolveMinimaxForcedLoginUrl,
  type MinimaxDeviceAuthorization,
} from '../../src/minimax-oauth.js'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSource = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
const clientSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')

  /** 截取 `account.create` 里 minimax 分支（从分支头到其 return）。 */
function minimaxBranch(): string {
    const start = rpcSource.indexOf(
      '} else if (provider === MINIMAX.id || provider === MINIMAX_INTL.id) {',
    )
    expect(start, 'jet-hub-rpc.ts 找不到 minimax 分支（被改名/移动了？）').toBeGreaterThan(-1)
    const end = rpcSource.indexOf('} else if (provider === ZCODE.id) {', start + 10)
    return rpcSource.slice(start, end > start ? end : undefined)
  }


const SITE = MINIMAX.accountHost
const HOST = new URL(SITE).origin
const CODE = 'QJNX-CZXV'

/**
 * ⚠️ 本格需要 `@deepseek-ai/cordis`（`MinimaxAuth extends Service`）。
 *
 * ## ⚠️⚠️ 探针必须是 `await import()`，不能是 `import.meta.resolve`
 *
 * 改前写的是 `import.meta.resolve('@deepseek-ai/cordis')`，注释还写着
 * 「完整安装的 checkout 里它会真跑」—— **两句话都不成立**（2026-10-25 审计实测）：
 * Vite SSR 下 `import.meta` 被改写成 `__vite_ssr_import_meta__`，它**没有
 * `resolve` 方法** ⇒ 恒抛 `TypeError` ⇒ `cordisAvailable` 恒 `false` ⇒
 * 这条**最承重的行为用例永久 SKIP**，与是否安装依赖毫无关系。
 * 而本机 `@deepseek-ai/cordis@4.0.5` 是**装着**的，同目录的
 * `minimax-login-nickname-rpc.spec.ts` 用 `await import()` 一直能真跑。
 *
 * ⇒ 探针与用例体用**同一种**加载方式（`await import`），SKIP 才真正代表
 *   「依赖不齐」。SKIP ≠ PASS 仍然成立（仓库铁律）。
 */
const cordisAvailable = await (async (): Promise<boolean> => {
  try {
    await import('@deepseek-ai/cordis')
    return true
  } catch {
    return false
  }
})()

/** 真机形态的 401 响应体（实测原文，见 `MINIMAX_DEVICE_AUTHORIZE_PATH` 注释）。 */
function loginRequiredBody(userCode = CODE): { login_url: string } {
  return {
    login_url: `/unified-login?login_redirect=${encodeURIComponent(
      `/oauth-authorize?client_id=mcode-public&user_code=${userCode}`,
    )}`,
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function deviceAuth(userCode = CODE): MinimaxDeviceAuthorization {
  return {
    deviceCode: 'd'.repeat(43),
    codeVerifier: 'v',
    userCode,
    verificationUri: `${HOST}/oauth-authorize`,
    verificationUriComplete: `${HOST}/oauth-authorize?user_code=${userCode}`,
    expiresInSec: 300,
    intervalSec: 3,
  }
}

describe('① resolveMinimaxForcedLoginUrl：白名单判据（不是「看起来像」）', () => {
  it('接受上游真机形态，并把 login_redirect 重编码成自己的干净参数', () => {
    const out = resolveMinimaxForcedLoginUrl(loginRequiredBody().login_url, SITE, CODE)
    expect(out).toBeDefined()
    const url = new URL(out as string)
    expect(url.origin).toBe(HOST)
    expect(url.pathname).toBe('/unified-login')
    const redirect = url.searchParams.get('login_redirect')
    expect(redirect, '必须带 login_redirect，否则登录完回不到授权页').not.toBeNull()
    const back = new URL(redirect as string, HOST)
    expect(back.pathname).toBe('/oauth-authorize')
    expect(back.searchParams.get('user_code')).toBe(CODE)
  })

  it('⚠️ 跨站 login_url 一律拒绝（防开放重定向）', () => {
    expect(resolveMinimaxForcedLoginUrl(
      'https://evil.example/unified-login?login_redirect=/oauth-authorize',
      SITE,
      CODE,
    )).toBeUndefined()
  })

  it('⚠️ login_redirect 指向外站 ⇒ 拒绝', () => {
    const bad = `/unified-login?login_redirect=${encodeURIComponent(
      'https://evil.example/oauth-authorize?user_code=' + CODE,
    )}`
    expect(resolveMinimaxForcedLoginUrl(bad, SITE, CODE)).toBeUndefined()
  })

  it('⚠️ login_redirect 的 user_code 与本次不一致 ⇒ 拒绝（防串到别人的授权）', () => {
    expect(resolveMinimaxForcedLoginUrl(loginRequiredBody('OTHER-CODE').login_url, SITE, CODE))
      .toBeUndefined()
  })

  it('⚠️ 路径不是 /unified-login ⇒ 拒绝', () => {
    const bad = `/somewhere-else?login_redirect=${encodeURIComponent(
      `/oauth-authorize?user_code=${CODE}`,
    )}`
    expect(resolveMinimaxForcedLoginUrl(bad, SITE, CODE)).toBeUndefined()
  })

  it('缺字段 / 空串 / 非字符串 ⇒ undefined（不抛错）', () => {
    expect(resolveMinimaxForcedLoginUrl(undefined, SITE, CODE)).toBeUndefined()
    expect(resolveMinimaxForcedLoginUrl('', SITE, CODE)).toBeUndefined()
    expect(resolveMinimaxForcedLoginUrl('', SITE, CODE)).toBeUndefined()
    expect(resolveMinimaxForcedLoginUrl(42, SITE, CODE)).toBeUndefined()
  })
})

describe('② fetchMinimaxForcedLoginUrl：任何失败都退回本地兜底', () => {
  it('正常路径：服务端 401 + login_url ⇒ 用服务端那份（已过白名单）', async () => {
    const fetcher = (async () => json(loginRequiredBody(), 401)) as unknown as typeof fetch
    const out = await fetchMinimaxForcedLoginUrl(deviceAuth(), fetcher, MINIMAX)
    expect(out).toContain('/unified-login')
    expect(new URL(out as string).origin).toBe(HOST)
  })

  it('⚠️ 请求抛错（网络/超时）⇒ 退回本地兜底，**不抛**', async () => {
    const fetcher = (async () => { throw new Error('boom') }) as unknown as typeof fetch
    const out = await fetchMinimaxForcedLoginUrl(deviceAuth(), fetcher, MINIMAX)
    expect(out).toBe(buildMinimaxForcedLoginUrl(SITE, CODE))
  })

  it('⚠️ 服务端回的是恶意 login_url ⇒ 不采信，退回本地兜底', async () => {
    const fetcher = (async () => json(
      { login_url: 'https://evil.example/unified-login' },
      401,
    )) as unknown as typeof fetch
    const out = await fetchMinimaxForcedLoginUrl(deviceAuth(), fetcher, MINIMAX)
    expect(out).toBe(buildMinimaxForcedLoginUrl(SITE, CODE))
  })

  it('⚠️ 响应非 JSON（网关降级 HTML）⇒ 退回本地兜底', async () => {
    const fetcher = (async () => new Response('<html>oops</html>', { status: 502 })) as unknown as typeof fetch
    const out = await fetchMinimaxForcedLoginUrl(deviceAuth(), fetcher, MINIMAX)
    expect(out).toBe(buildMinimaxForcedLoginUrl(SITE, CODE))
  })

  it('★ 请求**不带凭据**（回归守卫：本仓库有过「诊断请求烧掉 refresh_token」的事故）', async () => {
    let seen: RequestInit | undefined
    const fetcher = (async (_url: unknown, init: RequestInit) => {
      seen = init
      return json(loginRequiredBody(), 401)
    }) as unknown as typeof fetch
    await fetchMinimaxForcedLoginUrl(deviceAuth(), fetcher, MINIMAX)
    const headers = (seen?.headers ?? {}) as Record<string, string>
    expect(
      Object.keys(headers).some((k) => k.toLowerCase() === 'authorization'),
      '探测请求绝不能带 Authorization —— 它不该触碰任何凭据',
    ).toBe(false)
  })
})

describe('③ startLogin 把 forcedLoginUrl 带出来（可选字段）', () => {

  it.skipIf(!cordisAvailable)('★ 拿得到时必须填（客户端靠它绕开旧会话）', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { MinimaxAuth } = await import('../../src/minimax-auth.js')
    const ctx = new Context() as never as { provide: (n: string, v: unknown) => void }
    ctx.provide('credentials', { resolve: async () => undefined, set: async () => {} })

    const fetcher = (async (url: unknown) => {
      const u = String(url)
      if (u.includes('/oauth2/device/code')) {
        return json({
          device_code: 'd'.repeat(43),
          user_code: CODE,
          verification_uri: `${HOST}/oauth-authorize`,
          verification_uri_complete: `${HOST}/oauth-authorize?user_code=${CODE}`,
          expires_in: 300,
          interval: 3,
        }, 200)
      }
      if (u.includes('/oauth2/device/authorize')) return json(loginRequiredBody(), 401)
      return json({ status: 'denied' }, 200)
    }) as unknown as typeof fetch

    const auth = new MinimaxAuth(ctx as never, { fetchImpl: fetcher, sleep: async () => {} })
    const flow = await auth.startLogin()
    expect(flow.loginUrl).toContain('/oauth-authorize')
    expect(
      flow.forcedLoginUrl,
      '★ 没带出 forcedLoginUrl ⇒ 客户端只能用带旧会话的链接（本 bug 原样复发）',
    ).toContain('/unified-login')
    flow.close()
    await flow.result.catch(() => {})
  })

  /**
   * ⚠️ 接线断言的**纯文本替代**：即使 cordis 装不上，也要保证
   * `startLogin` 真的把该字段放进返回值（否则 RPC 层拿到的永远是 undefined）。
   */
  it('★ startLogin 源码里必须把 forcedLoginUrl 放进返回值（不依赖 cordis 也能查）', () => {
    const authSource = readFileSync(resolve(here, '../../src/minimax-auth.ts'), 'utf8')
    expect(authSource, 'startLogin 没调用强制登录链接的解析').toContain('fetchMinimaxForcedLoginUrl(')
    expect(
      authSource.includes('forcedLoginUrl,') || authSource.includes('forcedLoginUrl }'),
      'startLogin 的返回值里没有 forcedLoginUrl ⇒ RPC 层恒拿不到',
    ).toBe(true)
  })
})

describe('④b 方案 A：先登出、再打开授权页（2026-10-24 用户决策）', () => {
  it('★ 宿主必须下发 logoutUrl（否则客户端只能靠 forcedLoginUrl，旧会话仍在）', () => {
    // ⚠️ 只在**返回值**里找：`logoutUrl` 这个标识符在分支里还有定义处，
    //    全局查会让「定义在、但没下发」也通过（假绿）。
    const branch = minimaxBranch()
    const ret = branch.slice(branch.lastIndexOf('return {'))
    expect(ret, '返回值里没有 logoutUrl ⇒ 「登录完仍带上个账号」复发').toContain('logoutUrl')
    // 地址必须由 accountHost 派生（两站各用各的域，不能写死 .cn）
    expect(branch, '登出地址必须由 accountHost + MINIMAX_WEB_LOGOUT_PATH 拼出')
      .toContain('MINIMAX_WEB_LOGOUT_PATH')
    expect(branch).toMatch(/\$\{minimaxProduct\.accountHost\}\$\{MINIMAX_WEB_LOGOUT_PATH\}/)
  })

  it('★★ 没有 forcedLoginUrl 时**不得**给 logoutUrl（登出后无处可去更糟）', () => {
    const branch = minimaxBranch()
    const ret = branch.slice(branch.lastIndexOf('return {'))
    // 取「最后一个 spread 三元」——它必须把 logoutUrl 收在「拿到了 forcedLoginUrl」的分支里。
    const spreads = [...ret.matchAll(/forcedLoginUrl === undefined\s*\?\s*\{\}\s*:\s*\{\s*([^}]*)\}/g)]
    const withLogout = spreads.filter((m) => m[1].includes('logoutUrl'))
    expect(
      withLogout.length,
      'logoutUrl 必须与 forcedLoginUrl 同条件下发：否则登出后用户停在空白登录页',
    ).toBeGreaterThan(0)
  })

  it('★★ 客户端必须先开登出、再开授权页（顺序反了等于没登出）', () => {
    const i = clientSource.indexOf('const logoutUrl = typeof res.logoutUrl')
    expect(i, '客户端没读 res.logoutUrl ⇒ 服务端下发了也不生效').toBeGreaterThan(-1)
    const seg = clientSource.slice(i, i + 2600)
    const logoutAt = seg.indexOf('window.open(logoutUrl')
    const forcedAt = seg.indexOf('window.open(forcedLoginUrl')
    expect(logoutAt, '没有打开登出地址').toBeGreaterThan(-1)
    expect(forcedAt, '没有打开强制登录地址').toBeGreaterThan(-1)
    expect(logoutAt, '★ 登出必须在授权页**之前**').toBeLessThan(forcedAt)
  })

  it('★★ 登出前必须弹确认（它会连带登出用户的 MiniMax 网页版，不得静默）', () => {
    const i = clientSource.indexOf('const logoutUrl = typeof res.logoutUrl')
    const seg = clientSource.slice(i, i + 2600)
    expect(seg, '★ 静默登出会连带清掉用户网页版会话 —— 必须 confirm 告知')
      .toContain('confirm(')
    expect(seg, '文案必须说明会退出网页登录').toMatch(/退出\s*MiniMax\s*网页登录/)
  })

  it('⚠️ 登出必须用**导航**而不是 fetch（要真实写入 Set-Cookie）', () => {
    const i = clientSource.indexOf('const logoutUrl = typeof res.logoutUrl')
    const seg = clientSource.slice(i, i + 2600)
    expect(seg, '登出用了 fetch ⇒ HttpOnly cookie 未必被清除').not.toMatch(/fetch\(\s*logoutUrl/)
  })
})

describe('④ 接线：RPC 分支的无痕窗口用 forcedLoginUrl，客户端优先用它', () => {

  /**
   * ⚠️⚠️ **2026-10-24 用户决策：宿主开窗那一套废弃**，只要 token 过期这件工作。
   *
   * 为什么（本轮真实事故）：「宿主能开窗」≠「用户能看见窗口」。本机无头
   * （只有 Xvfb `:99`，用户经隧道用自己的浏览器访问）⇒ 宿主开窗返回
   * `incognitoOpened: true` ⇒ 客户端照契约跳过 `window.open` ⇒ 窗口画在没人
   * 看的屏上 ⇒ 用户报「点击新增账号不会跳转登录页了」。
   */
  it('★★ minimax 分支**不得**再调 openIncognitoWindow（宿主认领开窗已废弃）', () => {
    expect(
      minimaxBranch(),
      '★ 又调了 openIncognitoWindow ⇒ 无头宿主会返回 incognitoOpened:true，'
      + '客户端于是不再 window.open ⇒ 「点击新增账号不跳转」原样复发',
    ).not.toContain('openIncognitoWindow(')
  })

  it('★★ 返回值里**不得**含 incognitoOpened（否则客户端会跳过自己的 window.open）', () => {
    // ⚠️ 只查本分支尾部那个 `return { … }`（分支体截到下一个 provider 头，
    //    里面会包含**别的 provider** 的 incognitoOpened —— 全局查会假红）。
    const branch = minimaxBranch()
    // ⚠️ 源码经格式化后是 `return {\n  ok: true,`（多行），不能按单行字面量找。
    const ret = branch.slice(branch.lastIndexOf('return {'))
    expect(ret, '返回值里带了 incognitoOpened').not.toContain('incognitoOpened')
    expect(ret, '返回值里必须带 forcedLoginUrl').toContain('forcedLoginUrl')
  })

  it('★ 必须回传 forcedLoginUrl（换号能力落在这里，不落宿主开窗）', () => {
    expect(minimaxBranch()).toContain('forcedLoginUrl: minimaxStarted.forcedLoginUrl')
  })

  it('★ incognitoOpened === true 时必须先问用户（不得无条件再开，也不得一律不开）', () => {
    /**
     * 2026-10-25 合并审计改成「先确认」：无条件再开会把 codearts/officeace 的
     * 「新建账号还是同一个号」静默放回来（普通浏览器里有华为云 SSO 会话）；
     * 而一律不开又会让无头部署的用户看不到窗口（2026-10-24 的真实报障）。
     * 两条诉求只能由用户裁决 ⇒ 必须问，并按答案分流。
     *
     * ⚠️ 行为级判据在 `jet-hub-panel-wiring.spec.ts`（真渲染 + 真调 onClick +
     *    断言 window.open 有没有被调用）；这里只做「接线没被整体重写」的轻量哨兵。
     */
    const idx = clientSource.indexOf('res.incognitoOpened === true')
    expect(idx, '客户端的 incognitoOpened 判据不见了（被整体重写了？）').toBeGreaterThan(-1)
    const after = clientSource.slice(idx, idx + 4000)
    // ① 必须真的问用户（不是只打一行日志）
    expect(after, '宿主说「我开了」时没有征求用户意见 ⇒ 静默再开（老缺陷复发）或静默不开（无头看不到窗口）')
      .toContain('window.confirm(')
    // ② 必须有分流闸门，且开窗不在 incognito 分支内无条件执行
    expect(after, '缺少「用户拒绝就不再开」的闸门').toContain('skipClientOpen')
    expect(clientSource, '开窗没有被闸门包住 ⇒ 闸门是死代码').toContain('if (!skipClientOpen)')
  })

  it('★ 客户端必须优先用 res.forcedLoginUrl，且判据是精确的 string 非空', () => {
    expect(clientSource, '客户端没读 forcedLoginUrl ⇒ 服务端修了也不生效').toContain('res.forcedLoginUrl')
    expect(clientSource, "判据必须是 typeof === 'string'（老宿主 undefined 要退回 loginUrl）")
      .toContain("typeof res.forcedLoginUrl === 'string'")
  })

  it('★ 有 forcedLoginUrl 时窗口打开的是它（否则又带旧会话）', () => {
    expect(clientSource).toContain("window.open(forcedLoginUrl, '_blank'")
  })

  it('★★ 无 forcedLoginUrl 时**原样保留** loginUrl 回退（其余 12 家 provider 的唯一通路）', () => {
    // ⚠️ 这两条字面量是既有守卫的锚点（codearts-incognito-login ④ /
    //    login-link-copy），不能替换 —— 本轮实测过一次变红。
    expect(clientSource, '★ window.open(loginUrl …) 是其余 provider 的唯一通路，不得删').toContain(
      "openAccountLoginWindow({ provider, accountId, loginUrl, rpcCall, isolatedLoginCall,",
    )
    expect(clientSource, '★ setLoginUrlForManual(loginUrl) 是弹窗被拦时的手动兜底').toContain(
      'setLoginUrlForManual(loginUrl)',
    )
  })

  it('★ 手动兜底链接在 forced 分支里也要用 forcedLoginUrl（否则手动点又绕回旧会话）', () => {
    expect(clientSource).toContain('setLoginUrlForManual(forcedLoginUrl)')
  })
})
