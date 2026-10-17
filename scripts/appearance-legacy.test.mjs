import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {frontendTestAssets} from './frontend-test-assets.mjs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
test('real alpha.4 settings slots keep one appearance row and restore legacy on removal',async()=>{
 const source=await readFile(new URL('../peer/agent-cards/client-source.js',import.meta.url),'utf8');
 const helper=source.slice(source.indexOf('function registerLegacyAppearance'),source.indexOf('/** React 18'));
 const dist=path.join(root,'desktop-runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist');
 const {sharedFrontend}=await frontendTestAssets(dist);
 const server=createServer(async(req,res)=>{
  if(req.url==='/assets/test-shared.js'){res.writeHead(200,{'content-type':'text/javascript'}).end(sharedFrontend);return;}
  if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'}).end("import '/assets/test-shared.js';\n"+helper+`\nwindow.fixture={SlotCore:window.__TEST_SHARED__['@deepseek-ai/dsh-client-ui-slots'].SlotCore,registerLegacyAppearance};`);return;}
  if(req.url?.startsWith('/assets/')){try{res.writeHead(200,{'content-type':'text/javascript'}).end(await readFile(path.join(dist,req.url)));}catch{res.writeHead(404).end();}return;}
  res.writeHead(200,{'content-type':'text/html'}).end('<script type="module" src="/fixture.js"></script>');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const {chromium}=await import(pathToFileURL(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.fixture);
  const result=await page.evaluate(()=>{
   const {SlotCore,registerLegacyAppearance}=window.fixture;const slots=new SlotCore(),listeners=new Set();slots.register({name:'root',children:{'settings.section':{kind:'list',scope:'root'}}},()=>null);
   slots.onMutate(key=>{for(const fn of listeners)fn(key);});
   const ctx={slots:{inject:(key,fn)=>fn(),register:(...args)=>slots.register(...args),entriesOfSlot:key=>slots.entriesOfSlot(key)},on:(event,fn)=>{listeners.add(fn);return()=>listeners.delete(fn);}};
   const counts=[];const cleanup=registerLegacyAppearance(ctx,{name:'settings.section',id:'appearance',label:'外观皮肤'},()=>null);counts.push(slots.entries('settings.section').length);
   const remove=slots.register({name:'settings.section',id:'appearance',label:'外观',priority:-100},()=>null);counts.push(slots.entries('settings.section').length);const unified=slots.entries('settings.section')[0].options.label;
   slots.register({name:'settings.section',id:'another',label:'其他插件'},()=>null);counts.push(slots.entries('settings.section').length);
   remove();const restored=slots.entriesOfSlot('settings.section').find(e=>e.options.id==='appearance').options.label;cleanup();counts.push(slots.entries('settings.section').length);
   return{counts,unified,restored,listeners:listeners.size};
  });assert.deepEqual(result,{counts:[1,1,2,1],unified:'外观',restored:'外观皮肤',listeners:0});
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
