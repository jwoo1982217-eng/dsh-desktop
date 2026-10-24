# Gitee PR !111（autoclaw）审计记录

- 分支：`audit/pr-111`（PR 7969214 + 合并 origin/master 1266165，提交 75a3831）
- 合并后基线：`pnpm test` = **8927 passed / 0 failed**（359 文件），`pnpm build:all` 0 error
- 合并冲突 11 处，全部是「双方各加一个新 provider」的登记表，逐处双向保留

## ✅ 修复状态总览（2026-10-17 全部修完 + 真机取证）

**当前 HEAD**：`4c7d6a7`｜`pnpm test` = **8967 passed / 0 failed**（+40 例）
`pnpm build:all` 0 error。

### 🎯 真机取证（用户本机桌面端 + Jet Hub 真实凭据）

用户本机装有 AutoClaw2 桌面端（**未打包 asar**，`resources\app\dist\` 下源码
可直接读），且 Jet Hub 已导入真实凭据 ⇒ 此前标注「需真机」的项**大部分已坐实**，
并**查出一个新的真缺陷**。取证结果（真实网络 + 真实凭据，非推断）：

| 取证项 | 结论 | 依据 |
|---|---|---|
| appId / appKey / product | ✅ 与桌面端**逐字一致** | 穷尽扫描源码 |
| 签名算法 `md5(appId&ts&appKey)` | ✅ 一致 | 源码比对 |
| 基址 / 端点路径 / 头名 | ✅ 一致 | 源码比对 |
| 三个模型的三项能力数值 | ✅ 与远端**逐格一致** | 真实 GET |
| 思考档位三档 | ✅ 远端 `reasoningLevel: ["low","high","max"]` | 真实 GET |
| **两个端点认证头相反** | ❌ **查出真缺陷，已修** | 对照实验 |
| 非法档位值是否被拒 | ❌ **不被拒**（turbo/ultra/off 全 200） | 真实请求 |
| `zai_glm-5.3-flash` | ⚠️ **不在目录里，但实测仍可调用** | 真实请求 |
| 推理量能否区分档位 | ❌ **不能**（组内跨 16 倍、区间重叠） | 真实请求 |

#### 🔴 新查出的真缺陷：两个端点的认证头**相反**

同一 token、只换头名的对照实验：

| 端点 | `Authorization` | `X-Authorization` |
|---|---|---|
| `chat/completions`（推理） | 401 | ✅ **200** |
| `autoclaw-model-config`（目录） | ✅ **200** | 401 |

而原实现里 `probe()` 与 `fetchRemoteModelMeta()` 是**两份独立请求实现**：
一份同时发两个头、一份只发 `X-Authorization` ⇒ 分裂成
「**探活成功、真读目录 401**」。这条 401 字面读作「凭据失效」，
真因却是头名不对 —— **极难排查**（我自己第一次也被它引向「凭据过期」，
直到做对照实验才定位）。

修法：删掉冗余 `probe()`，合并为 `fetchRemoteModelMeta()` 一份实现 +
标准 `Authorization` 头 + 守卫锁住「不得改回」。请求数 2 → 1。

#### 推理量**不能**用来证明档位生效（判据踩坑记录）

`usage.completion_tokens_details.reasoning_tokens` 是权威判据
（`usage.reasoning_tokens` 恒 null），但**同档内波动跨 16 倍**：

| 档位 | 三次样本 | 中位 |
|---|---|---|
| (未发) | 1949 / 5509 / 11979 | 5509 |
| low | 3337 / 4334 / 11985 | 4334 |
| high | 9448 / 11985 / 5555 | 9448 |
| max | 609 / 8200 / 1947 | 1947 |

⇒ **组内方差 ≫ 组间差异，区间完全重叠**。任何「max 比 low 强」的结论都是
过度解读。档位是否存在，只能靠配置端点的 `reasoningLevel` 表态。

三个判据坑（已写进探针脚本头部警告后人）：
① `usage.reasoning_tokens` 恒 null；② 思考字符数同档波动 328~478、与档间同量级；
③ 耗时受题目难度/负载影响（0.7s~192s）。

#### ⚠️ `zai_glm-5.3-flash`：目录里没有，但**实测可用**

远端目录只有 3 条，**没有**它 —— 而它恰是 PR 里唯一标 `isFree: true` 的模型。
实测**直接调用仍 200 且正常回复**（`reasoning_tokens=46`，回复 `"2"`）。
⇒ **刻意保留**（唯一免费模型 + 实测可用），但在 `autoclaw-product.ts`
与本表里**如实登记这个不一致**，并写明「若将来真下线则一并删除」。
⚠️ 对照反例：`glm-5.3-flash` / `zai_glm-9.9-nonexistent` 都返回
`400 非法模型` ⇒ 上游对确实不存在的模型**会**报错，所以「200」是真信号。

| # | 问题 | 级别 | 状态 | 提交 |
|---|---|---|---|---|
| 1 | `maxOutputTokens` 写在宿主不存在的字段上被丢弃 | P0 | ✅ 已修 | `8df5796` |
| 2 | `stream()` 三处裸 `Error` 无错误码 | P0 | ✅ 已修 | `8df5796` |
| 3 | 图片能力三方矛盾（声明支持 / 一律拒图） | P0 | ✅ 已修 | `8df5796` |
| 4 | 聚合轮换三处漏接（静默陷阱第 4 次复发） | P0 | ✅ 已修 | `8df5796` |
| 5 | `max_tokens` 阈值编造 16384 + 无上限夹取 | P1 | ✅ 已修 | `8df5796` |
| 6 | `refresh_token` 空值导致推理/续期口径分裂 | P1 | ✅ 已修 | `5e4738e` |
| 7 | DPAPI 读真实凭据且无进程级隔离 | P0 | ✅ 已修 | `5e4738e` |
| 8 | `DELIMITER` 死常量 + JSDoc 说谎 | P1 | ✅ 已修（登记） | `5e4738e` |
| 9 | `listModels` 丢弃远端响应体 | P1 | ✅ 已修 | `3825574` |
| 10 | 三个隐藏 `<select>` 死 DOM | P2 | ✅ 已修 | `04af045` |
| 11 | sms 模式在 RPC 无对应分支 | P2 | ⚠️ **有意保留** | — |
| 12 | `APP_KEY` 暴露面 | P2 | ✅ **已核实一致**（见文末 B） | `2efbf71` |
| 13 | **两个端点认证头相反**（真机新查） | P0 | ✅ 已修 | `4c7d6a7` |
| 14 | `thinking_level` 非协议字段（真机新查） | P1 | ✅ 已修 | `2efbf71` |

### 关于 #11（sms 模式）：**有意保留现状**，理由如下

用户在卡片组选「手机验证码快速登录」后，RPC 无 `autoclawMode === 'sms'`
分支 ⇒ 打开的是本地服务器登录页，而该页**同时含两个入口**（一键导入 +
短信表单）。这确实与用户所选模式不符，但：

- 那条登录页是 `startAutoclawSmsLoginFlow` 的**唯一**实现，改成两条独立通路
  属于**新增功能**，不是修缺陷；
- 新增通路需要真机验证（弹窗行为、回调时序），当前无法验证 ⇒ 属于
  「无实测依据的改动」，违反本仓库红线。

⇒ 已如实登记为**待验证项**，不在本次修复范围。**两个功能都能到达**，
   只是 UX 不够精确 —— 不是「不可用」。

### 新增守卫（都已变异验证有牙）

| 守卫 | 抓什么 | 变异验证结果 |
|---|---|---|
| `expiry-runtime-parity` 不变式三 | AGGREGATE_CHANNELS 真渠道必须在折算清单里 | 删 `autoclaw` 登记 → 精确点名变红 |
| `autoclaw.spec` 图片通路 | 支持图片的模型必须真发 data URL | 令 supportsImage 恒 false → 变红 |
| `autoclaw.spec` max_tokens 上限 | 超声明上限必须被夹住 | 去掉夹取 → 变红 |
| `autoclaw.spec` 远端真读 | 远端值必须流到能力声明 | 退回只读兜底表 → 变红 |
| `autoclaw.spec` 凭据隔离 | `DSH_AUTOCLAW_APPDATA` 必须已登记 | 删登记 → 变红 |
| `new-account-dialog` 卡片组 | setter 必须接在卡片组上 | 断开 setter → 变红 |

⚠️ **不变式三补的是一个结构性盲区**：原不变式一只锁「清单 == runtime
expiry 域集合」双向一致，**抓不到**「某渠道折算压根没做」（那种漏法是
清单与 runtime **同步缺失** ⇒ 差集为空 ⇒ 全绿）。这正是本 PR 踩的形态。

---

## 以下为审计原始记录（修复前的状态，供追溯）

### 1. `maxOutputTokens` 写在了宿主不存在的字段上，被静默丢弃（P0，已修）
- `src/autoclaw-adapter.ts:152-156` 把 `maxOutputTokens` 放进 `context` 对象
- 宿主契约 `LlmModelContext` **只有** `contextWindow` 一个字段
  （`dsh-llm/lib/types/types.d.ts:316-320`）
- 宿主 `normalizeModelInfo` 白名单重建：`context: { contextWindow }`
  （`dsh-llm/lib/index.js:2124`）⇒ 该字段被丢
- 正确字段是顶层 `defaultMaxTokens`（`types.d.ts:381`；宿主 `index.js:2116` 校验、
  `index.js:2125` 保留、`index.js:2170` 在用户未指定时物化进请求）
- 后果：宿主 `info.defaultMaxTokens === undefined` ⇒ `index.js:2170` 不兜底
  ⇒ `src/autoclaw-adapter.ts:270` 的 `max_tokens` **整个字段不发**
- 违反 AGENTS.md / protocol-wire.md 明文红线「单次输出上限必须下发」
- tsc 不报错（写在对象展开里，excess property check 不作用于展开）——我实测过
- ⚠️ 仓库现有测试 `tests/unit/autoclaw.spec.ts:394`
  `expect(resolved.context?.maxOutputTokens).toBe(131072)`
  **把这个缺陷锁成了「正确行为」**：修好反而会让该用例变红

### 2. 图片能力三方矛盾（P0）
- `src/autoclaw-product.ts:59` `zai_auto-fast` 声明 `supportsImage: true`（全仓仅此 2 处命中，无探针/e2e/来源注释）
- `src/autoclaw-adapter.ts:151` `resolveModel` 按此声明 → `['text','image']`
- `src/autoclaw-adapter.ts:122` `listModels` 硬编码 `inputModalities: ['text']`（全模型一刀切）
- `src/autoclaw-adapter.ts:239-241` `stream()` **有无图片就抛裸 Error**
- 宿主按 `resolveModel` 的模态决定是否投影图片（`index.js:2311`）
  ⇒ `zai_auto-fast` 宿主不投影 → 图片原样进 `stream()` → **必然抛错**
  ⇒ 另外三个模型宿主投影成文本 → 请求能跑通
  ⇒ 同一 provider 内四个模型走两套图片通路
- 抛的是裸 `Error` 而非 `LlmError(..., 'UNSUPPORTED_CONTENT')`
  （`LlmError` 已在 `:11` import 但从未使用）⇒ 宿主归类为 `UNKNOWN`
- 全仓其余 15 家**零例外**用 `UNSUPPORTED_CONTENT`（loomy/accio/modelscope/opencode/
  buddy/qoder/zcode/cline/raccoon/gemini/lobsterai/minimax/trae 等）

### 2b. 更正：图片声明**有实测依据**，缺陷在 stream 未实现（P0）
`docs/autoclaw-models.md`（PR 自带）第 14、40-42 行明确记录 `zai_auto-fast`
「输入模态 `["text","image"]`」「唯一支持图文多模态的通道」，来源是官方
`autoclaw-model-config` / `third-party-provider-config` 实测。
⇒ **声明本身是对的**，真实缺陷是 `stream()` 没有实现图片通路。
⇒ 这条比「声明撒谎」更严重：`resolveModel` 已向宿主承诺图片能力，
宿主按承诺放行，用户贴图后必然失败。

### 2c. `max_tokens` 阈值与自家文档矛盾（P0）
`docs/autoclaw-models.md:53-56` 明写「官方网关要求 `max_tokens >= 10000`
**或完全不传递**」，而 `src/autoclaw-adapter.ts:270` 擅自抬到
`Math.max(16384, options.maxTokens)` ⇒ 用户只想输出 2000 token 时被强行发 16384
⇒ 属「编造数字」（AGENTS.md 红线）。
且与 `:346` 把**原始** `options.maxTokens` 传给 `consumeOpenAiSse` 口径分裂
（发出去 16384、按 2000 截断）。
`tests/unit/autoclaw.spec.ts:327` 的 `toBe(16384)` 把该缺陷锁成「正确行为」。


- `src/aggregate-adapter.ts:979` `'autoclaw'` 已进 `AGGREGATE_CHANNELS`
- `src/aggregate-expiry.ts:163-196` `WIRED_EXPIRY_PROVIDERS` **没有 autoclaw**
- `src/provider-expiry.ts:140-175` 的 expiry 原语表也**没有 autoclaw**
- 决定候选表可见性的是 `WIRED_EXPIRY_PROVIDERS`（`aggregate-adapter.ts:507` 等 4 处按它过滤）
  ⇒ autoclaw 折算恒 `UNUSABLE` ⇒ 聚合轮换列表里永远看不到它，**症状静默**
- 这正是 AGENTS.md 记载、**已复发三次**（cline → accio → officeace）的同一陷阱
- 客户端手抄副本 `jet-hub.js:5931` 同样不含 autoclaw（与后端一致，**这里是对的**）
- 守卫 `expiry-runtime-parity.spec.ts` 只锁「清单 == runtime expiry 域集合」双向一致，
  防不住「两层都没接」（autoclaw 恰是这种）

### 4. 思考档位
- 数组顺序 `['low','high','max']` ✅ 符合强度序（`REASONING_EFFORT_RANK`）
- `defaultEffort: 'high'` 是字面量、不是 `efforts[0]` ✅ 符合约定
- 「用户不选档就不发」在**生产中不成立**：宿主 `index.js:2180-2187` 会主动物化
  `defaultEffort` ⇒ 实际恒发 `high`，与声明自洽（我读宿主源码确认）
- ⚠️ 但 `reasoning_effort` + `thinking_level` **双发同值、零实测依据**
  （`src/autoclaw-adapter.ts:272-275`）——需真机探针判定哪个生效

### 5. 其他已确证为**正确**的接线（不是缺陷）
- 双模登录两条路径都进了 RPC：`jet-hub-rpc.ts:4138-4193`（local / sms）
- `failLogin` 三态终态已用（`:4188-4191`）
- 短信登录**先落盘凭据再回填池**（`loginWithCode` 内 `credentials.set`，
  `autoclaw-auth.ts:320-323`）⇒ 顺序正确，无「登录成功却被删号」风险
- 积分钱包 + 签到实现完整（`autoclaw-credits.ts` 全部 5 个导出函数）
- `throwIfAllRateLimited` 已接（`index.ts:2125`）
- 凭据前缀表已登记（`jet-hub-store.ts:874`）
- `SELF_HEAL_REFRESHABLE_PROVIDERS` 已登记（`jet-hub-rpc.ts` AUTOCLAW.id）
- 客户端 `PROVIDERS` 从 registry 派生 ⇒ 自动含 autoclaw
- `expires_at` 秒/毫秒归一化正确（`autoclaw.ts:78-95`，`>1e12` 防御）
- 续期双端点回退（`/userapi/v1/refresh` → `/userapi/v1/agent-refresh`）

## 测试覆盖缺口
`tests/unit/autoclaw.spec.ts` 共 32 例，**全部不过宿主边界**（直接 `adapter.stream()`）：
- 零用例断言 `inputModalities`
- 零用例触发 `stream()` 的图片抛错路径
- 零 e2e（`tests/e2e/` 下无 autoclaw 文件，`package.json` 无 `test:e2e:autoclaw`）
- `resolveModel` 只抽样 `zai_glm-5.3-flash`（唯一 `supportsImage:false` 的样本）
  ⇒ 行为不同的 `zai_auto-fast` 从未被断言
- 请求体组装用例从不传 `reasoningEffort` ⇒ 档位双发分支是死路径

## 第三份审计补充发现（已由我独立复核）

### 6. `refresh_token` 为空 ⇒ 推理正常但续期永久失败并报错误文案（P1，已可执行坐实）
- `src/autoclaw-oauth.ts:483` 登录成功时 `refresh_token: cleanRefresh ?? ''`
  ⇒ **上游不下发 refresh_token 时会产出空串凭据**
- `src/autoclaw.ts:126` `parseAutoclawCredential` 判 `!rawRefresh` ⇒ 返回 `undefined`
- `src/autoclaw-auth.ts:137-141`：`refreshAccountCredential` 先撞 `:138` 抛
  **「凭据解析失败」**，而 `:140` 那句准确的「无 refresh_token，请重新登录」
  **永远不可达**
- 推理侧却走裸 `JSON.parse`（`src/index.ts:2110`）⇒ 空串照样能用
- ⇒ 症状分裂：**发消息完全正常，点「刷新」/ 续期必然失败且文案误导**
- 我的可执行验证（未改任何源码）：
  ```
  parseAutoclawCredential({"access_token":"AT","refresh_token":""}) => undefined
  推理侧 JSON.parse 同一份 => 拿到 access_token，推理正常
  ```
- ⚠️ **更正第三份审计的一点**：`status()`（`autoclaw-auth.ts:250`）也走
  `parseAutoclawCredential`，但客户端 `plugin-src/client/**` **零调用**
  `auth.status()` ⇒ 该腿不可见，**实际可见症状只有「刷新按钮」那一条**
- autoclaw 已登记进 `SELF_HEAL_REFRESHABLE_PROVIDERS`（`jet-hub-rpc.ts:2041`）
  ⇒ 空 refresh_token 的账号在自愈链上**每次都失败**
- 对照 AGENTS.md 记载的 IKKHL5 / IKJOZ9 同型（症状逐字相同）

### 7. `stream()` 三处抛裸 `Error`，全无错误码（P0）
- `:222`（无凭据）、`:240`（图片）、`:333`（`!response.ok`）
- 文件 `:11` **import 了 `LlmError` 却从未使用**
- 后果：429 不归 `RATE_LIMIT`（**不触发换号**）、400/406 不归 `INVALID_REQUEST`、
  额度耗尽不归 `'QUOTA_EXCEEDED'`（AGENTS.md 明文红线：额度须用字面量、四处产出点缺一不可）
- ⚠️ 修正我自己的初判：我原先只标了「图片那处」，实际是**三处**全中

### 8. DPAPI 读真实 `%APPDATA%` 且无进程级测试隔离（P0，officeace 同型）
- `src/autoclaw-oauth.ts:39-42` 默认读 `process.env.APPDATA`
- `tests/setup-isolation.ts` 隔离了 `DSH_OFFICEACE_HOME`（`:83-85`）与
  `QODER_RUNTIME_INFO`（`:92-94`），**但没有 autoclaw 的对应项**
- 唯一用例显式传 `customAppData`（`tests/unit/autoclaw.spec.ts:539-544`）
  ⇒ **当前全绿是脆弱的绿**：任何新用例走「不传参读 env」就会真读用户凭据并真跑 powershell DPAPI
- 与 AGENTS.md 记载的 `.office-claw` 未隔离事故**同型**

### 9. 声称的「人设隔离分隔符」是死常量（P1）
- `AUTOCLAW_SYSTEM_PROMPT_DELIMITER`（`src/autoclaw.ts:32-33`）在 `src/` **零引用**
  （只有定义处与注释提及）
- `src/autoclaw.ts:251` 的 JSDoc 声称「通过注入 `AUTOCLAW_SYSTEM_PROMPT_DELIMITER`
  隔离前缀对 Agent 人设的侵入」，`prepareAutoclawMessages` 实现里**从未注入**
- 测试也只 import 未断言（`autoclaw.spec.ts:9`）
- ⇒ PR 描述第 2 条声称的「messages[1] 承载 Agent 原生人设」**部分不实**：
  人设确实放进了 `messages[1]`，但**没有隔离标记**，模型看到的是
  「AutoClaw 请直接简洁回答」紧接自己的完整人设，冲突风险原样存在

### 10. 目录数据是纯静态兜底表，「实测锁定」在代码里未接（P1）
- `listModels`（`:174-202`）只对 `autoclaw-model-config` 端点做 `probe()`
  ⇒ **只判 `r.ok`，响应体直接丢弃**，随后返回编译期 `fallbackModels`
- ⇒ PR 描述「官方配置端点实测锁定」的目录，在**运行时并没有真正读取远端**；
  远端新增/下线模型不会反映到列表
- （对照：`buddy` / `modelscope` 等家都真解析远端报文）

### 11. 客户端 sms 模式无对应分支（P2）
- 用户在卡片组选「手机验证码快速登录」⇒ `autoclawMode='sms'`
  ⇒ RPC 无 `==='sms'` 分支（`jet-hub-rpc.ts:4158`）⇒ 一律落进通用分支，
  打开本地服务器登录页，而该页**同时含「一键导入本机」按钮**
  ⇒ 用户选的模式与实际 UX 不符
- 且 `login.sendSms` / `login.submitSms` 的 autoclaw 分支
  （`jet-hub-rpc.ts:4508-4583`）在 `plugin-src/**` **零命中** ⇒ 死代码
  （RPC 自身注释 `:4373` 已承认）

### 12. select 改卡片组后的残留（P2，无功能回归）
- 三个 `<select>` 全部残留 `style:{display:'none'}` + `onChange` + `<option>`
  （`jet-hub.js:4039-4069`）⇒ 隐藏死 DOM
- 三家（zcode / accio / autoclaw）都被卡片组覆盖，取值与原 select 一致
  ⇒ **未见 zcode / accio 回归**

## 三份审计的交叉验证结论
| 结论 | 出处 | 我的独立复核 |
|---|---|---|
| 图片能力三方矛盾 | 三份全部命中 | ✅ 已确证 |
| `maxOutputTokens` 宿主不消费 | 两份命中 | ✅ 已读宿主源码确证 |
| 聚合轮换三处漏接 | 两份命中 | ✅ 已确证 |
| `max_tokens` 阈值编造 | 两份命中 | ✅ 已对照自家文档确证 |
| `stream()` 裸 Error | 一份命中 | ✅ 已确证，且**实为三处**（非一处） |
| refresh_token 空值分裂 | 一份命中 | ✅ 已用可执行脚本坐实 |
| DPAPI 无隔离 | 一份命中 | ✅ 已确证，并**更正**为「当前不可见但脆弱」 |
| 死常量 / sms 无分支 | 一份命中 | ✅ 已确证 |

三份审计在所有重叠结论上**无冲突**，且与我手工核查一致 ⇒ 结论可信度高。

## 需真机（真实账号 + 网络）才能定论 —— 不得当作实测
- `supportsImage: true` 的上游真实支持度（`docs/autoclaw-models.md:42` 有文档背书，但那是 PR 自带、非本仓库留证）
- `reasoning_effort` / `thinking_level` 哪个真正生效、是否互斥、非法值是否被 schema 拒
- 1048576 上下文与 131072 / 307200 / 393216 输出上限的真实值
- 不发 `max_tokens` 时网关默认输出上限是多少（决定实际截断点）
- 超声明上限发 `max_tokens` 时上游真实响应（截断 or 报错）
- 手填模型 id 时上游对 `zai_` 前缀兜底的容错
- 406 白名单拦截、签到是否真发额度
- DPAPI 本机导入路径（用户装有 AutoClaw 桌面端时）

## 审计过程纪律（如实登记）
- 三份 subagent 审计中，**第三份（功能实现度）严重超时**：两轮「立即收敛」催促均无响应，
  已 `interrupt_agent` 中止；其范围（双模登录 / 签到 / 凭据隔离）由我手工补完，
  随后它才交付报告。**该报告的三条独有发现我全部独立复核后才采纳**，
  并更正了其中一处过度声明（`status()` 那条腿客户端不可见）。
- 三份审计均受只读约束，**未做变异注入** ⇒ 每条「会红 / 不会红」的判定
  基于「断言数据源是否与被测对象同源」这一可静态判定的方法论，
  未实测执行。唯一实测动作是我自己那条不源码的 node 验证脚本。
- **修复阶段的变异注入是我自己做的**（subagent 已全部结束，工作区独占）：
  对新增/改写的 6 条守卫逐条注入变异并确认变红，见上方「新增守卫」表。
  ⚠️ 当时的理由是「工作区无法安全并行」——**该工作方式约定已于 2026-10-20 移除**；
  现行的同一条不变式改为「变异验证必须在**隔离环境**（独立 worktree）里做」，
  见 `AGENTS.md` 的「派 subagent 做**审计**的三条实测教训」。

## 未修项与理由（如实登记，不得当作已完成）

### A. `autoclawMode === 'sms'` 在 RPC 无对应分支（P2）
见上方总览 #11 —— **有意保留**：属新增功能而非修缺陷，且需真机验证。

### B. `AUTOCLAW_APP_KEY` 硬编码在源码（✅ **已核实，与桌面端一致**）

`src/autoclaw-product.ts` 明文写着 `appKey = '38d239…'`。
我一度把它登记为「暴露面未审」，那是**过度保留**；2026-10-17 已对照本机
桌面端做穷尽核查，结论如下（**实测**，非推断）。

**取证方法**（安装位置：`C:\Users\Jet\AppData\Local\Programs\AutoClaw2\`）：
应用代码**未打包成 asar**，在 `resources\app\dist\` 下 ⇒ 可直接搜索源码。

| 项 | 桌面端（`dist\main.cjs`） | 本仓库 | 结论 |
|---|---|---|---|
| appId | `"100003"` | `100003` | ✅ 一致 |
| appKey | `"38d2391985e2369a5fb8227d8e6cd5e5"` | 同 | ✅ 一致 |
| product | `"autoclaw"` | `autoclaw` | ✅ 一致 |
| 签名算法 | `md5(\`${appId}&${timestamp}&${appKey}\`).digest('hex')` | 同 | ✅ 一致 |
| 基址 | `https://autoglm-acceleration-api.zhipuai.cn` | 同 | ✅ 一致 |
| 聊天端点 | `/autoclaw-proxy/proxy/autoclaw` + `/chat/completions` | 同 | ✅ 一致 |
| 模型配置端点 | `/autoclaw-proxy/proxy/autoclaw-model-config` | 同 | ✅ 一致 |
| 请求头名 | `X-Auth-Appid` / `X-Auth-TimeStamp` / `X-Auth-Sign` / `X-Product` | 同 | ✅ 一致 |

**穷尽性核查**（不是「碰巧搜到一个」）：
- 全文 `appKey` 字面量共 **4 处**，其中 3 处属钉钉 / 飞书 OAuth 的**第三方**
  `appKey/appSecret`（`DINGTALK_OAPI`、`GET_TOKEN_URL` 上下文），
  **只有 1 处**是 AutoClaw 签名身份（`AUTOCLAW_COMPATIBLE_IDENTITY`）。
- 全文所有 **32 位十六进制串去重后仅 16 个**；其中唯一与签名配对的即上述值
  （`38d239…`，出现 1 次）。
- ⇒ **不存在第二组 appId/appKey**，PR 里的值是唯一真值。

⇒ 作者的常量**完全正确**，本仓库照抄无误，**无需改动**。

⚠️ 顺带发现一处**差异**（不是缺陷，未改）：桌面端还多发 `X-Version` /
`X-Tm` / `X-Lang` / `X-Channel` 四个头。本仓库不发它们也能工作
（原作者实测通过），故不擅自补 —— 补了属于**无实测依据的改动**。
如将来网关收紧，只需补 `X-Version` / `X-Lang` 两个即可（`X-Channel` 是
分发渠道标识、`X-Tm` 是平台标识）。

⚠️ **安全性质仍未评审**（与「值是否正确」是两个问题）：它是**客户端应用密钥**，
不是用户凭据，但「能否被第三方拿来伪造他人 `device_id` 发请求」需要专门的
安全评审。本次只核实了**一致性**，**没有**评审滥用面，如实登记。

### C. `reasoning_effort` / `thinking_level` 双发（✅ **已修**，不再是未修项）
原实现两个字段名同值下发、零实测依据。**2026-10-17 真机取证后已删掉
`thinking_level`**：
- 桌面端源码里 `thinking_level` 的 27 处命中**没有一个是上行请求体字段**
  —— 全是 SQLite 的 `work_runs.thinking_level` 列（含
  `CHECK(thinking_level IN ('off','minimal','low','medium','high','xhigh','max'))`）
  与埋点字段（`thinking_level: analyticsCode(...)`）；
- 托管网关实际只发 `reasoning_effort`（`compatibleOptions.reasoningEffort` /
  `resolvedReasoningEffort`）；
- ⇒ 保留双发的风险是「给上游不认识的字段赋值」，最坏情况是整个请求被 schema 拒。
  已加反向守卫锁住「不得复活」。

⚠️ 仍然如实的部分：**非法值不被上游拒绝**（实测 `turbo` / `ultra` / `off` 全 200）。
⇒ 我们的 `isAutoclawThinkingLevel` 门禁**仍有价值**（防止展示上游不认的档位），
但**不能**据此声称「档位强度真的生效」—— 那个结论推理量给不出来（见上方踩坑记录）。

### D. 远端响应体字段名（✅ **已由真机校正**）
`parseAutoclawRemoteModels` 的字段别名此前是**推测**的。真机 GET 确认实际形状：

```
{ "models": [ { id, name, reasoning, input: ["text"|"image"],
                 contextWindow, maxTokens, reasoningLevel: ["low","high","max"],
                 icon, iconURL, tooltip, creditConsumptionLevel, metadata } ] }
```

本仓库已按实测键名排序候选（`contextWindow` / `maxTokens` / `input` 置首），
并**照抄上游三条真实规则**（见该函数注释）：`contextWindow` 需 `>= 1e3` 且 `<= 1e7`；
`maxTokens` 需 `<= 1e6` **且 `< contextWindow`**；`input` 非数组或空则回落 `["text"]`。
兼容别名仍保留（猜不中就不采纳，代价为零）。

⚠️ **仍未接入的一项**：远端每个模型都带 `reasoningLevel` 字段，而本仓库的
档位声明目前是**编译期固定**的三档（已实测与远端逐字一致），**没有**从远端
动态读取。若上游将来给某个模型只开两档（或加 `xhigh`），我们不会跟随。
⇒ 如实登记为**已知缺口**（现状不会出错，只是不跟随远端变化）。

## 真机取证后：还需真机的项（已从 8 项缩减到 2 项）

| 项 | 状态 |
|---|---|
| 1M 上下文 / 各档输出上限真值 | ✅ **已坐实**（与兜底表逐格一致） |
| 思考档位三档是否存在 | ✅ **已坐实**（远端 `reasoningLevel` 表态） |
| `supportsImage: true` 是否可信 | ✅ **已坐实**（远端 `input: ["text","image"]`） |
| 406 白名单拦截 | ✅ **已由真实调用通过**（未触发 406） |
| 网关默认输出上限 | ⚠️ **仍未测**（未发 `max_tokens` 时的默认值未知） |
| 档位**强度**是否真的生效 | ⚠️ **仍无法定论**（推理量方差过大，见踩坑记录） |
| 签到是否真发额度 | ⚠️ **未测**（会消耗真实签到次数，未擅自触发） |
| DPAPI 导入路径 | ⚠️ 未走该路径（本轮用 Jet Hub 凭据，DPAPI 仅确认文件存在） |


