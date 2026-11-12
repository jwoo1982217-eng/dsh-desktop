import {cp, mkdir, readFile, writeFile, readdir, lstat, realpath, rm, symlink} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {patchPocket} from '../../runtime/pocket-update/patch.mjs';
import {JETHUB_PACKAGE, JETHUB_LEGACY_PACKAGE} from '../../scripts/jethub-package.mjs';
import {resolveOfmSource, verifyPackagedOfm, resolveJetHubSource, verifyPackagedJetHub} from '../plugin-sources.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const releaseSources = {
  [JETHUB_PACKAGE]: 'vendor/dsh-codearts-auth', '@zseven-w/dsh-noema': 'vendor/dsh-noema',
  'dsh-peer': 'peer', 'dsh-local-knowledge': 'knowledge', 'dsh-desktop-browser': 'desktop-browser',
  'dsh-team': 'team', 'dsh-desktop-chatgpt': 'desktop-chatgpt', 'dsh-appearance-center': 'appearance',
  'dsh-model-routing': 'model-routing', 'dsh-knowledge-workbench': 'knowledge-workbench',
};
const rejected = new Set(['node_modules', '.git', 'build-delivery', '.env', '.DS_Store', 'credentials', 'sessions', '.cache']);
const include = from => !rejected.has(path.basename(from)) && !/\.(?:log|bak|jks|keystore|p12|apk|aab|private)(?:\.|$)/i.test(from);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Assemble program files from the current checkout without installing into any user profile. */
export async function prepareRuntime(out, {ourFree, jetHub, sourceRoot = root} = {}) {
  out = path.resolve(out); sourceRoot = path.resolve(sourceRoot);
  if (out === sourceRoot || sourceRoot.startsWith(out + path.sep)) throw Error('Output must not contain the source checkout');
  const version = JSON.parse(await readFile(path.join(sourceRoot, 'desktop/windows/package.json'))).version;
  const input = path.join(sourceRoot, 'desktop-runtime/node_modules');
  if (out === input || out.startsWith(input + path.sep)) throw Error('Output overlaps installed dependencies');
  if (JSON.parse(await readFile(path.join(input, '@deepseek-ai/dsh/package.json'))).version !== '0.2.1-alpha.4')
    throw Error('Unexpected desktop core; preserve the existing release');
  try { await lstat(out); throw Error('Output already exists; preserve it or choose a new empty destination'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = out + '.preparing-' + randomUUID(), modules = path.join(temp, 'node_modules');
  const ofmSource = await resolveOfmSource(sourceRoot, ourFree);
  const jetHubSource = await resolveJetHubSource(sourceRoot, jetHub);
  const sources = {...releaseSources, [JETHUB_PACKAGE]: jetHubSource.directory, 'dsh-our-free-model': ofmSource.directory};
  const inputs = [];
  try {
    await mkdir(temp, {recursive: true});
    await cp(input, modules, {recursive: true, verbatimSymlinks: true,
      filter: from => !['.cache', '.install-lock', '.DS_Store'].includes(path.basename(from))});
    for (const [name, location] of Object.entries(sources)) {
      const source = path.resolve(sourceRoot, location), target = path.join(modules, name);
      const pkg = JSON.parse(await readFile(path.join(source, 'package.json')));
      if (pkg.name !== name) throw Error(`Unexpected package identity: ${name}`);
      await rm(target, {recursive: true, force: true}); await mkdir(path.dirname(target), {recursive: true});
      await cp(source, target, {recursive: true, verbatimSymlinks: true, filter: include});
    }
    await verifyPackagedOfm(modules, ofmSource);
    await verifyPackagedJetHub(modules, jetHubSource);
    await rm(path.join(modules, JETHUB_LEGACY_PACKAGE), {recursive: true, force: true});
    await symlink(JETHUB_PACKAGE, path.join(modules, JETHUB_LEGACY_PACKAGE));
    for (const name of ['chatgpt.js', 'chatgpt-page.html', 'chatgpt-account.js', 'chatgpt-protocol.js', 'chatgpt-adapter.js'])
      await cp(path.join(sourceRoot, 'phone-account', name), path.join(modules, 'dsh-desktop-chatgpt', name));
    await cp(path.join(sourceRoot, 'phone-qq/skill-import.js'), path.join(modules, 'dsh-peer/skill-import.js'));
    for (const name of await readdir(path.join(sourceRoot, 'runtime/overlays/@deepseek-ai'))) {
      const target = await realpath(path.join(modules, '@deepseek-ai', name));
      if (!target.startsWith(modules + path.sep)) throw Error(`External overlay target: ${name}`);
      await cp(path.join(sourceRoot, 'runtime/overlays/@deepseek-ai', name), target, {recursive: true});
    }
    await patchPocket(await realpath(path.join(modules, 'dsh-pocket')));
    async function inspect(directory) {
      for (const entry of await readdir(directory, {withFileTypes: true})) {
        const file = path.join(directory, entry.name), rel = path.relative(temp, file);
        if (entry.isSymbolicLink()) {
          const target = await realpath(file);
          if (!target.startsWith(temp + path.sep)) throw Error(`External release link: ${rel}`);
        } else if (entry.isDirectory()) await inspect(file);
        else inputs.push({path: rel.replaceAll(path.sep, '/'), sha256: hash(await readFile(file))});
      }
    }
    await inspect(temp);
    const plugins = [...Object.keys(sources), 'dsh-channel-qq', 'dsh-pocket'];
    const profile = {name: 'dsh-profile-web', private: true, dependencies: {}, dsh: {profile: {bundles: [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-agent-team-profile',
      '@deepseek-ai/dsh-experimental-auto-review', '@deepseek-ai/dsh-experimental-inspector-profile', ...plugins]}}};
    await writeFile(path.join(temp, 'bundle.json'), JSON.stringify({version, coreVersion: '0.2.1-alpha.4', plugins, profile}, null, 2));
    const {rename} = await import('node:fs/promises'); await rename(temp, out);
    return {version, sourceFiles: inputs.length, inputs, plugins, profileDataBundled: false};
  } catch (error) { await rm(temp, {recursive: true, force: true}); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  while (args.length) { const key = args.shift(); if (!['--out', '--our-free-model'].includes(key) || !args[0]) throw Error('Usage: --out DIR [--our-free-model SOURCE]'); options[key] = args.shift(); }
  if (!options['--out']) throw Error('--out is required');
  const receipt = await prepareRuntime(options['--out'], {ourFree: options['--our-free-model']});
  await writeFile(path.join(options['--out'], '../runtime-source-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(`Prepared latest Windows runtime ${receipt.version}: ${receipt.sourceFiles} program files`);
}
