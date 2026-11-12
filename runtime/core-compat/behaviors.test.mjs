import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {applyBehaviorCompatibility, behaviorCompatibilityFiles} from './behaviors.mjs';

const runtime = process.env.DSH_COMPAT_RUNTIME;
const work = process.env.DSH_COMPAT_TEST_ROOT;
if (!runtime || !work) throw Error('Set DSH_COMPAT_RUNTIME to a rc.1 candidate and DSH_COMPAT_TEST_ROOT to its registered generated test directory');
fs.mkdirSync(work, {recursive:true});
const modules = path.join(runtime, 'node_modules');
const sdk = name => import(pathToFileURL(path.join(modules, '@deepseek-ai', name, 'lib/index.js')));
const {Context} = await sdk('cordis');
const {default: Sessions, SESSION_FORMAT_VERSION} = await sdk('dsh-session');
const {default: Projections} = await sdk('dsh-session-projection');
const {default: TokenMeter} = await sdk('dsh-token-meter');
const {default: Agents, installModelSelection} = await sdk('dsh-agent');
const {default: Loop} = await sdk('dsh-agent-loop');
const {default: SystemPrompt} = await sdk('dsh-system-prompt');
const {default: Tools} = await sdk('dsh-tools');
const NativeExecutor = await sdk('dsh-tool-executor-native');
const {default: Llm, LlmAdapter, LlmError, createUserMessage} = await sdk('dsh-llm');
const {estimateMessage} = await import(pathToFileURL(path.join(modules, '@deepseek-ai/dsh-token-meter/lib/types/estimate.js')));
const {BasicCompactionEngine} = await sdk('dsh-compaction-basic');
const {transcriptGroups, splitText} = await import(pathToFileURL(path.join(modules, '@deepseek-ai/dsh-compaction-basic/lib/summary-budget.mjs')));
const temporary = prefix => fs.mkdtempSync(path.join(work,prefix));
const message = text => ({role:'user',content:[{type:'text',text}]});
const signal = () => new AbortController().signal;
const answer = '## Primary Request and Intent\n- Implement local audio import.\n## Files and Code\n- LocalAudioBookImporter.kt: check EventBus.\n## Errors and Fixes\n- Verify on disk before resuming.\n## Pending Jobs\n- Compile and test.\n## Next Step\n- Read the current diff; do not repeat an uncertain write.';

function fixture(t, {window=16384, output=1024, stream, persistent=false, config={}}={}) {
  const ctx=new Context(), calls=[];
  ctx.provide('tokenMeter',{estimateMessage});
  ctx.provide('llm',{
    async resolveModelInfo(){return {context:{contextWindow:window},defaultMaxTokens:output};},
    async *stream(options){calls.push(options);if(stream){yield* stream(options,calls.length);return;}
      yield {type:'text-delta',index:0,text:answer};yield {type:'finish',reason:{kind:'stop'}};}
  });
  const engine=new BasicCompactionEngine(ctx,{auto:false,maxTokens:output,...config});
  const agent={options:{provider:'fixture',model:'small'},session:{id:'test-'+Math.random(),requestHeader:()=>({config:{provider:'fixture',model:'small'}}),toolHistory:()=>({tools:[],updates:[]})}};
  if(persistent){const old=process.env.DSH_HOME,home=temporary('dsh-summary-');process.env.DSH_HOME=home;agent.session.header={cwd:home};
    t.after(()=>{if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old;fs.rmSync(home,{recursive:true,force:true});});}
  t.after(()=>ctx.fiber.dispose());
  return {ctx,engine,agent,calls};
}

test('small requests retain cacheable prefix and tools; no main-model or input mutation',async t=>{
  const f=fixture(t),input={messages:[message('original task')],tools:[{name:'read',description:'read',parameters:{}}]},before=structuredClone(input);
  const r=await f.engine.summarize(input,f.agent,signal());
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].messages[0],input.messages[0]);assert.deepEqual(f.calls[0].tools,input.tools);
  assert.deepEqual(input,before);assert.equal(r.model,'small');assert.equal(f.agent.options.model,'small');
});

