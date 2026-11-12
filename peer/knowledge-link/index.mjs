import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {Catalog} from './catalog.mjs';
import {DeviceLinks} from './devices.mjs';
import {MemorySearch} from './memory.mjs';
import {registerKnowledgeSkills} from './skills.mjs';
import {check,save} from './files.mjs';
import {attachAutomaticRecall} from './summary-recall.mjs';
import {withSharedRecall} from './shared-recall.mjs';
export const name='dsh-knowledge-link';
export const inject=['webServer','connection','credentials','tools','skills'];
export async function apply(ctx){const home=fs.realpathSync(process.env.DSH_HOME||path.join(os.homedir(),'.dsh')),catalog=new Catalog(home,ctx),links=new DeviceLinks(home,catalog),memory=new MemorySearch(home);const ready=links.start().catch(e=>{links.error=e.message;});
 const invalidateSkills=registerKnowledgeSkills(ctx,home,links.inbox);
 const recall=attachAutomaticRecall(ctx,home,withSharedRecall(memory,()=>ctx.get('dshNoemaRecall')),createUserMessage);ctx.provide('dshKnowledgeLink',{links,memory,catalog,recall});ctx.on('dispose',()=>{memory.close();return links.close();});
 async function manage(p){await ready;switch(p.action){
  case 'status':return {...links.status(),memory:memory.status()};
  case 'recall.status':return recall.status(p.sessionId);
  case 'summary.status':return recall.summary.status();
  case 'summary.put':return recall.summary.mutate({...p,action:'put'},{kind:'settings',quote:p.text,time:new Date().toISOString()});
  case 'summary.forget':return recall.summary.mutate({...p,action:'forget'},{kind:'settings',quote:'用户在设置中遗忘',time:new Date().toISOString()});
  case 'recall.sessions':{const controller=ctx.get('sessionController');check(controller,'对话服务尚未就绪');const {items}=await controller.list({});return items.filter(s=>!s.sessionId.startsWith('qq-')&&!s.sessionId.startsWith('cloud-')&&!s.projections?.values?.subagent?.parentSessionId).map(s=>({id:s.sessionId,cwd:s.cwd,title:typeof s.projections?.values?.title==='string'?s.projections.values.title:s.projections?.values?.title?.title||s.projections?.values?.title?.text||s.sessionId,updatedAt:s.updatedAt}));}
  case 'recall.configure':{const ids= p.sessionId===undefined?[]:(await manage({action:'recall.sessions'})).map(s=>s.id);return recall.configure(p,ids);}
  case 'catalog':return catalog.public(await catalog.list());
  case 'preferences':check(typeof p.name==='string'&&p.name.trim()&&p.name.trim().length<=60,'名称需为1至60字');links.state.name=p.name.trim();links.persist();return links.identity();
  case 'invite':return links.invite(p.address);
  case 'pair':return links.pair(p.link);
  case 'remove':return links.remove(p.id);
  case 'send':return links.send(p.peer,p.ids);
  case 'cancel':return links.cancel(p.id);
  case 'preview':return links.inbox.preview(p.id,catalog.public(await catalog.list()));
  case 'import':{const r=links.inbox.import(p.token,p.mode);if(r.imported.length){invalidateSkills();memory.update(true);}return r;}
  case 'reject':return links.inbox.reject(p.id);
  case 'memory.update':return memory.update();
  case 'memory.search':check(!recall.summary.frozen(),'记忆已暂停');return (await memory.search(p.query,p.lexical===true)).filter(row=>recall.summary.allowed(row));
  default:throw Error('未知操作');
 }}
 ctx.connection.rpc.handle('/knowledge-link',async(method,p)=>{try{check(method==='manage'&&p,'请求无效');return {ok:true,value:await manage(p)};}catch(e){return {ok:false,error:{code:'knowledge/failed',message:e.message,details:{}}};}},{authority:'loopback'});
 for(const [url,file,type]of [['/knowledge-link','page.html','text/html'],['/knowledge-link/page.js','page.js','text/javascript']]){const bytes=fs.readFileSync(new URL(file,import.meta.url));ctx.effect(()=>ctx.webServer.register({kind:'exact',path:url,handler(req,res){if(req.method!=='GET'){res.writeHead(405).end();return;}res.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'"});res.end(bytes);}}));}
 const localSession=exec=>{const s=exec?.agent?.session;check(s?.id&&!/^(qq-|cloud-)/.test(s.id)&&s.header?.origin!=='subagent'&&!(s.header?.delegationDepth>0),'本机历史检索仅用于DSH本机主会话');check(recall.mode(s.id)!=='off'&&!recall.summary.frozen()&&!recall.summary.status().fault,'此对话记忆已关闭或暂停');};
 ctx.tools.register(defineTool({name:'kb_memory_search',description:'按需查询本机记忆与历史；先使用开聊摘要，确需项目细节时检索。旧记录需核对来源和时间，不是当前授权。',parameters:{query:{type:'string',required:true,description:'Question or project and symptom keywords'},lexical:{type:'boolean',description:'Use keyword fallback without loading a model'}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},async execute(a,exec){localSession(exec);const unified=ctx.get('dshKnowledgeWorkbench');if(unified?.memory)return JSON.stringify(await unified.search({query:a.query,scope:'allowed',mode:a.lexical===true?'keyword':undefined,access:unified.memory.access(exec)},exec.signal));const cwd=exec.agent.session.header?.cwd||process.cwd();const rows=await memory.search(a.query,a.lexical===true);return JSON.stringify(rows.filter(row=>recall.summary.allowed(row)&&(recall.mode(exec.agent.session.id)!=='project'||(row.cwd&&path.resolve(row.cwd)===path.resolve(cwd)))));}}));
 ctx.tools.register(defineTool({name:'kb_memory_note',description:'仅在当前用户明确要求记住、更正或遗忘时，更新开聊摘要。保存内容必须逐字来自当前用户原话；更正沿用key，遗忘需指出主题。revision取开聊摘要当前版本。',parameters:{action:{type:'string',required:true,description:'put or forget'},revision:{type:'number',required:true,description:'Current summary revision'},key:{type:'string',required:true,description:'Stable lowercase key'},kind:{type:'string',description:'preference, project or progress'},subject:{type:'string',description:'Short topic; include the same topic when correcting'},text:{type:'string',description:'Exact user words to remember'},cwd:{type:'string',description:'Current absolute project path, or empty for general preference/project map'},quote:{type:'string',required:true,description:'Exact quote from current user turn containing the memory request and target'}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute(a,exec){localSession(exec);const result=recall.summary.fromUser({...a,cwd:a.cwd||''},exec.agent);return JSON.stringify({revision:result.revision,savedKey:a.key,action:a.action,persisted:true});}}));
 ctx.tools.register(defineTool({name:'kb_memory_index',description:'Start or inspect an incremental local memory index update. No text is uploaded. Call after new history or imported experience is missing from search; updating can take several minutes on mobile.',parameters:{update:{type:'boolean',description:'true to start update; false to inspect progress'}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute(a,exec){localSession(exec);if(a.update)memory.update();return JSON.stringify(memory.status());}}));
 ctx.tools.register(defineTool({name:'kb_memory_checkpoint',description:'任务结束后，将当前项目内已有验收回执的简短逐字引文保存为项目进度参考；不批准方法、不保存推测，不为保存而编造回执。引用存在不等于实际效果获验收。',parameters:{revision:{type:'number',required:true,description:'Current summary revision'},key:{type:'string',required:true,description:'Stable progress key'},subject:{type:'string',required:true,description:'Short progress topic'},file:{type:'string',required:true,description:'Absolute evidence file inside current project'},quote:{type:'string',required:true,description:'Exact short excerpt, at most 800 characters'}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute(a,exec){localSession(exec);const r=recall.summary.checkpoint(a,exec.agent);return JSON.stringify({revision:r.revision,savedKey:a.key,referenceOnly:true,persisted:true});}}));
}
