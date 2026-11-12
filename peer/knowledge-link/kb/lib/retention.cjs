'use strict';
const crypto=require('node:crypto');
const {fs,path,hash,json,lock}=require('./util.cjs');
const generation=/^\d+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const cacheKey=/^[0-9a-f]{64}$/;
// Also protects readers started by the previous, unpatched runtime during deployment.
const GRACE_MS=10*60*1000;
function directory(dir){const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw Error('索引回收拒绝非普通目录：'+dir);return st;}
function regular(file){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error('索引回收拒绝非普通文件：'+file);return st;}
function alive(pid){if(!Number.isSafeInteger(pid)||pid<1)return true;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function reading(dir){
  for(const name of fs.readdirSync(dir))if(name.startsWith('.reader-')){
    const match=name.match(/^\.reader-(\d+)-/);if(!match||alive(Number(match[1])))return true;
  }
  return false;
}
function acquire(c,getCurrent){
  for(let attempt=0;attempt<3;attempt++){
    const index=getCurrent(c);if(!index)return null;
    const file=path.join(index.dir,`.reader-${process.pid}-${crypto.randomUUID()}`);
    try{
      const before=directory(index.dir);fs.writeFileSync(file,'',{flag:'wx',mode:0o600});
      const after=directory(index.dir);
      if(before.ino!==after.ino||before.dev!==after.dev)throw Error('索引代已切换');
      return {...index,release(){try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}}};
    }catch(e){try{fs.unlinkSync(file);}catch{}if(e.code!=='ENOENT'&&e.message!=='索引代已切换')throw e;}
  }
  throw Error('索引正在回收，请重试检索');
}
function validate(dir){
  directory(dir);regular(path.join(dir,'manifest.json'));
  const mf=json(path.join(dir,'manifest.json'));
  if(mf.version!==3||!Array.isArray(mf.shards)||!Array.isArray(mf.sources)||!Number.isSafeInteger(mf.count)||mf.count<0)throw Error('保留索引清单不完整，停止回收');
  let count=0;
  for(const shard of mf.shards){
    if(!Number.isSafeInteger(shard.count)||shard.count<0)throw Error('保留索引分片数量无效');
    for(const [name,digest]of [[shard.text,shard.textHash],[shard.bin,shard.binHash]]){
      if(typeof name!=='string'||!/^shard-\d+\.(?:jsonl|bin)$/.test(name)||!cacheKey.test(digest))throw Error('保留索引分片路径或哈希无效');
      const file=path.join(dir,name);regular(file);if(hash(fs.readFileSync(file))!==digest)throw Error('保留索引分片损坏，停止回收');
    }
    count+=shard.count;
  }
  if(count!==mf.count||mf.sources.some(s=>!cacheKey.test(s.key)))throw Error('保留索引来源不完整，停止回收');
  return mf;
}
// Caller holds the same writer lock as build/migrate/rollback. All retained
// generations are checked before deleting anything, including cache directories.
function collectLocked(c,{apply=false,now=Date.now(),graceMs=GRACE_MS}={}){
  directory(c.dataDir);
  const parent=path.join(c.dataDir,'generations'),cache=path.join(c.dataDir,'cache');
  if(!fs.existsSync(parent))return {applied:apply,kept:[],generations:[],caches:[],removed:0,removedCache:0};
  directory(parent);if(fs.existsSync(cache))directory(cache);
  const keep=new Set();
  for(const name of ['CURRENT','PREVIOUS']){
    const file=path.join(c.dataDir,name);
    if(!fs.existsSync(file)){if(name==='CURRENT')throw Error('缺少 CURRENT，停止回收');continue;}
    regular(file);const id=fs.readFileSync(file,'utf8').trim();if(!generation.test(id))throw Error(name+' 指针无效，停止回收');keep.add(id);
  }
  const entries=fs.readdirSync(parent,{withFileTypes:true});
  for(const e of entries)if(e.isDirectory()&&generation.test(e.name)){
    const dir=path.join(parent,e.name),st=directory(dir);
    if(graceMs>0&&now-st.mtimeMs<graceMs||reading(dir))keep.add(e.name);
  }
  const keys=new Set();
  for(const id of keep){
    const dir=path.join(parent,id);
    // Recent incomplete builds are protected, but cannot authorize cache removal.
    if(!fs.existsSync(path.join(dir,'manifest.json')))throw Error('保留索引尚未完整，停止回收');
    for(const source of validate(dir).sources)keys.add(source.key);
  }
  const generations=entries.filter(e=>e.isDirectory()&&(generation.test(e.name)||e.name.startsWith('.gc-')&&generation.test(e.name.slice(4)))&&!keep.has(e.name.replace(/^\.gc-/,''))).map(e=>e.name);
  const caches=fs.existsSync(cache)?fs.readdirSync(cache,{withFileTypes:true}).filter(e=>e.isDirectory()&&cacheKey.test(e.name)&&!keys.has(e.name)&&now-directory(path.join(cache,e.name)).mtimeMs>=graceMs).map(e=>e.name):[];
  const result={applied:apply,kept:[...keep],generations,caches,removed:0,removedCache:0};
  if(!apply)return result;
  for(const id of generations){
    const original=path.join(parent,id),tomb=path.join(parent,id.startsWith('.gc-')?id:'.gc-'+id);
    // Rename first, then recheck leases: a reader can no longer attach to the
    // original path between the last lease check and recursive deletion.
    if(original!==tomb)fs.renameSync(original,tomb);
    if(reading(tomb)){if(original!==tomb)fs.renameSync(tomb,original);continue;}
    fs.rmSync(tomb,{recursive:true});result.removed++;
  }
  for(const key of caches){fs.rmSync(path.join(cache,key),{recursive:true});result.removedCache++;}
  return result;
}
function collect(c,opts){const release=lock(c.dataDir);try{return collectLocked(c,opts);}finally{release();}}
module.exports={acquire,collect,collectLocked,GRACE_MS};
