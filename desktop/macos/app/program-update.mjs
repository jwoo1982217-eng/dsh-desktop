import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {prepareProgramLinks} from './program-links.mjs';
import {acquireProgramLock} from './program-recovery.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const absent=async f=>{try{return await fs.readFile(f)}catch(e){if(e.code==='ENOENT')return null;throw e}};
const atomic=async(f,b)=>{await fs.mkdir(path.dirname(f),{recursive:true});const t=f+'.program-'+randomUUID();try{await fs.writeFile(t,b,{mode:0o600,flag:'wx'});await fs.rename(t,f)}finally{await fs.rm(t,{force:true})}};
const safe=s=>typeof s==='string'&&s.length<1024&&!s.startsWith('/')&&!s.includes('\\')&&s.split('/').every(x=>x&&x!=='.'&&x!=='..');
async function noLinks(root,relative,runtime){let p=root;for(const part of relative.split('/')){p=path.join(p,part);try{if((await fs.lstat(p)).isSymbolicLink()){const real=await fs.realpath(p);if(!real.startsWith(path.join(runtime,'node_modules')+path.sep))throw Error('升级目标含外部链接，已保留原程序')}}catch(e){if(e.code!=='ENOENT')throw e}}}

/** A bounded program transaction. Accounts, settings and existing bundle registrations are retained. */
export async function applyProgramUpdate(home,runtime,{checkpoint=async()=>{}}={}){
  const raw=await absent(path.join(runtime,'program-update.json'));if(!raw)return null;
  const spec=JSON.parse(raw),profile=path.join(home,'profiles/web'),manifestFile=path.join(profile,'package.json');
  const original=await absent(manifestFile);if(!original)return null;
  if(spec.format!==1||spec.owner!=='dsh-go-selective-v1'||!Array.isArray(spec.files)||spec.files.length>4096)throw Error('定向升级清单无效');
  const manifest=JSON.parse(original);if(!Array.isArray(manifest.dsh?.profile?.bundles))throw Error('已有配置无法识别，未覆盖');
  const lock=await acquireProgramLock(home,{profile,runtime});
  let backup,committed=false,links,failure;const changed=[];let manifestAfter;
  try{
    const plans=[];let total=0;const seen=new Set();
    links=await prepareProgramLinks(profile,runtime,spec.links??[]);
    const existingFeature=await absent(path.join(profile,'node_modules/dsh-phone-features/.dsh-feature-program.json'));
    const owned=existingFeature?JSON.parse(existingFeature):null;
    if(owned&&owned.owner!=='dsh-phone-features-v1')throw Error('增强插件名称冲突，已保留原程序');
    const markerRow=spec.files.find(row=>row.path==='node_modules/dsh-phone-features/.dsh-feature-program.json');
    if(existingFeature&&markerRow&&hash(existingFeature)!==markerRow.sha256&&!markerRow.before?.includes(hash(existingFeature)))throw Error('增强插件标记有未识别的自定义修改，已保留原程序');
    for(const row of spec.files){
      if(!safe(row.path)||seen.has(row.path)||!/^node_modules\/(?:dsh-peer\/|dsh-phone-features\/)/.test(row.path))throw Error('程序升级路径无效');seen.add(row.path);
      await noLinks(profile,row.path,runtime);
      const data=await fs.readFile(path.join(runtime,'program-update',row.path));total+=data.length;
      if(total>64*1024*1024||data.length!==row.bytes||hash(data)!==row.sha256)throw Error('程序升级内容校验失败');
      const target=path.join(profile,row.path),before=await absent(target),beforeHash=before?hash(before):'missing';
      // An ownership label is not authorization to overwrite arbitrary bytes.
      // Each predecessor hash, including the marker itself, is frozen by the release.
      if(beforeHash!==row.sha256&&!row.before?.includes(beforeHash))throw Error('程序有未识别的自定义修改，已保留：'+row.path);
      if(beforeHash!==row.sha256)plans.push({target,data,before,beforeHash,after:row.sha256});
    }
    manifest.dependencies??={};manifest.dependencies['dsh-phone-features']='file:'+path.join(profile,'node_modules/dsh-phone-features');
    if(!manifest.dsh.profile.bundles.includes('dsh-phone-features'))manifest.dsh.profile.bundles.push('dsh-phone-features');
    manifestAfter=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
    const manifestChanged=JSON.stringify(manifest)!==JSON.stringify(JSON.parse(original));
    if(!plans.length&&!manifestChanged&&!links.plans.length)return {profile,fresh:false,selective:true,current:true};
    backup=path.join(home,'backups','dsh-go-program-'+spec.version+'-'+randomUUID());await fs.mkdir(backup,{recursive:true,mode:0o700});
    await fs.writeFile(path.join(backup,'package.json'),original,{mode:0o600});
    for(let i=0;i<plans.length;i++)if(plans[i].before)await fs.writeFile(path.join(backup,String(i)),plans[i].before,{mode:0o600});
    await fs.writeFile(path.join(backup,'restore.json'),JSON.stringify({version:spec.version,manifestFile,before:hash(original),after:hash(manifestAfter),files:plans.map((p,i)=>({target:p.target,saved:p.before?String(i):null,before:p.beforeHash,after:p.after}))}),{mode:0o600});
    await lock.recordBackup(backup);
    for(const plan of plans){
      const now=await absent(plan.target);if((now?hash(now):'missing')!==plan.beforeHash)throw Error('程序刚刚改变，未覆盖并发修改');
      await atomic(plan.target,plan.data);changed.push(plan);await checkpoint('published-'+changed.length);
    }
    await links.apply({rollbackFile:path.join(backup,'sdk-links.json'),checkpoint});
    if(!original.equals(await fs.readFile(manifestFile)))throw Error('配置刚刚改变，保留当前配置');
    if(manifestChanged){await atomic(manifestFile,manifestAfter);committed=true}
    await checkpoint('registered');
    await lock.markComplete();
    return {profile,backup,fresh:false,selective:true,updated:plans.length};
  }catch(error){
    failure=error;
    try{await links?.rollback()}catch{error.message+='；SDK链接有并发修改，已保留私有恢复材料'}
    if(committed){const now=await fs.readFile(manifestFile);if(now.equals(manifestAfter))await atomic(manifestFile,original);else error.message+='；配置有并发修改，已保留并提供回退副本'}
    for(const plan of changed.reverse()){
      const now=await absent(plan.target);if(!now||hash(now)!==plan.after){error.message+='；程序有并发修改，已保留';continue}
      if(plan.before)await atomic(plan.target,plan.before);else await fs.rm(plan.target);
    }
    throw error;
  }finally{try{await lock.release()}catch(error){if(failure)failure.message+='；恢复材料已保留：'+error.code;else throw error}}
}
