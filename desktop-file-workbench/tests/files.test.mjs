import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {Readable, PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import {SandboxedFileSystem} from '@deepseek-ai/dsh-fs-sandbox';
import {writeFile, readFile, mkdir, readdir, rename, symlink, link, stat} from 'node:fs/promises';
import {FileWorkbench, FILE_LIMITS} from '../files.mjs';
import {fixture, addShared, code} from './fixture.mjs';

test('real SDK CAS supports Chinese UTF-8 creation, read, save, and file rename', async t => {
  const f = await fixture(t);
  const created = await f.service.manage('write', f.payload('中文.md', {text: '第一行\n你好世界', version: null}));
  assert.equal(typeof created.version, 'string');
  const initial = await f.service.manage('read', f.payload('中文.md'));
  assert.equal(initial.text, '第一行\n你好世界');
  assert.equal(initial.size, Buffer.byteLength(initial.text));
  const saved = await f.service.manage('write', f.payload('中文.md', {text: '修改以后', version: initial.version}));
  assert.notEqual(saved.version, initial.version);
  await f.service.manage('rename', f.payload('中文.md', {to: '更名.md', version: saved.version}));
  assert.equal(await readFile(path.join(f.workspace, '更名.md'), 'utf8'), '修改以后');
  assert.equal((await stat(path.join(f.workspace, '更名.md'))).nlink, 1);
  const listed = await f.service.manage('list', f.payload());
  assert.ok(listed.entries.find(value => value.name === '更名.md').version);
});

test('external edit and same-name create conflict preserve existing sentinel', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'sentinel.txt'), 'original');
  const initial = await f.service.manage('read', f.payload('sentinel.txt'));
  await writeFile(path.join(f.workspace, 'sentinel.txt'), 'external content');
  await assert.rejects(f.service.manage('write', f.payload('sentinel.txt', {text: 'wrong', version: initial.version})), code('conflict', 409));
  await assert.rejects(f.service.manage('write', f.payload('sentinel.txt', {text: 'wrong', version: null})), code('conflict', 409));
  assert.equal(await readFile(path.join(f.workspace, 'sentinel.txt'), 'utf8'), 'external content');
});

test('binary list has opaque SDK version; edit rejects binary and oversized UTF-8', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'binary.bin'), Buffer.from([0, 1, 255]));
  await writeFile(path.join(f.workspace, 'large.txt'), Buffer.alloc(FILE_LIMITS.maxTextBytes + 1, 65));
  const listed = await f.service.manage('list', f.payload());
  assert.ok(listed.entries.find(value => value.name === 'binary.bin').version);
  await assert.rejects(f.service.manage('read', f.payload('binary.bin')), code('not-text', 415));
  await assert.rejects(f.service.manage('read', f.payload('large.txt')), code('too-large', 413));
});

test('symlink and hardlink escape and sensitive files stay inaccessible', async t => {
  const f = await fixture(t);
  const outside = path.join(f.shared, 'sentinel.txt'); await writeFile(outside, 'outside');
  await symlink(f.shared, path.join(f.workspace, 'escape'));
  await link(outside, path.join(f.workspace, 'hard.txt'));
  await writeFile(path.join(f.workspace, '.env'), 'fixture secret');
  for (const file of ['escape/sentinel.txt', 'hard.txt', '.env', '../shared/sentinel.txt', '/etc/passwd', '%2e%2e/sentinel']) {
    await assert.rejects(f.service.manage('read', f.payload(file)), error => error.expose && [400, 403].includes(error.status));
  }
  const listed = await f.service.manage('list', f.payload());
  assert.equal(listed.entries.some(value => value.name === '.env'), false);
  assert.equal(listed.entries.find(value => value.name === 'escape').blocked, true);
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('read-only shared authorization retains reading and rejects each mutation', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.shared, 'existing.txt'), 'readonly');
  const root = await addShared(f.service, f.shared);
  const p = {rootId: root.id, generation: root.generation, path: 'existing.txt'};
  const read = await f.service.manage('read', p);
  assert.equal(read.text, 'readonly');
  for (const [action, extra] of [['write', {text: 'wrong', version: read.version}], ['mkdir', {path: 'folder'}], ['rename', {to: 'wrong.txt', version: read.version}]]) {
    await assert.rejects(f.service.manage(action, {...p, ...extra}), code('forbidden', 403));
  }
  await assert.rejects(f.service.importFile({...p, path: '', name: 'new.txt', stream: Readable.from(['x'])}), code('forbidden', 403));
  const ticket = await f.service.manage('export.prepare', {...p, version: read.version});
  assert.equal((await f.service.takeExport(ticket.id, {consume: false})).size, 8);
});

