#!/usr/bin/env node
//
// local-agent.mjs —— 本地执行器：让 AI 通过 OpenAI 兼容网关**直接读写你本机的项目文件**。
//
// 原理：模型不碰文件，只输出 tool_calls；真正落盘由本进程完成。
//       所以项目**不需要上传**，但被读写的文件内容会进入模型上下文（→ 见 README 的数据边界说明）。
//
// 用法：
//   node scripts/local-agent.mjs --root D:\code\app --task "把 src/config.ts 里的 port 改成 8080"
//   node scripts/local-agent.mjs --root D:\code\app --task "..." --allow-write
//   node scripts/local-agent.mjs --root D:\code\app --task "..." --allow-write --allow-run
//
// 参数：
//   --gateway <url>   网关地址，默认 http://127.0.0.1:8326
//   --key <key>       Bearer 密钥；默认从 <DSH_HOME>/openai-gateway/api-key 读
//   --model <name>    模型 id，默认取 /v1/models 的第一个
//   --root <dir>      项目根（必填）。所有路径都被限制在这个根之内
//   --task <text>     要 AI 做的事（必填）
//   --allow-write     允许修改/新建/删除文件（默认只读）
//   --allow-run       允许执行白名单内的 npm 脚本（默认禁止）
//   --max-rounds <n>  tool 循环上限，默认 20
//   --dry-run         只打印将要写的改动，不真正落盘
//
// 安全红线（硬编码，不提供开关）：
//   * 路径必须落在 --root 之内（对已存在部分 realpath 后校验，Windows 大小写不敏感；
//     目标尚不存在时上溯最近存在祖先做 realpath、接回剩余词法段后重校验）
//   * fs_write 拒绝以 symlink/junction 为目标；fs_delete 只删文件或空目录（不递归）
//   * .env* / *.pem / *.key / id_rsa* / *.pfx / .npmrc / credentials* 一律拒绝读写
//   * node_modules / dist / .git 等目录不扫描、不允许写
//   * 写文件必须带 expectSha256，不匹配即拒绝（防覆盖用户手改）
//   * 只允许 npm run build|test|lint|typecheck；不允许任意 shell

import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = {
    gateway: 'http://127.0.0.1:8326',
    key: '',
    model: '',
    root: '',
    task: '',
    allowWrite: false,
    allowRun: false,
    maxRounds: 20,
    dryRun: false,
    yes: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--gateway': out.gateway = next().replace(/\/+$/, ''); break
      case '--key': out.key = next(); break
      case '--model': out.model = next(); break
      case '--root': out.root = next(); break
      case '--task': out.task = next(); break
      case '--allow-write': out.allowWrite = true; break
      case '--allow-run': out.allowRun = true; break
      case '--max-rounds': out.maxRounds = Number(next()); break
      case '--dry-run': out.dryRun = true; break
      case '--yes': case '-y': out.yes = true; break
      case '--help': case '-h':
        console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 27).join('\n').replace(/^\/\/ ?/gm, ''))
        process.exit(0)
      default:
        if (a.startsWith('--')) throw new Error(`未知参数: ${a}`)
    }
  }
  if (!out.root) throw new Error('缺少 --root <项目目录>')
  if (!out.task) throw new Error('缺少 --task "<要 AI 做的事>"')
  return out
}

// ⚠️ 顶层 await 抛出的错误若无人接住，Node 在 Windows 上会触发 libuv 断言
//    （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），把真实错误埋掉。
process.on('unhandledRejection', (error) => {
  console.error(`\n[agent][error] ${error?.message ?? error}`)
  process.exit(1)
})

const args = parseArgs(process.argv.slice(2))
const ROOT = resolve(args.root)
if (!existsSync(ROOT)) throw new Error(`项目目录不存在: ${ROOT}`)

if (!args.key) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const keyFile = join(home, 'openai-gateway', 'api-key')
  if (existsSync(keyFile)) args.key = readFileSync(keyFile, 'utf8').trim()
}
if (!args.key) throw new Error('缺少 --key，且未找到 openai-gateway/api-key')

// ---------------------------------------------------------------- 安全边界

const SENSITIVE = [
  /^\.env/i, /\.pem$/i, /\.key$/i, /^id_rsa/i, /\.pfx$/i, /\.npmrc$/i, /^credentials/i, /\.p12$/i,
]
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.git', 'coverage',
  '.cache', '.venv', 'venv', '__pycache__', '.idea', '.vs', 'target',
])

class Denied extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.code = code
  }
}

/** ROOT 的真实路径（realpath 后再小写，供下面前缀比较；ROOT 在启动时已确认存在）。 */
const ROOT_REAL = realpathSync(ROOT).toLowerCase()

