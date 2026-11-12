import { homedir as __publicHomedir } from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function maybeManifest(directory) {
  try {const bytes=await fs.readFile(path.join(directory,'package.json'));return {value:JSON.parse(bytes),sha256:hash(bytes)};}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
/** Read-only SDK lookup audit; no installed aliases, processes or permissions are changed. */
export async function planAncestorSdkAliases({ancestor=(__publicHomedir() + '/.dsh/profiles/node_modules/@deepseek-ai'),runtime='/Applications/DSH.app/Contents/Resources/runtime'}={}) {
  const modules=path.join(runtime,'node_modules'),appScope=path.join(modules,'@deepseek-ai');
  const core=await maybeManifest(path.join(appScope,'dsh'));
  if(core?.value.name!=='@deepseek-ai/dsh'||core.value.version!=='0.2.2-rc.1')throw Error('Expected the deployed rc.1 application runtime');
  const closure=new Map(),queue=['@deepseek-ai/dsh'];
  while(queue.length) {
    const name=queue.shift();if(closure.has(name))continue;
    const entry=await maybeManifest(path.join(modules,name));if(!entry)continue;
    closure.set(name,entry);
    for(const dependency of Object.keys({...entry.value.dependencies,...entry.value.optionalDependencies,...entry.value.peerDependencies}))if(!closure.has(dependency))queue.push(dependency);
  }
  const appManifests=new Map();
  for(const entry of await fs.readdir(appScope,{withFileTypes:true})) {
    const name='@deepseek-ai/'+entry.name,manifest=await maybeManifest(path.join(appScope,entry.name));if(manifest)appManifests.set(name,manifest);
  }
  const rows=[],sourceRoots=new Map();
  for(const entry of await fs.readdir(ancestor,{withFileTypes:true})) {
    const name='@deepseek-ai/'+entry.name,file=path.join(ancestor,entry.name),stat=await fs.lstat(file),row={name,file,symlink:stat.isSymbolicLink(),inode:stat.ino,device:stat.dev};
    if(!stat.isSymbolicLink()){row.action='hold-non-alias';rows.push(row);continue;}
    row.raw=await fs.readlink(file);row.rawSha256=hash(Buffer.from(row.raw));row.resolved=path.resolve(path.dirname(file),row.raw);
    sourceRoots.set(path.dirname(row.resolved),(sourceRoots.get(path.dirname(row.resolved))??0)+1);
    try {row.real=await fs.realpath(file);}catch(error){if(error.code!=='ENOENT')throw error;row.broken=true;}
    const source=await maybeManifest(file),target=appManifests.get(name),targetDirectory=path.join(appScope,entry.name);
    row.source=source?{name:source.value.name,version:source.value.version,manifestSha256:source.sha256,repository:source.value.repository}:null;
    row.target=target?{directory:targetDirectory,name:target.value.name,version:target.value.version,manifestSha256:target.sha256,inCoreClosure:closure.has(name),repository:target.value.repository}:null;
    row.legacyProgramRoot=/\/Downloads\//.test(row.real??row.resolved)&&/\/node_modules\/@deepseek-ai\//.test(row.real??row.resolved);
    row.brokenExactSdkAlias=!!row.broken&&row.resolved.endsWith('/node_modules/'+name);
    if(row.real===targetDirectory)row.action='already-current';
    else if(target&&target.value.name===name&&closure.has(name)&&(row.legacyProgramRoot||row.brokenExactSdkAlias)&&(!source||source.value.name===name))row.action='retarget-to-app';
    else if(!target&&row.legacyProgramRoot&&(!source||source.value.name===name))row.action='review-legacy-search-alias';
    else if(!target&&row.brokenExactSdkAlias)row.action='review-broken-search-alias';
    else row.action='hold-for-review';
    rows.push(row);
  }
  const absent=rows.filter(row=>!row.target).map(row=>row.name),references=[];
  for(const [name,entry]of appManifests)for(const field of ['dependencies','optionalDependencies','peerDependencies'])for(const [dependency,spec]of Object.entries(entry.value[field]??{}))if(absent.includes(dependency))references.push({name,field,dependency,spec});
  for(const row of rows.filter(row=>row.action==='review-legacy-search-alias'))if(references.some(reference=>reference.dependency===row.name))row.action='hold-missing-still-referenced';
  const counts={entries:rows.length,symlinks:rows.filter(row=>row.symlink).length,broken:rows.filter(row=>row.broken).length,oldDownloads:rows.filter(row=>row.legacyProgramRoot).length,appSameName:rows.filter(row=>row.target).length,appMissingName:absent.length,retarget:rows.filter(row=>row.action==='retarget-to-app').length,retire:rows.filter(row=>row.action==='review-legacy-search-alias').length,detachBroken:rows.filter(row=>row.action==='detach-broken-search-alias').length,current:rows.filter(row=>row.action==='already-current').length,hold:rows.filter(row=>row.action.startsWith('hold')).length,newRuntimeReferencesToMissing:references.length};
  const sourceRootEvidence=[...sourceRoots].map(([directory,count])=>({directory,count})).sort((a,b)=>b.count-a.count);
  return {readOnly:true,ancestor,runtime,coreVersion:core.value.version,coreManifestSha256:core.sha256,coreDependencyClosurePackages:closure.size,appSdkPackages:appManifests.size,counts,rows,sourceRootEvidence,newRuntimeReferencesToMissing:references,recommendation:'Retarget only exact same-name application closure rows marked retarget-to-app. Missing npm packages may name live frontend virtual-module contracts: keep all review/missing rows unchanged until their current consumers and the rc.1 virtual module catalog are checked. No scope-wide replacement or quarantine is authorized by this read-only plan.',constraints:['Do not point a legacy missing package at a different package name.','Do not leave rc.8 aliases visible as a fallback for retired rc.1 modules.','Retain the original directory/links for exact rollback; no user data, settings, models, accounts, sessions or policies are in this plan.','This audit establishes lookup-generation drift, not that any given filesystem stall was caused by it.']};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [output,ancestor,runtime]=process.argv.slice(2);if(!output)throw Error('A private JSON output path is required');
  const plan=await planAncestorSdkAliases({...(ancestor?{ancestor}:{}),...(runtime?{runtime}:{})});
  await fs.writeFile(output,JSON.stringify(plan,null,2),{mode:0o600});await fs.chmod(output,0o600);
  console.log(JSON.stringify({readOnly:plan.readOnly,counts:plan.counts,privatePlan:output}));
}
