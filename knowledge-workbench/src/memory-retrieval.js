import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const canon=p=>{try{return fs.realpathSync(p);}catch{return path.resolve(p);}};
const within=(p,root)=>p===root||p.startsWith(root+path.sep);
const terms=s=>[...new Set((String(s).toLowerCase().match(/[a-z0-9_./-]+|[\p{Script=Han}]/gu)||[]).concat((String(s).toLowerCase().match(/[\p{Script=Han}]{2,}/gu)||[]).flatMap(s=>Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)))))].filter(w=>w.length>1);
function excerpt(item,query){
  const lines=item.content.split('\n'),words=terms(query);let best=0,at=0;
  for(let i=0;i<lines.length;i++){const score=words.reduce((n,w)=>n+(lines[i].toLowerCase().includes(w)?1:0),0);if(score>best){best=score;at=i;}}
  const start=Math.max(0,at-1),text=lines.slice(start,start+10).join('\n').slice(0,1200);
  return {content:text,text,lineStart:start+1,lineEnd:Math.min(lines.length,start+text.split('\n').length)};
}
function adjacent(items,seeds){
  const byId=new Map(items.map(n=>[n.id,n])),titles=new Map(),neighbors=new Map();
  for(const n of items){const list=titles.get(n.title)||[];list.push(n.id);titles.set(n.title,list);}
  const add=(from,to,kind,tags)=>{if(from===to||!byId.has(to))return;const key=[from,to].sort().join('|');if(!neighbors.has(key)||kind==='link')neighbors.set(key,{from,to,kind,...(tags?{tags}:{} )});};
  // Do not use the display graph's 120-note limit as a retrieval boundary.
  const seedIds=new Set(seeds.map(n=>n.id));
  for(const n of items){for(const m of n.content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)){
    const targets=byId.has('knowledge:'+m[1])?['knowledge:'+m[1]]:(titles.get(m[1])||[]);
    if(targets.length===1&&(seedIds.has(n.id)||seedIds.has(targets[0])))add(n.id,targets[0],'link');
  }}
  for(const seed of seeds)for(const n of items){const tags=seed.keywords.filter(t=>n.keywords.includes(t));if(tags.length)add(seed.id,n.id,'tag',tags);}
  return [...neighbors.values()].sort((a,b)=>(a.kind==='link'?0:1)-(b.kind==='link'?0:1));
}
/** One shared read path for the workbench, constellation, tools, and automatic recall. */
export async function recallMemory(service,query,{access=null,scope='all',kind='',tag='',project='',mode,limit=8,byteBudget=12000,signal}={}){
  if(typeof query!=='string'||!query.trim()||query.length>4000)throw Error('请输入 1～4000 字的检索内容');
  if(!['notes','summary','all','allowed'].includes(scope))throw Error('检索范围无效');
  if(scope==='allowed'&&!access)throw Error('请选择本机对话以确定记忆范围');
  if(!Number.isInteger(limit)||limit<1||limit>30||!Number.isInteger(byteBudget)||byteBudget<256||byteBudget>48000)throw Error('检索预算无效');
  signal?.throwIfAborted();
  const initial=service.snapshot({includeAll:true,access}),{kb,link,summaryService}=service.services();
  const permit=n=>n.provenance?.trust!=='needs-review'&&(scope!=='notes'||n.source==='知识库')&&(scope!=='summary'||n.source==='记忆摘要')&&(!kind||n.subcategory===kind)&&(!tag||n.keywords.includes(tag))&&(!project||n.project===project);
  let items=initial.items.filter(permit),byId=new Map(items.map(n=>[n.id,n]));
  const routes={keyword:[],semantic:[],relation:[]},scores=new Map(),reasons=new Map(),warnings=[];
  const addRoute=(route,ids)=>{routes[route]=[...new Set(ids)];routes[route].forEach((id,i)=>{scores.set(id,(scores.get(id)||0)+1/(60+i+1));const list=reasons.get(id)||[];list.push({kind:route});reasons.set(id,list);});};
  addRoute('keyword',service.keyword(query,{access,limit:60}).filter(n=>byId.has(n.id)).map(n=>n.id));
  mode=mode||kb.notes.state.preferences.searchMode;
  if(mode==='hybrid'||scope==='allowed'){
    try{
      const searcher=scope==='allowed'?(link.recall.memory||link.memory):link.memory;
      const indexed=searcher?.status?.().index?.indexed;
      if(mode==='hybrid'&&!indexed)warnings.push('本机语义索引尚未就绪，已使用关键词及真实关联。');
      if(searcher&&(indexed||scope==='allowed')){
        const deadline=AbortSignal.timeout(6000),searchSignal=signal?AbortSignal.any([signal,deadline]):deadline;
        const options={top:60,signal:searchSignal,...(access?{mode:access.mode,cwd:access.cwd,shared:access.shared}:{})};
        const lookups=[link.memory.search(query,mode!=='hybrid'||!indexed,{...options,sourceRoot:kb.notes.mirror})];
        if(scope==='allowed')lookups.push(searcher.search(query,mode!=='hybrid'||!indexed,options));
        const results=await Promise.allSettled(lookups),found=results.filter(r=>r.status==='fulfilled').flatMap(r=>r.value);
        if(results.every(r=>r.status==='rejected'))throw results[0].reason;
        if(results.some(r=>r.status==='rejected'))warnings.push('历史索引暂未完成，已保留知识库原文与关联结果。');
        signal?.throwIfAborted();
        // Re-read the authority after the asynchronous index lookup. Deleted/edited data never comes from the old index.
        items=service.snapshot({includeAll:true,access}).items.filter(permit);byId=new Map(items.map(n=>[n.id,n]));
        const semantic=[];
        for(const r of found){
          if(typeof r.file==='string'&&within(canon(r.file),canon(kb.notes.mirror))){
            const id='knowledge:'+path.basename(r.file,'.md');if(byId.has(id)&&!kb.notes.indexFault)semantic.push(id);continue;
          }
          if(scope!=='allowed'||!r.text||r.sid===access.sessionId||/^(qq-|cloud-)/.test(r.sid||'')||!service.allowedHistory(r))continue;
          if(access.mode==='project'&&!(r.cwd?canon(r.cwd)===access.cwd:typeof r.file==='string'&&within(canon(r.file),access.cwd)))continue;
          const id='history:'+createHash('sha256').update(JSON.stringify([r.file,r.sid,r.lineStart,r.memoryId,r.text])).digest('hex').slice(0,32);
          byId.set(id,{id,sourceId:r.memoryId||r.sid,source:r.origin||'历史记忆',title:r.title||path.basename(r.file||'历史记录'),content:String(r.text),keywords:[],project:r.cwd||'',historical:true,file:r.file,sourceSession:r.sid,updatedAt:r.time||r.mtime,lineStart:r.lineStart,lineEnd:r.lineEnd});semantic.push(id);
        }
        addRoute(mode==='hybrid'&&indexed?'semantic':'historyKeyword',semantic);
      }
    }catch(e){if(signal?.aborted)throw signal.reason;warnings.push('本机索引检索未完成，已回退到当前原文的关键词及关联。');}
  }
  // A correction while awaiting embeddings must also invalidate old lexical hits.
  const current=service.snapshot({includeAll:true,access}).items.filter(permit),currentMap=new Map(current.map(n=>[n.id,n]));
  for(const [id,n] of byId)if(!n.historical){if(currentMap.has(id))byId.set(id,currentMap.get(id));else{byId.delete(id);scores.delete(id);}}
  const seeds=[...scores].filter(([id])=>byId.has(id)).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,5).map(([id])=>byId.get(id));
  const edges=adjacent(current,seeds),expanded=[];
  for(const seed of seeds){let count=0;for(const edge of edges){if(edge.from!==seed.id&&edge.to!==seed.id)continue;const id=edge.from===seed.id?edge.to:edge.from;if(!byId.has(id)||++count>6)continue;
    if(!expanded.includes(id))expanded.push(id);const list=reasons.get(id)||[];list.push({kind:'relation',via:seed.id,title:seed.title,edge:edge.kind,tags:edge.tags});reasons.set(id,list);
    if(!scores.has(id))scores.set(id,(scores.get(seed.id)||0)*0.55);
  }}routes.relation=expanded;
  const selected=[],seen=new Set();let bytes=0,omitted=0;
  for(const [id,score]of [...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))){const n=byId.get(id);if(!n)continue;
    const part=excerpt(n,query),signature=createHash('sha256').update(part.content.trim()).digest('hex');if(seen.has(signature))continue;
    const why=(reasons.get(id)||[]).slice(0,8),row={...n,...part,derived:undefined,score,reasons:why,method:why.some(r=>r.kind==='semantic')?'混合检索':why.some(r=>r.kind==='keyword')?'关键词':'关联联想',related:edges.filter(e=>e.from===id||e.to===id).slice(0,6).map(e=>({id:e.from===id?e.to:e.from,kind:e.kind,tags:e.tags})),citation:selected.length+1};
    const size=Buffer.byteLength(JSON.stringify(row));if(selected.length>=limit||bytes+size>byteBudget){omitted++;continue;}selected.push(row);seen.add(signature);bytes+=size;
  }
  return {query,items:selected,rows:selected.map(n=>({...n,noteId:n.source==='知识库'?n.sourceId:undefined})),warnings,mode,scope,trace:{routes:Object.fromEntries(Object.entries(routes).map(([k,v])=>[k,v.length])),hopLimit:1,evidenceBytes:bytes,byteBudget,omitted,referenceOnly:true}};
}
