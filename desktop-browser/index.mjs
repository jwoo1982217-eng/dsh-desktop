import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DesktopBrowser } from './browser-engine.mjs';
import { BrowserPanelService } from './browser-panel-service.mjs';

export const name = 'dsh-desktop-browser';
export const inject = ['webServer', 'connection'];

export async function browserExecutable(env = process.env, platform = process.platform) {
  const candidates = env.DSH_BROWSER_EXECUTABLE ? [env.DSH_BROWSER_EXECUTABLE] : platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : platform === 'win32' ? [
    path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw Error('请先安装 Chrome 或 Edge，再重新打开浏览器面板');
}

export function apply(ctx) {
  if (process.env.DSH_PHONE_ANDROID === '1') return;
  let service, starting, disposed = false;
  async function getService() {
    if (disposed) throw Error('浏览器已停止');
    if (service) return service;
    starting ??= (async () => {
      const executable = await browserExecutable();
      if (disposed) throw Error('浏览器已停止');
      service = new BrowserPanelService(new DesktopBrowser({ executable,
        profile: path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'browser/profile') }));
      return service;
    })().finally(() => { starting = undefined; });
    return starting;
  }
  ctx.connection.rpc.handle('/desktop-browser', async (method, payload) => {
    try {
      if (method !== 'manage' || !payload) throw Error('无效的浏览器请求');
      const current = await getService();
      return { ok: true, value: await current.call(payload) };
    } catch (error) {
      return { ok: false, error: { code: 'browser/unavailable', message: error.message, details: {} } };
    }
  }, { authority: 'loopback' });
  ctx.provide('desktopBrowser', { getService });
  const page = readFileSync(new URL('./browser-panel.html', import.meta.url));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-browser', handler(req, res) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) { res.writeHead(rejection).end('请重新打开 DSH 登录入口'); return; }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'",
    });
    res.end(page);
  } }));
  ctx.effect(() => async () => { disposed = true; if (starting) await starting.catch(() => {}); await service?.close(); });
}
