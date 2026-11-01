# src/o2a — opencode2api 移植与同步手册

本目录是 [opencode2api](https://github.com/jasonxu114514/opencode2api) 网关里
**匿名免费道（free tier / anonymous lane）请求整形**的 JavaScript 移植。上游每
发布一个新版本，按本手册逐文件对照移植即可，不需要重新考古。

- 当前镜像版本：`src/o2a/version.js` 里的 `O2A_VERSION` / `O2A_COMMIT`
- 移植日期：2026-10-31（v1.4.6，commit `58f56676ba1438adb30604b889bf36db2a1542a1`）
- 上游发布页：https://github.com/jasonxu114514/opencode2api/releases

## 1. 文件对照表（Go → JS）

| 上游文件（`internal/…`） | 本目录 | 内容 |
|---|---|---|
| `identity/request.go` | `identity.js` | 会话铸造：`bootNonce`（进程盐）、`CanonicalSessionID`（慢钟时间戳 + 降序编码）、`isOfficialSessionID`、`RandomProjectID`、base62。JS 侧新增 `sessionTimestampMs`（把会话内嵌时间戳解出来，供持久层做时效重铸）。 |
| `protocol/tools.go` | `tool-renames.js` | `clint_<sha256[:12]>` 不透明改名、`ToolRenames`（正反映射 + 大小写/分隔符折叠解析 `Resolve`）、冲突 `_2` 后缀。 |
| `gateway/toolshape.go` | `toolshape.js` | `renameAndCompleteTools`（全部客户工具改名 + 追加官方 13 工具集）、`rewriteToolReferences`（tool_choice / 历史 tool_calls / tool_use / input 调用行 / function_call / allowed_tools 同步改名）、legacy `functions` 转换。 |
| `gateway/toolshape.go`（资产） | `official-tools.js` + `assets/opencode_tools.json` | 官方 2.x 工具集（捕获自官方 CLI，逐字）、`strict:false`（chat 线）、Windows 主机 shell 描述改写、`renamableToolName`（Responses/Messages 内建工具跳过）。 |
| `gateway/opencode_prompt.go`（资产） | `official-prompt.js` + `assets/opencode_prompt_v2.txt` | 官方 CLI 系统提示（base + `<env>` + skills）、marker 判重、三条线注入。 |
| `gateway/upstream.go`（body 部分） | `gateway-body.js` | `ensureAnonymousChatUsage`（`stream_options.include_usage`）、`ensureV2CompletionLimit`（`max_completion_tokens: 32000`）。 |
| `gateway/upstream.go`（header 部分） | `headers.js` | `setV2Headers` 四会话头 + 40-hex `x-opencode-project`（`projectID`：`global`/git commit 直通，其余哈希成 40-hex）、`anthropic-beta` 头、`Bearer public`、UA。 |
| `httpx/client.go` | `version.js` | `v2ClientVersion` → `V2_CLIENT_VERSION`（UA 与版本号唯一来源）。 |
| `gateway/upstream.go`（端点） | `src/upstream.js` 的 `endpointFor` | `/inference/<family>/v1/…` 族路径；Anthropic 线加 `?beta=true`。 |
| `gateway/upstream.go`（重试/轮换）、`warp/*`、`gateway/pool.go`、`gateway/rotation.go` 等 | **不移植** | 服务端运行时（进程池、WARP 出口、注册、轮换、冷却）是网关的职责；插件跑在用户本机，出口就是用户自己的 IP，这些层没有对应物。重试/失败分类沿用插件自己的 `failure.js` / `forward.js` 策略。 |

`assets/` 下两个文件是上游 `//go:embed` 的原样拷贝 —— **永远不要手改**，同步时
直接用新版本的同名文件覆盖。

## 2. 适配层保留的偏差（upstream.js，均为有意为之）

移植不是逐字节照抄；以下偏差是插件形态决定的，同步上游时**保留**：

1. **占位提示**：注入的官方工具集对本插件宿主是不可执行的占位工具，注入后追加
   「placeholders in this session」提示词压住模型调用（参考实现的下游是真
   CLI，会真的执行这些工具，所以不发这条）。
2. **`tool_choice: 'none'` 删除**：v2 门禁见它即 403（2026-10-16 实测）。参考
   实现从不主动下发，所以不需要删；插件的调用方（续写路径等）可能留下它，
   适配层兜底清除。
3. **幂等整形**：参考实现每个请求体只整形一次；插件可能对已整形请求体再次调
   `applyFingerprint`（重试/恢复路径）。已带逐字官方定义的声明视为官方声明
   （不再改名、不重复补），已带 `clint_` 前缀的名字是上一轮的线名（跳过）。
4. **Chat 线提示注入保留块对象**：参考实现把所有 system 文本折叠进一条重建的
   system 消息（丢失块对象与 `cache_control`）；本移植把官方提示**前插**进第一
   条 system 消息（字符串拼接 / 块数组前插），其余 system 原样保留。
5. **不强制 `stream: true`**：参考实现是流式代理所以强制；插件的探测等路径合
   法地发非流式请求，只在 `stream === true` 时补 `stream_options`。
6. **会话跨重启持久**：参考实现用 `bootNonce` 让每次重启重铸全部会话（守护进
   程语义）；插件把 conversation → session 映射持久化到 `session-map.json`，
   铸造时仍混入进程盐。持久层用 `sessionTimestampMs` 做时效检查：日期离开上游
   接受窗口（±400 天）的旧 id 重铸，而不是永久重放。
7. **响应端 copy-on-write**：参考实现原地改调用方对象；插件的工具对象/历史行
   与宿主 harness 共享，改名一律换浅拷贝。

## 3. 升级流程（上游发新版时）

1. **取源码**：从 release 页下载 `Source code (tar.gz)`，解压到独立目录（例如
   `/d/o2a-ref/opencode2api-<ver>/`），不要混进本仓库。
2. **看 diff**：`git diff v<旧> v<新> -- internal/`，只关心
   `identity/request.go`、`protocol/tools.go`、`gateway/toolshape.go`、
   `gateway/opencode_prompt.go`、`gateway/upstream.go`（body/header/端点）、
   `httpx/client.go`、以及 `internal/gateway/*.json|*.txt` 资产。
3. **对表移植**：按第 1 节的对照表逐文件把 diff 语义搬进对应 JS 模块；资产
   文件直接覆盖 `assets/`。更新 `version.js` 的三个常量。
4. **跑守卫**：`node scripts/fingerprint-test.mjs && node scripts/free-lane-wire-test.mjs && node scripts/opencode-parity-test.mjs && node scripts/wire-tool-alias-test.mjs && node scripts/free-lane-compat-test.mjs`，再跑
   `npm test`。
5. **灰度验证**（有条件时）：对上游真发一条 `PONG` 探测（`scripts/oc-free-live-test.mjs`），
   429/403 即回看 diff 是否漏搬了某个门禁事实。

## 4. 2026-10-31 线上对照的两条实测结论（写进守卫，防止回退）

用「让 v1.4.6 网关把整形后的请求发给本机明文 echo 服务器」的办法抓到了它的
**最终线字节**，与本移植逐字段 diff 后得到：

1. **v2 道不发 `accept` 头**。参考实现的 `setV2Headers` 不含 Accept（Go 的
   http client 不默认发）；本移植现同样默认不发，只有调用方显式给 `accept`
   （如清单 GET）才发。`headers.js` 有对应注释，`free-lane-wire-test.mjs` 有守卫。
2. **用 curl/python 重放本车道做 429/200 判定是无效的**。同一出口、同一时刻，
   v1.4.6 自己的字节经 Go 客户端 200、经 curl/转发 429（误差信息同为
   `FreeUsageLimitError`）——上游对 TLS/HTTP 客户端指纹敏感，429 的报文不区分
   「IP 配额烧尽」与「非官方客户端」。判定只能用本车道自己的客户端
   （插件 = Node/Bun）或参考网关本体做。

## 5. 本目录的纪律

- 纯函数、零插件依赖：本目录**不得** import `src/store.js`、`src/http.js` 等
  插件模块，也不读插件配置；它只被 `src/upstream.js` 反向消费。这样对照上游
  diff 时不存在隐藏耦合。
- 上游事实（每条都对应一次 403/429 的实测）写在各文件的头注释里，与上游注释
  对应；改行为前先读文件头。
- 版本常量必须与资产文件同一次提交里一起更新——守卫测试会比对
  `O2A_PORTED_VERSION` 与 UA 常量的一致性。
