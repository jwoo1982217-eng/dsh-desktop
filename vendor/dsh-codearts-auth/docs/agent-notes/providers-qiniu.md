# Qiniu（七牛云 AI）Provider 接入实测笔记

> 2026-10-29 实测登记。协议基线：`https://api.qnaigc.com/v1`（OpenAI 兼容网关）。
> 本文件是该 provider **实测事实与工程落地约定**的唯一登记处。

---

## 0. 协议形态：与 modelscope 同一范式

| 维度 | 七牛云 AI |
|---|---|
| 基础地址 | `https://api.qnaigc.com/v1`（含 `/v1`、无尾斜杠） |
| 对话 | `POST /chat/completions`（SSE 流式），`Authorization: Bearer <API Key>` |
| 目录 | `GET /models` ⇒ `data: [{id, object, owned_by, created, context_length, max_tokens}]` |
| 凭据 | **静态 API Key，长期有效** |
| refresh | **无**（无 refresh 端点、无 refresh_token） |
| 余额 / 签到 | **无**（用量与计费只在 web 控制台可见） |

⇒ 接入结构逐字镜像 modelscope（静态 API Key + OpenAI 兼容 + 无 refresh + 无余额）。
落地文件：`src/qiniu.ts`（凭据/URL/头）→ `src/qiniu-product.ts`（产品配置 + 错误分类）
→ `src/qiniu-auth.ts`（`QiniuAuth extends Service`）→ `src/qiniu-adapter.ts`（`LlmAdapter`）
→ `src/qiniu-rpc.ts`（Jet Hub RPC）；`src/qiniu-messages.ts` 是 message 归一化。

创建 Key 的入口：`https://portal.qiniu.com/ai-inference/api-key`（RPC 的失败文案里直接给出）。

---

## 1. ⚠️⚠️ `GET /models` **免鉴权也回 200** ⇒「目录能读到」不构成凭据有效的证据

与本仓库 `minimaxintl`、`qoder` 同型。因此：

- 解析层 `parseQiniuCredential` 只判**形状**（是否存在 `access_token`），不把「刚才目录拉到了」当成功；
- 凭据有效性只能由 **推理** 证伪（401/403 落 `auth`）。

## 2. ⚠️⚠️ 模型 id **两种形态混排，必须原样透传**

远端实测同时下发：

- 带厂商命名空间前缀：`moonshotai/kimi-k3`、`deepseek/deepseek-v4-pro-0813`、
  `qwen/qwen3.8-max`、`z-ai/glm-5.3`、`minimax/minimax-m3.1-flash`、`qiniu/conatus-free`；
- 裸名：`deepseek-v3`、`kimi-k2`、`glm-4.5`、`qwen-turbo`、`MiniMax-M1`。

官方 FAQ Q6 要求「请求里的 `model` 必须与模型广场的 API model 参数**逐字一致**」⇒
**不得**做 `/` 拆分、大小写归一或前缀剥离。`normalizeQiniuModelId(raw)` 只做 `raw.trim()`，
存在的意义是让「不剥前缀」这条判据有一处可被单测点名的地方。

⚠️ `canonical-models.ts` 的归一化是**给聚合分组用**的，绝不能回流到发请求的 model 字段
（与 qoder 的「id 是内部代号」同族教训）。

## 3. ⚠️⚠️ 兜底模型表**必须非空** —— 置空会被 UI 误判成「已关闭」

`QINIU_FALLBACK_MODELS`（`src/qiniu-product.ts:220`）由 `QINIU_REMOTE_SNAPSHOT`
（2026-10-29 直连 `/v1/models` 的实测快照，约 30 组 `[id, context_length]`）map 而成，
`name` 直接用 `id`。

为什么不置空（曾按「官方说别写死 id」错误地置空过）：

- `listAllModels()` **冷缓存**恒为 `[]` ⇒ `provider.status` 的 `models.total` 恒 0
  ⇒ 设置页判据 `closed = total > 0 && disabled === total` 把整个 provider 显示成
  「已关闭」，且模型选择器里**一条模型都没有可关**；
- `tests/unit/refresh-targets-derived.spec.ts` ⑧ 与
  `tests/unit/model-catalog-parity.spec.ts` (j) 会直接点名。

