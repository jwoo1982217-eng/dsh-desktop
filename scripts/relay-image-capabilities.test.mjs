import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const target=new URL('../desktop-runtime/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/.relay-qa-'+randomUUID()+'.mjs',import.meta.url);
const source=await readFile(new URL('../runtime/overlays/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',import.meta.url),'utf8');
await writeFile(target,source+'\nexport {resolveProfiles,readListing};\n');
let sdk;try{sdk=await import(target.href);}finally{await rm(target);}
function adapter(models,extra={}){
 const profiles=sdk.resolveProfiles({'qa-relay':{api:'openai-completions',baseURL:'http://127.0.0.1:1/v1',models,...extra}});
 return new sdk.PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>undefined});
}
test('the real relay adapter resolves the current GLM model as image capable',async()=>{
 const a=adapter([{id:'glm-5.3-flash',input:[]}]);
 assert.deepEqual((await a.resolveModel('qa-relay','glm-5.3-flash')).inputModalities,['text','image']);
 assert.deepEqual((await a.listModels('qa-relay'))[0].inputModalities,['text','image']);
});
test('exact GPT and Claude IDs retain catalog image capability on custom relays',async()=>{
 const ids=['gpt-6.1-sol','gpt-6-sol','claude-opus-4-6'];const a=adapter(ids.map(id=>({id})));
 for(const id of ids)assert.ok((await a.resolveModel('qa-relay',id)).inputModalities.includes('image'),id);
});
test('an explicitly text-only model remains text-only',async()=>{
 const a=adapter([{id:'glm-5.3-flash',input:['text']}]);
 assert.deepEqual((await a.resolveModel('qa-relay','glm-5.3-flash')).inputModalities,['text']);
});
test('unknown IDs and lookalike aliases keep route defaults without guessing',async()=>{
 const ids=['qa-unknown','gpt-6.1-sol-qa-alias'];const a=adapter(ids.map(id=>({id,input:[]})));
 for(const id of ids)assert.deepEqual((await a.resolveModel('qa-relay',id)).inputModalities,['text']);
 const b=adapter([{id:'qa-unknown'}],{defaultInput:['text','image']});assert.deepEqual((await b.resolveModel('qa-relay','qa-unknown')).inputModalities,['text','image']);
});
test('provider-specific model declarations retain priority over relay fallback',async()=>{
 const profiles=sdk.resolveProfiles({radius:{models:[{id:'glm-5.3-flash'}]}});
 const a=new sdk.PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>undefined});
 assert.deepEqual((await a.resolveModel('radius','glm-5.3-flash')).inputModalities,['text']);
});
test('model discovery preserves endpoint image and explicit text capabilities',()=>{
 const rows=sdk.readListing({data:[{id:'custom-image',architecture:{input_modalities:['text','image']}},{id:'glm-5.3-flash',input:['text']},{id:'gpt-6.1-sol'},{id:'unknown',input:['bogus']}]},'openai-completions');
 assert.deepEqual(rows[0].inputModalities,['text','image']);assert.deepEqual(rows[1].inputModalities,['text']);assert.deepEqual(rows[2].inputModalities,['text','image']);assert.equal(rows[3].inputModalities,undefined);
});
test('invalid discovery fails and a later valid discovery remains usable',()=>{
 assert.throws(()=>sdk.readListing({error:'fixture failure'}),/model listing/);
 assert.deepEqual(sdk.readListing({data:[{id:'glm-5.3-flash'}]},'openai-completions')[0].inputModalities,['text','image']);
});
