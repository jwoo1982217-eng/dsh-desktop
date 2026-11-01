import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateCustomizationSource, inheritCustomizationContract } from '../src/customization-guard.js'
const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(root, '.customization-test-'))
const contract = JSON.parse(fs.readFileSync(path.join(root, 'customization-contract.json')))
const files = new Set(['customization-contract.json', 'client.js', 'index.js', 'vendor/channel-pack/pack.js', 'src/updater.js', ...Object.keys(contract.criticalFiles), ...(contract.requiredCapabilities ?? []).flatMap(row => row.checks.map(check => check.file))])
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const before = Object.fromEntries([...files].map(file => [file, hash(fs.readFileSync(path.join(root, file)))]))
const restore = file => { const dest = path.join(scratch, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(root, file), dest) }
try {
  files.forEach(restore)
  assert.equal(validateCustomizationSource(root).managed, true)
  assert.equal(inheritCustomizationContract(root, scratch).managed, true)
  const pack = path.join(scratch, 'vendor/channel-pack/pack.js')
  fs.writeFileSync(pack, fs.readFileSync(pack, 'utf8').replaceAll('"codely"', '"lost-codely"').replaceAll("'codely'", "'lost-codely'"))
  assert.throws(() => inheritCustomizationContract(root, scratch), /codely|vendor\/channel-pack\/pack\.js/)
  restore('vendor/channel-pack/pack.js')
  const client = path.join(scratch, 'client.js')
  fs.writeFileSync(client, fs.readFileSync(client, 'utf8').replace('    function useChannelRpc(', '    function lostChannelRpc('))
  assert.throws(() => inheritCustomizationContract(root, scratch), /useChannelRpc|client\.js/)
  restore('client.js')
  for (const capability of contract.requiredCapabilities ?? []) {
    const check = capability.checks[0]
    const filename = path.join(scratch, check.file)
    fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replaceAll(check.markers[0], 'lost-owner-capability'))
    assert.throws(() => inheritCustomizationContract(root, scratch), /定制功能保护/)
    restore(check.file)
  }
  fs.unlinkSync(path.join(scratch, 'customization-contract.json'))
  assert.throws(() => inheritCustomizationContract(root, scratch), /缺少已审核的定制契约/)
  restore('customization-contract.json')
  assert.equal(inheritCustomizationContract(root, scratch).managed, true)
  assert.deepEqual(Object.fromEntries([...files].map(file => [file, hash(fs.readFileSync(path.join(root, file)))])), before)
  console.log('customization-contract: source and compatible target accepted; missing channel/mobile hook/contract rejected before writes; exact restoration accepted; installed bytes unchanged')
} finally { fs.rmSync(scratch, { recursive: true, force: true }) }
