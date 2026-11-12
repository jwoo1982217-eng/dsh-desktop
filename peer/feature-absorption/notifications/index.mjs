import {createSessionFrameProjector} from './projection.mjs';
export {classifySessionEvent,createSessionFrameProjector} from './projection.mjs';
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const cursor=value=>Number.isSafeInteger(value)&&value>= -1&&value<Number.MAX_SAFE_INTEGER;
const kinds=new Set(['completed','failed','stopped','approval','question']);

/** Metadata-only notification adapter. Parent owns event hooks and any preference persistence. */
export function createSessionNotifications({nativeCall,now=Date.now,attentionDelayMs=600,renewMs=60000,preferences={},manageBackground=true,isAppForeground}={}){
 if(typeof nativeCall!=='function')throw Error('A native call adapter is required');
 if(!preferences||typeof preferences!=='object'||Object.keys(preferences).some(k=>!['enabled',...kinds].includes(k)||typeof preferences[k]!=='boolean'))throw Error('Invalid notification preferences');
 const delay=Number.isFinite(attentionDelayMs)?Math.max(0,Math.min(attentionDelayMs,2000)):600;
 const renewal=Number.isFinite(renewMs)?Math.max(10,Math.min(renewMs,90000)):60000;
 const states=new Map(),pending=new Set();let closed=false,renewTimer,backgroundQueue=Promise.resolve(),backgroundRunning=false,backgroundDirty=false,viewed=null;
 let prefs={enabled:true,completed:true,failed:true,stopped:true,approval:true,question:true,...preferences};
 const identity=value=>{const source=value.source??(value.remote?'peer':'phone');if(!validId(source)||!validId(value.sessionId))throw Error('Invalid notification scope');return {source,sessionId:value.sessionId,remote:value.remote===true,key:source+'/'+value.sessionId};};
 const activeCount=()=>[...states.values()].filter(x=>x.active).length;
 const queueBackground=()=>{
  backgroundDirty=true;if(backgroundRunning)return;backgroundRunning=true;
  backgroundQueue=(async()=>{while(backgroundDirty&&!closed){backgroundDirty=false;try{await nativeCall('background.update',{activeTasks:activeCount()});}catch{}}})().finally(()=>{backgroundRunning=false;if(backgroundDirty&&!closed)queueBackground();});
 };
 const background=()=>{
  clearTimeout(renewTimer);renewTimer=undefined;if(closed||!manageBackground)return;
  const activeTasks=activeCount();
  queueBackground();
  if(activeTasks>0){renewTimer=setTimeout(background,renewal);renewTimer.unref?.();}
 };
 const cancelAttention=state=>{for(const [seq,item]of state.attention){clearTimeout(item.timer);state.attention.delete(seq);item.resolve({delivered:false,reason:'settled'});}};
 const get=value=>{
  const scope=identity(value);let state=states.get(scope.key);
  if(!state){
   if(states.size>=256){const removable=[...states].find(([,x])=>!x.active&&!x.attention.size);if(!removable)throw Error('Notification scopes are full');states.delete(removable[0]);}
   state={...scope,cursor:-1,seeded:false,nativeSeeded:false,active:false,attention:new Map(),projector:createSessionFrameProjector(),queue:Promise.resolve(),updatedAt:now()};states.set(scope.key,state);
  }
  return state;
 };
 const queued=(state,job)=>{if(pending.size>=512)return Promise.resolve({delivered:false,reason:'busy'});const promise=state.queue.catch(()=>{}).then(()=>closed?{delivered:false,reason:'closed'}:job());state.queue=promise;pending.add(promise);promise.finally(()=>pending.delete(promise)).catch(()=>{});return promise;};
 const ensureSeed=async(state,through)=>{
  if(state.nativeSeeded)return;
  await nativeCall('session.seed',{sessionId:state.sessionId,source:state.source,remote:state.remote,cursor:through+1});state.nativeSeeded=true;
 };
 const deliver=(state,meta,before)=>queued(state,async()=>{
  if(!prefs.enabled||prefs[meta.kind]!==true)return {delivered:false,reason:'disabled'};
  if(viewed?.foreground&&viewed.key===state.key&&(!isAppForeground||await isAppForeground()))return {delivered:false,reason:'viewed'};
  try{await ensureSeed(state,before);return await nativeCall('session.event',{sessionId:state.sessionId,source:state.source,remote:state.remote,id:'sdk-'+meta.seq+'-'+meta.kind,sequence:meta.seq+1,kind:meta.kind});}
  catch{state.nativeSeeded=false;return {delivered:false,reason:'native-unavailable'};}
 });
 const seed=async(value,{resetProjection=true}={})=>{
  if(closed)return {seeded:false,reason:'closed'};if(!cursor(value.cursor))throw Error('Invalid notification cursor');const state=get(value),was=state.active;
  if(value.cursor<state.cursor)return {seeded:false,reason:'stale-snapshot'};
  state.cursor=value.cursor;state.seeded=true;state.updatedAt=now();cancelAttention(state);if(resetProjection)state.projector.reset(state.cursor);
  if(typeof value.active==='boolean')state.active=value.active;if(was!==state.active)background();
  const through=state.cursor;
  return queued(state,async()=>{try{await nativeCall('session.seed',{sessionId:state.sessionId,source:state.source,remote:state.remote,cursor:through+1});state.nativeSeeded=true;return {seeded:true};}catch{state.nativeSeeded=false;return {seeded:false,reason:'native-unavailable'};}});
 };
 const observeProjected=value=>{
  if(closed)return Promise.resolve({delivered:false,reason:'closed'});const state=get(value),input=value.frame;
  if(input?.type==='snapshot')return seed({...value,cursor:input.cursor,active:input.active},{resetProjection:false});
  if(input?.type!=='event'||!cursor(input.seq)||input.seq<0||input.kind!==undefined&&!kinds.has(input.kind)||input.settles!==undefined&&(!Array.isArray(input.settles)||input.settles.length>128||input.settles.some(x=>!cursor(x)||x<0))||input.active!==undefined&&typeof input.active!=='boolean'||input.clearAttention!==undefined&&typeof input.clearAttention!=='boolean')return Promise.resolve({delivered:false,reason:'invalid-event'});
  const meta={type:'event',seq:input.seq,...(input.kind===undefined?{}:{kind:input.kind}),...(input.active===undefined?{}:{active:input.active}),...(input.settles===undefined?{}:{settles:[...input.settles]}),...(input.clearAttention===undefined?{}:{clearAttention:input.clearAttention})};
  if(!state.seeded)return seed({...value,cursor:meta.seq,active:meta.active}).then(()=>({delivered:false,reason:'unseeded'}));
  if(meta.seq<=state.cursor)return Promise.resolve({delivered:false,reason:'stale'});
  const before=state.cursor;state.cursor=meta.seq;state.updatedAt=now();
  if(meta.clearAttention)cancelAttention(state);
  for(const seq of meta.settles??[]){const item=state.attention.get(seq);if(item){clearTimeout(item.timer);state.attention.delete(seq);item.resolve({delivered:false,reason:'settled'});}}
  if(typeof meta.active==='boolean'&&state.active!==meta.active){state.active=meta.active;background();}
  if(!meta.kind)return Promise.resolve({delivered:false,reason:'not-notifiable'});
  if(meta.kind==='approval'||meta.kind==='question'){
   if(pending.size>=512)return Promise.resolve({delivered:false,reason:'busy'});
   const promise=new Promise(resolve=>{
    const item={resolve,timer:setTimeout(()=>{state.attention.delete(meta.seq);void deliver(state,meta,before).then(resolve);},delay)};
    state.attention.set(meta.seq,item);
   });pending.add(promise);promise.finally(()=>pending.delete(promise)).catch(()=>{});return promise;
  }
  return deliver(state,meta,before);
 };
 return {
  seed,seedSession(session,options={}){if(!session||!Number.isSafeInteger(session.seq)||session.seq<0)throw Error('Invalid Session offset');return seed({...options,sessionId:session.id,cursor:session.seq-1,active:typeof options.running==='boolean'?options.running:options.active});},
  observeProjected,
  observeEvent(value){if(closed)return Promise.resolve({delivered:false,reason:'closed'});const state=get(value);if(cursor(value.event?.seq)&&value.event.seq<=state.cursor)return Promise.resolve({delivered:false,reason:'stale'});const projected=state.projector.observeEvent(value.event);return projected?observeProjected({...value,frame:projected}):Promise.resolve({delivered:false,reason:'not-notifiable'});},
  observeFrame(value){if(closed)return Promise.resolve({delivered:false,reason:'closed'});const state=get(value);if(value.frame?.type==='event'&&cursor(value.frame.event?.seq)&&value.frame.event.seq<=state.cursor)return Promise.resolve({delivered:false,reason:'stale'});const projected=state.projector.observeFrame(value.frame);return projected?observeProjected({...value,frame:projected}):Promise.resolve({delivered:false,reason:'not-notifiable'});},
  setRunning(value){if(closed)return;const state=get(value);if(typeof value.running!=='boolean')throw Error('Invalid activity state');if(state.active!==value.running){state.active=value.running;background();}},
  setVisibility(value){if(value==null){viewed=null;return;}const scoped=identity(value);viewed={key:scoped.key,foreground:value.foreground===true};},
  configure(value){if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['enabled',...kinds].includes(k)||typeof value[k]!=='boolean'))throw Error('Invalid notification preferences');prefs={...prefs,...value};return {...prefs};},
  status(){return {preferences:{...prefs},sessions:states.size,activeTasks:activeCount(),pending:pending.size,renewScheduled:renewTimer!==undefined,closed};},
  async flush(){while(pending.size)await Promise.all([...pending]);do{await backgroundQueue;}while(backgroundRunning);},
  async close(){if(closed)return;closed=true;clearTimeout(renewTimer);renewTimer=undefined;for(const state of states.values())cancelAttention(state);const hadActive=manageBackground&&activeCount()>0;for(const state of states.values())state.active=false;await backgroundQueue;if(hadActive)await nativeCall('background.update',{activeTasks:0}).catch(()=>{});await Promise.all([...pending]);states.clear();},
 };
}
