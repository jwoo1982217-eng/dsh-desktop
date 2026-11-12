import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink, realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const adapter = await import('../runtime/pocket-update/adapter.mjs').catch(() => null);
const patcher = await import('../runtime/pocket-update/patch.mjs').catch(() => null);
const source = path.resolve('desktop-runtime/node_modules/dsh-pocket');

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'Pocket 更新 中文空格 '));
  t.after(() => rm(home, {recursive:true, force:true}));
  const profile = path.join(home, 'profiles/web');
  const target = path.join(profile, 'node_modules/dsh-pocket');
  await mkdir(path.dirname(target), {recursive:true});
  await cp(source, target, {recursive:true});
  const manifest = JSON.stringify({dependencies:{'dsh-pocket':'file:/application/pocket', other:'file:/keep'}, dsh:{profile:{bundles:['other','dsh-pocket']}}});
  await writeFile(path.join(profile, 'package.json'), manifest);
  await writeFile(path.join(profile, 'cordis.patch.yml'), '- id: dsh-pocket\n  disabled: true\n');
  let calls = 0;
  const install = async ({stage, version}) => {
    calls++;
    const pkg = path.join(stage, 'profiles/pocket-update/node_modules/dsh-pocket');
    await mkdir(path.dirname(pkg), {recursive:true}); await cp(source,pkg,{recursive:true});
    await symlink(path.dirname(source),path.join(pkg,'node_modules'),'dir');
    const file = path.join(pkg,'package.json'), p=JSON.parse(await readFile(file)); p.version=version;
    await writeFile(file,JSON.stringify(p));
    return {ok:true};
  };
  const options = {home, profile:'web', packageDirectory:target, coreEntry:path.resolve('desktop-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    metadata:async()=>({name:'dsh-pocket',version:'2.12.0'}), install};
  return {home,profile,target,manifest,options,calls:()=>calls};
}

test('managed updater stages Pocket, keeps other profile fields, and never restarts the host', async t=>{
  assert.equal(typeof adapter?.performDesktopUpdate,'function','desktop updater must replace the missing global CLI path');
  const f=await fixture(t), result=await adapter.performDesktopUpdate(f.options);
  assert.equal(result.ok,true); assert.equal(result.restartRequired,true); assert.equal(result.autoRestart,false);
  assert.equal(JSON.parse(await readFile(path.join(f.target,'package.json'))).version,'2.12.0');
  const p=JSON.parse(await readFile(path.join(f.profile,'package.json')));
  assert.equal(p.dependencies.other,'file:/keep'); assert.deepEqual(p.dsh.profile.bundles,['other','dsh-pocket']);
  assert.equal(await readFile(path.join(f.profile,'cordis.patch.yml'),'utf8'),'- id: dsh-pocket\n  disabled: true\n');
  assert.match(p.dependencies['dsh-pocket'],/updates/); assert.equal(f.calls(),1);
  assert.ok(result.backup); assert.equal(await readFile(path.join(result.backup,'package.json.before'),'utf8'),f.manifest);
});

test('installer failure leaves the old package and manifest intact, then retry succeeds',async t=>{
  assert.ok(adapter); const f=await fixture(t);
  const result=await adapter.performDesktopUpdate({...f.options,install:async()=>({ok:false,output:'download failed fixture'})});
  assert.equal(result.ok,false); assert.match(result.error,/download failed/);
  assert.equal(await readFile(path.join(f.profile,'package.json'),'utf8'),f.manifest);
  assert.equal(JSON.parse(await readFile(path.join(f.target,'package.json'))).version,'2.10.6');
  assert.equal((await adapter.performDesktopUpdate(f.options)).ok,true);
});

test('a concurrent profile edit refuses publication and preserves that edit',async t=>{
  assert.ok(adapter); const f=await fixture(t), install=f.options.install;
  const edited=f.manifest+'\n';
  const result=await adapter.performDesktopUpdate({...f.options,install:async opts=>{await install(opts);await writeFile(path.join(f.profile,'package.json'),edited);return {ok:true};}});
  assert.equal(result.ok,false); assert.match(result.error,/变化|changed/);
  assert.equal(await readFile(path.join(f.profile,'package.json'),'utf8'),edited);
  assert.equal(JSON.parse(await readFile(path.join(f.target,'package.json'))).version,'2.10.6');
});

test('publication failure restores the old link and permits a successful retry',async t=>{
  assert.ok(adapter); const f=await fixture(t);
  const original=path.join(f.home,'bundled-pocket'); await cp(source,original,{recursive:true});
  await rm(f.target,{recursive:true});await symlink(original,f.target,'dir');
  const result=await adapter.performDesktopUpdate({...f.options,beforeManifestCommit:async()=>{throw Error('commit fixture');}});
  assert.equal(result.ok,false); assert.equal(await realpath(f.target),await realpath(original));
  assert.equal(await readFile(path.join(f.profile,'package.json'),'utf8'),f.manifest);
  assert.equal((await adapter.performDesktopUpdate(f.options)).ok,true);
  assert.equal(JSON.parse(await readFile(path.join(original,'package.json'))).version,'2.10.6');
});

test('unknown package layout, wrong package metadata, and a different profile cannot mutate installation',async t=>{
  assert.ok(adapter); const f=await fixture(t);
  for(const extra of [{metadata:async()=>({name:'other',version:'2.12.0'})},{profile:'../escape'},{profile:'another'}]){
    const r=await adapter.performDesktopUpdate({...f.options,...extra});assert.equal(r.ok,false);
  }
  assert.equal(f.calls(),0);assert.equal(await readFile(path.join(f.profile,'package.json'),'utf8'),f.manifest);
});

test('adaptation is idempotent, carries itself into updates, and stops automatic host restart',async t=>{
  assert.equal(typeof patcher?.patchPocket,'function'); const f=await fixture(t);
  await patcher.patchPocket(f.target); const first=await readFile(path.join(f.target,'lib/index.js'),'utf8');
  const firstClient=await readFile(path.join(f.target,'client/client.js'),'utf8');
  await patcher.patchPocket(f.target); assert.equal(await readFile(path.join(f.target,'lib/index.js'),'utf8'),first);
  assert.equal(await readFile(path.join(f.target,'client/client.js'),'utf8'),firstClient);
  assert.match(first,/performDesktopUpdate/);
  assert.match(await readFile(path.join(f.target,'lib/web-rpc.js'),'utf8'),/restartRequired/);
  const client=await readFile(path.join(f.target,'client/client.js'),'utf8');
  assert.match(client,/restartRequired: r.restartRequired/);
  assert.match(client,/type: "button", style: styles.primary, onClick: runUpdate/);
  assert.match(client,/role: "alert"/);
  await readFile(path.join(f.target,'lib/desktop-update/adapter.mjs'));
});
