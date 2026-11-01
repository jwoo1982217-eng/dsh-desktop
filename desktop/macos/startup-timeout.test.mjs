import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import vm from 'node:vm';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Backend, startupTimeoutMs, statePath} from './app/backend.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check) {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() > deadline) throw Error('fixture timed out'); await pause(10); }
}
async function marker(home, port) {
  const deadline = Date.now() + 5000;
  while (true) {
    try { const state = JSON.parse(await fs.readFile(statePath(home, port), 'utf8')); if (state.starting) return state; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() > deadline) throw Error('starting marker timed out');
    await pause(10);
  }
}
async function fixture(t) {
  const base = process.env.DSH_STARTUP_TEST_DIR ?? os.tmpdir();
  await fs.mkdir(base, {recursive: true});
  const directory = await fs.mkdtemp(path.join(base, 'startup-'));
  const home = path.join(directory, 'home'), runtime = path.join(directory, 'runtime');
  const module = path.join(runtime, 'node_modules/@deepseek-ai/dsh');
  await fs.mkdir(path.join(module, 'lib'), {recursive: true});
  await fs.writeFile(path.join(module, 'package.json'), JSON.stringify({version: '0.2.1-alpha.4'}));
  await fs.writeFile(path.join(runtime, 'bundle.json'), JSON.stringify({version: 'fixture', plugins: [], profile: {dependencies: {}, dsh: {profile: {bundles: []}}}}));
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const backends = [];
  t.after(async () => { for (const backend of backends) await backend.stop(); await fs.rm(directory, {recursive: true, force: true}); });
  async function core(delayMs, holdStopUntilReady = false, {authenticate = true, exitAfterMs = null, bootstrapDelayMs = 0} = {}) {
    await fs.writeFile(path.join(module, 'lib/bin.js'), `
      const http=require('node:http'); const port=Number(process.argv[process.argv.indexOf('--port')+1]);
      let stopped=false;const close=()=>{server.closeAllConnections();server.close(()=>process.exit(0));};
      const server=http.createServer((req,res)=>{if(req.url.includes('token=')){require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'bootstrap-request'))},'requested');setTimeout(()=>{if(!${authenticate})res.writeHead(403).end();else res.writeHead(303,{'set-cookie':'session=fixture; HttpOnly',location:'/'}).end();},${bootstrapDelayMs});}else res.end('__DSH_BOOT__');});
      server.listen(port,'127.0.0.1',()=>setTimeout(()=>{console.log('dsh web: http://127.0.0.1:'+port+'/?token=STARTUP_FIXTURE_ONLY');if(stopped)setTimeout(close,30);},${delayMs}));
      process.on('SIGTERM',()=>{if(${holdStopUntilReady})stopped=true;else close();});
      if(${exitAfterMs}!==null)setTimeout(()=>process.exit(7),${exitAfterMs});
    `);
  }
  const make = options => { const backend = new Backend({home, runtime, node: process.execPath, port, cwd: directory, ...options}); backends.push(backend); return backend; };
  return {home, port, core, make, bootstrapRequest: path.join(directory, 'bootstrap-request')};
}

test('cold startup defaults to 240 seconds; progress stops after genuine ready', async t => {
  assert.equal(startupTimeoutMs, 240000);
  const f = await fixture(t); await f.core(160);
  const backend = f.make({_startupTimeoutMs: 1500, _startupStatusIntervalMs: 25});
  const statuses = []; backend.on('status', value => statuses.push(value));
  const state = await backend.start();
  assert.equal(state.reused, false); assert.equal(state.pid, backend.child.pid);
  assert.ok(statuses.includes('正在准备 DSH…'));
  assert.ok(statuses.some(value => /已等待 \d+ 秒，最多 2 秒/.test(value)));
  assert.equal(statuses.some(value => /https?:|token=|%/.test(value)), false);
  const count = statuses.length; await pause(90); assert.equal(statuses.length, count);
  assert.equal(JSON.parse(await fs.readFile(statePath(f.home, f.port), 'utf8')).pid, state.pid);
});

