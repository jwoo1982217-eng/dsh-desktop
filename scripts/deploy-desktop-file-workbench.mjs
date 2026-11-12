import { homedir as __publicHomedir, tmpdir as __publicTmpdir } from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {preflightDesktopFileWorkbench, installDesktopFileWorkbench, packageName} from './install-desktop-file-workbench.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const home=(__publicHomedir() + '/.dsh'), modules=path.join(repo,'desktop-runtime/node_modules');
const output=(__publicTmpdir() + '/dsh-desktop-file-workbench-20261106/generated/live-acceptance');
fs.mkdirSync(output,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=()=>JSON.parse(fs.readFileSync(path.join(home,'profiles/web/package.json')));
const protectedFiles=['.credentials.yaml','.env','cordis.patch.yml','profiles/web/cordis.patch.yml','.desktop-web-3080.json'];
const protectedHashes=()=>Object.fromEntries(protectedFiles.map(name=>[name,fs.existsSync(path.join(home,name))?sha(fs.readFileSync(path.join(home,name))):null]));
const pid=()=>{const lines=execFileSync('/usr/sbin/lsof',['-nP','-t','-iTCP:3080','-sTCP:LISTEN'],{encoding:'utf8'}).trim().split('\n');assert.equal(lines.length,1);return Number(lines[0]);};
const livePid=pid(),state=JSON.parse(fs.readFileSync(path.join(home,'.desktop-web-3080.json')));
assert.equal(state.pid,livePid);const entry=new URL(state.url);assert.equal(entry.origin,'http://127.0.0.1:3080');
const auth=await fetch(entry,{redirect:'manual',signal:AbortSignal.timeout(3000)});
const cookie=auth.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert(cookie);
async function rpc(method,payload){const res=await fetch(entry.origin+'/api/'+method,{method:'POST',headers:{cookie,origin:entry.origin,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload}),signal:AbortSignal.timeout(10000)});const value=await res.json();assert(value.result?.ok,'Existing DSH API is not healthy');return value.result.value;}
async function snapshot(){const [sessions,plugins]=await Promise.all([rpc('session/list',{args:{_request:{}}}),rpc('pluginManager/listPlugins',{args:{}})]);return {pid:pid(),manifest:manifest(),protected:protectedHashes(),sessions:sessions.items.map(s=>({id:s.sessionId,running:s.running})),plugins:plugins.map(p=>({id:p.entryId,module:p.moduleName,enabled:p.enabled,phase:p.fiberPhase}))};}
const before=await snapshot();assert.equal(before.pid,livePid);
const preflight=preflightDesktopFileWorkbench(home,modules);
fs.writeFileSync(path.join(output,'preflight.json'),JSON.stringify(preflight,null,2));
if(!process.argv.includes('--apply')){console.log(JSON.stringify({status:preflight.status,pid:livePid,sessionCount:before.sessions.length,pluginCount:before.plugins.length,fingerprint:preflight.fingerprint}));process.exit(0);}
const installed=installDesktopFileWorkbench(home,modules,{apply:true,owner:'codex-dsh-desktop-files-20261106'});
fs.writeFileSync(path.join(output,'installation.json'),JSON.stringify(installed,null,2));
let response,boot;
for(let i=0;i<80;i++){
 response=await fetch(entry.origin+'/desktop-files/api/bootstrap',{headers:{cookie},signal:AbortSignal.timeout(3000)});
 if(response.ok){boot=(await response.json()).value;break;}
 await new Promise(resolve=>setTimeout(resolve,250));
}
assert(boot,'New file workbench did not activate; original core was not restarted');
assert(boot.limits.providerAvailable);
const after=await snapshot();assert.equal(after.pid,before.pid);
assert.deepEqual(after.protected,before.protected,'Existing credentials, routing, policy or launch state changed');
const withoutOwn=value=>{const copy=structuredClone(value);delete copy.dependencies?.[packageName];copy.dsh.profile.bundles=copy.dsh.profile.bundles.filter(name=>name!==packageName);return copy;};
assert.deepEqual(withoutOwn(after.manifest),withoutOwn(before.manifest),'Unrelated profile fields changed');
const currentIds=new Set(after.sessions.map(s=>s.id));assert(before.sessions.every(s=>currentIds.has(s.id)),'An existing session disappeared');
const currentPlugins=new Map(after.plugins.map(p=>[p.id,p]));assert(before.plugins.every(p=>currentPlugins.get(p.id)?.module===p.module&&currentPlugins.get(p.id)?.enabled===p.enabled),'An existing plugin changed');
assert(after.plugins.some(p=>p.module===packageName&&p.phase==='active'));
const result={status:'installed-and-hot-loaded',pidUnchanged:true,pid:livePid,noRestart:true,sessionCountBefore:before.sessions.length,sessionCountAfter:after.sessions.length,existingSessionsRetained:true,existingPluginsRetained:true,protectedFileHashesUnchanged:true,unrelatedProfileFieldsUnchanged:true,providerMode:boot.limits.providerMode,canWriteText:boot.limits.canWriteText,canNativeMutate:boot.limits.canNativeMutate,fingerprint:installed.fingerprint,installationReceipt:installed.receipt,modelRequestsSent:0};
fs.writeFileSync(path.join(output,'live-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
