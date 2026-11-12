import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  desktopFileWorkbenchFiles, installDesktopFileWorkbench, preflightDesktopFileWorkbench,
  rollbackDesktopFileWorkbench, packageName, sdkVersion,
} from './install-desktop-file-workbench.mjs';

const owner = 'fixture-installer-owner';
const requestedFixtureBase = process.env.DSH_FILE_WORKBENCH_TEST_DIR || os.tmpdir();
fs.mkdirSync(requestedFixtureBase, { recursive: true, mode: 0o700 });
const fixtureBase = fs.realpathSync(requestedFixtureBase);
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fixtureBase, 'file-workbench-'));
  const home = path.join(directory, 'home'), profile = path.join(home, 'profiles/web');
  const sourceDir = path.join(directory, 'source'), modules = path.join(directory, 'runtime/node_modules');
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(sourceDir);
  const before = JSON.stringify({ name: 'existing-profile', dependencies: { keep: 'file:../../existing-program' },
    dsh: { profile: { bundles: ['existing-program'], custom: { exact: true } } },
    accountFixture: 'private-value-must-never-enter-receipts' });
  fs.writeFileSync(path.join(profile, 'package.json'), before, { mode: 0o640 });
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '# concurrent user plugin source\n');
  for (const file of desktopFileWorkbenchFiles) fs.writeFileSync(path.join(sourceDir, file), `// fixture ${file}\n`);
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ name: packageName, version: '0.1.0', type: 'module',
    main: 'index.mjs', peerDependencies: { '@deepseek-ai/dsh': sdkVersion } }));
  const sdk = path.join(modules, '@deepseek-ai/dsh'); fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: sdkVersion, main: 'index.js' }));
  fs.writeFileSync(path.join(sdk, 'index.js'), 'module.exports={fixture:true};\n');
  // An ancestor with a wrong SDK must not be selected by module resolution.
  const ancestor = path.join(directory, 'node_modules/@deepseek-ai/dsh'); fs.mkdirSync(ancestor, { recursive: true });
  fs.writeFileSync(path.join(ancestor, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: 'legacy' }));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, home, profile, sourceDir, modules, before,
    options: { apply: true, owner, sourceDir, files: [...desktopFileWorkbenchFiles] } };
}
const manifestBytes = f => fs.readFileSync(path.join(f.profile, 'package.json'), 'utf8');
const manifest = f => JSON.parse(manifestBytes(f));
function tree(directory) {
  return fs.readdirSync(directory, { recursive: true }).sort();
}
function install(f, hooks) { return installDesktopFileWorkbench(f.home, f.modules, { ...f.options, hooks }); }

