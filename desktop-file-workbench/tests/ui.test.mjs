import { tmpdir as __publicTmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import vm from 'node:vm';

// Uses an existing local browser in a separate headless context. No browser download,
// production endpoint, user profile, model call, or user directory is involved.
const directory = fileURLToPath(new URL('../', import.meta.url));
const report = process.argv[2] || (__publicTmpdir() + '/dsh-desktop-file-workbench-20261106/generated/ui-checks');
await mkdir(report, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.DSH_PLAYWRIGHT_MODULE || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
const [html, js, css, client] = await Promise.all(['page.html', 'page.js', 'page.css', 'client.js'].map(name => readFile(path.join(directory, name), 'utf8')));
const results = [];
let plugin;
vm.runInNewContext(client, { window: { __ModuleLoader__: { load({ factory }) { plugin = factory(id => { assert.equal(id, 'react'); return { createElement: (type, props) => ({ type, props }) }; }); } } } });
const slots = [];
plugin.apply({ slots: { inject: (_name, install) => install(), register: (slot, component) => slots.push({ ...slot, component }) } });
assert.equal(slots.find(slot => slot.name === 'sidebar.panellist').id, 'desktop-files');
assert.equal(slots.find(slot => slot.name === 'sidebar.panellist').label, '文件');
assert.equal(slots.find(slot => slot.name === 'main').key, 'desktop-files');
assert.equal(slots.find(slot => slot.name === 'main').component().props.src, '/desktop-files');
results.push('independent sidebar/main/settings slots');

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://fixture').pathname;
  const asset = pathname === '/desktop-files/page.js' ? [js, 'text/javascript'] : pathname === '/desktop-files/page.css' ? [css, 'text/css'] : [html, 'text/html'];
  res.writeHead(200, { 'content-type': asset[1] }).end(asset[0]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.DSH_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const roots = [
  { id: 'own', kind: 'internal', label: '自身文件区', path: '/fixture/自身文件', generation: 'g1', status: 'ready', mode: 'read-write' },
  { id: 'work', kind: 'workspace', label: '演示项目', path: '/fixture/project', generation: 'g1', status: 'ready', mode: 'read-write' },
  { id: 'shared', kind: 'shared', label: '只读素材', path: '/fixture/shared', generation: 'g1', status: 'ready', mode: 'read-only' },
];
const xss = '<img src=x onerror=window.__xss=1>.txt';
const entry = (name, kind = 'file') => ({ name, path: name, kind, size: 17, modifiedAt: '2026-11-06T01:00:00Z', version: kind === 'file' ? 'v1:' + name : undefined, editable: name.endsWith('.txt') });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate) { for (let index = 0; index < 500; index++) { if (predicate()) return; await sleep(10); } throw new Error('Fixture request did not arrive'); }
try {
  for (const width of [1440, 393]) {
    const context = await browser.newContext({ viewport: { width, height: 980 }, acceptDownloads: true });
    const page = await context.newPage(), errors = [], calls = [], deferred = new Map();
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    let currentRoots = structuredClone(roots), slowList = false, slowRead = false, slowWrite = false, failRead = false, conflict = false, slowSearch = false, imports = 0, maxImports = 0, exportFailure = false;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status >= 400 ? { ok: false, error: { code: status === 409 ? 'CONFLICT' : 'READ_FAILED', message: value } } : { ok: true, value }) });
    await page.route('**/desktop-files/api/bootstrap', route => fulfill(route, { csrf: 'fixture-csrf', roots: currentRoots, limits: { maxTextBytes: 2097152, maxImportBytes: 67108864 } }));
    await page.route('**/desktop-files/api/manage', async route => {
      const body = route.request().postDataJSON(); calls.push(body);
      assert.equal(route.request().headers()['x-dsh-files-csrf'], 'fixture-csrf');
      const { action, rootId, path: itemPath } = body;
      if (action === 'roots.list') return fulfill(route, { roots: currentRoots });
      if (action === 'list') {
        if (slowList && rootId === 'own') { await new Promise(resolve => deferred.set('list', resolve)); }
        return fulfill(route, { root: currentRoots.find(root => root.id === rootId), path: itemPath, parent: itemPath ? '' : null, entries: rootId === 'own' ? [entry('资料', 'directory'), entry('快.txt'), entry('慢.txt'), entry('原始.bin'), entry(xss)] : [entry(rootId === 'work' ? '项目.txt' : '素材.txt')], truncated: false }).catch(() => {});
      }
      if (action === 'read') {
        if (slowRead && itemPath === '慢.txt') await new Promise(resolve => deferred.set('read', resolve));
        if (failRead) return fulfill(route, '读取暂时失败，草稿应保留。', 503);
        if (itemPath === '原始.bin') return fulfill(route, '这是二进制文件，请导出后查看。', 415);
        return fulfill(route, { rootId, path: itemPath, name: itemPath.split('/').pop(), text: '磁盘正文 ' + itemPath + '\n<script>window.__xss=1</script>', version: 'v1:' + itemPath, size: 60, encoding: 'utf-8', editable: true }).catch(() => {});
      }
      if (action === 'write') {
        if (slowWrite) await new Promise(resolve => deferred.set('write', resolve));
        return conflict ? fulfill(route, '文件版本已变化，请保留草稿后重新读取。', 409) : fulfill(route, { path: itemPath, version: 'v2:' + itemPath, size: Buffer.byteLength(body.text) });
      }
      if (action === 'search') {
        if (slowSearch) await new Promise(resolve => deferred.set('search', resolve));
        return fulfill(route, { matches: [{ path: '快.txt', kind: 'file', size: 60, line: 2, snippet: '<img src=x onerror=window.__xss=1>仅作为搜索文本' }], truncated: false, scanned: 3 }).catch(() => {});
      }
      if (action === 'mkdir') return fulfill(route, { path: itemPath });
      if (action === 'rename') return fulfill(route, { path: body.to });
      if (action === 'roots.planAdd') return fulfill(route, { planId: 'plan1', root: { id: 'added', kind: 'shared', label: body.label || '新增共享', path: body.path, mode: body.mode, generation: 'g2', status: 'ready' }, expiresAt: Date.now() + 60000 });
      if (action === 'roots.add') {
        const plan = calls.filter(call => call.action === 'roots.planAdd').at(-1);
        const root = { id: 'added', kind: 'shared', label: plan.label || '新增共享', path: plan.path, mode: plan.mode, generation: 'g2', status: 'ready' };
        currentRoots.push(root); return fulfill(route, { root });
      }
      if (action === 'roots.remove') { currentRoots = currentRoots.filter(root => root.id !== rootId); return fulfill(route, { removed: true }); }
      if (action === 'export.prepare') return exportFailure ? fulfill(route, '导出票据已失效，请重试。', 410) : fulfill(route, { id: 'export1', filename: itemPath, size: 4, mime: 'application/octet-stream', expiresAt: Date.now() + 60000 });
      throw new Error('Unexpected action: ' + action);
    });
    await page.route('**/desktop-files/api/import?**', async route => {
      imports++; maxImports = Math.max(maxImports, imports);
      try {
        const request = route.request(), name = decodeURIComponent(request.headers()['x-dsh-file-name']);
        assert.equal(request.headers()['x-dsh-files-csrf'], 'fixture-csrf'); assert.equal(request.headers()['content-type'], 'application/octet-stream');
        assert.ok(new URL(request.url()).searchParams.has('generation')); assert.ok(request.postDataBuffer().length > 0);
        await sleep(40);
        return name === '冲突.txt' ? fulfill(route, '同名文件已存在，未覆盖。', 409) : fulfill(route, { path: name, name, size: 4, sha256: 'fixture' });
      } finally { imports--; }
    });
    await page.route('**/desktop-files/export/*', route => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from([0, 2, 4, 6]) }));
    const rootButton = name => page.getByRole('button', { name, exact: false }).filter({ has: page.locator('.root-label') });
    const choose = name => page.getByRole('button', { name, exact: true }).filter({ has: page.locator('.name') }).click();
    const editor = () => page.getByRole('textbox', { name: '文件内容', exact: true });
    await page.goto(base + '/desktop-files');
    await rootButton('自身文件区').waitFor();
    assert.equal(calls.filter(call => call.action === 'list').length, 0, 'bootstrap must not enumerate roots');
    slowList = true; await rootButton('自身文件区').click();
    await until(() => deferred.has('list'));
    await rootButton('演示项目').click(); await page.getByRole('button', { name: '项目.txt', exact: true }).waitFor();
    deferred.get('list')(); slowList = false; await sleep(30);
    assert.equal(await page.getByRole('button', { name: '快.txt', exact: true }).count(), 0);
    await rootButton('自身文件区').click(); await choose(xss);
    await editor().waitFor(); assert.ok((await editor().inputValue()).includes('<script>')); assert.equal(await page.locator('.files img').count(), 0);
    slowRead = true; await choose('慢.txt'); await until(() => deferred.has('read'));
    await choose('快.txt'); await editor().waitFor(); deferred.get('read')(); slowRead = false;
    await sleep(30); assert.ok((await editor().inputValue()).includes('快.txt'));
    await editor().fill('本地未保存草稿 <img onerror=alert(1)>');
    await rootButton('演示项目').click();
    await page.locator('.draft-button').filter({ hasText: '快.txt' }).click();
    await editor().waitFor(); assert.equal(await editor().inputValue(), '本地未保存草稿 <img onerror=alert(1)>');
    conflict = true; await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('文件已在其他地方改变', { exact: false }).waitFor(); assert.equal(await editor().inputValue(), '本地未保存草稿 <img onerror=alert(1)>');
    await page.getByRole('button', { name: '重新读取文件…', exact: true }).click(); failRead = true;
    await page.getByRole('button', { name: '放弃草稿并读取', exact: true }).click();
    await page.getByRole('dialog').getByRole('alert').waitFor(); await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await editor().inputValue(), '本地未保存草稿 <img onerror=alert(1)>'); failRead = false; conflict = false;
    const draftDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出草稿', exact: true }).first().click();
    assert.equal((await draftDownload).suggestedFilename(), '快.txt');
    slowWrite = true; await page.getByRole('button', { name: '保存', exact: true }).click(); await until(() => deferred.has('write'));
    await editor().fill('保存期间继续编辑的内容'); deferred.get('write')(); slowWrite = false;
    await page.getByRole('button', { name: '保存', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-editor-status]').textContent.includes('未保存'));
    assert.equal(await editor().inputValue(), '保存期间继续编辑的内容');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-editor-status]').textContent.startsWith('已保存'));
    assert.equal(calls.filter(call => call.action === 'write').at(-1).version, 'v2:快.txt');
    assert.equal(calls.filter(call => call.action === 'write').length, 3, 'one request per save, including the rejected conflict');
    assert.equal(await page.locator('[data-drafts] .draft-button').count(), 0);
    const textDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出文件', exact: true }).click(); await textDownload;
    assert.equal(calls.filter(call => call.action === 'export.prepare').at(-1).version, 'v2:快.txt', 'export uses the last saved file version even when directory listing is older');
    await page.getByRole('button', { name: '复制路径', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '/fixture/自身文件');
    await page.getByRole('searchbox', { name: '搜索当前目录', exact: true }).fill('文本');
    slowSearch = true; await page.getByRole('button', { name: '搜索', exact: true }).click(); await until(() => deferred.has('search'));
    await page.getByRole('button', { name: '取消', exact: true }).click(); deferred.get('search')(); slowSearch = false; await sleep(25);
    assert.equal(await page.getByRole('region', { name: '搜索结果' }).count(), 0);
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.getByText('<img src=x onerror=window.__xss=1>仅作为搜索文本', { exact: true }).waitFor();
    assert.equal(await page.locator('.search-result img').count(), 0); await page.getByRole('button', { name: '返回文件', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '改名 资料', exact: true }).count(), 0);
    await page.getByRole('button', { name: '改名 快.txt', exact: true }).click();
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('新名称.txt'); await page.getByRole('button', { name: '确定', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
    assert.equal(calls.filter(call => call.action === 'rename').at(-1).version, 'v1:快.txt');
    await page.getByRole('button', { name: '新目录', exact: true }).click(); await page.getByRole('textbox', { name: '名称', exact: true }).fill('中文新目录');
    await page.getByRole('button', { name: '确定', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
    assert.equal(calls.filter(call => call.action === 'mkdir').at(-1).path, '中文新目录');
    await page.getByRole('button', { name: '新文件', exact: true }).click(); await page.getByRole('textbox', { name: '名称', exact: true }).fill('新建.txt');
    await page.getByRole('button', { name: '开始编辑', exact: true }).click(); await editor().fill('新内容'); await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-editor-status]').textContent.startsWith('已保存'));
    assert.equal(calls.filter(call => call.action === 'write').at(-1).version, null);
    const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '导入文件', exact: true }).click();
    await (await chooser).setFiles(['甲.txt', '乙.bin', '丙.txt', '冲突.txt'].map(name => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('普通文件') })));
    await page.getByText('同名文件已存在，未覆盖。', { exact: false }).waitFor(); assert.equal(maxImports, 2);
    await choose('原始.bin'); await page.getByRole('alert').filter({ hasText: '这是二进制文件，请导出后查看。' }).waitFor();
    exportFailure = true; await page.getByRole('button', { name: '导出文件', exact: true }).click(); await page.getByText('导出票据已失效，请重试。', { exact: true }).waitFor();
    exportFailure = false; const binaryDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出文件', exact: true }).click();
    assert.equal((await binaryDownload).suggestedFilename(), '原始.bin');
    await rootButton('只读素材').click(); await choose('素材.txt'); await editor().waitFor(); assert.equal(await editor().getAttribute('readonly'), '');
    assert.equal(await page.getByRole('button', { name: '新文件', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '添加共享目录', exact: true }).first().click();
    assert.equal(await page.getByRole('combobox', { name: '共享目录权限' }).inputValue(), 'read-only');
    await page.getByRole('textbox', { name: '共享目录路径' }).fill('/fixture/新共享'); await page.getByRole('combobox', { name: '共享目录权限' }).selectOption('read-write');
    await page.getByRole('button', { name: '查看并确认', exact: true }).click(); await page.getByRole('button', { name: '添加目录', exact: true }).click();
    await page.getByText('请先勾选确认，允许写入这个目录。', { exact: true }).waitFor();
    assert.equal(calls.filter(call => call.action === 'roots.add').length, 0);
    await page.getByRole('checkbox', { name: '确认允许写入此目录' }).check(); await page.getByRole('button', { name: '添加目录', exact: true }).click();
    await rootButton('新增共享').waitFor();
    assert.deepEqual(calls.filter(call => call.action === 'roots.add').at(-1), { action: 'roots.add', planId: 'plan1', confirm: true });
    await page.getByRole('button', { name: '解除共享', exact: true }).click(); await page.getByRole('dialog').getByText('原目录和文件会保留。', { exact: false }).waitFor();
    await page.getByRole('button', { name: '解除共享', exact: true }).last().click();
    await page.waitForFunction(() => !document.querySelector('[role=dialog]')); assert.equal(calls.filter(call => /delete|remove/.test(call.action) && call.action !== 'roots.remove').length, 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await rootButton('自身文件区').click(); await choose('快.txt'); await editor().waitFor();
    await page.screenshot({ path: path.join(report, 'files-' + width + '.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--card').trim()), '#1b1e29');
    await page.screenshot({ path: path.join(report, 'files-' + width + '-dark.png'), fullPage: true });
    results.push({ width, lazyRoots: true, staleListAndReadRejected: true, draftRestored: true, casConflictPreserved: true, failedReloadPreserved: true, editDuringSavePreserved: true, latestSavedVersionExport: true, xssTextOnly: true, searchCancel: true, noDirectoryRename: true, newFileCAS: true, importConcurrency: maxImports, binaryDownload: true, sharedReadWriteConfirmed: true, removeMappingOnly: true, horizontalOverflow: false, pageErrors: errors.length });
    await context.close();
  }
  for (const capability of [
    { name: 'text-only provider', limits: { providerAvailable: true, canWriteText: true, canNativeMutate: false, providerMode: 'workspace-write' }, editable: true, nativeControls: false },
    { name: 'text writes unavailable', limits: { providerAvailable: true, canWriteText: false, canNativeMutate: false, providerMode: 'read-only' }, editable: false, nativeControls: false },
    { name: 'provider unavailable', limits: { providerAvailable: false, canWriteText: true, canNativeMutate: true, providerMode: 'unavailable' }, editable: false, nativeControls: false },
  ]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 } }), page = await context.newPage(), calls = [], errors = [];
    page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
    const reply = (route, value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value }) });
    await page.route('**/desktop-files/api/bootstrap', route => reply(route, { csrf: 'caps-csrf', roots: [roots[0]], limits: capability.limits }));
    await page.route('**/desktop-files/api/manage', route => {
      const body = route.request().postDataJSON(); calls.push(body);
      assert.equal(route.request().headers()['x-dsh-files-csrf'], 'caps-csrf');
      if (body.action === 'list') return reply(route, { entries: [entry('能力测试.txt')], truncated: false });
      if (body.action === 'read') return reply(route, { path: body.path, text: '原文', version: 'caps-v1', size: 6, editable: true });
      if (body.action === 'write') return reply(route, { path: body.path, version: 'caps-v2', size: Buffer.byteLength(body.text) });
      throw new Error('Capability fixture received unsupported action: ' + body.action);
    });
    await page.goto(base + '/desktop-files');
    await page.locator('.root-button').filter({ hasText: '自身文件区' }).click();
    await page.getByRole('button', { name: '能力测试.txt', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '文件内容', exact: true }); await editor.waitFor();
    assert.equal(await editor.isEditable(), capability.editable);
    assert.equal(await page.getByRole('button', { name: '新文件', exact: true }).isEnabled(), capability.editable);
    assert.equal(await page.getByRole('button', { name: '新目录', exact: true }).count(), Number(capability.nativeControls));
    assert.equal(await page.getByRole('button', { name: '导入文件', exact: true }).count(), Number(capability.nativeControls));
    assert.equal(await page.getByRole('button', { name: '改名 能力测试.txt', exact: true }).count(), Number(capability.nativeControls));
    if (capability.editable) {
      await editor.fill('文本仍可保存'); await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-editor-status]').textContent.startsWith('已保存'));
      assert.equal(calls.filter(call => call.action === 'write').at(-1).version, 'caps-v1');
      await page.getByRole('button', { name: '新文件', exact: true }).click(); await page.getByRole('textbox', { name: '名称', exact: true }).fill('能力新建.txt');
      await page.getByRole('button', { name: '开始编辑', exact: true }).click(); await editor.fill('新文件内容');
      await page.getByRole('button', { name: '保存', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[data-editor-status]').textContent.startsWith('已保存'));
      assert.equal(calls.filter(call => call.action === 'write').at(-1).version, null);
    } else {
      assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
      assert.equal(calls.filter(call => call.action === 'write').length, 0);
    }
    assert.equal(calls.filter(call => ['mkdir', 'rename'].includes(call.action)).length, 0); assert.deepEqual(errors, []);
    results.push({ capability: capability.name, textEdit: capability.editable, nativeControlsHidden: true, unsupportedMutations: 0, pageErrors: 0 }); await context.close();
  }
  await writeFile(path.join(report, 'verification.json'), JSON.stringify({ results, productionEndpoints: 0, modelRequests: 0, userDirectoriesTouched: 0, fixtureOnly: true }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