test('timeout rejects late ready, clears progress and allows a clean retry on the same owner', async t => {
  const f = await fixture(t); await f.core(600, true);
  const backend = f.make({_startupTimeoutMs: 250, _startupStatusIntervalMs: 20});
  const statuses = []; backend.on('status', value => statuses.push(value));
  await assert.rejects(backend.start(), /启动超时/);
  const count = statuses.length; await backend.stop(); await pause(70);
  assert.equal(statuses.length, count); assert.equal(backend.child, null);
  await assert.rejects(fs.stat(statePath(f.home, f.port)), {code: 'ENOENT'});
  await f.core(30);
  const state = await backend.start(); assert.equal(state.reused, false); assert.equal(backend.stopping, false);
  assert.equal(backend.owned, true);
});

test('cancel during initialization clears timers and ignores the child’s late URL', async t => {
  const f = await fixture(t); await f.core(400, true);
  const backend = f.make({_startupTimeoutMs: 1200, _startupStatusIntervalMs: 20});
  const statuses = []; backend.on('status', value => statuses.push(value));
  const starting = assert.rejects(backend.start(), /启动已取消/);
  await wait(() => statuses.some(value => value.includes('已等待')));
  const count = statuses.length; await backend.stop(); await starting; await pause(60);
  assert.equal(statuses.length, count); assert.equal(backend.child, null);
  await assert.rejects(fs.stat(statePath(f.home, f.port)), {code: 'ENOENT'});
});

test('state publication failure stops its child and clears the progress interval', async t => {
  const f = await fixture(t); await f.core(80);
  await fs.mkdir(statePath(f.home, f.port), {recursive: true});
  const backend = f.make({_startupTimeoutMs: 1200, _startupStatusIntervalMs: 20});
  const statuses = []; backend.on('status', value => statuses.push(value));
  await assert.rejects(backend.start()); await backend.stop();
  const count = statuses.length; await pause(70); assert.equal(statuses.length, count);
  assert.equal(backend.child, null);
});

test('an existing authenticated backend is reused without another process or progress timer', async t => {
  const f = await fixture(t); await f.core(30);
  const owner = f.make({_startupTimeoutMs: 1500}); const first = await owner.start();
  const borrowed = f.make({_startupTimeoutMs: 250, _startupStatusIntervalMs: 20});
  const statuses = []; borrowed.on('status', value => statuses.push(value));
  const reused = await borrowed.start(); assert.equal(reused.reused, true); assert.equal(reused.pid, first.pid);
  assert.equal(borrowed.child, null); assert.equal(borrowed.owned, false);
  await borrowed.stop(); await pause(60); assert.deepEqual(statuses, []);
  assert.doesNotThrow(() => process.kill(first.pid, 0));
});

