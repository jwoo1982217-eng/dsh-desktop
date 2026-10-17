import {readFile,writeFile,readdir,cp,rename,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {installDesktopAppearance} from './install-desktop-appearance.mjs';
// Fresh module URLs keep live ESM imports coherent without restarting the core.
export async function installDesktopAppearanceLive(profile,modules){
 const installed=await installDesktopAppearance(profile,modules,{writePatch:false}),hash=createHash('sha256');
 async function walk(base){for(const row of (await readdir(base,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(base,row.name);if(row.isDirectory())await walk(file);else if(row.isFile()){hash.update(path.relative(installed.plugin,file)+'\0');hash.update(await readFile(file));}}}
 await walk(installed.plugin);const revision=hash.digest('hex').slice(0,12),versioned=installed.plugin+'-live-'+revision;
 const stage=versioned+'.new-'+randomUUID();
 try{await cp(installed.plugin,stage,{recursive:true});await rename(stage,versioned);}catch(error){await rm(stage,{recursive:true,force:true});if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
 const patch=path.join(profile,'cordis.patch.yml'),original=await readFile(patch,'utf8');
 const begin='# BEGIN dsh-appearance-center',finish='# END dsh-appearance-center';
 const start=original.indexOf(begin),end=original.indexOf(finish,start);
 if(start>=0&&(end<start||original.indexOf(begin,start+begin.length)>=0))throw Error('外观安装标记存在冲突');
 // The pinned Loader keeps the existing fiber when only `name` changes.
 // A content-addressed entry ID disposes only the prior appearance scope.
 const next=begin+'\n- insert:\n    - id: appearance-center-live-'+revision+'\n      name: '+pathToFileURL(path.join(versioned,'index.mjs')).href+'\n'+finish;
 const nextPatch=start<0?original.trimEnd()+'\n'+next+'\n':original.slice(0,start)+next+original.slice(end+finish.length);
 const temporary=patch+'.appearance-'+randomUUID();
 if(await readFile(patch,'utf8')!==original)throw Error('Profile 同时被其他窗口修改，请重试');
 if(nextPatch!==original){await writeFile(temporary,nextPatch,{mode:0o600});await rename(temporary,patch);}
 return {...installed,plugin:versioned,revision};
}
