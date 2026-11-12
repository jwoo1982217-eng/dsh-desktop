import path from 'node:path';
import {constants} from 'node:fs';
import {mkdir, lstat, realpath, open, link, rename, unlink, rmdir} from 'node:fs/promises';
import {randomUUID, createHash} from 'node:crypto';
import {WorkbenchError, asWorkbenchError, createPathPolicy, directoryIdentity, identityOfDirectory, sameIdentity, checkAbort} from './paths.mjs';

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_SHARED = 64;
const MAX_WORKSPACES = 256;
const PLAN_TTL_MS = 60_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const ordinary = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => ordinary(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validIdentity = value => value === null || exactKeys(value, ['dev', 'ino']) && /^\d{1,30}$/.test(value.dev) && /^\d{1,30}$/.test(value.ino);
const labelOf = (value, fallback) => {
  const label = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!label || label.length > 100 || /[\x00-\x1f\x7f]/.test(label)) throw new WorkbenchError('invalid-root', '目录名称无效');
  return label;
};
const workspaceLabel = (value, fallback = '项目工作区') => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 100) || fallback : fallback;

async function privateDirectory(target, {create = false} = {}) {
  if (create) {
    try { await mkdir(target, {mode: 0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = await lstat(target, {bigint: true});
  if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(target) !== target || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) throw new WorkbenchError('unavailable', '文件工作台的私有状态目录不可用，已保留原件', 503);
  return stat;
}

async function readState(target) {
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat({bigint: true});
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_STATE_BYTES) || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) throw new WorkbenchError('unavailable', '目录映射记录不可用，已保留原件', 503);
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_STATE_BYTES) throw new WorkbenchError('unavailable', '目录映射记录过大，已保留原件', 503);
    return buffer.subarray(0, length);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

function validateState(value, policy) {
  if (!exactKeys(value, ['schema', 'revision', 'internal', 'shared', 'workspaces']) || value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.shared) || value.shared.length > MAX_SHARED || !Array.isArray(value.workspaces) || value.workspaces.length > MAX_WORKSPACES) throw new WorkbenchError('unavailable', '目录映射记录格式无效，已保留原件', 503);
  const seen = new Set();
  for (const record of [value.internal, ...value.shared, ...value.workspaces]) {
    if (!exactKeys(record, ['id', 'kind', 'label', 'path', 'mode', 'generation', 'identity']) ||
        !['internal', 'shared', 'workspace'].includes(record.kind) || !['read-only', 'read-write'].includes(record.mode) ||
        typeof record.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(record.id) || seen.has(record.id) ||
        typeof record.generation !== 'string' || !/^[a-f0-9-]{16,100}$/.test(record.generation) ||
        typeof record.path !== 'string' || !path.isAbsolute(record.path) || path.resolve(record.path) !== record.path || !validIdentity(record.identity)) throw new WorkbenchError('unavailable', '目录映射记录格式无效，已保留原件', 503);
    labelOf(record.label, '目录');
    if (record.kind === 'internal') {
      if (record !== value.internal || record.id !== 'internal' || record.path !== policy.internal || record.mode !== 'read-write' || record.identity === null) throw new WorkbenchError('unavailable', '内部文件区记录无效，已保留原件', 503);
    } else {
      if (record.kind === 'shared' && !record.id.startsWith('shared:') || record.kind === 'workspace' && !record.id.startsWith('workspace:')) throw new WorkbenchError('unavailable', '目录映射身份无效，已保留原件', 503);
      policy.validateRoot(record.path);
    }
    seen.add(record.id);
  }
  if (value.shared.some(value => value.kind !== 'shared') || value.workspaces.some(value => value.kind !== 'workspace')) throw new WorkbenchError('unavailable', '目录映射类型无效，已保留原件', 503);
  return value;
}

