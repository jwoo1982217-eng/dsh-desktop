import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {recallMemory} from './memory-retrieval.js';
import {MemoryOrganizer} from './memory-organizer.js';
import {mutateMemory} from './memory-mutations.js';

export const LAYERS = [
  {level:'soul',label:'写作',color:'#ffd166'}, {level:'user',label:'偏好',color:'#7ee8fa'},
  {level:'rules',label:'归档',color:'#ffa66b'}, {level:'project',label:'项目',color:'#c9a7ff'},
  {level:'topic',label:'知识',color:'#8ab4ff'}, {level:'fact',label:'记录',color:'#9dffc9'},
  {level:'lesson',label:'进度',color:'#ff8fb8'},
];
const levelFor = {knowledge:'topic',project:'project',record:'fact',archive:'rules',writing:'soul',diary:'fact',preference:'user',progress:'lesson'};
const canonical = p => {try{return fs.realpathSync(p);}catch{return path.resolve(p);}};
export const check = (ok,message,status=400) => {if(!ok)throw Object.assign(new Error(message),{status});};
const terms = value => {const text=String(value).toLowerCase(),latin=text.match(/[a-z0-9_./-]+/g)||[],han=text.match(/[\p{Script=Han}]+/gu)||[];return [...new Set([...latin,...han.flatMap(s=>s.length===1?[s]:Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)))])];};
const stamp = value => {const n=Date.parse(value);return Number.isFinite(n)?n:null;};

