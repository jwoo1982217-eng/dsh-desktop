import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { Miniflare } from 'miniflare';
import WebSocket from 'ws';

// Every request and WebSocket below crosses a real local workerd runtime.
const artifacts = resolve(process.env.RELAY_TEST_ARTIFACTS || '.test-artifacts');
const admin = 'synthetic-local-test-admin-key-not-a-real-secret';
const proof = 'a'.repeat(64);
const sockets = new Set();
let runtime, base;
const room = () => randomBytes(16).toString('hex');
const headers = { authorization: `Bearer ${admin}`, 'content-type': 'application/json' };

async function start(extraBindings = {}) {
  await mkdir(artifacts, { recursive: true });
  runtime = new Miniflare({
    name: 'dsh-private-relay-test', modules: true,
    scriptPath: fileURLToPath(new URL('./worker.mjs', import.meta.url)),
    compatibilityDate: '2026-07-30', host: '127.0.0.1', port: 0,
    bindings: { ADMIN_KEY: admin, ...extraBindings },
    durableObjects: { ROOMS: { className: 'RelayRoom', useSQLite: true } },
    durableObjectsPersist: resolve(artifacts, 'local-storage'),
  });
  base = (await runtime.ready).origin;
}
before(start);
after(async () => { for (const ws of sockets) ws.terminate(); await runtime?.dispose(); });

