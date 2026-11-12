import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdir, readFile, writeFile, rename, symlink} from 'node:fs/promises';
import {FileWorkbench} from '../files.mjs';
import {fixture, addShared, code} from './fixture.mjs';

test('real internal/workspace/shared roots persist their logical IDs and generations', async t => {
  const f = await fixture(t);
  assert.equal(f.root.status, 'ready');
  assert.equal(f.internal.status, 'ready');
  assert.equal(f.internal.path, path.join(f.home, 'storage/desktop-files/files'));
  const shared = await addShared(f.service, f.shared);
  assert.equal(shared.mode, 'read-only');
  await f.service.close();
  const reopened = new FileWorkbench({home: f.home, workspaceRegistry: f.workspaceRegistry, fsProvider: f.fsProvider});
  t.after(() => reopened.close());
  const {roots} = await reopened.manage('roots.list');
  assert.equal(roots.find(value => value.id === shared.id).generation, shared.generation);
  assert.equal(roots.find(value => value.id === f.root.id).generation, f.root.generation);
});

test('shared confirmation is single use; expired plans never authorize', async t => {
  let now = 1000;
  const f = await fixture(t, {clock: () => now});
  const plan = await f.service.manage('roots.planAdd', {path: f.shared});
  now += 60_001;
  await assert.rejects(f.service.manage('roots.add', {planId: plan.planId, confirm: true}), code('expired', 410));
  const fresh = await f.service.manage('roots.planAdd', {path: f.shared});
  await f.service.manage('roots.add', {planId: fresh.planId, confirm: true});
  await assert.rejects(f.service.manage('roots.add', {planId: fresh.planId, confirm: true}), code('expired', 410));
});

test('revocation removes mapping only and old generation stays unusable', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.shared, 'sentinel.txt'), '保留原件');
  const root = await addShared(f.service, f.shared, 'read-write');
  const p = {rootId: root.id, generation: root.generation};
  await f.service.manage('roots.remove', {...p, confirm: true});
  assert.equal(await readFile(path.join(f.shared, 'sentinel.txt'), 'utf8'), '保留原件');
  await assert.rejects(f.service.manage('list', p), code('revoked', 410));
  const replacement = await addShared(f.service, f.shared, 'read-write');
  assert.notEqual(replacement.generation, root.generation);
  assert.notEqual(replacement.id, root.id);
});

test('root replacement is not silently adopted after restart or list', async t => {
  const f = await fixture(t);
  const root = await addShared(f.service, f.shared, 'read-write');
  await rename(f.shared, `${f.shared}-old`);
  await mkdir(f.shared);
  await writeFile(path.join(f.shared, 'sentinel.txt'), 'replacement');
  const {roots} = await f.service.manage('roots.list');
  assert.equal(roots.find(value => value.id === root.id).status, 'changed');
  await assert.rejects(f.service.manage('write', {rootId: root.id, generation: root.generation, path: 'sentinel.txt', text: 'wrong', version: null}), code('root-changed', 409));
  assert.equal(await readFile(path.join(f.shared, 'sentinel.txt'), 'utf8'), 'replacement');
});

test('plan identity must still match when adding a shared directory', async t => {
  const f = await fixture(t);
  const plan = await f.service.manage('roots.planAdd', {path: f.shared, mode: 'read-write'});
  await rename(f.shared, `${f.shared}-old`); await mkdir(f.shared);
  await assert.rejects(f.service.manage('roots.add', {planId: plan.planId, confirm: true}), code('root-changed', 409));
});

test('core registry removal invalidates workspace without changing core registry', async t => {
  const f = await fixture(t);
  f.entities.delete('project');
  await assert.rejects(f.service.manage('list', f.payload()), code('root-unavailable', 410));
  const {roots} = await f.service.manage('roots.list');
  assert.equal(roots.some(value => value.id === f.root.id), false);
});

test('sensitive and broad roots and symlink aliases cannot be authorized', async t => {
  const f = await fixture(t);
  const alias = path.join(f.directory, 'alias'); await symlink(f.shared, alias);
  for (const target of [f.home, os.homedir(), '/', path.join(f.home, 'storage'), alias]) {
    await assert.rejects(f.service.manage('roots.planAdd', {path: target}), code('forbidden', 403));
  }
  const privateRoot = path.join(f.directory, '.ssh'); await mkdir(privateRoot);
  await assert.rejects(f.service.manage('roots.planAdd', {path: privateRoot}), code('forbidden', 403));
  const futureControl = path.join(f.home, 'future-account-control'); await mkdir(futureControl);
  await assert.rejects(f.service.manage('roots.planAdd', {path: futureControl}), code('forbidden', 403));
});

test('corrupt or externally edited roots state fails closed and preserves bytes', async t => {
  const f = await fixture(t);
  const state = path.join(f.home, 'storage/desktop-files/roots.json');
  const original = await readFile(state, 'utf8');
  const invalid = original + 'external'; await writeFile(state, invalid);
  await assert.rejects(f.service.manage('list', f.payload()), code('config-changed', 409));
  const other = new FileWorkbench({home: f.home, workspaceRegistry: f.workspaceRegistry, fsProvider: f.fsProvider});
  t.after(() => other.close());
  await assert.rejects(other.manage('roots.list'), code('unavailable', 503));
  assert.equal(await readFile(state, 'utf8'), invalid);
});

test('simultaneous registry instances never overwrite a newer mapping state', async t => {
  const f = await fixture(t);
  const other = new FileWorkbench({home: f.home, workspaceRegistry: f.workspaceRegistry, fsProvider: f.fsProvider});
  t.after(() => other.close());
  await other.manage('roots.list');
  await addShared(f.service, f.shared);
  const another = path.join(f.directory, 'another'); await mkdir(another);
  await assert.rejects(other.manage('roots.planAdd', {path: another}), code('config-changed', 409));
  assert.equal((await f.service.manage('roots.list')).roots.filter(value => value.kind === 'shared').length, 1);
});

test('unavailable newly discovered workspace is isolated while other roots remain usable', async t => {
  const f = await fixture(t);
  const alias = path.join(f.directory, 'replaced-project'); await symlink(f.shared, alias);
  f.entities.set('replaced', {id: 'replaced', title: 'A'.repeat(300), path: alias});
  const {roots} = await f.service.manage('roots.list');
  assert.equal(roots.find(value => value.id === 'workspace:replaced').status, 'changed');
  assert.equal(roots.find(value => value.id === f.internal.id).status, 'ready');
  assert.equal(roots.find(value => value.id === 'workspace:replaced').label.length, 100);
  assert.equal((await f.service.manage('list', f.payload())).entries.length, 0);
});
