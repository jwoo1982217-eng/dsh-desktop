import {readFile, writeFile, mkdir, mkdtemp, rename, rm, symlink, realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {patchPocket} from './patch.mjs';

const registry='https://registry.npmjs.org/';
const json=async file=>JSON.parse(await readFile(file,'utf8'));
async function atomic(file,bytes){
  const temp=file+'.pocket-'+randomUUID();
  try{await writeFile(temp,bytes,{flag:'wx',mode:0o600});await rename(temp,file);}
  finally{await rm(temp,{force:true});}
}

/** Use this installation's Node and CLI, only inside a fresh, isolated profile. */
export async function installStagedPocket({stage,version,coreEntry,timeoutMs}){
  const directory=path.join(stage,'profiles/pocket-update');
  await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'package.json'),JSON.stringify({name:'pocket-update',private:true,dependencies:{},dsh:{profile:{bundles:[]}}}));
  return new Promise(resolve=>{
    const child=spawn(process.execPath,['--expose-internals',coreEntry,'plugin','--profile','pocket-update','add',`dsh-pocket@${version}`,'--save-exact','--ignore-scripts','--ignore-workspace','--registry',registry],
      {cwd:stage,env:{...process.env,DSH_HOME:stage},stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
    let output='',timedOut=false,killTimer;
    const append=bytes=>{output=(output+String(bytes)).slice(-4000);};
    child.stdout.on('data',append);child.stderr.on('data',append);
    const stop=signal=>{try{if(process.platform!=='win32')process.kill(-child.pid,signal);else child.kill(signal);}catch{}};
    const timer=setTimeout(()=>{timedOut=true;stop('SIGTERM');killTimer=setTimeout(()=>stop('SIGKILL'),2000);},timeoutMs);
    child.once('error',error=>{clearTimeout(timer);clearTimeout(killTimer);resolve({ok:false,error:error.message});});
    child.once('close',code=>{clearTimeout(timer);clearTimeout(killTimer);resolve({ok:code===0&&!timedOut,output:timedOut?'Pocket 下载超时，请重试':output,code});});
  });
}

/** Stage dependencies first; publish only Pocket, retaining the previous entry for recovery. */
export async function performDesktopUpdate(options={}){
  const home=path.resolve(options.home??process.env.DSH_HOME??path.join(homedir(),'.dsh'));
  const currentProfile=process.argv[process.argv.indexOf('--profile')+1]??'web';
  const expectedProfile=process.argv.includes('--profile')?currentProfile:'web';
  const profile=options.profile??expectedProfile;
  if(!/^[a-zA-Z0-9_-]+$/.test(profile)||profile!==expectedProfile)return {ok:false,error:'只能更新当前 DSH profile 的 Pocket'};
  const directory=path.join(home,'profiles',profile),manifestFile=path.join(directory,'package.json');
  const target=path.join(directory,'node_modules/dsh-pocket');
  const lock=path.join(home,'dsh-pocket','.desktop-update.lock');
  let locked=false,stage,published=false,oldMoved=false,backup,manifestCommitted=false,original;
  try{
    await mkdir(path.dirname(lock),{recursive:true,mode:0o700});
    try{await mkdir(lock,{mode:0o700});locked=true;}catch(error){if(error.code==='EEXIST')throw Error('Pocket 正在更新，请等待本次更新完成');throw error;}
    original=await readFile(manifestFile,'utf8');
    const before=JSON.parse(original),installed=await json(path.join(target,'package.json'));
    if(installed.name!=='dsh-pocket'||!before.dsh?.profile?.bundles?.includes('dsh-pocket'))throw Error('当前 profile 未安装 Pocket');
    const coreEntry=path.resolve(options.coreEntry??process.argv[1]);
    if((await json(path.resolve(coreEntry,'../../package.json'))).name!=='@deepseek-ai/dsh')throw Error('无法定位桌面版内置 DSH，未修改安装');
    const request=options.metadata??(async()=>{
      const r=await fetch(registry+'dsh-pocket/latest',{signal:AbortSignal.timeout(15000)});
      if(!r.ok)throw Error(`Pocket 版本查询失败（HTTP ${r.status}）`);return r.json();
    });
    const meta=await request();
    if(meta?.name!=='dsh-pocket'||!/^\d+\.\d+\.\d+$/.test(meta.version))throw Error('Pocket 版本信息无效');
    const require=createRequire(coreEntry),semver=require('semver');
    if(!semver.gt(meta.version,installed.version))return {ok:true,version:installed.version,autoRestart:false,restartRequired:true,output:'当前已安装此版本；重新打开 DSH 后生效'};
    const updates=path.join(home,'dsh-pocket','updates');await mkdir(updates,{recursive:true,mode:0o700});
    stage=await mkdtemp(path.join(updates,'pocket-'));
    const result=await (options.install??installStagedPocket)({stage,version:meta.version,coreEntry,timeoutMs:options.timeoutMs??180000});
    if(!result.ok)throw Error(result.error||result.output||'Pocket 下载失败');
    const next=path.join(stage,'profiles/pocket-update/node_modules/dsh-pocket');
    const downloaded=await json(path.join(next,'package.json'));
    if(downloaded.name!=='dsh-pocket'||downloaded.version!==meta.version)throw Error('下载的 Pocket 版本不匹配');
    await patchPocket(await realpath(next));
    const packageRequire=createRequire(await realpath(path.join(next,'package.json')));
    for(const name of Object.keys(downloaded.dependencies??{}))packageRequire.resolve(name);
    // Cooperate with the native plugin manager's manifest lock, as well as our single-update lock.
    const {withFileLock}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href);
    await withFileLock(manifestFile,async()=>{
      if(await readFile(manifestFile,'utf8')!==original)throw Error('Profile 在更新期间变化，请重试；已有修改已保留');
      backup=path.join(home,'dsh-pocket','backups',randomUUID());await mkdir(backup,{recursive:true,mode:0o700});
      await writeFile(path.join(backup,'package.json.before'),original,{mode:0o600});
      await rename(target,path.join(backup,'previous-pocket'));oldMoved=true;
      try{
        await symlink(next,target,process.platform==='win32'?'junction':'dir');published=true;
        const after=structuredClone(before);after.dependencies['dsh-pocket']='file:'+next;
        await options.beforeManifestCommit?.();
        if(await readFile(manifestFile,'utf8')!==original)throw Error('Profile 在提交前变化，已取消更新');
        await atomic(manifestFile,JSON.stringify(after,null,2)+'\n');manifestCommitted=true;
        await writeFile(path.join(backup,'restore.json'),JSON.stringify({profile:directory,target,stage,version:meta.version,dependency:after.dependencies['dsh-pocket']},null,2),{mode:0o600});
      }catch(error){
        if(published){await rm(target,{recursive:true,force:true});published=false;}
        if(oldMoved){await rename(path.join(backup,'previous-pocket'),target);oldMoved=false;}
        if(manifestCommitted){await atomic(manifestFile,original);manifestCommitted=false;}
        throw error;
      }
    },{waitMs:1000});
    return {ok:true,version:meta.version,autoRestart:false,restartRequired:true,backup,output:`Pocket ${meta.version} 已安装，重新打开 DSH 后生效`};
  }catch(error){return {ok:false,error:error.message??String(error)};}
  finally{
    if(stage&&!published)await rm(stage,{recursive:true,force:true});
    if(locked)await rm(lock,{recursive:true,force:true});
  }
}
