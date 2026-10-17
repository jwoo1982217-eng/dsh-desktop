# DSH Mac 桌面安装包

双击 `DSH-0.1.1-macOS-arm64.pkg`，按 macOS 安装器完成安装。然后在“应用程序”里打开 **DSH**；也可以将图标保留在 Dock。应用使用独立窗口，内置 Electron、Node.js 和固定的 DSH 核心，不需要启动终端或浏览器。

当前安装包支持 Apple 芯片 Mac、macOS 13 或更新版本。本地构建采用 ad-hoc 签名，尚未配置 Apple Developer ID 和公证；对外分发前需要补齐这两项。

## 日常使用

- 点击 DSH 图标打开窗口；重复点击会回到已有窗口。
- 关闭窗口会隐藏应用，正在进行的任务继续运行；点 Dock 图标可重新显示。
- 从菜单 **DSH → 退出 DSH** 完全退出。应用自己启动的后台服务会一起停止；通过旧启动器运行的服务继续运行。
- **DSH → 重新连接** 可恢复连接；已有服务健康时直接复用，不重复启动。
- 下载文件会出现 Mac 保存对话框。外部网站和部分账号授权链接仍按网站要求使用系统浏览器。

账号、聊天、技能、角色卡和设置继续位于 `~/.dsh`。安装器只写入 `/Applications/DSH.app`，不携带用户数据。首次由应用启动服务时，程序入口会切换到应用内的运行时，旧程序入口保存到 `~/.dsh/backups/mac-app-*`；用户配置和自定义插件保持。当前已有服务运行时直接连接，不迁移或重启它。

## 后续升级

退出 DSH，双击新版 `.pkg` 覆盖安装，再点图标打开即可。安装目标固定为 `/Applications/DSH.app`，用户数据在应用外，不需要重新添加账号或导入聊天。若此前另有旧启动脚本运行的 DSH 服务，需要先停止旧服务，才会使用新包内的程序。应用自己启动的服务会随“退出 DSH”一起停止。

当前版本尚未提供自动检查更新或一键更新。未来 DSH 核心发生数据格式变化时，需要先做数据备份与相应的迁移、恢复验证；不能仅凭替换窗口程序就保证跨核心版本兼容。

## 从源码构建

先准备仓库现有的固定 `desktop-runtime`（见上级安装文档），并使用 Node.js 24.14.0 在 Mac arm64 上执行：

```sh
npm --prefix desktop/macos/tools ci --ignore-scripts --no-audit --no-fund
node desktop/macos/build.mjs
```

需要同时打包已有 Our Free Model 插件时，通过 `--our-free-model /path/to/our-free-model` 指定其源码。`--out /path/to/output` 可自定义输出目录。构建只读取当前运行时与源码，不安装到你的 DSH profile，也不重启服务。

```sh
node --test desktop/macos/backend.test.mjs desktop/macos/release-links.test.mjs
```

输出包含 `.pkg`、SHA256 和 `build-receipt.json`。构建器检查发行物中的符号链接全部位于包内，保留依赖许可证，并验证 `.app` 的签名。安装包无 preinstall/postinstall 脚本。
