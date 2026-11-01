import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../helpers/strip-comments.js'

/**
 * 账号卡片的「删除」按钮：文字 → 图标。
 *
 * 用户 2026-10-26 要求：「删除按钮改为图标」。
 *
 * ⚠️ 这个改动有**两处必然的净损失**，钉子就钉在这两处 —— 它们是
 *    「文字换图标」的标准陷阱，而且都不会在肉眼自测里暴露：
 *
 *  1. **`aria-label`**：图标按钮没有文字节点，而 `svg` 又标了
 *     `aria-hidden='true'` ⇒ 不给 `aria-label` 时读屏念出来只有「按钮」，
 *     用户无从知道它会删号。原来的文字按钮**天然**有可读名（`删除`），
 *     换图标就把这个能力丢了。
 *  2. **`title`**：删除**不可逆**（`onDelete` 连带清除凭据）。文字按钮的
 *     「删除」二字自带动作语义，垃圾桶图标勉强也算自解释 —— 但「不可逆」
 *     这一层信息原按钮也没有，必须借这次补上。
 *
 * 组件无法在本仓库单测里渲染（react 不在依赖内），故只能做源码文本断言。
 */

function hubSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
    .replace(/\r\n/g, '\n')
}

/**
 * ⚠️ 必须剥注释后再断言：本次改动**在注释里大量讨论「删除」**（解释为什么
 *    补 `aria-label`、为什么 tooltip 要写「不可逆」）。直接在原文上做字面
 *    搜索会命中注释而恒绿 —— 本仓库记过这类「注释诱饵」不止一次。
 */
function hubCode(): string {
  return stripComments(hubSource())
}

/** 切出删除按钮那一段 createElement（到它的 svg 子节点为止）。 */
function deleteButtonBlock(code: string): string {
  const at = code.indexOf("'data-kind': 'danger'")
  expect(at, '找不到 data-kind = danger 的按钮，删除按钮可能被改名或挪走了').toBeGreaterThan(-1)
  // 往前退到它所属的 `React.createElement('button'`，再往后取到 svg 结束。
  const start = code.lastIndexOf("React.createElement('button'", at)
  expect(start, 'danger 按钮前面找不到 createElement 调用').toBeGreaterThan(-1)
  return code.slice(start, code.indexOf('M14 11v6', at) + 40)
}

describe('账号卡片 ·「删除」按钮改为图标', () => {
  it('文字版「删除」按钮必须已消失（不得两个形态并存）', () => {
    const code = hubCode()
    // 旧形态：`}, '删除'));` —— 三个右括号分别是 button / actionsNode 的 div。
    expect(code, '文字版删除按钮还在，说明改动只加没删')
      .not.toMatch(/\},\s*'删除'\)\)/)
  })

  it('删除按钮用图标按钮样式，且保留危险色 data-kind', () => {
    const block = deleteButtonBlock(hubCode())
    expect(block, '删除按钮必须带 dim-jh-iconBtn（否则 svg 会被当文字挤成一行）')
      .toMatch(/className: 'dim-jh-btn dim-jh-iconBtn'/)
    // ⚠️ danger 是删除按钮唯一的红色来源（样式表按 data-kind 上色）。
    expect(block, 'data-kind = danger 丢了 ⇒ 删除按钮不再是危险色')
      .toMatch(/'data-kind': 'danger'/)
    expect(block, '必须换成 svg 图标').toMatch(/React\.createElement\('svg'/)
  })

  it('★ 图标按钮必须有 aria-label（文字换成图标后，读屏就靠它）', () => {
    const block = deleteButtonBlock(hubCode())
    expect(block, '没有 aria-label ⇒ 读屏只会念出「按钮」，用户不知道这是删号')
      .toMatch(/'aria-label':\s*'[^']*删除[^']*'/)
  })

  it('★ tooltip 必须说清「不可逆」（原文字按钮也没有这条信息）', () => {
    const block = deleteButtonBlock(hubCode())
    expect(block, '删除按钮没有 title').toMatch(/\btitle:\s*'([^']*)'/)
    const title = /\btitle:\s*'([^']*)'/.exec(block)![1]!
    expect(title, 'title 必须点明这是删除动作').toMatch(/删除/)
    expect(title, 'title 必须点明不可逆 / 凭据被清除，否则用户以为只是移出列表')
      .toMatch(/不可逆|凭据/)
  })

  it('svg 必须 aria-hidden 且不可聚焦（否则读屏会念两遍、Tab 会多停一站）', () => {
    const block = deleteButtonBlock(hubCode())
    expect(block).toMatch(/'aria-hidden':\s*'true'/)
    expect(block).toMatch(/focusable:\s*'false'/)
  })

  it('仍然调用 onDelete(account.id)（换图标不得顺手改掉行为）', () => {
    const block = deleteButtonBlock(hubCode())
    expect(block, '删除回调被改掉了').toMatch(/onClick:\s*\(\)\s*=>\s*onDelete\(account\.id\)/)
  })
})
