const fail=(ok,message)=>{if(!ok)throw Error(message);};
const element=(document,tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};

/** Declarative trees use DOM text nodes, never plugin HTML, script, CSS or URLs. */
export function mountContribution(document,container,item,{sendEvent,context={},onResult=()=>{}}={}){
 const root=element(document,'section'),title=element(document,'h3',item.title),status=element(document,'p');
 root.className='dsh-declarative-contribution';root.dataset.owner=item.owner;root.dataset.contribution=item.id;status.setAttribute('role','status');root.append(title);
 let disposed=false,nodes=0;const listeners=[],pending=new Set();
 const listen=(target,name,fn)=>{target.addEventListener(name,fn);listeners.push(()=>target.removeEventListener(name,fn));};
 async function invoke(node,value,button){
  if(disposed||button.disabled)return;button.disabled=true;status.textContent='正在处理…';
  const controller=new AbortController();pending.add(controller);
  try{
   fail(typeof sendEvent==='function'&&item.ready!==false,'插件暂未准备好');
   const uuid=globalThis.crypto?.randomUUID?.()??'event-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
   const result=await sendEvent({action:'event',owner:item.owner,id:item.id,revision:item.revision,nodeId:node.id,requestId:uuid,context,...(node.type==='input'?{value}:{})},{signal:controller.signal});
   if(disposed||controller.signal.aborted)return;status.textContent='操作已完成';try{onResult(result,{item,context});}catch{status.textContent='操作已完成，界面尚未更新，请刷新查看。';}
  }catch(error){if(!disposed&&!controller.signal.aborted)status.textContent=error.message||'操作未完成';}
  finally{pending.delete(controller);if(!disposed)button.disabled=item.ready===false;}
 }
 function render(node,depth=0){
  fail(node&&typeof node==='object'&&depth<=10&&++nodes<=300,'插件视图过大');
  if(['row','column','list'].includes(node.type)){
   fail(Array.isArray(node.children),'插件视图无效');const parent=element(document,node.type==='list'?'ul':'div');parent.className='dsh-declarative-'+node.type;
   for(const child of node.children){const view=render(child,depth+1);if(node.type==='list'){const li=element(document,'li');li.append(view);parent.append(li);}else parent.append(view);}return parent;
  }
  if(node.type==='text'||node.type==='code')return element(document,node.type==='code'?'pre':'p',String(node.text??''));
  if(node.type==='badge'){const badge=element(document,'span',String(node.text??''));badge.className='dsh-declarative-badge';return badge;}
  if(node.type==='progress'){
   const label=element(document,'label',String(node.label??'')),bar=element(document,'progress');bar.max=1;bar.value=Math.min(1,Math.max(0,Number(node.value)||0));label.append(bar);return label;
  }
  if(node.type==='button'){
   const button=element(document,'button',String(node.label??''));button.type='button';button.disabled=item.ready===false;listen(button,'click',()=>void invoke(node,undefined,button));return button;
  }
  if(node.type==='input'){
   const label=element(document,'label',String(node.label??'')),input=element(document,'input'),button=element(document,'button','提交');input.type='text';input.value=String(node.value??'');input.placeholder=String(node.placeholder??'');input.maxLength=Math.min(4096,Number(node.maxLength)||256);input.disabled=item.ready===false;button.type='button';button.disabled=item.ready===false;listen(button,'click',()=>void invoke(node,input.value,button));label.append(input,button);return label;
  }
  throw Error('不支持的插件视图');
 }
 try{root.append(render(item.view),status);}catch(error){status.textContent=error.message;root.append(status);}
 container.append(root);
 return {root,dispose(){if(disposed)return;disposed=true;for(const controller of pending)controller.abort();pending.clear();for(const stop of listeners)stop();root.remove();}};
}

/** Optional adapter mounts additive regions supplied by the existing UI, without replacing it. */
export function installContributionSurfaces({document,load,sendEvent,targets,context=()=>({}),onResult}={}){
 fail(document&&typeof load==='function'&&targets,'缺少插件界面连接器');
 const mounts=new Map();let items=[],closed=false,generation=0,queued=false;
 function reconcile(){
  if(closed)return;
  const currentContext=context()??{},scope=JSON.stringify({sessionId:currentContext.sessionId,messageSeq:currentContext.messageSeq});
  for(const item of items){
   const name=item.owner+'\0'+item.id,target=typeof targets[item.slot]==='function'?targets[item.slot](currentContext):targets[item.slot],old=mounts.get(name);
   if(old&&old.parent===target&&old.revision===item.revision&&old.scope===scope&&old.view.root.isConnected)continue;
   old?.view.dispose();mounts.delete(name);
   if(target?.isConnected){const view=mountContribution(document,target,item,{sendEvent,context:currentContext,onResult});mounts.set(name,{parent:target,revision:item.revision,scope,view});}
  }
 }
 const observer=typeof globalThis.MutationObserver==='function'?new MutationObserver(()=>{if(queued||closed)return;queued=true;queueMicrotask(()=>{queued=false;reconcile();});}):null;
 observer?.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-conversation-session','data-conversation-message-seq']});
 async function refresh(){
  const own=++generation,result=await load();if(closed||own!==generation)return;
  fail(Array.isArray(result.items)&&result.items.length<=200,'插件列表无效');items=result.items;
  const names=new Set(items.map(x=>x.owner+'\0'+x.id));for(const [name,row]of mounts)if(!names.has(name)){row.view.dispose();mounts.delete(name);}reconcile();
 }
 return {refresh,syncContext:reconcile,dispose(){if(closed)return;closed=true;generation++;observer?.disconnect();for(const row of mounts.values())row.view.dispose();mounts.clear();}};
}
