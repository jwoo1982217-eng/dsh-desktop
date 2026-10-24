import {cp, mkdir, readFile, writeFile, rm, readdir, lstat, realpath, readlink, symlink, chmod} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {rebaseReleaseLinks} from './release-links.mjs';
import {JETHUB_PACKAGE, JETHUB_LEGACY_PACKAGE} from '../../scripts/jethub-package.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const require = createRequire(path.join(directory, 'tools/package.json'));
const {packager} = await import(pathToFileURL(require.resolve('@electron/packager')).href);
const appInfo = JSON.parse(await readFile(path.join(directory, 'app/package.json'), 'utf8'));
// Keep the macOS bundle version increasing with product releases. The first
// delivered 0.1.0 used build 1; subsequent builds and versions compare above it.
const bundleVersion = appInfo.version.split('.').map((part, index) => Number(part) + (index === 0 ? 1 : 0)).join('.');
const args = process.argv.slice(2);
let output = path.join(root, 'build-delivery/macos-20261015'), ourFree, reuseRuntime = false, reuseApp = false;
while (args.length) {
  const arg = args.shift();
  if (arg === '--out' && args[0]) output = path.resolve(args.shift());
  else if (arg === '--our-free-model' && args[0]) ourFree = path.resolve(args.shift());
  else if (arg === '--reuse-runtime') reuseRuntime = true;
  else if (arg === '--reuse-app') { reuseRuntime = true; reuseApp = true; }
  else throw Error('Usage: node desktop/macos/build.mjs [--out DIR] [--our-free-model SOURCE]');
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('此安装包需在 Mac arm64 上构建。');
const work = path.join(output, 'work');
await mkdir(output, {recursive: true});
if (!reuseRuntime) await rm(work, {recursive: true, force: true});
await mkdir(work, {recursive: true});
const runtime = path.join(work, 'runtime'), modules = path.join(runtime, 'node_modules');
console.log('1/6 收集锁定运行时与程序组件');
if (!reuseRuntime) {
await cp(path.join(root, 'desktop-runtime/node_modules'), modules, {recursive: true, verbatimSymlinks: true,
  filter: from => !['.cache', '.install-lock', '.DS_Store'].includes(path.basename(from))});

const sources = {
  [JETHUB_PACKAGE]: 'vendor/dsh-codearts-auth', '@zseven-w/dsh-noema': 'vendor/dsh-noema',
  'dsh-peer': 'peer', 'dsh-local-knowledge': 'knowledge', 'dsh-desktop-browser': 'desktop-browser', 'dsh-team': 'team',
  'dsh-desktop-chatgpt': 'desktop-chatgpt', 'dsh-appearance-center': 'appearance',
  'dsh-model-routing': 'model-routing', 'dsh-knowledge-workbench': 'knowledge-workbench',
};
if (ourFree) sources['dsh-our-free-model'] = ourFree;
const rejected = new Set(['node_modules', '.git', 'build-delivery', '.env', '.DS_Store', 'credentials', 'sessions']);
for (const [name, relative] of Object.entries(sources)) {
  const source = path.resolve(root, relative), target = path.join(modules, name);
  await rm(target, {recursive: true, force: true});
  await mkdir(path.dirname(target), {recursive: true});
  await cp(source, target, {recursive: true, verbatimSymlinks: true,
    filter: from => !rejected.has(path.basename(from)) && !/\.(?:log|bak|jks|keystore|p12|apk|aab)$/.test(from)});
}
// 旧路径只作兼容别名，不能注册第二份 provider/accountPool。
await rm(path.join(modules, JETHUB_LEGACY_PACKAGE), {recursive: true, force: true});
await symlink(JETHUB_PACKAGE, path.join(modules, JETHUB_LEGACY_PACKAGE));
for (const file of ['chatgpt.js', 'chatgpt-page.html', 'chatgpt-account.js', 'chatgpt-protocol.js', 'chatgpt-adapter.js'])
  await cp(path.join(root, 'phone-account', file), path.join(modules, 'dsh-desktop-chatgpt', file));
// The desktop version imports the shared skill receiver under this name.
await cp(path.join(root, 'phone-qq/skill-import.js'), path.join(modules, 'dsh-peer/skill-import.js'));

// Runtime overlays replace their actual pnpm targets, not the symlink itself.
for (const name of await readdir(path.join(root, 'runtime/overlays/@deepseek-ai'))) {
  const target = await realpath(path.join(modules, '@deepseek-ai', name));
  if (!target.startsWith(modules + path.sep)) throw Error(`运行时链接越界：${name}`);
  await cp(path.join(root, 'runtime/overlays/@deepseek-ai', name), target, {recursive: true});
}
// Every release link must stay inside the release, so moving the .app is safe.
let links = 0, files = 0;
async function verifyTree(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const text = await readlink(file);
      let target;
      try { target = await realpath(file); } catch { throw Error(`发行包存在失效链接：${path.relative(runtime, file)}`); }
      if (!target.startsWith(runtime + path.sep)) throw Error(`发行包链接指向外部目录：${path.relative(runtime, file)}`);
      if (path.isAbsolute(text)) { await rm(file); await symlink(path.relative(path.dirname(file), target), file); }
      links++;
    } else if (entry.isDirectory()) await verifyTree(file);
    else files++;
  }
}
await verifyTree(runtime);
const plugins = [...Object.keys(sources), 'dsh-channel-qq', 'dsh-pocket'];
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-auto-review', '@deepseek-ai/dsh-experimental-inspector-profile', ...plugins];
const profile = {name: 'dsh-profile-web', private: true, dependencies: {}, dsh: {profile: {bundles}}};
await writeFile(path.join(runtime, 'bundle.json'), JSON.stringify({version: appInfo.version, coreVersion: '0.2.1-alpha.4', plugins, profile}, null, 2));
await mkdir(path.join(work, 'bin'));
execFileSync('/usr/bin/lipo', [process.execPath, '-thin', 'arm64', '-output', path.join(work, 'bin/node')]);
await chmod(path.join(work, 'bin/node'), 0o755);
const nodeLicense = await fetch('https://raw.githubusercontent.com/nodejs/node/v24.14.0/LICENSE');
if (!nodeLicense.ok) throw Error('无法取得 Node.js 发行声明');
await writeFile(path.join(work, 'bin/NODE-LICENSE.txt'), await nodeLicense.text());
await writeFile(path.join(runtime, 'THIRD-PARTY-NOTICES.txt'), `DSH desktop ${appInfo.version}\nDSH core: @deepseek-ai/dsh 0.2.1-alpha.4\nElectron: 44.7.2 (MIT), Chromium notices are in the application Resources.\nNode.js: ${process.versions.node}; see ../bin/NODE-LICENSE.txt\nDependency license files are retained alongside each package.\nThis package contains program files only. No account, cookie, API key, chat or skill data is included.\n`);
await writeFile(path.join(work, 'runtime-receipt.json'), JSON.stringify({files, links}));
}
// OpenCode CLI 与 Node 同目录交付，依赖内容由固定哈希核验。
execFileSync('python3', [path.join(root, 'scripts/prepare-opencode-native.py'), '--target', 'darwin-arm64'], {stdio: 'inherit'});
await mkdir(path.join(work, 'bin'), {recursive: true});
await cp(path.join(root, 'native/opencode/darwin-arm64/opencode'), path.join(work, 'bin/opencode'));
await cp(path.join(root, 'native/opencode/darwin-arm64/OPENCODE-NOTICES.txt'), path.join(work, 'bin/OPENCODE-NOTICES.txt'));
await chmod(path.join(work, 'bin/opencode'), 0o755);
const {files: runtimeFiles, links: runtimeLinks} = JSON.parse(await readFile(path.join(work, 'runtime-receipt.json'), 'utf8'));
if (JSON.parse(await readFile(path.join(runtime, 'bundle.json'), 'utf8')).version !== appInfo.version) throw Error('缓存运行时版本不匹配');
console.log(`2/6 打包 Electron 44.7.2（已检查 ${runtimeFiles} 文件、${runtimeLinks} 个内部链接）`);
execFileSync('/usr/bin/swift', [path.join(directory, 'icon.swift'), path.join(work, 'DSH.iconset')], {stdio: 'inherit'});
execFileSync('/usr/bin/iconutil', ['-c', 'icns', path.join(work, 'DSH.iconset'), '-o', path.join(work, 'DSH.icns')]);
const [application] = reuseApp ? [path.join(work, 'packaged/DSH-darwin-arm64')] : await packager({dir: path.join(directory, 'app'), out: path.join(work, 'packaged'),
  name: 'DSH', platform: 'darwin', arch: 'arm64', electronVersion: '44.7.2', appVersion: appInfo.version,
  buildVersion: bundleVersion, appBundleId: 'com.dsh.desktop', appCategoryType: 'public.app-category.developer-tools',
  icon: path.join(work, 'DSH.icns'), asar: true, overwrite: true, prune: false,
  extraResource: [runtime, path.join(work, 'bin')], darwinDarkModeSupport: true,
  extendInfo: {LSMinimumSystemVersion: '13.0', NSMicrophoneUsageDescription: 'DSH 使用麦克风完成语音输入。',
    NSCameraUsageDescription: 'DSH 使用相机扫描配对二维码。', NSLocalNetworkUsageDescription: 'DSH 连接你选择的本地设备和服务。'}});