/** 逐段检查剩余词法段（不落盘），判据与调用方保持同一套 SKIP_DIRS / SENSITIVE。 */
function lexicalCheck(abs, orig) {
  // ⚠️ Windows 路径大小写不敏感，比较必须归一化，否则 C:\App 与 c:\app 会绕开前缀判断
  const rel = relative(ROOT.toLowerCase(), abs.toLowerCase())
  if (rel === '..' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Denied('path_outside_root', orig)
  }
  if (rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg.toLowerCase()))) {
    throw new Denied('skipped_dir', orig)
  }
  if (SENSITIVE.some((re) => re.test(basename(abs)))) throw new Denied('sensitive_file', orig)
}

/**
 * 把用户/模型给的相对路径解析成绝对路径，并校验必须落在 ROOT 内。
 *
 * ⚠️ 2026-10-31 审计（P0）：仅做词法检查挡不住 symlink / NTFS junction ——
 *    模型可以 fs_write 新建一个指向根外的链接再要求写穿，fs_read/fs_write/fs_delete
 *    都会落到根外。因此必须对「真实落盘会经过的每个存在路径」做 realpath 后重校验：
 *    - 目标本身存在：对它做 realpath（跟随链接）后校验 —— 穿过链接到达的终点必须在根内；
 *    - 目标尚不存在（写场景）：上溯到最近存在的祖先做 realpath，再把剩余词法段接回，
 *      然后对拼接结果重做词法校验。真实创建发生在祖先内部，不存在任何中间目录
 *      被解析到根外的问题；祖先本身已过 realpath 校验。
 *    - 同时用 lstat 拒绝「路径上的任何存在段自身是链接」（见 isLinkUnsafe）。
 */
function safePath(p) {
  if (typeof p !== 'string' || p === '') throw new Denied('bad_path', '空路径')
  if (/^[a-zA-Z]:/.test(p) || isAbsolute(p)) throw new Denied('bad_path', '只接受相对路径')
  const abs = resolve(ROOT, p)
  lexicalCheck(abs, p)
  // 已存在的目标：realpath（跟随链接）后整体重校验 —— 链接指向根外时这里拒绝。
  if (existsSync(abs)) {
    lexicalCheck(realpathSync(abs).toLowerCase(), p)
    return abs
  }
  // 目标尚不存在（典型是 fs_write 的新文件）：上溯最近存在的祖先。
  let existing = dirname(abs)
  while (existing !== dirname(existing) && !existsSync(existing)) {
    existing = dirname(existing)
  }
  if (existing === dirname(existing)) throw new Denied('bad_path', `无法定位已存在的祖先目录: ${p}`)
  // 最近存在祖先的 realpath 必须落在根内（根的祖先也可能是链接，如 subst 盘符）。
  if (!realpathSync(existing).toLowerCase().startsWith(ROOT_REAL)) {
    throw new Denied('path_outside_root', p)
  }
  // 祖先之内不会再被解析改写，接回剩余词法段后重校验即可。
  lexicalCheck(join(realpathSync(existing), relative(existing, abs)).toLowerCase(), p)
  return abs
}

function sha256OfFile(file) {
  if (!existsSync(file)) return ''
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 路径上任何**存在**的段（含目标本身与中间目录）都不能自身是 symlink / junction。
 *
 * ⚠️ 2026-10-31 审计（P0）：lstat 逐段检查 —— 中间目录是链接而终点合法的情况
 *    （如 root/data -> 别处）同样要拒绝，只查 basename 或只查终点都挡不住。
 *    读/list 也一并收紧：穿透链接读取根外文件与写穿是同一类逃逸。
 */
function assertNoLinkOnPath(abs, orig) {
  let cur = abs
  while (cur !== dirname(cur)) {
    if (existsSync(cur)) {
      const st = lstatSync(cur)
      if (!st.isDirectory() && !st.isFile() && !st.isSymbolicLink()) throw new Denied('bad_path', orig)
      if (st.isSymbolicLink()) throw new Denied('symlink_target', `${orig}（路径含符号链接/junction）`)
    }
    cur = dirname(cur)
  }
}

// ---------------------------------------------------------------- 工具实现

function toolList({ path = '.', depth = 2 }) {
  const dir = safePath(path)
  assertNoLinkOnPath(dir, path)
  if (!existsSync(dir)) throw new Denied('not_found', path)
  if (!statSync(dir).isDirectory()) throw new Denied('not_a_directory', path)

  const walk = (d, left) => {
    const entries = []
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SENSITIVE.some((re) => re.test(e.name))) continue
      const rel = relative(ROOT, join(d, e.name)).split('\\').join('/')
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) {
          entries.push({ path: rel, type: 'dir', skipped: true })
          continue
        }
        entries.push({ path: rel, type: 'dir' })
        if (left > 1) entries.push(...walk(join(d, e.name), left - 1))
      } else {
        entries.push({ path: rel, type: 'file', size: statSync(join(d, e.name)).size })
      }
    }
    return entries
  }
  return { root: basename(ROOT), entries: walk(dir, Math.min(Math.max(depth, 1), 3)) }
}

