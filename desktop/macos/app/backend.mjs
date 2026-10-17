import {prepareProfileMigration, commitProfileMigration, migrationReceipt, restoreProfileMigration} from './profile-migration.mjs';
import {EventEmitter} from 'node:events';
import {readFile, writeFile, mkdir, rename, rm, lstat, symlink} from 'node:fs/promises';
import {spawn, execFile} from 'node:child_process';
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

export const coreVersion = '0.2.1-alpha.4';
export const statePath = (home, port) => path.join(home, `.desktop-web-${port}.json`);
export function localEntry(value, port) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === port &&
      url.pathname === '/' && !!url.searchParams.get('token') && !url.username && !url.password;
  } catch { return false; }
}

export async function existingBackend(home, port) {
  try {
    const state = JSON.parse(await readFile(statePath(home, port), 'utf8'));
    if (state.home !== home || state.version !== coreVersion || !Number.isInteger(state.pid) || state.pid < 1 || !localEntry(state.url, port)) return null;
    process.kill(state.pid, 0);
    const response = await fetch(state.url, {redirect: 'manual', signal: AbortSignal.timeout(15000)});
    if ([302, 303].includes(response.status)) {
      const location = response.headers.get('location');
      if (!response.headers.get('set-cookie') || !location || new URL(location, state.url).origin !== new URL(state.url).origin) return null;
    } else if (!response.ok || !(await response.text()).includes('__DSH_BOOT__')) return null;
    return state;
  } catch { return null; }
}

