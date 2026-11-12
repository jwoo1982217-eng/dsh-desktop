import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
export const sha=b=>createHash('sha256').update(b).digest('hex');
const read=file=>{try{return fs.readFileSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const atomic=(file,bytes)=>{const temp=file+'.'+randomUUID();try{fs.writeFileSync(temp,bytes,{flag:'wx',mode:0o600});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}};
/** Only files whose exact reviewed baseline still matches may be changed. */
export function replaceFiles(files,after=()=>{}){
  const applied=[];for(const f of files){const before=read(f.installed);if((before?sha(before):null)!==f.beforeSha)throw Error('程序文件有独立修改：'+f.installed);}
  try{for(const f of files){const before=read(f.installed);if((before?sha(before):null)!==f.beforeSha)throw Error('程序文件出现并发修改：'+f.installed);atomic(f.installed,f.bytes);applied.push({...f,before});}return after();}
  catch(error){for(const f of applied.reverse()){const current=read(f.installed);if(!current||sha(current)!==sha(f.bytes))throw Error(error.message+'；存在并发修改，保留当前文件及备份');if(f.before)atomic(f.installed,f.before);else fs.unlinkSync(f.installed);}throw error;}
}
