import {createHash,randomUUID} from 'node:crypto';

export const CONTRIBUTION_SLOTS=Object.freeze(['tool-card','input-capsule','message-action','status','panel']);
const encoder=new TextEncoder();
const idPattern=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ownerPattern=/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,100}$/;
function error(message){const value=Error(message);value.name='ContributionError';return value;}
const fail=(ok,message)=>{if(!ok)throw error(message);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const string=(value,max=4096)=>{fail(typeof value==='string'&&value.length<=max,'插件文字过长或无效');return value;};
const fields=(value,allowed)=>{fail(plain(value),'插件视图对象无效');for(const name of Object.keys(value))fail(allowed.includes(name),'插件视图含不支持的字段');};
const identifier=value=>{fail(typeof value==='string'&&idPattern.test(value),'插件标识无效');return value;};

function safeJson(value,depth=0,budget={nodes:0}){
 fail(depth<=8&&++budget.nodes<=256,'事件数据过大');
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='number'){fail(Number.isFinite(value),'事件数值无效');return value;}
 if(typeof value==='string')return string(value,4096);
 if(Array.isArray(value)){fail(value.length<=64,'事件数据过大');return value.map(x=>safeJson(x,depth+1,budget));}
 fail(plain(value),'事件数据不是普通 JSON');
 const result={};for(const key of Object.keys(value)){fail(!['__proto__','prototype','constructor'].includes(key)&&key.length<=64,'事件字段无效');result[key]=safeJson(value[key],depth+1,budget);}return result;
}

export function validateContribution(value){
 fields(value,['version','id','slot','title','view']);
 fail(value.version===1,'不支持的插件视图版本');identifier(value.id);fail(CONTRIBUTION_SLOTS.includes(value.slot),'插件位置无效');string(value.title,80);
 let count=0;const interactive=new Map();
 function visit(node,depth=0){
  fail(depth<=10,'插件视图层级过深');fail(++count<=300,'插件视图节点过多');fail(plain(node),'插件视图节点无效');
  const type=node.type;let result;
  if(type==='row'||type==='column'||type==='list'){
   fields(node,['type','children']);fail(Array.isArray(node.children)&&node.children.length<=100,'插件子项过多');result={type,children:node.children.map(x=>visit(x,depth+1))};
  }else if(type==='text'||type==='code'){
   fields(node,['type','text']);result={type,text:string(node.text,32768)};
  }else if(type==='badge'){
   fields(node,['type','text','tone']);const tone=node.tone??'info';fail(['info','success','warning','error'].includes(tone),'插件标记样式无效');result={type,text:string(node.text,120),tone};
  }else if(type==='progress'){
   fields(node,['type','value','label']);fail(Number.isFinite(node.value)&&node.value>=0&&node.value<=1,'插件进度无效');result={type,value:node.value,label:string(node.label??'',120)};
  }else if(type==='button'||type==='input'){
   fields(node,type==='button'?['type','id','label','event','payload']:['type','id','label','placeholder','value','maxLength','event','payload']);
   const id=identifier(node.id),event=identifier(node.event);fail(!interactive.has(id),'插件控件标识重复');result={type,id,label:string(node.label,80),event};
   if(node.payload!==undefined)result.payload=safeJson(node.payload);
   if(type==='input'){
    const maxLength=node.maxLength??256;fail(Number.isSafeInteger(maxLength)&&maxLength>0&&maxLength<=4096,'插件输入长度无效');result.maxLength=maxLength;result.placeholder=string(node.placeholder??'',120);result.value=string(node.value??'',maxLength);
   }
   interactive.set(id,result);
  }else throw error('不支持的插件视图类型');
  return result;
 }
 const view=visit(value.view),output={version:1,id:value.id,slot:value.slot,title:value.title,view};
 fail(encoder.encode(JSON.stringify(output)).length<=128*1024,'插件视图超过 128 KiB');return {value:output,interactive};
}

function contextOf(value){
 if(value===undefined)return {};
 fields(value,['sessionId','messageSeq']);const result={};
 if(value.sessionId!==undefined){fail(typeof value.sessionId==='string'&&value.sessionId.length>0&&value.sessionId.length<=256&&!/[\x00-\x1f]/.test(value.sessionId),'会话范围无效');result.sessionId=value.sessionId;}
 if(value.messageSeq!==undefined){fail(Number.isSafeInteger(value.messageSeq)&&value.messageSeq>=0,'消息范围无效');result.messageSeq=value.messageSeq;}
 return result;
}

