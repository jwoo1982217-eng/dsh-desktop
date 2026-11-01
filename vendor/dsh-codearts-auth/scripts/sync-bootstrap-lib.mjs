// 把构建产物（`lib/`）同步进 bootstrap / standalone 发布目录。
//
// ## 为什么需要这一步（2026-10-24 事故）
//
// `tsc` 的 outDir 是 `lib/`，客户端 esbuild 也输出到 `lib/client/jet-hub.js`，
// 但发布产物在 `dist/bootstrap/dsh-providers-hub-*/plugin/lib/` —— **两者之间没有
// 任何脚本负责同步**。结果是：`npm run build:all` 显示成功（exit 0），产物却一直
// 停留在上一次手工拷贝的时间（实测停了 2 天）。
//
// 更糟的是它没有显而易见的表现：打增量包时 `build-incremental.mjs` 会照常从产物
// 目录取文件，打出一个**看起来成功、实际不含任何新代码**的包。这次就是这样打出了
// 一个只含客户端的 686 KB 包，而服务端改动全在里面缺席。
//
// ## 覆盖范围
//
// 递归同步 `lib/` 下**全部**文件。之所以敢全量覆盖，是因为客户端 bundle 也是先写
// `lib/client/jet-hub.js`、再由本脚本搬过去的 —— 不存在「产物里有、lib 里没有的
// 独特文件」（那条假设已核对：反向差异为 0）。
//
// ⚠️ **只新增与覆盖，绝不删除**：产物里可能有历史遗留文件，误删的代价远大于残留。
// 若 `lib/` 里删掉了某个模块，产物会残留一份旧文件，这种情况在输出里提示。
//
// ⚠️ 2026-10-31 审计（P1）：standalone 产物是同一个事故的敞口 —— 它的插件 lib 在
//    `dist/standalone/dsh-providers-hub-*/home/profiles/<profile>/node_modules/<plugin>/lib/`
//    （布局见 build-standalone.mjs 的「组装 profile」一节），此前完全不在覆盖范围。
//    现已纳入同一遍历，语义与 bootstrap 相同：只新增与覆盖、绝不删除。
//
// ## 产物目录缺失时
//
// 首次构建（还没跑过 `service.bat package -Mode bootstrap`）时 `dist/bootstrap`
// 不存在 —— 那是**正常**情况，打印提示并以 0 退出，不阻断构建。
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')

const SRC = resolve(packageRoot, 'lib')
const BOOTSTRAP_ROOT = resolve(packageRoot, 'dist/bootstrap')
const STANDALONE_ROOT = resolve(packageRoot, 'dist/standalone')
const BUNDLE_PREFIX = 'dsh-providers-hub-'

/** 递归列出 `dir` 下所有文件的绝对路径。 */
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** 定位 bootstrap 产物里的 `plugin/lib` 目录；找不到返回 undefined。 */
function pluginLibOf(bundleDir) {
  const candidate = join(bundleDir, 'plugin', 'lib')
  return existsSync(candidate) ? candidate : undefined
}

/**
 * 定位 standalone 产物里每个 profile 的插件 lib 目录。
 * 布局（build-standalone.mjs「组装 profile」）：
 *   home/profiles/<profile>/node_modules/<plugin>/lib/
 * 产物可能带多个 profile（如 prod / dev），全部纳入。
 */