⚠️ 「删除/归一 id」是 Q6 禁止的，「本地留一份**远端下发过**的离线快照」不违反 Q6 ——
这两件事必须分开。**远端永远优先**：`loadQiniuCatalog` 一旦拉到远端就用远端结果覆盖
（含窗口）。

⚠️ `contextWindow: 0` 是「**不知道**」哨兵，不是合法窗口 —— `resolveModel` 判 `> 0`
才下发 `context`。

## 4. ⚠️⚠️ `supportsImage` 全表 `false` = 「没实测过」，不是「都不收图」

目录**不下发模态**（无 `modalities` / `input_modalities`）。目录里确实有 VL 系
（`qwen-vl-max-2025-01-25`、`doubao-1.5-vision-pro`、`qwen3-vl-30b-a3b-thinking`、
`deepseek/deepseek-v4-flash-vision-exp`），但**七牛云侧未做读图实测** ⇒ 一律如实记
`false`。

本仓库硬约定「**声明支持就必须真支持**」（`docs/agent-notes/providers-accio.md` 那轮实测：
漏报会让模型对图片**幻觉出答案**，HTTP 200 且不报错）。实测通过后把该条改成 `true`
并**在提交信息里附取证**。

## 5. ⚠️ 思考档位不声明

七牛云官方支持 `reasoning_effort: low|medium|high`，但**目录不下发**每个模型支持哪几档
⇒ 全表不写 `efforts`（等于不声明 `reasoning`）。给一份「看起来能选、实则被上游静默忽略」
的档位列表是更糟的谎。

## 6. ⚠️⚠️ 没有余额端点 ⇒ 三处必须**同向**处理（别只改一处）

`src/provider-registry.ts:870` 的 `credits: { balance: false, dailyCheckin: false }`
是**实测结论**，不是「还没接线」：

- `src/qiniu-credits.ts` **刻意不存在**，`provider-credits.ts` 的 `creditsTable` 不登记它；
- 不进 `aggregate-expiry.ts` 的 `WIRED_EXPIRY_PROVIDERS`（无额度 ⇒ 无临期档可折算），
  并在 `tests/unit/expiry-runtime-parity.spec.ts:264` 的 `NOT_EXPIRY_WIRED` 显式登记；
- 在 `tests/unit/credits-balance-self-heal.spec.ts:702` 的 `SELF_HEAL_EXEMPT` 显式豁免
  （理由比 modelscope 更彻底：无 refresh + 无余额 ⇒ 积分端点不会为它触发自愈链）。

⚠️ 「查不到」与「没接线」的区别必须留在注释里，否则后人会把本条当成漏登记，去补一个
编造的余额读数。

⚠️ 也**不进** `src/jet-hub-rpc.ts` 的 `SELF_HEAL_REFRESHABLE_PROVIDERS`（无 refresh
端点，与 modelscope 同款，见 `src/jet-hub-rpc.ts:2565` 的注释）。

## 7. ⚠️ `rateLimit` 省略 = `true` —— 与 modelscope 的 `false` **刻意不同源**

本适配器**确实会写** `modelRateLimits`（`qiniuRetryAfterMs`），接线层也注入了
`markLimited` ⇒「重测 / 重置」两个按钮都该保留。别照抄 modelscope 的 `false`
（那是用户取舍关闭入口）。

`qiniuRetryAfterMs(kind, retryAfterMs, attempt, nowMs)`：

- `retryAfterMs` 有值时取 `min(retryAfterMs, RETRY_AFTER_CAP_MS)`；
- `kind === 'quota'` ⇒ `nextUtc8DayStartMs(nowMs) - nowMs`；
- 否则 `RATE_LIMIT_BASE_MS * 2 ** (attempt - 1)`，封顶 `RETRY_AFTER_CAP_MS`。

⚠️⚠️ **额度冷却必须对齐 UTC+8 当日 24:00，不能用固定 24h**：七牛额度规则是
「每账号**每日 250 七牛额度**、按 **UTC+8 自然日**重置；旗舰档模型
（`deepseek-v4.1-flash` / `v4-pro` 等）**每次调用固定扣 2 额度**，与 token 数无关
⇒ 一天约 125 次调用」。固定 24h 会让 23:50 撞墙的号被冷却到**次日 23:50**，而额度
次日 00:00 就恢复了 —— 白等近 24 小时（旧 fork `key-pool.ts` 用「固定 1 小时 TTL」
近似，代价是反复空试）。复用仓库既有的 `nextUtc8DayStartMs()`
（`src/model-queue.ts`，与签到/聚合同一口径）一次算准。

