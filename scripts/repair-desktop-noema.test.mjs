import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '../desktop-runtime/node_modules/yaml/dist/index.js';
import { McpStdioClient } from '../desktop-runtime/node_modules/@zseven-w/dsh-noema/lib/mcp-stdio.js';
import { repairDesktopNoema } from './repair-desktop-noema.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'dsh-noema-repair-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile = path.join(directory, 'profile'), modules = path.join(directory, 'runtime/node_modules');
  const plugin = path.join(profile, 'node_modules/@zseven-w/dsh-noema');
  await fs.mkdir(plugin, { recursive: true });
  for (const entry of ['package.json', 'platforms.json', 'lib/bundled-binary.js']) {
    await fs.mkdir(path.dirname(path.join(plugin, entry)), { recursive: true });
    await fs.copyFile(path.join(root, 'vendor/dsh-noema', entry), path.join(plugin, entry));
  }
  const platforms = JSON.parse(await fs.readFile(path.join(plugin, 'platforms.json'), 'utf8'));
  const platform = platforms.find(entry => entry.id === process.platform + '-' + process.arch);
  assert(platform, 'fixture needs a supported desktop platform');
  const native = path.join(modules, platform.packageName);
  await fs.mkdir(path.dirname(native), { recursive: true });
  await fs.cp(path.join(root, 'desktop-runtime/node_modules', platform.packageName), native, { recursive: true, dereference: true });
  for (const entry of ['package.json', 'pnpm-lock.yaml']) await fs.copyFile(path.join(root, 'desktop-runtime', entry), path.join(modules, '..', entry));
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'test-profile', dependencies: { custom: 'file:./custom' }, dsh: { profile: { bundles: ['custom', '@zseven-w/dsh-noema'] } } }));
  await fs.writeFile(path.join(profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      custom:\n        specifier: file:./custom\n        version: file:custom\npackages: {}\nsnapshots: {}\n");
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), 'user-settings-marker\n');
  await fs.writeFile(path.join(profile, 'credentials-marker'), 'keep-user-data');
  return { directory, profile, modules, native, platform, plugin };
}

test('repair a copied plugin and use its real native engine without changing user settings', async t => {
  const f = await fixture(t);
  const before = parse(await fs.readFile(path.join(f.profile, 'pnpm-lock.yaml'), 'utf8'));
  const resolver = await import(pathToFileURL(path.join(f.plugin, 'lib/bundled-binary.js')));
  assert.equal(resolver.tryResolveBundledNoemaBinary(), undefined);
  const repaired = await repairDesktopNoema(f);
  assert.equal(repaired.changed, true);
  assert.equal(await fs.realpath(resolver.resolveBundledNoemaBinary()), await fs.realpath(repaired.binary));
  const manifest = JSON.parse(await fs.readFile(path.join(f.profile, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, { custom: 'file:./custom' });
  assert.deepEqual(manifest.dsh.profile.bundles, ['custom', '@zseven-w/dsh-noema']);
  assert.equal(manifest.optionalDependencies[f.platform.packageName], repaired.version);
  const locked = parse(await fs.readFile(path.join(f.profile, 'pnpm-lock.yaml'), 'utf8'));
  assert.deepEqual(locked.importers['.'].dependencies, before.importers['.'].dependencies);
  assert.equal(locked.importers['.'].optionalDependencies[f.platform.packageName].version, repaired.version);
  const client = new McpStdioClient({ command: repaired.binary, env: { NOEMA_ROOT: path.join(f.directory, 'isolated-memory') } });
  try {
    await client.start();
    const written = JSON.parse((await client.callTool('noema_remember', { text: '临时验证 标记 DESKTOP_NATIVE_REPAIR_FIXTURE', tags: ['qa'], accept: true }, { timeoutMs: 5000 })).text);
    assert.equal(written.outcome, 'accepted');
    const recall = await client.callTool('noema_recall', { query: 'DESKTOP_NATIVE_REPAIR_FIXTURE' }, { timeoutMs: 5000 });
    assert(recall.text.includes(written.memory_id));
    assert(recall.text.includes('DESKTOP_NATIVE_REPAIR_FIXTURE'));
  } finally { await client.dispose(); }
  assert.equal(await fs.readFile(path.join(f.profile, 'cordis.patch.yml'), 'utf8'), 'user-settings-marker\n');
  assert.equal(await fs.readFile(path.join(f.profile, 'credentials-marker'), 'utf8'), 'keep-user-data');
  const bytes = await Promise.all(['package.json', 'pnpm-lock.yaml'].map(entry => fs.readFile(path.join(f.profile, entry), 'utf8')));
  assert.equal((await repairDesktopNoema(f)).changed, false);
  assert.deepEqual(await Promise.all(['package.json', 'pnpm-lock.yaml'].map(entry => fs.readFile(path.join(f.profile, entry), 'utf8'))), bytes);
});

test('missing binary leaves the profile intact; restoring the source permits a later repair', async t => {
  const f = await fixture(t), binary = path.join(f.native, 'bin', f.platform.binaryName);
  const bytes = await Promise.all(['package.json', 'pnpm-lock.yaml'].map(entry => fs.readFile(path.join(f.profile, entry), 'utf8')));
  await fs.rename(binary, binary + '.saved');
  await assert.rejects(repairDesktopNoema(f), /ENOENT/);
  assert.deepEqual(await Promise.all(['package.json', 'pnpm-lock.yaml'].map(entry => fs.readFile(path.join(f.profile, entry), 'utf8'))), bytes);
  await fs.rename(binary + '.saved', binary);
  assert.equal((await repairDesktopNoema(f)).changed, true);
});

test('foreign native files and another declared version are preserved', async t => {
  const f = await fixture(t), target = path.join(f.profile, 'node_modules', f.platform.packageName);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'package.json'), '{"name":"custom-marker"}');
  await assert.rejects(repairDesktopNoema(f), /含其他修改/);
  assert.equal(await fs.readFile(path.join(target, 'package.json'), 'utf8'), '{"name":"custom-marker"}');
  await fs.rm(target, { recursive: true });
  const file = path.join(f.profile, 'package.json'), manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.optionalDependencies = { [f.platform.packageName]: 'custom-version' };
  const bytes = JSON.stringify(manifest); await fs.writeFile(file, bytes);
  await assert.rejects(repairDesktopNoema(f), /已选择其他/);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
});

test('an occupied repair lock is preserved', async t => {
  const f = await fixture(t), lock = path.join(f.profile, '.noema-native-repair-lock');
  await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner-marker'), 'other-operation');
  await assert.rejects(repairDesktopNoema(f), /修复正在运行/);
  assert.equal(await fs.readFile(path.join(lock, 'owner-marker'), 'utf8'), 'other-operation');
});
