import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { probeAutoclawLocalCredential, loginAutoclawWithCode } from '../../src/autoclaw-oauth.js'
import { AUTOCLAW, AUTOCLAW_INTL } from '../../src/autoclaw-product.js'

const PASSWORD = 'fixture-safe-storage-password'
const ACTIVE = 'a'.repeat(64)
let root: string
const { security, synchronousSecurity } = vi.hoisted(() => ({ security: vi.fn(), synchronousSecurity: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: synchronousSecurity,
  execFile: (...args: any[]) => {
    queueMicrotask(() => { try { args[3](null, security(...args.slice(0, 3)), '') } catch (error) { args[3](error, '', '') } })
    return {}
  },
}))
const token = (device = 'fixture-token-device') => `header.${Buffer.from(JSON.stringify({ user_id: 17, device_id: device, exp: 2000000000 })).toString('base64url')}.signature`
function put(relative: string, value: string | Buffer) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value)
}
function encrypt(value: unknown, password = PASSWORD) {
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32))
  return Buffer.concat([Buffer.from('v10'), cipher.update(JSON.stringify(value)), cipher.final()])
}
function fixture(product = AUTOCLAW_INTL, key = ACTIVE, access = token()) {
  const name = product.userDataDirName
  put(`${name}/device/active-product-account.json`, JSON.stringify({ schemaVersion: 1, accountKey: key }))
  put(`${name}/device/device-id.json`, JSON.stringify({ schemaVersion: 1, deviceId: `fixture-${product.id}-device` }))
  put(`${name}/accounts/${key}/account-profile.json`, JSON.stringify({ schemaVersion: 1, profile: { accountId: `fixture-${product.id}-account`, displayName: `测试${product.id}`, email: 'fixture@example.invalid', phone: null } }))
  put(`${name}/accounts/${key}/account-credentials.enc`, encrypt({ schemaVersion: 1, revision: 3, accessToken: access, refreshToken: 'fixture-refresh', updatedAt: '2026-10-24T00:00:00Z' }))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-mac-fixture-'))
  vi.spyOn(os, 'platform').mockReturnValue('darwin')
  security.mockReset().mockReturnValue(`${PASSWORD}\n`)
  synchronousSecurity.mockReset().mockReturnValue(`${PASSWORD}\n`)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }) })

