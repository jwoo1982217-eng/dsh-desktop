import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const packageName = 'dsh-desktop-file-workbench';
export const sdkVersion = '0.2.1-alpha.4';
export const desktopFileWorkbenchFiles = Object.freeze([
  'package.json', 'cordis.patch.yml', 'index.mjs', 'http.mjs', 'roots.mjs',
  'paths.mjs', 'files.mjs', 'client.js', 'page.html', 'page.js', 'page.css',
  'API.md', 'README.md',
]);
const defaultSource = fileURLToPath(new URL('../desktop-file-workbench/', import.meta.url));
const markerName = '.dsh-file-workbench-owner.json';
const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = message => { throw new Error(message); };
const parseJson = (bytes, message) => { try { return JSON.parse(bytes); } catch { fail(message); } };
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const exists = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const identity = stat => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;

// Read regular files without following a substituted final symlink. Receipts contain hashes,
// never the manifest bytes; its before image lives only in the private recovery directory.
function readFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail('Expected a regular file');
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || !sameIdentity(stat, after)) fail('File changed while reading');
    return { bytes, sha256: digest(bytes), mode: stat.mode & 0o777, identity: identity(stat) };
  } finally { fs.closeSync(fd); }
}

function matchesFile(file, snapshot) {
  try { const value = readFile(file); return value.sha256 === snapshot.sha256 && sameIdentity(value.identity, snapshot.identity) &&
    (snapshot.mode === undefined || value.mode === snapshot.mode); }
  catch { return false; }
}

function directoryChain(base, directory, create = false) {
  if (!inside(base, directory)) fail('Installer paths must remain inside DSH_HOME');
  for (const suffix of ['', ...path.relative(base, directory).split(path.sep).filter(Boolean)]) {
    base = suffix ? path.join(base, suffix) : base;
    const stat = exists(base);
    if (!stat && create) fs.mkdirSync(base, { mode: 0o700 });
    else if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('Installer directory is a symlink or non-directory');
  }
}

function inputSnapshot(sourceDir, selectedFiles) {
  const files = [...selectedFiles].sort();
  if (new Set(files).size !== files.length || files.some(file => !desktopFileWorkbenchFiles.includes(file)) ||
      desktopFileWorkbenchFiles.some(file => !files.includes(file))) fail('The complete explicit source file list is required');
  const buffers = {}, hashes = {};
  for (const file of files) {
    const snapshot = readFile(path.join(sourceDir, file));
    buffers[file] = snapshot.bytes; hashes[file] = snapshot.sha256;
  }
  const meta = parseJson(buffers['package.json'], 'Workbench package manifest is not valid JSON');
  if (meta.name !== packageName || meta.version !== '0.1.0' || meta.type !== 'module') fail('Unexpected workbench package identity');
  if (Object.keys(meta.dependencies || {}).length || Object.keys(meta.optionalDependencies || {}).length ||
      json(meta.peerDependencies) !== json({ '@deepseek-ai/dsh': sdkVersion })) fail('Only the pinned host SDK peer dependency is allowed');
  return { files, buffers, hashes, fingerprint: digest(json(hashes)), version: meta.version };
}

export function desktopFileWorkbenchDependencies(modules) {
  modules = fs.realpathSync(path.resolve(modules));
  const resolver = createRequire(path.join(modules, '@deepseek-ai/dsh/package.json'));
  const manifest = fs.realpathSync(resolver.resolve('@deepseek-ai/dsh/package.json'));
  if (!inside(modules, manifest)) fail('SDK dependency escapes the selected distribution runtime');
  const meta = parseJson(readFile(manifest).bytes, 'Runtime package manifest is not valid JSON');
  if (meta.name !== '@deepseek-ai/dsh' || meta.version !== sdkVersion) fail('Workbench requires the verified alpha.4 runtime');
  return { '@deepseek-ai/dsh': { path: path.dirname(manifest), version: meta.version, manifestSha256: digest(fs.readFileSync(manifest)) } };
}

function linkSnapshot(link) {
  const stat = exists(link);
  if (!stat) return { kind: 'missing' };
  if (!stat.isSymbolicLink()) fail('Same-name independent program is preserved; expected an owned symlink');
  return { kind: 'symlink', value: fs.readlinkSync(link), identity: identity(stat) };
}