function toolRead({ path, maxBytes = 2_000_000 }) {
  const file = safePath(path)
  assertNoLinkOnPath(file, path)
  if (!existsSync(file)) throw new Denied('not_found', path)
  const st = statSync(file)
  if (!st.isFile()) throw new Denied('not_a_file', path)
  if (st.size > maxBytes) {
    return { path, size: st.size, truncated: true, sha256: sha256OfFile(file), content: '' }
  }
  const buf = readFileSync(file)
  const isBinary = buf.includes(0)
  return {
    path,
    size: st.size,
    sha256: createHash('sha256').update(buf).digest('hex'),
    encoding: isBinary ? 'base64' : 'utf8',
    content: isBinary ? buf.toString('base64') : buf.toString('utf8'),
  }
}

async function confirm(question) {
  if (args.yes) return true
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((r) => rl.question(question, r))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

async function toolWrite({ path, content, expectSha256, createIfMissing = false }) {
  const file = safePath(path)
  assertNoLinkOnPath(dirname(file), path)
  // ⚠️ 2026-10-31 审计（P0）：目标自身若是 symlink/junction，rename 会整链接替换、
  //    或写入穿透到根外 —— 在落盘前用 lstat 显式拒绝（safePath 的 realpath 只挡
  //    「链接已指向根外」；「把合法文件替换成链接」这条要在这里挡）。
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new Denied('symlink_target', `${path}（目标是符号链接/junction）`)
  }
  const before = sha256OfFile(file)
  if (before !== '' && before !== expectSha256) {
    throw new Denied('conflict', `文件已被改动（当前 ${before.slice(0, 8)}，期望 ${String(expectSha256).slice(0, 8)}）`)
  }
  if (before === '' && expectSha256 !== '') throw new Denied('conflict', '期望旧哈希但文件不存在')
  if (before === '' && !createIfMissing) throw new Denied('not_found', `${path}（新建需 createIfMissing=true）`)
  if (!args.allowWrite) throw new Denied('permission', '未开启 --allow-write')

  const preview = `${before === '' ? '新建' : '覆盖'} ${path} (${Buffer.byteLength(content, 'utf8')} bytes)`
  if (args.dryRun) return { path, dryRun: true, preview }
  if (!(await confirm(`  ${preview}\n  允许写入？[y/N] `))) throw new Denied('user_rejected', path)

  // ⚠️ 原子写：先写同目录临时文件再 rename，避免半截文件
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}`)
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
  return { path, written: true, sha256: sha256OfFile(file) }
}

function toolDelete({ path }) {
  const file = safePath(path)
  assertNoLinkOnPath(dirname(file), path)
  if (!existsSync(file)) throw new Denied('not_found', path)
  if (!args.allowWrite) throw new Denied('permission', '未开启 --allow-write')
  if (args.dryRun) return { path, dryRun: true, preview: `删除 ${path}` }
  if (lstatSync(file).isSymbolicLink()) throw new Denied('symlink_target', `${path}（目标是符号链接/junction）`)
  const st = statSync(file)
  // ⚠️ 2026-10-31 审计（P0）：与 fs_delete 的 schema 声明对齐 —— 只删「文件或空目录」。
  //    旧实现 recursive:true 会整目录树删除，配合 symlink 可删掉根外的任意目录树。
  if (st.isDirectory()) {
    if (readdirSync(file).length > 0) throw new Denied('not_empty', `${path}（只允许删除文件或空目录）`)
    rmdirSync(file)
  } else if (st.isFile()) {
    rmSync(file, { force: true })
  } else {
    throw new Denied('not_a_file', path)
  }
  return { path, deleted: true }
}

const RUNNABLE = new Set(['build', 'test', 'lint', 'typecheck'])

function toolRun({ name }) {
  if (!args.allowRun) throw new Denied('permission', '未开启 --allow-run')
  if (!RUNNABLE.has(name)) throw new Denied('not_in_allowlist', `只允许 ${[...RUNNABLE].join('/')}`)
  if (args.dryRun) return { name, dryRun: true }
  const r = spawnSync('npm', ['run', name], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000, shell: process.platform === 'win32',
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { name, exitCode: r.status, truncated: out.length > 65_536, output: out.slice(-65_536) }
}

// ---------------------------------------------------------------- tool schema

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'fs_list',
      description: '列出项目内的目录条目（相对路径）。node_modules/dist 等会被标记 skipped。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对项目根的路径，默认 "."' },
          depth: { type: 'integer', description: '递归层数 1-3，默认 2' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_read',
      description: '读取项目内一个文本文件，返回内容 + sha256（写回时必须用它作为 expectSha256）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          maxBytes: { type: 'integer', description: '默认 2000000' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_write',
      description: '原子写入一个文件。必须提供读取时拿到的 sha256；新建文件传空串并把 createIfMissing 设为 true。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          expectSha256: { type: 'string' },
          createIfMissing: { type: 'boolean' },
        },
        required: ['path', 'content', 'expectSha256'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_delete',
      description: '删除项目内的文件或空目录（需 --allow-write）。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_script',
      description: '执行 package.json 里的白名单脚本（build/test/lint/typecheck，需 --allow-run）。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', enum: [...RUNNABLE] } },
        required: ['name'],
      },
    },
  },
]

async function execTool(name, rawArgs) {
  const a = rawArgs ? JSON.parse(rawArgs) : {}
  switch (name) {
    case 'fs_list': return toolList(a)
    case 'fs_read': return toolRead(a)
    case 'fs_write': return await toolWrite(a)
    case 'fs_delete': return toolDelete(a)
    case 'run_script': return toolRun(a)
    default: throw new Denied('unknown_tool', name)
  }
}

// ---------------------------------------------------------------- 网关交互

async function post(path, body) {
  const res = await fetch(`${args.gateway}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.key}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`网关 ${res.status}: ${text.slice(0, 500)}`)
  return JSON.parse(text)
}

