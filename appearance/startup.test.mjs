import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./client.js',import.meta.url),'utf8');
function load(importModuleDynamically){
 let plugin;const warnings=[],disposers=[];
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load:entry=>{plugin=entry.factory();}}},console:{warn:(...args)=>warnings.push(args)},AbortController},{importModuleDynamically});
 const ctx={effect(fn){const dispose=fn();if(typeof dispose==='function')disposers.push(dispose);},theme:{getTheme(){throw Error('A disposed initializer must not touch theme services');}}};
 return {plugin,ctx,warnings,dispose(){for(const dispose of disposers.reverse())dispose();}};
}
test('a stalled optional appearance import does not hold plugin or chat boot open',async()=>{
 let entered=false;const fixture=load(()=>{entered=true;return new Promise(()=>{});});
 assert.equal(fixture.plugin.apply(fixture.ctx),undefined);await new Promise(setImmediate);assert.equal(entered,true);fixture.dispose();assert.equal(fixture.warnings.length,0);
});
test('failed appearance restoration reports locally without rejecting global boot',async()=>{
 const fixture=load(async()=>{throw Error('fixture appearance asset unavailable');});
 assert.equal(fixture.plugin.apply(fixture.ctx),undefined);await new Promise(setImmediate);assert.equal(fixture.warnings.length,1);assert.match(String(fixture.warnings[0][0]),/聊天仍可使用/);fixture.dispose();
});
test('disposal before a late appearance import prevents theme and DOM changes',async()=>{
 let resolveImport;const gate=new Promise(resolve=>{resolveImport=resolve;});
 const module=new vm.SyntheticModule(['createVisuals','composeTokens','recipeFor'],function(){for(const key of ['createVisuals','composeTokens','recipeFor'])this.setExport(key,()=>{throw Error('disposed initialization ran');});});
 await module.link(()=>{});await module.evaluate();
 const fixture=load(()=>gate);fixture.plugin.apply(fixture.ctx);fixture.dispose();resolveImport(module);await new Promise(setImmediate);assert.equal(fixture.warnings.length,0);
});
