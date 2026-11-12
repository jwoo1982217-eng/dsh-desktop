import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {prepareRc1ProfileMigration, commitRc1ProfileMigration, restoreRc1ProfileMigration} from './rc1-profile-migration.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const owner = 'dsh-desktop-core-rc1-v1', version = '0.2.2-rc.1', compatibilityName = 'dsh-desktop-core-compatibility';
const optional = async file => {try {return await fs.readFile(file);} catch (e) {if (e.code === 'ENOENT') return null; throw e;}};
const atom = async (file, bytes) => {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = file + '.rc1-' + randomUUID();
  try {await fs.writeFile(temporary, bytes, {mode: 0o600, flag: 'wx'}); await fs.rename(temporary, file);}
  finally {await fs.rm(temporary, {force: true});}
};
const allowed = name => /^node_modules\/(?:dsh-peer\/(?:on-demand-tools\/(?:index|step-admission)\.mjs|subagent-scheduler\/(?:index|native)\.mjs)|billion-context\/dist\/agent\/dsh-native\.js)$/.test(name);
async function completedMarkerReceipt(home, profile, bytes, fresh) {
  let entries;
  try {entries = await fs.readdir(path.join(home, 'backups'), {withFileTypes:true});}
  catch (error) {if(error.code === 'ENOENT') return false; throw error;}
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(?:desktop-core-rc1-|mac-app-)/.test(entry.name)) continue;
    let raw;
    try {raw = await optional(path.join(home, 'backups', entry.name, 'restore.json'));}
    catch (error) {if (['EISDIR','EACCES'].includes(error.code)) continue; throw error;}
    if (!raw || raw.length > 1024 * 1024) continue;
    let receipt; try {receipt = JSON.parse(raw);} catch {continue;}
    if (receipt.profile !== profile) continue;
    if (fresh) {
      const row = receipt.rc1FreshMarker;
      if (receipt.complete === true && row?.owner === owner && row.coreVersion === version && row.file === path.join(profile, '.desktop-core-rc1.json') && row.sha256 === hash(bytes)) return true;
    } else if (receipt.owner === owner && Array.isArray(receipt.files)) {
      // Older finalized receipts have a nonempty migration receipt instead of
      // the explicit completion flag added here. Prepared-but-uncommitted receipts do not.
      const complete = receipt.complete === true || receipt.migration?.version === version && Array.isArray(receipt.migration.files) && receipt.migration.files.length > 0;
      if (complete && receipt.files.some(row => row.file === path.join(profile, '.desktop-core-rc1.json') && row.after === hash(bytes))) return true;
    }
  }
  return false;
}
async function verifyMarkerLink(profile, runtime, manifest) {
  const desired = path.join(runtime, 'node_modules', compatibilityName), link = path.join(profile, 'node_modules', compatibilityName);
  if (!manifest.dsh.profile.bundles.includes(compatibilityName) || manifest.dependencies?.[compatibilityName] !== 'file:' + desired) throw Error('核心升级标记缺少对应的兼容模块配置，未修改');
  if (!(await fs.lstat(link)).isSymbolicLink() || path.resolve(path.dirname(link), await fs.readlink(link)) !== desired) throw Error('核心升级标记对应的兼容模块链接已变化，未修改');
  const pkg = JSON.parse(await fs.readFile(path.join(desired,'package.json'),'utf8'));
  if (pkg.name !== compatibilityName || pkg.engines?.dsh !== version) throw Error('兼容模块与核心升级标记不匹配');
}
export async function assertFreshRc1PluginCompatibility(runtime, plugins, {sources} = {}) {
  if (!plugins.includes(compatibilityName)) throw Error('全新 rc.1 配置缺少核心兼容模块，未创建配置');
  for (const name of plugins) {
    const pkg = JSON.parse(await fs.readFile(path.join(sources?.[name] ?? path.join(runtime,'node_modules',name),'package.json'),'utf8'));
    if (!pkg.engines?.dsh) continue;
    const semver = createRequire(path.join(runtime,'node_modules/@deepseek-ai/dsh/package.json'))('semver');
    if (!semver.satisfies(version,pkg.engines.dsh,{includePrerelease:true})) throw Error('全新 rc.1 配置缺少已审核的插件兼容声明：' + name + ' (' + pkg.engines.dsh + ')；未禁用或丢弃该插件');
  }
}
export async function publishFreshRc1Marker(profile, runtime) {
  const bundleBytes = await fs.readFile(path.join(runtime,'bundle.json'));
  if (JSON.parse(bundleBytes).coreVersion !== version) throw Error('全新配置的发行清单核心版本不匹配');
  await verifyMarkerLink(profile,runtime,JSON.parse(await fs.readFile(path.join(profile,'package.json'))));
  const file = path.join(profile,'.desktop-core-rc1.json');
  const bytes = Buffer.from(JSON.stringify({owner,coreVersion:version,kind:'fresh',bundleSha256:hash(bundleBytes)})+'\n');
  await fs.writeFile(file,bytes,{mode:0o600,flag:'wx'});
  return {file,bytes,receipt:{owner,coreVersion:version,file,sha256:hash(bytes)}};
}
export async function removeFreshRc1Marker(marker) {
  const current = await optional(marker.file);
  if (current?.equals(marker.bytes)) await fs.rm(marker.file);
  else if (current) throw Error('全新配置标记有并发修改，已保留');
}
async function realParents(root, file) {
  for (let parent = path.dirname(file); parent !== root; parent = path.dirname(parent)) {
    if (!parent.startsWith(root + path.sep)) throw Error('升级路径越界');
    try {if ((await fs.lstat(parent)).isSymbolicLink()) throw Error('升级路径有链接，保留原程序');}
    catch (e) {if (e.code !== 'ENOENT') throw e;}
  }
  try {if ((await fs.lstat(file)).isSymbolicLink()) throw Error('升级目标有链接，保留原程序');}
  catch (e) {if (e.code !== 'ENOENT') throw e;}
}
/** Preserve installed programs and user data; publish only explicitly validated compatibility seams. */
export async function prepareRc1Profile(home, runtime, {checkpoint = async () => {}} = {}) {
  const profile = path.join(home, 'profiles/web'), manifestFile = path.join(profile, 'package.json');
  const original = await optional(manifestFile);
  const markerFile = path.join(profile, '.desktop-core-rc1.json'), markerBefore = await optional(markerFile);
  if (!original) {
    if (markerBefore) throw Error('发现没有对应配置的核心升级标记，未覆盖');
    return null;
  }
  const manifest = JSON.parse(original);
  if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw Error('已有 DSH 配置无法识别，已保留原文件');
  const specBytes = await optional(path.join(runtime, 'profile-update-rc1.json'));
  const spec = specBytes ? JSON.parse(specBytes) : null;
  if (spec && (spec.owner !== owner || spec.coreVersion !== version || !Array.isArray(spec.files) || spec.files.length > 6 || !Array.isArray(spec.plugins) || spec.plugins.length > 100)) throw Error('定制版升级清单无效');
  if (markerBefore) {
    const marker = JSON.parse(markerBefore);
    const fresh = marker.kind === 'fresh' && /^[a-f0-9]{64}$/.test(marker.bundleSha256 ?? '') && Object.keys(marker).length === 4;
    const migrated = marker.kind === undefined && /^[a-f0-9]{64}$/.test(marker.specSha256 ?? '') && Object.keys(marker).length === 3;
    if (marker.owner !== owner || marker.coreVersion !== version || (!fresh && !migrated)) throw Error('已有其他核心升级标记，未覆盖');
    if (migrated && specBytes) {
      if (marker.specSha256 !== hash(specBytes)) throw Error('已有其他核心升级标记，未覆盖');
      return {profile, current:true};
    }
    if (await completedMarkerReceipt(home,profile,markerBefore,fresh)) {
      await verifyMarkerLink(profile,runtime,manifest);
      return {profile,current:true};
    }
    throw Error('已有其他核心升级标记，未覆盖');
  }
  if (!spec) throw Error('此核心缺少已验证的定制版升级清单；未知旧配置已保留');
  const lock = path.join(home, '.rc1-profile-update.lock');
  try {await fs.mkdir(lock, {mode: 0o700});} catch (e) {if (e.code === 'EEXIST') throw Error('另一个核心升级尚未完成，未覆盖配置'); throw e;}
  const plans = []; let backup, migration, createdLink;
  const applied = [];
  try {
    const seen = new Set();
    for (const row of spec.files) {
      if (!allowed(row.path) || seen.has(row.path) || !/^[a-f0-9]{64}$/.test(row.sha256)) throw Error('定制版升级路径无效');
      seen.add(row.path);
      const source = path.join(runtime, row.path), file = path.join(profile, row.path);
      const after = await fs.readFile(source);
      if (after.length !== row.bytes || hash(after) !== row.sha256) throw Error('升级内容校验失败：' + row.path);
      await realParents(profile, file);
      const before = await optional(file), beforeHash = before ? hash(before) : 'missing';
      if (beforeHash !== row.sha256 && !row.before?.includes(beforeHash)) throw Error('程序存在未经验证的改动：' + row.path);
      if (beforeHash !== row.sha256) plans.push({file, before, after});
    }
    const compatibilityFile = path.join(profile, 'compatibility.json');
    const compatibilityBefore = await optional(compatibilityFile), grants = compatibilityBefore ? JSON.parse(compatibilityBefore) : {};
    if (!grants || Array.isArray(grants) || typeof grants !== 'object') throw Error('原兼容性配置无效，未覆盖');
    const validatedNames = new Set([
      ...manifest.dsh.profile.bundles.filter(name => !name.startsWith('@deepseek-ai/')),
      ...spec.plugins.filter(row => Object.hasOwn(manifest.dependencies ?? {}, row.name)).map(row => row.name),
    ]);
    for (const name of validatedNames) {
      if (name === 'dsh-desktop-core-compatibility') continue;
      const row = spec.plugins.find(row => row.name === name);
      if (!row) throw Error('新增插件尚未经过此次核心兼容验证：' + name);
      const file = path.join(profile, 'node_modules', name, 'package.json'), bytes = await fs.readFile(file), pkg = JSON.parse(bytes);
      if (pkg.version !== row.version || hash(bytes) !== row.manifestSha256) throw Error('插件版本在验证后变化：' + name);
      const key = name + '@' + pkg.version;
      if (grants[key] !== undefined && !Array.isArray(grants[key])) throw Error('原兼容性授权格式无效');
      grants[key] = [...new Set([...(grants[key] ?? []), '0.2.2-rc.1'])];
    }
    const compatibilityAfter = Buffer.from(JSON.stringify(grants, null, 2) + '\n');
    if (!compatibilityBefore?.equals(compatibilityAfter)) plans.push({file: compatibilityFile, before: compatibilityBefore, after: compatibilityAfter});
    manifest.dependencies ??= {};
    manifest.dependencies['dsh-desktop-core-compatibility'] = 'file:' + path.join(runtime, 'node_modules/dsh-desktop-core-compatibility');
    if (!manifest.dsh.profile.bundles.includes('dsh-desktop-core-compatibility')) manifest.dsh.profile.bundles.splice(2, 0, 'dsh-desktop-core-compatibility');
    const next = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (!original.equals(next)) plans.push({file: manifestFile, before: original, after: next});
    plans.push({file: markerFile, before: markerBefore, after: Buffer.from(JSON.stringify({owner: spec.owner, coreVersion: spec.coreVersion, specSha256: hash(specBytes)}) + '\n')});
    // Only this new owned module is linked. Existing bundles, modules and settings stay in place.
    const link = path.join(profile, 'node_modules/dsh-desktop-core-compatibility');
    const desired = path.join(runtime, 'node_modules/dsh-desktop-core-compatibility');
    let linkBefore = null;
    try {if (!(await fs.lstat(link)).isSymbolicLink()) throw Error('兼容模块名称已被其他程序占用'); linkBefore = await fs.readlink(link); if (linkBefore !== desired) throw Error('兼容模块链接目标有自定义修改');}
    catch (e) {if (e.code !== 'ENOENT') throw e;}
    const configPlan = await prepareRc1ProfileMigration(profile, path.join(runtime, 'node_modules'));
    if (!plans.length && linkBefore === desired && !configPlan.changed) return {profile, current: true};
    backup = path.join(home, 'backups', 'desktop-core-rc1-' + randomUUID());
    await fs.mkdir(backup, {recursive: true, mode: 0o700});
    const receipt = {owner: 'dsh-desktop-core-rc1-v1', profile, runtime, files: [], link: {file: link, before: linkBefore, after: desired}, migration: null};
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i], saved = p.before ? String(i) + '.before' : null;
      if (saved) await fs.writeFile(path.join(backup, saved), p.before, {mode: 0o600, flag: 'wx'});
      receipt.files.push({file: p.file, saved, before: p.before ? hash(p.before) : 'missing', after: hash(p.after)});
    }
    await fs.writeFile(path.join(backup, 'restore.json'), JSON.stringify(receipt, null, 2), {mode: 0o600, flag: 'wx'});
    for (const p of plans) {
      const now = await optional(p.file);
      if (p.before === null ? now !== null : !now?.equals(p.before)) throw Error('升级期间程序或配置发生并发修改');
      await atom(p.file, p.after); applied.push(p); await checkpoint('published-' + applied.length);
    }
    if (linkBefore === null) {await fs.symlink(desired, link); createdLink = {file: link, target: desired};}
    migration = await commitRc1ProfileMigration(configPlan, backup);
    receipt.migration = migration;
    receipt.complete = true;
    await atom(path.join(backup, 'restore.json'), Buffer.from(JSON.stringify(receipt, null, 2)));
    await checkpoint('complete');
    return {profile, backup, updated: applied.length, current: false};
  } catch (error) {
    if (migration) await restoreRc1ProfileMigration(migration);
    if (createdLink) try {if (await fs.readlink(createdLink.file) === createdLink.target) await fs.unlink(createdLink.file);} catch (e) {if (e.code !== 'ENOENT') error.message += '；兼容链接恢复材料已保留';}
    for (const p of applied.reverse()) if ((await optional(p.file))?.equals(p.after)) {if (p.before) await atom(p.file, p.before); else await fs.rm(p.file, {force: true});}
    throw error;
  } finally {await fs.rmdir(lock);}
}

