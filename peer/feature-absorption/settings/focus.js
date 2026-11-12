/** Wait for a real, visible row. This never changes its value or dispatches a change event. */
export function focusSetting(document,id,{signal,timeoutMs=5000}={}){
 if(!/^[A-Za-z][\w:.-]{0,99}$/.test(String(id??'')))return Promise.resolve({found:false,reason:'invalid-anchor'});
 return new Promise(resolve=>{
  const view=document.defaultView;let observer,timer,done=false;
  const finish=value=>{if(done)return;done=true;observer?.disconnect();clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(value);};
  const abort=()=>finish({found:false,reason:'cancelled'});
  const find=()=>{
   if(done)return;
   const target=document.getElementById(id);if(!target||target.closest('[hidden]'))return;
   const style=view?.getComputedStyle(target);if(style?.display==='none'||style?.visibility==='hidden')return;
   const row=target.closest('label')??target;
   if(!document.getElementById('dsh-setting-focus-style')){const sheet=document.createElement('link');sheet.id='dsh-setting-focus-style';sheet.rel='stylesheet';sheet.href='/phone-features/settings/focus.css';document.head.append(sheet);}
   for(const old of document.querySelectorAll('.dsh-setting-focus'))old.classList.remove('dsh-setting-focus');
   row.classList.add('dsh-setting-focus');row.scrollIntoView({block:'center',behavior:'auto'});
   finish({found:true,id});
  };
  if(signal?.aborted){abort();return;}
  signal?.addEventListener('abort',abort,{once:true});
  if(view?.MutationObserver){observer=new view.MutationObserver(find);observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','style','class']});}
  timer=setTimeout(()=>finish({found:false,reason:'missing-anchor'}),Math.max(50,Math.min(timeoutMs,10000)));find();
 });
}
