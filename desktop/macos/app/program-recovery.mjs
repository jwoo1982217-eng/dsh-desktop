import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PROGRAM_LINK_MODULES,programLinkHash} from './program-links.mjs';

const OWNER='dsh-program-update-lock-v1',LEDGER='dsh-program-recovery-v1';
const peer=new Set(['proxy.mjs','transport-proxy.mjs','tunnel.mjs','ws-message-bridge.mjs','android-lan-agent.mjs','quiet-session-bridge.mjs'].map(p=>'node_modules/dsh-peer/'+p));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const safe=relative=>typeof relative==='string'&&relative.length<=1024&&!relative.startsWith('/')&&!/[\\\0-\x1f]/.test(relative)&&relative.split('/').every(s=>s&&s!=='.'&&s!=='..');
async function regular(file,{optional=false,limit=8*1024*1024,privateFile=false}={}){let fd;try{fd=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const stat=await fd.stat();fail(stat.isFile()&&stat.size<=limit,'PROGRAM_RECOVERY_FILE_INVALID');if(privateFile)fail((stat.mode&0o077)===0&&(!process.getuid||stat.uid===process.getuid()),'PROGRAM_RECOVERY_PRIVATE_FILE_INVALID');return await fd.readFile();}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}finally{await fd?.close();}}
async function hashCurrent(file){const bytes=await regular(file,{optional:true,limit:64*1024*1024});return bytes===null?'missing':digest(bytes);}
async function jsonFile(file,options){const bytes=await regular(file,options);if(bytes===null)return null;try{return {value:JSON.parse(bytes),bytes};}catch{throw Object.assign(Error('PROGRAM_RECOVERY_JSON_INVALID'),{code:'PROGRAM_RECOVERY_JSON_INVALID'});}}
async function atomic(file,bytes){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const next=file+'.recovery-'+randomUUID(),fd=await fs.open(next,'wx',0o600);try{try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}await fs.rename(next,file);}finally{await fs.rm(next,{force:true});}}
async function noParents(root,file){const base=await fs.lstat(root);fail(base.isDirectory()&&!base.isSymbolicLink(),'PROGRAM_RECOVERY_PROFILE_CHANGED');let p=path.dirname(file);while(p!==root){fail(p.startsWith(root+path.sep),'PROGRAM_RECOVERY_PATH_INVALID');try{const s=await fs.lstat(p);fail(s.isDirectory()&&!s.isSymbolicLink(),'PROGRAM_RECOVERY_PARENT_CHANGED');}catch(error){if(error.code!=='ENOENT')throw error;}p=path.dirname(p);}}
const lockPath=home=>path.join(home,'.mac-app-install.lock');
const metadataPath=home=>path.join(lockPath(home),'owner.json');
function privateBackup(home,backup){fail(typeof backup==='string'&&path.dirname(backup)===path.join(home,'backups')&&/^dsh-go-program-[A-Za-z0-9_.-]+$/.test(path.basename(backup)),'PROGRAM_RECOVERY_BACKUP_INVALID');}
async function readLock(home,profile){
 try{const stat=await fs.lstat(lockPath(home));fail(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&(!process.getuid||stat.uid===process.getuid()),'PROGRAM_UPDATE_LOCK_UNKNOWN');}catch(error){if(error.code==='ENOENT')return null;throw error;}
 let row;try{row=(await jsonFile(metadataPath(home),{privateFile:true,limit:16384})).value;}catch{throw Object.assign(Error('PROGRAM_UPDATE_LOCK_UNKNOWN'),{code:'PROGRAM_UPDATE_LOCK_UNKNOWN'});}
 fail(row?.owner===OWNER&&Number.isInteger(row.pid)&&row.pid>1&&typeof row.nonce==='string'&&/^[a-f0-9-]{36}$/.test(row.nonce)&&row.profile===profile&&typeof row.runtime==='string'&&path.isAbsolute(row.runtime),'PROGRAM_UPDATE_LOCK_UNKNOWN');
 if(row.backup!==null){privateBackup(home,row.backup);fail(isHash(row.restoreHash)&&isHash(row.allowlistHash),'PROGRAM_UPDATE_LOCK_UNKNOWN');}
 return row;
}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;return true;}}
async function clearLock(home,expected){
 const current=await readLock(home,expected.profile);fail(current?.nonce===expected.nonce,'PROGRAM_UPDATE_LOCK_CHANGED');
 const names=await fs.readdir(lockPath(home));fail(names.every(name=>name==='owner.json'||/^owner\.json\.recovery-[a-f0-9-]{36}$/.test(name)),'PROGRAM_UPDATE_LOCK_UNKNOWN');
 const retired=path.join(home,'.mac-app-install.released-'+expected.nonce);await fs.rename(lockPath(home),retired);
 for(const name of names)await fs.unlink(path.join(retired,name));await fs.rmdir(retired);
}

