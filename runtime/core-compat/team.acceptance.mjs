import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {applyRc1TeamCompatibility} from './team.mjs';

function fixture(t) {
  const root = process.env.DSH_ACCEPTANCE_ROOT;
  assert.ok(root && path.isAbsolute(root));
  const directory = fs.mkdtempSync(path.join(root, 'team-patch-'));
  const modules = path.join(directory, 'node_modules/@deepseek-ai');
  const core = path.join(modules, 'dsh/package.json');
  fs.mkdirSync(path.dirname(core), {recursive: true}); fs.writeFileSync(core, JSON.stringify({version: '0.2.2-rc.1'}));
  const files = ['dsh-experimental-agent-team', 'dsh-experimental-tool-agent-team'].map(name => {
    const target = path.join(modules, name, 'lib/index.js');
    const original = execFileSync('tar', ['-xOf', path.join(root, `deepseek-ai-${name}-0.2.2-rc.1.tgz`), 'package/lib/index.js']);
    fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, original);
    return {target, original};
  });
  const helper = path.join(modules, 'dsh-experimental-tool-agent-team/lib/model-selection.js');
  t.after(() => { for (const {target} of files) fs.chmodSync(path.dirname(target), 0o755); fs.rmSync(directory, {recursive: true, force: true}); });
  return {directory, files, core, helper};
}
test('Team compatibility applies exact published files once and refuses unknown input without partial writes', async t => {
  const f = fixture(t);
  assert.equal((await applyRc1TeamCompatibility(f.directory)).changed, 3);
  const after = f.files.map(({target}) => fs.readFileSync(target));
  assert.equal((await applyRc1TeamCompatibility(f.directory)).changed, 0);
  f.files.forEach(({target}, i) => assert.deepEqual(fs.readFileSync(target), after[i]));
  fs.appendFileSync(f.files[1].target, '\n// independent user work\n');
  const changed = fs.readFileSync(f.files[1].target);
  await assert.rejects(() => applyRc1TeamCompatibility(f.directory));
  assert.deepEqual(fs.readFileSync(f.files[0].target), after[0]);
  assert.deepEqual(fs.readFileSync(f.files[1].target), changed);
});
test('Team compatibility rolls back its new helper when a later real filesystem write fails, then recovers', async t => {
  const f = fixture(t);
  fs.chmodSync(path.dirname(f.files[0].target), 0o555);
  await assert.rejects(() => applyRc1TeamCompatibility(f.directory), /EACCES|EPERM/);
  assert.equal(fs.existsSync(f.helper), false);
  f.files.forEach(({target, original}) => assert.deepEqual(fs.readFileSync(target), original));
  fs.chmodSync(path.dirname(f.files[0].target), 0o755);
  assert.equal((await applyRc1TeamCompatibility(f.directory)).changed, 3);
});
test('Team compatibility rejects an adjacent SDK version and preserves every original input', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.core, JSON.stringify({version: '0.2.1-alpha.4'}));
  await assert.rejects(() => applyRc1TeamCompatibility(f.directory), /只适用于/);
  assert.equal(fs.existsSync(f.helper), false);
  f.files.forEach(({target, original}) => assert.deepEqual(fs.readFileSync(target), original));
});
