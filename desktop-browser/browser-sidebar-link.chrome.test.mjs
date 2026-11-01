import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { frontendTestAssets } from '../scripts/frontend-test-assets.mjs';
import { DesktopBrowser } from './browser-engine.mjs';
import { BrowserPanelService } from './browser-panel-service.mjs';
import { browserExecutable } from './index.mjs';
import { browserCall } from '../peer/mcp-manager/builtins.mjs';

test('real MCP open → Session feed → SDK sidebar controller → React frame preserves the same page', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-sidebar-link-'));
  const executable = await browserExecutable();
  const target = new DesktopBrowser({ executable, profile: path.join(directory, 'target') });
  const driver = new DesktopBrowser({ executable, profile: path.join(directory, 'driver'), width: 1200, height: 900 });
  const service = new BrowserPanelService(target), requests = [], checks = [];
  const root = new URL('../', import.meta.url), dist = fileURLToPath(new URL('desktop-runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist/', root));
  const { sharedFrontend } = await frontendTestAssets(dist);
  const client = await readFile(process.env.DSH_BROWSER_CLIENT_FIXTURE || new URL('./client.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('./browser-panel.html', import.meta.url), 'utf8');
  const legacyHtml = process.env.DSH_BROWSER_LEGACY_HTML ? await readFile(process.env.DSH_BROWSER_LEGACY_HTML, 'utf8') : html.replace("const managed = params.get('managed') === '1' && /^mcp_[a-f0-9]{40}$/.test(panel);", 'const managed = false;').replace("document.documentElement.setAttribute('data-dsh-browser-managed', '');", '');
  const sidebar = (await readFile(new URL('desktop-runtime/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js', root), 'utf8')).replace('return module.exports;', 'module.exports.test = { createSidebarRightController, createSidebarRightStore, SidebarRightTabRegistry }; return module.exports;');
  const events = (await readFile(new URL('desktop-runtime/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/events.js', root), 'utf8')).replace("import { notifySubscribers } from '@deepseek-ai/dsh-client-store';", "const { notifySubscribers } = shared['@deepseek-ai/dsh-client-store'];").replace('export class MutableSessionEventSource', 'class MutableSessionEventSource');
  let legacy = false;
  const script = `
const shared=window.__TEST_SHARED__, React=shared.react, {createRoot}=shared['react-dom/client'];
window.__ModuleLoader__={load({id,factory}) { window[id==='dsh-desktop-browser'?'browserPlugin':'sidebarPlugin']=factory(name=>{if(!(name in shared))throw Error('Missing shared module '+name);return shared[name];});}};
${sidebar}
${client}
${events}
const effects=[], slots=new Map(), effect=fn=>{const dispose=fn();if(dispose)effects.push(dispose);return()=>dispose?.();};
const registry=new sidebarPlugin.test.SidebarRightTabRegistry({effect});
registry.register({id:'fixture-guide',kind:'guide',title:()=> '开始'});
const controllerState=sidebarPlugin.test.createSidebarRightController(registry,()=>{}, {autoFullscreen:()=>false,openWithFocus:(_,fn)=>fn(),closeWithFocus:(_,__,fn)=>fn()});
const sidebarController=controllerState.controller;
const store=sidebarPlugin.test.createSidebarRightStore(()=>({kind:'guide',title:'开始'})).create();
store.actions.open('s1');store.actions.setExpanded('s1',false);controllerState.adopt('s1',store);controllerState.show('s1');
const feed=new MutableSessionEventSource();const bindings=new Map([['s1',{sessionId:'s1',eventSource:feed}]]);
const source=()=>({getSnapshot:()=>({}),subscribe:()=>()=>{}});
const ctx={effect,sidebarRightTabs:registry,sidebarRight:sidebarController,sessions:{binding:id=>bindings.get(id),list:source()},slots:{inject:(_,fn)=>fn(),register:(def,body)=>{slots.set(def.name+':'+def.key,body);return()=>{};}}};
browserPlugin.apply(ctx);
const root=createRoot(document.querySelector('#app'));
function Body({tab}) {const occurrence=sidebarController.tabDomain.occurrence('s1',tab);const navigation=React.useSyncExternalStore(occurrence.navigation.subscribe,occurrence.navigation.getSnapshot);const surface=React.useSyncExternalStore(store.subscribe,store.getSnapshot).bySession.s1;const Component=slots.get('sidebar.right.pane.tab:dsh-desktop-browser-agent');return React.createElement(Component,{sessionId:'s1',useTabInfo:()=>({tab:{...tab,visible:surface.layout.expanded,signal:occurrence.signal,navigation}})});}
function App(){const state=React.useSyncExternalStore(store.subscribe,store.getSnapshot).bySession.s1;const tabs=Object.values(state.layout.tabs).filter(t=>t.kind==='browser-agent');return React.createElement('aside',{'data-expanded':state.layout.expanded,style:{display:state.layout.expanded?'flex':'none',height:'85vh',width:'900px'}},...tabs.map(tab=>React.createElement(Body,{tab,key:tab.id})));}
root.render(React.createElement(App));
window.fixture={feed(value,callId,seq){feed.append({type:'event',event:{type:'tool/call',seq,data:{name:'mcp__browser__open',callId,arguments:'{}'}}});feed.append({type:'event',event:{type:'tool/result',seq:seq+1,data:{message:{role:'tool',toolCallId:callId,content:[{type:'text',text:JSON.stringify(value)}]}}}});},collapse(){sidebarController.toggleExpanded();},close(){sidebarController.close(sidebarController.active().id);},view(){sidebarController.toggleExpanded();},state(){return {expanded:sidebarController.isExpanded(),tabs:sidebarController.tabsIn('s1').map(t=>({id:t.id,kind:t.kind})),selected:sidebarController.active()};}};
window.ready=true;`;
  const fixtureHtml = '<!doctype html><meta charset="utf-8"><div id="app"></div><script>window.fixtureErrors=[];onerror=(m)=>fixtureErrors.push(String(m));onunhandledrejection=e=>fixtureErrors.push(String(e.reason?.stack||e.reason));</script><script type="module">import "/assets/test-shared.js";\n' + script.replaceAll('</script', '<\\/script') + '</script>';
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const { payload } = JSON.parse(Buffer.concat(chunks)); requests.push(payload.method);
        const value = await service.call(payload); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result: { ok: true, value } })); return;
      }
      if (req.url === '/assets/test-shared.js') { res.setHeader('content-type', 'text/javascript'); res.end(sharedFrontend); return; }
      if (/^\/assets\/[\w.-]+\.js$/.test(req.url)) { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(path.join(dist, req.url))); return; }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(req.url.startsWith('/desktop-browser') ? legacy ? legacyHtml : html : req.url.startsWith('/site') ? '<!doctype html><title>同一网页验收</title><h1>AI 打开的原网页</h1><input id="draft" value="原文保留">' : fixtureHtml);
    } catch (error) { res.end(JSON.stringify({ result: { ok: false, error: { message: error.message } } })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await driver.close(); await service.close(); server.close(); await rm(directory, { recursive: true, force: true }); if (process.env.DSH_SIDEBAR_LINK_RECEIPT) await writeFile(process.env.DSH_SIDEBAR_LINK_RECEIPT, JSON.stringify({ checks, requests, passed: checks.length === 6 }, null, 2)); });
  const evaluate = async (browser, id, expression) => {
    const result = await browser.send(browser.tab(id), 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const web = await driver.newTab(origin + '/fixture'), outer = expression => evaluate(driver, web.id, expression);
  const wait = async (probe, label) => { const end = Date.now() + 8000; while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(40); } throw Error('Timeout: ' + label); };
  await wait(async () => { const state = await outer('({ready:window.ready,errors:window.fixtureErrors})'); if (state.errors?.length) throw Error(state.errors.join('\n')); return state.ready; }, 'real SDK/React fixture loaded');
  const ctx = { get: name => name === 'desktopBrowser' ? { getService: async () => service } : undefined };
  const exec = { agent: { session: { id: 's1', header: { cwd: directory } } }, signal: new AbortController().signal };
  for (const mode of ['current', 'legacy']) {
    legacy = mode === 'legacy';
    const actual = await browserCall(ctx, 'open', { url: origin + '/site?' + mode }, exec), id = actual.active;
    await evaluate(target, id, 'document.querySelector("#draft").value="中文草稿不丢"');
    await outer('window.fixture.feed(' + JSON.stringify(actual) + ',' + JSON.stringify(mode) + ',' + (legacy ? 3 : 1) + ')');
    await wait(() => outer('window.fixture.state().expanded && Boolean(document.querySelector("iframe")?.contentDocument?.querySelector("#screen")?.naturalWidth)'), 'MCP page visible in actual SDK sidebar');
    const src = await outer('document.querySelector("iframe").getAttribute("src")');
    assert.equal(new URL(src, origin).searchParams.get('panel'), new URL(actual.panelUrl, origin).searchParams.get('panel'));
    assert.equal(target.list().length, legacy ? 2 : 1, 'presentation must not duplicate target pages');
    checks.push(mode + ': actual MCP panel is decoded by the sidebar iframe, without a duplicate page');
    await outer('window.fixture.collapse()');
    await outer('window.fixture.view()');
    assert.equal(await evaluate(target, id, 'document.querySelector("#draft").value'), '中文草稿不丢');
    checks.push(mode + ': collapse/reopen keeps the same document and Chinese draft');
    await outer('window.fixture.close()');
    await wait(() => outer('!document.querySelector("iframe")'), 'sidebar view closed');
    await delay(250);
    assert.ok(target.tabs.has(id), 'closing the viewer must not close AI-owned tabs');
    assert.equal(await evaluate(target, id, 'document.querySelector("#draft").value'), '中文草稿不丢');
    checks.push(mode + ': closing the sidebar viewer preserves the AI-owned page');
  }
  assert.equal(requests.includes('release'), false);
});
