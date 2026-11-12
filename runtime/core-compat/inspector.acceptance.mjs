import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {applyRc1InspectorCompatibility} from './inspector.mjs';

const root = process.env.DSH_ACCEPTANCE_ROOT, runtime = process.env.DSH_RC1_RUNTIME;
assert.ok(root && runtime && path.isAbsolute(root) && path.isAbsolute(runtime));
const candidate = path.join(runtime, 'node_modules');
const sourceFile = path.join(root, 'billion-fetch-fixture.mjs');
// Add only a test export to the exact candidate bundle: execute the real fetch-chain
// installer and the exact cleanup used by its Cordis effect, without bootstrapping a proxy.
fs.writeFileSync(sourceFile, fs.readFileSync(path.join(candidate, 'billion-context/dist/agent/dsh-native.js'), 'utf8') + '\nexport {installNativeFetchIntercept as testInstall, liveStateSlotEffect as testLiveStateSlotEffect};\n');
const {startInspector} = await import(pathToFileURL(path.join(candidate, '@deepseek-ai/dsh-experimental-inspector/lib/index.js')));
const keys = ['billion-context.native-fetch-intercept', 'billion-context.native-intercept-state', 'billion-context.native-intercept-state-seq', 'dsh.inspector.fetch-chain-observer'].map(Symbol.for);
async function waitFor(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); } assert.fail('local observation did not settle'); }
async function fixture(t, suffix) {
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const globals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const home = fs.mkdtempSync(path.join(root, 'inspector-home-'));
  const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/slow') { res.writeHead(200, {'content-type': 'text/plain'}); res.write('partial'); const timer = setTimeout(() => res.end('final'), 1000); res.once('close', () => clearTimeout(timer)); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, {'content-type': 'text/plain', 'x-fixture': 'local'}); res.end('ACK:' + Buffer.concat(chunks).toString('utf8'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, handles = [];
  t.after(async () => {
    for (const handle of handles.toReversed()) await handle.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
    for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, {recursive: true, force: true});
  });
  let generation = 0, state, release;
  const startBillion = async () => {
    const billion = await import(pathToFileURL(sourceFile) + '?' + suffix + '-' + generation++);
    state = {ready: Promise.resolve(undefined)}; billion.testInstall(state); release = billion.testLiveStateSlotEffect(state)();
  };
  const stopBillion = () => release();
  const start = async () => {
    const handle = await startInspector({port: 0, maxJournalBytes: 2 * 1024 * 1024, maxRetainedRequests: 20, maxQueuedBytes: 1024 * 1024}); handles.push(handle);
    const events = [], publish = handle.source.publish;
    handle.source.publish = function(topic, payload, ...rest) { events.push({topic, payload}); return publish.call(this, topic, payload, ...rest); };
    return {handle, events};
  };
  const request = async (observer, text) => {
    const before = observer.events.length;
    const response = await fetch(origin + '/echo', {method: 'POST', headers: {'x-local-proof': 'fixture'}, body: text});
    assert.equal(await response.text(), 'ACK:' + text);
    await waitFor(() => observer.events.slice(before).some(e => e.topic === 'fetch/end'));
    const events = observer.events.slice(before);
    assert.equal(events.filter(e => e.topic === 'fetch/start').length, 1, 'one request must be captured exactly once');
    assert.equal(events.filter(e => e.topic === 'fetch/response').length, 1);
    const content = topic => Buffer.concat(events.filter(e => e.topic === topic).map(e => Buffer.from(e.payload.data, 'base64'))).toString('utf8');
    assert.equal(content('fetch/request-body-chunk'), text);
    assert.equal(content('fetch/response-body-chunk'), 'ACK:' + text);
    assert.equal(events.find(e => e.topic === 'fetch/end').payload.responseBodyTruncated, false);
  };
  return {start, startBillion, stopBillion, request, origin};
}