test('an oversized CJK transcript is split into bounded requests and merged',async t=>{
  const f=fixture(t,{window:262144,output:8192});
  const input={messages:Array.from({length:52},(_,i)=>message(`SOURCE-${i} `+'本地音频导入验证。'.repeat(1400)))};
  const r=await f.engine.summarize(input,f.agent,signal());
  assert(f.calls.length>2);assert.match(r.summary[0].text,/LocalAudioBookImporter/);
  const requests=f.calls.map(c=>JSON.stringify(c.messages));
  for(let i=0;i<52;i++)assert(requests.some(s=>s.includes(`SOURCE-${i} `)),`source ${i} retained`);
  for(const c of f.calls){assert(Buffer.byteLength(JSON.stringify(c.messages))<262144*2);assert.equal(c.purpose,'compaction');assert(!c.tools);assert.equal(c.toolHistory,undefined);}
});

test('provider-confirmed overflow halves the input instead of retrying the same request',async t=>{
  const f=fixture(t,{stream:async function*(o){
    if(JSON.stringify(o.messages).length>14000)throw new LlmError('pi-ai detected context overflow','CONTEXT_WINDOW_EXCEEDED');
    yield {type:'text-delta',index:0,text:answer};yield {type:'finish',reason:{kind:'stop'}};
  }});
  await f.engine.summarize({messages:[message('x'.repeat(45000))]},f.agent,signal());
  assert(f.calls.some(c=>JSON.stringify(c.messages).length>14000));assert(f.calls.some(c=>JSON.stringify(c.messages).length<14000));
  const over=f.calls.filter(c=>JSON.stringify(c.messages).length>14000).map(c=>JSON.stringify(c.messages));
  assert.equal(new Set(over).size,over.length,'no identical rejected requests');
});

test('authentication failure stops without capacity retries',async t=>{
  const f=fixture(t,{stream:async function*(){throw new LlmError('authentication required','AUTH');}});
  await assert.rejects(f.engine.summarize({messages:[message('x'.repeat(70000))]},f.agent,signal()),e=>e.code==='AUTH');assert.equal(f.calls.length,1);
});

test('completed batches survive failure and are reused after a fresh engine starts',async t=>{
  let fail=true;
  const f=fixture(t,{persistent:true,stream:async function*(o,n){if(n===2&&fail)throw new LlmError('local service unavailable','SERVER');yield {type:'text-delta',index:0,text:answer};yield {type:'finish',reason:{kind:'stop'}};}});
  const input={messages:Array.from({length:8},(_,i)=>message(`part ${i} `+'a'.repeat(17000)))};
  await assert.rejects(f.engine.summarize(input,f.agent,signal()),e=>e.code==='SERVER');
  const completed=JSON.stringify(f.calls[0].messages);fail=false;
  const nextCtx=new Context();nextCtx.provide('tokenMeter',f.ctx.tokenMeter);nextCtx.provide('llm',f.ctx.llm);t.after(()=>nextCtx.fiber.dispose());
  const next=new BasicCompactionEngine(nextCtx,{auto:false,maxTokens:1024});await next.summarize(input,f.agent,signal());
  assert.equal(f.calls.filter(c=>JSON.stringify(c.messages)===completed).length,1);
  const p=path.join(process.env.DSH_HOME,'storage/context-recovery');const record=JSON.parse(fs.readFileSync(path.join(p,fs.readdirSync(p)[0])));
  assert(record.reused>0);assert.equal(record.phase,'prepared');assert.match(record.task.originalRequest,/part 0/);
});

test('cancelled and truncated streams never produce a checkpoint summary',async t=>{
  for(const mode of ['cancel','truncated','no-finish']){
    const abort=new AbortController();const f=fixture(t,{stream:async function*(){yield {type:'text-delta',index:0,text:'partial'};if(mode==='cancel')abort.abort();if(mode==='truncated')yield {type:'finish',reason:{kind:'max-tokens'}};}});
    await assert.rejects(f.engine.summarize({messages:[message('task')]},f.agent,abort.signal));
  }
});

