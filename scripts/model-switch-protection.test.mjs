import test from 'node:test';import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';import Llm,{LlmAdapter,LlmError,createUserMessage} from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';import Projections from '@deepseek-ai/dsh-session-projection';import TokenMeter from '@deepseek-ai/dsh-token-meter';
import {BasicCompactionEngine} from '../runtime/overlays/@deepseek-ai/dsh-compaction-basic/lib/index.js';

async function fixture(t){
 const ctx=new Context(),calls=[],hooks={},on=ctx.on.bind(ctx);ctx.on=(event,fn,...rest)=>{if(event==='agent/request')hooks.request=fn;return on(event,fn,...rest);};t.after(()=>ctx.fiber.dispose());
 let failure=false;
 await ctx.plugin(Llm);class Adapter extends LlmAdapter{
  async resolveModel(provider,id){return{provider,id,name:id,context:{contextWindow:id==='old'?1000000:32768},defaultMaxTokens:1024};}
  async *stream(o){calls.push(o);if(failure)throw new LlmError('fixture old-model outage','SERVER');yield{type:'text-delta',index:0,text:'Summary of the original task, exact constraints, current progress and next safe action.'};yield{type:'finish',reason:{kind:'stop'}};}
 }
 ctx.llm.registerAdapter(['fixture'],new Adapter());await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(TokenMeter);
 const session=ctx.sessions.create('switch-protection');session.append('request/header',{header:{config:{provider:'fixture',model:'old'}},reason:'initial'});session.append('turn/start',{turn:1});
 for(let i=0;i<16;i++)session.append('user/message',createUserMessage({content:[{type:'text',text:'source-'+i+'x'.repeat(16000)}],source:{kind:'user'}}),{surfaceOp:'append'});
 const agent={session,options:{provider:'fixture',model:'old'}},engine=new BasicCompactionEngine(ctx,{maxTokens:1024,headroomTokens:2048,retainTokens:2048});
 return{ctx,calls,hooks,session,agent,engine,fail:value=>failure=value};
}
test('request-time route change uses previous model and admits the selected model only after compaction',async t=>{
 const f=await fixture(t),config={provider:'fixture',model:'small'};const result=await f.hooks.request({agent:f.agent,signal:new AbortController().signal},async()=>config);
 assert.equal(result,config);assert.ok(f.calls.length);assert.ok(f.calls.every(c=>c.model==='old'));assert.equal(f.session.requestHeader().config.model,'old');assert.ok(f.session.snapshotEvents().some(e=>e.type==='compaction/summary'));
});
test('failed switch preserves header and history; a later retry can recover without provider substitution',async t=>{
 const f=await fixture(t),before=f.session.surface.nodes.map(x=>x.seq);f.fail(true);
 await assert.rejects(f.hooks.request({agent:f.agent,signal:new AbortController().signal},async()=>({provider:'fixture',model:'small'})),e=>e.code==='MODEL_SWITCH_COMPACTION_FAILED');
 assert.equal(f.session.requestHeader().config.model,'old');assert.deepEqual(f.session.surface.nodes.map(x=>x.seq),before);assert.ok(f.calls.every(c=>c.model==='old'));
 f.fail(false);await f.hooks.request({agent:f.agent,signal:new AbortController().signal},async()=>({provider:'fixture',model:'small'}));assert.ok(f.session.surface.nodes.length<before.length);
});
test('unchanged route adds no summary calls and cancelled switch leaves the original history intact',async t=>{
 const f=await fixture(t),config={provider:'fixture',model:'old'};assert.equal(await f.hooks.request({agent:f.agent,signal:new AbortController().signal},async()=>config),config);assert.equal(f.calls.length,0);
 const abort=new AbortController();abort.abort();const next={provider:'fixture',model:'small'};assert.equal(await f.hooks.request({agent:f.agent,signal:abort.signal},async()=>next),next);assert.equal(f.calls.length,0);assert.equal(f.session.requestHeader().config.model,'old');
});
