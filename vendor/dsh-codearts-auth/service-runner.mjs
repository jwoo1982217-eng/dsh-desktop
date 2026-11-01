// service-runner.mjs —— Windows 服务的进程包装器。
//
// 为什么需要它：NSSM 把 Application / AppParameters 原样拼成命令行交给
// CreateProcess，参数里的引号在 cmd 解析层就会被剥掉，于是
// `C:\Program Files\nodejs\node.exe` 或带空格的脚本路径会被拆成两截。
// 这里把「程序 + 参数 + 工作目录 + 环境变量」放进同目录的 service.conf
// （纯文本 key=value），由本包装器用 spawn 精确还原 argv —— 没有任何引号转义问题。
//
// service.conf 格式（由 service.bat 生成，手工改完执行 service.bat restart 生效）：
//
//   program=C:\Program Files\nodejs\node.exe
//   args="C:\path with space\bin.js" --profile prod --no-open
//   cwd=C:\ProgramData\dsh-providers-hub\home\profiles\prod
//   env.DSH_HOME=C:\ProgramData\dsh-providers-hub\home
//   env.DSH_OPENAI_GATEWAY_PORT=8326
//
// 以 # 开头的行与空行会被忽略；args 之后的字符串按 shell 风格切分（支持双引号）。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 把 service.conf 解析成 { program, args, cwd, env }。 */
function parseConf(text) {
  const conf = { program: '', args: '', cwd: '', env: {} }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'program') conf.program = value
    else if (key === 'args') conf.args = value
    else if (key === 'cwd') conf.cwd = value
    else if (key.startsWith('env.')) conf.env[key.slice(4)] = value
  }
  return conf
}

/** shell 风格切分：空白分隔，双引号内的空白保留，引号本身不进入结果。 */
function tokenize(text) {
  const out = []
  let current = ''
  let quoted = false
  let started = false
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (started) {
        out.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) out.push(current)
  return out
}

let conf
try {
  conf = parseConf(readFileSync(join(here, 'service.conf'), 'utf8'))
} catch (error) {
  console.error(`[service-runner] 读取 service.conf 失败: ${error.message}`)
  process.exit(78)
}

if (conf.program === '') {
  console.error('[service-runner] service.conf 缺少 program')
  process.exit(78)
}

const cwd = conf.cwd !== '' && existsSync(conf.cwd) ? conf.cwd : here
const args = tokenize(conf.args)
console.log(`[service-runner] 启动: ${conf.program} ${args.join(' ')}`)
console.log(`[service-runner] 工作目录: ${cwd}`)

const child = spawn(conf.program, args, {
  cwd,
  env: { ...process.env, ...conf.env },
  stdio: 'inherit',
  windowsHide: true,
})

child.on('error', (error) => {
  console.error(`[service-runner] 启动失败: ${error.message}`)
  process.exit(69)
})

child.on('exit', (code, signal) => {
  console.log(`[service-runner] 子进程退出 code=${code} signal=${signal}`)
  process.exit(code === null ? (signal ? 1 : 0) : code)
})

// 服务停止时，NSSM 结束本进程；这里把信号先转给子进程，让它有机会正常收尾。
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    try {
      child.kill(signal)
    } catch {
      // 子进程可能已退出，忽略。
    }
  })
}
