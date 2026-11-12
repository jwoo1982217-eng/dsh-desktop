import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {PluginUpdates,updateReason} from '../desktop-enhancements/updates.mjs';
const manifest=version=>({name:'fixture-plugin',version,engines:{dsh:'0.2.1-alpha.4'},dsh:{bundle:{patch:'./cordis.patch.yml'}}});
function fixture(t,{outcome='applied',active=false,profile=false}={}){
 let version='1.0.0',enabled=true;const actions=[],hooks={},values={hmr:{},agents:{list:()=>active?[{status:'running'}]:[]}};
 const manager={async listBundles(){return[{name:'fixture-plugin',version,source:'fixture-plugin@'+version,enabled,availability:'profile',installed:true,official:false,removable:true}];},async inspect(){return{status:'accepted',kind:'registry',name:'fixture-plugin',version:'2.0.0',bundle:true,registry:'http://127.0.0.1:12345/'};},async registries(){return{resolved:"http://127.0.0.1:12345/"};},async installBundle(spec,options){actions.push({spec,options});version=spec.split('@').at(-1);enabled=options.enabled;return{application:version==='1.0.0'?'applied':outcome};},async cancelInstall(id){actions.push({cancel:id});return{status:'cancelled'};}};
 manager.removeBundle=async()=>({application:'applied'});values.pluginManager=manager;const ctx={get:key=>values[key],on:(name,fn)=>hooks[name]=fn};let dir;
 if(profile){dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-plugin-restore-'));fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({dependencies:{'fixture-plugin':'^1.0.0',unrelated:'keep'},dsh:{profile:{bundles:['fixture-plugin','unrelated']}}}));const original=manager.installBundle;manager.installBundle=async(spec,options)=>{const result=await original(spec,options),j=JSON.parse(fs.readFileSync(path.join(dir,'package.json')));j.dependencies['fixture-plugin']=spec.split('@').at(-1);fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify(j));return result;};t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));}
 const service=new PluginUpdates(ctx,{profile:dir,runtimeVersion:'0.2.1-alpha.4',manifestReader:async(_r,_n,v)=>manifest(v==='latest'?'2.0.0':v)});return{manager,values,service,hooks,actions,get version(){return version;},dir};
}
test('local and shipped plugins are protected while genuine registry packages are eligible',()=>{
 const base={name:'foo',version:'1.0.0',source:'foo@1.0.0',installed:true,availability:'profile',removable:true};assert.equal(updateReason(base),null);
 for(const source of ['file:/user/custom','link:../source','https://example.test/plugin.tgz','npm:another-package@1'])assert.ok(updateReason({...base,source}));assert.ok(updateReason({...base,official:true}));
});
test('successful exact-version update keeps enabled state and routes through the existing manager',async t=>{
 const f=fixture(t),plan=await f.service.plan('fixture-plugin');const result=await f.service.execute(plan.id);assert.equal(result.result,'restart-required');assert.equal(f.service.pendingRestart,true);assert.equal(f.version,'2.0.0');assert.equal(f.actions.length,1);assert.equal(f.actions[0].spec,'fixture-plugin@2.0.0');assert.equal(f.actions[0].options.enabled,true);assert.equal(f.service.flight,null);
});
for(const outcome of ['failed','cancelled'])test(outcome+' installation restores the original exact version and original dependency range',async t=>{
 const f=fixture(t,{outcome,profile:true}),plan=await f.service.plan('fixture-plugin');const result=await f.service.execute(plan.id);assert.equal(result.restored,true);assert.equal(f.version,'1.0.0');assert.deepEqual(f.actions.map(x=>x.spec),['fixture-plugin@2.0.0','fixture-plugin@1.0.0']);const j=JSON.parse(fs.readFileSync(path.join(f.dir,'package.json')));assert.equal(j.dependencies['fixture-plugin'],'^1.0.0');assert.equal(j.dependencies.unrelated,'keep');assert.deepEqual(j.dsh.profile.bundles,['fixture-plugin','unrelated']);
});
test('running tasks prevent mutation and the same service can plan again after a refusal',async t=>{
 const f=fixture(t,{active:true}),plan=await f.service.plan('fixture-plugin');await assert.rejects(f.service.execute(plan.id),/任务运行/);assert.equal(f.actions.length,0);assert.equal(f.version,'1.0.0');assert.equal(f.service.flight,null);assert.ok((await f.service.plan('fixture-plugin')).id);
});
test('a changed installation, an expired plan and incompatible metadata all refuse before install',async t=>{
 const f=fixture(t),plan=await f.service.plan('fixture-plugin');f.service.plans.get(plan.id).expires=0;await assert.rejects(f.service.execute(plan.id),/确认已失效/);
 f.service.manifestReader=async(_r,_n,v)=>({...manifest(v==='latest'?'2.0.0':v),engines:{dsh:'>=0.2.2'}});await assert.rejects(f.service.plan('fixture-plugin'),/不兼容/);assert.equal(f.actions.length,0);
});
test('metadata changed after confirmation leaves the old plugin and gate intact',async t=>{
 const f=fixture(t),plan=await f.service.plan('fixture-plugin');f.service.manifestReader=async(_r,_n,v)=>({...manifest(v==='latest'?'2.0.0':v),description:'changed'});await assert.rejects(f.service.execute(plan.id),/元数据.*变化/);assert.equal(f.actions.length,0);assert.equal(f.service.flight,null);
});
test('new steps wait during update and resume after it settles, without changing their signal or routing',async t=>{
 const f=fixture(t),plan=await f.service.plan('fixture-plugin');let release,entered;const started=new Promise(r=>entered=r),pending=new Promise(r=>release=r),original=f.manager.installBundle;
 f.manager.installBundle=async(...args)=>{entered();await pending;return original(...args);};const update=f.service.execute(plan.id);await started;
 let nextCalls=0;const controller=new AbortController(),step=f.hooks['agent/pre-step']({signal:controller.signal},()=>++nextCalls);await Promise.resolve();assert.equal(nextCalls,0);release();await update;await step;assert.equal(nextCalls,1);assert.equal(controller.signal.aborted,false);
});
test('failed restoration is reported as failed recovery instead of a successful update',async t=>{
 const f=fixture(t,{outcome:'failed'}),plan=await f.service.plan('fixture-plugin');const original=f.manager.installBundle;f.manager.installBundle=async(...a)=>{await original(...a);return{application:'failed'};};const result=await f.service.execute(plan.id);assert.equal(result.restored,false);assert.match(result.recovery,/未通过/);assert.equal(f.service.flight,null);
});
test('restoration preserves the previous range in both package manifest and pnpm importer',async t=>{const f=fixture(t,{outcome:'failed',profile:true}),lock=path.join(f.dir,'pnpm-lock.yaml');fs.writeFileSync(lock,'lockfileVersion: "9.0"\nimporters:\n  .:\n    dependencies:\n      fixture-plugin:\n        specifier: 1.0.0\n        version: 1.0.0\n      unrelated:\n        specifier: keep\n        version: keep\n');const plan=await f.service.plan('fixture-plugin'),result=await f.service.execute(plan.id);assert.equal(result.restored,true);assert.equal(result.configWarning,undefined);const restored=fs.readFileSync(lock,'utf8');assert.match(restored,/specifier: \^1\.0\.0/);assert.match(restored,/unrelated:\n\s+specifier: keep/);});
test('an independent local replacement made during installation is retained instead of being removed for recovery',async t=>{const f=fixture(t,{outcome:'failed'}),plan=await f.service.plan('fixture-plugin'),original=f.manager.installBundle,list=f.manager.listBundles;let removals=0;f.manager.removeBundle=async()=>{removals++;return{application:'applied'};};f.manager.installBundle=async(...a)=>{const result=await original(...a);f.manager.listBundles=async()=>(await list()).map(x=>({...x,source:'file:/user/independent-change'}));return result;};const result=await f.service.execute(plan.id);assert.equal(result.restored,false);assert.equal(removals,1);assert.equal(f.actions.length,1);});
test('a successful installation waits for a normal restart before another update can begin',async t=>{const f=fixture(t),plan=await f.service.plan('fixture-plugin');await f.service.execute(plan.id);await assert.rejects(f.service.plan('fixture-plugin'),/重启/);assert.equal(f.actions.length,1);});
