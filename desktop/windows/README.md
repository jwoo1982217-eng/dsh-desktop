# Windows 桌面安装包

目标：Windows 10/11 x64，当前用户安装，Electron 独立窗口。包含 Node.js、Noema 记忆引擎、OpenCode 本地服务和 Windows 原生依赖。账号与聊天存放在用户的 `.dsh`，发行包不含用户资料。

## 构建

需要 Node.js 24、Python 3，以及一个已整理并验证的完整程序运行时（含 `bundle.json` 和扁平 `node_modules`）。可复用 `desktop/macos/build.mjs` 产生的 `work/runtime`；本脚本会替换其中的平台包，并移除其他平台的二进制，不会打包 Mac 应用或用户配置目录。

```sh
npm ci --prefix desktop/windows/tools --ignore-scripts --no-audit --no-fund
node desktop/windows/build.mjs --runtime /absolute/program-only/runtime --out /absolute/build/windows --tools /absolute/source/desktop/windows/tools
```

产物：`DSH-0.1.6-Windows-x64-Setup.exe`、SHA-256、逐文件清单和构建回执。`runtime-lock.json` 锁定所有下载来源与 SHA-256。微软 CRT 从固定官方安装程序中提取，不需要用户单独安装运行库。修改版本时同步应用包、运行时 bundle 与说明中的版本。

`--reuse-stage` 仅供同一次发布调整 Electron 壳或安装脚本后重打包；它不重新生成或验证原生运行时，不可用来跳过首次完整构建。

## 安装与生命周期

- 默认目录 `%LOCALAPPDATA%\Programs\DSH`，桌面与开始菜单快捷方式，Windows 设置中的卸载入口。
- 使用目录 junction 挂载内置插件，普通用户无需开发者模式或管理员权限。
- Windows PATH 去除大小写重复项，显式指向捆绑的 `opencode.exe`。
- 关闭窗口后，父进程通过私有 IPC 请求后台正常清理；超时才结束本应用拥有的进程树。复用的外部 DSH 服务不会被关闭。
- 更新、卸载遇到程序文件锁定时要求关闭 DSH；卸载仅删除清单内的程序文件，保留用户配置及另存的文件。
- Windows 日志目录 `%APPDATA%\DSH\logs`。

## 验证边界

```sh
node --test desktop/windows/backend.test.mjs desktop/macos/backend.test.mjs desktop/macos/popup-navigation.test.mjs desktop/macos/release-links.test.mjs
```

交付前还应解开最终 NSIS 包并与逐文件清单核对，确认所有 PE 原生组件为 AMD64、无 Mach-O/ELF、CRT 导入完整。资源修改仅改 DSH.exe 的图标和版本，须核对可执行代码段未改变。

解包 NSIS 需要支持该格式的完整 `7zz`。构建依赖 `7zip-bin` 内的旧 `7za` 可解 CAB，但不含 NSIS 解码器；它的“无法打开为压缩包”不能据此判定 EXE 损坏。使用官方 7-Zip 26.04 解包，再与当次构建的完整逐文件清单核对。

当前发布在 macOS 上交叉构建，未签名。宿主测试及安装包结构检查不能替代 Windows 上的安装、首次启动、模型登录、记忆、图片、OpenCode 调用和卸载验收。构建回执会明确标记 `windowsNativeLaunchVerified: false`。
