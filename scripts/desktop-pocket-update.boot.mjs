import assert from 'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';
import{spawn}from'node:child_process';import{createServer}from'node:net';import path from'node:path';
const report=path.resolve(process.argv[2]);const installed=JSON.parse(await readFile(path.join(report,'actual-retry/real-install.json')));
const home=installed.home,profile=path.join(home,'profiles/web');
const file=path.join(profile,'package.json'),manifest=JSON.parse(await readFile(file));
manifest.dsh.profile.bundles=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-pocket'];await writeFile(file,JSON.stringify(manifest));
const unused=async()=>{const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;};
const port=await unused(),pocketPort=await unused();await writeFile(path.join(home,'dsh-pocket/settings.json'),JSON.stringify({proxyPort:pocketPort}));
const core=path.resolve('desktop-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
const child=spawn(process.execPath,['--expose-internals',core,'--profile','web','--host','127.0.0.1','--port',String(port),'--no-open'],{env:{...process.env,DSH_HOME:home},stdio:['ignore','pipe','pipe']});
let output='',errors='';child.stderr.on('data',b=>errors=(errors+b).slice(-2000));
try{
 const entry=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('isolated boot timed out: '+errors.replace(/token=\S+/g,'token=[hidden]'))),30000);child.stdout.on('data',b=>{output+=b;const m=output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.once('exit',c=>{clearTimeout(timer);reject(Error('isolated boot exit '+c+': '+errors.replace(/token=\S+/g,'token=[hidden]')));});});
 const u=new URL(entry),auth=await fetch(u,{redirect:'manual'}),cookie=auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 const rpc=async method=>{const r=await fetch(u.origin+'/dsh-pocket/'+method,{method:'POST',headers:{cookie,origin:u.origin,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{}}),signal:AbortSignal.timeout(20000)});return{status:r.status,...await r.json()};};
 const version=await rpc('pocket.version');assert.equal(version.result.value.current,'2.12.0');assert.equal(version.result.value.loaded,'2.12.0');
 const update=await rpc('pocket.update');assert.equal(update.result.ok,true);assert.equal(update.result.value.ok,true);assert.equal(update.result.value.autoRestart,false);
 const after=await rpc('pocket.version');assert.equal(after.status,200);process.kill(child.pid,0);
 const receipt={isolatedPid:child.pid,version:version.result.value,update:update.result.value,hostSurvivedUpdate:true,actualSdkAndHttp:true};
 await writeFile(path.join(report,'boot-verification.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}}
