import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOOMY } from '../../src/loomy-product.js'
import { sendLoomySmsCode } from '../../src/loomy-oauth.js'

const names = ['CMDC_PAK_LOOMY_ACCESS_KEY_ID', 'CMDC_PAK_LOOMY_ACCESS_KEY_SECRET'] as const
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const name of names) {
    saved.set(name, process.env[name])
    delete process.env[name]
  }
})

afterEach(() => {
  for (const name of names) {
    const value = saved.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
})

describe('公开版 Loomy 应用访问配置', () => {
  it('未配置时仍可读取供应商目录，模块不在导入时失败', () => {
    expect(LOOMY.id).toBe('loomy')
    expect(LOOMY.fallbackModels.length).toBeGreaterThan(0)
  })

  it.each([
    [undefined, undefined, names[0]],
    ['fixture-loomy-app', undefined, names[1]],
    ['', 'fixture-loomy-secret', names[0]],
    ['fixture-loomy-app', '', names[1]],
    [' \t ', 'fixture-loomy-secret', names[0]],
    ['fixture-loomy-app', ' \n ', names[1]],
  ])('缺少或空白配置时在账号请求前拒绝（%s / %s）', async (id, secret, missing) => {
    if (id !== undefined) process.env[names[0]] = id
    if (secret !== undefined) process.env[names[1]] = secret
    const fetcher = vi.fn()
    await expect(sendLoomySmsCode('10000000000', LOOMY, fetcher as typeof fetch))
      .rejects.toThrow(missing)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('注入配置后去除首尾空白，后续读取采用当前环境', () => {
    process.env[names[0]] = ' fixture-loomy-app '
    process.env[names[1]] = ' fixture-loomy-secret '
    expect(LOOMY.accessKeyId).toBe('fixture-loomy-app')
    expect(LOOMY.accessKeySecret).toBe('fixture-loomy-secret')
    process.env[names[1]] = 'fixture-loomy-secret-updated'
    expect(LOOMY.accessKeySecret).toBe('fixture-loomy-secret-updated')
  })

  it('配置齐全后沿用原签名与请求协议，仅调用模拟 fetch', async () => {
    process.env[names[0]] = 'fixture-loomy-app'
    process.env[names[1]] = 'fixture-loomy-secret'
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: '000000', data: { msgid: 'fixture-message-id' },
    })))
    await expect(sendLoomySmsCode('10000000000', LOOMY, fetcher as typeof fetch))
      .resolves.toBe('fixture-message-id')
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(LOOMY.accountBase + '/login/phone/sendMsgCode')
    expect((init.headers as Record<string, string>).Authorization)
      .toMatch(/^account fixture-loomy-app:/)
    expect(JSON.parse(String(init.body)).base.appid).toBe(LOOMY.appId)
    expect(String(init.body)).not.toContain('fixture-loomy-secret')
  })
})
