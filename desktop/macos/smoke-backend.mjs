import {mkdtemp, writeFile, readFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import path from 'node:path';
import {Backend} from './app/backend.mjs';

const resources = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
const directory = await mkdtemp(path.join(tmpdir(), 'DSH app standalone '));
const home = path.join(directory, 'user home'), runtime = path.join(resources, 'runtime');
await mkdir(home);
await writeFile(path.join(home, 'user-data-preserved.txt'), 'existing user material');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const backend = new Backend({home, runtime, node: path.join(resources, 'bin/node'), port, cwd: directory,
  log: value => console.log(value)});
const result = {standaloneResources: resources, sourceCheckoutUsedAsCwd: false, freshHome: true, cloudInferenceRequests: 0};
async function document(entry) {
  const bootstrap = await fetch(entry, {redirect: 'manual', signal: AbortSignal.timeout(30000)});
  if ([302, 303].includes(bootstrap.status)) {
    const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    return fetch(new URL(bootstrap.headers.get('location'), entry), {headers: {cookie}, signal: AbortSignal.timeout(30000)});
  }
  return bootstrap;
}
try {
  const state = await backend.start();
  result.coldStarted = !state.reused;
  const response = await document(state.url);
  result.documentStatus = response.status;
  result.hasDshDocument = (await response.text()).includes('__DSH_BOOT__');
  const second = new Backend({home, runtime, node: path.join(resources, 'bin/node'), port, cwd: directory});
  const reused = await second.start();
  result.reusedSamePid = reused.reused && reused.pid === state.pid;
  await second.stop();
  result.borrowedServiceSurvived = (await document(state.url)).ok;
  result.userMaterialPreserved = await readFile(path.join(home, 'user-data-preserved.txt'), 'utf8') === 'existing user material';
  await backend.stop();
  result.ownedServiceStopped = await fetch(state.url, {signal: AbortSignal.timeout(1000)}).then(() => false, () => true);
  const restart = new Backend({home, runtime, node: path.join(resources, 'bin/node'), port, cwd: directory});
  const restarted = await restart.start();
  result.restartSucceeded = !restarted.reused && (await document(restarted.url)).ok;
  await restart.stop();
  result.passed = result.coldStarted && result.hasDshDocument && result.reusedSamePid && result.borrowedServiceSurvived &&
    result.userMaterialPreserved && result.ownedServiceStopped && result.restartSucceeded;
  if (!result.passed) throw Error('独立启动验收未全部通过');
} catch (error) {
  result.passed = false; result.error = error.message;
  // Keep only the isolated home for diagnosis. No personal accounts are used.
  result.isolatedHome = home;
  throw error;
} finally {
  await backend.stop();
  await writeFile(evidence, JSON.stringify(result, null, 2));
  if (result.passed) await rm(directory, {recursive: true, force: true});
}
