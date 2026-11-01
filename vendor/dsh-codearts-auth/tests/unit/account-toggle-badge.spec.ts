import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../helpers/strip-comments.js'

/**
 * 「启用 / 停用」开关的入口位置。
 *
 * 用户 2026-10-26 要求：「将停用按钮功能合并到右上角的已启用，
 * 点击后账号已启用/停用切换」。
 *
 * 这个改动的**两个失败方向都是真缺陷**，所以两边都要钉住：
 *  - 删漏了底部按钮 ⇒ 同一个动作有两个入口，且按钮离状态显示很远，
 *    用户点完还得回头找徽章确认结果；
 *  - 删多了 / 徽章没接上点击 ⇒ 账号**再也停用不了**，只能删号重建
 *    （而删号会丢昵称、指纹代次与全部历史标记）。
 *
 * 组件无法在本仓库单测里渲染（react 不在依赖内），故只能做源码文本断言。
 */

function hubSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // ⚠️ 本仓库源码在 Windows 上是 CRLF，多行比对前必须归一化。
  return readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
    .replace(/\r\n/g, '\n')
}

/**
 * 剥注释后再断言。
 *
 * ⚠️ 必须剥：本次改动的注释里写着被删按钮的**旧文案**（「讲历史」），
 * 不剥的话「不再有停用按钮」那条会被自己的注释喂成假红。
 */
function hubCode(): string {
  return stripComments(hubSource())
}

/**
 * 切出状态徽章那一个元素表达式。
 *
 * ⚠️ 不用 `indexOf('dim-jh-accountTag')` 取首个：同一文件里还有「限额中」
 *    标记也用这个类名（它是静态的，不该被改）。这里以徽章**独有**的
 *    结尾文案反查起点，无论以后前面插多少个同类元素都不会切错。
 */
function badgeExpr(hub: string): string {
  const endMark = "'已启用' : '已停用')"
  const end = hub.indexOf(endMark)
  expect(end, '未定位到状态徽章（找不到「已启用/已停用」结尾）').toBeGreaterThan(-1)
  const at = hub.lastIndexOf('dim-jh-accountTag', end)
  expect(at, '未定位到状态徽章的类名').toBeGreaterThan(-1)
  return hub.slice(at, end + endMark.length)
}

