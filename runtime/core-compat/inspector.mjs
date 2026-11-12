import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const version = '0.2.2-rc.1';
const broker = 'dsh.inspector.fetch-chain-observer';
const patches = [
  {
    location: 'core', file: '@deepseek-ai/dsh-experimental-inspector/lib/index.js',
    before: '9cd7d04adf9c02caf5bb5d0d645d8f0ff409df6f32dc55b9131547511b1067c2',
    edits: [
      ['import z from "@deepseek-ai/schemastery";', 'import { AsyncLocalStorage } from "node:async_hooks";\nimport z from "@deepseek-ai/schemastery";'],
      ['\tconst original = globalThis.fetch;\n\tif (typeof original', '\tlet original = globalThis.fetch;\n\tconst fallback = original;\n\tconst callScope = new AsyncLocalStorage();\n\tconst isBillionChain = (value) => value?.configurable === true && typeof value.get === "function" && typeof value.set === "function" && value.get.call(globalThis)?.[Symbol.for("billion-context.native-fetch-chain")] === true;\n\tif (typeof original'],
      ['if (descriptor !== void 0 && !("value" in descriptor)) throw', 'if (descriptor !== void 0 && !("value" in descriptor) && !isBillionChain(descriptor)) throw'],
      ['\tconst observedFetch = async (input, init) => {\n\t\tconst request = new Request(input, init);', '\tconst observedFetch = async (input, init) => {\n\t\tif (controller.signal.aborted || callScope.getStore()?.has(input)) return Reflect.apply(fallback, globalThis, [input, init]);\n\t\tconst request = new Request(input, init);\n\t\treturn callScope.run(new Set([...(callScope.getStore() ?? []), request]), async () => {'],
      ['\t\treturn response;\n\t};\n\tObject.defineProperty(observedFetch', '\t\treturn response;\n\t\t});\n\t};\n\tObject.defineProperty(observedFetch'],
      ['\tObject.defineProperty(globalThis, "fetch", descriptor === void 0 ? {\n\t\tvalue: observedFetch,\n\t\twritable: true,\n\t\tconfigurable: true\n\t} : {\n\t\t...descriptor,\n\t\tvalue: observedFetch\n\t});\n\tlet stopped;', `\tlet restoreDescriptor = descriptor;
\tlet installedDescriptor;
\tconst hook = Symbol.for("${broker}");
\tconst previousHook = globalThis[hook];
\tconst adoptBillionChain = (chain) => {
\t\tif (controller.signal.aborted || !isBillionChain(chain)) return;
\t\toriginal = (input, init) => Reflect.apply(chain.get.call(globalThis), globalThis, [input, init]);
\t\trestoreDescriptor = chain;
\t\tinstalledDescriptor = {configurable: true, enumerable: chain.enumerable, get: () => observedFetch, set: value => chain.set.call(globalThis, value)};
\t\tObject.defineProperty(globalThis, "fetch", installedDescriptor);
\t};
\tif (isBillionChain(descriptor)) adoptBillionChain(descriptor);
\telse {
\t\tinstalledDescriptor = descriptor === void 0 ? {value: observedFetch, writable: true, configurable: true} : {...descriptor, value: observedFetch};
\t\tObject.defineProperty(globalThis, "fetch", installedDescriptor);
\t}
\tglobalThis[hook] = adoptBillionChain;
\tlet stopped;`],
      ['\t\t\tif (current !== void 0 && "value" in current && current.value === observedFetch) if (descriptor === void 0) Reflect.deleteProperty(globalThis, "fetch");\n\t\t\telse Object.defineProperty(globalThis, "fetch", descriptor);', `\t\t\tif (globalThis[hook] === adoptBillionChain) {
\t\t\t\tif (previousHook === undefined) Reflect.deleteProperty(globalThis, hook);
\t\t\t\telse globalThis[hook] = previousHook;
\t\t\t}
\t\t\tconst ownsFetch = current !== undefined && (("value" in current && current.value === observedFetch) || (typeof installedDescriptor.get === "function" && current.get === installedDescriptor.get && current.set === installedDescriptor.set));
\t\t\tif (ownsFetch) {
\t\t\t\tif (restoreDescriptor === undefined) Reflect.deleteProperty(globalThis, "fetch");
\t\t\t\telse Object.defineProperty(globalThis, "fetch", restoreDescriptor);
\t\t\t}`],
    ],
  },
  {
    location: 'billion', file: 'billion-context/dist/agent/dsh-native.js',
    before: 'd1cd137d92f7addcf9da6ef57c9d708c0460bebcfa5aae651efbac0a34ecc3d4',
    edits: [['installedDesc=accessor;Object.defineProperty(globalThis,"fetch",accessor)}else{globalThis.fetch=top}', `installedDesc=accessor;Object.defineProperty(globalThis,"fetch",accessor);globalThis[Symbol.for("${broker}")]?.(accessor)}else{globalThis.fetch=top}`]],
  },
];
function replaceOnce(text, before, after, file) {
  if (text.split(before).length !== 2) throw Error('Inspector互操作补丁未唯一命中：' + file);
  return text.replace(before, after);
}
async function atomic(file, bytes) {
  const temporary = file + '.' + randomUUID();
  try { await writeFile(temporary, bytes, {flag: 'wx'}); await rename(temporary, file); }
  finally { await rm(temporary, {force: true}); }
}
/** Preserve full Inspector capture and billion's fetch re-chaining on exact installed versions. */
export async function applyRc1InspectorCompatibility(runtime, {billionRuntime = runtime} = {}) {
  const roots = {core: path.join(runtime, 'node_modules'), billion: path.join(billionRuntime, 'node_modules')};
  const core = JSON.parse(await readFile(path.join(roots.core, '@deepseek-ai/dsh/package.json'), 'utf8'));
  if (core.version !== version) throw Error('Inspector互操作只适用于 DSH rc.1');
  let billion;
  try { billion = JSON.parse(await readFile(path.join(roots.billion, 'billion-context/package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {version, changed: 0, files: [], skipped: 'billion-not-installed'}; throw error; }
  if (core.version !== version || billion.version !== '0.1.212') throw Error('Inspector互操作只适用于 DSH rc.1 和 billion-context 0.1.212');
  const plans = [];
  for (const patch of patches) {
    const file = path.join(roots[patch.location], patch.file), bytes = await readFile(file);
    if (digest(bytes) === patch.before) {
      const after = Buffer.from(patch.edits.reduce((text, [before, after]) => replaceOnce(text, before, after, patch.file), bytes.toString('utf8')));
      plans.push({file, before: bytes, after});
    } else {
      const original = patch.edits.toReversed().reduce((text, [before, after]) => replaceOnce(text, after, before, patch.file), bytes.toString('utf8'));
      if (digest(Buffer.from(original)) !== patch.before) throw Error('Inspector互操作文件有未知改动，未覆盖：' + patch.file);
    }
  }
  const applied = [];
  try {
    for (const plan of plans) {
      if (!(await readFile(plan.file)).equals(plan.before)) throw Error('Inspector互操作文件发生并发修改');
      await atomic(plan.file, plan.after); applied.push(plan);
    }
  } catch (error) {
    for (const plan of applied.reverse()) if ((await readFile(plan.file)).equals(plan.after)) await atomic(plan.file, plan.before);
    throw error;
  }
  return {version, changed: plans.length, files: patches.map(p => p.file)};
}
