import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

export const NATIVE_MAX_BYTES=65536;
const commands=new Set(['status','session.seed','session.event','overlay.update','overlay.hide','background.update','actions.drain','rescue.status','rescue.select']);
export class NativeFeatureError extends Error {
 constructor(code){super(({NATIVE_UNAVAILABLE:'手机原生功能尚未就绪',NATIVE_DESCRIPTOR:'手机原生桥接描述无效',NATIVE_TIMEOUT:'手机原生功能响应超时',NATIVE_ABORTED:'手机原生请求已取消',NATIVE_BUSY:'手机原生请求繁忙',NATIVE_PROTOCOL:'手机原生响应不完整或格式无效',NATIVE_REJECTED:'手机原生功能拒绝了此操作',NATIVE_REQUEST:'手机原生请求无效'})[code]??'手机原生功能暂时不可用');this.name='NativeFeatureError';this.code=code;}
}
export function descriptorPath({home=process.env.DSH_HOME,env=process.env}={}){
 const file=env.DSH_PHONE_FEATURE_BRIDGE||(home?path.join(home,'storage/phone-features/native-bridge.json'):null);
 if(!file||!path.isAbsolute(file)||file.length>4096||/[\0\r\n]/.test(file))throw new NativeFeatureError('NATIVE_UNAVAILABLE');return file;
}
export function readNativeDescriptor(file,{uid=process.getuid?.()}={}){
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.size<2||stat.size>4096||(uid!==undefined&&stat.uid!==uid)||(stat.mode&0o077)!==0)throw new NativeFeatureError('NATIVE_DESCRIPTOR');
  const bounded=Buffer.alloc(4097),length=fs.readSync(fd,bounded,0,bounded.length,0);if(length!==stat.size||length>4096)throw new NativeFeatureError('NATIVE_DESCRIPTOR');const bytes=bounded.subarray(0,length);
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(value?.protocol!==1||!/^dsh-phone-features-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.address)||!Number.isSafeInteger(value.pid)||value.pid<1||value.pid>2147483647)throw new NativeFeatureError('NATIVE_DESCRIPTOR');
  return {protocol:1,address:value.address,pid:value.pid};
 }catch(error){if(error instanceof NativeFeatureError)throw error;throw new NativeFeatureError(error.code==='ENOENT'?'NATIVE_UNAVAILABLE':'NATIVE_DESCRIPTOR');}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function encodeNativeRequest(command,payload={}){
 if(!commands.has(command)||!payload||typeof payload!=='object'||Array.isArray(payload))throw new NativeFeatureError('NATIVE_REQUEST');
 let bytes;try{bytes=Buffer.from(JSON.stringify({...payload,command}));}catch{throw new NativeFeatureError('NATIVE_REQUEST');}
 if(bytes.length<1||bytes.length>NATIVE_MAX_BYTES)throw new NativeFeatureError('NATIVE_REQUEST');const header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);return Buffer.concat([header,bytes]);
}

