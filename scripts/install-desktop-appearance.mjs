import {cp,mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const begin='# BEGIN dsh-appearance-center',end='# END dsh-appearance-center';
export async function installDesktopAppearance(profile,modules,{writePatch=true}={}){
 const manifestPath=path.join(profile,'package.json'),patchPath=path.join(profile,'cordis.patch.yml');
 const manifestBytes=await readFile(manifestPath,'utf8'),patchBytes=await readFile(patchPath,'utf8'),manifest=JSON.parse(manifestBytes);
 if(!Array.isArray(manifest.dsh?.profile?.bundles))throw Error('请选择现有 DSH profile');
 if(JSON.parse(await readFile(path.join(modules,'@deepseek-ai/dsh/package.json'),'utf8')).version!=='0.2.1-alpha.4')throw Error('外观适配需要已验证的 SDK 0.2.1-alpha.4');
 const block='\n'+begin+'\n- insert:\n    - id: appearance-center\n      name: dsh-appearance-center\n'+end+'\n';
 let nextPatch=patchBytes;
 if(patchBytes.includes(begin)){const start=patchBytes.indexOf(begin),finish=patchBytes.indexOf(end,start);if(finish<start||patchBytes.indexOf(begin,start+begin.length)!==-1)throw Error('外观安装标记存在冲突');nextPatch=patchBytes.slice(0,start)+patchBytes.slice(finish+end.length);}
 // A manual Cordis row is hot-loadable without recomposing/restarting the core.
 // A profile already selecting the bundle uses its normal bundle patch instead.
 if(!manifest.dsh.profile.bundles.includes('dsh-appearance-center'))nextPatch=nextPatch.trimEnd()+block;
 manifest.dependencies={...manifest.dependencies,'dsh-appearance-center':'file:./node_modules/dsh-appearance-center'};
 const suffix='.'+randomUUID(),target=path.join(profile,'node_modules/dsh-appearance-center'),stage=target+suffix,backup=target+'.old'+suffix;
 let old=false,installed=false,manifestWritten=false;
 try{
  await mkdir(path.dirname(target),{recursive:true});await cp(path.join(root,'appearance'),stage,{recursive:true,filter:file=>!file.includes('/node_modules')&&!file.includes('/test-fixtures')&&!file.endsWith('.test.mjs')&&!file.endsWith('/build-catalog.mjs')});
  if(await readFile(manifestPath,'utf8')!==manifestBytes||await readFile(patchPath,'utf8')!==patchBytes)throw Error('Profile 同时被其他窗口修改，请重试');
  try{await rename(target,backup);old=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  await rename(stage,target);installed=true;
  await writeFile(manifestPath+suffix,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});await rename(manifestPath+suffix,manifestPath);manifestWritten=true;
  if(await readFile(patchPath,'utf8')!==patchBytes)throw Error('Profile 补丁同时被其他窗口修改，请重试');
  if(writePatch){await writeFile(patchPath+suffix,nextPatch,{mode:0o600});await rename(patchPath+suffix,patchPath);}
  if(old)await rm(backup,{recursive:true});return {plugin:target,version:'0.1.0',hotLoadable:true,bundlesPreserved:true};
 }catch(error){
  if(installed)await rm(target,{recursive:true,force:true});if(old)await rename(backup,target);
  if(manifestWritten && await readFile(manifestPath,'utf8')===JSON.stringify(manifest,null,2)+'\n'){await writeFile(manifestPath+suffix,manifestBytes,{mode:0o600});await rename(manifestPath+suffix,manifestPath);}
  throw error;
 }finally{await rm(stage,{recursive:true,force:true});await rm(manifestPath+suffix,{force:true});await rm(patchPath+suffix,{force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(!process.argv[2]||!process.argv[3])throw Error('Usage: node scripts/install-desktop-appearance.mjs <profile> <runtime node_modules>');console.log(JSON.stringify(await installDesktopAppearance(path.resolve(process.argv[2]),path.resolve(process.argv[3]))));}