test('unknown capacity fails before contacting the provider',async t=>{
  const f=fixture(t);f.ctx.llm.resolveModelInfo=async()=>({});
  await assert.rejects(f.engine.summarize({messages:[message('task')]},f.agent,signal()),e=>e.code==='COMPACTION_CAPACITY_UNKNOWN');assert.equal(f.calls.length,0);
});

test('an explicit summary route is honored without changing the conversation route',async t=>{
  const f=fixture(t,{config:{summarizationProvider:'chosen-summary',summarizationModel:'long-context'}});
  await f.engine.summarize({messages:[message('task')]},f.agent,signal());
  assert.equal(f.calls[0].provider,'chosen-summary');assert.equal(f.calls[0].model,'long-context');assert.equal(f.agent.options.provider,'fixture');
});

test('damaged progress is preserved; changed source never reuses an earlier batch',async t=>{
  const f=fixture(t,{persistent:true}),input={messages:[message('original task')]};
  await f.engine.summarize(input,f.agent,signal());const dir=path.join(process.env.DSH_HOME,'storage/context-recovery'),file=path.join(dir,fs.readdirSync(dir)[0]);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  await f.engine.summarize({messages:[message('different task')]},f.agent,signal());assert.equal(f.calls.length,2);
  fs.writeFileSync(file,'damaged-progress');await f.engine.summarize(input,f.agent,signal());assert.equal(f.calls.length,3);assert.equal(fs.readFileSync(file,'utf8'),'damaged-progress');
});

test('an impossible summary envelope is rejected locally without falsifying capacity',async t=>{
  const f=fixture(t,{window:2048,output:2048});
  await assert.rejects(f.engine.summarize({messages:[message('task')]},f.agent,signal()),e=>e.code==='COMPACTION_ENVELOPE_TOO_LARGE');assert.equal(f.calls.length,0);
});

test('tool pairs stay grouped and oversized Unicode records are losslessly fragmented',()=>{
  const call={role:'assistant',content:[{type:'tool-call',id:'c1',name:'edit',arguments:'{}'}]};
  const result={role:'tool',toolCallId:'c1',content:[{type:'text',text:'observed edit result'}]};
  const groups=transcriptGroups([message('goal'),call,result,message('next')]);assert.equal(groups.length,3);assert(groups[1].includes('observed edit result'));assert(groups[1].includes('"name":"edit"'));
  const text='源码🙂'.repeat(15000),parts=splitText(text,3000);assert.equal(parts.join(''),text);assert(parts.every(p=>!/[\uD800-\uDBFF]$/.test(p)));
});

