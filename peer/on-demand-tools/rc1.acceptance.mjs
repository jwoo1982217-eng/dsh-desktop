// Run against the isolated rc.1 dependency tree, never the active DSH profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Context, symbols} from '@deepseek-ai/cordis';
import {bindScopeParent} from '@deepseek-ai/dsh-scope';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, {defineTool} from '@deepseek-ai/dsh-tools';
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';
import * as PtcExecutor from '@deepseek-ai/dsh-tool-executor-ptc';
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node';
import LocalFs from '@deepseek-ai/dsh-fs-local';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import Sandbox from '@deepseek-ai/dsh-sandbox-local';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import Llm, {LlmAdapter, createUserMessage} from '@deepseek-ai/dsh-llm';
import Skills from '@deepseek-ai/dsh-skill';
import * as SkillTool from '@deepseek-ai/dsh-tool-skill';
import * as OnDemand from './index.mjs';

const BASE = ['ask_user_question', 'read', 'skill', 'tool_load', 'tool_search'];
const output = {schema: {type: 'string'}, render: (_a, v) => [{type: 'text', text: v}]};
const names = assembly => assembly.tools.map(tool => tool.name).sort();
const body = result => JSON.parse(result.value);
let serial = 0;

async function fixture(t, {ptc = false, actions, realSkill = false} = {}) {
  const root = process.env.DSH_ACCEPTANCE_ROOT;
  assert.ok(root && path.isAbsolute(root), 'DSH_ACCEPTANCE_ROOT must be the registered task generated/tool-tests directory');
  const home = fs.mkdtempSync(path.join(root, 'on-demand-'));
  const ctx = new Context(), requests = [], executions = [];
  t.after(async () => { await ctx.fiber.dispose(); fs.rmSync(home, {recursive: true, force: true}); });
  for (const plugin of [Llm, Sessions, Projections, Agents, SystemPrompt, Tools, Loop]) await ctx.plugin(plugin);
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, id) { return {provider, id, name: id, contextWindow: 32768, maxTokens: 1024, inputModalities: ['text']}; }
    async *stream(options) {
      const index = requests.length;
      requests.push({tools: structuredClone(options.tools), messages: structuredClone(options.messages)});
      const calls = actions?.[index];
      if (calls) {
        for (const [i, [name, args]] of calls.entries()) yield {type: 'tool-call-delta', index: i, id: `call-${index}-${i}`, name, argumentsDelta: JSON.stringify(args)};
        yield {type: 'finish', reason: {kind: 'tool-calls'}};
      } else {
        yield {type: 'text-delta', index: 0, text: 'local fixture complete'};
        yield {type: 'finish', reason: {kind: 'stop'}};
      }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new FixtureAdapter());
  if (ptc || realSkill) {
    await ctx.plugin(LocalFs, {cwd: home});
    await ctx.plugin(WorkingDirectory, {defaultDirectory: home});
  }
  if (ptc) {
    await ctx.plugin(LocalSubprocess);
    await ctx.plugin(Sandbox);
    await ctx.plugin(SandboxPolicy, {mode: 'danger-full-access', workspaceRoot: home});
    await ctx.plugin(NodePtcRuntime, {executionMode: 'per-call', timeoutMs: 5000, maxTimeoutMs: 5000});
    await ctx.plugin(PtcExecutor);
  } else await ctx.plugin(NativeExecutor);
  const register = (name, extra = {}, options) => ctx.tools.register(defineTool({
    name, description: `fixture capability ${name}`, parameters: {}, output,
    execute(_args, exec) { executions.push({name, agent: exec.agent?.id}); return `actual callback ${name}`; }, ...extra,
  }), options);
  for (const name of ['read', ...(realSkill ? [] : ['skill']), 'ask_user_question', 'bash', 'write', 'mcp__mt__mt_file_list']) register(name);
  if (realSkill) {
    await ctx.plugin(Skills);
    await ctx.plugin(SkillTool, {catalogDescriptionMaxLength: 160});
    ctx.skills.register({name: 'fixture-skill', description: '用于本机技能按需加载验收。'.repeat(50), source: 'fixture', content: 'FULL_BODY_ONLY_AFTER_SELECTION'});
  }
  const originalResolve = ctx.tools[symbols.original].resolve;
  const fork = ctx.plugin(OnDemand); await fork;
  async function agent(parent) {
    const handle = await ctx.agents.create({sessionId: `on-demand-${++serial}`, parentAgent: parent,
      meta: {cwd: home, ...(parent ? {parentSession: parent.id, origin: 'subagent', delegationDepth: 1} : {})},
      agentOptions: {provider: 'fixture', model: 'test'}});
    if (parent) bindScopeParent(handle.agent, parent);
    return handle.agent;
  }
  const a = await agent();
  const resolve = (a = f.a, signal = new AbortController().signal) => ctx.tools.resolve({agent: a, signal, modelSelection: {provider: 'fixture', model: 'test'}});
  const assemble = (a, toolSet) => ctx.systemPrompt.assemble({agent: a, scope: a, toolSet});
  const invoke = async (name, args, a = f.a, toolSet, signal = new AbortController().signal) => {
    const batch = await ctx.tools.execute({agent: a, toolSet, signal, calls: [{type: 'tool-call', id: `direct-${++serial}`, name, arguments: JSON.stringify(args)}]});
    assert.equal(batch.results.length, 1);
    return batch.results[0].result;
  };
  const step = async (a = f.a) => { const set = await resolve(a); return {set, assembly: await assemble(a, set)}; };
  const f = {ctx, home, a, agent, register, invoke, resolve, assemble, step, requests, executions, originalResolve, fork};
  return f;
}

