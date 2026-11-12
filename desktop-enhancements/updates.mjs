import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import semver from 'semver';
import {parseDocument} from 'yaml';
import {evaluatePluginCompatibility,getDshRuntimeVersion,readProfileVersionExemptions} from '@deepseek-ai/dsh-app-boot';
import {withFileLock,writeFileAtomic} from '@deepseek-ai/dsh-atomic-write';

const check=(v,m)=>{if(!v)throw Error(m);};
const safeMessage=e=>String(e?.message||e||'操作失败').replace(/(token|password|api[-_]?key)=\S+/gi,'$1=[hidden]').slice(0,600);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function updateReason(bundle){
 if(!bundle?.installed||bundle.availability!=='profile'||bundle.official||!bundle.removable||bundle.readOnlyReason)return '内置或受管理的插件，沿用原维护流程';
 if(!semver.valid(bundle.version))return '没有有效的已安装版本';
 const source=bundle.source||'';
 if(source!==bundle.name&&!source.startsWith(bundle.name+'@'))return '本地源码、文件包或链接受保护，不在这里覆盖';
 return null;
}
async function publicManifest(registry,name,version,signal){
 const base=new URL(registry);check(!base.username&&!base.password,'注册源含认证信息，请使用原插件管理流程');
 check(['registry.npmjs.org','registry.npmmirror.com','127.0.0.1','localhost'].includes(base.hostname),'该注册源未纳入此公开包更新入口，请使用原插件管理流程');
 const url=new URL(encodeURIComponent(name)+'/'+encodeURIComponent(version),base.href.replace(/\/?$/,'/'));
 const response=await fetch(url,{signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(15000)])});check(response.ok,'读取版本元数据失败: HTTP '+response.status);
 const text=await response.text();check(Buffer.byteLength(text)<2*1024*1024,'版本元数据过大');return JSON.parse(text);
}
export class PluginUpdates{
 constructor(ctx,{home,profile,manifestReader=publicManifest,runtimeVersion=getDshRuntimeVersion()}={}){
  this.ctx=ctx;this.home=home;this.profile=profile;this.manifestReader=manifestReader;this.runtimeVersion=runtimeVersion;this.plans=new Map();this.flight=null;this.closed=false;this.last=null;this.pendingRestart=false;
  ctx.on?.('agent/pre-step',async(payload,next)=>{
   if(this.flight){const pending=this.flight.done,signal=payload.signal;if(signal.aborted)signal.throwIfAborted();let abort;
    try{await Promise.race([pending,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]);}
    finally{signal.removeEventListener('abort',abort);}
   }
   return next();
  },{prepend:true});
 }
 get manager(){const value=this.ctx.get('pluginManager');check(value,'插件管理服务尚未就绪');return value;}
 async list(){return(await this.manager.listBundles()).filter(b=>b.installed).map(b=>({name:b.name,version:b.version,enabled:b.enabled,canUpdate:updateReason(b)===null,reason:updateReason(b)}));}
 status(){return{pendingRestart:this.pendingRestart,flight:this.flight?{name:this.flight.plan.name,from:this.flight.plan.from,to:this.flight.plan.to,phase:this.flight.phase,requestId:this.flight.requestId}:null,last:this.last};}
 async plan(name,target='latest',signal){
  check(!this.closed,'更新服务已停止');check(!this.pendingRestart,'已有插件等待安全重启生效，请重启后再检查下一项');check(typeof name==='string'&&name.length<=214&&/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name),'插件名称无效');
  check(typeof target==='string'&&(target==='latest'||semver.valid(target)),'请使用准确版本或latest');
  const bundle=(await this.manager.listBundles()).find(b=>b.name===name);check(!updateReason(bundle),updateReason(bundle));
  check(typeof this.manager.removeBundle==='function'&&typeof this.manager.installBundle==='function','当前核心不支持安全更新流程，请走原维护流程');
  const registries=await this.manager.registries(),registry=registries.resolved||registries.registry;check(registry,'无法确定原注册源');
  const manifest=await this.manifestReader(registry,name,target,signal);
  check(manifest.name===name&&semver.valid(manifest.version)&&manifest.dsh?.bundle&&(target==='latest'||manifest.version===target),'目标不是同名、准确版本的插件包');
  check(semver.gt(manifest.version,bundle.version),'目标版本没有高于当前版本');
  const exemptions=this.profile?readProfileVersionExemptions(this.profile):{};
  const incompatible=evaluatePluginCompatibility(manifest,exemptions,this.runtimeVersion);
  check(!incompatible||incompatible.exempted,'目标插件不兼容当前DSH核心，保留已安装版本');
  check(!Object.keys(manifest.scripts||{}).some(k=>['preinstall','install','postinstall','prepare'].includes(k)),'目标含安装脚本，请通过原插件管理页明确处理脚本授权');
  const previousManifest=await this.manifestReader(registry,name,bundle.version,signal);
  check(previousManifest.name===name&&previousManifest.version===bundle.version,'无法核对原版本的恢复来源，保留当前插件');
  let previousSpec=bundle.source.slice(name.length+1);if(this.profile){const current=JSON.parse(await fs.readFile(path.join(this.profile,'package.json'),'utf8'));previousSpec=current.dependencies?.[name];check(typeof previousSpec==='string','当前profile缺少该依赖');}
  const plan={id:randomUUID(),name,from:bundle.version,to:manifest.version,enabled:bundle.enabled,source:bundle.source,registry,previousSpec,manifestHash:hash(manifest),expires:Date.now()+120000};
  for(const [id,p]of this.plans)if(p.expires<Date.now())this.plans.delete(id);check(this.plans.size<20,'待确认的更新过多，请稍后重试');this.plans.set(plan.id,plan);
  return{id:plan.id,name,from:plan.from,to:plan.to,expires:plan.expires,notice:'确认后只更新这一项；有运行中任务时拒绝更新，失败时尝试恢复原版本。'};
 }
 async execute(id){
  check(!this.closed&&!this.flight,'已有更新或服务已停止');check(!this.pendingRestart,'已有插件等待安全重启生效，请重启后再更新下一项');const plan=this.plans.get(id);check(plan&&plan.expires>Date.now(),'更新确认已失效，请重新检查');this.plans.delete(id);
  const current=(await this.manager.listBundles()).find(b=>b.name===plan.name);
  check(!updateReason(current)&&current.version===plan.from&&current.source===plan.source&&current.enabled===plan.enabled,'插件状态已变化，请重新检查');
  check(this.ctx.get('hmr'),'当前宿主没有热加载，保留原版本，请走维护升级流程');
  let release;const done=new Promise(r=>release=r);const flight=this.flight={plan,done,phase:'checking',requestId:'desktop-update-'+randomUUID()};
  try{
   const active=this.ctx.get('agents')?.list?.()||[];check(!active.some(a=>a.status!=='idle'&&a.status!=='disposed'),'还有任务运行中，插件没有更新；请等任务结束后重试');
   const controller=this.ctx.get('sessionController');if(controller){const rows=await controller.list({},new AbortController().signal);check(!rows.items.some(s=>s.running),'还有任务运行中，插件没有更新；请等任务结束后重试');}
   const metadata=await this.manifestReader(plan.registry,plan.name,plan.to);check(hash(metadata)===plan.manifestHash,'目标版本元数据在确认后变化，保留原插件');
   flight.phase='removing';let result;
   try{result=await this.manager.removeBundle(plan.name);}
   catch(error){result={application:'failed',error:{diagnostic:safeMessage(error)}};}
   if(result.application!=='failed'&&result.application!=='cancelled'){
   flight.phase='installing';
   try{result=await this.manager.installBundle(plan.name+'@'+plan.to,{registry:plan.registry,saveExact:true,enabled:plan.enabled,requestId:flight.requestId});}
   catch(error){result={application:'failed',error:{diagnostic:safeMessage(error)}};}
   }
   if(result.application!=='failed'&&result.application!=='cancelled'){
    const after=(await this.manager.listBundles()).find(b=>b.name===plan.name);
    if(after?.version===plan.to){this.pendingRestart=true;this.last={name:plan.name,from:plan.from,to:plan.to,result:'restart-required',reason:'alpha.4不能可靠确认新包代码已热加载；请在任务空闲时正常重启桌面后生效',time:Date.now()};await this.persist();return this.last;}
    result={application:'failed',error:{diagnostic:'安装结果与目标版本不符，开始恢复原版'}};
   }
   flight.phase='restoring';let restore;
   try{
    const leftover=(await this.manager.listBundles()).find(b=>b.name===plan.name&&b.installed);
    if(leftover){check(!updateReason(leftover)&&[plan.from,plan.to].includes(leftover.version),'恢复期间出现独立的插件改动，保留并停止覆盖');const removed=await this.manager.removeBundle(plan.name);check(removed.application!=='failed'&&removed.application!=='cancelled','新版本卸载未通过，停止覆盖并保留诊断');}
    restore=await this.manager.installBundle(plan.name+'@'+plan.from,{registry:plan.registry,saveExact:true,enabled:plan.enabled});
   }
   catch(error){restore={application:'failed',error:{diagnostic:safeMessage(error)}};}
   const restored=(await this.manager.listBundles()).find(b=>b.name===plan.name);
   const recovered=restore.application!=='failed'&&restore.application!=='cancelled'&&restored?.version===plan.from&&restored.enabled===plan.enabled;
   let configWarning;if(recovered)try{await this.restoreSpec(plan);}catch(error){configWarning=safeMessage(error);}
   this.last={name:plan.name,from:plan.from,to:plan.to,result:'failed',restored:recovered,...configWarning?{configWarning}:{},reason:safeMessage(result.error?.diagnostic||result.application),recovery:recovered?'原版本已恢复':'恢复未通过，请到原插件管理页处理',time:Date.now()};await this.persist();return this.last;
  }finally{this.flight=null;release();}
 }
 async restoreSpec(plan){
  if(!this.profile||!plan.previousSpec)return;
  const file=path.join(this.profile,'package.json');
  await withFileLock(file,async()=>{
   const text=await fs.readFile(file,'utf8'),manifest=JSON.parse(text),value=manifest.dependencies?.[plan.name];
   check(value===plan.previousSpec||value===plan.from,'恢复期间依赖声明发生并发修改，保留当前配置，请人工核对');
   const lock=path.join(this.profile,'pnpm-lock.yaml');let lockText;try{lockText=await fs.readFile(lock,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
   if(lockText){const doc=parseDocument(lockText);check(doc.errors.length===0,'恢复后的锁文件无法解析，请在原管理页核对');const key=['importers','.','dependencies',plan.name,'specifier'],specifier=doc.getIn(key);if(specifier!==undefined&&specifier!==plan.previousSpec){check(specifier===plan.from,'恢复期间锁文件发生并发修改，保留当前锁文件');doc.setIn(key,plan.previousSpec);check(await fs.readFile(lock,'utf8')===lockText,'恢复期间锁文件变化，保留新内容');await writeFileAtomic(lock,String(doc),{mode:0o600,dirMode:0o700});}}
   if(value===plan.previousSpec)return;manifest.dependencies[plan.name]=plan.previousSpec;
   check(await fs.readFile(file,'utf8')===text,'恢复期间profile变化，保留新配置');await writeFileAtomic(file,JSON.stringify(manifest,null,2)+'\n',{mode:0o600,dirMode:0o700});
  },{waitMs:3000});
 }
 async cancel(){check(this.flight?.phase==='installing','当前没有可取消的目标安装');return this.manager.cancelInstall(this.flight.requestId);}
 async persist(){if(!this.home)return;try{const file=path.join(this.home,'storage/desktop-enhancements/last-update.json');await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFileAtomic(file,JSON.stringify(this.last)+'\n',{mode:0o600,dirMode:0o700});}catch(error){this.last.receiptError=safeMessage(error);}}
 async close(){this.closed=true;const flight=this.flight;if(flight){if(flight.phase==='installing')await this.manager.cancelInstall(flight.requestId);await flight.done;}}
}
