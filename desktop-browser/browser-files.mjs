/** 用户主动选择的文件暂存；不接受本机路径，只接受有界的文件块。 */
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const FILE_LIMITS = Object.freeze({ count: 8, fileBytes: 32 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, chunkBytes: 128 * 1024 });
const MAX_RESERVED_BYTES = 128 * 1024 * 1024;
const RETAIN_MS = 10 * 60 * 1000;

export class BrowserFiles {
  constructor() {
    this.records = new Map();
    this.timer = setInterval(() => { void this.expire().catch(() => {}); }, 60_000);
    this.timer.unref();
  }
  async expire() {
    for (const record of [...this.records.values()]) if (record.expiresAt <= Date.now()) await this.remove(record);
  }
  async begin(owner, tabId, context, files) {
    await this.expire();
    if (!Array.isArray(files) || files.length < 1 || files.length > FILE_LIMITS.count) throw Error('一次请选择 1–8 个文件');
    let total = 0;
    const normalized = files.map(file => {
      if (!file || typeof file.name !== 'string' || !file.name || file.name === '.' || file.name === '..' || /[\x00-\x1f\x7f/\\]/u.test(file.name) || Buffer.byteLength(file.name) > 240) throw Error('文件名无效');
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > FILE_LIMITS.fileBytes) throw Error('单个文件大小不能超过 32 MB');
      total += file.size;
      return { name: file.name, size: file.size, type: typeof file.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream', received: 0 };
    });
    if (total > FILE_LIMITS.totalBytes) throw Error('一次文件合计不能超过 64 MB');
    if (this.records.size >= 32 || total + [...this.records.values()].reduce((n, record) => n + record.total, 0) > MAX_RESERVED_BYTES) throw Error('正在处理的文件较多，请稍后重试');
    const directory = await mkdtemp(path.join(tmpdir(), 'dsh-browser-files-'));
    try {
      for (let index = 0; index < normalized.length; index++) {
        const folder = path.join(directory, String(index)); await mkdir(folder, { mode: 0o700 });
        normalized[index].path = path.join(folder, normalized[index].name);
        await writeFile(normalized[index].path, '', { mode: 0o600, flag: 'wx' });
      }
      const record = { id: randomUUID(), owner, tabId, context, directory, files: normalized, total, expiresAt: Date.now() + RETAIN_MS, delivered: false };
      this.records.set(record.id, record);
      return { uploadId: record.id, chunkBytes: FILE_LIMITS.chunkBytes };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  record(owner, tabId, id) {
    const record = this.records.get(id);
    if (!record || record.owner !== owner || record.tabId !== tabId || record.expiresAt <= Date.now()) throw Error('文件传输已失效或无权访问，请重新选择');
    return record;
  }
  async append(owner, tabId, { uploadId, index, offset, data }) {
    const record = this.record(owner, tabId, uploadId);
    if (record.delivered) throw Error('文件传输已结束');
    const file = Number.isInteger(index) ? record.files[index] : undefined;
    if (!file || !Number.isSafeInteger(offset) || offset !== file.received) throw Error('文件块顺序不正确，请重新选择');
    if (typeof data !== 'string' || data.length > Math.ceil(FILE_LIMITS.chunkBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error('文件块数据无效');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > FILE_LIMITS.chunkBytes || bytes.length + file.received > file.size || bytes.toString('base64') !== data) throw Error('文件块数据或大小无效');
    await appendFile(file.path, bytes);
    file.received += bytes.length; record.expiresAt = Date.now() + RETAIN_MS;
    return { received: file.received };
  }
  async commit(owner, tabId, id, deliver) {
    const record = this.record(owner, tabId, id);
    if (record.delivered) return record.result;
    if (record.files.some(file => file.received !== file.size)) throw Error('文件尚未完整传输，请重试');
    const result = await deliver(record.context, record.files);
    // 原生 File 可能在用户稍后提交表单时才读盘，交付后保留到本页离开。
    // 总量仍受 128 MiB 预留上限约束，不能定时删掉网页仍可能使用的附件。
    record.delivered = true; record.result = result; record.expiresAt = Infinity;
    return result;
  }
  async cancel(owner, tabId, id) {
    const record = this.record(owner, tabId, id);
    if (record.delivered) return { cancelled: false, delivered: true };
    await this.remove(record); return { cancelled: true };
  }
  async remove(record) { await rm(record.directory, { recursive: true, force: true }); this.records.delete(record.id); }
  async release(tabId, documentId, deliveredOnly = false) {
    for (const record of [...this.records.values()]) if (record.tabId === tabId && (documentId === undefined || record.context.documentId === documentId) && (!deliveredOnly || record.delivered)) await this.remove(record);
  }
  async clear() { for (const record of [...this.records.values()]) await this.remove(record); }
  async close() { clearInterval(this.timer); await this.clear(); }
}
