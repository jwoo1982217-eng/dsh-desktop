import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// These are the user's existing account channels, not a ceiling on upstream additions.
export const requiredOfmProviders = Object.freeze([
  'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
  'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
  'accio', 'astudio', 'autoclaw', 'autoclawintl', 'codely', 'magicrew',
  'minimaxintl', 'modelscope', 'officeace',
]);

/** Resolve the maintained customization explicitly; never inherit a stale bundled copy. */
export async function resolveOfmSource(root, override) {
  const directory = path.resolve(root, override ?? 'vendor/dsh-our-free-model');
  let manifest, contract;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    contract = JSON.parse(await fs.readFile(path.join(directory, 'customization-contract.json'), 'utf8'));
  } catch (error) {
    throw new Error(`缺少已审核的 OFM 定制源，停止打包以保留现有免费接入：${directory}`, {cause: error});
  }
  if (manifest.name !== 'dsh-our-free-model' || contract.format !== 1 ||
      !requiredOfmProviders.every(id => contract.requiredProviders?.includes(id))) {
    throw new Error('OFM 定制源未保留原有 22 个账号接入，未生成安装包');
  }
  const guardPath = path.join(directory, 'src/customization-guard.js');
  const guard = await import(pathToFileURL(guardPath).href);
  const verified = await guard.validateCustomizationSource(directory);
  if (!verified.managed) throw new Error('OFM 定制源未通过实际程序检查');
  return {directory, version: manifest.version, contract, verified, guard};
}

/** Also check reused build output: a new launcher version does not make old plugins current. */
export async function verifyPackagedOfm(modules, source) {
  const directory = path.join(modules, 'dsh-our-free-model');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-our-free-model' || manifest.version !== source.version) {
    throw new Error('缓存运行时仍包含另一版 OFM，停止打包');
  }
  return source.guard.inheritCustomizationContract(source.directory, directory);
}

export async function resolveJetHubSource(root, override) {
  const directory = path.resolve(root, override ?? 'vendor/dsh-codearts-auth');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const contract = JSON.parse(await fs.readFile(path.join(directory, 'customization-contract.json'), 'utf8'));
  if (manifest.name !== 'dsh-providers-hub') throw new Error('JetHub 定制源身份不匹配');
  const entry = contract.guardModule;
  if (typeof entry !== 'string' || path.isAbsolute(entry) || entry.split(/[\\/]/).some(x => !x || x === '.' || x === '..')) throw new Error('JetHub 定制检查入口无效');
  const guard = await import(pathToFileURL(path.join(directory, entry)).href);
  const verified = await guard.validateCustomizationSource(directory, {verifySources:true});
  if (!verified?.ok) throw new Error('JetHub 定制源未通过实际程序检查');
  return {directory, version:manifest.version, contract, guard, verified};
}

export async function verifyPackagedJetHub(modules, source) {
  // JetHub keeps rc.2 across many protocol updates. Its version alone cannot
  // distinguish the old package from the reviewed custom implementation.
  return source.guard.inheritCustomizationContract(source.directory,
    path.join(modules, 'dsh-providers-hub'));
}
