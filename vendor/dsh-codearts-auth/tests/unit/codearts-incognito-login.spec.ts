/**
 * `codearts-incognito-login.spec.ts` —— CodeArts **换账号登录**（无痕窗口）守卫。
 *
 * ## 这个文件为什么存在（2026-10-21 用户报障）
 *
 * > 「在华为云环境中，点击“新建账号”后出现缓存上一个账号登录信息并自动登录」
 *
 * 与 OfficeAce 2026-10-13 的报障**完全同型**：CodeArts 的授权页也在华为云 SSO 域
 * （新式 IAM OAuth = `codearts.huaweicloud.com/portal/authorize`，老 ticket 流程 =
 * `auth.huaweicloud.com/authui/login.html`），华为 authui 会**静默复用**浏览器
 * 已有会话 —— 客户端 `window.open` 带着上一账号的 cookie 打开授权页直接放行，
 * 看不到登录框 ⇒「新建账号」永远只能建出同一个号。
 *
 * ## 修复契约（本文件锁的就是这几格）
 *
 * 1. **宿主接线**：`account.create` 的 codearts 分支必须调用
 *    `openIncognitoWindow(started.loginUrl)`，并把结果回传 `incognitoOpened`；
 * 2. **客户端分流**：判据仍是 `res.incognitoOpened === true`（精确匹配，
 *    `undefined` 必须走回退 —— 升级期安全阀，见 officeace 同款守卫 ⑦）；
 * 3. **前提锚点**：CodeArts 授权 URL 确属华为域 —— 若哪天换了授权域，
 *    「无痕是正解」的前提要重审（也许新域根本不复用会话）。
 *
 * ## 涉及的缓存 / 状态范围与「清除」语义
 *
 * 授权页会话的全部载体（cookie、localStorage、sessionStorage、HTTP cache）
 * 都活在浏览器的 **cookie jar（profile 目录）**里 ⇒ 独立 `--user-data-dir` +
 * `--incognito` 的全新 profile 让它们**天生为空**（不是「事后删」，是「从未有过」）。
 * 刻意**不清**账号池凭据（已登录账号照常用）、**不走** `authui/logout`
 *（会连带登出用户日常浏览器的华为云控制台）—— 取舍依据见 `src/login.ts`
 * `openIncognitoWindow` 注释（真机三次对照，Gitee issue IKM741）。
 *
 * ⚠️⚠️ 本文件是「只做源码级断言」的（2026-10-13 用户明确要求：「打开浏览器
 * 窗口的测试只能放在 e2e 测试里」）⇒ **不得** import 会开窗的模块（officeace
 * 同款守卫 ⑪ 会抓单测目录里的 `login.js` import）。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const rpcSource = readFileSync(resolve(here, '../../src/jet-hub-rpc.ts'), 'utf8')
const clientSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
const loginSource = readFileSync(resolve(here, '../../src/login.ts'), 'utf8')

/** 截取 `account.create` 里 codearts 分支的源码片段（从分支头到其 return）。 */
function codeartsBranch(): string {
  const start = rpcSource.indexOf("} else if (provider === 'codearts') {")
  expect(start, 'jet-hub-rpc.ts 里找不到 codearts 分支（被改名/移动了？）').toBeGreaterThan(-1)
  const end = rpcSource.indexOf("} else if (provider ===", start + 10)
  return rpcSource.slice(start, end > start ? end : undefined)
}