const appPath = path.join(application, 'DSH.app');
if (reuseApp) {
  const {createPackage} = await import(pathToFileURL(require.resolve('@electron/asar')).href);
  await createPackage(path.join(directory, 'app'), path.join(appPath, 'Contents/Resources/app.asar'));
}
if (reuseApp) {
  const appRuntime=path.join(appPath,'Contents/Resources/runtime');
  await rm(appRuntime,{recursive:true,force:true});
  await cp(runtime,appRuntime,{recursive:true,verbatimSymlinks:true});
}
const releaseLinks = await rebaseReleaseLinks(runtime, path.join(appPath, 'Contents/Resources/runtime'));
await writeFile(path.join(output, 'release-links.json'), JSON.stringify(releaseLinks, null, 2));
await cp(path.join(work, 'bin/opencode'), path.join(appPath, 'Contents/Resources/bin/opencode'));
await cp(path.join(work, 'bin/OPENCODE-NOTICES.txt'), path.join(appPath, 'Contents/Resources/bin/OPENCODE-NOTICES.txt'));
// 复用应用外壳时也更新 Finder 与系统识别的版本。
execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleShortVersionString', '-string', appInfo.version, path.join(appPath, 'Contents/Info.plist')]);
execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleVersion', '-string', bundleVersion, path.join(appPath, 'Contents/Info.plist')]);
console.log('3/6 验证本机签名');
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {stdio: 'inherit'});
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {stdio: 'inherit'});
execFileSync(path.join(appPath, 'Contents/Resources/bin/node'), ['--version'], {stdio: 'inherit'});
execFileSync(path.join(appPath, 'Contents/Resources/bin/opencode'), ['--version'], {stdio: 'inherit'});
console.log('4/6 生成安装组件');
const payload = path.join(work, 'payload'); await rm(payload, {recursive: true, force: true}); await mkdir(payload);
try { execFileSync('/bin/cp', ['-cR', appPath, path.join(payload, 'DSH.app')], {stdio: 'pipe'}); }
catch { await cp(appPath, path.join(payload, 'DSH.app'), {recursive: true, verbatimSymlinks: true}); }
const components = path.join(work, 'components.plist');
execFileSync('/usr/bin/pkgbuild', ['--analyze', '--root', payload, components]);
execFileSync('/usr/bin/plutil', ['-replace', '0.BundleIsRelocatable', '-bool', 'NO', components]);
const component = path.join(work, 'DSH-component.pkg');
execFileSync('/usr/bin/pkgbuild', ['--root', payload, '--component-plist', components, '--identifier', 'com.dsh.desktop',
  '--version', appInfo.version, '--install-location', '/Applications', '--ownership', 'recommended', component], {stdio: 'inherit'});
