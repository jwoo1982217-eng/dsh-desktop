# 0.1.9 界面定向发布候选

本次修复 SSH 在会话头部和状态区重复占位、分享在输入区和消息区显示大卡片的问题。桌面只同步 `web-capabilities.mjs`、`settings/workbench-client.js`、`conversation/client.js` 三个冻结文件，保留原 87 个运行文件的闭包、原桌面 `index.mjs`、SSH vendor、0.2.1-alpha.4 核心及两个已验证 SDK 补丁。手机新增包装入口与原生模块不进入桌面包。

`build-selective.mjs` 使用已核验的 0.1.8 App 程序基线。`baselines/0.1.8.json` 固定 App asar、程序清单、旧 ownership marker、87 个文件以及核心和两个 SDK 补丁的指纹；构建还验证基线签名。不会从运行 profile 复制用户数据，也不把现场文件或链接的当前指纹自动列为可覆盖版本。

```sh
node desktop/macos/build-selective.mjs TASK/generated/mac-release DESKTOP_REPO/peer/feature-absorption EXISTING_PROFILE VERIFIED_0.1.8_APP
```

输出必须在已登记且未超预算的任务 generated 内，同一目录不覆盖已有构建。第四参数必须为封存的程序 App，不能替换成用户运行时目录。第三参数保留命令兼容，不作为程序指纹的信任来源。

现有 profile 升级只接受发布清单中明确列出的旧 SHA 或新 SHA。0.1.8 的 ownership marker SHA `5f76cea1b4b65d504c1e52019e67f090b27caef74bc24a7dc68a4681cc5e9b75` 已作为明确前驱，不能仅凭 marker 的 owner 标签覆盖自定义字节。实际迁移只发布三份新文件和新 marker；其余 84 个文件也会检查自定义漂移，账号、会话、其他插件、配置及额外用户文件保留。

程序和三处 SDK 链接仍使用原有受控事务：先保存私有恢复材料，再逐文件原子发布；未知锁、并发修改、损坏备份会拒绝覆盖。进程中断后的下一次启动只恢复自己的死进程事务。SDK 链接保持指向本 App 同一个实例，不整体替换 profile 或用户后装插件。

```sh
node --test desktop/macos/selective-upgrade.test.mjs desktop/macos/program-update.test.mjs desktop/macos/program-links.test.mjs desktop/macos/program-recovery.test.mjs
```

上述 20 项源测试已通过，包括实际 87 文件升级、幂等、旧 marker、自定义文件或 marker 拒绝、发布失败回退和真实子进程中断恢复。打包完成后还必须验证最终 stage 的 94 行程序清单、87 文件、40 项 SSH 依赖文件及独立 dependency-lock、SDK 实际解析路径与签名；源码测试不等于已安装。

2026-10-31 已安装 0.1.8 的实际恢复另已完成：无探针 LaunchAgent 以原 cwd、KeepAlive、RunAtLoad 和 ExitTimeOut15 启动 App 内核心，GUI 复用同一核心；原会话 123 与视频壁纸显示正常。壁纸插件可选预热跳过旧符号链接的补丁只位于用户既有插件目录，有单独私有恢复点，不由本次增强包覆盖。34.75 秒真实库存重扫与 HTTP 检查保留 403 会话和原 230 插件状态，三星经原 LAN 配对连续两次读取各 1.45MB 内容一致。此记录不等于 WAN 或系统注销登录测试。

0.1.9 当前是可审查构建候选，已复制到 build-delivery/macos-dshgo-20261031 并回读 SHA，尚未安装。本轮在确认空闲与空草稿后正常退出 GUI，随后部署被暂停；尚未 bootout 服务、停止核心、替换 App 或运行升级器。原 0.1.8 GUI 已重新打开并复用核心 29969，403 会话、原 230 插件状态及空输入均通过只读核验，profile 配置和旧 marker 指纹未变。不能声称新界面已在桌面生效。实际发布需另记空闲检查、备份、安装及界面验收。ad hoc 重签会改变代码身份，不应预先宣称既有文件夹授权一定沿用，也不应扩大为完全磁盘访问；本轮构建未改变任何系统授权。

永久验收材料位于 `deepseek hardness/reports/dsh-go-1.0.2/feature-absorption/release-install/`：`mac-wallpaper-prewarm-deployment.json` 为 0.1.8 实机恢复；`desktop019-source-before.json`、`desktop019-source-frozen.json` 和 `desktop019-stage.json` 记录本次原有 WIP、冻结源与最终 stage。部署记录须继续区分安装 App、运行 core 路径、用户数据保留和真实业务结果。
