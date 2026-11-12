import { homedir as __publicHomedir, tmpdir as __publicTmpdir } from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const home=(__publicHomedir() + '/.dsh'),output=(__publicTmpdir() + '/dsh-desktop-file-workbench-20261106/generated/live-acceptance');
const shared=path.join(output,'shared-fixture'),state=JSON.parse(fs.readFileSync(path.join(home,'.desktop-web-3080.json'))),entry=new URL(state.url);
assert.equal(entry.origin,'http://127.0.0.1:3080');
const auth=await fetch(entry,{redirect:'manual',signal:AbortSignal.timeout(3000)}),cookie=auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');assert(cookie);
const request=(url,init={})=>fetch(entry.origin+url,{...init,headers:{cookie,...init.headers},signal:AbortSignal.timeout(10000)});
const initial=await request('/desktop-files/api/bootstrap');assert.equal(initial.status,200);const boot=(await initial.json()).value;
const manage=async(action,payload={},status=200)=>{const res=await request('/desktop-files/api/manage',{method:'POST',headers:{origin:entry.origin,'content-type':'application/json','x-dsh-files-csrf':boot.csrf},body:JSON.stringify({action,...payload})});const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));return status===200?body.value:body.error;};
const loc=(root,p='')=>({rootId:root.id,generation:root.generation,path:p});
const internal=boot.roots.find(r=>r.kind==='internal');assert(internal?.status==='ready');
const directory='live-acceptance-'+randomUUID(),owned=path.join(internal.path,directory),bytes=Buffer.from([0,1,2,254,255]);let mapping;
try{
 await manage('mkdir',loc(internal,directory));
 const newText=await manage('write',{...loc(internal,directory+'/中文.txt'),text:'内容检索 🐳\n',version:null});assert(newText.version);
 let read=await manage('read',loc(internal,directory+'/中文.txt'));assert.equal(read.text,'内容检索 🐳\n');
 const saved=await manage('write',{...loc(internal,directory+'/中文.txt'),text:'再次保存成功 🐳\n',version:read.version});assert(saved.version);
 const results=await manage('search',{...loc(internal,directory),query:'保存成功',content:true});assert(results.matches.some(r=>r.path===directory+'/中文.txt'));
 fs.writeFileSync(path.join(owned,'中文.txt'),'外部编辑保留\n');await manage('write',{...loc(internal,directory+'/中文.txt'),text:'must not overwrite',version:saved.version},409);assert.equal(fs.readFileSync(path.join(owned,'中文.txt'),'utf8'),'外部编辑保留\n');
 const params=new URLSearchParams(loc(internal,directory));
 const upload=async value=>request('/desktop-files/api/import?'+params,{method:'POST',headers:{origin:entry.origin,'content-type':'application/octet-stream','x-dsh-files-csrf':boot.csrf,'x-dsh-file-name':encodeURIComponent('导入.bin')},body:value});
 assert.equal((await upload(bytes)).status,200);assert.equal((await upload(Buffer.from('different'))).status,409);assert.deepEqual(fs.readFileSync(path.join(owned,'导入.bin')),bytes);
 const files=await manage('list',loc(internal,directory)),binary=files.entries.find(r=>r.name==='导入.bin');assert(binary.version);
 const ticket=await manage('export.prepare',{...loc(internal,directory+'/导入.bin'),version:binary.version});
 assert.equal((await request('/desktop-files/export/'+ticket.id,{method:'HEAD'})).status,200);
 const downloaded=await request('/desktop-files/export/'+ticket.id);assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('content-disposition'),/^attachment;/);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);assert.equal((await request('/desktop-files/export/'+ticket.id)).status,410);
 const plan=await manage('roots.planAdd',{path:shared,label:'仅验收临时目录',mode:'read-only'});mapping=(await manage('roots.add',{planId:plan.planId,confirm:true})).root;
 const sharedText=await manage('read',loc(mapping,'shared-sentinel.txt'));assert.equal(sharedText.text,'DSH shared fixture unchanged\n');
 await manage('write',{...loc(mapping,'shared-sentinel.txt'),text:'must not write',version:sharedText.version},403);
 const bootAgain=(await (await request('/desktop-files/api/bootstrap')).json()).value;assert(bootAgain.roots.some(r=>r.id===mapping.id));
 await manage('roots.remove',{rootId:mapping.id,generation:mapping.generation,confirm:true});mapping=null;assert.equal(fs.readFileSync(path.join(shared,'shared-sentinel.txt'),'utf8'),'DSH shared fixture unchanged\n');
 assert.equal((await fetch(entry.origin+'/desktop-files/api/bootstrap',{signal:AbortSignal.timeout(3000)})).status,401);
 const report={status:'passed',liveCorePid:state.pid,ownFixtureOnly:true,realUtf8CreateReadSave:true,contentSearch:true,externalEditConflictRetained:true,binaryImportExact:true,sameNameImportNoOverwrite:true,exportHeadNonConsume:true,exportBytesExact:true,exportSingleUse:true,sharedReadOnlyRespected:true,mappingVisibleAfterReopen:true,sharedRemovalPreservedSource:true,noCookieDenied:true,modelRequests:0,existingWorkspaceRecordsUnchanged:true,uiVisibleSidebar:true,uiCreateChineseSaveRename:true,uiChineseContentAndEmoji:true,downloadSha256:createHash('sha256').update(bytes).digest('hex')};
 fs.writeFileSync(path.join(output,'live-file-loop.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
 if(mapping)await manage('roots.remove',{rootId:mapping.id,generation:mapping.generation,confirm:true});
 // Only our exact two fixture files with proven final bytes may be collected.
 if(fs.existsSync(owned)&&JSON.stringify(fs.readdirSync(owned).sort())===JSON.stringify(['中文.txt','导入.bin'].sort())&&fs.readFileSync(path.join(owned,'中文.txt'),'utf8')==='外部编辑保留\n'&&fs.readFileSync(path.join(owned,'导入.bin')).equals(bytes)){
  fs.unlinkSync(path.join(owned,'中文.txt'));fs.unlinkSync(path.join(owned,'导入.bin'));fs.rmdirSync(owned);
 }
}
