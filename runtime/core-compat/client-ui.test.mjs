// Run the existing acceptance cases against rc.1 without overwriting alpha.4 overlays.
// Usage: DSH_RC1_RUNTIME=/registered/generated/core node runtime/core-compat/client-ui.test.mjs /registered/generated/client-tests
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = process.env.DSH_RC1_RUNTIME;
const report = process.argv[2];
if (!runtime || !report || !path.isAbsolute(runtime) || !path.isAbsolute(report)) throw Error('Provide an isolated rc.1 runtime and registered generated/ report directory');
assert.equal(JSON.parse(await readFile(path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))).version, '0.2.2-rc.1');
await mkdir(report, {recursive:true});
const cases = (process.env.DSH_RC1_CLIENT_CASES ?? 'composer-newline,model-picker-ui,code-progress-ui,model-settings-loading-ui,jethub-model-refresh-ui').split(',');
for (const name of cases) if (!['composer-newline','model-picker-ui','code-progress-ui','model-settings-loading-ui','jethub-model-refresh-ui'].includes(name)) throw Error('Unknown acceptance case');
for (const name of cases) {
  let source = await readFile(path.join(root, 'scripts', name + '.test.mjs'), 'utf8');
  source = source.replaceAll("'./frontend-test-assets.mjs'", JSON.stringify(pathToFileURL(path.join(root, 'scripts/frontend-test-assets.mjs')).href));
  source = source.replaceAll("from './build-code-progress.mjs'", `from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/build-code-progress.mjs')).href)}`);
  source = source.replaceAll("fileURLToPath(new URL('../',import.meta.url))", JSON.stringify(root));
  source = source.replaceAll("fileURLToPath(new URL('../', import.meta.url))", JSON.stringify(root));
  source = source.replaceAll("path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')", JSON.stringify(root));
  source = source.replaceAll("path.join(root,'runtime/overlays/", "path.join(rcRuntime,'node_modules/");
  source = source.replaceAll("path.join(root, 'runtime/overlays/", "path.join(rcRuntime, 'node_modules/");
  source = source.replaceAll("path.join(root,'desktop-runtime/node_modules/", "path.join(rcRuntime,'node_modules/");
  source = source.replaceAll("path.join(root, 'desktop-runtime/node_modules/", "path.join(rcRuntime, 'node_modules/");
  source = source.replace("const runtime = path.join(root, root.includes('dsh-phone-public') ? 'runtime' : 'desktop-runtime');", 'const runtime = rcRuntime;');
  source = source.replace("const marker = 'function ModelSelect({ locked, available, directory, load, select, t }) {';", `const marker = ${JSON.stringify('function ModelSelect({ locked, available, directory, load, select, t, resolveText = (value) => typeof value === "string" ? value : "", renderSlot = (_, __, options) => options.fallback }) {')};`);
  if (name === 'composer-newline') {
    source = source.replace('Tooltip: ({children}) => children,', 'Tooltip: ({children}) => children, HoverCardGroup: ({children,...props}) => React.createElement(\'div\',props,children),');
    source = source.replace("await update({locked:false,phase:'submitting'}); assert.equal(await send.isDisabled(),true);", "await update({locked:false,phase:'submitting'}); assert.equal(await send.isDisabled(),true);await update({phase:'sending'});assert.equal(await send.isDisabled(),true);assert.equal(await send.getAttribute('aria-busy'),'true');assert.equal(await send.locator('circle').count(),1);assert.equal(await page.getByRole('button',{name:'停止',exact:true}).count(),1);");
    source = source.replace('useNotices:s=>s(null),', 'useAccess:()=>undefined,useNotices:s=>s(null),');
    source = source.replace('useAnchoredPosition: () => ({}), useDismissOnOutsidePointer: () => {}', 'useAnchoredPosition: () => ({}), useDismissOnOutsidePointer: () => {}, isMobileDevice:()=>false, focusWithoutRing:(element,options)=>element.focus(options)');
  }
  if (name === 'code-progress-ui') {
    source = source.replace("useDisclosure,t}", "useDisclosure,useContextMenu:()=>({getTriggerProps:()=>({})}),resolveFilePath:path=>path,t}");
  }
  if (name === 'model-picker-ui') {
    source = source.replace('window.calls=[];', "groups[0].models[0].badge={text:{zh:'官方标记'},tone:'info'};window.labelSlots=[];window.calls=[];");
    source = source.replace('locked:false,available:true,directory:window.store,t,load:', "locked:false,available:true,directory:window.store,t,resolveText:()=> '官方标记',renderSlot:(seat,owner,options)=>{window.labelSlots.push({seat,placement:owner.placement,provider:owner.provider.id,model:owner.model.id});return options.fallback;},load:");
    source = source.replace('await open();assert.equal(await rows.count(),totalModels);', "await open();assert.equal(await rows.count(),totalModels);assert.equal(await page.getByText('官方标记',{exact:true}).count(),1);assert.equal(await page.evaluate(()=>window.labelSlots.some(x=>x.seat==='conversation.input.model.label'&&x.placement==='trigger')),true);assert.equal(await page.evaluate(()=>window.labelSlots.some(x=>x.seat==='conversation.input.model.label'&&x.placement==='menu')),true);assert.equal(await page.evaluate(()=>window.labelSlots.some(x=>x.seat==='conversation.input.model.label'&&x.placement==='option')),true);");
  }
  if (name === 'jethub-model-refresh-ui') {
    // rc.1 deliberately leaves NEW models unchecked when refreshing an existing list.
    source = source.replace("await dialog.getByRole('button',{name:'应用所选',exact:true}).click();", "await dialog.locator('label').filter({hasText:'fixture/new-image'}).getByRole('checkbox').check();await dialog.getByRole('button',{name:'应用所选',exact:true}).click();");
  }
  const fixture = path.join(report, name + '.test.mjs');
  await writeFile(fixture, `const rcRuntime=${JSON.stringify(runtime)};\n` + source);
  await mkdir(path.join(report, name), {recursive:true});
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, path.join(report, name)], {cwd:root, env:process.env, stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', data => {stdout += data; process.stdout.write(data);});
    child.stderr.on('data', data => {stderr += data; process.stderr.write(data);});
    child.on('error', reject); child.on('close', code => resolve({name, code, stdout, stderr}));
  });
  await writeFile(path.join(report, name + '-run.json'), JSON.stringify(result,null,2));
  assert.equal(result.code, 0, name + ' rc.1 acceptance failed');
}
console.log('All rc.1 client acceptance cases passed');
