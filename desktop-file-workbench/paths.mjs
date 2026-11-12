import path from 'node:path';
import os from 'node:os';
import {lstat, realpath} from 'node:fs/promises';

/** Only this marked error is safe to show through the authenticated UI. */
export class WorkbenchError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WorkbenchError';
    this.code = `files/${code}`;
    this.status = status;
    this.expose = true;
  }
}

export function checkAbort(signal) {
  if (signal?.aborted) throw new WorkbenchError('aborted', '操作已取消', 499);
}

export function asWorkbenchError(error) {
  if (error instanceof WorkbenchError) return error;
  const code = error?.code;
  if (error?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'FS_ABORTED') return new WorkbenchError('aborted', '操作已取消', 499);
  if (['EACCES', 'EPERM', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED'].includes(code)) return new WorkbenchError('forbidden', '当前目录或宿主权限不允许这项操作', 403);
  if (['EEXIST', 'ENOTEMPTY', 'FS_STALE_VERSION', 'FS_NOT_OBSERVED'].includes(code)) return new WorkbenchError('conflict', '文件或目录已变化，请刷新后重试；不会覆盖现有内容', 409);
  if (['ENOENT', 'ENOTDIR', 'FS_NOT_FOUND', 'FS_NOT_DIRECTORY'].includes(code)) return new WorkbenchError('missing', '文件或目录已不存在，请刷新列表', 404);
  if (['FS_TOO_LARGE', 'ERR_FS_FILE_TOO_LARGE'].includes(code)) return new WorkbenchError('too-large', '文件超过本次操作的大小限制', 413);
  if (['FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE', 'EISDIR', 'ELOOP'].includes(code)) return new WorkbenchError('unsupported', '此项目不支持这项文件操作', 400);
  if (code === 'ENOSPC' || code === 'EDQUOT') return new WorkbenchError('storage-full', '磁盘空间不足，未能完成操作', 507);
  return new WorkbenchError('failed', '文件操作未完成，请刷新后重试', 400);
}

export const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export function filename(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' ||
      Buffer.byteLength(value) > 240 || /[\x00-\x1f\x7f/\\:]/u.test(value) || /[. ]$/.test(value) || reserved.test(value) || /%(?:00|2e|2f|5c)/i.test(value)) {
    throw new WorkbenchError('invalid-path', '文件名无效，请使用普通文件名');
  }
  return value;
}

/** API paths are host-independent relative segments, never URLs or host paths. */
export function relativePath(value, {empty = true} = {}) {
  if (typeof value !== 'string' || value.length > 4096 || value.startsWith('/') || value.includes('\\')) throw new WorkbenchError('invalid-path', '请使用当前目录内的相对路径');
  if (value === '') {
    if (empty) return '';
    throw new WorkbenchError('invalid-path', '请选择文件或子目录');
  }
  return value.split('/').map(filename).join('/');
}

export const joinRelative = (directory, leaf) => directory ? `${relativePath(directory)}/${filename(leaf)}` : filename(leaf);

export function directoryIdentity(stat) {
  return {dev: String(stat.dev), ino: String(stat.ino)};
}

export const sameIdentity = (left, right) => Boolean(left && right && left.dev === right.dev && left.ino === right.ino);

export async function identityOfDirectory(target) {
  const stat = await lstat(target, {bigint: true});
  if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(target) !== target) throw new WorkbenchError('root-changed', '目录身份已变化，请重新授权', 409);
  return directoryIdentity(stat);
}

const privateNames = /^(?:\.env(?:\..*)?|\.credentials(?:\..*)?|credentials?\.(?:json|ya?ml)|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|authorized_keys|known_hosts)$/i;
const privateDirectories = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.git', '.dsh', '.dsh-file-workbench']);
const keyExtensions = /\.(?:pem|p12|pfx|key|keystore)$/i;
export function protectedName(name) {
  return privateDirectories.has(name.toLowerCase()) || privateNames.test(name) || keyExtensions.test(name) || /^\.dsh-files-(?:import|stage)-/.test(name);
}

