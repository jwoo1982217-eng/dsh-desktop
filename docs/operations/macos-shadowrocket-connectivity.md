# macOS：DSH 与小火箭连接修复

本记录对应 2026-10-25 单台 Mac 上的实际处置，DSH 核心为 `0.2.1-alpha.4`。提交包含配置示例、恢复步骤和脱敏验收摘要；本机配置与 launchd 状态由操作系统保存。

## GitHub 抓取被非公网地址检查拦截

现场系统 DNS 将 GitHub 域名解析到 `198.18.0.0/15` 地址段。DSH 后台未配置显式代理时，网页抓取返回 `WEB_BLOCKED_URL`。同版核心支持从 `DSH_HOME/.env` 读取代理，接入小火箭已有 HTTP 代理后，网页抓取由代理处理域名解析。公网 IP 检查和 TLS 校验保持原样。

本机代理为 `http://127.0.0.1:1082`；其他机器应先核对实际监听端口。配置示例：[shadowrocket-proxy.env.example](examples/shadowrocket-proxy.env.example)。在仓库根目录执行下面的命令仅会创建原本不存在的配置：

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home"
if [ -e "$dsh_home/.env" ]; then
  echo "已有配置：请先备份，再合并代理字段，保留其他内容。"
else
  install -m 600 docs/operations/examples/shadowrocket-proxy.env.example "$dsh_home/.env"
fi
```

`NO_PROXY` 保留本地界面、本机 API 桥接和 `.local` 主机的直连。小火箭需要保持连接，并监听配置中的 HTTP 代理端口。

代理在 DSH 启动时加载。先确认所有运行中的对话任务结束；使用本机已登记的 `ai.deepseek.dsh` 服务时，可正常重启后台：

```sh
launchctl kill SIGTERM "gui/$(id -u)/ai.deepseek.dsh"
```

等后台完成启动并可通过现有鉴权连接，再用 DSH 的网页抓取验证 GitHub 和 raw README。启动期间的暂时超时应先等待就绪，避免重复重启。网页工具直接访问本地 IP 时仍应返回 `WEB_BLOCKED_URL`。

恢复时，将 `.env` 还原为操作前的版本，再于空闲时重启 DSH。仅当该文件原本不存在、内容仍与本示例完全一致且未加入其他配置时，才可删除这份新建文件。

## 小火箭连接开关自行关闭

现场系统日志在 10:13 和 12:31 两次明确记录：Shadowrocket 收到 `Microsoft Defender Helper` 发出的停止命令。可先用下面的命令核对本机实际调用方：

```sh
log show --last 1d --style compact --info --predicate 'process == "nesessionmanager" AND eventMessage CONTAINS[c] "Shadowrocket" AND eventMessage CONTAINS[c] "stop command"'
```

只有确认调用方属于同一个 Defender 托盘助手，并接受其托盘图标、相关通知及账号界面停用的影响后，才应用本次处置：

```sh
launchctl disable "gui/$(id -u)/com.microsoft.wdav.tray"
launchctl bootout "gui/$(id -u)/com.microsoft.wdav.tray"
```

本次保留了 Defender 杀毒主进程和程序文件；进程存在不能单独证明防护健康。launchd 的禁用设置跨系统重启保留。本次核对了即时状态及短时未重新拉起，尚未重启 macOS 或进行长期观察。手动重新启用助手、重新安装或更新 Defender 后，需要重新核查。

恢复助手：

```sh
launchctl enable "gui/$(id -u)/com.microsoft.wdav.tray"
launchctl bootstrap "gui/$(id -u)" /Library/LaunchAgents/com.microsoft.wdav.tray.plist
```

恢复操作会重新允许该助手运行；若它已加载，应先核对状态，避免重复 bootstrap。

## 验收范围

[脱敏验收摘要](verification/macos-shadowrocket-20261025.json) 保存实际结果：正式 DSH 网页抓取完整读取 README，GitHub 页面可达，原会话保留；本地直连、鉴权门禁、网页工具的本地 IP 限制以及坏代理恢复均有验证。

GitHub HTML 仍受原有 100000 字符上限约束。AutoClaw 的繁忙或套餐拒绝，以及这类错误被显示为“密钥无效”的问题，未包含在本次代理配置修复中。
