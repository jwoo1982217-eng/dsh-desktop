# fix(codearts): 续期静默死号 + 目录三处缺陷（IKQY27 / IKQ2QI 相关）

> ## ⚠️⚠️ 2026-10-28：合入 master 后的两处修订（**先读这段；下文是当时的原文，保留作历史**）
>
> master（`08548c8`）合入本分支时，原有四处修复按下面处置（提交 `82219c5` 合并、
> `f9208e3` 修缺陷）：
>
> | # | 原修法 | 现状 | 原因 |
> |---|---|---|---|
> | 1 | 「`X-NNNN` 只有在同目录存在 `X` 时才保留，否则**剥掉后缀**」（`resolveModelIds`） | ❌ **整条删除** | master 的 `3f0f48c` 已把同一缺陷（1017 被吞）修成「对外 id / `seen` 去重键 / 展示名一律用**原始** `model_id`」；且本修法依据的前提「chat 端点只认不带后缀的 id」在本仓 2026-09-23 已被实测推翻（`-0731` 回 404 的真因是**缺 `maas_type` 头**，两者是后端**两个独立注册模型**）。见 `src/llm-adapter.ts` 的 `DEFAULT_MODELS` 注释与 `tests/unit/models.spec.ts` 里那条「带版本后缀必须原样暴露」的用例 |
> | 2 | 「复用 codearts 的 `RefreshTokenExpiredError` ⇒ **九家同时受益**」 | ⚠️ **机制改写** | 各家判的是**自己那个同名类**（buddy/trae/qoder/cline/lobsterai 各自定义、gemini/minimax/accio 各带前缀），跨模块 `instanceof` **恒 false** ⇒ 另外 8 家仍按非终态处理。改为**必填参数** `makeTerminalError(message) => Error`，10 处调用点各给自己的类；漏接线在 `tsc` 就红 |
> | 3 | `STS5.1806` 归终态（`src/oauth.ts`） | ✅ 保留 | 与 master 无交集，仍是缺的 |
> | 4 | 目录表校准（`DEFAULT_MODELS` / `CONTEXT_WINDOWS` 补 `-1017`） | ✅ 保留 | master 只修了「1017 可见」，它的窗口仍落 `524_288` 具名兜底 ⇒ 分母错 2 倍 |
> | 5 | 已下架模型不再补回设置页（以 `listAllModels()` 为界） | ⚠️ **保留意图、判据加固** | master 的 `model.list` 仍无条件补回。但「拿得到 `listAllModels()`」**不等于**「拿到全量目录」——冷缓存 / 远端降级时它是**编译期兜底子集**（Issue IKJW33 实测：`cline` 冷缓存 3 条 vs 远端 460 条）⇒ 会把用户关掉的**在售**模型判成「已下架」、从设置页**彻底消失且无法重新打开**。⇒ 新增适配器自报钩子 `catalogConfirmedRemote()`，只有它能证明「远端完整读取」时才允许隐藏；其余 14 家不实现 ⇒ 行为与加判据之前逐字节一致 |
>
> ⇒ 下文提到 `resolveModelIds` / `gatewayIdMap` / 「仍须剥掉后缀」的段落**均已作废**；
> 「九家同时受益」的目标成立，但机制是**调用方注入**而不是共用某个类。
> 上述三处的完整判据、守卫与变异验证已登记进
> `docs/agent-notes/providers-codearts.md`（「目录 id 语义 / 续期终态类型 /
> 「已下架」判据」一节）。

> 分支：`fix/codearts-renew-and-catalog`（基于 `master@239a7ee`，**不含** PR !158 的 UI 修复）
> 提交：4 个 · 12 文件 · +567 / −38

## ⚠️ 与另外两个 PR 的关系（先读这段）

| PR | 范围 | 本分支的关系 |
|---|---|---|
| **!156** `fix/benefit-header-truth`（IKQ2QI） | benefit 头判据改为**只认远端** `gateway/config`，删除静态兜底表 | **判据一行未改**（详见下节） |
| **!158** `fix/credit-row-overlap-copy` | 设置页积分行越界重叠、锁定文案 | **零文件重叠**，可各自独立合并 |

### 与 !156 的边界（重要）

!156 要**删除** `CODEARTS_BENEFIT_FALLBACK` 与 `isCodeArtsBenefitModel`，把唯一权威改为
远端 `gateway/config`。**本 PR 刻意不碰这两者**——它们在本分支里仍是
`['glm-5.3-flash', 'deepseek-v4.1-flash']` 原样：

```ts
// src/models.ts:52 —— 本分支未改动
export const CODEARTS_BENEFIT_FALLBACK: readonly string[] = ['glm-5.3-flash', 'deepseek-v4.1-flash']
```

