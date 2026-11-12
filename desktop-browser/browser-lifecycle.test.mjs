import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopBrowser } from './browser-engine.mjs';
import { browserExecutable } from './index.mjs';

async function fixture(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'dsh-lifecycle-'));
  const server=createServer((req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end('<title>浏览器恢复验证</title><h1>同一个浏览器可以继续打开网页</h1>');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  // 全新资料会有组件扩展的后台页，恰好掩盖“普通frame为零”的正式现场。
  // 仅在隔离资料禁用这些扩展，避免测试依赖扩展替产品维持frame。
  const executable=await browserExecutable(),wrapper=path.join(directory,'chrome-fixture.sh');
  await writeFile(wrapper,`#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' --disable-extensions --disable-component-extensions-with-background-pages "$@"\n`,{mode:0o700});
  const browser=new DesktopBrowser({executable:wrapper,profile:path.join(directory,'profile')});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const evaluate=async(id,expression)=>{const r=await browser.send(browser.tab(id),'Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error('测试页执行失败');return r.result.value;};
  const wait=async(probe)=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(await probe())return;await delay(40);}throw Error('等待测试页面超时');};
  t.after(async()=>{await browser.close();server.close();await rm(directory,{recursive:true,force:true});});
  return {browser,origin,evaluate,wait,executable:wrapper,profile:path.join(directory,'profile')};
}

test('真实Chrome：启动后等待、最后一个标签关闭后等待，仍能继续打开隐藏网页',{timeout:45000},async t=>{
  const {browser,origin,evaluate,wait}=await fixture(t);const receipt={checks:[]};
  try{
    await browser.start();const pid=browser.child.pid;
    // 模拟用户稍后点击“打开”，不能依赖已关闭的初始化页尚未从Chrome消失的竞态。
    await delay(750);
    const first=await browser.newTab(origin);await wait(()=>evaluate(first.id,'document.title').then(v=>v==='浏览器恢复验证'));
    receipt.checks.push('启动后延迟仍可打开页面');
    await evaluate(first.id,'document.cookie="dsh_lifecycle=retained; Max-Age=3600; SameSite=Lax"');
    await browser.closeTab(first.id);assert.equal(browser.list().length,0);await delay(750);
    const second=await browser.newTab(origin);await wait(()=>evaluate(second.id,'document.title').then(v=>v==='浏览器恢复验证'));
    assert.equal(browser.child.pid,pid);assert.match(await evaluate(second.id,'document.cookie'),/dsh_lifecycle=retained/);
    receipt.checks.push('关闭最后网页后延迟重新打开，进程和登录cookie保持');receipt.passed=true;
  }finally{if(process.env.DSH_BROWSER_LIFECYCLE_RECEIPT)await writeFile(process.env.DSH_BROWSER_LIFECYCLE_RECEIPT,JSON.stringify(receipt,null,2));}
});

test('真实Chrome：普通支撑窗口被关闭后自动恢复，不销毁已有网页或复制登录',{timeout:45000},async t=>{
  const {browser,origin,evaluate,wait}=await fixture(t);
  const first=await browser.newTab(origin);await wait(()=>evaluate(first.id,'document.title').then(v=>v==='浏览器恢复验证'));
  await evaluate(first.id,'document.cookie="dsh_anchor=retained; Max-Age=3600; SameSite=Lax"');
  const pid=browser.child.pid;
  const targets=(await browser.pipe.send('Target.getTargets')).targetInfos;
  for(const target of targets)if(target.type==='page'&&!browser.tabs.has(target.targetId))await browser.pipe.send('Target.closeTarget',{targetId:target.targetId});
  await delay(500);
  const created=await Promise.all([browser.newTab(origin),browser.newTab(origin)]);
  assert.equal(browser.child.pid,pid);assert.equal(browser.tabs.size,3);
  for(const tab of [first,...created]){await wait(()=>evaluate(tab.id,'document.title').then(v=>v==='浏览器恢复验证'));assert.match(await evaluate(tab.id,'document.cookie'),/dsh_anchor=retained/);}
});

test('真实Chrome：已有资料重新启动后可延迟打开网页并保留原登录',{timeout:45000},async t=>{
  const {browser,origin,evaluate,wait,executable,profile}=await fixture(t);
  const first=await browser.newTab(origin);await wait(()=>evaluate(first.id,'document.title').then(v=>v==='浏览器恢复验证'));
  await evaluate(first.id,'document.cookie="dsh_restart=retained; Max-Age=3600; SameSite=Lax"');
  await browser.close();
  const reopened=new DesktopBrowser({executable,profile});
  try {
    await reopened.start();await delay(750);
    const second=await reopened.newTab(origin);
    const read=async expression=>(await reopened.send(reopened.tab(second.id),'Runtime.evaluate',{expression,returnByValue:true})).result.value;
    await wait(()=>read('document.title').then(v=>v==='浏览器恢复验证'));
    assert.match(await read('document.cookie'),/dsh_restart=retained/);
    assert.equal(reopened.list().length,1);
  } finally { await reopened.close(); }
});
