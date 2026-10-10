import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** 授权交给用户在普通浏览器中完成，登录窗口不连接调试器。 */
export class SystemLoginBrowser extends EventEmitter {
  constructor({ executable, profile, spawnProcess = spawn }) {
    super();
    Object.assign(this, { executable, profile, spawnProcess });
    this.disposed = false;
  }
  async newTab(url) {
    if (this.disposed || this.child) throw Error('登录窗口已打开或关闭');
    const child = this.child = this.spawnProcess(this.executable, [
      `--user-data-dir=${this.profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-background-mode', '--new-window', url,
    ], { stdio: 'ignore', windowsHide: false });
    child.once('exit', () => this.emit('closed'));
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(Error('无法启动普通登录浏览器')));
    });
  }
  async close() {
    this.disposed = true;
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      let forceTimer, failureTimer;
      const finished = () => { clearTimeout(forceTimer); clearTimeout(failureTimer); resolve(); };
      child.once('exit', finished);
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2000);
      failureTimer = setTimeout(() => {
        child.off('exit', finished);
        clearTimeout(forceTimer);
        reject(Error('登录浏览器仍未退出，请关闭本次登录窗口后重试'));
      }, 5000);
      // 只关闭本次创建的 Chrome/Edge 主进程，不按应用名称结束其他窗口。
      child.kill('SIGTERM');
    });
  }
}
