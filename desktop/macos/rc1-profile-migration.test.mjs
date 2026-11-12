import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {prepareRc1ProfileMigration as plan,commitRc1ProfileMigration as commit,restoreRc1ProfileMigration as restore} from './app/rc1-profile-migration.mjs';
const modules=process.env.DSH_RC1_MODULES||path.resolve('desktop-runtime/node_modules');
const root=process.env.DSH_RC1_MIGRATION_TEST_ROOT||os.tmpdir();
const require=createRequire(path.join(modules,'@deepseek-ai/dsh/package.json'));const YAML=require('yaml');
const input=`# 用户注释\n- id: preset\n  config:\n    unrelated: '原值'\n    plugins:\n      - name: '@deepseek-ai/dsh-tool-subagent'\n        disabled: !!js process.platform === 'win32'\n        config:\n          provider: spawn\n          # 保留键前注释\n          modelSelectionSettings: false # 保留行尾注释\n          permission: danger-full-access\n      - name: '@deepseek-ai/dsh-agent-tool-presentation'\n        config: {mode: ptc}\n- id: literal\n  config: {text: 'modelSelectionSettings: true'}\n`;
async function fixture(t,text=input){const directory=await fs.mkdtemp(path.join(root,'rc1-profile-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const file=path.join(directory,'cordis.patch.yml');await fs.writeFile(file,text,{mode:0o600});return {directory,file,backup:path.join(directory,'private-backup')};}
const parse=text=>YAML.parseDocument(text,{keepSourceTokens:true});
const semantic=text=>parse(text).toJS();
test('rename is exact in meaning: false, comments, JS tags, unrelated text and PTC presentation survive; restore matches every byte',async t=>{
 const f=await fixture(t),p=await plan(f.directory,modules);assert.equal(p.renamed,1);const text=p.files[0].next.toString();
 assert(text.includes("!!js process.platform === 'win32'"));assert(text.includes('# 用户注释'));assert(text.includes('# 保留键前注释'));assert(text.includes('modelSelection: false # 保留行尾注释'));assert(text.includes("text: 'modelSelectionSettings: true'"));assert(!text.includes('modelDiscovery:'));
 const expected=semantic(input);expected[0].config.plugins[0].config.modelSelection=expected[0].config.plugins[0].config.modelSelectionSettings;delete expected[0].config.plugins[0].config.modelSelectionSettings;assert.deepEqual(semantic(text),expected);
 const r=await commit(p,f.backup);assert.equal((await fs.stat(r.files[0].saved)).mode&0o777,0o600);assert.equal((await fs.stat(f.backup)).mode&0o777,0o700);assert.equal((await plan(f.directory,modules)).changed,false);await restore(r);assert.equal(await fs.readFile(f.file,'utf8'),input);await restore(r);
});
test('nested multiple presets rename independently; existing new-key configuration stays exact',async t=>{
 const text=input+input.replace('modelSelectionSettings: false','modelSelection: true'),f=await fixture(t,text),p=await plan(f.directory,modules);assert.equal(p.renamed,1);const r=await commit(p,f.backup);assert.equal((await plan(f.directory,modules)).changed,false);await restore(r);assert.equal(await fs.readFile(f.file,'utf8'),text);
});
test('both old and new names, even equal values, refuse without writing',async t=>{
 const text=input.replace('modelSelectionSettings: false','modelSelection: false\n          modelSelectionSettings: false'),f=await fixture(t,text);await assert.rejects(plan(f.directory,modules),/同时包含/);assert.equal(await fs.readFile(f.file,'utf8'),text);
});
test('retired tools mode/concurrency are refused while unrelated mode is retained',async t=>{
 for(const config of ['{mode: both}','{maxParallelSubCalls: 3}']){const text=`- name: '@deepseek-ai/dsh-tools'\n  config: ${config}\n`,f=await fixture(t,text);await assert.rejects(plan(f.directory,modules),/executor/);assert.equal(await fs.readFile(f.file,'utf8'),text);}
 const f=await fixture(t,"- name: '@deepseek-ai/dsh-agent-tool-presentation'\n  config: {mode: ptc}\n");assert.equal((await plan(f.directory,modules)).changed,false);
});
test('shared config aliases refuse rather than modifying other plugin users',async t=>{
 const text="- id: shared\n  config: &shared {modelSelectionSettings: true}\n- name: '@deepseek-ai/dsh-tool-subagent'\n  config: *shared\n",f=await fixture(t,text);await assert.rejects(plan(f.directory,modules),/共享别名/);assert.equal(await fs.readFile(f.file,'utf8'),text);
});
test('invalid YAML and duplicate keys are refused without changing bytes',async t=>{
 for(const text of ['- config: [\n',"- name: '@deepseek-ai/dsh-tool-subagent'\n  config: {modelSelectionSettings: true, modelSelectionSettings: false}\n"]){const f=await fixture(t,text);await assert.rejects(plan(f.directory,modules),/有效/);assert.equal(await fs.readFile(f.file,'utf8'),text);}
});
test('commit preserves a concurrent edit; a new plan can migrate and restore it',async t=>{
 const f=await fixture(t),p=await plan(f.directory,modules);await fs.appendFile(f.file,'# concurrent edit\n');await assert.rejects(commit(p,f.backup),/配置已变化/);assert((await fs.readFile(f.file,'utf8')).endsWith('# concurrent edit\n'));const retry=await plan(f.directory,modules),r=await commit(retry,f.backup);await restore(r);assert((await fs.readFile(f.file,'utf8')).endsWith('# concurrent edit\n'));
});
test('restore preserves changes after migration; corrupted backup cannot overwrite migrated config',async t=>{
 const f=await fixture(t),r=await commit(await plan(f.directory,modules),f.backup);await fs.appendFile(f.file,'# newer change\n');await assert.rejects(restore(r),/其他修改/);assert((await fs.readFile(f.file,'utf8')).endsWith('# newer change\n'));
 const g=await fixture(t),receipt=await commit(await plan(g.directory,modules),g.backup),before=await fs.readFile(g.file);await fs.writeFile(receipt.files[0].saved,'corrupt');await assert.rejects(restore(receipt),/备份校验/);assert.deepEqual(await fs.readFile(g.file),before);
});
test('backup collision and nonprivate directory refuse; exact original backup can be reused',async t=>{
 const f=await fixture(t),p=await plan(f.directory,modules);await fs.mkdir(f.backup,{mode:0o755});await assert.rejects(commit(p,f.backup),/私有/);assert.equal(await fs.readFile(f.file,'utf8'),input);
 await fs.chmod(f.backup,0o700);const r=await commit(p,f.backup);await restore(r);assert(await commit(await plan(f.directory,modules),f.backup));await restore(r);await fs.writeFile(r.files[0].saved,'different');await assert.rejects(commit(await plan(f.directory,modules),f.backup),/备份内容不匹配/);assert.equal(await fs.readFile(f.file,'utf8'),input);
});

test('profile and global patch plan together; second-file write failure rolls the first file back',async t=>{
 const f=await fixture(t),profile=path.join(f.directory,'profiles','web');await fs.mkdir(profile,{recursive:true});await fs.writeFile(path.join(profile,'cordis.patch.yml'),input);
 const p=await plan(profile,modules);assert.equal(p.files.length,2);assert.equal(p.renamed,2);assert(p.files.every(item=>item.changed));
 await assert.rejects(commit(p,f.backup,{beforeWrite({index}){if(index===1)throw Error('fixture disk failure');}}),/fixture disk failure/);
 assert.equal(await fs.readFile(f.file,'utf8'),input);assert.equal(await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8'),input);
 const r=await commit(await plan(profile,modules),f.backup);assert.equal(r.files.length,2);assert.doesNotThrow(()=>JSON.stringify(r));
 await fs.appendFile(f.file,'# user global change\n');const migrated=await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8');await assert.rejects(restore(r),/其他修改/);assert.equal(await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8'),migrated);
});
test('an unchanged global patch is still covered by commit CAS',async t=>{
 const f=await fixture(t,"- id: unrelated\n  disabled: false\n"),profile=path.join(f.directory,'profiles','web');await fs.mkdir(profile,{recursive:true});await fs.writeFile(path.join(profile,'cordis.patch.yml'),input);
 const p=await plan(profile,modules);assert.equal(p.files.filter(item=>item.changed).length,1);await fs.appendFile(f.file,'# concurrent global edit\n');await assert.rejects(commit(p,f.backup),/配置已变化/);assert.equal(await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8'),input);
});

test('a reused backup with public read bits refuses before migration',async t=>{
 const f=await fixture(t),p=await plan(f.directory,modules),r=await commit(p,f.backup);await restore(r);await fs.chmod(r.files[0].saved,0o644);await assert.rejects(commit(await plan(f.directory,modules),f.backup),/私有普通文件/);assert.equal(await fs.readFile(f.file,'utf8'),input);
});

const delegation=`- id: delegation\n  name: cordis:group\n  config:\n    - id: tool-subagent-control\n      name: '@deepseek-ai/dsh-tool-subagent-control'\n    # 发现工具的用户注释\n    - id: tool-subagent-list-agents # 保留 ID 行尾注释\n      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' # 保留入口行尾注释\n    - id: tool-subagent\n      name: '@deepseek-ai/dsh-tool-subagent'\n      disabled: !!js process.platform === 'win32'\n      config: {provider: spawn, modelSelectionSettings: false}\n`;
test('three custom presets retire only redundant discovery entries, preserving comments, JS tags and nonempty history',async t=>{
 const text=['standard','tools','balanced'].map(id=>`- id: ${id}\n  config:\n    retainedText: '@deepseek-ai/dsh-tool-subagent-control/list-agents'\n    plugins:\n${delegation.split('\n').filter(Boolean).map(line=>'      '+line).join('\n')}\n`).join('');
 const f=await fixture(t,text);await fs.mkdir(path.join(f.directory,'sessions'));const history=path.join(f.directory,'sessions','retained.jsonl');const historyBytes=Buffer.from('{"type":"user","text":"existing nonempty history"}\n');await fs.writeFile(history,historyBytes);
 const p=await plan(f.directory,modules);assert.equal(p.removedLegacyListAgents,3);assert.equal(p.renamed,3);const next=p.files[0].next.toString();
 for(const comment of ['发现工具的用户注释','保留 ID 行尾注释','保留入口行尾注释'])assert.equal(next.split(comment).length-1,3);
 assert.equal(next.split("!!js process.platform === 'win32'").length-1,3);
 const expected=semantic(text);for(const preset of expected){const rows=preset.config.plugins[0].config;rows.splice(1,1);rows[1].config.modelSelection=rows[1].config.modelSelectionSettings;delete rows[1].config.modelSelectionSettings;}
 assert.deepEqual(semantic(next),expected);const r=await commit(p,f.backup);assert.equal(r.removedLegacyListAgents,3);assert.equal((await plan(f.directory,modules)).changed,false);assert.deepEqual(await fs.readFile(history),historyBytes);await restore(r);assert.equal(await fs.readFile(f.file,'utf8'),text);assert.deepEqual(await fs.readFile(history),historyBytes);
});
test('a missing/disabled/customized sibling or customized discovery row refuses without reducing tool capability',async t=>{
 const cases=[
  delegation.replace("    - id: tool-subagent-control\n      name: '@deepseek-ai/dsh-tool-subagent-control'\n",''),
  delegation.replace("name: '@deepseek-ai/dsh-tool-subagent-control'", "name: '@deepseek-ai/dsh-tool-subagent-control'\n      disabled: true"),
  delegation.replace("name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' # 保留入口行尾注释", "name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'\n      config: {scope: descendants}"),
  delegation.replace('id: tool-subagent-list-agents # 保留 ID 行尾注释','id: private-discovery'),
  delegation.replace('id: tool-subagent-list-agents # 保留 ID 行尾注释','id: tool-subagent-list-agents\n      disabled: false'),
  delegation.replace('id: tool-subagent-list-agents # 保留 ID 行尾注释','id: tool-subagent-list-agents\n      disabled: true'),
 ];
 for(const text of cases){const f=await fixture(t,text);await assert.rejects(plan(f.directory,modules),/未移除工具/);assert.equal(await fs.readFile(f.file,'utf8'),text);}
});
test('unknown rc.1 merged-control code or retained subpath exports refuse the retirement',async t=>{
 const f=await fixture(t,delegation),fake=path.join(f.directory,'sdk/node_modules'),control=path.join(fake,'@deepseek-ai/dsh-tool-subagent-control');await fs.mkdir(path.join(fake,'@deepseek-ai/dsh'),{recursive:true});await fs.mkdir(path.join(control,'lib'),{recursive:true});await fs.symlink(path.join(modules,'yaml'),path.join(fake,'yaml'));await fs.copyFile(path.join(modules,'@deepseek-ai/dsh/package.json'),path.join(fake,'@deepseek-ai/dsh/package.json'));
 const pkg=await fs.readFile(path.join(modules,'@deepseek-ai/dsh-tool-subagent-control/package.json')),main=await fs.readFile(path.join(modules,'@deepseek-ai/dsh-tool-subagent-control/lib/index.js'));
 await fs.writeFile(path.join(control,'package.json'),pkg);await fs.writeFile(path.join(control,'lib/index.js'),Buffer.concat([main,Buffer.from('\n// foreign change')]));await assert.rejects(plan(f.directory,fake),/未确认 rc.1/);assert.equal(await fs.readFile(f.file,'utf8'),delegation);
 await fs.writeFile(path.join(control,'lib/index.js'),main);const altered=JSON.parse(pkg);altered.exports['./list-agents']='./legacy.js';await fs.writeFile(path.join(control,'package.json'),JSON.stringify(altered));await assert.rejects(plan(f.directory,fake),/未确认 rc.1/);assert.equal(await fs.readFile(f.file,'utf8'),delegation);
});
test('retired discovery migration joins both patches in CAS and restores the first after a second-file failure',async t=>{
 const f=await fixture(t,delegation),profile=path.join(f.directory,'profiles/web');await fs.mkdir(profile,{recursive:true});const file=path.join(profile,'cordis.patch.yml');await fs.writeFile(file,delegation);
 const p=await plan(profile,modules);assert.equal(p.removedLegacyListAgents,2);await assert.rejects(commit(p,f.backup,{beforeWrite({index}){if(index===1)throw Error('actual two-file failure');}}),/actual two-file failure/);assert.equal(await fs.readFile(file,'utf8'),delegation);assert.equal(await fs.readFile(f.file,'utf8'),delegation);
 const retry=await plan(profile,modules);await fs.appendFile(f.file,'# concurrent global edit\n');await assert.rejects(commit(retry,f.backup),/配置已变化/);assert.equal(await fs.readFile(file,'utf8'),delegation);
});