async function fetchModels() {
  const res = await fetch(`${args.gateway}/v1/models`, { headers: { authorization: `Bearer ${args.key}` } })
  if (!res.ok) throw new Error(`/v1/models 失败 ${res.status}`)
  const data = await res.json()
  return (data.data ?? []).map((m) => m.id).filter(Boolean)
}

async function pickModel() {
  if (args.model) return args.model
  const ids = await fetchModels()
  if (ids.length === 0) throw new Error('网关未返回任何模型')
  // ⚠️ /v1/models 里混着 DSH 内置 provider（deepseek-official/*，需要 DEEPSEEK_API_KEY），
  //    直接取第一个会 502 MISSING_CREDENTIAL。优先用插件的聚合路由，其次跳过内置 provider。
  return ids.find((i) => i.startsWith('jet-hub-auto/'))
    ?? ids.find((i) => !i.startsWith('deepseek-official/'))
    ?? ids[0]
}

// ---------------------------------------------------------------- 主循环

const model = await pickModel()
console.log(`[agent] gateway = ${args.gateway}`)
console.log(`[agent] model   = ${model}`)
console.log(`[agent] root    = ${ROOT}`)
console.log(`[agent] 权限    = 读${args.allowWrite ? '+写' : ''}${args.allowRun ? '+执行' : ''}`)
console.log('')

const messages = [
  {
    role: 'system',
    content: [
      '你是一个可以直接操作系统文件的编程助手。',
      '必须通过提供的工具读写文件，不要凭记忆猜测文件内容。',
      '修改文件前先用 fs_read 取得最新内容与 sha256，写回时把该 sha256 作为 expectSha256。',
      '只改需要改的最小范围，保持其它字节不变。',
      '路径一律使用相对项目根的 POSIX 风格路径（如 src/config.ts）。',
      '如果工具返回 DENIED，不要重试同一操作，改为向用户说明限制。',
    ].join('\n'),
  },
  { role: 'user', content: args.task },
]

for (let round = 1; round <= args.maxRounds; round += 1) {
  const data = await post('/v1/chat/completions', {
    model,
    messages,
    tools: TOOLS,
    tool_choice: 'auto',
    temperature: 0,
  })

  const msg = data.choices?.[0]?.message
  if (!msg) throw new Error('网关返回缺少 choices[0].message')
  messages.push(msg)

  const calls = (msg.tool_calls ?? []).filter((c) => c?.function?.name)
  if (calls.length === 0) {
    console.log('[done] ' + (msg.content ?? '').trim())
    break
  }

  for (const call of calls) {
    const { name, arguments: rawArgs } = call.function
    let result
    try {
      result = await execTool(name, rawArgs)
      console.log(`  [${name}] ✓ ${rawArgs ?? ''}`)
    } catch (error) {
      result = { error: error.code ?? 'failed', message: error.message }
      console.log(`  [${name}] ✗ ${error.message}`)
    }
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
  }
  console.log('')
}
