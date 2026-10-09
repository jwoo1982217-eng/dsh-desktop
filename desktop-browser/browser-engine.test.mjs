import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopBrowser, websiteAddress } from './browser-engine.mjs';
import { browserExecutable } from './index.mjs';
import { tmpdir } from 'node:os';

test('real Chrome navigation, input, frames, cookies and failure recovery', { timeout: 60000 }, async t => {
  let executable;
  try { executable = await browserExecutable(); } catch (error) {
    if (process.env.DSH_BROWSER_EXECUTABLE) throw error;
    t.skip('Requires installed Chrome or Edge'); return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-browser-case-'));
  const server = createServer((request, response) => {
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/fixture-login') {
      response.setHeader('Set-Cookie', 'dsh_login=verified; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600');
      response.writeHead(302, { location: '/protected' }); response.end(); return;
    }
    if (request.url === '/protected') {
      response.end(`<title>${request.headers.cookie?.includes('dsh_login=verified') ? 'Authenticated fixture' : 'Login required'}</title>`); return;
    }
    const content = request.url === '/two' ? '<h1>Second page</h1>' : '<h1>DSH 内置浏览器验证</h1><input id="text" style="display:block;width:300px;height:40px"><a id="next" href="/two" style="display:block;margin-top:40px">下一页</a>';
    response.end(`<!doctype html><html><head><title>${request.url === '/two' ? 'Second' : 'Browser test'}</title></head><body>${content}<script>document.documentElement.dataset.ready='yes'</script></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = { executable, profile: join(directory, 'profile') };
  let browser = new DesktopBrowser(options);
  const receipt = { integratedIntoDsh: false, checks: [] };
  async function waitFor(probe, expected) {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const value = await probe();
      if (value === expected) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error(`Timed out waiting for ${expected}`);
  }
  async function evaluate(id, expression) {
    const result = await browser.send(browser.tab(id), 'Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw Error('Fixture script failed');
    return result.result.value;
  }
  try {
    assert.equal(websiteAddress('example.com'), 'https://example.com/');
    for (const address of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com', 'data:text/html,test']) assert.throws(() => websiteAddress(address));
    receipt.checks.push('unsupported protocols and embedded credentials rejected');
    const tab = await browser.newTab(origin.replace('http://', ''));
    const framePromise = once(browser, 'frame');
    await browser.startFrames(tab.id);
    const [frame] = await framePromise;
    assert.equal(frame.id, tab.id); assert.ok(Buffer.from(frame.data, 'base64').length > 1000);
    receipt.checks.push('immediate navigation starts live Chrome frames');
    await waitFor(() => evaluate(tab.id, 'document.documentElement.dataset.ready'), 'yes');
    await new Promise(resolve => setTimeout(resolve, 1000));
    await browser.refresh([tab.id]);
    assert.equal(browser.list()[0].title, 'Browser test');
    assert.equal(await evaluate(tab.id, 'document.title'), 'Browser test');
    receipt.checks.push('real Chrome loads site with DENY and frame-ancestors none');
    await browser.resize(tab.id, 480, 640);
    assert.equal(await evaluate(tab.id, 'innerWidth'), 480);
    receipt.checks.push('viewport resize');
    const rectangle = await evaluate(tab.id, 'JSON.stringify(document.querySelector("#text").getBoundingClientRect().toJSON())');
    const box = JSON.parse(rectangle);
    await browser.pointer(tab.id, { type: 'mousePressed', x: box.x + 20, y: box.y + 20, button: 'left', buttons: 1 });
    await browser.pointer(tab.id, { type: 'mouseReleased', x: box.x + 20, y: box.y + 20, button: 'left', buttons: 0 });
    await browser.text(tab.id, '中文输入与 website');
    assert.equal(await evaluate(tab.id, 'document.querySelector("#text").value'), '中文输入与 website');
    receipt.checks.push('click and Chinese text input');
    await browser.stopFrames(tab.id);
    const screenshot = await browser.screenshot(tab.id);
    assert.ok(Buffer.from(screenshot.data, 'base64').length > 1000);
    await browser.navigate(tab.id, origin + '/two');
    await waitFor(() => evaluate(tab.id, 'document.title'), 'Second');
    assert.equal(await browser.history(tab.id, -1), true);
    await waitFor(() => evaluate(tab.id, 'document.title'), 'Browser test');
    assert.equal(await browser.history(tab.id, 1), true);
    await waitFor(() => evaluate(tab.id, 'document.title'), 'Second');
    await browser.reload(tab.id);
    await waitFor(() => evaluate(tab.id, 'document.title'), 'Second');
    receipt.checks.push('navigate, back, forward and reload');
    await evaluate(tab.id, 'document.cookie="dsh_test=retained; Max-Age=3600; SameSite=Lax"');
    await browser.closeTab(tab.id);
    assert.equal(browser.list().length, 0);
    await assert.rejects(browser.reload(tab.id), /关闭/);
    receipt.checks.push('closed tab rejects further actions');
    await browser.close();
    browser = new DesktopBrowser(options);
    const reopened = await browser.newTab(origin);
    await waitFor(() => evaluate(reopened.id, 'document.documentElement.dataset.ready'), 'yes');
    assert.match(await evaluate(reopened.id, 'document.cookie'), /dsh_test=retained/);
    receipt.checks.push('dedicated cookie profile survives browser restart');
    const agent = await browser.newTab(origin + '/protected');
    await waitFor(() => evaluate(agent.id, 'document.title'), 'Login required');
    const human = await browser.newTab(origin + '/fixture-login', { visible: true });
    await waitFor(() => evaluate(human.id, 'document.title'), 'Authenticated fixture');
    assert.equal(human.loginWindow, true);
    await browser.resize(human.id, 320, 240);
    assert.ok(await evaluate(human.id, 'innerWidth') > 320, 'human window must retain its actual viewport');
    await browser.showWindow(human.id);
    await assert.rejects(browser.showWindow(agent.id), /登录窗口/);
    await browser.reload(agent.id);
    await waitFor(() => evaluate(agent.id, 'document.title'), 'Authenticated fixture');
    receipt.checks.push('visible human login and hidden agent share HttpOnly authentication without copying cookies');
    await browser.closeTab(human.id);
    await browser.closeTab(agent.id);
    const afterClose = await browser.newTab(origin + '/protected');
    await waitFor(() => evaluate(afterClose.id, 'document.title'), 'Authenticated fixture');
    receipt.checks.push('closing login window retains shared authentication');
    const failed = new DesktopBrowser({ executable: '/nonexistent/dsh-browser-fixture', profile: join(directory, 'missing') });
    await assert.rejects(failed.start(), /ENOENT/);
    await failed.close();
    assert.equal(await evaluate(reopened.id, 'document.title'), 'Browser test');
    receipt.checks.push('missing engine failure preserves running browser');
    receipt.passed = true;
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    await browser.close();
    server.close();
    await rm(directory, { recursive: true, force: true });
    if (process.env.DSH_BROWSER_TEST_RECEIPT) await writeFile(process.env.DSH_BROWSER_TEST_RECEIPT, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  }

});
