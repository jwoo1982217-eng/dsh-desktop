import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {applyRc1HistoryControllerCompatibility, normalizeRc1HistoryController} from './history-controller.mjs';
import {ChatHistory, applyChatHistory} from '../../peer/chat-history/index.mjs';

const runtime = process.env.DSH_COMPAT_RUNTIME, work = process.env.DSH_COMPAT_TEST_ROOT;
assert.ok(runtime && work && path.isAbsolute(runtime) && path.isAbsolute(work));
fs.mkdirSync(work, {recursive: true});
const modules = path.join(runtime, 'node_modules'), dependencyLink = path.join(work, 'node_modules');
if (!fs.existsSync(dependencyLink)) fs.symlinkSync(modules, dependencyLink);
assert.equal(fs.realpathSync(dependencyLink), fs.realpathSync(modules));
const sdk = name => import(pathToFileURL(path.join(modules, '@deepseek-ai', name, 'lib/index.js')));
const {Context} = await sdk('cordis');
const {default: Sessions, SESSION_FORMAT_VERSION} = await sdk('dsh-session');
const {default: Projections} = await sdk('dsh-session-projection');
const {default: Agents} = await sdk('dsh-agent');
const {default: Loop} = await sdk('dsh-agent-loop');
const {default: SystemPrompt} = await sdk('dsh-system-prompt');
const {default: Tools} = await sdk('dsh-tools');
const Native = await sdk('dsh-tool-executor-native');
const Jsonl = await sdk('dsh-session-persistence-jsonl');
const {default: Query} = await sdk('dsh-session-query');
const {default: Llm, createUserMessage} = await sdk('dsh-llm');
const {default: Storage} = await sdk('dsh-storage');
const JsonStorage = await sdk('dsh-storage-json');
const Domains = await sdk('dsh-storage-domain');
const {default: Cache} = await sdk('dsh-session-projection-cache');
const {default: Workspaces} = await sdk('dsh-workspace');
const controllerPath = path.join(modules, '@deepseek-ai/dsh-api-session-controller/lib/index.js');
const original = normalizeRc1HistoryController(fs.readFileSync(controllerPath));
const patchRoot = path.join(work, 'patched-runtime'), target = path.join(patchRoot, 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js');
fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, original);
fs.mkdirSync(path.join(patchRoot, 'node_modules/@deepseek-ai/dsh'), {recursive: true});
fs.writeFileSync(path.join(patchRoot, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({version: '0.2.2-rc.1'}));
await applyRc1HistoryControllerCompatibility(patchRoot);
const testModule = path.join(work, 'controller-fixture.mjs');
// Add a test-only export of the real private Agent controller; production bytes
// retain only their original exports plus the already-authorized catalog export.
fs.writeFileSync(testModule, fs.readFileSync(target, 'utf8') + '\nexport {ApiSessionAgentController};\n');
const {SessionController, ApiSessionAgentController, ApiSessionNotFound} = await import(pathToFileURL(testModule));
const beforeModule = path.join(work, 'controller-before-fixture.mjs');
fs.writeFileSync(beforeModule, original.toString('utf8') + '\nexport {ApiSessionAgentController};\n');
const Before = await import(pathToFileURL(beforeModule));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, {Controller = SessionController, AgentController = ApiSessionAgentController, skipManager = false} = {}) {
  const home = fs.mkdtempSync(path.join(work, 'history-')), oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; fs.rmSync(home, {recursive: true, force: true}); });
  ctx.provide('agentDefaultModel', {currentSelection: () => ({provider: 'local-fixture', model: 'no-inference'})});
  ctx.provide('typert', {lookups: {configure() {}}, contexts: {configureHost() {}}});
  ctx.provide('remoteAccess', {allows: () => true});
  for (const plugin of [Llm, Sessions, Projections]) await ctx.plugin(plugin);
  await ctx.plugin(Storage); await ctx.plugin(JsonStorage, {root: path.join(home, 'storage-medium')});
  await ctx.plugin(Domains, {backend: 'json'});
  await ctx.plugin(Cache, {writeEveryEvents: 20, writeIntervalMs: 60000});
  await ctx.plugin(Jsonl, {root: path.join(home, 'sessions'), compression: 'none'});
  await ctx.plugin(Workspaces);
  for (const plugin of [Query, Agents, SystemPrompt, Tools, Native, Loop]) await ctx.plugin(plugin);
  const agents = new AgentController(ctx);
  const listRows = async () => (await ctx.sessionPersistence.list()).map(({header}) => ({sessionId: header.id, cwd: header.cwd, running: ctx.agents.get(header.id)?.status === 'running'}));
  const controller = {ctx, agents, listState: {list: listRows, search: async () => ({items: await listRows(), hasMore: false})}};
  for (const name of ['list', 'search', 'deletionLease', 'markPermanentlyDeleted', 'resolveAgent']) if (typeof Controller.prototype[name] === 'function') controller[name] = Controller.prototype[name].bind(controller);
  ctx.provide('sessionController', controller);
  const snapshots = new Map();
  for (const id of ['previously-deleted', 'keep-history', 'selected-history']) {
    const header = {id, version: SESSION_FORMAT_VERSION, createdAt: 1, cwd: home, isSeeded: false};
    const handle = await ctx.sessionPersistence.create(header);
    await handle.append([{seq: 0, time: 1, type: 'user/message', data: createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'PRESERVE_NONEMPTY_HISTORY_' + id}]}), surfaceOp: 'append'}]);
    await handle.flush(); await handle.close();
    const file = ctx.sessionPersistence.locate(header).path;
    snapshots.set(id, {file, hash: sha(fs.readFileSync(file)), header});
  }
  const ledger = path.join(home, 'storage/chat-history/deleted.json'); fs.mkdirSync(path.dirname(ledger), {recursive: true});
  fs.writeFileSync(ledger, JSON.stringify({deleted: ['previously-deleted'], pending: []}));
  const manager = skipManager ? undefined : new ChatHistory(ctx, home);
  const unchanged = id => assert.equal(sha(fs.readFileSync(snapshots.get(id).file)), snapshots.get(id).hash, id + ' must retain exact stored history bytes');
  return {ctx, home, agents, controller, manager, snapshots, ledger, unchanged};
}

