import { spawn } from 'node:child_process';
import { access, mkdir, chmod } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export function websiteAddress(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020]/u.test(value.trim())) throw Error('请输入有效网址');
  let address = value.trim();
  if (!address) throw Error('请输入网址');
  if (/^(?:file|javascript|data|about|blob|ftp|mailto|ws|wss):/iu.test(address)) throw Error('仅支持 HTTP 和 HTTPS 网站');
  const bareHostPort = /^[^/?#:]+:\d+(?:[/?#]|$)/u.test(address);
  if (!/^[a-z][a-z\d+.-]*:/iu.test(address) || bareHostPort) {
    const loopback = /^(?:(?:[\w-]+\.)*localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(?:[/?#]|$)/iu.test(address);
    address = `${loopback ? 'http' : 'https'}://${address}`;
  }
  let url;
  try { url = new URL(address); } catch { throw Error('请输入有效网址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('仅支持 HTTP 和 HTTPS 网站');
  return url.href;
}

/** Private Chrome pipe: no listening debugging port or executable page content. */
class ChromePipe extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    child.stdio[4].on('data', bytes => this.receive(bytes));
    child.stdio[3].on('error', error => this.fail(error));
    child.stdio[4].on('error', error => this.fail(error));
    child.on('error', error => this.fail(error));
    child.on('exit', () => this.fail(Error('浏览器进程已退出')));
  }
  receive(bytes) {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > 32 * 1024 * 1024) return this.fail(Error('浏览器响应过大'));
    let end;
    while ((end = this.buffer.indexOf(0)) !== -1) {
      const packet = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      if (!packet.length) continue;
      let message;
      try { message = JSON.parse(packet.toString('utf8')); }
      catch { this.fail(Error('浏览器通信格式异常')); return; }
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(Error(message.error.message));
        else request.resolve(message.result ?? {});
      } else if (message.method) this.emit('event', message);
    }
  }
  send(method, params = {}, sessionId, timeout = 15000) {
    if (this.closed) return Promise.reject(Error('浏览器未连接'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('浏览器操作超时'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      this.child.stdio[3].write(JSON.stringify(message) + '\0', error => {
        if (error) this.fail(error);
      });
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.emit('closed', error);
  }
}

/** Original component intended for the desktop website tab. */
export class DesktopBrowser extends EventEmitter {
  constructor({ executable, profile, width = 1024, height = 768 }) {
    super();
    this.executable = executable;
    this.profile = profile;
    this.viewport = { width, height };
    this.tabs = new Map();
    this.disposed = false;
  }
  async start() {
    if (this.disposed) throw Error('浏览器已关闭');
    if (this.pipe && !this.pipe.closed) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await access(this.executable);
      await mkdir(this.profile, { recursive: true, mode: 0o700 });
      await chmod(this.profile, 0o700);
      const child = spawn(this.executable, [
        '--no-startup-window', '--remote-debugging-pipe', `--user-data-dir=${this.profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--disable-component-update', '--disable-sync', 'about:blank'
      ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stderr.on('data', () => {});
      const pipe = this.pipe = new ChromePipe(child);
      pipe.on('event', message => this.event(message));
      pipe.on('closed', () => {
        if (this.pipe !== pipe) return;
        this.tabs.clear();
        this.emit('closed');
      });
      try {
        this.version = await pipe.send('Browser.getVersion');
        await pipe.send('Browser.setDownloadBehavior', { behavior: 'deny' });
        await pipe.send('Target.setDiscoverTargets', { discover: true });
        // --no-startup-window leaves an existing persistent profile unloaded.
        // Initialize its default context with a minimized, empty bootstrap page;
        // otherwise Chrome rejects hidden targets on the second launch.
        const bootstrap = await pipe.send('Target.createTarget', { url: 'about:blank',
          newWindow: true, background: true, windowState: 'minimized' });
        await pipe.send('Target.closeTarget', { targetId: bootstrap.targetId });
      } catch (error) { child.kill('SIGTERM'); throw error; }
    })();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  event(message) {
    if (message.method === 'Target.targetCreated') {
      const info = message.params.targetInfo;
      if (info.type === 'page' && this.tabs.has(info.openerId) && !this.tabs.has(info.targetId)) {
        void this.adoptPopup(info).catch(() => {});
      }
    }
    if (message.method === 'Target.targetInfoChanged') {
      const tab = this.tabs.get(message.params.targetInfo.targetId);
      if (tab) { tab.url = message.params.targetInfo.url; tab.title = message.params.targetInfo.title; this.emit('tab', this.summary(tab)); }
    }
    if (message.method === 'Target.targetDestroyed') {
      if (this.tabs.delete(message.params.targetId)) this.emit('tabs', this.list());
    }
    if (message.method === 'Page.screencastFrame') {
      const tab = [...this.tabs.values()].find(value => value.sessionId === message.sessionId);
      this.pipe.send('Page.screencastFrameAck', { sessionId: message.params.sessionId }, message.sessionId).catch(() => {});
      if (tab) this.emit('frame', { id: tab.id, data: message.params.data, metadata: message.params.metadata });
    }
  }
  async adoptPopup(info) {
    if (this.tabs.size >= 16) { await this.pipe.send('Target.closeTarget', { targetId: info.targetId }); return; }
    const { sessionId } = await this.pipe.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
    const tab = { id: info.targetId, sessionId, url: info.url, title: info.title, human: Boolean(this.tabs.get(info.openerId)?.human), ...this.viewport };
    this.tabs.set(tab.id, tab);
    await this.send(tab, 'Page.enable');
    await this.resize(tab.id, tab.width, tab.height);
    this.emit('popup', { openerId: info.openerId, tab: this.summary(tab) });
  }
  summary(tab) { return { id: tab.id, url: tab.url, title: tab.title, width: tab.width, height: tab.height, ...(tab.human ? { loginWindow: true } : {}) }; }
  list() { return [...this.tabs.values()].map(tab => this.summary(tab)); }
  async refresh(ids) {
    await Promise.all(ids.map(async id => {
      const tab = this.tabs.get(id);
      if (!tab || Date.now() - (tab.refreshedAt || 0) < 1000) return;
      tab.refreshedAt = Date.now();
      const result = await this.pipe.send('Target.getTargetInfo', { targetId: id }).catch(() => undefined);
      if (result && this.tabs.get(id) === tab) {
        tab.url = result.targetInfo.url; tab.title = result.targetInfo.title;
      }
    }));
  }
  tab(id) {
    const tab = this.tabs.get(id);
    if (!tab || !this.pipe || this.pipe.closed) throw Error('网页标签已关闭');
    return tab;
  }
  send(tab, method, params = {}) { return this.pipe.send(method, params, tab.sessionId); }
  async newTab(address, { visible = false } = {}) {
    const url = address === undefined ? 'about:blank' : websiteAddress(address);
    await this.start();
    // Hidden targets retain normal Chrome rendering without opening a desktop
    // window for every agent tab. Human verification uses a visible target in
    // this exact browser context, so no cookies or credentials are copied.
    const parameters = { url: 'about:blank',
      ...(visible ? { newWindow: true, background: false, width: 1100, height: 900 } : { hidden: true, background: true }) };
    // On headed Chrome the pipe answers before hidden-target support is ready,
    // especially immediately after reopening the same profile.
    const deadline = Date.now() + 5000;
    let targetId;
    while (true) {
      try { ({ targetId } = await this.pipe.send('Target.createTarget', parameters)); break; }
      catch (error) {
        if (visible || !error.message.includes('Hidden target can be created only when remote debugging is enabled') || Date.now() >= deadline) throw error;
        await delay(50);
      }
    }
    try {
      const { sessionId } = await this.pipe.send('Target.attachToTarget', { targetId, flatten: true });
      const tab = { id: targetId, sessionId, url: 'about:blank', title: '', human: visible, ...this.viewport };
      this.tabs.set(tab.id, tab);
      await this.send(tab, 'Page.enable');
      await this.resize(tab.id, tab.width, tab.height);
      if (url !== 'about:blank') await this.navigate(tab.id, url);
      this.emit('tabs', this.list());
      return this.summary(tab);
    } catch (error) {
      this.tabs.delete(targetId);
      await this.pipe.send('Target.closeTarget', { targetId }).catch(() => {});
      throw error;
    }
  }
  async navigate(id, address) {
    const tab = this.tab(id), url = websiteAddress(address);
    const result = await this.send(tab, 'Page.navigate', { url });
    if (result.errorText) throw Error(`网页加载失败：${result.errorText}`);
    tab.url = url;
    return this.summary(tab);
  }
  async reload(id) { return this.send(this.tab(id), 'Page.reload'); }
  async showWindow(id) {
    if (!this.tab(id).human) throw Error('该标签不是登录窗口');
    await this.pipe.send('Target.activateTarget', { targetId: id });
  }
  async history(id, direction) {
    if (![-1, 1].includes(direction)) throw Error('无效的浏览方向');
    const tab = this.tab(id), history = await this.send(tab, 'Page.getNavigationHistory');
    const entry = history.entries[history.currentIndex + direction];
    if (entry) await this.send(tab, 'Page.navigateToHistoryEntry', { entryId: entry.id });
    return Boolean(entry);
  }
  async resize(id, width, height) {
    const tab = this.tab(id);
    if (![width, height].every(Number.isInteger) || width < 320 || width > 2560 || height < 240 || height > 2160) throw Error('无效的网页尺寸');
    if (tab.human) {
      await this.send(tab, 'Emulation.clearDeviceMetricsOverride');
      const { cssLayoutViewport: viewport } = await this.send(tab, 'Page.getLayoutMetrics');
      if (viewport) { tab.width = Math.round(viewport.clientWidth); tab.height = Math.round(viewport.clientHeight); }
      return;
    }
    await this.send(tab, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    tab.width = width; tab.height = height;
  }
  async startFrames(id) {
    this.tab(id);
    await this.pipe.send('Target.activateTarget', { targetId: id });
    // Page.navigate may return before Chromium commits the new document.
    const deadline = Date.now() + 5000;
    while (true) {
      try { return await this.send(this.tab(id), 'Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 }); }
      catch (error) {
        if (!error.message.includes('Not attached to an active page') || Date.now() >= deadline) throw error;
        await delay(50);
      }
    }
  }
  async stopFrames(id) { return this.send(this.tab(id), 'Page.stopScreencast'); }
  async screenshot(id) { return this.send(this.tab(id), 'Page.captureScreenshot', { format: 'png' }); }
  async pointer(id, { type, x, y, button = 'none', buttons = 0, deltaX = 0, deltaY = 0, modifiers = 0 }) {
    const tab = this.tab(id);
    if (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(type) || !['none', 'left', 'right', 'middle'].includes(button) || ![x, y, deltaX, deltaY].every(Number.isFinite) || x < 0 || y < 0 || x > tab.width || y > tab.height || !Number.isInteger(buttons) || buttons < 0 || buttons > 7 || !Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15) throw Error('无效的鼠标操作');
    return this.send(tab, 'Input.dispatchMouseEvent', { type, x, y, button, buttons, modifiers, ...(type === 'mousePressed' || type === 'mouseReleased' ? { clickCount: 1 } : {}), ...(type === 'mouseWheel' ? { deltaX, deltaY } : {}) });
  }
  async text(id, value) {
    if (typeof value !== 'string' || value.length > 65536) throw Error('无效的输入内容');
    return this.send(this.tab(id), 'Input.insertText', { text: value });
  }
  async key(id, { type, key, code, modifiers = 0, windowsVirtualKeyCode = 0 }) {
    if (!['keyDown', 'keyUp', 'rawKeyDown'].includes(type) || typeof key !== 'string' || key.length > 64 || typeof code !== 'string' || code.length > 64 || !Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15 || !Number.isInteger(windowsVirtualKeyCode)) throw Error('无效的键盘操作');
    return this.send(this.tab(id), 'Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode });
  }
  async closeTab(id) {
    const tab = this.tab(id);
    await this.pipe.send('Target.closeTarget', { targetId: tab.id });
    this.tabs.delete(id);
    this.emit('tabs', this.list());
  }
  async close() {
    this.disposed = true;
    if (this.starting) await this.starting.catch(() => {});
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await this.pipe.send('Browser.close', {}, undefined, 3000).catch(() => {});
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
