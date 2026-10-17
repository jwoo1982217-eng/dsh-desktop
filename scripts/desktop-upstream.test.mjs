import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, lstat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { installDesktopUpstream, restoreDesktopUpstream } from './install-desktop-upstream.mjs';
const source = path.resolve('vendor/dsh-codearts-auth');
async function fixture(t, fail = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-upstream-')); t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'), desktop = path.join(root, 'desktop');
  await mkdir(path.join(profile, 'node_modules'), { recursive: true });
  const known = JSON.parse(await readFile('desktop-chatgpt/upstream-source-hashes.json'));
  for (const { path: file } of known.files) {
    const target = path.join(profile, 'node_modules/dsh-codearts-auth', file); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(source, file), target);
  }
  for (const name of ['@zseven-w/dsh-noema', 'dsh-peer', 'dsh-desktop-chatgpt']) {
    const target = path.join(profile, 'node_modules', name); await mkdir(target, { recursive: true }); await writeFile(path.join(target, 'marker'), name);
  }
  const manifest = JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ['dsh-codearts-auth', '@zseven-w/dsh-noema', 'dsh-peer', 'dsh-desktop-chatgpt'] } } });
  await writeFile(path.join(profile, 'package.json'), manifest); await writeFile(path.join(profile, 'user-marker'), 'keep');
  await mkdir(path.join(desktop, 'node_modules/.bin'), { recursive: true }); await writeFile(path.join(desktop, 'node_modules/.bin/dsh'), 'original launcher', { mode: 0o755 });
  if (fail) await writeFile(path.join(desktop, 'node_modules/@deepseek-ai'), 'block swap');
  else { await mkdir(path.join(desktop, 'node_modules/@deepseek-ai/dsh'), { recursive: true }); await writeFile(path.join(desktop, 'node_modules/@deepseek-ai/dsh/marker'), 'old core'); }
  return { root, profile, desktop, manifest };
}
async function restored(f) {
  assert.equal(await readFile(path.join(f.profile, 'package.json'), 'utf8'), f.manifest);
  for (const name of ['@zseven-w/dsh-noema', 'dsh-peer', 'dsh-desktop-chatgpt']) assert.equal(await readFile(path.join(f.profile, 'node_modules', name, 'marker'), 'utf8'), name);
  assert.equal(await readFile(path.join(f.desktop, 'node_modules/.bin/dsh'), 'utf8'), 'original launcher');
  assert.equal(await readFile(path.join(f.profile, 'user-marker'), 'utf8'), 'keep');
}
test('desktop upgrade restores core, plugins and launcher after successful installation', async t => {
  const f = await fixture(t), result = await installDesktopUpstream(f.desktop, f.profile);
  assert.equal(result.version, '0.2.1-alpha.4');
  assert.ok((await lstat(path.join(f.desktop, 'node_modules/@deepseek-ai/dsh'))).isSymbolicLink());
  await restoreDesktopUpstream(result.backup); await restored(f);
  assert.equal(await readFile(path.join(f.desktop, 'node_modules/@deepseek-ai/dsh/marker'), 'utf8'), 'old core');
});
test('failed core swap also restores both account and paired-peer bundles', async t => {
  const f = await fixture(t, true); await assert.rejects(installDesktopUpstream(f.desktop, f.profile)); await restored(f);
});


test('compiled-only installed Jet Hub is accepted while every corresponding JS remains verified', async t => {
  const f = await fixture(t);
  await rm(path.join(f.profile, 'node_modules/dsh-codearts-auth/src'), {recursive:true});
  const result = await installDesktopUpstream(f.desktop, f.profile);
  await restoreDesktopUpstream(result.backup);
  await restored(f);
});

test('a missing compiled Jet Hub file refuses before writing the profile, then recovers', async t => {
  const f = await fixture(t);
  const file = 'lib/llm-adapter.js';
  await rm(path.join(f.profile, 'node_modules/dsh-codearts-auth/src'), {recursive:true});
  await rm(path.join(f.profile, 'node_modules/dsh-codearts-auth', file));
  await assert.rejects(installDesktopUpstream(f.desktop, f.profile));
  await restored(f);
  await cp(path.join(source,file),path.join(f.profile,'node_modules/dsh-codearts-auth',file));
  const result=await installDesktopUpstream(f.desktop,f.profile);
  await restoreDesktopUpstream(result.backup);
  await restored(f);
});


test('unknown edits of an audited desktop Jet Hub file are refused before writes; restoring exact bytes permits retry', async t => {
  const f = await fixture(t);
  const file = path.join(f.profile, 'node_modules/dsh-codearts-auth/lib/minimax-messages.js');
  const original = await readFile(file);
  const changed = Buffer.concat([original, Buffer.from('\n// unrecognized fixture edit\n')]);
  await writeFile(file, changed);
  await assert.rejects(installDesktopUpstream(f.desktop, f.profile), /lib\/minimax-messages\.js/);
  await restored(f);
  assert.deepEqual(await readFile(file), changed);
  await writeFile(file, original);
  const result = await installDesktopUpstream(f.desktop, f.profile);
  await restoreDesktopUpstream(result.backup);
  await restored(f);
});
