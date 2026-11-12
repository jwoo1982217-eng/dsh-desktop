window.__ModuleLoader__.load({id:'dsh-phone-features',factory:require=>{
 const React=require('react'),{MenuItemButton}=require('@deepseek-ai/dsh-client-ui-primitives'),inject=['slots'];
 function apply(ctx){
  let active=true;const disposers=new Set(),api=window.__dshPhoneFeatures??={},previous=api.openSession,marker={ready:true};api.workbench=marker;
  const panel=()=>React.createElement('iframe',{src:'/phone-features',title:'DSH增强功能',style:{width:'100%',height:'calc(100dvh - 110px)',minHeight:520,border:0}});
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'dsh-phone-features',order:19,label:'增强功能'},panel));
  const sourceScope=()=>({origin:location.origin,remote:!!window.__dshPeerRemote,source:typeof window.__dshPhoneFeatureSource==='string'?window.__dshPhoneFeatureSource:null,generation:ctx.get('connection')?.generation?.getSnapshot?.()?.id??null});
  const sameScope=(a,b)=>a.origin===b.origin&&a.remote===b.remote&&a.source===b.source&&a.generation===b.generation;
  function ShareReplayMenuItem({sessionId,useMenuOpenState}){
   const [,setMenuOpen]=useMenuOpenState(),scope=sourceScope();
   if(typeof sessionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(sessionId)||sessionId.startsWith('qq-')||sessionId.startsWith('cloud-'))return null;
   return React.createElement(MenuItemButton,{onSelect:()=>{setMenuOpen(false);if(!active||!sameScope(scope,sourceScope()))return;const url=new URL('/phone-features/conversation/',scope.origin);url.searchParams.set('sessionId',sessionId);location.assign(url.href);}},'分享 / 离线回放');
  }
  ctx.slots.inject('sidebar.workspaces.session.menu.item',()=>ctx.slots.register({name:'sidebar.workspaces.session.menu.item',id:'dsh-phone-features-share-replay',order:350},ShareReplayMenuItem));
  const mapping={'input-capsule':'conversation.input.left',status:'conversation.composer.dock',panel:'conversation.session.header.utilities','tool-card':'conversation.chat.turnTail','message-action':'conversation.chat.assistant-actions'};
  for(const [slot,name]of Object.entries(mapping)){
   function Seat({featureContext,messageId,seq}){
    const ref=React.useRef(null),sessionId=featureContext?.sessionId;
    React.useEffect(()=>{
     let stopped=false,adapter;const node=ref.current;if(!node||typeof sessionId!=='string')return;
     const context=()=>{if(slot!=='message-action')return {sessionId};const row=node.closest('[data-conversation-message-seq]'),owner=row?.closest('[data-conversation-session]'),value=Number(row?.dataset.conversationMessageSeq);return row&&owner?.dataset.conversationSession===sessionId&&Number.isSafeInteger(value)&&value>=0?{sessionId,messageSeq:value}:{sessionId};};
     if(slot==='message-action'){
      const row=node.closest('[data-conversation-message-seq]'),owner=row?.closest('[data-conversation-session]'),seq=Number(row?.dataset.conversationMessageSeq);
      if(!row||owner?.dataset.conversationSession!==sessionId||!Number.isSafeInteger(seq)||seq<0)return;
     }
     const dispose=()=>{stopped=true;adapter?.dispose();disposers.delete(dispose);};disposers.add(dispose);
     void import('/phone-features/declarative/host-adapter.mjs').then(({installWebContributionTargets})=>{
      if(stopped||!active||!node.isConnected)return;
      adapter=installWebContributionTargets({document,window,targets:{[slot]:node},context});return adapter.refresh();
     }).catch(()=>{});
     return dispose;
    },[sessionId,messageId,seq]);
    return React.createElement('span',{ref,'data-dsh-feature-seat':slot});
   }
   ctx.slots.inject(name,()=>ctx.slots.register({name,id:'dsh-phone-features-'+slot,order:90,inject:sessionId=>({featureContext:{sessionId}})},Seat));
  }
  const open=target=>{
   if(!active||!target||typeof target.sessionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(target.sessionId)||(target.remote===true)!==!!window.__dshPeerRemote||target.source&&target.source!==(target.remote?'peer':'phone')&&target.source!==window.__dshPhoneFeatureSource)return false;
   const workspace=ctx.get('uiWorkspace');if(typeof workspace?.openSession!=='function')return false;
   try{workspace.openSession(target.sessionId);}catch{return false;}
   if(target.focusComposer){
    let timer;const observer=new MutationObserver(focus),dispose=()=>{observer.disconnect();clearTimeout(timer);disposers.delete(dispose);};
    function focus(){if(!active){dispose();return;}const roots=[...document.querySelectorAll('[data-conversation-session]')].filter(x=>x.dataset.conversationSession===target.sessionId&&x.getClientRects().length),input=roots.flatMap(x=>[...x.querySelectorAll('textarea,[contenteditable=true][role=textbox]')]).find(x=>x.getClientRects().length);if(input){input.focus();dispose();}}
    disposers.add(dispose);timer=setTimeout(dispose,5000);observer.observe(document.body,{childList:true,subtree:true});focus();
   }
   return true;
  };
  api.openSession=open;try{const pending=JSON.parse(sessionStorage.getItem('dsh-phone-features/navigation')??'null');if(pending&&open(pending))sessionStorage.removeItem('dsh-phone-features/navigation');}catch{}
  ctx.effect(()=>()=>{active=false;for(const dispose of [...disposers])dispose();if(api.openSession===open)api.openSession=previous;if(api.workbench===marker)delete api.workbench;});
 }
 return {inject,apply};
}});
