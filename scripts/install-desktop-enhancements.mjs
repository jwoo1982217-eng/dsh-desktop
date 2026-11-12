import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {fileURLToPath,pathToFileURL} from 'node:url';import {createHash,randomUUID} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),hash=v=>createHash('sha256').update(v).digest('hex');
const files=['package.json','cordis.patch.yml','index.mjs','metrics.mjs','history.mjs','updates.mjs','client.js','page.html','page.js','page.css','README.md'];
export function desktopEnhancementDependencies(modules){
 const runtime=createRequire(path.join(path.resolve(modules),'@deepseek-ai/dsh/package.json')),dependencies={};
 for(const name of ['@deepseek-ai/dsh-llm','@deepseek-ai/dsh-app-boot','@deepseek-ai/dsh-atomic-write','semver','yaml']){
  const resolver=name==='yaml'?createRequire(runtime.resolve('@deepseek-ai/dsh-app-boot/package.json')):runtime;
  let location;try{location=path.dirname(fs.realpathSync(resolver.resolve(name+'/package.json')));}catch(e){if(e.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw e;location=path.dirname(fs.realpathSync(resolver.resolve(name)));}
  dependencies[name]=location;
 }
 return dependencies;
}
export function wireDesktopEnhancementDependencies(directory,modules){
 for(const[name,location]of Object.entries(desktopEnhancementDependencies(modules))){
  if(!location.startsWith(fs.realpathSync(modules)+path.sep))throw Error('增强包依赖超出发行运行时');
  const target=path.join(directory,'node_modules',name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.symlinkSync(path.relative(path.dirname(target),location),target);
 }
}
export function installDesktopEnhancements(home,modules,{profile:profileDir}={}){
 home=path.resolve(home);modules=path.resolve(modules);const runtime=createRequire(path.join(modules,'@deepseek-ai/dsh/package.json'));
 if(JSON.parse(fs.readFileSync(runtime.resolve('@deepseek-ai/dsh/package.json'))).version!=='0.2.1-alpha.4')throw Error('增强包需要已适配的alpha.4运行时');
 const profile=profileDir?path.resolve(profileDir):path.join(home,'profiles/web'),manifestFile=path.join(profile,'package.json'),before=fs.readFileSync(manifestFile,'utf8'),manifest=JSON.parse(before);
 if(!Array.isArray(manifest.dsh?.profile?.bundles))throw Error('请选择现有Web profile');
 const hashes=Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(path.join(root,'desktop-enhancements',f)))])),fingerprint=hash(JSON.stringify(hashes));
 const target=path.join(home,'extensions/dsh-desktop-enhancements/0.1.0-'+fingerprint.slice(0,16)),link=path.join(profile,'node_modules/dsh-desktop-enhancements');
 const dependencies=desktopEnhancementDependencies(modules);
 const lock=path.join(profile,'.desktop-enhancements-install.lock');fs.mkdirSync(lock,{mode:0o700});let linked=false,created=false,committed=false,previousLink;
 try{
  if(fs.existsSync(target)){for(const f of files)if(hash(fs.readFileSync(path.join(target,f)))!==hashes[f])throw Error('已有增强包内容改变，保留原件');}
  else{const stage=target+'.new-'+randomUUID();fs.mkdirSync(stage,{recursive:true,mode:0o700});try{for(const f of files){fs.copyFileSync(path.join(root,'desktop-enhancements',f),path.join(stage,f));fs.chmodSync(path.join(stage,f),0o600);}for(const[name,location]of Object.entries(dependencies)){const p=path.join(stage,'node_modules',name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.symlinkSync(location,p);}fs.renameSync(stage,target);created=true;}finally{fs.rmSync(stage,{recursive:true,force:true});}}
  try{if(!fs.lstatSync(link).isSymbolicLink())throw Error('同名插件已有独立修改，保留原件');if(fs.realpathSync(link)!==fs.realpathSync(target)){
   if(!files.every(f=>{try{return hash(fs.readFileSync(path.join(link,f)))===hashes[f];}catch{return false;}}))throw Error('同名插件已有独立修改，保留原件');
   previousLink=fs.readlinkSync(link);fs.unlinkSync(link);fs.symlinkSync(path.relative(path.dirname(link),target),link);linked=true;
  }}
  catch(e){if(e.code!=='ENOENT')throw e;fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(path.relative(path.dirname(link),target),link);linked=true;}
  manifest.dependencies={...manifest.dependencies,'dsh-desktop-enhancements':'file:'+path.relative(profile,target).split(path.sep).join('/')};if(!manifest.dsh.profile.bundles.includes('dsh-desktop-enhancements'))manifest.dsh.profile.bundles.push('dsh-desktop-enhancements');
  if(fs.readFileSync(manifestFile,'utf8')!==before)throw Error('profile在安装期间变化，保留并发修改');const receiptDir=path.join(home,'storage/desktop-enhancements/install-'+fingerprint.slice(0,16));fs.mkdirSync(receiptDir,{recursive:true,mode:0o700});if(!fs.existsSync(path.join(receiptDir,'package.before.json')))fs.writeFileSync(path.join(receiptDir,'package.before.json'),before,{mode:0o600,flag:'wx'});
  const after=JSON.stringify(manifest,null,2)+'\n',tmp=manifestFile+'.enhancements-'+randomUUID();try{fs.writeFileSync(tmp,after,{mode:0o600,flag:'wx'});fs.renameSync(tmp,manifestFile);committed=true;}finally{fs.rmSync(tmp,{force:true});}
  const result={target,link,fingerprint,files:hashes,dependencies,beforeSha256:hash(before),afterSha256:hash(after),backup:path.join(receiptDir,'package.before.json')};fs.writeFileSync(path.join(receiptDir,'receipt.json'),JSON.stringify(result,null,2),{mode:0o600});return result;
 }catch(e){if(!committed){if(linked){fs.unlinkSync(link);if(previousLink)fs.symlinkSync(previousLink,link);}if(created)fs.rmSync(target,{recursive:true,force:true});}throw e;}
 finally{fs.rmdirSync(lock);}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)console.log(JSON.stringify(installDesktopEnhancements(process.argv[2],process.argv[3])));
