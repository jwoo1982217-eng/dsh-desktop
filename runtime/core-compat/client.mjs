import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const clientVersion = '0.2.2-rc.1';
const root = fileURLToPath(new URL('../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const clientFiles = {
  conversation: {name: 'dsh-client-ui-conversation', before: '9a37949cc76603ea3a965ce4d0d6ca65885de4a9808345c38748e595ac396378', after: '0180fb40cb265991814cd0375ac3e3fac399bfa14d01b95836e4b9266cf79e0d'},
  picker: {name: 'dsh-client-ui-model-selection', before: '124c4f0fe80bb7d0c5b2da9bbc071534bfc9a3e96825980c447525eb40f87855', after: '871f041e21df70e3d9f627a0eef19c9b4af395f4bd745c107f4333e7f67c093c'},
  models: {name: 'dsh-client-ui-settings-models', before: 'e111ecefea8262e0426f528864b9681d818068042e93d053bcb0b6884b317278', after: '894d8a2012d55a1c9f35d5f14232a2b3e6a2b3ac7642b39d8d0e11bd5fae2c91'},
  tools: {name: 'dsh-client-ui-tool', before: 'd4b0ee6d04a583f63e5e701de989b7d1645d17d09a85b43338e4a11748ea23ac', after: '6d3a6377dad3c00a9aaa334d4c0b015810ee1664b3ddda23c3603c5ab7fe5b54'},
};
const sourceHashes = {
  'model-picker.jsx': '21eae52d306dd27a8825aa5898bf9673cb2f4eb39d7c696fba4b5f32c0cf1c06',
  'model-picker.css': 'b92258fdac938afb85a405335f3041f1fe562ee5cbe5ae788fc2073e3ffab690',
  'code-progress.jsx': '547b9cc556847eb662941c90a7cc44161454082e272d452eda8704580fec29fa',
  'code-progress.css': '28e316c210729b6bd11136a56c036ec43127a6d01f5ddae2517be8a83317fb61',
};
function replace(text, before, after, count = 1) {
  if (text.split(before).length - 1 !== count) throw Error('rc.1 客户端补丁边界已变化：' + before.slice(0, 90));
  return text.replaceAll(before, after);
}
async function customSource(name) {
  const text = await readFile(path.join(root, 'runtime/client-src', name), 'utf8');
  if (digest(text) !== sourceHashes[name]) throw Error('客户端定制源码发生变化，请重新审核：' + name);
  return text;
}
async function compile(source) {
  const {transform} = createRequire(path.join(root, 'vendor/dsh-codearts-auth/package.json'))('esbuild');
  return (await transform(source, {loader:'jsx', jsxFactory:'react.createElement', jsxFragment:'react.Fragment', target:'es2022'})).code;
}
function region(text, first, next) {
  const start = text.indexOf(first), end = text.indexOf(next, start + first.length);
  if (start < 0 || end < 0 || text.indexOf(first, start + first.length) >= 0) throw Error('rc.1 客户端区块不存在或重复');
  return {start, end, text: text.slice(start, end)};
}
function conversation(text) {
  text = replace(text, '\t\t\t\tevent?.preventDefault();\n\t\t\t\tif (event?.repeat === true) return true;\n\t\t\t\tif (!handlers.canSubmit()) return true;', '\t\t\t\t// 普通 Enter（含软键盘）交给 Lexical 换行；菜单、输入法与快捷发送保留。\n\t\t\t\tif (event === null || !(event.ctrlKey || event.metaKey)) return false;\n\t\t\t\tevent.preventDefault();\n\t\t\t\tif (event.repeat === true) return true;\n\t\t\t\tif (!handlers.canSubmit()) return true;');
  text = replace(text, '"data-composer-input": true,', '"data-composer-input": true,\n\t\t\t\tenterKeyHint: "enter",');
  text = replace(text, '"aria-label": primaryLabel,', '"aria-label": primaryLabel,\n\t\t\t\t\t\t\t\t\t\t\t\t"data-composer-send": primaryStops ? void 0 : true,');
  // Keep rc.1's spinner, cancellation, queued/steering submission and guards intact.
  const input = region(text, '\t\t//#region lib/types/client/skeleton/InputBar.js', '\t\t//#endregion');
  const start = input.text.indexOf('children: primaryStops ?'), end = input.text.lastIndexOf('\n\t\t\t\t\t\t\t\t\t\t\t})');
  if (start < 0 || end < start) throw Error('rc.1 发送按钮边界变化');
  const expressionEnd = input.text.indexOf('\n\t\t\t\t\t\t\t\t\t\t\t\t})\n', start);
  if (expressionEnd < 0) throw Error('rc.1 发送按钮结束边界变化');
  const expression = input.text.slice(start + 'children: '.length, expressionEnd + '\n\t\t\t\t\t\t\t\t\t\t\t\t})'.length);
  const wrapped = `primaryStops ? (${expression}) : (0, react_jsx_runtime.jsxs)("span", {children: [(${expression}), (0, react_jsx_runtime.jsx)("span", {children: t("input.send.button")})]})`;
  const updated = replace(input.text, 'children: ' + expression, 'children: ' + wrapped);
  text = text.slice(0, input.start) + updated + text.slice(input.end);
  text = replace(text, '"input.send": "发送消息",', '"input.send": "发送消息",\n\t\t\t"input.send.button": "发送",');
  text = replace(text, '"input.send": "Send message",', '"input.send": "Send message",\n\t\t\t"input.send.button": "Send",');
  const css = '.uV2eYG_primary[data-composer-send]{width:auto;min-width:68px;padding:0 12px;white-space:nowrap;font:inherit;font-size:13px}.uV2eYG_primary[data-composer-send]>span{display:flex;align-items:center;gap:6px}';
  return text + `\n// DSH rc.1 multiline composer\n{const style=document.createElement('style');style.dataset.pluginCss='dsh-multiline-composer';style.textContent=${JSON.stringify(css)};document.head.querySelector('style[data-plugin-css="dsh-multiline-composer"]')?.remove();document.head.appendChild(style);}\n`;
}
async function picker(text) {
  let source = await customSource('model-picker.jsx');
  source = replace(source, 'function ModelSelect({locked, available, directory, load, select, t}) {', 'function ModelSelect({locked, available, directory, load, select, t, resolveText = value => typeof value === "string" ? value : "", renderSlot = (_, __, options) => options.fallback}) {');
  // rc.1 adds provider badges and an inline label slot. Preserve that official extension point.
  const helper = `\n  const renderModelLabel = (providerId, modelId, placement, selected) => {\n    const group = groups.find(group => group.id === providerId);\n    const model = group?.models.find(model => model.id === modelId);\n    if (!model) return modelId;\n    const provider = {id:group.id, name:group.id === 'deepseek-account' ? t('provider.account') : group.name};\n    const badge = model.badge && <P.Tag className={ModelSelect_module_css_default.badge} tone={model.badge.tone}>{resolveText(model.badge.text)}</P.Tag>;\n    const fallback = !badge ? model.name : <span className={ModelSelect_module_css_default.badgedName}>{placement === 'trigger' && <>{badge} </>}<span className={ModelSelect_module_css_default.badgedNameText}>{model.name}</span>{placement !== 'trigger' && <> {badge}</>}</span>;\n    return <span data-provider-id={provider.id} data-model-id={model.id}>{renderSlot('conversation.input.model.label', {provider,model,placement,selected}, {fallback})}</span>;\n  };\n`;
  source = replace(source, '  const currentGroup = groups.find', helper + '  const currentGroup = groups.find');
  source = replace(source, '>{modelLabel}</span>', '>{currentModel ? renderModelLabel(currentGroup.id, currentModel.id, "trigger", true) : modelLabel}</span>');
  source = replace(source, '<span title={modelLabel}>{modelLabel}<small>', '<span title={modelLabel}>{currentModel ? renderModelLabel(currentGroup.id, currentModel.id, "menu", true) : modelLabel}<small>');
  source = replace(source, '<span>{row.name}</span><small>', '<span>{renderModelLabel(row.provider, row.model, "option", !!row.selected)}</span><small>');
  source = replace(source, 'const row = {provider: group.id, providerName: group.name, model: model.id, name: model.name};', 'const row = {provider: group.id, providerName: group.name, model: model.id, name: model.name ?? model.id};');
  const bounds = region(text, '\t\t//#region lib/types/client/ModelSelect.js', '\t\t//#region lib/types/client/locales.js');
  const css = await customSource('model-picker.css');
  const replacement = `\t\t//#region lib/types/client/ModelSelect.js\n// DSH rc.1 model picker\n${await compile(source)}\n{const style=document.createElement('style');style.dataset.pluginCss='dsh-model-picker';style.textContent=${JSON.stringify(css)};document.head.querySelector('style[data-plugin-css="dsh-model-picker"]')?.remove();document.head.appendChild(style);}\n\t\t//#endregion\n`;
  return text.slice(0, bounds.start) + replacement + text.slice(bounds.end);
}
function models(text) {
  text = replace(text, 'pendingLoads = /* @__PURE__ */ new Set();', 'pendingLoads = /* @__PURE__ */ new Set();\n\t\t\taccountCatalogRead;');
  const blocking = '\t\t\t\tif (rows.some((row) => row.entry.provider === "deepseek-account")) {\n\t\t\t\t\tconst catalog = await this.ctx.remote.session.modelCatalog();\n\t\t\t\t\tfor (const row of rows) if (row.entry.provider === "deepseek-account") row.accountAvailable = catalog.ok && catalog.value.groups.some((group) => group.id === "deepseek-account" && group.models.length > 0);\n\t\t\t\t}\n';
  text = replace(text, blocking, '');
  const background = `\t\t\t\tthis.refreshAccountAvailability(rows, generation);\n\t\t\t}\n\t\t\trefreshAccountAvailability(rows, generation) {\n\t\t\t\tconst account = rows.find((row) => row.entry.provider === "deepseek-account");\n\t\t\t\tif (account === void 0) return;\n\t\t\t\tif (this.accountCatalogRead === void 0) {\n\t\t\t\t\tconst operation = Promise.resolve().then(() => this.ctx.remote.session.modelCatalog()).finally(() => {\n\t\t\t\t\t\tif (this.accountCatalogRead === operation) this.accountCatalogRead = void 0;\n\t\t\t\t\t});\n\t\t\t\t\tthis.accountCatalogRead = operation;\n\t\t\t\t}\n\t\t\t\tthis.accountCatalogRead.then((catalog) => {\n\t\t\t\t\tif (generation !== this.generation || !catalog.ok) return;\n\t\t\t\t\tconst available = catalog.value.groups.some((group) => group.id === "deepseek-account" && group.models.length > 0);\n\t\t\t\t\tthis.store.update((s) => {\n\t\t\t\t\t\tconst next = s.rows.filter((row) => row.entry.provider !== "deepseek-account");\n\t\t\t\t\t\tif (available) next.unshift({ ...account, accountAvailable: true });\n\t\t\t\t\t\ts.rows = next;\n\t\t\t\t\t});\n\t\t\t\t}).catch(() => {});\n\t\t\t}\n`;
  text = replace(text, '\t\t\t}\n\t\t\t/** Settle callers only while this read still owns the current refresh. */', background + '\t\t\t/** Settle callers only while this read still owns the current refresh. */');
  const refresh = `\t\tfunction refreshDiscoveredModel(current, candidate) {\n\t\t\tif (current === void 0) return adopt(candidate);\n\t\t\tif (Array.isArray(current.input) && current.input.length > 0) return current;\n\t\t\tif (!Array.isArray(candidate.inputModalities) || candidate.inputModalities.length === 0) return current;\n\t\t\treturn { ...current, input: [...candidate.inputModalities] };\n\t\t}\n`;
  text = replace(text, '\t\tfunction ModelListEditor(props) {', refresh + '\t\tfunction ModelListEditor(props) {');
  // Keep rc.1's add/remove/reorder model editor; refresh only selected existing entries.
  text = replace(text, 'const keptRows = models.filter((_model, at) => !removedRows.has(at));', 'const candidateById = new Map(activeCandidates.map(candidate => [candidate.id, candidate]));\n\t\t\tconst keptRows = models.filter((_model, at) => !removedRows.has(at)).map(model => {\n\t\t\t\tconst candidate = candidateById.get(textOf(model, "id"));\n\t\t\t\treturn candidate && isPicked(candidate.id) ? refreshDiscoveredModel(model, candidate) : model;\n\t\t\t});');
  // rc.1 has its own initial-loading/error branches. Add the loading announcement there,
  // preserving its retry screen and the rule that background refreshes keep open drafts.
  const early = region(text, '\t\t\tif (!hasReadySnapshot && state.status !== "ready")', '\t\t\tconst savedRow');
  const loading = replace(early.text, '\t\t\t\t})]', '\t\t\t\t}), (0, react_jsx_runtime.jsx)("p", {role:"status", children:t("loadingModels")})]');
  text = text.slice(0, early.start) + loading + text.slice(early.end);
  text = replace(text, 'title: "Models",', 'title: "Models",\n\t\t\tloadingModels: "Loading saved model providers…",');
  text = replace(text, 'title: "模型",', 'title: "模型",\n\t\t\tloadingModels: "正在读取本机模型配置…",');
  return text;
}
async function tools(text) {
  const css = await customSource('code-progress.css');
  const injection = `// DSH CODE PROGRESS BEGIN\n${await compile(await customSource('code-progress.jsx'))}\n{const style=document.createElement('style');style.dataset.pluginCss='dsh-code-progress';style.textContent=${JSON.stringify(css)};document.head.querySelector('style[data-plugin-css="dsh-code-progress"]')?.remove();document.head.appendChild(style);}\n// DSH CODE PROGRESS END\n`;
  text = replace(text, '//#region lib/types/client/apply.js', injection + '//#region lib/types/client/apply.js');
  text = replace(text, '}, BashRow))', '}, DshProgressBashRow))');
  return replace(text, '}, FileMutationRow);', '}, DshProgressFileRow);', 3);
}
/** Pure audited transformation, useful for checking target blocks against published rc.1 bytes. */
export async function buildRc1ClientFile(kind, original) {
  if (!clientFiles[kind] || digest(original) !== clientFiles[kind].before) throw Error('不是已审核的原始 rc.1 客户端：' + kind);
  return ({conversation, picker, models, tools})[kind](original.toString());
}
/** Preflight every target before any write; atomic replacement avoids mutating pnpm store hard links. */
export async function applyRc1ClientCompatibility(runtime) {
  const modules = path.join(runtime, 'node_modules');
  if (JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'))).version !== clientVersion) throw Error('客户端兼容层只适用于 DSH ' + clientVersion);
  const plans = [];
  for (const [kind, spec] of Object.entries(clientFiles)) {
    const base = path.join(modules, '@deepseek-ai', spec.name);
    if (JSON.parse(await readFile(path.join(base, 'package.json'))).version !== clientVersion) throw Error('客户端包版本不匹配：' + spec.name);
    const file = path.join(base, 'lib/client.js'), before = await readFile(file), hash = digest(before);
    if (hash === spec.after) continue;
    if (hash !== spec.before) throw Error('客户端文件有未知改动，未覆盖：' + spec.name);
    const after = Buffer.from(await buildRc1ClientFile(kind, before));
    if (digest(after) !== spec.after) throw Error('客户端编译结果变化，未写入：' + spec.name);
    plans.push({file, before, after});
  }
  const applied = [];
  const atomic = async (file, bytes) => {
    const temporary = file + '.' + randomUUID();
    try {await writeFile(temporary, bytes, {flag:'wx'}); await rename(temporary, file);}
    finally {await rm(temporary, {force:true});}
  };
  try {
    for (const plan of plans) {
      if (!(await readFile(plan.file)).equals(plan.before)) throw Error('客户端文件发生并发修改，停止移植');
      await atomic(plan.file, plan.after); applied.push(plan);
    }
  } catch (error) {
    for (const plan of applied.reverse()) if ((await readFile(plan.file)).equals(plan.after)) await atomic(plan.file, plan.before);
    throw error;
  }
  return {version:clientVersion, changed:plans.length, files:Object.values(clientFiles).map(spec => '@deepseek-ai/' + spec.name + '/lib/client.js')};
}
