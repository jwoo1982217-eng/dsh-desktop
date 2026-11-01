# 固定地址长连接服务

此服务在常驻 Node.js 进程中转发 DSH 的加密 WebSocket 帧，不使用 Durable Objects 逐条处理消息。它不运行模型或任务，不接收模型账号密钥。服务容量取决于服务器及网络，不承诺无限带宽或永不离线。

设备首次打开连接链接后保存配对。日常电脑运行 DSH，手机打开已保存的电脑；短暂断网后由现有 PeerTunnel 自动重连。电脑离线时保留配对，不重新生成链接。

## 运行条件

使用 Node.js 22 或更新版及 ws 8.22.0。部署目录保留 `remote-relay-node/`、`peer/relay.mjs`、`peer/protocol.mjs`、`remote-relay/worker.mjs`，ws 安装在这些目录共同的父目录 `node_modules/ws`。

私有配置示例：

```json
{
  "port": 18789,
  "adminKeyFile": "/private/dsh-relay/admin-key",
  "admissionsFile": "/private/dsh-relay/admissions.json"
}
```

配置、管理员密钥及授权文件只允许服务账号读取。密钥不得写入源码、日志或启动参数。

```sh
node remote-relay-node/server.mjs /private/dsh-relay/config.json
```

服务只监听 127.0.0.1。公网服务器通过 HTTPS/WSS 反向代理发布固定域名，转发 `/relay` 的 WebSocket Upgrade。已有合法证书的反向代理或命名隧道负责 TLS；不关闭证书校验，不直接发布 DSH 的本机核心端口。

`service.mjs` 是命名隧道方案的可选进程管理入口，需要另行配置 cloudflared 和私有 token 文件。只有真实隧道、设备连接及重新连接验收通过，才算部署完成；DNS 已绑定或健康页返回 200 都不能替代设备验收。

## 授权与恢复

管理接口兼容 `RemoteService`：`POST /admin/rooms` 登记，`DELETE /admin/rooms/<room>` 撤销，管理员凭据使用 Authorization 请求头。连接升级前检查已登记的 room 和 proof，加入时再次检查，撤销会关闭已连接和尚未加入的套接字。

只持久化授权摘要与撤销状态，使用原子写入；不持久化消息。重启后原配对仍可使用，损坏的授权文件导致启动失败，不自动清空。客户端请求和回复保留现有加密、方向、会话及重放保护。

本机回归：

```sh
node --import ./scripts/desktop-test-imports.mjs --test \
  peer/relay-startup.test.mjs peer/peer.test.mjs remote-relay-node/server.test.mjs
```
