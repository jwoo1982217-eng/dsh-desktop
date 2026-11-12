import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopBrowser } from './browser-engine.mjs';
import { BrowserPanelService } from './browser-panel-service.mjs';
import { browserExecutable } from './index.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const page = `<!doctype html><title>附件测试</title><style>input,textarea,#drop{display:block;margin:30px;width:70vw;height:70px}#drop{background:#eee}</style>
<input id="file" type="file" accept="image/png" multiple><textarea id="editor">原有评论文字</textarea><div id="drop">拖拽到这里</div><div id="previews"></div>
<script>
window.uploaded=[];
async function receive(files){for(const file of files){await fetch('/uploaded?name='+encodeURIComponent(file.name),{method:'POST',body:file});uploaded.push({name:file.name,size:file.size,type:file.type});const img=new Image();img.src=URL.createObjectURL(file);document.querySelector('#previews').append(img);}}
document.querySelector('#file').onchange=e=>receive(e.target.files);
document.querySelector('#editor').onpaste=e=>{if(e.clipboardData.files.length){e.preventDefault();receive(e.clipboardData.files);}};
document.querySelector('#drop').ondragover=e=>e.preventDefault();document.querySelector('#drop').ondrop=e=>{e.preventDefault();receive(e.dataTransfer.files);};
</script>`;
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(),'dsh-attachment-case-')), uploads=[];
  const server=createServer(async(req,res)=>{
    if(req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);uploads.push({name:new URL(req.url,'http://fixture').searchParams.get('name'),bytes:Buffer.concat(chunks)});res.end('ok');return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const browser=new DesktopBrowser({executable:await browserExecutable(),profile:path.join(directory,'profile')});
  const service=new BrowserPanelService(browser);const origin=`http://127.0.0.1:${server.address().port}`;
  const call=(method,payload={})=>service.call({panel:'fixture',method,payload});
  const state=await call('new',{url:origin}),id=state.active;
  const evaluate=async expression=>{const r=await browser.send(browser.tab(id),'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
  const wait=async probe=>{const end=Date.now()+8000;while(Date.now()<end){const r=await probe();if(r)return r;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('本地附件用例等待超时');};
  const click=async(selector,extra={})=>{
    const b=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for(const type of ['mousePressed','mouseReleased'])await browser.pointer(id,{type,...b,button:'left',buttons:type==='mousePressed'?1:0,...extra});
  };
  const transfer=async(kind,name,options={})=>{
    const {uploadId}=await call('file.begin',{id,kind,files:[{name,size:png.length,type:'image/png'}],...options});
    await call('file.chunk',{id,uploadId,index:0,offset:0,data:png.toString('base64')});
    return call('file.commit',{id,uploadId});
  };
  t.after(async()=>{await service.close();server.close();await rm(directory,{recursive:true,force:true});});
  await wait(()=>evaluate('document.readyState === "complete" && Boolean(document.querySelector("#editor"))'));
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  return {browser,service,id,call,evaluate,wait,click,transfer,uploads,origin};
}

test('真实Chrome：选文件、粘图和拖拽均让网页收到正确字节并显示图片预览', {timeout:60000}, async t=>{
  const f=await fixture(t);const receipt={checks:[],externalUpload:false};
  try{
    assert.equal(typeof f.browser.fileContext,'function','浏览器需要提供附件交付能力');
    await f.click('#file');const chooser=await f.wait(()=>f.browser.fileChooser(f.id));
    assert.equal(chooser.multiple,true);assert.equal(chooser.accept,'image/png');
    await f.transfer('input','中文截图.png',{requestId:chooser.requestId});
    await f.wait(()=>f.uploads.length===1);assert.deepEqual(f.uploads[0],{name:'中文截图.png',bytes:png});
    await f.wait(()=>f.evaluate('document.querySelector("#previews img")?.naturalWidth===1'));
    receipt.checks.push('网页原生选文件，中文名称、字节及图片预览一致');
    await f.click('#editor');await f.transfer('paste','剪贴板.png');
    await f.wait(()=>f.uploads.length===2);assert.deepEqual(f.uploads[1],{name:'剪贴板.png',bytes:png});
    assert.equal(await f.evaluate('document.querySelector("#editor").value'),'原有评论文字');
    receipt.checks.push('粘贴图片到编辑器且原有评论文字保留');
    const point=await f.evaluate('(()=>{const r=document.querySelector("#drop").getBoundingClientRect();return{x:r.x+20,y:r.y+20}})()');
    await f.transfer('drop','拖入.png',{point});await f.wait(()=>f.uploads.length===3);assert.deepEqual(f.uploads[2],{name:'拖入.png',bytes:png});
    receipt.checks.push('原生拖拽文件交付且字节一致');
    await f.click('#file');const second=await f.wait(()=>f.browser.fileChooser(f.id));
    await f.call('file.cancelChooser',{id:f.id,requestId:second.requestId});
    assert.equal(await f.evaluate('document.querySelector("#file").files[0].name'),'中文截图.png');
    await assert.rejects(f.transfer('input','旧请求.png',{requestId:second.requestId}),/失效|变化/);
    await f.click('#file');const third=await f.wait(()=>f.browser.fileChooser(f.id));await f.transfer('input','重试.png',{requestId:third.requestId});
    await f.wait(()=>f.uploads.length===4);receipt.checks.push('取消保留原选择，旧请求拒绝，新请求可重试');
    const begin=await f.call('file.begin',{id:f.id,kind:'paste',files:[{name:'过期.png',size:png.length,type:'image/png'}]});
    await f.call('file.chunk',{id:f.id,uploadId:begin.uploadId,index:0,offset:0,data:png.toString('base64')});
    await f.browser.navigate(f.id,f.origin+'/next');await f.wait(()=>f.evaluate('document.querySelectorAll("#previews img").length===0'));
    await assert.rejects(f.call('file.commit',{id:f.id,uploadId:begin.uploadId}),/网页已变化/);await f.call('file.cancel',{id:f.id,uploadId:begin.uploadId});
    assert.equal(f.uploads.length,4);receipt.checks.push('导航后旧图片拒绝交付到新网页');
    receipt.passed=true;
  }finally{if(process.env.DSH_ATTACHMENTS_RECEIPT)await writeFile(process.env.DSH_ATTACHMENTS_RECEIPT,JSON.stringify(receipt,null,2));}
});

test('真实Chrome：画面尺寸变化后旧画面坐标按视口转换，不再误报无效鼠标操作',{timeout:45000},async t=>{
  const f=await fixture(t);await f.browser.resize(f.id,480,640);
  const width=await f.evaluate('innerWidth'),height=await f.evaluate('innerHeight');
  const b=await f.evaluate('(()=>{const r=document.querySelector("#editor").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
  for(const type of ['mousePressed','mouseReleased'])await f.browser.pointer(f.id,{type,x:b.x*4,y:b.y*2,viewportWidth:width*4,viewportHeight:height*2,button:'left',buttons:type==='mousePressed'?1:0});
  await f.browser.text(f.id,'尺寸转换');assert.match(await f.evaluate('document.querySelector("#editor").value'),/尺寸转换/);
});

test('真实Chrome：文件读取期间切换焦点，粘贴仍交付给原评论框',{timeout:45000},async t=>{
  const f=await fixture(t);await f.evaluate('document.querySelector("#editor").focus()');
  assert.equal(await f.evaluate('document.activeElement.id'),'editor');
  const {uploadId}=await f.call('file.begin',{id:f.id,kind:'paste',files:[{name:'焦点保持.png',size:png.length,type:'image/png'}]});
  await f.evaluate('document.body.insertAdjacentHTML("beforeend", "<textarea id=other></textarea>"); document.querySelector("#other").focus()');
  await f.call('file.chunk',{id:f.id,uploadId,index:0,offset:0,data:png.toString('base64')});
  await f.call('file.commit',{id:f.id,uploadId});
  await f.wait(()=>f.uploads.length===1);assert.equal(f.uploads[0].name,'焦点保持.png');
});
