# 源码来源

- `team/vendor/ds-bot`：正式 npm `ds-bot@0.1.5`，来源 [Fei2411/DeepSeek-Bot](https://github.com/Fei2411/DeepSeek-Bot)，沿用 Apache-2.0 许可证；原始文件和发行完整性在 `team/upstream.json` 登记。`team` 的本地适配负责模式切换、角色卡复制和已有工具、技能衔接。

电脑版适配基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，核心固定为 npm 发布的 `0.2.1-alpha.4`。依赖由 `desktop-runtime/pnpm-lock.yaml` 固定，安装时校验锁文件。

本次独立整理的源文件来自 [DSH 手机与共享适配仓库](https://cnb.cool/applecabal/dsh-phone) 的提交 `904ea96477626bbdb96989f7394f9f3ae6719337`，保留电脑版安装器、共享账号与远程协议、插件源码及兼容层。初始公开提交重新建立历史，不带私人开发目录或运行数据。

- `vendor/dsh-codearts-auth`：Jet Hub 插件源码与客户端资源。
- `vendor/dsh-channel-qq`：QQ 消息适配插件源码。
- `vendor/dsh-noema`：Noema 插件及其上游源码。
- `peer/vendor`、`phone-account/vendor`：保留 DeepSeek 上游许可证的适配器源码。
- `runtime/overlays`：按模块保留上游许可证的兼容改动；桌面使用原生平台分支。
- `peer/presentation.*`、`peer/browser-compat.js`：两端共用的界面适配资源。
- `dsh-pocket`：手机扫码访问插件，初装锁定 npm 2.10.6，来源 [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket)，保留 GPL-2.0 许可证。桌面构建及安装会应用 [本地更新适配](runtime/pocket-update/README.md)，已验证升级到 2.12.0；适配仅进入本地安装目录，不改写 npm 发布包。

各上游组件沿用其目录中 LICENSE 或 package.json 声明的许可证。本仓库不将第三方代码重新许可，也不包含从其他应用提取的原生运行库、APK 或私人素材。

## 官方能力选择性吸收（2026-10-30）

固定参考 `deepseek-ai/deepseek-harness@ce7073d51254c26cd63b22a60835b8f948deb447`，核心仍为 `0.2.1-alpha.4`。`runtime/overlays/@deepseek-ai/dsh-agent-instructions/src/upstream-render.ts` 保留官方 MIT renderer，按全局/项目各自预算渲染。压缩模块保留本地分段和恢复实现，补充切模型时先用原模型压缩；插件更新沿用本版原有移除、安装与热加载接口，按官方更新流程在独立包中编排。`desktop-enhancements` 为适配本版公共事件与客户端插槽的独立实现，提供耗时/缓存统计与逐项确认、失败恢复的注册源插件更新。本地、链接、内置与受管理插件不进入该更新入口。没有整包升级核心或迁移会话格式。

## JetHub 桌面增量跟进（2026-10-21）

固定上游 `iJetLi/deepseek-harness-codearts@ff16e517f27c054f05e657d8216867e02a0575bd`（`dsh-providers-hub@0.2.1-rc.2`），在既有增强代码上三方合并；桌面核心保持 `0.2.1-alpha.4`，不替换其它插件或用户数据。兼容性和保留策略见 `vendor/dsh-codearts-auth/docs/desktop-local-integration.md`。源文件中的个人账号示例已脱敏；未发布本地私有备份与验证夹具。
