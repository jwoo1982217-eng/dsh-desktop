# 桌面 0.1.10：知识库索引自动回收

规范源码 `peer/knowledge-link/kb` 增加受 writer lock 保护的代际回收、读租约保护及不可变分片共享。成功发布、无变化更新、迁移后清理；保留当前、上一代、正在读取和近期的目录。先完整校验保留代，再回收旧代及失效来源缓存；不改变原始知识、会话、模型或索引格式。

`desktop/macos/build-kb-retention.mjs` 只接受 `kb-retention-release.json` 固定的 0.1.9 App 程序基线。继承其全部功能与运行资源，仅更新七个引擎文件、受控程序升级清单及应用版本 0.1.10。本次定向升级清单只负责这七个文件，不耦合其他插件的旧升级事务。同步修正 asar 完整性字段，重新签名验证并生成 macOS arm64 PKG。不会打包本机 profile、账号或其他源码 WIP。

```sh
node desktop/macos/build-kb-retention.mjs TASK/generated/mac VERIFIED_0.1.9_APP
node --import ./scripts/desktop-test-imports.mjs --test peer/knowledge-link/kb-retention.test.mjs peer/knowledge-link/automatic-recall.test.mjs peer/knowledge-link/shared-recall.test.mjs peer/knowledge-link/automatic-recall.native.test.mjs peer/knowledge-link/shared-recall.native.test.mjs peer/knowledge-link/knowledge.test.mjs
```

新包同时包含实际运行副本和程序升级载荷，全新安装及已知旧版覆盖均得到修复。只在已固定 SHA 的恢复模块中增加这七个精确路径，并同步应用到 daemon 和 asar 两份模块，不放宽目录前缀或其他恢复检查。程序升级仍使用原有逐 SHA 前驱检查、私有备份及失败恢复；其他插件与用户配置保留。手动回收默认预览：`node kb.cjs gc --config CONFIG`，显式 `--apply` 才执行。

`DSH_KB_PACKAGE_APP=TASK/generated/mac/payload/DSH.app node --test desktop/macos/kb-retention-package.test.mjs` 直接调用实际打包的升级与恢复模块，检查七文件升级、重复执行、保留其他自定义程序、自改拒绝及发布中断恢复。引擎测试按实际硬链接能力验证共享或普通写入回退，不能把桌面的 inode 行为强加给 Android。

部署前确认正式任务空闲，保留原应用恢复点及用户数据指纹；替换后通过原 LaunchAgent 启动核心并打开 GUI。重启后自动召回按三十分钟节流。索引本身随知识量正常增长，活跃读者可让代数暂时超过两代，不承诺整个知识库的固定字节配额。
