import { browserExecutable } from './index.mjs';
import { IsolatedLoginService } from './isolated-login-service.mjs';

export const name = 'dsh-desktop-isolated-login';
export const inject = ['connection'];

export function apply(ctx) {
  if (process.env.DSH_PHONE_ANDROID === '1') return;
  let service, starting, disposed = false;
  async function getService() {
    if (disposed) throw Error('独立登录组件已停止');
    if (service) return service;
    starting ??= browserExecutable().then(executable => {
      if (disposed) throw Error('独立登录组件已停止');
      return service = new IsolatedLoginService({ executable });
    }).finally(() => { starting = undefined; });
    return starting;
  }
  ctx.connection.rpc.handle('/desktop-isolated-login', async (method, payload) => {
    try {
      if (method !== 'manage' || !payload) throw Error('无效的独立登录请求');
      const current = await getService();
      if (payload.action === 'open') return { ok: true, value: await current.open(payload.url) };
      if (payload.action === 'close') {
        if (typeof payload.sessionId !== 'string') throw Error('无效的登录窗口编号');
        await current.close(payload.sessionId);
        return { ok: true, value: {} };
      }
      if (payload.action === 'status') return { ok: true, value: current.status() };
      throw Error('无效的独立登录操作');
    } catch {
      // The authorization URL/state must never appear in an error or log.
      return { ok: false, error: { code: 'login/browser-unavailable', message: '独立登录窗口启动失败，请确认已安装 Chrome 或 Edge，关闭不用的登录窗口后重试。', details: {} } };
    }
  }, { authority: 'loopback' });
  ctx.effect(() => async () => {
    disposed = true;
    if (starting) await starting.catch(() => {});
    await service?.dispose();
  });
}
