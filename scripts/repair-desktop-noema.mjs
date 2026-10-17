import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, parseDocument } from '../desktop-runtime/node_modules/yaml/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async file => {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
async function atomicWrite(file, content) {
  const temporary = file + '.noema-' + randomUUID();
  try {
    await fs.writeFile(temporary, content, { mode: (await fs.stat(file)).mode & 0o777 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Materialize the pinned native package beside a copied Noema plugin. */
export async function repairDesktopNoema({
  profile = path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'profiles/web'),
  modules = path.join(root, 'desktop-runtime/node_modules'),
} = {}) {
  profile = path.resolve(profile); modules = path.resolve(modules);
  const lock = path.join(profile, '.noema-native-repair-lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error('Noema 修复正在运行；请等待原操作完成');
    throw error;
  }
  let staged;
  try {
    const plugin = path.join(profile, 'node_modules/@zseven-w/dsh-noema');
    const metadata = await readJson(path.join(plugin, 'package.json'));
    const platforms = await readJson(path.join(plugin, 'platforms.json'));
    const platform = platforms.find(entry => entry.id === process.platform + '-' + process.arch);
    if (!platform || !/^@zseven-w\/dsh-noema-[a-z0-9-]+$/.test(platform.packageName)
      || !/^noema-mcp(?:\.exe)?$/.test(platform.binaryName)) throw Error('当前平台没有匹配的 Noema 原生包');
    const name = platform.packageName, version = metadata.version, key = name + '@' + version;
    const source = await fs.realpath(path.join(modules, name));
    const sourceMetadata = await readJson(path.join(source, 'package.json'));
    const runtime = await readJson(path.join(modules, '../package.json'));
    const upstream = parse(await fs.readFile(path.join(modules, '../pnpm-lock.yaml'), 'utf8'));
    if (metadata.name !== '@zseven-w/dsh-noema' || sourceMetadata.name !== name
      || sourceMetadata.version !== version || runtime.optionalDependencies?.[name] !== version
      || !sourceMetadata.os?.includes(process.platform) || !sourceMetadata.cpu?.includes(process.arch)
      || !upstream.packages?.[key]?.resolution?.integrity?.startsWith('sha512-')
      || !upstream.snapshots?.[key]?.optional) throw Error('Noema 原生包与插件或运行时锁定版本不匹配');
    const entries = ['package.json', 'LICENSE', 'bin/' + platform.binaryName];
    const hashes = {};
    for (const entry of entries) {
      const file = path.join(source, entry);
      if (!(await fs.lstat(file)).isFile()) throw Error('Noema 原生包文件不完整：' + entry);
      hashes[entry] = digest(await fs.readFile(file));
    }
    if (process.platform !== 'win32') await fs.access(path.join(source, entries[2]), fs.constants.X_OK);
    const target = path.join(profile, 'node_modules', name), targetExists = await exists(target);
    const matches = async directory => {
      try {
        for (const entry of entries) if (digest(await fs.readFile(path.join(directory, entry))) !== hashes[entry]) return false;
        return true;
      } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    };
    if (targetExists && !await matches(target)) throw Error('已有 Noema 原生包含其他修改；保留原文件，请先核对');
    if (targetExists && process.platform !== 'win32') await fs.access(path.join(target, entries[2]), fs.constants.X_OK);
    const files = ['package.json', 'pnpm-lock.yaml'];
    const originals = await Promise.all(files.map(file => fs.readFile(path.join(profile, file), 'utf8')));
    const manifest = JSON.parse(originals[0]), originalManifest = JSON.parse(originals[0]);
    if (!Array.isArray(manifest.dsh?.profile?.bundles) || !manifest.dsh.profile.bundles.includes('@zseven-w/dsh-noema')) throw Error('请选择已安装 Noema 的 DSH profile');
    const declared = manifest.optionalDependencies?.[name] ?? manifest.dependencies?.[name];
    if (declared && declared !== version) throw Error('Profile 已选择其他 Noema 原生包版本；保留原配置');
    manifest.optionalDependencies = { ...manifest.optionalDependencies, [name]: version };
    const document = parseDocument(originals[1]);
    if (document.errors.length || !document.getIn(['importers', '.'])) throw Error('Profile 锁文件无效');
    document.setIn(['importers', '.', 'optionalDependencies', name], { specifier: version, version });
    document.setIn(['packages', key], upstream.packages[key]);
    document.setIn(['snapshots', key], upstream.snapshots[key]);
    const contents = [isDeepStrictEqual(manifest, originalManifest) ? originals[0] : JSON.stringify(manifest, null, 2) + '\n',
      isDeepStrictEqual(document.toJSON(), parse(originals[1])) ? originals[1] : String(document)];
    if (targetExists && contents.every((content, index) => content === originals[index])) return { changed: false, binary: path.join(target, entries[2]), version };
    const backup = path.join(profile, '.noema-native-repair-backup-' + randomUUID());
    await fs.mkdir(backup, { mode: 0o700 });
    for (let index = 0; index < files.length; index++) await fs.writeFile(path.join(backup, files[index]), originals[index], { mode: 0o600 });
    const written = [];
    let installed = false;
    try {
      if (!targetExists) {
        staged = target + '.noema-' + randomUUID();
        await fs.mkdir(path.join(staged, 'bin'), { recursive: true });
        for (const entry of entries) {
          await fs.copyFile(path.join(source, entry), path.join(staged, entry));
          await fs.chmod(path.join(staged, entry), (await fs.stat(path.join(source, entry))).mode & 0o777);
        }
        if (!await matches(staged)) throw Error('Noema 原生包复制校验失败');
      }
      for (let index = 0; index < files.length; index++) if (await fs.readFile(path.join(profile, files[index]), 'utf8') !== originals[index]) throw Error('Profile 在修复期间变化；保留新配置');
      if (staged) {
        if (await exists(target)) throw Error('Noema 原生包在修复期间变化');
        await fs.rename(staged, target); installed = true; staged = undefined;
      }
      for (let index = 0; index < files.length; index++) {
        if (contents[index] === originals[index]) continue;
        const file = path.join(profile, files[index]);
        if (await fs.readFile(file, 'utf8') !== originals[index]) throw Error('Profile 在修复期间变化；保留新配置');
        await atomicWrite(file, contents[index]); written.push(index);
      }
      await fs.writeFile(path.join(backup, 'repair.json'), JSON.stringify({ name, version, hashes, target, targetExisted: targetExists }, null, 2), { mode: 0o600 });
      return { changed: true, binary: path.join(target, entries[2]), version, backup };
    } catch (error) {
      const conflicts = [];
      for (const index of written.reverse()) {
        const file = path.join(profile, files[index]);
        if (await fs.readFile(file, 'utf8') === contents[index]) await atomicWrite(file, originals[index]);
        else conflicts.push(files[index]);
      }
      if (installed) {
        if (await matches(target)) await fs.rm(target, { recursive: true });
        else conflicts.push(name);
      }
      if (conflicts.length) throw new Error('并发修改已保留，原文件备份位于 ' + backup + '：' + conflicts.join(', '), { cause: error });
      throw error;
    }
  } finally {
    if (staged) await fs.rm(staged, { recursive: true, force: true });
    await fs.rm(lock, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (!['--profile', '--modules'].includes(flag) || !value || value.startsWith('--')) throw Error('用法：node scripts/repair-desktop-noema.mjs [--profile 目录] [--modules node_modules目录]');
      options[flag.slice(2)] = value;
    }
    const result = await repairDesktopNoema(options);
    console.log(JSON.stringify(result));
    console.log('Noema 原生依赖已就绪。可在原 DSH 设置页查询记忆；无需重启核心。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