test('real SDK Session transaction leaves history unchanged on failure, then commits and preserves a paired recent tail',async t=>{
  const home=temporary('dsh-compaction-native-'),ctx=new Context();t.after(async()=>{await ctx.fiber.dispose();fs.rmSync(home,{recursive:true,force:true});});
  let failing=true;const requests=[];
  await ctx.plugin(Llm);class Adapter extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:32768},defaultMaxTokens:1024};}
    async *stream(o){requests.push(o);if(failing)throw new LlmError('fixture authentication required','AUTH');yield {type:'text-delta',index:0,text:answer};yield {type:'finish',reason:{kind:'stop'}};}
  }
  ctx.llm.registerAdapter(['fixture'],new Adapter());await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(TokenMeter);
  await ctx.plugin(BasicCompactionEngine,{auto:false,maxTokens:1024,headroomTokens:2048,retainTokens:2048});const engine=ctx.compaction;
  const session=ctx.sessions.create('native',{meta:{cwd:home}});
  session.append('system/message',{turn:1,step:1,message:{role:'system',content:[{type:'text',text:'Keep user requirements.'}],id:'sys'}},{surfaceOp:'append'});
  session.append('request/header',{header:{config:{provider:'fixture',model:'small'}},reason:'initial'});
  session.append('turn/start',{turn:1});
  for(let i=0;i<20;i++)session.append('user/message',createUserMessage({content:[{type:'text',text:`task ${i} `+'x'.repeat(6000)}],source:{kind:'user'}}),{surfaceOp:'append'});
  session.append('step/start',{turn:1,step:1});
  session.append('assistant/message',{turn:1,step:1,message:{role:'assistant',id:'read-call',content:[{type:'tool-call',id:'paired-read',name:'read',arguments:'{}'}]},stream:[]},{surfaceOp:'append'});
  session.append('tool/result',{turn:1,step:1,message:{role:'tool',id:'read-result',toolCallId:'paired-read',content:[{type:'text',text:'retained actual result '+'x'.repeat(9000)}],isError:false}},{surfaceOp:'append'});
  session.append('step/end',{turn:1,step:1});
  const a={session,options:{provider:'fixture',model:'small'}};const surface=[...session.surface.nodes];
  await assert.rejects(engine.compactIfNeeded(a,'pressure',signal()),e=>e.code==='AUTH');assert.deepEqual(session.surface.nodes,surface);assert(!session.snapshotEvents().some(e=>e.type==='compaction/summary'));
  failing=false;const result=await engine.compactIfNeeded(a,'pressure',signal());assert(result);assert(session.surface.nodes.length<surface.length);assert.equal(session.surface.nodes[0],surface[0]);assert.equal(session.surface.nodes.at(-1),surface.at(-1));
  assert(session.surface.nodes.includes(surface.at(-2)),'call kept with recent result');assert(ctx.tokenMeter.measure(session).totalTokens<32768);assert(requests.every(r=>r.purpose==='compaction'));
});

test('the real Agent loop compacts for the selected model, then executes one tool and completes',async t=>{
  const home=fs.realpathSync(temporary('dsh-compaction-loop-')),ctx=new Context();
  let handle; t.after(async()=>{await handle?.dispose();await ctx.fiber.dispose();fs.rmSync(home,{recursive:true,force:true});});
  const calls=[];let reads=0;
  await ctx.plugin(Llm);class Adapter extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:id==='large'?1000000:32768},defaultMaxTokens:1024};}
    async *stream(o){calls.push(o);
      if(o.purpose==='compaction'){yield {type:'text-delta',index:0,text:answer};}
      else if(o.messages.some(m=>m.role==='tool')){yield {type:'text-delta',index:0,text:'Completed after reading the actual fixture.'};}
      else {yield {type:'tool-call-delta',index:0,id:'read-after-compaction',name:'read',argumentsDelta:'{}'};yield {type:'finish',reason:{kind:'tool-calls'}};return;}
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Adapter());await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(TokenMeter);
  await ctx.plugin(Agents);await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await ctx.plugin(NativeExecutor);await ctx.plugin(Loop);
  await ctx.plugin(BasicCompactionEngine,{maxTokens:1024,headroomTokens:2048,retainTokens:2048});
  ctx.tools.register({name:'read',description:'Read the local fixture',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:()=>{reads++;return 'actual fixture read';}});
  const seed=ctx.sessions.create('seed');seed.append('request/header',{header:{config:{provider:'fixture',model:'large',maxTokens:256000},adapterDefaults:{maxTokens:true}},reason:'initial'});
  seed.append('turn/start',{turn:1});
  for(let i=0;i<18;i++)seed.append('user/message',createUserMessage({content:[{type:'text',text:`history ${i} `+'x'.repeat(9000)}],source:{kind:'user'}}),{surfaceOp:'append'});
  seed.append('turn/end',{turn:1,reason:{kind:'completed'}});seed.append('model/selection',{provider:'fixture',model:'small'});
  handle=await ctx.agents.create({sessionId:'compaction-loop',seed:seed.snapshotEvents(),meta:{cwd:home},agentOptions:{provider:'fixture',model:'large'},setup:agentCtx=>{installModelSelection(agentCtx);}});
  const agent=handle.agent;agent.followup(createUserMessage({content:[{type:'text',text:'Read the local fixture once and report the observed result.'}],source:{kind:'user'}}));await agent.whenIdle();
  const events=agent.session.snapshotEvents(),end=events.filter(e=>e.type==='turn/end').at(-1);
  assert.equal(end.data.reason.kind,'completed',JSON.stringify(end.data));assert.equal(reads,1);
  assert(events.some(e=>e.type==='compaction/summary'),'automatic compaction committed');
  const main=calls.filter(c=>c.purpose!=='compaction');assert.equal(main.length,2);assert(main.every(c=>c.model==='small'));assert(calls.filter(c=>c.purpose==='compaction').every(c=>c.model==='large'));
  assert(calls.indexOf(main[0])>0,'summaries precede the first main request');
  assert(main.every(c=>c.messages.reduce((n,m)=>n+estimateMessage(m),0)+(c.maxTokens??1024)<32768),'input plus reserved output fits the new window');
  assert(main[0].messages.some(m=>JSON.stringify(m).includes('Read the local fixture once')),'latest user task survives');
  assert.equal(events.filter(e=>e.type==='tool/result').length,1);
});

