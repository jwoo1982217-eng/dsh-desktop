import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {installDesktopAppearance} from './install-desktop-appearance.mjs';
import {installDesktopAppearanceLive} from './install-desktop-appearance-live.mjs';
test('add only the appearance plugin, preserve all profile selections; reinstall and SDK rejection recover',async()=>{
 const work=await mkdtemp(path.join(os.tmpdir(),'appearance-install-')),profile=path.join(work,'profile'),modules=path.join(work,'modules');
 try{await mkdir(profile);await mkdir(path.join(modules,'@deepseek-ai/dsh'),{recursive:true});
 const original={private:true,dependencies:{other:'1.0'},dsh:{profile:{bundles:['other']}}};await writeFile(path.join(profile,'package.json'),JSON.stringify(original));
 const patch='# user-owned config\n- id: existing\n  disabled: false\n';await writeFile(path.join(profile,'cordis.patch.yml'),patch);
 const core=path.join(modules,'@deepseek-ai/dsh/package.json');await writeFile(core,'{"version":"0.2.1-alpha.4"}');
 await installDesktopAppearance(profile,modules);const result=JSON.parse(await readFile(path.join(profile,'package.json')));assert.deepEqual(result.dsh,original.dsh);assert.equal(result.dependencies.other,'1.0');
 await installDesktopAppearance(profile,modules);const installedPatch=await readFile(path.join(profile,'cordis.patch.yml'),'utf8');assert(installedPatch.startsWith(patch.trimEnd()));assert.equal(installedPatch.split('# BEGIN dsh-appearance-center').length,2);
 const saved=await readFile(path.join(profile,'node_modules/dsh-appearance-center/client.js'),'utf8');await writeFile(core,'{"version":"0.1.0"}');await assert.rejects(installDesktopAppearance(profile,modules),/SDK/);assert.equal(await readFile(path.join(profile,'node_modules/dsh-appearance-center/client.js'),'utf8'),saved);assert.equal(await readFile(path.join(profile,'cordis.patch.yml'),'utf8'),installedPatch);
 }finally{await rm(work,{recursive:true});}
});
test('live installation uses one content-addressed scope and preserves unrelated profile rows',async()=>{
 const work=await mkdtemp(path.join(os.tmpdir(),'appearance-live-')),profile=path.join(work,'profile'),modules=path.join(work,'modules');
 try{
  await mkdir(profile);await mkdir(path.join(modules,'@deepseek-ai/dsh'),{recursive:true});
  await writeFile(path.join(modules,'@deepseek-ai/dsh/package.json'),' {"version":"0.2.1-alpha.4"}');
  const original={dependencies:{other:'1.0'},dsh:{profile:{bundles:['other']}}};
  await writeFile(path.join(profile,'package.json'),JSON.stringify(original));
  const user='# user-owned config\n- id: existing\n  disabled: false\n';
  await writeFile(path.join(profile,'cordis.patch.yml'),user+'# BEGIN dsh-appearance-center\n- insert:\n    - id: appearance-center\n      name: dsh-appearance-center\n# END dsh-appearance-center\n');
  const first=await installDesktopAppearanceLive(profile,modules),patch=await readFile(path.join(profile,'cordis.patch.yml'),'utf8');
  assert(patch.startsWith(user));assert(patch.includes('id: appearance-center-live-'+first.revision));assert(!patch.includes('id: appearance-center\n'));
  const again=await installDesktopAppearanceLive(profile,modules);assert.equal(again.revision,first.revision);assert.equal(await readFile(path.join(profile,'cordis.patch.yml'),'utf8'),patch);
  assert.deepEqual(JSON.parse(await readFile(path.join(profile,'package.json'))).dsh,original.dsh);
  assert.equal(await readFile(path.join(first.plugin,'index.mjs'),'utf8'),await readFile(new URL('../appearance/index.mjs',import.meta.url),'utf8'));
 }finally{await rm(work,{recursive:true});}
});