describe('Mac AutoClaw 国际版本机导入', () => {
  it('手机标记优先于Mac平台与完整桌面夹具，不触碰钥匙串', async () => {
    fixture()
    vi.stubEnv('DSH_PHONE_ANDROID', '1')
    expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).toBeUndefined()
    expect(security).not.toHaveBeenCalled(); expect(synchronousSecurity).not.toHaveBeenCalled()
  })
  it('读取当前账号的原生 v10 CBC 文件，保留国际账号、真实JWT死线和设备号', async () => {
    fixture()
    const before = fs.readFileSync(path.join(root, AUTOCLAW_INTL.userDataDirName, 'accounts', ACTIVE, 'account-credentials.enc'))
    const c = await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })
    expect(c).toMatchObject({ access_token: token(), refresh_token: 'fixture-refresh', user_id: 'fixture-autoclawintl-account', user_name: '测试autoclawintl', device_id: 'fixture-token-device', expires_at: 2000000000000 })
    expect(security).toHaveBeenCalledOnce()
    expect(synchronousSecurity).not.toHaveBeenCalled()
    expect(security.mock.calls[0]?.slice(0, 2)).toEqual(['/usr/bin/security', ['find-generic-password', '-w', '-s', 'AutoClaw Safe Storage', '-a', 'AutoClaw Key']])
    expect(fs.readFileSync(path.join(root, AUTOCLAW_INTL.userDataDirName, 'accounts', ACTIVE, 'account-credentials.enc'))).toEqual(before)
  })
  it('默认路径读取 Mac Application Support；测试隔离变量优先且不回落真实目录', async () => {
    const home = path.join(root, 'fixture-home'); const appData = path.join(home, 'Library', 'Application Support')
    const previous = root; root = appData; fixture(); root = previous
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    vi.stubEnv('DSH_AUTOCLAW_APPDATA', undefined); vi.stubEnv('APPDATA', undefined); vi.stubEnv('USERPROFILE', undefined)
    expect(await probeAutoclawLocalCredential({ product: AUTOCLAW_INTL })).toMatchObject({ user_id: 'fixture-autoclawintl-account' })
    security.mockClear(); vi.stubEnv('DSH_AUTOCLAW_APPDATA', path.join(root, 'isolated-empty'))
    expect(await probeAutoclawLocalCredential({ product: AUTOCLAW_INTL })).toBeUndefined()
    expect(security).not.toHaveBeenCalled()
  })
  it('只导入当前指针账号；国内外目录不串用，也不复活未选中的历史账号', async () => {
    fixture(AUTOCLAW); fixture(AUTOCLAW_INTL, 'b'.repeat(64), token('inactive'))
    fixture(AUTOCLAW_INTL)
    expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).toMatchObject({ user_id: 'fixture-autoclawintl-account', access_token: token() })
    expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW })).toMatchObject({ user_id: 'fixture-autoclaw-account' })
    fs.unlinkSync(path.join(root, AUTOCLAW_INTL.userDataDirName, 'device/active-product-account.json'))
    security.mockClear()
    expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).toBeUndefined()
    expect(security).not.toHaveBeenCalled()
  })
  it('钥匙串拒绝时返回明确且脱敏的错误；允许后同一原文件可重试', async () => {
    fixture(); security.mockImplementationOnce(() => { throw new Error('fixture-password-do-not-log') })
    const failure = await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL }).catch(e => e)
    expect(failure).toBeInstanceOf(Error); expect(failure.message).toContain('钥匙串'); expect(failure.message).not.toContain('fixture-password-do-not-log')
    expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).toMatchObject({ access_token: token() })
  })
  it('坏密文、未知前缀及越界/链接指针不能导入，拒绝后可恢复', async () => {
    fixture(); const base = `${AUTOCLAW_INTL.userDataDirName}/accounts/${ACTIVE}/account-credentials.enc`
    put(base, Buffer.from('v99-invalid')); expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).toBeUndefined()
    fixture(); put(`${AUTOCLAW_INTL.userDataDirName}/device/active-product-account.json`, JSON.stringify({ accountKey: '../outside' }))
    expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).toBeUndefined()
    fixture(); fs.unlinkSync(path.join(root, base)); put('outside.enc', encrypt({ accessToken: token(), refreshToken: 'fixture' })); fs.symlinkSync(path.join(root, 'outside.enc'), path.join(root, base))
    expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).toBeUndefined()
    fs.unlinkSync(path.join(root, base)); fixture()
    expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).toMatchObject({ access_token: token() })
  })
  it('国际版登录的设备号也来自 Mac 国际目录', async () => {
    const home = path.join(root, 'fixture-home'); const previous = root
    root = path.join(home, 'Library', 'Application Support'); fixture(); root = previous
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    vi.stubEnv('DSH_AUTOCLAW_APPDATA', undefined); vi.stubEnv('APPDATA', undefined); vi.stubEnv('USERPROFILE', undefined)
    let body: Record<string, unknown> = {}
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ code: 0, data: { access_token: token(), refresh_token: 'fixture' } }), { status: 200 }) })
    await loginAutoclawWithCode('13800000000', '123456', { product: AUTOCLAW_INTL, fetchImpl: fetcher as typeof fetch })
    expect(body.device_id).toBe('fixture-autoclawintl-device')
  })
  it('CBC 密文损坏时不返回残缺令牌，恢复密文后可以重试', async () => {
    fixture(); const file = path.join(root, AUTOCLAW_INTL.userDataDirName, 'accounts', ACTIVE, 'account-credentials.enc')
    const original = fs.readFileSync(file); const broken = Buffer.from(original); broken[broken.length - 1] ^= 255; fs.writeFileSync(file, broken)
    await expect(probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).rejects.toThrow('无法解密')
    fs.writeFileSync(file, original)
    expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).toMatchObject({ access_token: token() })
  })
  it('读取过程中切换当前账号时拒绝旧快照，重试只读新账号', async () => {
    fixture(AUTOCLAW_INTL, 'b'.repeat(64), token('new-account')); fixture()
    security.mockImplementationOnce(() => { put(`${AUTOCLAW_INTL.userDataDirName}/device/active-product-account.json`, JSON.stringify({ accountKey: 'b'.repeat(64) })); return `${PASSWORD}\n` })
    expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).toBeUndefined()
    expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).toMatchObject({ access_token: token('new-account') })
  })
  it('Windows 的 DPAPI/AES-GCM 导入仍按原协议执行', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    const key = Buffer.alloc(32, 66); const nonce = Buffer.alloc(12, 23)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ accessToken: token(), refreshToken: 'fixture-refresh', userId: 'fixture-windows' })), cipher.final()])
    const name = AUTOCLAW_INTL.userDataDirName
    put(`${name}/Local State`, JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.alloc(32, 7)]).toString('base64') } }))
    put(`${name}/accounts/legacy/account-credentials.enc`, Buffer.concat([Buffer.from('v10'), nonce, encrypted, cipher.getAuthTag()]))
    synchronousSecurity.mockReturnValue(key.toString('base64'))
    expect(await probeAutoclawLocalCredential({ customAppData: root, product: AUTOCLAW_INTL })).toMatchObject({ user_id: 'fixture-windows', access_token: token() })
    expect(synchronousSecurity.mock.calls[0]?.[0]).toBe('powershell.exe')
  })
})
