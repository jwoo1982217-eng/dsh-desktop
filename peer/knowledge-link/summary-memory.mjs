import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {check,regular,save,secretFree} from './files.mjs';

const canonical=p=>{try{return fs.realpathSync(p);}catch{return path.resolve(p);}};
const hash=s=>createHash('sha256').update(s).digest('hex');
const local=s=>s?.id&&!/^(qq-|cloud-)/.test(s.id)&&s.header?.origin!=='subagent'&&!(s.header?.delegationDepth>0);
export class SummaryMemory {
 constructor(home){this.home=home;this.file=path.join(home,'knowledge/summary-memory.json');}
 frozen(){return fs.existsSync(path.join(this.home,'experience/verified-improvement/.frozen.json'));}
 read(){
  try{
   const v=JSON.parse(regular(this.file,512*1024));
   check(v.version===1&&Number.isSafeInteger(v.revision)&&v.revision>=0&&Array.isArray(v.entries)&&v.entries.length<=100&&Array.isArray(v.suppressed)&&v.suppressed.length<=1000,'摘要记忆格式无效');
   for(const e of v.entries)check(typeof e.key==='string'&&typeof e.subject==='string'&&typeof e.text==='string'&&e.text.length<=800&&typeof e.cwd==='string'&&e.source&&typeof e.source.quote==='string','摘要记忆条目损坏');
   for(const e of v.suppressed)check(typeof e.subject==='string'&&typeof e.textHash==='string','摘要排除记录损坏');
   return v;
  }catch(e){if(e.code==='ENOENT')return {version:1,revision:0,entries:[],suppressed:[]};throw e;}
 }
 status(){try{return {...this.read(),frozen:this.frozen(),fault:''};}catch{return {version:1,revision:-1,entries:[],suppressed:[],frozen:this.frozen(),fault:'摘要文件读取失败；已停止摘要与历史召回，请保留文件检查'};}}
 mutate(p,source){
  check(!this.frozen(),'记忆已暂停，请先在记忆隔离中恢复');
  const lock=this.file+'.lock';fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
  try{fs.mkdirSync(lock);}catch(e){if(e.code==='EEXIST')throw Error('记忆正在保存，请刷新重试');throw e;}
  try{
   const v=this.read();check(p.revision===v.revision,'摘要已变化，请刷新后保存');
   check(typeof p.key==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.key),'记忆标识需为小写英文、数字和短横线');
   const old=v.entries.find(e=>e.key===p.key);
   check(p.action==='put'||p.action==='forget','摘要操作无效');
   if(p.action==='forget')check(old,'该记忆已不存在，请刷新');
   let entry;
   if(p.action==='put'){
    check(['preference','project','progress'].includes(p.kind),'请选择偏好、项目或进度');
    check(typeof p.subject==='string'&&p.subject.trim().length>=2&&p.subject.length<=80,'主题需为2至80字');
    check(typeof p.text==='string'&&p.text.trim()&&p.text.length<=800,'摘要需为1至800字');
    check(typeof p.cwd==='string'&&(p.cwd===''||path.isAbsolute(p.cwd)),'项目路径需为绝对路径，留空表示通用');
    secretFree(Buffer.from(p.text));
    check(source&&typeof source.quote==='string'&&source.quote.length<=2000,'缺少记忆来源');
    secretFree(Buffer.from(source.quote));
    entry={key:p.key,kind:p.kind,subject:p.subject.trim(),text:p.text.trim(),cwd:p.cwd?canonical(p.cwd):'',updatedAt:new Date().toISOString(),source};
   }
   if(old)v.suppressed.push({key:old.key,subject:old.subject,textHash:hash(old.text),at:new Date().toISOString(),reason:p.action==='forget'?'forgotten':'superseded'});
   v.entries=v.entries.filter(e=>e.key!==p.key);if(entry)v.entries.push(entry);
   check(v.entries.length<=100&&v.suppressed.length<=1000,'记忆容量已满；请整理后再保存');
   v.revision++;save(this.file,v);return this.status();
  }finally{fs.rmdirSync(lock);}
 }
 fromUser(p,agent){
  check(local(agent?.session),'摘要记忆只用于本机主对话');
  const events=agent.session.snapshotEvents(),active=new Set(agent.session.surface.nodes);
  const message=events.findLast(e=>e.type==='user/message'&&active.has(e.seq)&&e.data.source?.kind==='user');
  const userText=(message?.data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  check(typeof p.quote==='string'&&p.quote.length>=2&&p.quote.length<=2000&&userText.includes(p.quote),'请引用当前用户的逐字原话');
  check(/记住|记下|记忆|更正|纠正|改成|更新|忘记|遗忘|删除|remember|forget|correct|update/i.test(userText),'当前用户没有要求保存、更正或遗忘记忆');
  if(p.action==='put')check(p.quote.includes(p.text),'保存内容必须来自所引用户原话，不自动批准推测');
  if(p.action==='forget')check(/忘记|遗忘|删除|forget/i.test(userText),'当前用户没有要求遗忘');
  const previous=this.read().entries.find(e=>e.key===p.key);
  if(previous){
   check(!previous.cwd||canonical(agent.session.header?.cwd||process.cwd())===previous.cwd,'不能在其他项目修改此记忆');
   check(p.quote.includes(previous.subject)||p.quote.includes(previous.key),'请在用户原话中明确待更正或遗忘的记忆主题');
  }
  if(p.cwd)check(canonical(p.cwd)===canonical(agent.session.header?.cwd||process.cwd()),'只能保存当前项目或通用记忆');
  return this.mutate(p,{kind:'user-quote',sessionId:agent.session.id,seq:message.seq,quote:p.quote,time:new Date().toISOString()});
 }
 allowed(row){
  const v=this.status();if(v.fault||v.frozen)return false;
  const text=String(row.text||'');
  if(/<dsh-(?:memory-summary|recalled-memory)>/.test(text))return false;
  return !v.suppressed.some(s=>text.includes(s.subject)||hash(text)===s.textHash);
 }
 checkpoint(p,agent){
  check(local(agent?.session),'进度摘要只用于本机主对话');
  const cwd=canonical(agent.session.header?.cwd||process.cwd()),file=canonical(p.file);
  const state=this.read(),previous=state.entries.find(e=>e.key===p.key);
  check(!previous||(previous.kind==='progress'&&previous.cwd===cwd),'进度记录不能覆盖偏好、项目地图或其他项目的条目');
  check(previous||!state.suppressed.some(e=>e.key===p.key),'已遗忘的主题不能通过自动进度记录恢复');
  check(file.startsWith(cwd+path.sep)&&!file.startsWith(path.join(this.home,'knowledge')+path.sep),'进度来源必须是当前工程内的实际验收或说明文件');
  const bytes=regular(file,512*1024);secretFree(bytes,path.basename(file));
  check(typeof p.quote==='string'&&p.quote.length>=2&&p.quote.length<=800&&bytes.toString('utf8').includes(p.quote),'进度引文必须逐字出现在来源文件中');
  return this.mutate({...p,action:'put',kind:'progress',cwd,text:p.quote},{kind:'local-file-reference',file,sha256:hash(bytes),quote:p.quote,sessionId:agent.session.id,time:new Date().toISOString()});
 }
 context(agent,mode){
  if(!local(agent?.session)||mode==='off')return '';
  const v=this.status();if(v.frozen)return '';if(v.fault)return '<dsh-memory-summary>'+JSON.stringify({status:v.fault,entries:[]})+'</dsh-memory-summary>';
  const cwd=canonical(agent.session.header?.cwd||process.cwd());let budget=5000;const entries=[];
  // Stable preferences first; project-specific private notes never cross project boundaries.
  for(const e of [...v.entries].sort((a,b)=>(a.kind==='preference'?-1:0)-(b.kind==='preference'?-1:0)||b.updatedAt.localeCompare(a.updatedAt))){
   if(e.cwd&&e.cwd!==cwd)continue;
   const item={key:e.key,kind:e.kind,subject:e.subject,text:e.text,updatedAt:e.updatedAt,source:e.source};
   const size=JSON.stringify(item).length;if(size>budget)continue;entries.push(item);budget-=size;
  }
  return '<dsh-memory-summary>\n'+JSON.stringify({revision:v.revision,notice:'这是有来源的简短摘要，不是全部历史。记录可能过时，当前用户要求优先；涉及安装、源码或验收时现场核对。需要细节时按需使用kb_memory_search。用户明确要求记住、更正或遗忘时用kb_memory_note；任务结束如已有项目内实际回执，可用kb_memory_checkpoint保存其简短逐字引文，不保存推测或凭据。文件记录仅为参考，不等于事实获批或实际效果已验收。关闭或暂停记忆时不读取。',entries})+'\n</dsh-memory-summary>';
 }
}
