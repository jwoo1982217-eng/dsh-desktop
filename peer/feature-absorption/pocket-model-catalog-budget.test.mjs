import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const script = fs.readFileSync(new URL('./pocket-model-catalog-budget.js', import.meta.url), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (id, signal) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method: 'session/modelCatalog', payload: { args: {} } }), ...(signal ? { signal } : {}) });
const response = (id, result = { ok: true, value: { groups: [{ id: 'fixture', models: [{ id: 'synthetic' }] }], failures: [] } }) => new Response(JSON.stringify({ type: 'server-response', rpcId: id, result }), { headers: { 'content-type': 'application/json', 'content-length': '999' } });
function install(fetch, deadline = 40) {
  let activeTimers = 0;
  const timers = new Set();
  const context = vm.createContext({ fetch, location: new URL('http://127.0.0.1:3080/'), document: { baseURI: 'http://127.0.0.1:3080/' }, URL, Headers, Response, Request, TextEncoder, TextDecoder, Uint8Array, AbortController, AbortSignal, DOMException,
    setTimeout(fn, ms) { assert.equal(ms, 8000); activeTimers++; const timer = setTimeout(() => { timers.delete(timer); activeTimers--; fn(); }, deadline); timers.add(timer); return timer; },
    clearTimeout(timer) { if (timers.delete(timer)) activeTimers--; clearTimeout(timer); }
  });
  vm.runInContext(script, context);
  return { context, status: () => context.__dshModelCatalogBudget.status(), dispose: () => context.__dshModelCatalogBudget.dispose(), timers: () => activeTimers };
}
test('verified alpha.1 wire shares only in flight and rewrites every caller rpcId', async () => {
  const calls = []; let release;
  const f = install((input, init) => { calls.push({ input, init }); return new Promise(resolve => { release = () => resolve(response(JSON.parse(init.body).rpcId)); }); }, 500);
  const a = f.context.fetch('api/session/modelCatalog', request('one'));
  const b = f.context.fetch('/api/session/modelCatalog', request('two'));
  await delay(0); assert.equal(calls.length, 1); assert.equal(f.status().callers, 2); release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal((await first.json()).rpcId, 'one'); assert.equal((await second.json()).rpcId, 'two');
  assert.equal(first.headers.get('content-length'), null); assert.equal(f.status().shared, 1); assert.equal(f.timers(), 0);
  const again = f.context.fetch('/api/session/modelCatalog', request('three')); await delay(0); assert.equal(calls.length, 2); release(); assert.equal((await (await again).json()).rpcId, 'three'); f.dispose();
});
test('caller abort is local; last caller cancels underlying and next explicit call recovers', async () => {
  const calls = []; let release;
  const f = install((input, init) => { calls.push(init); return new Promise(resolve => { release = () => resolve(response(JSON.parse(init.body).rpcId)); }); }, 500);
  const a = new AbortController(), b = new AbortController();
  const first = f.context.fetch('/api/session/modelCatalog', request('a', a.signal));
  const second = f.context.fetch('/api/session/modelCatalog', request('b', b.signal));
  await delay(0); a.abort(); await assert.rejects(first, { name: 'AbortError' }); assert.equal(calls[0].signal.aborted, false);
  release(); assert.equal((await (await second).json()).rpcId, 'b');
  const c = new AbortController(); const third = f.context.fetch('/api/session/modelCatalog', request('c', c.signal)); await delay(0); c.abort(); await assert.rejects(third, { name: 'AbortError' }); assert.equal(calls[1].signal.aborted, true); assert.equal(f.status().active, 0); assert.equal(f.timers(), 0);
  const fourth = f.context.fetch('/api/session/modelCatalog', request('d')); await delay(0); release(); assert.equal((await (await fourth).json()).rpcId, 'd'); f.dispose();
});
test('8 second budget includes complete response body and clears after timeout without retry', async () => {
  let calls = 0, underlying;
  const f = install((input, init) => { calls++; underlying = init.signal; return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { headers: { 'content-type': 'application/json' } })); });
  const first = f.context.fetch('/api/session/modelCatalog', request('slow-body'));
  await assert.rejects(first, { name: 'TimeoutError' }); assert.equal(underlying.aborted, true); assert.equal(calls, 1); assert.equal(f.status().active, 0); assert.equal(f.status().timedOut, 1); assert.equal(f.timers(), 0); await delay(60); assert.equal(calls, 1); f.dispose();
});
test('deadline while awaiting headers releases all callers; a later manual retry works', async () => {
  let count = 0;
  const f = install((input, init) => ++count === 1 ? new Promise(() => {}) : Promise.resolve(response(JSON.parse(init.body).rpcId)));
  const first = f.context.fetch('/api/session/modelCatalog', request('a'));
  const second = f.context.fetch('/api/session/modelCatalog', request('b'));
  await Promise.all([assert.rejects(first, { name: 'TimeoutError' }), assert.rejects(second, { name: 'TimeoutError' })]);
  assert.equal((await (await f.context.fetch('/api/session/modelCatalog', request('retry'))).json()).rpcId, 'retry'); assert.equal(count, 2); f.dispose();
});
test('unmatched calls pass exact input/init through, including generation, bot, foreign origin and unknown schema', async () => {
  const calls = []; const original = function (...args) { calls.push(args); return Promise.resolve(new Response('unchanged')); };
  const f = install(original);
  const cases = [
    ['/api/agent/send', request('generation')], ['/api/bot', request('bot')], ['https://remote.example/api/session/modelCatalog', request('foreign')],
    ['/api/session/modelCatalog', { ...request('get'), method: 'GET' }], ['/api/session/modelCatalog?x=1', request('query')],
    ['/api/session/modelCatalog', { ...request('unknown'), body: JSON.stringify({ type: 'client-request', rpcId: 'unknown', method: 'session/modelCatalog', payload: {} }) }],
    ['/api/session/modelCatalog', { ...request('args'), body: JSON.stringify({ type: 'client-request', rpcId: 'args', method: 'session/modelCatalog', payload: { args: { sessionId: 'x' } } }) }],
    ['/api/session/modelCatalog', { ...request('auth'), headers: { 'content-type': 'application/json', authorization: 'fixture-only' } }],
    ['/api/session/modelCatalog', { ...request('creds'), credentials: 'omit' }], [new Request('http://127.0.0.1:3080/api/session/modelCatalog', request('req')), undefined]
  ];
  for (const [input, init] of cases) { assert.equal(await (await f.context.fetch(input, init)).text(), 'unchanged'); const args = calls.at(-1); assert.equal(args[0], input); assert.equal(args[1], init); }
  assert.equal(f.status().requests, 0); assert.equal(f.timers(), 0); f.dispose(); assert.equal(f.context.fetch, original);
});
test('correlation mismatch, invalid body and oversized stream fail safely, then recover', async () => {
  const replies = [() => response('wrong-id'), () => new Response('not json', { headers: { 'content-type': 'application/json' } }), () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })];
  const f = install((input, init) => Promise.resolve(replies.length ? replies.shift()() : response(JSON.parse(init.body).rpcId)), 500);
  for (let i = 0; i < 3; i++) { await assert.rejects(f.context.fetch('/api/session/modelCatalog', request('bad-' + i)), { name: 'NetworkError' }); assert.equal(f.status().active, 0); }
  assert.equal((await (await f.context.fetch('/api/session/modelCatalog', request('recovered'))).json()).rpcId, 'recovered'); f.dispose();
});
test('server RPC failure and HTTP authentication failure remain failures without empty-model fallback', async () => {
  const failure = { ok: false, error: { code: 'FIXTURE', message: 'synthetic only', details: {} } };
  const f = install((input, init) => Promise.resolve(response(JSON.parse(init.body).rpcId, failure)), 500);
  const [a, b] = await Promise.all(['a', 'b'].map(id => f.context.fetch('/api/session/modelCatalog', request(id)).then(r => r.json())));
  assert.equal(a.rpcId, 'a'); assert.equal(b.rpcId, 'b'); assert.deepEqual(a.result, failure); assert.deepEqual(b.result, failure); f.dispose();
  const auth = install(() => Promise.resolve(new Response('unauthorized', { status: 401 })), 500);
  const result = await auth.context.fetch('/api/session/modelCatalog', request('auth')); assert.equal(result.status, 401); assert.equal(await result.text(), 'unauthorized'); auth.dispose();
});
test('bounded subscribers, preaborted call, disposal and idempotent install', async () => {
  let requests = 0; const original = () => { requests++; return new Promise(() => {}); }; const f = install(original, 500);
  vm.runInContext(script, f.context); const aborted = new AbortController(); aborted.abort(); await assert.rejects(f.context.fetch('/api/session/modelCatalog', request('aborted', aborted.signal)), { name: 'AbortError' }); assert.equal(requests, 0);
  const pending = Array.from({ length: 128 }, (_, i) => f.context.fetch('/api/session/modelCatalog', request('caller-' + i)).catch(error => error.name));
  await assert.rejects(f.context.fetch('/api/session/modelCatalog', request('over-limit')), { name: 'QuotaExceededError' }); await delay(0); assert.equal(requests, 1);
  f.dispose(); assert.equal(f.context.fetch, original); assert.equal(f.timers(), 0); assert.equal(f.context.__dshModelCatalogBudget, undefined); assert.deepEqual(await Promise.all(pending), Array(128).fill('AbortError'));
});

