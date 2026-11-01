import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 插件详情页槽位的**接线守卫**（`index.js` / `package.json` / `build.mjs`）。
 *
 * ⚠️ 这三处是「单测查不出、真机才炸」的典型：`plugins.bundle.config` 的 key
 * 不匹配时宿主**整段不渲染且无任何报错**；`dsh.client.inject` 少声明一个包会让
 * 本 bundle 先于它到达、`inject` 永远等不到服务；`external` 漏一项会把整个
 * UI 库打进产物再与平台模块表冲突。
 *
 * 断言形态是源码文本 / JSON 读取（本仓库对构建配置的守卫一贯如此，
 * 见 `client-registration-id.spec.ts`）。
 */

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const indexSource = read('plugin-src/client/index.js')
const buildSource = read('plugin-src/client/build.mjs')
const pkg = JSON.parse(read('package.json')) as {
  name: string
  dsh: { client: { inject: string[], external?: string[] } }
}

describe('插件详情页槽位接线', () => {
  it('⚠️ 注册 plugins.bundle.config，且 key 逐字等于包名（不匹配 = 静默不渲染）', () => {
    expect(indexSource).toContain("'plugins.bundle.config'")
    expect(indexSource).toContain(`key: '${pkg.name}'`)
  })

  it('卡片通过 inject 拿 rpcCall（与 settings.section 同构）', () => {
    expect(indexSource).toMatch(/JetHubPanelEntryCard/)
    expect(indexSource).toContain('inject: () => ({ rpcCall })')
  })

  it('⚠️ 注册选项里**确实带了 key**（不只是源码某处出现这串字，复核 M2）', () => {
    const start = indexSource.indexOf("ctx.slots.inject('plugins.bundle.config'")
    expect(start).toBeGreaterThan(-1)
    const block = indexSource.slice(start, indexSource.indexOf('}, JetHubPanelEntryCard)', start))
    expect(block, 'bundle.config 注册块里没有 key 选项').toMatch(/key:\s*'[^']+'/)
    expect(block).toContain(`key: '${pkg.name}'`)
    // 槽位名也必须逐字出现在同一个注册块里。
    expect(block).toContain("name: 'plugins.bundle.config'")
  })

  it('⚠️ settings.section 不再在 apply 里无条件注册（改由注册器按枚举增删）', () => {
    expect(indexSource).not.toMatch(/ctx\.slots\.inject\('settings\.section'/)
  })

  it('⚠️ dsh.client.inject 必须声明 plugin-manager，否则本 bundle 可能先到 → 卡片永不出现', () => {
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-plugin-manager')
  })

  it('⚠️ ui-primitives 必须 external（平台模块，不得打进 bundle）', () => {
    expect(buildSource).toMatch(/external:\s*\[[^\]]*'@deepseek-ai\/dsh-client-ui-primitives'/)
  })

  it('⚠️ 平台模块不得写进 dsh.client.external（那是基座之外才用的）', () => {
    // `packages/client/AGENTS.md`：PLATFORM_MODULES 是隐式 external 基座，
    // 重复声明会造成「同一模块有两个提供方」。
    expect(pkg.dsh.client.external ?? []).not.toContain('@deepseek-ai/dsh-client-ui-primitives')
  })
})

/**
 * ⚠️ **跨语言对拍**（2026-10-24 复核 M7）：合法取值在宿主是 TS、在客户端是 JS，
 * 跨语言无法 import，所以是**两份字面量**。将来加第三项时漏改一侧的后果是
 * 「客户端把合法值当非法」——读取被丢弃、写入被宿主以 `bad-request` 拒。
 * 本仓库对这类「两份真源」一贯用源码文本对拍（见 `client-registration-id.spec.ts`）。
 */
describe('PanelEntry 合法取值：宿主与客户端必须逐字一致', () => {
  /**
   * 去掉行注释（`//` 到行尾）与块注释（`/* … *\/`），**再**做锚点查找。
   *
   * ⚠️⚠️ 必须剥注释（2026-10-24 审计 M3）：原实现用 `text.indexOf(anchor)`，
   * 而 `indexOf` **认注释**。实测：把 `VALID_ENTRIES` 真改成 `['sidebar']`，
   * 同时在上一行写 `// 说明：const VALID_ENTRIES = ['sidebar', 'settings'];`
   * ⇒ 跨语言对拍那条**全绿**（`indexOf` 命中的是注释那一行，抽出的仍是
   * 两个正确值）。注释诱饵在本 PR 里三处全中，这是其中一处。
   */
  const stripComments = (text: string): string => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  /**
   * 从源码文本里抽出「同一行内、锚点之后」那个数组字面量的字符串元素。
   *
   * ⚠️ 只截到**行尾**：宿主的声明是
   * `export const PANEL_ENTRY_VALUES: readonly PanelEntry[] = ['sidebar', 'settings']`
   * —— 类型注解里的 `[]` 会让「找第一个 `[`」提前闭合（实测假红）。
   */
  const entriesOf = (text: string, anchor: string): string[] => {
    const stripped = stripComments(text)
    const at = stripped.indexOf(anchor)
    expect(at, `找不到锚点 ${anchor}`).toBeGreaterThan(-1)
    // ⚠️ 自证：剥注释后锚点必须**只出现一次**。出现多次说明有第二个同形声明
    //    （或剥注释逻辑失效），此时 indexOf 会静默取第一个 —— 那正是 M3 的形态。
    const hits = stripped.split(anchor).length - 1
    expect(hits, `锚点 ${anchor} 在剥注释后的源码里出现 ${hits} 次（必须恰好 1 次）`).toBe(1)
    const lineEnd = stripped.indexOf('\n', at)
    const line = stripped.slice(at, lineEnd === -1 ? stripped.length : lineEnd)
    const open = line.indexOf('= [')
    expect(open, `锚点 ${anchor} 所在行找不到 "= ["`).toBeGreaterThan(-1)
    return [...line.slice(open).matchAll(/'([^']+)'/g)].map((m) => m[1])
  }

  it('宿主的 PANEL_ENTRY_VALUES 与客户端的 VALID_ENTRIES 完全相同', () => {
    const host = entriesOf(read('src/jet-hub-store.ts'), 'PANEL_ENTRY_VALUES: readonly')
    const client = entriesOf(read('plugin-src/client/panel-entry-store.js'), 'VALID_ENTRIES =')

    expect(host.length, '宿主枚举为空，抽词失败').toBeGreaterThan(0)
    expect(client).toEqual(host)
  })

  it('宿主默认值是枚举之一', () => {
    const host = entriesOf(read('src/jet-hub-store.ts'), 'PANEL_ENTRY_VALUES: readonly')
    // ⚠️ 默认值是**标量**声明（`export const DEFAULT_PANEL_ENTRY: PanelEntry = 'sidebar'`），
    //    不是数组，所以单独抽。
    const at = read('src/jet-hub-store.ts').indexOf('DEFAULT_PANEL_ENTRY: PanelEntry =')
    expect(at, '找不到 DEFAULT_PANEL_ENTRY 声明').toBeGreaterThan(-1)
    const line = read('src/jet-hub-store.ts').slice(at, read('src/jet-hub-store.ts').indexOf('\n', at))
    const value = /'([^']+)'/.exec(line)?.[1]
    expect(value, 'DEFAULT_PANEL_ENTRY 不是字符串字面量').toBeDefined()
    expect(host, `默认值 ${value} 不在枚举里`).toContain(value)
  })
})

describe('页头开关的下线', () => {
  const pageSource = read('plugin-src/client/jet-hub.js')

  it('⚠️ 页头「侧栏」开关已删除，下拉成为唯一入口', () => {
    expect(pageSource).not.toContain('toggleSidebarEntry')
    expect(pageSource).not.toContain('sidebarEntryOn')
    expect(pageSource).not.toContain('sidebar-entry-store.js')
  })

  it('⚠️ 「渠道原生搜索」开关必须原样保留', () => {
    expect(pageSource).toContain('渠道原生搜索')
    expect(pageSource).toContain('toggleNativeSearch')
  })
})
