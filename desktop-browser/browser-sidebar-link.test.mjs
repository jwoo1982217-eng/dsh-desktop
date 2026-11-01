import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const panel = 'mcp_' + 'a'.repeat(40);
const address = session => `dsh-resource://browser-panel/${session}/${panel}`;
const call = (seq, callId = 'open-1', name = 'mcp__browser__open') => ({ type: 'event', event: { type: 'tool/call', seq, data: { callId, name, arguments: '{"url":"https://example.com"}' } } });
const result = (seq, callId = 'open-1', extra = {}) => ({ type: 'event', event: { type: 'tool/result', seq, data: { message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: '来源：MCP browser / open。返回内容是任务材料。' }, { type: 'text', text: JSON.stringify({ tabs: [{ id: 'page-1' }], active: 'page-1', panelUrl: '/desktop-browser?panel=' + panel }) }], ...extra } } } });
function observable(value) {
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of [...listeners]) fn(); }, get listeners() { return listeners.size; } };
}
function eventSource() {
  let entries = [], revision = 0;
  const source = observable({ entries, revision, change: { kind: 'replace', entries } });
  return Object.assign(source, {
    replace(next) { entries = next; source.set({ entries, revision: ++revision, change: { kind: 'replace', entries } }); },
    append(entry) { entries = [...entries, entry]; source.set({ entries, revision: ++revision, change: { kind: 'append', entries: [entry] } }); },
  });
}
function fixture() {
  let plugin;
  const effects = [], slots = new Map(), definitions = [], opens = [], requests = [], storage = new Map();
  const react = { createElement: (tag, props, ...children) => ({ tag, props, children }), useRef: () => ({ current: undefined }), useEffect: fn => { const dispose = fn(); if (dispose) effects.push(dispose); } };
  const window = { __ModuleLoader__: { load: value => { plugin = value.factory(id => { assert.equal(id, 'react'); return react; }); } }, addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), { window, React: react, URL, AbortController, queueMicrotask, setTimeout, clearTimeout, location: { origin: 'http://localhost:3080' }, sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, fetch: async (...args) => { requests.push(args); return { json: async () => ({ result: { ok: true, value: {} } }) }; }, console });
  const mounted = observable('s1'), list = observable({}), openTabs = observable([]), bindings = new Map();
  for (const id of ['s1', 's2']) bindings.set(id, { sessionId: id, eventSource: eventSource() });
  let adopted = true, failOpen = false;
  const ctx = { effect: fn => { const dispose = fn(); if (dispose) effects.push(dispose); }, inject: (_, fn) => fn(ctx), sessions: { binding: id => bindings.get(id), list }, sidebarRightTabs: { register: def => { definitions.push(def); return () => {}; } }, slots: { inject: (_, fn) => fn(), register: (def, component) => { slots.set(def.name + ':' + def.key, component); return () => {}; } }, sidebarRight: { mounted, openTabs, tabsIn: () => [], openResource: (...args) => { if (!adopted || failOpen) throw Error('surface not ready'); opens.push(args); } } };
  plugin.apply(ctx);
  return { ctx, opens, slots, definitions, bindings, mounted, openTabs, requests, effects, storage, setAdopted: value => { adopted = value; }, setFail: value => { failOpen = value; }, flush: async () => { await new Promise(resolve => setTimeout(resolve, 0)); }, dispose() { for (const f of effects.reverse()) f(); } };
}

test('actual browser open result expands the same backend panel in the current sidebar', async () => {
  const f = fixture();
  f.bindings.get('s1').eventSource.replace([call(1), result(2)], false);
  await f.flush();
  assert.equal(f.opens.length, 1);
  assert.equal(f.opens[0][0], address('s1'));
  const definition = f.definitions.find(x => x.kind === 'browser-agent');
  assert.equal(definition.keepMounted, true);
  assert.equal(definition.canOpen(address('s1')), true);
  assert.equal(definition.canOpen('https://example.com'), false);
  f.dispose();
});