async function standalonePluginLibsOf(bundleDir) {
  const profilesDir = join(bundleDir, 'home', 'profiles')
  if (!existsSync(profilesDir)) return []
  const out = []
  for (const entry of await readdir(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(profilesDir, entry.name, 'node_modules', 'dsh-providers-hub', 'lib')
    if (existsSync(candidate)) out.push(candidate)
  }
  return out
}

async function syncLibDir(label, dest, sources) {
  let copied = 0
  let skipped = 0
  for (const from of sources) {
    const rel = relative(SRC, from)
    const to = join(dest, rel)
    await mkdir(dirname(to), { recursive: true })
    // 尺寸 + 修改时间都相同 ⇒ 没变，跳过（避免无谓写盘、也让统计有意义）。
    if (existsSync(to)) {
      const [a, b] = await Promise.all([stat(from), stat(to)])
      if (a.size === b.size && a.mtimeMs === b.mtimeMs) { skipped++; continue }
    }
    await copyFile(from, to)
    copied++
  }

  // 残留检查：产物里有、lib 里没有的文件（不删，只报告）。
  const srcRel = new Set(sources.map((f) => relative(SRC, f)))
  const stale = (await walk(dest))
    .map((f) => relative(dest, f))
    .filter((rel) => !srcRel.has(rel))

  return { label, total: sources.length, copied, skipped, stale }
}

async function syncBundle(bundleDir) {
  const dest = pluginLibOf(bundleDir)
  if (dest === undefined) {
    console.log(`[sync] 跳过（无 plugin/lib）：${relative(packageRoot, bundleDir)}`)
    return undefined
  }
  const r = await syncLibDir(relative(packageRoot, bundleDir), dest, await walk(SRC))

  // ⚠️ 2026-10-31 审计（P1）：bootstrap 产物在目标机 install.cmd 后才长出
  //    home/profiles；打包机上一般没有 —— 那不是遗漏，不提示。
  return [r]
}

async function syncStandaloneBundle(bundleDir) {
  const libs = await standalonePluginLibsOf(bundleDir)
  if (libs.length === 0) {
    console.log(`[sync] 跳过（standalone 产物里没有插件 lib）：${relative(packageRoot, bundleDir)}`)
    return undefined
  }
  const sources = await walk(SRC)
  const results = []
  for (const dest of libs) {
    // 同样「只新增与覆盖，绝不删除」；路径深一层，判据与 bootstrap 完全一致。
    results.push(await syncLibDir(relative(packageRoot, dest), dest, sources))
  }
  return results
}

async function syncRoot(rootDir, kind, syncFn) {
  if (!existsSync(rootDir)) {
    console.log(`[sync] 未找到 ${relative(packageRoot, rootDir)} —— 首次构建属正常，跳过 ${kind} 同步。`)
    return 0
  }
  const bundles = (await readdir(rootDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith(BUNDLE_PREFIX))
    .map((e) => join(rootDir, e.name))

  if (bundles.length === 0) {
    console.log(`[sync] ${relative(packageRoot, rootDir)} 下没有 ${BUNDLE_PREFIX}* 目录，跳过 ${kind} 同步。`)
    return 0
  }
  if (bundles.length > 1) {
    console.log(`[sync] 注意：${kind} 发现 ${bundles.length} 个产物目录，将全部同步。`)
  }

  let totalCopied = 0
  for (const bundle of bundles) {
    const r = await syncFn(bundle)
    if (r === undefined) continue
    for (const item of (Array.isArray(r) ? r : [r])) {
      if (item === undefined) continue
      totalCopied += item.copied
      console.log(`[sync] ${item.label}：更新 ${item.copied}，未变 ${item.skipped}（共 ${item.total}）`)
      if (item.stale.length > 0) {
        console.log(`       残留 ${item.stale.length} 个 lib 中已不存在的文件（未删除）：`
          + item.stale.slice(0, 5).join(', ') + (item.stale.length > 5 ? ' …' : ''))
      }
    }
  }
  return totalCopied
}

async function main() {
  if (!existsSync(SRC)) throw new Error(`缺少构建产物 ${SRC} —— 先跑 tsc`)

  const bootstrapCopied = await syncRoot(BOOTSTRAP_ROOT, 'bootstrap', syncBundle)
  const standaloneCopied = await syncRoot(STANDALONE_ROOT, 'standalone', syncStandaloneBundle)
  const totalCopied = bootstrapCopied + standaloneCopied

  console.log(`[sync] done. 共更新 ${totalCopied} 个文件。`)
  if (totalCopied === 0) console.log('       （全部已是最新 —— 若刚改过 src，请确认 tsc 已跑）')
}

await main()
