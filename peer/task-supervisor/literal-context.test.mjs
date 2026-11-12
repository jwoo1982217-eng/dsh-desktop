import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt, {renderContextSections} from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Llm, {LlmAdapter, createUserMessage} from '@deepseek-ai/dsh-llm';
import {applyTaskSupervisor} from './index.mjs';

async function fixture(t) {
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsh-supervisor-literal-')));
  const previous=process.env.DSH_HOME;
  process.env.DSH_HOME=home;
  const ctx=new Context();
  let handle;
  t.after(async()=>{
    await handle?.dispose();
    await ctx.fiber.dispose();
    if(previous===undefined)delete process.env.DSH_HOME;
    else process.env.DSH_HOME=previous;
    fs.rmSync(home,{recursive:true,force:true});
  });
  const calls=[];
  ctx.provide('connection',{rpc:{handle(){}}});
  ctx.provide('webServer',{register(){return()=>{};}});
  await ctx.plugin(Llm);
  class FixtureAdapter extends LlmAdapter {
    async *stream(options) {
      calls.push(options);
      yield {type:'text-delta',index:0,text:'Fixture completed'};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['fixture'],new FixtureAdapter());
  for(const plugin of [Sessions,Projections,Agents,SystemPrompt,Tools,Loop])await ctx.plugin(plugin);
  const service=applyTaskSupervisor(ctx);
  service.store.configure({revision:0,learning:false,swarm:false,continuity:true});
  handle=await ctx.agents.create({sessionId:'literal-context-main',meta:{cwd:home},agentOptions:{provider:'fixture',model:'literal-model'}});
  return {ctx,service,agent:handle.agent,calls};
}

test('native supervised turns preserve task placeholders without interpreting them',async t=>{
  const {service,agent,calls}=await fixture(t);
  const literal='Keep {{name}}, {{page}}, {{provider}}, {{{{nested}}}}, {{bad name}}, $&, and a lone {{ exactly as written.';
  agent.followup(createUserMessage({content:[{type:'text',text:literal}],source:{kind:'user'}}));
  await agent.whenIdle();
  assert.equal(service.latest(agent).endReason,'completed',JSON.stringify(agent.session.snapshotEvents().slice(-2)));
  assert.equal(calls.length,1);
  assert.equal(service.latest(agent).board.facts[0].content,literal);
  const sent=calls[0].messages.flatMap(m=>m.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
  assert.ok(sent.includes('当前任务状态：'));
  assert.ok(sent.includes(literal),'supervisor context must retain literal placeholders and special characters');
});

test('literal supervisor context does not relax strict templates and recovers after a rejected template',async t=>{
  const {ctx,service,agent}=await fixture(t);
  const job=service.store.create({id:agent.session.id,cwd:agent.session.header.cwd},1,'Keep {{name}} and {{provider}}');
  service.live.set(job.id,job);
  service.facts.seed(job);
  ctx.systemPrompt.variable('fixture_value',()=> 'registered-value');
  const releaseKnown=ctx.systemPrompt.context({name:'fixture:known',order:24,text:'Selected {{fixture_value}}'});
  t.after(releaseKnown);
  const assemble=()=>ctx.systemPrompt.assemble({agent});
  let assembly=await assemble();
  const original=assembly.contexts.find(x=>x.name==='dsh:task-supervisor');
  assert.equal(original.interpolate,false);
  const rendered=renderContextSections(assembly);
  assert.equal(rendered.find(x=>x.name==='dsh:task-supervisor').text,original.text);
  assert.equal(rendered.find(x=>x.name==='fixture:known').text,'Selected registered-value');
  const releaseUnknown=ctx.systemPrompt.context({name:'fixture:unknown',order:25,text:'{{missing}}'});
  try {
    assembly=await assemble();
    assert.throws(()=>renderContextSections(assembly),/unknown prompt variable.*missing.*fixture:unknown/);
  } finally { releaseUnknown(); }
  assembly=await assemble();
  assert.doesNotThrow(()=>renderContextSections(assembly));
  assert.doesNotThrow(()=>renderContextSections(ctx.systemPrompt.refreshContext(assembly,{agent})));
});
