import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopBrowser } from './browser-engine.mjs';
import { BrowserPanelService } from './browser-panel-service.mjs';
import { browserExecutable } from './index.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const site=`<!doctype html><style>textarea,input,#drop{display:block;margin:16px;width:70vw;height:64px}#drop{background:#ddd}</style><input type=file id=file multiple accept="image/png"><textarea id=editor>保留原评论</textarea><div id=drop>附件拖拽区</div><div id=images></div><script>
async function upload(files){for(const f of files){await fetch('/received?name='+encodeURIComponent(f.name),{method:'POST',body:f});if(f.type.startsWith('image/')){const img=new Image();img.src=URL.createObjectURL(f);document.querySelector('#images').append(img);}}}
document.querySelector('#file').onchange=e=>upload(e.target.files);document.querySelector('#editor').onpaste=e=>{if(e.clipboardData.files.length){e.preventDefault();upload(e.clipboardData.files);}};document.querySelector('#drop').ondragover=e=>e.preventDefault();document.querySelector('#drop').ondrop=e=>{e.preventDefault();upload(e.dataTransfer.files);};</script>`;

test('真实面板完整链路：剪贴板、网页选文件和拖拽均通过本地RPC到达网页，分块有界且原文字保留',{timeout:90000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'dsh-panel-attachment-'));
  const executable=await browserExecutable(), target=new DesktopBrowser({executable,profile:path.join(directory,'target')}),driver=new DesktopBrowser({executable,profile:path.join(directory,'driver'),width:1000,height:800});
  const service=new BrowserPanelService(target),received=[],requests=[];
  const html=await readFile(process.env.DSH_PANEL_HTML_FIXTURE||new URL('./browser-panel.html',import.meta.url),'utf8');
  const server=createServer(async(req,res)=>{
    try{
      if(req.url.startsWith('/received')){const chunks=[];for await(const b of req)chunks.push(b);received.push({name:new URL(req.url,'http://test').searchParams.get('name'),bytes:Buffer.concat(chunks)});res.end('ok');return;}
      if(req.method==='POST'){
        const chunks=[];for await(const b of req)chunks.push(b);const bytes=Buffer.concat(chunks);const body=JSON.parse(bytes);requests.push({method:body.payload.method,bytes:bytes.length});
        const value=await service.call(body.payload);res.setHeader('content-type','application/json');res.end(JSON.stringify({result:{ok:true,value}}));return;
      }
      res.setHeader('content-type','text/html; charset=utf-8');res.end(req.url.startsWith('/site')?site:html);
    }catch(error){res.setHeader('content-type','application/json');res.end(JSON.stringify({result:{ok:false,error:{message:error.message}}}));}
  });server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  const out={checks:[],externalUpload:false};
  t.after(async()=>{await driver.close();await service.close();server.close();await rm(directory,{recursive:true,force:true});if(process.env.DSH_PANEL_ATTACHMENTS_RECEIPT)await writeFile(process.env.DSH_PANEL_ATTACHMENTS_RECEIPT,JSON.stringify(out,null,2));});
  const web=await driver.newTab(origin+'/desktop-browser?panel=test');
  const evaluate=async(browser,id,expression)=>{const r=await browser.send(browser.tab(id),'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const outer=expression=>evaluate(driver,web.id,expression);
  const wait=async(probe,label)=>{const end=Date.now()+10000;while(Date.now()<end){const r=await probe();if(r)return r;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('等待失败：'+label);};
  await wait(()=>outer('Boolean(document.querySelector("#keyboard"))'),'面板加载');
  const state=await service.call({panel:'test',method:'new',payload:{url:origin+'/site'}}),id=state.active;
  const inner=expression=>evaluate(target,id,expression);
  await wait(()=>outer('Boolean(document.querySelector("#screen").src)'),'网页画面');
  await wait(()=>inner('Boolean(document.querySelector("#editor"))'),'目标编辑器');
  await inner('document.querySelector("#editor").focus()');
  const dispatchFile=async(bytes,name,type='image/png',event='paste',point)=>{
    const data={base64:bytes.toString('base64'),name,type,event,point};
    return outer(`(()=>{const d=${JSON.stringify(data)},raw=atob(d.base64),a=Uint8Array.from(raw,c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([a],d.name,{type:d.type}));if(d.event==='paste'){const field=document.querySelector('#keyboard');field.focus();field.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}else{const image=document.querySelector('#screen'),r=image.getBoundingClientRect(),s=Math.min(r.width/d.point.width,r.height/d.point.height);document.querySelector('#surface').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true,clientX:r.left+(r.width-d.point.width*s)/2+d.point.x*s,clientY:r.top+(r.height-d.point.height*s)/2+d.point.y*s}));}})()`);
  };
  await dispatchFile(png,'面板粘贴.png');await wait(()=>received.length===1,'剪贴板图片实际到达网站');
  assert.deepEqual(received[0],{name:'面板粘贴.png',bytes:png});await wait(()=>inner('document.querySelector("#images img")?.naturalWidth===1'),'真实图片预览');
  await wait(()=>outer('document.querySelector("#transferStatus")?.textContent.includes("确认网页附件预览")'),'确认提示');
  await outer(`(()=>{const k=document.querySelector('#keyboard');k.value=' +中文';k.dispatchEvent(new InputEvent('input',{inputType:'insertText',data:k.value,bubbles:true}));})()`);
  await wait(()=>inner('document.querySelector("#editor").value.includes("+中文")'),'文字输入');assert.match(await inner('document.querySelector("#editor").value'),/保留原评论/);
  out.checks.push('面板ClipboardEvent→FileReader→RPC→网页paste→本地接收字节和预览一致，文字保留');
  const rect=await inner('(()=>{const r=document.querySelector("#file").getBoundingClientRect();return{x:r.x+20,y:r.y+20}})()');
  for(const type of ['mousePressed','mouseReleased'])await target.pointer(id,{type,...rect,button:'left',buttons:type==='mousePressed'?1:0});
  await wait(()=>outer('Boolean(document.querySelector("#filePrompt")&&!document.querySelector("#filePrompt").hidden)'),'网页选文件提示');
  await outer('document.querySelector("#chooseFiles").click()');
  const request=await wait(()=>driver.fileChooser(web.id),'面板本地选文件框');
  const selected=path.join(directory,'选文件.png');await writeFile(selected,png);
  await driver.send(driver.tab(web.id),'DOM.setFileInputFiles',{backendNodeId:driver.tab(web.id).fileChooser.backendNodeId,files:[selected]});await driver.cancelFileChooser(web.id,request.requestId);
  await wait(()=>received.length===2,'选文件实际到达网站');assert.deepEqual(received[1],{name:'选文件.png',bytes:png});
  out.checks.push('网页原生fileChooser请求→面板选择→分块→Chrome原生FileInput，字节一致');
  await wait(()=>outer('document.querySelector("#cancelTransfer").hidden'),'传输结束');
  const point=await inner('(()=>{const r=document.querySelector("#drop").getBoundingClientRect();return{x:r.x+30,y:r.y+30,width:innerWidth,height:innerHeight}})()');
  await dispatchFile(png,'面板拖拽.png','image/png','drop',point);await wait(()=>received.length===3,'拖拽实际到达网站');assert.deepEqual(received[2],{name:'面板拖拽.png',bytes:png});
  out.checks.push('面板拖拽事件→坐标转换→Chrome原生drop，字节一致');
  await wait(()=>outer('document.querySelector("#cancelTransfer").hidden'),'拖拽结束');
  await inner('document.querySelector("#editor").focus()');const large=Buffer.alloc(512*1024+7,97);
  await dispatchFile(large,'较大分析文件.json','application/json');await wait(()=>received.length===4,'较大文件完整上传');assert.deepEqual(received[3],{name:'较大分析文件.json',bytes:large});
  assert.ok(requests.filter(r=>r.method==='file.chunk').length>=8);assert.ok(requests.every(r=>r.bytes<180000));
  out.checks.push('超过单块的普通文件完整还原，每个JSON请求小于180KB');out.passed=true;
});
