import { homedir as __publicHomedir, tmpdir as __publicTmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {install} from './install.mjs';
const home=(__publicHomedir() + '/.dsh'),report=(__publicTmpdir() + '/dsh-memory-constellation-20261108');
fs.mkdirSync(report,{recursive:true,mode:0o700});
let state;
for(let i=0;i<360;i++){
  try{const s=JSON.parse(fs.readFileSync(path.join(home,'.desktop-web-3080.json')));if(!s.starting&&s.url){const r=await fetch(s.url,{redirect:'manual',signal:AbortSignal.timeout(1000)});if(r.ok||r.status===302||r.status===303){state=s;break;}}}catch{}
  await new Promise(r=>setTimeout(r,500));
}
assert(state,'DSH 后台尚未就绪');const origin=new URL(state.url).origin;
assert.equal(origin,'http://127.0.0.1:3080');assert.equal(state.version,'0.2.2-rc.1');
const auth=await fetch(state.url,{redirect:'manual',signal:AbortSignal.timeout(5000)}),cookie=auth.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert(cookie);
async function request(url,options={}){return fetch(origin+url,{...options,headers:{cookie,...options.headers},signal:AbortSignal.timeout(10000)});}
async function rpc(base,method,payload){const response=await request(base+'/'+method,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload})});const d=await response.json();assert(d.result?.ok,d.result?.error?.message||'RPC failed');return d.result.value;}
const protectedNames=['.credentials.yaml','.env','cordis.patch.yml','profiles/web/cordis.patch.yml','.desktop-web-3080.json','knowledge/workbench/state.json','knowledge/summary-memory.json'];
const protectedHashes=()=>Object.fromEntries(protectedNames.map(f=>[f,fs.existsSync(path.join(home,f))?createHash('sha256').update(fs.readFileSync(path.join(home,f))).digest('hex'):null]));
async function snapshot(){const [sessions,plugins,graph]=await Promise.all([rpc('/api','session/list',{args:{_request:{}}}),rpc('/api','pluginManager/listPlugins',{args:{}}),rpc('/knowledge-base','manage',{action:'graph'})]);return {pid:JSON.parse(fs.readFileSync(path.join(home,'.desktop-web-3080.json'))).pid,sessions:sessions.items.map(s=>({id:s.sessionId,running:s.running})),plugins:plugins.map(p=>({module:p.moduleName,entryId:p.entryId,enabled:p.enabled,phase:p.fiberPhase})),graph,protected:protectedHashes(),manifest:JSON.parse(fs.readFileSync(path.join(home,'profiles/web/package.json')))};}
let before;
if(process.argv.includes('--install')){
  before=await snapshot();
  fs.writeFileSync(path.join(report,'before.private.json'),JSON.stringify(before),{mode:0o600,flag:'wx'});
  const receipt=install(home,'/Applications/DSH.app/Contents/Resources/runtime/node_modules');
  fs.writeFileSync(path.join(report,'installation.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  console.log('Installed local extension; checking hot activation.');
}else before=JSON.parse(fs.readFileSync(path.join(report,'before.private.json')));
let stars;
for(let i=0;i<60;i++){
  const response=await request('/meow-constellation/api/memories?all=1');
  if(response.ok){const body=await response.json();if(body.ok){stars=body;break;}console.log('Waiting:',body.error);}
  await new Promise(r=>setTimeout(r,500));
}
assert(stars,'Plugin did not become ready; existing service was not restarted');
const after=await snapshot();const restarted=after.pid!==before.pid;
const protectedBefore={...before.protected},protectedAfter={...after.protected};
if(restarted){delete protectedBefore['.desktop-web-3080.json'];delete protectedAfter['.desktop-web-3080.json'];}
const credentialsFileChanged=protectedAfter['.credentials.yaml']!==protectedBefore['.credentials.yaml'];
// The running credential provider may rotate sessions independently. Retain its current file; do not claim byte identity.
delete protectedBefore['.credentials.yaml'];delete protectedAfter['.credentials.yaml'];
assert.deepEqual(protectedAfter,protectedBefore,'Knowledge or configuration data changed');
const newIds=new Set(after.sessions.map(s=>s.id));assert(before.sessions.every(s=>newIds.has(s.id)));
const counts=rows=>{const out=new Map();for(const p of rows){const key=JSON.stringify([p.module,p.enabled,p.phase]),n=out.get(key)||0;out.set(key,n+1);}return out;};
const currentCounts=counts(after.plugins);for(const [key,n] of counts(before.plugins))assert((currentCounts.get(key)||0)>=n,'Existing plugin state changed: '+key);
assert(after.plugins.some(p=>p.module==='dsh-meow-constellation'&&p.enabled&&p.phase==='active'));
const strip=value=>{const result=structuredClone(value);delete result.dependencies['dsh-meow-constellation'];result.dsh.profile.bundles=result.dsh.profile.bundles.filter(n=>n!=='dsh-meow-constellation');return result;};assert.deepEqual(strip(after.manifest),strip(before.manifest));
const expected=after.graph.edges.map(e=>({...e,from:'knowledge:'+e.from,to:'knowledge:'+e.to}));assert.deepEqual(stars.edges,expected);
const known=new Set(after.graph.nodes.map(n=>'knowledge:'+n.id));assert(stars.items.some(n=>known.has(n.id)));
const example=stars.items.find(n=>n.source==='知识库');assert(example);const source=await rpc('/knowledge-base','manage',{action:'read',id:example.sourceId});assert.equal(example.content,source.body.slice(0,12000));
const read=await (await request('/meow-constellation/api/read?id='+encodeURIComponent(example.id))).json();assert.equal(read.item.content,source.body.slice(0,12000));
assert.equal((await fetch(origin+'/meow-constellation/api/memories')).status,401);
assert.equal((await request('/meow-constellation/api/memories',{headers:{origin:'https://example.invalid'}})).status,403);
const workbench=await (await request('/knowledge-base/page.js')).text();
assert.equal(workbench,fs.readFileSync(new URL('../knowledge-workbench/page.js',import.meta.url),'utf8'),'知识库页面未部署');
assert(workbench.includes('/meow-constellation/app?embedded=1'));
assert(!fs.readFileSync(new URL('./client.js',import.meta.url),'utf8').includes('sidebar.panellist'));
const receipt={knowledgePageMerged:true,standaloneSidebarRemoved:true,status:'installed-and-active',version:'0.1.0-dsh-kb.1',upstream:JSON.parse(fs.readFileSync(new URL('./upstream-source.json',import.meta.url))),core:state.version,pidUnchanged:!restarted,normalRestart:restarted,oldSessionsPreserved:true,sessionCountBefore:before.sessions.length,sessionCountAfter:after.sessions.length,oldPluginStatesPreserved:true,knowledgeAndConfigHashesUnchanged:true,credentialsFileChanged,credentialsCause:credentialsFileChanged?'not determined; current credentials preserved without overwrite':null,unrelatedProfileFieldsUnchanged:true,
  knowledgeNotes:stars.items.filter(n=>n.source==='知识库').length,summaryEntries:stars.items.filter(n=>n.source==='记忆摘要').length,edges:stars.edges.length,graphMatchesOriginal:true,detailMatchesOriginal:true,unauthenticatedDenied:true,foreignOriginDenied:true,modelRequestsSent:0,uiVerified:false};
fs.writeFileSync(path.join(report,'live-verification.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));