export class RootRegistry {
  constructor({home, workspaceRegistry, clock = Date.now}) {
    if (typeof home !== 'string' || !path.isAbsolute(home)) throw new WorkbenchError('unavailable', 'DSH数据目录尚未就绪', 503);
    this.requestedHome = path.resolve(home);
    this.workspaceRegistry = workspaceRegistry;
    this.clock = clock;
    this.plans = new Map();
    this.tail = Promise.resolve();
    this.closed = false;
    this.ready = this.initialize();
    this.ready.catch(() => {});
  }

  async initialize() {
    const home = await realpath(this.requestedHome);
    const homeStat = await lstat(home);
    if (!homeStat.isDirectory()) throw new WorkbenchError('unavailable', 'DSH数据目录尚未就绪', 503);
    this.policy = createPathPolicy(home);
    const storage = path.join(home, 'storage');
    await privateDirectory(storage, {create: true});
    this.control = path.join(storage, 'desktop-files');
    await privateDirectory(this.control, {create: true});
    this.controlIdentity = await identityOfDirectory(this.control);
    this.file = path.join(this.control, 'roots.json');
    const bytes = await readState(this.file);
    this.diskHash = bytes === null ? null : hash(bytes);
    if (bytes === null) {
      await privateDirectory(this.policy.internal, {create: true});
      const identity = await identityOfDirectory(this.policy.internal);
      const state = {schema: 1, revision: 1, internal: {id: 'internal', kind: 'internal', label: 'DSH内部文件区', path: this.policy.internal, mode: 'read-write', generation: randomUUID(), identity}, shared: [], workspaces: []};
      await this.persist(state);
    } else {
      let parsed;
      try { parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
      catch { throw new WorkbenchError('unavailable', '目录映射记录不可读取，已保留原件', 503); }
      this.state = validateState(parsed, this.policy);
    }
  }

  async assertControl() {
    const identity = await identityOfDirectory(this.control);
    if (!sameIdentity(identity, this.controlIdentity)) throw new WorkbenchError('unavailable', '目录映射的状态目录已变化，请重新打开工作台', 503);
  }

  async assertCurrent() {
    await this.assertControl();
    const bytes = await readState(this.file);
    if (bytes === null || hash(bytes) !== this.diskHash) throw new WorkbenchError('config-changed', '目录映射配置有并发变更，请重新打开工作台', 409);
  }

  async persist(state) {
    validateState(state, this.policy);
    await this.assertControl();
    const encoded = Buffer.from(JSON.stringify(state) + '\n');
    if (encoded.length > MAX_STATE_BYTES) throw new WorkbenchError('too-large', '目录映射数量已达上限', 413);
    const lock = path.join(this.control, 'roots.lock');
    try { await mkdir(lock, {mode: 0o700}); }
    catch (error) {
      if (error.code === 'EEXIST') throw new WorkbenchError('busy', '另一个目录映射操作尚未结束，请稍后重试', 409);
      throw error;
    }
    const temporary = path.join(this.control, `.roots-${randomUUID()}.tmp`);
    let handle;
    try {
      const before = await readState(this.file);
      if ((before === null ? null : hash(before)) !== this.diskHash) throw new WorkbenchError('config-changed', '目录映射配置有并发变更，请重新打开工作台', 409);
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await handle.writeFile(encoded);
      await handle.sync();
      await handle.close(); handle = undefined;
      await this.assertControl();
      const fresh = await readState(this.file);
      if ((fresh === null ? null : hash(fresh)) !== this.diskHash) throw new WorkbenchError('config-changed', '目录映射配置有并发变更，请重新打开工作台', 409);
      if (this.diskHash === null) await link(temporary, this.file);
      else await rename(temporary, this.file);
      this.state = state;
      this.diskHash = hash(encoded);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(lock).catch(() => {});
    }
  }

  enqueue(operation) {
    const run = this.tail.then(async () => {
      await this.ready;
      if (this.closed) throw new WorkbenchError('unavailable', '文件工作台已关闭', 503);
      await this.assertCurrent();
      return operation();
    });
    this.tail = run.catch(() => {});
    return run;
  }

  async workspaceEntities() {
    if (typeof this.workspaceRegistry?.list !== 'function' || typeof this.workspaceRegistry?.get !== 'function') return [];
    const entities = await this.workspaceRegistry.list();
    if (!Array.isArray(entities) || entities.length > MAX_WORKSPACES) throw new WorkbenchError('unavailable', '项目工作区清单不可用或过大', 503);
    return entities;
  }

  async syncWorkspaces() {
    await this.assertCurrent();
    const entities = await this.workspaceEntities();
    const next = structuredClone(this.state);
    const retained = new Set();
    const unavailable = [];
    for (const entity of entities) {
      if (!entity || typeof entity.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,170}$/.test(entity.id) || typeof entity.path !== 'string' || !path.isAbsolute(entity.path)) continue;
      const id = `workspace:${entity.id}`;
      retained.add(id);
      try { this.policy.validateRoot(entity.path); }
      catch {
        unavailable.push({id, kind: 'workspace', label: workspaceLabel(entity.title), path: '', mode: 'read-only', generation: '', status: 'unavailable', message: '该工作区包含受保护目录，请在原工作区列表中选择具体项目目录'});
        continue;
      }
      let record = next.workspaces.find(record => record.id === id);
      if (!record) {
        let identity = null;
        try { identity = await identityOfDirectory(entity.path); }
        catch (error) { if (!['ENOENT', 'ENOTDIR', 'files/root-changed', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
        record = {id, kind: 'workspace', label: workspaceLabel(entity.title, path.basename(entity.path) || '项目工作区'), path: entity.path, mode: 'read-write', generation: randomUUID(), identity};
        next.workspaces.push(record);
      }
    }
    next.workspaces = next.workspaces.filter(record => retained.has(record.id));
    if (JSON.stringify(next.workspaces) !== JSON.stringify(this.state.workspaces)) {
      next.revision++;
      await this.persist(next);
    }
    return {entities, unavailable};
  }

  async dto(record) {
    const common = {id: record.id, kind: record.kind, label: record.label, path: record.path, mode: record.mode, generation: record.generation};
    if (record.kind === 'workspace') {
      const entity = await this.workspaceRegistry?.get?.(record.id.slice('workspace:'.length));
      if (!entity) return {...common, status: 'unavailable', message: '项目已从原工作区列表移除'};
      if (entity.path !== record.path) return {...common, status: 'changed', message: '项目目录登记已变化，请重新授权'};
    }
    try {
      this.policy.validateRoot(record.path);
      const identity = await identityOfDirectory(record.path);
      if (!sameIdentity(identity, record.identity)) return {...common, status: 'changed', message: '目录身份已变化，请重新授权'};
      return {...common, status: 'ready'};
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return {...common, status: 'missing', message: '目录已不存在；映射记录及原数据均未改动'};
      if (error instanceof WorkbenchError && error.code === 'files/root-changed') return {...common, status: 'changed', message: '目录身份已变化，请重新授权'};
      return {...common, status: 'unavailable', message: '目录权限或状态不可用'};
    }
  }

  async list() {
    return this.enqueue(async () => {
      const {entities, unavailable} = await this.syncWorkspaces();
      const byId = new Map(this.state.workspaces.map(record => [record.id, record]));
      const records = [this.state.internal, ...entities.map(entity => byId.get(`workspace:${entity.id}`)).filter(Boolean), ...this.state.shared];
      return {roots: [...await Promise.all(records.map(record => this.dto(record))), ...unavailable]};
    });
  }

  async require(id, generation) {
    await this.ready;
    if (this.closed) throw new WorkbenchError('unavailable', '文件工作台已关闭', 503);
    await this.assertCurrent();
    if (typeof id !== 'string' || typeof generation !== 'string') throw new WorkbenchError('invalid-root', '目录身份或代次无效');
    const record = [this.state.internal, ...this.state.workspaces, ...this.state.shared].find(record => record.id === id);
    if (!record || record.generation !== generation) throw new WorkbenchError('revoked', '目录映射已撤销或更新，请重新选择目录', 410);
    const dto = await this.dto(record);
    if (dto.status !== 'ready') throw new WorkbenchError(dto.status === 'changed' ? 'root-changed' : 'root-unavailable', dto.message, dto.status === 'changed' ? 409 : 410);
    return record;
  }

  planAdd({path: requested, label, mode = 'read-only'}, {signal} = {}) {
    return this.enqueue(async () => {
      checkAbort(signal);
      for (const [id, plan] of this.plans) if (plan.expiresAt <= this.clock()) this.plans.delete(id);
      if (this.plans.size >= MAX_SHARED || this.state.shared.length >= MAX_SHARED) throw new WorkbenchError('too-large', '共享目录数量或待确认操作已达上限', 413);
      if (typeof requested !== 'string' || !path.isAbsolute(requested) || requested.length > 4096 || /[\x00-\x1f\x7f]/.test(requested) || !['read-only', 'read-write'].includes(mode)) throw new WorkbenchError('invalid-root', '共享目录路径或访问方式无效');
      const canonical = await realpath(requested);
      if (canonical !== path.resolve(requested)) throw new WorkbenchError('forbidden', '请直接选择实际目录，不能通过符号链接授权', 403);
      this.policy.validateRoot(canonical);
      const identity = await identityOfDirectory(canonical);
      if ([this.state.internal, ...this.state.shared, ...this.state.workspaces].some(record => record.path === canonical)) throw new WorkbenchError('conflict', '该目录已有映射，请使用原有目录入口', 409);
      checkAbort(signal);
      const record = {id: `shared:${randomUUID()}`, kind: 'shared', label: labelOf(label, path.basename(canonical) || '共享目录'), path: canonical, mode, generation: randomUUID(), identity};
      const planId = randomUUID(), expiresAt = this.clock() + PLAN_TTL_MS;
      this.plans.set(planId, {record, expiresAt});
      return {planId, root: await this.dto(record), expiresAt};
    });
  }

  add({planId, confirm}, {signal} = {}) {
    return this.enqueue(async () => {
      checkAbort(signal);
      const plan = typeof planId === 'string' ? this.plans.get(planId) : undefined;
      if (confirm !== true || !plan || plan.expiresAt <= this.clock()) throw new WorkbenchError('expired', '目录授权确认已失效，请重新选择', 410);
      this.plans.delete(planId);
      this.policy.validateRoot(plan.record.path);
      if (!sameIdentity(await identityOfDirectory(plan.record.path), plan.record.identity)) throw new WorkbenchError('root-changed', '目录身份已变化，请重新选择并授权', 409);
      if ([this.state.internal, ...this.state.shared, ...this.state.workspaces].some(record => record.path === plan.record.path)) throw new WorkbenchError('conflict', '该目录已有映射，请使用原有目录入口', 409);
      const next = structuredClone(this.state);
      next.revision++;
      next.shared.push(plan.record);
      checkAbort(signal);
      await this.persist(next);
      return {root: await this.dto(plan.record)};
    });
  }

  remove({rootId, generation, confirm}, {signal} = {}) {
    return this.enqueue(async () => {
      checkAbort(signal);
      if (confirm !== true) throw new WorkbenchError('confirmation', '请确认解除这项共享目录映射');
      const record = this.state.shared.find(record => record.id === rootId);
      if (!record || record.generation !== generation) throw new WorkbenchError('revoked', '目录映射已撤销或更新，请刷新列表', 410);
      const next = structuredClone(this.state);
      next.revision++;
      next.shared = next.shared.filter(record => record.id !== rootId);
      await this.persist(next);
      return {removed: true};
    });
  }

  async removable(rootId, generation) {
    await this.ready;
    await this.assertCurrent();
    const record = this.state.shared.find(record => record.id === rootId && record.generation === generation);
    if (!record) throw new WorkbenchError('revoked', '目录映射已撤销或更新，请刷新列表', 410);
    return record;
  }

  async close() {
    this.closed = true;
    this.plans.clear();
    await this.tail;
  }
}

export {asWorkbenchError};
