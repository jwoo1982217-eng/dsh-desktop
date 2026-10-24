<!-- 搬自 AGENTS.md 的「深细节索引」惯例：事故史与逐项规则放本文件，按需阅读，
     不进每轮注入。内容与 src/opencode-proxy.ts 的 proxyFetch 注释互为对照。 -->

## OpenCode V2 协议更新

- 推理/目录端点改为 `https://opencode.ai/inference/v1`；默认 UA 为 `opencode/latest/2.0.29/cli`。⚠️ UA **不是**门禁的一部分（见下方逐变量矩阵）：`opencode/1.18.22` 在其余两项正确时照样 200，改成 `latest/<v>/cli` 只为外形一致，别再写成「不换就 403」。
- session 外形仍是 `ses_ + 12hex + 14base62`，但首段必须按 `~(timestamp * 0x1000 + 1)` 的低 48 位生成，不能使用裸时间戳或随机 hex。
- V2 不发送旧 `x-opencode-request`（⚠️ **它在场即 403**，即使 affinity 头齐全）；四个 session 头复用同一 session，但其中**只有 `x-opencode-session-id` 是必需的**。
- 门禁工具**只保留 `read`**（名字与 `path/offset/limit` 参数 schema 必须保持上游形态，改名或空 properties 会 403）；不再注入 `shell`。⚠️ 「不再发显式 `tool_choice:none`」**与门禁无关**（实测 V2 接受 `none`/`auto`/`required`/`function` 全部 200），只是因为它**没有约束力**：同一句「读取 /tmp/a.txt」在 `tool_choice:none` 下后端照样产出 `read` 调用 —— 只发一条描述也拦不住。故「未启用工具」的不变式**必须**由响应层逐调用强制。
- **客户端工具别名统一使用 `dsh_` 前缀**。所有客户端工具（包括 edit/write）都映射；定义、历史调用、指定工具选择同步改名，调用 id、参数 schema、结果正文不变。响应名字跨帧拼接后还原，缺失 index 按调用身份归并；保留/未知/不完整名字**剔除该次调用**（见下），不交给宿主执行、也不整轮报错。
- 归一只在 `src/opencode-stream.ts` 的 OpenCode 专用前置流中完成，**不修改共享 `src/openai-compat.ts`**；不新增 SSE 单事件大小上限。取消/提前结束须释放前置流及上游连接。
- 保留账号池的指纹代次、代理同源 fetch、额度分类/换槽与思考档位。不擅自设置默认输出预算；DSH `system` 转成标准 chat system 消息，不注入 OpenCode 身份提示词。

### 匿名通道门禁：逐变量实测（2026-10-15，`POST /inference/v1/chat/completions`，每格 2 次）

固定 body 形状：「`read` + 真 schema + `path`」才放行；提示词 `读取 /tmp/a.txt 这个文件。`。

| 变量 | 取值 | 结果 |
|---|---|---|
| 端点 | `/inference/v1` | 200 |
| 端点 | `/zen/v1`（旧） | **403** |
| session 算法 | `~(ts*0x1000+1)` 低 48 位 | 200 |
| session 算法 | 旧版小端裸时间戳 | **403** |
| 头集 | `{project, session, client}` + `x-opencode-request` | **403** |
| 头集 | 上三头 + `x-opencode-session-id` | 200 |
| 头集 | 上三头 + 仅 `x-session-affinity` | **403** |
| 头集 | 上三头 + 仅 `X-Session-Id` | **403** |
| 头集 | 四个 affinity 头 + `x-opencode-request` | **403** |
| UA | `opencode/1.18.22`（本机 1.x CLI 真值） | **200**（不参与门禁） |
| `tool_choice` | `none`/`auto`/`required`/`{function read}` | 全部 200（但 `none` **不被执行**） |
| 工具 schema | `read` 且 `properties` 为空 / 改名成 `bash` | **403** |
| 鉴权 | 不带 `authorization` | **403**（`FreeTierError`，勿与形状门禁混淆） |

⚠️ 探测时的两个坑：① 漏发 `authorization: Bearer public` 会让**所有格**返回 403，
看起来像「修法无效」——曾据此误判过一轮（正是「对照矩阵里每个变量必须独立」那条
教训的复发）；② `cat-jam-free` 在本机返回 `RegionError`（地域不可用），
`muse-spark-1.2-contributor-free` 同样；`step-5-preview-free` 返回 429
「Endpoint is unavailable」；`jev-1.13-free` 返回 400 `ModelProtocolUnsupported`
（模型级，与端点无关）。免费档实测可用：`big-pickle` / `deepseek-v4.1-flash-free` /
`mimo-v2.6-flash-free` / `nemotron-3.5-lightning-free` / `longcat-2.5-preview-free` /
`space-bunny-free`。

### ⚠️⚠️ 保留门禁工具会被模型真的调用：只能「剔除」，不能整轮报错

`toolsDisabled`（调用方没传工具）时线上仍必须广告门禁 `read`，而模型**会**去调它 ——
同一句「读取 /tmp/a.txt」，`big-pickle` **多次**产出 `read{path:"/tmp/a.txt"}`
（3 次独立观测，含一次完整 SSE 实录，见 `tests/fixtures/opencode-gate-call.sse.txt`；
⚠️ **非必然**：另有一次它直接作答、未调工具，故用例把它写成「两种收尾都算过」）。
`tool_choice:none` 拦不住它（后端不执行该字段）。

- **原实现**（PR 初版）在线性响应层对此抛 `LlmError(..., 'PERMISSION_DENIED')`
  ⇒ **整轮对话死掉**，已流出的正文一并作废。对真机实录写成单测对照可复现：
  HEAD 版归一器抛 `PERMISSION_DENIED`，修后版正常收尾。
- **现修法**：未知/保留/残缺名字一律**剔除该次调用**（去掉 `name` 后照原样下发），
  只记一条 `warn`。共享消费器对**无名** tool-call 本来就有既定语义：
  **不发任何 chunk**（不执行、也不会把 `unknown tool ""` 写进会话，
  那是会把整条会话打成 400 的形态 —— ⚠️ 注意它在内部**仍登记**一条不会 `announced`
  的调用，正因如此剔除时必须**连参数一起丢**，见下表第二行），
  又在没有别的可用调用时报 `max-tokens`（`droppedUnnamedCalls`）
  —— 这正是「模型想调工具却被剔除」的既有信号。
- **仍然 fail-closed 的只剩线上歧义**：同名 id / 同下标指向两条不同调用、
  名字已确定后又改口 —— 那时无法判断参数属于谁，执行谁都是错的。
- 判据（`tests/unit/opencode-stream.spec.ts`）：剔除后**一个 `block-end` 都不发**、
  `finish` 为 `max-tokens`、`warn` 恰好一次且带被剔除的名字、
  同批合法调用**不受连坐**（仍报 `tool-calls`）；另有一例直接跑真机实录 fixture。

#### ⚠️⚠️ 用户可见症状 → 根因（**排障入口，别再从「token 不够」查起**）

