# WorkBuddy / CodeBuddy 原生搜索能力调研

> 状态：**探测完成**（2026-10-14）
> 结论：**WorkBuddy 原生 WebSearch 可被第三方直接调用**，端点 `/agenttool/v1/search` 已实测打通。
> 本文只记录**已验证的事实**与**证据出处**，不含实施方案（尚未决定是否实施）。
>
> ⚠️ 本文含一次**方向性误判的完整记录**（§五），保留它是因为同类错误容易复发：
> 误把「能返回搜索结果的端点」当成「原生搜索端点」，以及误把 `agentic_search` 当成正主。

---

## 一、调研缘起

用户在 DSH 里使用 `dsh-codearts-auth`（jet-hub）插件注册的 workbuddy 路由时，
`web_search` 工具不可用，而官方 DeepSeek 账号模型下可用。

追问链条：

1. 为什么官方能用、插件接过来不能用？
2. 插件侧是否没做搜索兼容和 key 传参？
3. 能不能让插件带 key 去调 buddy 那边的原生搜索？
4. **（用户质疑，后被证实正确）** 是不是把对话端口当成了搜索端口？

---

## 二、DSH 侧的架构事实（决定了问题边界）

### 2.1 搜索不走插件，走 Host 的 `ctx.web` seam

`dsh-web-search-deepseek` 的 `resolveOptions()` 有两条鉴权路径，分叉点是：

```js
if (ctx.get("agents")?.currentInitiator()?.session.requestContext()?.provider !== ACCOUNT_PROVIDER)
    return void 0;   // ACCOUNT_PROVIDER = "deepseek-account"
```

- **账号令牌路径**：仅当会话 provider === `deepseek-account` 时启用，用登录态搜索。
- **API Key 路径**：其余一切路由，回落解析 `DEEPSEEK_API_KEY`。

jet-hub 注册的路由是 `codearts / buddy / workbuddy / lobsterai / qoder / qodercn / trae /
cline / loomy / raccoon / minimax / zcode / gemini / opencode`，**均不等于 `deepseek-account`**，
故账号令牌分支被短路，只能走 key 路径。

### 2.2 `web-search-deepseek` 是专用适配器，不是通用搜索客户端

```js
const endpoint = `${options.baseURL}/messages`;   // → https://api.deepseek.com/anthropic/v1/messages
headers: { 'x-api-key', 'authorization', 'anthropic-version': '2023-06-01' }
body: { model, messages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses }] }
```

打的是 **Anthropic Messages 协议**，工具声明是 **Anthropic 服务端工具**。
workbuddy 走的是 **OpenAI 兼容协议**（`/v2/chat/completions`）。两者四处不同
（路径 / 协议 / 工具声明形态 / 鉴权头），**不是换 `baseURL` 能解决的**。

### 2.3 插件侧确实没有搜索实现

在项目 `src/`（128 个 ts 文件）全量搜索 `ctx.web`、`registerSearchProvider`、
`searchProvider`、`imasearch`、`agenttool` —— **0 命中**。

`src/openai-gateway/responses.ts` 里那两处 `web_search` 是**反方向**的事：
网关丢弃客户端（Codex）传来的、DSH `ToolSchema` 无法表达的工具类型。

### 2.4 seam 提供的扩展点

`ctx.web` 的服务定义（`app.asar` 内）：

```
registerSearchProvider(provider: WebSearchProvider): () => void
  — 重复 id 抛 WEB_DUPLICATE_PROVIDER；返回 disposer，随调用 fiber 释放

async search(request: WebSearchRequest, signal?): Promise<WebSearchResult>
  — 调用时按选择规则解析 provider；seam 对结果强制 request.maxResults 截断
```

选择语义（执行时解析，与注册顺序无关）：

