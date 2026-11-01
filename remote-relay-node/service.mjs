import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createFixedRelay} from './server.mjs';

export async function startService(config){
 if(!config||!Number.isInteger(config.port)||config.port<1024||config.port>65535||!config.cloudflared||!config.tokenFile||!config.adminKeyFile||!config.admissionsFile)throw Error('Fixed relay service configuration invalid');
 const adminKey=(await fs.readFile(config.adminKeyFile,'utf8')).trim();
 const relay=await createFixedRelay({adminKey,admissionsFile:config.admissionsFile,androidCertSha256:config.androidCertSha256});
 try{await new Promise((resolve,reject)=>{relay.server.once('error',reject);relay.server.listen(config.port,'127.0.0.1',resolve)})}catch(e){await relay.close().catch(()=>{});throw e}
 let child,timer,closed=false,attempt=0;
 const connect=()=>{
  if(closed)return;
  child=spawn(config.cloudflared,['tunnel','--no-autoupdate','--protocol','http2','run','--token-file',config.tokenFile],{stdio:['ignore','ignore','pipe'],env:{...process.env,TUNNEL_METRICS:'127.0.0.1:0'}});
  child.stderr.on('data',bytes=>{const text=bytes.toString();if(text.includes('Registered tunnel connection')){attempt=0;console.log('DSH fixed tunnel connected')}else if(/ERR|error/i.test(text))console.error('DSH fixed tunnel reported a connection error')});
  child.once('error',()=>console.error('DSH fixed tunnel could not start'));
  child.once('close',()=>{child=null;if(!closed){const delay=Math.min(30000,1000*2**Math.min(attempt++,5));timer=setTimeout(connect,delay)}});
 };
 connect();console.log('DSH fixed relay service ready');
 return{relay,async close(){if(closed)return;closed=true;clearTimeout(timer);const owned=child;if(owned&&!owned.killed){const exited=new Promise(r=>owned.once('exit',r));owned.kill('SIGTERM');let force;await Promise.race([exited,new Promise(r=>{force=setTimeout(()=>{owned.kill('SIGKILL');r()},5000)})]);clearTimeout(force)}await relay.close()}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const service=await startService(JSON.parse(await fs.readFile(process.argv[2],'utf8')));let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await service.close();process.exit(0)};process.on('SIGTERM',stop);process.on('SIGINT',stop)}catch{console.error('DSH fixed relay service failed to start');process.exit(1)}
}
