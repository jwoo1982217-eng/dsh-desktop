import {readFile, writeFile, rename, rm, mkdir, lstat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const version = '0.2.2-rc.1';
const controlName='@deepseek-ai/dsh-tool-subagent-control',retiredListName=controlName+'/list-agents';
const mergedControlHash='9e84bfc3fce6eb2cfe70362c3da79473398932f45fc289f27ebbd79c9ea14bb7';
async function assertMergedControl(modules) {
  const directory=path.join(modules,controlName),pkg=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
  const main=await readFile(path.join(directory,'lib/index.js'));
  if(pkg.name!==controlName||pkg.version!==version||pkg.main!=='lib/index.js'||pkg.exports?.['.']?.default!=='./lib/index.js'||Object.hasOwn(pkg.exports,'./list-agents')||digest(main)!==mergedControlHash||!main.toString().includes('function apply(ctx) {\n\tregisterListAgents(ctx);'))throw Error('未确认 rc.1 主控制模块已合并 list_agents，保留原独立发现工具');
}
async function optional(file) {
  try {const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw Error('升级配置不是普通文件，未修改');return await readFile(file);}
  catch(error) {if(error.code==='ENOENT')return null;throw error;}
}
async function atomic(file, bytes) {
  const temporary = file + '.rc1-' + randomUUID();
  try {await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,file);}
  finally {await rm(temporary,{force:true});}
}

/** Plan confirmed rc.1 subagent seams only. Buffers may contain private configuration. */
async function prepareFile(profile, modules) {
  const file=path.join(path.resolve(profile),'cordis.patch.yml'),original=await optional(file);
  if(original===null)return {changed:false,file,version};
  const require=createRequire(path.join(path.resolve(modules),'@deepseek-ai/dsh/package.json'));
  const core=JSON.parse(await readFile(path.join(modules,'@deepseek-ai/dsh/package.json'),'utf8'));
  if(core.version!==version)throw Error('配置迁移只适用于 DSH '+version);
  const {parseDocument,isMap,isSeq,isAlias}=require('yaml');
  const document=parseDocument(original.toString('utf8'),{keepSourceTokens:true,strict:true,uniqueKeys:true});
  if(document.errors.length||!isSeq(document.contents))throw Error('升级配置不是有效的 Cordis patch 列表，未修改');
  let renamed=0,subagents=0,removedLegacyListAgents=0;
  function plainControlRow(node,expectedId,expectedName) {
    return isMap(node)&&!node.anchor&&!node.tag&&node.get('id')===expectedId&&node.get('name')===expectedName&&node.items.length===2&&node.items.every(pair=>['id','name'].includes(pair.key?.value)&&!pair.key?.tag&&!pair.value?.tag&&!pair.value?.anchor&&!isAlias(pair.value));
  }
  function retainedComments(node,output=[]) {
    if(node?.commentBefore)output.push(node.commentBefore);
    if(isMap(node))for(const pair of node.items){retainedComments(pair.key,output);retainedComments(pair.value,output);}
    if(node?.comment)output.push(node.comment);
    return output;
  }
  function retireListAgentRows(sequence) {
    const legacy=sequence.items.filter(item=>isMap(item)&&item.get('name')===retiredListName);
    const aliases=sequence.items.filter(item=>isAlias(item)&&isMap(item.resolve(document))&&item.resolve(document).get('name')===retiredListName);
    if(aliases.length)throw Error('独立 list_agents 使用共享别名，未删除共享工具配置');
    if(!legacy.length)return;
    const main=sequence.items.filter(item=>isMap(item)&&item.get('name')===controlName);
    if(legacy.length!==1||main.length!==1||!plainControlRow(main[0],'tool-subagent-control',controlName)||!plainControlRow(legacy[0],'tool-subagent-list-agents',retiredListName))throw Error('独立 list_agents 缺少同组已启用主控制模块或存在自定义设置，未移除工具');
    const index=sequence.items.indexOf(legacy[0]),comments=retainedComments(legacy[0]);
    sequence.items.splice(index,1);removedLegacyListAgents++;
    if(comments.length) {
      const next=sequence.items[index],previous=sequence.items[index-1];
      if(next)next.commentBefore=[...comments,next.commentBefore].filter(Boolean).join('\n');
      else if(previous)previous.comment=[previous.comment,...comments].filter(Boolean).join('\n');
      else sequence.comment=[sequence.comment,...comments].filter(Boolean).join('\n');
    }
  }
  function walk(node) {
    if(isMap(node)) {
      const name=node.get('name'),config=node.get('config',true);
      if(name==='@deepseek-ai/dsh-tool-subagent') {
        subagents++;
        if(isAlias(config)) {
          const target=config.resolve(document);
          if(isMap(target)&&(target.has('modelSelectionSettings')||target.has('modelSelection')))throw Error('子代理配置使用共享别名，未自动改变共享配置');
        } else if(isMap(config)) {
          if(config.has('<<'))throw Error('子代理配置使用 YAML 合并，未自动改变共享配置');
          if(config.has('modelSelectionSettings')) {
            if(config.has('modelSelection'))throw Error('子代理同时包含 modelSelectionSettings 和 modelSelection，未修改冲突配置');
            const pair=config.items.find(item=>item.key?.value==='modelSelectionSettings');
            // Rename the existing scalar node: keep its value, quotes, comments and custom tags.
            pair.key.value='modelSelection';renamed++;
          }
        }
      }
      if(name==='@deepseek-ai/dsh-tools'&&isMap(config)&&(config.has('mode')||config.has('maxParallelSubCalls')))throw Error('旧 tools.mode 或 maxParallelSubCalls 需要独立 executor 适配，未静默更改执行模式或并发设置');
      for(const pair of node.items)walk(pair.value);
    } else if(isSeq(node)){retireListAgentRows(node);for(const item of node.items)walk(item);}
  }
  walk(document.contents);
  if(removedLegacyListAgents)await assertMergedControl(modules);
  if(!renamed&&!removedLegacyListAgents)return {changed:false,file,version,before:digest(original),subagents,removedLegacyListAgents};
  const next=Buffer.from(String(document));
  return {changed:true,file,version,original,next,before:digest(original),after:digest(next),renamed,subagents,removedLegacyListAgents};
}

