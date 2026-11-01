/** Offline mount with the real desktop/phone Cordis and LLM SDK classes. */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url)), sdk = process.argv[2]
assert.ok(sdk, 'SDK node_modules required')
const req = createRequire(path.join(sdk, '__ofm_sdk_mount__.cjs'))
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) return { url: pathToFileURL(req.resolve(specifier)).href, shortCircuit: true }
  return next(specifier, context)
} })
const scratch = fs.mkdtempSync(path.join(root, '.sdk-mount-'))
Object.assign(process.env, { DSH_HOME: scratch, DSH_CHANNEL_PACK_STATE_DIR: scratch, DSH_OPENAI_GATEWAY_ENABLED: '0', DSH_UNIT_TEST_NO_WREQ: '1', QODER_RUNTIME_INFO: path.join(scratch, 'missing-runtime.exe'), QODER_MACHINE_TOKEN_PATH: path.join(scratch, 'missing-machine.json'), CODEARTS_MODELS_CACHE_DIR: scratch, AUTOCLAW_APPDATA: path.join(scratch, 'autoclaw'), AUTOCLAW_LOCAL_APPDATA: path.join(scratch, 'autoclaw-local'), DSH_OFFICEACE_HOME: path.join(scratch, 'officeace') })
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key]
const savedFetch = globalThis.fetch
let calls = 0, writes = 0
const blocked = []
const disposers = [], routes = [], settings = new Map()
let adapters
try {
  globalThis.fetch = async input => { calls++; blocked.push(new URL(String(input)).origin + new URL(String(input)).pathname); throw new Error('upstream network disabled in real SDK mount') }
  const { Context } = await import('@deepseek-ai/cordis')
  const { LlmRuntime } = await import('@deepseek-ai/dsh-llm')
  const ctx = new Context()
  Object.assign(ctx, { logger: { info() {}, warn() {}, debug() {}, error() {} }, effect: setup => { const result = setup(); const cleanup = typeof result === 'function' ? [result] : result && typeof result[Symbol.iterator] === 'function' ? [...result].filter(row => typeof row === 'function') : []; disposers.push(...cleanup); return () => { for (const callback of cleanup.reverse()) callback() } } })
  ctx.provide('profileContext', { home: scratch })
  ctx.provide('settings', { register: namespace => ({ get: () => settings.get(namespace), replace: value => settings.set(namespace, value) }), describe: () => [] })
  ctx.provide('credentials', { resolve: async () => undefined, describe: async () => undefined, set: async () => { writes++; throw new Error('unexpected credential write') }, unset: async () => { writes++; throw new Error('unexpected credential deletion') } })
  const llm = new LlmRuntime(ctx)
  adapters = llm.adapters
  ctx.provide('connection', { fetch: { register: route => routes.push(route) } })
  const pack = await import('../vendor/channel-pack/pack.js')
  pack.apply(ctx, { disableOpencode: true })
  for (let i = 0; i < 10 && !routes.some(row => row.path === '/api/channel-pack'); i++) await new Promise(resolve => setTimeout(resolve, 10))
  const required = JSON.parse(fs.readFileSync(path.join(root, 'customization-contract.json'))).requiredProviders
  for (const id of [...required, 'aggregate', 'channel-pack-auto']) assert.ok(adapters.has(id), `real SDK adapter ${id}`)
  assert.ok(!adapters.has('opencode'))
  const route = routes.find(row => row.path === '/api/channel-pack'); assert.ok(route, 'real management RPC registered')
  const response = await route.fetch(new Request('http://localhost/api/channel-pack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'real-sdk', method: 'channel-pack', payload: { method: 'provider.status', payload: { providers: required } } }) }))
  const result = (await response.json()).result; assert.equal(result.ok, true)
  for (const id of required) assert.ok(result.value.statuses[id], `real SDK status ${id}`)
  assert.ok(blocked.every(url => /models\.dev|recommended-models/.test(url)), 'only credential-free public catalog prewarm is attempted')
  assert.equal(writes, 0)
  console.log(JSON.stringify({ passed: true, sdk, llmVersion: JSON.parse(fs.readFileSync(req.resolve('@deepseek-ai/dsh-llm/package.json'))).version, providers: required.length, adapters: adapters.size, upstreamRequestsSent: 0, blockedPublicCatalogLookups: blocked, credentialWrites: writes }))
} finally {
  for (const cleanup of disposers.reverse()) try { await cleanup() } catch {}
  // Dedicated subprocess: keep the offline fetch fence until exit so late catalog warmup cannot escape it.
  hooks.deregister(); fs.rmSync(scratch, { recursive: true, force: true })
}
