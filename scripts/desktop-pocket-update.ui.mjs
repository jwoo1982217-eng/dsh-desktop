import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {frontendTestAssets} from './frontend-test-assets.mjs';

const report=path.resolve(process.argv[2]);await mkdir(report,{recursive:true});
const installed=JSON.parse(await readFile(path.join(report,'actual-retry/real-install.json')));
const dist=path.resolve('desktop-runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist'),assets=await frontendTestAssets(dist);
const packageDir=path.join(installed.home,'profiles/web/node_modules/dsh-pocket');
const original=await readFile(path.join(packageDir,'client/client.js'),'utf8');
const client=original.replace('return module.exports;','module.exports.test={PocketSettingsTab,zh2};return module.exports;');
if(client===original)throw Error('Cannot expose the actual Pocket settings component');
const fixture=`import '/assets/shared.js';const shared=window.__TEST_SHARED__;window.__ModuleLoader__={load:({factory})=>{window.plugin=factory(id=>shared[id]);}};
${client}
const{PocketSettingsTab,zh2}=window.plugin.test;let calls=0,fail=true;window.switchToSuccess=()=>{fail=false;};
const rpcCall=async(endpoint)=>{if(endpoint==='pocket.version')return{ok:true,value:{current:'2.10.6',loaded:'2.10.6'}};
if(endpoint==='pocket.status')return{ok:true,value:{desktop:false,proxyRunning:true,lanEnabled:false,tunnelRunning:false,lanAuthEnabled:true,tunnelConfig:{mode:'quick'},tunnelState:{phase:'idle'}}};
if(endpoint==='pocket.update'){calls++;document.getElementById('calls').textContent='update calls: '+calls;await new Promise(r=>setTimeout(r,250));return{ok:true,value:fail?{ok:false,error:'下载失败测试，可重试'}:{ok:true,version:'2.12.0',autoRestart:false,restartRequired:true}};}throw Error('Unexpected endpoint '+endpoint);};
const nativeFetch=window.fetch;window.fetch=(url,opts)=>String(url).startsWith('https://registry.npmjs.org/')?Promise.resolve(new Response(JSON.stringify({version:'2.12.0'}),{headers:{'content-type':'application/json'}})):nativeFetch(url,opts);
document.getElementById('form').onsubmit=e=>{e.preventDefault();document.getElementById('submits').textContent='UNEXPECTED FORM SUBMIT';};
document.getElementById('success').onclick=()=>{fail=false;document.getElementById('success').textContent='成功响应已启用';};
shared['react-dom/client'].createRoot(document.getElementById('app')).render(shared.react.createElement(PocketSettingsTab,{rpcCall,t:key=>zh2[key]??key}));`;
const server=createServer(async(req,res)=>{
 const p=new URL(req.url,'http://fixture').pathname;
 if(p==='/assets/shared.js'){res.writeHead(200,{'content-type':'text/javascript'}).end(assets.sharedFrontend);return;}
 if(p==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'}).end(fixture);return;}
 if(p==='/style.css'){res.writeHead(200,{'content-type':'text/css'}).end(assets.css);return;}
 if(p.startsWith('/assets/')){try{res.writeHead(200,{'content-type':'text/javascript'}).end(await readFile(path.join(dist,p)));}catch{res.writeHead(404).end();}return;}
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="calls">update calls: 0</div><div id="submits">form submits: 0</div><button id="success" type="button">下次返回成功</button><form id="form"><div id="app"></div></form><script type="module" src="/fixture.js"></script>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port;
await writeFile(path.join(report,'ui-fixture.json'),JSON.stringify({url,packageDir,actualComponent:true}));console.log(url);
