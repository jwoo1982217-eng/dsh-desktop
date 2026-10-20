import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const scheduleTools = new Set(['schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update']);
const policyId = 'dsh-legacy-subagent-tool-policy';
async function optional(file) {
  try { return await readFile(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function atomic(file, bytes) {
  const temp = file + '.alpha4-' + randomUUID();
  try { await writeFile(temp, bytes, {mode:0o600}); await rename(temp, file); }
  finally { await rm(temp, {force:true}); }
}

/** 只迁移已观测的定时工具 deny 策略；未知 persona/过滤器在写入前拒绝。 */
export async function prepareProfileMigration(profile, modules) {
  const file = path.join(profile, 'cordis.patch.yml'), original = await optional(file);
  if (!original || !/toolFilter|backgroundMode|enableRunInBackground|\{\{cwd\}\}/.test(original.toString())) return {changed:false};
  const require = createRequire(path.join(modules, '@deepseek-ai/dsh/package.json'));
  const {parseDocument, isMap, isSeq} = require('yaml');
  const document = parseDocument(original.toString());
  if (document.errors.length || !isSeq(document.contents)) throw Error('升级配置不是有效的 Cordis patch 列表，未修改');
  let migrated = 0, retiredFields = 0, directoryStatements = 0;
  const denied = new Set();
  function walk(node) {
    if (isMap(node)) {
      if (node.get('name') === '@deepseek-ai/dsh-persona') {
        const config = node.get('config');
        if (isMap(config)) for (const field of ['prefix', 'suffix']) {
          const value = config.get(field);
          if (typeof value !== 'string' || !value.includes('{{cwd}}')) continue;
          const lines = value.split('\n'), kept = [];
          for (const line of lines) {
            if (!line.includes('{{cwd}}')) {kept.push(line); continue;}
            if (!/^\s*Your working directory is \{\{cwd\}\}\.\s*$/.test(line)) throw Error('发现未验证的 cwd 自定义提示词，请先按工作目录迁移指南适配；原文本保留');
            directoryStatements++;
          }
          config.set(field, kept.join('\n'));
        }
      }
      if (node.get('name') === '@deepseek-ai/dsh-tool-subagent') {
        const config = node.get('config');
        if (isMap(config)) {
          if (config.has('persona')) throw Error('旧子代理 persona 需要独立 Agent Preset 适配，未覆盖配置');
          if (config.has('toolFilter')) {
            const filter = config.get('toolFilter')?.toJSON();
            if (!filter || Object.keys(filter).some(k => k !== 'deny') || !Array.isArray(filter.deny) || !filter.deny.length || filter.deny.some(n => !scheduleTools.has(n))) throw Error('发现未验证的子代理工具过滤器，未放宽或移除它');
            for (const name of filter.deny) denied.add(name);
            config.delete('toolFilter'); migrated++;
          }
          for (const key of ['backgroundMode', 'enableRunInBackground']) if (config.has(key)) {config.delete(key); retiredFields++;}
        }
      }
      for (const item of node.items) walk(item.value);
    } else if (isSeq(node)) for (const item of node.items) walk(item);
  }
  walk(document.contents);
  if (!migrated && !retiredFields && !directoryStatements) return {changed:false};
  if (denied.size) {
    let existing;
    for (const row of document.contents.items) {
      if (!isMap(row)) continue;
      const insert = row.get('insert');
      if (!isSeq(insert)) continue;
      for (const child of insert.items) if (isMap(child) && child.get('id') === policyId) existing = child;
    }
    if (existing) {
      if (existing.get('name') !== 'dsh-peer/legacy-subagent-policy') throw Error('迁移策略 ID 已由其他插件使用，未修改');
      const config = existing.get('config')?.toJSON();
      if (!config || !Array.isArray(config.deny) || config.deny.some(n => !scheduleTools.has(n))) throw Error('已有迁移策略不是已核对版本，未修改');
      for (const name of config.deny) denied.add(name);
      existing.set('config', {deny:[...denied].sort()});
    } else document.add({insert:[{id:policyId, name:'dsh-peer/legacy-subagent-policy', config:{deny:[...denied].sort()}}]});
  }
  const next = Buffer.from(String(document));
  return {changed:true, file, original, next, before:digest(original), after:digest(next), migrated, retiredFields, directoryStatements, deny:[...denied].sort()};
}

export function migrationReceipt(plan, backup) {
  return plan.changed ? {file:plan.file, saved:path.join(backup,'cordis.patch.yml.before-alpha4'), before:plan.before, after:plan.after, migrated:plan.migrated, retiredFields:plan.retiredFields, directoryStatements:plan.directoryStatements} : null;
}
export async function commitProfileMigration(plan, backup) {
  if (!plan.changed) return null;
  if (digest(await readFile(plan.file)) !== plan.before) throw Error('升级期间配置已变化，未覆盖原配置');
  const receipt = migrationReceipt(plan, backup);
  await writeFile(receipt.saved, plan.original, {mode:0o600});
  await atomic(plan.file, plan.next);
  return receipt;
}
export async function restoreProfileMigration(receipt) {
  if (!receipt) return;
  const current = digest(await readFile(receipt.file));
  if (current === receipt.before) return;
  if (current !== receipt.after) throw Error('升级后配置已有其他修改，保留当前文件和升级备份');
  const saved = await readFile(receipt.saved);
  if (digest(saved) !== receipt.before) throw Error('配置回退备份校验失败，未覆盖');
  await atomic(receipt.file, saved);
}
