import {prepareProfileMigration, commitProfileMigration, migrationReceipt, restoreProfileMigration} from './profile-migration.mjs';
import {checkPluginInheritance} from './plugin-inheritance.mjs';
import {EventEmitter} from 'node:events';
import {readFile, writeFile, mkdir, rename, rm, lstat, symlink} from 'node:fs/promises';
import {spawn, execFile} from 'node:child_process';
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

export const coreVersion = '0.2.1-alpha.4';
export const startupTimeoutMs = 240000;
export const statePath = (home, port) => path.join(home, `.desktop-web-${port}.json`);
export function localEntry(value, port) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) === port &&
      url.pathname === '/' && !!url.searchParams.get('token') && !url.username && !url.password;
  } catch { return false; }
}

export async function existingBackend(home, port, {signal} = {}) {
  try {
    const state = JSON.parse(await readFile(statePath(home, port), 'utf8'));
    if (state.starting === true || state.home !== home || state.version !== coreVersion || !Number.isInteger(state.pid) || state.pid < 1 || !localEntry(state.url, port)) return null;
    process.kill(state.pid, 0);
    const response = await fetch(state.url, {redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)});
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
    for (const name of names) await checkPluginInheritance(name,
      path.join(modules, name), path.join(profile, 'node_modules', name));
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

async function backendRecord(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {raw: null, state: null}; throw error; }
  return {raw, state: JSON.parse(raw)};
}

function validStarting(state, home, now = Date.now()) {
  if (state?.starting !== true || state.home !== home || state.version !== coreVersion ||
      !Number.isInteger(state.pid) || state.pid < 1 || typeof state.instance !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,160}$/.test(state.instance) || 'url' in state ||
      !Number.isFinite(state.startedAt) || !Number.isFinite(state.deadline) ||
      state.startedAt > now || state.deadline <= now || state.deadline <= state.startedAt ||
      state.deadline - state.startedAt > startupTimeoutMs) return false;
  try { process.kill(state.pid, 0); return true; } catch { return false; }
}

// Check the exact previous record immediately before the atomic replacement.
// A launch may only replace its own starting record, never a newer owner's state.
async function publishBackendRecord(file, value, expected) {
  const temporary = `${file}.${randomUUID()}`;
  const raw = JSON.stringify(value, null, 2) + '\n';
  try {
    await writeFile(temporary, raw, {mode: 0o600, flag: 'wx'});
    if ((await backendRecord(file)).raw !== expected) throw Error('DSH 启动记录已变化，已保留其他服务的记录。');
    await rename(temporary, file);
    return raw;
  } finally { await rm(temporary, {force: true}); }
}

