import { homedir as __publicHomedir, tmpdir as __publicTmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync,openSync,closeSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createFaststartKit} from './faststart.js';
import {applyPatch,rollbackPatch,planPatch,loadPatch} from './install.mjs';

const sourceRoot=path.dirname(fileURLToPath(import.meta.url));
const generated=process.env.DSH_WALLPAPER_PATCH_TEST_DIR??(process.platform==='darwin'?(__publicTmpdir() + '/dsh-go-capability-absorption-20261031/generated/wallpaper-prewarm-tests'):path.join(os.tmpdir(),'dsh-wallpaper-prewarm-tests'));
const ownerPlugin=process.env.DSH_WALLPAPER_PLUGIN??(__publicHomedir() + '/.dsh/plugins/dsh-plugin-wallpaper-engine');
const {getMediaInfo}=await import(pathToFileURL(path.join(ownerPlugin,'lib/media-probe.js')).href);
const {createMp4VfsKit}=await import(pathToFileURL(path.join(ownerPlugin,'lib/mp4-vfs.js')).href);
async function fixture(t){await fs.mkdir(generated,{recursive:true});const dir=await fs.mkdtemp(path.join(generated,'case-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function pluginAt(base,name){const root=path.join(base,name);await fs.mkdir(path.join(root,'lib'),{recursive:true});await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'dsh-plugin-wallpaper-engine',version:'1.3.3',type:'module'}));await fs.copyFile(path.join(sourceRoot,'fixtures/faststart-before.txt'),path.join(root,'lib/faststart.js'));return root;}
function warmKit(factory,dir,layoutFor,items){return factory({layoutFor,cacheBaseDir:()=>dir,legacyCacheBaseDir:()=>'',readConfig:()=>({settings:{rotationGroups:[]}}),mediaMap:new Map(items)});}
const wallpaper=token=>({id:token,type:'video',media:'/wallpaper-engine/media/'+token});

test('real MP4 regular file still prewarms through the original MP4 parser/layout API',async t=>{
  const dir=await fixture(t),video=path.join(dir,'ordinary.mp4');await fs.copyFile(path.join(sourceRoot,'fixtures/ordinary.mp4'),video);
  const header=readFileSync(video);assert.equal(header.toString('ascii',4,8),'ftyp');
  const actual=getMediaInfo(video);assert.equal(actual.width,16);assert.equal(actual.height,16);assert.equal(actual.codec,'avc1');assert.equal(actual.duration,1);
  const layout=createMp4VfsKit({});let calls=0;
  const kit=warmKit(createFaststartKit,dir,abs=>{calls++;return layout.layoutFor(abs);},[['regular',video]]);
  await kit.warmFaststartFavorites([wallpaper('regular')]);assert.equal(calls,1);
  // Explicit APIs retain their original behavior and signature.
  kit.faststartVariant(video);assert.equal(calls,2);kit.pinnedFaststartVariant(video,'direct');assert.equal(calls,3);
});
test('dangling, restricted-target and readable aliases/non-regular files are never opened by optional warmup',async t=>{
  const dir=await fixture(t),ordinary=path.join(dir,'ordinary.mp4'),restricted=path.join(dir,'restricted.mp4');
  await fs.copyFile(path.join(sourceRoot,'fixtures/ordinary.mp4'),ordinary);await fs.copyFile(ordinary,restricted);await fs.chmod(restricted,0);t.after(()=>fs.chmod(restricted,0o600).catch(()=>{}));
  const items=[['dangling',path.join(dir,'dangling.mp4')],['restricted-link',path.join(dir,'restricted-link.mp4')],['readable-link',path.join(dir,'readable-link.mp4')],['missing',path.join(dir,'missing.mp4')],['directory',path.join(dir,'directory.mp4')]];
  await fs.symlink(path.join(dir,'absent-target.mp4'),items[0][1]);await fs.symlink(restricted,items[1][1]);await fs.symlink(ordinary,items[2][1]);await fs.mkdir(items[4][1]);
  if(process.platform!=='win32'){const fifo=path.join(dir,'fifo.mp4');assert.equal(spawnSync('mkfifo',[fifo]).status,0);items.push(['fifo',fifo]);}
  let opens=0;const kit=warmKit(createFaststartKit,dir,abs=>{opens++;const fd=openSync(abs,'r');closeSync(fd);return {kind:'plain'};},items);
  await kit.warmFaststartFavorites(items.map(([token])=>wallpaper(token)));assert.equal(opens,0);
});
test('the old production function attempts an alias while the candidate skips it; ordinary errors do not stop later valid media',async t=>{
  const dir=await fixture(t),alias=path.join(dir,'alias.mp4'),ordinary=path.join(dir,'ordinary.mp4');await fs.symlink(path.join(dir,'missing-target.mp4'),alias);await fs.copyFile(path.join(sourceRoot,'fixtures/ordinary.mp4'),ordinary);
  const oldSource=await fs.readFile(path.join(sourceRoot,'fixtures/faststart-before.txt'),'utf8'),old=await import('data:text/javascript;base64,'+Buffer.from(oldSource).toString('base64'));
  let oldCalls=0;await warmKit(old.createFaststartKit,dir,()=>{oldCalls++;return {kind:'plain'};},[['alias',alias]]).warmFaststartFavorites([wallpaper('alias')]);assert.equal(oldCalls,1);
  const seen=[];await warmKit(createFaststartKit,dir,abs=>{seen.push(abs);if(abs===ordinary)throw Object.assign(Error('fixture'),{code:'EIO'});return {kind:'plain'};},[['alias',alias],['first',ordinary],['second',ordinary]]).warmFaststartFavorites([wallpaper('alias'),wallpaper('first'),wallpaper('second')]);assert.deepEqual(seen,[ordinary,ordinary]);
});
test('two hard-linked target paths install with guarded publication, remain idempotent and roll back exact bytes',async t=>{
  const dir=await fixture(t),a=await pluginAt(dir,'canonical'),b=await pluginAt(dir,'active'),backupDir=path.join(dir,'backup');const {before,after}=await loadPatch();
  await fs.rm(path.join(b,'lib/faststart.js'));await fs.link(path.join(a,'lib/faststart.js'),path.join(b,'lib/faststart.js'));
  assert.equal((await fs.stat(path.join(a,'lib/faststart.js'))).ino,(await fs.stat(path.join(b,'lib/faststart.js'))).ino);
  assert.equal((await planPatch([a,b])).changed,true);await applyPatch({targets:[a,b],backupDir});
  for(const root of [a,b])assert.deepEqual(await fs.readFile(path.join(root,'lib/faststart.js')),after);
  assert.equal((await fs.stat(path.join(backupDir,'receipt.json'))).mode&0o777,0o600);
  assert.equal((await applyPatch({targets:[a,b],backupDir:path.join(dir,'unused')})).changed,false);await assert.rejects(fs.stat(path.join(dir,'unused')),{code:'ENOENT'});
  await rollbackPatch(backupDir);for(const root of [a,b])assert.deepEqual(await fs.readFile(path.join(root,'lib/faststart.js')),before);
  assert.deepEqual(await fs.readFile(path.join(backupDir,'before-0.bin')),before);
});
test('unknown before bytes reject before mutation; injected publish failure restores both files',async t=>{
  const dir=await fixture(t),a=await pluginAt(dir,'a'),b=await pluginAt(dir,'b'),{before}=await loadPatch(),file=path.join(a,'lib/faststart.js');await fs.appendFile(file,'\n// unrelated WIP\n');
  await assert.rejects(applyPatch({targets:[a,b],backupDir:path.join(dir,'not-created')}),{code:'PATCH_UNKNOWN_TARGET_BYTES'});await assert.rejects(fs.stat(path.join(dir,'not-created')),{code:'ENOENT'});assert.ok((await fs.readFile(file,'utf8')).includes('unrelated WIP'));
  await fs.writeFile(file,before);const backupDir=path.join(dir,'failed');await assert.rejects(applyPatch({targets:[a,b],backupDir,checkpoint:()=>{throw Error('fixture publish failure');}}),/fixture publish failure/);
  for(const root of [a,b])assert.deepEqual(await fs.readFile(path.join(root,'lib/faststart.js')),before);
});
test('rollback preflights every SHA, refuses concurrent edits or damaged recovery bytes, and can recover after restoring known state',async t=>{
  const dir=await fixture(t),a=await pluginAt(dir,'a'),b=await pluginAt(dir,'b'),backupDir=path.join(dir,'backup'),{before,after}=await loadPatch();await applyPatch({targets:[a,b],backupDir});
  await fs.writeFile(path.join(b,'lib/faststart.js'),'concurrent user content');await assert.rejects(rollbackPatch(backupDir),{code:'PATCH_CONCURRENT_TARGET_CHANGE'});assert.deepEqual(await fs.readFile(path.join(a,'lib/faststart.js')),after);
  await fs.writeFile(path.join(b,'lib/faststart.js'),after);await fs.writeFile(path.join(backupDir,'before-0.bin'),'damaged');await assert.rejects(rollbackPatch(backupDir),{code:'PATCH_BACKUP_HASH_MISMATCH'});assert.deepEqual(await fs.readFile(path.join(b,'lib/faststart.js')),after);
  await fs.writeFile(path.join(backupDir,'before-0.bin'),before);await rollbackPatch(backupDir);for(const root of [a,b])assert.deepEqual(await fs.readFile(path.join(root,'lib/faststart.js')),before);
});
