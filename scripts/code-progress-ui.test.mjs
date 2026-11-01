import {frontendTestAssets} from './frontend-test-assets.mjs';
import {withoutCodeProgress} from './build-code-progress.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
const root=fileURLToPath(new URL('../',import.meta.url));
const report=process.argv[2];if(!report)throw Error('Provide a registered generated/ output directory');await fs.mkdir(report,{recursive:true});
const dist=path.join(root,'desktop-runtime/node_modules/@deepseek-ai/dsh-web-frontend/dist');
const {sharedFrontend,css}=await frontendTestAssets(dist);
const original=withoutCodeProgress(await fs.readFile(path.join(root,'desktop-runtime/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js'),'utf8'));
const source=await fs.readFile(path.join(root,'runtime/overlays/@deepseek-ai/dsh-client-ui-tool/lib/client.js'),'utf8');
const conv=await fs.readFile(path.join(root,'desktop-runtime/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'),'utf8');
const start=conv.indexOf('const SIMPLE_ESCAPES ='),end=conv.indexOf('//#endregion',start);assert(start>0&&end>start);
const partial=conv.slice(start,end).replace('(class PartialArguments','(window.PartialArguments=class PartialArguments');
function instrument(s){return s.replace('return module.exports;','module.exports.test={write:typeof DshProgressFileRow===\'function\'?DshProgressFileRow:FileMutationRow,bash:typeof DshProgressBashRow===\'function\'?DshProgressBashRow:BashRow,preview:typeof dshCodeProgressData===\'function\'?dshCodeProgressData:null};return module.exports;');}
const bootstrap=`
const shared=window.__TEST_SHARED__,React=shared.react,createRoot=shared['react-dom/client'].createRoot;
window.__ModuleLoader__={load({factory}){window.tools=factory(id=>shared[id]);}};
${partial}
const root=createRoot(document.getElementById('app'));
function useDisclosure(){const[expanded,set]=React.useState(false);return{expanded,toggle:()=>set(x=>!x)};}
const t=(key,args={})=>({'tool.title.write':'写入文件','tool.title.edit':'修改文件','tool.title.bash':'运行命令','tool.preparing.content':args.kilobytes+' KB','row.input':'输入','row.output':'输出'})[key]??key;
window.show=(tool,phase,args,output='',error=false,raw)=>{
 const view=raw===undefined?window.PartialArguments.fromObject(args):new window.PartialArguments();if(raw!==undefined)view.append(raw);
 const call={name:tool,callId:'fixture-call',argsRaw:JSON.stringify(args)};
 let block=phase==='settled'?{kind:'tool-result',args:view,call,content:[{type:'text',text:output}],isError:error,meta:{}}:{...call,args:view,phase};
 window.currentBlock=block;window.currentTool=tool;
 root.render(React.createElement(window.tools.test[tool==='bash'?'bash':'write'],{toolName:tool,block,cwd:'/work',home:'/home/test',sessionId:'fixture',useSessions:()=>'/work',useDisclosure,t}));
};
window.code='import json\\n\\ndef greet(name: str):\\n    message = "你好, " + name\\n    return json.dumps({"message": message}, ensure_ascii=False)\\n\\nprint(greet("Mac"))\\n';
window.show('write','preparing',{file_path:'/work/demo.py',content:window.code},'',false,JSON.stringify({file_path:'/work/demo.py',content:window.code}).slice(0,-2));
`;
function html(baseline){return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--dsw-alias-bg-base:#f8fafc;--dsw-alias-bg-module-platform:#fff;--dsw-alias-label-primary:#182230;--dsw-alias-label-secondary:#475467;--dsw-alias-label-tertiary:#667085;--dsw-alias-border-l1:#d0d5dd;--ds-font-family-code:ui-monospace,SFMono-Regular,monospace}*{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#182230;font:14px system-ui}#app{max-width:960px;margin:24px auto;padding:0 16px;min-width:0}${css}</style><div id="app"></div><script type="module">import '/assets/test-shared.js';${bootstrap.slice(0,bootstrap.indexOf('const root=createRoot'))}${instrument(baseline?original:source)}\n${bootstrap.slice(bootstrap.indexOf('const root=createRoot'))}</script></html>`;}
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/assets/test-shared.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(sharedFrontend);return;}
  if(req.url.startsWith('/assets/')){const target=path.resolve(dist,decodeURIComponent(req.url.split('?')[0]).slice(1));if(!target.startsWith(path.join(dist,'assets')+path.sep))throw Error('Invalid asset path');res.writeHead(200,{'content-type':target.endsWith('.js')?'text/javascript':target.endsWith('.wasm')?'application/wasm':'text/css'});res.end(await fs.readFile(target));return;}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html(req.url.includes('baseline')));
 }catch(e){res.writeHead(404);res.end();}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const {chromium}=await import(pathToFileURL(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const results=[],errors=[];let passed=false;
try{
 const page=await browser.newPage({viewport:{width:1200,height:900}});page.on('pageerror',e=>errors.push(e.stack));page.setDefaultTimeout(12000);const url='http://127.0.0.1:'+server.address().port;
 await page.goto(url+'/?baseline');await page.waitForFunction(()=>!!window.currentBlock);await page.waitForTimeout(200);assert.equal(await page.locator('[data-code-progress]').count(),0);results.push('Baseline preparing row has no code preview');
 await page.goto(url);await page.locator('[data-code-progress] .md-code-block').waitFor();assert.match(await page.locator('[data-code-progress]').innerText(),/尚未写入/);assert.match(await page.locator('[data-code-progress] pre').first().innerText(),/def greet/);
 await page.waitForFunction(()=>new Set(Array.from(document.querySelectorAll('[data-code-progress] code span[style]'),e=>getComputedStyle(e).color)).size>=4);results.push('Incomplete real PartialArguments renders syntax-colored Python before execution');
 await fs.writeFile(path.join(report,'highlight-details.json'),JSON.stringify(await page.locator('[data-code-progress] code span').evaluateAll(els=>els.slice(0,35).map(e=>({text:e.textContent,style:e.getAttribute('style'),color:getComputedStyle(e).color}))),null,2));await page.screenshot({path:path.join(report,'python-live-preview.png'),fullPage:true});
 await page.getByRole('button',{name:/demo.py/}).click();assert.equal(await page.locator('[data-code-progress] .md-code-block').count(),0);
 await page.evaluate(()=>window.show('write','preparing',{file_path:'/work/demo.py',content:window.code+'# updated\n'}));assert.equal(await page.locator('[data-code-progress] .md-code-block').count(),0);await page.getByRole('button',{name:/demo.py/}).click();await page.waitForFunction(()=>document.querySelector('[data-code-progress] pre')?.textContent.includes('updated'));results.push('Streaming update keeps user collapse choice and then displays latest code');
 await page.evaluate(()=>window.show('write','settled',{file_path:'/work/demo.py',content:window.code},'wrote /work/demo.py'));
 await page.getByText('实际执行结果',{exact:true}).waitFor();assert.match(await page.locator('[data-code-progress]').innerText(),/wrote \/work\/demo.py/);results.push('Settled write keeps real result and original row');
 await page.evaluate(()=>window.show('edit','settled',{file_path:'/work/demo.py',old_string:'x',new_string:'y'},'permission denied',true));await page.getByText('执行失败',{exact:true}).waitFor();assert.equal(await page.getByText('正在写入',{exact:true}).count(),0);results.push('Failed edit displays failure, not a successful write');
 await page.evaluate(()=>window.show('edit','preparing',{file_path:'/work/demo.py',old_string:'x',new_string:''}));await page.getByText('本次替换内容为空',{exact:true}).waitFor();results.push('Empty replacement is displayed as a deletion');
 await page.evaluate(()=>window.show('bash','preparing',{command:"python3 - <<'PY'\nimport json\nprint(json.dumps({'ok': True}))\nPY",description:'Run local Python check'}));await page.waitForFunction(()=>document.querySelector('[data-code-progress]').textContent.includes('运行 Python 脚本'));assert.match(await page.locator('[data-code-progress] pre').first().innerText(),/import json/);results.push('Actual shell heredoc uses Python highlighting');
 await page.evaluate(()=>window.show('bash','settled',{command:'uname -s',description:'Read operating system'},'Darwin\n[exit code: 0]'));await page.locator('[data-sample=bash]').click();await page.waitForFunction(()=>document.body.textContent.includes('Darwin'));assert.equal(await page.locator('[data-code-progress]').count(),0);results.push('One-line inspection keeps original terminal output without duplicating a code card');
 await page.evaluate(()=>window.show('write','preparing',{file_path:'/work/large.js',content:'const x = 1;\n'.repeat(10000)}));await page.getByText('大文件仅预览部分内容，可打开文件查看全部。',{exact:true}).waitFor();const limit=await page.evaluate(()=>window.tools.test.preview(window.currentTool,window.currentBlock).code.length);assert.equal(limit,65536);results.push('Large input preview has a bounded decoded prefix');
 await page.setViewportSize({width:393,height:852});await page.evaluate(()=>window.show('write','preparing',{file_path:'/work/demo.py',content:window.code}));await page.waitForTimeout(300);assert(await page.locator('[data-code-progress]').evaluate(el=>el.getBoundingClientRect().right<=innerWidth));results.push('393px viewport retains contained card and code scrolling');
 await page.evaluate(()=>window.show('write','preparing',{file_path:'/work/demo.js',content:'window.__codeExecuted = true;\n</script><script>window.__codeExecuted = true</script>'}));await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.__codeExecuted),undefined);results.push('Code is displayed as text and never executed by the preview');
 assert.deepEqual(errors,[]);passed=true;
}finally{await fs.writeFile(path.join(report,'verification.json'),JSON.stringify({passed,results,pageErrors:errors},null,2));await browser.close();await new Promise(r=>server.close(r));console.log(JSON.stringify({passed,results,pageErrors:errors}));}
