# 桌面增量集成（2026-10-21）

- 上游：`https://gitee.com/iJetLi/deepseek-harness-codearts`，固定提交 `78dc506cf42bb1821a20cd4378f2b81cd8de8ded`，包 `dsh-providers-hub@0.2.1-rc.2`。
- 与本地增强版作三方增量合并，不以官方发行包覆盖本地功能。
- 桌面核心继续锁定 `0.2.1-alpha.4`；宿主构建使用 `tsconfig.product.json`，客户端同步重建。不是核心升级。
- 旧名 `dsh-codearts-auth` 仅保留模块解析别名，profile bundles 只激活新版一次；配置行 id `codearts-auth` 和 `codeartsAuth` 服务不变。
- 保留 ChatGPT 会员入口、OrcaTerm、原生 OpenCode、本地网关、账号排序/粘滞与分模型故障转移、实际候选上下文窗口、ZCode 来源和待领取说明、AutoClaw 短信与 WorkBuddy 独立浏览器登录。
- 上游新增国际渠道、目录与积分共享缓存、关闭供应商目录门控、协议/签名/工具历史修复同步接入。新增 OpenCode Zen V2 源码保留，但不擅自替换用户原生 OpenCode 默认通道；既有可选 /inference 实现单独保留，不自动启用。
- 验证覆盖固定实际 SDK、完整实际插件图的隔离冷启动、真实本地 HTTP 网关与图片/错误恢复、账号选择与上下文回归；没有据此宣称所有供应商的真实云端账号/登录/额度均已验证。
- 升级需先确认无活动任务、保存完整现用 App 和配置备份，再只切换 JetHub 与名称引用；其他插件、凭据和会话不覆盖。
