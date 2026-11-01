import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const contractName = 'customization-contract.json';
const hasContract = async directory => {
  try { await fs.access(path.join(directory, contractName)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const loadGuard = async directory => {
  const contract = JSON.parse(await fs.readFile(path.join(directory, contractName), 'utf8'));
  const relative = contract.guardModule ?? 'src/customization-guard.js';
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) {
    throw new Error('定制功能检查入口无效，原程序已保留');
  }
  return import(pathToFileURL(path.join(directory, relative)).href);
};

/** Validate capabilities before swapping any program entry. */
export async function checkPluginInheritance(name, source, installed) {
  const markedSource = await hasContract(source);
  const markedInstalled = await hasContract(installed);
  if (name !== 'dsh-our-free-model' && !markedInstalled && !markedSource) return;
  if (!markedSource) throw new Error(`${name} 更新包缺少定制功能契约，原程序已保留`);
  const guard = await loadGuard(source);
  await guard.validateCustomizationSource(source);
  if (markedInstalled) {
    const installedGuard = await loadGuard(installed);
    await installedGuard.inheritCustomizationContract(installed, source);
  }
}