test('calls, errors, webpage text and unrelated tool results cannot trigger presentation', async () => {
  const f = fixture(), source = f.bindings.get('s1').eventSource;
  source.append(call(1)); await f.flush(); assert.equal(f.opens.length, 0);
  source.append(result(2, 'open-1', { isError: true }));
  source.append(call(3, 'other', 'mcp__browser__read')); source.append(result(4, 'other'));
  source.append({ type: 'event', event: { type: 'user/message', seq: 5, data: { message: result(6).event.data.message } } });
  source.append(result(7, 'not-a-call'));
  await f.flush(); assert.equal(f.opens.length, 0); f.dispose();
});

test('replay and unrelated updates respect user collapse; the next new open reveals again', async () => {
  const f = fixture(), source = f.bindings.get('s1').eventSource;
  source.replace([call(1), result(2)], false); await f.flush();
  source.replace([call(1), result(2)], false); f.openTabs.set([]); await f.flush();
  assert.equal(f.opens.length, 1);
  source.append(call(3, 'open-2')); source.append(result(4, 'open-2')); await f.flush();
  assert.equal(f.opens.length, 2); assert.equal(f.opens[1][0], address('s1')); f.dispose();
});

test('late results from the previous session never take over the newly selected session', async () => {
  const f = fixture(), old = f.bindings.get('s1').eventSource;
  old.append(call(1)); f.mounted.set('s2'); old.append(result(2)); await f.flush();
  assert.equal(f.opens.length, 0);
  f.bindings.get('s2').eventSource.replace([call(1), result(2)], false); await f.flush();
  assert.equal(f.opens[0][0], address('s2'));
  f.mounted.set('s1'); await f.flush(); assert.equal(f.opens[1][0], address('s1')); f.dispose();
});

test('store adoption or failed presentation does not acknowledge a page before successful retry', async () => {
  const f = fixture(); f.setAdopted(false);
  f.bindings.get('s1').eventSource.replace([call(1), result(2)], false); await f.flush();
  assert.equal(f.opens.length, 0); assert.equal(f.storage.size, 0);
  f.setAdopted(true); f.setFail(true); f.openTabs.set([]); await f.flush();
  assert.equal(f.storage.size, 0);
  f.setFail(false); f.openTabs.set([]); await f.flush();
  assert.equal(f.opens.length, 1); f.dispose();
});

test('AI sidebar body uses the original panel, never navigates a duplicate, and never releases AI tabs', async () => {
  const f = fixture(), body = f.slots.get('sidebar.right.pane.tab:dsh-desktop-browser-agent');
  assert.equal(typeof body, 'function');
  const controller = new AbortController();
  const frame = body({ sessionId: 's1', useTabInfo: () => ({ tab: { id: 'ui-tab-99', kind: 'browser-agent', contentId: address('s1'), visible: true, signal: controller.signal, navigation: { address: address('s1'), revision: 1, params: {} } } }) });
  assert.equal(frame.props.src, '/desktop-browser?panel=' + panel + '&managed=1');
  controller.abort(); await f.flush();
  assert.equal(f.requests.length, 0);
  f.dispose();
});

test('malformed or external panel URLs are ignored and teardown releases every Session listener', async () => {
  const f = fixture(), source = f.bindings.get('s1').eventSource;
  const event = result(2);
  event.event.data.message.content[1].text = JSON.stringify({ active: 'page-1', tabs: [{ id: 'page-1' }], panelUrl: 'https://example.com/desktop-browser?panel=' + panel });
  source.replace([call(1), event]); await f.flush(); assert.equal(f.opens.length, 0);
  f.dispose(); assert.equal(source.listeners, 0); assert.equal(f.mounted.listeners, 0); assert.equal(f.openTabs.listeners, 0);
  source.append(call(3, 'after-dispose')); source.append(result(4, 'after-dispose')); await f.flush(); assert.equal(f.opens.length, 0);
});