/** Explicit rollback preserves concurrent edits and validates every saved byte before writing. */
export async function restoreRc1Profile(backup) {
  const receipt = JSON.parse(await fs.readFile(path.join(backup, 'restore.json'), 'utf8'));
  if (receipt.owner !== 'dsh-desktop-core-rc1-v1' || !Array.isArray(receipt.files)) throw Error('核心恢复材料无效');
  const rows = [];
  for (const row of receipt.files) {
    if (!row.file.startsWith(receipt.profile + path.sep) || (row.saved !== null && !/^\d+\.before$/.test(row.saved))) throw Error('核心恢复路径无效');
    const current = await optional(row.file), currentHash = current ? hash(current) : 'missing';
    if (currentHash === row.before) continue;
    if (currentHash !== row.after) throw Error('升级后程序或配置有并发修改，保留当前内容和恢复点');
    const before = row.saved === null ? null : await fs.readFile(path.join(backup, row.saved));
    if ((before ? hash(before) : 'missing') !== row.before) throw Error('核心备份校验失败');
    rows.push({file: row.file, before});
  }
  const link = receipt.link;
  let currentLink = null;
  try {currentLink = await fs.readlink(link.file);} catch (e) {if (e.code !== 'ENOENT') throw e;}
  if (currentLink !== link.before && currentLink !== link.after) throw Error('兼容链接有并发修改');
  if (receipt.migration) await restoreRc1ProfileMigration(receipt.migration);
  for (const row of rows.reverse()) {if (row.before) await atom(row.file, row.before); else await fs.rm(row.file, {force: true});}
  if (currentLink !== link.before) {await fs.unlink(link.file); if (link.before !== null) await fs.symlink(link.before, link.file);}
  return {restored: rows.length};
}
