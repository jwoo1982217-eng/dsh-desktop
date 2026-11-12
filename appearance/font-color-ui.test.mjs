import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {apply} from './index.mjs';
const {chromium}=await import(pathToFileURL(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')));
const report=path.resolve(process.argv[2]||'docs/appearance-fonts-colors-20261103/browser');await mkdir(report,{recursive:true});
const home=await mkdtemp(path.join(os.homedir(),'.codex/work/appearance-controls-test-'));
const folder=path.join(home,'中文 字体');await mkdir(folder);await cp('/System/Library/Fonts/SFNSMono.ttf',path.join(folder,'样张.ttf'));await writeFile(path.join(folder,'损坏.otf'),'invalid');
process.env.DSH_HOME=home;const routes=new Map();let rpc,deny=false;
await apply({clientModules:{clientPath:()=>undefined,onGraphChanged:()=>()=>{}},connection:{rpc:{handle:(_r,handler)=>{rpc=handler;}}},webServer:{register:r=>{routes.set(r.path,r.handler);return()=>{};}},effect:f=>f()});
const server=createServer(async(req,res)=>{
  try {
    if(req.url==='/appearance-center/manage') {let body='';for await(const data of req)body+=data;const request=JSON.parse(body);const result=deny&&request.payload.action==='configure'?{ok:false,error:{message:'测试保存失败'}}:await rpc(request.method,request.payload);res.setHeader('content-type','application/json');res.end(JSON.stringify({result}));return;}
    const route=routes.get(new URL(req.url,'http://localhost').pathname);if(route)await route(req,res);else res.writeHead(404).end();
  } catch(e){res.writeHead(500).end(e.message);}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;let browser;const results=[];
try {
  browser=await chromium.launch({headless:true,channel:'chrome'});
  for(const width of [393,1280]) {
    const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/appearance-center');await page.locator('#custom:not([hidden])').waitFor();
    const color=page.locator('[data-color-control=accent]');await color.getByRole('button',{name:'蓝色',exact:true}).click();
    assert.equal(await page.locator('input[name=accent]').inputValue(),'#497de2');
    await page.getByRole('button',{name:'保存调整',exact:true}).click();await page.locator('#notice').filter({hasText:'已应用并保存'}).waitFor();
    await page.reload();await page.locator('#custom:not([hidden])').waitFor();assert.equal(await page.locator('input[name=accent]').inputValue(),'#497de2');
    await color.locator('[data-color-reset]').click();await page.getByRole('button',{name:'保存调整',exact:true}).click();await page.locator('#notice').filter({hasText:'已应用并保存'}).waitFor();assert.equal(await page.locator('input[name=accent]').inputValue(),'');
    await rpc('manage',{action:'font.scan',directory:folder});
    await page.getByRole('button',{name:'浏览字体文件夹',exact:true}).click();await page.locator('#font-directory').filter({hasText:'中文 字体'}).waitFor();
    await page.getByRole('button',{name:'扫描这个文件夹',exact:true}).click();await page.getByRole('button',{name:'样张.ttf',exact:true}).click();await page.locator('#use-local-font:not([disabled])').waitFor();
    assert.equal(await page.evaluate(()=>document.fonts.check('22px "'+[...document.fonts].find(f=>f.family.startsWith('dshPreview_')).family+'"')),true);
    await page.locator('#use-local-font').click();await page.locator('#notice').filter({hasText:'已应用并保存'}).waitFor();
    assert.match(await page.locator('select[name=uiFont]').inputValue(),/^local:/);
    assert.match(await page.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--dsw-font-family')),/dshLocal_/);
    await page.reload();await page.locator('#custom:not([hidden])').waitFor();assert.match(await page.locator('select[name=uiFont]').inputValue(),/^local:/);
    await page.getByRole('button',{name:'浏览字体文件夹',exact:true}).click();await page.getByRole('button',{name:'损坏.otf',exact:true}).click();await page.locator('#font-notice').filter({hasText:'无法预览'}).waitFor();assert.equal(await page.locator('#use-local-font').isDisabled(),true);
    const before=(await rpc('manage',{action:'status'})).value;deny=true;await page.locator('[data-color-control=accent]').getByRole('button',{name:'红色',exact:true}).click();await page.getByRole('button',{name:'保存调整',exact:true}).click();await page.locator('#notice').filter({hasText:'测试保存失败'}).waitFor();deny=false;assert.equal((await rpc('manage',{action:'status'})).value.revision,before.revision);
    await page.getByRole('button',{name:'保存调整',exact:true}).click();await page.locator('#notice').filter({hasText:'已应用并保存'}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(report,'appearance-'+width+'.png'),fullPage:true});results.push({width,colorSwatches:true,themeReset:true,colorReload:true,browseFolders:true,realFontPreview:true,fontAppliedAndReloaded:true,invalidFontRetainsCurrent:true,writeFailureRetainsCurrent:true,retry:true,noOverflow:true,pageErrors:errors});await page.close();
  }
  await writeFile(path.join(report,'verification.json'),JSON.stringify({results},null,2));console.log(JSON.stringify({results}));
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(home,{recursive:true,force:true});}
