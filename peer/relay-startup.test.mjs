import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createRelay } from './relay.mjs';
import { PeerTunnel } from './tunnel.mjs';
import { newPair } from './protocol.mjs';

const exec = promisify(execFile);
const loader = fileURLToPath(new URL('../scripts/desktop-test-imports.mjs', import.meta.url));
const relayFile = fileURLToPath(new URL('./relay.mjs', import.meta.url));
const listen = (server, host = '127.0.0.1') => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, () => resolve(server.address().port)); });
const waitFor = async condition => { const deadline = Date.now() + 5000; while (!condition()) { if (Date.now() > deadline) throw Error('Synthetic peer connection timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } };
async function occupiedPort(t, host = '127.0.0.1') {
  const server = createServer(), port = await listen(server, host);
  t.after(() => new Promise(resolve => server.close(resolve)));
  return port;
}
async function child(t, source) {
  const dir = await mkdtemp(path.join(tmpdir(), 'relay-startup-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'child.mjs'); await writeFile(file, source.replaceAll('__FIXTURE_HOME__', JSON.stringify(path.join(dir, 'home'))));
  return exec(process.execPath, ['--import', loader, file], { timeout: 7000, env: { ...process.env, DSH_HOME: path.join(dir, 'home') }, maxBuffer: 1024 * 1024 });
}
const hostFixture = `
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
const host=createServer((req,res)=>res.end('host healthy'));
await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));
const health=async()=>{const response=await fetch('http://127.0.0.1:'+host.address().port);assert.equal(response.status,200);assert.equal(await response.text(),'host healthy')};
`;

test('managed listen rejects EADDRINUSE while its host process remains healthy', async t => {
  const port = await occupiedPort(t);
  const result = await child(t, hostFixture + `
import {createRelay} from ${JSON.stringify(new URL('./relay.mjs', import.meta.url).href)};
const relay=createRelay();let caught=0;
try {
  await assert.rejects(new Promise((resolve,reject)=>{relay.server.once('error',error=>{caught++;reject(error)});relay.server.listen(${port},'127.0.0.1',resolve)}),{code:'EADDRINUSE'});
  assert.equal(caught,1);await health();console.log('managed-error-caught-host-healthy');
} finally {await relay.close();await new Promise(resolve=>host.close(resolve))}
`);
  assert.equal(result.stdout.trim(), 'managed-error-caught-host-healthy');
});

test('actual DeviceLinks relay caller receives its friendly failure and preserves its host', async t => {
  const port = await occupiedPort(t, '0.0.0.0');
  const result = await child(t, hostFixture + `
import {DeviceLinks} from ${JSON.stringify(new URL('./knowledge-link/devices.mjs', import.meta.url).href)};
const links=new DeviceLinks(__FIXTURE_HOME__,{},{computer:true,port:${port}});
try {await assert.rejects(links.relay(),/局域网连接端口被占用/);assert.equal(links.relayServer,undefined);await health();console.log('device-links-failure-caught-host-healthy')}
finally {await links.close();await new Promise(resolve=>host.close(resolve))}
`);
  assert.equal(result.stdout.trim(), 'device-links-failure-caught-host-healthy');
});

test('standalone relay CLI without an error handler exits nonzero and reports occupied port', async t => {
  const port = await occupiedPort(t);
  await assert.rejects(exec(process.execPath, ['--import', loader, relayFile], {
    timeout: 7000, env: { ...process.env, DSH_RELAY_HOST: '127.0.0.1', DSH_RELAY_PORT: String(port) }, maxBuffer: 1024 * 1024,
  }), error => {
    assert.equal(typeof error.code, 'number'); assert.notEqual(error.code, 0);
    assert.match(error.stderr, /EADDRINUSE/); assert.match(error.stderr, new RegExp(String(port)));
    assert.doesNotMatch(error.stdout, /DSH relay listening/); return true;
  });
});

test('relay still serves health, forwards encrypted RPC, and rejects wrong proof and upgrade path', async t => {
  const relay = createRelay(), port = await listen(relay.server), pair = newPair(`ws://127.0.0.1:${port}/relay`);
  const phone = new PeerTunnel(pair, 'phone'), computer = new PeerTunnel(pair, 'computer');
  t.after(async () => { phone.stop(); computer.stop(); await relay.close(); });
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  phone.start(); computer.start(); await waitFor(() => phone.online && computer.online);
  const frames = []; relay.rooms.get(pair.room).phone.on('message', value => frames.push(value.toString()));
  computer.handler = (action, value) => ({ action, value });
  const secret = 'synthetic-private-rpc-content';
  assert.deepEqual(await phone.call('fixture', { secret }), { action: 'fixture', value: { secret } });
  assert.ok(frames.length); assert.ok(frames.every(frame => !frame.includes(secret)));
  const denied = new WebSocket(pair.relay); await once(denied, 'open');
  denied.send(JSON.stringify({ type: 'join', room: pair.room, role: 'phone', proof: '0'.repeat(64) }));
  assert.equal((await once(denied, 'close'))[0], 1008);
  const wrongPath = new WebSocket(`ws://127.0.0.1:${port}/wrong-path`); t.after(() => wrongPath.terminate());
  await assert.rejects(once(wrongPath, 'open'), /Unexpected server response: 400/);
  assert.equal(phone.online, true); assert.equal(computer.online, true);
});

test('close completes before any listen and after a successful listen, releasing the owned server', async () => {
  const bounded = async operation => {
    let timer;
    try { await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Relay close did not complete')), 1500); })]); }
    finally { clearTimeout(timer); }
  };
  const neverListened = createRelay(); await bounded(neverListened.close());
  assert.equal(neverListened.server.listenerCount('upgrade'), 0);
  const relay = createRelay(), port = await listen(relay.server); await bounded(relay.close());
  assert.equal(relay.server.listening, false); assert.equal(relay.server.listenerCount('upgrade'), 0);
  const replacement = createServer();
  await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => replacement.close(resolve));
});