async function request(path, init) { return runtime.dispatchFetch(base + path, init); }
async function register(id, value = proof) {
  return request('/admin/rooms', { method: 'POST', headers, body: JSON.stringify({ room: id, proof: value }) });
}
async function registered(id) { assert.equal((await register(id)).status, 201); }
async function upgrade(id, value = proof, suffix = '') {
  return request(`/relay?room=${id}${suffix}`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${value}` } });
}
async function connect(id, value = proof) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + `/relay?room=${id}`, {
    headers: { Authorization: `Bearer ${value}` }, perMessageDeflate: false,
    // workerd delivers alarm-originated Close before completing TCP teardown.
    closeTimeout: 1000,
  });
  sockets.add(ws);
  const queue = [], waiters = [];
  ws.on('message', (data, binary) => {
    const item = { data, binary };
    if (waiters.length) waiters.shift()(item); else queue.push(item);
  });
  ws.on('error', () => {});
  ws.closed = new Promise(resolveClose => ws.once('close', (code) => { sockets.delete(ws); resolveClose(code); }));
  // Observe ws's actual protocol decoder before TCP teardown completes.
  ws.closeFrame = new Promise(resolveFrame => ws.once('open', () => ws._receiver.once('conclude', resolveFrame)));
  ws.next = (timeout = 4000) => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolveNext, reject) => {
      const deliver = item => { clearTimeout(timer); resolveNext(item); };
      const timer = setTimeout(() => { const i = waiters.indexOf(deliver); if (i >= 0) waiters.splice(i, 1); reject(Error('Expected relay frame did not arrive')); }, timeout);
      waiters.push(deliver);
    });
  };
  ws.signal = async type => { const item = await ws.next(); assert.equal(item.binary, false); assert.deepEqual(JSON.parse(item.data.toString()), { type }); };
  await new Promise((opened, failed) => {
    ws.once('open', opened);
    ws.once('error', failed);
    ws.once('unexpected-response', (_req, response) => { response.resume(); failed(Error(`Upgrade rejected: ${response.statusCode}`)); });
  });
  return ws;
}
async function join(ws, id, role, value = proof) {
  ws.send(JSON.stringify({ type: 'join', room: id, proof: value, role }));
  await ws.signal('joined');
}
async function paired(id) {
  await registered(id);
  const computer = await connect(id), phone = await connect(id);
  await join(computer, id, 'computer'); await join(phone, id, 'phone');
  await computer.signal('peer-online'); await phone.signal('peer-online');
  return { computer, phone };
}
async function closed(ws, expected, timeout = 4000) {
  let timer;
  try { assert.equal(await Promise.race([ws.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Expected socket close did not arrive')), timeout); })]), expected); }
  finally { clearTimeout(timer); }
}

test('health has no identities and admin registration requires the admin secret', async () => {
  const health = await request('/health');
  assert.equal(health.status, 200); assert.equal(await health.text(), 'ok');
  assert.equal((await request('/admin/rooms', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await request('/admin/rooms', { method: 'POST', headers: { ...headers, authorization: `Bearer ${proof}` }, body: '{}' })).status, 401);
  assert.equal((await request('/admin/rooms/' + room(), { method: 'DELETE' })).status, 401);
});

test('routing, methods, body size and registration schema are bounded before mutation', async () => {
  assert.equal((await request('/unknown', { method: 'POST' })).status, 404);
  assert.equal((await request('/admin/rooms', { method: 'GET' })).status, 405);
  assert.equal((await request('/admin/rooms', { method: 'POST', headers: { 'content-length': '513' }, body: 'x'.repeat(513) })).status, 413);
  assert.equal((await request('/admin/rooms', { method: 'POST', headers, body: 'x'.repeat(513) })).status, 413);
  assert.equal((await request('/admin/rooms', { method: 'POST', headers, body: '{bad' })).status, 400);
  assert.equal((await register('A'.repeat(32))).status, 400);
  assert.equal((await register(room(), 'F'.repeat(64))).status, 400);
  assert.equal((await request('/admin/rooms', { method: 'POST', headers, body: JSON.stringify({ room: room(), proof, extra: true }) })).status, 400);
});

test('room registration is idempotent and never overwrites a different proof', async () => {
  const id = room(); await registered(id);
  assert.equal((await register(id)).status, 200);
  assert.equal((await register(id, 'b'.repeat(64))).status, 409);
  assert.equal((await upgrade(id, 'b'.repeat(64))).status, 403);
});

test('WebSocket admission rejects missing proof, malformed room, unregistered and wrong proof', async () => {
  const id = room();
  assert.equal((await upgrade(id)).status, 403);
  await registered(id);
  assert.equal((await request(`/relay?room=${id}`, { headers: { Upgrade: 'websocket' } })).status, 403);
  assert.equal((await upgrade(id, 'b'.repeat(64))).status, 403);
  assert.equal((await upgrade(id, proof, `&room=${id}`)).status, 400);
  assert.equal((await upgrade('invalid')).status, 400);
  assert.equal((await request(`/relay?room=${id}`)).status, 426);
});

test('registered peers relay exact opaque v1 text and binary ciphertext in both directions', async () => {
  const { computer, phone } = await paired(room());
  const handshake = ' {"phase":"handshake", "frame":{"v":1,"body":"opaque+/=="}} ';
  phone.send(handshake);
  const text = await computer.next(); assert.equal(text.binary, false); assert.equal(text.data.toString(), handshake);
  const ciphertext = Buffer.from([0, 255, 10, 13, 192, 128, 0, 44]);
  computer.send(ciphertext, { binary: true });
  const binary = await phone.next(); assert.equal(binary.binary, true); assert.deepEqual(binary.data, ciphertext);
  phone.close(1000); await closed(phone, 1000); await computer.signal('peer-offline');
  computer.close(1000);
});

test('saved proof reconnects after both clients disconnect', async () => {
  const id = room(); const first = await paired(id);
  first.phone.close(1000); await closed(first.phone, 1000); await first.computer.signal('peer-offline');
  first.computer.close(1000); await closed(first.computer, 1000);
  const second = await connect(id); await join(second, id, 'phone'); second.close(1000);
});

test('hibernation restores socket attachments and keeps opaque forwarding intact', async () => {
  const id = room(), { computer, phone } = await paired(id);
  await runtime.unsafeEvictDurableObject('dsh-private-relay-test', 'RelayRoom', { name: id, webSockets: 'hibernate' });
  phone.send('after-hibernation');
  assert.equal((await computer.next()).data.toString(), 'after-hibernation');
  computer.send('restored-role'); assert.equal((await phone.next()).data.toString(), 'restored-role');
  phone.close(1000); await closed(phone, 1000); await computer.signal('peer-offline'); computer.close(1000);
});

test('same-role takeover closes stale socket without clearing the replacement', async () => {
  const id = room(), { computer, phone: stale } = await paired(id);
  const replacement = await connect(id); await join(replacement, id, 'phone');
  await computer.signal('peer-online'); await replacement.signal('peer-online');
  await closed(stale, 1000);
  computer.send('after-stale-close');
  assert.equal((await replacement.next()).data.toString(), 'after-stale-close');
  replacement.send('new-owner'); assert.equal((await computer.next()).data.toString(), 'new-owner');
  replacement.close(1000); await closed(replacement, 1000); await computer.signal('peer-offline'); computer.close(1000);
});

test('initial join must match the admitted room/proof and valid role', async () => {
  const id = room(); await registered(id);
  for (const change of [{ room: room() }, { proof: 'b'.repeat(64) }, { role: 'admin' }, { type: 'session' }]) {
    const ws = await connect(id);
    ws.send(JSON.stringify({ type: 'join', room: id, proof, role: 'phone', ...change }));
    await closed(ws, 1008);
  }
  const large = await connect(id); large.send(' '.repeat(2049)); await closed(large, 1008);
  const binary = await connect(id); binary.send(Buffer.from('{}')); await closed(binary, 1008);
});

test('unjoined sockets are capped and expire without pinning the room in memory', { timeout: 15000 }, async () => {
  const id = room(); await registered(id);
  const a = await connect(id), b = await connect(id);
  assert.equal((await upgrade(id)).status, 429);
  assert.deepEqual(await Promise.all([a.closeFrame, b.closeFrame]), [1008, 1008]);
  assert.equal(a._closeFrameReceived, true); assert.equal(b._closeFrameReceived, true);
  const retry = await connect(id); await join(retry, id, 'phone'); retry.close(1000);
  await closed(a, 1008, 9000); await closed(b, 1008, 9000);
});

test('one MiB boundary passes unchanged and oversized frames close the sender', async () => {
  const { computer, phone } = await paired(room());
  const boundary = Buffer.alloc(1024 * 1024, 0x5a);
  phone.send(boundary); assert.deepEqual((await computer.next()).data, boundary);
  phone.send(Buffer.alloc(1024 * 1024 + 1));
  await closed(phone, 1009); await computer.signal('peer-offline'); computer.close(1000);
});

test('revocation closes clients, rejects saved credentials and allows explicit admin re-enable', async () => {
  const id = room(), { computer, phone } = await paired(id);
  assert.equal((await request(`/admin/rooms/${id}`, { method: 'DELETE', headers })).status, 200);
  await closed(phone, 1008); await closed(computer, 1008);
  assert.equal((await upgrade(id)).status, 403);
  assert.equal((await register(id, 'b'.repeat(64))).status, 409);
  assert.equal((await register(id)).status, 200);
  const reenabled = await connect(id); await join(reenabled, id, 'phone'); reenabled.close(1000);
});

test('SQLite authorization and revocation survive full local runtime disposal/restart', async () => {
  const active = room(), revoked = room(); await registered(active); await registered(revoked);
  assert.equal((await request(`/admin/rooms/${revoked}`, { method: 'DELETE', headers })).status, 200);
  for (const ws of sockets) ws.terminate();
  await runtime.dispose(); await start();
  const restored = await connect(active); await join(restored, active, 'phone'); restored.close(1000);
  assert.equal((await upgrade(revoked)).status, 403);
  assert.equal((await upgrade(active, 'b'.repeat(64))).status, 403);
});

test('transport ping receives protocol pong without adding business messages', { timeout: 5000 }, async () => {
  const id = room(); await registered(id);
  const ws = await connect(id); await join(ws, id, 'phone');
  const payload = Buffer.from('transport-liveness');
  const pong = new Promise(resolvePong => ws.once('pong', resolvePong)); ws.ping(payload);
  assert.deepEqual(await pong, payload);
  await assert.rejects(ws.next(100), /Expected relay frame/); ws.close(1000);
});

test('connect landing reads capability only from the fragment and offers only an explicit DSH link', async () => {
  const result = await request('/connect'); assert.equal(result.status, 200);
  const html = await result.text();
  assert.match(result.headers.get('content-type'), /^text\/html/);
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script); assert.match(script, /location\.hash/);
  assert.ok(result.headers.get('content-security-policy').includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`));
  assert.ok(!html.includes(proof)); assert.ok(!html.includes(admin));
  function render(hash) {
    const elements = { open: { hidden: true }, status: {} };
    runInNewContext(script, { location: { hash }, document: { getElementById: id => elements[id] } });
    return elements;
  }
  const capability = 'dsh-peer:1:eyJ2ZXJzaW9uIjoxfQ';
  const valid = render('#' + capability);
  assert.equal(valid.open.href, 'dsh-phone://peer/connect#' + capability); assert.equal(valid.open.hidden, false);
  for (const invalid of ['', '#https://example.com', '#dsh-peer:1:bad/value', '#' + 'dsh-peer:1:' + 'a'.repeat(2048)]) {
    const view = render(invalid); assert.equal(view.open.hidden, true); assert.equal(view.open.href, undefined);
  }
  assert.equal((await request('/connect', { method: 'POST' })).status, 405);
});

test('assetlinks is absent unless valid Android signing fingerprints are configured', async () => {
  assert.equal((await request('/.well-known/assetlinks.json')).status, 404);
  for (const ws of sockets) ws.terminate(); await runtime.dispose();
  const first = Array(32).fill('aa').join(':'), second = Array(32).fill('BB').join(':');
  await start({ ANDROID_CERT_SHA256: `${first}, ${second}` });
  const result = await request('/.well-known/assetlinks.json'); assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), [{ relation: ['delegate_permission/common.handle_all_urls'], target: {
    namespace: 'android_app', package_name: 'com.dshphone', sha256_cert_fingerprints: [first.toUpperCase(), second],
  } }]);
  assert.equal((await request('/.well-known/assetlinks.json', { method: 'POST' })).status, 405);
  await runtime.dispose(); await start({ ANDROID_CERT_SHA256: `${first},invalid` });
  assert.equal((await request('/.well-known/assetlinks.json')).status, 404);
});
