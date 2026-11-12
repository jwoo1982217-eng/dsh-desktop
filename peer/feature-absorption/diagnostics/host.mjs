import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {sanitizeFacts,sanitizeLogs} from './redact.mjs';
import {createZip} from './zip.mjs';

export const DIAGNOSTICS_ASSETS=Object.freeze([
 {path:'/phone-features/diagnostics',file:new URL('./page.html',import.meta.url),type:'text/html'},
 {path:'/phone-features/diagnostics/client.js',file:new URL('./client.js',import.meta.url),type:'text/javascript'},
 {path:'/phone-features/diagnostics/style.css',file:new URL('./style.css',import.meta.url),type:'text/css'},
]);
export function createDiagnostics({sources=[],knownSecrets=[],now=()=>new Date(),timeoutMs=1500}={}){
 if(!Array.isArray(sources)||sources.length>16||sources.some(x=>!x||x.name==='summary'||!/^[a-z][a-z0-9-]{0,39}$/.test(x.name)||!['facts','logs'].includes(x.kind)||typeof x.read!=='function')||new Set(sources.map(x=>x.name)).size!==sources.length)throw Error('Invalid diagnostic sources');
 const timeout=Number.isFinite(timeoutMs)?Math.max(50,Math.min(timeoutMs,5000)):1500;
 const boundedRead=async read=>{const controller=new AbortController();let timer;try{return await Promise.race([Promise.resolve().then(()=>read(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('DIAGNOSTIC_SOURCE_TIMEOUT'));},timeout);})]);}finally{clearTimeout(timer);}};
 let collecting;const downloads=new Map();
 const snapshot=()=>{
  if(collecting)return collecting;
  collecting=(async()=>{
   let secrets;try{secrets=typeof knownSecrets==='function'?await boundedRead(knownSecrets):knownSecrets;}catch{secrets=undefined;}
   const entries=await Promise.all(sources.map(async source=>{
    try{
     if(source.kind==='facts'&&!Array.isArray(secrets))throw Error('DIAGNOSTIC_SECRETS_UNAVAILABLE');
     const value=await boundedRead(source.read);
     return {name:source.name,kind:source.kind,status:'ok',value:source.kind==='logs'?sanitizeLogs(value):sanitizeFacts(value,{knownSecrets:secrets})};
    }catch{return {name:source.name,kind:source.kind,status:'unavailable'};}
   }));
   return {format:'dsh-diagnostics-v1',generatedAt:now().toISOString(),privacy:{credentials:'excluded',conversations:'excluded',logs:'technical-codes-only',upload:'none'},sources:entries};
  })().finally(()=>{collecting=undefined;});
  return collecting;
 };
 const bundle=async()=>{
  const value=await snapshot(),manifest={...value,sources:value.sources.map(({name,kind,status})=>({name,kind,status}))};
  const files=[{name:'summary.json',bytes:JSON.stringify(manifest,null,2)+'\n'}];
  for(const source of value.sources.filter(x=>x.status==='ok'))files.push({name:source.name+(source.kind==='logs'?'.log':'.json'),bytes:source.kind==='logs'?source.value.lines.join('\n')+'\n'+`# ${source.value.policy}; ${source.value.omittedLines} non-technical lines omitted\n`:JSON.stringify(source.value,null,2)+'\n'});
  return {bytes:createZip(files),fileName:'dsh-diagnostics-'+value.generatedAt.replace(/[^0-9]/g,'').slice(0,14)+'.zip',snapshot:value};
 };
 const prune=()=>{const time=now().getTime();for(const [id,item]of downloads)if(item.expiresAt<=time)downloads.delete(id);};
 const prepare=async()=>{
  const output=await bundle();prune();while(downloads.size>=3)downloads.delete(downloads.keys().next().value);
  const id=randomBytes(24).toString('hex');downloads.set(id,{...output,expiresAt:now().getTime()+60000,remainingGets:3});
  return {downloadUrl:'/phone-features/diagnostics/download/'+id,fileName:output.fileName,snapshot:output.snapshot};
 };
 // WebView first GETs the attachment, then DownloadListener fetches it again.
 // Keep the exact immutable bundle for a bounded number of retries; HEAD is metadata only.
 const takeDownload=(id,{consume=true}={})=>{prune();if(!/^[a-f0-9]{48}$/.test(String(id??'')))return;const output=downloads.get(id);if(output&&consume&&--output.remainingGets===0)downloads.delete(id);return output;};
 return {snapshot,bundle,prepare,takeDownload,close:()=>downloads.clear(),assets:DIAGNOSTICS_ASSETS.map(x=>({...x,bytes:readFileSync(x.file)}))};
}
