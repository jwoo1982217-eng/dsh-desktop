# Pocket 遥控适配

面向现有 DSH 0.2.2 与社区 Pocket 2.12.0。独立模块 peer/feature-absorption/pocket-layout-compat.mjs 处理移动端AppFrame列位置，并提供自己的模型目录共享脚本；Pocket页面等待30秒，本机页面仍为8秒。保持原访问认证、取消和错误语义。

现有综合功能入口含其他未提交工作，故仅用 feature-host-integration.patch 记录本任务的两行接入；调用必须放在原HTML注入tap注册之后，保证重写脚本URL。该模块及旁边的 pocket-model-catalog-budget.js 一同部署。当前真实profile已接入，不要求重启健康核心。

真实三星手机向电脑DSH发送 uname -s，电脑Bash工具返回Darwin，手机显示相同结果，独立测试会话正常结束。证据见 acceptance.json；冷加载仍偏慢，不能称持续稳定或蜂窝网络验收通过。

验证：node --test peer/feature-absorption/pocket-layout-compat.test.mjs peer/feature-absorption/pocket-model-catalog-budget.test.mjs，12项通过，包含共享、不同RPC关联、调用者取消、超时、错误与恢复，以及最后一位生命周期所有者释放路由。
