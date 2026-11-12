import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {prepareRc1Profile, restoreRc1Profile} from './app/rc1-profile.mjs';
import {prepareProfile} from './app/backend.mjs';

const sdk = process.env.DSH_COMPAT_RUNTIME;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.DSH_COMPAT_TEST_ROOT ?? tmpdir(), 'profile-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const home = path.join(root, 'home'), runtime = path.join(root, 'runtime'), profile = path.join(home, 'profiles/web');
  const relative = 'node_modules/dsh-peer/on-demand-tools/index.mjs';
  const before = Buffer.from('previous verified program\n'), after = Buffer.from('new verified compatibility program\n');
  const manifest = Buffer.from(JSON.stringify({name: 'existing', dependencies: {'dsh-peer': 'file:existing'}, dsh: {profile: {bundles: ['dsh-peer']}}}, null, 2) + '\n');
  const plugin = Buffer.from(JSON.stringify({name: 'dsh-peer', version: '0.1.0'}));
  await fs.mkdir(path.dirname(path.join(profile, relative)), {recursive: true});
  await fs.mkdir(path.dirname(path.join(runtime, relative)), {recursive: true});
  await fs.mkdir(path.join(runtime, 'node_modules/dsh-desktop-core-compatibility'), {recursive: true});
  await fs.writeFile(path.join(runtime, 'node_modules/dsh-desktop-core-compatibility/package.json'), JSON.stringify({name:'dsh-desktop-core-compatibility',version:'0.1.0',engines:{dsh:'0.2.2-rc.1'}}));
  await fs.symlink(path.join(sdk, 'node_modules/yaml'), path.join(runtime, 'node_modules/yaml'));
  await fs.symlink(path.join(sdk, 'node_modules/semver'), path.join(runtime, 'node_modules/semver'));
  await fs.mkdir(path.join(runtime, 'node_modules/@deepseek-ai/dsh'), {recursive: true});
  await fs.writeFile(path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({name: '@deepseek-ai/dsh', version: '0.2.2-rc.1'}));
  await fs.writeFile(path.join(profile, relative), before); await fs.writeFile(path.join(runtime, relative), after);
  await fs.writeFile(path.join(profile, 'package.json'), manifest);
  await fs.writeFile(path.join(profile, 'node_modules/dsh-peer/package.json'), plugin);
  const config = Buffer.from('- insert:\n    - id: child\n      name: "@deepseek-ai/dsh-tool-subagent"\n      config:\n        modelSelectionSettings: true # retain route selection\n        provider: sdk\n');
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), config); await fs.writeFile(path.join(home, 'cordis.patch.yml'), '[]\n');
  await fs.writeFile(path.join(home, 'account-marker'), 'retain account data');
  await fs.writeFile(path.join(runtime, 'profile-update-rc1.json'), JSON.stringify({owner: 'dsh-desktop-core-rc1-v1', coreVersion: '0.2.2-rc.1', files: [{path: relative, bytes: after.length, sha256: hash(after), before: [hash(before)]}], plugins: [{name: 'dsh-peer', version: '0.1.0', manifestSha256: hash(plugin)}]}));
  return {home, runtime, profile, relative, before, after, manifest, config};
}
test('actual profile transaction preserves accounts, enables the validated version and can restore exact program/config bytes', {skip: !sdk}, async t => {
  const f = await fixture(t), update = await prepareRc1Profile(f.home, f.runtime);
  assert.deepEqual(await fs.readFile(path.join(f.profile, f.relative)), f.after);
  assert.equal(await fs.readFile(path.join(f.home, 'account-marker'), 'utf8'), 'retain account data');
  assert.match(await fs.readFile(path.join(f.profile, 'cordis.patch.yml'), 'utf8'), /modelSelection: true # retain route selection/);
  const grants = JSON.parse(await fs.readFile(path.join(f.profile, 'compatibility.json')));
  assert.deepEqual(grants['dsh-peer@0.1.0'], ['0.2.2-rc.1']);
  assert.equal((await prepareRc1Profile(f.home, f.runtime)).current, true);
  // Once installed, new user plugins are handled by the normal manager and never erased by startup.
  const m = JSON.parse(await fs.readFile(path.join(f.profile, 'package.json'))); m.dsh.profile.bundles.push('user-new-plugin');
  await fs.writeFile(path.join(f.profile, 'package.json'), JSON.stringify(m));
  assert.equal((await prepareRc1Profile(f.home, f.runtime)).current, true);
  await assert.rejects(restoreRc1Profile(update.backup), /并发修改/);
  m.dsh.profile.bundles.pop(); await fs.writeFile(path.join(f.profile, 'package.json'), JSON.stringify(m, null, 2) + '\n');
  await restoreRc1Profile(update.backup);
  assert.deepEqual(await fs.readFile(path.join(f.profile, f.relative)), f.before);
  assert.deepEqual(await fs.readFile(path.join(f.profile, 'package.json')), f.manifest);
  assert.deepEqual(await fs.readFile(path.join(f.profile, 'cordis.patch.yml')), f.config);
  await assert.rejects(fs.lstat(path.join(f.profile, 'node_modules/dsh-desktop-core-compatibility')), {code: 'ENOENT'});
});
test('unknown program edits and a plugin added after validation fail before changing any configuration', {skip: !sdk}, async t => {
  const f = await fixture(t), file = path.join(f.profile, f.relative);
  await fs.writeFile(file, 'private custom change');
  await assert.rejects(prepareRc1Profile(f.home, f.runtime), /未经验证/);
  assert.deepEqual(await fs.readFile(path.join(f.profile, 'package.json')), f.manifest);
  await fs.writeFile(file, f.before);
  const m = JSON.parse(f.manifest); m.dsh.profile.bundles.push('unknown');
  const changed = JSON.stringify(m); await fs.writeFile(path.join(f.profile, 'package.json'), changed);
  await assert.rejects(prepareRc1Profile(f.home, f.runtime), /新增插件/);
  assert.deepEqual(await fs.readFile(file), f.before);
  assert.equal(await fs.readFile(path.join(f.profile, 'package.json'), 'utf8'), changed);
});
test('a failure after publication and config migration rolls back exact bytes and removes the newly created link', {skip: !sdk}, async t => {
  const f = await fixture(t);
  await assert.rejects(prepareRc1Profile(f.home, f.runtime, {checkpoint: async phase => {if (phase === 'complete') throw Error('actual injected activation failure');}}), /activation failure/);
  assert.deepEqual(await fs.readFile(path.join(f.profile, f.relative)), f.before);
  assert.deepEqual(await fs.readFile(path.join(f.profile, 'package.json')), f.manifest);
  assert.deepEqual(await fs.readFile(path.join(f.profile, 'cordis.patch.yml')), f.config);
  await assert.rejects(fs.lstat(path.join(f.profile, 'node_modules/dsh-desktop-core-compatibility')), {code: 'ENOENT'});
  assert.equal((await prepareRc1Profile(f.home, f.runtime)).current, false);
});
test('new Cordis executes and awaits retained legacy cleanup; explicit cancellation removes the handler', {skip: !sdk}, async () => {
  const {Context} = await import(pathToFileURL(path.join(sdk, 'node_modules/@deepseek-ai/cordis/lib/index.js')));
  const ctx = new Context(); let disposed = 0, cancelled = 0;
  const plugin = ctx.plugin({name: 'legacy-owner', apply(owner) {
    owner.on('dispose', async () => {await Promise.resolve(); disposed++;});
    const off = owner.on('dispose', () => {cancelled++;}); off();
    owner.on('ordinary-event', () => {throw Error('ordinary listener must not fire during unload');});
  }});
  await plugin; await plugin.dispose(); assert.equal(disposed, 1); assert.equal(cancelled, 0);
});
test('a completed migration can use a public runtime without the private spec; an unrecorded marker cannot', {skip:!sdk}, async t => {
  const f=await fixture(t);
  const updated=await prepareRc1Profile(f.home,f.runtime);
  const markerFile=path.join(f.profile,'.desktop-core-rc1.json'), marker=await fs.readFile(markerFile);
  const receiptFile=path.join(updated.backup,'restore.json'),receipt=JSON.parse(await fs.readFile(receiptFile));
  // The already delivered transaction predates the explicit completion flag;
  // its finalized, nonempty config-migration receipt still establishes completion.
  delete receipt.complete;await fs.writeFile(receiptFile,JSON.stringify(receipt));
  await fs.rm(path.join(f.runtime,'profile-update-rc1.json'));
  assert.equal((await prepareProfile(f.home,f.runtime)).current,true);
  const incomplete={...receipt,migration:null};await fs.writeFile(receiptFile,JSON.stringify(incomplete));
  await assert.rejects(prepareProfile(f.home,f.runtime),/其他核心升级标记/);
  await fs.writeFile(receiptFile,JSON.stringify(receipt));
  const unknown=JSON.parse(marker);unknown.specSha256='a'.repeat(64);
  await fs.writeFile(markerFile,JSON.stringify(unknown));
  await assert.rejects(prepareProfile(f.home,f.runtime),/其他核心升级标记/);
  await fs.writeFile(markerFile,marker);
  const m=JSON.parse(await fs.readFile(path.join(f.profile,'package.json')));m.dsh.profile.bundles.push('new-user-plugin');
  await fs.writeFile(path.join(f.profile,'package.json'),JSON.stringify(m));
  assert.equal((await prepareProfile(f.home,f.runtime)).current,true);
});
test('an available private spec still rejects a mismatching marker and unknown legacy profiles stay untouched', {skip:!sdk}, async t => {
  const f=await fixture(t);await prepareRc1Profile(f.home,f.runtime);
  const spec=JSON.parse(await fs.readFile(path.join(f.runtime,'profile-update-rc1.json')));spec.note='different validated input';
  await fs.writeFile(path.join(f.runtime,'profile-update-rc1.json'),JSON.stringify(spec));
  await assert.rejects(prepareProfile(f.home,f.runtime),/其他核心升级标记/);
  const other=await fixture(t);await fs.rm(path.join(other.runtime,'profile-update-rc1.json'));
  await assert.rejects(prepareProfile(other.home,other.runtime),/未知旧配置已保留/);
  assert.deepEqual(await fs.readFile(path.join(other.profile,'package.json')),other.manifest);
  assert.deepEqual(await fs.readFile(path.join(other.profile,other.relative)),other.before);
});
async function publicFixture(t) {
  const f=await fixture(t);f.home=path.join(path.dirname(f.home),'fresh-home');f.profile=path.join(f.home,'profiles/web');
  await fs.rm(path.join(f.runtime,'profile-update-rc1.json'));
  await fs.writeFile(path.join(f.runtime,'bundle.json'),JSON.stringify({version:'test-public-rc1',coreVersion:'0.2.2-rc.1',plugins:['dsh-desktop-core-compatibility'],profile:{private:true,dependencies:{},dsh:{profile:{bundles:['dsh-desktop-core-compatibility']}}}}));
  return f;
}
test('a clean public profile starts and restarts using a completed fresh marker without a private spec', {skip:!sdk}, async t => {
  const f=await publicFixture(t),result=await prepareProfile(f.home,f.runtime);
  assert.equal(result.fresh,true);
  const marker=JSON.parse(await fs.readFile(path.join(f.profile,'.desktop-core-rc1.json')));
  assert.equal(marker.kind,'fresh');assert.equal(marker.coreVersion,'0.2.2-rc.1');
  assert.equal((await prepareProfile(f.home,f.runtime)).current,true);
  await fs.rm(path.join(result.backup,'restore.json'));
  await assert.rejects(prepareProfile(f.home,f.runtime),/其他核心升级标记/);
});
test('fresh creation rolls back its marker on publication failure and preserves a concurrent marker', {skip:!sdk}, async t => {
  const f=await publicFixture(t);
  await assert.rejects(prepareProfile(f.home,f.runtime,{beforeCommit:async()=>{
    const backup=(await fs.readdir(path.join(f.home,'backups')))[0];
    await fs.mkdir(path.join(f.home,'backups',backup,'restore.json'));
  }}),/EISDIR/);
  for(const name of ['package.json','.desktop-core-rc1.json'])await assert.rejects(fs.stat(path.join(f.profile,name)),{code:'ENOENT'});
  assert.equal((await prepareProfile(f.home,f.runtime)).fresh,true);
  assert.equal((await prepareProfile(f.home,f.runtime)).current,true);
  const other=await publicFixture(t),foreign=Buffer.from('foreign marker');
  await assert.rejects(prepareProfile(other.home,other.runtime,{beforeCommit:()=>fs.writeFile(path.join(other.profile,'.desktop-core-rc1.json'),foreign)}),/EEXIST/);
  assert.deepEqual(await fs.readFile(path.join(other.profile,'.desktop-core-rc1.json')),foreign);
  await assert.rejects(fs.stat(path.join(other.profile,'package.json')),{code:'ENOENT'});
});
test('fresh public profiles reject a custom plugin with only alpha.4 engine support instead of silently omitting it', {skip:!sdk}, async t => {
  const f=await publicFixture(t);
  await fs.mkdir(path.join(f.runtime,'node_modules/custom-alpha-only'),{recursive:true});
  await fs.writeFile(path.join(f.runtime,'node_modules/custom-alpha-only/package.json'),JSON.stringify({name:'custom-alpha-only',version:'1.0.0',engines:{dsh:'0.2.1-alpha.4'}}));
  const file=path.join(f.runtime,'bundle.json'),bundle=JSON.parse(await fs.readFile(file));bundle.plugins.push('custom-alpha-only');bundle.profile.dsh.profile.bundles.push('custom-alpha-only');await fs.writeFile(file,JSON.stringify(bundle));
  await assert.rejects(prepareProfile(f.home,f.runtime),/custom-alpha-only.*未禁用或丢弃/);
  await assert.rejects(fs.stat(path.join(f.profile,'package.json')),{code:'ENOENT'});
});