test('a preexisting deletion ledger remains effective while nonempty retained histories and metadata stay byte-identical', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.controller.list({})).items.map(x => x.sessionId).sort(), ['keep-history', 'selected-history']);
  assert.deepEqual((await f.controller.search({query: 'history'})).items.map(x => x.sessionId).sort(), ['keep-history', 'selected-history']);
  await assert.rejects(() => f.controller.resolveAgent('previously-deleted'), ApiSessionNotFound);
  await assert.rejects(() => f.agents.createSession({sessionId: 'previously-deleted', cwd: f.home, reusable: () => true}), ApiSessionNotFound);
  assert.equal(f.ctx.agents.list().length, 0);
  for (const id of f.snapshots.keys()) f.unchanged(id);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.ledger)), {deleted: ['previously-deleted'], pending: []});
});

test('actual rc1 resume handles are retained, exclusively leased, disposed and can resume again after lease release', async t => {
  const f = await fixture(t);
  const originalPrefix = fs.readFileSync(f.snapshots.get('selected-history').file, 'utf8');
  const result = await f.agents.resolveAgent('selected-history'); assert.ok(result.agent, result.error?.message ?? 'No resolved Agent');
  assert.equal(f.agents.ownedHandles.size, 1);
  const release = await f.controller.deletionLease(['selected-history']);
  assert.equal(f.ctx.agents.get('selected-history'), undefined);
  assert.equal(f.agents.ownedHandles.size, 0);
  await assert.rejects(() => f.controller.resolveAgent('selected-history'), ApiSessionNotFound);
  assert.ok(fs.readFileSync(f.snapshots.get('selected-history').file, 'utf8').startsWith(originalPrefix), 'resume metadata may append; every original byte must remain its exact prefix');
  f.unchanged('keep-history');
  release(); assert.ok((await f.controller.resolveAgent('selected-history')).agent);
});

test('a foreign live owner makes deletion fail without hiding or changing any existing history', async t => {
  const f = await fixture(t);
  const foreign = await f.ctx.agents.resume({resumeSessionId: 'selected-history', agentOptions: {provider: 'local-fixture', model: 'no-inference'}});
  t.after(() => foreign.dispose());
  f.snapshots.get('selected-history').hash = sha(fs.readFileSync(f.snapshots.get('selected-history').file));
  const preview = await f.manager.preview({scope: 'session', sessionId: 'selected-history'});
  const beforeLedger = fs.readFileSync(f.ledger);
  await assert.rejects(() => f.manager.remove({token: preview.token}), /其他服务持有/);
  assert.deepEqual(fs.readFileSync(f.ledger), beforeLedger);
  assert.equal(f.agents.deletingIds.size, 0);
  assert.ok((await f.controller.list({})).items.some(x => x.sessionId === 'selected-history'));
  for (const id of f.snapshots.keys()) f.unchanged(id);
});