| 用户看到 | 实际根因 | 证据 |
|---|---|---|
| 一条回复**几乎没有正文**，却提示「已达到输出 token 上限」/「回答被截断…发送"继续"」 | **模型唯一意图是调门禁 `read`**，该调用被剔除 ⇒ 消费器报 `max-tokens` | 真机 fixture 34 帧里 `content` 分片 **0 个**（只有 reasoning）⇒ 客户端那句「已有输出保留在对话中」是**假话**；客户端 bundle 里没有任何「工具调用被剔除」文案（grep 零命中），用户唯一可见信号就是这条 token 提示 |

⇒ 遇到该症状**先查宿主日志**（`[codearts-auth] opencode: 上游调用了保留门禁工具 read…`），
不要按「输出上限」调 `maxTokens`：调大没用，模型下一轮还会去调它。
真正的用户可见修复需要共享消费器新增一种 finish 变体（超本 PR 范围，**未做**）。

验证：原匿名 E2E 夹具传空池，先修夹具后得到目录成功、两次真实聊天均 `FreeTierError` 的基线；V2 修复后目录、两条最小聊天、完整客户端工具集与工具历史回传均通过。付费 API key 通道未做真实额度测试。

### ⚠️ 2026-10-15 审计（独立 + 对抗性，两轮 subagent）落地清单

审计结论：**净改进、方向正确**（改前「门禁 `read` / 未知名 / 残缺名」三种真机形态都抛
`PERMISSION_DENIED` 打死整轮；宿主异常路径只在 `signal.aborted` 时落 `assistant/message`，
非 abort 的流中异常**只 settle `assistant/attempt`** ⇒ 正文真的会丢），
但确证了 5 处缺陷，已全部落地 + 变异验证（每条都能被自己的用例抓住）：

| 缺陷（审计确证） | 修法 | 守卫用例 |
|---|---|---|
| 名字**从未到达**的调用零告警消失（`assertState` 要求 `upstreamName.length > 0`，而 `longer` 被空串吸收）—— 「『空』被当成『正常的无』」那一类 | 判据改为「**没还原**就告警」，文案区分「始终没有名字」 | 「名字从未到达的调用被剔除时也要留痕」 |
| 被剔除调用的**半截参数**让消费器的 `argsTruncated` 连坐同批**合法**调用（遍历全部块，含未 `announced` 者）⇒ 宿主丢弃并重试、合法调用白丢一轮 | 剔除时**连参数一起丢**（`delete next.arguments`；消费器对缺参按 `normalizeToolArguments` 归一） | 「坏调用的残缺参数不得把同批合法调用拖成 max-tokens」 |
| `note`/`dropCall` 在 `TransformStream.transform` 里**同步**调 `warn` ⇒ 日志出口一抛错又打死整轮 | 告警出口加 `try/catch` 隔离 | 「告警出口抛异常不得打死本轮」 |
| 被剔除的调用仍占 id/下标槽 ⇒ 上游在同一槽开另一条调用时新名字被拼进死调用（`bash`+`dsh_glob`），**零新告警**地消失 | 已放弃的调用 + 非空名字片段 ⇒ 摘槽另立调用（真机续传帧是 `"name":null`，不触发） | 「已剔除的调用占用的下标被复用时…」 |
| `toolsDisabled` 那行是**注释声称的最后防线、实际无用例**（生产链路不可达，改回 `aliases.get(name)` 全量仍全绿） | 直接用「非空别名表 + `toolsDisabled`」直连归一器钉住（绕过请求构造器） | 「toolsDisabled 时别名表非空也不还原」 |

附带修正（同为审计发现，不改行为）：
- 剔除文案分流：`dsh_` 前缀单列（**我们自己**的别名表/历史重命名可能有缺陷，别记到模型头上）、
  门禁名、幻觉名、名字始终为空四种原因不再混用一句话；前缀歧义说「**重叠**」而不是「不完整」。
- `finish_reason` 降级处的注释**改准**：旧注释写「原样下发会让宿主等一个永不到来的工具结果」
  与宿主实现不符（零 tool-call 块 ⇒ 宿主直接判 `completed`，改前是**静默正常完成**）；
  真正的收益是走 `resolveEmptyResponseReason` 得到可重试的 `EMPTY_RESPONSE`。
  另在「声称 tool_calls 却**一个调用都没有**」时补一条 warn（有调用被剔除时不补，避免与剔除告警重复刷屏）。

**明确不做**（如实登记，避免下次重复讨论）：
1. **裸门禁名 + 本轮确实广告过同名客户端工具 ⇒ 仍剔除**。审计建议「还原成客户端 `read` 并执行」，
   但那等于把**门禁调用**猜成客户端意图（门禁 schema 是 `{path}`、客户端 `read` 要 `{file_path}`），
   猜错就是执行一个模型没打算调的工具；剔除的代价只是**这一次**调用没发生且有 warn。
   同一请求体里 `dsh_read`（执行）与 `read`（剔除）结局不同是**刻意**的，不是漏判。
2. **前缀歧义下的无参调用仍会被剔**（同时启用 `read` 与 `read_image`、上游只给 `dsh_read`
   且一个参数字节都没有）。放宽判据（如「出现过 `arguments` 键就算完整」）会引入更坏的
   **还原成错工具**（名字先给短别名、后补长名 ⇒ 已按短别名发出去的名字收不回来），
   线上未观察到该切法 ⇒ 保持保守，代价写在 `src/opencode-stream.ts` 文件头。
3. **纯分片恰好落在前缀边界 + 参数已到**会让归一器走「改口」fail-closed（整轮失败，机制可达、
   线上未观察到）。代码无法区分「模型改口」与「我们猜早了」，只能靠名字整帧到达的实测形态兜住。

### ⚠️ 两条**上游侧**不稳定（与协议适配无关，勿记到本 PR 账上）

2026-10-15 本机 `big-pickle` 实测，两条都会让**拿「正文非空」当判据的 gated e2e 假红**：

1. **空正文**：HTTP 200 + 只有 2 个字符的 `reasoning_content`、`content` 为空、`finish_reason: stop`
   —— 6 次裸探测命中 **2 次**。这不是「零块」（有一个思考块），故
   `resolveEmptyResponseReason` 不会改写它，用户侧表现为「没有回复」。判据应写成
   「本轮确有产出（正文或思考）」，而不是「正文长度 > 0」。
2. **思考漏进正文**：约 11 次采样命中 **1 次**，上游把思考文本与**裸闭标签** `think`
   直接写进 `content`（正文里出现 `…without calling any tools.</think>OK`）。
   ⚠️ **这不是本 PR 的缺口**：共享消费器的 `splitThinkTaggedContent`（**恒开**、
   `block-end` 权威覆盖，`tests/unit/think-tag-split.spec.ts` 已覆盖
   `思考</think>真正文` 形态，跨帧 7/11 种切法也有用例）会把标签前的独白归位到
   reasoning 块、正文只留 `OK` —— 已在 `tests/unit/opencode-stream.spec.ts` 用该形态
   钉住（含「本适配器不自己造第二套解析」这条边界）。残余：切分发生在收尾，
   **流式过程中**已发出的 `text-delta` 仍带该前缀，且被切出的 reasoning 块拿到更靠后的
   index（全渠道同型，属既有设计，不在本次范围）。

