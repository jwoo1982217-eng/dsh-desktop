import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 插件详情页设置卡片（`plugin-src/client/settings-card.js`）的源码守卫。
 *
 * ⚠️ 为什么只能做源码文本断言：该模块 import 了 `react` 与
 * `@deepseek-ai/dsh-client-ui-primitives`，两者都是 esbuild 的 `external`
 * （`node_modules` 里没有），vitest 跑不起来。本仓库对客户端模块的守卫一律如此。
 *
 * 这些断言守的是**会静默失败**的几条约定：
 * 1. 最外层必须自成 column 且 `gap: 0` —— 宿主 `detailSection` 给直接子元素
 *    `gap: 12px`，不包一层的话卡片内部间距全部被那个值接管；
 * 2. 下拉必须用官方 `Menu` 且 `portal` 开 —— 卡片在滚动列里，就地展开会被裁；
 * 3. 不得出现原生 `<select>` —— 本仓库已因 Windows/Electron 点不开而整体删除。
 */

const source = readFileSync(new URL('../../plugin-src/client/settings-card.js', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { name: string }

/** 剥掉行注释与块注释（锚点查找前必须先剥，见 optionsBody 的说明）。 */
const stripComments = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')

/**
 * 只取 `const OPTIONS = [ … ];` 这段**数组字面量**（剥注释后）。
 *
 * ⚠️⚠️ 为什么必须切窗口（2026-10-24 审计 M4）：本文件原来的三条断言全部打在
 * **整份源码**上 —— `toContain("id: 'settings'")` 之类。实测：真删掉 OPTIONS 里的
 * `settings` 项、同时在数组上方留一条写着同样字面量的注释 ⇒ **11/11 全绿**。
 * （纯删除时能红，所以它是「对删除有牙、对注释诱饵无牙」。）
 *
 * ⇒ 判据必须落在**数组字面量内部**，且先剥注释。
 */
const optionsBody = (): string => {
  const stripped = stripComments(source)
  const start = stripped.indexOf('const OPTIONS = [')
  expect(start, '找不到 const OPTIONS = [').toBeGreaterThan(-1)
  const end = stripped.indexOf('];', start)
  expect(end, '找不到 OPTIONS 的闭合 `];`').toBeGreaterThan(start)
  return stripped.slice(start, end)
}

describe('插件详情页设置卡片', () => {
  it('导出 JetHubPanelEntryCard', () => {
    expect(source).toContain('export function JetHubPanelEntryCard')
  })

  it('⚠️ 最外层容器必须 gap:0（官方 detailSection 给直接子元素 12px）', () => {
    expect(source).toContain('dim-jh-cardStack')
  })

  it('⚠️ 用官方 Menu 且必须开 portal（卡片在滚动列里，就地展开会被裁）', () => {
    expect(source).toContain("from '@deepseek-ai/dsh-client-ui-primitives'")
    expect(source).toMatch(/\bMenu\b/)
    expect(source).toMatch(/portal:\s*true/)
  })

  it('⚠️ 禁用原生 select（Windows/Electron 下点不开）', () => {
    expect(source).not.toMatch(/createElement\(\s*['"]select['"]/)
  })

  it('两个选项的字面量与设计一致（只判 OPTIONS 数组窗口）', () => {
    // ⚠️ 见 optionsBody 的长注释：打在整份源码上会被注释诱饵骗过（审计 M4）。
    const body = optionsBody()
    expect(body).toContain('仅侧栏')
    expect(body).toContain('仅设置页')
    expect(body).toContain("id: 'sidebar'")
    expect(body).toContain("id: 'settings'")
    // 计数防「同一项写两遍」也能满足 toContain。
    const ids = [...body.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1])
    expect(ids, '选项必须恰好两项且顺序为 sidebar → settings').toEqual(['sidebar', 'settings'])
  })

  it('⚠️ 两项 label 互不相同（用户要能分清）', () => {
    const labels = [...optionsBody().matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1])
    expect(labels, 'label 数量不是 2').toHaveLength(2)
    expect(new Set(labels).size, `label 有重复：${JSON.stringify(labels)}`).toBe(2)
  })

  /**
   * ⚠️⚠️ **描述三元必须同时认两个失败标记**（2026-10-24 审计 M5.1）。
   *
   * 原来只查「文件里出现过 `CARD_DESC_WRITE_FAILED`」⇒ 从三元里删掉
   * `writeFailed ? CARD_DESC_WRITE_FAILED` 那一支，常量仍在文件里（别处定义），
   * **11/11 全绿** —— 而症状正是「写失败时用户看到的是读失败文案」这个原始缺陷。
   *
   * ⇒ 判据锚定**三元本身**：它必须同时引用 `writeFailed` 与 `readFailed` 两个标记。
   */
  it('⚠️⚠️ 描述三元同时使用 writeFailed 与 readFailed 两个标记', () => {
    const stripped = stripComments(source)
    // 找到三元表达式：writeFailed ? … : readFailed ? … : …
    const at = stripped.search(/writeFailed\s*\?\s*CARD_DESC_WRITE_FAILED/)
    expect(at, '找不到 `writeFailed ? CARD_DESC_WRITE_FAILED` 这一支').toBeGreaterThan(-1)
    // 三元整体：从该处往后 200 字符内必须出现 readFailed 分支。
    const tail = stripped.slice(at, at + 220)
    expect(tail, '三元的 else 分支里没有 readFailed').toMatch(/readFailed\s*\?\s*CARD_DESC_READ_FAILED/)
    // 反向：正常态文案必须作为最后的 else 存在（否则读失败态会盖住正常态）。
    expect(tail, '三元缺少正常态文案 CARD_DESC 兜底').toContain('CARD_DESC')
  })

  it('⚠️ 写入不做乐观更新：失败要回滚到宿主的实际值', () => {
    // ⚠️ 这几条断言曾经是**恒真的**（只查 /panelEntry()/ 与 /catch/，把 setEntry
    // 改成乐观更新、把 catch 换成空壳都照样绿）—— 2026-10-24 复核 M1。
    expect(source).toContain('catch')
    // 成功路径里不得出现「先乐观改 setEntry(next)」这种形态。
    expect(source).not.toMatch(/setEntry\(next\)/)

    /**
     * ⚠️ 回滚必须落在 **catch 块内部**（审计 M5.2）。
     *
     * 原来只查 `source` 里出现过 `setEntry(currentEntry())` —— 该串在文件里
     * 另有 2 处（订阅回调、挂载读值），从 catch 里删掉它仍全绿。
     * ⇒ 切出 catch 块，断言块内有这一句。
     */
    const stripped = stripComments(source)
    const catchAt = stripped.indexOf('catch (caught)')
    expect(catchAt, '找不到 catch 块').toBeGreaterThan(-1)
    const catchBody = stripped.slice(catchAt, stripped.indexOf('\n    }', catchAt))
    expect(catchBody, 'catch 块里没有回滚到宿主实际值').toContain('setEntry(currentEntry())')
    expect(catchBody, 'catch 块里没有置写失败标记').toContain('setWriteFailed(true)')
  })

  it('⚠️ 读失败与写失败必须是两个标记、两句文案（复核 I5）', () => {
    // 共用一个标记会让**写失败**时显示「未能读取当前设置…显示的是默认值」，
    // 既不准也把用户引向错误的排查方向。
    expect(source).toContain('readFailed')
    expect(source).toContain('writeFailed')
    expect(source).toContain('CARD_DESC_READ_FAILED')
    expect(source).toContain('CARD_DESC_WRITE_FAILED')
  })

  it('⚠️ 写入回调自带重入闸门（busy 挡不住 Menu.onSelect，复核 I4）', () => {
    expect(source).toContain('busyRef')
    expect(source).toMatch(/if\s*\(\s*busyRef\.current\s*\)\s*return/)
  })

  it('卡片自己不注册槽位，也不碰包名（key 在 index.js 里）', () => {
    expect(source).not.toContain('slots.register')
    expect(source).not.toContain(pkg.name)
  })

  it('读取失败只换文案、不禁用控件（否则一次抖动就没法自救）', () => {
    expect(source).toContain('panelEntryReadFailed')
  })

  it('⚠️ 卡片挂载时自己读一次（不依赖两处槽位 inject 是否触发）', () => {
    expect(source).toContain('loadPanelEntry')
  })
})