**但有一处必须说明的耦合**：`fetchCodeArtsRemoteModels` 里记录 benefit 集合的那一行，
本 PR 因 `resolveModelIds` 的引入而改写了**引用方式**（不是判据本身）：

```diff
- if (rawId.length > 0 && normalizeModelId(rawId) === rawId) benefitIds.push(mi.id)
+ if (rawId.length > 0 && gatewayIdMap.get(rawId) === rawId) benefitIds.push(mi.id)
```

**语义完全等价**（都表达「这个 id 没有被剥过后缀」），只是归一化结果改为从裁决表取。
若 !156 先合并、删掉了 `CODEARTS_BENEFIT_FALLBACK`，本行不受影响；
若本 PR 先合并，!156 在该处的改动也只需调整这一行。**两边都不会互相阻塞。**

> 建议合并顺序：**!156 先、本 PR 后**（!156 删除的东西本 PR 不依赖）。
> 反过来也能合，只是 !156 需在 `gatewayIdMap` 那行上重做一次 rebase。

---

## 1. 续期「兑换成功但落盘失败」⇒ 静默死号（最严重）

### 现象

codearts 账号用着用着突然报 `HTTP 400 APIG.0602 the security token has expired`，
而 `refresh_token` 明明还有 30 天寿命。面板此前一直显示「自动续期」正常。

### 根因

`src/expiry-sync.ts` 的 `refreshAccountWithReconcile`：

```ts
const refreshed = await refresh(credential)   // ① 服务端已消耗一次性 token 并签发新的
await save(refreshed)                          // ② 若这里失败 → 新凭据只剩内存引用，随栈消失
```

旧实现让 ② 的异常**直接冒泡**，调用方（各家 `refreshAll` 的 catch）把它当**非终态**：

- 只记一条 warn；
- **不**标 `refreshable:false`；
- 下一轮继续拿同一份**已被消耗**的 token 去兑换 ⇒ 服务端如实回
  `STS5.1806 the refresh token has been used`；
- 日志被 `terminalWarned` 去重、面板照常显示「自动续期」。

### 实测时间线（2026-10-27，本机两个账号，当天同一形态发生两次）

```
16:58:33  第 4 轮续期成功，凭据落盘（rt_iat=16:58:19）
17:58     第 5 轮：兑换成功，但 .credentials.yaml 零写入   ← 关键
18:23:48  DSH 写 state.json，此时 refreshable 已为 false
18:30     实测续期 → 400 STS5.1806（token 已被消耗）
```

⚠️ 上一版加的「判终态前重读凭据」防护**救不了它**：磁盘上的 `refresh_token` 与刚用过的那份
**完全相同**（因为没写进去），`latest !== credential` 条件不成立，直接落到标死分支。

### 修法

`save()` 失败时抛 `RefreshTokenExpiredError`（终态）：

- 语义正确：服务端票据已消耗、新凭据丢失、重试无意义；
- 复用各家已在用的同一错误类，**九家 provider 同时受益**（`providers-officeace.md`
  里同样记着「先到者写盘前被打断 ⇒ 新 token 永久丢失」）；
- 抛终态**之前**单独记一条 warn，文案明确区分「落盘失败」与「服务端拒绝」——
  实测当时日志只剩「续期失败：<存储错误>」一条，与服务端拒绝同形，定位多花了几十分钟。

### 未解决（如实登记）

`save()` **为什么**会失败尚未定位（宿主进程中断/退出、存储层异常皆有可能）。
本 PR 修的是**失败后的处置**，把它从「静默死号」变成「当场报需重新登录」。
若再次发生，新加的 warn 会带出存储层原始错误，可据此继续定位。

---

## 2. `STS5.1806` 未归终态（与 1 的连带缺陷）

`src/oauth.ts` 的 `requestToken` 原先只把 `invalid_grant` / `ExpiredRefreshToken`
归终态，`STS5.1806`（一次性 token 已被使用）落到普通 `Error`。后果与 1 叠加：

- `refreshAll` 走非终态分支 ⇒ 不写 `refreshable:false`；
- 另一条终态判据要求「本地 `refresh_token.exp` 已过」，而该账号 exp 还剩 29 天 ⇒ 不成立；
- ⇒ 池内 `refreshable` 永远停在 `true`，面板照常「自动续期」，实际每 30 分钟静默失败。

现归终态。`error_code` 与 `error_msg` 两条腿各一条用例锁住，且**两条腿的报文字段
刻意互不重叠**——首版把真实报文同时喂给两条腿，变异验证时删掉 `error_code` 腿测试仍全绿
（msg 兜底完全遮盖），已按组合变异修正。

---

## 3. issue IKQY27：`deepseek-v4.1-flash-1017` 在模型列表里不出现

### 根因

`normalizeModelId` 无条件剥掉末尾 `-NNNN`，于是 `deepseek-v4.1-flash-1017` 被改写成
`deepseek-v4.1-flash`、撞 id 后被 `seen` 去重丢弃 ⇒ 选择器里 1017 一条都不出现且零提示。

