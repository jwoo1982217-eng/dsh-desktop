import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readSelectiveBaseline,verifySelectiveBase,planSelectiveFeatures,previousProgramHashes} from './selective-inputs.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(root,'desktop/macos/tools/package.json'));
const {createPackage,extractFile}=require('@electron/asar');
const sha=b=>createHash('sha256').update(b).digest('hex');
const [output,features,profile=path.join(process.env.HOME,'.dsh/profiles/web'),base='/Applications/DSH.app']=process.argv.slice(2);
if(!output||!features||process.platform!=='darwin')throw Error('Usage: node build-selective.mjs TASK_GENERATED_OUT DESKTOP_FEATURES_SOURCE [PROFILE] [VERIFIED_0.1.8_APP]');
let marker;
for(let p=path.resolve(output);p!==path.dirname(p);p=path.dirname(p)){try{marker={dir:p,...JSON.parse(await fs.readFile(path.join(p,'.task-artifacts.json'),'utf8'))};break}catch(e){if(e.code!=='ENOENT')throw e}}
if(!marker||marker.status!=='open'||!path.resolve(output).startsWith(path.join(marker.dir,'generated')+path.sep))throw Error('Use the registered task generated directory');
await fs.mkdir(output,{recursive:true});
const baseline=await readSelectiveBaseline();
const previous=await verifySelectiveBase(base,{extractFile,baseline});
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',base],{stdio:'inherit'});
const payload=path.join(output,'payload'),app=path.join(payload,'DSH.app');
await fs.mkdir(payload,{recursive:true});
try{await fs.lstat(app);throw Error('Refuse overwriting an earlier build')}catch(e){if(e.code!=='ENOENT')throw e}
execFileSync('/bin/cp',['-cR',base,app]);
const resources=path.join(app,'Contents/Resources'),runtime=path.join(resources,'runtime');
const version=JSON.parse(await fs.readFile(path.join(root,'desktop/macos/app/package.json'),'utf8')).version;
const spec={format:1,owner:'dsh-go-selective-v1',version,files:[],links:[],corePatches:[]};
const peerFiles=['proxy.mjs','transport-proxy.mjs','tunnel.mjs','ws-message-bridge.mjs','android-lan-agent.mjs','quiet-session-bridge.mjs'];
async function put(relative,source,before){
  const bytes=await fs.readFile(source);const target=path.join(runtime,'program-update',relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);
  spec.files.push({path:relative,bytes:bytes.length,sha256:sha(bytes),before:[...new Set(before)]});
}
for(const name of peerFiles){
  const relative='node_modules/dsh-peer/'+name,before=previousProgramHashes(previous.spec,relative);
  const peerSource=await fs.readFile(path.join(root,'peer',name));
  if(sha(peerSource)!==previous.spec.files.find(row=>row.path===relative).sha256)throw Error('UI release must retain the existing peer: '+name);
  const source=path.join(root,'peer',name);await put('node_modules/dsh-peer/'+name,source,before);
  await fs.copyFile(source,path.join(runtime,'node_modules/dsh-peer',name));
}
const featureRows=[];
const featureInputs=JSON.parse(await fs.readFile(path.join(root,'desktop/macos/feature-program-files.json'),'utf8'));
for(const {row,before} of planSelectiveFeatures(featureInputs,baseline)){
  if(row.path.startsWith('/')||row.path.split('/').includes('..'))throw Error('Invalid feature source path');
  const file=path.join(features,row.path),bytes=await fs.readFile(file);
  if(bytes.length!==row.bytes||sha(bytes)!==row.sha256)throw Error('Frozen feature source changed: '+row.path);
  await put('node_modules/dsh-phone-features/'+row.path,file,before);
  const copy=path.join(runtime,'node_modules/dsh-phone-features',row.path);await fs.mkdir(path.dirname(copy),{recursive:true});await fs.writeFile(copy,bytes);
  featureRows.push(row);
}
const ownership=Buffer.from(JSON.stringify({owner:'dsh-phone-features-v1',version,files:featureRows})+'\n');
const ownedFile=path.join(output,'feature-ownership.json');await fs.writeFile(ownedFile,ownership);
await put('node_modules/dsh-phone-features/.dsh-feature-program.json',ownedFile,['missing',previous.markerSha256]);
await fs.writeFile(path.join(runtime,'node_modules/dsh-phone-features/.dsh-feature-program.json'),ownership);
for(const [entry,module] of [
 ['dsh-peer','@deepseek-ai/dsh-http-proxy'],
 ['dsh-phone-features','@deepseek-ai/dsh-session'],
 ['dsh-phone-features','@deepseek-ai/dsh'],
]){
  const relative='node_modules/'+entry+'/node_modules/'+module;
  // Freeze known release link predecessors; do not bless an arbitrary live link.
  const before=previous.spec.links.find(row=>row.path===relative&&row.module===module)?.before;
  if(!before)throw Error('Frozen SDK link predecessor missing');
  spec.links.push({path:relative,module,before});
  const link=path.join(runtime,relative),target=await fs.realpath(path.join(runtime,'node_modules',module));
  if(!target.startsWith(runtime+path.sep))throw Error('SDK link points outside runtime');
  await fs.mkdir(path.dirname(link),{recursive:true});await fs.rm(link,{force:true,recursive:true});await fs.symlink(path.relative(path.dirname(link),target),link);
}
// Preserve the two verified SDK patches currently used by this computer.
for(const relative of ['@deepseek-ai/dsh-client-ui-model-selection/lib/client.js','@deepseek-ai/dsh-compaction-basic/lib/summary-runner.mjs']){
  const source=path.join(root,'desktop-runtime/node_modules',relative),target=path.join(runtime,'node_modules',relative);
  const bytes=await fs.readFile(source),expected=baseline.runtimeFiles.find(row=>row.path==='node_modules/'+relative);
  if(!expected||bytes.length!==expected.bytes||sha(bytes)!==expected.sha256)throw Error('Verified SDK patch changed: '+relative);
  await fs.writeFile(target,bytes);spec.corePatches.push({path:relative,sha256:sha(bytes)});
}
await fs.writeFile(path.join(runtime,'program-update.json'),JSON.stringify(spec,null,2)+'\n');
const bundle=JSON.parse(await fs.readFile(path.join(runtime,'bundle.json'),'utf8'));bundle.version=version;
for(const list of [bundle.plugins,bundle.profile.dsh.profile.bundles])if(!list.includes('dsh-phone-features'))list.push('dsh-phone-features');
await fs.writeFile(path.join(runtime,'bundle.json'),JSON.stringify(bundle,null,2)+'\n');
await createPackage(path.join(root,'desktop/macos/app'),path.join(resources,'app.asar'));
const daemon=path.join(resources,'bin/desktop-host');await fs.mkdir(daemon,{recursive:true});
for(const file of ['daemon.mjs','backend.mjs','profile-migration.mjs','pocket-preserve.mjs','program-update.mjs','program-links.mjs','program-recovery.mjs'])await fs.copyFile(path.join(root,'desktop/macos/app',file),path.join(daemon,file));
execFileSync('/usr/bin/plutil',['-replace','CFBundleShortVersionString','-string',version,path.join(app,'Contents/Info.plist')]);
execFileSync('/usr/bin/plutil',['-replace','CFBundleVersion','-string','1.'+version.split('.').slice(1).join('.'),path.join(app,'Contents/Info.plist')]);
execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',app],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
const components=path.join(output,'components.plist');execFileSync('/usr/bin/pkgbuild',['--analyze','--root',payload,components]);
execFileSync('/usr/bin/plutil',['-replace','0.BundleIsRelocatable','-bool','NO',components]);
const pkg=path.join(output,`DSH-${version}-macOS-arm64.pkg`);
execFileSync('/usr/bin/pkgbuild',['--root',payload,'--component-plist',components,'--identifier','com.dsh.desktop','--version',version,'--install-location','/Applications','--ownership','recommended',pkg],{stdio:'inherit'});
const receipt={version,app,pkg,sha256:sha(await fs.readFile(pkg)),programFiles:spec.files.length,coreVersion:bundle.coreVersion,profileDataBundled:false,selective:true,signature:'ad-hoc'};
await fs.writeFile(path.join(output,'build-receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