| 条件 | 结果 |
|---|---|
| 配置了 id，已注册且 `available()` | 用该 provider |
| 配置了 id，未注册 | `WEB_PROVIDER_CONFIGURED_MISSING` |
| 配置了 id，已注册但不可用 | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 未配 id，恰有一个可用 | 用它 |
| 未配 id，多个可用 | `WEB_PROVIDER_AMBIGUOUS` |
| 未配 id，无可用 | `WEB_PROVIDER_UNAVAILABLE` |

⇒ **插件可以自行注册搜索 provider，无需改 DSH 本体。**

---

## 三、客户端源码位置（证据出处）

WorkBuddy 桌面端已重新安装，**版本 5.7.6**。

| 项 | 值 |
|---|---|
| 安装目录 | `C:\Users\Think\AppData\Local\Programs\WorkBuddyAI` |
| `install-manifest.json` → `appVersion` | `5.7.6` |
| `product.json` → `genieVersion` | `5.7.6` |
| `version`（Electron） | `37.10.3-24` |
| CLI 包 | `@genie/agent-cli`（`version: 0.0.0`） |

**CLI 主体（含全部工具实现）：**

```
resources\app.asar.unpacked\cli\dist\codebuddy-headless.js     11,938,885 字节
resources\app.asar.unpacked\cli\dist\codebuddy-lite-wb.mjs      8,567,703 字节
```

**产品配置：** `resources\app.asar.unpacked\cli\product.json`（378,883 字节）

```json
{
  "applicationName": "workbuddy-ai",
  "productName": "WorkBuddy AI",
  "endpoint": "https://www.workbuddy.ai",
  "stagingEndpoint": "https://staging-codebuddy.tencent.com",
  "deploymentType": "SaaS",
  "platform": "CLI",
  "isOversea": true,
  "genieVersion": "5.7.6"
}
```

**关键偏移（`codebuddy-headless.js`）：**

| 内容 | offset |
|---|---|
| `WEB_SEARCH_API_PATH` / `WEB_SEARCH_TIMEOUT_MS` | 6,419,676 / 6,419,697 |
| `performWebSearch` 全文 | ~6,419,697 – 6,423,000 |
| `buildRequestBody` | ~6,425,300 |
| `/agenttool/v1/webfetch` | 6,394,736 |
| 请求头常量定义表 | **9,571,779** |

---

## 四、原生 WebSearch 的权威实现

### 4.1 工具类（`codebuddy-headless.js` @6,419,697）

```js
class extends BaseTool {
  this.WEB_SEARCH_API_PATH = "/agenttool/v1/search"
  this.WEB_SEARCH_TIMEOUT_MS = 2e4          // 20 秒
  this.name = ToolNames.WEB_SEARCH
  this.aliases = ["read"]
}
```

### 4.2 参数 schema

```js
{
  query:           string, min 2,
  allowed_domains: string[] 可选,
  blocked_domains: string[] 可选,
  freshness:       string 可选,
                   regex /^(?:d(?:[1-9]|[12]\d|30)?|m(?:[1-9]|1[0-2])?|y[1-5]?)$/
}
```

`freshness` 语义（源码注释原文）：`d[N]` 最近 N 个自然日（1–30）、`m[N]` 最近 N 个自然月
（1–12）、`y[N]` 最近 N 个自然年（1–5）。N 可省略，默认 1；当前未走完的自然单位计为 1。
`d1` = 今天，`m1` = 本月至今天，`y1` = 本年至今天。

### 4.3 请求体（`buildRequestBody` 原文逐字）

```js
buildRequestBody(eA) {
  let {query: el, allowed_domains: ec, blocked_domains: eu} = eA
  let ed = eu?.length ? ` (${eu.map(a => `-site:${a}`).join(" ")})` : ""
  return {
    query: `${el}${ed}`,
    type: "text2text",
    max_results: 5,                              // ← 客户端写死 5（但**上游支持更大**，见 §6.5）
    ...ec?.length ? {allowed_domains: ec} : {},
    ...eA.freshness ? {freshness: eA.freshness} : {}
  }
}
```

