import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')))
const pending = ['index.js', 'client.js', 'vendor/channel-pack/pack.js'], visited = new Set()
const exported = file => pkg.files.some(entry => file === entry || file.startsWith(entry + '/'))
while (pending.length) {
  const relative = pending.pop()
  if (visited.has(relative)) continue
  visited.add(relative)
  assert.ok(exported(relative), `runtime export misses ${relative}`)
  const absolute = path.join(root, relative)
  assert.ok(fs.existsSync(absolute), `runtime dependency missing ${relative}`)
  if (!relative.endsWith('.js')) continue
  const source = fs.readFileSync(absolute, 'utf8')
  for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
    if (!fileName.startsWith('.')) continue
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), fileName))
    assert.ok(!target.startsWith('../'), `runtime dependency escapes package ${target}`)
    pending.push(target)
  }
}
for (const relative of ['customization-contract.json', 'vendor/channel-pack/qoder-auth-wasm.wasm', 'src/benchmark.js', 'src/host-channels.js']) {
  assert.ok(exported(relative) && fs.existsSync(path.join(root, relative)), `required custom resource ${relative}`)
}
console.log(JSON.stringify({ passed: true, reachableRuntimeFiles: visited.size, checkedFiles: [...visited].sort(), runtimeExport: pkg.files }))