test('a second Backend waits on the owner marker then validates and reuses genuine ready', async t => {
  const f = await fixture(t); await f.core(450);
  const owner = f.make({_startupTimeoutMs: 2000, _startupStatusIntervalMs: 20});
  const starting = owner.start(); const pending = await marker(f.home, f.port);
  assert.equal(pending.pid, owner.child.pid); assert.equal(pending.home, f.home);
  assert.equal(pending.version, '0.2.1-alpha.4'); assert.ok(pending.instance);
  assert.equal(pending.deadline - pending.startedAt, 2000);
  assert.equal('url' in pending, false); assert.equal('token' in pending, false);
  assert.equal((await fs.stat(statePath(f.home, f.port))).mode & 0o777, 0o600);
  const viewer = f.make({_startupTimeoutMs: 2000, _startupStatusIntervalMs: 20});
  const statuses = []; viewer.on('status', value => statuses.push(value));
  let completed = false; const viewing = viewer.start().then(state => { completed = true; return state; });
  await wait(() => statuses.length > 0); await pause(70);
  assert.equal(completed, false); assert.equal(viewer.child, null); assert.equal(viewer.owned, false);
  const [ready, reused] = await Promise.all([starting, viewing]);
  assert.equal(reused.reused, true); assert.equal(reused.pid, ready.pid); assert.equal(reused.instance, pending.instance);
  assert.equal('starting' in reused, false);
  const stored = JSON.parse(await fs.readFile(statePath(f.home, f.port), 'utf8'));
  assert.equal(stored.url, ready.url); assert.equal(stored.instance, pending.instance);
  assert.equal('starting' in stored, false); assert.equal('deadline' in stored, false);
  assert.equal(statuses.some(value => /https?:|token=|%/.test(value)), false);
  const count = statuses.length; await viewer.stop(); await pause(60);
  assert.equal(statuses.length, count); assert.doesNotThrow(() => process.kill(ready.pid, 0));
  assert.equal(owner.owned, true);
});

test('a viewer can cancel or time out without stopping or deleting the starting owner', async t => {
  for (const mode of ['cancel', 'timeout']) await t.test(mode, async t => {
    const f = await fixture(t); await f.core(450);
    const owner = f.make({_startupTimeoutMs: 2000}); const owning = owner.start();
    const pending = await marker(f.home, f.port);
    const viewer = f.make({_startupTimeoutMs: mode === 'timeout' ? 100 : 1500, _startupStatusIntervalMs: 20});
    const statuses = []; viewer.on('status', value => statuses.push(value));
    const rejected = assert.rejects(viewer.start(), mode === 'timeout' ? /启动超时/ : /启动已取消/);
    await wait(() => statuses.length > 0); if (mode === 'cancel') await viewer.stop();
    await rejected; const count = statuses.length; await viewer.stop(); await pause(40);
    assert.equal(statuses.length, count); assert.equal(viewer.child, null);
    assert.doesNotThrow(() => process.kill(pending.pid, 0));
    assert.equal(JSON.parse(await fs.readFile(statePath(f.home, f.port), 'utf8')).instance, pending.instance);
    const ready = await owning; assert.equal(ready.pid, pending.pid); assert.equal(owner.owned, true);
  });
});

test('stale, dead, foreign and malformed starting markers are refused without overwrite', async t => {
  const variants = {
    stale: state => ({...state, startedAt: Date.now() - 2000, deadline: Date.now() - 1}),
    future: state => ({...state, startedAt: Date.now() + 2000, deadline: Date.now() + 3000}),
    unbounded: state => ({...state, deadline: state.startedAt + 240001}),
    foreignHome: state => ({...state, home: state.home + '-other'}),
    foreignVersion: state => ({...state, version: 'unknown'}),
    unknownInstance: state => ({...state, instance: 'unknown'}),
    fakeURL: state => ({...state, url: 'http://127.0.0.1:1/?token=fake'}),
    deadPID: state => ({...state, pid: 2147483647}),
  };
  for (const [name, modify] of Object.entries(variants)) await t.test(name, async t => {
    const f = await fixture(t); await f.core(30); await fs.mkdir(f.home, {recursive: true});
    const state = modify({starting: true, home: f.home, version: '0.2.1-alpha.4', pid: process.pid, instance: 'fixture-owner-identifier', startedAt: Date.now(), deadline: Date.now() + 2000});
    const original = JSON.stringify(state); await fs.writeFile(statePath(f.home, f.port), original);
    const viewer = f.make({_startupTimeoutMs: 100, _startupStatusIntervalMs: 20});
    await assert.rejects(viewer.start(), /启动记录/); await viewer.stop();
    assert.equal(viewer.child, null); assert.equal(await fs.readFile(statePath(f.home, f.port), 'utf8'), original);
  });
});