test('selected deletion uses the real rc1 persistence helpers and leaves unrelated nonempty history untouched', async t => {
  const f = await fixture(t), preview = await f.manager.preview({scope: 'session', sessionId: 'selected-history'});
  assert.equal((await f.manager.remove({token: preview.token})).deleted, 1);
  assert.equal(fs.existsSync(f.snapshots.get('selected-history').file), false);
  assert.equal(await f.ctx.sessionPersistence.stat('selected-history'), undefined);
  f.unchanged('keep-history'); f.unchanged('previously-deleted');
  assert.deepEqual((await f.controller.list({})).items.map(x => x.sessionId), ['keep-history']);
  await assert.rejects(() => f.controller.resolveAgent('selected-history'), ApiSessionNotFound);
});

test('patch composition preserves the catalog export, is idempotent and refuses unknown edits and failed writes', async t => {
  const root = fs.mkdtempSync(path.join(work, 'patch-failure-')), file = path.join(root, 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js');
  fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, original);
  fs.mkdirSync(path.join(root, 'node_modules/@deepseek-ai/dsh'), {recursive: true}); fs.writeFileSync(path.join(root, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({version: '0.2.2-rc.1'}));
  t.after(() => {fs.chmodSync(path.dirname(file), 0o755); fs.rmSync(root, {recursive: true, force: true});});
  fs.chmodSync(path.dirname(file), 0o555); await assert.rejects(() => applyRc1HistoryControllerCompatibility(root), /EACCES|EPERM/);
  assert.deepEqual(fs.readFileSync(file), original); fs.chmodSync(path.dirname(file), 0o755);
  assert.equal((await applyRc1HistoryControllerCompatibility(root)).changed, 1);
  assert.equal((await applyRc1HistoryControllerCompatibility(root)).changed, 0);
  assert.deepEqual(normalizeRc1HistoryController(fs.readFileSync(file)), original);
  assert.equal(fs.readFileSync(file, 'utf8').includes('export { buildModelCatalog };'), original.toString().includes('export { buildModelCatalog };'));
  fs.appendFileSync(file, '\n// independent owner\n'); const modified = fs.readFileSync(file);
  await assert.rejects(() => applyRc1HistoryControllerCompatibility(root), /未知改动/); assert.deepEqual(fs.readFileSync(file), modified);
});

test('the actual nested ChatHistory fiber reproduces the live missing-method failure with a nonempty prior ledger and activates after the patch', async t => {
  for (const patched of [false, true]) await t.test(patched ? 'patched nested fiber' : 'original nested failure', async st => {
    const f = await fixture(st, patched ? {skipManager: true} : {Controller: Before.SessionController, AgentController: Before.ApiSessionAgentController, skipManager: true});
    const routes = []; f.ctx.provide('connection', {rpc: {handle(route) { routes.push(route); }}});
    f.ctx.provide('webServer', {register() { return () => {}; }});
    const beforeLedger = fs.readFileSync(f.ledger), fibers = [];
    f.ctx.on('internal/plugin', fiber => fibers.push(fiber));
    const owner = f.ctx.plugin({name: 'dsh-peer-history-regression', inject: ['connection', 'webServer'], apply: applyChatHistory}); await owner;
    const inner = fibers.find(fiber => fiber.parent?.fiber?.uid === owner.uid);
    assert.ok(inner, 'the same injected child fiber must be created'); await inner;
    if (patched) {
      assert.equal(inner.state, 2); assert.ok(routes.includes('/chat-history'));
      assert.deepEqual((await f.controller.list({})).items.map(x => x.sessionId).sort(), ['keep-history', 'selected-history']);
    } else {
      assert.equal(inner.state, 3);
      assert.equal(inner._error?.message, 'ctx.sessionController.markPermanentlyDeleted is not a function');
      assert.equal(routes.includes('/chat-history'), false);
    }
    assert.deepEqual(fs.readFileSync(f.ledger), beforeLedger);
    for (const id of f.snapshots.keys()) f.unchanged(id);
  });
});
