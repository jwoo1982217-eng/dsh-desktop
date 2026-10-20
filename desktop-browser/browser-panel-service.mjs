/** Transport-independent controller. The DSH adapter must authenticate every call. */
export class BrowserPanelService {
  constructor(browser) {
    this.browser = browser;
    this.panels = new Map();
    this.frames = new Map();
    this.revision = 0;
    this.onFrame = frame => {
      const tab = browser.tabs.get(frame.id);
      if (tab?.human && frame.metadata?.deviceWidth && frame.metadata?.deviceHeight) {
        tab.width = Math.round(frame.metadata.deviceWidth); tab.height = Math.round(frame.metadata.deviceHeight);
      }
      if (tab) this.frames.set(frame.id, { revision: ++this.revision, data: frame.data, width: tab.width, height: tab.height });
    };
    this.onClosed = () => { this.frames.clear(); this.panels.clear(); };
    this.onPopup = ({ openerId, tab }) => {
      for (const panel of this.panels.values()) if (panel.tabs.has(openerId)) {
        panel.tabs.add(tab.id);
        panel.queue = panel.queue.then(() => this.activate(panel, tab.id)).catch(() => {});
        break;
      }
    };
    browser.on('frame', this.onFrame);
    browser.on('closed', this.onClosed);
    browser.on('popup', this.onPopup);
  }
  panel(key) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(key)) throw Error('无效的浏览器面板');
    let panel = this.panels.get(key);
    if (!panel) {
      if (this.panels.size >= 32) throw Error('请先关闭不用的浏览器面板');
      this.panels.set(key, panel = { tabs: new Set(), active: undefined, queue: Promise.resolve() });
    }
    return panel;
  }
  status(panel) {
    const tabs = this.browser.list().filter(tab => panel.tabs.has(tab.id));
    if (!tabs.some(tab => tab.id === panel.active)) panel.active = tabs.at(-1)?.id;
    return { tabs, active: panel.active ?? null,
      loginProfile: 'DSH 专用浏览器资料：右侧面板、登录窗口与 AI 标签共享网站登录；普通 Chrome/Edge 资料不共享。',
      loginHelp: '安全验证加载失败时，可在右侧“浏览网站”点击“登录窗口”，由用户完成验证后刷新原网页。关闭单个标签页不会主动清除登录 Cookie。' };
  }
  async call({ panel: key, method, payload = {} }) {
    const panel = this.panel(key);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('无效的浏览器请求');
    if (method === 'status' || method === 'frame') await this.browser.refresh([...panel.tabs]);
    if (method === 'status') return this.status(panel);
    if (method === 'frame') {
      if (payload.id !== panel.active || !panel.tabs.has(payload.id)) return { ...this.status(panel), frame: null };
      const frame = this.frames.get(payload.id);
      return { ...this.status(panel), frame: frame && frame.revision !== payload.revision ? frame : null };
    }
    const operation = panel.queue.then(async () => {
      const id = payload.id ?? panel.active;
      if (!['new', 'open', 'release'].includes(method) && (!id || !panel.tabs.has(id))) throw Error('网页标签已关闭');
      switch (method) {
        case 'new':
        case 'open': {
          if (method === 'open' && id && panel.tabs.has(id)) await this.browser.navigate(id, payload.url);
          else {
            if (this.browser.tabs.size >= 16) throw Error('请先关闭不用的网页标签');
            const tab = await this.browser.newTab(payload.url);
            panel.tabs.add(tab.id);
            await this.activate(panel, tab.id);
          }
          break;
        }
        case 'select': await this.activate(panel, id); break;
        case 'login': {
          const current = this.browser.tab(id);
          if (current.human) {
            await this.browser.showWindow(id);
          } else {
            if (this.browser.tabs.size >= 16) throw Error('请先关闭不用的网页标签');
            const tab = await this.browser.newTab(current.url, { visible: true });
            panel.tabs.add(tab.id);
            await this.activate(panel, tab.id);
          }
          break;
        }
        case 'close':
          await this.browser.closeTab(id); panel.tabs.delete(id); this.frames.delete(id);
          if (id === panel.active) {
            panel.active = undefined;
            if (panel.tabs.size) await this.activate(panel, [...panel.tabs].at(-1));
          }
          break;
        case 'back': await this.browser.history(id, -1); break;
        case 'forward': await this.browser.history(id, 1); break;
        case 'reload': await this.browser.reload(id); break;
        case 'resize': this.frames.delete(id); await this.browser.resize(id, payload.width, payload.height); break;
        case 'pointer': await this.browser.pointer(id, payload); break;
        case 'text': await this.browser.text(id, payload.text); break;
        case 'key': await this.browser.key(id, payload); break;
        case 'pause': await this.browser.stopFrames(id); break;
        case 'resume': await this.browser.startFrames(id); break;
        case 'release':
          for (const owned of panel.tabs) {
            if (this.browser.tabs.has(owned)) await this.browser.closeTab(owned);
            this.frames.delete(owned);
          }
          panel.tabs.clear(); this.panels.delete(key); break;
        default: throw Error('不支持的浏览器操作');
      }
      return this.status(panel);
    });
    panel.queue = operation.catch(() => {});
    return operation;
  }
  async activate(panel, id) {
    if (panel.active && panel.active !== id && this.browser.tabs.has(panel.active)) await this.browser.stopFrames(panel.active);
    panel.active = id;
    await this.browser.startFrames(id);
  }
  async close() {
    this.browser.off('frame', this.onFrame);
    this.browser.off('closed', this.onClosed);
    this.browser.off('popup', this.onPopup);
    this.frames.clear(); this.panels.clear();
    await this.browser.close();
  }
}
