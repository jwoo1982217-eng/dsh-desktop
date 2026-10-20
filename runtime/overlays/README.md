# DSH 0.2.1-alpha.4 适配补丁

全部 JS / YAML 以官方 dsh-v0.2.1-alpha.1 为三方合并基线，已适配 dsh-v0.2.1-alpha.4 发布产物，保留 MIT LICENSE。

- app-boot：Android 使用已开启 --expose-internals 的内置加载器，避免加载没有 Android 包的 require-builtin 原生扩展。
- bash-local：手机使用应用随包提供的 Bionic bash。
- session-persistence-jsonl：Android 通过临时目录 fsync / rename 原子发布会话，避免不支持的硬链接；桌面沿用官方分支。
- client-connection：声明 Web 服务依赖，让独立管理 RPC 通道完成注册；本机回环地址不受浏览器的互联网离线提示阻断，页面从缓存恢复或回到前台时恢复断开的实时连接。保留官方 Host/Origin 和浏览器会话认证，不重发用户任务。
- client-ui-conversation：桌面和手机普通 Enter 换行，输入框声明回车键提示，并显示文字发送按钮；保留输入法候选确认、菜单选择、Ctrl/Cmd+Enter 与发送/排队/插话/停止原有流程。
- client-ui-model-selection：点击直接打开搜索列表，模型名、ID 和 API 来源可组合搜索，提供 API 筛选、收藏和最近使用。对话页选择器包含“ZCode 重置额度”入口，调用 Jet Hub 所拥有的账号/套餐重置弹窗，查询不消耗机会，核销需明确确认。手机浮动面板、平板居中宽面板自适应横竖屏及软键盘；圆角面板四周留白，中间列表独立触摸滚动；键盘 Tab 不会意外切换模型。仅本浏览器保存模型标识偏好，Host 目录、选择请求、推理等级与失败恢复仍使用本版 SDK。维护源码为 `runtime/client-src/model-picker.jsx` 和 `.css`，运行 `node scripts/build-model-picker.mjs` 生成覆盖文件；`node scripts/model-picker-ui.test.mjs` 使用同版正式前端共享模块验证。
- compaction-basic：摘要默认输出预算为 8192 tokens，使用已声明的低档推理等级；按压缩模型实际容量分批摘要、分层合并，只有完整且变小的摘要才替换历史。上游明确超限时缩小分段，其他错误不伪装成容量问题；成功分段保存在独立恢复记录中。切模型按已组装步骤的选择预检容量，保留正在运行步骤的选择及用户下一次选择。详见 [上下文整理与恢复](../../docs/context-recovery.md)。显式摘要预算及独立摘要模型设置继续生效。
- settings：把旧 noema-memory 设置迁入新版 dsh-noema 配置表单。
- web-app presets：标准、创作、PTC 预设启用 timed 提问（120 秒）；迟到的回答继续送入原会话，不产生默认许可。

上游源码：https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.4

2026-10-16：按官方 npm 完整性验证 alpha.1/alpha.4 两侧产物后逐文件合并，处理 client-connection 的 client.browser.js 改名，保留新版命令输入修复和本地发送按钮；会话控制器的永久删除句柄管理已迁入新版 claim/create 流程。子代理 activation 适配及已有 Profile 的旧定时工具限制迁移见 `docs/official-alpha4-upgrade-20261016.md`。

- Agent Teams 选模兼容：spawn_teammate 声明 provider/model/reasoning_effort，按会话精确授权与模型元数据在创建前校验；独立模型选项透传到原生子代理，spawn/fork 执行方式不变。桌面保持 alpha.4，安卓保持 alpha.1。
