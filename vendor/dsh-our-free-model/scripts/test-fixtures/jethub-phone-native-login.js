/** 原生窗口只回传当前登录的凭据，写入仍由本机 JetHub RPC 校验账号归属。 */
export function openPhoneNativeLogin({ provider, accountId, loginUrl, rpcCall, onError, onCancel, browserWindow = window }) {
  if (!['orcaterm', 'magicrew'].includes(provider) || !accountId || typeof rpcCall !== 'function') throw Error('手机登录上下文不完整');
  const callback = provider === 'orcaterm' ? '__dshOrcaTermLogin' : '__dshMagicrewLogin';
  const previous = browserWindow[callback];
  let closed = false, completed = false, busy = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    if (browserWindow[callback] === receive) browserWindow[callback] = previous;
    return completed ? Promise.resolve() : rpcCall('login.cancel', { accountId }).catch(() => {});
  };
  const receive = async payload => {
    if (closed || completed) return;
    let data;
    try { data = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch { return; }
    if (data?.accountId !== accountId) return;
    if (data.cancelled === true) { await close(); onCancel?.(); return; }
    if (busy) return;
    if (data.value == null) return;
    busy = true;
    try {
      await rpcCall('account.create', { provider, mode: 'manual', accountId, credential: data.value });
      completed = true;
    } catch { onError?.('手机登录凭据未能保存，请重新登录。'); }
    finally { busy = false; }
  };
  browserWindow[callback] = receive;
  const scheme = new URL(`dsh-phone://${provider}/login`);
  scheme.searchParams.set('account', accountId);
  scheme.searchParams.set('url', loginUrl);
  try { browserWindow.location.href = scheme.toString(); }
  catch { browserWindow[callback] = previous; throw Error('无法打开手机登录窗口'); }
  return {
    get closed() { return closed; },
    close,
  };
}
