import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(path.join(root,'desktop/macos/tools/package.json'));
const {createPackage,extractAll,getRawHeader}=require('@electron/asar');
const sha=b=>createHash('sha256').update(b).digest('hex');
const [output,base='/Applications/DSH.app']=process.argv.slice(2);
if(!output||process.platform!=='darwin')throw Error('Usage: node build-kb-retention.mjs REGISTERED_TASK/generated/mac [VERIFIED_0.1.9_APP]');
let task;
for(let p=path.resolve(output);p!==path.dirname(p);p=path.dirname(p))try{task={dir:p,...JSON.parse(await fs.readFile(path.join(p,'.task-artifacts.json'),'utf8'))};break}catch(e){if(e.code!=='ENOENT')throw e;}
if(!task||task.status!=='open'||!path.resolve(output).startsWith(path.join(task.dir,'generated')+path.sep))throw Error('Use an open registered task generated directory');
const spec=JSON.parse(await fs.readFile(new URL('./kb-retention-release.json',import.meta.url),'utf8'));
const recoveryPatch=raw=>{
 if(sha(raw)!==spec.baseProgramRecoverySha256)throw Error('Verified program recovery module changed');
 const source=raw.toString('utf8'),anchor='\nconst digest=bytes=>';
 if(source.split(anchor).length!==2)throw Error('Program recovery patch anchor changed');
 const owned=spec.files.map(row=>'node_modules/dsh-peer/knowledge-link/'+row.path);
 return source.replace(anchor,'\nfor(const file of '+JSON.stringify(owned)+')peer.add(file);'+anchor);
};
const resources=path.join(base,'Contents/Resources'),oldRuntime=path.join(resources,'runtime');
for(const [file,digest]of [['app.asar',spec.baseAsarSha256],['runtime/program-update.json',spec.baseProgramUpdateSha256],['runtime/bundle.json',spec.baseBundleSha256]])if(sha(await fs.readFile(path.join(resources,file)))!==digest)throw Error('Verified application baseline changed: '+file);
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',base],{stdio:'inherit'});
await fs.mkdir(output,{recursive:true});const payload=path.join(output,'payload'),app=path.join(payload,'DSH.app');
await fs.mkdir(payload,{recursive:true});try{await fs.lstat(app);throw Error('Refuse an existing stage')}catch(e){if(e.code!=='ENOENT')throw e;}
execFileSync('/bin/cp',['-cR',base,app]);
const newResources=path.join(app,'Contents/Resources'),runtime=path.join(newResources,'runtime');
const recoveryFile=path.join(newResources,'bin/desktop-host/program-recovery.mjs');
await fs.writeFile(recoveryFile,recoveryPatch(await fs.readFile(recoveryFile)));
const program=JSON.parse(await fs.readFile(path.join(oldRuntime,'program-update.json'),'utf8'));program.version=spec.version;
// This release owns only the KB repair. Keep all other installed custom
// programs even if their independent upgrade is declined or has local edits.
program.files=[];
for(const row of spec.files){
 const relative='node_modules/dsh-peer/knowledge-link/'+row.path,data=await fs.readFile(path.join(root,'peer/knowledge-link',row.path));
 if(data.length!==row.bytes||sha(data)!==row.sha256)throw Error('Frozen KB source changed: '+row.path);
 if(program.files.some(x=>x.path===relative))throw Error('Unexpected existing KB upgrade entry');
 const before=path.join(oldRuntime,relative);let digest='missing';try{digest=sha(await fs.readFile(before));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(digest!==row.before)throw Error('Application KB predecessor changed');
 for(const prefix of ['', 'program-update/']){const file=path.join(runtime,prefix,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);}
 program.files.push({path:relative,bytes:data.length,sha256:row.sha256,before:[row.before]});
}
await fs.writeFile(path.join(runtime,'program-update.json'),JSON.stringify(program,null,2)+'\n');
const bundle=JSON.parse(await fs.readFile(path.join(runtime,'bundle.json'),'utf8'));if(bundle.version!==spec.baseVersion)throw Error('Unexpected application version');bundle.version=spec.version;await fs.writeFile(path.join(runtime,'bundle.json'),JSON.stringify(bundle,null,2)+'\n');
const unpacked=path.join(output,'asar-work');extractAll(path.join(newResources,'app.asar'),unpacked);
const asarRecovery=path.join(unpacked,'program-recovery.mjs');await fs.writeFile(asarRecovery,recoveryPatch(await fs.readFile(asarRecovery)));
const manifest=JSON.parse(await fs.readFile(path.join(unpacked,'package.json'),'utf8'));if(manifest.version!==spec.baseVersion)throw Error('Unexpected asar version');manifest.version=spec.version;await fs.writeFile(path.join(unpacked,'package.json'),JSON.stringify(manifest,null,2)+'\n');await createPackage(unpacked,path.join(newResources,'app.asar'));
execFileSync('/usr/bin/plutil',['-replace','CFBundleShortVersionString','-string',spec.version,path.join(app,'Contents/Info.plist')]);
execFileSync('/usr/bin/plutil',['-replace','CFBundleVersion','-string','1.1.10',path.join(app,'Contents/Info.plist')]);
execFileSync('/usr/bin/plutil',['-replace','ElectronAsarIntegrity','-json',JSON.stringify({'Resources/app.asar':{algorithm:'SHA256',hash:sha(getRawHeader(path.join(newResources,'app.asar')).headerString)}}),path.join(app,'Contents/Info.plist')]);
execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',app],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
const components=path.join(output,'components.plist');execFileSync('/usr/bin/pkgbuild',['--analyze','--root',payload,components]);execFileSync('/usr/bin/plutil',['-replace','0.BundleIsRelocatable','-bool','NO',components]);
const pkg=path.join(output,`DSH-${spec.version}-知识库索引自动回收-macOS-arm64.pkg`);
execFileSync('/usr/bin/pkgbuild',['--root',payload,'--component-plist',components,'--identifier','com.dsh.desktop','--version',spec.version,'--install-location','/Applications','--ownership','recommended',pkg],{stdio:'inherit'});
const receipt={version:spec.version,app,pkg,sha256:sha(await fs.readFile(pkg)),bytes:(await fs.stat(pkg)).size,kbFiles:spec.files.length,programFiles:program.files.length,coreVersion:bundle.coreVersion,baseAsarSha256:spec.baseAsarSha256,signature:'ad-hoc',privateProfileBundled:false};await fs.writeFile(path.join(output,'build-receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