// Use a generated module with a symlink to the candidate dependency closure;
// do not place test exports in the runtime package or load user profiles.
const introspection = temporary('pi-ai-');
fs.symlinkSync(modules,path.join(introspection,'node_modules'));
const piFile = path.join(introspection,'pi.mjs');
fs.writeFileSync(piFile,fs.readFileSync(path.join(modules,'@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),'utf8')+'\nexport {resolveProfiles,readListing,mapStopReason};\n');
const pi = await import(pathToFileURL(piFile));
test.after(()=>fs.rmSync(introspection,{recursive:true,force:true}));
function relay(models,extra={}) {
 const profiles=pi.resolveProfiles({'fixture-relay':{api:'openai-completions',baseURL:'http://127.0.0.1:1/v1',models,...extra}});
 return new pi.PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>undefined});
}
test('relay modalities use exact catalog IDs and endpoint declarations while explicit text and unknown aliases remain bounded',async()=>{
 const a=relay([{id:'gpt-6.1-sol'},{id:'claude-opus-4-6'},{id:'gpt-6.1-sol-alias'},{id:'glm-5.3-flash',input:['text']}]);
 for(const id of ['gpt-6.1-sol','claude-opus-4-6']) assert((await a.resolveModel('fixture-relay',id)).inputModalities.includes('image'));
 assert.deepEqual((await a.resolveModel('fixture-relay','gpt-6.1-sol-alias')).inputModalities,['text']);
 assert.deepEqual((await a.resolveModel('fixture-relay','glm-5.3-flash')).inputModalities,['text']);
 const rows=pi.readListing({data:[{id:'custom-image',architecture:{input_modalities:['text','image']}},{id:'gpt-6.1-sol',input:['text']},{id:'gpt-6.1-sol'},{id:'unknown',input:['bogus']}]},'openai-completions');
 assert.deepEqual(rows[0].inputModalities,['text','image']); assert.deepEqual(rows[1].inputModalities,['text']);
 assert.deepEqual(rows[2].inputModalities,['text','image']);assert.equal(rows[3].inputModalities,undefined);
 assert.throws(()=>pi.readListing({error:'failed'}),/model listing/);assert.equal(pi.readListing({data:[{id:'retry'}]},'openai-completions')[0].id,'retry');
});
test('gateway quota and temporary restriction classifications retain status and do not swallow ordinary auth/rate failures',()=>{
 const cases=[
  ['429: {"error":{"type":"gateway_error","code":"42907","message":"Credits不足"}}','QUOTA',429],
  ['429: {"type":"gateway_error","code":"42906"}','QUOTA',429],
  ['429: {"error":{"type":"gateway_error","code":"42905"}}','RATE_LIMIT',429],
  ['403: {"type":"gateway_error","code":"40303","message":"稍后重试"}','UPSTREAM_RESTRICTED',403],
  ['401: {"type":"gateway_error","code":"40303"}','AUTH',401],
  ['403: not json','AUTH',403], ['403: {"type":"other","code":"40303"}','AUTH',403],
  ['429: {"type":"other","code":"42907"}','RATE_LIMIT',429], ['network text 40303','TRANSPORT',undefined],
 ];
 for(const [text,code,status]of cases){const result=pi.mapStopReason({stopReason:'error',content:[],errorMessage:text},65536);assert.equal(result.failure.code,code,text);assert.equal(result.failure.status,status);}
 const r=pi.mapStopReason({stopReason:'error',content:[],errorMessage:cases[3][0]},65536);assert.equal(r.failure.message,'稍后重试');
});
test('real pi-ai HTTP adapter returns quota once and recovers with a later successful local response',async t=>{
 let error=true,count=0;
 const server=createServer(async(req,res)=>{for await(const _ of req){} count++;
  if(error){res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'gateway_error',code:'42907',message:'Credits不足'}}));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  const c={id:'fixture',object:'chat.completion.chunk',model:'fixture-model',choices:[{index:0,delta:{role:'assistant',content:'ready'},finish_reason:null}]};
  res.write('data: '+JSON.stringify(c)+'\n\n');res.write('data: '+JSON.stringify({...c,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})+'\n\n');res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const profiles=pi.resolveProfiles({fixture:{api:'openai-completions',baseURL:'http://127.0.0.1:'+server.address().port+'/v1',models:[{id:'fixture-model'}]}});
 const adapter=new pi.PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=> 'local-fixture'});
 const options={provider:'fixture',model:'fixture-model',messages:[createUserMessage({content:[{type:'text',text:'fixture'}],source:{kind:'user'}})],maxTokens:32};
 let chunks=[];for await(const chunk of adapter.stream(options))chunks.push(chunk);
 assert.equal(count,1);assert.equal(chunks.at(-1).reason.failure.code,'QUOTA');assert.equal(chunks.at(-1).reason.failure.status,429);
 assert(!adapter.providerRetryPolicy('fixture').retryableCodes.includes('QUOTA'));error=false;chunks=[];
 for await(const chunk of adapter.stream(options))chunks.push(chunk);assert.equal(count,2);assert.equal(chunks.at(-1).reason.kind,'stop');
});
test('upstream instruction renderer retains separate global/project chains and bounded UTF8 diagnostics',async()=>{
 const {renderAgentInstructions:render}=await sdk('dsh-agent-instructions');
 const file=(displayPath,content)=>({absolutePath:'/fixture/'+displayPath,displayPath,content});
 const files=[file('$DSH_HOME/AGENTS.md','GLOBAL-KEEP'),file('AGENTS.md','PROJECT-MARK '+'源码🙂'.repeat(2000))];
 const result=render(files,{maxBytes:1500});assert(result.text.includes('GLOBAL-KEEP'));assert(result.text.includes('PROJECT-MARK'));assert(Buffer.byteLength(result.text)<=3000);assert(!result.text.includes('\ufffd'));
 for(const maxBytes of [0,1,80,300,1000,8000]){const r=render(files,{maxBytes});assert(Buffer.byteLength(r.text)<=2*maxBytes);}
});

