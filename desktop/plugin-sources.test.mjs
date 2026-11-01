import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveOfmSource, verifyPackagedOfm, resolveJetHubSource, requiredOfmProviders} from './plugin-sources.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
async function temporary(t) {
  const root = process.env.DSH_PLUGIN_TEST_OUTPUT ?? os.tmpdir();
  await fs.mkdir(root, {recursive: true});
  const directory = await fs.mkdtemp(path.join(root, 'dsh-custom-source-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return directory;
}

test('a launcher update cannot silently fall back to an unmarked old OFM package', async t => {
  const directory = await temporary(t);
  await fs.mkdir(path.join(directory, 'vendor/dsh-our-free-model'), {recursive: true});
  await fs.writeFile(path.join(directory, 'vendor/dsh-our-free-model/package.json'), JSON.stringify({name:'dsh-our-free-model',version:'2.5.7'}));
  await assert.rejects(resolveOfmSource(directory), /缺少已审核的 OFM 定制源/);
  assert.deepEqual(await fs.readdir(directory), ['vendor']);
});

test('the maintained source has all existing account channels and actual guarded programs', async () => {
  const source = await resolveOfmSource(repo);
  assert.equal(source.verified.managed, true);
  for (const id of requiredOfmProviders) assert.ok(source.contract.requiredProviders.includes(id), id);
  await verifyPackagedOfm(path.join(repo, 'vendor'), source);
});

test('cached runtime with another plugin version is rejected without modifying it', async t => {
  const directory = await temporary(t);
  const file = path.join(directory, 'dsh-our-free-model/package.json');
  await fs.mkdir(path.dirname(file), {recursive:true});
  const bytes = '{"name":"dsh-our-free-model","version":"2.5.7"}\n';
  await fs.writeFile(file, bytes);
  await assert.rejects(verifyPackagedOfm(directory, {version:'2.8.0'}), /缓存运行时/);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
});

test('JetHub uses its reviewed program fingerprints even when upstream keeps the same rc version', async () => {
  const source = await resolveJetHubSource(repo);
  assert.equal(source.verified.ok, true);
  assert.ok(source.verified.checkedFiles > 100);
});