## ⚠️⚠️ OpenCode 出口代理：dispatcher 与 fetch **必须同源**（Issue IKK4BY）

**用户报障**（2026-10-08，Gitee issue IKK4BY）：「OpenCode 账号的代理按钮，
填任意合法地址后点测试连接，**固定显示测试失败 fetch failed，耗时 0 到 1 毫秒**。
代理地址或目标站点换成别的也一样。但直连出口 IP 查询接口是正常的。
保存动作会成功，保存后该账号的每次对话请求也会以相同方式失败。」
环境：`dsh-codearts-auth` 0.2.0-rc.3 / DSH Desktop / Node **v24.21.0**（内置 undici 7.29.1）/
插件依赖 `undici` 8.11.2。

### 根因：跨实例 handler 契约冲突，断言发生在**建连之前**

`src/opencode-proxy.ts` 的 `ProxyAgent` / `Agent` 来自**外部** undici，
而 `fetch` 原先用的是**全局**（Node 内置 undici）。`RequestInit.dispatcher`
把外部实例交给内置 fetch 时，内置 fetch 会按**自己的版本**塑造 handler，
外部 undici 的 `Client` 再按**自己的版本**去断言它：

```
TypeError: fetch failed
  ← InvalidArgumentError: invalid onRequestStart method
    code = UND_ERR_INVALID_ARG
```

断言在 `new Request(...)` 里完成，**早于任何 socket 建立** ——
故与代理地址是否可用、目标站点是否可达**完全无关**（实测耗时 1~7ms、
代理中介命中 0 次），也与账号/额度无关。又因为该异常被 fetch 包装成
`TypeError` 且 **`cause` 被 UI 丢弃**（旧 `opencode-rpc.ts` 只取 `error.message`），
用户只能看到一句没有信息量的 `fetch failed`。

### 版本矩阵（本机实测 Node 22.19 / 24.21 / 26.10，外部 undici 8.11.2）

| Node | 内置 undici | 全局 fetch + 外部 8.x dispatcher |
|---|---|---|
| 22.19.0（engines 下界） | 6.21.2 | ✗ 缺 6 个新契约字段 |
| 24.21.0（报障者环境） | 7.29.1 | ✗ 缺 5 个 |
| 26.10.0 | 8.10.2 | ✓ **恰好**同契约 |

⚠️ **机制关键点（容易漏）**：undici **7.x** 的 `assertRequestHandler`
开头带「双契约早返回」——

```js
if (typeof handler.onRequestStart === 'function') {
  // TODO (fix): More checks...
  return            // 有 onRequestStart 就直接通过，不再查老方法
}
```

而 **8.x 删掉了这个早返回**，改为无条件要求新契约字段。这就是
「同一份 handler，Node 26 过、Node 22/24 挂」的全部来源，也是
「把外部 undici 降到 7.x 也能兼容三代 Node」的原因。

⚠️ 该「降级可行」结论已做**真实 fetch** 实测（不是只读源码判据）：
7.0.0 / 7.16.0 / 7.30.0 × Node 22.19 / 24.21 / 26.10 = **9 组全部通过**
（自建 HTTP CONNECT 中介，逐组断言 `body=origin-ok` 且中介命中 +1）。
（补记：初版只对 7.30.0 跑过真实 fetch，7.0.0 / 7.16.0 仅做过源码静态判据 ——
  自审时补齐，以免把「静态推断」写成「实测」。）

⚠️ 因此 **Node 26 上「看似正常」纯属版本巧合**，不是「跨实例 Dispatcher 被支持」。
外部 undici 升到 9.x、或用户换回 Node 22/24，都会立刻复发。
⇒ **结论与版本无关的唯一根治办法是让 dispatch 与 fetch 出自同一份 undici。**

### 修法：`proxyFetch` 收口（不允许再出现「裸 fetch + dispatcher」）

`src/opencode-proxy.ts` 新增并导出 `proxyFetch(input, init, proxy)`：

- **有代理** → 走 `undici` 自带的 `fetch`（与 dispatcher 同源）；
- **无代理**（`proxy === undefined`）→ **仍走全局 `fetch`**。
  ⚠️ 这条不是随手写的：无代理路径本来就没有 dispatcher，切实现只会白白改变
  既有直连行为。**已实测**：`NODE_USE_ENV_PROXY=1` + `HTTP_PROXY=<中介>` 时，
  Node 26 的全局 fetch 会经中介（中介命中 +2），而 Node 22 不支持该特性
  （命中 0）—— 这正是「保留全局 fetch」要护住的宿主特性。

两个调用点因此都改为经 `proxyFetch`：`opencode-adapter.ts`（chat）与
`opencode-rpc.ts`（`opencode.testProxy`，即「测试连接」按钮）。
⚠️ `buildProxyDispatcher` 仍是导出，但它只该被 `proxyFetch` 内部使用。

⚠️ **语义差异已逐条实测无影响**（换成 undici 的 fetch 之后）：

- **SSE 增量语义不变**：`response.body` 仍逐块到达（4 段 SSE 的分片数与首片耗时
  与全局 fetch 一致，未被整体缓冲）—— `consumeOpenAiSse` 依赖这条；
- **`AbortSignal` 行为不变**：1.5s 中断 3s 慢响应，两者都是 `AbortError`，耗时一致；
- **HTTPS + CONNECT 隧道**（生产 chat 的真实形态，`https://opencode.ai/zen`）
  也单独实测通过（自签 TLS 目标站 + 统计 CONNECT 次数）。

### ⚠️ 可观测性：`fetch failed` 的根因在 `cause` 里

`opencode-rpc.ts` 新增导出的 `describeFetchError(error)`：沿 `cause` 链
（最多 3 层）展开 message 与 `code`，产出 `invalid onRequestStart method ← UND_ERR_INVALID_ARG`
这样的可读串。顶层那句没有信息量的 `fetch failed` 在**后面还有 cause 可展开**时省略；
若它就是全部（没有 cause）则保留原样。

⚠️ **只取 `error.message` 是本缺陷「无从下手」的直接原因** ——
Node 的 fetch 在**任何**传输层失败（DNS / 连接被拒 / TLS / 契约冲突）时
message 恒为 `fetch failed`。排查任何 fetch 问题时先看 `cause`。

⚠️ **边界（自审实测，记录以免误判）**：

- 自引用 `e.cause = e` **不死循环**（限深挡住），输出 `Error: fetch failed`；
  环形 `a↔b` 输出 `A ← B ← A`（尾部轻微重复，无害）。
- `message` 为空串时输出空串 ⇒ 用户会看到「测试失败：」后面空着（信息量为零，
  但不会崩，且比编造一句假原因好）。
- 5 层链被限深截到 3 层（`L1 ← L2 ← L3`），符合设计。
- **凭据泄漏：实测不可达**。`normalizeProxy` 允许 `http://user:pass@…` 与
  `socks5://user:pass@…`，而本函数会原样带出 `cause.message` —— 理论上若 cause
  含 URL 原文就会把明文口令回给 UI。但真实 fetch 失败时 cause 只有
  `connect ECONNREFUSED 127.0.0.1:45999`（**不含** URL 与口令），实测两种协议均未泄漏。
  ⇒ 不作为缺陷，仅记为残余风险（upstream 若改变错误消息形态需重新评估）。
  相关的 `maskLabel()` 经实测对各种形态均正确脱敏（`user:secret@`、`user:p%40ss@`、
  `user:a@b@`、仅用户名）。

