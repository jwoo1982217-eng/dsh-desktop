const $=id=>document.getElementById(id),number=v=>v===null||v===undefined?'—':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(v),ms=v=>v===null||v===undefined?'—':number(v/1000)+'s',percent=v=>v===null||v===undefined?'—':number(v*100)+'%';
let sessionId=new URLSearchParams(location.search).get('sessionId'),limit=200,revision=0,pluginBusy=false,sessionsLoaded=false;
const node=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};
function error(e){$('error').textContent=String(e.message||e);$('error').hidden=false;}
async function rpc(payload){const r=await fetch('/desktop-enhancements/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'manage',payload})});const j=await r.json();if(!r.ok||!j.result?.ok)throw Error(j.result?.error?.message||'读取失败，请重试');return j.result.value;}
function panel(plugins){$('metrics-panel').hidden=plugins;$('plugins-panel').hidden=!plugins;$('error').hidden=true;document.querySelector('h1').textContent=plugins?'插件更新':'耗时与缓存统计';$('subtitle').textContent=plugins?'更新前核对版本，失败时尝试恢复原版。':'从本机会话日志读取；不会发起模型请求。';if(plugins)void pluginsList().catch(error);else if(!sessionsLoaded)void sessions().catch(error);}
function summary(data){const total=data.totals;$('totals').replaceChildren();for(const[label,value]of[['已读轮次',number(total.turns)],['已读步骤',number(total.steps)],['模型用时',ms(total.modelMs)],['工具墙钟',ms(total.toolMs)],['输入 Token',number(total.inputTokens)],['缓存命中',percent(total.cacheHit)]]){const e=node('div',undefined,'metric');e.append(node('span',label),node('strong',value));$('totals').append(e);}}
async function refresh(){
 if(!sessionId)return;const own=++revision;$('error').hidden=true;$('refresh').disabled=true;
 try{const data=await rpc({action:'metrics',id:sessionId,limit});if(own!==revision)return;summary(data);$('rows').replaceChildren();
  for(const row of data.rows){const tr=node('tr');const cells=[row.kind==='compaction'?'上下文压缩':row.turn+' / '+row.step,row.model||'未知',row.status,number(row.usage?.inputTokens),number(row.usage?.outputTokens),percent(row.cacheHit),ms(row.ttftMs),ms(row.modelMs),ms(row.toolMs),ms(row.wallMs)];cells.forEach((text,i)=>{const td=node('td',text,i===1?'model':undefined);td.title=String(text);tr.append(td);});$('rows').append(tr);
   if(row.tools?.length){const extra=node('tr',undefined,'details'),td=node('td');td.colSpan=10;const details=node('details');details.append(node('summary','工具 '+row.tools.length+' 项'+(row.retries?' · 模型重试 '+row.retries+' 次':'')));for(const tool of row.tools)details.append(node('p',tool.name+' · '+tool.status+' · '+ms(tool.ms)));td.append(details);extra.append(td);$('rows').append(extra);}
  }
  $('range').textContent=data.range.scope+' · '+data.range.events+' 条事件'+(data.range.capped?'（达到事件上限）':'');$('more').hidden=!data.range.hasMore||limit>=1000;$('notes').textContent=data.notes.join(' ');
 }catch(e){if(own===revision)error(e);}finally{if(own===revision)$('refresh').disabled=false;}
}
async function sessions(){sessionsLoaded=true;const values=await rpc({action:'sessions'});$('session').replaceChildren();for(const row of values){const option=node('option',(row.title||row.id)+(row.running?' · 运行中':''));option.value=row.id;$('session').append(option);}if(!values.some(x=>x.id===sessionId))sessionId=values[0]?.id;if(sessionId)$('session').value=sessionId;await refresh();}
async function pluginsList(){
 const rows=await rpc({action:'plugins'});$('plugins').replaceChildren();
 for(const item of rows){const card=node('article',undefined,'plugin');card.append(node('h2',item.name),node('p','当前版本 '+(item.version||'未知')+' · '+(item.enabled?'已启用':'未启用')));
  if(!item.canUpdate){card.append(node('p',item.reason,'muted'));$('plugins').append(card);continue;}
  const controls=node('div',undefined,'toolbar'),input=node('input');input.value='latest';input.setAttribute('aria-label',item.name+' 目标版本');const inspect=node('button','检查版本'),update=node('button','确认更新');inspect.type=update.type='button';update.disabled=true;const preview=node('p',undefined,'muted');let plan;
  inspect.onclick=async()=>{inspect.disabled=true;update.disabled=true;$('error').hidden=true;try{plan=await rpc({action:'update.plan',name:item.name,version:input.value.trim()});preview.textContent=plan.from+' → '+plan.to+'。'+plan.notice;update.disabled=false;}catch(e){error(e);}finally{inspect.disabled=false;}};
  update.onclick=async()=>{if(pluginBusy||!plan)return;if(!confirm('将 '+plan.name+' 从 '+plan.from+' 更新到 '+plan.to+'？有运行中任务时不会开始，失败时尝试恢复原版。'))return;pluginBusy=true;update.disabled=true;$('cancel-update').hidden=false;$('update-status').textContent='正在安装，失败时会尝试恢复原版…';
   try{const result=await rpc({action:'update.execute',id:plan.id,confirm:true});$('update-status').textContent=result.result==='failed'?(result.restored?'新版本未通过，原版本已恢复':'恢复未通过，请检查原插件管理页'):result.result==='restart-required'?'已安装，等待安全重启后生效':'更新完成';if(result.result==='failed')error(result.reason||result.recovery);await pluginsList();}catch(e){error(e);$('update-status').textContent='请刷新状态核对操作结果';}finally{pluginBusy=false;$('cancel-update').hidden=true;}
  };
  input.oninput=()=>{plan=undefined;update.disabled=true;preview.textContent='';};controls.append(input,inspect,update);card.append(controls,preview);$('plugins').append(card);
 }
 const state=await rpc({action:'status'});if(state.update.flight)$('update-status').textContent=state.update.flight.name+' · '+state.update.flight.phase;
}
$('show-metrics').onclick=()=>panel(false);$('show-plugins').onclick=()=>panel(true);$('reload-plugins').onclick=()=>pluginsList().catch(error);$('refresh').onclick=refresh;$('more').onclick=()=>{limit=Math.min(1000,limit+200);void refresh();};$('session').onchange=()=>{sessionId=$('session').value;limit=200;void refresh();};$('cancel-update').onclick=()=>rpc({action:'update.cancel'}).then(()=>{$('update-status').textContent='正在取消并核对恢复结果…';}).catch(error);
panel(location.hash==='#plugins');