## 8. ⚠️⚠️ 超限（context_window）必须映射成 `CONTEXT_WINDOW_EXCEEDED_CODE`

`classifyQiniuError(status, body, headers)`（`src/qiniu-product.ts:285`）的判定
**顺序不可换**：`context_window` 最先 → `rate_limit`(429) → `quota`(402) → …

`context_window` 的 marker 全表：`maximum context length` / `context length` /
`context window` / (`context` && `limit`) / `context_length_exceeded` /
`reduce the length` / `too many tokens` / `input tokens exceed`。

⚠️⚠️ 判定顺序必须在 `rate_limit`/`quota` **之前**：超限报文里常同时出现
`too many tokens` 之类的措辞，若排在后面会被吞成限流/额度。

⚠️⚠️ **错误码映射不能走 `httpErrorCode(status)`**：七牛超限回 **HTTP 400** ⇒ 那样会落
`INVALID_REQUEST`，而宿主的 context-overflow 监听器判据是
`if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()` ⇒ **自动压缩不跑**，
用户只看到「请求无效」。修法：`context_window` → `CONTEXT_WINDOW_EXCEEDED_CODE`
（从 `@deepseek-ai/dsh-llm` 导入，与 `src/gemini-adapter.ts:888` 同修法），轮换层本就不
换号，两条口径一致。

## 9. ⚠️⚠️ Key 形状闸**不得绑死前缀**，但派生的 ref 名必须是合法标识符

`src/qiniu-rpc.ts` 的 `KEY_PATTERN = /^[A-Za-z0-9_.-]{16,}$/`
（**刻意不绑死 `sk-`**：opencode 的 IKPLRU 教训 —— 上游换签发前缀就会把新 key 全数拒绝）。

`qiniuSlotNamesOf(apiKey)`（`src/qiniu-rpc.ts:122`）：

```
tail = apiKey.slice(-8); upper = tail.toUpperCase()
refName = /^[A-Z0-9_]*$/.test(upper)
  ? `QINIU_ACCOUNT_${upper}`
  : `QINIU_ACCOUNT_${upper.replace(/[^A-Z0-9_]/g,'')}_${sha256(apiKey).slice(0,8).toUpperCase()}`
id = `qiniu-${tail.toLowerCase()}`
```

⚠️⚠️ 宿主的 `credentialRef()` 只认 `/^[A-Za-z_][A-Za-z0-9_]*$/`（`@deepseek-ai/dsh-credentials`
的 `REF_PATTERN`），而形状闸放行 `.`/`-` ⇒ 末段含这两字符的 Key 派生出
`QINIU_ACCOUNT_BBB-CCDD` 会**直接抛** `credential ref "…" must match /^[A-Za-z_][A-Za-z0-9_]*$/`
⇒ 这类 Key **一个账号都加不进来**，用户只看到一句英文正则。修法照 `src/opencode-rpc.ts:208-221`：

- 尾段本来就合法时**逐字节不变**（保护存量凭据引用，纯替换会让存量账号找不到凭据）；
- 不合法时剥非标识符字符 + 追加 Key 的 **sha256 前 8 位**（防止 `…bbb-ccdd` 与
  `…bbb_ccdd` 撞成同一 ref、后者覆盖前者凭据）。

⚠️ 前缀必须是 `QINIU`：`src/jet-hub-store.ts:1286` 的 `REF_PREFIX_TO_PROVIDER` 按它反推
provider，漏登记会让 `QINIU_ACCOUNT_*` 的账号在 `state.json` 缺失时**静默消失**
（该陷阱在本仓库已是**第六次**复发；`account.create` 生成的 ref 恒为
`${provider.toUpperCase()}_ACCOUNT_${suffix}`，两者必须对上）。

## 10. 凭据契约与 RPC 约定

- 凭据 JSON 的字段名**必须是 `access_token`**（`AccountPool` 的身份反查键，
  见 `src/account-pool.ts:1271` 的 `identifierKey`）；默认 ref 前缀
  `QINIU_ACCESS_TOKEN`（`QINIU.defaultCredentialRef`）。
