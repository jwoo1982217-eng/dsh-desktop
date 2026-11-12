import {readFile,writeFile,mkdir,rename,rm,lstat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function existing(file){try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw Error('外观程序路径不是普通文件');return await readFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function atomic(file,bytes){const temp=file+'.appearance-'+randomUUID();try{await writeFile(temp,bytes,{mode:0o600,flag:'wx'});await rename(temp,file);}finally{await rm(temp,{force:true});}}
export async function restoreProgramUpdate(backup){
  const state=JSON.parse(await readFile(path.join(backup,'transaction.json'),'utf8'));
  for(const row of [...state.files].reverse()){
    const current=await existing(row.target),digest=current===null?null:hash(current);
    if(digest===row.before)continue;
    if(digest!==row.after)throw Error('外观程序同时被修改，保留现场并停止恢复');
    if(row.before===null)await rm(row.target);else await atomic(row.target,await readFile(path.join(backup,row.backup)));
  }
  await atomic(path.join(backup,'status.json'),Buffer.from(JSON.stringify({state:'restored'})));
}
/** Exact file whitelist, all-copy preflight and rollback; never writes wallpaper or user preferences. */
export async function applyProgramUpdate({targets,files,backup,afterPublish=()=>{}}){
  const rows=[];
  for(const [copy,root] of targets.entries())for(const file of files){
    if(!/^[a-z][a-z-]*\.(mjs|js|html|css)$/.test(file.name))throw Error('外观更新文件名无效');
    const bytes=Buffer.from(file.body,'base64');if(hash(bytes)!==file.after)throw Error('外观更新校验失败');
    const target=path.join(root,file.name),current=await existing(target),before=current===null?null:hash(current);
    if(before!==file.before&&before!==file.after)throw Error('发现未知外观改动，停止更新：'+file.name);
    rows.push({target,before,after:file.after,backup:copy+'-'+file.name,bytes,current});
  }
  if(rows.every(row=>row.before===row.after))return {changed:0,idempotent:true};
  await mkdir(backup,{recursive:true,mode:0o700});
  // Exclusive receipt prevents a new attempt from overwriting an existing recovery point.
  await writeFile(path.join(backup,'transaction.json'),JSON.stringify({files:rows.map(({bytes,current,...row})=>row)}),{mode:0o600,flag:'wx'});
  for(const row of rows)if(row.current!==null)await writeFile(path.join(backup,row.backup),row.current,{mode:0o600,flag:'wx'});
  let published=0;
  try{
    for(const row of rows){
      const current=await existing(row.target);if((current===null?null:hash(current))!==row.before)throw Error('外观程序同时被修改，停止更新');
      if(row.before===row.after)continue;await atomic(row.target,row.bytes);afterPublish(++published);
    }
    await atomic(path.join(backup,'status.json'),Buffer.from(JSON.stringify({state:'installed',changed:published})));
    return {changed:published,idempotent:false,backup};
  }catch(error){await restoreProgramUpdate(backup);throw error;}
}
