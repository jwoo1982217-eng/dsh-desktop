// Read the actual profile only; never write it or copy private config to fixtures.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {prepareRc1ProfileMigration} from '../../desktop/macos/app/rc1-profile-migration.mjs';

const runtime = process.env.DSH_COMPAT_RUNTIME, work = process.env.DSH_COMPAT_TEST_ROOT, profileDir = process.env.DSH_PROFILE_FIXTURE_SOURCE;
assert.ok(runtime && work && profileDir);
const modules = path.join(runtime, 'node_modules'), anchor = path.join(modules, '@deepseek-ai/dsh/package.json');
const require = createRequire(anchor), yaml = require('js-yaml');
const sdk = name => import(pathToFileURL(path.join(modules, '@deepseek-ai', name, 'lib/index.js')));
const {Context} = await sdk('cordis'), {default: Loader} = await sdk('cordis-plugin-loader');
const {entryListSchema} = await sdk('cordis-plugin-include'), {default: Group} = await sdk('cordis-plugin-group');
const {PluginPackages, createRuntimeResolution} = await sdk('dsh-app-boot');
const source = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'));
const plan = await prepareRc1ProfileMigration(profileDir, modules), next = plan.files.find(f => f.file === path.join(profileDir, 'cordis.patch.yml'))?.next ?? source;
const rows = bytes => yaml.load(bytes.toString('utf8'), {schema: entryListSchema});
function definitions(data) {
  const found = [];
  function walk(value) {if (!value || typeof value !== 'object') return; if (value.name === '@deepseek-ai/dsh-agent-preset') found.push(value.config); for (const child of Object.values(value)) walk(child);}
  walk(data); return found;
}
const actual = definitions(rows(source)), migrated = definitions(rows(next));
const selected = ['standard', 'ptc', 'cordis'];
const resolution = await createRuntimeResolution({installAnchor: anchor, home: path.dirname(path.dirname(profileDir)), profile: {name: 'web', dir: profileDir, layers: [], patches: [], patchPath: path.join(profileDir, 'cordis.patch.yml'), skippedBundles: []}});
const base = rows(fs.readFileSync(path.join(modules, '@deepseek-ai/dsh-base/cordis.patch.yml')))[0].insert;
const web = rows(fs.readFileSync(path.join(modules, '@deepseek-ai/dsh-web-app/cordis.patch.yml'))).flatMap(patch => patch.insert ?? []);
const disabled = new Set(['hmr', 'telemetry', 'otel', 'command-feedback', 'session-title-llm', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'deepseek-account', 'authorization', 'plugin-package-inventory-deepseek']);
fs.mkdirSync(work, {recursive: true});
const originalFetch = globalThis.fetch;
let networkCalls = 0, inferenceCalls = 0;
globalThis.fetch = async () => {networkCalls++; throw Error('External fetch forbidden in preset fixture');};
const results = [];
const timeout = setTimeout(() => {console.error(JSON.stringify({timeout: true, results}));process.exit(2);}, 30000);
try {
  for (const presetId of selected) {
    const home = fs.mkdtempSync(path.join(work, 'preset-')), oldHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const ctx = new Context();
    try {
      ctx.baseUrl = pathToFileURL(path.join(profileDir, 'cordis.patch.yml')).href;
      ctx.dshHomePath = (...parts) => path.join(home, ...parts);
      ctx.provide('profileContext', {name: 'preset-fixture', dir: home, startedBundles: []});
      await ctx.plugin(PluginPackages, {resolution});
      await ctx.plugin(Loader, {baseUrl: pathToFileURL(path.join(profileDir, 'cordis.patch.yml')).href});
      ctx.loader.builtins.group = Group;
      ctx.on('llm/stream', () => {inferenceCalls++; throw Error('Inference forbidden in preset fixture');});
      const host = structuredClone(base).map(row => ({...row, ...(disabled.has(row.id) ? {disabled: true} : {})}));
      host.push(...structuredClone(web.filter(row => ['schedule', 'cordis-host-runner', 'cordis-inspect-providers'].includes(row.id))));
      host.push({id: 'fixture-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: {default: presetId}});
      await ctx.loader.root.update(host); await ctx.loader.await();
      if (!ctx.get('agentPresets')) throw Error('Fixture preset registry missing');
      const before = actual.find(d => d.id === presetId), after = migrated.find(d => d.id === presetId);
      assert.ok(before && after);
      const native = ctx.loader.internal;
      const resolve = name => {try {return (native.version === 'v2' ? native.resolveSync(pathToFileURL(path.join(profileDir, 'cordis.patch.yml')).href, {specifier: name, attributes: {}}) : native.resolveSync(name, pathToFileURL(path.join(profileDir, 'cordis.patch.yml')).href, {})).url;} catch (error) {return {error: error.code};}};
      const beforeDispose = await ctx.agentPresets.register({...structuredClone(before), id: presetId + '-before'});
      const baseline = await ctx.agentPresets.resolve(presetId + '-before');
      await beforeDispose();
      const stop = await ctx.agentPresets.register(structuredClone(after));
      const state = await ctx.agentPresets.resolve(presetId);
      const result = {presetId, baselineBroken: baseline.broken, migratedBroken: state.broken, mainResolved: resolve('@deepseek-ai/dsh-tool-subagent-control'), retiredResolved: resolve('@deepseek-ai/dsh-tool-subagent-control/list-agents')};
      if (!state.broken) {
        const handle = await ctx.agents.create({sessionId: 'fixture-' + presetId, meta: {cwd: home, agentPreset: presetId}, agentOptions: {provider: 'local-no-inference', model: 'fixture'}, setup: async agentCtx => {await ctx.agentPresets.mount(agentCtx, presetId);}});
        const names = ctx.tools.schemas(handle.agent).map(tool => tool.name);
        result.controls = Object.fromEntries(['list_agents', 'send_message', 'interrupt_agent'].map(name => [name, names.filter(n => n === name).length]));
        result.toolCount = names.length; result.agentConstructed = true;
        const toolSet = await ctx.tools.resolve({agent: handle.agent, modelSelection: {provider: 'local-no-inference', model: 'fixture'}, signal: new AbortController().signal});
        try {
          const assembly = await ctx.systemPrompt.assemble({agent: handle.agent, scope: handle.agent, toolSet});
          result.modelTools = assembly.tools.map(tool => tool.name);
          if (presetId === 'ptc') {
            assert.deepEqual(result.modelTools, ['run_code']);
            const sdkText = assembly.sections.find(section => section.name === 'tools:sdk')?.text;
            for (const name of ['list_agents', 'send_message', 'interrupt_agent']) assert.ok(sdkText?.includes(name + ':'), 'PTC must declare ' + name);
          }
        } finally {toolSet.dispose();}
        await handle.dispose();
      }
      results.push(result); await stop();
    } finally {await ctx.fiber.dispose(); if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; fs.rmSync(home, {recursive: true, force: true});}
  }
} finally {clearTimeout(timeout); globalThis.fetch = originalFetch;}
assert.deepEqual(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml')), source, 'actual profile must remain unchanged');
console.log(JSON.stringify({results, networkCalls, inferenceCalls, migratedRows: plan.removedLegacyListAgents ?? plan.removedListAgents}, null, 2));
if (results.some(r => !r.agentConstructed || Object.values(r.controls).some(n => n !== 1)) || networkCalls || inferenceCalls) process.exitCode = 1;
