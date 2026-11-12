import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TaskStore} from './storage.mjs';
import {Facts} from './facts.mjs';
import {TaskSupervisor} from './service.mjs';
function fixture(t){
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsh-supervisor-startup-')));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const store=new TaskStore(home),job=store.create({id:'fixture-session',cwd:home},1,'Restore this actual local task');
 new Facts(store).seed(job);job.finishedAt='2026-01-01T00:00:00.000Z';job.phase='本轮已结束';job.learning='无需新经验';store.put(job);
 return {home,store,job,ctx:{get(){return undefined}}};
}
function load(f){
 const original=fs.fsyncSync;let calls=0;fs.fsyncSync=function(...args){calls++;return Reflect.apply(original,this,args)};
 try{return {service:new TaskSupervisor(f.ctx,f.home),calls}}finally{fs.fsyncSync=original}
}
test('finished historical tasks are loaded without touching their files',t=>{
 const f=fixture(t),file=f.store.file(f.job),before=fs.readFileSync(file),mtime=fs.statSync(file).mtimeMs;
 const {service,calls}=load(f);
 assert.equal(service.live.size,1);assert.equal(calls,0);assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.statSync(file).mtimeMs,mtime);
 service.close();
});
test('interrupted claims and learning recover in one write and a second startup is read-only',t=>{
 const f=fixture(t);delete f.job.finishedAt;f.job.phase='子代理协作';f.job.learning='验证中';f.job.nodes=[{id:'child',status:'执行中'}];f.job.board.claims=[{id:'claim',status:'running'}];f.store.put(f.job);
 const first=load(f),job=first.service.live.get(f.job.id);
 assert.equal(first.calls,2,'one atomic save syncs the task file and its directory');assert.equal(job.phase,'主代理接管');assert.equal(job.learning,'待重试');assert.equal(job.nodes[0].status,'主代理接管');assert.equal(job.board.claims[0].status,'interrupted');
 const bytes=fs.readFileSync(f.store.file(job));first.service.close();
 const second=load(f);assert.equal(second.calls,0);assert.deepEqual(fs.readFileSync(f.store.file(job)),bytes);second.service.close();
});
test('damaged historical records remain intact and do not cause recovery writes',t=>{
 const f=fixture(t),file=f.store.file(f.job);fs.writeFileSync(file,'{damaged');const {service,calls}=load(f);
 assert.equal(service.live.size,0);assert.equal(calls,0);assert.equal(fs.readFileSync(file,'utf8'),'{damaged');assert.equal(service.store.issues.length,1);service.close();
});
