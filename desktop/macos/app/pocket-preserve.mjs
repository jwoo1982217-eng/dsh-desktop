import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';

/** A profile-owned update survives app initialization; newer bundled versions may supersede it. */
export async function preservePocket(home,profile,modules,manifest){
  try{
    const target=await realpath(path.join(profile,'node_modules/dsh-pocket'));
    const root=await realpath(path.join(home,'dsh-pocket/updates'));
    if(!target.startsWith(root+path.sep))return false;
    const spec=manifest.dependencies?.['dsh-pocket'];
    if(typeof spec!=='string'||!spec.startsWith('file:')||await realpath(path.resolve(profile,spec.slice(5)))!==target)return false;
    const pkg=JSON.parse(await readFile(path.join(target,'package.json')));
    const mark=JSON.parse(await readFile(path.join(target,'desktop-update.json')));
    const bundled=JSON.parse(await readFile(path.join(modules,'dsh-pocket/package.json')));
    if(pkg.name!=='dsh-pocket'||mark.version!==1||mark.packageVersion!==pkg.version)return false;
    if(!/^\d+\.\d+\.\d+$/.test(pkg.version)||!/^\d+\.\d+\.\d+$/.test(bundled.version))return false;
    const a=pkg.version.split('.').map(Number),b=bundled.version.split('.').map(Number);
    for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
    return true;
  }catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return false;throw error;}
}