### 判据

上游实测：两条 `display_enabled` 均为 true，网页端是**两个独立可点选项**，且两条真实请求
分别回显各自 id（伪造 id 报「未找到模型」）⇒ 后端注册为独立模型，权重版本与排队池都不同。

改为看**整个目录**：`X-1017` 只有在同目录里存在 `X` 时才保留，否则按旧规则剥掉
（`gateway/config` 只下发 `deepseek-v4-flash-0731` 时仍须剥，否则 chat 端点
`404 not registered`）。归一化拆成 `modelIdSuffixCandidate`（只算候选）与
`resolveModelIds`（拿全目录后裁决），两个来源各算一张表。

> ⚠️ name 的归一化跟着 id 走：首版对 name 独立再算一次，导致 id 保留 `-1017` 而 name 被剥
> （被新增用例抓出，已修）。

---

## 4. 目录两张表校准（真机逐条实测）

### `DEFAULT_MODELS`：9 条里 3 条已失效、4 条上游新模型缺席

| 条目 | 不带 maas_type 实测 | 处置 |
|---|---|---|
| `GLM-5.2` / `GLM-5.1` | 200 | 保留 |
| `GLM-5` | 404 `InferHub.002002009` | **删除** |
| `glm-5.3-flash` | 404 `InferHub.002002009` | **删除** |
| `openpangu-2.0-flash` / `-pro` | 200 | 保留 |
| `deepseek-v4-flash` | 200 | 保留 |
| `deepseek-v4-pro` | 404 `ModelArts.81009 Invalid model` | **删除** |
| `glm-5.3` / `glm-5.2-sft-harmony` | 200 | **新增** |
| `deepseek-v4.1-flash-1017` | 200 | **新增**（IKQY27） |
| `kimi-k3` | 200 | **新增** |

⚠️ 判据是「**真机能不能调通**」，不是「在不在 `/v1/model/builtin` 目录里」：
`GLM-5.1` 与 `deepseek-v4-flash` 都不在目录里，但实测 200 ⇒ 保留。按目录比对删掉会让用户
少两个可用模型（`dead-model-store.ts` 头注释那条「不从残缺目录反推」铁律）。

### `CONTEXT_WINDOWS`：补 `deepseek-v4.1-flash-1017` = `1_048_576`

与老版窗口一致（用户确认）。不补会走 `524_288` 具名兜底 ⇒ 分母错 2 倍、压缩阈值偏早
（正是 `CODEARTS_FALLBACK_CONTEXT_WINDOW` 记录过的报障形态）。

---

## 5. 已下架模型不得再补回设置页

`model.list` 原先无条件把黑名单条目推回设置页 ⇒ 上游已下架、但用户曾关掉过的模型**永久留在
列表里**：灰显、开关能动，点开必然 404（实测 `GLM-5` / `glm-5.3-flash`）。

改为补回时以**全量目录**为界。⚠️ 判据必须用 `listAllModels()`，**不能用 `llm.listModels()`**——
后者已被适配器按黑名单过滤，拿它当「在售集合」会把**每一个被用户关掉的在售模型**都判成已下架
⇒ 集体从设置页消失、无法重新打开（那正是本端点当初要修的缺陷）。**第一版就搞错了，被 7 条
既有用例当场打红**，改用 `listAllModels()` 后全绿。

---

## 验证

- 全量 `npx vitest run`：**452 文件 / 11014 用例全绿**（2 skipped 为既有环境跳过）
- `npx tsc --noEmit -p tsconfig.json`：0 错误
- `npx tsc --noEmit -p tsconfig.tests.json`：0 错误
- **双向变异验证**（确认新用例有牙）：
  - STS5.1806：删 `error_code` 腿 → 对应用例红；删 msg 腿 → 另一条红；
  - `resolveModelIds`：退回「无条件剥后缀」→ 1 条红；改成「永不剥」→ 3 条红；
  - `save()` 失败：退回「直接冒泡」→ 精确 1 条红。
- **真机回放**：用 issue 报文跑 `fetchCodeArtsRemoteModels`，11 条模型里
  `deepseek-v4.1-flash` 与 `deepseek-v4.1-flash-1017` 同时存在，`deepseek-v4-flash-0731`
  正确剥成 `deepseek-v4-flash`。

## 与 !158 的独立性

本分支基于 `master@239a7ee`（即 !158 的父提交），**不含** !158 的任何文件改动：

```
本分支改动：src/{models,oauth,llm-adapter,jet-hub-rpc,expiry-sync}.ts + 对应测试 + docs
!158 改动 ：plugin-src/client/*.js + credit-* 测试 + .gitignore
交集       ：无
```

⇒ 两个 PR 可**各自独立合并**，互不依赖。