describe('账号状态徽章兼作启停开关', () => {
  it('底部按钮行里**不再**有「停用 / 启用」按钮（不能留两个入口）', () => {
    // 旧形态：}, account.enabled ? '停用' : '启用'),
    expect(hubCode()).not.toMatch(/\}, account\.enabled \? '停用' : '启用'\)/)
  })

  it('徽章接了 onClick，且复用既有的 onToggle（不另写一套切换逻辑）', () => {
    const badge = badgeExpr(hubCode())
    expect(badge, '徽章必须能点').toContain('onClick:')
    expect(badge, '必须调用既有的 onToggle(account.id, !account.enabled)')
      .toMatch(/onToggle\(account\.id, !account\.enabled\)/)

    /**
     * ⚠️⚠️ **`onClick` 的值不得是死分支**（2026-10-27 对抗审计 P1-1，实测有牙缺口）。
     *
     * 原判据只有 `toContain('onClick:')` + 正则匹配 `onToggle(...)` —— 两者都能被
     * **同一个字面量**满足，即使那个调用被包进恒不执行的分支里：
     *
     * ```js
     * onClick: () => { if (false) { onToggle(account.id, !account.enabled) } }
     * ```
     *
     * 实测：注入上面这行后本文件 **6 passed 全绿**，而账号的鼠标/键盘启停**双双失效**。
     * 这是本仓库的头号复发形态（`if (false)` 短路禁用），且风险**不对称** ——
     * 底部「停用/启用」按钮已被本 PR 删除 ⇒ 一旦这段失效，**账号再也停用不了**
     * （只能删号重建，丢昵称/指纹代次/历史标记），而用户侧**无报错、无白屏**。
     *
     * ⇒ 这里补三条「死分支」判据。它们不是完备的（真正的行为级判据需要多轮渲染
     * 夹具），但能挡住**恒假条件**这一类，成本极低。
     */
    const handler = badge.slice(badge.indexOf('onClick:'))
    expect(
      handler,
      'onClick 里出现恒假条件（if (false) / if (0) …）⇒ 徽章点了没反应，账号无法启停',
    ).not.toMatch(/\bif\s*\(\s*(?:false|0|null|undefined|!\s*1|!\s*true)\s*\)/)
    expect(
      handler,
      'onClick 被 `假值 && …` 短路 ⇒ 徽章点了没反应',
    ).not.toMatch(/(?:^|[\s(])(?:false|null|undefined|0)\s*&&/)
    expect(
      handler,
      'onClick 被 `假值 ? … : …` 短路 ⇒ 徽章点了没反应',
    ).not.toMatch(/(?:^|[\s(])(?:false|null|undefined|0)\s*\?/)
  })

  it('徽章是键盘可达的（role + tabIndex + Enter/空格 + 拦下空格滚动）', () => {
    const badge = badgeExpr(hubCode())
    expect(badge, '原本那个真 button 是可达的，换成 span 不能倒退').toContain("role: 'button'")
    expect(badge).toContain('tabIndex: 0')
    expect(badge, '必须处理 Enter 与空格').toMatch(/event\.key !== 'Enter' && event\.key !== ' '/)
    expect(badge, '空格键默认会滚动页面，必须 preventDefault')
      .toContain('event.preventDefault()')
  })

  it('title 同时说清「当前状态」与「点了会怎样」', () => {
    const badge = badgeExpr(hubCode())
    // ⚠️ 徽章的文字本身是**状态**（「已启用」），不像原按钮的「停用」自带动作
    //    语义 ⇒ 不写清楚点击后果，用户根本不知道它能点。
    expect(badge, 'tooltip 必须点出「点击…该账号」')
      .toMatch(/点击\$\{account\.enabled \? '停用' : '启用'\}该账号/)
    // 资源包列表 tooltip 不能被顶掉（同账号名那处也挂着同一个 accountTitle）。
    expect(badge, '必须保留 accountTitle（资源包列表）').toContain('accountTitle')
  })

  it('徽章带 data-clickable，且样式里给了指针与焦点圈', () => {
    const badge = badgeExpr(hubCode())
    expect(badge).toContain("'data-clickable': 'true'")

    const here = dirname(fileURLToPath(import.meta.url))
    const styles = readFileSync(resolve(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')
    expect(styles, '可点徽章必须给 cursor: pointer（否则完全看不出能点）')
      .toMatch(/\.dim-jh-accountTag\[data-clickable="true"\]\s*\{[^}]*cursor:\s*pointer/)
    expect(styles, '键盘焦点圈必须有，否则「可达」是骗人的')
      .toMatch(/\.dim-jh-accountTag\[data-clickable="true"\]:focus-visible\s*\{[^}]*outline:/)
  })

  it('可点徽章有 1px 边框（用户反馈「不明显」），且 padding 抵掉边框占位', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const styles = readFileSync(resolve(here, '../../plugin-src/client/jet-hub-styles.js'), 'utf8')

    // ⚠️ 两个 tone 都要给边框色：只给一态，另一态看起来仍是纯标签。
    expect(styles, '已启用态要有边框色')
      .toMatch(/\.dim-jh-accountTag\[data-clickable="true"\]\[data-tone="on"\]\s*\{[^}]*border-color:/)
    expect(styles, '已停用态要有边框色')
      .toMatch(/\.dim-jh-accountTag\[data-clickable="true"\]\[data-tone="off"\]\s*\{[^}]*border-color:/)

    // ⚠️ 基准规则必须有 transparent 兜底 + padding 补偿：
    //    加 1px 边框会长高 2px，不减 padding 就比旁边的静态标签（如「限额中」）
    //    高，而同一行里两枚标签不等高非常显眼。
    const base = /\.dim-jh-accountTag\[data-clickable="true"\]\s*\{([^}]*)\}/.exec(styles)
    expect(base, '未找到可点徽章的基准规则').not.toBeNull()
    expect(base![1], '基准规则要有 transparent 边框兜底（否则未上色的 tone 会矮 2px）')
      .toMatch(/border:\s*1px solid transparent/)
    expect(base![1], 'padding 必须减掉边框占位，保持与静态标签等高')
      .toMatch(/padding:\s*0 7px/)
  })
})