describe('CodeArts 新建账号：宿主无痕窗口接线', () => {
  it('① codearts 分支必须调用 openIncognitoWindow(started.loginUrl)', () => {
    const branch = codeartsBranch()
    expect(
      branch,
      'codearts 分支未调用 openIncognitoWindow ⇒ 客户端 window.open 带旧 cookie '
      + '打开授权页 ⇒ 华为 SSO 静默放行 ⇒「新建账号」永远建出同一个号（本次报障）',
    ).toContain('openIncognitoWindow(started.loginUrl)')
  })

  it('② 必须回传 incognitoOpened（客户端据此决定是否自己开窗）', () => {
    const branch = codeartsBranch()
    expect(branch, '未回传 incognitoOpened ⇒ 客户端会照旧 window.open，'
      + '与宿主的无痕窗并存（用户看到两个登录页，且普通那个复用旧会话）')
      .toContain('incognitoOpened')
  })

  /**
   * ⚠️ **回传字段必须与 loginUrl 同源**（不是 authorizeUrl）。
   *
   * OfficeAce 分支的字段叫 `started.authorizeUrl`，CodeArts 叫 `started.loginUrl`
   * —— 两家 auth 服务的返回形状不同。照抄 OfficeAce 的字段名会 `undefined`
   * 传进 openIncognitoWindow ⇒ 无痕窗打开空白页，且 `incognitoOpened` 还可能是
   * `true`（窗口确实开了）⇒ 症状是「无痕窗里打不开登录页」，极难排查。
   */
  it('③ 传给 openIncognitoWindow 的必须是 loginUrl（CodeArts 的字段名，不是 OfficeAce 的 authorizeUrl）', () => {
    const branch = codeartsBranch()
    expect(branch, '字段名抄成 OfficeAce 的 authorizeUrl ⇒ 无痕窗打开的是 undefined（空白页）')
      .not.toContain('openIncognitoWindow(started.authorizeUrl)')
  })

  it('④ 客户端判据仍是 `=== true`（CodeArts 走的就是这条通用分流，不得为它另写特判）', () => {
    // CodeArts 复用与 OfficeAce 相同的客户端分流（见 officeace-incognito-login.spec ⑦）。
    // 这里交叉确认它没被本次改动破坏、也没被绕过。
    expect(clientSource, '客户端通用判据丢失 ⇒ 无痕窗与普通窗并存或都不出现')
      .toContain('res.incognitoOpened === true')
    expect(clientSource, '回退 window.open 被删 ⇒ 其余 provider 无法登录')
      .toContain("openAccountLoginWindow({ provider, accountId, loginUrl, rpcCall, isolatedLoginCall,")
  })

  /**
   * ⚠️ **前提锚点**：本修复的成立前提是「CodeArts 授权页在华为云 SSO 域、
   * 会复用浏览器会话」。把授权域钉在源码里 —— 哪天有人换了授权域，
   * 这条会红并提醒重新审视前提（也许新域自带会话隔离，无痕就只是冗余而非必需）。
   */
  it('⑤ 前提锚点：CodeArts 授权 URL 确属华为域（无痕是「必需」而非「装饰」的前提）', () => {
    expect(loginSource, '新式 IAM OAuth 的授权域变了 ⇒ 重审「华为 SSO 复用会话」前提')
      .toContain("PORTAL_AUTHORIZE_BASE = 'https://codearts.huaweicloud.com/portal/authorize'")
    expect(loginSource, '老 ticket 流程的 authui 域变了 ⇒ 同上')
      .toContain("HUAWEI_AUTH_BASE = 'https://auth.huaweicloud.com/authui/login.html'")
  })

  /**
   * ⚠️ **元守卫**：无痕机制本体（`--incognito` / 独立 `--user-data-dir` /
   * 测试断路器）由 `officeace-incognito-login.spec.ts` 锁着 —— 两家共用同一实现，
   * 那边红这边必然也该红。本条防的是「有人以为 CodeArts 另起炉灶，把共享实现
   * 改坏只影响自己」的误解。
   */
  it('⑥ 无痕机制本体由 officeace 同款守卫锁定（共享实现，不得另起炉灶）', () => {
    // 共享实现的三个关键点仍在 src/login.ts（officeace 守卫 ②③④⑩ 的锚点）。
    expect(loginSource, '--incognito 丢失 ⇒ 两家一起退回复用会话').toContain("'--incognito'")
    expect(loginSource, '独立 --user-data-dir 丢失 ⇒ 第二个窗口与第一个共享 jar').toContain('--user-data-dir')
    expect(
      loginSource,
      '测试断路器丢失 ⇒ pnpm test 会真开浏览器窗口（2026-10-13 污染事故复发）',
    ).toMatch(/NODE_ENV\s*===\s*['"]test['"]/)
  })
})
