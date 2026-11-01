import test from 'node:test';
import assert from 'node:assert/strict';
import {buildModelCatalog,acquireModelCatalog} from './model-catalog-availability.mjs';
function fixture(){
 let release,reads=0;const pending=new Promise(resolve=>{release=resolve}),adapters={fast:{},slow:{}};
 const llm={registration:id=>({adapter:adapters[id]}),listProviders:()=>[{id:'fast',name:'Fast'},{id:'slow',name:'Slow'}],listModels:async id=>{if(id==='slow'){reads++;await pending}return[{id:'m',name:'M'}]},resolveModelInfo:async()=>({reasoning:{efforts:[{id:'high',name:'High'}],defaultEffort:'high'}})};
 return{ctx:{llm,agentDefaultModel:{currentSelection:()=>({provider:'fast',model:'m'})}},release,reads:()=>reads};
}
test('a stalled provider does not hide ready groups or the saved default',async()=>{
 const f=fixture();const a=await buildModelCatalog(f.ctx,undefined,10);
 assert.deepEqual(a.groups.map(x=>x.id),['fast']);assert.deepEqual(a.default,{provider:'fast',model:'m'});assert.deepEqual(a.failures.map(x=>x.id),['slow']);assert.equal(a.groups[0].models[0].reasoning.defaultEffort,'high');f.release();
});
test('concurrent and repeated reads share pending work, then recover after it completes',async()=>{
 const f=fixture();await Promise.all([buildModelCatalog(f.ctx,undefined,10),buildModelCatalog(f.ctx,undefined,10)]);assert.equal(f.reads(),1);
 await buildModelCatalog(f.ctx,undefined,10);assert.equal(f.reads(),1);
 f.release();await new Promise(resolve=>setImmediate(resolve));const a=await buildModelCatalog(f.ctx,undefined,30);assert.deepEqual(a.groups.map(x=>x.id),['fast','slow']);assert.equal(a.failures.length,0);
});
test('multiple owners release only their patch and preserve concurrent replacement',()=>{
 const original=()=>null,controller={modelCatalog:original};const first=acquireModelCatalog(controller),wrapper=controller.modelCatalog,second=acquireModelCatalog(controller);
 first();assert.equal(controller.modelCatalog,wrapper);second();assert.equal(controller.modelCatalog,original);
 const release=acquireModelCatalog(controller),foreign=()=>42;controller.modelCatalog=foreign;release();assert.equal(controller.modelCatalog,foreign);
});