test('rc1 admission keeps five resident tools, search/load are inert and only the next step executes the selected callback', async t => {
  const f = await fixture(t), first = await f.step();
  assert.deepEqual(names(first.assembly), BASE);
  assert.equal(f.ctx.tools.get('bash', f.a).name, 'bash');
  assert.equal((await f.invoke('bash', {}, f.a, first.set)).error.info.code, 'UNKNOWN_TOOL');
  assert.equal(body(await f.invoke('tool_search', {query: 'bash'}, f.a, first.set)).tools[0].name, 'bash');
  assert.deepEqual(body(await f.invoke('tool_load', {names: ['bash']}, f.a, first.set)).loaded, ['bash']);
  assert.equal(f.executions.length, 0);
  assert.equal(f.ctx.tools.executable('bash', f.a, first.set), undefined, 'the accepted step remains immutable after loading');
  first.set.dispose();
  const second = await f.step();
  assert.ok(names(second.assembly).includes('bash'));
  assert.equal((await f.invoke('bash', {}, f.a, second.set)).value, 'actual callback bash');
  assert.equal(f.executions.length, 1);
  second.set.dispose();
  assert.equal(f.ctx.tools.executable('bash', f.a, second.set), undefined);
});

test('rc1 scopes, inherited permission restrictions and monotonic guards remain authoritative', async t => {
  const f = await fixture(t), other = await f.agent(), child = await f.agent(f.a);
  f.a.ctx.tools.restrict({deny: ['write']});
  await f.invoke('tool_load', {names: ['bash']});
  assert.ok(!names((await f.step(other)).assembly).includes('bash'));
  assert.ok(!names((await f.step(child)).assembly).includes('bash'));
  await f.invoke('tool_load', {names: ['mcp__mt__mt_file_list']}, child);
  assert.ok(!names((await f.step()).assembly).includes('mcp__mt__mt_file_list'));
  assert.equal(body(await f.invoke('tool_search', {query: 'write'}, child)).total, 0);
  assert.equal((await f.invoke('tool_load', {names: ['write']}, child)).isError, true);
  f.ctx.tools.guard(exec => exec.name === 'bash' ? 'fixture permission denied' : undefined);
  f.ctx.on('tools/pre-execute', (_exec, _next) => Promise.resolve({kind: 'allow'}));
  const selected = await f.step();
  assert.equal(selected.set.view(other).size, 0);
  assert.equal((await f.invoke('bash', {}, f.a, selected.set)).isError, true);
  assert.equal(f.executions.length, 0);
  child.ctx.tools.restrict({allow: ['read', 'bash']});
  assert.deepEqual(names((await f.step(child)).assembly), ['bash', 'read']);
});

test('rc1 failed/oversized/cancelled selections preserve state and revoked registrations never revive', async t => {
  const f = await fixture(t);
  for (const name of ['large_a', 'large_b', 'large_c']) f.register(name, {description: 'x'.repeat(14000)});
  await f.invoke('tool_load', {names: ['large_a']});
  assert.equal((await f.invoke('tool_load', {names: ['large_b', 'large_c']})).isError, true);
  assert.ok(names((await f.step()).assembly).includes('large_a'));
  assert.deepEqual(body(await f.invoke('tool_load', {names: ['large_b']})).evicted, ['large_a']);
  assert.equal((await f.invoke('tool_load', {names: ['bash', 'missing']})).isError, true);
  const aborted = AbortSignal.abort(Error('fixture cancelled'));
  await assert.rejects(() => f.resolve(f.a, aborted), /fixture cancelled/);
  await assert.rejects(async () => f.ctx.tools.get('tool_load', f.a).execute({names: ['bash']}, {agent: f.a, signal: aborted}), /fixture cancelled/);
  assert.ok(!names((await f.step()).assembly).includes('bash'));
  const remove = f.register('temporary');
  await f.invoke('tool_load', {names: ['temporary']});
  const admitted = await f.step(); remove();
  assert.equal(f.ctx.tools.executable('temporary', f.a, admitted.set), undefined);
  f.register('temporary');
  assert.equal(f.ctx.tools.executable('temporary', f.a, admitted.set), undefined, 'same-name replacement cannot revive old admission');
  f.ctx.emit('agent/status', {agent: f.a, status: 'idle'});
  assert.deepEqual(names((await f.step()).assembly), BASE);
});