// The installed recall service may predate summary-memory. Read its optional
// authoritative file, never copy in the repository's undeployed recall WIP.
export class ReadOnlySummary {
  constructor(home){this.home=home;this.file=path.join(home,'knowledge/summary-memory.json');}
  status(){
    const frozen=fs.existsSync(path.join(this.home,'experience/verified-improvement/.frozen.json'));
    try{
      let v;try{const st=fs.lstatSync(this.file);check(st.isFile()&&!st.isSymbolicLink()&&st.size<=512*1024,'摘要文件无效',503);v=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')v={version:1,revision:0,entries:[],suppressed:[]};else throw e;}
      check(v.version===1&&Number.isSafeInteger(v.revision)&&v.revision>=0&&Array.isArray(v.entries)&&v.entries.length<=100&&Array.isArray(v.suppressed)&&v.suppressed.length<=1000,'摘要格式无效',503);
      for(const e of v.entries)check(typeof e.key==='string'&&typeof e.subject==='string'&&typeof e.text==='string'&&e.text.length<=800&&typeof e.cwd==='string'&&e.source&&typeof e.source.quote==='string','摘要条目无效',503);
      for(const e of v.suppressed)check(typeof e.subject==='string'&&typeof e.textHash==='string','摘要排除项无效',503);
      return {...v,frozen,fault:''};
    }catch{return {entries:[],suppressed:[],revision:-1,frozen,fault:'摘要文件读取失败，请保留原文件检查'};}
  }
  allowed(row){const v=this.status(),text=String(row.text||'');return !v.frozen&&!v.fault&&!/<dsh-(?:memory-summary|recalled-memory)>/.test(text)&&!v.suppressed.some(s=>text.includes(s.subject)||createHash('sha256').update(text).digest('hex')===s.textHash);}
}

/** A read-through view: no duplicate memory store and no writes to the knowledge service. */
export class UnifiedMemory {
  constructor(ctx,{home=process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),kb}={}){this.ctx=ctx;this.kb=kb;this.home=home;this.summaryFallback=new ReadOnlySummary(home);this.organizer=new MemoryOrganizer(this,home);}
  recall(query,options={}){return recallMemory(this,query,options);}
  async search(query,options={}){return (await this.recall(query,options)).items;}
  mutate(p,exec){return mutateMemory(this,p,exec);}
  allowedHistory(row){
    const {kb,summaryService}=this.services();if(!summaryService.allowed(row))return false;
    const text=String(row.text||'').trim(),active=new Set(kb.notes.state.notes.filter(n=>!n.deletedAt).map(n=>n.body));
    for(const n of kb.notes.state.notes){const old=[...(n.deletedAt?[n.body]:[]),...(n.history||[]).map(h=>h.body)];for(const body of old){if(active.has(body))continue;if(text===body||(body.length>=12&&text.includes(body))||(text.length>=24&&body.includes(text)))return false;}}
    return true;
  }
  close(){this.organizer.close();}
  services(){
    const kb=this.kb||this.ctx.get('dshKnowledgeWorkbench'), link=this.ctx.get('dshKnowledgeLink');
    check(kb?.notes&&typeof link?.recall?.mode==='function','知识库或记忆服务尚未就绪，请稍后重试',503);
    const summaryService=link.recall.summary||this.summaryFallback;
    const summary=summaryService.status();
    check(!summary.frozen&&!summary.fault,summary.fault||'记忆已暂停，请在原记忆设置中恢复',503);
    return {kb,link,summary,summaryService};
  }
  access(exec){
    const session=exec?.agent?.session;
    check(session?.id&&!/^(qq-|cloud-)/.test(session.id)&&session.header?.origin!=='subagent'&&!(session.header?.delegationDepth>0),'星图检索仅用于 DSH 本机主会话',403);
    const {link}=this.services(), mode=link.recall.mode(session.id);
    check(mode&&mode!=='off','当前对话已关闭记忆',403);
    return {mode,cwd:canonical(session.header?.cwd||process.cwd()),sessionId:session.id,shared:link.recall.shared(session.id)};
  }
  snapshot({includeAll=false,scope='__all__',access=null}={}){
    check(['__all__','knowledge','summary'].includes(scope),'未知记忆来源');
    const {kb,summary,summaryService}=this.services();
    // Read one current atomic snapshot. Never instantiate Notes (which maintains its mirror).
    const state=kb.notes.state;
    check(state?.version===1&&Array.isArray(state.notes),'知识库数据格式异常',503);
    const items=[];
    if(scope!=='summary')for(const n of state.notes){
      if(n.deletedAt||(!includeAll&&n.kind==='archive'))continue;
      if(access?.mode==='project'&&(!n.project||canonical(n.project)!==access.cwd))continue;
      if(!summaryService.allowed({text:n.title+'\n'+n.body}))continue;
      items.push({id:'knowledge:'+n.id,level:levelFor[n.kind]||'topic',title:n.title,content:n.body,keywords:n.tags||[],
        status:n.kind==='archive'?'archived':'active',project:n.project||'',subcategory:n.kind,source:'知识库',
        sourceId:n.id,revision:n.revision,provenance:n.provenance,derived:this.organizer?.entry(n),sourceUrl:'/knowledge-base',createdAt:stamp(n.createdAt),updatedAt:stamp(n.updatedAt)});
    }
    if(scope!=='knowledge')for(const e of summary.entries){
      if(access?.mode==='project'&&e.cwd&&canonical(e.cwd)!==access.cwd)continue;
      items.push({id:'summary:'+e.key,level:e.kind==='preference'?'user':e.kind==='progress'?'lesson':'project',title:e.subject,
        content:e.text,keywords:[],status:'active',project:e.cwd,subcategory:e.kind,source:'记忆摘要',sourceId:e.key,
        sourceSession:e.source?.sessionId,provenance:e.source,sourceUrl:'/knowledge-link',revision:summary.revision,updatedAt:stamp(e.updatedAt)});
    }
    const ids=new Set(items.map(n=>n.id));
    // Retain the existing graph's exact links/tag evidence; never invent semantic edges.
    const graph=scope==='summary'?{edges:[],limited:false}:kb.notes.graph();
    const edges=graph.edges.map(e=>({...e,from:'knowledge:'+e.from,to:'knowledge:'+e.to}))
      .filter(e=>ids.has(e.from)&&ids.has(e.to));
    const revision=createHash('sha256').update(JSON.stringify({items,edges})).digest('hex');
    return {items,edges,revision,graphLimited:!!graph.limited};
  }
  page(options={}){
    const full=this.snapshot(options), all=full.items.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)), items=all.slice(0,500).map(n=>({...n,content:n.content.slice(0,12000),truncated:n.content.length>12000}));
    const ids=new Set(items.map(n=>n.id));
    return {ok:true,workspace:options.scope||'__all__',workspaceName:'DSH 知识库与记忆',includeAll:!!options.includeAll,
      mtime:full.revision,generatedAt:Date.now(),total:all.length,displayed:items.length,limited:all.length>items.length,
      graphLimited:full.graphLimited,items,edges:full.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)),layers:LAYERS,
      layerCounts:Object.fromEntries(LAYERS.map(l=>[l.level,items.filter(n=>n.level===l.level).length]))};
  }
  keyword(query,{access=null,limit=60}={}){
    check(typeof query==='string'&&query.trim()&&query.length<=4000,'请输入 1～2000 字的检索内容');
    const {items,edges}=this.snapshot({includeAll:true,access}), words=terms(query);
    const rows=items.map(n=>({n,score:words.reduce((sum,w)=>sum+(n.title.toLowerCase().includes(w)?4:0)+(n.keywords.some(t=>t.toLowerCase().includes(w))?2:0)+(n.content.toLowerCase().includes(w)?1:0),0)}))
      .filter(r=>r.score>0).sort((a,b)=>b.score-a.score||(b.n.updatedAt||0)-(a.n.updatedAt||0)).slice(0,Math.min(60,Math.max(1,limit)));
    return rows.map(({n,score})=>{const at=Math.max(0,n.content.toLowerCase().indexOf(query.toLowerCase()));return {...n,content:n.content.slice(Math.max(0,at-120),Math.max(0,at-120)+1600),score,
      related:edges.filter(e=>e.from===n.id||e.to===n.id).slice(0,6).map(e=>({id:e.from===n.id?e.to:e.from,kind:e.kind,tags:e.tags}))};});
  }
  read(id,{access=null,offset=0}={}){
    check(typeof id==='string'&&id.length<=160,'记忆 ID 无效');check(Number.isSafeInteger(offset)&&offset>=0,'读取位置无效');
    const {items,edges}=this.snapshot({includeAll:true,access}), n=items.find(n=>n.id===id);
    check(n,'记忆不存在、已删除或不在当前对话范围',404);
    return {...n,content:n.content.slice(offset,offset+12000),offset,nextOffset:offset+12000<n.content.length?offset+12000:null,
      related:edges.filter(e=>e.from===id||e.to===id).map(e=>({id:e.from===id?e.to:e.from,kind:e.kind,tags:e.tags})).slice(0,20)};
  }
}
