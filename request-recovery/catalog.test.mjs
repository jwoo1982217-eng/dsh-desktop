import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedModelCatalog} from './catalog.mjs';
import {buildModelCatalog} from '../desktop-runtime/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js';
const providers=[{id:'ready',name:'正常 API'},{id:'stuck',name:'慢 API'}];
const selection=()=>({provider:'ready',model:'m'});
const group=p=>({groups:[{...p,models:[{id:'m',name:'模型'}]}],failures:[]});
test('actual SDK catalog keeps healthy provider and reasoning metadata while another list never resolves',async()=>{
 const llm={listProviders:()=>providers,listModels:id=>id==='stuck'?new Promise(()=>{}):Promise.resolve([{id:'m',name:'模型'}]),resolveModelInfo:async()=>({reasoning:{efforts:[{id:'low',name:'低'}],defaultEffort:'low'}})};
 const catalog=new BoundedModelCatalog({providers:()=>providers,selection,deadlineMs:20,load:(p,s)=>buildModelCatalog({llm:{...llm,listProviders:()=>[p]}},s)});
 const result=await catalog.read();assert.equal(result.groups.length,1);assert.equal(result.groups[0].models[0].reasoning.defaultEffort,'low');assert.equal(result.failures[0].id,'stuck');assert.deepEqual(result.default,selection());assert.deepEqual(result.routableProviders,['ready']);
});
test('repeated refreshes share one stalled load; late completion appears without restarting',async()=>{
 let release,calls=0;const task=new Promise(r=>{release=r;});
 const c=new BoundedModelCatalog({providers:()=>[providers[1]],selection,deadlineMs:10,load:()=>{calls++;return task;}});
 await Promise.all([c.read(),c.read()]);assert.equal(calls,1);release(group(providers[1]));await task;const r=await c.read();assert.equal(r.groups.length,1);assert.equal(calls,1);
});
test('adapter changes and rollback retire old catalog; provider failure does not reject healthy groups',async()=>{
 let fail=false;const c=new BoundedModelCatalog({providers:()=>providers,selection,load:async p=>{if(p.id==='stuck'||fail)throw Error('offline');return group(p);}});
 assert.equal((await c.read()).groups.length,1);fail=true;c.invalidate();assert.equal((await c.read()).groups.length,0);c.close();assert.equal((await c.read()).groups.length,0);
});
test('a normal catalog-loaded notification during reading does not discard healthy results',async()=>{
 let c;c=new BoundedModelCatalog({providers:()=>providers,selection,load:async p=>{c.invalidate();return group(p);}});
 assert.equal((await c.read()).groups.length,2);
});
