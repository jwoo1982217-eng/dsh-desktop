import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareRuntime, releaseSources} from './prepare-runtime.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'DSH Windows 程序 '));
  t.after(() => rm(dir, {recursive: true, force: true}));
  async function put(name, bytes) { const file = path.join(dir, name); await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, bytes); }
  await put('desktop/windows/package.json', '{"version":"test"}');
  await put('desktop-runtime/node_modules/@deepseek-ai/dsh/package.json', '{"version":"0.2.1-alpha.4"}');
  return {dir, put, out: path.join(dir, 'output')};
}
test('an existing release is preserved before collection starts', async t => {
  const {dir, put, out} = await fixture(t); await put('output/sentinel', 'previous release');
  await assert.rejects(prepareRuntime(out, {sourceRoot: dir}), /Output already exists/);
  assert.equal(await readFile(path.join(out, 'sentinel'), 'utf8'), 'previous release');
});
test('an unexpected core and dependency-overlapping output do not mutate inputs', async t => {
  const {dir, put, out} = await fixture(t);
  await assert.rejects(prepareRuntime(path.join(dir, 'desktop-runtime/node_modules/new'), {sourceRoot: dir}), /overlaps/);
  await put('desktop-runtime/node_modules/@deepseek-ai/dsh/package.json', '{"version":"unknown"}');
  await assert.rejects(prepareRuntime(out, {sourceRoot: dir}), /Unexpected desktop core/);
  assert.deepEqual((await readdir(dir)).sort(), ['desktop', 'desktop-runtime']);
});
test('a copied external overlay link cannot modify its target; staging is removed', async t => {
  const {dir, put, out} = await fixture(t);
  for (const [name, source] of Object.entries(releaseSources)) await put(source + '/package.json', JSON.stringify({name}));
  for (const file of ['chatgpt.js', 'chatgpt-page.html', 'chatgpt-account.js', 'chatgpt-protocol.js', 'chatgpt-adapter.js']) await put('phone-account/' + file, 'fixture');
  await put('phone-qq/skill-import.js', 'fixture');
  await put('runtime/overlays/@deepseek-ai/example/index.js', 'replacement');
  await put('outside/index.js', 'must stay unchanged');
  await symlink(path.join(dir, 'outside'), path.join(dir, 'desktop-runtime/node_modules/@deepseek-ai/example'));
  const ourFree = fileURLToPath(new URL('../../vendor/dsh-our-free-model', import.meta.url));
  const jetHub = fileURLToPath(new URL('../../vendor/dsh-codearts-auth', import.meta.url));
  await assert.rejects(prepareRuntime(out, {sourceRoot: dir, ourFree, jetHub}), /External overlay target/);
  assert.equal(await readFile(path.join(dir, 'outside/index.js'), 'utf8'), 'must stay unchanged');
  assert.equal((await readdir(dir)).some(name => name.startsWith('output')), false);
});