function matchesLink(link, expected) {
  try {
    const current = linkSnapshot(link);
    return current.kind === expected.kind && (current.kind === 'missing' ||
      (current.value === expected.value && sameIdentity(current.identity, expected.identity)));
  } catch { return false; }
}

function validateTarget(target, extensionRoot, expected) {
  const stat = exists(target);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || path.dirname(target) !== extensionRoot) fail('Unknown or changed workbench target is preserved');
  const marker = parseJson(readFile(path.join(target, markerName)).bytes, 'Workbench ownership marker is not valid JSON');
  if (marker.format !== 1 || marker.packageName !== packageName || marker.version !== '0.1.0' ||
      !/^[a-f0-9]{64}$/.test(marker.fingerprint) || path.basename(target) !== `${marker.version}-${marker.fingerprint}` ||
      digest(json(marker.files)) !== marker.fingerprint || !marker.installId) fail('Unknown workbench ownership marker');
  if (expected && (marker.fingerprint !== expected.fingerprint || json(marker.files) !== json(expected.hashes) ||
      json(marker.dependencies) !== json(expected.dependencies))) fail('Existing workbench target differs from frozen inputs');
  if (json(Object.keys(marker.files).sort()) !== json([...desktopFileWorkbenchFiles].sort())) fail('Incomplete workbench ownership marker');
  const expectedTop = [...Object.keys(marker.files), markerName, 'node_modules'].sort();
  if (json(fs.readdirSync(target).sort()) !== json(expectedTop)) fail('Existing workbench target has independent files');
  for (const [file, hash] of Object.entries(marker.files)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(file) || readFile(path.join(target, file)).sha256 !== hash) fail('Existing workbench file was modified');
  }
  const moduleDir = path.join(target, 'node_modules');
  if (!exists(moduleDir)?.isDirectory() || exists(moduleDir)?.isSymbolicLink() ||
      json(fs.readdirSync(moduleDir).sort()) !== json(['@deepseek-ai']) ||
      json(fs.readdirSync(path.join(moduleDir, '@deepseek-ai')).sort()) !== json(['dsh'])) fail('Workbench dependency directory changed');
  const sdk = marker.dependencies?.['@deepseek-ai/dsh'];
  const dependency = path.join(moduleDir, '@deepseek-ai/dsh');
  if (Object.keys(marker.dependencies || {}).length !== 1 || !sdk || sdk.version !== sdkVersion ||
      !exists(dependency)?.isSymbolicLink() || fs.realpathSync(dependency) !== sdk.path ||
      readFile(path.join(sdk.path, 'package.json')).sha256 !== sdk.manifestSha256 ||
      parseJson(readFile(path.join(sdk.path, 'package.json')).bytes, 'Runtime package manifest is not valid JSON').version !== sdkVersion) fail('Workbench SDK dependency drifted');
  return { identity: identity(stat), marker, markerSha256: readFile(path.join(target, markerName)).sha256 };
}

function context(home, modules, options = {}) {
  home = fs.realpathSync(path.resolve(home));
  const profile = options.profile ? path.resolve(options.profile) : path.join(home, 'profiles/web');
  directoryChain(home, profile);
  const manifestFile = path.join(profile, 'package.json'), before = readFile(manifestFile);
  const manifest = parseJson(before.bytes, 'Profile manifest is not valid JSON');
  if (!Array.isArray(manifest.dsh?.profile?.bundles) ||
      (manifest.dependencies != null && (typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)))) fail('Select an existing web profile');
  const sourceDir = fs.realpathSync(path.resolve(options.sourceDir || defaultSource));
  const input = inputSnapshot(sourceDir, options.files || desktopFileWorkbenchFiles);
  const dependencies = desktopFileWorkbenchDependencies(modules);
  const extensionRoot = path.join(home, 'extensions', packageName);
  const recoveryRoot = path.join(home, 'storage/desktop-files/installer/recovery');
  directoryChain(home, extensionRoot); directoryChain(home, recoveryRoot);
  directoryChain(home, path.join(profile, 'node_modules'));
  const target = path.join(extensionRoot, `${input.version}-${input.fingerprint}`);
  if (exists(target)) validateTarget(target, extensionRoot, { ...input, dependencies });
  const link = path.join(profile, 'node_modules', packageName), previousLink = linkSnapshot(link);
  let oldTarget;
  if (previousLink.kind === 'symlink') {
    oldTarget = path.resolve(path.dirname(link), previousLink.value);
    validateTarget(oldTarget, extensionRoot);
  }
  const previousDependency = manifest.dependencies?.[packageName];
  const count = manifest.dsh.profile.bundles.filter(value => value === packageName).length;
  if (count > 1 || ((previousDependency !== undefined || count) && !oldTarget) ||
      (previousDependency !== undefined && previousDependency !== 'file:' + path.relative(profile, oldTarget).split(path.sep).join('/'))) fail('Same-name profile entry is not owned by this installer');
  const dependency = 'file:' + path.relative(profile, target).split(path.sep).join('/');
  const unchanged = oldTarget === target && previousDependency === dependency && count === 1;
  const afterManifest = structuredClone(manifest);
  afterManifest.dependencies = { ...afterManifest.dependencies, [packageName]: dependency };
  if (!count) afterManifest.dsh.profile.bundles.push(packageName);
  const after = unchanged ? before.bytes : Buffer.from(json(afterManifest));
  return { home, profile, manifestFile, before, sourceDir, input, dependencies, extensionRoot,
    recoveryRoot, target, link, previousLink, after, unchanged };
}

