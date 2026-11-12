import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {normalizeRc1HistoryController} from './history-controller.mjs';

export const version = '0.2.2-rc.1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const patches = [
  {
    file: '@deepseek-ai/dsh-client-connection/lib/index.js',
    before: '0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684',
    transform: text => text.replace('owner.effect(() => owner.webServer.register(route)', "owner.effect(() => owner.get('webServer').register(route)"),
    inverse: text => text.replace("owner.effect(() => owner.get('webServer').register(route)", 'owner.effect(() => owner.webServer.register(route)'),
  },
  {
    file: '@deepseek-ai/dsh-api-session-controller/lib/index.js',
    before: '4cf6c66e65cce865d270fa89405b96d048ffa62e493e4ffbd1a826be2207a4cd',
    transform: text => text + '\nexport { buildModelCatalog };\n',
    inverse: text => text.replace(/\nexport \{ buildModelCatalog \};\n$/, ''),
  },
  {
    file: '@deepseek-ai/cordis/lib/index.js',
    before: '627409afa06a265f7253200d3bc4648e88805c39fd3768568eb9b9518a31fe8f',
    transform: text => text.replace('\ton(name, listener, options) {\n', '\ton(name, listener, options) {\n' + legacyDispose),
    inverse: text => text.replace(legacyDispose, ''),
  },
];
const legacyDispose = `\t\t// DSH desktop legacy cleanup bridge; the fiber owns and awaits this effect.\n\t\tif (name === "dispose") {\n\t\t\tthis.ctx.fiber.assertActive();\n\t\t\tconst callback = this.ctx.reflect.bind(listener);\n\t\t\tlet active = true;\n\t\t\tconst detach = this.ctx.effect(() => () => {\n\t\t\t\tif (!active) return;\n\t\t\t\tactive = false;\n\t\t\t\treturn callback.call(this.ctx);\n\t\t\t}, "legacy dispose");\n\t\t\treturn () => { active = false; return detach(); };\n\t\t}\n`;
/** Exact published rc.1 files; unknown bytes are never treated as an upgrade predecessor. */
export async function applyRc1Compatibility(runtime) {
  const modules = path.join(runtime, 'node_modules');
  const core = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
  if (core.version !== version) throw Error('此兼容层只适用于 DSH ' + version);
  const plans = [];
  for (const patch of patches) {
    const file = path.join(modules, patch.file), bytes = await readFile(file), hash = digest(bytes);
    if (hash === patch.before) {
      const after = Buffer.from(patch.transform(bytes.toString('utf8')));
      if (digest(after) === hash) throw Error('兼容补丁未命中：' + patch.file);
      plans.push({file, before: bytes, after});
    } else {
      // Reconstruct the exact original for an idempotence check; do not bless arbitrary edits.
      const inspected = patch.file === '@deepseek-ai/dsh-api-session-controller/lib/index.js' ? normalizeRc1HistoryController(bytes) : bytes;
      const text = inspected.toString('utf8');
      const original = patch.inverse(text);
      if (digest(Buffer.from(original)) !== patch.before || !Buffer.from(patch.transform(original)).equals(inspected)) throw Error('核心文件有未知改动，未覆盖：' + patch.file);
    }
  }
  const applied = [];
  const atomic = async (file, bytes) => {
    const temporary = file + '.' + randomUUID();
    try { await writeFile(temporary, bytes, {flag: 'wx'}); await rename(temporary, file); }
    finally { await rm(temporary, {force: true}); }
  };
  try {
    for (const plan of plans) {
      if (!(await readFile(plan.file)).equals(plan.before)) throw Error('核心文件发生并发修改');
      await atomic(plan.file, plan.after); applied.push(plan);
    }
  } catch (error) {
    for (const plan of applied.reverse()) if ((await readFile(plan.file)).equals(plan.after)) await atomic(plan.file, plan.before);
    throw error;
  }
  return {version, changed: plans.length, files: patches.map(p => p.file)};
}