async function portOccupied(port) {
  return new Promise(resolve => {
    const socket = createConnection({host: '127.0.0.1', port});
    let done = false;
    const finish = value => { if (!done) { done = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(1500, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
  });
}

export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    await rename(temporary, file);
  } finally { await rm(temporary, {force: true}); }
}

// Only program entry points move. Accounts, chat files, skills and user patches
// stay in DSH_HOME. All replaced entries have a rollback copy.
export async function prepareProfile(home, runtime, {beforeCommit} = {}) {
  const bundle = JSON.parse(await readFile(path.join(runtime, 'bundle.json'), 'utf8'));
  const modules = path.join(runtime, 'node_modules');
  const engine = JSON.parse(await readFile(path.join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
  if (engine.version !== coreVersion) throw Error('安装包内的 DSH 核心版本不匹配。');
  const profile = path.join(home, 'profiles/web'), manifestFile = path.join(profile, 'package.json');
  await mkdir(profile, {recursive: true, mode: 0o700});
  const lock = path.join(home, '.mac-app-install.lock');
  try { await mkdir(lock, {mode: 0o700}); }
  catch (error) { if (error.code === 'EEXIST') throw Error('另一个 DSH 安装过程尚未完成，请稍后重试。'); throw error; }
  let original = null, backup, manifestCommitted = false;
  const swaps = [], created = [];
  let profileMigration, profilePatch;
  try {
    try { original = await readFile(manifestFile, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const manifest = original === null ? structuredClone(bundle.profile) : JSON.parse(original);
    if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw Error('已有 DSH 配置无法识别，已保留原文件。');
    manifest.dependencies ??= {};
    profileMigration = await prepareProfileMigration(profile, modules);
    const names = bundle.plugins.filter(name => original === null || name in manifest.dependencies || manifest.dsh.profile.bundles.includes(name));
    backup = path.join(home, 'backups', `mac-app-${bundle.version}-${randomUUID()}`);
    await mkdir(backup, {recursive: true, mode: 0o700});
    if (original !== null) await writeFile(path.join(backup, 'package.json'), original, {mode: 0o600});
    for (const name of names) {
      const source = path.join(modules, name), target = path.join(profile, 'node_modules', name);
      await readFile(path.join(source, 'package.json'));
      await mkdir(path.dirname(target), {recursive: true});
      const saved = path.join(backup, 'modules', name);
      let existed = false;
      try {
        await lstat(target);
        await mkdir(path.dirname(saved), {recursive: true});
        await rename(target, saved); existed = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      swaps.push({target, saved, existed});
      // Directory junctions work without Developer Mode or administrator rights.
      await symlink(source, target, process.platform === 'win32' ? 'junction' : undefined);
      manifest.dependencies[name] = 'file:' + (process.platform === 'win32' ? source.replaceAll('\\', '/') : source);
    }
    for (const file of ['cordis.yml', 'cordis.patch.yml']) {
      const target = path.join(profile, file);
      try { await writeFile(target, '[]\n', {flag: 'wx', mode: 0o600}); created.push(target); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    await beforeCommit?.();
    let current = null;
    try { current = await readFile(manifestFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== original) throw Error('DSH 配置刚刚发生变化，请重试；原配置已保留。');
    profilePatch = await commitProfileMigration(profileMigration, backup);
    await atomicJson(manifestFile, manifest); manifestCommitted = true;
    await atomicJson(path.join(backup, 'restore.json'), {profile, manifestExisted: original !== null, swaps, profilePatch});
    return {profile, backup, fresh: original === null};
  } catch (error) {
    await restoreProfileMigration(profilePatch);
    for (const {target, saved, existed} of swaps.reverse()) {
      await rm(target, {recursive: true, force: true});
      if (existed) await rename(saved, target);
    }
    for (const file of created) await rm(file, {force: true});
    if (manifestCommitted) {
      if (original === null) await rm(manifestFile, {force: true});
      else await writeFile(manifestFile, original, {mode: 0o600});
    }
    throw error;
  } finally { await rm(lock, {recursive: true, force: true}); }
}

export function redact(value) {
  return value.replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, '$1[已隐藏参数]')
    .replace(/(bearer\s+|(?:token|api[_-]?key|password|cookie|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]');
}

export class Backend extends EventEmitter {
  constructor({home, runtime, node, port = 3080, cwd, log = () => {}}) {
    super(); Object.assign(this, {home: path.resolve(home), runtime, node, port, cwd, log});
    this.child = null; this.owned = false; this.stopping = false;
  }
  async start() {
    const existing = await existingBackend(this.home, this.port);
    if (existing) { this.log('复用已有 DSH 服务'); this.state = existing; return {...existing, reused: true}; }
    if (await portOccupied(this.port)) throw Error('DSH 端口正在使用，但无法安全连接。请先关闭旧 DSH 服务，再点“重新连接”。');
    this.emit('status', '正在准备 DSH…');
    await prepareProfile(this.home, this.runtime);
    this.emit('status', '正在启动 DSH…');
    const env = backendEnvironment(this.node, this.home);
    const entry = path.join(this.runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
    const windows = process.platform === 'win32';
    const launcher = windows ? [path.join(path.dirname(this.node), 'backend-runner.mjs'), entry] : [entry];
    this.child = spawn(this.node, ['--expose-internals', ...launcher, '--profile', 'web', '--host', '127.0.0.1', '--port', String(this.port), '--no-open'],
      {cwd: this.cwd, env, windowsHide: true, stdio: windows ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe']});
    this.owned = true;
    this.log('启动内置 DSH 核心');
    let output = '', diagnostic = '', settled = false;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(Error('DSH 启动超时。请点“重新连接”再试。')), 90000);
      const fail = error => {
        if (settled) return; settled = true; clearTimeout(timer);
        this.log(redact(diagnostic).slice(-4000));
        // A failed launch must not leave a second backend behind on retry.
        void this.stop(); reject(error);
      };
      this.child.once('error', error => fail(Error(`无法启动内置运行环境：${error.message}`)));
      this.child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-12000); });
      this.child.stdout.on('data', bytes => {
        output = (output + bytes.toString()).slice(-32000);
        const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
        if (settled || !match || !localEntry(match[1], this.port)) return;
        settled = true; clearTimeout(timer);
        this.state = {version: coreVersion, home: this.home, pid: this.child.pid, instance: randomUUID(), url: match[1]};
        atomicJson(statePath(this.home, this.port), this.state).then(() => {
          this.log('DSH 已就绪'); resolve({...this.state, reused: false});
        }, error => { void this.stop(); reject(error); });
      });
      this.child.once('exit', (code, signal) => {
        if (!settled) fail(Error(`DSH 启动未完成（${code ?? signal}）。请点“重新连接”再试。`));
        else if (!this.stopping) this.emit('unavailable');
        this.owned = false;
      });
    });
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOwned();
    try { await this.stopPromise; } finally { this.stopPromise = null; }
  }
  async stopOwned() {
    if (!this.child || !this.owned) return;
    this.stopping = true;
    const child = this.child;
    await new Promise(resolve => {
      const timer = setTimeout(() => forceStop(child), 8000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolve(); return; }
      if (process.platform === 'win32' && child.connected) child.send({type: 'dsh-desktop-shutdown'}, error => { if (error) forceStop(child); });
      else child.kill('SIGTERM');
    });
    try {
      const file = statePath(this.home, this.port), state = JSON.parse(await readFile(file, 'utf8'));
      if (state.instance === this.state?.instance) await rm(file, {force: true});
    } catch (error) { if (error.code !== 'ENOENT') this.log('未删除其他进程的启动记录'); }
    this.child = null; this.owned = false;
  }
}


export function backendEnvironment(node, home, platform = process.platform, source = process.env) {
  const env = {...source, DSH_HOME: home};
  delete env.ELECTRON_RUN_AS_NODE;
  if (platform === 'win32') {
    // Windows environment keys are case-insensitive; duplicate PATH/Path drops entries in spawn.
    const keys = Object.keys(env).filter(key => key.toLowerCase() === 'path');
    const original = keys.map(key => env[key]).filter(Boolean).join(';');
    for (const key of keys) delete env[key];
    const bin = path.win32.dirname(node);
    env.Path = [bin, original].filter(Boolean).join(';');
    env.DSH_OPENCODE_BINARY ||= path.win32.join(bin, 'opencode.exe');
  } else env.PATH = [path.dirname(node), '/usr/local/bin', '/opt/homebrew/bin', env.PATH || '/usr/bin:/bin'].join(path.delimiter);
  return env;
}

function forceStop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Only our own backend tree, never an existing CLI service that the UI reused.
    const command = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(command, ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true}, error => { if (error) child.kill('SIGKILL'); });
  } else child.kill('SIGKILL');
}