/** A web profile and its global patch form one migration/CAS unit. */
export async function prepareRc1ProfileMigration(profile, modules) {
  const directory=path.resolve(profile),directories=[directory];
  if(path.basename(path.dirname(directory))==='profiles')directories.push(path.dirname(path.dirname(directory)));
  const files=[];
  for(const item of directories)files.push(await prepareFile(item,modules));
  return {version,changed:files.some(item=>item.changed),renamed:files.reduce((n,item)=>n+(item.renamed??0),0),removedLegacyListAgents:files.reduce((n,item)=>n+(item.removedLegacyListAgents??0),0),files};
}
export function rc1MigrationReceipt(plan, backup) {
  if(!plan.changed)return null;
  return {version,removedLegacyListAgents:plan.removedLegacyListAgents??0,files:plan.files.filter(item=>item.changed).map(item=>({file:item.file,saved:path.join(path.resolve(backup),'cordis.patch.yml.'+digest(Buffer.from(item.file)).slice(0,16)+'.before-rc1'),before:item.before,after:item.after,renamed:item.renamed,removedLegacyListAgents:item.removedLegacyListAgents??0}))};
}
async function assertOriginal(item) {
  const current=await optional(item.file),hash=current===null?undefined:digest(current);
  if(hash!==item.before)throw Error('升级期间配置已变化，未覆盖原配置');
}
/** Validate both patches before writing either. Unknown concurrent changes are never overwritten. */
export async function commitRc1ProfileMigration(plan, backup, {beforeWrite}={}) {
  if(!plan.changed)return null;
  for(const item of plan.files) {
    if(item.changed&&(digest(item.original)!==item.before||digest(item.next)!==item.after))throw Error('配置迁移计划内容校验失败，未修改');
    await assertOriginal(item);
  }
  const directory=path.resolve(backup);
  await mkdir(directory,{recursive:true,mode:0o700});
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw Error('配置备份目录须为私有普通目录');
  const receipt=rc1MigrationReceipt(plan,directory),changes=plan.files.filter(item=>item.changed);
  for(const [index,item]of changes.entries()) {
    const entry=receipt.files[index];
    try {await writeFile(entry.saved,item.original,{mode:0o600,flag:'wx'});}
    catch(error) {if(error.code!=='EEXIST')throw error;const saved=await optional(entry.saved);if(saved===null||digest(saved)!==item.before)throw Error('已有配置备份内容不匹配，未覆盖');}
    const savedInfo=await lstat(entry.saved);
    if(!savedInfo.isFile()||savedInfo.isSymbolicLink()||(savedInfo.mode&0o077)!==0)throw Error('配置备份文件须为私有普通文件');
    if(digest(await readFile(entry.saved))!==item.before)throw Error('配置备份校验失败，未修改');
  }
  for(const item of plan.files)await assertOriginal(item);
  const applied=[];
  try {
    for(const [index,item]of changes.entries()) {
      await beforeWrite?.({index,file:item.file});
      await assertOriginal(item);await atomic(item.file,item.next);applied.push(item);
    }
  } catch(error) {
    const failures=[];
    for(const item of applied.reverse())try {
      const current=await optional(item.file);
      if(current===null||digest(current)!==item.after)throw Error('回退时配置已有并发修改，保留当前文件和升级备份');
      await atomic(item.file,item.original);
    } catch(failure) {failures.push(failure);}
    if(failures.length){const failure=new AggregateError([error,...failures],'配置迁移失败，部分并发修改须人工核对');failure.receipt=receipt;throw failure;}
    throw error;
  }
  return receipt;
}
export async function restoreRc1ProfileMigration(receipt) {
  if(!receipt)return;
  const plans=[];
  // Whole-receipt preflight prevents an unrelated edit in the second file from partially restoring the first.
  for(const entry of receipt.files) {
    const current=await optional(entry.file);
    if(current===null)throw Error('升级配置已移除，保留备份，未重建');
    const hash=digest(current);
    if(hash===entry.before)continue;
    if(hash!==entry.after)throw Error('升级后配置已有其他修改，保留当前文件和升级备份');
    const saved=await optional(entry.saved);
    if(saved===null||digest(saved)!==entry.before)throw Error('配置回退备份校验失败，未覆盖');
    plans.push({entry,current,saved});
  }
  const applied=[];
  try {
    for(const plan of plans) {
      const latest=await optional(plan.entry.file);
      if(latest===null||digest(latest)!==plan.entry.after)throw Error('回退期间配置已变化，保留当前文件和升级备份');
      await atomic(plan.entry.file,plan.saved);applied.push(plan);
    }
  } catch(error) {
    const failures=[];
    for(const plan of applied.reverse())try {
      const current=await optional(plan.entry.file);
      if(current===null||digest(current)!==plan.entry.before)throw Error('恢复迁移状态时发现并发修改');
      await atomic(plan.entry.file,plan.current);
    } catch(failure){failures.push(failure);}
    if(failures.length)throw new AggregateError([error,...failures],'配置回退未完成，请核对私有备份');
    throw error;
  }
}