/** One request per private socket; no retries or response/payload logging. */
export function createNativeClient({home=process.env.DSH_HOME,env=process.env,platform=process.platform,timeoutMs=5000,maxConcurrent=2,maxPending=32,
 connect=descriptor=>net.createConnection({path:'\0'+descriptor.address}),readDescriptor=readNativeDescriptor,now=Date.now}={}){
 if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>8||!Number.isInteger(maxPending)||maxPending<0||maxPending>64)throw new NativeFeatureError('NATIVE_REQUEST');
 const defaultTimeout=Number.isFinite(timeoutMs)?Math.max(10,Math.min(timeoutMs,10000)):5000;
 let closed=false,active=0;const waiting=[],jobs=new Set();
 const pump=()=>{
  while(!closed&&active<maxConcurrent&&waiting.length){
   const job=waiting.shift();if(job.done)continue;active++;job.started=true;run(job);
  }
 };
 function finish(job,error,value){
  if(job.done)return;job.done=true;clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.abort);job.socket?.destroy();jobs.delete(job);if(job.started)active--;else{const index=waiting.indexOf(job);if(index!==-1)waiting.splice(index,1);}error?job.reject(error):job.resolve(value);pump();
 }
 function run(job){
  if(now()>=job.deadline){finish(job,new NativeFeatureError('NATIVE_TIMEOUT'));return;}
  try{
   const descriptor=readDescriptor(descriptorPath({home,env}));job.socket=connect(descriptor);let buffer=Buffer.alloc(0),expected;
   job.socket.on('connect',()=>{if(!job.done)try{job.socket.write(job.bytes);}catch{finish(job,new NativeFeatureError('NATIVE_UNAVAILABLE'));}});
   job.socket.on('error',()=>finish(job,new NativeFeatureError('NATIVE_UNAVAILABLE')));
   job.socket.on('end',()=>{if(!job.done)finish(job,new NativeFeatureError('NATIVE_PROTOCOL'));});
   job.socket.on('close',()=>{if(!job.done)finish(job,new NativeFeatureError('NATIVE_UNAVAILABLE'));});
   job.socket.on('data',chunk=>{
    if(job.done)return;
    if(buffer.length+chunk.length>NATIVE_MAX_BYTES+4){finish(job,new NativeFeatureError('NATIVE_PROTOCOL'));return;}
    buffer=Buffer.concat([buffer,chunk]);
    if(expected===undefined&&buffer.length>=4){expected=buffer.readUInt32BE();if(expected<1||expected>NATIVE_MAX_BYTES){finish(job,new NativeFeatureError('NATIVE_PROTOCOL'));return;}}
    if(expected===undefined||buffer.length<expected+4)return;
    if(buffer.length!==expected+4){finish(job,new NativeFeatureError('NATIVE_PROTOCOL'));return;}
    try{
     const response=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(4)));
     if(response?.ok===false){finish(job,new NativeFeatureError('NATIVE_REJECTED'));return;}
     if(response?.ok!==true||!response.value||typeof response.value!=='object'||Array.isArray(response.value))throw Error('Invalid reply');
     finish(job,null,response.value);
    }catch{finish(job,new NativeFeatureError('NATIVE_PROTOCOL'));}
   });
  }catch(error){finish(job,error instanceof NativeFeatureError?error:new NativeFeatureError('NATIVE_UNAVAILABLE'));}
 }
 const call=(command,payload={},options={})=>{
  if(closed||options.signal?.aborted)return Promise.reject(new NativeFeatureError('NATIVE_ABORTED'));
  if(platform!=='android')return Promise.reject(new NativeFeatureError('NATIVE_UNAVAILABLE'));
  let bytes;try{bytes=encodeNativeRequest(command,payload);}catch(error){return Promise.reject(error);}
  if(active>=maxConcurrent&&waiting.filter(x=>!x.done).length>=maxPending)return Promise.reject(new NativeFeatureError('NATIVE_BUSY'));
  const timeout=Number.isFinite(options.timeoutMs)?Math.max(10,Math.min(options.timeoutMs,10000)):defaultTimeout;
  return new Promise((resolve,reject)=>{
   const job={bytes,resolve,reject,signal:options.signal,deadline:now()+timeout,done:false,started:false};
   job.abort=()=>finish(job,new NativeFeatureError('NATIVE_ABORTED'));job.timer=setTimeout(()=>finish(job,new NativeFeatureError('NATIVE_TIMEOUT')),timeout);job.signal?.addEventListener('abort',job.abort,{once:true});jobs.add(job);waiting.push(job);pump();
  });
 };
 return {call,close(){if(closed)return;closed=true;for(const job of [...jobs])finish(job,new NativeFeatureError('NATIVE_ABORTED'));waiting.length=0;},status(){return {platformSupported:platform==='android',active,pending:waiting.filter(x=>!x.done).length,closed};}};
}
