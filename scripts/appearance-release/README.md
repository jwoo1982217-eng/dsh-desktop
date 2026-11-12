# 电脑端外观：本地字体与可视化选色

从手机端提交 `efe493e` 选择性同步独立 `appearance/` 模块。设置 → 外观支持浏览字体文件夹、筛选、单个样张、应用和持久化，并以色块和系统调色盘选择强调色、背景色及文字色。

Mac 快捷入口为用户字体（~/Library/Fonts）、系统字体（/Library/Fonts）、内置字体（/System/Library/Fonts）、下载及用户文件夹。访问范围限制在用户目录和这两处字体目录，路径按 realpath 核对；符号链接越界、失效文件、非字体及超过32MiB的单个文件会被拒绝。每目录最多列出300个字体，只登记引用，预览时仅加载选中的字体。字体移动或修改后需要重扫。

外观客户端保持同步返回、后台恢复；本地字体须实际加载成功后才保存选择。保持现有主题、代码及终端字号、账号、会话和壁纸插件。用户正在编辑的草稿和后来产生的外观选择不能用验收前的快照覆盖。

`program-update.mjs` 用于显式文件清单的受控部署：先核对原文件SHA，保留恢复点，失败回退，重试幂等。只替换当前profile中dsh-appearance-center的七个已知程序文件，新增三个字体和颜色模块，不整目录覆盖，不写profile配置或签名应用。更新前确认无运行中会话，正常停止核心；更新后重启并验证原生窗口、设置入口、实际字体与颜色，以及再次重开后的恢复。恢复原程序同样需要先停核心，并保留更新后的用户配置。

维护源码的macOS构建映射已将appearance作为输入，后续正常构建会包含这些功能。此次为既有0.1.10部署独立外观模块，不构建新的PKG或改动应用签名。

验证：

```sh
node --experimental-vm-modules --test appearance/store.test.mjs appearance/startup.test.mjs appearance/font-library.test.mjs scripts/appearance-install.test.mjs scripts/appearance-release/program-update.test.mjs
node appearance/font-color-ui.test.mjs docs/appearance-fonts-colors-20261103/browser
node appearance/ui.test.mjs docs/appearance-fonts-colors-20261103/host-ui
```

测试复用已安装的Chrome和SDK，不下载浏览器或复制整套运行时。新目录入口另有macOS断言；坏字体、无效引用、越界、原子保存失败、模块中断恢复和旧外观卸载恢复均纳入回归。浏览器夹具通过不能代替正式DSH窗口验收。
