import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SystemLoginBrowser } from './system-login-browser.mjs';

export function workBuddyLoginAddress(address) {
  let url;
  try { url = new URL(address); } catch { throw Error('无效的 WorkBuddy 授权地址'); }
  if (url.origin !== 'https://www.workbuddy.ai' || url.pathname !== '/login' ||
      url.username || url.password || url.searchParams.get('platform') !== 'workbuddy-ai' ||
      !url.searchParams.get('state')) throw Error('无效的 WorkBuddy 授权地址');
  return url.href;
}

/** 每次授权新建普通浏览器进程和资料目录，并发登录也互不共享 Cookie。 */
export class IsolatedLoginService {
  constructor({ executable, directory = tmpdir(), timeoutMs = 310000,
    validateAddress = workBuddyLoginAddress, createBrowser = options => new SystemLoginBrowser(options) }) {
    Object.assign(this, { executable, directory, timeoutMs, validateAddress, createBrowser });
    this.sessions = new Map();
    this.disposed = false;
  }
  async open(address) {
    const url = this.validateAddress(address);
    if (this.disposed) throw Error('独立登录组件已停止');
    if (this.sessions.size >= 4) throw Error('请先完成或关闭已有登录窗口');
    const sessionId = randomUUID(), entry = {};
    this.sessions.set(sessionId, entry);
    entry.starting = Promise.resolve().then(async () => {
      entry.profile = await mkdtemp(path.join(this.directory, 'dsh-account-login-'));
      entry.browser = this.createBrowser({ executable: this.executable, profile: entry.profile });
      entry.browser.on('closed', () => { void this.close(sessionId).catch(() => {}); });
      entry.browser.on('tabs', tabs => {
        if (entry.ready && tabs.length === 0) void this.close(sessionId).catch(() => {});
      });
      await entry.browser.newTab(url, { visible: true });
      entry.ready = true;
      entry.timer = setTimeout(() => { void this.close(sessionId).catch(() => {}); }, this.timeoutMs);
      entry.timer.unref?.();
    });
    try {
      await entry.starting;
      if (this.disposed || entry.closing) throw Error('独立登录窗口已关闭');
      return { sessionId, isolated: true, browserMode: 'system' };
    } catch (error) {
      await this.close(sessionId);
      throw error;
    }
  }
  async close(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.closing ??= Promise.resolve().then(async () => {
      await entry.starting.catch(() => {});
      clearTimeout(entry.timer);
      try {
        await entry.browser?.close();
        // 等浏览器确实退出后再删资料，Windows 文件锁允许短暂重试。
        if (entry.profile) await rm(entry.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        this.sessions.delete(sessionId);
      } catch (error) {
        entry.closing = undefined;
        throw error;
      }
    });
    return entry.closing;
  }
  status() { return { browserMode: 'system', sessions: [...this.sessions].map(([sessionId, entry]) => ({ sessionId, ready: Boolean(entry.ready), closing: Boolean(entry.closing) })) }; }
  async dispose() {
    this.disposed = true;
    await Promise.all([...this.sessions.keys()].map(id => this.close(id)));
  }
}
