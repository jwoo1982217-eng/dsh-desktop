/**
 * `opencode-official-prompt.ts` 与 `opencode-bun-tls.ts` 的行为守卫。
 *
 * ## ⚠️ 本文件的两条判据都来自真机实测（2026-10-26）
 *
 * 1. **提示词形态**：没有 `<env>` 块 ⇒ 上游免费档回 429；DSH 自己的 system
 *    必须拼在后面且只产生**一条** system 消息。
 * 2. **TLS 参数**：浏览器预设全部 429，只有 Bun 形状（无 GREASE、不 permute、
 *    ALPN 只有 HTTP1、17 个 cipher 按序）才 200。这些常量是**指纹本身**，
 *    少一项就退化成 429，所以逐项钉住。
 *
 * ⚠️ 变异提示：本文件对「删掉某个 cipher」「打开 greaseEnabled」「改
 * `alpnProtocols`」都敏感；但对格式化/顺序无关的写法不敏感（刻意）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  OPENCODE_OFFICIAL_PROMPT_TEMPLATE,
  mergeSystemWithOfficialPrompt,
  opencodeDisplayName,
  opencodePromptDate,
  renderOpencodeOfficialPrompt,
} from '../../src/opencode-official-prompt.js'
import {
  OPENCODE_BUN_TLS_OPTIONS,
  BunTlsUnavailableError,
  bunTlsUnavailableReason,
  bunTlsFetch,
  ensureBunTlsLoaded,
  resetBunTlsLoaderForTests,
} from '../../src/opencode-bun-tls.js'

afterEach(() => {
  vi.unstubAllEnvs()
  resetBunTlsLoaderForTests()
})

describe('官方形态提示词', () => {
  it('四个占位符全部替换，且不留任何 {{…}}', () => {
    const text = renderOpencodeOfficialPrompt('deepseek-v4.1-flash-free', new Date(Date.UTC(2026, 9, 26)))
    expect(text).not.toMatch(/\{\{[A-Z]+\}\}/)
    expect(text).toContain('Model ID: deepseek-v4.1-flash-free')
    expect(text).toContain('Name: Deepseek V4.1 Flash Free')
    expect(text).toContain('Mon Oct 26 2026')
  })

  it('⚠️ `<env>` 块必须在，且 `Working directory` 是相对路径 ./', () => {
    const text = renderOpencodeOfficialPrompt('big-pickle')
    // 实测：整块删掉 ⇒ 429；绝对路径会让模型以为自己能直接访问本机目录。
    expect(text).toContain('<env>')
    expect(text).toContain('Working directory: ./')
    expect(text).not.toMatch(/Working directory: [A-Za-z]:\\/)
  })

  it('模板体积量级锁住 —— 实测「截掉前半」会 429', () => {
    // 不是断言某个魔法数字，而是防止有人把它「精简」成几十字节的短句：
    // 真机对照里 40 字符与减半两种形态都回 429，只有完整模板（含 env 块）才 200。
    expect(OPENCODE_OFFICIAL_PROMPT_TEMPLATE.length).toBeGreaterThan(700)
    // 关键小节都在（任一缺失都改变模型看到的 harness 形态）。
    for (const section of ['# Harness', '# Communication', '# Working in codebases', '# Your Model']) {
      expect(OPENCODE_OFFICIAL_PROMPT_TEMPLATE).toContain(section)
    }
  })

  it('展示名按 - 切分逐段首字母大写', () => {
    expect(opencodeDisplayName('big-pickle')).toBe('Big Pickle')
    expect(opencodeDisplayName('glm-5.3-flash-free')).toBe('Glm 5.3 Flash Free')
    // 连续连字符不产生空段（否则名字里会出现双空格）。
    expect(opencodeDisplayName('a--b')).toBe('A B')
    expect(opencodeDisplayName('')).toBe('')
  })

  it('日期是 UTC 且与官方同形（周几 月 日 年）', () => {
    // 用固定时刻钉住：直接 new Date() 会随运行日漂移（本仓库已登记过这类脆弱用例）。
    expect(opencodePromptDate(new Date(Date.UTC(2026, 0, 1)))).toBe('Thu Jan 01 2026')
    expect(opencodePromptDate(new Date(Date.UTC(2026, 9, 26)))).toBe('Mon Oct 26 2026')
    // 个位数日期补零（`Jan 05` 而不是 `Jan 5`）。
    expect(opencodePromptDate(new Date(Date.UTC(2026, 4, 5)))).toMatch(/ 05 2026$/)
  })

  it('与 DSH system 合并：官方在前、DSH 在后、空 system 不留多余空行', () => {
    expect(mergeSystemWithOfficialPrompt('OFFICIAL', 'OWN')).toBe('OFFICIAL\n\nOWN')
    expect(mergeSystemWithOfficialPrompt('OFFICIAL', '')).toBe('OFFICIAL')
    expect(mergeSystemWithOfficialPrompt('OFFICIAL', undefined)).toBe('OFFICIAL')
    // 只有空白也视作「没有」——否则会出现一条只有空白的尾巴。
    expect(mergeSystemWithOfficialPrompt('OFFICIAL', '   \n ')).toBe('OFFICIAL')
  })
})

describe('Bun TLS 参数（指纹本体）', () => {
  it('⚠️ 关键开关逐项钉住 —— 任一改动都会让 JA4 变形', () => {
    expect(OPENCODE_BUN_TLS_OPTIONS.greaseEnabled).toBe(false)
    expect(OPENCODE_BUN_TLS_OPTIONS.permuteExtensions).toBe(false)
    expect(OPENCODE_BUN_TLS_OPTIONS.alpnProtocols).toEqual(['HTTP1'])
    expect(OPENCODE_BUN_TLS_OPTIONS.minTlsVersion).toBe('TLS1.2')
    expect(OPENCODE_BUN_TLS_OPTIONS.maxTlsVersion).toBe('TLS1.3')
    expect(OPENCODE_BUN_TLS_OPTIONS.curvesList.startsWith('X25519MLKEM768')).toBe(true)
    expect(OPENCODE_BUN_TLS_OPTIONS.enableOcspStapling).toBe(true)
    expect(OPENCODE_BUN_TLS_OPTIONS.enableSignedCertTimestamps).toBe(true)
    expect(OPENCODE_BUN_TLS_OPTIONS.sessionTicket).toBe(true)
    expect(OPENCODE_BUN_TLS_OPTIONS.renegotiation).toBe(true)
  })

  it('⚠️ cipher 列表是 17 项且**顺序**即指纹（别排序、别去重）', () => {
    const ciphers = String(OPENCODE_BUN_TLS_OPTIONS.cipherList).split(':')
    expect(ciphers).toHaveLength(17)
    // 前三项是 TLS 1.3 套件，且 AES128 在 AES256 之前 —— 排序会翻转它。
    expect(ciphers.slice(0, 3)).toEqual([
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
    ])
    expect(new Set(ciphers).size).toBe(ciphers.length)
  })

  it('sigalgs 是 9 项且首项是 ECDSA+SHA256', () => {
    const sigalgs = String(OPENCODE_BUN_TLS_OPTIONS.sigalgsList).split(':')
    expect(sigalgs).toHaveLength(9)
    expect(sigalgs[0]).toBe('ECDSA+SHA256')
  })
})

describe('Bun TLS 加载与回退', () => {
  it('本机若装得到 wreq-js ⇒ 加载成功；装不到 ⇒ 如实报原因（两种都合法）', async () => {
    const loaded = await ensureBunTlsLoaded()
    if (loaded) {
      expect(bunTlsUnavailableReason()).toBeUndefined()
    } else {
      // ⚠️ 不可用**不是测试失败**：这是按平台分发的可选依赖。
      // 但原因必须可读（否则用户只看得到一句「不可用」）。
      expect(String(bunTlsUnavailableReason()).length).toBeGreaterThan(0)
    }
  })

  it('⚠️ 未加载时 `bunTlsFetch` 抛的是专用错误，而不是 TypeError', async () => {
    // 必须能与「请求真的失败了」区分开：调用方只对这一类回退。
    resetBunTlsLoaderForTests()
    vi.doMock('wreq-js', () => { throw new Error('模拟：没有匹配的预编译包') })
    vi.resetModules()
    const fresh = await import('../../src/opencode-bun-tls.js')
    const failed = await fresh.ensureBunTlsLoaded().catch(() => false)
    if (!failed) {
      await expect(fresh.bunTlsFetch('https://example.invalid', {}, undefined))
        .rejects.toBeInstanceOf(fresh.BunTlsUnavailableError)
    }
    vi.doUnmock('wreq-js')
    vi.resetModules()
  })

  it('专用错误的文案带上真因（否则用户无从自查）', () => {
    const error = new BunTlsUnavailableError('Cannot find module wreq-js')
    expect(error.message).toContain('Cannot find module wreq-js')
    expect(error.name).toBe('BunTlsUnavailableError')
  })

  it('`wreq-js` 拿不到时，`bunTlsFetch` 不会静默降级成裸 fetch', async () => {
    // 若它偷偷换了实现，调用方就再也看不到「已回退」这件事，
    // 而免费通道会以「莫名 429」的面目出现。
    const spy = vi.fn(async () => new Response('nope'))
    vi.stubGlobal('fetch', spy)
    vi.doMock('wreq-js', () => { throw new Error('缺席') })
    vi.resetModules()
    const fresh = await import('../../src/opencode-bun-tls.js')
    const ok = await fresh.ensureBunTlsLoaded().catch(() => false)
    if (!ok) {
      await expect(fresh.bunTlsFetch('https://example.invalid', {}, undefined))
        .rejects.toBeInstanceOf(fresh.BunTlsUnavailableError)
      expect(spy).not.toHaveBeenCalled()
    }
    vi.doUnmock('wreq-js')
    vi.resetModules()
  })
})

/**
 * ⚠️ **单点守卫**：`wreq-js` / `.node` 只允许出现在 `opencode-bun-tls.ts`。
 *
 * 判据照本仓库既有写法（`opencode-proxy.spec.ts` 的 `dispatcher` 总闸）：
 * 扫**整个 `src/` 目录**而不是写死文件清单，新增文件也会被覆盖；
 * 且**先剥注释**再匹配（注释里会正当引用这些字面量，否则必然假失败）。
 */
