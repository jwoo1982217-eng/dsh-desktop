/** Keep preopened authorization tabs alive until their first real destination. */
export function externalUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

export function installPopupNavigation(contents, {isLocal, openExternal}) {
  contents.setWindowOpenHandler(({url}) => {
    if (url === 'about:blank' || isLocal(url)) return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        ...(url === 'about:blank' ? {show:false} : {}),
        webPreferences: {nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true, partition:'persist:dsh'},
      },
    };
    if (externalUrl(url)) openExternal(url);
    return {action:'deny'};
  });
  contents.on('did-create-window', (child, details) => {
    const placeholder = details.url === 'about:blank';
    let handedOff = false;
    const navigate = (event, url) => {
      if (url === 'about:blank' || isLocal(url)) return;
      event.preventDefault();
      if (!handedOff && externalUrl(url)) {handedOff = true; openExternal(url);}
      if (placeholder) setImmediate(() => {if (!child.isDestroyed()) child.close();});
    };
    child.webContents.on('will-navigate', navigate);
    child.webContents.on('will-redirect', navigate);
    installPopupNavigation(child.webContents, {isLocal, openExternal});
  });
}
