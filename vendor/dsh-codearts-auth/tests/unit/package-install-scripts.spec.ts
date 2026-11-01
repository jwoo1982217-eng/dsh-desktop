/**
 * `package.json` 的**安装期脚本**不得依赖任何包管理器（2026-10-21 合并审计发现，阻断级）。
 *
 * ## 背景
 *
 * 本插件以 **git 依赖**方式被 DSH 安装（`dsh plugin add <git-url>` → 底层
 * `pnpm add git+…`），pnpm 会在 clone 目录里执行本包的 `prepare` 来构建 `lib/`。
 *
 * ⚠️ 而 DSH **只用 pnpm 装插件**（宿主的 plugin-manager 全程 `execa("pnpm", …)`），
 * 且 pnpm 10 起会拦截依赖的构建脚本（需在 profile 的 `pnpm-workspace.yaml` 里
 * `allowBuilds` 放行）—— 这套闸门与「`prepare` 里能不能找到 `pnpm`」是两件事。
 *
 * ## 为什么 `prepare` 必须**内联真实命令**
 *
 * 合并审计做了三档 pnpm 的**真实对照实验**（PATH 中刻意剔除 npm）：
 *
 * | pnpm | prepare 里的 `npm run build:all` | 结果 |
 * |---|---|---|
 * | 10.20.0 | `'npm' 不是内部或外部命令` | ❌ 安装失败 |
 * | 11.0.0 | `'npm' 不是内部或外部命令` | ❌ 安装失败 |
 * | 12.8.2 | pnpm **自带 npm** 注入 PATH | ✅ 成功 |
 *
 * ⇒ PR !132 把 `prepare` 从 `pnpm build:all` 改成 `npm run build:all`，
 * **并没有解决它声称要解决的问题** —— 只是把失败点从「pnpm 缺失」换成了
 * 「npm 缺失」，且**只在 pnpm ≥ 12 上有效**（而 AGENTS.md 记的恰恰是 10/11 那两代）。
 *
 * ⇒ 正确修法：`prepare` **直接内联** `tsc` / `node`（它们在 `node_modules/.bin`
 * 与 PATH 上都由**包管理器**保证存在）⇒ 不依赖任何包管理器的**名字**。
 *
 * ⚠️ 本文件是**源码级**守卫：它读 `package.json` 的 JSON，不是读文本 ——
 * 这样注释/格式都不会造成假绿。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(
  readFileSync(resolve(here, '../../package.json'), 'utf-8'),
) as { scripts: Record<string, string> }

describe('安装期脚本（prepare）不得依赖包管理器的名字', () => {
  const prepare = pkg.scripts.prepare ?? ''

  it('prepare 存在且非空', () => {
    expect(typeof prepare, 'package.json 必须有 prepare 脚本（git 依赖靠它构建 lib/）').toBe('string')
    expect(prepare.length).toBeGreaterThan(0)
  })

  it('★ prepare 不得调 pnpm / npm / yarn（那会依赖「那个包管理器在 PATH 上」）', () => {
    // ⚠️ 判据是**脚本串里出现包管理器名**，不是「有没有间接调用」——
    // 间接调用（如 `npm run build:all`）同样要求那个名字在 PATH 上。
    for (const manager of ['pnpm', 'npm', 'yarn', 'bun']) {
      expect(
        prepare.includes(manager),
        `★★ prepare 里出现了「${manager}」⇒ 安装期依赖该包管理器在 PATH 上（pnpm 10/11 上没有自带 npm ⇒ 安装直接失败）`,
      ).toBe(false)
    }
  })

  it('★ prepare 必须真的做构建（内联 tsc + 资源拷贝 + 客户端打包）', () => {
    // ⚠️ 三段都要在：少一段 ⇒ git 装出来的插件缺产物 ⇒ 启动即失败。
    expect(prepare, 'prepare 必须跑 tsc（宿主侧产物）').toContain('tsc -p tsconfig.json')
    expect(prepare, 'prepare 必须拷贝资源（assets）').toContain('node scripts/copy-assets.mjs')
    expect(prepare, 'prepare 必须打客户端 bundle（esbuild）').toContain('node plugin-src/client/build.mjs')
  })

  it('prepare 与 build:all 的构建内容一致（两条路径不得漂移）', () => {
    // ⚠️ 两条脚本各写一份构建串 ⇒ 将来只改一条 ⇒ 两条路径产出不同。
    // 判据取「三段构建命令的集合相同」而非整串相等（顺序可不同）。
    const segments = (script: string): string[] =>
      script.split('&&').map((part) => part.trim()).filter(Boolean).sort()
    expect(segments(prepare)).toEqual(segments(pkg.scripts['build:all'] ?? ''))
  })

  it('⚠️ 已知的不对称：pretest 仍用 npm（纯开发期路径，刻意保留）', () => {
    // ⚠️ `pretest` 只在**开发者**环境执行（那时包管理器必然在）⇒ 改成 npm 无害。
    // 但它与 `prepare` 的处理**不同** ⇒ 这里显式记录，避免后人以为漏改。
    // ⚠️ 反过来说：若哪天把 `pretest` 也内联，那是允许的（不是缺陷）。
    expect(pkg.scripts.pretest).toBe('npm run typecheck:tests')
  })
})
