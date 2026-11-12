export const MAX_REPLAY_BYTES=8*1024*1024;
const encoder=new TextEncoder();
const fail=(ok,message)=>{if(!ok)throw Error(message);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=(value,allowed)=>{fail(object(value),'回放对象无效');for(const key of Object.keys(value))fail(allowed.includes(key),'回放包含不支持的字段');};
const bytes=value=>encoder.encode(value).length;

/** Shared by every export surface; no source credential value is retained as a prefix. */
export function redactText(value){
 let text=String(value??'');
 text=text.replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g,'[私钥已隐藏]');
 text=text.replace(/dsh-peer:1:[A-Za-z0-9_-]+/g,'[配对信息已隐藏]');
 text=text.replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,'[凭据已隐藏]');
 text=text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]{6,}/gi,'$1 [凭据已隐藏]');
 text=text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[凭据已隐藏]@');
 text=text.replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|auth|authorization|key|code)=)[^&#\s)"']+/gi,'$1[凭据已隐藏]');
 text=text.replace(/((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|token|secret|password|passwd|authorization|cookie)["']?\s*[:=]\s*)(["'])([^\r\n]*?)\2/gi,'$1$2[凭据已隐藏]$2');
 text=text.replace(/((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|token|secret|password|passwd|authorization|cookie)["']?\s*[:=]\s*)([^\s"',;)}]+)/gi,'$1[凭据已隐藏]');
 text=text.replace(/\/(?:Users|home)\/[^/\s"'<>]+/g,'[用户目录]').replace(/[A-Za-z]:\\Users\\[^\\\s"'<>]+/gi,'[用户目录]');
 text=text.replace(/\/data\/(?:user\/\d+|data)\/[A-Za-z0-9._-]+/g,'[应用目录]');
 text=text.replace(/!\[([^\]\n]*)\]\([^\n]*?\)/g,(_,alt)=>alt?'〔'+alt+'〕':'[图片]');
 return text;
}

function message(value,{importing=false}={}){
 fields(value,['seq','role','blocks','time']);
 fail(Number.isSafeInteger(value.seq)&&value.seq>=0,'消息编号无效');
 fail(['user','assistant','tool','system'].includes(value.role),'消息角色无效');
 fail(Array.isArray(value.blocks)&&value.blocks.length<=64,'消息内容数量无效');
 const blocks=value.blocks.map(block=>{
  fields(block,['type','text']);fail(['text','reasoning','tool'].includes(block.type)&&typeof block.text==='string','消息内容无效');
  fail(block.text.length<=1024*1024,'单条内容太长，请缩小导出范围');return {type:block.type,text:importing?redactText(block.text):block.text};
 });
 const result={seq:value.seq,role:value.role,blocks};
 if(value.time!==undefined){fail(Number.isSafeInteger(value.time)&&value.time>=0,'消息时间无效');result.time=value.time;}
 return result;
}

function normalizeMessages(values,options){
 fail(Array.isArray(values)&&values.length<=2000,'最多处理 2000 条消息，请缩小范围');
 const result=values.map(value=>message(value,options)),seen=new Set();
 for(const row of result){fail(!seen.has(row.seq),'消息编号重复');seen.add(row.seq);}
 return result.sort((a,b)=>a.seq-b.seq);
}

export function projectConversation(source,options={}){
 fail(object(source)&&typeof source.title==='string','会话内容不可用');
 const include={text:options.includeText!==false,reasoning:options.includeReasoning===true,tool:options.includeTools===true};
 for(const key of ['includeText','includeReasoning','includeTools'])fail(options[key]===undefined||typeof options[key]==='boolean','导出选项无效');
 fail(Object.values(include).some(Boolean),'请至少选择一种内容');
 const original=normalizeMessages(source.messages),available=new Set(original.map(x=>x.seq));
 let selected;
 if(options.range!==undefined){
  fail(Array.isArray(options.range)&&options.range.length===2&&options.range.every(x=>available.has(x)),'范围选择已失效');
  const [low,high]=[...options.range].sort((a,b)=>a-b);selected=new Set(original.filter(x=>x.seq>=low&&x.seq<=high).map(x=>x.seq));
 }else if(options.selected!==undefined){
  fail(Array.isArray(options.selected)&&options.selected.length<=2000&&options.selected.every(x=>available.has(x)),'消息选择已变化');selected=new Set(options.selected);
 }else selected=available;
 const messages=original.filter(row=>selected.has(row.seq)).map(row=>({...row,blocks:row.blocks.filter(block=>include[block.type]).map(block=>({...block,text:redactText(block.text)}))})).filter(row=>row.blocks.length>0);
 fail(messages.length>0,'所选消息没有可导出的内容');
 const doc={format:'dsh-conversation-replay',version:1,title:redactText(source.title).slice(0,300),createdAt:new Date().toISOString(),redacted:true,messages};
 fail(bytes(JSON.stringify(doc))<=MAX_REPLAY_BYTES,'导出超过 8 MiB，请缩小范围');return doc;
}

export function parseReplay(text){
 fail(typeof text==='string'&&bytes(text)<=MAX_REPLAY_BYTES,'回放文件最多 8 MiB');
 let value;try{value=JSON.parse(text);}catch{throw Error('回放文件不是有效 JSON');}
 fields(value,['format','version','title','createdAt','redacted','messages']);
 fail(value.format==='dsh-conversation-replay'&&value.version===1,'不支持的回放格式或版本');
 fail(typeof value.title==='string'&&value.title.length<=300,'回放标题无效');
 fail(typeof value.createdAt==='string'&&value.createdAt.length<=64&&Number.isFinite(Date.parse(value.createdAt)),'回放日期无效');
 fail(value.redacted===true,'仅支持脱敏回放格式');
 const messages=normalizeMessages(value.messages,{importing:true});fail(messages.length>0,'回放没有消息');
 return {format:value.format,version:1,title:redactText(value.title),createdAt:value.createdAt,redacted:true,messages};
}

/** Read-only presentation clock. It has no host connection or command callback. */
export class ReplayController{
 constructor(document,{onChange=()=>{},schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id)}={}){
  this.document=parseReplay(JSON.stringify(document));this.onChange=onChange;this.schedule=schedule;this.cancel=cancel;this.position=0;this.speed=1;this.playing=false;this.disposed=false;
 }
 state(){return {position:this.position,total:this.document.messages.length,speed:this.speed,playing:this.playing};}
 update(){if(!this.disposed)this.onChange(this.state());}
 stopTimer(){if(this.timer!==undefined){this.cancel(this.timer);this.timer=undefined;}}
 tick(){
  if(!this.playing||this.disposed)return;
  const rows=this.document.messages,current=rows[this.position],previous=rows[this.position-1];
  const interval=previous?.time!==undefined&&current?.time!==undefined?Math.max(150,Math.min(1500,current.time-previous.time)):650;
  this.timer=this.schedule(()=>{this.timer=undefined;if(!this.playing||this.disposed)return;this.position++;if(this.position>=rows.length)this.playing=false;this.update();this.tick();},interval/this.speed);
 }
 play(){if(this.disposed||this.playing)return;if(this.position>=this.document.messages.length)this.position=0;this.playing=true;this.update();this.tick();}
 pause(){this.playing=false;this.stopTimer();this.update();}
 seek(position){fail(Number.isSafeInteger(position)&&position>=0&&position<=this.document.messages.length,'回放位置无效');this.pause();this.position=position;this.update();}
 setSpeed(value){fail([0.5,1,2,4].includes(value),'回放速度无效');this.speed=value;this.stopTimer();this.update();this.tick();}
 dispose(){this.pause();this.disposed=true;this.onChange=()=>{};}
}
