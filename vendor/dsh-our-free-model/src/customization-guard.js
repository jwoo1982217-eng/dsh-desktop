/** Preserve owner-managed features before the updater changes any installed byte. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const contractName = 'customization-contract.json'
export function verifyCustomizationContract(installedDir, stageDir) {
  const file = path.join(installedDir, contractName)
  if (!fs.existsSync(file)) return { managed: false }
  const current = JSON.parse(fs.readFileSync(file, 'utf8'))
  const reject = reason => { throw new Error(`定制功能保护：${reason}。原程序未替换；请使用保留账号渠道、手机适配及共享后端的宿主管理更新包。`) }
  let incoming
  try { incoming = JSON.parse(fs.readFileSync(path.join(stageDir, contractName), 'utf8')) } catch { reject('目标更新缺少已审核的定制契约') }
  if (current.format !== 1 || incoming.format !== 1 || current.id !== incoming.id) reject('目标更新的定制契约不兼容')
  for (const provider of current.requiredProviders) {
    if (!incoming.requiredProviders.includes(provider)) reject(`目标更新缺少 ${provider} 渠道声明`)
    for (const file of ['client.js', 'vendor/channel-pack/pack.js']) {
      let source
      try { source = fs.readFileSync(path.join(stageDir, file), 'utf8') } catch { reject(`目标更新缺少 ${file}`) }
      if (!new RegExp(`['"]${provider}['"]`).test(source)) reject(`目标更新缺少 ${provider} 的界面或后台实现`)
    }
  }
  for (const capability of current.requiredCapabilities ?? []) {
    if (!(incoming.requiredCapabilities ?? []).some(row => row.id === capability.id)) reject(`目标更新缺少 ${capability.id} 能力声明`)
    for (const check of capability.checks) {
      let source
      try { source = fs.readFileSync(path.join(stageDir, check.file), 'utf8') } catch { reject(`目标更新缺少 ${capability.id} 所需文件 ${check.file}`) }
      for (const marker of check.markers) if (!source.includes(marker)) reject(`目标更新缺少 ${capability.id} 的已审核接口 ${marker}`)
    }
  }
  for (const [relative, expected] of Object.entries(current.criticalFiles)) {
    let bytes
    try { bytes = fs.readFileSync(path.join(stageDir, relative)) } catch { reject(`目标更新缺少 ${relative}`) }
    if (digest(bytes) !== expected) reject(`目标更新改变了需人工复核的定制接口 ${relative}`)
  }
  for (const section of current.criticalSections ?? []) {
    let source
    try { source = fs.readFileSync(path.join(stageDir, section.file), 'utf8') } catch { reject(`目标更新缺少 ${section.file}`) }
    const start = source.indexOf(section.start)
    const end = start < 0 ? -1 : source.indexOf(section.end, start + section.start.length)
    if (start < 0 || end < 0 || digest(source.slice(start, end + section.end.length)) !== section.sha256) reject(`目标更新改变了需复核的 ${section.name}`)
  }
  const updater = fs.readFileSync(path.join(stageDir, 'src/updater.js'), 'utf8')
  if (!updater.includes('verifyCustomizationContract(this.deps.pkgDir, this.stageDir)')) reject('目标更新未保留定制保护预检')
  return { managed: true, id: current.id, providers: current.requiredProviders.length }
}

/** Read-only build gate: validate the source against its own reviewed contract. */
export function validateCustomizationSource(sourceDir) {
  const result = verifyCustomizationContract(sourceDir, sourceDir)
  if (!result.managed) throw new Error("OFM source has no owner-managed customization contract")
  return result
}
/** Read-only inheritance gate; preserves current minimum capabilities and reviewed interfaces. */
export const inheritCustomizationContract = verifyCustomizationContract