test('Pocket shares proxy requests until a bounded 30 second deadline and cancellation restores native fetch', async () => {
 const calls=[];let fire;const original=(input,init)=>{calls.push(init);return new Promise(()=>{})};
 const context=vm.createContext({fetch:original,location:new URL('http://computer.test:3081/'),document:{baseURI:'http://computer.test:3081/',querySelector:s=>s==='script[data-dsh-pocket-polyfill="1"]'?{}:null},URL,Headers,Response,Request,TextEncoder,TextDecoder,Uint8Array,AbortController,AbortSignal,DOMException,setTimeout(fn,ms){assert.equal(ms,30000);fire=fn;return 1},clearTimeout(){}});
 vm.runInContext(script,context);assert.equal(context.__dshModelCatalogBudget.status().deadlineMs,30000);
 const a=context.fetch('/api/session/modelCatalog',request('pocket-one')),b=context.fetch('/api/session/modelCatalog',request('pocket-two'));
 await delay(0);assert.equal(calls.length,1);assert.equal(context.__dshModelCatalogBudget.status().callers,2);
 fire();await Promise.all([assert.rejects(a,{name:'TimeoutError'}),assert.rejects(b,{name:'TimeoutError'})]);assert.equal(calls[0].signal.aborted,true);
 context.__dshModelCatalogBudget.dispose();assert.equal(context.fetch,original);
});
