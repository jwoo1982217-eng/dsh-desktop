import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {config}=require('./kb/lib/config.cjs');
const {build,current,rollback,acquireCurrent}=require('./kb/lib/store.cjs');
const {collect}=require('./kb/lib/retention.cjs');
const {search}=require('./kb/lib/search.cjs');
const {lock}=require('./kb/lib/util.cjs');
const embed=async texts=>texts.map(()=>[1,0]);
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kb-retention-')),docs=path.join(root,'docs'),dataDir=path.join(root,'index'),file=path.join(root,'config.json');
  fs.mkdirSync(docs);fs.writeFileSync(file,JSON.stringify({sources:[{name:'notes',path:docs}],sessionsRoots:[],dataDir,shardSize:1}));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const name of ['a','b','c'])fs.writeFileSync(path.join(docs,name+'.md'),name+' 保留知识库资料');
  return {root,docs,file,c:config({config:file}),async update(text){fs.writeFileSync(path.join(docs,'c.md'),text);return build(this.c,undefined,embed);}};
}
const ids=f=>fs.readdirSync(path.join(f.c.dataDir,'generations')).filter(x=>!x.startsWith('.'));
const age=f=>{for(const id of ids(f))fs.utimesSync(path.join(f.c.dataDir,'generations',id),new Date(0),new Date(0));for(const key of fs.readdirSync(path.join(f.c.dataDir,'cache')))fs.utimesSync(path.join(f.c.dataDir,'cache',key),new Date(0),new Date(0));};
test('重复更新自动回收旧代和失效缓存，保留两代与原始资料；无变化也回收',async t=>{
  const f=fixture(t);await build(f.c,undefined,embed);
  for(let i=0;i<5;i++){age(f);await f.update('版本 '+i);}
  assert.equal(ids(f).length,2);assert.equal(fs.readdirSync(path.join(f.c.dataDir,'cache')).length,4);
  const before=current(f.c).id;age(f);
  const r=await build(f.c,undefined,()=>{throw Error('不应计算向量');});
  assert.equal(r.noOp,true);assert.equal(r.id,before);assert.equal(r.embedded,0);
  assert.equal((await search(f.c,'版本 4',{lexical:true}))[0].text,'版本 4');
  assert.equal(fs.readFileSync(path.join(f.docs,'a.md'),'utf8'),'a 保留知识库资料');
});
test('未变分片按系统能力共享或回退写入；回退和再更新均可读',async t=>{
  const f=fixture(t),first=await build(f.c,undefined,embed),second=await f.update('变化后的知识');
  const p=id=>path.join(f.c.dataDir,'generations',id);
  const probe=path.join(f.root,'hardlink-probe');let supported=true;
  try{fs.linkSync(p(first.id)+'/shard-0000.bin',probe);}catch(e){assert.ok(['EXDEV','EPERM','EACCES','ENOTSUP','EMLINK'].includes(e.code));supported=false;}finally{fs.rmSync(probe,{force:true});}
  for(const suffix of ['bin','jsonl']){
    const a=p(first.id)+'/shard-0000.'+suffix,b=p(second.id)+'/shard-0000.'+suffix;
    assert.deepEqual(fs.readFileSync(a),fs.readFileSync(b));
    if(supported)assert.equal(fs.statSync(a).ino,fs.statSync(b).ino);else assert.notEqual(fs.statSync(a).ino,fs.statSync(b).ino);
  }
  assert.notEqual(fs.statSync(p(first.id)+'/shard-0002.jsonl').ino,fs.statSync(p(second.id)+'/shard-0002.jsonl').ino);
  assert.equal(rollback(f.c),first.id);assert.ok((await search(f.c,'c 保留知识库资料',{lexical:true})).length);
  await f.update('回退后再更新');assert.ok((await search(f.c,'回退后再更新',{lexical:true})).length);
});
test('持有旧代读租约时跨多次发布仍可读，释放后回收；查询失败释放租约',async t=>{
  const f=fixture(t);await build(f.c,undefined,embed);const reader=acquireCurrent(f.c);
  for(let i=0;i<3;i++){age(f);await f.update('更新 '+i);}
  assert.ok(fs.existsSync(reader.dir));assert.equal(ids(f).length,3);
  reader.release();collect(f.c,{apply:true,graceMs:0});assert.equal(ids(f).length,2);
  await assert.rejects(search(f.c,'知识',{},async()=>{throw Error('模型失败');}),/模型失败/);
  assert.equal(fs.readdirSync(current(f.c).dir).filter(x=>x.startsWith('.reader-')).length,0);
});
test('真正暂停中的查询跨三次发布后继续，返回其原代结果',async t=>{
  const f=fixture(t);await build(f.c,undefined,embed);
  let resume,started;const entered=new Promise(r=>started=r);
  const query=search(f.c,'c 保留知识库资料',{},async()=>{started();return new Promise(r=>resume=()=>r([[1,0]]));});
  await entered;for(let i=0;i<3;i++){age(f);await f.update('后续版本 '+i);}resume();
  assert.ok((await query).some(r=>r.text==='c 保留知识库资料'));
  collect(f.c,{apply:true,graceMs:0});assert.equal(ids(f).length,2);
});
test('保留代损坏或指针无效时零删除，修复后重试；writer lock 拒绝并发清理',async t=>{
  const f=fixture(t);for(let i=0;i<3;i++)await f.update('版本 '+i);age(f);
  const index=current(f.c),file=path.join(index.dir,'shard-0002.jsonl'),original=fs.readFileSync(file),count=ids(f).length;
  fs.writeFileSync(file,'损坏');assert.throws(()=>collect(f.c,{apply:true,graceMs:0}),/损坏/);assert.equal(ids(f).length,count);
  fs.writeFileSync(file,original);const pointer=path.join(f.c.dataDir,'PREVIOUS'),saved=fs.readFileSync(pointer);
  fs.writeFileSync(pointer,'../outside');assert.throws(()=>collect(f.c,{apply:true}),/指针/);assert.equal(ids(f).length,count);fs.writeFileSync(pointer,saved);
  const release=lock(f.c.dataDir);try{assert.throws(()=>collect(f.c,{apply:true}),/已有建库进程/);}finally{release();}
  assert.equal(collect(f.c,{apply:true,graceMs:0}).removed,1);assert.equal(ids(f).length,2);
});
test('发布中断保留当前与上一代，原代共享文件和资料不变；重试成功',async t=>{
  const f=fixture(t);await build(f.c,undefined,embed);await f.update('已有第二代');const before=current(f.c).id;
  fs.writeFileSync(path.join(f.docs,'c.md'),'待发布的新资料');
  await assert.rejects(build(f.c,undefined,embed,{failpoint:where=>{if(where==='before-publish')throw Error('模拟发布失败');}}),/发布失败/);
  assert.equal(current(f.c).id,before);assert.equal(ids(f).length,2);assert.ok((await search(f.c,'已有第二代',{lexical:true})).length);
  const result=await build(f.c,undefined,embed);assert.equal(result.embedded,0);assert.ok((await search(f.c,'待发布的新资料',{lexical:true})).length);
});
test('默认只预览、近期目录保护、符号链接与未知恢复材料保留；CLI 可解析预览',async t=>{
  const f=fixture(t);for(let i=0;i<3;i++)await f.update('版本 '+i);
  assert.equal(collect(f.c,{apply:true}).removed,0);age(f);
  const parent=path.join(f.c.dataDir,'generations');fs.symlinkSync(f.docs,path.join(parent,'10000000-00000000-0000-0000-0000-000000000000'));
  const cache=path.join(f.c.dataDir,'cache');fs.mkdirSync(path.join(cache,'.corrupt-recovery'));fs.writeFileSync(path.join(cache,'.corrupt-recovery','recover'),'保留');
  const plan=collect(f.c,{graceMs:0});assert.equal(plan.applied,false);assert.equal(plan.generations.length,1);assert.equal(ids(f).length,4);
  const cli=spawnSync(process.execPath,[fileURLToPath(new URL('./kb/kb.cjs',import.meta.url)),'gc','--config',f.file],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).applied,false);
  collect(f.c,{apply:true,graceMs:0});assert.equal(fs.readFileSync(path.join(cache,'.corrupt-recovery','recover'),'utf8'),'保留');assert.equal(fs.readdirSync(f.docs).length,3);
});
test('不能硬链接时退回普通写入，仍能检索；上次清理中断留下的目录可继续回收',async t=>{
  const f=fixture(t),first=await build(f.c,undefined,embed),link=fs.linkSync;
  try{fs.linkSync=()=>{throw Object.assign(Error('跨设备'),{code:'EXDEV'});};await f.update('普通写入');}finally{fs.linkSync=link;}
  assert.ok((await search(f.c,'普通写入',{lexical:true})).length);
  const parent=path.join(f.c.dataDir,'generations');await f.update('第三代');age(f);
  fs.renameSync(path.join(parent,first.id),path.join(parent,'.gc-'+first.id));
  assert.equal(collect(f.c,{apply:true,graceMs:0}).removed,1);assert.equal(fs.existsSync(path.join(parent,'.gc-'+first.id)),false);
});
