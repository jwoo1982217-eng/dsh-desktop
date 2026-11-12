import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {Constellation} from '../data.mjs';
import {UnifiedMemory,ReadOnlySummary} from '../../knowledge-workbench/src/memory.js';
import {createHttp} from '../http.mjs';
import {createTools} from '../tools.mjs';
import {install} from '../install.mjs';
import {Notes} from '../../knowledge-workbench/src/notes.js';
const root=process.env.DSH_CONSTELLATION_TEST_ROOT;
assert(root&&path.isAbsolute(root),'Set test root to registered generated/');fs.mkdirSync(root,{recursive:true});
const modules='/Applications/DSH.app/Contents/Resources/runtime/node_modules';
const req=createRequire(path.join(modules,'@deepseek-ai/dsh/package.json'));
const {defineTool}=await import(req.resolve('@deepseek-ai/dsh-tools'));
function fixture(t){
  const home=fs.mkdtempSync(path.join(root,'case-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const notes=new Notes(home),summary=new ReadOnlySummary(home);let mode='related';
  const a=notes.save({title:'DSH 知识库',body:'[[语音方案]]\n本地记忆检索方案',tags:['DSH'],project:home}),b=notes.save({title:'语音方案',body:'克隆的正文',tags:['DSH'],project:home});
  const gone=notes.save({title:'应删除',body:'秘密删除内容',tags:[]});notes.trash(gone.id,gone.revision);
  const foreign=notes.save({title:'其他项目',body:'别的项目记忆',tags:[],project:path.join(home,'other')});
  fs.writeFileSync(summary.file,JSON.stringify({version:1,revision:1,entries:[{key:'preferences',kind:'preference',subject:'文字偏好',text:'请用中文回答',cwd:'',source:{kind:'user-quote',quote:'请记住：请用中文回答'}}],suppressed:[]}));
  const link={recall:{summary,mode:()=>mode,shared:()=>({enabled:true,sources:['dsh']})}};
  const kb={notes,schedule(){}};const ctx={get:name=>({dshKnowledgeWorkbench:kb,dshKnowledgeLink:link}[name])};kb.memory=new UnifiedMemory(ctx,{home,kb});t.after(()=>kb.memory.close());
  return {home,notes,summary,service:new Constellation(ctx),a,b,foreign,setMode:v=>{mode=v;},exec:{agent:{session:{id:'local-test',header:{cwd:home}}}}};
}
test('read-through graph preserves exact real Notes edges, content and source; no source writes',async t=>{
  const f=fixture(t),file=path.join(f.home,'knowledge/workbench/state.json'),before=fs.readFileSync(file),d=f.service.page();
  assert.equal(d.total,4);assert(d.items.some(n=>n.id==='summary:preferences'));assert(!d.items.some(n=>n.title==='应删除'));
  assert.deepEqual(d.edges,f.notes.graph().edges.map(e=>({...e,from:'knowledge:'+e.from,to:'knowledge:'+e.to})));
  const found=await f.service.search('知识库');assert.equal(found[0].id,'knowledge:'+f.a.id);assert.equal(found[0].related[0].id,'knowledge:'+f.b.id);
  assert.equal(f.service.read(found[0].related[0].id).content,'克隆的正文');assert.deepEqual(fs.readFileSync(file),before);
});
test('correction and deletion are reflected immediately without reindexing; no stale cache',t=>{
  const f=fixture(t),old=f.service.page();f.notes.save({...f.notes.read(f.a.id),body:'更新后的原文'});assert.notEqual(f.service.page().mtime,old.mtime);
  const note=f.notes.read(f.b.id);f.notes.trash(note.id,note.revision);assert.throws(()=>f.service.read('knowledge:'+note.id),/不存在/);
  f.service.mutate({action:'forget',id:'summary:preferences',revision:1});assert(!f.service.page().items.some(n=>n.id==='summary:preferences'));
});
test('real SDK tool schemas execute scoped search/read; off, QQ, subagent and frozen memory denied',async t=>{
  const f=fixture(t),[search,read]=createTools(f.service,defineTool);
  assert.equal(search.name,'memory_constellation_search');const result=JSON.parse(await search.execute({query:'知识库'},f.exec));assert(result.items.length);
  f.setMode('project');const access=f.service.access(f.exec);assert(!f.service.snapshot({access}).items.some(n=>n.id==='knowledge:'+f.foreign.id));
  await assert.rejects(()=>read.execute({id:'knowledge:'+f.foreign.id},f.exec),/范围/);
  for(const session of [{id:'qq-dm-1',header:{}},{id:'local',header:{origin:'subagent'}},{id:'local',header:{delegationDepth:1}}])await assert.rejects(()=>search.execute({query:'DSH'},{agent:{session}}),/本机主会话/);
  f.setMode('off');await assert.rejects(()=>search.execute({query:'DSH'},f.exec),/关闭/);f.setMode('related');
  const freeze=path.join(f.home,'experience/verified-improvement/.frozen.json');fs.mkdirSync(path.dirname(freeze),{recursive:true});fs.writeFileSync(freeze,'{}');assert.throws(()=>f.service.page(),/暂停/);
  fs.unlinkSync(freeze);assert(f.service.page().total>0);
});
test('malformed summary fails visibly and recovers without source changes',t=>{
  const f=fixture(t),file=f.summary.file,old=fs.readFileSync(file);fs.writeFileSync(file,'broken');assert.throws(()=>f.service.page(),/读取失败/);assert.equal(fs.readFileSync(file,'utf8'),'broken');fs.writeFileSync(file,old);assert(f.service.page().total>0);
});
test('authenticated HTTP read, revision check, arbitrary path rejection, remote/origin/unauthenticated denial',t=>{
  const f=fixture(t);const handle=createHttp({requestRejection:r=>r.headers.cookie==='valid'?undefined:401},f.service,new Map());
  const call=(url,extra={})=>{let status,body;const req={url,method:'GET',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:3080',cookie:'valid'},...extra};handle(req,{writeHead:s=>{status=s;},end:v=>{body=JSON.parse(v);}});return {status,body};};
  const ok=call('/meow-constellation/api/memories');assert.equal(ok.status,200);assert.equal(call('/meow-constellation/api/memories?since='+ok.body.mtime).body.unchanged,true);
  assert.equal(call('/meow-constellation/api/memories?dir=/etc').status,400);
  assert.equal(call('/meow-constellation/api/memories',{socket:{remoteAddress:'192.168.0.1'}}).status,403);
  assert.equal(call('/meow-constellation/api/memories',{headers:{host:'127.0.0.1:3080'}}).status,401);
  assert.equal(call('/meow-constellation/api/memories',{headers:{host:'127.0.0.1:3080',cookie:'valid',origin:'https://evil.test'}}).status,403);
  assert.equal(call('/meow-constellation/api/memories',{method:'POST'}).status,405);
  assert.equal(call('/meow-constellation/api/memories').status,200);
});
test('installer adds only own bundle; installation is repeatable; unknown same-name package preserved',t=>{
  const home=fs.mkdtempSync(path.join(root,'install-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const profile=path.join(home,'profiles/web');fs.mkdirSync(profile,{recursive:true});const original={dependencies:{existing:'file:/unchanged'},dsh:{profile:{bundles:['existing']}},custom:'keep'};fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify(original));
  const result=install(home,modules);assert(fs.existsSync(result.backup));const current=JSON.parse(fs.readFileSync(path.join(profile,'package.json')));delete current.dependencies['dsh-meow-constellation'];current.dsh.profile.bundles.pop();assert.deepEqual(current,original);assert(install(home,modules).unchanged);
  fs.writeFileSync(path.join(result.target,'page.js'),'independent edit');assert.throws(()=>install(home,modules),/同名插件/);assert.equal(fs.readFileSync(path.join(result.target,'page.js'),'utf8'),'independent edit');
});
test('installer injected post-commit failure restores original manifest and removes only own installation',t=>{
  const home=fs.mkdtempSync(path.join(root,'rollback-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const profile=path.join(home,'profiles/web');fs.mkdirSync(profile,{recursive:true});const original=JSON.stringify({dsh:{profile:{bundles:[]}},custom:'preserved'});const file=path.join(profile,'package.json');fs.writeFileSync(file,original);
  assert.throws(()=>install(home,modules,{afterCommit:()=>{throw Error('injected failure');}}),/injected/);assert.equal(fs.readFileSync(file,'utf8'),original);assert(!fs.existsSync(path.join(profile,'node_modules/dsh-meow-constellation')));
});

test('actual rc1 ToolRuntime registers and executes both tools, validates arguments and denies disabled memory',async t=>{
  const f=fixture(t),load=async name=>import(req.resolve('@deepseek-ai/'+name));
  const {Context}=await load('cordis'),ctx=new Context();t.after(()=>ctx.fiber.dispose());
  for(const name of ['dsh-llm','dsh-session','dsh-session-projection','dsh-agent','dsh-system-prompt','dsh-tools','dsh-agent-loop'])await ctx.plugin((await load(name)).default);
  await ctx.plugin(await load('dsh-tool-executor-native'));
  for(const tool of createTools(f.service,defineTool))ctx.tools.register(tool);
  const {agent}=await ctx.agents.create({sessionId:'constellation-native',meta:{cwd:f.home},agentOptions:{provider:'fixture',model:'local-only'}});
  const signal=new AbortController().signal,toolSet=await ctx.tools.resolve({agent,signal,modelSelection:{provider:'fixture',model:'local-only'}});t.after(()=>toolSet.dispose());
  const invoke=async(name,args)=>(await ctx.tools.execute({agent,toolSet,signal,calls:[{type:'tool-call',id:'check-'+name,name,arguments:JSON.stringify(args)}]})).results[0].result;
  const result=await invoke('memory_constellation_search',{query:'知识库'});assert.equal(result.isError,false);
  const found=JSON.parse(result.value);assert.equal(found.items[0].id,'knowledge:'+f.a.id);
  const detail=await invoke('memory_constellation_read',{id:found.items[0].related[0].id});assert.equal(detail.isError,false);assert.equal(JSON.parse(detail.value).item.content,'克隆的正文');
  assert.equal((await invoke('memory_constellation_search',{query:123})).isError,true);
  f.setMode('off');assert.equal((await invoke('memory_constellation_search',{query:'DSH'})).isError,true);
  f.setMode('related');assert.equal((await invoke('memory_constellation_search',{query:'DSH'})).isError,false);
});

test('legacy recall API works without undeployed summary service, and missing summary remains empty',async t=>{
  const f=fixture(t),{AutomaticRecall}=await import('../../peer/knowledge-link/automatic-recall.mjs');
  const recall=new AutomaticRecall(f.home,{status:()=>({index:{indexed:true}})});t.after(()=>recall.close());
  assert.equal(recall.summary,undefined);
  const service=new UnifiedMemory({get:n=>({dshKnowledgeWorkbench:{notes:f.notes},dshKnowledgeLink:{recall}}[n])},{home:f.home});
  assert.equal(service.page().total,4);assert.throws(()=>service.access(f.exec),/关闭/);recall.config.defaultMode='related';assert.equal(service.access(f.exec).mode,'related');
  fs.unlinkSync(f.summary.file);assert.equal(service.page().total,3);assert(!fs.existsSync(f.summary.file));
  fs.writeFileSync(f.summary.file,'invalid');assert.throws(()=>service.page(),/读取失败/);fs.unlinkSync(f.summary.file);assert.equal(service.page().total,3);
  const reader=new ReadOnlySummary(f.home);assert.equal(reader.status().fault,'');
});

test('owned upgrade retains old program and rolls back exact previous link and manifest on failure',t=>{
  const home=fs.mkdtempSync(path.join(root,'upgrade-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const profile=path.join(home,'profiles/web');fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({dsh:{profile:{bundles:[]}}}));
  const first=install(home,modules),before=fs.readFileSync(path.join(profile,'package.json')),source=path.join(home,'source');fs.cpSync(new URL('../',import.meta.url),source,{recursive:true});fs.appendFileSync(path.join(source,'page.js'),'\n// upgrade fixture');
  assert.throws(()=>install(home,modules,{source,replaceFingerprint:first.fingerprint,afterCommit:()=>{throw Error('upgrade failure');}}),/upgrade failure/);
  assert.deepEqual(fs.readFileSync(path.join(profile,'package.json')),before);assert.equal(fs.realpathSync(first.link),first.target);
  // Recovery artifacts are retained; use a different candidate fingerprint for retry.
  fs.appendFileSync(path.join(source,'page.js'),'\n// corrected candidate');const second=install(home,modules,{source,replaceFingerprint:first.fingerprint});assert.notEqual(second.target,first.target);assert(fs.existsSync(first.target));assert.equal(fs.realpathSync(first.link),second.target);
});