注意 `blocked_domains` **不是**独立字段，而是拼进 `query` 字符串的 `-site:` 后缀。

### 4.4 请求头（`performWebSearch` 原文）

```
Accept:                       application/json
Content-Type:                 application/json;charset=UTF-8
X-Requested-With:             XMLHttpRequest
User-Agent:                   ${PRODUCT_TYPE}/${platformVersion}
Authorization:                Bearer ${accessToken}
X-Agent-Intent:               craft   （或 meta["codebuddy.ai/mode"]）
X-Conversation-ID:            context.id
X-Conversation-Request-ID:    context.conversationRequestId || ""
X-Conversation-Message-ID:    <32位无横线 uuid>
X-Request-ID:                 <同上>
X-Product:                    deploymentType（"SaaS"）
X-IDE-Type:                   clientInfo.ideType
X-IDE-Name:                   clientInfo.platform
X-IDE-Version:                clientInfo.platformVersion
X-User-Id:                    account.uid
X-Department-Info:            account.departmentFullName || ""
```

另叠加：`IOAUtils.applyIOADefaultHeaders(...)` + `customHeadersProvider.applyTo(...)`。

### 4.5 请求头常量的真实字符串值（@9,571,779 提取）

| 源码常量 | 真实值 |
|---|---|
| `TRACE_ID_HEADER` | `X-Trace-ID` |
| `REQUEST_ID_HEADER` | `X-Request-ID` |
| `ROOT_REQUEST_ID_HEADER` | `X-Root-Request-ID` |
| `PARENT_CONVERSATION_ID_HEADER` | `X-Parent-Conversation-ID` |
| `AGENT_TYPE_HEADER` | `X-Agent-Type` |
| `CONVERSATION_ID_HEADER` | `X-Conversation-ID` |
| `SESSION_ID_HEADER` | `X-Session-ID` |
| `CONVERSATION_REQUEST_ID_HEADER` | `X-Conversation-Request-ID` |
| `CONVERSATION_MESSAGE_ID_HEADER` | `X-Conversation-Message-ID` |
| `AGENT_INTENT` | `X-Agent-Intent` |
| `PRODUCT` | `X-Product` |
| `IDE_TYPE_HEADER` | `X-IDE-Type` |
| `IDE_NAME_HEADER` | `X-IDE-Name` |
| `IDE_VERSION_HEADER` | `X-IDE-Version` |
| `API_KEY_HEADER` | `X-API-Key` |
| `PRODUCT_VERSION_HEADER` | `X-Product-Version` |
| `USER_ID_HEADER` | `X-User-Id` |
| `PRIVATE_DATA_HEADER` | `X-Private-Data` |
| `DATA_TAG_HEADER` | `X-Data-Tag` |
| `MODEL_ID_HEADER` | `X-Model-ID` |
| `AGENT_PURPOSE` | `X-Agent-Purpose` |

### 4.6 响应解析（源码原文）

```js
{
  provider:         eA.provider || "",
  results: (eA.results || []).map(r => ({
    title:   r.title   || "Untitled",
    url:     r.url     || "",
    snippet: r.snippet || "",
    ...r.site    ? {site: r.site}       : {},
    ...r.favicon ? {favicon: r.favicon} : {}
  })),
  total_results:    eA.total_results    || 0,
  response_time_ms: eA.response_time_ms || 0
}
```

工具产出另有结构化块 `buildStructuredResult`：

```js
{ type: "web_search_tool_result", query, searchType: "text2text",
  provider, results, totalResults, responseTimeMs }
```

### 4.7 兄弟工具：WebFetch

```js
this.WEB_FETCH_API_PATH = "/agenttool/v1/webfetch"
parameters: { url: string, prompt: string }
```

---

## 五、⚠️ 误判记录（同类错误易复发，务必保留）

