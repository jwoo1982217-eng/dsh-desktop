/**
 * ZCode **浏览器探测**的回归测试。
 *
 * ## 守的是什么（两个实测踩过的真缺陷）
 *
 * ### 1. 空环境变量会产生**相对路径**
 *
 * `join('', 'Google', 'Chrome', 'Application', 'chrome.exe')` 返回
 * `Google\Chrome\Application\chrome.exe` —— 一个**相对路径**。
 * `existsSync` 相对**当前工作目录**解析，于是：
 *   - 「当前目录下恰好有同名文件」会被误判成浏览器；
 *   - 真正的浏览器却可能找不到。
 *
 * ⇒ 只接受**绝对路径**候选。
 *
 * ### 2. `USERPROFILE` 不等于家目录
 *
 * scoop 默认装在 `~/scoop`，而 `~` 应当用 `os.homedir()` 求。
 * 用 `process.env.USERPROFILE` 拼路径时，**一旦该变量被改写**
 * （沙箱、CI、异常环境），原本可用的 scoop chromium 就找不到了 ——
 * 实测：把 `USERPROFILE` 指到临时目录后，`findBrowserExecutable()`
 * 返回 undefined，而 `ZCODE_CHROME_PATH` 一设就好。
 *
 * ⚠⚠ 这条**只靠行为判据守不住**（本机实测，Windows）：`os.homedir()` 在
 * Windows 上本身就取自 `USERPROFILE`，把实现改成读死 env 后新旧行为**逐字相同**。
 * ⇒ 末尾的「默认家目录不回落到 `process.env.USERPROFILE`」用**源码结构判据**守。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  browserCandidates,
  browserNotFoundMessage,
  decodeRegistryOutput,
  decodeRegistryOutputWithFallback,
  encodingForOemCodePage,
  registryCodePage,
  windowsRegisteredBrowserPaths,
  findBrowserExecutable,
  isBrowserDeploymentError,
  scoopRootFromPath,
  BrowserDeploymentError,
} from '../../src/chromium-session.js'

/**
 * 被扫描的源码文件。
 *
 * ⚠ 是 `chromium-session.ts`，**不是** `zcode-captcha.ts`（2026-10-08 抽共享模块）：
 * 候选链的三个分支函数、出口函数与 `findBrowserExecutable` 全部搬到了那里，
 * 供 zcode captcha 与库库AI 登录共用。
 *
 * ⚠⚠ **本文件的判据全部依赖「扫到的确实是真源码」**，指错文件时的失效是
 * **静默**的：`fnBody(code, name)` 里的 `expect(start).toBeGreaterThan(-1)`
 * 会兜住「函数找不到」，但 `stripComments` 那几条整文件正则不会 ——
 * 它们会在一个不含该代码的文件上求值并**全绿**。改实现文件时**必须同时改这里**。
 */
const sourcePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'chromium-session.ts',
)

/**
 * 剥掉注释，只留可执行代码。
 *
 * ⚠ 必须剥：本文件多处注释正是在解释「**为什么不用** `USERPROFILE`」，
 * 不剥会把这些说明当成违规（反之，实现里新加的中文注释也一样）。
 * 范式取自 `raccoon-client-independence.spec.ts`。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 取某个具名函数的**函数体**（按配对大括号切，不靠正则猜边界）。
 *
 * ⚠⚠ **必须先跳过参数列表**（2026-10-08 修）。
 *
 * 早期实现直接 `indexOf('{', start)` 取第一个 `{` —— 对
 * `browserCandidates` 这种**参数是对象字面量类型**的函数，那个 `{` 落在
 * **参数类型注解**里，于是「函数体」只截到
 * `{ platform?: …; env?: …; home?: string }` 就结束了（实测 len=103），
 * 真正的函数体一行都没扫到 ⇒ 本文件里依赖 `fnBody` 的判据**静默恒真**。
 * 这正是「扫描类断言必须自带护栏」那条教训的又一实例。
 *
 * 修法：先按括号配对找到参数列表的 `)`，再从它之后取第一个 `{`。
 *
 * ⚠ 已知边界：若将来某个被扫的函数**返回类型本身含大括号**
 * （如 `): { a: string } {`），这里仍会取错。本文件扫的 5 个函数返回类型
 * 分别只有 `string[]` / `string | undefined`，不触发该边界。
 */
function fnBody(code: string, name: string): string {
  const start = code.indexOf(`function ${name}(`)
  expect(start, `源码里应能找到 ${name}`).toBeGreaterThan(-1)
  // 先跳过参数列表：从 `(` 起按圆括号配对，找到与之配对的 `)`。
  const paramsOpen = code.indexOf('(', start)
  let parens = 0
  let paramsClose = -1
  for (let i = paramsOpen; i < code.length; i++) {
    if (code[i] === '(') parens++
    else if (code[i] === ')') {
      parens--
      if (parens === 0) { paramsClose = i; break }
    }
  }
  if (paramsClose === -1) throw new Error(`${name} 的参数列表括号不配对`)
  // 再从参数列表之后取函数体。
  const open = code.indexOf('{', paramsClose)
  if (open === -1) throw new Error(`${name} 找不到函数体起始大括号`)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (depth === 0) return code.slice(open, i + 1)
    }
  }
  throw new Error(`${name} 的函数体括号不配对`)
}

/** 临时环境变量的设置/还原。 */
const saved: Record<string, string | undefined> = {}
function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of Object.keys(saved)) delete saved[k]
})

