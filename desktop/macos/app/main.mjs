import {app, BrowserWindow, Menu, dialog, shell} from 'electron';
import {appendFile, mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Backend, existingBackend, redact, coreVersion} from './backend.mjs';
import {externalUrl, installPopupNavigation} from './popup-navigation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
const resources = process.resourcesPath;
const isWindows = process.platform === 'win32';
if (isWindows) {
  app.setName('DSH');
  app.setPath('userData', path.join(app.getPath('appData'), 'DSH'));
  app.setAppUserModelId('ai.deepseek.dsh');
}
const logDirectory = path.join(app.getPath('userData'), 'logs');
let window, backend, origin, connecting = false, quitting = false;
const splash = path.join(here, 'splash.html');
const log = message => appendFile(path.join(logDirectory, 'desktop.log'), `${new Date().toISOString()} ${redact(message)}\n`, {mode: 0o600}).catch(() => {});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => { if (isWindows) app.quit(); });
  app.on('before-quit', event => {
    if (quitting) return;
    quitting = true;
    if (!backend?.owned) return;
    event.preventDefault();
    backend.stop().finally(() => app.quit());
  });
  app.whenReady().then(async () => {
    await mkdir(logDirectory, {recursive: true, mode: 0o700});
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label: 'DSH', submenu: [{label: '关于 DSH', role: 'about'}, {type: 'separator'},
        {label: '重新连接', click: () => connect()},
        {label: '显示数据文件夹', click: () => shell.openPath(home)},
        ...(isWindows ? [] : [{type: 'separator'}, {role: 'hide', label: '隐藏 DSH'}, {role: 'hideOthers', label: '隐藏其他'},
        {role: 'unhide', label: '全部显示'}]), {type: 'separator'}, {role: 'quit', label: '退出 DSH'}]},
      {label: '编辑', submenu: [{role: 'undo', label: '撤销'}, {role: 'redo', label: '重做'}, {type: 'separator'},
        {role: 'cut', label: '剪切'}, {role: 'copy', label: '复制'}, {role: 'paste', label: '粘贴'}, {role: 'selectAll', label: '全选'}]},
      {label: '显示', submenu: [{role: 'reload', label: '刷新'}, {role: 'resetZoom', label: '实际大小'},
        {role: 'zoomIn', label: '放大'}, {role: 'zoomOut', label: '缩小'}, {role: 'togglefullscreen', label: '全屏'}]},
      {label: '窗口', submenu: [{role: 'minimize', label: '最小化'}, ...(isWindows ? [] : [{role: 'zoom', label: '缩放'}]), {label: '显示 DSH', click: () => showWindow()}]},
    ]));
    app.setAboutPanelOptions({applicationName: 'DSH', applicationVersion: app.getVersion(), version: 'DSH '+coreVersion, copyright: 'DSH 桌面版'});
    createWindow();
    await connect();
  }).catch(error => { log(error.message); dialog.showErrorBox('DSH 启动失败', redact(error.message)); });
}

function allowedLocal(url) {
  try { return !!origin && new URL(url).origin === origin; } catch { return false; }
}
function external(url) {
  if (externalUrl(url)) shell.openExternal(url).catch(() => {
    log('无法打开外部页面，请检查系统默认浏览器。');
    dialog.showErrorBox('无法打开页面', '请确认系统默认浏览器可用，或使用登录弹窗中的“复制登录链接”。');
  });
}
function createWindow() {
  window = new BrowserWindow({title: 'DSH', width: 1360, height: 900, minWidth: 850, minHeight: 600,
    backgroundColor: '#f8f9fc', show: false,
    ...(isWindows ? {icon: path.join(resources, 'icon.ico')} : {}),
    webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, partition: 'persist:dsh'}});
  window.once('ready-to-show', () => window.show());
  window.on('close', event => { if (!quitting && !isWindows) { event.preventDefault(); window.hide(); } });
  window.webContents.on('will-navigate', (event, url) => {
    if (allowedLocal(url) || url.startsWith('file:') && url.split('?')[0] === pathToFileURL(splash).href) return;
    event.preventDefault(); external(url);
  });
  installPopupNavigation(window.webContents, {isLocal:allowedLocal, openExternal:external});
  const session = window.webContents.session;
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    !!contents && allowedLocal(requestingOrigin) && ['clipboard-sanitized-write', 'fullscreen'].includes(permission));
  session.setPermissionRequestHandler(async (contents, permission, callback) => {
    if (!allowedLocal(contents.getURL())) return callback(false);
    if (['clipboard-sanitized-write', 'fullscreen'].includes(permission)) return callback(true);
    if (!['media', 'notifications', 'clipboard-read'].includes(permission)) return callback(false);
    const label = {media: '使用麦克风', notifications: '发送通知', 'clipboard-read': '读取剪贴板'}[permission];
    const result = await dialog.showMessageBox(window, {type: 'question', buttons: ['允许', '取消'], defaultId: 1, cancelId: 1, message: `允许 DSH ${label}吗？`});
    callback(result.response === 0);
  });
  session.on('will-download', (event, item) => item.setSaveDialogOptions({title: '保存 DSH 文件'}));
  window.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && allowedLocal(url)) showSplash('连接暂时断开', '请从菜单 DSH → 重新连接恢复窗口。');
  });
}
function showWindow() {
  if (!window || window.isDestroyed()) createWindow();
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
async function showSplash(title, detail = '首次启动需要一点时间。') {
  if (!window || window.isDestroyed()) return;
  await window.loadFile(splash, {query: {title, detail}});
}
async function connect() {
  if (connecting) return;
  connecting = true; showWindow();
  try {
    await showSplash('正在启动 DSH…');
    const port = Number(process.env.DSH_DESKTOP_PORT || 3080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('DSH 端口配置无效。');
    if (backend?.owned) {
      const live = await existingBackend(path.resolve(home), port);
      if (live) { origin = new URL(live.url).origin; await window.loadURL(live.url); return; }
      await backend.stop();
    }
    backend = new Backend({home, runtime: path.join(resources, 'runtime'), node: path.join(resources, 'bin', isWindows ? 'node.exe' : 'node'), port, cwd: homedir(), log});
    backend.on('unavailable', () => { if (!quitting) showSplash('DSH 已停止', '请从菜单 DSH → 重新连接再次启动。'); });
    const state = await backend.start();
    origin = new URL(state.url).origin;
    await window.loadURL(state.url);
    window.setTitle('DSH');
  } catch (error) {
    log(error.message);
    await showSplash('暂时无法打开 DSH', redact(error.message));
  } finally { connecting = false; }
}