export class Backend extends EventEmitter {
  constructor({home, runtime, node, port = 3080, cwd, log = () => {}, _startupTimeoutMs = startupTimeoutMs, _startupStatusIntervalMs = 5000}) {
    super(); Object.assign(this, {home: path.resolve(home), runtime, node, port, cwd, log});
    // Private timing overrides let lifecycle tests use real subprocesses without a four-minute wait.
    if (!Number.isFinite(_startupTimeoutMs) || _startupTimeoutMs <= 0 || _startupTimeoutMs > startupTimeoutMs || !Number.isFinite(_startupStatusIntervalMs) || _startupStatusIntervalMs <= 0) throw Error('启动等待时间必须为正数且不超过 240 秒。');
    this.startupTimeoutMs = _startupTimeoutMs; this.startupStatusIntervalMs = _startupStatusIntervalMs;
    this.child = null; this.owned = false; this.stopping = false;
  }
  startupStatus(startedAt, budget) {
    this.emit('status', `正在启动 DSH…已等待 ${Math.floor((Date.now() - startedAt) / 1000)} 秒，最多 ${Math.ceil(budget / 1000)} 秒。`);
  }
  async reuseStarting(marker) {
    if (!validStarting(marker, this.home)) throw Error('DSH 启动记录已失效或无法识别，已保留原记录。请稍后重新连接。');
    const deadline = Math.min(marker.deadline, Date.now() + this.startupTimeoutMs);
    const controller = new AbortController();
    return await new Promise((resolve, reject) => {
      let settled = false, poll;
      const finish = (error, state) => {
        if (settled) return; settled = true;
        clearTimeout(timer); clearTimeout(poll); clearInterval(progress); controller.abort();
        if (this.cancelStartup === cancel) this.cancelStartup = null;
        if (error) reject(error);
        else { this.state = state; this.log('复用已有 DSH 服务'); resolve({...state, reused: true}); }
      };
      const cancel = () => finish(Error('DSH 启动已取消。'));
      const timer = setTimeout(() => finish(Error('DSH 启动超时。请点“重新连接”再试。')), Math.max(1, deadline - Date.now()));
      const progress = setInterval(() => this.startupStatus(marker.startedAt, marker.deadline - marker.startedAt), this.startupStatusIntervalMs);
      progress.unref?.(); this.cancelStartup = cancel;
      this.startupStatus(marker.startedAt, marker.deadline - marker.startedAt);
      const check = async () => {
        try {
          const {state} = await backendRecord(statePath(this.home, this.port));
          if (settled) return;
          if (state?.instance !== marker.instance || state.pid !== marker.pid || state.home !== this.home || state.version !== coreVersion) throw Error('DSH 启动记录已变化，已保留其他服务的记录。');
          process.kill(marker.pid, 0);
          if (state.starting === true) {
            if (!validStarting(state, this.home) || state.startedAt !== marker.startedAt || state.deadline !== marker.deadline) throw Error('DSH 启动记录已失效或无法识别。');
          } else {
            const ready = await existingBackend(this.home, this.port, {signal: controller.signal});
            if (settled) return;
            const current = (await backendRecord(statePath(this.home, this.port))).state;
            if (!ready || ready.instance !== marker.instance || ready.pid !== marker.pid || current?.instance !== marker.instance || current.url !== ready.url) throw Error('DSH 服务尚未通过安全连接验证。请重新连接。');
            finish(null, ready); return;
          }
          if (!settled) poll = setTimeout(check, Math.min(250, this.startupStatusIntervalMs));
        } catch (error) { finish(error); }
      };
      void check();
    });
  }
  async start() {
    if (this.stopPromise) await this.stopPromise;
    this.stopping = false;
    const file = statePath(this.home, this.port);
    let record = await backendRecord(file);
    const existing = await existingBackend(this.home, this.port);
    if (existing) { this.log('复用已有 DSH 服务'); this.state = existing; return {...existing, reused: true}; }
    if (record.state?.starting === true) return await this.reuseStarting(record.state);
    if (await portOccupied(this.port)) {
      // The owner may have published its marker while the port probe was pending.
      record = await backendRecord(file);
      if (record.state?.starting === true) return await this.reuseStarting(record.state);
      throw Error('DSH 端口正在使用，但无法安全连接。请先关闭旧 DSH 服务，再点“重新连接”。');
    }
    this.emit('status', '正在准备 DSH…');
    await prepareProfile(this.home, this.runtime);
    const current = await backendRecord(file);
    if (current.raw !== record.raw) {
      if (current.state?.starting === true) return await this.reuseStarting(current.state);
      const ready = await existingBackend(this.home, this.port);
      if (ready) { this.state = ready; return {...ready, reused: true}; }
      throw Error('DSH 启动记录已变化，已保留其他服务的记录。');
    }
    this.emit('status', '正在启动 DSH…');
    const env = backendEnvironment(this.node, this.home);
    const entry = path.join(this.runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
    const windows = process.platform === 'win32';
    const launcher = windows ? [path.join(path.dirname(this.node), 'backend-runner.mjs'), entry] : [entry];
    this.child = spawn(this.node, ['--expose-internals', ...launcher, '--profile', 'web', '--host', '127.0.0.1', '--port', String(this.port), '--no-open'],
      {cwd: this.cwd, env, windowsHide: true, stdio: windows ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe']});
    this.owned = true;
    const child = this.child, startedAt = Date.now();
    this.state = {starting: true, version: coreVersion, home: this.home, pid: child.pid, instance: randomUUID(), startedAt, deadline: startedAt + this.startupTimeoutMs};
    this.log('启动内置 DSH 核心');
    let output = '', diagnostic = '', settled = false, publishing = false;
    return await new Promise((resolve, reject) => {
      const clearStartup = () => {
        clearTimeout(timer); clearInterval(progress);
        if (this.cancelStartup === cancel) this.cancelStartup = null;
      };
      const fail = (error, stopChild = true) => {
        if (settled) return; settled = true; clearStartup();
        this.log(redact(diagnostic).slice(-4000));
        // A failed launch must not leave a second backend behind on retry.
        if (stopChild) void this.stop();
        reject(error);
      };
      const cancel = () => fail(Error('DSH 启动已取消。'), false);
      const timer = setTimeout(() => fail(Error('DSH 启动超时。请点“重新连接”再试。')), this.startupTimeoutMs);
      const progress = setInterval(() => { if (!settled) this.startupStatus(startedAt, this.startupTimeoutMs); }, this.startupStatusIntervalMs);
      progress.unref?.(); this.cancelStartup = cancel;
      const publication = Number.isInteger(child.pid) ? publishBackendRecord(file, this.state, record.raw) : Promise.reject(Error('无法启动内置运行环境。'));
      this.stateCommit = publication;
      publication.catch(error => fail(error));
      child.once('error', error => fail(Error(`无法启动内置运行环境：${error.message}`)));
      child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-12000); });
      child.stdout.on('data', bytes => {
        output = (output + bytes.toString()).slice(-32000);
        const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
        if (settled || publishing || !match || !localEntry(match[1], this.port)) return;
        publishing = true;
        const state = {version: coreVersion, home: this.home, pid: child.pid, instance: this.state.instance, url: match[1]};
        const commit = publication.then(async expected => {
          if (settled || this.stopping || this.child !== child) throw Error('DSH 启动已取消。');
          await publishBackendRecord(file, state, expected);
        });
        this.stateCommit = commit;
        commit.then(() => {
          if (settled) return;
          if (this.stopping || this.child !== child) { fail(Error('DSH 启动已取消。')); return; }
          settled = true; clearStartup(); this.state = state;
          this.log('DSH 已就绪'); resolve({...state, reused: false});
        }, error => fail(error));
      });
      child.once('exit', (code, signal) => {
        if (!settled) fail(Error(`DSH 启动未完成（${code ?? signal}）。请点“重新连接”再试。`));
        else if (!this.stopping) { this.emit('unavailable'); void this.stop(); }
        if (this.child === child) this.owned = false;
      });
    });
  }
  async stop() {
    this.cancelStartup?.();
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOwned();
    try { await this.stopPromise; } finally { this.stopPromise = null; }
  }
  async stopOwned() {
    if (!this.child) return;
    this.stopping = true;
    const child = this.child;
    await new Promise(resolve => {
      const timer = setTimeout(() => forceStop(child), 8000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolve(); return; }
      if (process.platform === 'win32' && child.connected) child.send({type: 'dsh-desktop-shutdown'}, error => { if (error) forceStop(child); });
      else child.kill('SIGTERM');
    });
    await this.stateCommit?.catch(() => {});
    try {
      const file = statePath(this.home, this.port), {state} = await backendRecord(file);
      if (state?.instance === this.state?.instance && state.pid === child.pid && state.home === this.home && state.version === coreVersion) await rm(file, {force: true});
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
