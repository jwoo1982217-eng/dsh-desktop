import { tmpdir as __publicTmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readSelectiveBaseline,verifySelectiveBase,planSelectiveFeatures,selectiveHash} from './selective-inputs.mjs';

const repo=path.resolve(import.meta.dirname,'../..');
const generated=(__publicTmpdir() + '/dsh-go-capability-absorption-20261031/generated/program-review');
const prefix='node_modules/dsh-phone-features/';
const baseline=await readSelectiveBaseline();
const inputs=JSON.parse(await fs.readFile(new URL('./feature-program-files.json',import.meta.url),'utf8'));
const plans=planSelectiveFeatures(inputs,baseline);
const updateUrl=process.env.DSH_PROGRAM_UPDATE_MODULE??new URL('./app/program-update.mjs',import.meta.url).href;
const {applyProgramUpdate}=await import(updateUrl);
const oldMarker=Buffer.from(JSON.stringify(baseline.featureOwnership)+'\n');
const newMarker=Buffer.from(JSON.stringify({owner:'dsh-phone-features-v1',version:'0.1.9',files:inputs.files})+'\n');

async function fixture(t){
  await fs.mkdir(generated,{recursive:true});
  const dir=await fs.mkdtemp(path.join(generated,'upgrade019-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const home=path.join(dir,'含 空格 home'),profile=path.join(home,'profiles/web'),runtime=path.join(dir,'runtime');
  const manifestFile=path.join(profile,'package.json');
  await fs.mkdir(profile,{recursive:true});
  const manifest=Buffer.from(JSON.stringify({dependencies:{custom:'file:untouched','dsh-phone-features':'file:'+path.join(profile,'node_modules/dsh-phone-features')},dsh:{profile:{bundles:['custom','dsh-phone-features']}},privateRef:'retained'})+'\n');
  await fs.writeFile(manifestFile,manifest);await fs.writeFile(path.join(profile,'cordis.patch.yml'),'private settings');
  const rows=[];
  for(const {row,before}of plans){
    const old=await fs.readFile('/Applications/DSH.app/Contents/Resources/runtime/'+prefix+row.path);
    assert.equal(selectiveHash(old),baseline.featureOwnership.files.find(x=>x.path===row.path).sha256);
    const data=await fs.readFile(path.join(repo,'peer/feature-absorption',row.path));assert.equal(selectiveHash(data),row.sha256);
    const target=path.join(profile,prefix,row.path),source=path.join(runtime,'program-update',prefix,row.path);
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.mkdir(path.dirname(source),{recursive:true});
    await fs.writeFile(target,old);await fs.writeFile(source,data);rows.push({path:prefix+row.path,bytes:row.bytes,sha256:row.sha256,before});
  }
  const marker=prefix+'.dsh-feature-program.json';
  await fs.writeFile(path.join(profile,marker),oldMarker);await fs.writeFile(path.join(runtime,'program-update',marker),newMarker);
  rows.push({path:marker,bytes:newMarker.length,sha256:selectiveHash(newMarker),before:['missing',selectiveHash(oldMarker)]});
  await fs.writeFile(path.join(runtime,'program-update.json'),JSON.stringify({format:1,owner:'dsh-go-selective-v1',version:'0.1.9',files:rows,links:[]}));
  return {home,profile,runtime,manifestFile,manifest,marker:path.join(profile,marker)};
}
async function assertOld(f){
  for(const row of baseline.featureOwnership.files)assert.equal(selectiveHash(await fs.readFile(path.join(f.profile,prefix,row.path))),row.sha256,row.path);
  assert.deepEqual(await fs.readFile(f.marker),oldMarker);assert.deepEqual(await fs.readFile(f.manifestFile),f.manifest);
}

test('frozen release changes exactly three of 87 files and retains the desktop wrapper',()=>{
  assert.equal(plans.length,87);
  assert.equal(selectiveHash(oldMarker),'5f76cea1b4b65d504c1e52019e67f090b27caef74bc24a7dc68a4681cc5e9b75');
  const changed=plans.filter(x=>x.row.sha256!==x.before[1]).map(x=>x.row.path).sort();
  assert.deepEqual(changed,['conversation/client.js','settings/workbench-client.js','web-capabilities.mjs']);
  const altered=structuredClone(inputs);altered.files.find(x=>x.path==='index.mjs').sha256='0'.repeat(64);
  assert.throws(()=>planSelectiveFeatures(altered,baseline),/Unapproved/);
  const missing=structuredClone(inputs);missing.files.pop();assert.throws(()=>planSelectiveFeatures(missing,baseline),/closure/);
});
test('actual installed 0.1.8 program baseline and SDK closure pass read-only verification',async()=>{
  const require=createRequire(new URL('./tools/package.json',import.meta.url));
  const {extractFile}=require('@electron/asar');
  const result=await verifySelectiveBase('/Applications/DSH.app',{extractFile,baseline});
  assert.equal(result.bundle.coreVersion,'0.2.1-alpha.4');assert.equal(result.owner.files.length,87);assert.equal(result.spec.files.length,94);
});
test('real 87-file upgrade replaces only three UI files plus the marker and is idempotent',async t=>{
  const f=await fixture(t);assert.equal((await applyProgramUpdate(f.home,f.runtime)).updated,4);
  for(const row of inputs.files)assert.equal(selectiveHash(await fs.readFile(path.join(f.profile,prefix,row.path))),row.sha256,row.path);
  assert.deepEqual(await fs.readFile(f.marker),newMarker);assert.deepEqual(await fs.readFile(f.manifestFile),f.manifest);
  assert.equal(await fs.readFile(path.join(f.profile,'cordis.patch.yml'),'utf8'),'private settings');
  assert.equal((await applyProgramUpdate(f.home,f.runtime)).current,true);
});
test('drift in an unchanged owned file is refused before publishing UI or marker',async t=>{
  const f=await fixture(t),file=path.join(f.profile,prefix,'index.mjs');await fs.writeFile(file,'user custom wrapper');
  await assert.rejects(applyProgramUpdate(f.home,f.runtime),/自定义/);
  assert.equal(await fs.readFile(file,'utf8'),'user custom wrapper');assert.deepEqual(await fs.readFile(f.marker),oldMarker);
  const row=baseline.featureOwnership.files.find(x=>x.path==='web-capabilities.mjs');assert.equal(selectiveHash(await fs.readFile(path.join(f.profile,prefix,row.path))),row.sha256);
});
test('a same-owner custom marker cannot authorize arbitrary replacement bytes',async t=>{
  const f=await fixture(t),marker=JSON.parse(oldMarker);marker.custom=true;
  const file=path.join(f.profile,prefix,'conversation/client.js');await fs.writeFile(file,'custom');
  marker.files.find(x=>x.path==='conversation/client.js').sha256=selectiveHash('custom');
  const data=Buffer.from(JSON.stringify(marker)+'\n');await fs.writeFile(f.marker,data);
  await assert.rejects(applyProgramUpdate(f.home,f.runtime),/标记.*自定义/);
  assert.equal(await fs.readFile(file,'utf8'),'custom');assert.deepEqual(await fs.readFile(f.marker),data);assert.deepEqual(await fs.readFile(f.manifestFile),f.manifest);
});
test('a publish failure restores the real 0.1.8 marker and all files before retry',async t=>{
  const f=await fixture(t);
  await assert.rejects(applyProgramUpdate(f.home,f.runtime,{checkpoint:async phase=>{if(phase==='published-2')throw Error('injected publish failure');}}),/injected/);
  await assertOld(f);assert.equal((await applyProgramUpdate(f.home,f.runtime)).updated,4);
});
test('an abrupt child exit during the three-file upgrade recovers before the next start',async t=>{
  const f=await fixture(t);
  const code=`const {applyProgramUpdate}=await import(${JSON.stringify(updateUrl)});await applyProgramUpdate(${JSON.stringify(f.home)},${JSON.stringify(f.runtime)},{checkpoint:async phase=>{if(phase==='published-2')process.exit(71)}});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe'],env:{PATH:process.env.PATH}});let stderr='';child.stderr.on('data',x=>stderr+=x);
  assert.equal((await once(child,'exit'))[0],71,stderr);
  assert.equal((await applyProgramUpdate(f.home,f.runtime)).updated,4);
  assert.deepEqual(await fs.readFile(f.marker),newMarker);assert.deepEqual(await fs.readFile(f.manifestFile),f.manifest);
  await assert.rejects(fs.lstat(path.join(f.home,'.mac-app-install.lock')),{code:'ENOENT'});
});
