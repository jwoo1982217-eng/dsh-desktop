import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Scheduler,isSubagentSession} from './scheduler.mjs';
import {installNativeSelection} from './native.mjs';
const route={provider:'fixture',model:'selected'};
function setup(t,isSubagent=()=>true){const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-scheduler-recovery-'));const s=new Scheduler(home,{allowed:()=>[route],isSubagent});s.config.minIntervalMs=0;s.config.delegationEnabled=true;s.config.routes=[{...route,tasks:['general'],quotaGroup:'fixture'}];t.after(()=>{s.close();fs.rmSync(home,{recursive:true,force:true});});return s;}
const deadline=async(p,ms=120)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('test deadline')),ms)})]);}finally{clearTimeout(timer);}};

test('ordinary and auxiliary model calls bypass a fully occupied child scheduler',async t=>{const s=setup(t,o=>o.sessionId==='child');s.config.maxConcurrent=1;const lease=await s.acquire(route);t.after(()=>lease.release());let calls=0;await deadline((async()=>{for await(const c of s.stream({...route,sessionId:'root'},async function*(){calls++;yield{type:'finish',reason:{kind:'stop'}};}))assert.equal(c.type,'finish');})());assert.equal(calls,1);assert.equal(s.total,1);assert.equal(s.pending.length,0);});

test('cancellation releases a granted permit even when upstream next and return never settle',async t=>{const s=setup(t);s.config.maxConcurrent=1;const abort=new AbortController();let entered;const started=new Promise(r=>entered=r);const stream=s.stream({...route,signal:abort.signal},()=>({[Symbol.asyncIterator](){return this;},next(){entered();return new Promise(()=>{});},return(){return new Promise(()=>{});}}));const first=stream.next();await started;abort.abort(Error('user stopped'));await assert.rejects(deadline(first),/user stopped/);assert.equal(s.total,0);assert.equal(s.active.size,0);const lease=await deadline(s.acquire(route));lease.release();});

test('disabled delegation rejects a child before any account API dispatch',async t=>{const s=setup(t);s.config.delegationEnabled=false;let calls=0;await assert.rejects(async()=>{for await(const _ of s.stream(route,async function*(){calls++;yield{type:'finish',reason:{kind:'stop'}};})){}},/子代理已关闭/);assert.equal(calls,0);assert.equal(s.total,0);});

test('new and legacy settings never turn on delegation implicitly',t=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-scheduler-default-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const s=new Scheduler(home);assert.equal(s.config.delegationEnabled,false);const config={...s.config};delete config.delegationEnabled;fs.mkdirSync(path.dirname(s.file),{recursive:true});fs.writeFileSync(s.file,JSON.stringify({revision:0,config}));s.close();const reloaded=new Scheduler(home);assert.equal(reloaded.config.delegationEnabled,false);reloaded.close();});

test('manual delegation requires a selected exact route and never inherits the main account',async t=>{const s=setup(t);s.config.routes=[{...route,tasks:['general'],quotaGroup:'fixture'}];let calls=0;const service={start(){calls++;},startContinuable(){calls++;}};const restore=installNativeSelection({get:n=>n==='subagents'?service:{stateOf:()=>null}},s);t.after(restore);const parent={session:{}};assert.throws(()=>service.start('spawn',{parent}),/明确选择|provider/);assert.throws(()=>service.start('spawn',{parent,agentOptions:{provider:'other',model:'paid'}}),/明确选择|模型池|授权/);await service.start('spawn',{parent,agentOptions:route});assert.equal(calls,1);});

test('an ordinary fork with inherited history is not a delegated account call',async t=>{const s=setup(t,()=>isSubagentSession({header:{parentSession:'root',origin:'fork',delegationDepth:0}}));s.config.delegationEnabled=false;let calls=0;for await(const _ of s.stream(route,async function*(){calls++;yield{type:'finish',reason:{kind:'stop'}};})){}assert.equal(calls,1);assert.equal(s.active.size,0);});
