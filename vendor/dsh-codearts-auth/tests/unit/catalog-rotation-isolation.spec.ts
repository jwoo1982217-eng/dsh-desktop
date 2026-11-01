import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/account-pool.js'
import { rotatingStream, rotationRequest } from '../../src/account-rotation.js'
import { RemoteCatalogGate } from '../../src/remote-catalog-gate.js'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'catalog-rotation-'))
  vi.stubEnv('DSH_JET_HUB_STATE_DIR', directory)
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })

async function fixture() {
  const pool = new AccountPool({
    logger: { warn: vi.fn() }, get: () => undefined,
    credentials: { resolve: async () => { await Promise.resolve(); return { value: '{"access_token":"test-only"}' } } },
  } as never, { preserveAccountOrder: true })
  await pool.addAccount({ id: 'A', provider: 'workbuddy', credentialRef: 'TEST_ACCOUNT_A', enabled: true, nickname: 'test', createdAt: 1 })
  return pool
}

async function observe<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(value => ({ completed: true as const, value })),
      new Promise<{ completed: false }>(resolve => { timer = setTimeout(() => resolve({ completed: false }), 150) }),
    ])
  } finally { clearTimeout(timer) }
}

describe('目录加载与请求选号隔离', () => {
  it('冷目录在实际请求中读取凭据，不会经免费资格检查等待自己', async () => {
    const pool = await fixture(), gate = new RemoteCatalogGate()
    let loaded = false, checks = 0, fetches = 0
    const load = async () => {
      if (loaded) return
      await gate.run(async () => {
        fetches += 1
        loaded = (await pool.getAvailableAccount('workbuddy', '')) !== null
        return loaded
      })
    }
    pool.setRequestEligibility('workbuddy', async () => { checks += 1; await load(); return true })
    const iterator = rotatingStream('workbuddy', 'model', async function* () {
      await load()
      yield { id: (await pool.getAvailableAccount('workbuddy', 'model'))?.entry.id, model: rotationRequest('workbuddy')?.model }
    })[Symbol.asyncIterator]()
    const result = await observe(iterator.next())
    expect(result).toEqual({ completed: true, value: { done: false, value: { id: 'A', model: 'model' } } })
    expect(fetches).toBe(1)
    expect(checks).toBe(1)
    await iterator.return?.()
  })

  it('目录失败不破坏原请求的资格过滤或取消信号', async () => {
    const pool = await fixture(), gate = new RemoteCatalogGate(), controller = new AbortController()
    const checks: string[] = []
    pool.setRequestEligibility('workbuddy', async (_entry, model) => { checks.push(model); return false })
    const iterator = rotatingStream('workbuddy', 'restricted', async function* () {
      await gate.run(async () => { throw new Error('catalog offline') })
      yield { id: (await pool.getAvailableAccount('workbuddy', 'restricted'))?.entry.id, sameSignal: rotationRequest('workbuddy')?.signal === controller.signal }
    }, controller.signal)[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: { id: undefined, sameSignal: true } })
    expect(checks).toEqual(['restricted'])
    controller.abort()
    await expect(async () => iterator.next()).rejects.toMatchObject({ name: 'AbortError' })
    await iterator.return?.()
  })
})
