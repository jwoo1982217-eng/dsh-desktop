import fs from 'node:fs';
import path from 'node:path';
import {createSessionNotifications} from './index.mjs';
const valid=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);
const ordinary=session=>valid(session?.id)&&!session.id.startsWith('qq-')&&!session.id.startsWith('cloud-')&&session.header?.origin!=='subagent'&&!(session.header?.delegationDepth>0);
const prefsKeys=new Set(['enabled','completed','failed','stopped','approval','question']);
function preferences(file){try{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>4096||(stat.mode&0o077)||stat.uid!==process.getuid?.())return {};const b=Buffer.alloc(4097),n=fs.readSync(fd,b,0,b.length,0),value=JSON.parse(b.subarray(0,n));if(n!==stat.size||!value||Object.keys(value).some(k=>!prefsKeys.has(k)||typeof value[k]!=='boolean'))return {};return value;}finally{fs.closeSync(fd);}}catch{return {};}}
function writePreferences(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temporary=file+'.'+process.pid+'.tmp';try{fs.writeFileSync(temporary,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}}

/** Observes real resident Sessions; never resumes, lists history bodies, appends or changes permissions. */
export function createFeatureSessionRuntime(ctx,{nativeCall,home,controlCall,now=Date.now,renewMs=60000,actionMs=1000,onError=()=>{}}={}){
 const file=path.join(home,'storage/phone-features/notification-preferences.json'),notifier=createSessionNotifications({nativeCall,manageBackground:false,preferences:preferences(file),now,isAppForeground:async()=>{try{return(await nativeCall('status',{})).foreground===true;}catch{return false;}}}),seeded=new WeakSet(),disposers=[],actions=[];
 let closed=false,renewTimer,actionTimer,refreshing=false,lastCount=0,lastLease=null,controlOffset=0;
 const agents=()=>ctx.get('agents')?.list?.()??[],running=()=>agents().filter(x=>x.status==='running'),activeCount=()=>running().length;
 const safe=task=>Promise.resolve(task).catch(()=>onError('NATIVE_UNAVAILABLE'));
 const seed=session=>{if(!ordinary(session)||seeded.has(session))return;seeded.add(session);void safe(notifier.seedSession(session,{running:ctx.get('agents')?.get?.(session.id)?.status==='running'}));};
 const remember=value=>{actions.push(value);if(actions.length>32)actions.shift();};
 async function overlay(){
  if(!controlCall||closed||!activeCount())return;
  const candidates=running().filter(a=>ordinary(a.session));if(!candidates.length)return;
  const preferred=lastLease&&candidates.find(a=>a.session.id===lastLease.owner),selected=preferred??candidates[controlOffset++%candidates.length];
  try{const value=await controlCall('status',{owner:selected.session.id}),grant=value?.grant;if(!grant||grant.owner!==selected.session.id||!Number.isSafeInteger(grant.epoch)||grant.epoch<0)return;
   if(closed||!activeCount()||ctx.get('agents')?.get?.(selected.session.id)?.status!=='running')return;lastLease={owner:grant.owner,epoch:grant.epoch,observedAt:now()};await nativeCall('overlay.update',{owner:grant.owner,epoch:grant.epoch,status:'任务运行中'});
  }catch{onError('NATIVE_UNAVAILABLE');}
 }
 async function drain(){
  if(closed||refreshing||!activeCount())return;refreshing=true;
  try{
   await overlay();if(closed||!activeCount())return;const value=await nativeCall('actions.drain',{});if(closed)return;
   for(const item of (Array.isArray(value?.items)?value.items:[]).slice(0,64)){
    if(item.action==='background-network'){remember({action:item.action,blocked:item.blocked===true,at:now()});continue;}
    if(!['pause','resume','stop','interject'].includes(item.action)||!lastLease||item.owner!==lastLease.owner||item.epoch!==lastLease.epoch||!Number.isFinite(item.intentAt)||Math.abs(now()-item.intentAt)>15000)continue;
    const agent=ctx.get('agents')?.get?.(item.owner);if(!agent||!ordinary(agent.session)||agent.session.id!==item.owner)continue;
    // Native has already performed its phone-control gate. Never convert pause to a model retry.
    if(item.action==='stop')ctx.get('sessionController')?.cancel?.({sessionId:item.owner});
    remember({action:item.action,sessionId:item.owner,phoneOperationsPaused:item.action==='pause',at:now()});
    // Interject navigation was already dispatched by Native FeatureNavigation; no duplicate open/send.
   }
  }catch{onError('NATIVE_UNAVAILABLE');}finally{refreshing=false;if(!closed&&activeCount())actionTimer=setTimeout(drain,actionMs);actionTimer?.unref?.();}
 }
 const update=()=>{
  if(closed)return;const count=activeCount();clearTimeout(renewTimer);renewTimer=undefined;
  if(count!==lastCount||count>0){lastCount=count;void safe(nativeCall('background.update',{activeTasks:Math.min(512,count)}));}
  if(count>0){renewTimer=setTimeout(update,Math.min(renewMs,90000));renewTimer.unref?.();if(!actionTimer&&!refreshing)void drain();}
  else{clearTimeout(actionTimer);actionTimer=undefined;lastLease=null;void safe(nativeCall('overlay.hide',{}));}
 };
 const on=(name,handler)=>{const dispose=ctx.on(name,handler);if(typeof dispose==='function')disposers.push(dispose);};
 on('session/created',session=>{seed(session);update();});
 on('session/event',(session,event)=>{if(!ordinary(session))return;if(!seeded.has(session)){seeded.add(session);void safe(notifier.seed({sessionId:session.id,cursor:Math.max(-1,event.seq-1),active:ctx.get('agents')?.get?.(session.id)?.status==='running'}));}void safe(notifier.observeEvent({sessionId:session.id,event}));});
 const status=(id,active)=>{const session=ctx.get('sessions')?.get?.(id);if(ordinary(session)){seed(session);notifier.setRunning({sessionId:id,running:active===true});}update();};
 on('api-session/status',status);on('agent/status',({agent,status:phase})=>status(agent.id,phase==='running'));on('agent/disposed',()=>update());on('session/disposed',()=>update());
 for(const session of ctx.get('sessions')?.list?.()??[])seed(session);update();
 return {
  notifier,observe:value=>notifier.observeProjected(value),visibility:value=>notifier.setVisibility(value),
  configure(value){if(!value||Object.keys(value).some(k=>!prefsKeys.has(k)||typeof value[k]!=='boolean'))throw Error('通知偏好无效');const next={...notifier.status().preferences,...value};writePreferences(file,next);return notifier.configure(value);},
  status:()=>({available:true,...notifier.status(),activeTasks:activeCount(),overlayLeaseObserved:!!lastLease,actions:actions.slice(-8),leaseRenewScheduled:renewTimer!==undefined}),
  async close(){if(closed)return;closed=true;clearTimeout(renewTimer);clearTimeout(actionTimer);for(const off of disposers.splice(0))off();await notifier.close();await safe(nativeCall('background.update',{activeTasks:0}));await safe(nativeCall('overlay.hide',{}));},
 };
}