test('preflight and CLI default are read-only, import has no CLI side effects', t => {
  const f = fixture(t), before = tree(f.home);
  const plan = preflightDesktopFileWorkbench(f.home, f.modules, { sourceDir: f.sourceDir });
  assert.equal(plan.status, 'planned'); assert.deepEqual(tree(f.home), before);
  assert.equal(installDesktopFileWorkbench(f.home, f.modules, { sourceDir: f.sourceDir }).status, 'planned');
  const installer = fileURLToPath(new URL('./install-desktop-file-workbench.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [installer, f.home, f.modules, '--source', f.sourceDir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'planned');
  assert.deepEqual(tree(f.home), before); assert.equal(manifestBytes(f), f.before);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./install-desktop-file-workbench.mjs', import.meta.url).href)})`], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, '');
});

test('install preserves profile values, freezes every source SHA and links only actual alpha.4 SDK', t => {
  const f = fixture(t), first = install(f), after = manifest(f);
  assert.equal(first.status, 'installed');
  assert.equal(after.dsh.profile.bundles.filter(x => x === packageName).length, 1);
  const expected = JSON.parse(f.before); expected.dependencies[packageName] = after.dependencies[packageName]; expected.dsh.profile.bundles.push(packageName);
  assert.deepEqual(after, expected);
  assert.equal(fs.readFileSync(path.join(f.profile, 'cordis.patch.yml'), 'utf8'), '# concurrent user plugin source\n');
  assert.equal(fs.statSync(path.join(f.profile, 'package.json')).mode & 0o777, 0o640);
  assert.equal(Object.keys(first.files).length, 13); assert.match(path.basename(first.target), /^0\.1\.0-[a-f0-9]{64}$/);
  for (const file of desktopFileWorkbenchFiles) assert.deepEqual(fs.readFileSync(path.join(first.target, file)), fs.readFileSync(path.join(f.sourceDir, file)));
  const req = createRequire(path.join(first.target, 'package.json'));
  assert.equal(JSON.parse(fs.readFileSync(req.resolve('@deepseek-ai/dsh/package.json'))).version, sdkVersion);
  const sdkLink = path.join(first.target, 'node_modules/@deepseek-ai/dsh');
  assert.ok(fs.lstatSync(sdkLink).isSymbolicLink()); assert.equal(fs.realpathSync(sdkLink), path.join(f.modules, '@deepseek-ai/dsh'));
  assert.deepEqual(fs.readdirSync(path.join(first.target, 'node_modules')), ['@deepseek-ai']);
  const recovery = path.dirname(first.receipt);
  assert.equal(fs.statSync(recovery).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(recovery, 'package.before.json')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(recovery, 'package.before.json'), 'utf8'), f.before);
  assert.ok(!JSON.stringify(first).includes('private-value-must-never-enter-receipts'));
  assert.ok(!fs.readFileSync(first.receipt, 'utf8').includes('private-value-must-never-enter-receipts'));
});

test('repeat is a strict no-op, keeping manifest, symlink inode and private recovery count', t => {
  const f = fixture(t), first = install(f), before = manifestBytes(f);
  const inode = fs.lstatSync(first.link).ino, targetInode = fs.lstatSync(first.target).ino;
  const snapshots = tree(path.dirname(path.dirname(first.receipt)));
  const second = install(f);
  assert.equal(second.status, 'unchanged'); assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(fs.lstatSync(first.link).ino, inode); assert.equal(fs.lstatSync(first.target).ino, targetInode);
  assert.equal(manifestBytes(f), before); assert.deepEqual(tree(path.dirname(path.dirname(first.receipt))), snapshots);
});

test('source version upgrade retains old version, owner rollback restores exact manifest and previous symlink', t => {
  const f = fixture(t), first = install(f), previous = manifestBytes(f);
  fs.appendFileSync(path.join(f.sourceDir, 'page.css'), '/* new */\n');
  const second = install(f);
  assert.notEqual(second.target, first.target); assert.ok(fs.existsSync(first.target));
  assert.equal(fs.realpathSync(second.link), second.target);
  assert.equal(rollbackDesktopFileWorkbench(f.home, second.receipt).status, 'rollback-planned');
  assert.throws(() => rollbackDesktopFileWorkbench(f.home, second.receipt, { apply: true, owner: 'foreign' }), /owner/);
  const result = rollbackDesktopFileWorkbench(f.home, second.receipt, { apply: true, owner });
  assert.equal(result.status, 'rolled-back'); assert.equal(manifestBytes(f), previous);
  assert.equal(fs.realpathSync(first.link), first.target); assert.ok(fs.existsSync(first.target)); assert.ok(fs.existsSync(second.target));
  assert.equal(rollbackDesktopFileWorkbench(f.home, second.receipt, { apply: true, owner }).unchanged, true);
});

test('rollback of first install restores private before image and retains completed immutable version', t => {
  const f = fixture(t), first = install(f);
  const result = rollbackDesktopFileWorkbench(f.home, first.receipt, { apply: true, owner });
  assert.equal(result.status, 'rolled-back'); assert.equal(manifestBytes(f), f.before);
  assert.equal(result.retainedTarget, true); assert.equal(JSON.parse(fs.readFileSync(first.receipt)).retainedTarget, true);
  assert.equal(fs.existsSync(first.link), false); assert.ok(fs.existsSync(first.target));
  assert.ok(fs.existsSync(first.receipt));
});

test('same-name independent directory, unowned symlink and manifest entry are refused without changes', t => {
  for (const kind of ['directory', 'symlink', 'manifest']) {
    const f = fixture(t), link = path.join(f.profile, 'node_modules', packageName);
    fs.mkdirSync(path.dirname(link));
    if (kind === 'directory') { fs.mkdirSync(link); fs.writeFileSync(path.join(link, 'sentinel'), 'private-edit'); }
    if (kind === 'symlink') fs.symlinkSync(f.sourceDir, link);
    if (kind === 'manifest') { const value = manifest(f); value.dependencies[packageName] = 'file:private'; fs.writeFileSync(path.join(f.profile, 'package.json'), JSON.stringify(value)); }
    const before = manifestBytes(f), entries = tree(f.home);
    assert.throws(() => install(f), /independent|Unknown|owned|ENOENT/);
    assert.equal(manifestBytes(f), before); assert.deepEqual(tree(f.home), entries);
  }
});

test('modified target, foreign dependency link and unexpected files are preserved and block repeat', t => {
  for (const kind of ['file', 'dependency', 'extra']) {
    const f = fixture(t), first = install(f), before = manifestBytes(f);
    if (kind === 'file') fs.appendFileSync(path.join(first.target, 'index.mjs'), '// private edit\n');
    if (kind === 'extra') fs.writeFileSync(path.join(first.target, 'private.txt'), 'keep me');
    if (kind === 'dependency') {
      const dependency = path.join(first.target, 'node_modules/@deepseek-ai/dsh'); fs.unlinkSync(dependency); fs.symlinkSync(f.sourceDir, dependency);
    }
    const entries = tree(first.target);
    assert.throws(() => install(f), /modified|independent|drifted/);
    assert.equal(manifestBytes(f), before); assert.deepEqual(tree(first.target), entries);
  }
});

test('concurrent profile edit is preserved while its owned symlink is recovered', t => {
  const f = fixture(t); let concurrent;
  assert.throws(() => install(f, { beforeManifestCommit: ({ manifestFile }) => {
    const value = JSON.parse(fs.readFileSync(manifestFile)); value.userEdit = 'concurrent'; concurrent = JSON.stringify(value); fs.writeFileSync(manifestFile, concurrent);
  } }), /concurrent edits/);
  assert.equal(manifestBytes(f), concurrent);
  assert.equal(fs.existsSync(path.join(f.profile, 'node_modules', packageName)), false);
  assert.equal(fs.existsSync(path.join(f.profile, '.desktop-file-workbench-install.lock')), false);
});

test('injected failures before and after manifest publication recover owned resources byte-for-byte', t => {
  for (const phase of ['afterTarget', 'afterLink', 'afterManifestCommit', 'beforeReceipt']) {
    const f = fixture(t); let target, link;
    const hooks = { [phase]: value => { ({ target, link } = value); throw new Error('injected fixture failure'); } };
    assert.throws(() => install(f, hooks), /injected fixture failure/);
    assert.equal(manifestBytes(f), f.before, phase); assert.equal(fs.existsSync(link), false, phase); assert.equal(fs.existsSync(target), false, phase);
    assert.equal(fs.existsSync(path.join(f.profile, '.desktop-file-workbench-install.lock')), false);
  }
});

test('failure recovery preserves concurrent manifest edits, symlink replacements, target additions and foreign lock', t => {
  const f = fixture(t), foreign = path.join(f.directory, 'foreign'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'sentinel'), 'keep');
  let target, link, concurrent;
  assert.throws(() => install(f, { afterManifestCommit: value => {
    ({ target, link } = value);
    const current = manifest(f); current.concurrent = 'new choice'; concurrent = JSON.stringify(current); fs.writeFileSync(value.manifestFile, concurrent);
    fs.unlinkSync(link); fs.symlinkSync(foreign, link);
    fs.writeFileSync(path.join(target, 'new-private-file'), 'keep target');
    const lock = path.join(f.profile, '.desktop-file-workbench-install.lock'); fs.renameSync(lock, lock + '-original'); fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), '{"owner":"foreign"}');
    throw new Error('injected concurrent failure');
  } }), /injected concurrent failure/);
  assert.equal(manifestBytes(f), concurrent); assert.equal(fs.realpathSync(link), foreign);
  assert.equal(fs.readFileSync(path.join(target, 'new-private-file'), 'utf8'), 'keep target');
  assert.equal(fs.readFileSync(path.join(foreign, 'sentinel'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(path.join(f.profile, '.desktop-file-workbench-install.lock', 'owner.json')));
});