### 测试与闸门（三道，缺一会复发）

1. **接线断言**（`tests/unit/opencode-proxy.spec.ts` 的「同源不变式」段）：
   扫**整个 `src/` 目录**（不是写死文件清单，新增文件也必须被覆盖，实测 169 个 `.ts`），
   除 `opencode-proxy.ts`（唯一合法落点）外**任何文件出现 `dispatcher:` 即变红**；
   另锁 `adapter` / `rpc` 两个调用点走 `proxyFetch`、`describeFetchError` 接线。
   ⚠️ 这组断言必须**先剥注释**再匹配：注释里**故意**引用了那些反面写法
   （写用例时实测到两条假失败）。
   ⚠️⚠️ **判据必须是 `dispatcher:`，不能是「`fetch(...dispatcher:)`」**（自审实测）：
   初版写成 `/\bfetch\s*\([^;]{0,400}?dispatcher\s*:/`，**6 种等价写法漏网** ——
   最现实的一种是 `const init = { dispatcher: d }; fetch(url, init)`（dispatcher
   字面量不在 fetch 的括号里）；另有展开对象、夹分号（IIFE）、间隔 >400 字符、
   代理对象传参等。改用 `/\bdispatcher\s*:/` 后漏网降到 1 种，且**不误伤**
   属性读取 `init.dispatcher` 与类型注解 `dispatcher?: Dispatcher`（均实测）。
2. **真实联通**（`tests/unit/opencode-proxy-live.spec.ts`）：6 例全部改走 `proxyFetch`。
   ⚠️ 两处**假绿**已修掉：原先「代理不可用/不存在时失败」只断言 `rejects`，
   而契约冲突**恰好也 reject** —— 那两条在缺陷环境下「因为错误的原因通过」，
   掩盖了缺陷两轮。现在必须验 `error.cause` 的 `code`：
   真连不上是 `ECONNREFUSED`，**绝不能**是 `UND_ERR_INVALID_ARG`；
   CONNECT 被拒那例还要验到自建隧道抛出的可读错误文案。
   `DEAD_PORT` 用 45xxx（合法、无人监听、不与真实服务撞 port）。
   ⚠️ **纠正一处早先写错的理由**：曾称「`1`/`9` 落在 forbidden-port 名单里会被
   拦成 `bad port`」—— 实测**不成立**：forbidden-port **只作用于 target URL**，
   **完全不检代理端口**（proxy 端口 1/9 走的是 `connect ECONNREFUSED`）。
   当时看到 `bad port` 是因为把 **target** 写成了 `:9`，报的是目标 URL 的问题。
3. **行为用例**（`tests/unit/opencode-fetch-error.spec.ts`，11 条）：
   单层/多层 cause、带 code、无 cause、非 Error、code 已含在 message 里不重复追加；
   另含审计发现的边界：噪音层不得挤掉根因、`cause=null` 与 `undefined` 同判、空 message 不输出空串、自引用/环形不死循环。
4. **SOCKS5 端口**（`opencode-proxy.spec.ts` 的 `resolveConnectPort` 段 8 条 +
   `opencode-proxy-live.spec.ts` 的 CONNECT 帧端到端 1 条）：见下面的独立缺陷章节。

⚠️ **`vi.stubGlobal('fetch', …)` 拦不到有代理的路径**（它已改走 undici 的 fetch）：
`opencode-rpc.spec.ts` 与 `opencode-rotate.spec.ts` 里涉及代理的用例改为
`vi.mock('undici', importOriginal => ({ ...original, fetch: spy }))` ——
⚠️ 必须用 `importOriginal` 展开，**只换 `fetch`**：`ProxyAgent` / `Pool` 要保持真实，
否则 `buildProxyDispatcher` 失去构造能力，测的就不是本 provider 了。
（改完后全量 3 条红转绿；无代理的用例**仍用**全局 stub，因为那条路径刻意保留全局 fetch。）

⚠️ 替身的清理必须放 `afterEach`，**不要**在各用例里手写 `mockReset()`：
手写版一旦某条断言中途抛错，那行 `mockReset()` 就被跳过，被污染的替身会
**泄漏到下一条用例**（表现为随机性假失败，极难排查）。两个文件均已收进 `afterEach`。

### ⚠️⚠️ 同源修复**顺带挖出**的独立缺陷：SOCKS5 走默认端口时 CONNECT 帧端口写成 0

**同一轮实测（2026-10-08）发现，与 IKK4BY 同源但独立**：修好「fetch 同源」后
用真实 `https://opencode.ai/zen` 复测 SOCKS5，仍报
`SOCKS5 代理在握手完成前关闭了连接`。往下查发现 CONNECT 帧里的端口是 **0**。

**根因**：旧的端口解析写的是

```ts
const port = Number(opts.port ?? 443)
```

而 undici 传给 connector 的 `opts.port` 在**默认端口**时是**空字符串 `""`**、
**不是 `undefined`**（实测 undici 8.11.2；`opts` 全部键为
`host,hostname,protocol,port,servername,localAddress`）：

| 目标 URL | `opts.port` | `Number(opts.port ?? 443)` |
|---|---|---|
| `https://opencode.ai/zen/...`（默认 443） | `""` | **0** ← 坏 |
| `https://example.com:8443/` | `"8443"` | 8443 ✓ |

`??` 只兜 `null`/`undefined`，**兜不住空串** ⇒ `Number("") === 0` ⇒ CONNECT 帧
端口写成 `0x0000` ⇒ 上游按端口 0 连接**必然失败**。

**影响面正好是生产主路径**：`OPENCODE.baseUrl = https://opencode.ai/zen`（默认 443）
⇒「SOCKS5 代理」在修复前是**恒不可用**的（HTTP 代理不受影响，它不走这条 connector）。
三代 Node（22.19 / 24.21 / 26.10）一致复现，**与 Node 版本无关**。

**实测证据**（自建 SOCKS5 中介记录它收到的 CONNECT 目标）：

```
修复前：CONNECT → "opencode.ai:0"        → 失败（应答码 0x5）
修复后：CONNECT → "opencode.ai:443"      → HTTP 400（服务端正常应答，链路通）
显式端口对照：CONNECT → "example.com:8443" → 通过（修复前后都通过）
```

**修法**：抽出可单测的纯函数 `resolveConnectPort(opts)`，三层兜底 ——
① 空串/`null`/`undefined` 视为「未指明」；② 解析后必须是 **1..65535 的整数**，
否则回退；③ 按协议给默认值（`https:`/`wss:` → 443，其余 → 80）。
⚠️ **不复用 443 作通用兜底**：http 目标回退到 443 会把「端口没给对」伪装成
「连不上」，掩盖真实原因。

⚠️ **为什么必须配一条端到端用例**：纯函数用例覆盖不了「undici 真的传空串」这一步。
端到端手法是**绕过 `fetch`、直接驱动 dispatcher** 打一个**无显式端口**的 origin：