console.log('5/6 生成可双击的安装包');
const installerResources = path.join(work, 'installer-resources'); await mkdir(installerResources, {recursive: true});
await writeFile(path.join(installerResources, 'welcome.html'), '<html lang="zh-CN"><meta charset="utf-8"><body style="font-family:-apple-system;font-size:14px;line-height:1.8"><h1>安装 DSH 桌面版</h1><p>安装后，在“应用程序”中点击 DSH 图标即可打开独立桌面窗口。</p><p>运行环境已包含在应用中，无需终端或额外安装 Node.js。</p><p>已有 DSH 账号、聊天、技能和设置继续保存在你的用户目录中。</p></body></html>');
const distribution = path.join(work, 'Distribution.xml');
await writeFile(distribution, `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2"><title>DSH 桌面版</title><welcome file="welcome.html" mime-type="text/html"/>
<options customize="never" require-scripts="false" hostArchitectures="arm64"/>
<domains enable_localSystem="true" enable_currentUserHome="false" enable_anywhere="false"/>
<allowed-os-versions><os-version min="13.0"/></allowed-os-versions>
<choices-outline><line choice="default"><line choice="com.dsh.desktop"/></line></choices-outline>
<choice id="default"/><choice id="com.dsh.desktop" visible="false"><pkg-ref id="com.dsh.desktop"/></choice>
<pkg-ref id="com.dsh.desktop" version="${appInfo.version}" onConclusion="none">DSH-component.pkg</pkg-ref></installer-gui-script>`);
const installer = path.join(output, `DSH-${appInfo.version}-macOS-arm64.pkg`);
execFileSync('/usr/bin/productbuild', ['--distribution', distribution, '--resources', installerResources, '--package-path', work, installer], {stdio: 'inherit'});
const sha256 = createHash('sha256').update(await readFile(installer)).digest('hex');
const receipt = {version: appInfo.version, coreVersion: '0.2.1-alpha.4', electronVersion: '44.7.2', nodeVersion: process.versions.node,
  platform: 'darwin-arm64', appPath, installer, sha256, runtimeFiles, internalLinks: runtimeLinks, signed: 'ad-hoc', notarized: false,
  profileDataBundled: false};
await writeFile(path.join(output, 'build-receipt.json'), JSON.stringify(receipt, null, 2));
await writeFile(installer + '.sha256', sha256 + '  ' + path.basename(installer) + '\n');
console.log('6/6 安装包已生成：' + installer);
