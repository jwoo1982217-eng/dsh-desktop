import {focusSetting} from './focus.js';
const $=id=>document.getElementById(id);let searchAbort,focusAbort,resizeObserver,selected,sequence=0;
function stopFocus(){focusAbort?.abort();resizeObserver?.disconnect();resizeObserver=undefined;}
function showItems(items){
 $('results').replaceChildren();
 for(const item of items){const li=document.createElement('li'),link=document.createElement('a'),name=document.createElement('strong'),path=document.createElement('small');link.href=item.href+(item.href.includes('#')?'':'#'+(item.anchor??''));name.textContent=item.title;path.textContent=item.group+' · '+item.english;link.append(name,path);li.append(link);$('results').append(li);link.addEventListener('click',event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();open(item);});}
}
async function search(){
 const id=++sequence;searchAbort?.abort();searchAbort=new AbortController();const query=$('query').value.trim();$('status').textContent='正在查找…';
 try{const response=await fetch('/phone-features/settings/search?q='+encodeURIComponent(query),{cache:'no-store',signal:searchAbort.signal});if(!response.ok)throw Error('设置索引暂时不可用');const result=await response.json();if(id!==sequence)return;const items=result.items??result.value?.items??[];showItems(items);$('status').textContent=items.length?'找到 '+items.length+' 项设置。':query?'没有匹配的设置，试试中文、英文或旧名称。':'输入名称开始查找。';}catch(error){if(error.name!=='AbortError'&&id===sequence)$('status').textContent=error.message;}
}
function open(item){stopFocus();selected=item;$('setting-panel').hidden=false;$('setting-title').textContent=item.title;$('open-page').href=item.href;$('focus-status').textContent='正在打开原设置…';$('setting-frame').src=item.href;$('setting-panel').scrollIntoView({block:'start'});}
$('setting-frame').addEventListener('load',async()=>{
 if(!selected)return;stopFocus();const item=selected;focusAbort=new AbortController();
 try{
  const frame=$('setting-frame'),page=frame.contentDocument;if(!page||frame.contentWindow.location.origin!==location.origin)throw Error('此页面不能在这里定位，请单独打开。');
  const fit=()=>{const natural=Math.max(page.body?.scrollHeight??0,page.documentElement.scrollHeight);frame.style.height=Math.max(420,Math.min(natural+30,24000))+'px';};fit();if(typeof ResizeObserver==='function'){resizeObserver=new ResizeObserver(fit);if(page.body)resizeObserver.observe(page.body);}
   const result=item.anchor?await focusSetting(page,item.anchor,{signal:focusAbort.signal}):{found:true};if(item!==selected||result.reason==='cancelled')return;$('focus-status').textContent=result.found?(item.anchor?'已定位并高亮原设置。':'已打开原设置页面。'):'页面已打开，但这项设置当前不可见或锚点已变化。可单独打开查看。';
 }catch(error){$('focus-status').textContent=error.message;}
});
$('search-form').addEventListener('submit',event=>{event.preventDefault();void search();});let typing;$('query').addEventListener('input',()=>{clearTimeout(typing);typing=setTimeout(search,180);});
$('close').onclick=()=>{selected=undefined;stopFocus();$('setting-panel').hidden=true;$('setting-frame').src='about:blank';};
window.addEventListener('pagehide',()=>{clearTimeout(typing);searchAbort?.abort();stopFocus();},{once:true});
void search();
