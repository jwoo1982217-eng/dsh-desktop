import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const version = '0.2.2-rc.1';
const helper = `// DSH compatibility: LLM routes are distinct from spawn/fork backends.
// Validate before provisioning so a selection error does not consume a name.
export async function teammateAgentOptions(ctx, agent, args, signal) {
  const scheduler = ctx.get('dshSubagentScheduler');
  scheduler?.assertDelegation();
  signal.throwIfAborted();
  const policy = ctx.get('sessionProjections')?.stateOf(agent.session, 'subagentModelSelectionPolicy');
  const selected = args.provider !== undefined || args.model !== undefined || args.reasoning_effort !== undefined;
  if (!selected) {
    if (scheduler || (Array.isArray(policy) && policy.length)) throw Error('请根据子任务内容选择模型。先调用 subagent_model_routes，再在 spawn_teammate 同时传 provider 和 model。');
    return undefined;
  }
  if (typeof args.provider !== 'string' || !args.provider.length || typeof args.model !== 'string' || !args.model.length)
    throw Error('spawn_teammate 的 provider 和 model 必须同时提供且非空。');
  if (!Array.isArray(policy) || !policy.some(r => r.provider === args.provider && r.model === args.model))
    throw Error('子模型线路不在本会话授权列表：' + args.provider + '/' + args.model);
  if (args.reasoning_effort !== undefined && (typeof args.reasoning_effort !== 'string' || !args.reasoning_effort.length))
    throw Error('reasoning_effort 必须是非空推理等级。');
  const options = {provider: args.provider, model: args.model};
  scheduler?.assertRoute(options);
  if (args.reasoning_effort !== undefined) options.reasoningEffort = args.reasoning_effort;
  const sameRoute = agent.options.provider === options.provider && agent.options.model === options.model;
  const reasoningEffort = options.reasoningEffort ?? (sameRoute ? agent.options.reasoningEffort : undefined);
  await ctx.get('llm').resolveCallConfig({...options, ...(reasoningEffort === undefined ? {} : {reasoningEffort})}, signal);
  signal.throwIfAborted();
  return options;
}
`;
const replacements = [
  {
    file: '@deepseek-ai/dsh-experimental-agent-team/lib/index.js',
    before: 'd5ed602b92410d40b1350185fd48cf1cefb9f606fb0a69351a10e12204afc3a2',
    edits: [
      ['\t\t\t\t\tprompt: request.prompt,\n\t\t\t\t\tparent: root', '\t\t\t\t\tprompt: request.prompt,\n\t\t\t\t\t...(request.agentOptions === undefined ? {} : {agentOptions: request.agentOptions}),\n\t\t\t\t\tparent: root'],
      ['\tasync sendMessage(caller, request) {\n\t\tif (this.lifecycle.disposed)', '\tasync sendMessage(caller, request) {\n\t\tconst scheduler = this.ctx.get("dshSubagentScheduler");\n\t\tif (scheduler && !scheduler.config.delegationEnabled) {\n\t\t\tconst membership = this.roster.membership(caller);\n\t\t\tif (!(membership.role === "teammate" && request.target === "lead")) scheduler.assertDelegation();\n\t\t}\n\t\tif (this.lifecycle.disposed)'],
    ],
  },
  {
    file: '@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js',
    before: 'cac22fe5f83a179056469cf329def58393c7620eae23b018c66f42c37d849f63',
    edits: [
      ['import z from "@deepseek-ai/schemastery";', 'import {teammateAgentOptions} from "./model-selection.js";\nimport z from "@deepseek-ai/schemastery";'],
      ['description: "Create one named, durable teammate. Only the Team Lead may call this tool.",\n\t\t\tparameters: {', 'description: "Create one named, durable teammate. Only the Team Lead may call this tool. Choose an authorized LLM provider/model for the task using subagent_model_routes; supply both fields. Failed names from earlier attempts cannot be reused.",\n\t\t\tparameters: {\n\t\t\t\tprovider: {type: "string", description: "LLM provider from subagent_model_routes. Supply together with model; this is not the spawn/fork backend."},\n\t\t\t\tmodel: {type: "string", description: "Exact authorized LLM model selected for this task. Supply together with provider."},\n\t\t\t\treasoning_effort: {type: "string", description: "Optional advertised reasoning effort for the selected model."},'],
      ['\t\t\t\tconst context = args.context ?? "fresh";\n\t\t\t\treturn { member:', '\t\t\t\tconst context = args.context ?? "fresh";\n\t\t\t\tconst agentOptions = await teammateAgentOptions(ctx, agent, args, exec.signal);\n\t\t\t\treturn { member:'],
      ['\t\t\t\t\tcontext,\n\t\t\t\t\tprovider: context === "fork"', '\t\t\t\t\tcontext,\n\t\t\t\t\t...(agentOptions === undefined ? {} : {agentOptions}),\n\t\t\t\t\tprovider: context === "fork"'],
    ],
  },
];
function replaceOnce(text, before, after, file) {
  if (text.split(before).length !== 2) throw Error('团队兼容补丁未唯一命中：' + file);
  return text.replace(before, after);
}
async function optional(file) { try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function atomic(file, bytes) {
  const temporary = file + '.' + randomUUID();
  try { await writeFile(temporary, bytes, {flag: 'wx'}); await rename(temporary, file); }
  finally { await rm(temporary, {force: true}); }
}
/** Retain the existing DSH Team route and delegation policy on exact published rc.1 bytes. */
export async function applyRc1TeamCompatibility(runtime) {
  const modules = path.join(runtime, 'node_modules');
  const core = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
  if (core.version !== version) throw Error('团队兼容层只适用于 DSH ' + version);
  const plans = [];
  for (const patch of replacements) {
    const file = path.join(modules, patch.file), bytes = await readFile(file);
    if (digest(bytes) === patch.before) {
      const after = Buffer.from(patch.edits.reduce((text, [before, after]) => replaceOnce(text, before, after, patch.file), bytes.toString('utf8')));
      plans.push({file, before: bytes, after});
    } else {
      const original = patch.edits.toReversed().reduce((text, [before, after]) => replaceOnce(text, after, before, patch.file), bytes.toString('utf8'));
      if (digest(Buffer.from(original)) !== patch.before) throw Error('团队核心文件有未知改动，未覆盖：' + patch.file);
    }
  }
  const file = path.join(modules, '@deepseek-ai/dsh-experimental-tool-agent-team/lib/model-selection.js');
  const before = await optional(file), after = Buffer.from(helper);
  if (before === null) plans.unshift({file, before, after});
  else if (!before.equals(after)) throw Error('团队模型选择适配已有未知改动，未覆盖');
  const applied = [];
  try {
    for (const plan of plans) {
      const current = await optional(plan.file);
      if (plan.before === null ? current !== null : current === null || !current.equals(plan.before)) throw Error('团队核心文件发生并发修改');
      await atomic(plan.file, plan.after); applied.push(plan);
    }
  } catch (error) {
    for (const plan of applied.reverse()) if ((await optional(plan.file))?.equals(plan.after)) {
      if (plan.before === null) await rm(plan.file);
      else await atomic(plan.file, plan.before);
    }
    throw error;
  }
  return {version, changed: plans.length, files: [...replacements.map(p => p.file), '@deepseek-ai/dsh-experimental-tool-agent-team/lib/model-selection.js']};
}
