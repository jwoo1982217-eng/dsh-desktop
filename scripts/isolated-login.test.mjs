import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { IsolatedLoginService, workBuddyLoginAddress } from '../desktop-browser/isolated-login-service.mjs';
import { openAccountLoginWindow } from '../vendor/dsh-codearts-auth/plugin-src/client/account-login-window.js';
import { SystemLoginBrowser } from '../desktop-browser/system-login-browser.mjs';

const login = 'https://www.workbuddy.ai/login?platform=workbuddy-ai&state=test-only';
class FakeBrowser extends EventEmitter {
  async newTab() { return {}; }
  async close() { this.closed = true; this.emit('closed'); }
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-login-test-'));
  const browsers = [];
  const service = new IsolatedLoginService({ directory, executable: 'test-only',
    createBrowser: opts => { const browser = new FakeBrowser(); browser.profile = opts.profile; browsers.push(browser); return browser; }, ...options });
  t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { service, directory, browsers };
}
test('concurrent authorizations each reserve a private profile, and close only their own browser', async t => {
  const { service, browsers, directory } = await fixture(t);
  const [a, b] = await Promise.all([service.open(login), service.open(login)]);
  const browserA = service.sessions.get(a.sessionId).browser;
  const browserB = service.sessions.get(b.sessionId).browser;
  assert.notEqual(a.sessionId, b.sessionId);
  assert.notEqual(browserA.profile, browserB.profile);
  await service.close(a.sessionId);
  assert.equal(browserA.closed, true);
  assert.equal(browserB.closed, undefined);
  await assert.rejects(access(browserA.profile));
  await service.close(a.sessionId); // idempotent cleanup
  await service.close(b.sessionId);
  assert.deepEqual(await readdir(directory), []);
});
test('launch failure cleans its reserved profile and allows retry', async t => {
  let fail = true;
  const { service, directory } = await fixture(t, { createBrowser: () => {
    const browser = new FakeBrowser();
    browser.newTab = async () => { if (fail) throw Error('test launch failure'); };
    return browser;
  } });
  await assert.rejects(service.open(login), /test launch failure/);
  assert.equal(service.sessions.size, 0);
  assert.deepEqual(await readdir(directory), []);
  fail = false;
  const session = await service.open(login);
  assert.equal(session.isolated, true);
});
test('expiry removes the login browser and profile', async t => {
  const { service, browsers, directory } = await fixture(t, { timeoutMs: 10 });
  await service.open(login);
  const deadline = Date.now() + 1000;
  while (service.sessions.size && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(browsers[0].closed, true);
  assert.deepEqual(await readdir(directory), []);
});
test('the host only opens official WorkBuddy authorization URLs', () => {
  assert.equal(workBuddyLoginAddress(login), login);
  for (const url of [login.replace('https:', 'http:'), login.replace('www.workbuddy.ai', 'www.workbuddy.ai.evil.test'),
    login.replace('/login?', '/?'), login.replace('workbuddy-ai', 'other'), login.replace('state=test-only', 'state='),
    login.replace('www.workbuddy.ai', 'user:password@www.workbuddy.ai'), 'javascript:alert(1)']) {
    assert.throws(() => workBuddyLoginAddress(url), /授权地址/);
  }
});
test('WorkBuddy never uses the shared popup, and closing its handle releases exactly its session', async () => {
  const calls = [], shared = { open() { throw Error('shared cookie popup invoked'); } };
  const handle = await openAccountLoginWindow({ provider: 'workbuddy', loginUrl: login, browserWindow: shared,
    isolatedLoginCall: async payload => { calls.push(payload); return { isolated: true, browserMode: 'system', sessionId: 'test-session' }; } });
  handle.close(); handle.close();
  assert.deepEqual(calls, [{ action: 'open', url: login }, { action: 'close', sessionId: 'test-session' }]);
  assert.equal(handle.closed, true);
  await assert.rejects(openAccountLoginWindow({ provider: 'workbuddy', loginUrl: login, browserWindow: shared,
    isolatedLoginCall: async () => { throw Error('browser unavailable'); } }), /browser unavailable/);
});
test('旧版调试登录组件被识别并收尾，不能默认为 Google 登录可用', async () => {
  const calls = [];
  await assert.rejects(openAccountLoginWindow({ provider: 'workbuddy', loginUrl: login, browserWindow: {},
    isolatedLoginCall: async payload => { calls.push(payload); return { isolated: true, sessionId: 'old-session' }; } }), /普通浏览器模式/);
  assert.deepEqual(calls.at(-1), { action: 'close', sessionId: 'old-session' });
});
test('普通授权窗口没有调试管道或自动化参数，仅关闭自己的子进程', async () => {
  let args, options, killed;
  const child = new EventEmitter();
  Object.assign(child, { pid: 12345, exitCode: null, signalCode: null, kill(signal) {
    killed = signal; this.signalCode = signal; this.emit('exit');
  } });
  const browser = new SystemLoginBrowser({ executable: 'test-browser', profile: '/test-only/private-profile', spawnProcess: (_exe, argv, opts) => {
    args = argv; options = opts; queueMicrotask(() => child.emit('spawn')); return child;
  } });
  await browser.newTab(login);
  assert.equal(args.at(-1), login);
  assert.ok(args.includes('--user-data-dir=/test-only/private-profile'));
  assert.ok(args.includes('--new-window'));
  assert.equal(args.some(arg => /remote-debugging|automation|headless|no-sandbox|ignore-certificate|disable-blink/.test(arg)), false);
  assert.equal(options.stdio, 'ignore');
  await browser.close();
  assert.equal(killed, 'SIGTERM');
});
test('other providers retain their ordinary popup and blocked-popup result', async () => {
  const popup = {};
  assert.equal(await openAccountLoginWindow({ provider: 'buddy', loginUrl: login, browserWindow: { open: () => popup } }), popup);
  assert.equal(await openAccountLoginWindow({ provider: 'buddy', loginUrl: login, browserWindow: { open: () => null } }), null);
});