async function buildAllowlist(runtime,nonce,restoreHash){
 const spec=(await jsonFile(path.join(runtime,'program-update.json'),{limit:8*1024*1024})).value;
 fail(spec?.format===1&&spec.owner==='dsh-go-selective-v1'&&Array.isArray(spec.files)&&spec.files.length<=4096,'PROGRAM_RECOVERY_SPEC_INVALID');
 const rows=new Map(),featurePrefix='node_modules/dsh-phone-features/',marker=featurePrefix+'.dsh-feature-program.json';
 for(const row of spec.files){fail(safe(row.path)&&!rows.has(row.path)&&isHash(row.sha256),'PROGRAM_RECOVERY_SPEC_INVALID');rows.set(row.path,row);}
 let feature=new Map();
 if([...rows.keys()].some(p=>p.startsWith(featurePrefix))){
  const markerRow=rows.get(marker);fail(markerRow,'PROGRAM_RECOVERY_FEATURE_ALLOWLIST_MISSING');const raw=await regular(path.join(runtime,'program-update',marker));fail(digest(raw)===markerRow.sha256,'PROGRAM_RECOVERY_FEATURE_ALLOWLIST_INVALID');const data=JSON.parse(raw);fail(data.owner==='dsh-phone-features-v1'&&Array.isArray(data.files)&&data.files.length<=4096,'PROGRAM_RECOVERY_FEATURE_ALLOWLIST_INVALID');
  for(const row of data.files){fail(safe(row.path)&&row.path!=='.dsh-feature-program.json'&&!feature.has(featurePrefix+row.path)&&isHash(row.sha256),'PROGRAM_RECOVERY_FEATURE_ALLOWLIST_INVALID');feature.set(featurePrefix+row.path,row.sha256);}fail(feature.has(featurePrefix+'package.json'),'PROGRAM_RECOVERY_FEATURE_ALLOWLIST_INVALID');feature.set(marker,markerRow.sha256);
 }
 const files=[];
 for(const [relative,row]of rows){fail(peer.has(relative)||feature.get(relative)===row.sha256,'PROGRAM_RECOVERY_PATH_INVALID');files.push({path:relative,after:row.sha256});}
 const links=spec.links??[];fail(Array.isArray(links)&&links.length<=3,'PROGRAM_RECOVERY_SPEC_INVALID');const seen=new Set();
 for(const row of links){fail(row&&PROGRAM_LINK_MODULES[row.path]===row.module&&!seen.has(row.path)&&Array.isArray(row.before)&&row.before.every(x=>x==='missing'||isHash(x)),'PROGRAM_RECOVERY_SPEC_INVALID');seen.add(row.path);}
 return {owner:LEDGER,nonce,restoreHash,files,links};
}

