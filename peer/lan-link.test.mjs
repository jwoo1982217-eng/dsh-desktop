import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRelay } from './relay.mjs';
import { newPair, pairCode } from './protocol.mjs';
import { PeerTunnel } from './tunnel.mjs';
import { createPeerProxy } from './proxy.mjs';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { lanInterfaces } from './lan-network.mjs';

const module = await import('./lan-link.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const waitFor = async fn => {
  const until = Date.now() + 5000;
  while (!fn()) { if (Date.now() > until) throw Error('LAN link condition timed out'); await new Promise(r => setTimeout(r, 10)); }
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function fixture(t, relayEnabled = true) {
  assert.equal(typeof module.LanPeerTunnel, 'function', 'The existing paired transport needs LAN preference');
  const relay = createRelay(), port = await listen(relay.server), pair = newPair(`ws://127.0.0.1:${port}/relay`);
  const lan = { discovery: false, addresses: () => ['127.0.0.1'], allowLoopback: true, cacheFile: false };
  const opts = { reconnectMs: 20, maxReconnectMs: 50, lan, handshakeTimeoutMs: 600 };
  if (!relayEnabled) { await relay.close(); pair.relay = 'ws://127.0.0.1:9/relay'; }
  const computer = new module.LanPeerTunnel(pair, 'computer', opts), phone = new module.LanPeerTunnel(pair, 'phone', opts);
  t.after(async () => { await Promise.all([phone.stop(), computer.stop()]); if (relayEnabled) await relay.close(); });
  computer.handler = (action, value) => ({ action, value });
  computer.start(); phone.start();
  await waitFor(() => computer.lanCandidates.length);
  phone.addLanCandidates(computer.lanCandidates);
  await waitFor(() => computer.route === 'lan' && phone.route === 'lan');
  return { computer, phone, pair, relay };
}

test('same saved pairing uses LAN even when the external relay is unreachable', async t => {
  const { computer, phone, pair } = await fixture(t, false), before = pairCode(pair);
  assert.deepEqual(await phone.call('read', { n: 1 }), { action: 'read', value: { n: 1 } });
  assert.equal(pairCode(phone.pair), before); assert.equal(pairCode(computer.pair), before);
  assert.equal(phone.relay.online, false);
});

test('LAN loss falls back to the already paired relay without reconnecting the UI transport', async t => {
  const { computer, phone } = await fixture(t);
  await waitFor(() => computer.routes.includes('relay') && phone.routes.includes('relay'));
  let offline = 0; phone.on('offline', () => offline++);
  phone.lanPeer.stop();
  await waitFor(() => phone.route === 'relay' && computer.route === 'relay');
  assert.deepEqual(await phone.call('read', 2), { action: 'read', value: 2 });
  assert.equal(offline, 0, 'A route change must not tear down the stable UI proxy');
});

test('a route change delivers ordered packets and a mutation exactly once after a lost acknowledgement', async t => {
  const { computer, phone } = await fixture(t);
  await waitFor(() => computer.routes.includes('relay') && phone.routes.includes('relay'));
  const received = []; let writes = 0;
  computer.on('packet', packet => received.push(packet.n));
  computer.handler = () => ++writes;
  const original = computer.lanPeer.send.bind(computer.lanPeer);
  computer.lanPeer.send = packet => { if (packet.type !== 'link.ack') original(packet); };
  for (let n = 0; n < 20; n++) phone.send({ type: 'fixture', n });
  assert.equal(await phone.call('mutation', {}), 1);
  await waitFor(() => received.length === 20);
  phone.lanPeer.stop();
  await waitFor(() => phone.route === 'relay');
  phone.send({ type: 'fixture', n: 20 });
  await waitFor(() => received.length === 21 && phone.outbox.size === 0);
  assert.deepEqual(received, Array.from({ length: 21 }, (_, i) => i)); assert.equal(writes, 1);
});

test('losing every route rejects a pending operation and does not submit it after recovery', async t => {
  const { computer, phone } = await fixture(t);
  let writes = 0, release;
  computer.handler = action => { if (action !== 'mutation') return 'recovered'; writes++; return new Promise(resolve => { release = resolve; }); };
  const pending = phone.call('mutation', {}); const rejected = assert.rejects(pending, /断开|离线/);
  await waitFor(() => writes === 1);
  phone.relay.retire('PEER_NETWORK', true); phone.lanPeer.retire('PEER_NETWORK', true);
  await rejected; release('finished');
  await waitFor(() => phone.online && computer.online);
  assert.equal(await phone.call('read', {}, 1500), 'recovered');
  assert.equal(writes, 1); assert.equal(phone.pending.size, 0);
});

test('an older paired peer continues using the relay protocol', async t => {
  assert.equal(typeof module.LanPeerTunnel, 'function');
  const relay = createRelay(), port = await listen(relay.server), pair = newPair(`ws://127.0.0.1:${port}/relay`);
  const old = new PeerTunnel(pair, 'computer'), phone = new module.LanPeerTunnel(pair, 'phone', { lan: { enabled: false } });
  t.after(async () => { old.stop(); await phone.stop(); await relay.close(); });
  old.handler = (action, value) => { if (action === 'link.hello') throw Error('Unknown peer operation'); return value; };
  old.start(); phone.start(); await waitFor(() => phone.online);
  assert.equal(phone.route, 'relay'); assert.deepEqual(await phone.call('read', { compatible: true }), { compatible: true });
});

test('LAN candidates cannot dial public addresses, hostnames, URL credentials or invalid ports', () => {
  assert.equal(typeof module.validLanCandidate, 'function');
  for (const value of [{ host: '8.8.8.8', port: 443 }, { host: 'example.com', port: 80 }, { host: '127.0.0.1', port: 3080 }, { host: '192.168.1.2@evil.test', port: 80 }, { host: '192.168.1.2', port: -1 }]) assert.equal(module.validLanCandidate(value), false);
  assert.equal(module.validLanCandidate({ host: '192.168.1.2', port: 12345 }), true);
});

test('paired broadcast discovery finds the computer without the cloud or manual LAN address', async t => {
  const interfaces = lanInterfaces(); if (!interfaces.length) return t.skip('No private physical interface in this test host');
  const pair = newPair('ws://127.0.0.1:9/relay');
  const computer = new module.LanPeerTunnel(pair, 'computer', { lan: { cacheFile: false } });
  const phone = new module.LanPeerTunnel(pair, 'phone', { lan: { cacheFile: false } });
  t.after(async () => { await phone.stop(); await computer.stop(); });
  computer.handler = () => 'discovered'; computer.start(); phone.start();
  await waitFor(() => phone.route === 'lan');
  assert.equal(await phone.call('read', {}), 'discovered'); assert.equal(phone.relay.online, false);
});

test('a different pairing cannot join the LAN ciphertext endpoint', async t => {
  const { computer } = await fixture(t, false), candidate = computer.lanCandidates[0];
  const intruder = new PeerTunnel(newPair('ws://127.0.0.1:9/relay'), 'phone', { endpoint: `ws://${candidate.host}:${candidate.port}/relay`, handshakeTimeoutMs: 100, reconnectMs: 10000 });
  t.after(() => intruder.stop()); intruder.start();
  await waitFor(() => intruder.phase === 'retrying');
  assert.equal(intruder.online, false); assert.equal(computer.lanRelay.rooms.size, 1);
});

test('large real browser websocket data stays intact and the same socket survives LAN to relay', async t => {
  const { computer, phone } = await fixture(t);
  await waitFor(() => computer.routes.includes('relay') && phone.routes.includes('relay'));
  const ui = createServer(), webPort = await listen(ui), sockets = new WebSocketServer({ server: ui, path: '/api/remote.mux' });
  const desktopProxy = createPeerProxy(computer, { role: 'computer', webPort }), phoneProxy = createPeerProxy(phone, { role: 'phone' });
  computer.handler = (action, value) => desktopProxy.action(action, value); phone.handler = (action, value) => phoneProxy.action(action, value);
  const proxyPort = await listen(phoneProxy.ui), snapshot = 'large-history-' + 'x'.repeat(762671), messages = [];
  let upstream;
  sockets.on('connection', ws => { upstream = ws; ws.on('message', bytes => messages.push(String(bytes))); ws.send(snapshot); });
  const browser = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/remote.mux`), first = once(browser, 'message');
  t.after(async () => { browser.terminate(); phoneProxy.close(); desktopProxy.close(); for (const ws of sockets.clients) ws.terminate(); await new Promise(resolve => sockets.close(resolve)); for (const server of [phoneProxy.ui, ui]) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  assert.equal(String((await first)[0]), snapshot); let closed = 0; browser.on('close', () => closed++);
  phone.lanPeer.stop(); await waitFor(() => phone.route === 'relay' && computer.route === 'relay');
  const after = once(browser, 'message'); upstream.send('same-browser-after-switch');
  assert.equal(String((await after)[0]), 'same-browser-after-switch');
  browser.send('single-operation'); await waitFor(() => messages.length === 1);
  assert.deepEqual(messages, ['single-operation']); assert.equal(closed, 0);
});
