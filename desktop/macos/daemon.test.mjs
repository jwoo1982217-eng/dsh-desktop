import { tmpdir as __publicTmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createDesktopDaemon,parseDaemonArgs} from './app/daemon.mjs';
import {Backend,statePath} from './app/backend.mjs';
const generated=process.env.DSH_DAEMON_TEST_DIR??(process.platform==='darwin'?(__publicTmpdir() + '/dsh-go-capability-absorption-20261031/generated/daemon-tests'):path.join(os.tmpdir(),'dsh-daemon-tests'));
const executable=fileURLToPath(new URL('./app/daemon.mjs',import.meta.url));
async function wait(fn,label){const end=Date.now()+10000;while(!await fn()){if(Date.now()>end)throw Error('Timeout: '+label);await new Promise(resolve=>setTimeout(resolve,25));}}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function fixture(t){await fs.mkdir(generated,{recursive:true});const directory=await fs.mkdtemp(path.join(generated,'case-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const home=path.join(directory,'home'),runtime=path.join(directory,'runtime'),module=path.join(runtime,'node_modules/@deepseek-ai/dsh');await fs.mkdir(path.join(module,'lib'),{recursive:true});await fs.writeFile(path.join(module,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version:'0.2.1-alpha.4'}));await fs.writeFile(path.join(runtime,'bundle.json'),JSON.stringify({version:'test',plugins:[],profile:{dependencies:{},dsh:{profile:{bundles:[]}}}}));
 const core=`const http=require('node:http');const p=Number(process.argv[process.argv.indexOf('--port')+1]);const s=http.createServer((q,r)=>{if(q.url.includes('token=')){r.writeHead(303,{'set-cookie':'session=test; HttpOnly',location:'/'}).end();}else r.end('__DSH_BOOT__');});s.listen(p,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+p+'/?token=PRIVATE_DAEMON_TEST_TOKEN'));process.on('SIGTERM',()=>{s.closeAllConnections();s.close(()=>process.exit(0));});`;
 await fs.writeFile(path.join(module,'lib/bin.js'),core);const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const port=s.address().port;await new Promise(resolve=>s.close(resolve));return {home,runtime,node:process.execPath,port,cwd:directory};}
function launch(f,t){const child=spawn(process.execPath,[executable,'--home',f.home,'--runtime',f.runtime,'--node',f.node,'--port',String(f.port)],{cwd:f.cwd,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH}});let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}});return {child,output:()=>output};}