### 5.1 第一次误判：把「返回搜索结果的端点」当成「原生端点」的反面

先用 `/agenttool/v1/search` 探测成功（返回漂亮网页结果），**却因为没找到它出现在
客户端工具清单里而怀疑它不是原生的**，转而去追 `agentic_search`。

### 5.2 第二次误判：把 `agentic_search` 当成原生搜索

从旧版客户端 `CodeCache` 残片里挖到工具清单：

```
connect_cloud_service / connect_open_platform / conversation_search /
workbuddy_marketplace_skill / agentic_search
```

于是认定 `agentic_search` 是原生搜索并实测。**实测结果暴露它是知识库检索，不是网页搜索：**

```json
POST /agenttool/v1/agentic_search
{"query": "..."}
→ {"request_id":"...","results":[{"id":"pdf_...","title":"2025天津卷政治真题.pdf",
    "content":"...","source":3,"content_type":1,"rerank_score":25.62,
    "resource_id":"pdf_..."}],
   "latency_ms":204,
   "statuses":[{"source":"SOURCE_TYPE_GAO_KAO","status":"OK","result_count":40}]}
```

判据：搜「北京今天天气」**返回 0 条**；`statuses` 显示数据源是
`SOURCE_TYPE_GAO_KAO`（**高考**知识库）。领域过窄，**不能当通用搜索**。

### 5.3 定案

装完 5.7.6 后直接读客户端源码，`WEB_SEARCH_API_PATH="/agenttool/v1/search"` **写死在
WebSearch 工具类里**，且在 5.5.2 → 5.7.6 两个版本中**未变**。

⇒ **`/agenttool/v1/search` 才是原生搜索端点。** §5.1 的怀疑是错的。

### 5.4 教训

- **「能返回搜索结果」≠「是该产品的原生搜索」**，反之亦然。必须找到调用点源码才算数。
- 客户端工具清单（`product.json` 的 `tools[]`）只列**名字**，不含端点；
  端点只能从 CLI 主体源码里找。
- 从 `CodeCache` 残片挖到的清单可能属于**不同版本**（当时是 5.5.2 残留），
  不可直接当作当前行为。

---

## 六、实测结果（2026-10-14，真实请求）

### 6.1 原生搜索：7 组全部 HTTP 200

请求：`POST https://www.workbuddy.ai/agenttool/v1/search`
凭据：`WORKBUDDY_ACCOUNT_66E05E7C`（`www.workbuddy.ai`）

| # | 测试 | 状态 | 耗时 | 结果数 | 备注 |
|---|---|---|---|---|---|
| 1 | 完整头 + 官方 body | 200 | 752ms | 5 | 上游 `response_time_ms` 464 |
| 2 | **最小头**（仅 Content-Type + Authorization + UA） | 200 | 334ms | 5 | **98ms** — 关键结论 |
| 3 | `freshness: "d7"` | 200 | 11065ms | 5 | 返回含「2天前」内容 ✓ 生效 |
| 4 | `allowed_domains: ["github.com"]` | 200 | 3450ms | 5 | ⚠️ 结果**未被限制**到 github（见 §6.3） |
| 5 | `blocked_domains: ["zhihu.com"]` | 200 | 201ms | 5 | 结果中无 zhihu（但本来也可能没有，**不构成证据**） |
| 6 | 实时新闻 `freshness: "d1"` | 200 | 2659ms | 5 | 新浪科技 / 新华网 / 环球网 ✓ |
| 7 | 用 `limit` 代替 `max_results` | 200 | 320ms | 5 | 仍 5 条 ⇒ `max_results` 才是正主 |

### 6.2 鉴权：两种域各认各的 token