function publicPlan(c) {
  return { packageName, version: c.input.version, status: c.unchanged ? 'unchanged' : 'planned',
    home: c.home, profile: c.profile, target: c.target, link: c.link,
    sourceDir: c.sourceDir, files: c.input.hashes, fingerprint: c.input.fingerprint,
    dependencies: c.dependencies, beforeSha256: c.before.sha256, afterSha256: digest(c.after),
    activation: 'Profile HMR may activate the bundle; no process restart is performed' };
}

export function preflightDesktopFileWorkbench(home, modules, options = {}) {
  return publicPlan(context(home, modules, options));
}

function acquireLock(c, owner) {
  const lock = path.join(c.profile, '.desktop-file-workbench-install.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  const token = { installId: randomUUID(), owner, pid: process.pid };
  const stat = identity(fs.lstatSync(lock));
  try { fs.writeFileSync(path.join(lock, 'owner.json'), json(token), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (sameIdentity(identity(exists(lock) || {}), stat)) { try { fs.rmdirSync(lock); } catch { /* Preserve any replacement or addition. */ } }
    throw error;
  }
  return { token, release() {
    // A replaced lock belongs to someone else, even if its pathname is identical.
    if (!sameIdentity(identity(exists(lock) || {}), stat)) return;
    try {
      if (fs.readFileSync(path.join(lock, 'owner.json'), 'utf8') !== json(token) ||
          json(fs.readdirSync(lock).sort()) !== json(['owner.json'])) return;
      fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
    } catch { /* A concurrent owner keeps its lock. */ }
  } };
}

function writePrivate(file, bytes, mode = 0o600) {
  const fd = fs.openSync(file, 'wx', mode);
  try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicFile(file, bytes, mode) {
  const temporary = file + '.files-' + randomUUID();
  try { writePrivate(temporary, bytes, mode); fs.renameSync(temporary, file); }
  finally { if (exists(temporary)) fs.unlinkSync(temporary); }
  return readFile(file);
}

function replaceLink(link, before, value) {
  if (!matchesLink(link, before)) fail('Workbench symlink changed concurrently');
  if (before.kind === 'missing') fs.symlinkSync(value, link); // Exclusive publication: never clobbers a new entry.
  else {
    const temporary = link + '.files-' + randomUUID();
    try {
      fs.symlinkSync(value, temporary);
      if (!matchesLink(link, before)) fail('Workbench symlink changed concurrently');
      fs.renameSync(temporary, link); // One atomic link replacement; repeated installs never enter here.
    } finally { if (exists(temporary)) fs.unlinkSync(temporary); }
  }
  return linkSnapshot(link);
}

function persistReceipt(receiptFile, receipt) { atomicFile(receiptFile, json(receipt), 0o600); }

function matchesCreated(item) {
  if (!sameIdentity(identity(exists(item.path) || {}), item.identity)) return false;
  if (item.directory) return exists(item.path).isDirectory() && !exists(item.path).isSymbolicLink();
  if (item.value !== undefined) return exists(item.path).isSymbolicLink() && fs.readlinkSync(item.path) === item.value;
  try { return readFile(item.path).sha256 === item.sha256; } catch { return false; }
}

function referencesTarget(link, target) {
  try { return exists(link)?.isSymbolicLink() && path.resolve(path.dirname(link), fs.readlinkSync(link)) === target; }
  catch { return true; } // Unknown concurrent state is retained for manual inspection.
}

function restoreOwned(c, state) {
  const result = { manifest: 'unchanged', link: 'unchanged', target: 'retained' };
  if (state.afterManifest) {
    if (matchesFile(c.manifestFile, state.afterManifest)) {
      atomicFile(c.manifestFile, c.before.bytes, c.before.mode); result.manifest = 'restored';
    } else result.manifest = 'concurrent-change-preserved';
  }
  if (state.afterLink) {
    if (matchesLink(c.link, state.afterLink)) {
      if (c.previousLink.kind === 'missing') fs.unlinkSync(c.link);
      else replaceLink(c.link, state.afterLink, c.previousLink.value);
      result.link = 'restored';
    } else result.link = 'concurrent-change-preserved';
  }
  if (state.createdTarget && !state.afterManifest && !state.afterLink) {
    // A failure before linking may leave an incomplete target; remove only the exact
    // files/inodes this invocation wrote, then empty directories, never a recursive rm.
    if (matchesFile(c.manifestFile, c.before) && !referencesTarget(c.link, c.target)) {
      for (const item of [...state.createdPaths].reverse()) {
        if (!matchesCreated(item)) continue;
        try { item.directory ? fs.rmdirSync(item.path) : fs.unlinkSync(item.path); } catch { /* Preserve unknown additions. */ }
      }
    }
    result.target = exists(c.target) ? 'changed-target-preserved' : 'removed';
  } else if (state.createdTarget) {
    try {
      const target = validateTarget(c.target, c.extensionRoot, { ...c.input, dependencies: c.dependencies });
      if (!sameIdentity(target.identity, state.createdTarget)) fail('Target ownership changed');
      if (referencesTarget(c.link, c.target)) fail('Target is still linked');
      if (result.manifest === 'concurrent-change-preserved') fail('Concurrent manifest may retain target');
      for (const item of [...state.createdPaths].reverse()) {
        if (!matchesCreated(item)) fail('Target file identity or content changed');
        item.directory ? fs.rmdirSync(item.path) : fs.unlinkSync(item.path);
      }
      result.target = 'removed';
    } catch { result.target = 'changed-target-preserved'; }
  }
  return result;
}

// `hooks` is a synchronous fixture seam for failure/concurrency tests. No subprocess,
// model request, restart, LaunchAgent update or application-signature change occurs here.
export function installDesktopFileWorkbench(home, modules, options = {}) {
  if (!options.apply) return preflightDesktopFileWorkbench(home, modules, options);
  if (typeof options.owner !== 'string' || !options.owner.trim() || options.owner.length > 200) fail('An explicit installation owner is required');
  const initial = context(home, modules, options), lock = acquireLock(initial, options.owner);
  let c, state = { createdPaths: [] }, receipt, receiptFile;
  const hook = phase => options.hooks?.[phase]?.({ target: c.target, link: c.link, manifestFile: c.manifestFile, receiptFile });
  const track = (file, directory = false) => {
    const stat = fs.lstatSync(file);
    state.createdPaths.push({ path: file, identity: identity(stat), directory,
      ...(directory ? {} : stat.isSymbolicLink() ? { value: fs.readlinkSync(file) } : { sha256: readFile(file).sha256 }) });
  };
  try {
    c = context(home, modules, options);
    if (c.before.sha256 !== initial.before.sha256 || c.input.fingerprint !== initial.input.fingerprint || !matchesLink(c.link, initial.previousLink)) fail('Installation inputs changed while acquiring lock');
    if (c.unchanged) return publicPlan(c);
    directoryChain(c.home, c.extensionRoot, true); directoryChain(c.home, c.recoveryRoot, true);
    directoryChain(c.home, path.dirname(c.link), true);
    const recoveryDir = path.join(c.recoveryRoot, lock.token.installId);
    fs.mkdirSync(recoveryDir, { mode: 0o700 });
    writePrivate(path.join(recoveryDir, 'package.before.json'), c.before.bytes);
    receiptFile = path.join(recoveryDir, 'receipt.json');
    receipt = { ...publicPlan(c), format: 1, installId: lock.token.installId, owner: options.owner,
      status: 'prepared', manifestFile: c.manifestFile, recoveryDir, beforeMode: c.before.mode,
      previousLink: c.previousLink, targetCreated: false };
    persistReceipt(receiptFile, receipt);
    if (!exists(c.target)) {
      fs.mkdirSync(c.target, { mode: 0o700 }); track(c.target, true); state.createdTarget = identity(fs.lstatSync(c.target));
      for (const file of c.input.files) { const destination = path.join(c.target, file); writePrivate(destination, c.input.buffers[file]); track(destination); }
      for (const suffix of ['node_modules', 'node_modules/@deepseek-ai']) {
        const directory = path.join(c.target, suffix); fs.mkdirSync(directory, { mode: 0o700 }); track(directory, true);
      }
      const sdkLink = path.join(c.target, 'node_modules/@deepseek-ai/dsh');
      fs.symlinkSync(path.relative(path.dirname(sdkLink), c.dependencies['@deepseek-ai/dsh'].path), sdkLink); track(sdkLink);
      const marker = { format: 1, packageName, version: c.input.version, installId: lock.token.installId,
        fingerprint: c.input.fingerprint, files: c.input.hashes, dependencies: c.dependencies };
      writePrivate(path.join(c.target, markerName), json(marker)); track(path.join(c.target, markerName));
    }
    validateTarget(c.target, c.extensionRoot, { ...c.input, dependencies: c.dependencies });
    receipt.targetCreated = !!state.createdTarget;
    receipt.createdTarget = state.createdTarget;
    receipt.createdPaths = state.createdPaths;
    persistReceipt(receiptFile, receipt);
    hook('afterTarget');
    // Frozen copies must still correspond to the explicit source at publication time.
    if (inputSnapshot(c.sourceDir, c.input.files).fingerprint !== c.input.fingerprint) fail('Source inputs changed during installation');
    hook('beforeLink');
    state.afterLink = replaceLink(c.link, c.previousLink, path.relative(path.dirname(c.link), c.target));
    receipt.afterLink = state.afterLink; receipt.status = 'linked'; persistReceipt(receiptFile, receipt);
    hook('afterLink'); hook('beforeManifestCommit');
    if (!matchesFile(c.manifestFile, c.before)) fail('Profile changed during installation; concurrent edits are preserved');
    if (!matchesLink(c.link, state.afterLink)) fail('Workbench symlink drifted before manifest publication');
    validateTarget(c.target, c.extensionRoot, { ...c.input, dependencies: c.dependencies });
    state.afterManifest = atomicFile(c.manifestFile, c.after, c.before.mode);
    receipt.afterManifest = { sha256: state.afterManifest.sha256, identity: state.afterManifest.identity, mode: state.afterManifest.mode };
    receipt.status = 'committed'; persistReceipt(receiptFile, receipt);
    hook('afterManifestCommit'); hook('beforeReceipt');
    if (!matchesFile(c.manifestFile, state.afterManifest) || !matchesLink(c.link, state.afterLink)) fail('Installation changed before completion');
    receipt.status = 'installed'; persistReceipt(receiptFile, receipt);
    return { ...publicPlan(c), status: 'installed', receipt: receiptFile, installId: receipt.installId };
  } catch (error) {
    if (c) {
      const recovery = restoreOwned(c, state);
      if (receipt && receiptFile) {
        receipt.status = 'failed'; receipt.recovery = recovery;
        try { persistReceipt(receiptFile, receipt); } catch { /* Keep the original private recovery material. */ }
      }
      error.recovery = recovery;
      if (receiptFile) error.receipt = receiptFile;
    }
    throw error;
  } finally { lock.release(); }
}

export function rollbackDesktopFileWorkbench(home, receiptPath, options = {}) {
  home = fs.realpathSync(path.resolve(home)); receiptPath = path.resolve(receiptPath);
  const recoveryRoot = path.join(home, 'storage/desktop-files/installer/recovery');
  if (!inside(recoveryRoot, receiptPath) || path.basename(receiptPath) !== 'receipt.json') fail('Select a private workbench recovery receipt');
  directoryChain(home, path.dirname(receiptPath));
  const receipt = parseJson(readFile(receiptPath).bytes, 'Recovery receipt is not valid JSON');
  const profile = path.join(home, 'profiles/web');
  if (receipt.format !== 1 || receipt.packageName !== packageName || receipt.home !== home ||
      receipt.profile !== profile || receipt.recoveryDir !== path.dirname(receiptPath) ||
      receipt.installId !== path.basename(path.dirname(receiptPath)) ||
      receipt.manifestFile !== path.join(profile, 'package.json') ||
      receipt.link !== path.join(profile, 'node_modules', packageName) ||
      receipt.target !== path.join(home, 'extensions', packageName, `${receipt.version}-${receipt.fingerprint}`)) fail('Recovery receipt identity does not match this profile');
  if (receipt.status === 'rolled-back') return { status: 'rolled-back', receipt: receiptPath, unchanged: true };
  if (receipt.status !== 'installed') fail('Only a completed installation can be explicitly rolled back');
  const before = readFile(path.join(path.dirname(receiptPath), 'package.before.json'));
  if (before.sha256 !== receipt.beforeSha256 || !receipt.afterManifest || !receipt.afterLink) fail('Recovery image is incomplete');
  const c = { home, profile, target: receipt.target, link: receipt.link, manifestFile: receipt.manifestFile,
    extensionRoot: path.dirname(receipt.target), before: { ...before, mode: receipt.beforeMode },
    previousLink: receipt.previousLink, input: { hashes: receipt.files, fingerprint: receipt.fingerprint }, dependencies: receipt.dependencies };
  const check = () => {
    directoryChain(home, profile); directoryChain(home, c.extensionRoot);
    if (receipt.afterLink.kind !== 'symlink' || path.resolve(path.dirname(c.link), receipt.afterLink.value) !== c.target ||
        !['symlink', 'missing'].includes(c.previousLink.kind)) fail('Recovery symlink identity is invalid');
    if (!matchesFile(c.manifestFile, receipt.afterManifest) || !matchesLink(c.link, receipt.afterLink)) fail('Rollback refused: profile or symlink changed since this installation');
    const target = validateTarget(c.target, c.extensionRoot, { ...c.input, dependencies: c.dependencies });
    const allowed = [c.target, ...desktopFileWorkbenchFiles.map(file => path.join(c.target, file)),
      ...['node_modules', 'node_modules/@deepseek-ai', 'node_modules/@deepseek-ai/dsh', markerName].map(file => path.join(c.target, file))];
    if (receipt.targetCreated && (target.marker.installId !== receipt.installId ||
        json((receipt.createdPaths || []).map(item => item.path).sort()) !== json(allowed.sort()) ||
        !sameIdentity(target.identity, receipt.createdTarget))) fail('Recovery target ownership is invalid');
    if (c.previousLink.kind === 'symlink') validateTarget(path.resolve(path.dirname(c.link), c.previousLink.value), c.extensionRoot);
  };
  check();
  if (!options.apply) return { status: 'rollback-planned', receipt: receiptPath, target: c.target, profile, retainsPreviousVersions: true };
  if (options.owner !== receipt.owner) fail('Rollback owner must match the installation receipt');
  const lock = acquireLock(c, options.owner);
  try {
    options.hooks?.beforeRollback?.(); check();
    // Completed immutable versions remain available for inspection and any late HMR
    // disposal. Only a failed, unpublished candidate is eligible for failure cleanup.
    const result = restoreOwned(c, { afterManifest: receipt.afterManifest, afterLink: receipt.afterLink });
    receipt.status = result.manifest === 'restored' && result.link === 'restored' ? 'rolled-back' : 'rollback-incomplete';
    receipt.retainedTarget = true;
    receipt.recovery = result; persistReceipt(receiptPath, receipt);
    return { status: receipt.status, receipt: receiptPath, retainedTarget: true, ...result };
  } finally { lock.release(); }
}

function cli(argv) {
  const args = [...argv], options = {}, positional = [];
  let rollback;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--apply') options.apply = true;
    else if (arg === '--owner') options.owner = args.shift();
    else if (arg === '--source') options.sourceDir = args.shift();
    else if (arg === '--rollback') rollback = args.shift();
    else if (arg.startsWith('--')) fail('Unknown installer option');
    else positional.push(arg);
  }
  const [home, modules] = positional;
  if (!home || (!rollback && !modules) || positional.length > (rollback ? 1 : 2)) fail('Usage: node scripts/install-desktop-file-workbench.mjs DSH_HOME RUNTIME_NODE_MODULES [--source DIR] [--apply --owner OWNER]; rollback: DSH_HOME --rollback RECEIPT [--apply --owner OWNER]');
  return rollback ? rollbackDesktopFileWorkbench(home, rollback, options) : installDesktopFileWorkbench(home, modules, options);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(json(cli(process.argv.slice(2))).trimEnd()); }
  catch (error) { console.error(error.message); if (error.receipt) console.error('Private recovery receipt: ' + error.receipt); process.exitCode = 1; }
}
