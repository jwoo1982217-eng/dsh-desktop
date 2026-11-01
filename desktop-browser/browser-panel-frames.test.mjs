import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DesktopBrowser} from './browser-engine.mjs';
import {BrowserPanelService} from './browser-panel-service.mjs';
import {browserExecutable} from './index.mjs';

test('真实面板：布局上报先于首帧轮询时，静态网页仍显示并可输入、切换和刷新', {timeout:60000}, async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'dsh-panel-frames-'));
  const executable=await browserExecutable();
  const target=new DesktopBrowser({executable,profile:path.join(directory,'target')});
  const driver=new DesktopBrowser({executable,profile:path.join(directory,'driver'),width:1000,height:800});
  const service=new BrowserPanelService(target);
  const html=await readFile(new URL('./browser-panel.html',import.meta.url),'utf8');
  const requests=[];
  let resized;
  const firstResize=new Promise(resolve=>resized=resolve);
  const server=createServer(async(req,res)=>{
    try {
      if(req.method==='POST') {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const {payload}=JSON.parse(Buffer.concat(chunks));
        requests.push(payload.method);
        // A delayed first frame request is normal when layout and polling race.
        // The page has already produced its only frame before a same-size resize.
        if(payload.method==='frame')await firstResize;
        const value=await service.call(payload);
        if(payload.method==='resize')resized();
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({result:{ok:true,value}}));
      } else {
        res.setHeader('content-type','text/html;charset=utf-8');
        res.end(req.url.startsWith('/site')? '<!doctype html><title>静态网页</title><h1>网页已加载</h1><input id="text" value="保留原文">':html);
      }
    }catch(error){res.end(JSON.stringify({result:{ok:false,error:{message:error.message}}}));}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  const result={checks:[],externalRequests:false};
  t.after(async()=>{
    resized();await driver.close();await service.close();server.close();
    await rm(directory,{recursive:true,force:true});
    if(process.env.DSH_PANEL_FRAMES_RECEIPT)await writeFile(process.env.DSH_PANEL_FRAMES_RECEIPT,JSON.stringify(result,null,2));
  });
  const call=(method,payload={})=>service.call({panel:'frames',method,payload});
  const evaluate=async(browser,id,expression)=>{
    const r=await browser.send(browser.tab(id),'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
    return r.result.value;
  };
  const wait=async(probe,label)=>{
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){const value=await probe();if(value)return value;await delay(40);}
    throw Error('等待失败：'+label);
  };
  const first=(await call('new',{url:origin+'/site'})).active;
  await wait(()=>Promise.resolve(service.frames.has(first)),'目标首帧');
  await delay(300);
  const web=await driver.newTab(origin+'/desktop-browser?panel=frames');
  const outer=expression=>evaluate(driver,web.id,expression);
  await wait(()=>outer('Boolean(document.querySelector("#keyboard"))'),'面板加载');
  // Keep the target viewport identical: a static Chrome page need not repaint.
  await outer('Object.defineProperties(document.querySelector("#surface"),{clientWidth:{get:()=>1024},clientHeight:{get:()=>768}})');
  await firstResize;
  const loaded=await evaluate(target,first,'document.readyState');
  assert.equal(loaded,'complete');
  await wait(()=>outer('document.querySelector("#screen").naturalWidth>0'),'已加载的静态网页显示');
  result.checks.push('布局先于轮询，静态网页首帧仍能实际解码');
  for(let n=0;n<3;n++)await call('resize',{id:first,width:1024,height:768});
  assert.ok((await call('frame',{id:first,revision:-1})).frame,'重复尺寸上报保留可交付画面');
  await evaluate(target,first,'document.querySelector("#text").focus()');
  await outer('(()=>{const k=document.querySelector("#keyboard");k.value=" +中文";k.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"}));})()');
  await wait(()=>evaluate(target,first,'document.querySelector("#text").value.includes("+中文")'),'面板文字输入');
  result.checks.push('重复尺寸上报后画面可获取，中文输入到达原页面');
  const second=(await call('new',{url:origin+'/site?second'})).active;
  await wait(()=>outer(`document.querySelector('#tabs .tab.active .close')&&document.querySelector('#screen').naturalWidth>0`),'第二页画面');
  await call('select',{id:first});await call('resize',{id:first,width:780,height:600});
  await wait(async()=>{const f=(await call('frame',{id:first,revision:-1})).frame;return f?.width===780&&f?.height===600;},'新尺寸实际画面');
  assert.match(await evaluate(target,first,'document.querySelector("#text").value'),/\+中文/);
  await call('reload',{id:first});
  await wait(()=>evaluate(target,first,'document.querySelector("#text")?.value==="保留原文"'),'刷新后的真实文档');
  await wait(()=>outer('document.querySelector("#screen").naturalWidth>0'),'刷新后面板画面');
  await call('close',{id:second});
  result.checks.push('切换标签、改变尺寸和刷新后仍显示，原输入在刷新前保留');
  assert.ok(requests.includes('resize')&&requests.includes('frame'));
  result.passed=true;
});