test('one native model-switch listener remains; pressure failures have a finite per-turn budget and idle resets it',async t=>{
 const ctx=new Context(),hooks={},registrations=[];t.after(()=>ctx.fiber.dispose());const on=ctx.on.bind(ctx);
 ctx.on=(name,fn,...args)=>{registrations.push(name);hooks[name]=fn;return on(name,fn,...args);};
 ctx.provide('tokenMeter',{estimateMessage});ctx.provide('llm',{});
 const engine=new BasicCompactionEngine(ctx,{compactionRetries:1});let attempts=0,admitted=0;
 assert.equal(registrations.filter(name=>name==='agent/request').length,1,'the upstream model-switch hook is registered exactly once');
 engine.compactIfNeeded=async()=>{attempts++;throw new LlmError('fixture unavailable','SERVER');};
 const agent={options:{provider:'fixture',model:'small'},session:{requestHeader:()=>({config:{provider:'fixture',model:'small'}})}};
 const run=()=>hooks['agent/pre-step']({agent,signal:signal()},()=>{admitted++;});
 await run();assert.equal(attempts,1);await assert.rejects(run,e=>e.code==='COMPACTION_FAILED');assert.equal(attempts,2);
 await assert.rejects(run,e=>e.code==='COMPACTION_FAILED');assert.equal(attempts,2);assert.equal(admitted,1);
 hooks['agent/status']({agent,status:'idle'});await run();assert.equal(attempts,3);
 hooks['agent/status']({agent,status:'idle'});engine.compactIfNeeded=async()=>{throw Object.assign(Error('over capacity'),{compactionUnsafe:true});};
 await assert.rejects(run,e=>e.code==='COMPACTION_FAILED');
});

