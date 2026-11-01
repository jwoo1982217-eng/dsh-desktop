import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkPluginInheritance} from './app/plugin-inheritance.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const plugins = [
  ['dsh-our-free-model', 'vendor/dsh-our-free-model'],
  ['dsh-providers-hub', 'vendor/dsh-codearts-auth'],
];
for (const [name, relative] of plugins) {
  test(`${name}: real reviewed program can inherit itself`, async () => {
    const source = path.join(repo, relative);
    await checkPluginInheritance(name, source, source);
  });
  test(`${name}: unmarked replacement is refused without touching the installed program`, async t => {
    const temporary = await fs.mkdtemp(path.join(process.env.DSH_PLUGIN_TEST_OUTPUT ?? os.tmpdir(), 'dsh-plugin-inheritance-'));
    t.after(() => fs.rm(temporary, {recursive:true, force:true}));
    const installed = path.join(repo, relative);
    const bytes = await fs.readFile(path.join(installed, 'package.json'));
    await fs.writeFile(path.join(temporary, 'package.json'), bytes);
    await assert.rejects(checkPluginInheritance(name, temporary, installed), /缺少定制功能契约/);
    assert.deepEqual(await fs.readFile(path.join(installed, 'package.json')), bytes);
    await checkPluginInheritance(name, installed, installed);
  });
}