for (const order of ['billion-first', 'inspector-first']) test(`real Inspector Worker + billion fetch chain preserve full capture, re-chaining and lifecycle (${order})`, async t => {
  const f = await fixture(t, order);
  let observer;
  if (order === 'billion-first') { await f.startBillion(); observer = await f.start(); }
  else { observer = await f.start(); await f.startBillion(); }
  await f.request(observer, '本机正文😀'.repeat(100));
  const earlier = globalThis.fetch; let wrapperCalls = 0;
  globalThis.fetch = async (...args) => { wrapperCalls++; return earlier(...args); };
  await f.request(observer, 'after third-party wrapper'); assert.equal(wrapperCalls, 1);
  const beforeNested = observer.events.length, previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url).pathname === '/echo') await (await globalThis.fetch(f.origin + '/independent-side-request')).text();
    return previous(input, init);
  };
  assert.equal(await (await fetch(f.origin + '/echo', {method: 'POST', body: 'nested proof'})).text(), 'ACK:nested proof');
  await waitFor(() => observer.events.slice(beforeNested).filter(e => e.topic === 'fetch/end').length === 2);
  const nestedStarts = observer.events.slice(beforeNested).filter(e => e.topic === 'fetch/start');
  assert.equal(nestedStarts.length, 2, 'a distinct nested HTTP request must retain full capture');
  assert.deepEqual(nestedStarts.map(e => new URL(e.payload.url).pathname).sort(), ['/echo', '/independent-side-request']);
  // Restore a simple later wrapper while keeping billion's setter adoption active.
  globalThis.fetch = (...args) => earlier(...args);
  const savedObserver = globalThis.fetch;
  await observer.handle.close();
  assert.equal((await savedObserver(f.origin + '/echo', {method: 'POST', body: 'stale reference'})).status, 200);
  observer = await f.start();
  await f.request(observer, 'Inspector reloaded');
  f.stopBillion();
  assert.equal(globalThis[Symbol.for('billion-context.native-intercept-state')], undefined);
  await f.request(observer, 'billion unloaded');
  await f.startBillion();
  await f.request(observer, 'billion reloaded');
  const controller = new AbortController();
  const response = await fetch(f.origin + '/slow', {signal: controller.signal}); controller.abort();
  await assert.rejects(() => response.text(), /abort/i);
  await waitFor(() => observer.events.some(e => e.topic === 'fetch/end' && e.payload.responseCaptureError));
});

test('Inspector keeps rejecting an unknown fetch accessor and recovers after it is removed', async t => {
  const f = await fixture(t, 'unknown-accessor');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const native = globalThis.fetch;
  const unknown = {configurable: true, get: () => native, set() {}};
  Object.defineProperty(globalThis, 'fetch', unknown);
  await assert.rejects(() => f.start(), /accessor/);
  assert.equal(Object.getOwnPropertyDescriptor(globalThis, 'fetch').get, unknown.get);
  Object.defineProperty(globalThis, 'fetch', original);
  const observer = await f.start();
  await f.request(observer, 'recovered after unsupported accessor');
  const observed = globalThis.fetch, laterWrapper = (...args) => observed(...args);
  globalThis.fetch = laterWrapper;
  await observer.handle.close();
  assert.equal(globalThis.fetch, laterWrapper, 'unloading must preserve a later data-property owner');
  assert.equal(await (await fetch(f.origin + '/echo')).text(), 'ACK:');
});

test('Inspector patch is idempotent, rejects unknown bytes, rolls back a real later write failure and handles absence', async t => {
  const directory = fs.mkdtempSync(path.join(root, 'inspector-patch-'));
  const modules = path.join(directory, 'node_modules');
  const inspector = path.join(modules, '@deepseek-ai/dsh-experimental-inspector/lib/index.js');
  const billion = path.join(modules, 'billion-context/dist/agent/dsh-native.js');
  const receipt = path.resolve(root, '../../receipts');
  for (const [name, version] of [['@deepseek-ai/dsh', '0.2.2-rc.1'], ['billion-context', '0.1.212']]) { const file = path.join(modules, name, 'package.json'); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify({version})); }
  for (const [target, name] of [[inspector, 'inspector-original-index.js'], [billion, 'inspector-original-billion-native.js']]) { fs.mkdirSync(path.dirname(target), {recursive: true}); fs.copyFileSync(path.join(receipt, name), target); }
  t.after(() => { fs.chmodSync(path.dirname(billion), 0o755); fs.rmSync(directory, {recursive: true, force: true}); });
  const originalInspector = fs.readFileSync(inspector), originalBillion = fs.readFileSync(billion);
  fs.chmodSync(path.dirname(billion), 0o555);
  await assert.rejects(() => applyRc1InspectorCompatibility(directory), /EACCES|EPERM/);
  assert.deepEqual(fs.readFileSync(inspector), originalInspector); assert.deepEqual(fs.readFileSync(billion), originalBillion);
  fs.chmodSync(path.dirname(billion), 0o755);
  assert.equal((await applyRc1InspectorCompatibility(directory)).changed, 2);
  assert.equal((await applyRc1InspectorCompatibility(directory)).changed, 0);
  const patchedInspector = fs.readFileSync(inspector); fs.appendFileSync(billion, '\n// user work\n');
  const unknown = fs.readFileSync(billion);
  await assert.rejects(() => applyRc1InspectorCompatibility(directory));
  assert.deepEqual(fs.readFileSync(inspector), patchedInspector); assert.deepEqual(fs.readFileSync(billion), unknown);
  fs.rmSync(path.join(modules, 'billion-context/package.json'));
  assert.equal((await applyRc1InspectorCompatibility(directory)).skipped, 'billion-not-installed');
});
