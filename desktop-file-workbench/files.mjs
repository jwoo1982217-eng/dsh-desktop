import path from 'node:path';
import {constants} from 'node:fs';
import {opendir, lstat, open, mkdir, link, unlink, rmdir} from 'node:fs/promises';
import {Readable, Transform, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash, randomUUID} from 'node:crypto';
import {RootRegistry} from './roots.mjs';
import {WorkbenchError, asWorkbenchError, checkAbort, relativePath, filename, joinRelative, protectedName, inspectPath, recheckPath, recheckAncestors, sameIdentity, directoryIdentity} from './paths.mjs';

export const FILE_LIMITS = Object.freeze({
  maxTextBytes: 2 * 1024 * 1024,
  maxImportBytes: 64 * 1024 * 1024,
  maxExportBytes: 256 * 1024 * 1024,
  importConcurrency: 2,
  listEntries: 1000,
  searchEntries: 5000,
  searchMatches: 200,
  searchDepth: 8,
  searchMs: 5000,
  searchBytes: 16 * 1024 * 1024,
  exportTtlMs: 60_000,
  exportTickets: 128,
});

const requireVersion = value => {
  if (typeof value !== 'string' || !value || value.length > 8192) throw new WorkbenchError('version-required', '请先刷新文件版本，再执行这项操作', 409);
  return value;
};
const textOf = bytes => {
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { throw new WorkbenchError('not-text', '此文件不是UTF-8文本，可使用导出保存', 415); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new WorkbenchError('not-text', '此文件包含二进制内容，可使用导出保存', 415);
  return text;
};
const ordinaryFile = snapshot => {
  if (!snapshot.stat?.isFile()) throw new WorkbenchError('unsupported', '请选择普通文件执行这项操作', 400);
};
const absent = async full => {
  try { await lstat(full); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new WorkbenchError('conflict', '目标名称已存在，不会覆盖现有内容', 409);
};
const mimeOf = name => ({'.txt': 'text/plain', '.md': 'text/plain', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.zip': 'application/zip'}[path.extname(name).toLowerCase()] ?? 'application/octet-stream');

/** Authenticated human UI only. This does not register model tools or alter session policy. */
export class FileWorkbench {
  constructor({home, workspaceRegistry, fsProvider, clock = Date.now}) {
    this.clock = clock;
    this.fs = fsProvider;
    this.registry = new RootRegistry({home, workspaceRegistry, clock});
    this.controller = new AbortController();
    this.operations = new Map();
    this.revoking = new Set();
    this.tails = new Map();
    this.exports = new Map();
    this.imports = 0;
    this.closed = false;
    const available = ['resolve', 'processPath', 'contains', 'stat', 'readBytes', 'writeText'].every(name => typeof fsProvider?.[name] === 'function');
    const mode = fsProvider?.sandboxMode;
    const scopedGate = mode === 'workspace-write' && typeof fsProvider?.checkedTarget === 'function';
    this.limits = Object.freeze({...FILE_LIMITS,
      providerAvailable: available,
      providerMode: typeof mode === 'string' ? mode : 'host-default',
      canWriteText: available && mode !== 'read-only' && (mode !== 'workspace-write' || scopedGate),
      canNativeMutate: available && (mode === undefined || mode === 'danger-full-access' || scopedGate),
      directoryRename: false,
    });
  }

  async safe(operation) {
    try {
      if (this.closed) throw new WorkbenchError('unavailable', '文件工作台已关闭', 503);
      return await operation();
    } catch (error) { throw asWorkbenchError(error); }
  }

  serial(rootId, operation) {
    const previous = this.tails.get(rootId) ?? Promise.resolve();
    const run = previous.then(operation);
    const settled = run.catch(() => {});
    this.tails.set(rootId, settled);
    settled.finally(() => { if (this.tails.get(rootId) === settled) this.tails.delete(rootId); });
    return run;
  }

  async withRoot(payload, parentSignal, operation) {
    const controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, controller.signal, ...(parentSignal ? [parentSignal] : [])]);
    checkAbort(signal);
    if (this.revoking.has(payload.rootId)) throw new WorkbenchError('aborted', '目录映射正在解除，操作已取消', 499);
    const root = await this.registry.require(payload.rootId, payload.generation);
    if (this.revoking.has(root.id)) throw new WorkbenchError('aborted', '目录映射正在解除，操作已取消', 499);
    let set = this.operations.get(root.id);
    if (!set) this.operations.set(root.id, set = new Set());
    set.add(controller);
    try {
      checkAbort(signal);
      return await operation(root, signal);
    } finally {
      set.delete(controller);
      if (!set.size && this.operations.get(root.id) === set) this.operations.delete(root.id);
    }
  }

  revoke(rootId) {
    for (const controller of this.operations.get(rootId) ?? []) controller.abort();
    for (const [id, ticket] of this.exports) if (ticket.rootId === rootId) this.exports.delete(id);
  }

  provider() {
    if (!this.limits.providerAvailable) throw new WorkbenchError('unavailable', '宿主文件服务尚未就绪，请稍后重新打开工作台', 503);
    return this.fs;
  }

  writable(root, native = false) {
    this.provider();
    if (root.mode !== 'read-write' || this.fs.sandboxMode === 'read-only') throw new WorkbenchError('forbidden', '当前目录为只读授权，不能修改文件', 403);
    const mode = this.fs.sandboxMode;
    if (mode === 'workspace-write' && typeof this.fs.checkedTarget !== 'function' || native && mode !== undefined && !['danger-full-access', 'workspace-write'].includes(mode)) throw new WorkbenchError('unsupported', '当前宿主文件服务未开放安全的目录写入授权，这项操作暂不可用', 403);
  }

  sandboxPolicy(root) {
    // A human-authorized GUI root, never a client-supplied workspaceRoot or session override.
    return this.fs.sandboxMode === 'workspace-write' ? {mode: 'workspace-write', workspaceRoot: root.path} : undefined;
  }

  /** Keep the SDK target opaque; verify its real process mapping instead of manufacturing keys. */
  async target(snapshot, signal, {mutation = false} = {}) {
    const fs = this.provider();
    if (mutation) this.writable(snapshot.record, true);
    checkAbort(signal);
    const [parent, resolved] = await Promise.all([
      fs.resolve(snapshot.record.path, {signal}), fs.resolve(snapshot.full, {signal}),
    ]);
    let target = resolved;
    if (fs.processPath(parent) !== snapshot.record.path || fs.processPath(target) !== snapshot.full || !await fs.contains(parent, target)) throw new WorkbenchError('forbidden', '宿主目录映射不一致，已停止本次操作', 403);
    if (mutation && fs.sandboxMode === 'workspace-write') {
      this.writable(snapshot.record, true);
      target = await fs.checkedTarget(target, this.sandboxPolicy(snapshot.record));
      if (fs.processPath(target) !== snapshot.full || !await fs.contains(parent, target)) throw new WorkbenchError('forbidden', '宿主写入授权返回了不同目录，已停止本次操作', 403);
    }
    await recheckPath(snapshot, this.registry, {signal});
    if (mutation) this.writable(snapshot.record, true);
    return target;
  }

  async fileInfo(snapshot, signal, expected) {
    ordinaryFile(snapshot);
    const target = await this.target(snapshot, signal);
    const info = await this.fs.stat(target, signal);
    if (!info || info.type !== 'file' || typeof info.version !== 'string' || !info.version) throw new WorkbenchError('conflict', '文件状态已变化，请刷新列表', 409);
    if (expected !== undefined && info.version !== requireVersion(expected)) throw new WorkbenchError('conflict', '文件已被其他程序修改，请刷新后重试；不会覆盖原件', 409);
    await recheckPath(snapshot, this.registry, {signal});
    return {target, info};
  }

  async manage(action, payload = {}, {signal} = {}) {
    return this.safe(async () => {
      checkAbort(signal);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new WorkbenchError('invalid-request', '文件操作参数无效');
      if (action === 'roots.list') return this.registry.list();
      if (action === 'roots.planAdd') return this.registry.planAdd(payload, {signal});
      if (action === 'roots.add') return this.registry.add(payload, {signal});
      if (action === 'roots.remove') {
        if (payload.confirm !== true) throw new WorkbenchError('confirmation', '请确认解除这项共享目录映射');
        await this.registry.removable(payload.rootId, payload.generation);
        if (this.revoking.has(payload.rootId)) throw new WorkbenchError('busy', '这项目录映射正在解除，请稍后刷新', 409);
        this.revoking.add(payload.rootId);
        // Cancel ongoing streams/search before waiting for already-started mutations to settle.
        this.revoke(payload.rootId);
        try { return await this.serial(payload.rootId, () => this.registry.remove(payload, {signal})); }
        finally { this.revoking.delete(payload.rootId); }
      }
      const handlers = {list: this.list, read: this.read, write: this.write, mkdir: this.makeDirectory, rename: this.renameFile, search: this.search, 'export.prepare': this.prepareExport};
      const handler = Object.hasOwn(handlers, action) ? handlers[action] : null;
      if (!handler) throw new WorkbenchError('unsupported', '不支持这项文件操作', 400);
      const execute = () => this.withRoot(payload, signal, (root, active) => handler.call(this, root, payload, active));
      return ['write', 'mkdir', 'rename'].includes(action) ? this.serial(payload.rootId, execute) : execute();
    });
  }

  async list(root, payload, signal) {
    const snapshot = await inspectPath(root, payload.path ?? '', this.registry.policy, {signal});
    if (!snapshot.stat.isDirectory()) throw new WorkbenchError('unsupported', '请选择目录查看文件列表');
    await recheckPath(snapshot, this.registry, {signal});
    const entries = [];
    let truncated = false, scanned = 0;
    const directory = await opendir(snapshot.full);
    try {
      for await (const item of directory) {
        checkAbort(signal);
        if (scanned++ >= this.limits.listEntries) { truncated = true; break; }
        let rel;
        try { rel = joinRelative(snapshot.relative, item.name); }
        catch { continue; }
        if (protectedName(item.name) || this.registry.policy.isProtected(path.join(snapshot.full, item.name))) continue;
        await recheckPath(snapshot, this.registry, {signal});
        let child;
        try { child = await inspectPath(root, rel, this.registry.policy, {signal}); }
        catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
          if (error instanceof WorkbenchError && ['files/forbidden', 'files/unsupported'].includes(error.code)) {
            entries.push({name: item.name, path: rel, kind: 'other', size: 0, modifiedAt: null, blocked: true, editable: false});
            continue;
          }
          throw error;
        }
        const isFile = child.stat.isFile();
        const entry = {name: item.name, path: rel, kind: isFile ? 'file' : 'directory', size: isFile ? Number(child.stat.size) : 0, modifiedAt: new Date(Number(child.stat.mtimeMs)).toISOString(), editable: false};
        if (isFile && this.limits.providerAvailable) {
          const {info} = await this.fileInfo(child, signal);
          entry.version = info.version;
          entry.editable = Number(child.stat.size) <= this.limits.maxTextBytes;
        }
        entries.push(entry);
      }
    } finally { await directory.close().catch(error => { if (error.code !== 'ERR_DIR_CLOSED') throw error; }); }
    await recheckPath(snapshot, this.registry, {signal});
    entries.sort((a, b) => (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
    return {root: await this.registry.dto(root), path: snapshot.relative, parent: snapshot.relative ? path.posix.dirname(snapshot.relative) === '.' ? '' : path.posix.dirname(snapshot.relative) : null, entries, truncated};
  }

  async textSnapshot(root, rel, signal) {
    const snapshot = await inspectPath(root, relativePath(rel, {empty: false}), this.registry.policy, {signal});
    ordinaryFile(snapshot);
    if (snapshot.stat.size > BigInt(this.limits.maxTextBytes)) throw new WorkbenchError('too-large', '文本预览上限为2MiB，请导出后使用其他应用打开', 413);
    const {target, info} = await this.fileInfo(snapshot, signal);
    const bytes = await this.fs.readBytes(target, signal, this.limits.maxTextBytes);
    if (bytes.byteLength > this.limits.maxTextBytes) throw new WorkbenchError('too-large', '文本文件超过2MiB限制', 413);
    const text = textOf(bytes);
    await this.fileInfo(snapshot, signal, info.version);
    return {snapshot, info, text, size: bytes.byteLength};
  }

  async read(root, payload, signal) {
    const {snapshot, info, text, size} = await this.textSnapshot(root, payload.path, signal);
    return {rootId: root.id, path: snapshot.relative, name: path.basename(snapshot.full), text, version: info.version, size, encoding: 'utf-8', editable: true};
  }

  async write(root, payload, signal) {
    this.writable(root);
    if (typeof payload.text !== 'string') throw new WorkbenchError('invalid-text', '保存内容必须为文本');
    const size = Buffer.byteLength(payload.text);
    if (size > this.limits.maxTextBytes) throw new WorkbenchError('too-large', '文本保存上限为2MiB', 413);
    textOf(Buffer.from(payload.text));
    if (payload.version !== null) requireVersion(payload.version);
    const snapshot = await inspectPath(root, relativePath(payload.path, {empty: false}), this.registry.policy, {missingLeaf: true, signal});
    if (snapshot.stat) {
      ordinaryFile(snapshot);
      if (payload.version === null) throw new WorkbenchError('conflict', '同名文件已存在，不会覆盖原件', 409);
      // Read only bounded UTF-8 text before replacing a previously existing file.
      const current = await this.textSnapshot(root, snapshot.relative, signal);
      if (current.info.version !== payload.version) throw new WorkbenchError('conflict', '文件已被其他程序修改，请刷新后重试；已保留你的编辑', 409);
    } else if (payload.version !== null) throw new WorkbenchError('conflict', '文件已不存在，不会另建同名文件', 409);
    const target = await this.target(snapshot, signal);
    await recheckPath(snapshot, this.registry, {signal});
    const expected = payload.version === null ? {kind: 'createIfAbsent'} : {kind: 'replaceIfVersion', version: payload.version};
    // The provider still enforces its policy; workspace-write is scoped to this validated GUI root.
    const result = await this.fs.writeText(target, payload.text, expected, signal, this.sandboxPolicy(root));
    await recheckPath(snapshot, this.registry, {signal, final: false});
    const written = await inspectPath(root, snapshot.relative, this.registry.policy, {signal});
    const {info} = await this.fileInfo(written, signal, result?.version);
    return {path: snapshot.relative, version: info.version, size};
  }

  async makeDirectory(root, payload, signal) {
    this.writable(root, true);
    const snapshot = await inspectPath(root, relativePath(payload.path, {empty: false}), this.registry.policy, {missingLeaf: true, signal});
    if (snapshot.stat) throw new WorkbenchError('conflict', '同名项目已存在，不会覆盖原件', 409);
    await this.target(snapshot, signal, {mutation: true});
    await recheckPath(snapshot, this.registry, {signal});
    this.writable(root, true);
    await mkdir(snapshot.full, {mode: 0o700});
    await recheckPath(snapshot, this.registry, {signal, final: false});
    return {path: snapshot.relative};
  }

  async renameFile(root, payload, signal) {
    this.writable(root, true);
    const source = await inspectPath(root, relativePath(payload.path, {empty: false}), this.registry.policy, {signal});
    if (source.stat.isDirectory()) throw new WorkbenchError('unsupported', '本版本仅支持普通文件改名，目录保持原样', 400);
    ordinaryFile(source);
    const destination = await inspectPath(root, relativePath(payload.to, {empty: false}), this.registry.policy, {missingLeaf: true, signal});
    if (destination.stat) throw new WorkbenchError('conflict', '目标名称已存在，不会覆盖现有内容', 409);
    await this.fileInfo(source, signal, payload.version);
    await this.target(source, signal, {mutation: true});
    await this.target(destination, signal, {mutation: true});
    await recheckPath(source, this.registry, {signal});
    await recheckPath(destination, this.registry, {signal});
    this.writable(root, true);
    let linked = false;
    try {
      // link is atomic no-replace; rename(2) would overwrite a competing destination.
      await link(source.full, destination.full); linked = true;
      await recheckPath(source, this.registry, {signal, final: false});
      await recheckPath(destination, this.registry, {signal, final: false});
      const [current, published] = await Promise.all([lstat(source.full, {bigint: true}), lstat(destination.full, {bigint: true})]);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 2n || !sameIdentity(directoryIdentity(current), directoryIdentity(source.stat)) || !sameIdentity(directoryIdentity(published), directoryIdentity(source.stat)) || current.size !== source.stat.size || current.mtimeNs !== source.stat.mtimeNs || current.ctimeNs < source.stat.ctimeNs) throw new WorkbenchError('conflict', '原文件在改名时已变化，已停止操作', 409);
      checkAbort(signal);
      await unlink(source.full);
      linked = false;
      await recheckPath(destination, this.registry, {signal, final: false});
      return {path: destination.relative};
    } finally {
      if (linked) {
        let safe = false;
        try { await recheckAncestors(destination); safe = true; } catch { /* never follow replaced parents during rollback */ }
        if (safe) await this.removeOwnLink(destination.full, source.stat);
      }
    }
  }

  async removeOwnLink(full, identity) {
    // Never remove a replacement created by another actor while recovering our own failed operation.
    try {
      const stat = await lstat(full, {bigint: true});
      if (!stat.isSymbolicLink() && stat.isFile() && sameIdentity(directoryIdentity(stat), directoryIdentity(identity))) await unlink(full);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async search(root, payload, signal) {
    if (typeof payload.query !== 'string' || !payload.query.trim() || payload.query.length > 200 || /[\x00-\x1f\x7f]/.test(payload.query)) throw new WorkbenchError('invalid-query', '请输入不超过200字的普通搜索内容');
    const base = await inspectPath(root, payload.path ?? '', this.registry.policy, {signal});
    if (!base.stat.isDirectory()) throw new WorkbenchError('unsupported', '请选择目录搜索');
    if (payload.content && !this.limits.providerAvailable) this.provider();
    const query = payload.query.toLocaleLowerCase();
    const matches = [], started = this.clock();
    let scanned = 0, bytes = 0, truncated = false;
    const callerSignal = signal, deadline = new AbortController();
    signal = AbortSignal.any([callerSignal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), this.limits.searchMs);
    timer.unref?.();
    const exhausted = () => scanned >= this.limits.searchEntries || matches.length >= this.limits.searchMatches || this.clock() - started >= this.limits.searchMs;
    const visit = async (relative, depth) => {
      if (exhausted()) { truncated = true; return; }
      const snapshot = await inspectPath(root, relative, this.registry.policy, {signal});
      await recheckPath(snapshot, this.registry, {signal});
      const directory = await opendir(snapshot.full);
      try {
        for await (const entry of directory) {
          checkAbort(signal);
          if (exhausted()) { truncated = true; break; }
          scanned++;
          if (protectedName(entry.name) || ['node_modules', 'vendor', '.DS_Store'].includes(entry.name)) continue;
          let rel, child;
          try {
            rel = joinRelative(relative, entry.name);
            child = await inspectPath(root, rel, this.registry.policy, {signal});
          } catch (error) {
            if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof WorkbenchError && ['files/forbidden', 'files/unsupported', 'files/invalid-path'].includes(error.code)) continue;
            throw error;
          }
          await recheckPath(snapshot, this.registry, {signal});
          const kind = child.stat.isDirectory() ? 'directory' : 'file';
          const size = kind === 'file' ? Number(child.stat.size) : 0;
          if (!payload.content && entry.name.toLocaleLowerCase().includes(query)) matches.push({path: rel, kind, size});
          if (payload.content && kind === 'file' && size <= this.limits.maxTextBytes) {
            if (bytes + size > this.limits.searchBytes) { truncated = true; return; }
            bytes += size;
            try {
              const {text} = await this.textSnapshot(root, rel, signal);
              let offset = 0, line = 1;
              // Split lazily so a very large line count does not allocate an unbounded array.
              while (offset <= text.length) {
                checkAbort(signal);
                if (exhausted()) { truncated = true; return; }
                const end = text.indexOf('\n', offset);
                const value = text.slice(offset, end < 0 ? undefined : end);
                const index = value.toLocaleLowerCase().indexOf(query);
                if (index >= 0) matches.push({path: rel, kind, size, line, snippet: value.slice(Math.max(0, index - 80), Math.max(0, index - 80) + 240)});
                if (end < 0) break;
                offset = end + 1; line++;
              }
            } catch (error) { if (!(error instanceof WorkbenchError && ['files/not-text', 'files/too-large'].includes(error.code))) throw error; }
          }
          if (kind === 'directory') {
            if (depth >= this.limits.searchDepth) truncated = true;
            else await visit(rel, depth + 1);
          }
        }
      } finally { await directory.close().catch(error => { if (error.code !== 'ERR_DIR_CLOSED') throw error; }); }
      await recheckPath(snapshot, this.registry, {signal});
    };
    try {
      try { await visit(base.relative, 0); }
      catch (error) {
        if (deadline.signal.aborted && !callerSignal.aborted) truncated = true;
        else throw error;
      }
      await recheckPath(base, this.registry, {signal: callerSignal});
      return {matches, truncated, scanned};
    } finally { clearTimeout(timer); }
  }

  async importFile({rootId, generation, path: directory = '', name, stream, signal}) {
    return this.safe(async () => {
      if (this.imports >= this.limits.importConcurrency) throw new WorkbenchError('busy', '同时最多导入两个文件，请稍后再试', 429);
      if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new WorkbenchError('invalid-request', '导入数据流无效');
      filename(name);
      this.imports++;
      try {
        return await this.serial(rootId, () => this.withRoot({rootId, generation}, signal, (root, active) => this.receive(root, directory, name, stream, active)));
      } finally { this.imports--; }
    });
  }

  async receive(root, directory, name, stream, signal) {
    this.writable(root, true);
    const parent = await inspectPath(root, relativePath(directory), this.registry.policy, {signal});
    if (!parent.stat.isDirectory()) throw new WorkbenchError('unsupported', '请选择目录导入文件');
    const relative = joinRelative(parent.relative, name);
    const destination = await inspectPath(root, relative, this.registry.policy, {missingLeaf: true, signal});
    if (destination.stat) throw new WorkbenchError('conflict', '同名文件已存在，不会覆盖原件', 409);
    await this.target(destination, signal, {mutation: true});
    await recheckPath(parent, this.registry, {signal});
    const stage = path.join(parent.full, `.dsh-files-import-${randomUUID()}`);
    let handle, stagedStat, stageIdentity, published = false;
    const staged = path.join(stage, 'data');
    try {
      await mkdir(stage, {mode: 0o700});
      stageIdentity = directoryIdentity(await lstat(stage, {bigint: true}));
      handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      stagedStat = await handle.stat({bigint: true});
      let size = 0;
      const hash = createHash('sha256');
      const counter = new Transform({transform(chunk, encoding, callback) {
        try {
          checkAbort(signal);
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
          size += data.length;
          if (size > FILE_LIMITS.maxImportBytes) throw new WorkbenchError('too-large', '单个导入文件不能超过64MiB', 413);
          hash.update(data); callback(null, data);
        } catch (error) { callback(error); }
      }});
      // Own the descriptor explicitly: FileHandle's autoClose:false stream can wait forever
      // for close under pipeline. This sink finishes while keeping the fd for fsync.
      const output = new Writable({write(chunk, encoding, callback) {
        (async () => {
          let offset = 0;
          while (offset < chunk.length) {
            checkAbort(signal);
            const {bytesWritten} = await handle.write(chunk, offset, chunk.length - offset);
            if (!bytesWritten) throw new WorkbenchError('failed', '导入文件写入未完成，已停止操作');
            offset += bytesWritten;
          }
        })().then(() => callback(), callback);
      }});
      await pipeline(stream, counter, output, {signal});
      await handle.sync();
      await handle.close(); handle = undefined;
      await recheckPath(parent, this.registry, {signal});
      await recheckPath(destination, this.registry, {signal});
      await this.target(destination, signal, {mutation: true});
      if (!sameIdentity(directoryIdentity(await lstat(stage, {bigint: true})), stageIdentity)) throw new WorkbenchError('conflict', '导入暂存目录已变化，已停止操作', 409);
      const final = await lstat(staged, {bigint: true});
      if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1n || !sameIdentity(directoryIdentity(final), directoryIdentity(stagedStat)) || Number(final.size) !== size) throw new WorkbenchError('conflict', '导入暂存文件已变化，已停止操作', 409);
      await absent(destination.full);
      checkAbort(signal);
      this.writable(root, true);
      await link(staged, destination.full); published = true;
      await recheckPath(parent, this.registry, {signal});
      const delivered = await lstat(destination.full, {bigint: true});
      if (!sameIdentity(directoryIdentity(delivered), directoryIdentity(stagedStat))) throw new WorkbenchError('conflict', '导入目标已变化，请刷新列表', 409);
      await unlink(staged);
      published = false;
      return {path: relative, name, size, sha256: hash.digest('hex')};
    } finally {
      await handle?.close().catch(() => {});
      // Check parent/root again before cleanup; a swapped ancestor must never redirect deletion.
      let safe = false;
      try {
        await recheckAncestors(parent);
        const current = await lstat(stage, {bigint: true});
        safe = current.isDirectory() && !current.isSymbolicLink() && sameIdentity(directoryIdentity(current), stageIdentity);
      } catch { /* preserve recoverable own stage if its path is no longer trustworthy */ }
      if (safe) {
        if (published && stagedStat) await this.removeOwnLink(destination.full, stagedStat);
        if (stagedStat) await this.removeOwnLink(staged, stagedStat);
        await rmdir(stage).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
      }
    }
  }

  async prepareExport(root, payload, signal) {
    for (const [id, ticket] of this.exports) if (ticket.expiresAt <= this.clock()) this.exports.delete(id);
    if (this.exports.size >= this.limits.exportTickets) throw new WorkbenchError('busy', '待下载文件数量已达上限，请稍后重试', 429);
    const snapshot = await inspectPath(root, relativePath(payload.path, {empty: false}), this.registry.policy, {signal});
    const {info} = await this.fileInfo(snapshot, signal, payload.version);
    const size = Number(snapshot.stat.size);
    if (size > this.limits.maxExportBytes) throw new WorkbenchError('too-large', '单个导出文件不能超过256MiB', 413);
    const id = randomUUID(), expiresAt = this.clock() + this.limits.exportTtlMs;
    const ticket = {rootId: root.id, generation: root.generation, path: snapshot.relative, version: info.version, filename: path.basename(snapshot.full), size, mime: mimeOf(snapshot.full), expiresAt};
    this.exports.set(id, ticket);
    return {id, filename: ticket.filename, size, mime: ticket.mime, expiresAt};
  }

  async takeExport(id, {consume = true, signal} = {}) {
    return this.safe(async () => {
      const ticket = typeof id === 'string' ? this.exports.get(id) : undefined;
      if (!ticket || ticket.expiresAt <= this.clock()) {
        this.exports.delete(id);
        throw new WorkbenchError('expired', '下载链接已失效，请重新导出', 410);
      }
      const controller = new AbortController();
      const active = AbortSignal.any([this.controller.signal, controller.signal, ...(signal ? [signal] : [])]);
      let set = this.operations.get(ticket.rootId);
      if (!set) this.operations.set(ticket.rootId, set = new Set());
      set.add(controller);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        set.delete(controller);
        if (!set.size && this.operations.get(ticket.rootId) === set) this.operations.delete(ticket.rootId);
      };
      let handle;
      try {
        const root = await this.registry.require(ticket.rootId, ticket.generation);
        const snapshot = await inspectPath(root, ticket.path, this.registry.policy, {signal: active});
        await this.fileInfo(snapshot, active, ticket.version);
        const meta = {filename: ticket.filename, size: ticket.size, mime: ticket.mime};
        if (!consume) { release(); return meta; }
        // Claim synchronously before yielding to open: a second GET cannot consume this ticket.
        if (this.exports.get(id) !== ticket) throw new WorkbenchError('expired', '下载链接已被使用，请重新导出', 410);
        this.exports.delete(id);
        handle = await open(snapshot.full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stat = await handle.stat({bigint: true});
        if (!stat.isFile() || stat.nlink !== 1n || !sameIdentity(directoryIdentity(stat), directoryIdentity(snapshot.stat)) || stat.size !== snapshot.stat.size || stat.mtimeNs !== snapshot.stat.mtimeNs || stat.ctimeNs !== snapshot.stat.ctimeNs) throw new WorkbenchError('conflict', '文件在下载前已变化，请重新导出', 409);
        await this.fileInfo(snapshot, active, ticket.version);
        checkAbort(active);
        const self = this, owned = handle; handle = undefined;
        async function* chunks() {
          try {
            let position = 0;
            while (position < ticket.size) {
              checkAbort(active);
              await recheckPath(snapshot, self.registry, {signal: active});
              const current = await owned.stat({bigint: true});
              if (current.size !== stat.size || current.mtimeNs !== stat.mtimeNs || current.ctimeNs !== stat.ctimeNs) throw new WorkbenchError('conflict', '文件在下载中已变化，已停止传输', 409);
              const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, ticket.size - position));
              const {bytesRead} = await owned.read(buffer, 0, buffer.length, position);
              if (!bytesRead) throw new WorkbenchError('conflict', '文件在下载中已变化，已停止传输', 409);
              position += bytesRead;
              yield buffer.subarray(0, bytesRead);
            }
            checkAbort(active);
            await self.fileInfo(snapshot, active, ticket.version);
          } catch (error) { throw asWorkbenchError(error); }
          finally { await owned.close(); release(); }
        }
        const output = Readable.from(chunks());
        // Cancellation can arrive between returning the stream and HTTP attaching pipeline.
        // Keep that brief ownership handoff from producing an unhandled error in the host.
        output.on('error', () => {});
        const abort = () => output.destroy(new WorkbenchError('aborted', '下载已取消', 499));
        active.addEventListener('abort', abort, {once: true});
        output.once('close', () => { active.removeEventListener('abort', abort); owned.close().catch(() => {}); release(); });
        return {...meta, stream: output};
      } catch (error) { await handle?.close().catch(() => {}); release(); throw error; }
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.exports.clear();
    await Promise.allSettled([...this.tails.values()]);
    await this.registry.close();
  }
}

export {WorkbenchError};
