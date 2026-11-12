import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url));
const fail=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const owned='dsh-wallpaper-prewarm-backup-v1';
async function regular(file,limit=65536){
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const stat=await handle.stat();fail(stat.isFile()&&stat.size<=limit,'PATCH_FILE_INVALID');return {bytes:await handle.readFile(),mode:stat.mode&0o777};}
  finally{await handle.close();}
}
async function atomic(file,bytes,mode=0o600){
  const temporary=path.join(path.dirname(file),'.wallpaper-prewarm-'+randomUUID()+'.tmp');
  try{const handle=await fs.open(temporary,'wx',mode);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}await fs.rename(temporary,file);}
  finally{await fs.rm(temporary,{force:true});}
}
async function packageAt(root,manifest){
  fail(path.isAbsolute(root),'PATCH_TARGET_ABSOLUTE_REQUIRED');
  const real=await fs.realpath(root),data=JSON.parse((await regular(path.join(real,'package.json'))).bytes);
  fail(data.name===manifest.package&&data.version===manifest.version,'PATCH_PACKAGE_MISMATCH');
  return real;
}
export async function loadPatch(){
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
  const before=(await regular(path.join(directory,'fixtures/faststart-before.txt'))).bytes;
  const after=(await regular(path.join(directory,'faststart.js'))).bytes;
  fail(manifest.owner==='dsh-wallpaper-prewarm-patch-v1'&&manifest.relativeTarget==='lib/faststart.js','PATCH_MANIFEST_INVALID');
  fail(hash(before)===manifest.before.sha256&&hash(after)===manifest.after.sha256,'PATCH_PAYLOAD_HASH_MISMATCH');
  return {manifest,before,after};
}
export async function planPatch(targets){
  const {manifest}=await loadPatch();
  fail(Array.isArray(targets)&&targets.length>=1&&targets.length<=2,'PATCH_TARGET_COUNT_INVALID');
  const rows=[];
  for(const input of targets){
    const root=await packageAt(input,manifest),target=path.join(root,manifest.relativeTarget);
    fail(!rows.some(x=>x.target===target),'PATCH_TARGET_DUPLICATE');
    const state=await regular(target),sha256=hash(state.bytes);
    fail([manifest.before.sha256,manifest.after.sha256].includes(sha256),'PATCH_UNKNOWN_TARGET_BYTES');
    rows.push({root,target,sha256,mode:state.mode,status:sha256===manifest.after.sha256?'applied':'original'});
  }
  fail(rows.every(x=>x.status===rows[0].status),'PATCH_MIXED_TARGET_STATE');
  return {manifest,targets:rows,changed:rows[0].status==='original'};
}
async function preflightReceipt(backupDir){
  fail(typeof backupDir==='string'&&path.isAbsolute(backupDir),'PATCH_BACKUP_ABSOLUTE_REQUIRED');
  const {manifest}=await loadPatch(),receipt=JSON.parse((await regular(path.join(backupDir,'receipt.json'))).bytes);
  fail(receipt.owner===owned&&receipt.package===manifest.package&&receipt.before===manifest.before.sha256&&receipt.after===manifest.after.sha256&&Array.isArray(receipt.targets)&&receipt.targets.length>=1&&receipt.targets.length<=2,'PATCH_BACKUP_INVALID');
  const checked=[];
  for(const [index,row]of receipt.targets.entries()){
    const root=await packageAt(row.root,manifest);
    fail(row.target===path.join(root,manifest.relativeTarget)&&row.saved==='before-'+index+'.bin'&&!checked.some(x=>x.row.target===row.target)&&Number.isSafeInteger(row.mode)&&row.mode>=0&&row.mode<=0o777,'PATCH_BACKUP_TARGET_INVALID');
    const saved=await regular(path.join(backupDir,row.saved));
    fail(hash(saved.bytes)===manifest.before.sha256,'PATCH_BACKUP_HASH_MISMATCH');
    const current=await regular(row.target),currentHash=hash(current.bytes);
    fail([manifest.before.sha256,manifest.after.sha256].includes(currentHash),'PATCH_CONCURRENT_TARGET_CHANGE');
    checked.push({row,saved: saved.bytes,currentHash});
  }
  return {manifest,receipt,checked};
}
export async function rollbackPatch(backupDir){
  const {manifest,receipt,checked}=await preflightReceipt(backupDir);
  // Validate every backup and destination before restoring even the first file.
  for(const {row,saved,currentHash}of checked.reverse()){
    if(currentHash===manifest.before.sha256)continue;
    fail(hash((await regular(row.target)).bytes)===manifest.after.sha256,'PATCH_CONCURRENT_TARGET_CHANGE');
    await atomic(row.target,saved,row.mode);
  }
  for(const {row}of checked)fail(hash((await regular(row.target)).bytes)===manifest.before.sha256,'PATCH_ROLLBACK_VERIFY_FAILED');
  await atomic(path.join(backupDir,'receipt.json'),JSON.stringify({...receipt,status:'rolled-back'})+'\n');
  return {restored:true,targets:checked.map(x=>x.row.target)};
}
export async function applyPatch({targets,backupDir,checkpoint}={}){
  const plan=await planPatch(targets),{manifest,before,after}=await loadPatch();
  if(!plan.changed)return {changed:false,targets:plan.targets.map(x=>x.target)};
  fail(typeof backupDir==='string'&&path.isAbsolute(backupDir),'PATCH_BACKUP_ABSOLUTE_REQUIRED');
  await fs.mkdir(path.dirname(backupDir),{recursive:true,mode:0o700});
  await fs.mkdir(backupDir,{mode:0o700}); // An existing recovery point is never overwritten.
  const receipt={owner:owned,package:manifest.package,before:manifest.before.sha256,after:manifest.after.sha256,status:'prepared',targets:plan.targets.map((row,index)=>({root:row.root,target:row.target,mode:row.mode,saved:'before-'+index+'.bin'}))};
  for(const row of receipt.targets){const handle=await fs.open(path.join(backupDir,row.saved),'wx',0o600);try{await handle.writeFile(before);await handle.sync();}finally{await handle.close();}}
  await atomic(path.join(backupDir,'receipt.json'),JSON.stringify(receipt)+'\n');
  let published=false;
  try{
    for(const row of receipt.targets)fail(hash((await regular(row.target)).bytes)===manifest.before.sha256,'PATCH_CONCURRENT_TARGET_CHANGE');
    for(const [index,row]of receipt.targets.entries()){
      fail(hash((await regular(row.target)).bytes)===manifest.before.sha256,'PATCH_CONCURRENT_TARGET_CHANGE');
      await atomic(row.target,after,row.mode);published=true;
      await checkpoint?.('published-'+(index+1),{target:row.target});
    }
    for(const row of receipt.targets)fail(hash((await regular(row.target)).bytes)===manifest.after.sha256,'PATCH_INSTALL_VERIFY_FAILED');
    await atomic(path.join(backupDir,'receipt.json'),JSON.stringify({...receipt,status:'complete'})+'\n');
    return {changed:true,backupDir,targets:receipt.targets.map(x=>x.target)};
  }catch(error){
    if(published)try{await rollbackPatch(backupDir);}catch(recovery){throw Object.assign(Error('PATCH_FAILED_ROLLBACK_REFUSED'),{code:'PATCH_FAILED_ROLLBACK_REFUSED',cause:error,recovery});}
    throw error;
  }
}
async function cli(args){
  const action=args.shift(),targets=[];let backupDir;
  while(args.length){const flag=args.shift(),value=args.shift();fail(typeof value==='string'&&!value.startsWith('--'),'PATCH_ARGUMENT_INVALID');if(flag==='--target')targets.push(value);else if(flag==='--backup')backupDir=value;else fail(false,'PATCH_ARGUMENT_INVALID');}
  fail(['plan','apply','rollback'].includes(action),'PATCH_ACTION_INVALID');
  if(action==='rollback'){fail(targets.length===0,'PATCH_ARGUMENT_INVALID');return rollbackPatch(backupDir);}
  if(action==='apply')return applyPatch({targets,backupDir});
  fail(backupDir===undefined,'PATCH_ARGUMENT_INVALID');return planPatch(targets);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{console.log(JSON.stringify(await cli(process.argv.slice(2))));}catch(error){console.error(error.code??'PATCH_OPERATION_FAILED');process.exitCode=1;}
}