- **重复 Key 必须复用同一账号**（`existed: true`）：同 Key 加两次会让用户误以为有两个
  独立额度桶，实际请求仍打到同一份额度、并在限额时一起被跳过。
- 默认昵称 `Qiniu ${apiKey.slice(-6)}`。
- ⚠️ `handleQiniuRpc` 对**不认识的方法必须返回 `undefined`**，不能回
  `{ok:false}` —— 主 switch 在 `default` 之前调用它，回信封会把别的 provider 的方法名
  误判成「格式错误」而不是「没这个方法」。
- ⚠️ `QiniuAuth` **刻意不提供 `refreshableOf`**：`isQiniuRefreshable` 恒为 `false`，
  据此回写池里的 `refreshable` 会把「账号落池时明确写 false」变成一次翻转。
- `refreshAll(pool)` **刻意不判 `entry.enabled`、不判 `entry.refreshable`**
  （后者只是凭据材料的镜像，拿它当门禁会把一次瞬时失败固化成永久状态）。

## 11. 客户端（Jet Hub 面板）

- 登录入口是**粘贴 API Key**（无浏览器、无设备码），弹窗
  `plugin-src/client/qiniu-key-modal.js`（`QiniuKeyModal` / `QiniuKeyEditModal`），
  在 `plugin-src/client/jet-hub.js:41` 引入，`:3068` 起持有独立 modal state。
- 卡片上的 Key **由宿主打码后下发**（`account.qiniuKeyMask`，源头 `maskQiniuKey`）——
  ⚠️ 客户端**不自己打码**，否则与宿主实现漂移（`plugin-src/client/jet-hub.js:970`）。
- 面板**不渲染**「余额」「签到」「重测/重置」以外的积分类按钮；「重测 / 重置」保留
  （见 §7）。
- 图标在 `plugin-src/client/provider-icons.js:346`（`qiniu: QINI_ICON`）。

> ⚠️ 2026-10-31 合并审计注：上文/本节的 `src/index.ts`、`jet-hub-rpc.ts` 行号在
> master 并入（magicrew 追加进同几张表）后整体后移过；合并冲突再动这些文件时
> 行号会再漂，判据以「键名/条目内容」为准，别按行号盲改。

## 12. 接线清单（漏一处都是静默失效）

| 位置 | 内容 |
|---|---|
| `src/provider-registry.ts:870` | 纯数据条目 `id: 'qiniu'`、`logoClass: 'qiniu'` |
| `src/index.ts:5880` | `['qiniu', qiniu]` 注册进 `registerProviderRuntime` 派生表 |
| `src/jet-hub-rpc.ts:125, 157-158, 293, 1654` | 引入 `QiniuAuth` / `QINIU` / `maskQiniuKey` / `handleQiniuRpc` |
| `src/jet-hub-store.ts:1286` | `REF_PREFIX_TO_PROVIDER` 加 `['QINIU','qiniu']` |
| `src/aggregate-adapter.ts:1338` | 聚合渠道清单含 `'qiniu'` |
| `tests/helpers/provider-sets.ts:283` | 进 `WRITES_RATE_LIMIT_PROVIDERS` 集合 |
| `src/provider-registry.ts` credits | `{ balance: false, dailyCheckin: false }`（见 §6） |

## 13. 测试锚点

| 文件 | 覆盖 |
|---|---|
| `tests/unit/qiniu-product.spec.ts` | 错误分类顺序 / `qiniuRetryAfterMs` 三格 / 兜底表非空 |
| `tests/unit/qiniu-catalog.spec.ts` | 远端优先、窗口 `0` 不下发、id 原样透传 |
| `tests/unit/qiniu-adapter.spec.ts` | `listModels`/`resolveModel`/`prepareCall`/错误码映射（含 `CONTEXT_WINDOW_EXCEEDED_CODE`） |
| `tests/unit/qiniu-rpc.spec.ts` | `qiniuSlotNamesOf` 两格 / 重复 Key 复用 / 未知方法回 `undefined` |
| `tests/unit/qiniu-messages.spec.ts` | message 归一化 |
| `tests/unit/qiniu-wiring.spec.ts` | 上面 §12 的接线点逐一断言 |
