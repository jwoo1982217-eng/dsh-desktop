import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {backendEnvironment} from '../macos/app/backend.mjs';

test('Windows keeps the system search path, locates bundled OpenCode and removes Electron mode', () => {
  const original = {Path: 'C:\\Windows\\System32', PATH: 'D:\\Tools', ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes'};
  const env = backendEnvironment('C:\\Users\\测试用户\\DSH App\\bin\\node.exe', 'D:\\聊天 数据', 'win32', original);
  assert.deepEqual(Object.keys(env).filter(k => k.toLowerCase() === 'path'), ['Path']);
  assert.equal(env.Path, 'C:\\Users\\测试用户\\DSH App\\bin;C:\\Windows\\System32;D:\\Tools');
  assert.equal(env.DSH_OPENCODE_BINARY, 'C:\\Users\\测试用户\\DSH App\\bin\\opencode.exe');
  assert.equal(env.DSH_HOME, 'D:\\聊天 数据');
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.KEEP, 'yes');
  assert.equal(original.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(backendEnvironment('C:\\bin\\node.exe', 'home', 'win32', {DSH_OPENCODE_BINARY: 'D:\\custom.exe'}).DSH_OPENCODE_BINARY, 'D:\\custom.exe');
});

for (const mode of ['request', 'disconnect']) test(`parent ${mode} lets the backend finish its asynchronous cleanup`, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'DSH IPC 测试 '));
  t.after(() => rm(temp, {recursive: true, force: true}));
  const entry = path.join(temp, 'entry.mjs'), receipt = path.join(temp, 'cleaned.txt');
  await writeFile(entry, `import {writeFile} from 'node:fs/promises';
    export async function runCli() {
      if (process.argv[1] !== ${JSON.stringify(entry)}) throw Error('wrong entry argument');
      process.on('SIGTERM', async () => {
        await new Promise(r => setTimeout(r, 70));
        await writeFile(${JSON.stringify(receipt)}, 'disposed'); process.exit(0);
      });
      process.send('ready');
    }`);
  const runner = fileURLToPath(new URL('./backend-runner.mjs', import.meta.url));
  const child = spawn(process.execPath, [runner, entry], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = once(child, 'exit');
  await once(child, 'message');
  if (mode === 'request') child.send({type: 'dsh-desktop-shutdown'});
  else child.disconnect();
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(await readFile(receipt, 'utf8'), 'disposed');
});