```ts
dispatcher.dispatch({ origin: 'https://example.test', path: '/', method: 'GET', headers: {} }, handler)
```

并**从 CONNECT 帧里读出端口**断言为 443（实测：`example.test:443` / `example.test:80` /
`example.test:8443` 三种形态都正确）。用 `proxyFetch(url)` 构造不出这个场景 ——
URL 解析层不会暴露「端口缺省」这一步。

⚠️ 反向验证：把实现改回 `Number(opts.port ?? 443)` ⇒ **2 条独立用例变红**
（纯函数接线闸 + 端到端 CONNECT 帧断言）。两条各自锁死，别删其中任一条。

⚠️ 记录一个测试期望的坑：`Number('0x50') === 80` 且 80 是**合法端口**，
故 `'0x50'` **不该**回退到 443（我最初把它当非法值，实测红了）。
这是 JS 数字字面量语义，不是解析缺陷，已单独写用例记录。

### ⚠️ 已知的**同族缺口**（未修，超出本 issue 范围，留待后续）

`src/index.ts:2121` 的 `fetchRemoteCatalog` 拉 `https://opencode.ai/zen/v1/models`
（模型目录）时**不传 dispatcher** —— 即「配了代理的账号，目录仍走本机直连出口」。
它的 `slot.proxy` 是**可用**的（`IdentitySlot` 上就有该字段），只是没被用。

- 它是 `7dd3422` 引入的 **pre-existing** 问题，**不是**本次提交造成的；
- 它**不触发** IKK4BY 的机制（没有 dispatcher 就不会有跨实例断言冲突）；
- 影响面限于**模型可见性**（`listModels` / 目录），**不影响对话**（对话走 `stream()`，已修）；
- 修法显然是改走 `proxyFetch(url, init, slot.proxy)`，但会改变「目录经由哪个出口」
  的行为（含缓存按槽 id 分开存的语义），**需单独评估**，故本次不动。

### 反向验证（变异各自独立锁死，别当同义反复删掉）

| 变异 | 结果 |
|---|---|
| `proxyFetch` 改回全局 `fetch`（还原缺陷） | live **5 条红** + 接线断言 **1 条红** |
| `adapter` 调用点改回「裸 fetch + dispatcher」 | 接线专项断言 **2 条红**（⚠️ 见下方补充） |
| `describeFetchError` 改回只取 `error.message` | `opencode-fetch-error` **3 条红** |
| 去掉 `init instanceof Request` 守卫（审计发现 C） | live 的 Request 用例 **1 条红** |
| `describeFetchError` 退回「单 depth 计数 + cause!==undefined」（审计发现 D） | `opencode-fetch-error` **2 条红** |
| SOCKS5 端口改回 `Number(opts.port ?? 443)`（本轮独立缺陷） | **2 条红**（纯函数接线闸 + CONNECT 帧端到端） |

⚠️ 补充（对抗性审计实测）：第 2 行那个「接线闸 2 条红」里，**`src/` 总闸对修复前的
adapter 写法其实是漏网的** —— 真正拦住它的是 adapter 专项断言 `/buildProxyDispatcher/`。
即「总闸能覆盖新增调用点」这个假设当时并不成立（已在下面第 1 条修掉）。
教训：**总闸的判据要单独做一次「对已知缺陷形态的召回测试」**，别假设它自然覆盖。

### ⚠️ 对抗性审计（2026-10-08）发现的四条（已全部落地修复）

对提交做了一轮独立对抗性审计（只读、约束不可改仓库）。**修复本身成立、核心机制与
三条反向验证均被独立复现**；以下四条是审计揪出的实质问题，均已修 + 补测 + 反向验证：

1. **总闸判据两度被绕过**（最值得修，因为它保护的正是「下次有人加调用点」）：
   - 初版 `/\bfetch\s*\([^;]{0,400}?dispatcher\s*:/` → **6 种等价写法漏网**
     （`const init = { dispatcher: d }; fetch(url, init)` 最现实）；
   - 二版 `/\bdispatcher\s*:/` → 仍漏 `{ ['dispatcher']: d }` 与 `[k]` 模板键；
   - 现版 `/\bdispatcher\b/`（**只用于扫 `src/`**）→ 7 种写法零漏网、`src/` 零误伤
     （大小写敏感，故 `Dispatcher` 类型名与 `closeAllProxyDispatchers` 不命中）。
   ⚠️ **测试文件不能套最严判据**：live spec 有用例名 `'per-request dispatcher 生效'`
   这类正当措辞，套了会假失败（实测踩到）—— 故测试文件用 `/\bdispatcher\s*:/` 分层。
2. **`proxyFetch` 不接受 `Request` 作 `init`（新增显式守卫）**：`{ ...init }` 展开
   `Request` 得到**空对象** ⇒ 请求**静默降级**为 GET、丢 body 与 headers
   （实测：全局 fetch 传 Request 是 POST+body，展开后变 GET 空体）。
   这比抛错更危险，故入口 `instanceof Request` 直接抛。三个调用点今天都不传 Request，
   属**防御性**修复。
3. **`describeFetchError` 的「噪音层挤掉根因」**：旧实现用**同一个 depth 计数**
   兼任「遍历上限」与「输出条数上限」，于是 `fetch failed` 这类无信息量层会
   **白白吃掉输出预算**。实测反例：
   `outer → mid → fetch failed → connect ECONNREFUSED` 旧输出 `outer ← mid`（**根因丢失**）。
   现拆成 `TRAVERSE_CAP=8`（防环形）+ `MAX_PARTS=3`（控可读性）。
4. **`cause = null` 未与 `undefined` 一视同仁**：旧判据写 `cause === undefined`，
   于是 `null` 走进「无 cause」分支，输出带 `Error: ` 前缀的噪音（实测 `Error: fetch failed`）。
   改用 `cause != null`。另：空 message 不再输出空串（UI 会显示成「测试失败：」后空白）。

### 实测基线（修复后，三版本一致）

`pnpm test` 全量：Node 22.19 / 24.21 / 26.10 均 **6716 passed / 0 failed / 5 skipped**。
（基线对照：修复前 master 是 `6522 passed / 2 failed`；本轮修复后首轮全绿 6701，
自审加固 +5 → 6706，再补 SOCKS5 端口缺陷 +10 → **6716**。）
⚠️ **修复前 Node 22.19 与 24.21 上是 `2 failed`**（就是本 issue 的那两条 live 用例）。
⚠️ **Node 26 上「能否工作」的端到端实测**（真实出网，本机可直连 opencode.ai）：
经自建代理打 `https://opencode.ai/zen/v1/models` → **HTTP 200**、CONNECT 隧道目标
`opencode.ai:443`；SOCKS5 形态 → 端口修复后 **HTTP 400**（服务端正常应答，链路通）；
SSE 逐块到达（0/43/89ms 三片）、并发 5 全 200。⇒ **Node 26 上工作正常**，
且该版本上「旧写法」也恰好能过（内置 8.10.2 与外部 8.x 同契约）—— 属版本巧合而非修好。

