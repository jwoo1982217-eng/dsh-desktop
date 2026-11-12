# DSH 电脑端源码目录

本仓库是 DSH 电脑端的规范源码根：`dsh-desktop-public`。Android 手机端在相邻的独立仓库 `../dsh-phone-public` 维护，两者各有自己的 `.git`、分支与提交历史。

| 目录或文件 | 职责 |
| --- | --- |
| `desktop/macos/`、`desktop/windows/` | 桌面应用、平台适配与安装包构建 |
| `desktop-runtime/` | 电脑端 Node/DSH 依赖与锁文件 |
| `scripts/install-desktop.mjs`、`scripts/start-desktop.mjs` | 电脑版源码安装和启动入口 |
| `desktop-browser/`、`desktop-chatgpt/`、`desktop-enhancements/` | 电脑版浏览器、授权适配和增强功能 |
| `runtime/overlays/`、`runtime/pocket-update/` | SDK 适配与 Pocket 更新适配 |
| `peer/`、`vendor/`、`phone-account/`、`phone-qq/` 等 | 本仓库维护的插件与共用能力；名称含 phone 的插件仍可能由电脑版使用 |
| `build-delivery/` | 安装包等交付物，不是源码入口 |

本机分类入口是 `../DSH源码/电脑端源码`，指向本仓库。实际源码仍只保留这一份，现有服务和应用继续使用原规范路径。

手机版仓库中的旧桌面目录不作为电脑版维护或部署入口。两端需要同一修复时分别核对版本和已有工作，只同步确定的改动；不复制整套工程或直接覆盖插件目录。