export function createPathPolicy(home) {
  const internal = path.join(home, 'storage/desktop-files/files');
  const user = path.resolve(os.homedir());
  const prefixes = [
    home,
    '/Applications', '/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc',
    ...['profiles', 'sessions', 'credentials', 'storage', 'knowledge', 'memory', 'browser', 'backups', 'extensions', 'plugins', 'logs', 'mcp', 'openai-gateway'].map(value => path.join(home, value)),
    ...['.ssh', '.aws', '.azure', '.gnupg', '.codex/sessions', '.codex/memories', 'Library/Keychains', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Microsoft Edge', 'Library/Application Support/Firefox', 'Library/Application Support/BraveSoftware'].map(value => path.join(user, value)),
    path.join(user, '.codex/auth.json'), path.join(user, '.codex/config.toml'),
  ];
  const isProtected = candidate => {
    if (within(internal, candidate)) return false;
    return prefixes.some(root => within(root, candidate)) || path.relative(home, candidate).split(path.sep).some(protectedName);
  };
  const validateRoot = candidate => {
    if (candidate === path.parse(candidate).root || candidate === user || candidate === home ||
        ['/', '/Applications', '/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private/etc'].some(root => candidate === root) ||
        isProtected(candidate) || prefixes.some(root => within(candidate, root))) {
      throw new WorkbenchError('forbidden', '请选择具体项目或共享目录；账号、聊天和程序控制目录不开放为文件工作区', 403);
    }
  };
  return {home, internal, isProtected, validateRoot};
}

/** Snapshot every directory below the registered root before any file access. */
export async function inspectPath(record, value, policy, {missingLeaf = false, signal} = {}) {
  checkAbort(signal);
  const relative = relativePath(value);
  const full = path.join(record.path, ...relative.split('/').filter(Boolean));
  if (!within(record.path, full) || policy.isProtected(full) || relative.split('/').some(protectedName)) throw new WorkbenchError('forbidden', '此目录或文件受保护，不能通过文件工作台访问', 403);
  const ancestors = [];
  let current = record.path;
  const rootStat = await lstat(current, {bigint: true});
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !sameIdentity(directoryIdentity(rootStat), record.identity) || await realpath(current) !== current) throw new WorkbenchError('root-changed', '目录身份已变化，请重新授权', 409);
  ancestors.push({path: current, identity: directoryIdentity(rootStat)});
  const parts = relative ? relative.split('/') : [];
  let stat = rootStat;
  for (let index = 0; index < parts.length; index++) {
    checkAbort(signal);
    current = path.join(current, parts[index]);
    try { stat = await lstat(current, {bigint: true}); }
    catch (error) {
      if (error.code === 'ENOENT' && index === parts.length - 1 && missingLeaf) return {record, relative, full, ancestors, stat: null};
      throw error;
    }
    if (stat.isSymbolicLink()) throw new WorkbenchError('forbidden', '符号链接不在本次文件操作范围内', 403);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new WorkbenchError('missing', '父目录已变化，请刷新列表', 404);
    if (stat.isDirectory()) ancestors.push({path: current, identity: directoryIdentity(stat)});
    else if (index < parts.length - 1 || !stat.isFile()) throw new WorkbenchError('unsupported', '只支持普通文件和目录', 400);
    else if (stat.nlink !== 1n) throw new WorkbenchError('forbidden', '硬链接文件不在本次文件操作范围内', 403);
  }
  checkAbort(signal);
  return {record, relative, full, ancestors, stat};
}

export async function recheckPath(snapshot, registry, {signal, final = true} = {}) {
  checkAbort(signal);
  await registry.require(snapshot.record.id, snapshot.record.generation);
  await recheckAncestors(snapshot, {signal});
  if (final && snapshot.stat) {
    const stat = await lstat(snapshot.full, {bigint: true});
    if (stat.isSymbolicLink() || !sameIdentity(directoryIdentity(stat), directoryIdentity(snapshot.stat)) || stat.isFile() && stat.nlink !== 1n) throw new WorkbenchError('conflict', '文件已变化，请刷新后重试', 409);
  }
  checkAbort(signal);
}

/** Physical identity only, used to clean our private stage after authorization is revoked. */
export async function recheckAncestors(snapshot, {signal} = {}) {
  checkAbort(signal);
  for (const entry of snapshot.ancestors) {
    const stat = await lstat(entry.path, {bigint: true});
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(directoryIdentity(stat), entry.identity) || await realpath(entry.path) !== entry.path) throw new WorkbenchError('changed', '父目录已变化，请刷新后重试', 409);
  }
  checkAbort(signal);
}
