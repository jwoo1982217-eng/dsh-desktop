import {installContributionSurfaces} from './renderer.mjs';
const features=Object.freeze({conversation:'/phone-features/conversation/',declarative:'/phone-features/declarative/',ssh:'/phone-features/ssh/'});

/** Explicit clicks may navigate only the three installed feature pages; no arbitrary URLs or commands. */
export function applyFeatureResult(result,{location=globalThis.location}={}){
 const effects=result?.value?.effects;if(effects===undefined)return false;
 if(!Array.isArray(effects)||effects.length!==1)throw Error('插件返回不支持的界面效果');
 const effect=effects[0];if(effect?.type!=='open-feature'||!Object.hasOwn(features,effect.feature))throw Error('插件不能打开该页面');
 const query=new URLSearchParams();if(effect.sessionId!==undefined){if(typeof effect.sessionId!=='string'||effect.sessionId.length>256||/[\0-\x1f]/.test(effect.sessionId))throw Error('会话范围无效');query.set('sessionId',effect.sessionId);}
 if(effect.messageSeq!==undefined){if(!Number.isSafeInteger(effect.messageSeq)||effect.messageSeq<0)throw Error('消息范围无效');query.set('messageSeq',effect.messageSeq);}
 location.assign(features[effect.feature]+(query.size?'?'+query:''));return true;
}

/** Parent supplies authoritative host targets/context. No React internals or historical composer scan. */
export function installWebContributionTargets({document=globalThis.document,window=globalThis.window,targets,context,onResult}={}){
 if(!document||!window||!targets)throw Error('缺少真实插件位置连接器');
 const wrappers=new Map(),loadController=new AbortController();let closed=false,pending=null;
 const rpc=async(payload,{signal}={})=>{const response=await window.fetch('/phone-features/declarative/manage',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal});const data=await response.json();if(!response.ok||!data.ok)throw Error((typeof data.error==='string'?data.error:data.error?.message)??'插件界面请求失败');return data.value;};
 const adapted=Object.fromEntries(Object.entries(targets).map(([slot,target])=>[slot,current=>{
  const parent=typeof target==='function'?target(current):target;if(!parent?.isConnected)return null;
  let row=wrappers.get(slot);if(row?.parent!==parent||!row?.node.isConnected){row?.node.remove();const node=document.createElement('div');node.className='dsh-feature-surface';node.dataset.featureSlot=slot;parent.append(node);row={parent,node};wrappers.set(slot,row);}return row.node;
 }]));
 const style=document.createElement('link');style.rel='stylesheet';style.href='/phone-features/declarative/surface.css';document.head.append(style);
 const currentScope=()=>{const value=context?.()??{};return {sessionId:value.sessionId,messageSeq:value.messageSeq};};
 const surfaces=installContributionSurfaces({document,targets:adapted,context:currentScope,load:()=>rpc({action:'list'},{signal:loadController.signal}),sendEvent:(payload,options)=>{const current=currentScope();if(payload.context?.sessionId!==current.sessionId||payload.context?.messageSeq!==current.messageSeq){surfaces.syncContext();throw Error('会话或消息范围已变化，请重新操作。');}return rpc(payload,options);},onResult:(result,details)=>{const current=currentScope();if(details.context?.sessionId!==current.sessionId||details.context?.messageSeq!==current.messageSeq)return;applyFeatureResult(result,{location:window.location});onResult?.(result,details);}});
 const refresh=()=>{if(closed)return Promise.resolve();if(pending)return pending;pending=surfaces.refresh().finally(()=>{pending=null;});return pending;};
 const focus=()=>{void refresh().catch(()=>{});};window.addEventListener('focus',focus);window.addEventListener('dsh-phone-features:changed',focus);
 const dispose=()=>{if(closed)return;closed=true;loadController.abort();surfaces.dispose();window.removeEventListener('focus',focus);window.removeEventListener('dsh-phone-features:changed',focus);window.removeEventListener('pagehide',dispose);for(const row of wrappers.values())row.node.remove();wrappers.clear();style.remove();};
 window.addEventListener('pagehide',dispose);return {refresh,syncContext:surfaces.syncContext,dispose};
}
