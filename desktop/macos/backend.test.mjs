import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {Backend, prepareProfile, localEntry, redact, existingBackend, statePath} from './app/backend.mjs';

test('local bootstrap validation rejects external, credential and wrong-port URLs', () => {
  assert.ok(localEntry('http://127.0.0.1:3080/?token=private', 3080));
  for (const url of ['http://example.com:3080/?token=x', 'http://127.0.0.1:3081/?token=x',
    'http://user:password@127.0.0.1:3080/?token=x', 'http://127.0.0.1:3080/path?token=x', 'http://127.0.0.1:3080/'])
    assert.equal(localEntry(url, 3080), false);
  assert.equal(redact('http://127.0.0.1:3080/?token=PRIVATE api_key=SECRET').includes('PRIVATE'), false);
  assert.equal(redact('http://127.0.0.1:3080/?token=PRIVATE api_key=SECRET').includes('SECRET'), false);
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh mac rollback '));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const home = path.join(directory, 'home'), runtime = path.join(directory, 'runtime');
  await mkdir(path.join(runtime, 'node_modules/@deepseek-ai/dsh'), {recursive: true});
  await writeFile(path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({version: '0.2.1-alpha.4'}));
  await mkdir(path.join(runtime, 'node_modules/local-plugin'), {recursive: true});
  await writeFile(path.join(runtime, 'node_modules/local-plugin/package.json'), '{}');
  await writeFile(path.join(runtime, 'bundle.json'), JSON.stringify({version: 'test', plugins: ['local-plugin'],
    profile: {dependencies: {}, dsh: {profile: {bundles: ['local-plugin']}}}}));
  return {home, runtime};
}

test('existing profile keeps private data, presets and optional plugins while program link moves', async t => {
  const {home, runtime} = await fixture(t), profile = path.join(home, 'profiles/web');
  await mkdir(path.join(profile, 'node_modules/local-plugin'), {recursive: true});
  await writeFile(path.join(profile, 'node_modules/local-plugin/old.txt'), 'original plugin');
  const manifest = {private: true, dependencies: {'local-plugin': 'file:old'}, dsh: {profile: {bundles: ['local-plugin', 'custom-plugin']}}};
  await writeFile(path.join(profile, 'package.json'), JSON.stringify(manifest));
  const patch = '# user presets\n[]\n';
  await writeFile(path.join(profile, 'cordis.patch.yml'), patch);
  await mkdir(path.join(home, 'sessions'), {recursive: true});
  await writeFile(path.join(home, 'sessions/retained'), 'existing chat');
  const result = await prepareProfile(home, runtime);
  assert.equal(result.fresh, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'package.json'))).dsh, manifest.dsh);
  assert.equal(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'), patch);
  assert.equal(await readFile(path.join(home, 'sessions/retained'), 'utf8'), 'existing chat');
  assert.ok((await lstat(path.join(profile, 'node_modules/local-plugin'))).isSymbolicLink());
  assert.equal(await readFile(path.join(result.backup, 'modules/local-plugin/old.txt'), 'utf8'), 'original plugin');
});

test('failed migration restores original directory and exact manifest; concurrent edits survive', async t => {
  const {home, runtime} = await fixture(t), profile = path.join(home, 'profiles/web');
  await mkdir(path.join(profile, 'node_modules/local-plugin'), {recursive: true});
  await writeFile(path.join(profile, 'node_modules/local-plugin/old.txt'), 'original');
  const original = JSON.stringify({dependencies: {}, dsh: {profile: {bundles: ['local-plugin']}}});
  await writeFile(path.join(profile, 'package.json'), original);
  await assert.rejects(prepareProfile(home, runtime, {beforeCommit() { throw Error('interrupted'); }}), /interrupted/);
  assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), original);
  assert.equal(await readFile(path.join(profile, 'node_modules/local-plugin/old.txt'), 'utf8'), 'original');
  const concurrent = original + '\n';
  await assert.rejects(prepareProfile(home, runtime, {beforeCommit: () => writeFile(path.join(profile, 'package.json'), concurrent)}), /发生变化/);
  assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), concurrent);
  assert.equal(await readFile(path.join(profile, 'node_modules/local-plugin/old.txt'), 'utf8'), 'original');
});

test('occupied port is rejected before touching an existing profile', async t => {
  const {home, runtime} = await fixture(t);
  const server = createServer((request, response) => response.end('unrelated server'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const backend = new Backend({home, runtime, node: process.execPath, port: server.address().port, cwd: tmpdir()});
  await assert.rejects(backend.start(), /端口正在使用/);
  await assert.rejects(lstat(path.join(home, 'profiles/web/package.json')), {code: 'ENOENT'});
});

test('fresh profile initialization is independent of the source checkout', async t => {
  const {home, runtime} = await fixture(t);
  const result = await prepareProfile(home, runtime);
  assert.equal(result.fresh, true);
  assert.equal(await readFile(path.join(home, 'profiles/web/cordis.patch.yml'), 'utf8'), '[]\n');
});

test('a busy existing DSH remains reusable when authentication takes more than three seconds', async t => {
  const {home} = await fixture(t);
  await mkdir(home, {recursive: true});
  const server = createServer((request, response) => setTimeout(() => {
    response.writeHead(303, {'set-cookie': 'session=local-test; HttpOnly', location: '/'}); response.end();
  }, 3400));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  await writeFile(statePath(home, port), JSON.stringify({home, version: '0.2.1-alpha.4', pid: process.pid, url: `http://127.0.0.1:${port}/?token=test-only`}));
  assert.equal((await existingBackend(home, port))?.pid, process.pid);
});