| 域 | token 来源 | 结果 |
|---|---|---|
| `www.workbuddy.ai` | `WORKBUDDY_ACCOUNT_*` | ✅ 200 |
| `www.workbuddy.ai` | buddy token | ❌ 401 |
| `copilot.tencent.com` | `BUDDY_ACCOUNT_*` | ✅ 200 |
| `copilot.tencent.com` | `WORKBUDDY_ACCOUNT_*` | ❌ 401 |
| 无 token | — | ❌ 401（APISIX 网关层） |

⇒ **X-Domain 与 token 必须同源。**

### 6.3 待复核项

- `allowed_domains` 传 `["github.com"]` 却返回百度系结果 ⇒ **疑似被上游忽略**，
  但仅一次观测，**需二次验证**才能定论（也可能与 `query` 语义有关）。
- `blocked_domains` 同理：无 zhihu 结果可能只是巧合。
- **频率限制未测**。
- ~~`max_results` 固定 5 是否可被其它值覆盖~~ ⇒ **已实测，见 §6.5**（客户端写死 5 只是它的选择，上游本身支持 1–8）。

### 6.5 `max_results` 上限实测（2026-10-14 补测）

客户端源码写死 `max_results: 5`，但**上游本身支持更大**。实测（两个 host 各测 7 个值）：

| `max_results` | 1 | 3 | 5 | **8** | 10 | 20 | 50 |
|---|---|---|---|---|---|---|---|
| 实际返回条数 | 1 | 3 | 5 | **8** | 8 | 8 | 8 |

**结论**：
- 1–8 原样返回；
- **> 8 一律封顶到 8**；
- 两个 host（`www.workbuddy.ai` / `copilot.tencent.com`）行为**完全一致**。

⇒ 客户端写死 5 是它的产品选择，不是上游限制。我们实现取 **8**，与官方 DSH 的 `WEB_SEARCH_MAX_RESULTS = 8` 一致，且恰好是上游上限。

### 6.6 上游其它怪癖（同批实测，非搜索专属）

| 现象 | 响应 |
|---|---|
| 非流式 chat | `400` `code:11101` `Non-stream chat request is currently not supported` |
| workbuddy 首条非 system | `400` `code:11128` `first message is not system prompt`，**且 displayMsg 伪装成「被安全策略拦截」** |
| `tool_choice` 传对象 | `400` `cannot unmarshal object into Go struct field Request.tool_choice of type string` |
| `tool_choice: "none"` | 仍返回 `finish_reason: "tool_calls"` ⇒ 疑似被忽略 |
| 服务端搜索工具（三种形态） | 均 `200` 但**被静默忽略**，无任何搜索行为 |

> 服务端工具三形态：`{type:'web_search'}` / `{type:'web_search_20250305', max_uses:3}` /
> `{type:'web_search_preview'}`。均无 `web_search_tool_result` 块、无 citations、
> `delta_keys` 无搜索字段。⇒ **workbuddy 不提供 Anthropic 式服务端搜索工具。**

---

## 七、相关端点（同批探测，供参考）

| 端点 | 性质 | 鉴权 | 返回 |
|---|---|---|---|
| `/agenttool/v1/search` | **通用网页搜索（原生）** | buddy 或 workbuddy token（同源） | `{query,type,provider,results[],total_results,response_time_ms}` |
| `/agenttool/v1/agentic_search` | 知识库检索（高考源） | 同上 | `{request_id,results[],latency_ms,statuses[]}` |
| `/agenttool/v1/imasearch` | 知识库 RAG | 同上 | `{chunks[]}`；`limit` 必须 **[5,20]** |
| `/agenttool/v1/webfetch` | 网页抓取 | 同上 | （客户端 WebFetch 工具用） |
| `/agenttool/v1/tempkey` | 换临时密钥 | 同上 | `{temp_key,expires_at,ttl_seconds:86400}` |
| `/openapi/v2/skill-token` | 技能令牌 | 同上 | `{token,expires_in,introspect_url}` |