test('host provider modes are retained; absent provider never invents file versions', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'existing.txt'), 'data');
  for (const mode of ['read-only', 'workspace-write']) {
    Object.defineProperty(f.fsProvider, 'sandboxMode', {value: mode, configurable: true});
    const service = new FileWorkbench({home: f.home, workspaceRegistry: f.workspaceRegistry, fsProvider: f.fsProvider});
    await service.manage('roots.list');
    assert.equal(service.limits.providerMode, mode);
    assert.equal(service.limits.canNativeMutate, false);
    await assert.rejects(service.manage('mkdir', f.payload('new')), error => error.expose && error.status === 403);
    await service.close();
  }
  delete f.fsProvider.sandboxMode;
  const noProvider = new FileWorkbench({home: f.home, workspaceRegistry: f.workspaceRegistry});
  await noProvider.manage('roots.list');
  assert.equal(noProvider.limits.providerAvailable, false);
  const listed = await noProvider.manage('list', f.payload());
  assert.equal(listed.entries[0].version, undefined);
  await assert.rejects(noProvider.manage('read', f.payload('existing.txt')), code('unavailable', 503));
  await noProvider.close();
});

test('mkdir is exclusive and directory rename remains unsupported without changes', async t => {
  const f = await fixture(t);
  await f.service.manage('mkdir', f.payload('目录'));
  await assert.rejects(f.service.manage('mkdir', f.payload('目录')), code('conflict', 409));
  await assert.rejects(f.service.manage('rename', f.payload('目录', {to: 'other', version: 'ignored'})), code('unsupported', 400));
  assert.deepEqual(await readdir(f.workspace), ['目录']);
});

test('file rename destination conflicts and stale versions never clobber files', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'source.txt'), 'source');
  await writeFile(path.join(f.workspace, 'target.txt'), 'target sentinel');
  const read = await f.service.manage('read', f.payload('source.txt'));
  await assert.rejects(f.service.manage('rename', f.payload('source.txt', {to: 'target.txt', version: read.version})), code('conflict', 409));
  await writeFile(path.join(f.workspace, 'source.txt'), 'external');
  await assert.rejects(f.service.manage('rename', f.payload('source.txt', {to: 'new.txt', version: read.version})), code('conflict', 409));
  assert.equal(await readFile(path.join(f.workspace, 'source.txt'), 'utf8'), 'external');
  assert.equal(await readFile(path.join(f.workspace, 'target.txt'), 'utf8'), 'target sentinel');
});

test('binary import hashes streams and publishes without overwriting destination', async t => {
  const f = await fixture(t);
  const data = Buffer.from([0, 255, 1, 2, 3]);
  const result = await f.service.importFile({...f.payload(), name: 'file.bin', stream: Readable.from([data])});
  assert.equal(result.sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(result.size, 5);
  assert.deepEqual(await readFile(path.join(f.workspace, 'file.bin')), data);
  await assert.rejects(f.service.importFile({...f.payload(), name: 'file.bin', stream: Readable.from(['wrong'])}), code('conflict', 409));
  assert.deepEqual(await readdir(f.workspace), ['file.bin']);
});

test('failed, oversize, and cancelled imports clean only their own private stage', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'sentinel.txt'), 'preserve');
  async function* broken() { yield Buffer.from('first'); throw new Error('fixture stream failure'); }
  await assert.rejects(f.service.importFile({...f.payload(), name: 'failed.bin', stream: Readable.from(broken())}), code('failed', 400));
  // One oversized chunk is rejected before disk write; generated fixtures remain under 32MiB.
  await assert.rejects(f.service.importFile({...f.payload(), name: 'large.bin', stream: Readable.from([Buffer.alloc(FILE_LIMITS.maxImportBytes + 1)])}), code('too-large', 413));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.importFile({...f.payload(), name: 'cancel.bin', stream: Readable.from(['cancel']), signal: controller.signal}), code('aborted', 499));
  assert.deepEqual(await readdir(f.workspace), ['sentinel.txt']);
  assert.equal(await readFile(path.join(f.workspace, 'sentinel.txt'), 'utf8'), 'preserve');
});