function pristine(t) {
 const originals=path.join(work,'originals');
 if(!fs.existsSync(originals))throw Error('Place verified published rc.1 index.js files under DSH_COMPAT_TEST_ROOT/originals');
 const fixture=temporary('patch-');t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
 fs.mkdirSync(path.join(fixture,'node_modules/@deepseek-ai/dsh'),{recursive:true});
 fs.writeFileSync(path.join(fixture,'node_modules/@deepseek-ai/dsh/package.json'),JSON.stringify({version:'0.2.2-rc.1'}));
 for(const name of behaviorCompatibilityFiles.filter(x=>x.endsWith('index.js'))){const target=path.join(fixture,'node_modules',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(originals,name),target);}
 return fixture;
}
const snapshot = runtime => new Map(behaviorCompatibilityFiles.map(name=>{const f=path.join(runtime,'node_modules',name);return [name,fs.existsSync(f)?fs.readFileSync(f):null];}));
const assertSnapshot = (runtime,expected) => {for(const [name,value]of expected){const file=path.join(runtime,'node_modules',name);if(value===null)assert(!fs.existsSync(file),name);else assert.deepEqual(fs.readFileSync(file),value,name);}};
test('exact published rc.1 behavior patches apply once and remain idempotent',async t=>{
 const fixture=pristine(t);assert.equal((await applyBehaviorCompatibility(fixture)).changed,11);assert.equal((await applyBehaviorCompatibility(fixture)).changed,0);
});
test('unknown bytes are refused before any earlier file is written',async t=>{
 const fixture=pristine(t),last=path.join(fixture,'node_modules',behaviorCompatibilityFiles[7]);fs.appendFileSync(last,'\n// external work\n');
 const before=snapshot(fixture);await assert.rejects(applyBehaviorCompatibility(fixture),/未知改动/);assertSnapshot(fixture,before);
});
test('a mid-publication failure restores original indexes and removes newly published helpers',async t=>{
 const fixture=pristine(t),before=snapshot(fixture);
 await assert.rejects(applyBehaviorCompatibility(fixture,{beforeWrite({index}){if(index===10)throw Error('fixture disk write failure');}}),/fixture disk write failure/);
 assertSnapshot(fixture,before);assert.equal((await applyBehaviorCompatibility(fixture)).changed,11);
});
test('a concurrent edit is retained while previously published task files roll back',async t=>{
 const fixture=pristine(t),before=snapshot(fixture),second=path.join(fixture,'node_modules',behaviorCompatibilityFiles[1]);
 await assert.rejects(applyBehaviorCompatibility(fixture,{beforeWrite({index}){if(index===1)fs.appendFileSync(second,'\n// concurrent owner\n');}}),/并发修改/);
 before.set(behaviorCompatibilityFiles[1],fs.readFileSync(second));assertSnapshot(fixture,before);
});