test('source change and symlink drift before publication are refused without overwriting concurrent entries', t => {
  for (const kind of ['source', 'link']) {
    const f = fixture(t), foreign = path.join(f.directory, 'foreign'); fs.mkdirSync(foreign); let target;
    assert.throws(() => install(f, { afterTarget: value => {
      target = value.target;
      if (kind === 'source') fs.appendFileSync(path.join(f.sourceDir, 'index.mjs'), '// changed\n');
      else fs.symlinkSync(foreign, value.link);
    } }), /Source inputs changed|symlink changed/);
    assert.equal(manifestBytes(f), f.before); assert.equal(fs.existsSync(target), false);
    if (kind === 'link') assert.equal(fs.realpathSync(path.join(f.profile, 'node_modules', packageName)), foreign);
  }
});

test('failure cleanup preserves an in-place private edit with the original inode', t => {
  const f = fixture(t); let changed;
  assert.throws(() => install(f, { afterTarget: ({ target }) => {
    changed = path.join(target, 'index.mjs');
    fs.appendFileSync(changed, '// private concurrent content\n');
    throw new Error('in-place edit failure');
  } }), /in-place edit failure/);
  assert.match(fs.readFileSync(changed, 'utf8'), /private concurrent content/);
  assert.equal(manifestBytes(f), f.before);
});

