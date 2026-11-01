# JetHub 本机定制维护合同

上游：iJetLi/deepseek-harness-codearts，当前精确提交 2bf76ce66f1214f18ee3202238fb0f2d02cc791f（2026-11-01）。上游包版本仍为 0.2.1-rc.2；版本号不能证明已包含本次更新。合并同时核对手机旧定制基线 78dc506cf42bb1821a20cd4378f2b81cd8de8ded、桌面实际 WIP 的上游基线 ff16e517f27c054f05e657d8216867e02a0575bd、桌面运行包及 OFM 已维护签名出口。桌面1975文件与手机1809文件已逐项比对；运行包82个JS差异中的74个等于旧手机版，其余8个的Mac导入/国内WorkBuddy/桌面fetch差异均纳入并集。

保留的本机能力：

- 原22个账号渠道、原OpenCode、自制OrcaTerm，包含最新上游七牛。渠道不是仅显示卡片：实际注册及账号/余额RPC有隔离调用验收。
- OrcaTerm腾讯登录、工具协议、模型关闭与黑名单。
- ZCode本人免费/个人套餐/组织来源、来源隔离、套餐额度重置与对话页入口；新增上游会话均衡尊重池开关和当前请求账号。
- OpenCode本机serve、MCP转接及交接；原推理快通道代码保留。本机入口使用现有provider id，不能被升级静默替换为远端账号通道。
- ChatGPT会员入口与独立凭据引用；桌面WorkBuddy独立普通浏览器、手机系统浏览器登录。
- 同模型沿用当前账号，额度/限流时按用户顺序接续；输出正文或工具后不重放。准备调用、取消和清理均保留请求上下文。
- Mac AutoClaw 按当前账号指针读取 safeStorage v10，异步钥匙串、授权拒绝与文件轮换保护；原文件逐字保留。
- 国内 WorkBuddy 保留 buddy 路由与旧账号 ref，使用当前账号协议；国际版端点与签发域独立。
- 目录/控制面用 withoutAccountRotation 隔离推理选号，已列模型复用同一元数据，取消仍生效。
- 手机国内 AutoClaw 应用内短信、国际版 Z.ai 官方授权回调；AStudio 网页短信/密码/微信；OrcaTerm/Magicrew 使用手机原生窗口回传，当前账号校验后保存手机 ref，提供显式凭据导入。
- Android 拒绝桌面本地导入，通用开浏览器函数不启动桌面进程；取消会清理本轮上下文，写库途中取消可撤回本轮写入并恢复去重旧账号的原字节。
- 国内/国际产品独立账号与credentialRef，推理档位、slot/配额语义、启用/停用/续期保持。
- CodeArts独立签名传输、手机直连、用户出口、双实例余额缓存与请求取消隔离。继承请求体、签名、输出上限和取消参数。

customization-contract.json明确列出需要保留的渠道和源/运行文件指纹。lib/customization-guard.js提供只读validateCustomizationSource与inheritCustomizationContract。默认仅验运行文件，保留的旧src等额外文件不影响增量升级；维护源码审计须显式传{verifySources:true}，CLI verify:source（或verify-customizations.mjs --source）会这样调用，附带CLI默认只验运行文件；未知覆盖、渠道缺失、被保护文件缺失或改写时拒绝更新并保留现场。额外用户文件不被删除或自动覆盖。维护代码发生真实改变后，必须先重新验证、再审查并更新指纹；不能为了绕过预检自动重写合同。

构建使用package.json的build:all；运行包、客户端、WASM与bootstrap同步脚本均为维护源码。交付前执行verify:customizations与smoke:runtime。runtime-smoke支持DSH_SMOKE_SDK_NODE_MODULES，实际验证桌面与手机SDK解析，不发模型请求或写账号。scripts/codearts-rpc-context-test.mjs只接两个本机夹具，覆盖全部渠道RPC及签名/取消/卸载恢复。

本包不携带用户凭据或配置。实际账号登录、远端模型推理、正式Android安装和系统浏览器授权仍须由正式设备验收；离线夹具通过不能替代这些环节。包名别名和profile加载行由宿主安装器维护，不能以重置profile实现升级。