test('daemon arguments require explicit absolute runtime/home/node and reject unknown or malformed flags',()=>{
 assert.equal(parseDaemonArgs(['--home','/home/test','--runtime','/runtime','--node','/node']).port,3080);for(const args of [[],['--home','relative','--runtime','/runtime','--node','/node'],['--home','/home','--runtime','/runtime','--node','/node','--port','0'],['--home','/home','--runtime','/runtime','--node','/node','--open','true']])assert.throws(()=>parseDaemonArgs(args));
});
test('reused backend stays alive with a referenced 30s PID-only watch, then starts only when PID disappears',async()=>{
 class Fake extends EventEmitter{constructor(){super();this.calls=0;this.stops=0;this.owned=false;}async start(){this.calls++;if(this.calls===1)return {pid:12345,reused:true,url:'PRIVATE_TOKEN'};this.owned=true;this.child={pid:12346};return {pid:12346,reused:false};}async stop(){this.stops++;this.owned=false;}}
 const backend=new Fake();let scheduled,checks=0,exists=true;const daemon=createDesktopDaemon({home:'/home',runtime:'/runtime',node:'/node'},{backendFactory:()=>backend,pidAlive:pid=>{assert.equal(pid,12345);checks++;return exists;},schedule:(fn,ms)=>{assert.equal(ms,30000);scheduled=fn;return 1;},cancel:()=>{scheduled=null;}});await daemon.start();assert.equal(daemon.status().mode,'reused');assert.equal(backend.calls,1);assert.equal(JSON.stringify(daemon.status()).includes('PRIVATE_TOKEN'),false);scheduled();assert.equal(checks,1);assert.equal(backend.calls,1);exists=false;scheduled();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(backend.calls,2);assert.equal(daemon.status().mode,'owned');await daemon.stop();assert.equal(await daemon.done,0);assert.equal(backend.stops,1);
});
test('stop during preparation waits for start and releases only a newly owned child',async()=>{
 let ready;class Fake extends EventEmitter{constructor(){super();this.owned=false;this.stops=0;}async start(){await new Promise(resolve=>{ready=resolve;});this.owned=true;this.child={pid:12346};return {pid:12346,reused:false};}async stop(){this.stops++;this.owned=false;}}
 const backend=new Fake(),daemon=createDesktopDaemon({home:'/home',runtime:'/runtime',node:'/node'},{backendFactory:()=>backend});const starting=daemon.start(),stopping=daemon.stop();assert.equal(backend.stops,0);ready();await starting;await stopping;assert.equal(await daemon.done,0);assert.equal(backend.owned,false);assert.equal(backend.stops,1);
});
test('failed recovery of a vanished borrowed PID exits once without a background retry loop',async()=>{
 class Fake extends EventEmitter{constructor(){super();this.calls=0;this.owned=false;}async start(){if(++this.calls===1)return {pid:12345,reused:true};throw Error('PRIVATE_START_FAILURE');}async stop(){assert.fail('must not stop a borrowed PID');}}
 let scheduled;const backend=new Fake(),daemon=createDesktopDaemon({home:'/home',runtime:'/runtime',node:'/node'},{backendFactory:()=>backend,pidAlive:()=>false,schedule:fn=>{scheduled=fn;return 1;},cancel:()=>{scheduled=null;}});await daemon.start();const tick=scheduled;scheduled=null;tick();assert.equal(await daemon.done,1);assert.equal(backend.calls,2);assert.equal(scheduled,null);assert.equal(daemon.status().mode,'stopped');
});
test('actual daemon owns one core/state, emits no token and SIGTERM stops only its child',async t=>{
 const f=await fixture(t),d=launch(f,t);let state;await wait(async()=>{try{state=JSON.parse(await fs.readFile(statePath(f.home,f.port),'utf8'));return state.pid!==d.child.pid&&alive(state.pid);}catch{return false;}},'owned core state');assert.equal((await fs.stat(statePath(f.home,f.port))).mode&0o777,0o600);const exited=once(d.child,'exit');d.child.kill('SIGTERM');assert.equal((await exited)[0],0);await wait(()=>!alive(state.pid),'owned core stopped');assert.equal(d.output().includes('PRIVATE_DAEMON_TEST_TOKEN'),false);await assert.rejects(fs.lstat(statePath(f.home,f.port)),{code:'ENOENT'});
});
test('actual daemon borrowing an existing core does not exit/relaunch or stop that core on SIGTERM',async t=>{
 const f=await fixture(t),backend=new Backend({...f,log(){}});const state=await backend.start();t.after(()=>backend.stop());const d=launch(f,t);await new Promise(resolve=>setTimeout(resolve,800));assert.equal(d.child.exitCode,null);assert.equal(alive(state.pid),true);const exited=once(d.child,'exit');d.child.kill('SIGTERM');assert.equal((await exited)[0],0);assert.equal(alive(state.pid),true);assert.equal(d.output().includes('PRIVATE_DAEMON_TEST_TOKEN'),false);
});
test('unexpected owned core exit terminates actual daemon with code 1 for the existing KeepAlive policy',async t=>{
 const f=await fixture(t),d=launch(f,t);let state;await wait(async()=>{try{state=JSON.parse(await fs.readFile(statePath(f.home,f.port),'utf8'));return alive(state.pid);}catch{return false;}},'core before exit');const exited=once(d.child,'exit');process.kill(state.pid,'SIGTERM');assert.equal((await exited)[0],1);assert.equal(d.output().includes('PRIVATE_DAEMON_TEST_TOKEN'),false);
});