test('failed publication retains a target referenced by a concurrent new symlink or profile', t => {
  for (const kind of ['link', 'manifest']) {
    const f = fixture(t); let target;
    assert.throws(() => install(f, { afterTarget: value => {
      target = value.target;
      if (kind === 'link') fs.symlinkSync(target, value.link);
      else { const current = manifest(f); current.concurrentTarget = target; fs.writeFileSync(value.manifestFile, JSON.stringify(current)); }
      throw new Error('concurrent target reference');
    } }), /concurrent target reference/);
    assert.ok(fs.existsSync(target));
    if (kind === 'link') assert.equal(fs.realpathSync(path.join(f.profile, 'node_modules', packageName)), target);
    else assert.equal(manifest(f).concurrentTarget, target);
  }
});

test('rollback refuses profile edits, replaced equal-byte manifests, mode changes and symlink drift; no force override exists', t => {
  for (const kind of ['manifest', 'identity', 'mode', 'symlink']) {
    const f = fixture(t), first = install(f);
    if (kind === 'manifest') { const value = manifest(f); value.userNewChoice = true; fs.writeFileSync(path.join(f.profile, 'package.json'), JSON.stringify(value)); }
    if (kind === 'identity') { const file = path.join(f.profile, 'package.json'), temporary = file + '.new'; fs.writeFileSync(temporary, fs.readFileSync(file)); fs.renameSync(temporary, file); }
    if (kind === 'mode') fs.chmodSync(path.join(f.profile, 'package.json'), 0o600);
    if (kind === 'symlink') { fs.unlinkSync(first.link); fs.symlinkSync(f.sourceDir, first.link); }
    const before = manifestBytes(f), linkValue = fs.readlinkSync(first.link);
    assert.throws(() => rollbackDesktopFileWorkbench(f.home, first.receipt, { apply: true, owner, force: true }), /changed since/);
    assert.equal(manifestBytes(f), before); assert.equal(fs.readlinkSync(first.link), linkValue); assert.ok(fs.existsSync(first.target));
  }
});

test('wrong SDK, missing source input, source symlink and parent symlink are blocked read-only', t => {
  for (const kind of ['sdk', 'missing', 'source-link', 'parent-link']) {
    const f = fixture(t);
    if (kind === 'sdk') fs.writeFileSync(path.join(f.modules, '@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-alpha.3' }));
    if (kind === 'missing') fs.unlinkSync(path.join(f.sourceDir, 'API.md'));
    if (kind === 'source-link') { const file = path.join(f.sourceDir, 'http.mjs'); fs.unlinkSync(file); fs.symlinkSync(path.join(f.sourceDir, 'index.mjs'), file); }
    if (kind === 'parent-link') { const foreign = path.join(f.directory, 'foreign'); fs.mkdirSync(foreign); fs.symlinkSync(foreign, path.join(f.home, 'extensions')); }
    const entries = tree(f.home);
    assert.throws(() => install(f)); assert.deepEqual(tree(f.home), entries); assert.equal(manifestBytes(f), f.before);
  }
});

test('malformed profile errors do not include private JSON bytes, and forged recovery paths are refused', t => {
  const f = fixture(t), file = path.join(f.profile, 'package.json');
  fs.writeFileSync(file, '{"credential":"secret-parser-context", broken }');
  assert.throws(() => install(f), error => error.message === 'Profile manifest is not valid JSON');
  fs.writeFileSync(file, f.before);
  const first = install(f), receipt = JSON.parse(fs.readFileSync(first.receipt));
  const sentinel = path.join(f.directory, 'external-sentinel'); fs.writeFileSync(sentinel, 'keep');
  receipt.createdPaths[0].path = sentinel; fs.writeFileSync(first.receipt, JSON.stringify(receipt));
  const before = manifestBytes(f), link = fs.readlinkSync(first.link);
  assert.throws(() => rollbackDesktopFileWorkbench(f.home, first.receipt, { apply: true, owner }), /ownership is invalid/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep'); assert.equal(manifestBytes(f), before); assert.equal(fs.readlinkSync(first.link), link);
});
