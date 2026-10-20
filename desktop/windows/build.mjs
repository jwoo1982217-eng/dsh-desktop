import {cp, mkdir, readFile, writeFile, readdir, lstat, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const options = {};
for (const args = process.argv.slice(2); args.length;) {
  const key = args.shift();
  if (key === '--reuse-stage') options.reuse = true;
  else if (['--runtime', '--out', '--tools'].includes(key) && args[0]) options[key.slice(2)] = path.resolve(args.shift());
  else throw Error('Usage: node desktop/windows/build.mjs --runtime DIR --out DIR --tools DIR [--reuse-stage]');
}
if (!options.runtime || !options.out || !options.tools) throw Error('runtime, out and tools are required');
const require = createRequire(path.join(options.tools, 'package.json'));
const {createPackage} = await import(pathToFileURL(require.resolve('@electron/asar')).href);
const RE = await import(pathToFileURL(require.resolve('resedit')).href);
const {getMakeNsisPath} = require('app-builder-lib/out/toolsets/windows.js');
const stage = path.join(options.out, 'stage');
await mkdir(options.out, {recursive: true});
if (!options.reuse) {
  const sevenzip = require('7zip-bin').path7za;
  const {chmod} = await import('node:fs/promises');
  await chmod(sevenzip, 0o755);
  execFileSync('python3', [path.join(directory, 'stage.py'), '--runtime', options.runtime, '--out', stage, '--cache', path.join(options.out, 'cache'), '--sevenzip', sevenzip], {stdio: 'inherit'});
}
const appInfo = JSON.parse(await readFile(path.join(directory, '../macos/app/package.json'), 'utf8'));
const bundle = JSON.parse(await readFile(path.join(stage, 'resources/runtime/bundle.json'), 'utf8'));
if (bundle.version !== appInfo.version) throw Error('Runtime and app versions differ');
const app = path.join(options.out, 'app-source');
await rm(app, {recursive: true, force: true});
await cp(path.join(directory, '../macos/app'), app, {recursive: true});
await writeFile(path.join(app, 'package.json'), JSON.stringify({...appInfo, name: 'dsh-desktop'}, null, 2));
await createPackage(app, path.join(stage, 'resources/app.asar'));
await cp(path.join(directory, 'icon.ico'), path.join(stage, 'resources/icon.ico'));
await cp(path.join(directory, '使用说明.txt'), path.join(stage, '使用说明.txt'));
await cp(path.join(directory, 'backend-runner.mjs'), path.join(stage, 'resources/bin/backend-runner.mjs'));

// Resource editing is pure JavaScript, so building on macOS does not need Wine.
const exeFile = path.join(stage, 'DSH.exe');
const exe = RE.NtExecutable.from(await readFile(exeFile), {ignoreCert: true});
const resources = RE.NtExecutableResource.from(exe);
const icon = RE.Data.IconFile.from(await readFile(path.join(directory, 'icon.ico')));
for (const group of RE.Resource.IconGroupEntry.fromEntries(resources.entries))
  RE.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icon.icons.map(item => item.data));
for (const info of RE.Resource.VersionInfo.fromEntries(resources.entries)) {
  info.setFileVersion(appInfo.version + '.0');
  info.setProductVersion(appInfo.version + '.0');
  for (const language of info.getAllLanguagesForStringValues()) info.setStringValues(language, {
    ProductName: 'DSH', FileDescription: 'DSH Desktop', CompanyName: 'DSH Desktop',
    OriginalFilename: 'DSH.exe', InternalName: 'DSH', LegalCopyright: 'DSH Desktop',
    ProductVersion: appInfo.version, FileVersion: appInfo.version,
  });
  info.outputToResourceEntries(resources.entries);
}
resources.outputResource(exe);
await writeFile(exeFile, Buffer.from(exe.generate()));

const files = [], dirs = [];
async function walk(folder) {
  for (const entry of await readdir(folder)) {
    const file = path.join(folder, entry), stat = await lstat(file);
    if (stat.isSymbolicLink()) throw Error('Windows payload must not contain symlinks');
    if (stat.isDirectory()) { dirs.push(path.relative(stage, file)); await walk(file); }
    else files.push({path: path.relative(stage, file).replaceAll(path.sep, '/'), bytes: stat.size,
      sha256: createHash('sha256').update(await readFile(file)).digest('hex')});
  }
}
await walk(stage);
const unsafe = /["$\r\n]/;
if (files.some(f => unsafe.test(f.path)) || dirs.some(d => unsafe.test(d))) throw Error('Unsafe NSIS manifest path');
const manifest = path.join(options.out, 'payload-manifest.json');
await writeFile(manifest, JSON.stringify(files, null, 2) + '\n');
const uninstall = path.join(options.out, 'uninstall-files.nsh');
await writeFile(uninstall, [
  ...files.map(file => `Delete "$INSTDIR\\${file.path.replaceAll('/', '\\')}"`),
  ...dirs.sort((a,b) => b.length - a.length).map(dir => `RMDir "$INSTDIR\\${dir.replaceAll(path.sep, '\\')}"`),
].join('\n') + '\n');
const installer = path.join(options.out, `DSH-${appInfo.version}-Windows-x64-Setup.exe`);
const compiler = await getMakeNsisPath('1.2.1');
execFileSync(compiler.path, ['-V2', `-DSTAGE=${stage}`, `-DOUTPUT=${installer}`, `-DVERSION=${appInfo.version}`,
  `-DDELETEFILES=${uninstall}`, `-DSIZE_KB=${Math.ceil(files.reduce((n,f) => n + f.bytes, 0) / 1024)}`, path.join(directory, 'installer.nsi')],
  {stdio: 'inherit', env: {...process.env, ...compiler.env}});
const receipt = {version: appInfo.version, coreVersion: bundle.coreVersion, platform: 'win32-x64',
  electron: '44.7.2', node: '24.14.0', files: files.length, installer,
  bytes: (await lstat(installer)).size, sha256: createHash('sha256').update(await readFile(installer)).digest('hex'),
  signed: false, windowsNativeLaunchVerified: false, profileDataBundled: false};
await writeFile(path.join(options.out, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
await writeFile(installer + '.sha256', receipt.sha256 + '  ' + path.basename(installer) + '\n');
console.log('Installer:', installer);
