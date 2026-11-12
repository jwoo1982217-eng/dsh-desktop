import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, access } from 'node:fs/promises';
import { BrowserPanelService } from './browser-panel-service.mjs';

class BrowserFixture extends EventEmitter {
  tabs = new Map(); delivered = []; document = 'first';
  list() { return [...this.tabs.values()]; }
  async refresh() {}
  async newTab() { const tab = {id: String(this.tabs.size + 1), url: 'https://example.test', width: 1024, height: 768}; this.tabs.set(tab.id, tab); return tab; }
  tab(id) { return this.tabs.get(id); }
  async startFrames() {} async stopFrames() {} async close() {}
  fileContext(id, payload) { return { documentId: this.document, kind: payload.kind, requestId: payload.requestId }; }
  fileChooser() { return undefined; }
  async deliverFiles(id, context, files) {
    if (context.documentId !== this.document) throw Error('网页已变化，请重新选择文件');
    this.delivered.push({ id, context, files: await Promise.all(files.map(async f => ({ name: f.name, size: f.size, bytes: await readFile(f.path), path: f.path }))) });
    return { delivered: true, count: files.length };
  }
}
async function setup(t) {
  const browser = new BrowserFixture(), service = new BrowserPanelService(browser);
  const call = (method, payload = {}, panel = 'own') => service.call({panel, method, payload});
  await call('new'); await call('new', {}, 'other');
  t.after(() => service.close());
  return { browser, service, call };
}
const file = (name = '作品.png', size = 4) => ({ name, size, type: 'image/png' });

test('面板分块传输真实字节及中文文件名，只在完成后交给目标网页', async t => {
  const {browser, call} = await setup(t);
  const start = await call('file.begin', {kind: 'paste', files: [file()]});
  assert.equal(browser.delivered.length, 0);
  await call('file.chunk', {uploadId: start.uploadId, index: 0, offset: 0, data: Buffer.from([1,2]).toString('base64')});
  await assert.rejects(call('file.commit', {uploadId: start.uploadId}), /完整/);
  await call('file.chunk', {uploadId: start.uploadId, index: 0, offset: 2, data: Buffer.from([3,4]).toString('base64')});
  const result = await call('file.commit', {uploadId: start.uploadId});
  assert.equal(result.delivered, true);
  assert.equal(browser.delivered[0].files[0].name, '作品.png');
  assert.deepEqual(browser.delivered[0].files[0].bytes, Buffer.from([1,2,3,4]));
  const repeated=await call('file.commit', {uploadId: start.uploadId});
  assert.equal(repeated.delivered,true);assert.equal(browser.delivered.length,1);
  const lateCancel=await call('file.cancel',{uploadId:start.uploadId});
  assert.equal(lateCancel.delivered,true);await access(browser.delivered[0].files[0].path);
});

test('其它面板不能写入、提交或取消别人的文件，拒绝后原传输可以继续', async t => {
  const {call, browser} = await setup(t);
  const {uploadId} = await call('file.begin', {kind: 'paste', files: [file()]});
  for (const method of ['file.chunk','file.commit','file.cancel']) await assert.rejects(call(method, {uploadId, id: '2', index: 0, offset: 0, data: 'AQIDBA=='}, 'other'), /失效|无权/);
  await call('file.chunk', {uploadId, index: 0, offset: 0, data: 'AQIDBA=='});
  await call('file.commit', {uploadId});
  assert.equal(browser.delivered.length, 1);
});

test('文件名越界、超限和乱序块拒绝，取消后不留临时文件且可以重试', async t => {
  const {call, service, browser} = await setup(t);
  for (const files of [[file('../secret')], [file('a/b')], [file('a\\b')], [file('x', 33*1024*1024)], Array.from({length:9},()=>file()), [file('x',-1)]]) {
    await assert.rejects(call('file.begin', {kind:'paste', files}), /文件|大小|数量/);
  }
  const {uploadId} = await call('file.begin', {kind:'paste', files:[file()]});
  await assert.rejects(call('file.chunk', {uploadId,index:0,offset:2,data:'AQIDBA=='}), /顺序/);
  await assert.rejects(call('file.chunk', {uploadId,index:0,offset:0,data:'not base64'}), /数据/);
  await call('file.chunk', {uploadId,index:0,offset:0,data:'AQIDBA=='});
  await call('file.cancel', {uploadId});
  await assert.rejects(call('file.commit', {uploadId}), /结束|失效/);
  const next=await call('file.begin', {kind:'paste',files:[file()]});
  await call('file.chunk',{uploadId:next.uploadId,index:0,offset:0,data:'AQIDBA=='});await call('file.commit',{uploadId:next.uploadId});
  const staged=browser.delivered[0].files[0].path;
  await service.close();await assert.rejects(access(staged));
});

test('传输中网页导航后不会把旧图片交给新页面，失败可以取消', async t => {
  const {call,browser}=await setup(t);
  const {uploadId}=await call('file.begin',{kind:'paste',files:[file()]});
  await call('file.chunk',{uploadId,index:0,offset:0,data:'AQIDBA=='});
  browser.document='next';
  await assert.rejects(call('file.commit',{uploadId}),/网页已变化/);
  assert.equal(browser.delivered.length,0);
  await call('file.cancel',{uploadId});
});

test('空文件可以交付；过期暂存清理后旧请求拒绝，新传输仍可开始', async t => {
  const {call,service,browser}=await setup(t);
  const {uploadId}=await call('file.begin',{kind:'paste',files:[file('空文件.txt',0)]});
  await call('file.commit',{uploadId});assert.equal(browser.delivered[0].files[0].bytes.length,0);
  const staged=browser.delivered[0].files[0].path;
  service.files.records.get(uploadId).expiresAt=0;await service.files.expire();await assert.rejects(access(staged));
  await assert.rejects(call('file.commit',{uploadId}),/失效/);
  assert.ok((await call('file.begin',{kind:'paste',files:[file()]})).uploadId);
});

test('暂存预留总量有界，取消释放预留，且不需要真的生成大文件',async t=>{
  const {call}=await setup(t),ids=[];
  await assert.rejects(call('file.begin',{kind:'paste',files:[file('a',32*1024*1024),file('b',32*1024*1024),file('c',1)]}),/合计/);
  for(let n=0;n<4;n++)ids.push((await call('file.begin',{kind:'paste',files:[file('配额.png',32*1024*1024)]})).uploadId);
  await assert.rejects(call('file.begin',{kind:'paste',files:[file()]}),/较多/);
  await call('file.cancel',{uploadId:ids[0]});assert.ok((await call('file.begin',{kind:'paste',files:[file()]})).uploadId);
});