**不存在**（404）：`/agenttool/v1/websearch`、`/agenttool/v1/web_search`、
`/agenttool/v1/websearch/query`、`/agenttool/v1/imawebsearch`、`/v2/search`、`/v3/search`、
`/agenttool/v1/conversation_search`。

---

## 八、可行性判断

**结论：可行。** 原生搜索是**客户端工具**（非服务端工具），与 DSH 的 `ctx.web`
「客户端发起搜索」模型**天然契合**。

映射到 seam 契约几乎是**一对一**：

| 原生响应字段 | DSH `WebSearchResult.sources[]` |
|---|---|
| `results[].title` | `title` |
| `results[].url` | `url` |
| `results[].snippet` | `snippet` |
| （无对应） | `publishedAt`（可选，可不填） |

实现形态（伪代码，**尚未实施**）：

```ts
async search(request) {
  const { token, endpoint } = await 取同源凭据()   // workbuddy 或 buddy，须与 endpoint 同源
  const res = await fetch(`${endpoint}/agenttool/v1/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: request.query, type: 'text2text', max_results: 8 }),
    signal,
  })
  const { results } = await res.json()
  return { sources: results.map(r => ({ url: r.url, title: r.title, snippet: r.snippet })), truncated: false }
}
```

`max_results` 取 **8**（上游上限，也是官方 DSH 默认值，见 §6.5）。若 `request.maxResults` 更大，seam 不会补足（seam 只做**截断**）。

---

## 九、遗留问题（未验证，实施前需确认）

1. **`allowed_domains` / `blocked_domains` 是否真的生效**（§6.3）。
2. **频率限制**：未测；客户端设 20s 超时，服务端配额未知。
3. **凭据选择策略**：DSH 里选 workbuddy 路由时，搜索该用 workbuddy token
   （配 `www.workbuddy.ai`）还是 buddy token（配 `copilot.tencent.com`）？
   两者都能通，但**账号池可用性不同**（buddy 有 5 个账号，workbuddy 有 3 个）。
4. **`freshness` 是否要暴露给模型**：原生工具支持，但 DSH 的 `WebSearchRequest`
   只有 `query` + `maxResults`，无时间过滤字段。
5. **是否要注册为独立 provider**：会与 `web-search-deepseek` 并存，
   需在 `cordis.patch.yml` 把 `searchProvider` 指到新 id。

---

## 十、原始证据

- 探测脚本：`.agent\temp\probe-native-search.mjs`（本轮主脚本，按源码逐字段复刻）
- 其余脚本：`.agent\temp\probe-buddy-search*.mjs`、`probe-agentic-*.mjs`、
  `probe-search-endpoint-detail.mjs`、`mine-*.mjs`
- 原始响应 JSON：`.agent\temp\native-search-result.json`（本轮 7 组完整结果）
  及 `search-probe-*.json`、`agentic-search-*.json`、`search-endpoint-detail.json`

> ⚠️ 上述脚本从 `.agent\temp\probe-creds.json` 读凭据，该文件**已在探测后删除**。
> 复跑前需重新生成（从 `~/.dsh/.credentials.yaml` 提取，勿提交）。

---

## 附：本次调研推翻的结论汇总

| 曾做出的判断 | 实际 | 依据 |
|---|---|---|
| 「换 baseURL 就能用 buddy 搜索」 | ❌ 协议不同，非换端点可解 | §2.2 |
| 「插件漏做了搜索兼容」 | ❌ 架构分工如此，搜索不走插件 | §2.3 |
| 「服务端搜索工具可透传」 | ❌ 三种形态均被静默忽略 | §6.4 |
| 「`agentic_search` 是原生搜索」 | ❌ 它是高考知识库检索 | §5.2 |
| 「`/agenttool/v1/search` 不是原生」 | ❌ 它就是，源码写死 | §5.3 |
| 「`limit` 参数被忽略」 | ❌ 参数名是 `max_results`；上限 8（见 §6.5） | §4.3 / §6.5 |
