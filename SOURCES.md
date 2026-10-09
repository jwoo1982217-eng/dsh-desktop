# 源码来源

电脑版适配基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，核心固定为 npm 发布的 `0.2.1-alpha.1`。依赖由 `desktop-runtime/pnpm-lock.yaml` 固定，安装时校验锁文件。

本次独立整理的源文件来自 [DSH 手机与共享适配仓库](https://cnb.cool/applecabal/dsh-phone) 的提交 `904ea96477626bbdb96989f7394f9f3ae6719337`，保留电脑版安装器、共享账号与远程协议、插件源码及兼容层。初始公开提交重新建立历史，不带私人开发目录或运行数据。

- `vendor/dsh-codearts-auth`：Jet Hub 插件源码与客户端资源。
- `vendor/dsh-channel-qq`：QQ 消息适配插件源码。
- `vendor/dsh-noema`：Noema 插件及其上游源码。
- `peer/vendor`、`phone-account/vendor`：保留 DeepSeek 上游许可证的适配器源码。
- `runtime/overlays`：按模块保留上游许可证的兼容改动；桌面使用原生平台分支。
- `peer/presentation.*`、`peer/browser-compat.js`：两端共用的界面适配资源。
- `dsh-pocket`：手机扫码访问插件，固定 npm 2.10.6，来源 [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket)，沿用 GPL-2.0 许可证；通过锁文件安装，未改写上游包。

各上游组件沿用其目录中 LICENSE 或 package.json 声明的许可证。本仓库不将第三方代码重新许可，也不包含从其他应用提取的原生运行库、APK 或私人素材。