test('an unknown occupied port is refused immediately without accepting its HTTP page', async t => {
  const f = await fixture(t); await f.core(30);
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.end('HTTP/1.1 200 OK\r\n\r\n__DSH_BOOT__'); });
  await new Promise(resolve => server.listen(f.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const viewer = f.make({_startupTimeoutMs: 1200}); const start = Date.now();
  await assert.rejects(viewer.start(), /端口正在使用.*无法安全连接/);
  assert.ok(Date.now() - start < 500); assert.equal(viewer.child, null);
  await assert.rejects(fs.stat(statePath(f.home, f.port)), {code: 'ENOENT'});
});

test('owner exit during startup rejects viewers and removes only its own marker', async t => {
  const f = await fixture(t); await f.core(2000, false, {exitAfterMs: 180});
  const owner = f.make({_startupTimeoutMs: 2000}); const owning = assert.rejects(owner.start(), /启动未完成/);
  await marker(f.home, f.port);
  const viewer = f.make({_startupTimeoutMs: 1500, _startupStatusIntervalMs: 20});
  await assert.rejects(viewer.start()); await owning; await owner.stop();
  assert.equal(viewer.child, null); await assert.rejects(fs.stat(statePath(f.home, f.port)), {code: 'ENOENT'});
});

test('concurrent marker replacement is preserved; neither owner nor viewer accepts its ready URL', async t => {
  const f = await fixture(t); await f.core(350);
  const owner = f.make({_startupTimeoutMs: 1500}); const owning = assert.rejects(owner.start(), /启动记录已变化/);
  const pending = await marker(f.home, f.port);
  const viewer = f.make({_startupTimeoutMs: 1500, _startupStatusIntervalMs: 20});
  const statuses = []; viewer.on('status', value => statuses.push(value));
  const viewing = assert.rejects(viewer.start(), /启动记录已变化/); await wait(() => statuses.length > 0);
  const foreign = JSON.stringify({...pending, instance: 'newer-owner-identifier'});
  await fs.writeFile(statePath(f.home, f.port), foreign); await viewing; await owning;
  await owner.stop(); await viewer.stop();
  assert.equal(await fs.readFile(statePath(f.home, f.port), 'utf8'), foreign);
  assert.equal(owner.child, null); assert.equal(viewer.child, null);
});

test('ready publication failure stops only its owner and leaves an unrecognized replacement intact', async t => {
  const f = await fixture(t); await f.core(250);
  const owner = f.make({_startupTimeoutMs: 1500, _startupStatusIntervalMs: 20});
  const statuses = []; owner.on('status', value => statuses.push(value));
  const owning = assert.rejects(owner.start()); await marker(f.home, f.port);
  await fs.rm(statePath(f.home, f.port)); await fs.mkdir(statePath(f.home, f.port));
  await owning; await owner.stop(); const count = statuses.length; await pause(50);
  assert.equal(statuses.length, count); assert.equal(owner.child, null);
  assert.equal((await fs.stat(statePath(f.home, f.port))).isDirectory(), true);
});

test('a starting viewer still requires authenticated ready and rejects a failed bootstrap', async t => {
  const f = await fixture(t); await f.core(300, false, {authenticate: false});
  const owner = f.make({_startupTimeoutMs: 1500}); const owning = owner.start(); await marker(f.home, f.port);
  const viewer = f.make({_startupTimeoutMs: 1500, _startupStatusIntervalMs: 20});
  await assert.rejects(viewer.start(), /安全连接验证/); const ready = await owning;
  assert.equal(viewer.child, null); await viewer.stop(); assert.doesNotThrow(() => process.kill(ready.pid, 0));
});

