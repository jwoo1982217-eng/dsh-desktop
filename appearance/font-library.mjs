import {open, readFile, readdir, realpath, stat, mkdir, writeFile, rename, rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {homedir} from 'node:os';

const extensions = /\.(ttf|otf|ttc|woff2?)$/i;
const MAX_BYTES = 32 * 1024 * 1024;
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
export const localFont = value => /^local:[a-f0-9]{64}$/.test(value);

export function fontLocations(platform = process.platform, userHome = homedir()) {
  if (platform === 'darwin') return {
    roots: [userHome, '/Library/Fonts', '/System/Library/Fonts'],
    shortcuts: [{name:'用户字体',path:path.join(userHome,'Library/Fonts')}, {name:'系统字体',path:'/Library/Fonts'},
      {name:'内置字体',path:'/System/Library/Fonts'}, {name:'下载',path:path.join(userHome,'Downloads')}, {name:'用户文件夹',path:userHome}],
  };
  return {roots:[userHome],shortcuts:[{name:'字体文件夹',path:path.join(userHome,'Fonts')},
    {name:'下载',path:path.join(userHome,'Downloads')},{name:'用户文件夹',path:userHome}]};
}

/** Local file references only: browsing never loads an entire folder into memory. */
export class FontLibrary {
  constructor(home, roots, shortcuts) {
    const defaults = fontLocations();
    this.file = path.join(home, 'appearance/font-library.json');
    this.rootPaths = roots || defaults.roots;
    this.shortcuts = shortcuts || (roots ? roots.map(root => ({name:path.basename(root),path:root})) : defaults.shortcuts);
    this.queue = Promise.resolve();
  }
  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.roots = [];
      for (const root of this.rootPaths) {
        try { this.roots.push(await realpath(root)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      if (!this.roots.length && process.platform !== 'android') this.roots.push(await realpath(homedir()));
      this.state = {directory: this.roots[0], fonts: {}};
      try {
        const saved = JSON.parse(await readFile(this.file, 'utf8'));
        if (!saved || typeof saved.directory !== 'string' || !saved.fonts || typeof saved.fonts !== 'object') throw Error('字体目录记录无效');
        this.state = saved;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    })();
    try { await this.ready; } catch (e) { this.ready = null; throw e; }
  }
  async allowed(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('请选择本机文件夹');
    const actual = await realpath(file);
    if (!this.roots.some(root => inside(root, actual))) throw Error('请选择用户文件夹或系统字体目录内的文件夹');
    return actual;
  }
  async status() {
    await this.init();
    return {directory: this.state.directory, roots: this.roots,
      shortcuts: this.shortcuts,
      fonts: Object.values(this.state.fonts).filter(f => path.dirname(f.path) === this.state.directory).map(({path: _path, ...font}) => font)};
  }
  async browse(directory) {
    await this.init();
    const actual = await this.allowed(directory || this.state.directory);
    const entries = await readdir(actual, {withFileTypes: true});
    const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a,b) => a.name.localeCompare(b.name));
    return {directory: actual, parent: this.roots.includes(actual) ? null : path.dirname(actual),
      folders: folders.slice(0, 300).map(e => ({name: e.name, path: path.join(actual, e.name)})), truncated: folders.length > 300};
  }
  scan(directory) {
    const job = this.queue.then(async () => {
      await this.init();
      const actual = await this.allowed(directory);
      const entries = (await readdir(actual, {withFileTypes: true})).filter(e => e.isFile() && extensions.test(e.name)).sort((a,b) => a.name.localeCompare(b.name));
      const fonts = [];
      for (const entry of entries.slice(0, 300)) {
        const file = path.join(actual, entry.name);
        try {
          const info = await stat(file);
          if (info.size <= 0 || info.size > MAX_BYTES) continue;
          const id = createHash('sha256').update(file + '\0' + info.size + '\0' + info.mtimeMs).digest('hex');
          fonts.push({id, name: entry.name, path: file, bytes: info.size, modified: info.mtimeMs});
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      const saved = Object.fromEntries(Object.entries(this.state.fonts).filter(([, f]) => path.dirname(f.path) !== actual));
      for (const font of fonts) saved[font.id] = font;
      if (Object.keys(saved).length > 2000) throw Error('已登记的字体过多，请继续使用现有字体目录');
      const next = {directory: actual, fonts: saved};
      const temp = this.file + '.' + randomUUID();
      await mkdir(path.dirname(this.file), {recursive: true, mode: 0o700});
      try { await writeFile(temp, JSON.stringify(next), {mode: 0o600}); await rename(temp, this.file); this.state = next; }
      finally { await rm(temp, {force: true}); }
      return {...await this.status(), truncated: entries.length > 300};
    });
    this.queue = job.catch(() => {});
    return job;
  }
  async read(id) {
    await this.init();
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw Error('请重新扫描字体目录');
    const font = this.state.fonts[id];
    if (!font || await this.allowed(font.path) !== font.path) throw Error('字体路径已改变，请重新扫描');
    const handle = await open(font.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== font.bytes || info.mtimeMs !== font.modified || info.size > MAX_BYTES) throw Error('字体文件已改变，请重新扫描');
      const body = await handle.readFile();
      const magic = body.subarray(0,4).toString('hex');
      if (!['00010000','4f54544f','74746366','774f4646','774f4632','74727565'].includes(magic)) throw Error('文件不是受支持的字体');
      return body;
    } finally { await handle.close(); }
  }
}
