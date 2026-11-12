import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {FontLibrary,fontLocations} from './font-library.mjs';
import {AppearanceStore} from './store.mjs';

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'dsh-fonts-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const shared=path.join(root,'shared'),folder=path.join(shared,'中文 字体');await mkdir(folder,{recursive:true});
  const bytes=Buffer.concat([Buffer.from('00010000','hex'),Buffer.from('font-fixture')]);
  await writeFile(path.join(folder,'样张.ttf'),bytes);await writeFile(path.join(folder,'ignore.txt'),'x');
  return {root,shared,folder,bytes,library:new FontLibrary(root,[shared])};
}
test('browse, scan and persisted font references support Chinese and spaced directories',async t=>{
  const f=await fixture(t);assert.equal((await f.library.browse(f.shared)).folders[0].name,'中文 字体');
  const scanned=await f.library.scan(f.folder);assert.equal(scanned.fonts.length,1);const font=scanned.fonts[0];assert.equal(font.name,'样张.ttf');
  assert.deepEqual(await f.library.read(font.id),f.bytes);
  const reloaded=new FontLibrary(f.root,[f.shared]);assert.equal((await reloaded.status()).directory,await realpath(f.folder));assert.deepEqual(await reloaded.read(font.id),f.bytes);
  const store=new AppearanceStore(f.root);await store.init();await store.change({action:'configure',revision:0,options:{uiFont:'local:'+font.id,accent:'#497de2'}});
  const restored=new AppearanceStore(f.root);await restored.init();assert.equal(restored.status().options.uiFont,'local:'+font.id);
});
test('escaping directories, symbolic font links and oversized fonts are rejected',async t=>{
  const f=await fixture(t);await symlink(f.root,path.join(f.shared,'escape'));await symlink(path.join(f.folder,'样张.ttf'),path.join(f.folder,'link.ttf'));
  await assert.rejects(f.library.browse(path.join(f.shared,'escape')),/用户文件夹或系统字体目录/);
  const large=await import('node:fs/promises');const handle=await large.open(path.join(f.folder,'large.otf'),'w');await handle.truncate(33*1024*1024);await handle.close();
  assert.equal((await f.library.scan(f.folder)).fonts.length,1);
  await assert.rejects(f.library.read('../secret'),/重新扫描/);
});
test('macOS exposes user, installed and built-in font directories plus Downloads',()=>{
  const locations=fontLocations('darwin','/Users/test');
  assert.deepEqual(locations.roots,['/Users/test','/Library/Fonts','/System/Library/Fonts']);
  assert.deepEqual(locations.shortcuts.map(item=>item.path),['/Users/test/Library/Fonts','/Library/Fonts','/System/Library/Fonts','/Users/test/Downloads','/Users/test']);
  assert.equal(locations.shortcuts.some(item=>item.path.includes('/storage/')),false);
});
test('changed, invalid or missing font cannot replace a saved selection and scanning recovers',async t=>{
  const f=await fixture(t);const font=(await f.library.scan(f.folder)).fonts[0];const saved=await readFile(f.library.file);
  await writeFile(path.join(f.folder,'样张.ttf'),'invalid-font');await assert.rejects(f.library.read(font.id),/改变/);assert.deepEqual(await readFile(f.library.file),saved);
  const invalid=(await f.library.scan(f.folder)).fonts[0];await assert.rejects(f.library.read(invalid.id),/不是受支持/);
  await writeFile(path.join(f.folder,'样张.ttf'),f.bytes);const recovered=(await f.library.scan(f.folder)).fonts[0];assert.deepEqual(await f.library.read(recovered.id),f.bytes);
  await rm(path.join(f.folder,'样张.ttf'));await assert.rejects(f.library.read(recovered.id));assert.equal((await f.library.scan(f.folder)).fonts.length,0);
});
