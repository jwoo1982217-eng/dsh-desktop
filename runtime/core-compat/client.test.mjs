import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, readdir, mkdtemp, rm, link, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {clientFiles, buildRc1ClientFile, applyRc1ClientCompatibility} from './client.mjs';

const output = process.env.DSH_RC1_CLIENT_TEST_OUTPUT;
if (!output || !path.isAbsolute(output)) throw Error('Set DSH_RC1_CLIENT_TEST_OUTPUT to a registered generated/ directory');
await mkdir(output,{recursive:true});
const directory = await mkdtemp(path.join(output,'unit-'));
after(() => rm(directory,{recursive:true,force:true}));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const store = process.env.DSH_PNPM_STORE ?? path.join(os.homedir(),'Library/pnpm/store/v10');
const originals = {};
for (const [kind,spec] of Object.entries(clientFiles)) {
  let index;
  for (const bucket of await readdir(path.join(store,'index'))) {
    if (!/^[a-f0-9]{2}$/.test(bucket)) continue;
    const file = (await readdir(path.join(store,'index',bucket))).find(name=>name.endsWith('-@deepseek-ai+'+spec.name+'@0.2.2-rc.1.json'));
    if (file) {index=JSON.parse(await readFile(path.join(store,'index',bucket,file)));break;}
  }
  assert(index, 'Published rc.1 cache index missing for '+spec.name);
  const integrity = index.files['lib/client.js'].integrity;
  const sha = Buffer.from(integrity.slice('sha512-'.length),'base64').toString('hex');
  const file = path.join(store,'files',sha.slice(0,2),sha.slice(2));
  const bytes = await readFile(file);
  assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),integrity);
  assert.equal(hash(bytes),spec.before);
  originals[kind]={file,bytes,text:bytes.toString()};
}
async function fixture(name) {
  const runtime=path.join(directory,name),modules=path.join(runtime,'node_modules/@deepseek-ai');
  await mkdir(path.join(modules,'dsh'),{recursive:true});await writeFile(path.join(modules,'dsh/package.json'),JSON.stringify({version:'0.2.2-rc.1'}));
  for(const [kind,spec] of Object.entries(clientFiles)) {
    const base=path.join(modules,spec.name);await mkdir(path.join(base,'lib'),{recursive:true});
    await writeFile(path.join(base,'package.json'),JSON.stringify({version:'0.2.2-rc.1'}));
    await link(originals[kind].file,path.join(base,'lib/client.js'));
  }
  return {runtime,file:kind=>path.join(modules,clientFiles[kind].name,'lib/client.js')};
}
test('published rc.1 bytes migrate once, stay repeatable, and preserve pnpm store inodes',async()=>{
  const f=await fixture('normal');
  const inode=(await stat(f.file('conversation'))).ino;
  assert.equal((await applyRc1ClientCompatibility(f.runtime)).changed,4);
  assert.equal((await applyRc1ClientCompatibility(f.runtime)).changed,0);
  assert.notEqual((await stat(f.file('conversation'))).ino,inode);
  for(const [kind,spec] of Object.entries(clientFiles)) {
    assert.equal(hash(await readFile(f.file(kind))),spec.after);
    assert.equal(hash(await readFile(originals[kind].file)),spec.before);
    const text=await readFile(f.file(kind),'utf8');new vm.Script(text);
  }
});
test('preflight rejects an unknown last file without modifying earlier pristine files',async()=>{
  const f=await fixture('unknown');
  // Detach the hard link before tampering so the cache remains an immutable input.
  await rm(f.file('tools'));await writeFile(f.file('tools'),originals.tools.text+'\n// foreign change\n');
  await assert.rejects(applyRc1ClientCompatibility(f.runtime),/未知改动/);
  for(const kind of ['conversation','picker','models'])assert.equal(hash(await readFile(f.file(kind))),clientFiles[kind].before);
});
test('a real atomic-rename failure restores an earlier written file', {skip:process.platform !== 'darwin'}, async()=>{
  const f=await fixture('rollback'), run=promisify(execFile);
  // Detach before setting any filesystem metadata; the pnpm cache inode is protected.
  await rm(f.file('picker'));await writeFile(f.file('picker'),originals.picker.bytes);
  await run('/usr/bin/chflags',['uchg',f.file('picker')]);
  try {
    await assert.rejects(applyRc1ClientCompatibility(f.runtime),/EPERM|operation not permitted/i);
    for(const [kind,spec] of Object.entries(clientFiles))assert.equal(hash(await readFile(f.file(kind))),spec.before);
  } finally {await run('/usr/bin/chflags',['nouchg',f.file('picker')]);}
});
test('version mismatch and modified custom output fail closed; a restored file can resume',async()=>{
  const f=await fixture('resume');await applyRc1ClientCompatibility(f.runtime);
  await writeFile(f.file('models'),await readFile(f.file('models'),'utf8')+'\n// foreign custom change\n');
  await assert.rejects(applyRc1ClientCompatibility(f.runtime),/未知改动/);
  await writeFile(f.file('models'),originals.models.bytes);
  assert.equal((await applyRc1ClientCompatibility(f.runtime)).changed,1);
  await writeFile(path.join(f.runtime,'node_modules/@deepseek-ai/dsh/package.json'),'{}');
  await assert.rejects(applyRc1ClientCompatibility(f.runtime),/只适用于/);
});
function region(text,start,end='\t\t//#endregion') {
  const at=text.indexOf(start),to=text.indexOf(end,at+start.length);assert(at>=0&&to>at);return text.slice(at,to);
}
test('rc.1 native model ordering, editor drag/reorder, input capability limits and tool rows survive',async()=>{
  const picker=await buildRc1ClientFile('picker',originals.picker.bytes);
  const start='\t\t//#region lib/types/client/ModelSelect.js',end='\t\t//#region lib/types/client/locales.js';
  assert.equal(picker.replace(region(picker,start,end),''),originals.picker.text.replace(region(originals.picker.text,start,end),''));
  const models=await buildRc1ClientFile('models',originals.models.bytes);
  for(const marker of ['lib/types/client/ModelInputTypes.js','lib/types/client/useModelRows.js']) {
    const start='\t\t//#region '+marker;
    assert.equal(region(models,start),region(originals.models.text,start));
  }
  assert.match(models,/candidateById/);assert.match(models,/refreshDiscoveredModel\(model, candidate\)/);
  const tools=await buildRc1ClientFile('tools',originals.tools.bytes);
  assert.equal(tools.replace(/\/\/ DSH CODE PROGRESS BEGIN[\s\S]*?\/\/ DSH CODE PROGRESS END\n/,'').replaceAll('}, DshProgressBashRow))','}, BashRow))').replaceAll('}, DshProgressFileRow);','}, FileMutationRow);'),originals.tools.text);
});