⚠️ **一条 pre-existing flaky（与本修复无关，已用 master 基线证实）**：
`tests/unit/aggregate-expiry.spec.ts:154`（`★ 清单里的每个渠道都真的走过了折算路径`）
偶发 `Test timed out in 5000ms`，实测频率约 **1/5 ~ 1/6**。

- 与本修复**无关**的三条证据：① 该 spec 未在本次改动中被触碰；② 它 import 的是
  `aggregate-core.js` / `lobsterai-product.js` / `trae-product.js`，而
  `aggregate-expiry.ts` 也不 import 本次改过的任何文件；③ `WIRED_EXPIRY_PROVIDERS`
  **不含 `opencode`**（只有 buddy / workbuddy / loomy / codearts / zcode / lobsterai / trae）。
- **决定性证据**：用 `git worktree add <dir> master --detach` 拉出**未含本修复**的
  master 基线，同一台机器同一 Node 跑 6 次，同样出现 **1 次失败**。
- ⇒ 全量跑看到它变红时，**先看失败项是否落在自己改过的文件上**，别记到本次账上。
  ⚠️ 但也别当噪音永久放过（本 issue 的教训正是「把红用例当环境性问题放过」）——
  它值得**单独开 issue** 查「为什么逐条遍历 7 个渠道会偶发超过 5s」。

### ⚠️ 为什么这个缺陷能进主干（值得记住的教训）

`git log` 显示它由 `7dd3422`（2026-10-02，新增 OpenCode Zen provider）引入，
此后 `opencode-proxy.ts` 未改。进主干的路径是**两次被当成「环境性问题」放过**：

- `PR-描述.md`：「那 2 条失败与本 PR 无关……属**环境性问题，非代码回归**」；
- `docs/GEMINI-PORT-PLAN.md`：「undici 8.11.2 的环境性不兼容，**移植前基线同红**」。

两次判断都**基于真实观察**（确非那两个 PR 引入、基线确实同红），但结论下错了 ——
「非本 PR 引入」不等于「不是缺陷」。而且更早还有第三重掩盖：
该 spec 的 2 条「代理不可用」用例**因为错误的原因通过**（见上文假绿）。
⇒ **教训**：看到「基线同红 / 环境性问题」时，要么查清根因，要么**留一条会持续报警的闸**；
把红用例当背景噪音放过，等于让一个「provider 完全不可用」的缺陷安静地留在主干里。

## ⚠️⚠️ Issue IKM9LR：可达性判据从「本地硬编码表」改为「远端 `provider.api`」

**用户报障**（2026-10-16）：OpenCode 官方公告 GLM 5.3 Flash 与 DeepSeek V4.1 Flash
已免费提供（附官方推文截图），而本插件的 OpenCode 渠道**选择不了这两个模型**；
用户在 scoop 装的 opencode TUI 里**能看到**。

### 根因：一个常量吃了两份职责

`OPENCODE_FALLBACK_MODELS` 同时是「网络失败的兜底目录」**与**「协议可达性白名单」，
而后者是**硬编码**的。`loadOpencodeCatalog` 拉到远端 85 条后逐条过
`isReachableOpencodeModel`（`opencode-adapter.ts`）⇒ 远端**明明下发**的新模型
被本地表挡掉，症状与「上游没这个模型」**完全同形**。

实测被挡掉的 5 条：`beam-free`、`nemotron-3.5-super-vl-free`、`jev-1.13-free`、
**`deepseek-v4.1-flash-free`**、**`glm-5.3-flash-free`**。

⚠️ 这不是「数据没更新」而是**设计缺陷**：每上一个新模型都要手工加一行代码。

### 修法：`provider.api` 才是协议端点的权威字段

models.dev 每个条目带 `provider.api`。实测（2026-10-17）按它分组与
「本插件实现了哪些协议」**逐格吻合**：

| `provider.api` | 条数 | 本插件 |
|---|---|---|
| `https://opencode.ai/inference/openai/v1` | 56 | ✅ 已实现（`OPENCODE_CHAT_PROTOCOL_API`） |
| `…/inference/anthropic/v1` | 17 | ❌ 未实现（实测 `/v1/messages` 恒 500） |
| `…/inference/google/v1beta` | 8 | ❌ 未实现（Gemini 原生协议） |
| （无该字段） | 4 | ⚠️ 不知道 ⇒ **退回本地表** |

⚠️ 改前那 14 条本地表条目**全部**落在 `openai/v1` 内、**零反例**。

**三格语义（缺一不可）**：`true` ⇒ 可达；`false` ⇒ 不可达；**缺条目 ⇒ 退回本地表**。
第三格是刻意的 —— `jev-1.13-free` 无条目且实测回 `400 ModelProtocolUnsupported`，
但那条实测**只属于那个模型**，推广成「无条目即不可达」会让未来所有新模型凭空消失。

⚠️ **比较必须逐字相等**（用 `endsWith` 也会过，但会让未来同后缀的第三方端点被误判）。

### ⚠️ 这道闸管不了的三样（只能靠运行时错误分类兜）

① **地域封锁**：`beam-free` 的 `api` 就是 `openai/v1`，实测 403 `RegionError`
（按出口 IP 判，目录层无从预知）；② **上游不稳定**：`glm-5.3-flash-free`
实测约 2/5 概率 429；③ **废弃**：`mimo-v2.5-free` 回 410
`ModelDeprecated`（上游点名改用 `mimo-v2.6-flash-free`），
`nemotron-3-ultra-free` 远端已不下发且实测 503 —— 这两条**已从兜底表移除**，
移除理由留在 `opencode-product.ts` 的注释里（别顺手加回来）。

### ⚠️⚠️ 两个**同源但独立**的判据 bug（都靠硬编码表）

1. **免费判定也只看本地表**（`isFreeOpencodeModel`）⇒ 远端 `cost: {input:0,output:0}`
   的新免费模型被判成**收费** ⇒ 匿名用户看不到（与可达性那个症状同形、但独立）。
   现已改为**远端 cost 优先、本地表兜底**。
2. **`listModels` 的调用顺序**：`catalog()` 内部会逐条过滤，而两张远端表是
   **读能力表那一刻才注入**的 ⇒ 原先「先取目录、后读能力表」在冷启动首帧
   **必然**退化成纯本地表。**守卫用例实测抓到的真缺陷**，修法是先读能力表。
   ⚠️ `loadOpencodeCatalog` 里也加了一次同样的前置读（它也过滤）。

### 实测结果

匿名可见模型 **7 条 → 9 条**，issue 报的两个都在列；
`deepseek-v4.1-flash-free` 另测得工具调用正确还原 `read`、`effort=low`/`max` 上游均 200。

⚠️ **图片能力仍是零实测**：models.dev 标这两个为 `text+image`，但实测窗口内
`FreeTierError` 拒绝率升到 8/8，取不到证 ⇒ 按惯例**不写进实测校准表**，
记「结构上可达、零实测」。

### ⚠️⚠️ 判「某个模型可用」时**单次探测不作数**

实测 `FreeTierError` 是**逐请求随机**的（3 轮 × 4 模型并列，`big-pickle` 这种
老模型也在 OK 与 403 间交替）⇒ 单次请求判不了任何模型能力。
我据此作废过一轮图片结论（先拿到「白色」，解码后发现那张 PNG 其实是
`R0G0B0A0` **全透明**，纯幻觉）。⇒ 每格必须多采样，且只统计「过了门禁的那些」。

