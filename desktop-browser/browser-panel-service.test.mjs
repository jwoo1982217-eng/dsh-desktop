import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserPanelService } from './browser-panel-service.mjs';

class FixtureBrowser extends EventEmitter {
  tabs = new Map();
  operations = [];
  sequence = 0;
  list() { return [...this.tabs.values()]; }
  async refresh() {}
  async newTab(url = 'about:blank', { visible = false } = {}) {
    const tab = { id: String(++this.sequence), url, title: url, human: visible, width: 1024, height: 768 };
    this.tabs.set(tab.id, tab); return tab;
  }
  tab(id) { return this.tabs.get(id); }
  async showWindow(id) { this.operations.push(['show', id]); }
  async navigate(id, url) {
    if (url === 'failure') throw Error('Fixture navigation failed');
    this.tabs.get(id).url = url; this.operations.push(['navigate', id, url]);
  }
  async startFrames(id) { this.operations.push(['start', id]); }
  async stopFrames(id) { this.operations.push(['stop', id]); }
  async closeTab(id) { this.operations.push(['close', id]); this.tabs.delete(id); }
  async text(id, text) { this.operations.push(['text', id, text]); }
  async close() { this.tabs.clear(); }
}
const setup = () => { const browser = new FixtureBrowser(); return { browser, service: new BrowserPanelService(browser) }; };
const call = (service, panel, method, payload) => service.call({ panel, method, payload });

test('panels only expose and control their own tabs and frames', async () => {
  const { browser, service } = setup();
  const first = await call(service, 'first', 'new'), second = await call(service, 'second', 'new');
  assert.deepEqual(first.tabs.map(t => t.id), ['1']);
  assert.deepEqual(second.tabs.map(t => t.id), ['2']);
  await assert.rejects(call(service, 'first', 'text', { id: '2', text: 'foreign' }), /关闭/);
  browser.emit('frame', { id: '2', data: 'private-frame' });
  assert.equal((await call(service, 'first', 'frame', { id: '2' })).frame, null);
  const own = await call(service, 'second', 'frame', { id: '2' });
  assert.equal(own.frame.data, 'private-frame');
  assert.equal((await call(service, 'second', 'frame', { id: '2', revision: own.frame.revision })).frame, null);
  await service.close();
});

test('queued actions keep input order and recover after a rejected navigation', async () => {
  const { browser, service } = setup();
  await call(service, 'pane', 'new');
  const result = await Promise.allSettled([
    call(service, 'pane', 'open', { url: 'failure' }),
    call(service, 'pane', 'text', { text: '中' }),
    call(service, 'pane', 'text', { text: '文' }),
    call(service, 'pane', 'open', { url: 'https://example.com/' }),
  ]);
  assert.equal(result[0].status, 'rejected');
  assert.ok(result.slice(1).every(r => r.status === 'fulfilled'));
  assert.deepEqual(browser.operations.filter(op => op[0] === 'text'), [['text', '1', '中'], ['text', '1', '文']]);
  assert.equal((await call(service, 'pane', 'status')).tabs[0].url, 'https://example.com/');
  await service.close();
});

test('selection stops hidden frames, release closes owned tabs, and popups stay with their opener', async () => {
  const { browser, service } = setup();
  await call(service, 'pane', 'new'); await call(service, 'pane', 'new'); await call(service, 'other', 'new');
  assert.ok(browser.operations.some(op => op[0] === 'stop' && op[1] === '1'));
  const popup = await browser.newTab('https://example.com/popup');
  browser.emit('popup', { openerId: '1', tab: popup });
  await service.panels.get('pane').queue;
  assert.equal((await call(service, 'pane', 'status')).active, popup.id);
  await call(service, 'pane', 'release');
  assert.deepEqual(browser.list().map(tab => tab.id), ['3']);
  assert.equal(service.panels.has('pane'), false);
  await assert.rejects(call(service, 'pane', 'text', { id: '1', text: 'closed' }), /关闭/);
  browser.emit('closed');
  assert.equal(service.panels.size, 0); assert.equal(service.frames.size, 0);
  await service.close();
});

test('invalid panel keys and tab limits fail without creating extra browser resources', async () => {
  const { browser, service } = setup();
  for (const panel of ['../private', '', 'a'.repeat(121)]) await assert.rejects(call(service, panel, 'new'), /无效/);
  assert.equal(browser.tabs.size, 0);
  for (let index = 0; index < 16; index++) await call(service, 'pane', 'new');
  await assert.rejects(call(service, 'pane', 'new'), /关闭/);
  assert.equal(browser.tabs.size, 16);
  await call(service, 'pane', 'close', { id: '1' }); await call(service, 'pane', 'new');
  assert.equal(browser.tabs.size, 16);
  await service.close();
});

test('human login window inherits only its owner URL, remains owned, and reopens without duplication', async () => {
  const { browser, service } = setup();
  await call(service, 'own', 'new', { url: 'https://example.com/login' });
  await call(service, 'other', 'new', { url: 'https://example.com/private' });
  await assert.rejects(call(service, 'own', 'login', { id: '2' }), /关闭/);
  const state = await call(service, 'own', 'login');
  assert.equal(state.active, '3');
  assert.equal(browser.tab('3').url, 'https://example.com/login');
  assert.equal(browser.tab('3').human, true);
  assert.equal((await call(service, 'other', 'status')).tabs.some(t => t.id === '3'), false);
  await call(service, 'own', 'login');
  assert.equal(browser.tabs.size, 3);
  assert.deepEqual(browser.operations.at(-1), ['show', '3']);
  await call(service, 'own', 'release');
  assert.deepEqual(browser.list().map(t => t.id), ['2']);
  await service.close();
});