test('real JSONL delete helpers close owned handles, decode zstd and reject a symlink without touching its target',async t=>{
 const directory=temporary('jsonl-'),ctx=new Context();t.after(async()=>{await ctx.fiber.dispose();fs.rmSync(directory,{recursive:true,force:true});});
 const Jsonl=await sdk('dsh-session-persistence-jsonl');await ctx.plugin(Jsonl,{root:path.join(directory,'sessions'),compression:'zstd'});
 const persistence=ctx.sessionPersistence,header={id:'delete-me',version:SESSION_FORMAT_VERSION,createdAt:1,cwd:directory,isSeeded:false};
 const kept={...header,id:'keep-me'},handle=await persistence.create(header),other=await persistence.create(kept);
 await handle.flush();await other.flush();await other.close();
 const file=persistence.locate(header).path,compressed=fs.readFileSync(file);
 assert(persistence.decodeDeletionLog(compressed,true).includes('delete-me'));
 assert.equal(persistence.decodeDeletionLog(Buffer.from('plain'),false),'plain');
 assert.throws(()=>persistence.decodeDeletionLog(compressed.subarray(0,compressed.length-2),true),/不完整|zstd|frame|corrupt/i);
 await persistence.preparePermanentDeletion([header.id]);await assert.rejects(handle.read());
 await persistence.removePermanently(header);assert.equal(await persistence.stat(header.id),undefined);assert(await persistence.stat(kept.id));
 const escape={...header,id:'symlink-me'},link=path.dirname(persistence.locate(escape).path),protectedDir=path.join(directory,'protected');
 fs.mkdirSync(protectedDir);fs.writeFileSync(path.join(protectedDir,'sentinel'),'original');fs.symlinkSync(protectedDir,link);
 await assert.rejects(persistence.removePermanently(escape),/Unsafe session directory/);assert.equal(fs.readFileSync(path.join(protectedDir,'sentinel'),'utf8'),'original');
});

test('real SQLite permanent forgetting removes only selected live/persisted search rows and prepared cache',async t=>{
 const directory=temporary('sqlite-'),ctx=new Context();t.after(async()=>{await ctx.fiber.dispose();fs.rmSync(directory,{recursive:true,force:true});});
 await ctx.plugin(Sessions);const {default:Sqlite}=await sdk('dsh-session-query-sqlite');await ctx.plugin(Sqlite,{path:path.join(directory,'search.sqlite'),journalMode:'wal'});
 const query=ctx.sessionQuery;
 for(const id of ['delete-me','keep-me']){
  const entry={header:{id,version:SESSION_FORMAT_VERSION,createdAt:1,cwd:directory,isSeeded:false},inheritedEventCount:0,documents:[{text:'private '+id,sessionId:id,seq:0,type:'user/message',time:1,surface:'current'}],fingerprint:'fixture'};
  query._replacePersistedSession(entry,'revision',1);query._replaceLiveSession(entry,1,true);query._observations.cache.set(id,{fixture:id});
 }
 await query.forgetPermanently(['delete-me']);
 for(const table of ['persisted_sessions','temp.live_sessions']){assert.equal(query._db.prepare('SELECT COUNT(*) AS count FROM '+table+' WHERE id = ?').get('delete-me').count,0);assert.equal(query._db.prepare('SELECT COUNT(*) AS count FROM '+table+' WHERE id = ?').get('keep-me').count,1);}
 for(const table of ['persisted_docs','temp.live_docs']){assert.equal(query._db.prepare('SELECT COUNT(*) AS count FROM '+table+' WHERE session_id = ?').get('delete-me').count,0);assert.equal(query._db.prepare('SELECT COUNT(*) AS count FROM '+table+' WHERE session_id = ?').get('keep-me').count,1);}
 assert(!query._observations.cache.has('delete-me'));assert(query._observations.cache.has('keep-me'));
});