### ⚠️ 三次实测暴露的上游形态（供下次判读报障参考）

| 现象 | 含义 |
|---|---|
| `403 FreeTierError`「can only be used from within OpenCode」 | 形状门禁失败（缺 session 头/门禁工具），**不是**额度 |
| `429 …Endpoint is unavailable` | 上游该端点不稳定，**可重试**（`glm-5.3-flash-free` 常见） |
| `400 ModelProtocolUnsupported` | 模型级，与端点无关（`jev-1.13-free`） |
| `410 ModelDeprecated` | 上游废弃，报文带 `replacement` 字段 |
| `403 RegionError` | 出口 IP 地域封锁，本地判不了 |
| 空正文 + `finish=stop` | 上游抽风（2026-10-15 记录，约 1/3 概率），**与协议适配无关** |

## ⚠️⚠️ models.dev 直读收敛到全仓唯一直读点（2026-10-17）

**用户要求**：「定期读取 models.dev 应该成功就保存本地文件，冷启动就读本地文件缓存，
读不到就 fallback 不会直读 models.dev（可能卡很久）；opencode 或者 cline 等 provider
读取 models.dev 的直读操作都变成读取本地缓存，只有 1 处定期更新本地缓存可以直读」。

### 改前：两处各直连一次（5 MB 的外部站点）

`opencode-capability.ts` 与 `cline-models-dev.ts` **各自**一套
直连 + TTL + 在飞去重 + ETag。既是「一文件两套同义判据」，
也让这 5 MB 的请求在插件里发生**两次**。实测那份数据
**解压后 5.05~5.39 MB**，且「要么 ~2 秒、要么整段挂死」
（本机三取：`20010ms 超时` / `20010ms 超时` / `1908ms 成功`；
2026-10-17 再测仍复现 `200` / `45s 超时` / `200` 交替）。

### 改后：`src/models-dev-cache.ts` 唯一直读点

降级链**三级，任何一级都不回退到网络**：

```
内存 → $DSH_HOME/cache/models-dev.json → undefined（调用方各自的本地兜底表）
```

| 常量 | 值 | 依据 |
|---|---|---|
| `MODELS_DEV_TIMEOUT_MS` | 90s | 成功只需 ~2s、失败能挂满窗口 ⇒ 调大几乎零成本 |
| `MODELS_DEV_MAX_ATTEMPTS` | 3 | 用户要求「3 次都失败才放弃」 |
| 退避 | 指数 2s → 4s | 固定间隔可能整体落在同一抖动窗口 |
| `MODELS_DEV_TTL_MS` | 6h | 发布节奏的数据 |
| 周期刷新 | TTL/2 = 3h | 比 TTL 短才能保证最坏只落后半个 TTL |
| `MODELS_DEV_DEADLOCK_MS` | 480s | ⚠️ **必须 > 单轮最坏耗时**，见下 |
| `MODELS_DEV_CACHED_PROVIDERS` | `['opencode','cline-pass']` | 见下 |

### ⚠️ 旧缓存文件不升版的**已知退化**（2026-10-17 实测，如实登记）

本次新增了 `provider.api` 字段，但 `CACHE_VERSION` **仍是 1** —— 没有升版。

**为什么可以接受**（实测探针结论，非推断）：老用户磁盘上已有的
`models-dev.json` 里**没有** `provider.api` ⇒ `chatProtocol` 全为 `undefined`
⇒ 判据**退回本地兜底表**（不是判死、不是崩）。实测：

```
旧缓存（无 provider.api）下：能力表 2 条、chatProtocol 全 undefined
  deepseek-v4.1-flash-free  isReachable=true  isFree=true   ← 本 issue 的模型仍可见（已补进本地表）
  brand-new-x（未来新模型）  isReachable=false               ← 退化期内不可见
```

⇒ 退化窗口 = **旧缓存 TTL（最长 6 小时）**，期间行为与本次改动前完全一致
（即用户拿到的是「没有本次修复」的状态，而不是「坏掉」的状态）。

⚠️ **不升版的理由**：`provider.api` 是**新增的可选字段**，缺它的缓存仍能被
`normalizeEntry` 正常解析（该字段全部标为可选，缺字段一律按「不知道」处理）。
若为此升版，会让所有老用户的缓存**立刻作废**并强制重新下载 5 MB ——
代价远大于「退化 6 小时」。

⚠️ 与 issue IKJJ0V 的对比（**同类问题，处理方式相反**）：当年 `version: 1→2`
必须升版，是因为**旧缓存缺 `efforts` 会让思考档位在 TTL 内持续缺失**，
而那次是「字段缺失导致功能静默失效且用户无从察觉」。本次的退化是
**可预期、可自愈、且退回的是改动前的行为**，故按「不值得作废缓存」处理。
⚠️ 这条权衡是判断，不是事实 —— 若将来出现「缺 `provider.api` 导致的功能
静默失效」，应重新评估升版。

### ⚠️⚠️ 三个「加长超时 / 加重试」引入的耦合点（各自都有守卫）

1. **死锁阈值必须 > 单轮最坏耗时**：单轮 = 3×90s + 6s ≈ **276s**，而旧判据
   `TIMEOUT × 2` 只有 180s ⇒ **一个正在正常重试的刷新会被误判成「已死」而再起一个**
   ⇒ 并发请求翻倍，正好加剧上游压力。守卫是**双向**的：
   `DEADLOCK > WORST_CASE` 且 `DEADLOCK < WORST_CASE × 4`
   （后者防阈值大到让真卡死的刷新永久占住去重位）。
2. **只缓存白名单里的 provider**：整份落盘实测 **2.6 MB / 8993 条**，而
   `loadDiskCacheSync()` 是 `readFileSync`、跑在**启动路径**上 ⇒ 与本模块
   自己写的「代价可忽略」矛盾，也与 2026-10-02 那次事故同型。
   白名单后降到 **50.4 KB**（原始 5.49 MB 的 0.90%）。
   ⚠️ 新增消费方必须往白名单加一条，否则它永远读到空块；守卫会扫描消费方逐个点名。
3. **失败日志必须说明重试过几次**（`已重试 3 次`），否则用户看到一条
   「沿用上一次读数」却不知道后台已经等过。

### 失败永不覆盖既有缓存（核心不变式）

