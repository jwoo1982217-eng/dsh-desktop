# 电脑 Noema 原生依赖补齐

记忆开关已开启，但操作提示 `bundled package @zseven-w/dsh-noema-darwin-arm64 is not installed` 时，当前 profile 里的插件可能是独立副本，无法找到桌面运行时已安装的原生包。

先按项目锁文件安装桌面运行时并保留 optional dependencies，然后在项目根目录执行：

```sh
node scripts/repair-desktop-noema.mjs
```

默认处理 `DSH_HOME/profiles/web`，未设置 DSH_HOME 时使用 `~/.dsh/profiles/web`。自定义目录可传 `--profile 目录`；自定义固定运行时可传 `--modules node_modules目录`。

脚本核对当前平台、插件版本及运行时锁定版本，只补齐匹配的原生包和 profile 的 optional dependency、锁文件记录。保留原插件源码、记忆设置、凭据和聊天，不重启 DSH。原清单与锁文件保存在 profile 的 `.noema-native-repair-backup-*` 中；已经补齐时重复运行不改文件。已有不同原生包、不同版本声明或并发修改会被保留并报错。

完成后在原 DSH 的「设置 → Noema Memory」查询记忆目录。运行状态和查询成功说明引擎可用；用户记忆仍遵守原来的审核政策。

2026-10-12 的 Mac ARM64 修复使用固定 Noema `0.1.0-rc.1`，原生包文件与官方 npm 包逐字一致。正式运行服务的目录、待审、临时写入、随机标记召回及精确清理均通过，原目录和待审内容恢复，核心进程未重启。手机配置不在此修复范围。

验证脚本及隔离的真实原生引擎读写：

```sh
node --test scripts/repair-desktop-noema.test.mjs
```