async function loadLedger(meta){
 const restore=await jsonFile(path.join(meta.backup,'restore.json'),{privateFile:true});fail(digest(restore.bytes)===meta.restoreHash,'PROGRAM_RECOVERY_RESTORE_CHANGED');
 const saved=await jsonFile(path.join(meta.backup,'recovery-allowlist.json'),{privateFile:true});fail(digest(saved.bytes)===meta.allowlistHash,'PROGRAM_RECOVERY_ALLOWLIST_CHANGED');
 const allow=saved.value,value=restore.value;fail(allow.owner===LEDGER&&allow.nonce===meta.nonce&&allow.restoreHash===meta.restoreHash&&value.manifestFile===path.join(meta.profile,'package.json')&&isHash(value.before)&&isHash(value.after)&&Array.isArray(value.files)&&value.files.length<=4096,'PROGRAM_RECOVERY_RESTORE_INVALID');
 const fileMap=new Map(allow.files.map(row=>[row.path,row.after])),seen=new Set(),files=[];
 for(const row of value.files){const relative=path.relative(meta.profile,row.target??'').split(path.sep).join('/');fail(safe(relative)&&path.join(meta.profile,relative)===row.target&&!seen.has(relative)&&fileMap.get(relative)===row.after&&(row.before==='missing'||isHash(row.before)),'PROGRAM_RECOVERY_PATH_INVALID');seen.add(relative);fail(row.before==='missing'?row.saved===null:typeof row.saved==='string'&&/^[0-9]+$/.test(row.saved),'PROGRAM_RECOVERY_SAVED_INVALID');files.push(row);}
 const linkFile=await jsonFile(path.join(meta.backup,'sdk-links.json'),{privateFile:true,optional:true,limit:131072});let links=[];
 if(linkFile){const v=linkFile.value;fail(v.owner==='dsh-program-links-v1'&&v.profile===meta.profile&&v.runtime===meta.runtime&&Array.isArray(v.links)&&v.links.length<=3,'PROGRAM_RECOVERY_LINKS_INVALID');const linkSeen=new Set(),root=await fs.realpath(path.join(meta.runtime,'node_modules'));
  for(const row of v.links){const spec=allow.links.find(s=>s.path===row.path&&s.module===row.module);fail(spec&&PROGRAM_LINK_MODULES[row.path]===row.module&&!linkSeen.has(row.path)&&row.target===path.join(meta.profile,row.path)&&spec.before.includes(row.beforeHash),'PROGRAM_RECOVERY_LINKS_INVALID');linkSeen.add(row.path);fail(row.oldRaw===null?row.beforeHash==='missing':typeof row.oldRaw==='string'&&row.oldRaw.length<=4096&&!/[\0\r\n]/.test(row.oldRaw)&&programLinkHash(row.oldRaw)===row.beforeHash,'PROGRAM_RECOVERY_LINKS_INVALID');const desired=await fs.realpath(path.join(meta.runtime,'node_modules',row.module));fail(desired.startsWith(root+path.sep)&&row.newRaw===desired&&programLinkHash(row.newRaw)===row.afterHash,'PROGRAM_RECOVERY_LINKS_INVALID');links.push(row);}
 }
 return {value,files,links};
}
async function currentLink(target){try{const stat=await fs.lstat(target);fail(stat.isSymbolicLink(),'PROGRAM_RECOVERY_LINK_CHANGED');return programLinkHash(await fs.readlink(target));}catch(error){if(error.code==='ENOENT')return 'missing';throw error;}}
async function preflight(meta,{restored=false,committed=false}={}){
 const ledger=await loadLedger(meta),manifest=ledger.value.manifestFile;await noParents(meta.profile,manifest);const currentManifest=await hashCurrent(manifest);fail([ledger.value.before,ledger.value.after].includes(currentManifest),'PROGRAM_RECOVERY_MANIFEST_CONCURRENT');if(restored)fail(currentManifest===ledger.value.before,'PROGRAM_RECOVERY_NOT_RESTORED');
 const original=await regular(path.join(meta.backup,'package.json'),{privateFile:true});fail(digest(original)===ledger.value.before,'PROGRAM_RECOVERY_BACKUP_CHANGED');
 for(const row of ledger.files){await noParents(meta.profile,row.target);const current=await hashCurrent(row.target);fail([row.before,row.after].includes(current),'PROGRAM_RECOVERY_PROGRAM_CONCURRENT');if(restored)fail(current===row.before,'PROGRAM_RECOVERY_NOT_RESTORED');if(committed)fail(current===row.after,'PROGRAM_RECOVERY_NOT_COMMITTED');if(row.saved!==null)fail(digest(await regular(path.join(meta.backup,row.saved),{privateFile:true,limit:64*1024*1024}))===row.before,'PROGRAM_RECOVERY_BACKUP_CHANGED');}
 for(const row of ledger.links){await noParents(meta.profile,row.target);const current=await currentLink(row.target);fail([row.beforeHash,row.afterHash].includes(current),'PROGRAM_RECOVERY_LINK_CONCURRENT');if(restored)fail(current===row.beforeHash,'PROGRAM_RECOVERY_NOT_RESTORED');if(committed)fail(current===row.afterHash,'PROGRAM_RECOVERY_NOT_COMMITTED');}
 return {...ledger,original};
}
async function isComplete(meta){if(meta.complete)return true;if(!meta.backup)return false;const value=await jsonFile(path.join(meta.backup,'complete.json'),{privateFile:true,optional:true,limit:16384});if(!value)return false;const ledger=await loadLedger(meta);fail(value.value.complete===true&&value.value.files===ledger.files.length,'PROGRAM_RECOVERY_COMPLETE_INVALID');return true;}

