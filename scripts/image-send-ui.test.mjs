import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// 从实际覆盖产物取出编辑器和输入栏，仅在测试副本暴露内部符号。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = process.argv[2] ?? path.join(os.tmpdir(), 'dsh-composer-newline');
await mkdir(report, { recursive: true });
const require = createRequire(path.join(root, 'vendor/dsh-codearts-auth/package.json'));
const { build } = require('esbuild');
const playwright = process.env.DSH_PLAYWRIGHT_MODULE ?? path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwright));
const source = await readFile(path.join(root, 'runtime/overlays/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'), 'utf8');
assert.equal(source.split('return module.exports;').length, 2);
const tested = source.replace('return module.exports;', 'module.exports.test = { InputBar, DraftEditorRuntime, ConversationController, registerComposerKeymap, enterCommand: cn$1 }; return module.exports;');
const bundled = await build({ stdin: { resolveDir: path.join(root, 'vendor/dsh-codearts-auth'), loader: 'js', contents: `
import React from 'react'; import * as jsx from 'react/jsx-runtime'; import * as zod from 'zod';
import * as ReactDOM from 'react-dom'; import { createRoot } from 'react-dom/client';
window.__ModuleLoader__ = { load({factory}) {
  window.conversation = factory(id => {
    if (id === 'zod') return zod;
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsx;
    if (id === 'react-dom') return ReactDOM;
    if (id === '@deepseek-ai/cordis') return { Service: class Service {} };
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {
      Tooltip: ({children}) => children, Toast: ({text}) => React.createElement('div', {role:'alert'}, text),
      IconPlusOutlineMedium: () => React.createElement('span', {}, '+'),
      useAnchoredPosition: () => ({}), useDismissOnOutsidePointer: () => {}
    };
    return {};
  });
}};
${tested}
const { InputBar, DraftEditorRuntime, ConversationController } = window.conversation.test;
window.controller=Object.create(ConversationController.prototype);Object.assign(window.controller,{draftAttachments:new Map(),fileUploads:{getSnapshot:()=>({})},ctx:{get:()=>undefined}});window.sends = []; window.stopCount = 0; window.popup = false; window.picks = 0;
window.fixture = { running:false, phase:'plain', locked:false, attachment:false, upload:'ready', busyEnter:'queue' };
let redraw = () => {};
const runtime = new DraftEditorRuntime({ onUpdate: () => { runtime.refreshProjection(); redraw(); },
  activeClaimToken: () => undefined, lexicon: () => undefined, resolveLexicon: () => undefined, openReference: () => {} });
runtime.register(); window.runtime = runtime;
const keyboard = { editor: runtime.editor, arbitrate: key => { if (window.popup && key==='enter') { window.picks++; return 'consumed'; } return 'pass'; },
  dismissPopup: () => {window.popup=false;}, space: () => false, paste: text => runtime.paste(text),
  bindFilePicker: () => () => {}, caretSpan: () => null,
  submit: (mode,origin) => window.sends.push({mode,origin,text:runtime.projection.clipboardText}), steerQueue: () => {} };
function App() {
  const [,setTick] = React.useState(0); redraw = () => setTick(n => n+1); window.redraw = redraw;
  const f = window.fixture; const draft = runtime.projection.clipboardText;
  const useInput = selector => selector({draft,phase:f.phase,queue:[],attachmentIds:f.attachment?['file']:[]});
  const useSession = selector => selector({running:f.running,removed:false,subagent:null});
  const t = key => ({'input.send':'发送消息','input.send.button':'发送','input.send.queue':'排队发送','input.send.steer':'插话发送','input.stop':'停止','placeholder.default':'输入消息','input.commands':'命令','file.stillUploading':'附件上传中'})[key] ?? key;
  return React.createElement(InputBar, { useInput,useSession,t,keyboard,inputActions:{pruneAttachments:()=>{}},
    resolveDraftAttachments: ids => ids.map(id=>({id,kind:'image'})),
    useBusyEnter:s=>s(f.busyEnter),useFileUploads:s=>s({file:{status:f.upload}}),
    useNotices:s=>s(null),useLexicon:s=>s(undefined),useMenuLauncher:s=>s(null),useStopShortcut:s=>s([]),
    useProjection: (_,selector) => selector?selector(undefined):undefined,
    renderSlot: () => null, stop:()=>window.stopCount++, variant:'composer',sessionId:'isolated-fixture',disabled:f.locked });
}
createRoot(document.getElementById('app')).render(React.createElement(App));
` }, nodePaths: [path.join(root, 'desktop-runtime/node_modules'), path.join(root, 'runtime/node_modules')], bundle: true, platform: 'browser', format: 'iife', write: false });
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://127.0.0.1:32181/**',route=>route.fulfill({contentType:'text/html',body:'<div id="app"></div><script>'+bundled.outputFiles[0].text+'</script>'}));
 await page.goto('http://127.0.0.1:32181/');await page.locator('[data-composer-send]').waitFor();
 await page.evaluate(()=>{window.fixture.attachment=true;window.redraw();});assert.equal(await page.locator('[data-composer-send]').isDisabled(),false,'an image-only draft is sendable');
 const result=await page.evaluate(async()=>{
  const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;canvas.getContext('2d').fillRect(0,0,32,32);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const file=new File([blob],'local-qa.png',{type:'image/png'});
  const c=window.controller;const [draft]=c.createDrafts('local-qa',[file]);let retire,captured;
  const session={sessionId:'local-qa',beginSubmission(value){retire=value.onRetire;return{requestId:'local-qa-request',abandon(){retire({reason:'failed'});}};},async prompt(content){captured=content;retire({reason:'failed'});return{ok:false,error:{code:'session/attachment-invalid',details:{reason:'MODEL_DOES_NOT_SUPPORT_IMAGES'}}};}};
  const failed=await c.sendSession(session,'',[draft.id],'queue');const preserved=c.draftAttachments.has(draft.id);const encoded=await c.encodeImage(file);
  session.prompt=async content=>{captured=content;retire({reason:'observed',attachments:[{mediaType:'image/png',id:'local-qa-image'}]});return{ok:true};};
  const success=await c.sendSession(session,'请读图',[draft.id],'queue');
  return{failed:failed.kind,preserved,success:success.kind,retired:!c.draftAttachments.has(draft.id),media:captured[0].mediaType,bytesMatch:captured[0].data===encoded.data,text:captured[1].text,imageKind:draft.kind,preview:draft.previewUrl.startsWith('blob:')};
 });
 assert.deepEqual(result,{failed:'error',preserved:true,success:'success',retired:true,media:'image/png',bytesMatch:true,text:'请读图',imageKind:'image',preview:true});assert.deepEqual(errors,[]);
 await writeFile(path.join(report,'image-send.json'),JSON.stringify({imageOnlySendEnabled:true,...result,pageErrors:errors,cloudCalls:0},null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
