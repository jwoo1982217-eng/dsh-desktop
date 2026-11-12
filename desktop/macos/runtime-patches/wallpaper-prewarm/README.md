# Wallpaper Engine 可选预热保护候选

仅适用于已核验的 `dsh-plugin-wallpaper-engine@1.3.3`，只改 `lib/faststart.js`。

真实问题是 GUI 清单重扫会预热前 12 个视频：预热循环虽声明为 async，内部的 MP4 布局分析仍同步打开文件。已有视频 alias 指向另一 App 的容器；打开等待时，整个 DSH 核心 HTTP 都被阻塞。轮播关闭不能阻止这个独立预热器。

此补丁只在可选预热中用 `lstatSync` 检查路径本身，跳过最终符号链接、目录、FIFO、缺失或不可获取元数据的条目。保留原 12 项预算与顺序；正常显式播放、导入、faststart API 和全部墙纸配置保持原实现。没有删除或导入任何媒体、关闭插件或更改系统权限。

这不是完整文件系统沙箱：不保证并发替换或父目录链接的隔离，也不解决显式选择其他旧 alias 时的 OS 访问等待。当前选中视频的普通文件导入属于父代理独立执行的数据修复，不在此脚本中。

## 指纹

- 修改前：`9af9ceb3e8f88a8e9bb2d09713116d2379ba47d106253c5341afa4d7f73b2622`
- 修改后：`90dece6d7ac7b0b007553b31cb707b95ec8ac696e5e04d089b680f0789fac4a6`
- `faststart.patch` 是准确统一差异；`fixtures/faststart-before.txt` 保留原文。
- `fixtures/ordinary.mp4` 是本机生成的 16×16、1 秒 avc1 实际 MP4，无用户媒体内容。

## 安装与回退

先由部署方确认核心已空闲并停止，避免文件监视器在逐个发布期间热加载。两个目标之间不是文件系统上的单次原子操作；脚本逐文件原子改名，预先保存全部原文，失败时按 SHA 守卫回退。

只读计划：

```sh
node desktop/macos/runtime-patches/wallpaper-prewarm/install.mjs plan --target ~/.dsh/plugins/dsh-plugin-wallpaper-engine --target ~/.dsh/profiles/web/node_modules/dsh-plugin-wallpaper-engine
```

安装使用相同的两个 `--target`，将 `plan` 改成 `apply`，并加 `--backup` 指定全新、绝对路径的私有恢复目录。已有备份不覆盖。两目标当前是同 inode 的硬链接；逐文件改名会打断该链接，但两处最终内容一致。

回退：

```sh
node desktop/macos/runtime-patches/wallpaper-prewarm/install.mjs rollback --backup /ABSOLUTE/PRIVATE/RECOVERY_DIRECTORY
```

安装与回退都先验证所有目标和恢复字节。未知版本、未知当前 SHA、损坏恢复材料或并发编辑会拒绝操作；不覆盖用户改动。备份会保留。

## 验证

```sh
node --test desktop/macos/runtime-patches/wallpaper-prewarm/prewarm.test.mjs
```

测试默认只读使用本机维护目录的原 MP4 解析器，也可用 `DSH_WALLPAPER_PLUGIN` 指向同版插件。夹具在本任务登记的 generated/wallpaper-prewarm-tests 下创建并清理，不绑定真实用户会话或媒体。覆盖实际 MP4 预热、链接与非普通文件不打开、旧函数红例、显式 API 保留、双硬链接路径安装、幂等、失败恢复和 SHA 拒绝边界。

源码依据是本机已安装的 MIT 插件 1.3.3（仓库地址来自其 package.json：`https://github.com/elysia395/dsh-wallpaper-engine`）；补丁没有下载或重建整个 SDK。维护目录 `~/.dsh/plugins/dsh-plugin-wallpaper-engine` 当前不是 Git 仓库。
