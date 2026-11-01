import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
export const REQUIRED_CHANNELS = 'codearts buddy workbuddy lobsterai qoder qodercn trae cline loomy raccoon zcode minimax minimaxintl gemini officeace accio autoclaw autoclawintl modelscope astudio magicrew codely'.split(' ')
export function customUiProviders() {
  let record
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace('exports.__test = {', 'exports.__test = { CHANNEL_PROVIDERS, CHANNEL_CREDITS,')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { record = value } } } })
  return record.factory(() => ({})).__test
}
export async function verifyCustomProviderParity({ adapters, call, ctx, creds }) {
  const ui = customUiProviders(), ids = ui.CHANNEL_PROVIDERS.map(row => row.id)
  for (const id of [...REQUIRED_CHANNELS, 'aggregate', 'channel-pack-auto']) assert.ok(adapters.has(id), `required adapter ${id}`)
  for (const id of REQUIRED_CHANNELS) assert.ok(ids.includes(id), `required UI ${id}`)
  const statuses = await call('provider.status', { providers: ids })
  assert.equal(statuses.ok, true)
  for (const id of ids) {
    assert.ok(adapters.has(id), `${id} UI has a real adapter`)
    assert.ok(statuses.value.statuses[id], `${id} UI has a real provider.status result`)
    assert.equal((await call('account.list', { provider: id })).ok, true, `${id} account RPC`)
    if (ui.CHANNEL_CREDITS[id]) {
      const result = await call('credits.balances', { provider: id })
      assert.equal(result.ok, true, `${id}: ${result.error?.message}`)
    }
  }
  for (const provider of ['modelscope', 'qiniu']) {
    const before = ctx.accountPool.listAccountsByProvider(provider).map(row => row.id)
    const added = await call(`${provider}.addAccount`, { apiKey: provider === 'modelscope' ? 'ms-fixture-owned-key-1234567890' : 'fixture-owned-qiniu-key-1234567890' })
    assert.equal(added.ok, true, `${provider} true key login RPC`)
    const row = ctx.accountPool.findAccount(added.value.accountId)
    assert.ok(row)
    assert.ok(creds.has(row.credentialRef))
    assert.equal((await call('account.delete', { accountId: row.id })).ok, true)
    assert.deepEqual(ctx.accountPool.listAccountsByProvider(provider).map(row => row.id), before)
  }
  const fetchBefore = globalThis.fetch
  let balanceRequests = 0
  try {
    globalThis.fetch = async () => {
      balanceRequests++
      return Response.json({ code: 1000, remaining_points: '123', details: [{ type: 'gift_credit', remaining_points: '123' }], data: { total_points: 123, expiring_quota_details: [] } })
    }
    for (const provider of ['codely', 'magicrew']) {
      const id = `fixture-parity-${provider}`, ref = `FIXTURE_PARITY_${provider.toUpperCase()}`
      const credential = provider === 'codely' ? { access_token: 'fixture-codely', expires_at: '2099-01-01T00:00:00Z' }
        : { jwt: 'fixture-magicrew-jwt', organizationCode: 'fixture-org', apiKey: 'mgw_fixture', apiKeyExpiresAt: Date.parse('2099-01-01') }
      const previous = balanceRequests
      try {
        creds.set(ref, { value: JSON.stringify(credential) })
        await ctx.accountPool.addAccount({ id, provider, nickname: 'offline fixture', enabled: true, refreshable: false, credentialRef: ref, createdAt: 1 })
        const result = await call('credits.balances', { provider, force: true })
        assert.equal(result.ok, true, `${provider}: balance dispatch exists`)
        assert.equal(result.value.accounts.find(row => row.accountId === id)?.balance?.total, 123, `${provider}: real backend credit parser`)
        assert.ok(balanceRequests > previous, `${provider}: actual fixture request`)
      } finally {
        await ctx.accountPool.removeAccount(id)
        creds.delete(ref)
      }
    }
  } finally { globalThis.fetch = fetchBefore }
  console.log(`ok custom provider parity: ${ids.length} account cards; required22 plus internal routes retained; every card has backend status/account/declared-credit dispatch; real ModelScope/Qiniu key RPCs persist and remove only fixture credentials`)
}
