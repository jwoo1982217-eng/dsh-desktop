(() => {
 if(window.__dshPhoneFeaturesBootstrap)return;window.__dshPhoneFeaturesBootstrap=true;const api=window.__dshPhoneFeatures??={};let last='',scheduled=false,stopped=false;
 const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
 if(!api.openSession)api.openSession=target=>{if(!target||!id(target.sessionId)||target.remote===true!==!!window.__dshPeerRemote)return false;try{sessionStorage.setItem('dsh-phone-features/navigation',JSON.stringify(target));if(location.pathname!=='/')location.assign('/');}catch{}return false;};
 const sync=()=>{scheduled=false;if(stopped)return;const root=[...document.querySelectorAll('[data-conversation-session]')].find(x=>x.getClientRects().length&&!x.parentElement?.closest('[data-conversation-session]')),sessionId=root?.dataset.conversationSession,foreground=!document.hidden;const stamp=(id(sessionId)?sessionId:'')+'/'+foreground;if(stamp===last)return;last=stamp;const value=id(sessionId)&&foreground?{sessionId,foreground:true}:{clear:true};void fetch('/phone-features/notifications/visibility',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}).catch(()=>{});};
 const schedule=()=>{if(!scheduled&&!stopped){scheduled=true;requestAnimationFrame(sync);}};
 const observer=new MutationObserver(schedule);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-conversation-session','hidden','aria-hidden']});document.addEventListener('visibilitychange',schedule);schedule();
 window.addEventListener('pagehide',()=>{stopped=true;observer.disconnect();document.removeEventListener('visibilitychange',schedule);},{once:true});
})();
