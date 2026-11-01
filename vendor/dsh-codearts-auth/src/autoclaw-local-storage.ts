/** AutoClaw 本机只读存储：Mac 使用当前账号指针及系统钥匙串，不写客户端文件。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { desktopCredentialImportAvailable } from './login-platform.js'
import { cleanBearerToken, autoclawAccessTokenExpiresAtMs, type AutoclawCredential } from './autoclaw.js'

const MAX_FILE_BYTES = 128 * 1024

/** 隔离目录优先；Mac 不使用 Windows 的 APPDATA 兜底。 */
export function resolveAutoclawAppData(custom?: string): string | undefined {
  if (!desktopCredentialImportAvailable()) return undefined
  const explicit = custom ?? process.env.DSH_AUTOCLAW_APPDATA
  if (explicit !== undefined) return explicit
  if (os.platform() === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
  return process.env.APPDATA
    ?? (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : undefined)
}

/** 只透传面向用户的固定文案，不透传系统命令输出、密钥或原始密文。 */
export class AutoclawLocalStorageError extends Error {}

function physicalDirectory(file: string): boolean {
  const stat = fs.lstatSync(file)
  return stat.isDirectory() && !stat.isSymbolicLink()
}

function readFile(file: string): Buffer {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) throw new Error('Invalid local file')
  return fs.readFileSync(file)
}

/**
 * 已与 Mac AutoClaw 2.1.1 的 safeStorage v10 文件实测核对：
 * PBKDF2-SHA1 / saltysalt / 1003 / 16，AES-128-CBC，16个空格IV。
 * 这是 safeStorage 文档，不是 Chromium cookie，不删除解密后的32字节。
 */
export async function readMacAutoclawCredential(appDir: string): Promise<AutoclawCredential | undefined> {
  if (!desktopCredentialImportAvailable()) return undefined
  let clear: Buffer | undefined
  let key: Buffer | undefined
  try {
    const accounts = path.join(appDir, 'accounts')
    const device = path.join(appDir, 'device')
    if (![appDir, accounts, device].every(physicalDirectory)) return undefined
    const pointerPath = path.join(device, 'active-product-account.json')
    const pointerBytes = readFile(pointerPath)
    const pointer = JSON.parse(pointerBytes.toString()) as { accountKey?: unknown }
    if (typeof pointer.accountKey !== 'string' || !/^[a-f0-9]{64}$/.test(pointer.accountKey)) return undefined
    const accountDir = path.join(accounts, pointer.accountKey)
    if (!physicalDirectory(accountDir)) return undefined
    const credentialFile = path.join(accountDir, 'account-credentials.enc')
    const encrypted = readFile(credentialFile)
    if (encrypted.subarray(0, 3).toString() !== 'v10' || encrypted.length <= 3 || (encrypted.length - 3) % 16 !== 0) return undefined

    let password: string
    try {
      // 系统授权期间不阻塞 DSH 的事件循环，其他会话仍可处理请求。
      password = await new Promise<string>((resolve, reject) => {
        execFile('/usr/bin/security', [
          'find-generic-password', '-w', '-s', 'AutoClaw Safe Storage', '-a', 'AutoClaw Key',
        ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 16_384 }, (error, stdout) => {
          if (error) reject(new Error('Keychain access unavailable'))
          else resolve(stdout.replace(/\r?\n$/, ''))
        })
      })
      if (!password) throw new Error('Empty keychain item')
    } catch {
      throw new AutoclawLocalStorageError('Mac 钥匙串未允许读取 AutoClaw 登录信息，请允许系统访问提示后重试；原账号文件保持。')
    }
    key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
    password = ''
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32))
      clear = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
    } catch {
      throw new AutoclawLocalStorageError('无法解密 Mac AutoClaw 登录文件，请确认客户端已解锁后重试；原文件保持。')
    }
    const material = JSON.parse(clear.toString()) as Record<string, unknown>
    if (material.schemaVersion !== 1 || typeof material.accessToken !== 'string' || typeof material.refreshToken !== 'string') return undefined
    const access = cleanBearerToken(material.accessToken)
    const refresh = cleanBearerToken(material.refreshToken)
    if (!access || !refresh) return undefined
    const data = JSON.parse(readFile(path.join(accountDir, 'account-profile.json')).toString()) as { profile?: Record<string, unknown> }
    const profile = data.profile ?? {}
    let jwt: Record<string, unknown> = {}
    try { jwt = JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString()) } catch {}
    let deviceId: unknown
    try { deviceId = JSON.parse(readFile(path.join(device, 'device-id.json')).toString()).deviceId } catch {}
    // 读取期间切换账号或轮换凭据时不导入过时的快照，用户可重新点击。
    if (!readFile(pointerPath).equals(pointerBytes) || !readFile(credentialFile).equals(encrypted)) return undefined
    const userId = profile.accountId ?? material.userId ?? jwt.user_id
    return {
      access_token: access,
      refresh_token: refresh,
      user_id: typeof userId === 'string' || typeof userId === 'number' ? userId : undefined,
      user_name: typeof profile.displayName === 'string' ? profile.displayName : undefined,
      user_phone: typeof profile.phone === 'string' ? profile.phone : undefined,
      device_id: typeof jwt.device_id === 'string' ? jwt.device_id : typeof deviceId === 'string' ? deviceId : undefined,
      expires_at: autoclawAccessTokenExpiresAtMs(access, undefined),
    }
  } catch (error) {
    if (error instanceof AutoclawLocalStorageError) throw error
    return undefined
  } finally {
    clear?.fill(0)
    key?.fill(0)
  }
}
