# Pocket 桌面更新适配

适用于本项目的独立 Node 桌面核心和 macOS 应用，已实际验证 Pocket 2.10.6 → 2.12.0。

`patch.mjs` 保留 Pocket 原功能和 GPL-2.0 声明，仅替换自更新调用及相应提示。更新使用当前桌面核心和 Node，在 DSH_HOME/dsh-pocket/updates 下的独立 profile 安装 npm 官方包及依赖，验证后只切换当前 profile 的 Pocket 入口。失败保留旧安装，并发配置修改拒绝覆盖；成功留下原清单和旧入口备份。

更新成功不自动结束 DSH 核心。界面提示重新打开后生效；应在所有任务结束后重启服务。macOS 启动器会保留带适配标记、版本不低于内置包的更新，避免启动时恢复旧版。

适配会随新 Pocket 包一起保留。遇到未识别的接口布局会停止发布，保留原安装。上游来源：https://github.com/shaobeichen/dsh-pocket 。本地适配脚本不会改变 npm 注册表发布内容。

验证：`node --test scripts/desktop-pocket-update.test.mjs scripts/desktop-pocket-install.test.mjs desktop/macos/backend.test.mjs desktop/windows/backend.test.mjs`。实际 npm 安装、独立核心 HTTP 和实际前端组件验证入口分别是同目录 scripts 下的 `desktop-pocket-update.integration.mjs`、`desktop-pocket-update.boot.mjs` 和 `desktop-pocket-update.ui.mjs`；它们使用独立测试目录，不使用个人账号。