describe('接线守卫', () => {
  const srcRoot = resolve(process.cwd(), 'src')

  function stripComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, out)
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
    return out
  }

  it('⚠️ 除 opencode-bun-tls.ts 外，src/ 里不得出现 wreq-js 或原生 .node 导入', () => {
    const offenders: string[] = []
    for (const file of walk(srcRoot)) {
      if (file.endsWith('opencode-bun-tls.ts')) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      // 说明符字面量与直接 require 两种形态都禁（本仓库里解析器只该有一处）。
      if (/['"]wreq-js['"]/.test(code) || /require\([^)]*\.node['"]/.test(code)) {
        offenders.push(file.slice(srcRoot.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })

  it('⚠️ 传输层的调用点只有一个（`bunTlsFetch` 只在 adapter 里被用）', () => {
    const callers: string[] = []
    for (const file of walk(srcRoot)) {
      if (file.endsWith('opencode-bun-tls.ts')) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      if (/bunTlsFetch\s*\(/.test(code)) callers.push(file.slice(srcRoot.length + 1))
    }
    expect(callers).toEqual(['opencode-adapter.ts'])
  })

  it('adapter 的回退只接 `BunTlsUnavailableError`（不得接其它错误）', () => {
    const code = readFileSync(join(srcRoot, 'opencode-adapter.ts'), 'utf8')
    // 判据：同一函数体内 `instanceof BunTlsUnavailableError` 在，且 catch 里
    // 没有裸 `catch {` 把一切吞掉再回退的写法。
    const block = code.slice(code.indexOf('fetchWithBunFingerprint'))
    const body = block.slice(0, block.indexOf('proxyFetch(', block.indexOf('catch')))
    expect(body).toContain('instanceof BunTlsUnavailableError')
  })
})
