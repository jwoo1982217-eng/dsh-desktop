import {MAX_REPLAY_BYTES,ReplayController} from './model.mjs';

const $=id=>document.getElementById(id),names={user:'我',assistant:'AI',tool:'工具',system:'系统'},types={text:'正文',reasoning:'思考',tool:'工具记录'};
const state={rows:[],selected:new Set(),revision:null,sessionId:null,epoch:0,listEpoch:0,player:null};
const element=(tag,text)=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=text;return item;};
function status(id,text,error=false){$(id).textContent=text;$(id).classList.toggle('error',error);}
async function rpc(payload){const response=await fetch('/phone-features/conversation/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),credentials:'same-origin'});let result;try{result=await response.json();}catch{throw Error('请求未完成（'+response.status+'）');}if(!response.ok||!result.ok)throw Error((typeof result.error==='string'?result.error:result.error?.message)??'请求未完成（'+response.status+'）');return result.value;}
function count(){$('selection-count').textContent='已选 '+state.selected.size+' 条';}
function render(){
 const fragment=document.createDocumentFragment();$('range-from').replaceChildren();$('range-to').replaceChildren();
 for(const row of state.rows){
  const label=element('label'),box=element('input'),text=element('span',row.preview||'（无文字）'),head=element('small','#'+row.seq+' · '+(names[row.role]??row.role)+' · '+row.types.map(x=>types[x]).join(' / '));
  label.className='message-row';box.type='checkbox';box.checked=state.selected.has(row.seq);box.setAttribute('aria-label','选择消息 '+row.seq);box.addEventListener('change',()=>{box.checked?state.selected.add(row.seq):state.selected.delete(row.seq);count();});text.prepend(head);label.append(box,text);fragment.append(label);
  for(const id of ['range-from','range-to']){const option=element('option','#'+row.seq);option.value=row.seq;$(id).append(option);}
 }
 $('messages').replaceChildren(fragment);if(state.rows.length)$('range-to').value=state.rows.at(-1).seq;count();
}
async function loadMessages(id){
 const epoch=++state.epoch;state.listEpoch++;state.sessionId=id;state.rows=[];state.selected.clear();state.revision=null;render();status('status','正在读取消息…');
 let data;try{data=await rpc({action:'messages',sessionId:id});}catch(error){if(epoch!==state.epoch)return;throw error;}if(epoch!==state.epoch)return;state.rows=data.items;state.revision=data.revision;const params=new URL(location.href).searchParams,scoped=params.get('sessionId')===id&&params.has('messageSeq'),seq=Number(params.get('messageSeq'));state.selected=scoped?new Set(Number.isSafeInteger(seq)&&state.rows.some(x=>x.seq===seq)?[seq]:[]):new Set(state.rows.map(x=>x.seq));render();status('status',scoped&&!state.selected.size?'消息范围已变化，请重新选择消息。':state.rows.length+' 条消息。导出前可选择范围和内容。');
}
async function loadSessions(){
 status('status','正在读取会话…');const listEpoch=++state.listEpoch,scope=state.sessionId,previous=scope??new URL(location.href).searchParams.get('sessionId'),data=await rpc({action:'sessions'});if(listEpoch!==state.listEpoch||state.sessionId!==scope)return;$('sessions').replaceChildren();
 for(const row of data.items){const option=element('option',row.title+(row.running?' · 进行中':''));option.value=row.id;$('sessions').append(option);}
 if(previous&&!data.items.some(x=>x.id===previous)){state.epoch++;state.sessionId=null;state.rows=[];state.selected.clear();state.revision=null;$('sessions').selectedIndex=-1;render();status('status','该会话已不在当前主机或已删除，请重新选择；未读取其他会话。',true);return;}
 if(!data.items.length){status('status','还没有可分享的会话');state.rows=[];state.selected.clear();state.revision=null;render();return;}
 if(data.items.some(x=>x.id===previous))$('sessions').value=previous;await loadMessages($('sessions').value);
}
function action(button,fn,errorTarget='status'){
 button.addEventListener('click',async()=>{if(button.disabled)return;button.disabled=true;try{await fn();}catch(error){status(errorTarget,error.message||'操作未完成',true);}finally{button.disabled=false;}});
}
action($('reload'),loadSessions);$('sessions').addEventListener('change',()=>void loadMessages($('sessions').value).catch(error=>status('status',error.message,true)));
action($('select-all'),()=>{state.selected=new Set(state.rows.map(x=>x.seq));render();});action($('clear'),()=>{state.selected.clear();render();});
action($('range-select'),()=>{const [a,b]=[Number($('range-from').value),Number($('range-to').value)].sort((x,y)=>x-y);state.selected=new Set(state.rows.filter(x=>x.seq>=a&&x.seq<=b).map(x=>x.seq));render();});
for(const button of document.querySelectorAll('[data-export]'))action(button,async()=>{
 if(!state.revision||!state.selected.size)throw Error('请先选择消息');
 const epoch=state.epoch,sessionId=state.sessionId;let data;try{data=await rpc({action:'export',sessionId,expectedRevision:state.revision,selected:[...state.selected],includeText:$('include-text').checked,includeReasoning:$('include-reasoning').checked,includeTools:$('include-tools').checked,format:button.dataset.export});}catch(error){if(epoch!==state.epoch||sessionId!==state.sessionId)return;throw error;}if(epoch!==state.epoch||sessionId!==state.sessionId)return;
 const link=element('a','下载 '+data.filename+'（'+Math.ceil(data.bytes/1024)+' KiB）');link.href='/phone-features/conversation/download/'+encodeURIComponent(data.downloadToken);link.download=data.filename;$('download').replaceChildren(link);link.click();status('status','已生成 '+data.messages+' 条消息的脱敏文件；链接两分钟内有效。');
});

function showReplay(doc){
 state.player?.dispose();$('replay').hidden=false;$('replay-name').textContent=doc.title;$('replay-messages').replaceChildren();$('speed').value='1';$('progress').max=doc.messages.length;let shown=0;
 state.player=new ReplayController(doc,{onChange:current=>{
  if(current.position<shown){$('replay-messages').replaceChildren();shown=0;}
  while(shown<current.position){const row=doc.messages[shown++],article=element('article'),heading=element('h3',(names[row.role]??row.role)+' · #'+row.seq);article.append(heading);for(const block of row.blocks)article.append(element('small',types[block.type]),element('pre',block.text));$('replay-messages').append(article);}
  $('counter').textContent=current.position+' / '+current.total;$('progress').value=current.position;$('play').textContent=current.playing?'暂停':'播放';
 }});state.player.seek(0);status('import-status','已打开只读回放，共 '+doc.messages.length+' 条消息。');
}
async function openText(text){state.player?.pause();const data=await rpc({action:'import',text});showReplay(data.document);}
action($('import-button'),()=>openText($('import-text').value),'import-status');
$('import-file').addEventListener('change',async()=>{const file=$('import-file').files[0];if(!file)return;try{if(file.size>MAX_REPLAY_BYTES)throw Error('回放文件最多 8 MiB');await openText(await file.text());}catch(error){status('import-status',error.message,true);}finally{$('import-file').value='';}});
action($('play'),()=>{if(!state.player)return;state.player.state().playing?state.player.pause():state.player.play();},'import-status');
action($('next'),()=>{if(state.player)state.player.seek(Math.min(state.player.document.messages.length,state.player.state().position+1));},'import-status');
action($('show-all'),()=>state.player?.seek(state.player.document.messages.length),'import-status');
$('speed').addEventListener('change',()=>state.player?.setSpeed(Number($('speed').value)));$('progress').addEventListener('input',()=>state.player?.seek(Number($('progress').value)));
document.addEventListener('visibilitychange',()=>{if(document.hidden)state.player?.pause();});window.addEventListener('pagehide',()=>state.player?.dispose());
void loadSessions().catch(error=>status('status',error.message,true));
