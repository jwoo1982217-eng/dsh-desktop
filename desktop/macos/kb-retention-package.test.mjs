import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const app=process.env.DSH_KB_PACKAGE_APP;
if(!app)throw Error('Set DSH_KB_PACKAGE_APP to the registered staged App');
const resources=path.join(app,'Contents/Resources'),runtime=path.join(resources,'runtime');
const {applyProgramUpdate}=await import(pathToFileURL(path.join(resources,'bin/desktop-host/program-update.mjs')));
const spec=JSON.parse(await fs.readFile(path.join(runtime,'program-update.json'),'utf8'));
const release=JSON.parse(await fs.readFile(new URL('./kb-retention-release.json',import.meta.url),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
 const home=await fs.mkdtemp(path.join(path.dirname(path.dirname(app)),'kb-package-test-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const profile=path.join(home,'profiles/web');
 await fs.mkdir(profile,{recursive:true});
 await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({dependencies:{'dsh-phone-features':'file:'+path.join(profile,'node_modules/dsh-phone-features')},dsh:{profile:{bundles:['dsh-phone-features']}}}));
 await fs.mkdir(path.join(profile,'node_modules/dsh-phone-features'),{recursive:true});await fs.copyFile(path.join(runtime,'node_modules/dsh-phone-features/.dsh-feature-program.json'),path.join(profile,'node_modules/dsh-phone-features/.dsh-feature-program.json'));
 for(const row of release.files)if(row.before!=='missing'){
  const target=path.join(profile,'node_modules/dsh-peer/knowledge-link',row.path);await fs.mkdir(path.dirname(target),{recursive:true});const old=await fs.readFile(path.join('/Applications/DSH.app/Contents/Resources/runtime/node_modules/dsh-peer/knowledge-link',row.path));assert.equal(sha(old),row.before);await fs.writeFile(target,old);
 }
 await fs.writeFile(path.join(home,'private-sentinel.json'),'existing private settings');
 const custom=path.join(profile,'node_modules/dsh-peer/custom-user-program.mjs');await fs.writeFile(custom,'custom peer function');
 return {home,profile,custom};
}
async function versions(f){const out={};for(const row of release.files){const p=path.join(f.profile,'node_modules/dsh-peer/knowledge-link',row.path);try{out[row.path]=sha(await fs.readFile(p));}catch(e){if(e.code!=='ENOENT')throw e;out[row.path]='missing';}}return out;}
test('实际安装包只升级七个引擎文件，保留其他自定义程序并可重复',async t=>{
 assert.equal(spec.files.length,7);const f=await fixture(t);const result=await applyProgramUpdate(f.home,runtime);assert.equal(result.updated,7);assert.deepEqual(await versions(f),Object.fromEntries(release.files.map(r=>[r.path,r.sha256])));assert.equal(await fs.readFile(f.custom,'utf8'),'custom peer function');assert.equal(await fs.readFile(path.join(f.home,'private-sentinel.json'),'utf8'),'existing private settings');assert.equal((await applyProgramUpdate(f.home,runtime)).current,true);
});
test('实际安装包发布失败恢复旧引擎，新模块不遗留，重试成功',async t=>{
 const f=await fixture(t),before=await versions(f);await assert.rejects(applyProgramUpdate(f.home,runtime,{checkpoint:async phase=>{if(phase==='published-2')throw Error('injected KB deployment failure');}}),/injected/);assert.deepEqual(await versions(f),before);assert.equal((await applyProgramUpdate(f.home,runtime)).updated,7);
});
test('自改引擎拒绝覆盖，不修改其余文件',async t=>{
 const f=await fixture(t),file=path.join(f.profile,'node_modules/dsh-peer/knowledge-link/kb/lib/store.cjs');await fs.appendFile(file,'\n// local change');const before=await versions(f);await assert.rejects(applyProgramUpdate(f.home,runtime),/自定义修改/);assert.deepEqual(await versions(f),before);
});
