import {createHash,randomUUID} from 'node:crypto';
import {MAX_REPLAY_BYTES,parseReplay,projectConversation,redactText} from './model.mjs';

const fail=(ok,message)=>{if(!ok)throw Error(message);};
const html=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const role=value=>({user:'我',assistant:'AI',tool:'工具',system:'系统'}[value]??value);
const kind=value=>({text:'正文',reasoning:'思考',tool:'工具记录'}[value]??value);
const markdownText=text=>text.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\[([^\]]*)\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi,'$1');
const markdown=doc=>'# '+markdownText(doc.title.replace(/[\r\n]/g,' '))+'\n\n'+doc.messages.map(row=>'## '+role(row.role)+' · #'+row.seq+'\n\n'+row.blocks.map(block=>(block.type==='text'?'':'**'+kind(block.type)+'**\n\n')+markdownText(block.text)).join('\n\n')).join('\n\n---\n\n')+'\n';
const revision=source=>createHash('sha256').update(JSON.stringify(source)).digest('hex');
const filename=(title,extension)=>(title.replace(/[\x00-\x1f<>:"/\\|?*]/g,'_').slice(0,65)||'会话')+extension;

function offlineRuntime(){
 const data=JSON.parse(document.getElementById('replay-data').textContent),output=document.getElementById('messages'),counter=document.getElementById('counter'),play=document.getElementById('play'),speed=document.getElementById('speed'),range=document.getElementById('range');
 let position=0,timer=null,running=false;
 const names={user:'我',assistant:'AI',tool:'工具',system:'系统'},types={text:'正文',reasoning:'思考',tool:'工具记录'};
 function show(){output.replaceChildren();for(const row of data.messages.slice(0,position)){const article=document.createElement('article'),h=document.createElement('h2');h.textContent=names[row.role]+' · #'+row.seq;article.append(h);for(const block of row.blocks){const label=document.createElement('small'),text=document.createElement('pre');label.textContent=types[block.type];text.textContent=block.text;article.append(label,text);}output.append(article);}counter.textContent=position+' / '+data.messages.length;range.value=position;play.textContent=running?'暂停':'播放';}
 function pause(){running=false;clearTimeout(timer);timer=null;show();}
 function tick(){if(!running)return;timer=setTimeout(()=>{position++;if(position>=data.messages.length)running=false;show();tick();},650/Number(speed.value));}
 play.addEventListener('click',()=>{if(running){pause();return;}if(position>=data.messages.length)position=0;running=true;show();tick();});
 document.getElementById('all').addEventListener('click',()=>{pause();position=data.messages.length;show();});
 range.max=data.messages.length;range.addEventListener('input',()=>{pause();position=Number(range.value);show();});
 speed.addEventListener('change',()=>{clearTimeout(timer);tick();});document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});window.addEventListener('pagehide',pause);show();
}

export function offlineHtml(doc){
 const script='('+offlineRuntime.toString()+')();',hash=createHash('sha256').update(script).digest('base64');
 const data=JSON.stringify(doc).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
 return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; script-src &#39;sha256-'+hash+'&#39;"><title>'+html(doc.title)+'</title><style>body{font:16px/1.6 system-ui;max-width:850px;margin:24px auto;padding:16px;color:#243044;background:#f4f6fa}header{position:sticky;top:0;background:#f4f6fa;padding:10px 0}button,select,input{font:inherit;min-height:44px}article{padding:16px;margin:14px 0;background:white;border:1px solid #d8deea;border-radius:12px}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}h2{font-size:17px}small{color:#606b7c}input[type=range]{width:100%}</style><h1>'+html(doc.title)+'</h1><p>离线只读回放 · 不执行工具或发送消息</p><header><button id="play">播放</button> <button id="all">显示全部</button> <label>速度 <select id="speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label> <span id="counter"></span><input aria-label="回放进度" id="range" type="range" min="0" value="0"></header><main id="messages"></main><script id="replay-data" type="application/json">'+data+'</script><script>'+script+'</script></html>';
}

export function conversationSvg(doc){
 const lines=[];
 const append=(text,bold=false)=>{for(const raw of String(text).split('\n')){let row='',width=0;for(const char of raw){const size=char.codePointAt(0)>255?2:1;if(width+size>66){lines.push({text:row,bold});row='';width=0;}row+=char;width+=size;}lines.push({text:row,bold});}};
 append(doc.title,true);append('');for(const row of doc.messages){append(role(row.role)+' · #'+row.seq,true);for(const block of row.blocks){if(block.type!=='text')append('['+kind(block.type)+']');append(block.text);}append('');}
 fail(lines.length<=550,'图片内容太长，请减少所选消息');
 const height=Math.max(220,lines.length*27+90);
 return '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="'+height+'" viewBox="0 0 960 '+height+'"><title>'+html(doc.title)+'</title><rect width="100%" height="100%" fill="#f4f6fa"/>'+lines.map((line,i)=>'<text x="36" y="'+(48+i*27)+'" fill="#243044" font-family="system-ui,sans-serif" font-size="22"'+(line.bold?' font-weight="bold"':'')+'>'+html(line.text)+'</text>').join('')+'</svg>';
}

export function createConversationFeatures({listSessions,readSession,now=()=>Date.now(),maxDownloads=8,maxDownloadBytes=32*1024*1024}={}){
 fail(typeof listSessions==='function'&&typeof readSession==='function','缺少会话读取接口');
 const downloads=new Map();let disposed=false;
 const prune=()=>{for(const [key,row]of downloads)if(row.expires<=now())downloads.delete(key);};
 const load=async id=>{fail(!disposed,'分享服务已关闭');fail(typeof id==='string'&&id.length>0&&id.length<=256&&!/[\x00-\x1f]/.test(id),'会话编号无效');const source=await readSession(id);fail(source&&source.id===id,'会话不可用');return source;};
 async function manage(payload){
  fail(payload&&typeof payload==='object'&&!disposed,'请求不可用');
  if(payload.action==='sessions'){
   const values=await listSessions();fail(Array.isArray(values)&&values.length<=10000,'会话列表不可用');
   return {items:values.map(row=>({id:row.id,title:redactText(row.title??'未命名').slice(0,300),updatedAt:row.updatedAt,running:row.running===true}))};
  }
  if(payload.action==='import')return {document:parseReplay(payload.text),readOnly:true};
  fail(['messages','export'].includes(payload.action),'操作无效');const source=await load(payload.sessionId),stamp=revision(source);
  if(payload.action==='messages'){
   // Preview all supported blocks without leaking secrets; exported visibility is selected separately.
   const doc=projectConversation(source,{includeReasoning:true,includeTools:true});
   return {revision:stamp,title:doc.title,items:doc.messages.map(row=>({seq:row.seq,role:row.role,preview:row.blocks.map(x=>x.text).join('\n').slice(0,240),types:[...new Set(row.blocks.map(x=>x.type))]}))};
  }
  fail(payload.expectedRevision===undefined||payload.expectedRevision===stamp,'会话已变化，请刷新后重新选择');
  const format=payload.format;fail(['markdown','html','json','svg'].includes(format),'导出格式无效');
  const doc=projectConversation(source,payload),extensions={markdown:'.md',html:'.html',json:'.dsh-replay',svg:'.svg'},mime={markdown:'text/markdown; charset=utf-8',html:'text/html; charset=utf-8',json:'application/json; charset=utf-8',svg:'image/svg+xml; charset=utf-8'}[format];
  const text=format==='markdown'?markdown(doc):format==='html'?offlineHtml(doc):format==='svg'?conversationSvg(doc):JSON.stringify(doc,null,2);
  const body=Buffer.from(text);fail(body.length<=MAX_REPLAY_BYTES+1024*1024,'导出文件过大，请缩小范围');prune();
  fail(downloads.size<maxDownloads&&[...downloads.values()].reduce((n,x)=>n+x.body.length,0)+body.length<=maxDownloadBytes,'待下载文件过多，请完成下载后再试');
  const downloadToken=randomUUID(),name=filename(doc.title,extensions[format]);downloads.set(downloadToken,{filename:name,mime,body,expires:now()+120000});
  return {filename:name,mime,bytes:body.length,downloadToken,messages:doc.messages.length};
 }
 return {manage,download(token){fail(!disposed,'下载已失效');prune();const row=downloads.get(token);fail(row,'下载已失效，请重新导出');return {filename:row.filename,mime:row.mime,body:row.body};},dispose(){disposed=true;downloads.clear();}};
}
