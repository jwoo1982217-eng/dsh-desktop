import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const selectiveHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const UI_UPGRADE_FILES=Object.freeze({
  'web-capabilities.mjs':'3eb8da27780499a81901165fdd62de20a4c72a2269dd48a0da66b8180bc1c026',
  'settings/workbench-client.js':'050d77e19d6e38b5405471ee03332ba09c635966252ba5e48ef051ac6c3087a2',
  'conversation/client.js':'fbce55b1fb8774ccc76ca077ce0dbe104d39468fd8bbf00386331a70fb2b4c01',
});
const safe=p=>typeof p==='string'&&!p.startsWith('/')&&!p.includes('\\')&&p.split('/').every(x=>x&&x!=='.'&&x!=='..');
const check=(condition,message)=>{if(!condition)throw Error(message);};

export async function readSelectiveBaseline(){return JSON.parse(await fs.readFile(new URL('./baselines/0.1.8.json',import.meta.url),'utf8'));}

/** Read only application program files, never the running profile or private data. */
export async function verifySelectiveBase(base,{extractFile,baseline}={}){
  baseline??=await readSelectiveBaseline();
  const resources=path.join(base,'Contents/Resources'),runtime=path.join(resources,'runtime');
  const asar=await fs.readFile(path.join(resources,'app.asar'));
  check(asar.length===baseline.asar.bytes&&selectiveHash(asar)===baseline.asar.sha256,'Verified 0.1.8 application baseline changed');
  check(JSON.parse(extractFile(path.join(resources,'app.asar'),'package.json')).version===baseline.appVersion,'Use the verified 0.1.8 application baseline');
  const data=new Map();
  for(const row of baseline.runtimeFiles){
    check(safe(row.path),'Invalid baseline path');
    const bytes=await fs.readFile(path.join(runtime,row.path));
    check(bytes.length===row.bytes&&selectiveHash(bytes)===row.sha256,'Frozen application program changed: '+row.path);
    data.set(row.path,bytes);
  }
  const bundle=JSON.parse(data.get('bundle.json'));
  check(bundle.coreVersion===baseline.coreVersion&&JSON.parse(data.get('node_modules/@deepseek-ai/dsh/package.json')).version===baseline.coreVersion,'Frozen SDK version changed');
  const owner=JSON.parse(data.get('node_modules/dsh-phone-features/.dsh-feature-program.json'));
  check(JSON.stringify(owner)===JSON.stringify(baseline.featureOwnership)&&owner.files.length===baseline.featureFileCount,'Frozen feature ownership changed');
  for(const row of owner.files){
    check(safe(row.path),'Invalid feature baseline path');
    const bytes=await fs.readFile(path.join(runtime,'node_modules/dsh-phone-features',row.path));
    check(bytes.length===row.bytes&&selectiveHash(bytes)===row.sha256,'Frozen application feature changed: '+row.path);
  }
  return {runtime,bundle,owner,spec:JSON.parse(data.get('program-update.json')),markerSha256:selectiveHash(data.get('node_modules/dsh-phone-features/.dsh-feature-program.json'))};
}

/** Exactly three changes inside the existing 87-file closure. No phone-only wrapper. */
export function planSelectiveFeatures(inputs,baseline,{changes=UI_UPGRADE_FILES}={}){
  check(inputs?.format===1&&inputs.package==='dsh-phone-features'&&Array.isArray(inputs.files),'Invalid feature manifest');
  const previous=baseline.featureOwnership.files;
  check(inputs.files.length===baseline.featureFileCount&&previous.length===inputs.files.length,'Feature closure changed');
  const old=new Map(previous.map(row=>[row.path,row])),seen=new Set(),changed=[];
  const plans=inputs.files.map(row=>{
    check(safe(row.path)&&!seen.has(row.path)&&old.has(row.path),'Feature closure path changed');seen.add(row.path);
    const before=old.get(row.path);
    if(row.sha256!==before.sha256||row.bytes!==before.bytes){check(changes[row.path]===row.sha256,'Unapproved feature change: '+row.path);changed.push(row.path);}
    return {row,before:['missing',before.sha256]};
  });
  check(changed.length===Object.keys(changes).length&&Object.keys(changes).every(name=>changed.includes(name)),'Expected UI upgrade files missing');
  return plans;
}

export function previousProgramHashes(spec,relative){
  const row=spec.files.find(x=>x.path===relative);
  check(row&&Array.isArray(row.before),'Program predecessor missing: '+relative);
  return [...new Set([...row.before,row.sha256])];
}
