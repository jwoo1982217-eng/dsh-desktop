import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
export const files=['package.json','cordis.patch.yml','index.mjs','data.mjs','tools.mjs','http.mjs','client.js','page.html','page.js','LICENSE','upstream-source.json'];
const name='dsh-meow-constellation',sha=s=>createHash('sha256').update(s).digest('hex');
const atomic=(file,bytes)=>{const tmp=file+'.'+randomUUID();try{fs.writeFileSync(tmp,bytes,{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}};
const exists=p=>{try{return fs.lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export function install(home,modules,{source=fileURLToPath(new URL('./',import.meta.url)),beforeCommit=()=>{},afterCommit=()=>{},replaceFingerprint}={}){
  home=fs.realpathSync(home);modules=fs.realpathSync(modules);
  for(const p of ['@deepseek-ai/dsh','@deepseek-ai/dsh-tools'])if(JSON.parse(fs.readFileSync(path.join(modules,p,'package.json'))).version!=='0.2.2-rc.1')throw Error('需要当前已验证的 DSH rc.1 运行时');
  const profile=path.join(home,'profiles/web'),file=path.join(profile,'package.json'),lock=path.join(home,'.mac-app-install.lock');
  fs.mkdirSync(lock,{mode:0o700});let created=false,linked=false,committed=false,after,before,target,link,previousLink;
  try{
    before=fs.readFileSync(file,'utf8');const manifest=JSON.parse(before);if(!Array.isArray(manifest.dsh?.profile?.bundles))throw Error('现有 profile 无效');
    const bytes=Object.fromEntries(files.map(f=>[f,fs.readFileSync(path.join(source,f))])),hashes=Object.fromEntries(files.map(f=>[f,sha(bytes[f])])),fingerprint=sha(JSON.stringify(hashes));
    target=path.join(home,'extensions',name,fingerprint);link=path.join(profile,'node_modules',name);
    if(exists(link)||manifest.dependencies?.[name]||manifest.dsh.profile.bundles.includes(name)){
      if(exists(link)?.isSymbolicLink()&&fs.realpathSync(link)===target&&manifest.dependencies?.[name]==='file:'+target&&manifest.dsh.profile.bundles.filter(x=>x===name).length===1&&files.every(f=>sha(fs.readFileSync(path.join(target,f)))===hashes[f]))return {unchanged:true,target,fingerprint};
      const old=exists(link)?.isSymbolicLink()?fs.realpathSync(link):null;
      if(!replaceFingerprint||!/^[a-f0-9]{64}$/.test(replaceFingerprint)||old!==path.join(home,'extensions',name,replaceFingerprint)||manifest.dependencies?.[name]!=='file:'+old||manifest.dsh.profile.bundles.filter(x=>x===name).length!==1)throw Error('同名插件已存在，保留原安装；不能自动覆盖');
      const oldReceipt=JSON.parse(fs.readFileSync(path.join(home,'storage/memory-constellation/install-'+replaceFingerprint.slice(0,16),'receipt.json')));
      if(oldReceipt.fingerprint!==replaceFingerprint||!files.every(f=>sha(fs.readFileSync(path.join(old,f)))===oldReceipt.files[f]))throw Error('已有插件含独立修改，已保留');
      previousLink=fs.readlinkSync(link);
    }
    if(exists(target))throw Error('已有同指纹目录尚未登记，保留原件');
    fs.mkdirSync(target,{recursive:true,mode:0o700});created=true;
    for(const f of files)fs.writeFileSync(path.join(target,f),bytes[f],{mode:0o600,flag:'wx'});
    fs.mkdirSync(path.join(target,'node_modules/@deepseek-ai'),{recursive:true});
    fs.symlinkSync(fs.realpathSync(path.join(modules,'@deepseek-ai/dsh-tools')),path.join(target,'node_modules/@deepseek-ai/dsh-tools'));
    fs.mkdirSync(path.dirname(link),{recursive:true});
    const tempLink=link+'.'+randomUUID();try{fs.symlinkSync(target,tempLink);if(previousLink&&fs.readlinkSync(link)!==previousLink)throw Error('插件链接发生并发变化');fs.renameSync(tempLink,link);linked=true;}finally{fs.rmSync(tempLink,{force:true});}
    beforeCommit();if(fs.readFileSync(file,'utf8')!==before)throw Error('profile 已被其他任务修改，保留并发修改');
    const recovery=path.join(home,'storage/memory-constellation/install-'+fingerprint.slice(0,16));fs.mkdirSync(recovery,{recursive:true,mode:0o700});
    const backup=path.join(recovery,'package.before.json');fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
    manifest.dependencies={...manifest.dependencies,[name]:'file:'+target};if(!manifest.dsh.profile.bundles.includes(name))manifest.dsh.profile.bundles.push(name);
    after=JSON.stringify(manifest,null,2)+'\n';atomic(file,after);committed=true;afterCommit();
    const receipt={target,link,fingerprint,files:hashes,backup,previousLink,beforeSha256:sha(before),afterSha256:sha(after),version:JSON.parse(bytes['package.json']).version};
    fs.writeFileSync(path.join(recovery,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});return receipt;
  }catch(e){
    if(committed){if(fs.readFileSync(file,'utf8')!==after)throw new Error(e.message+'；profile 出现并发修改，已保留安装及恢复文件');atomic(file,before);}
    if(linked&&exists(link)?.isSymbolicLink()&&fs.readlinkSync(link)===target){fs.unlinkSync(link);if(previousLink)fs.symlinkSync(previousLink,link);}
    if(created)fs.rmSync(target,{recursive:true,force:true});throw e;
  }finally{fs.rmdirSync(lock);}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)console.log(JSON.stringify(install(process.argv[2],process.argv[3])));
