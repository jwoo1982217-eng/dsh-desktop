import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const allowed=new Map([
 ['node_modules/dsh-peer/node_modules/@deepseek-ai/dsh-http-proxy','@deepseek-ai/dsh-http-proxy'],
 ['node_modules/dsh-phone-features/node_modules/@deepseek-ai/dsh-session','@deepseek-ai/dsh-session'],
 ['node_modules/dsh-phone-features/node_modules/@deepseek-ai/dsh','@deepseek-ai/dsh'],
]);
export const PROGRAM_LINK_MODULES=Object.freeze(Object.fromEntries(allowed));
export const programLinkHash=raw=>createHash('sha256').update(raw).digest('hex');
const fail=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
async function linkState(file){try{const stat=await fs.lstat(file);fail(stat.isSymbolicLink(),'PROGRAM_LINK_CUSTOM_ENTRY');const raw=await fs.readlink(file);return {raw,hash:programLinkHash(raw)};}catch(error){if(error.code==='ENOENT')return {raw:null,hash:'missing'};throw error;}}
async function parents(profile,file){const base=await fs.lstat(profile);fail(base.isDirectory()&&!base.isSymbolicLink(),'PROGRAM_LINK_PROFILE_INVALID');let current=path.dirname(file);while(current!==profile){fail(current.startsWith(profile+path.sep),'PROGRAM_LINK_PATH_INVALID');try{const stat=await fs.lstat(current);fail(stat.isDirectory()&&!stat.isSymbolicLink(),'PROGRAM_LINK_PARENT_CHANGED');}catch(error){if(error.code!=='ENOENT')throw error;}current=path.dirname(current);}}
async function sameTarget(file,desired){try{return await fs.realpath(file)===desired;}catch(error){if(['ENOENT','ENOTDIR','ELOOP'].includes(error.code))return false;throw error;}}
async function replaceLink(profile,file,raw){await parents(profile,file);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temporary=file+'.program-link-'+randomUUID();try{await fs.symlink(raw,temporary);await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}}

/** Read-only preflight of exactly the three owned SDK seams. No plugin/package directory is swapped. */
export async function prepareProgramLinks(profile,runtime,rows=[]){
 profile=path.resolve(profile);runtime=path.resolve(runtime);fail(Array.isArray(rows)&&rows.length<=3,'PROGRAM_LINK_SPEC_INVALID');
 const plans=[],checked=[],seen=new Set();let applied=[];
 if(rows.length){const stat=await fs.lstat(profile);fail(stat.isDirectory()&&!stat.isSymbolicLink(),'PROGRAM_LINK_PROFILE_INVALID');}
 const moduleRoot=rows.length?await fs.realpath(path.join(runtime,'node_modules')):null;
 for(const row of rows){
  fail(row&&allowed.get(row.path)===row.module&&!seen.has(row.path),'PROGRAM_LINK_SPEC_INVALID');seen.add(row.path);
  fail(Array.isArray(row.before)&&row.before.length<=32&&row.before.every(value=>value==='missing'||/^[a-f0-9]{64}$/.test(value)),'PROGRAM_LINK_SPEC_INVALID');
  const desired=await fs.realpath(path.join(runtime,'node_modules',row.module));fail(desired.startsWith(moduleRoot+path.sep),'PROGRAM_LINK_SDK_OUTSIDE_RUNTIME');
  const pkg=JSON.parse(await fs.readFile(path.join(desired,'package.json'),'utf8'));fail(pkg.name===row.module,'PROGRAM_LINK_SDK_IDENTITY_INVALID');
  const target=path.join(profile,row.path),before=await linkState(target);checked.push({path:row.path,module:row.module});
  if(before.raw!==null&&await sameTarget(target,desired))continue;
  await parents(profile,target);fail(row.before.includes(before.hash),'PROGRAM_LINK_UNKNOWN_INPUT');
  plans.push({path:row.path,module:row.module,target,beforeHash:before.hash,afterHash:programLinkHash(desired),oldRaw:before.raw,newRaw:desired});
 }
 async function rollback(){
  // Check every changed link before restoring any: preserve user edits and retain the private record.
  const restore=[];
  for(const plan of applied){await parents(profile,plan.target);const current=await linkState(plan.target);if(current.hash===plan.beforeHash)continue;fail(current.hash===plan.afterHash,'PROGRAM_LINK_ROLLBACK_CONCURRENT');restore.push(plan);}
  for(const plan of restore.reverse()){if(plan.oldRaw===null)await fs.unlink(plan.target);else await replaceLink(profile,plan.target,plan.oldRaw);}
  const restored=applied.length;applied=[];return {restored};
 }
 async function apply({rollbackFile,checkpoint=async()=>{}}={}){
  const pending=[];
  for(const plan of plans){const current=await linkState(plan.target);if(current.raw!==null&&await sameTarget(plan.target,plan.newRaw))continue;await parents(profile,plan.target);fail(current.hash===plan.beforeHash,'PROGRAM_LINK_CONCURRENT');pending.push(plan);}
  if(!pending.length)return {changed:0,current:true};
  fail(typeof rollbackFile==='string'&&path.isAbsolute(rollbackFile),'PROGRAM_LINK_PRIVATE_ROLLBACK_REQUIRED');
  await fs.mkdir(path.dirname(rollbackFile),{recursive:true,mode:0o700});
  // The caller retains this 0600 record beside its program/configuration transaction backup.
  const temporary=rollbackFile+'.tmp-'+randomUUID(),backup=await fs.open(temporary,'wx',0o600);
  try{try{await backup.writeFile(JSON.stringify({owner:'dsh-program-links-v1',profile,runtime,links:pending})+'\n');await backup.sync();}finally{await backup.close();}await fs.link(temporary,rollbackFile);}finally{await fs.rm(temporary,{force:true});}
  try{
   for(const plan of pending){
    await parents(profile,plan.target);const current=await linkState(plan.target);fail(current.hash===plan.beforeHash,'PROGRAM_LINK_CONCURRENT');
    await replaceLink(profile,plan.target,plan.newRaw);applied.push(plan);await checkpoint('link-published-'+applied.length,{path:plan.path,module:plan.module});
   }
   return {changed:applied.length,current:false,rollbackFile};
  }catch(error){try{await rollback();}catch(recovery){error.recovery=recovery.code??'PROGRAM_LINK_ROLLBACK_FAILED';}throw error;}
 }
 return {plans,checked,apply,rollback};
}