失败（超时/网络/**解析为空**）一律**保留旧值**，只记日志。
⚠️ 「解析为空」也必须算失败：否则会把磁盘上的好数据覆盖成空文件，
下次冷启动真的什么都没有。守卫用例逐条锁住。

## ⚠️⚠️ 2026-10-17 两轮 subagent 审计（独立 + 对抗变异）打穿的 5 处

合并到 master 后跑了一轮独立审计 + 一轮对抗性变异审计（15 个变异）。
⚠️ **下面每一条我都独立复现过**，不是只采信审计报告。

| 级别 | 缺陷 | 修法 |
|---|---|---|
| **P1** | **判据依赖调用顺序 ⇒ `stream()` 路径误报 `MISSING_CREDENTIAL`** | 改为**自给自足**（钩子） |
| P2 | 在途去重**吞掉后到者**的回调 ⇒ 启动首刷广播永不发出 | 订阅者列表 |
| P3 | `onUpdated` 零守卫 | 补行为用例 |
| P4 | `finally` 不校验槽位归属 ⇒ 误清他人槽 | 加身份哨兵 |
| P5 | `AbortError` 仍重试，与注释矛盾 | 拆开超时/中断 |

### ⚠️⚠️ P1 最值得记：它是我自己的修复引入的**真回归**

对抗审计先打穿了两条**恒真守卫**（守卫生效却看似在守护），
我修守卫时**删掉了 `listModels` 里那句冗余的前置读**，理由是
「`loadOpencodeCatalog` 更靠前那次读兜住了」。**对 listModels 成立，
对 `stream()` 不成立** —— 独立审计实测：

```
模型 glm-5-free（models.dev 标免费，但本地兜底表没有）：
  目录里可见   = true       （走 loadOpencodeCatalog，有前置读）
  stream() 抛出 = MISSING_CREDENTIAL「请先添加账号」  ← 不走那条路径
```

影响面实测：**37 个模型**（远端免费 46 − 本地表免费 9）。
⚠️ issue 报的那两个恰好已被收录进本地表，所以**表面完全看不出来**。

**修法不是「再补一处前置读」**（那会重蹈「两处同款、漏一条」的覆辙），
而是把「有没有读过能力表」变成**判据自身的事实**：
`opencode-product.ts` 导出 `setOpencodeCapabilityHook()`，
两个判据读到表为 `undefined` 时**就地**读一次能力表
（`opencode-capability.ts` 在**模块加载期**注册 —— 冷启动首帧才拿得到）。

⇒ 判据自给自足，任何调用点、任何顺序都得到同一答案。

⚠️ **两条方法论**（比这个 bug 本身更值得记）：
1. 「删掉一处冗余」不等于「约束转移到了另一处」—— **要验证另一处真的覆盖了
   所有调用点**，而这里恰恰没有；
2. 守卫断言用的样本若**恰好落在另一条兜底路径覆盖的范围内**，
   守卫就退化成恒真。用本地表里**没有**的 id（`zzz-brand-new-x`）才有敏感性。

### P2：在途去重曾把后到者的回调整个丢弃

`index.ts` 里 `primeModelsDev()`（不带回调）会先占住 `refreshing`，
8 行后的 `refreshModelsDev(broadcast, …)` 命中 `return refreshing` ⇒
**那个广播回调被整个丢弃**。实测 fetch 1 次 / **广播 0 次**。
⚠️ 能力表本身能自愈（memory 换新对象身份 ⇒ 归一缓存失效），
**真正丢的是 `llm/adapters-updated`** ⇒ 首帧那套「text-only / 兜底表」
渲染会保持到下次交互。

⇒ 改成**订阅者列表**：在途期间到来的每个回调都登记，成功后逐个兑现；
兑现时**先取快照再清空**，且单个订阅者抛错**不得**连坐其余订阅者。

### P4：`finally` 不校验槽位归属

无条件 `refreshing = undefined` ⇒ 若本轮已因「死锁超时」被判过期
（被另一轮清空并重新赋值），它稍后 settle 的 `finally` 会把**别人的槽也清掉**
⇒ 第三次调用又发一次请求 ⇒ 并发翻倍。

⚠️ 修法有个**TDZ 陷阱**：`finally` 里不能读 `task`（async IIFE 可能在本轮
被赋值前就同步走到 `finally`）⇒ 另设一个**先声明**的身份哨兵 `mine`，
存进 `refreshingToken` 供比对。
⚠️ 且 `refreshing`（promise，供调用方 await）与 `refreshingToken`（哨兵）
必须**同步赋值** —— 我第一版曾让两者类型不一致、比对恒为假，
死锁恢复功能**静默失效**，被自己的类型检查抓出来。

### ⚠️ 审计过程中被证伪的两个「结论」（如实登记）

1. **独立审计一度得出「匿名用户仍看不到新模型」的相反结论**，后自行证伪 ——
   探针**复用了同一个 `Response`（body 只读一次）** + 跨用例
   `setRemote*(undefined)` 与记忆化打架。单用例复刻完整序列后，
   主修复**确实兑现**（匿名可见 37 个远端免费新模型 + 9 个本地免费）。
   ⚠️ 教训：**探针自身的缺陷会得出与被测代码相反的结论**。
2. **我第一版的 P4 探针判据也不准**：用 `force: true` 观察「是否多发」，
   而 `force` 的语义**就是每次都发** ⇒ 恒为「未修复」的假阴性。
   改用 `force: false`（缓存新鲜时不该发）才区分得出来。

### ⚠️ OpenRouter **不能**当 models.dev 的备份源（实测核对，用户提议）

用户提议用 `https://openrouter.ai/api/v1/models` 作备份。实测
**HTTP 200 / 2.3s / 470 条**（国内可达），但**接不得**：

| 问题 | 实测 |
|---|---|
| **没有 `provider.api` 字段** | 470 条里 **0 条**有 ⇒ 协议可达性无从判定 |
| **id 命名空间不重叠** | 前缀全是 `openai:`/`deepseek:`/`z-ai:`…；`*opencode*` / `*zen*` 匹配 **0 条** |

⇒ 并进来会让 `chatProtocol` 变 `undefined` ⇒ 退回本地表 ⇒ **等于没修 issue**。
它的 `context_length` / `architecture.input_modalities` 在 models.dev 也有
⇒ 属**冗余而非补充**。⇒ **决定不接入**（2026-10-17）。

## ⚠️ 连带修掉的一个 pre-existing flaky：`officeace-inflight-guard` 用例③

**与 OpenCode 无关**，但它污染全量信号（实测 12 次里红 4 次）⇒ 一并根除。

**根因（探针实测，非推断）**：`DSH_OFFICEACE_PENDING_TTL_MS = '0'` 把判据
`nowMs - pending.at > TTL` 退化成 `> 0`，即「**跨过 1 毫秒**才算中止」
（`isAbandonedOfficeAceLogin` 用**严格大于**）。而用例③在 `account.create`
之后**紧接着**调 `account.list`，两者常落在**同一毫秒** ⇒ `delta === 0`
⇒ 判「进行中」⇒ 幽灵条目没被收掉 ⇒ 断言要 0 拿到 1。

探针输出：`delta=0 ⇒ 已中止=false`、`delta=1 ⇒ 已中止=true`。

**修法**：断言前确定性推进时钟 2ms。

⚠️ **验证方式本身值得记**：先做负向对照（把 2ms 改回 0ms）却 8/8 全绿，
差点把巧合当结论；是 `git stash` 严格对照才确认有效 ——
**机器状态会漂，单次观测不可信**。

| 版本 | 20 次对照 |
|---|---|
| 原始 | 11 绿 / **9 红** |
| 修复后 | **20 绿 / 0 红** |

⚠️ 这是 `isAbandonedOfficeAceLogin` 注释里记的同型事故（「20 次只有 10 次变红」）
的**复发** —— 当年没被根治。教训：断言必须是**确定时刻**可驱动的。