test('export HEAD retains ticket, GET streams binary once, stale version and expiry fail', async t => {
  let now = 1000;
  const f = await fixture(t, {clock: () => now});
  const data = Buffer.from([0, 255, 7]); await writeFile(path.join(f.workspace, 'download.bin'), data);
  const entry = (await f.service.manage('list', f.payload())).entries[0];
  const ticket = await f.service.manage('export.prepare', f.payload(entry.path, {version: entry.version}));
  assert.equal((await f.service.takeExport(ticket.id, {consume: false})).size, data.length);
  assert.equal((await f.service.takeExport(ticket.id, {consume: false})).size, data.length);
  const download = await f.service.takeExport(ticket.id, {consume: true});
  const chunks = []; for await (const chunk of download.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), data);
  await assert.rejects(f.service.takeExport(ticket.id, {consume: true}), code('expired', 410));
  const expired = await f.service.manage('export.prepare', f.payload(entry.path, {version: entry.version}));
  now += FILE_LIMITS.exportTtlMs + 1;
  await assert.rejects(f.service.takeExport(expired.id, {consume: false}), code('expired', 410));
  await writeFile(path.join(f.workspace, entry.path), 'changed');
  await assert.rejects(f.service.manage('export.prepare', f.payload(entry.path, {version: entry.version})), code('conflict', 409));
});

test('literal name/content search is bounded, skips secrets/symlinks, supports cancellation', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.workspace, 'nested'));
  await writeFile(path.join(f.workspace, 'nested', '你好.txt'), 'first\n找得到 literal [x]\nlast');
  await writeFile(path.join(f.workspace, '.env'), 'literal [x] secret');
  await symlink(f.shared, path.join(f.workspace, 'outside'));
  const named = await f.service.manage('search', f.payload('', {query: '你好', content: false}));
  assert.deepEqual(named.matches.map(value => value.path), ['nested/你好.txt']);
  const content = await f.service.manage('search', f.payload('', {query: 'literal [x]', content: true}));
  assert.equal(content.matches.length, 1);
  assert.equal(content.matches[0].line, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.manage('search', f.payload('', {query: 'x', content: true}), {signal: controller.signal}), code('aborted', 499));
});

test('provider resolution cannot swap a parent into external sentinel before write', async t => {
  const f = await fixture(t);
  const parent = path.join(f.workspace, 'parent'); await mkdir(parent);
  await writeFile(path.join(f.shared, 'sentinel.txt'), 'outside sentinel');
  const original = f.fsProvider.resolve.bind(f.fsProvider);
  let swapped = false;
  f.fsProvider.resolve = async (file, options) => {
    const target = await original(file, options);
    if (!swapped && file === path.join(parent, 'sentinel.txt')) {
      swapped = true; await rename(parent, `${parent}-old`); await symlink(f.shared, parent);
    }
    return target;
  };
  await assert.rejects(f.service.manage('write', f.payload('parent/sentinel.txt', {text: 'wrong', version: null})), error => error.expose && [403, 409].includes(error.status));
  assert.equal(await readFile(path.join(f.shared, 'sentinel.txt'), 'utf8'), 'outside sentinel');
});

