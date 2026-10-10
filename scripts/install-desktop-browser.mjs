import { readFile, mkdir, cp, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function installDesktopBrowser(profile, modules) {
  profile = path.resolve(profile); modules = path.resolve(modules);
  const manifestFile = path.join(profile, 'package.json'), original = await readFile(manifestFile, 'utf8'), manifest = JSON.parse(original);
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw Error('请选择已有 DSH Web profile');
  const engine = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
  if (engine.version !== '0.2.1-alpha.1') throw Error('浏览器面板适配 DSH 0.2.1-alpha.1，请先验证其他核心版本');
  const target = path.join(profile, 'node_modules/dsh-desktop-browser'), staging = target + '.new-' + randomUUID(), backup = target + '.old-' + randomUUID(), temporary = manifestFile + '.browser-' + randomUUID();
  let old = false, installed = false;
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    for (const name of ['package.json', 'cordis.patch.yml', 'index.mjs', 'client.js', 'browser-engine.mjs', 'browser-panel-service.mjs', 'browser-panel.html', 'isolated-login.mjs', 'isolated-login-service.mjs', 'system-login-browser.mjs']) await cp(path.join(root, 'desktop-browser', name), path.join(staging, name));
    try { await rename(target, backup); old = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(staging, target); installed = true;
    manifest.dependencies = { ...manifest.dependencies, 'dsh-desktop-browser': 'file:./node_modules/dsh-desktop-browser' };
    if (!manifest.dsh.profile.bundles.includes('dsh-desktop-browser')) manifest.dsh.profile.bundles.push('dsh-desktop-browser');
    if (await readFile(manifestFile, 'utf8') !== original) throw Error('Profile 在安装中变化，请重试');
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, manifestFile);
    // A cleanup failure after committing the manifest must not undo the plugin.
    if (old) await rm(backup, { recursive: true, force: true }).catch(() => {});
    return { profile, plugin: target, page: '/desktop-browser' };
  } catch (error) {
    if (installed) await rm(target, { recursive: true, force: true });
    if (old) await rename(backup, target);
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); await rm(temporary, { force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await installDesktopBrowser(process.argv[2], process.argv[3]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
