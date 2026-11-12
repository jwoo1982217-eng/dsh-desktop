import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {cleanNote,brief,check} from './notes.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const canon=p=>{try{return fs.realpathSync(p);}catch{return path.resolve(p);}};
export function mutateMemory(service,p,exec){
  const {kb,summary}=service.services(),notes=kb.notes;
  check(['remember','correct','forget'].includes(p.action),'请选择记住、更正或遗忘');
  let provenance={kind:'knowledge-editor',quote:String(p.text||p.quote||'用户在知识库中执行'+p.action).slice(0,4000),time:new Date().toISOString()},cwd=null,operationId;
  if(exec){
    const session=exec.agent?.session;check(session?.id&&!/^(qq-|cloud-)/.test(session.id)&&session.header?.origin!=='subagent'&&!(session.header?.delegationDepth>0),'记忆管理仅用于本机主会话');
    const active=new Set(session.surface?.nodes||[]),event=session.snapshotEvents().findLast(e=>e.type==='user/message'&&active.has(e.seq)&&e.data.source?.kind==='user');
    const text=(event?.data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    check(typeof p.quote==='string'&&p.quote.length>=2&&p.quote.length<=4000&&text.includes(p.quote),'请引用当前用户的逐字原话');
    check(/记住|记下|记忆|更正|纠正|改成|更新|忘记|遗忘|删除|保存|存入|存到|以后|别忘|remember|forget|correct|update|save/i.test(text),'当前用户没有要求记忆操作');
    if(p.action==='forget')check(/忘记|遗忘|删除|forget/i.test(text),'当前用户没有要求遗忘');
    if(p.action!=='forget')check(typeof p.text==='string'&&p.quote.includes(p.text),'保存内容必须逐字来自用户原话');
    cwd=canon(session.header?.cwd||process.cwd());check(!p.project||canon(p.project)===cwd,'只能写入当前项目或通用记忆');
    operationId=hash(JSON.stringify([session.id,event.seq,p.action,p.id,p.text,p.title]));
    const previous=notes.state.memoryOperations?.find(x=>x.id===operationId);if(previous)return {...previous.result,duplicate:true};
    provenance={kind:'user-quote',sessionId:session.id,seq:event.seq,quote:p.quote,time:new Date().toISOString()};
  }
  const isSummary=p.id?.startsWith('summary:'),id=isSummary?p.id.slice(8):p.id?.replace(/^knowledge:/,''),old=isSummary?summary.entries.find(e=>e.key===id):notes.state.notes.find(n=>n.id===id);
  if(p.action!=='remember'){
    check(old,'记忆不存在或已遗忘',404);
    check(!old.deletedAt,'记忆已经移至回收站');
    check(p.revision===(isSummary?summary.revision:old.revision),'记忆版本已变化，请重新读取',409);
    if(exec){check(!old.project&&!old.cwd||canon(old.project||old.cwd)===cwd,'不能在其他项目修改此记忆');check(p.quote.includes(old.title||old.subject)||p.quote.includes(id),'请在用户原话中明确要更正或遗忘的主题');}
  }
  if(isSummary)return mutateSummary(service,p,old,provenance);
  const next=structuredClone(notes.state);let note;
  if(p.action==='forget'){
    note=next.notes.find(n=>n.id===id);note.deletedAt=new Date().toISOString();note.updatedAt=note.deletedAt;note.revision++;
    // History remains recoverable; retrieval always excludes the tombstone and its exact old text.
    next.memorySuppressed=[...(next.memorySuppressed||[]),{id:note.id,textHash:hash(note.body),at:note.deletedAt}].slice(-5000);
  }else{
    check(typeof p.text==='string'&&p.text.trim()&&p.text.length<=12000,'记忆正文需为 1～12000 字');
    note=cleanNote({...old,title:p.title||old?.title||p.text.slice(0,60),body:p.text,kind:p.kind||old?.kind||'knowledge',tags:p.tags||old?.tags||[],project:p.project??old?.project??cwd??'',provenance},old);
    note.provenance=provenance;
    if(old){next.notes[next.notes.findIndex(n=>n.id===id)]=note;next.memorySuppressed=[...(next.memorySuppressed||[]),{id:old.id,textHash:hash(old.body),at:note.updatedAt}].slice(-5000);}
    else{check(next.notes.length<5000,'本机最多保存 5000 篇笔记');next.notes.push(note);}
  }
  const result={ok:true,id:'knowledge:'+note.id,revision:note.revision,status:p.action==='forget'?'trashed':'active',duplicate:false,source:provenance,entry:brief(note)};
  if(operationId)next.memoryOperations=[...(next.memoryOperations||[]),{id:operationId,result:{...result,source:undefined,entry:undefined}}].slice(-1000);
  notes.record(next,p.action==='remember'?'记住知识':p.action==='correct'?'纠正记忆':'遗忘记忆');kb.schedule();return result;
}
function mutateSummary(service,p,old,provenance){
  const file=service.summaryFallback.file,lock=file+'.lock';fs.mkdirSync(path.dirname(file),{recursive:true});try{fs.mkdirSync(lock);}catch{throw Error('记忆正在保存，请刷新重试');}
  try{const state=service.summaryFallback.status();check(!state.fault&&!state.frozen,'摘要暂不可用');check(state.revision===p.revision,'摘要已变化，请刷新',409);
    const current=state.entries.find(e=>e.key===old.key);check(current,'摘要已不存在');
    const next={...state};delete next.fault;delete next.frozen;
    next.history=[...(next.history||[]),{entry:current,revision:state.revision,action:p.action,at:new Date().toISOString()}].slice(-100);
    next.suppressed.push({key:old.key,subject:old.subject,textHash:hash(old.text),at:new Date().toISOString(),reason:p.action==='forget'?'forgotten':'superseded'});
    next.entries=next.entries.filter(e=>e.key!==old.key);
    if(p.action==='correct'){check(!p.title||(typeof p.title==='string'&&p.title.trim().length>=2&&p.title.length<=80),'摘要主题需为 2～80 字');check(typeof p.text==='string'&&p.text.trim()&&p.text.length<=800,'摘要需为 1～800 字');next.entries.push({...old,subject:p.title||old.subject,text:p.text,source:provenance,updatedAt:new Date().toISOString()});}
    check(next.suppressed.length<=1000,'摘要排除记录已满，请整理后再保存');next.revision++;
    const bytes=JSON.stringify(next,null,2)+'\n';check(Buffer.byteLength(bytes)<=512*1024,'摘要及版本记录达到容量上限，原内容已保留');
    const tmp=file+'.'+randomUUID();try{fs.writeFileSync(tmp,bytes,{flag:'wx',mode:0o600});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}
    return {ok:true,id:'summary:'+old.key,revision:next.revision,status:p.action==='forget'?'forgotten':'active',source:provenance};
  }finally{fs.rmdirSync(lock);}
}