describe('Windows App Paths 浏览器发现', () => {
  // ⚠️⚠️ **夹具必须是「真实形态」**（2026-10-30 四路审计 P0 D-01 / P2 D-4 修）：
  //
  // 旧夹具写的是 `'    (默认)    REG_SZ    D:\\\\Tools\\\\Chrome\\\\App\\\\chrome.exe\r\n'`
  // —— ① 中文标签是 **UTF-8**（真实输出是 **GBK 字节**）；② 路径是**双反斜杠**
  // （真实输出是**单反斜杠**）；③ 路径**根本不存在**。
  // ⇒ 它只验证了「`REG_SZ` 这个 ASCII token 能找到」，**完全绕开了编码问题**
  // ⇒ P0 D-01 正是从这条缝漏过去的。
  //
  // ⇒ 下面的夹具改成：**真实存在的临时文件** + **真实 GBK 字节**。

  /** 造一个真实的、存在的可执行文件（`existsSync` 过滤要过）。 */
  function makeRealExe(dirName: string, rel: string): string {
    const dir = join(dirName, ...rel.split('/').slice(0, -1))
    mkdirSync(dir, { recursive: true })
    const exe = join(dirName, ...rel.split('/'))
    writeFileSync(exe, '')
    return exe
  }

  it('★★ **GBK 字节**的中文路径必须被正确解码（2026-10-30 审计 P0 D-01 修）', () => {
    // ⚠️⚠️ **判据必须直接打解码器**（旧夹具把「已解码的文本」喂给注入点 ⇒
    //    **完全绕开了编码问题** ⇒ P0 D-01 正是从这条缝漏过去的）。
    //
    //    真实 `reg query` 输出是**系统 OEM 代码页字节**（中文 Windows = GBK）。
    //    旧实现写死 `encoding: 'utf8'` ⇒ 中文被解成 **U+FFFD（不可逆）**。
    const gbkBytesOf = (text: string): Buffer => {
      // Node 无 GBK **编码器**（`TextEncoder` 只有 utf8）⇒ 用已知字节表。
      // ⚠️⚠️ 字节表必须**逐项反查验证**（2026-10-30 第二轮审计 N-4 修）：
      //    原表把 `认` 写成 `[0xd0,0xb6]` ⇒ 实测解出的是 **`卸`**（另一个字！）
      //    ⇒ 而夹具里用的是 `默`/`认` 的**标签**、路径用「我的工具」⇒
      //    那张错表**从未被真正测到**（潜伏）⇒ 必须给表项**加守卫**。
      //    下表每一项都由 `TextDecoder('gb18030')` 反查得出（见本用例的自证）。
      const table: Record<string, readonly number[]> = {
        '我': [0xce, 0xd2], '的': [0xb5, 0xc4], '工': [0xb9, 0xa4], '具': [0xbe, 0xdf],
        '默': [0xc4, 0xac], '认': [0xc8, 0xcf],
      }
      // ⚠️ **自证**：表里每一项都必须**解回原字**（否则这张表是错的）。
      for (const [ch, bytes] of Object.entries(table)) {
        expect(new TextDecoder('gb18030').decode(Buffer.from(bytes)), `字节表项 ${ch} 必须解回自身`).toBe(ch)
      }
      const out: number[] = []
      for (const ch of text) {
        const bytes = table[ch]
        if (bytes === undefined) out.push(...Buffer.from(ch, 'utf8'))
        else out.push(...bytes)
      }
      return Buffer.from(out)
    }
    const raw = gbkBytesOf('    (默认)    REG_SZ    D:\\我的工具\\Chrome\\App\\chrome.exe\r\n')
    // ⚠️ **自证**：这段字节确实是 GBK（按 utf8 解必然乱码、按 gb18030 解正常）。
    //    ⚠️ `Buffer.toString` **只认 utf8/latin1/ucs2/base64 等**（无 gbk）⇒
    //    GBK 的「正确解」必须走 `TextDecoder`（Node 内置支持 gbk/gb18030，实测）。
    expect(raw.toString('utf8')).not.toBe(new TextDecoder('gb18030').decode(raw))
    expect(new TextDecoder('gb18030').decode(raw)).toContain('我的工具')

    // ⚠️ 判据：解码后中文**完整**、**没有 U+FFFD**。
    const decoded = decodeRegistryOutput(raw, 'gb18030')
    expect(decoded).toContain('我的工具')
    expect(decoded).not.toContain('\uFFFD')
    expect(decoded).toContain('D:\\我的工具\\Chrome\\App\\chrome.exe')
    // ⚠️ 反向对照：旧的 utf8 口径**确实**会坏（证明这条用例有判别力）。
    expect(raw.toString('utf8')).toContain('\uFFFD')
  })

  it('★★ 英文代码页（windows-1252）**不得**被 `gb18030` 解坏（2026-10-30 第二轮审计修）', () => {
    // ⚠️⚠️ **两个解码器都能解任何字节序列**（`fatal: false`）⇒ 「先试 gb18030」
    //    在**英文 Windows**上会把 1252 的字节解成**别的字符**：
    //    `C:\Users\José\Chrome` ⇒ gb18030 解成 `C:\Users\Jos閈\Chrome`。
    const raw = Buffer.from('C:\\Users\\Jos\u00e9\\Chrome', 'latin1')
    // ⚠️ 自证：这段字节是 1252 的（`é` = 0xE9，位于 `Jos` 之后）。
    expect(raw.indexOf(0xe9)).toBeGreaterThan(0)
    expect(raw[raw.indexOf(0xe9)]).toBe(0xe9)
    // ⚠️ 1252 解码器必须给出正确的 `é`
    expect(decodeRegistryOutput(raw, 'windows-1252')).toContain('Jos\u00e9')
    // ⚠️ 反向对照：**gb18030 确实会解坏**（证明这条用例有判别力）
    expect(decodeRegistryOutput(raw, 'gb18030')).not.toContain('Jos\u00e9')
  })

  it('★★ 代码页判据必须**读权威的 OEMCP**（2026-10-30 第二轮审计 P1-1 修）', () => {
    // ⚠️⚠️ **不能**按 locale 猜：日文 OEMCP=932（Shift-JIS）、韩文=949、
    //    **繁体中文=950（Big5）** ⇒ 把 ja/ko/zh-TW 映射到 gb18030 **全错**
    //    （实测 Shift-JIS 的 `あ` 被 gb18030 解成 `偁`、Big5 的 `中` 解成 `い`）。
    // ⚠️ 而且 `Intl` 的 locale 是**用户区域格式**、不一定等于 UI 语言。
    // ⇒ 权威来源：`HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage` 的 `OEMCP`。
    expect(encodingForOemCodePage(936)).toBe('gb18030')
    expect(encodingForOemCodePage(932)).toBe('shift_jis')
    expect(encodingForOemCodePage(949)).toBe('euc-kr')
    expect(encodingForOemCodePage(950)).toBe('big5')
    expect(encodingForOemCodePage(1252)).toBe('windows-1252')
    expect(encodingForOemCodePage(65001)).toBe('utf-8')
    // ⚠️ 未知档 ⇒ 1252（**安全降级**：解错会被存在性过滤筛掉 ⇒「找不到」）
    expect(encodingForOemCodePage(99999)).toBe('windows-1252')
    // ⚠️ **OEMCP 优先于 locale**
    expect(registryCodePage(936, 'en-US')).toBe('gb18030')
    expect(registryCodePage(1252, 'zh-CN')).toBe('windows-1252')
    // ⚠️ 读不到 OEMCP ⇒ locale 启发式（**只**把简体中文映射到 GBK）
    expect(registryCodePage(undefined, 'zh-CN')).toBe('gb18030')
    expect(registryCodePage(undefined, 'zh-TW')).toBe('windows-1252')
    expect(registryCodePage(undefined, 'ja-JP')).toBe('windows-1252')
    expect(registryCodePage(undefined, 'ko-KR')).toBe('windows-1252')
    expect(registryCodePage(undefined, 'en-US')).toBe('windows-1252')
  })

  it('★★ 首选编码解出 U+FFFD ⇒ 自动重试候选编码（2026-10-30 第二轮审计修）', () => {
    // ⚠️⚠️ `TextDecoder`（`fatal:false`）**不抛** ⇒ 首选编码猜错时只产出
    //    U+FFFD ⇒ 路径被存在性过滤筛掉 ⇒ 整条注册表腿静默失效。
    // ⇒ 必须有「重试」兜底。
    const raw = Buffer.from('C:\\Users\\Jos\u00e9\\Chrome', 'latin1')
    // ⚠️ 首选 gb18030（**错**的）⇒ 兜底必须救回来
    const rescued = decodeRegistryOutputWithFallback(raw, 'gb18030')
    expect(rescued).toContain('Jos\u00e9')
    expect(rescued).not.toContain('\uFFFD')
    // ⚠️ 反向对照：纯 ASCII 输出**首选即命中**（零额外开销）
    const ascii = Buffer.from('C:\\Program Files\\Chrome\\chrome.exe', 'latin1')
    expect(decodeRegistryOutputWithFallback(ascii, 'gb18030')).toBe('C:\\Program Files\\Chrome\\chrome.exe')
  })

  it('★★ 解码后的中文路径**能过存在性过滤**并成为候选（端到端）', () => {
    if (process.platform !== 'win32') {
      expect(windowsRegisteredBrowserPaths(() => ({ status: 0, stdout: 'x' }))).toEqual([])
      return
    }
    const dir = mkdtempSync(join(tmpdir(), 'reg-gbk-'))
    try {
      // ⚠️ **真实的中文目录名** + **真实存在的文件**（存在性过滤要过）。
      const exe = makeRealExe(dir, '我的工具/Chrome/App/chrome.exe')
      const found = windowsRegisteredBrowserPaths((key) => (
        key.startsWith('HKCU') && key.endsWith('\\chrome.exe')
          // ⚠️ 注入点给的是**已解码**的文本（与真实解码器输出一致）。
          ? { status: 0, stdout: `    (默认)    REG_SZ    ${exe}\r\n` }
          : { status: 1, stdout: '' }
      ))
      expect(found).toEqual([exe])
      expect(found[0]).not.toContain('\uFFFD')
      expect(found[0]).toContain('我的工具')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★ 注册名 ≠ 文件名时**不得**误杀（2026-10-30 审计 P3-3 修）', () => {
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'reg-edge-'))
    try {
      // ⚠️ 真实形态：`App Paths\msedge.exe` 的默认值是 `Microsoft Edge.exe`
      //    （实测本机）⇒ 旧守卫 `=== 'msedge.exe'` 会**误杀**它。
      const exe = makeRealExe(dir, 'Microsoft Edge/Application/Microsoft Edge.exe')
      const found = windowsRegisteredBrowserPaths((key) => (
        key.endsWith('\\msedge.exe')
          ? { status: 0, stdout: `    (Default)    REG_SZ    ${exe}\r\n` }
          : { status: 1, stdout: '' }
      ))
      expect(found).toEqual([exe])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★ `REG_EXPAND_SZ` 也**要认**（2026-10-30 审计 U6 修）', () => {
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'reg-expand-'))
    try {
      const exe = makeRealExe(dir, 'Chrome/App/chrome.exe')
      // ⚠️ 旧实现用 `/\bREG_SZ\b/i` ⇒ **不匹配** `REG_EXPAND_SZ`
      //    （`\b` 在 `_` 前不成立）⇒ 整行被跳过。
      const found = windowsRegisteredBrowserPaths((key) => (
        key.endsWith('\\chrome.exe')
          ? { status: 0, stdout: `    (Default)    REG_EXPAND_SZ    ${exe}\r\n` }
          : { status: 1, stdout: '' }
      ))
      expect(found).toEqual([exe])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★ **不存在的路径不产生候选**（存在性过滤，2026-10-30 审计 P2-1 修）', () => {
    if (process.platform !== 'win32') return
    // ⚠️ 标准安装会推出 `C:\Program Files\Google\Data` 这种**垃圾路径** ⇒
    //    存在性过滤把它筛掉（否则污染目录列表 + 扫无关目录的 localStorage）。
    const found = windowsRegisteredBrowserPaths((key) => (
      key.endsWith('\\chrome.exe')
        ? { status: 0, stdout: '    (Default)    REG_SZ    C:\\不存在的路径\\App\\chrome.exe\r\n' }
        : { status: 1, stdout: '' }
    ))
    expect(found).toEqual([])
  })

  it('★ 查询失败或路径不完整时不产生候选', () => {
    const found = windowsRegisteredBrowserPaths(() => ({ status: 0, stdout: '    (默认)    REG_SZ\r\n' }))
    expect(found).toEqual([])
  })

  it('★ 非 Windows 平台**不执行**注册表查询（平台闸门）', () => {
    if (process.platform === 'win32') {
      // Windows 上闸门是「不短路」⇒ 断言查询器**被调用过**。
      let called = 0
      windowsRegisteredBrowserPaths(() => { called += 1; return { status: 1, stdout: '' } })
      expect(called).toBeGreaterThan(0)
      return
    }
    let called = 0
    windowsRegisteredBrowserPaths(() => { called += 1; return { status: 0, stdout: 'x' } })
    expect(called, '非 Windows 不得执行注册表查询').toBe(0)
  })
})