/** Recover only an owned dead writer. Active/unknown locks and unknown concurrent bytes remain untouched. */
export async function recoverProgramUpdate(home,profile=path.join(home,'profiles/web')){
 home=path.resolve(home);profile=path.resolve(profile);fail(profile===path.join(home,'profiles/web'),'PROGRAM_RECOVERY_PROFILE_INVALID');const meta=await readLock(home,profile);if(!meta)return {recovered:false,absent:true};fail(!alive(meta.pid),'PROGRAM_UPDATE_LOCK_ACTIVE');
 if(meta.backup===null||await isComplete(meta)){await clearLock(home,meta);return {recovered:true,completed:meta.backup!==null};}
 const ledger=await preflight(meta);
 if(await hashCurrent(ledger.value.manifestFile)===ledger.value.after)await atomic(ledger.value.manifestFile,ledger.original);
 for(const row of [...ledger.links].reverse())if(await currentLink(row.target)===row.afterHash){if(row.oldRaw===null)await fs.unlink(row.target);else{const temporary=row.target+'.recover-link-'+randomUUID();try{await fs.symlink(row.oldRaw,temporary);await fs.rename(temporary,row.target);}finally{await fs.rm(temporary,{force:true});}}}
 for(const row of [...ledger.files].reverse())if(await hashCurrent(row.target)===row.after){if(row.before==='missing')await fs.unlink(row.target);else await atomic(row.target,await regular(path.join(meta.backup,row.saved),{privateFile:true,limit:64*1024*1024}));}
 await preflight(meta,{restored:true});await clearLock(home,meta);return {recovered:true,completed:false,files:ledger.files.length,links:ledger.links.length};
}

/** The parent records restore.json, then recordBackup(), before publishing its first file/link. */
export async function acquireProgramLock(home,{profile=path.join(home,'profiles/web'),runtime}={}){
 home=path.resolve(home);profile=path.resolve(profile);fail(profile===path.join(home,'profiles/web')&&typeof runtime==='string'&&path.isAbsolute(runtime),'PROGRAM_RECOVERY_PROFILE_INVALID');runtime=path.resolve(runtime);
 await recoverProgramUpdate(home,profile);await fs.mkdir(home,{recursive:true,mode:0o700});await fs.mkdir(lockPath(home),{mode:0o700});
 let meta={owner:OWNER,nonce:randomUUID(),pid:process.pid,profile,runtime,backup:null,complete:false},released=false;await atomic(metadataPath(home),Buffer.from(JSON.stringify(meta)+'\n'));
 const own=async()=>{fail(!released,'PROGRAM_UPDATE_LOCK_RELEASED');const current=await readLock(home,profile);fail(current?.nonce===meta.nonce&&current.pid===process.pid,'PROGRAM_UPDATE_LOCK_CHANGED');};
 return {
  path:lockPath(home),
  async recordBackup(backup){await own();backup=path.resolve(backup);privateBackup(home,backup);const stat=await fs.lstat(backup);fail(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'PROGRAM_RECOVERY_BACKUP_INVALID');const restore=await regular(path.join(backup,'restore.json'),{privateFile:true}),restoreHash=digest(restore),allow=await buildAllowlist(runtime,meta.nonce,restoreHash),allowBytes=Buffer.from(JSON.stringify(allow)+'\n');
   await atomic(path.join(backup,'recovery-allowlist.json'),allowBytes);const next={...meta,backup,restoreHash,allowlistHash:digest(allowBytes)};await loadLedger(next);await preflight(next);await atomic(metadataPath(home),Buffer.from(JSON.stringify(next)+'\n'));meta=next;return {recorded:true};},
  async markComplete(){await own();fail(meta.backup,'PROGRAM_RECOVERY_BACKUP_REQUIRED');await preflight(meta,{committed:true});const ledger=await loadLedger(meta);await atomic(path.join(meta.backup,'complete.json'),Buffer.from(JSON.stringify({complete:true,files:ledger.files.length})+'\n'));meta={...meta,complete:true};await atomic(metadataPath(home),Buffer.from(JSON.stringify(meta)+'\n'));},
  async release(){await own();if(meta.backup&&!await isComplete(meta))await preflight(meta,{restored:true});await clearLock(home,meta);released=true;},
 };
}
