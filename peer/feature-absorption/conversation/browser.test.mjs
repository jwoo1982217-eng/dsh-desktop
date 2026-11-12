import { tmpdir as __publicTmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createConversationFeatures,offlineHtml} from './host.mjs';
import {projectConversation} from './model.mjs';
import {createContributionRegistry} from '../declarative/host.mjs';

const generated=process.env.DSH_FEATURE_TEST_DIR??(process.platform==='darwin'?(__publicTmpdir() + '/dsh-go-capability-absorption-20261031/generated/share'):path.join(tmpdir(),'dsh-feature-tests-'+process.pid));
const browserExecutable=process.env.DSH_BROWSER_EXECUTABLE??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/chromium');
const wait=async fn=>{const end=Date.now()+8000;while(!(await fn())){if(Date.now()>end)throw Error('Browser condition timed out');await new Promise(r=>setTimeout(r,40));}};
const source={id:'sample',title:'隔离分享验证',messages:[{seq:1,role:'user',blocks:[{type:'text',text:'API_KEY=not-a-real-key-12345 hello'}]},{seq:2,role:'assistant',blocks:[{type:'text',text:'<script>window.pwned=1</script>正文<img src="https://never-fetch.invalid/image.png">'},{type:'reasoning',text:'hidden thought'},{type:'tool',text:'{ "command": "must never execute" }'}]}]};

