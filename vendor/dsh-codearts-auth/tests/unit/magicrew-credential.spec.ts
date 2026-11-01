import { describe, expect, it } from 'vitest'
import {
  magicrewCredentialFingerprint,
  magicrewDisplayNickname,
  parseMagicrewCredential,
} from '../../src/magicrew-auth.js'

describe('magicrew 凭据解析', () => {
  it('★ 完整凭据被正确解析', () => {
    const credential = parseMagicrewCredential({
      jwt: 'header.payload.sig',
      organizationCode: '26em6msgebcv',
      apiKey: 'mgw_abc',
      apiKeyExpiresAt: 1_793_209_071_000,
      refreshToken: 'rt_abc',
      phone: '13011112222',
    })
    expect(credential).toMatchObject({
      jwt: 'header.payload.sig',
      organizationCode: '26em6msgebcv',
      apiKey: 'mgw_abc',
      // ★ `apiKeyExpiresAt` 是任务 3b 判断「要不要续期」的**唯一输入** ⇒ 必须断言。
      //    漏了它，「每请求都续期 / 永不续期」两个方向都不会有任何用例变红。
      apiKeyExpiresAt: 1_793_209_071_000,
      refreshToken: 'rt_abc',
      // ★ `phone` 必须经过 parse 被断言：昵称用例是直接传对象字面量，
      //    走不到 parse，删掉 parse 里的 phone 分支它也照样绿。
      phone: '13011112222',
    })
  })

  it('★ refreshTokenExpiresAt 也被保留（readNumber 的第二条腿）', () => {
    // 只测一个数值键不够：两条取数分支各自独立，删掉任一条都该有红。
    const credential = parseMagicrewCredential({
      jwt: 'j.w.t',
      organizationCode: '',
      refreshToken: 'rt',
      refreshTokenExpiresAt: 1_793_900_000_000,
    })
    expect(credential?.refreshTokenExpiresAt).toBe(1_793_900_000_000)
  })

  it('★ jwt 缺失 ⇒ undefined（不可用）', () => {
    expect(parseMagicrewCredential({ apiKey: 'mgw_x' })).toBeUndefined()
    expect(parseMagicrewCredential({ jwt: '' })).toBeUndefined()
    expect(parseMagicrewCredential(null)).toBeUndefined()
    expect(parseMagicrewCredential(undefined)).toBeUndefined()
  })

  it('★ api_key 缺失但 jwt 在 ⇒ 仍返回凭据（可续期救回）', () => {
    const credential = parseMagicrewCredential({ jwt: 'j.w.t', organizationCode: 'org1' })
    expect(credential?.jwt).toBe('j.w.t')
    expect(credential?.apiKey).toBeUndefined()
    // ★ 「缺失即缺失」：`toBeUndefined()` 对 `{ apiKey: undefined }` 一视同仁，
    //    钉不住条件展开的写法 ⇒ 必须用 `in` 判「键在不在」。
    expect('apiKey' in credential!).toBe(false)
  })

  it('★ 指纹基于 jwt（账号识别用），空 jwt 返回空串', () => {
    expect(magicrewCredentialFingerprint('j.w.t')).toHaveLength(16)
    expect(magicrewCredentialFingerprint('j.w.t')).toBe(magicrewCredentialFingerprint('j.w.t'))
    expect(magicrewCredentialFingerprint('other.j.w')).not.toBe(magicrewCredentialFingerprint('j.w.t'))
    expect(magicrewCredentialFingerprint('')).toBe('')
  })

  it('★ 展示昵称：手机号脱敏，缺失时回落固定文案', () => {
    // ⚠️ `organizationCode` 是**必需字段**（国内站可为空串）⇒ 测试字面量不能省略它，
    //    否则 `TS2345`。**不要**为了省事把它改成可选字段 —— 两站都要它参与绑定判断，
    //    可选会让「忘了写」与「确实没有」长得一模一样。
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: '', phone: '13011112222' }))
      .toBe('130****2222')
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: 'org1', phone: '13011112222' }))
      .toBe('130****2222')
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: '' })).toBe('超级麦吉')
    // ★ `/^\d{11}$/` 的**否定分支**：非 11 位纯数字一律回落渠道名，
    //    否则 `slice(0,3)+'****'+slice(7)` 会把 10 位或带国家码的号段切成乱码。
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: '', phone: '1380013800' }))
      .toBe('超级麦吉') // 10 位
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: '', phone: '+8613011112222' }))
      .toBe('超级麦吉') // 带国家码
  })
})
