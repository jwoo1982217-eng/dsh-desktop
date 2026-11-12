import {readFile, writeFile, rename, rm, stat} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const beforeHashes = new Set([
  '4cf6c66e65cce865d270fa89405b96d048ffa62e493e4ffbd1a826be2207a4cd', // published rc.1
  '337899c4754a4e60839c08e68ddeca7410f56562e682f86870578ba27239b38e', // plus existing buildModelCatalog export
]);
export const historyControllerCompatibilityFile = '@deepseek-ai/dsh-api-session-controller/lib/index.js';
const ownership = `\townedHandles = new Map();
\tdeletedIds = new Set();
\tdeletingIds = new Set();
\tasync deletionLease(ids) {
\t\tfor (const id of ids) if (this.deletingIds.has(id)) throw new Error("聊天正在删除，请稍后重试");
\t\tfor (const id of ids) this.deletingIds.add(id);
\t\ttry {
\t\t\tawait Promise.all(ids.flatMap(id => [this.resumes.get(id), this.claims.get(id)]).filter(Boolean));
\t\t\tfor (const id of ids) {
\t\t\t\tconst agent = this.ctx.agents.get(id);
\t\t\t\tif (agent?.status === "running") throw new Error("请先停止聊天中正在运行的任务");
\t\t\t\tif ((agent || this.ctx.sessions.get(id)) && !this.ownedHandles.has(id)) throw new Error("聊天由其他服务持有，请先停止该服务并重试");
\t\t\t}
\t\t\tfor (const id of ids) { const handle = this.ownedHandles.get(id); if (handle) { await handle.dispose(); this.ownedHandles.delete(id); } }
\t\t\treturn () => { for (const id of ids) this.deletingIds.delete(id); };
\t\t} catch (error) { for (const id of ids) this.deletingIds.delete(id); throw error; }
\t}
\tretainHandle(handle) { this.ownedHandles.set(handle.agent.id, handle); return handle.agent; }
\tassertAvailable(id) { if (this.deletedIds.has(id) || this.deletingIds.has(id)) throw new ApiSessionNotFound(\`session "\${id}" was permanently deleted\`); }
`;
const edits = [
  ['var ApiSessionAgentController = class {\n\tctx;\n', 'var ApiSessionAgentController = class {\n\tctx;\n' + ownership],
  ['\tasync resolve(sessionId, observation) {\n', '\tasync resolve(sessionId, observation) {\n\t\tthis.assertAvailable(sessionId);\n'],
  ['\tasync claim(sessionId, request) {\n', '\tasync claim(sessionId, request) {\n\t\tthis.assertAvailable(sessionId);\n'],
  ['\tasync createAgent(sessionId, cwd, composition) {\n', '\tasync createAgent(sessionId, cwd, composition) {\n\t\tthis.assertAvailable(sessionId);\n'],
  ['\t\treturn (await this.ctx.agents.resume({\n\t\t\tresumeSessionId: sessionId,\n\t\t\tagentOptions: this.agentOptions(),\n\t\t\tsetup: composition.setup\n\t\t})).agent;', '\t\treturn this.retainHandle(await this.ctx.agents.resume({\n\t\t\tresumeSessionId: sessionId,\n\t\t\tagentOptions: this.agentOptions(),\n\t\t\tsetup: composition.setup\n\t\t}));'],
  ['\t\t\treturn (await this.ctx.agents.resume({\n\t\t\t\tresumeSessionId: sessionId,\n\t\t\t\tagentOptions: this.agentOptions(),\n\t\t\t\tsetup: this.reuseSetup(composition)\n\t\t\t})).agent;', '\t\t\treturn this.retainHandle(await this.ctx.agents.resume({\n\t\t\t\tresumeSessionId: sessionId,\n\t\t\t\tagentOptions: this.agentOptions(),\n\t\t\t\tsetup: this.reuseSetup(composition)\n\t\t\t}));'],
  ['\t\treturn (await this.ctx.agents.create({\n\t\t\tsessionId,\n\t\t\tagentOptions: this.agentOptions(),\n\t\t\tmeta: {\n\t\t\t\tcwd,\n\t\t\t\t...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }\n\t\t\t},\n\t\t\tsetup: composition.setup\n\t\t})).agent;', '\t\treturn this.retainHandle(await this.ctx.agents.create({\n\t\t\tsessionId,\n\t\t\tagentOptions: this.agentOptions(),\n\t\t\tmeta: {\n\t\t\t\tcwd,\n\t\t\t\t...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }\n\t\t\t},\n\t\t\tsetup: composition.setup\n\t\t}));'],
  ['\t\tresolveAgent(sessionId) {\n\t\t\treturn this.agents.resolveAgent(sessionId);', '\t\tdeletionLease(ids) { return this.agents.deletionLease(ids); }\n\t\tmarkPermanentlyDeleted(ids) { for (const id of ids) this.agents.deletedIds.add(id); }\n\t\tresolveAgent(sessionId) {\n\t\t\treturn this.agents.resolveAgent(sessionId);'],
  ['return { items: (await this.listState.list(signal)).filter((item) => this.ctx.remoteAccess.allows({', 'return { items: (await this.listState.list(signal)).filter((item) => !this.agents.deletedIds.has(item.sessionId) && this.ctx.remoteAccess.allows({'],
  ['items: result.items.filter((item) => this.ctx.remoteAccess.allows({', 'items: result.items.filter((item) => !this.agents.deletedIds.has(item.sessionId) && this.ctx.remoteAccess.allows({'],
];
const replaceOnce = (text, before, after) => {
  if (text.split(before).length !== 2) throw Error('聊天控制器兼容补丁未唯一命中');
  return text.replace(before, after);
};
const transform = bytes => Buffer.from(edits.reduce((text, [before, after]) => replaceOnce(text, before, after), bytes.toString('utf8')));
/** Only an exact complete known patch is stripped; unknown edits are returned unchanged. */
export function normalizeRc1HistoryController(bytes) {
  if (beforeHashes.has(sha(bytes))) return bytes;
  try {
    const original = Buffer.from(edits.toReversed().reduce((text, [before, after]) => replaceOnce(text, after, before), bytes.toString('utf8')));
    return beforeHashes.has(sha(original)) && transform(original).equals(bytes) ? original : bytes;
  } catch { return bytes; }
}
/** Preserve the legacy deletion ledger and exact Agent-handle ownership on the rc.1 controller. */
export async function applyRc1HistoryControllerCompatibility(runtime) {
  const modules = path.join(runtime, 'node_modules');
  if (JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version !== '0.2.2-rc.1') throw Error('聊天控制器兼容层只适用于 rc.1');
  const file = path.join(modules, historyControllerCompatibilityFile), before = await readFile(file), original = normalizeRc1HistoryController(before);
  if (!beforeHashes.has(sha(original))) throw Error('聊天控制器有未知改动，未覆盖');
  if (!original.equals(before)) return {changed: 0, files: [historyControllerCompatibilityFile], sha256: sha(before)};
  const after = transform(before), temporary = file + '.' + randomUUID();
  try {
    if (!(await readFile(file)).equals(before)) throw Error('聊天控制器发生并发修改');
    await writeFile(temporary, after, {flag: 'wx', mode: (await stat(file)).mode & 0o777});
    if (!(await readFile(file)).equals(before)) throw Error('聊天控制器发生并发修改');
    await rename(temporary, file);
  } finally { await rm(temporary, {force: true}); }
  return {changed: 1, files: [historyControllerCompatibilityFile], sha256: sha(after)};
}
