import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installDesktopBrowser } from './install-desktop-browser.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-browser-install-'));
  const profile = path.join(directory, 'profile'), modules = path.join(directory, 'modules');
  await mkdir(path.join(profile, 'node_modules/dsh-desktop-browser'), { recursive: true });
  await mkdir(path.join(modules, '@deepseek-ai/dsh'), { recursive: true });
  await writeFile(path.join(modules, '@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '0.2.1-alpha.1' }));
  const manifest = JSON.stringify({ private: true, dependencies: { existing: '1.0.0' }, dsh: { profile: { bundles: ['existing'] } } });
  await writeFile(path.join(profile, 'package.json'), manifest);
  await writeFile(path.join(profile, 'node_modules/dsh-desktop-browser/previous'), 'old plugin');
  await writeFile(path.join(profile, 'credentials-marker'), 'keep');
  t.after(async () => { await chmod(profile, 0o700); await rm(directory, { recursive: true, force: true }); });
  return { profile, modules, manifest };
}

test('browser installation and reinstallation preserve unrelated profile configuration', async t => {
  const { profile, modules } = await fixture(t);
  await installDesktopBrowser(profile, modules); await installDesktopBrowser(profile, modules);
  const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['existing', 'dsh-desktop-browser']);
  assert.equal(manifest.dependencies.existing, '1.0.0');
  assert.equal(await readFile(path.join(profile, 'credentials-marker'), 'utf8'), 'keep');
  assert.match(await readFile(path.join(profile, 'node_modules/dsh-desktop-browser/browser-panel.html'), 'utf8'), /网站地址/);
  await import(path.join(profile, 'node_modules/dsh-desktop-browser/isolated-login.mjs'));
});

test('unsupported core leaves the manifest and previous browser plugin intact', async t => {
  const { profile, modules, manifest } = await fixture(t);
  await writeFile(path.join(modules, '@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '0.1.0' }));
  await assert.rejects(installDesktopBrowser(profile, modules), /先验证/);
  assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), manifest);
  assert.equal(await readFile(path.join(profile, 'node_modules/dsh-desktop-browser/previous'), 'utf8'), 'old plugin');
});

test('a manifest commit failure restores the replaced plugin and permits a successful retry', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const { profile, modules, manifest } = await fixture(t);
  await chmod(profile, 0o500);
  await assert.rejects(installDesktopBrowser(profile, modules), { code: 'EACCES' });
  assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), manifest);
  assert.equal(await readFile(path.join(profile, 'node_modules/dsh-desktop-browser/previous'), 'utf8'), 'old plugin');
  await chmod(profile, 0o700);
  await installDesktopBrowser(profile, modules);
  assert.match(await readFile(path.join(profile, 'node_modules/dsh-desktop-browser/index.mjs'), 'utf8'), /requestRejection/);
});