test('root revocation cancels a live import and leaves external data intact', async t => {
  const f = await fixture(t);
  const root = await addShared(f.service, f.shared, 'read-write');
  await writeFile(path.join(f.shared, 'sentinel.txt'), 'external');
  const stream = new PassThrough();
  const pending = f.service.importFile({rootId: root.id, generation: root.generation, path: '', name: 'pending.bin', stream});
  pending.catch(() => {});
  stream.write(Buffer.from('partial'));
  // Wait for our stage to prove import is active before revoking authorization.
  for (let i = 0; i < 100 && !(await readdir(f.shared)).some(name => name.startsWith('.dsh-files-import-')); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await f.service.manage('roots.remove', {rootId: root.id, generation: root.generation, confirm: true});
  await assert.rejects(pending, code('aborted', 499));
  assert.deepEqual(await readdir(f.shared), ['sentinel.txt']);
});

test('an import parent swapped while streaming never publishes or cleans through the replacement', async t => {
  const f = await fixture(t);
  const parent = path.join(f.workspace, 'parent'); await mkdir(parent);
  await writeFile(path.join(f.shared, 'sentinel.txt'), 'external sentinel');
  const stream = new PassThrough();
  const pending = f.service.importFile({...f.payload('parent'), name: 'sentinel.txt', stream});
  pending.catch(() => {}); stream.write(Buffer.from('wrong'));
  for (let i = 0; i < 100 && !(await readdir(parent)).some(name => name.startsWith('.dsh-files-import-')); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await rename(parent, `${parent}-old`); await symlink(f.shared, parent);
  stream.end();
  await assert.rejects(pending, error => error.expose && [403, 409].includes(error.status));
  assert.equal(await readFile(path.join(f.shared, 'sentinel.txt'), 'utf8'), 'external sentinel');
  assert.deepEqual(await readdir(f.shared), ['sentinel.txt']);
});

test('root revocation cancels download midstream and invalidates prepared tickets', async t => {
  const f = await fixture(t);
  const root = await addShared(f.service, f.shared, 'read-write');
  await writeFile(path.join(f.shared, 'large.bin'), Buffer.alloc(512 * 1024, 42));
  const p = {rootId: root.id, generation: root.generation, path: 'large.bin'};
  const entry = (await f.service.manage('list', {...p, path: ''})).entries[0];
  const ticket = await f.service.manage('export.prepare', {...p, version: entry.version});
  const spare = await f.service.manage('export.prepare', {...p, version: entry.version});
  const result = await f.service.takeExport(ticket.id, {consume: true});
  const iterator = result.stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.length, 64 * 1024);
  await f.service.manage('roots.remove', {...p, confirm: true});
  await assert.rejects(iterator.next(), code('aborted', 499));
  await assert.rejects(f.service.takeExport(spare.id, {consume: false}), code('expired', 410));
  assert.equal((await stat(path.join(f.shared, 'large.bin'))).size, 512 * 1024);
});

test('external edits during export stop the stream instead of returning mixed file versions', async t => {
  const f = await fixture(t);
  const full = path.join(f.workspace, 'file.bin');
  await writeFile(full, Buffer.alloc(512 * 1024, 1));
  const entry = (await f.service.manage('list', f.payload())).entries[0];
  const ticket = await f.service.manage('export.prepare', f.payload(entry.path, {version: entry.version}));
  const result = await f.service.takeExport(ticket.id);
  const iterator = result.stream[Symbol.asyncIterator](); await iterator.next();
  await writeFile(full, Buffer.alloc(512 * 1024, 2));
  await assert.rejects(async () => { while (!(await iterator.next()).done) { /* drain until the verified stream rejects */ } }, code('conflict', 409));
});

test('search reports truncation on its actual entry/time budgets and can retry afterwards', async t => {
  let now = 1000;
  const f = await fixture(t, {clock: () => now});
  for (let i = 0; i < 15; i++) await writeFile(path.join(f.workspace, `match-${i}.txt`), 'value');
  const original = f.service.limits;
  f.service.limits = Object.freeze({...original, searchEntries: 4});
  const bounded = await f.service.manage('search', f.payload('', {query: 'match', content: false}));
  assert.equal(bounded.scanned, 4); assert.equal(bounded.truncated, true);
  f.service.limits = Object.freeze({...original, searchMs: 1});
  const resolve = f.fsProvider.resolve.bind(f.fsProvider);
  f.fsProvider.resolve = async (...args) => { await new Promise(r => setTimeout(r, 5)); return resolve(...args); };
  const deadline = await f.service.manage('search', f.payload('', {query: 'value', content: true}));
  assert.equal(deadline.truncated, true);
  f.fsProvider.resolve = resolve;
  f.service.limits = original;
  const retry = await f.service.manage('search', f.payload('', {query: 'match', content: false}));
  assert.equal(retry.matches.length, 15); assert.equal(retry.truncated, false);
});

test('import concurrency cap rejects a third transfer and cancellation frees both slots', async t => {
  const f = await fixture(t);
  const streams = [new PassThrough(), new PassThrough()];
  const controllers = [new AbortController(), new AbortController()];
  const pending = streams.map((stream, i) => f.service.importFile({...f.payload(), name: `pending-${i}`, stream, signal: controllers[i].signal}));
  pending.forEach(value => value.catch(() => {}));
  await assert.rejects(f.service.importFile({...f.payload(), name: 'third', stream: Readable.from(['third'])}), code('busy', 429));
  controllers.forEach(value => value.abort());
  for (const value of pending) await assert.rejects(value, code('aborted', 499));
  await f.service.importFile({...f.payload(), name: 'retry', stream: Readable.from(['retry'])});
  assert.deepEqual(await readdir(f.workspace), ['retry']);
});

test('revoke cancels both active and queued imports without waiting for queued body data', async t => {
  const f = await fixture(t);
  const root = await addShared(f.service, f.shared, 'read-write');
  const p = {rootId: root.id, generation: root.generation, path: ''};
  const pending = [0, 1].map(i => f.service.importFile({...p, name: `queued-${i}`, stream: new PassThrough()}));
  pending.forEach(value => value.catch(() => {}));
  for (let i = 0; i < 100 && !(await readdir(f.shared)).some(name => name.startsWith('.dsh-files-import-')); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await f.service.manage('roots.remove', {...p, confirm: true});
  for (const value of pending) await assert.rejects(value, code('aborted', 499));
  assert.deepEqual(await readdir(f.shared), []);
});

test('real SandboxedFileSystem scopes GUI mutations to verified RW roots without changing default/session policy', async t => {
  const f = await fixture(t);
  const policy = {mode: 'workspace-write', workspaceRoot: f.workspace};
  const ctx = new Context();
  const unprovide = ctx.provide('sandboxPolicy', {defaultMode: 'workspace-write', resolve: () => policy});
  t.after(unprovide);
  const provider = new SandboxedFileSystem(ctx, {cwd: f.home, diffBasisMaxBytes: 2 * 1024 * 1024});
  const service = new FileWorkbench({home: f.home, workspaceRegistry: f.workspaceRegistry, fsProvider: provider});
  t.after(() => service.close());
  await service.manage('roots.list');
  assert.equal(service.limits.providerMode, 'workspace-write');
  assert.equal(service.limits.canNativeMutate, true);
  const shared = await addShared(service, f.shared, 'read-write');
  const p = {rootId: shared.id, generation: shared.generation};
  await service.manage('mkdir', {...p, path: '目录'});
  const created = await service.manage('write', {...p, path: '目录/中文.txt', text: '共享目录', version: null});
  await service.manage('rename', {...p, path: '目录/中文.txt', to: '目录/改名.txt', version: created.version});
  await service.importFile({...p, path: '', name: 'binary.bin', stream: Readable.from([Buffer.from([0, 255])])});
  assert.equal(await readFile(path.join(f.shared, '目录/改名.txt'), 'utf8'), '共享目录');
  const internalP = {rootId: f.internal.id, generation: f.internal.generation};
  await service.manage('mkdir', {...internalP, path: 'folder'});
  await service.manage('write', {...internalP, path: 'folder/internal.txt', text: '内部文件', version: null});
  await service.manage('write', f.payload('workspace.txt', {text: '项目文件', version: null}));
  await writeFile(path.join(f.directory, 'outside.txt'), 'external sentinel');
  await symlink(f.directory, path.join(f.shared, 'escape'));
  await assert.rejects(service.manage('write', {...p, path: 'escape/outside.txt', text: 'wrong', version: null}), code('forbidden', 403));
  await assert.rejects(service.manage('write', {...p, path: '../outside.txt', text: 'wrong', version: null}), code('invalid-path', 400));
  const readonlyDirectory = path.join(f.directory, 'readonly'); await mkdir(readonlyDirectory);
  const readonly = await addShared(service, readonlyDirectory);
  await assert.rejects(service.manage('mkdir', {rootId: readonly.id, generation: readonly.generation, path: 'wrong'}), code('forbidden', 403));
  // The provider's existing session/default scope still refuses a direct write outside its original workspace.
  const direct = await provider.resolve(path.join(f.shared, 'direct-outside-session.txt'));
  await assert.rejects(provider.writeText(direct, 'wrong', {kind: 'createIfAbsent'}), error => error.code === 'FS_SANDBOX_DENIED');
  assert.equal(provider.sandboxMode, 'workspace-write');
  assert.deepEqual(policy, {mode: 'workspace-write', workspaceRoot: f.workspace});
  assert.equal(await readFile(path.join(f.directory, 'outside.txt'), 'utf8'), 'external sentinel');
});

test('real read-only SandboxedFileSystem preserves all roots and denies scoped mutation', async t => {
  const f = await fixture(t);
  const ctx = new Context();
  const unprovide = ctx.provide('sandboxPolicy', {defaultMode: 'read-only', resolve: () => ({mode: 'read-only', workspaceRoot: f.workspace})});
  t.after(unprovide);
  const provider = new SandboxedFileSystem(ctx, {cwd: f.home, diffBasisMaxBytes: 2 * 1024 * 1024});
  const service = new FileWorkbench({home: f.home, workspaceRegistry: f.workspaceRegistry, fsProvider: provider});
  t.after(() => service.close()); await service.manage('roots.list');
  assert.equal(service.limits.canWriteText, false); assert.equal(service.limits.canNativeMutate, false);
  await writeFile(path.join(f.workspace, 'sentinel.txt'), 'readonly sentinel');
  const read = await service.manage('read', f.payload('sentinel.txt'));
  await assert.rejects(service.manage('write', f.payload('sentinel.txt', {text: 'wrong', version: read.version})), code('forbidden', 403));
  await assert.rejects(service.manage('mkdir', f.payload('wrong')), code('forbidden', 403));
  assert.equal(await readFile(path.join(f.workspace, 'sentinel.txt'), 'utf8'), 'readonly sentinel');
  assert.equal(provider.sandboxMode, 'read-only');
});
