import path from 'node:path';
import {compareVersions, readReleases, installerAsset, downloadInstaller, coreRepository, desktopRepository} from './update-catalog.mjs';

/** Native menu action; public release metadata never receives local settings or credentials. */
export function createUpdateAction({dialog, shell, getWindow, appVersion, coreVersion, cacheDirectory, log, releaseReader = readReleases, downloader = downloadInstaller}) {
  let checking = false;
  return async function checkUpdates() {
    if (checking) return;
    checking = true;
    const show = options => {
      const window = getWindow();
      return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
    };
    try {
      const [coreResult, desktopResult] = await Promise.allSettled([
        releaseReader(coreRepository), releaseReader(desktopRepository),
      ]);
      if (coreResult.status === 'rejected' && desktopResult.status === 'rejected') throw coreResult.reason;
      const core = coreResult.status === 'fulfilled' ? coreResult.value[0] : null;
      const desktop = desktopResult.status === 'fulfilled' ? desktopResult.value.find(row => compareVersions(row.tag_name, appVersion) > 0 && installerAsset(row)) : null;
      const coreNewer = core && compareVersions(core.tag_name, coreVersion) > 0;
      const detail = [
        `当前桌面版：${appVersion}\n当前核心：${coreVersion}`,
        core ? `官方核心：${core.tag_name.replace(/^dsh-v/, '')}${core.prerelease ? '（预览版）' : ''}` : '官方核心检查失败，可重试。',
        desktop ? `可安装的定制版：${desktop.tag_name}` : desktopResult.status === 'rejected' ? '定制版检查失败，可重试。' : '定制版更新源暂未发布更新的本机安装包。',
        coreNewer && !desktop ? '官方核心需要与现有定制插件一同适配；可查看更新说明，适配包发布后在这里下载安装。' : '',
        desktop ? '安装前请保存草稿并等待任务结束。安装器确认后才更新应用；账号、聊天和设置继续保存在原数据目录。' : '',
      ].filter(Boolean).join('\n\n');
      const buttons = desktop ? ['下载更新包', '查看更新说明', '关闭'] : core ? ['查看更新说明', '关闭'] : ['关闭'];
      const choice = await show({type: 'info', title: 'DSH 更新', message: desktop ? '有可安装的桌面更新' : coreNewer ? '官方核心有新版本' : '更新检查完成', detail, buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1});
      if (desktop && choice.response === 0) {
        const confirm = await show({type: 'question', message: `下载 ${desktop.tag_name} 定制版更新包？`, detail: '下载完成并校验 SHA-256 后打开系统安装器。安装器中确认才会安装。', buttons: ['下载', '取消'], defaultId: 1, cancelId: 1});
        if (confirm.response !== 0) return;
        const file = await downloader(desktop, path.join(cacheDirectory, 'updates'));
        const result = await shell.openPath(file);
        if (result) throw Error('更新包已下载，但无法打开安装器。请在应用缓存 updates 目录中打开安装包。');
      } else if ((desktop && choice.response === 1) || (!desktop && core && choice.response === 0)) {
        await shell.openExternal((desktop ?? core).html_url);
      }
    } catch (error) {
      log?.('更新检查或下载失败：' + error.message);
      await show({type: 'error', message: '暂时无法完成更新', detail: String(error.message), buttons: ['关闭']});
    } finally { checking = false; }
  };
}