/** Host plugins register trusted callbacks; the browser can list or invoke declared controls only. */
export function createContributionRegistry({onChange=()=>{},handlerTimeout=5000,maxContributions=200,maxOwners=64,maxViewBytes=2*1024*1024}={}){
 fail(Number.isInteger(handlerTimeout)&&handlerTimeout>0&&handlerTimeout<=30000,'插件超时设置无效');
 const entries=new Map();let closed=false,change=0;
 const key=(owner,id)=>owner+'\0'+id;
 const notify=()=>{change++;try{onChange({revision:change});}catch{}};
 const cancel=entry=>{entry.cancel?.('插件操作已取消');};
 function register(owner,contribution,handler){
  fail(!closed,'插件界面服务已关闭');fail(typeof owner==='string'&&ownerPattern.test(owner),'插件包名无效');
  const validated=validateContribution(contribution),name=key(owner,validated.value.id),old=entries.get(name);
  const size=encoder.encode(JSON.stringify(validated.value)).length;
  fail([...entries.values()].reduce((n,x)=>n+(x===old?0:x.size),0)+size<=maxViewBytes,'插件界面总大小超过上限');
  fail(old||entries.size<maxContributions,'插件界面数量超过上限');
  fail([...entries.values()].some(x=>x.owner===owner)||new Set([...entries.values()].map(x=>x.owner)).size<maxOwners,'插件数量超过上限');
  fail(handler===undefined||typeof handler==='function','插件处理器无效');
  const entry={...validated,owner,handler,size,revision:randomUUID(),requests:new Map()};
  if(old)cancel(old);entries.set(name,entry);notify();
  return {owner,id:entry.value.id,revision:entry.revision,dispose(){if(entries.get(name)===entry){cancel(entry);entries.delete(name);notify();}}};
 }
 function list(){fail(!closed,'插件界面服务已关闭');return {version:1,revision:change,items:[...entries.values()].map(entry=>({...entry.value,owner:entry.owner,revision:entry.revision,ready:entry.interactive.size===0||typeof entry.handler==='function'}))};}
 async function invoke(payload,signal){
  fail(!closed,'插件界面服务已关闭');fail(typeof payload.owner==='string'&&typeof payload.id==='string','插件标识无效');
  const entry=entries.get(key(payload.owner,payload.id));fail(entry&&entry.revision===payload.revision,'插件界面已变化，请刷新后重试');
  const node=entry.interactive.get(payload.nodeId);fail(node,'按钮或输入框已失效');fail(typeof entry.handler==='function','插件暂未准备好');
  fail(typeof payload.requestId==='string'&&/^[A-Za-z0-9_.-]{8,128}$/.test(payload.requestId),'操作编号无效');
  const scope=contextOf(payload.context);let value;
  if(node.type==='input')value=string(payload.value??'',node.maxLength);else fail(payload.value===undefined,'按钮不接受输入值');
  const signature=createHash('sha256').update(JSON.stringify({nodeId:node.id,value,scope})).digest('hex');
  if(entry.requests.has(payload.requestId)){const old=entry.requests.get(payload.requestId);fail(old.signature===signature,'操作编号重复且内容不一致');return old.task;}
  fail(!entry.active,'插件操作正在进行，请稍候');fail(!signal?.aborted,'插件操作已取消');
  const controller=new AbortController();let rejectCancel,cancelled=false;
  const cancellation=new Promise((_,reject)=>{rejectCancel=reject;});
  const abort=message=>{if(cancelled)return;cancelled=true;rejectCancel(error(message));controller.abort();};
  const onAbort=()=>abort('插件操作已取消');signal?.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>abort('插件操作超时'),handlerTimeout);timer.unref?.();
  entry.cancel=abort;
  const task=Promise.race([
   Promise.resolve().then(()=>entry.handler(Object.freeze({owner:entry.owner,id:entry.value.id,action:node.event,payload:node.payload===undefined?undefined:safeJson(node.payload),value,context:Object.freeze(scope),signal:controller.signal}))),
   cancellation,
  ]).then(result=>{
   fail(!closed&&!cancelled&&entries.get(key(entry.owner,entry.value.id))===entry,'插件操作已取消');
   const safe=result===undefined?null:safeJson(result);fail(encoder.encode(JSON.stringify(safe)).length<=16384,'插件返回内容过大');return {delivered:true,value:safe};
  }).catch(cause=>{throw cause?.name==='ContributionError'?cause:error('插件操作未完成');}).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(!controller.signal.aborted)controller.abort();if(entry.active===task){entry.active=null;entry.cancel=null;}});
  entry.active=task;entry.requests.set(payload.requestId,{signature,task});
  if(entry.requests.size>8)entry.requests.delete(entry.requests.keys().next().value);
  return task;
 }
 return {
  register,list,
  removeOwner(owner){let changed=false;for(const [name,entry]of entries)if(entry.owner===owner){cancel(entry);entries.delete(name);changed=true;}if(changed)notify();},
  async manage(payload,{signal}={}){fail(plain(payload),'插件请求无效');if(payload.action==='list')return list();if(payload.action==='event')return invoke(payload,signal);throw error('插件操作无效');},
  dispose(){if(closed)return;for(const entry of entries.values())cancel(entry);entries.clear();closed=true;},
 };
}