describe('ZCode 浏览器探测', () => {
  it('★ ZCODE_CHROME_PATH 显式指定时优先（且必须是绝对路径）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-browser-'))
    try {
      const exe = join(dir, 'chrome.exe')
      writeFileSync(exe, '')
      setEnv('ZCODE_CHROME_PATH', exe)
      expect(findBrowserExecutable()).toBe(exe)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★ ZCODE_CHROME_PATH 是**相对路径**时被忽略（防 CWD 误匹配）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-browser-rel-'))
    const cwdSaved = process.cwd()
    try {
      /**
       * ⚠ 诱饵文件放在**专属临时目录**并 `chdir` 进去，**不写 `process.cwd()`**
       * （Gitee issue IKJMQ5，本机实测复现）。
       *
       * 相对路径是**相对 CWD** 解析的，所以「CWD 里有同名文件」这个前提不能省 ——
       * 但把它实现成「往仓库根写一个**固定名**文件」会引入两个真问题：
       *
       * ① **并行跑必炸，且是假失败**：另一个 vitest 进程正持有同名文件的句柄时，
       *    Windows 的删除直接 `EPERM`，而 `rmSync(..., { force: true })` 的
       *    `force` **只吞 ENOENT、不吞 EPERM** ⇒ 异常从 `finally` 抛出，
       *    用例变红。**被测代码行为完全正确**，红的是脚手架。
       *    实测（本机，8 个 vitest 进程并发）：8 轮 80 次 → 2 次红；
       *    4 并发 100 次 → 2 次红；2 并发 80 次 → 0 次红。
       *    ⚠ 单次 `vitest run` **不会**触发（同一文件在一个进程里只跑一次），
       *    所以这是「多进程共享同一工作区」才暴露 —— CI 并行 job、
       *    本地同时跑两条测试、IDE 里 watch 与手动跑重叠都会撞上。
       * ② **会往仓库根留垃圾**：进程被 kill / 超时时 `finally` 不执行，
       *    `chrome-rel-test.exe` 就留在仓库根进 `git status`。
       *
       * ⇒ 修法：诱饵文件随 `mkdtempSync` **每个进程独占**，CWD 由 `chdir`
       * 临时切进该目录，测完在 `finally` 里切回。
       * ⚠ `process.chdir` 需要 worker 是**真进程**（vitest 默认 pool `forks`；
       * 若哪天改成 `threads` 会抛 `ERR_WORKER_UNSUPPORTED_OPERATION`，
       * 那时这条会**响亮地**失败，而不是静默失去覆盖）。
       */
      const relative = 'chrome-rel-test.exe'
      writeFileSync(join(dir, relative), '')
      process.chdir(dir)
      setEnv('ZCODE_CHROME_PATH', relative)
      // ⚠ 相对路径不该被接受（否则会误把它当浏览器）。
      const found = findBrowserExecutable()
      expect(found).not.toBe(relative)
      if (found !== undefined) expect(isAbsolute(found)).toBe(true)
    } finally {
      process.chdir(cwdSaved)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★ 环境变量为空时不产生相对路径候选（只能返回绝对路径或 undefined）', () => {
    // 清掉所有可能来源，只留一个不存在的 override。
    for (const k of ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA', 'SCOOP', 'SCOOP_GLOBAL']) {
      setEnv(k, undefined)
    }
    setEnv('ZCODE_CHROME_PATH', join(tmpdir(), 'definitely-no-such-browser.exe'))
    const found = findBrowserExecutable()
    // 要么 undefined，要么绝对路径；**绝不能**是相对路径。
    if (found !== undefined) expect(isAbsolute(found)).toBe(true)
  })

  it('★ 探测跟随 os.homedir()：home 注入口优先于进程真实家目录', () => {
    /**
     * ★ 这条断言的方向改过三次，记下来免得后人又写错。
     *
     * 1. 最初断言「改 `USERPROFILE` 后仍能找到 `~/scoop` 的浏览器」——
     *    要求 `homedir()` 不变，而独立 node 进程里它首次调用后就缓存（121）。
     * 2. 改成「探测结论与 `homedir()` 一致」——方向对了，但仍**测不到目标**：
     *    它靠 `setEnv('USERPROFILE', dir)` 让家目录变化，而 `USERPROFILE` 是
     *    **Windows 专属变量**。darwin / linux 上它是空操作，实测：
     *        homedir() 改前 = /Users/gandhi
     *        homedir() 改后 = /Users/gandhi   ← 完全没变
     *        临时目录含 AppData\Local\Temp = false（POSIX 形态）
     *    于是走 `else` 分支，而该分支唯一的判据断言检查的是 **Windows 形态
     *    子串** `AppData\Local\Temp\zcode-browser-home-`，在本机永远不可能出现
     *    ⇒ **恒真断言等于没有断言**。
     *
     * 反向验证（决定性）：把实现改成读死 env，该用例在 macOS 上**照样全绿**：
     *        - const home = input.home ?? homedir()
     *        + const home = input.home ?? process.env.USERPROFILE ?? homedir()
     *        → ✓ 探测跟随 os.homedir()  0ms
     *
     * ⇒ 现在照 `SCOOP 优先于默认 ~/scoop` 的范式：走纯函数
     * {@link browserCandidates}、把平台钉死、让 `home` 注入口与「进程真实家目录」
     * 取**不同的值**，于是「实现是否真的采用注入口」成为可失败判据。
     */
    const dir = mkdtempSync(join(tmpdir(), 'zcode-browser-home-'))
    try {
      const appsDir = join(dir, 'scoop', 'apps', 'chromium', 'current')
      mkdirSync(appsDir, { recursive: true })
      const exe = join(appsDir, 'chrome.exe')
      writeFileSync(exe, '')

      const candidates = browserCandidates({
        platform: 'win32',
        env: { ZCODE_CHROME_PATH: undefined },
        // ⚠ 刻意给一个**不同于真实家目录**的值：判据成立的唯一前提就是这个差异。
        home: dir,
      })

      // 判据 1：注入的家目录被采用 —— 默认 `~/scoop` 路径的第一条即命中它。
      expect(candidates[0]).toBe(exe)
      // 判据 2：若实现忽略注入口、改读 `homedir()`，首条就**不会**是它 ⇒ 变红。
      expect(candidates[0]).not.toContain(realHomeScoop())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * 真实家目录下的默认 scoop 路径（用于「实现是否读了真实 `homedir()`」的反向判据）。
   *
   * ⚠ 单独抽成函数而不是内联 `homedir()`：内联的话，`home: dir` 与判据 2 用的是
   * 同一个值，判据 2 会退化成「`exe` 不含它自己」的恒真断言 —— 与它要防的
   * 恒真问题同型。这里刻意让两者取不同的来源。
   */
  function realHomeScoop(): string {
    return join(homedir(), 'scoop', 'apps', 'chromium', 'current', 'chrome.exe')
  }

  it('★ SCOOP 显式声明的根目录**优先于**默认 ~/scoop', () => {
    /**
     * ⚠⚠ **必须显式传 `platform: 'win32'`** —— 判据是**候选顺序**，不是
     * 「本机能不能找到那个 exe」。
     *
     * ## 这条用例踩过的坑（2026-10-06，Gitee issue IKJPBJ 评论里由 @Ghandi 暴露）
     *
     * 它原先调 `findBrowserExecutable()`，而那个函数内部读**宿主** `process.platform`：
     *
     * - 在 macOS 补 darwin 分支**之前**，macOS 落进 win32 分支 ⇒ `SCOOP` 生效 ⇒
     *   临时造的 exe 排第一 ⇒ 用例通过（**靠巧合**）；
     * - 补了 darwin 分支**之后**，macOS 走 `/Applications/…` 那条链，`SCOOP`
     *   **被完全忽略** ⇒ 返回真实 Chrome（或 `undefined`）⇒ **必然失败**。
     *
     * 实测证据（`browserCandidates` 注入同一个 `SCOOP`）：
     * ```
     * win32  → 首条 C:\tmp\fake-scoop\apps\chromium\current\chrome.exe
     * darwin → 含任何 scoop 路径: false；首条 /Applications/Google Chrome.app/...
     * ```
     *
     * ⇒ 这不是「macOS 环境没配好」，是**用例本身只在 Windows 成立**。
     * 改调纯函数 {@link browserCandidates} 并把平台钉死，任意宿主上都跑同一份。
     *
     * ⚠ `SCOOP` 只在 win32 分支被读：它是 scoop（Windows 包管理器）的概念，
     * darwin / linux 分支里**根本没有**这一档 —— 下面第 2 条断言把这条契约锁死。
     */
    const dir = mkdtempSync(join(tmpdir(), 'zcode-browser-scoop-'))
    try {
      // 造一个符合 scoop 布局的路径：<root>/apps/chromium/current/chrome.exe
      const appsDir = join(dir, 'apps', 'chromium', 'current')
      mkdirSync(appsDir, { recursive: true })
      const exe = join(appsDir, 'chrome.exe')
      writeFileSync(exe, '')

      const candidates = browserCandidates({
        platform: 'win32',
        env: { ZCODE_CHROME_PATH: undefined, SCOOP: dir },
        home: homedir(),
      })
      /**
       * ⚠ 断言「第一条就是自定义那个」而不是「包含它」—— `SCOOP` 是 scoop 自己
       * 的权威声明，用户设了就说明默认路径不对。若实现把它排在 `~/scoop`
       * 之后，会先命中真实的 `~/scoop/.../chrome.exe`（实测第一版就是这么错的）。
       *
       * ⚠ 判据落在**候选链**而不是 `findBrowserExecutable()`：后者要过
       * `existsSync`，在本机会被真实安装的 Chrome 抢走第一名。
       */
      expect(candidates[0]).toBe(exe)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * 上面那条的**配套契约锁**：`SCOOP` 是 Windows 概念，darwin 分支里不得出现。
   * ⚠ 这条同时是上面那条的**反向验证**——若有人把 darwin 分支去掉、或让 SCOOP
   * 跨平台生效，它会立刻变红。
   */
  it('★ SCOOP / SCOOP_GLOBAL 只在 win32 分支被读（darwin · linux 一律忽略）', () => {
    const injected = { SCOOP: 'D:\\scoop', SCOOP_GLOBAL: 'E:\\gscoop' }
    expect(browserCandidates({ platform: 'win32', env: injected, home: 'C:\\u' })
      .some((c) => c.includes('scoop'))).toBe(true)
    for (const platform of ['darwin', 'linux'] as const) {
      expect(browserCandidates({ platform, env: injected, home: '/home/u' })
        .some((c) => c.includes('scoop'))).toBe(false)
    }
  })

  /**
   * ★★ 默认家目录**只**来自 `homedir()`，不得读 `USERPROFILE`（PR #75 补齐）。
   *
   * ## 为什么必须另立一条，而不是靠上面那条
   *
   * 上面那条（`home` 注入口优先）只证明「**注入口**被尊重」，
   * 证明不了「**没给注入口时**回落到 `homedir()`」——而后者才是本文件
   * 文件头「### 2. `USERPROFILE` 不等于家目录」那条**真正要守**的性质。
   *
   * ## ⚠⚠ 判据为什么不能靠「改 `USERPROFILE` 再看结论」
   *
   * 本机（Windows）实测复刻了旧用例并对读死 env 的变异做过对照：
   * ```
   * 未变异：homedir() = C:\Users\Jet\AppData\Local\Temp\zcode-browser-home-KGiOeH
   *         found = undefined（临时目录里本就没有 scoop）
   * 变异后：homedir() = C:\Users\Jet\AppData\Local\Temp\zcode-browser-home-RP5R3e
   *         found = undefined            ← 与未变异**逐字相同** ⇒ 用例照样全绿
   * ```
   * 根因：**Windows 上 `os.homedir()` 本身就取自 `USERPROFILE`** ——
   * 两种实现算出的家目录是**同一个值**，任何基于「结论是否变化」的判据
   * 都不可能区分它们。旧用例正是栽在这里。
   * ⇒ 唯一可失败的做法是**结构判据**：直接扫源码，看默认表达式里有没有 `USERPROFILE`。
   * 范式取自 `raccoon-client-independence.spec.ts` 的「不读取任何环境变量」。
   */
  it('★ 默认家目录不回落到 process.env.USERPROFILE（源码结构判据）', () => {
    const source = readFileSync(sourcePath, 'utf8')
    // 剥掉注释：文档里大量解释「为什么**不**用 USERPROFILE」，不能算成违规。
    const code = stripComments(source)

    // ⚠ 必须扫**整个**候选链构造路径，而不只是 browserCandidates 那一个赋值点：
    // windows / mac / linux 三个分支函数都吃 `home` 参数，若某分支改成自己读
    // `process.env.USERPROFILE`，上面那条注入口用例**照样全绿**。
    for (const fn of ['windowsBrowserCandidates', 'macBrowserCandidates', 'linuxBrowserCandidates']) {
      const body = fnBody(code, fn)
      expect(body, `${fn} 不得自行读取 process.env.USERPROFILE`).not.toContain('USERPROFILE')
      expect(body, `${fn} 不得自行读取 process.env.HOME`).not.toContain('process.env.HOME')
    }

    // 默认回落必须仍是 homedir()：注入口缺省时用它。
    expect(code).toMatch(/const\s+home\s*=\s*input\.home\s*\?\?\s*homedir\(\)/)
    // ⚠ 兜住「有人把 USERPROFILE 又加回 ?? 链」这种改法
    //   （上面那条正则锚定的是完整表达式，加在后面就匹配不上而变红）。
    expect(code, 'home 默认值不得混入 USERPROFILE').not.toMatch(
      /const\s+home\s*=[^\n]*USERPROFILE/,
    )
  })

  /**
   * ★★ 上面那条的**范围缺口修补**：判据原先只扫「三个分支函数体 + 一个赋值点」，
   * **调用点不在扫描范围内**（Gitee issue IKJS58 的复核中发现）。
   *
   * ## 缺口实测（本机 Windows，2026-10-08）
   *
   * 把注入搬到调用方即可绕过上面那条的全部断言 —— 但它在
   * 「`USERPROFILE` 被沙箱/CI 改写」时（正是本文件头 ### 2 要防的场景）与
   * 坏实现**行为等价**：
   *
   * ```ts
   * for (const candidate of browserCandidates({ home: process.env.USERPROFILE })) {
   * ```
   *
   * 实测：`zcode-browser-*.spec.ts` **34 条全绿**、`zcode-browser-detection.spec.ts`
   * 8/8 全绿。根因是上面那条的扫描域是**函数体白名单**，而缺口在调用点。
   *
   * ## 判据为什么需要**两个维度**（单维度实测各漏一半）
   *
   * 黑名单（`not.toContain('USERPROFILE')`）对本文件要防的写法无效，且必须
   * **穷举**变量名才成立 —— 正是本仓库反复出现的那类「同义判据漏一边」：
   *
   * ```ts
   * process.env['USER' + 'PROFILE']        // 拼接：不含字面量 USERPROFILE
   * const p = process.env; p.USERPROFILE   // 别名：不经 process.env 前缀
   * ```
   *
   * ⇒ 改判「**剥注释后的整份源码里，`process` 的每一次使用都必须在白名单内**」。
   *
   * | 维度 | 锁什么 | 漏掉的绕过（实测） |
   * |---|---|---|
   * | 只有**属性**白名单 | 属性名 ∈ {platform, env, kill} | `process.env` 搬到**调用点**（M1/M2/M4 全绿） |
   * | 加**位置**白名单 | `process.env` 只在默认回落处 | —（M1~M5 全红） |
   *
   * 1. **属性维度**锚定 `process` **标识符**而非 `process.env` 字面量 ——
   *    否则 `process['env']`（不含该字面量）会漏掉。
   * 2. **位置维度**把唯一的合法用法整串剔除，剩余不得再有 `process.env`。
   *
   * ⚠ 位置维度用「**剔除**后无残留」而非「计数 == 1」：两者都抓调用点，
   * 但计数锁会在新增一处完全无害的 `process.platform` 时**假失败**。
   *
   * ---
   *
   * ## ⚠⚠⚠ 这不是「已穷尽绕过」的防线，只是一枚**防回归锚点**
   *
   * 两轮独立审计（2026-10-08）各自实测出多类**全绿漏网**。**别把本判据
   * 的能力读高了** —— 它锚定的是「`process` 字面拼写」与「`process.env`
   * 出现的位置」，而这两样都不是「家目录来源」的充分刻画：
   *
   * | 已实测的漏网 | 机制 |
   * |---|---|
   * | `import proc from 'node:process'` | 进程对象可从**别的模块名**导入 |
   * | `import { env as hostEnv } from 'node:process'` | 同上（具名导入） |
   * | `const p = process as NodeJS.Process` | `as` **断言改名**，无 `process.` 前缀 |
   * | `env[['USER','PROFILE'].join('')]` | `env` 是**合法参数**；属性名可计算 ⇒ **文本层不可判定** |
   * | `(globalThis as any).eval('pro'+'cess')` | 动态求值 ⇒ **原理上不可判定** |
   * | `env.VITEST ? home : 偷env` | **测试环境自检测**：跑在 vitest 下就完全规矩 ⇒ 任何在用测试都抓不到 |
   * | `input.platform === undefined ? 偷env : home` | **条件门**：只在生产调用形态下使坏 |
   *
   * ⚠ 前 6 类**纯文本判据原理上都堵不住**（`eval` 与自检测尤其）；
   * 第 7 类（条件门）已由行为判据的**无参生产入口用例**封死 —— 那是
   * 本轮审计最有价值的产出，**别把它删了**。
   *
   * ⇒ **真正守住「家目录只来自 `homedir()`」的是行为判据**
   * （`tests/unit/zcode-browser-home-source.spec.ts` 的哨兵 + 默认入口用例）。
   * 本判据只是**快速静态预警**：它能在**改动默认回落那一行**时立刻出声，
   * 而代价极低。两者**互补而非冗余**（实测：V2「调用点注入」只有它能抓，
   * `env[evilKey]` 只有行为判据能抓）。
   *
   * ⚠ **新增任何白名单外的 `process.*`（含无辜的 `process.pid`）都会让它变红**
   * —— 那是**刻意**的：请到白名单处显式登记，而不是绕过它。为此本判据**只扫
   * 候选链的 5 个函数体**（而不是整个文件），把假失败面压到「与家目录真正相关
   * 的区域」。
   */
  it('★ process 只出现在白名单位置（覆盖调用点的范围缺口）', () => {
    const code = stripComments(readFileSync(sourcePath, 'utf8'))

    /**
     * ⚠ 只扫**候选链相关的 5 个函数体**，而不是整个文件。
     *
     * 理由（审计实测，2026-10-08）：家目录解析**只发生在这些函数里**；
     * 扫全文件会让 `process.pid` / `process.hrtime` / `process.stdout` /
     * `process.env.NODE_ENV` 这类**与家目录无关**的新增用法全部**假失败**
     * （实测 4 例），而它们完全无辜。窄域让判据只在**真正相关的区域**变红。
     *
     * ⚠ 必须含 `findBrowserExecutable`：调用点（`browserCandidates({ home: … })`）
     * 就在它里面 —— 那正是本判据要补的范围缺口。
     */
    const CHAIN_FUNCTIONS = [
      'windowsBrowserCandidates',
      'macBrowserCandidates',
      'linuxBrowserCandidates',
      'browserCandidates',
      'findBrowserExecutable',
    ] as const
    const region = CHAIN_FUNCTIONS.map((fn) => fnBody(code, fn)).join('\n')

    /**
     * ⚠ 剥掉**字符串字面量与模板字面量**：错误消息/脚本正文里出现的
     * `process.env.USERPROFILE`（给人看的文案、内嵌 PowerShell 脚本）不算
     * 「读取宿主环境变量」。
     */
    const withoutStrings = region
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')

    /**
     * 把 `process . env`（点前后有空白）**归一**成 `process.env` 再判。
     *
     * ⚠ 必须归一（审计实测漏洞 U2）：`process.  env`（点后多空格）不含
     * `process.env` 连续字面量，会**同时**绕过位置维度与正向锚定
     * （`\s*` 之后 `process\.env\b` 要求点后紧邻 `env`）⇒ 实测 9/9 全绿。
     */
    const normalized = withoutStrings.replace(/process\s*\.\s*env\b/g, 'process.env')

    // ── 维度 1：属性白名单 ────────────────────────────────────────────────────
    /**
     * `process` 的全部合法属性访问（**实测事实**，2026-10-08）：
     * 候选链区域里只有 `platform` ×1 / `env` ×1（`kill` 不在本区域，
     * 但保留在集合里以防将来迁入）。
     *
     * ⚠ 用逐点枚举而不是「总计数 == N」：后者在**新增**一处 `process.platform`
     * （完全无害）时会假失败。
     */
    const ALLOWED_PROCESS_PROPS = new Set(['platform', 'env', 'kill'])
    for (const match of normalized.matchAll(/process\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
      expect(
        ALLOWED_PROCESS_PROPS.has(match[1]),
        `候选链里不得读取 process.${match[1]}（白名单只允许 ${[...ALLOWED_PROCESS_PROPS].join(' / ')}）`,
      ).toBe(true)
    }
    // 括号访问一律违规 —— `process['env']` 不含 `process.env` 字面量。
    expect(
      normalized,
      '不得用括号访问 process（如 process["env"]），它会绕过属性名判据',
    ).not.toMatch(/process\s*\[/)
    /**
     * 裸 `process`（既不是属性访问也不是括号访问）不得出现。
     *
     * ⚠ 用 `[ \t]*` 而**不是** `\s*`：`\s` 会**跨行**，于是
     * `const p = process` + 换行 + 下一行的标识符被当成续接，负前瞻失效
     * ⇒ 实测漏掉「裸 process 别名」（9/9 全绿）。
     */
    expect(
      normalized,
      '不得把 process 整体当值使用（如 `const p = process`）',
    ).not.toMatch(/process\b(?![ \t]*[.[\w$])/)

    // ── 维度 2：位置（`process.env` 的唯一合法用途）──────────────────────────
    /**
     * ⚠⚠ 判据是「**归一后全区域恰好 1 处 `process.env`**」，且那一处必须是
     * `env` 的默认回落。
     *
     * ⚠ 早期版本用 `split(ENV_DEFAULT).join('')` 把合法串**整串剔除**再查残留 ——
     * 那是**自身缺陷**（审计实测 V_B4）：剔除是全局的，于是
     * `const h = (input.env ?? process.env).USERPROFILE ?? home` 里的坏用法
     * **连同合法串一起被剔除**，残留为空 ⇒ 9/9 全绿。**计数法不会自豁免** ——
     * 那个坏实现会数到 2 处，直接变红。
     */
    const envOccurrences = normalized.match(/process\.env/g) ?? []
    expect(
      envOccurrences.length,
      'process.env 在候选链里只允许出现 1 处（env 的默认回落）；' +
        '不得把它当作 home 等注入口的取值（应当由 homedir() 求解）',
    ).toBe(1)
    // 且那一处必须**确实是**默认回落（不是别的用途）。
    expect(normalized, 'env 的默认回落必须是 input.env ?? process.env').toMatch(
      /const\s+env\s*=\s*input\.env\s*\?\?\s*process\.env\b/,
    )
  })

  /**
   * 上面那条的**扫描健壮性护栏**：判据依赖「扫到的是真源码」。
   *
   * ⚠ 同 `raccoon-client-independence.spec.ts` 的做法 —— 扫描类断言必须先证明
   * 扫到了东西，否则「一个文件都没扫到」会让整条判据静默恒真。
   */
  it('★ 结构判据确实扫到了候选链实现（防止扫描失效而恒真）', () => {
    const code = stripComments(readFileSync(sourcePath, 'utf8'))
    // 三条分支函数 + 出口函数，缺一即说明扫描路径变了。
    for (const fn of [
      'windowsBrowserCandidates',
      'macBrowserCandidates',
      'linuxBrowserCandidates',
      'browserCandidates',
    ]) {
      expect(code).toContain(`function ${fn}(`)
    }
    // 确认剥注释后正文仍在（否则说明 stripComments 过度，把代码也吃掉了）。
    expect(code).toContain('join(')
  })
})

/**
 * Gitee issue IKQ4JN：**scoop 装在非默认根时一个 chromium 都找不到**。
 *
 * ## 为什么这一组必须存在（它补的正是漏掉的那一格）
 *
 * 既有用例（「SCOOP 显式声明的根目录优先于默认 ~/scoop」）只覆盖了
 * **`SCOOP` 有值**的情形。而报障人的机器上 `SCOOP` / `SCOOP_GLOBAL` **都是空的**
 * （用 `root_path` 把根挪到 `D:\System_Tools\Scoop`），`~/scoop` 也不存在
 * ⇒ 两条腿同时落空 ⇒ 候选链 9 条全部 `existsSync === false`。
 *
 * ⇒ 缺的判据就是「**环境变量为空 + 根不在默认位置**」这一格。
 * 它是本 issue 的**可复现最小条件**，也是当初这个 bug 穿过全部测试的原因。
 */
describe('scoop 非默认根（IKQ4JN 根因①）', () => {
  /** 报障人的机器：scoop 在 D 盘、SCOOP 为空、~/scoop 不存在。 */
  const reporterEnv = {
    LOCALAPPDATA: 'C:\\Users\\reporter\\AppData\\Local',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    PATH: 'D:\\System_Tools\\Scoop\\shims;C:\\Windows\\system32',
    // ⚠️ 刻意不给 SCOOP / SCOOP_GLOBAL —— 这正是 issue 的实测状态。
  }
  const reporterHome = 'C:\\Users\\reporter'
  /** shims 存在性替身：只有 D 盘那个是真的。 */
  const shimsWithScoop = (p: string): boolean =>
    p === 'D:\\System_Tools\\Scoop\\shims\\scoop.cmd'
    || p === 'D:\\System_Tools\\Scoop\\shims\\scoop.ps1'

  it('★★ 从 PATH 反推 scoop 根（不依赖 SCOOP 变量）', () => {
    expect(scoopRootFromPath(reporterEnv, shimsWithScoop)).toBe('D:\\System_Tools\\Scoop')
  })

  it('★★ 报障场景：候选链里必须出现真实的 scoop 根', () => {
    const list = browserCandidates({
      platform: 'win32',
      env: reporterEnv,
      home: reporterHome,
      exists: shimsWithScoop,
    })
    expect(
      list,
      '候选链里没有 D:\\System_Tools\\Scoop ⇒ 非默认根机器的 ZCode 领取恒失败',
    ).toContain('D:\\System_Tools\\Scoop\\apps\\chromium\\current\\chrome.exe')
  })

  it('★ 反推出来的档**排在默认 ~/scoop 之前**（实测到的根优先于默认推导）', () => {
    const list = browserCandidates({
      platform: 'win32',
      env: reporterEnv,
      home: reporterHome,
      exists: shimsWithScoop,
    })
    const derived = list.indexOf('D:\\System_Tools\\Scoop\\apps\\chromium\\current\\chrome.exe')
    const fallback = list.indexOf('C:\\Users\\reporter\\scoop\\apps\\chromium\\current\\chrome.exe')
    expect(derived).toBeGreaterThanOrEqual(0)
    expect(fallback).toBeGreaterThan(derived)
  })

  it('★ 显式 SCOOP 仍**优先于** PATH 反推（既有契约不变）', () => {
    const list = browserCandidates({
      platform: 'win32',
      env: { ...reporterEnv, SCOOP: 'E:\\explicit-scoop' },
      home: reporterHome,
      exists: shimsWithScoop,
    })
    const explicit = list.indexOf('E:\\explicit-scoop\\apps\\chromium\\current\\chrome.exe')
    const derived = list.indexOf('D:\\System_Tools\\Scoop\\apps\\chromium\\current\\chrome.exe')
    expect(explicit).toBe(0)
    expect(derived).toBeGreaterThan(explicit)
  })

  it('⚠️ 目录名叫 shims 但**没有 scoop 自己的 shim** ⇒ 不认（防误命中）', () => {
    // 某些 SDK 也有 shims 子目录；只按目录名匹配会误判成 scoop 根。
    expect(scoopRootFromPath(reporterEnv, () => false)).toBeUndefined()
  })

  it('⚠️ PATH 里的引号包裹能剥掉（安装器写坏时常见）', () => {
    const env = { PATH: '"D:\\System_Tools\\Scoop\\shims";C:\\Windows' }
    expect(scoopRootFromPath(env, shimsWithScoop)).toBe('D:\\System_Tools\\Scoop')
  })

  it('⚠️ 无 PATH / PATH 为空 ⇒ undefined（不抛错）', () => {
    expect(scoopRootFromPath({}, shimsWithScoop)).toBeUndefined()
    expect(scoopRootFromPath({ PATH: '' }, shimsWithScoop)).toBeUndefined()
  })

  it('⚠️ `Path`（首字母大写）也认 —— Windows 上两种拼写都出现过', () => {
    const env = { Path: 'D:\\System_Tools\\Scoop\\shims' }
    expect(scoopRootFromPath(env, shimsWithScoop)).toBe('D:\\System_Tools\\Scoop')
  })

  it('★ Windows 候选链补齐 Brave（IKQ4JN 附带建议 4）', () => {
    const list = browserCandidates({
      platform: 'win32',
      env: reporterEnv,
      home: reporterHome,
      exists: () => false,
    })
    const brave = list.filter((p) => p.toLowerCase().includes('brave'))
    expect(brave.length, 'Windows 候选链缺 Brave（mac/linux 早就有）').toBeGreaterThanOrEqual(3)
    // ⚠️ Brave 必须排在 Edge 之前（Edge 是最后的兜底）。
    const firstBrave = list.findIndex((p) => p.toLowerCase().includes('brave'))
    const edge = list.findIndex((p) => p.toLowerCase().includes('msedge.exe'))
    expect(firstBrave).toBeLessThan(edge)
  })

  it('⚠️ 候选链里**不得**出现 headless_shell（IKQ4JN 实测坑 2：恒 F001）', () => {
    const list = browserCandidates({
      platform: 'win32',
      env: reporterEnv,
      home: reporterHome,
      exists: () => false,
    })
    for (const p of list) {
      expect(p.toLowerCase(), 'chrome-headless-shell 能启动但 mint 恒 F001，不可加进候选')
        .not.toContain('headless')
    }
  })
})

/**
 * Gitee issue IKQ4JN 根因②：**部署错误不得计入 captcha 退避**。
 *
 * ## 为什么必须有这一组
 *
 * 原实现把「找不到浏览器」和「mint 产出失败」一视同仁地 `noteFailure()`，
 * 于是第 3 次点击进入冷却，用户看到「设备信誉不足」——把部署问题说成信誉问题。
 *
 * ⚠️ 这组的判据是**行为级**（抛真的错误对象、断言计数不变），
 * 而不是「源码里有没有 `isBrowserDeploymentError`」这种文本断言。
 */
describe('部署错误不计入 captcha 退避（IKQ4JN 根因②）', () => {
  it('★★ 部署错误可被识别；普通产出错误不可', () => {
    const deploy = new BrowserDeploymentError('找不到浏览器', 'browser-not-found')
    expect(isBrowserDeploymentError(deploy)).toBe(true)
    expect(isBrowserDeploymentError(new Error('mint F001'))).toBe(false)
    expect(isBrowserDeploymentError(null)).toBe(false)
    expect(isBrowserDeploymentError('字符串')).toBe(false)
    // ⚠️ 名字对但 deployKind 不合法 ⇒ 不认（防第三方恰好同名）。
    const impostor = Object.assign(new Error('x'), { name: 'BrowserDeploymentError', deployKind: 'whatever' })
    expect(isBrowserDeploymentError(impostor)).toBe(false)
  })

  it('★★ 部署错误**不累计** streak（连抛 5 次仍不进冷却）', async () => {
    const { CaptchaBackoff } = await import('../../src/captcha-backoff.js')
    const backoff = new CaptchaBackoff({ threshold: 3, baseMs: 60_000 })
    // 模拟 zcode-auth 的 catch 分支：部署错误**跳过** noteFailure。
    for (let i = 0; i < 5; i++) {
      const error = new BrowserDeploymentError('找不到浏览器', 'browser-not-found')
      if (!isBrowserDeploymentError(error)) backoff.noteFailure()
    }
    expect(backoff.failureStreak(), '部署错误被计入了信誉退避').toBe(0)
    expect(backoff.remainingMs(), '部署错误触发了冷却 ⇒ 用户会看到「设备信誉不足」').toBe(0)
  })

  it('★★ 对照：普通产出错误**照常**累计并进入冷却（护栏没被拆掉）', async () => {
    const { CaptchaBackoff } = await import('../../src/captcha-backoff.js')
    const backoff = new CaptchaBackoff({ threshold: 3, baseMs: 60_000 })
    for (let i = 0; i < 3; i++) {
      const error = new Error('mintOnPage: F001')
      if (!isBrowserDeploymentError(error)) backoff.noteFailure()
    }
    expect(backoff.failureStreak()).toBe(3)
    expect(backoff.remainingMs(), '产出失败必须仍能进冷却（那是信誉护栏）').toBeGreaterThan(0)
  })
})

/**
 * Gitee issue IKQ4JN 附带建议 1/3：找不到浏览器时**摊开**已尝试的候选与变量值。
 */
describe('找不到浏览器时的可执行提示（IKQ4JN 附带建议 1/3）', () => {
  it('★ 回显本进程看到的 override 值 + 逐条候选路径', () => {
    const message = browserNotFoundMessage('win32', 'ZCODE_CHROME_PATH', {
      tried: ['C:\\a\\chrome.exe', 'C:\\b\\msedge.exe'],
      overrideValue: undefined,
    })
    expect(message).toContain('本进程看到的 ZCODE_CHROME_PATH = （未设置）')
    expect(message).toContain('本次已尝试 2 条候选')
    expect(message).toContain('C:\\a\\chrome.exe')
    expect(message).toContain('C:\\b\\msedge.exe')
  })

  it('★ 设了变量时回显它的值（用来分辨「变量没生效」与「路径写错」）', () => {
    const message = browserNotFoundMessage('win32', 'ZCODE_CHROME_PATH', {
      tried: [],
      overrideValue: 'D:\\my\\chrome.exe',
    })
    expect(message).toContain('本进程看到的 ZCODE_CHROME_PATH = D:\\my\\chrome.exe')
  })

  it('⚠️ 空候选链也要说清（不留一片空白）', () => {
    const message = browserNotFoundMessage('win32', 'ZCODE_CHROME_PATH', { tried: [] })
    expect(message).toContain('没有产生任何候选路径')
  })

  it('★★ 省略 detail ⇒ 与修复前**逐字节相同**（老调用方不受影响）', () => {
    // 既有用例与库库AI 的调用点都只传前两个参数；输出必须不变。
    const withoutDetail = browserNotFoundMessage('win32')
    expect(withoutDetail).not.toContain('本进程看到的')
    expect(withoutDetail).toContain('可用 ZCODE_CHROME_PATH 显式指定 chrome.exe 路径')
    // Windows 文案必须提 Brave（候选链已补）。
    expect(withoutDetail).toContain('Brave')
  })
})

/**
 * **接线守卫**：`zcode-auth.ts` 的 catch 分支必须真的用上部署错误判据。
 *
 * ## ⚠️⚠️ 为什么这一格只能靠源码判据（如实登记）
 *
 * 该分支在 `CaptchaPool` 的 `mint` 回调闭包里，要真跑需要构造整个
 * `ZcodeAuth` + 池 + 浏览器替身，成本远高于收益（而那套编排另有
 * `zcode-captcha-guard.spec.ts` / `zcode-carrier-auth.spec.ts` 覆盖）。
 *
 * ## ⚠️ 但判据必须**锚定结构关系**，不能只查「有没有这个词」
 *
 * 本仓库记过：`expect(src).toContain('isBrowserDeploymentError')` 这类断言
 * 对「`if (false && isBrowserDeploymentError(error))`」**完全无感**
 * —— 实测确认过这个变异全绿。
 *
 * ⇒ 判据写成两条**位置关系**：
 * ① 部署错误分支必须 `throw error`（早退，不落到下面的计数）；
 * ② 该分支必须**出现在** `noteFailure()` 之前。
 */
describe('zcode-auth 的 catch 分支接线（IKQ4JN 根因②）', () => {
  const authPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'zcode-auth.ts')

  it('★★ 部署错误分支必须早退（`throw error`）且在 noteFailure **之前**', () => {
    const code = stripComments(readFileSync(authPath, 'utf8'))
    const branchAt = code.indexOf('isBrowserDeploymentError(error)')
    expect(branchAt, 'zcode-auth 的 catch 里没有部署错误分支').toBeGreaterThan(-1)
    const noteAt = code.indexOf('captchaBackoff.noteFailure()')
    expect(noteAt, '找不到 noteFailure 调用点（判据锚点失效）').toBeGreaterThan(-1)
    expect(
      branchAt,
      '部署错误分支必须在 noteFailure 之前 ⇒ 否则它照样会累计 streak',
    ).toBeLessThan(noteAt)
    // 分支体里必须有 `throw error`（早退），且它出现在 noteFailure 之前。
    const between = code.slice(branchAt, noteAt)
    expect(between, '部署错误分支没有 throw error ⇒ 会继续落到 noteFailure').toContain('throw error')
  })

  /**
   * ⚠️⚠️ **条件必须是精确等价，不是「禁几种假值前缀」**（对抗审计实测打穿）。
   *
   * 初版写 `/^\s*(?:false|0|''|""|null|undefined)\s*&&/` 只禁「假值常数 + `&&`」，
   * 而对抗审计实测**三种写法全部绕过**（判据全绿）：
   *
   * | 写法 | 后果 |
   * |---|---|
   * | `isBrowserDeploymentError(error) === false` | 分支永不执行 ⇒ 根因②修复整体失效**且**所有普通错误被误当部署错误而不计数 |
   * | `isBrowserDeploymentError(error) \|\| true` | **所有**错误都不计数/不冷却 ⇒ `CaptchaBackoff` 整道信誉护栏被静默拆除（最危险） |
   * | `isBrowserDeploymentError(error) && <恒假>` | 等价回归到修复前 |
   *
   * ⇒ 判据改成「**条件去掉外层空白后必须逐字等于** `isBrowserDeploymentError(error)`」，
   * 或它的合法取反 `!isBrowserDeploymentError(error)`（那种形态下分支语义相反，
   * 但**本仓库不这么写**，故一并禁止 —— 允许它只会给绕过留口子）。
   *
   * 这是「白名单」而不是「黑名单」：任何多余的运算符/常量都会让它变红。
   */
  it('★★ 部署错误分支的条件必须**精确**（禁所有绕过写法）', () => {
    const code = stripComments(readFileSync(authPath, 'utf8'))
    const guard = code.match(/if\s*\(([^()]*isBrowserDeploymentError\([^()]*\)[^()]*)\)/)
    expect(guard, '找不到部署错误分支的 if 条件（判据锚点失效）').not.toBeNull()
    const condition = guard![1]!.trim()
    /**
     * ⚠️ 白名单只有一种合法形态。多加 `=== false`、`|| true`、`&& …`、
     * 三元、`Boolean(...)` 包装等**全部变红**。
     * 分隔符统一按源码实际写法（`isBrowserDeploymentError(error)`）。
     */
    expect(
      condition,
      `部署错误分支的条件被改写了 ⇒ 根因②的修复可能整体失效、或信誉护栏被拆：if (${condition})`,
    ).toBe('isBrowserDeploymentError(error)')
  })

  it('★★ 对照：`noteFailure()` 仍**存在且未被注释掉**（护栏没被拆）', () => {
    const code = stripComments(readFileSync(authPath, 'utf8'))
    // ⚠️ 剥注释后仍有它 ⇒ 它不是在注释里（注释诱饵）。
    expect(code).toContain('captchaBackoff.noteFailure()')
    // 且不在 `if (false)` 之类的死条件里（本仓库反复记录的假绿形态）。
    expect(code).not.toMatch(/if\s*\(\s*false\s*\)[^\n]*noteFailure/)
  })
})

/**
 * **去重**：反推根与默认 `~/scoop` 是同一个目录时，候选链里只应出现一次。
 *
 * ## ⚠️ 为什么必须单独守（实测无牙）
 *
 * 实测：把 `sameAsDefault` 恒置 `false`（= 不去重）时，**全部 34 条用例仍全绿**。
 * 后果不是崩溃，而是：
 * - 「找不到浏览器」的报错里同一条路径**重复列出**（用户以为扫了两个地方）；
 * - 既有 `list.find(c => c.includes('scoop'))` 这类「取第一条」的判据，
 *   取到哪一条**取决于真实环境**（`zcode-browser-home-source` 两条用例
 *   就是这样变红的）。
 *
 * ⇒ 判据必须是**行为级**的「候选里不出现重复路径」，而不是源码里有没有那个变量。
 */
describe('反推根与默认根相同时去重（IKQ4JN）', () => {
  /** shims 与 scoop.cmd 都指向**家目录下**的 scoop（= 与 `~/scoop` 同一个根）。 */
  const homeScoopShims = (p: string): boolean =>
    p === 'C:\\Users\\me\\scoop\\shims\\scoop.cmd'

  it('★★ 同一个根只出现一次（否则报错里重复、既有判据取哪条依赖环境）', () => {
    const list = browserCandidates({
      platform: 'win32',
      env: { PATH: 'C:\\Users\\me\\scoop\\shims' },
      home: 'C:\\Users\\me',
      exists: homeScoopShims,
    })
    const scoopEntries = list.filter((p) => p.toLowerCase().includes('scoop'))
    expect(scoopEntries.length, `scoop 候选重复了：${scoopEntries.join(' | ')}`).toBe(1)
    expect(scoopEntries[0]).toBe('C:\\Users\\me\\scoop\\apps\\chromium\\current\\chrome.exe')
  })

  it('★ scoop 那两档不得重复（朴素但有效）', () => {
    /**
     * ⚠️ 只判 **scoop 那两档**，不判整条链。
     *
     * 整条链在「env 里没有任何 `PROGRAMFILES` / `LOCALAPPDATA`」时会天然产生
     * **相对路径重复**（`join('', …)` 得 `Google\Chrome\…`）：那是
     * `browserCandidates` 头部「坑 1」记录的**既有**形态，由
     * `findBrowserExecutable` 的 `isAbsolute` 过滤兜住，**不是**本 issue 的范围。
     * 把它写进断言会让本组在无关的既有行为上变红（实测踩到）。
     */
    const list = browserCandidates({
      platform: 'win32',
      env: { PATH: 'C:\\Users\\me\\scoop\\shims' },
      home: 'C:\\Users\\me',
      exists: homeScoopShims,
    })
    const scoopEntries = list.filter((p) => p.toLowerCase().includes('scoop'))
    expect(new Set(scoopEntries).size, `scoop 档有重复：${scoopEntries.join(' | ')}`)
      .toBe(scoopEntries.length)
  })

  it('★ 大小写 / 尾分隔符不同也算同一个根（Windows 语义）', () => {
    // `PATH` 里写成大写、且带尾反斜杠 —— 仍是同一个目录。
    const list = browserCandidates({
      platform: 'win32',
      env: { PATH: 'C:\\USERS\\ME\\SCOOP\\shims\\' },
      home: 'C:\\Users\\me',
      exists: (p) => p.toLowerCase() === 'c:\\users\\me\\scoop\\shims\\scoop.cmd',
    })
    expect(list.filter((p) => p.toLowerCase().includes('scoop')).length).toBe(1)
  })

  it('⚠️ 不同根时**两条都要保留**（去重不得误伤）', () => {
    const list = browserCandidates({
      platform: 'win32',
      env: { PATH: 'D:\\Other\\Scoop\\shims' },
      home: 'C:\\Users\\me',
      exists: (p) => p === 'D:\\Other\\Scoop\\shims\\scoop.cmd',
    })
    // ⚠️ 用 `toLowerCase()` 过滤：反推出来的根是**大小写混合**的
    //    （`D:\Other\Scoop` 里是大写 `S`），直接 `includes('scoop')` 会漏（实测踩到）。
    const scoopEntries = list.filter((p) => p.toLowerCase().includes('scoop'))
    expect(scoopEntries.length, '不同根被误去重 ⇒ 默认兜底丢了').toBe(2)
    expect(scoopEntries[0]).toContain('D:\\Other\\Scoop')
    expect(scoopEntries[1]).toContain('C:\\Users\\me\\scoop')
  })
})

/**
 * **冷却闸门不得自我放大**（对抗审计实测的 P0，IKQ4JN 附带修）。
 *
 * ## 实测的原始缺陷
 *
 * 闸门在 `ZcodeCaptchaBrowser` 内部，而调用侧的 catch 包住整个
 * `mintWithOutcome` ⇒ 闸门抛的普通 `Error` 流回 catch ⇒ `noteFailure()` 一次
 * ⇒ 冷却期内**每点一次，streak +1、冷却翻倍**。
 *
 * 实测：真失败 3 次进 60s 冷却后，用户再点 5 次（一次 mint 都没发出）
 * ⇒ streak 4→8、冷却 60s → 120 → 240 → 480 → 960 → **1800s**。
 */
describe('冷却闸门不得自我放大（IKQ4JN）', () => {
  it('★★ 冷却期内重复点击**不再累计** streak（否则 1 分钟被点成 30 分钟）', async () => {
    const { CaptchaBackoff, CaptchaCooldownError, isCaptchaCooldownError } =
      await import('../../src/captcha-backoff.js')
    const backoff = new CaptchaBackoff({ threshold: 3, baseMs: 60_000, maxMs: 1_800_000 })
    // 真失败 3 次 ⇒ 进 60s 冷却。
    for (let i = 0; i < 3; i++) backoff.noteFailure()
    const baseline = backoff.remainingMs()
    expect(baseline).toBeGreaterThan(0)
    // 冷却期内用户连点 5 次：闸门每次抛 CaptchaCooldownError。
    for (let i = 0; i < 5; i++) {
      const gateError = new CaptchaCooldownError('冷却中', backoff.remainingMs())
      // 与 zcode-auth 的 catch 同构：冷却错误**跳过**计数。
      if (!isCaptchaCooldownError(gateError)) backoff.noteFailure()
    }
    expect(backoff.failureStreak(), '冷却期内重复点击被计入 ⇒ streak 自我放大').toBe(3)
    expect(
      backoff.remainingMs(),
      '冷却被点成了更长时间（原始缺陷：60s → 1800s）',
    ).toBeLessThanOrEqual(baseline)
  })

  it('⚠️ `CaptchaCooldownError` 与普通 Error 可区分', async () => {
    const { CaptchaCooldownError, isCaptchaCooldownError } = await import('../../src/captcha-backoff.js')
    expect(isCaptchaCooldownError(new CaptchaCooldownError('x', 60_000))).toBe(true)
    expect(isCaptchaCooldownError(new Error('x'))).toBe(false)
    expect(isCaptchaCooldownError(null)).toBe(false)
    // ⚠️ 名字对但缺 remainMs ⇒ 不认（防第三方同名）。
    const impostor = Object.assign(new Error('x'), { name: 'CaptchaCooldownError' })
    expect(isCaptchaCooldownError(impostor)).toBe(false)
  })
})

/**
 * **`scoopRootFromPath` 必须与宿主平台无关**（对抗审计 P1 修法）。
 *
 * 缺陷原状：用了 `node:path` 的**默认导出**（跟随宿主）。在 Linux/macOS 上
 * `posix.basename('D:\\x\\shims')` 返回**整串**（反斜杠不是 POSIX 分隔符）
 * ⇒ 永不等于 `'shims'` ⇒ 本函数在非 Windows 宿主上**恒 undefined**。
 *
 * ⇒ 修法是改用 `win32.*`。这条用例的价值：**它在本机（无论什么平台）都成立**，
 * 所以 CI 换到 Linux 也不会静默失效。
 */
describe('scoop 路径解析与宿主平台无关（IKQ4JN）', () => {
  it('★★ Windows 风格路径在任何宿主上都解析正确', () => {
    // ⚠️ 断言的是「不管 process.platform 是什么，这个纯函数都给出同一答案」。
    expect(
      scoopRootFromPath(
        { PATH: 'D:\\System_Tools\\Scoop\\shims' },
        (p) => p === 'D:\\System_Tools\\Scoop\\shims\\scoop.cmd',
      ),
    ).toBe('D:\\System_Tools\\Scoop')
  })

  it('★ 尾分隔符 / 大小写 / 混合分隔符都认', () => {
    for (const path of [
      'D:\\System_Tools\\Scoop\\shims\\',   // 尾反斜杠
      'D:\\System_Tools\\Scoop\\SHIMS',     // 大写
      'D:\\System_Tools\\Scoop/shims',      // 混合分隔符
    ]) {
      expect(
        scoopRootFromPath({ PATH: path }, () => true),
        `${path} 未被识别`,
      ).toBe('D:\\System_Tools\\Scoop')
    }
  })
})

/**
 * **`detail.tried` 必须只列「真的会被尝试」的路径**（对抗审计 P1 修法）。
 *
 * `findBrowserExecutable()` 会跳过非绝对路径，而 `browserCandidates()` 原样返回
 * 它们（空环境变量会产生相对路径 —— `browserCandidates` 头部「坑 1」的既有形态）。
 * 若文案把相对路径也列进「已尝试」，用户会以为扫过那些位置。
 */
describe('报错里的「已尝试」必须是真的（IKQ4JN）', () => {
  it('★★ 生产抛错点必须按 `isAbsolute` 过滤后再回显', () => {
    const code = stripComments(readFileSync(sourcePath, 'utf8'))
    // 锚在**具体表达式**上：调用 browserNotFoundMessage 时 tried 经过过滤。
    expect(code, 'error message lists un-attempted relative candidates').toMatch(
      /tried:\s*browserCandidates\(\)\.filter\([\s\S]{0,80}?isAbsolute\(/,
    )
  })

  it('★ 相对路径候选确实存在（证明上面的过滤不是空谈）', () => {
    // 环境变量全空 ⇒ 候选里确实有相对路径。
    const list = browserCandidates({
      platform: 'win32',
      env: { PATH: '' },
      home: 'C:\\Users\\me',
      exists: () => false,
    })
    expect(
      list.some((p) => p.length > 0 && !isAbsolute(p)),
      '若这里为 false，说明过滤那一条已无必要，应删掉它并更新判据',
    ).toBe(true)
  })
})
