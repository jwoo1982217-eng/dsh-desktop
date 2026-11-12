import {readFile, writeFile, mkdir, realpath, cp, rm, symlink, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export const desktopCoreVersion = '0.2.2-rc.1';
export const defaultRc1Runtime = path.join(root,'desktop-runtime/rc1');
const lockHash = 'f96c598ed30d28259faf168e51152b25c9b597f1e30aa1455239f7878fabe3cd';
const sha = value => createHash('sha256').update(value).digest('hex');
const compatible = [
  ['rc1','applyRc1Compatibility'],
  ['history-controller','applyRc1HistoryControllerCompatibility'],
  ['behaviors','applyBehaviorCompatibility'],
  ['client','applyRc1ClientCompatibility'],
  ['team','applyRc1TeamCompatibility'],
  ['inspector','applyRc1InspectorCompatibility'],
];
function packageIdentity(snapshot) {
  const plain=snapshot.split('(')[0],at=plain.lastIndexOf('@');
  if(at<=0)throw Error('锁文件包标识不合法：'+snapshot);
  return {name:plain.slice(0,at),version:plain.slice(at+1)};
}
function safeRelative(value) {
  return typeof value==='string' && value.startsWith('node_modules/') && !path.isAbsolute(value) && !value.split('/').some(part=>!part||part==='.'||part==='..'||part.includes('\\'));
}
/** Read-only inspection of an already installed, pure official dependency input. */
export async function preflightDesktopRc1(source=defaultRc1Runtime,{target}={}) {
  if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('rc.1 Mac 构建要求 darwin-arm64；没有生成其他平台产物');
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<24||major===24&&minor<11)throw Error('rc.1 Mac 构建要求 Node.js >=24.11.0');
  source=path.resolve(source);
  const canonical=JSON.parse(await readFile(path.join(defaultRc1Runtime,'package.json'),'utf8'));
  if(JSON.stringify(canonical.dependencies)!==JSON.stringify({'@deepseek-ai/dsh':desktopCoreVersion}))throw Error('rc.1 规范清单必须只有固定官方核心依赖');
  const officialLock=await readFile(path.join(defaultRc1Runtime,'pnpm-lock.yaml'));
  if(sha(officialLock)!==lockHash||/(?:[\s'"](?:file|link|workspace):|\/Users\/)/.test(officialLock.toString()))throw Error('rc.1 规范锁文件变化或包含本机路径，请重新审核');
  let sourceReal;
  try {sourceReal=await realpath(source);await stat(path.join(sourceReal,'node_modules/@deepseek-ai/dsh/package.json'));}
  catch(error){if(error.code!=='ENOENT')throw error;throw Error('尚未安装官方 rc.1 依赖。请在 desktop-runtime/rc1 执行 pnpm install --frozen-lockfile，或用 --core-runtime 指定已安装的官方 rc.1 目录。');}
  if(target){const output=path.resolve(target);if(output===sourceReal||output.startsWith(sourceReal+path.sep)||sourceReal.startsWith(output+path.sep))throw Error('rc.1 输入与构建目标不得互相包含');}
  const manifest=JSON.parse(await readFile(path.join(sourceReal,'package.json'),'utf8'));
  if(JSON.stringify(manifest.dependencies)!==JSON.stringify(canonical.dependencies)||Object.keys(manifest.devDependencies??{}).length||Object.keys(manifest.optionalDependencies??{}).length)throw Error('rc.1 输入必须是单一官方依赖安装，不能使用个人 profile 或本机插件清单');
  for(const file of ['pnpm-lock.yaml','node_modules/.pnpm/lock.yaml'])if(sha(await readFile(path.join(sourceReal,file)))!==lockHash)throw Error('rc.1 已安装依赖锁文件与规范输入不一致：'+file);
  const core=JSON.parse(await readFile(path.join(sourceReal,'node_modules/@deepseek-ai/dsh/package.json'),'utf8'));
  if(core.name!=='@deepseek-ai/dsh'||core.version!==desktopCoreVersion)throw Error('拒绝旧核心或未知核心：要求 '+desktopCoreVersion);
  const {parse}=createRequire(path.join(sourceReal,'package.json'))('yaml');
  const lock=parse(officialLock.toString()),metadata=parse(await readFile(path.join(sourceReal,'node_modules/.modules.yaml'),'utf8'));
  if(!metadata.hoistedLocations||!lock.snapshots||lock.importers?.['.']?.dependencies?.['@deepseek-ai/dsh']?.specifier!==desktopCoreVersion)throw Error('需要已验证的 hoisted rc.1 安装布局');
  const packages=[],paths=new Set(),bins=new Map(),optionalUnavailable=[];
  for(const [snapshot,locations] of Object.entries(metadata.hoistedLocations)) {
    if(!Object.hasOwn(lock.snapshots,snapshot))throw Error('安装目录出现规范锁之外的依赖：'+snapshot);
    const identity=packageIdentity(snapshot);
    if(identity.name.startsWith('@deepseek-ai/dsh')&&identity.version!==desktopCoreVersion)throw Error('官方 SDK 混有旧版：'+identity.name);
    for(const relative of locations) {
      if(!safeRelative(relative)||paths.has(relative))throw Error('安装目录存在越界或重复路径：'+relative);
      paths.add(relative);
      const from=path.join(sourceReal,relative);
      let resolved;
      try {resolved=await realpath(from);}
      catch(error){if(error.code==='ENOENT'&&lock.snapshots[snapshot].optional===true){optionalUnavailable.push({name:identity.name,version:identity.version,relative});continue;}throw error;}
      if(!resolved.startsWith(sourceReal+path.sep))throw Error('官方依赖链接指向安装目录外：'+relative);
      const info=JSON.parse(await readFile(path.join(from,'package.json'),'utf8'));
      if(info.name!==identity.name||info.version!==identity.version)throw Error('安装依赖与锁文件版本不符：'+relative);
      packages.push({relative,...identity});
      const exports=typeof info.bin==='string'?{[identity.name.split('/').at(-1)]:info.bin}:info.bin??{};
      const moduleDirectory=relative.slice(0,relative.lastIndexOf('node_modules')+'node_modules'.length);
      for(const [name,value] of Object.entries(exports)) {
        if(!/^[\w.-]+$/.test(name)||typeof value!=='string'||path.isAbsolute(value)||value.split(/[\\/]/).includes('..'))throw Error('不安全的官方 bin 声明：'+identity.name);
        const bin=path.join(moduleDirectory,'.bin',name),destination=path.join(relative,value);
        if(bins.has(bin)&&bins.get(bin)!==destination)throw Error('官方 bin 名称冲突：'+bin);
        await stat(path.join(sourceReal,destination));bins.set(bin,destination);
      }
    }
  }
  for(const [file,exportName] of compatible) {
    const module=await import(pathToFileURL(path.join(root,'runtime/core-compat',file+'.mjs')).href);
    if(typeof module[exportName]!=='function')throw Error('缺少 rc.1 兼容入口：'+file+'/'+exportName);
  }
  return {source:sourceReal,version:desktopCoreVersion,lockSha256:lockHash,packages:packages.sort((a,b)=>a.relative.length-b.relative.length),bins:[...bins].map(([relative,destination])=>({relative,destination})),optionalUnavailable,ignoredUnlistedPackages:true};
}
/** Replace only official locked packages after the build has collected its existing custom programs. */
export async function prepareDesktopRc1({source=defaultRc1Runtime,target}) {
  if(!target)throw Error('rc.1 准备入口需要构建目标目录');
  target=path.resolve(target);
  if(path.basename(target)!=='runtime'||path.basename(path.dirname(target))!=='work'||target.startsWith('/Applications/')||target.startsWith(path.join(process.env.HOME??'','.dsh')+path.sep))throw Error('只允许准备隔离构建目录 work/runtime，不能覆盖安装目录或用户 profile');
  const plan=await preflightDesktopRc1(source,{target});
  if(await realpath(target)!==target)throw Error('构建目标不得通过链接指向其他目录');
  await stat(path.join(target,'node_modules/dsh-peer/package.json'));
  await rm(path.join(target,'node_modules/@deepseek-ai'),{recursive:true,force:true});
  for(const item of plan.packages) {
    const from=path.join(plan.source,item.relative),destination=path.join(target,item.relative);await rm(destination,{recursive:true,force:true});await mkdir(path.dirname(destination),{recursive:true});
    await cp(from,destination,{recursive:true,verbatimSymlinks:true,filter:file=>file!==path.join(from,'node_modules')&&path.basename(file)!=='.DS_Store'});
  }
  for(const bin of plan.bins) {
    const destination=path.join(target,bin.relative);await mkdir(path.dirname(destination),{recursive:true});await rm(destination,{force:true});await symlink(path.relative(path.dirname(destination),path.join(target,bin.destination)),destination);
  }
  await mkdir(path.join(target,'node_modules/.pnpm'),{recursive:true});await cp(path.join(defaultRc1Runtime,'pnpm-lock.yaml'),path.join(target,'node_modules/.pnpm/lock.yaml'));
  const receipts=[];
  for(const [file,exportName] of compatible) {
    const module=await import(pathToFileURL(path.join(root,'runtime/core-compat',file+'.mjs')).href);
    receipts.push({module:file,...await module[exportName](target)});
  }
  const receipt={version:desktopCoreVersion,lockSha256:lockHash,officialPackages:plan.packages.length,officialBins:plan.bins.length,optionalUnavailable:plan.optionalUnavailable,compatibility:receipts,oldAlpha4OverlaysApplied:false};
  await writeFile(path.join(target,'rc1-build-receipt.json'),JSON.stringify(receipt,null,2));return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const args=process.argv.slice(2);let source=defaultRc1Runtime,target,preflight=false;
  while(args.length){const flag=args.shift();if(flag==='--source'&&args[0])source=path.resolve(args.shift());else if(flag==='--target'&&args[0])target=path.resolve(args.shift());else if(flag==='--preflight')preflight=true;else throw Error('Usage: prepare-desktop-rc1.mjs [--source RUNTIME] [--target BUILD_RUNTIME] [--preflight]');}
  if(preflight){const plan=await preflightDesktopRc1(source,{target});console.log(JSON.stringify({version:plan.version,lockSha256:plan.lockSha256,officialPackages:plan.packages.length,officialBins:plan.bins.length,optionalUnavailable:plan.optionalUnavailable,readOnly:true}));}
  else console.log(JSON.stringify(await prepareDesktopRc1({source,target})));
}
