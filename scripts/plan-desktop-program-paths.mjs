import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const protectedSource = file => /(?:^|\/)Downloads\//.test(file) || /(?:^|\/)desktop-runtime(?:\/|$)/.test(file);
/** Read-only operational plan. It changes neither installed programs nor user configuration. */
export async function planDesktopProgramPaths({profile=path.join(os.homedir(),'.dsh/profiles/web'),runtime='/Applications/DSH.app/Contents/Resources/runtime',sourceReceipt}={}) {
  const modules=path.join(profile,'node_modules'),appModules=path.join(runtime,'node_modules');
  const manifestFile=path.join(profile,'package.json'),manifestBytes=await fs.readFile(manifestFile),manifest=JSON.parse(manifestBytes);
  const symlinks=[];
  for(const top of await fs.readdir(modules,{withFileTypes:true})) {
    const topPath=path.join(modules,top.name),children=top.isDirectory()&&top.name.startsWith('@')?(await fs.readdir(topPath)).map(name=>path.join(topPath,name)):[topPath];
    for(const file of children)if((await fs.lstat(file)).isSymbolicLink()) {
      const raw=await fs.readlink(file);let real;
      try {real=await fs.realpath(file);}catch(error){if(error.code!=='ENOENT')throw error;}
      if(protectedSource(real??path.resolve(path.dirname(file),raw)))symlinks.push({file,raw,real});
    }
  }
  const sourceDependencies=Object.entries(manifest.dependencies??{}).filter(([,spec])=>typeof spec==='string'&&protectedSource(spec.replace(/^(?:file|link):/,''))).map(([name,spec])=>({name,spec}));
  const require=createRequire(path.join(appModules,'@deepseek-ai/dsh/package.json')),Y=require('yaml');
  const entries=[];
  function walk(node,trail=[]) {
    if(Y.isMap(node)) {
      const name=node.get('name');
      if(typeof name==='string'&&(name.startsWith('file:')||name.startsWith('./')||name.startsWith('../')))entries.push({id:node.get('id'),location:trail.join('.'),name,file:name.startsWith('file:')?fileURLToPath(name):path.resolve(profile,name),disabled:node.get('disabled')===true});
      for(const pair of node.items)walk(pair.value,[...trail,pair.key?.value]);
    } else if(Y.isSeq(node))node.items.forEach((child,index)=>walk(child,[...trail,index]));
  }
  const configurationHashes=[];
  for(const file of [path.join(profile,'cordis.patch.yml'),path.join(path.dirname(path.dirname(profile)),'cordis.patch.yml')]) {
    try {const bytes=await fs.readFile(file),document=Y.parseDocument(bytes.toString());if(document.errors.length)throw Error('Cordis patch cannot be parsed; no plan published');configurationHashes.push({file,sha256:sha(bytes)});walk(document.contents);}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const directImports=[];
  for(const entry of entries) {
    const bytes=await fs.readFile(entry.file),text=bytes.toString();
    const imports=[...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()(['"])([^'"]+)\1/g)].map(match=>match[2]);
    directImports.push({file:entry.file,sha256:sha(bytes),imports,sourcePathReferences:text.split('\n').flatMap((line,index)=>/Downloads|desktop-runtime/.test(line)?[{line:index+1,text:line.trim()}]:[])});
  }
  let checkedSources=0,transitiveSourceReferences=[];
  if(sourceReceipt) {
    const receipt=JSON.parse(await fs.readFile(sourceReceipt));
    for(const row of receipt.mappedSources??[])if(/\.(?:mjs|js|cjs)$/.test(row.source)) {
      const text=await fs.readFile(row.source,'utf8');checkedSources++;
      text.split('\n').forEach((line,index)=>{if(/Downloads|desktop-runtime/.test(line))transitiveSourceReferences.push({file:row.source,line:index+1,text:line.trim()});});
    }
  }
  const actions=[],packageEvidence=[];
  // The only observed development package. Never substitute a merely same-version changed program.
  for(const dependency of sourceDependencies) {
    if(dependency.name!=='dsh-orcaterm-llm')continue;
    const link=symlinks.find(row=>row.file===path.join(modules,dependency.name));
    if(!link)throw Error('Manifest development dependency lacks its verified installed link');
    const target=path.join(appModules,dependency.name),source=link.real;
    const sourcePackage=JSON.parse(await fs.readFile(path.join(source,'package.json'))),targetPackage=JSON.parse(await fs.readFile(path.join(target,'package.json')));
    if(sourcePackage.version!==targetPackage.version)throw Error('Application program version differs; no redirect is proposed');
    const files=[];
    async function compare(relative='') {for(const entry of await fs.readdir(path.join(target,relative),{withFileTypes:true})) {
      if(['node_modules','.git','.DS_Store'].includes(entry.name))continue;
      const name=path.join(relative,entry.name);
      if(entry.isDirectory())await compare(name);
      else if(entry.isFile()) {const [oldBytes,newBytes]=await Promise.all([fs.readFile(path.join(source,name)),fs.readFile(path.join(target,name))]);if(!oldBytes.equals(newBytes))throw Error('Application program bytes differ: '+name);files.push({file:name,sha256:sha(newBytes),bytes:newBytes.length});}
    }}
    await compare();packageEvidence.push({name:dependency.name,version:sourcePackage.version,source,target,files});
    actions.push({kind:'replace-symlink',file:link.file,beforeRawTarget:link.raw,afterTarget:target});
    const afterSpec=dependency.spec.startsWith('link:')?'link:'+target:'file:'+target;
    actions.push({kind:'replace-package-dependency',file:manifestFile,beforeFileSha256:sha(manifestBytes),jsonPointer:'/dependencies/'+dependency.name,beforeValue:dependency.spec,afterValue:afterSpec});
  }
  return {readOnly:true,profile,runtime,manifestSha256:sha(manifestBytes),configurationHashes,sourceSymlinks:symlinks,sourceDependencies,directEntries:entries,directImports,checkedMappedSourceFiles:checkedSources,transitiveSourceReferences,packageEvidence,actions,limits:['Only current profile links/dependencies, literal Cordis entries and the previously mapped local source closure were inspected.','No claim is made that these references establish the cause of the GUI filesystem stall.','No process, file-access permission, account, credential, session or tool policy was changed.']};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [profile,runtime,sourceReceipt]=process.argv.slice(2);
  console.log(JSON.stringify(await planDesktopProgramPaths({...(profile?{profile}:{}),...(runtime?{runtime}:{}),...(sourceReceipt?{sourceReceipt}:{})}),null,2));
}