test('rc1 conditional activation, cancellation and plugin disposal preserve SDK ownership', async t => {
  const f = await fixture(t);
  let checks = 0;
  f.register('conditional', {}, {when: ({modelSelection}) => { checks++; return modelSelection.model === 'test'; }});
  f.register('unavailable', {}, {when: () => false});
  await f.invoke('tool_load', {names: ['conditional', 'unavailable']});
  const current = await f.step();
  assert.ok(names(current.assembly).includes('conditional'));
  assert.ok(!names(current.assembly).includes('unavailable'));
  assert.equal(checks, 1);
  assert.equal((await f.invoke('conditional', {}, f.a, current.set)).isError, false);
  assert.equal((await f.invoke('unavailable', {}, f.a, current.set)).error.info.code, 'UNKNOWN_TOOL');
  await f.fork.dispose();
  assert.equal(f.ctx.tools[symbols.original].resolve, f.originalResolve);
  assert.equal(f.ctx.tools.get('tool_load', f.a), undefined);
  const restored = await f.step();
  assert.ok(names(restored.assembly).includes('bash'));
  assert.equal((await f.invoke('bash', {}, f.a, restored.set)).value, 'actual callback bash');
});

test('rc1 real Agent loop rejects same-step hidden calls, then executes a loaded capability and resets at idle', async t => {
  const f = await fixture(t, {actions: [
    [['tool_search', {query: 'bash'}]],
    [['tool_load', {names: ['bash']}], ['bash', {}]],
    [['bash', {}]],
  ]});
  f.a.followup(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'local tool discovery fixture'}]}));
  await f.a.whenIdle();
  assert.equal(f.requests.length, 4, JSON.stringify(f.a.session.snapshotEvents().slice(-4)));
  assert.deepEqual(f.requests[0].tools.map(t => t.name).sort(), BASE);
  assert.ok(!f.requests[1].tools.some(t => t.name === 'bash'));
  assert.ok(f.requests[2].tools.some(t => t.name === 'bash'));
  assert.deepEqual(f.executions.map(e => e.name), ['bash']);
  const results = f.a.session.snapshotEvents().filter(e => e.type === 'tool/result');
  assert.ok(results.some(e => JSON.stringify(e).includes('UNKNOWN_TOOL')), JSON.stringify(results));
  assert.deepEqual(names((await f.step()).assembly), BASE);
});

test('rc1 genuine Node PTC shares admitted declarations, next-step bindings and original denial guards', async t => {
  const f = await fixture(t, {ptc: true});
  const code = code => ({code, description: 'Verify local tool selection behavior'});
  const first = await f.step();
  assert.deepEqual(names(first.assembly), ['run_code']);
  const sdk = first.assembly.sections.find(section => section.name === 'tools:sdk').text;
  assert.ok(sdk.includes('tool_load:'));
  assert.ok(!sdk.includes('bash:'));
  assert.equal((await f.invoke('bash', {}, f.a, first.set)).error.info.code, 'UNKNOWN_TOOL');
  const hidden = await f.invoke('run_code', code('return typeof tools.bash;'), f.a, first.set);
  assert.equal(hidden.isError, false, JSON.stringify(hidden));
  assert.equal(hidden.value.result, 'undefined');
  const loaded = await f.invoke('run_code', code('await tools.tool_load({names: ["bash"]}); return typeof tools.bash;'), f.a, first.set);
  assert.equal(loaded.isError, false, JSON.stringify(loaded));
  assert.equal(loaded.value.result, 'undefined', 'loading cannot add program bindings during an admitted step');
  first.set.dispose();
  const second = await f.step();
  assert.ok(second.assembly.sections.find(s => s.name === 'tools:sdk').text.includes('bash:'));
  const result = await f.invoke('run_code', code('return await tools.bash({});'), f.a, second.set);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.result, 'actual callback bash');
  assert.equal(f.executions.length, 1);
  f.ctx.tools.guard(exec => exec.name === 'bash' ? 'fixture monotonic denial' : undefined);
  f.ctx.on('tools/pre-execute', () => Promise.resolve({kind: 'allow'}));
  const denied = await f.invoke('run_code', code('return await tools.bash({});'), f.a, second.set);
  assert.equal(denied.isError, true);
  assert.equal(f.executions.length, 1);
});

test('rc1 actual skill loader keeps the catalog brief and loads body only after selection through real Agent steps', async t => {
  const f = await fixture(t, {realSkill: true, actions: [[['skill', {name: 'fixture-skill'}]]]});
  f.a.followup(createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'Use the fixture skill'}]}));
  await f.a.whenIdle();
  assert.equal(f.requests.length, 2, JSON.stringify(f.a.session.snapshotEvents().slice(-5)));
  assert.ok(!JSON.stringify(f.requests[0]).includes('FULL_BODY_ONLY_AFTER_SELECTION'));
  assert.ok(JSON.stringify(f.requests[1].messages).includes('FULL_BODY_ONLY_AFTER_SELECTION'));
  const catalogs = f.a.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'skill-catalog');
  assert.equal(catalogs.length, 1);
  assert.ok(catalogs[0].data.source.entries[0].description.length <= 160);
});