test('viewer cancellation and timeout also abort an in-flight ready authentication', async t => {
  for (const mode of ['cancel', 'timeout']) await t.test(mode, async t => {
    const f = await fixture(t); await f.core(100, false, {bootstrapDelayMs: 1000});
    const owner = f.make({_startupTimeoutMs: 2000}); const owning = owner.start(); await marker(f.home, f.port);
    const viewer = f.make({_startupTimeoutMs: mode === 'timeout' ? 450 : 1500, _startupStatusIntervalMs: 20});
    const statuses = []; viewer.on('status', value => statuses.push(value));
    const viewing = assert.rejects(viewer.start(), mode === 'timeout' ? /启动超时/ : /启动已取消/);
    const ready = await owning;
    await wait(async () => { try { await fs.stat(f.bootstrapRequest); return true; } catch { return false; } });
    const start = Date.now(); if (mode === 'cancel') await viewer.stop(); await viewing;
    assert.ok(Date.now() - start < 500); const count = statuses.length; await pause(40);
    assert.equal(statuses.length, count); assert.equal(viewer.child, null);
    assert.doesNotThrow(() => process.kill(ready.pid, 0)); assert.equal(owner.owned, true);
    assert.equal(JSON.parse(await fs.readFile(statePath(f.home, f.port), 'utf8')).instance, ready.instance);
  });
});

test('owner deadline bounds its viewers; a late URL cannot restore a failed startup', async t => {
  const f = await fixture(t); await f.core(550, true);
  const owner = f.make({_startupTimeoutMs: 250, _startupStatusIntervalMs: 20});
  const owning = assert.rejects(owner.start(), /启动超时/); await marker(f.home, f.port);
  const viewer = f.make({_startupTimeoutMs: 1500, _startupStatusIntervalMs: 20});
  await assert.rejects(viewer.start(), /启动超时|启动记录已失效/); await owning; await owner.stop();
  assert.equal(viewer.child, null); assert.equal(owner.child, null);
  await assert.rejects(fs.stat(statePath(f.home, f.port)), {code: 'ENOENT'});
});

test('the actual main connect flow shows status and removes the listener before loading chat', async () => {
  const main = fileURLToPath(new URL('./app/main.mjs', import.meta.url));
  const instances = [], loads = [], urls = [];
  class FakeBackend extends EventEmitter {
    constructor() { super(); this.owned = false; this.stops = 0; instances.push(this); }
    async start() { this.emit('status', '正在准备 DSH…'); this.emit('status', '正在启动 DSH…已等待 5 秒，最多 240 秒。'); await pause(10); this.owned = true; return {url: 'http://127.0.0.1:3080/?token=fixture'}; }
    async stop() { this.stops++; }
  }
  const source = (await fs.readFile(main, 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(main).href));
  const context = vm.createContext({Backend: FakeBackend, existingBackend: async () => ({url: 'http://127.0.0.1:3080/?token=fixture'}), redact: value => value, coreVersion: '0.2.1-alpha.4',
    process: {platform: 'darwin', env: {DSH_HOME: '/isolated-home'}, resourcesPath: '/isolated-runtime'}, app: {getPath: () => '/isolated-app', requestSingleInstanceLock: () => false, quit() {}},
    path, URL, homedir: () => '/isolated-home', fileURLToPath, pathToFileURL, appendFile: async () => {}, externalUrl() {}, console});
  vm.runInContext(source + '\nglobalThis.runConnect=connect;globalThis.useWindow=value=>{window=value};', context, {filename: main});
  context.useWindow({isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {}, setTitle() {}, loadFile: async (_file, options) => { loads.push(options.query); }, loadURL: async url => { urls.push(url); }});
  await context.runConnect();
  assert.ok(loads.some(row => row.detail === '正在准备 DSH…'));
  assert.ok(loads.some(row => row.detail.includes('已等待 5 秒，最多 240 秒')));
  assert.equal(instances[0].listenerCount('status'), 0);
  const count = loads.length; instances[0].emit('status', 'late status'); await pause(10); assert.equal(loads.length, count);
  await context.runConnect(); assert.equal(instances.length, 1); assert.equal(instances[0].stops, 0); assert.equal(urls.length, 2);
});