test('actual browser exports files, replays inert content and invokes isolated declarative controls',async t=>{
 try{await fs.access(browserExecutable);}catch{t.skip('A Chromium executable is required; set DSH_BROWSER_EXECUTABLE');return;}
 await fs.mkdir(generated,{recursive:true});const runDirectory=await fs.mkdtemp(path.join(generated,'browser-case-')),downloadDir=path.join(runDirectory,'downloads');await fs.mkdir(downloadDir,{recursive:true});
 await fs.unlink(path.join(downloadDir,source.title+'.dsh-replay')).catch(error=>{if(error.code!=='ENOENT')throw error;});
 const service=createConversationFeatures({readSession:async()=>source,listSessions:async()=>[{id:'sample',title:source.title}]}),registry=createContributionRegistry();let calls=0;
 for(const slot of ['tool-card','input-capsule','message-action','status','panel'])registry.register('fixture',{version:1,id:slot,slot,title:slot,view:{type:'column',children:[{type:'text',text:'<img src=x onerror=alert(1)>'},{type:'button',id:'run',label:'执行',event:'run'},{type:'input',id:'value',label:'文字',event:'edit'}]}},event=>({count:++calls,action:event.action,value:event.value??null}));
 const base=fileURLToPath(new URL('../',import.meta.url));let offline=offlineHtml(projectConversation(source,{includeReasoning:true,includeTools:true}));
 const server=http.createServer(async(req,res)=>{
  try{
   if(req.method==='POST'){
    const chunks=[];for await(const b of req)chunks.push(b);const payload=JSON.parse(Buffer.concat(chunks));let value;
    if(req.url==='/phone-features/conversation/manage')value=await service.manage(payload);else if(req.url==='/phone-features/declarative/manage')value=await registry.manage(payload);else throw Error('missing');
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,value}));return;
   }
   if(req.url.startsWith('/phone-features/conversation/download/')){const value=service.download(req.url.split('/').at(-1));res.writeHead(200,{'content-type':value.mime,'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(value.filename)}).end(value.body);return;}
   if(req.url==='/offline.html'){res.writeHead(200,{'content-type':'text/html'}).end(offline);return;}
   const pathname=new URL(req.url,'http://fixture').pathname,match=/^\/(conversation|declarative)\/(page\.html|page\.css|client\.js|model\.mjs|renderer\.mjs|host-adapter\.mjs|surface\.css)?$/.exec(pathname);
   if(!match){res.writeHead(404).end();return;}const file=match[2]||'page.html';res.writeHead(200,{'content-type':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/javascript'}).end(await fs.readFile(path.join(base,match[1],file)));
  }catch(error){res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({ok:false,error:{message:error.message}}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port,profile=path.join(runDirectory,'chrome-profile');
 await fs.unlink(path.join(profile,'DevToolsActivePort')).catch(error=>{if(error.code!=='ENOENT')throw error;});
 const chrome=spawn(browserExecutable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','ignore']});
 let ws;
 t.after(async()=>{ws?.close();registry.dispose();service.dispose();const exit=chrome.exitCode===null?once(chrome,'exit'):Promise.resolve();if(chrome.exitCode===null)chrome.kill('SIGTERM');await Promise.race([exit,new Promise(r=>setTimeout(r,3000))]);if(chrome.exitCode===null){chrome.kill('SIGKILL');await exit;}server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(runDirectory,{recursive:true,force:true});});
 let port;await wait(async()=>{try{port=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];return !!port;}catch{return false;}});
 const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(targets.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
 let serial=0;const pending=new Map(),network=[];
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Network.requestWillBeSent')network.push(m.params.request.url);});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'))},8000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;};
 const click=async selector=>{const rect=await evaluate('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});};
 await call('Network.enable');await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir});
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:850,deviceScaleFactor:1,mobile:true});
 await call('Page.navigate',{url:url+'/conversation/'});await wait(()=>evaluate('document.querySelectorAll(".message-row").length===2'));
 assert.equal(await evaluate('document.querySelector("#include-reasoning").checked'),false);
 assert.equal(await evaluate('document.querySelector("#include-tools").checked'),false);
 assert.equal(await evaluate('document.body.textContent.includes("not-a-real-key")'),false);
 await evaluate('document.querySelector("[data-export=json]").scrollIntoView({block:"center"})');await click('[data-export=json]');
 const exported=path.join(downloadDir,source.title+'.dsh-replay');await wait(async()=>{try{return (await fs.stat(exported)).size>0;}catch{return false;}});
 const replay=JSON.parse(await fs.readFile(exported,'utf8'));assert.equal(replay.messages.length,2);assert.deepEqual(replay.messages[1].blocks.map(x=>x.type),['text']);
 await evaluate('document.querySelector("summary").scrollIntoView({block:"center"})');await click('summary');
 await evaluate('document.getElementById("import-text").value='+JSON.stringify(JSON.stringify(replay)));await evaluate('document.getElementById("import-button").scrollIntoView({block:"center"})');await click('#import-button');await wait(()=>evaluate('!document.querySelector("#replay").hidden'));
 await evaluate('document.getElementById("speed").value="4";document.getElementById("speed").dispatchEvent(new Event("change"));document.getElementById("play").scrollIntoView({block:"center"})');await click('#play');await wait(()=>evaluate('document.querySelector("#counter").textContent.startsWith("1 / ")'));await click('#play');
 const paused=await evaluate('document.querySelector("#counter").textContent');await new Promise(r=>setTimeout(r,220));assert.equal(await evaluate('document.querySelector("#counter").textContent'),paused);
 await evaluate('document.getElementById("show-all").scrollIntoView({block:"center"})');await click('#show-all');assert.equal(await evaluate('document.querySelectorAll("#replay-messages article").length'),2);assert.equal(await evaluate('window.pwned'),undefined);
 await call('Page.navigate',{url:url+'/offline.html'});await wait(()=>evaluate('document.getElementById("counter")?.textContent==="0 / 2"'));await click('#all');assert.equal(await evaluate('document.querySelectorAll("#messages article").length'),2);assert.equal(await evaluate('window.pwned'),undefined);
 assert.equal(network.some(x=>x.includes('never-fetch.invalid')),false);
 await call('Page.navigate',{url:url+'/declarative/'});await wait(()=>evaluate('document.querySelectorAll(".dsh-declarative-contribution").length===5'));assert.equal(calls,0);assert.equal(await evaluate('document.querySelectorAll("img").length'),0);
 await click('.dsh-declarative-contribution button');await wait(()=>calls===1);
 const lifecycle=await evaluate(`(async()=>{const {mountContribution}=await import('/declarative/renderer.mjs'),parent=document.createElement('div');document.body.append(parent);let aborted=false;const item={owner:'test',id:'pending',title:'pending',revision:'one',ready:true,view:{type:'button',id:'go',label:'go',event:'go'}};const view=mountContribution(document,parent,item,{sendEvent:(_,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve(null)}))});view.root.querySelector('button').click();await Promise.resolve();view.dispose();return {aborted,remaining:parent.children.length}})()`);assert.deepEqual(lifecycle,{aborted:true,remaining:0});
 const scopes=await evaluate(`(async()=>{const {installContributionSurfaces}=await import('/declarative/renderer.mjs'),target=document.createElement('div');document.body.append(target);let scope='session-a';const seen=[],item={owner:'test',id:'scope',slot:'panel',title:'scope',revision:'one',ready:true,view:{type:'button',id:'go',label:'go',event:'go'}};const controller=installContributionSurfaces({document,load:async()=>({items:[item]}),sendEvent:async event=>{seen.push(event.context.sessionId);return {delivered:true}},targets:{panel:target},context:()=>({sessionId:scope})});await controller.refresh();target.querySelector('button').click();await new Promise(r=>setTimeout(r,0));scope='session-b';controller.syncContext();target.querySelector('button').click();await new Promise(r=>setTimeout(r,0));controller.dispose();return {seen,remaining:target.children.length}})()`);assert.deepEqual(scopes,{seen:['session-a','session-b'],remaining:0});
 const result={actualBrowser:true,mobileWidth:390,exportedFile:true,replayPauseAndSpeed:true,offlineHtmlInert:true,noExternalMediaFetch:true,declarativeSurfaces:5,renderHasNoHostSideEffect:true,explicitEventCalls:calls,lifecycleCancelled:true,sessionScopeSwitchPreserved:true};await fs.writeFile(path.join(generated,'browser-verification.json'),JSON.stringify(result,null,2)+'\n');
});
