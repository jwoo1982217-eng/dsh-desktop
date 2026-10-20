import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, readlink, realpath, cp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {rebaseReleaseLinks} from './release-links.mjs';

test('repairs real fs.cp absolute links and the result works after removing the source', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh release links '));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), destination = path.join(root, 'app/runtime');
  await mkdir(path.join(source, 'bin'), {recursive: true});
  await writeFile(path.join(source, 'code.js'), 'program');
  await symlink('../code.js', path.join(source, 'bin/cli'));
  await cp(source, destination, {recursive: true});
  assert.ok(path.isAbsolute(await readlink(path.join(destination, 'bin/cli'))));
  assert.deepEqual(await rebaseReleaseLinks(source, destination), {checked: 1, repaired: 1, allInternal: true});
  await rm(source, {recursive: true});
  assert.equal(await realpath(path.join(destination, 'bin/cli')), await realpath(path.join(destination, 'code.js')));
  assert.deepEqual(await rebaseReleaseLinks(source, destination), {checked: 1, repaired: 0, allInternal: true});
});

test('rejects an unrelated external link before touching other links', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh release refusal '));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), destination = path.join(root, 'app');
  await mkdir(source); await mkdir(destination);
  await writeFile(path.join(source, 'code.js'), 'program');
  await writeFile(path.join(destination, 'code.js'), 'program');
  await writeFile(path.join(root, 'private'), 'outside release');
  await symlink(path.join(source, 'code.js'), path.join(destination, 'a-valid'));
  await symlink(path.join(root, 'private'), path.join(destination, 'z-invalid'));
  await assert.rejects(rebaseReleaseLinks(source, destination), /链接越界/);
  assert.equal(await readlink(path.join(destination, 'a-valid')), path.join(source, 'code.js'));
});
