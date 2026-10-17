import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {frontendTestAssets} from './frontend-test-assets.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const report=process.argv[2]??path.join(os.tmpdir(),'dsh-jethub-model-refresh');await mkdir(report,{recursive:true});
const client=await readFile(process.env.DSH_MODELS_CLIENT_FILE??path.join(root,'runtime/overlays/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js'),'utf8');
assert.equal(client.split('return module.exports;').length,2);
const tested=client.replace('return module.exports;','module.exports.test={ModelListEditor};return module.exports;');
const dist=path.join(root,'desktop-runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist');const {sharedFrontend,css}=await frontendTestAssets(dist);
const fixture=`import '/assets/test-shared.js';const shared=window.__TEST_SHARED__,React=shared.react;
window.__ModuleLoader__={load:({factory})=>{window.modelsPlugin=factory(id=>shared[id]);}};
${tested}
const initial=[{id:'buddy/vision/with-slash',name:'自定义名称',input:[],contextWindow:12345,maxTokens:33},{id:'fixture/text-only',input:['text']},{id:'fixture/unknown',input:[]}];
window.original=structuredClone(initial);window.saved=structuredClone(initial);window.mode='ok';
const candidates=[{id:'buddy/vision/with-slash',name:'远端名称',inputModalities:['text','image'],contextWindow:99999},{id:'fixture/text-only',inputModalities:['text','image']},{id:'fixture/unknown'},{id:'fixture/new-image',inputModalities:['text','image']}];
const labels={fetchModels:'获取模型',fetchTitle:'选择模型',fetchAdopt:'应用所选',cancel:'取消',close:'关闭',fetchSearch:'搜索',models:'模型',fetchDescription:'选择添加或更新模型',fetchSelectAll:'全选'};const t=key=>labels[key]??key;
function App(){const[models,setModels]=React.useState(initial);return React.createElement(window.modelsPlugin.test.ModelListEditor,{models,onChange:value=>{window.saved=structuredClone(value);setModels(value);},probe:{settingsNs:'llm-pi-ai',provider:'local-relay',baseURL:'http://fixture/v1',api:'openai-completions'},operations:{discoverModels:async()=>window.mode==='fail'?{kind:'refused',message:'本地目录暂不可用'}:{kind:'found',models:candidates}},t,onBusyChange:()=>{},disabled:false,reasoningLevels:[],defaultInput:['text']});}
shared['react-dom/client'].createRoot(document.getElementById('app')).render(React.createElement(App));`;
const server=createServer(async(req,res)=>{const pathname=new URL(req.url,'http://fixture').pathname;
 if(pathname==='/assets/test-shared.js'){res.writeHead(200,{'content-type':'text/javascript'}).end(sharedFrontend);return;}
 if(pathname==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'}).end(fixture);return;}
 if(pathname==='/style.css'){res.writeHead(200,{'content-type':'text/css'}).end(css);return;}
 if(pathname.startsWith('/assets/')){try{res.writeHead(200,{'content-type':'text/javascript'}).end(await readFile(path.join(dist,pathname)));}catch{res.writeHead(404).end();}return;}
 res.writeHead(200,{'content-type':'text/html'}).end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="app"></div><script type="module" src="/fixture.js"></script>');
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const {chromium}=await import(pathToFileURL(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results=[];try{for(const width of [1280,393]){
 const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});await page.goto('http://127.0.0.1:'+server.address().port);
 const open=async()=>{await page.getByRole('button',{name:'获取模型',exact:true}).click();await page.getByRole('dialog',{name:'选择模型',exact:true}).waitFor();};
 await open();const dialog=page.getByRole('dialog',{name:'选择模型',exact:true});const old=dialog.locator('label').filter({hasText:'buddy/vision/with-slash'}).getByRole('checkbox');assert.equal(await old.isChecked(),true);
 await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.saved),await page.evaluate(()=>window.original));
 await open();await dialog.locator('label').filter({hasText:'fixture/text-only'}).getByRole('checkbox').check();await dialog.getByRole('button',{name:'应用所选',exact:true}).click();
 const models=await page.evaluate(()=>window.saved);assert.deepEqual(models[0],{id:'buddy/vision/with-slash',name:'自定义名称',input:['text','image'],contextWindow:12345,maxTokens:33});assert.deepEqual(models[1].input,['text']);assert.deepEqual(models[2].input,[]);assert.deepEqual(models[3],{id:'fixture/new-image',input:['text','image']});assert.equal(models.length,4);
 await page.evaluate(()=>window.mode='fail');await page.getByRole('button',{name:'获取模型',exact:true}).click();await page.getByText('本地目录暂不可用',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.saved),models);assert.deepEqual(errors,[]);
 results.push({width,realModelListEditor:true,fullProviderModelIdPreserved:true,missingImageCapabilityRestored:true,explicitTextPreserved:true,nameAndLimitsPreserved:true,cancelPreservesDraft:true,fetchFailurePreservesDraft:true,duplicates:0});await page.close();
}await writeFile(path.join(report,'verification.json'),JSON.stringify({results},null,2)+'\n');console.log(JSON.stringify({results}));}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
