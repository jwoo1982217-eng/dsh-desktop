# Gitee PR !126（aggregate 候选能力解析串行 + 失败不缓存）审计记录

- 审计分支：`pr126-aggregate`（PR 提交 `3bb0acb` + merge master `cafe269` = `429ae94`）
- 净改动（PR 自身）：`git diff b5dab83 3bb0acb` 仅两个文件
  - `src/aggregate-adapter.ts`（+334 / -33）
  - `tests/unit/aggregate-adapter.spec.ts`（+305 / -33）
- 合并后基线：`pnpm test` = **9771 passed / 1 failed**（388 文件）—— 唯一红是
  `tests/unit/jet-hub-styles-ownership.spec.ts`，它读**本机安装的宿主** `client.js`
  文本，与本 PR 无关（在 master 的干净 worktree 上**同样红**，已实测确认）。
- PR 声称修复：用户报障「聚合 provider 每轮请求到上游前白等 55–239 秒（中位 60.3s，
  68.5% 的请求 ≥55s），同模型直连另一渠道只要 0.8s」。
- 审计方式：**主审 + 对抗性审计两路 subagent 并行**（各自独立 git worktree 沙箱 +
  node_modules 目录联接）+ 主会话独立复验 + 变异验证（含红因核对）。

## 一、结论摘要

| 维度 | 结论 |
|---|---|
| 报障的根因是否成立 | ✅ 成立。`contextWindowFor` 串行 + 两处缓存「失败就不记」的组合，确实让一个持续故障的候选每轮都被重等一次 |
| 是否解决该问题 | ✅ 部分解决（修后最坏 3.0s 量级 vs 修前 8–21s/轮），但**首版只修了一半**（见 P1-1） |
| 是否引入新问题 | ⚠️ 是。**P0×1**（预算超时被读成「用户取消」⇒ 整轮失败）+ **P1×2**（`candidatesFor` 仍串行；并发无封顶/无在飞合并） |
| PR 的变异表是否可信 | ❌ **一条不成立**：「单候选预算改 60 秒 ⇒ 1 条红」实测**全绿**（见 §4） |
| 断言「偏保守」是否成立 | ❌ 方向反了（见 P2-1，已订正注释） |

## 二、确认缺陷

### 🔴 P0-1：预算到期「先 abort 再 reject」⇒ 把「我们不等了」变成「用户取消」

**位置**：`src/aggregate-adapter.ts` 的 `resolveWithBudget()`（PR 新增）。

**机制**（PR 自己的设计意图与实现相反）：

```ts
timer = setTimeout(() => {
  timedOut = true
  controller.abort()      // ← 先 abort
  reject(error)           // ← 再 reject 哨兵（name = 'AggregateCapabilityDeadline'）
}, budgetMs)
```

`controller.signal` 通过 `AbortSignal.any([signal, controller.signal])` 传给了底层
`resolveModelInfo`。真实适配器（以及 `fetch` / `undici`）在 `signal` 的 `abort` 事件里
**同步**以 `AbortError` 结算 ⇒ 该 Promise 的 race 反应**先于**哨兵入队 ⇒
`Promise.race` 以 `AbortError` 结算 ⇒ `capabilityOf` 的

```ts
if (isAbortLike(error, signal)) throw error   // 对 name==='AbortError' 无条件 true
```

把它当成「用户取消整轮请求」**原样抛出** ⇒ **整轮失败**。

**症状极具误导性**：用户没取消，但每轮都失败；而 PR 注释还写着「超时不等于取消」。

**两条独立证据**（同一结论）：

1. 常规审计 `pr126-audit-cancel.spec.ts`：
   `{"verdict":"REJECTED name=AbortError","message":"The operation was aborted","badCalls":1,"badAborted":true}`
2. 对抗审计 `adv-cancel-semantics.spec.ts`：
   `[实验1] thrown = AbortError: The operation was aborted | info.contextWindow = undefined`

**为什么首轮容易被漏**：胜负取决于**微任务跳数**。对抗审计量化：
`hops=0 → AbortError`，`hops=1..6 → AggregateCapabilityDeadline`。
即「零跳的同步结算必赢，一层 `async` 包装就输」。
⚠️ 我第一版探针用了 `async` stub ⇒ **打不中**（这正是「守卫自己可能是假绿」的又一实例）。
`dsh-llm` 真实链路是 3 层 async ⇒ 生产「恰好安全」，但**不是设计安全**。

**修法**（已实施，见 §5）：① 改成**先 reject 哨兵、再 abort**；② `catch` 里按
`timedOut` 兜底（无论谁赢 race，只要预算是我们放弃的，就折算成哨兵）。
⚠️ 两条腿**互相遮蔽**：单独回退任一条都仍全绿，只有两条一起回退才原缺陷。
故守卫用例必须在**原缺陷态**下验证（已实测：原缺陷态 ⇒ 红；修复态 ⇒ 绿）。

### 🟠 P1-1：`candidatesFor` 仍串行 —— PR 的根因分析点名了它，却没改

**位置**：`src/aggregate-adapter.ts` 的 `candidatesFor()`，PR 版本仍是

```ts
for (const candidate of ranked.slice(0, limit)) {
  const capability = await this.capabilityOf(candidate.provider, candidate.realId, signal)
  targets.push({ ... })
}
```

而 PR 的根因表格自己写着：

```
prepareCall
└─ candidatesFor
    └─ capabilityOf        ★ 又逐候选串行
```

**实测代价**（13 个候选、`capabilityTimeoutMs: 100`、两处能力缓存全清）：

| 版本 | `prepareCall` 耗时 |
|---|---|
| 串行（PR 原样） | **761 ms** |
| 并发（本次补修） | **101 ms** |

⇒ 7.5 倍差。`contextWindowFor` 已并发，但它先跑并把坏候选落进失败短缓存，
**部分遮蔽**了 `candidatesFor` 的串行；隔离测量（`contextWindowCache` 命中完整判决
+ 清两张能力缓存 + 让选型缓存过期）才暴露出来。

⚠️ 这也说明 PR 那 5 条用例里的「并发」用例（`peak === 8`）**只守了
`contextWindowFor`**：把 `candidatesFor` 留在串行，全部用例仍绿。

### 🟠 P1-2：并发化带来 `auto` 全池扇出 + 同一候选被并发重复解析

**位置**：`contextWindowFor()` 的 `Promise.all(candidates.map(...))`（PR 新增）。

两条独立的放大面：

1. **无封顶**：`auto` 的候选表是 `autoCandidates()` = **全池**（实测 1–2 百条），
   而 `candidatesFor` 那条路径有 `ranked.slice(0, limit)`（`maxAttemptsFor`，实测 14）。
   窗口路径原先**一条封顶都没有**。
2. **无在飞合并**：`capabilityCache` 在 `await` **之后**才写 ⇒ 同一拍的重复询问全部穿透。

**实测**：

| 场景 | 修前 | 修后 |
|---|---|---|
| `auto` 池 = 5 渠道 × 30 模型，单次窗口推导 | **150** 次调用 | **5** 次（封顶） |
| 4 个虚拟模型并行（每模型 3 个共享候选） | 4 个候选各被解析 **2** 次 | 重复 **0** |
| 18 渠道 × 40 模型 / 41 个虚拟模型并行 | 单候选重复 **2** 次 | **1** 次 |

⚠️ 关于「峰值 364 / 738」要**正确归因**：那主要是宿主 `buildModelCatalog` 对
**每个虚拟模型并行**调 `resolveModelInfo` 的固有形态（41 个模型各 5 条 = 205），
**不是**单个模型无封顶 —— 封顶修好后单个模型恒 `≤ maxAttemptsFor(catalog)`。
但「重复解析」是纯粹的本适配器浪费，已由在飞合并消除。

## 三、证伪的 PR 声明

### P2-1：「退化期间声明的窗口方向上偏保守」—— 方向反了

PR 注释原文：「退化期间声明的窗口是「已成功解析那部分候选的最大值」，方向上偏**保守**
（窗口偏小只是提前触发压缩；偏大才会被上游拒绝）」。

| 情形 | 声明值 | 与真实窗口比 | 后果 |
|---|---|---|---|
| 有候选解析成功 | 已成功那部分的最大值 | **≤** 真实最大值 | 保守（提前压缩）✅ |
| **全部候选都失败** | `AGGREGATE_FALLBACK_CONTEXT_WINDOW`（200_000） | 可能 **>** 真实值 | **偏大** ⇒ 压缩阈值推后 ⇒ 上游 `CONTEXT_WINDOW_EXCEEDED` ❌ |

实测：唯一候选真实窗口 131_072（128K）、解析失败 ⇒ 声明 **200_000**（大 52%）。
而同一文件的**冷帧**常量 `AGGREGATE_COLD_CONTEXT_WINDOW` = 131_072 才是真保守
⇒ 两个「保守兜底」方向相反。

⚠️ **如实标注证据强度**：这个 200_000 的取值是**既有行为**——在 master 的干净
worktree 上实测同样是 200_000，**不是本 PR 引入**。本 PR 引入的只是那句
**写错方向的注释**，已订正（见 §5）。要改取值是独立议题，本 PR 不动。

### P2-2：「失败短缓存 30 秒是安全折中：上游恢复后最迟 30 秒自动纠正」

不成立。三处后果的到期时刻**互不相同**：

| 后果 | 依据 | 实际到期 |
|---|---|---|
| `imageCapable=false` ⇒ 带图请求**硬拒**「候选渠道都不支持图片输入」 | `prepareCall` 每次现算 `targets.filter(imageCapable)` | **30s** |
| `efforts=[]` ⇒ 用户选的思考档位**静默不下发**（`reasoningEffort: undefined`） | 存在 `choiceCache` 的 `DispatchTarget` 上 | **60s**（`AGGREGATE_TTL_MS` 遮蔽） |
| `contextWindow` 走 200K 兜底 | 退化 TTL | **30s** |

实测（带图那条）：t=0 抖动一次 ⇒ t=31s 仍报「都不支持图片」⇒ t=61s 才纠正。

⚠️ **如实标注**：这条「带图误报」在 master 上**同样存在**（实测对照），
因为 `choiceCache` 的 60 秒遮蔽是既有的。本 PR 的净变化是：
把「每轮重算」换成「30 秒内复用退化值」，即**窗口期从 0 变成 30 秒**，
且被 60 秒的选型缓存放大。属**加重既有形态**，不是全新缺陷。

## 四、PR 的变异表逐条复核

| PR 声称 | 实测 | 结论 |
|---|---|---|
| 删 `capabilityFailureCache.set(key, now)` ⇒ 2 条红 | 2 条红（`candidatesFor` 路径 + 上游恢复） | ✅ 成立 |
| `contextWindowFor` 改回「全成功才记忆化」⇒ 1 条红 | 1 条红 | ✅ 成立 |
| 单候选预算改 60 秒 ⇒ 1 条红 | **全绿**（138 条 + 142 条两轮） | ❌ **不成立** |
| 失败记录 TTL 拉到 1 天 ⇒ 3 条红 | 5 条红 | ✅ 成立（更强） |
| 删成功分支的 `capabilityFailureCache.delete(key)` ⇒ 仍绿 | 仍绿 | ✅ 成立（作者自述正确） |

**「预算改 60 秒 ⇒ 1 条红」为什么不成立**：那条用例断言的是
`expect(elapsed).toBeLessThan(2_000)`，而 stub 是 `new Promise(() => {})`（永不 resolve），
真正让它 2 秒内结束的是**注入的 40ms 预算**（`capabilityTimeoutMs: 40`）。
⇒ 该断言只是「40ms < 2000ms」的**同义反复**，对**生产默认值零判别力**。
已补一条直接钉生产常量的用例（`AGGREGATE_CAPABILITY_TIMEOUT_MS === 3_000`
且 `< AGGREGATE_CATALOG_TTL_MS`），实测变异（3s→60s）⇒ 红。

## 五、已实施的修复（本分支）

| 改动 | 位置 | 守卫用例 |
|---|---|---|
| 预算到期改为**先 reject 哨兵、再 abort** + `catch` 按 `timedOut` 兜底 | `resolveWithBudget` | `★★★ 预算到期 ≠ 调用方取消`（3 条：同步 abort-reject / 微任务 / 反向对照「调用方真取消仍抛 AbortError」） |
| `candidatesFor` 串行 → `Promise.all`（**保序**：`Promise.all` 与输入同序，派发序不变） | `candidatesFor` | `★★ candidatesFor 也必须并发`（峰值 == 候选数；变异回串行 ⇒ `expected 1 to be 5`） |
| `contextWindowFor` **去重 + 封顶**（`maxAttemptsFor`，与 `candidatesFor` 同一口径） | `contextWindowFor` | `★★ 窗口推导必须去重 + 封顶`（变异去封顶 ⇒ `expected 150 to be less than or equal to 5`） |
| 新增 `capabilityInFlight` 在飞合并表（成功/失败都删，失败固化只由失败短缓存管） | `capabilityOf` | `★★ 跨虚拟模型并行不得重复解析`（变异删查表复用 ⇒ 4 个候选各 2 次） |
| 订正「偏保守」这句写反方向的注释 | 常量 + `contextWindowFor` 两处 | —（注释，无用例） |
| 补生产常量取值守卫 | — | `★★ 生产默认预算的值本身必须有守卫`（变异 3s→60s ⇒ 红） |

**验证**：
- `npx tsc -p tsconfig.json --noEmit` → 0
- `npx tsc -p tsconfig.tests.json --noEmit` → 0
- `tests/unit/aggregate-adapter.spec.ts` → **145 passed**（PR 原 138，净 +7；
  连跑 8 次全稳）
- 全量（连跑 3 次）→ `9774 passed / 1 failed`，唯一红是基线既有的
  `jet-hub-styles-ownership`（读本机宿主 `client.js` 文本，master 上同样红）。
  ⚠️ 其中 1 次全量多出一条 `raccoon-login-page.spec.ts` 的「验证码错误时不终止流程」
  —— 该文件**单跑 12 次全绿**，且在 **PR 原样（stash 掉本分支修复后）单跑 12 次
  也全绿** ⇒ 属全量并发下的**既有 flaky**，与本 PR 及本次修复无关
  （如实登记，未修）。

## 六、如实登记的无牙腿（变异全绿）

| 腿 | 变异 | 全绿说明 |
|---|---|---|
| `void pending.catch(() => {})` | 删掉 | 两路审计都**未**观测到 unhandled rejection（vitest 不报）；需构造「哨兵赢后延迟 reject」才测得出 ⇒ **未验证必要性** |
| `finally` 里二次 `abort()` | 删掉 | 纯冗余（`timedOut` 时已在 timer 内 abort 过）⇒ **防御性、无牙** |
| `timer.unref?.()` | 删掉 | 只在长驻进程优雅退出时可见，单测观测不到 |
| `budgetMs <= 0` 早退分支 | 删掉 | **零用例使用**（PR 注释称「测试里想模拟挂住时用得到」，但没有任何用例用） |
| 两个缓存「到期即 `delete`」 | 各删 | 纯内存卫生（下一次 `set` 会覆盖） |
| `capabilityCache.clear()` / `capabilityFailureCache.clear()` | 各删 | **无牙**（`contextWindowCache.clear()` 那条有牙，`m9` 红 1） |
| 完整判决的 TTL 腿 | 改成 `Infinity` | **无牙**：该腿只靠 `refreshCatalog` 的 `clear` 兜住 |
| `CAPABILITY_DEADLINE_NAME` 的**值** | 改成任意串 | **无牙**：「两个哨兵必须分开」只在「不叫 `AbortError`」上有守卫 |
| 超时分支的 `controller.abort()` 本身 | 删掉 | PR 自带用例**零覆盖**（对抗审计自写的 `sawAbortEvent` 用例能抓到） |
| 调用方 `signal` 透传 | 改成不透传 | PR 自带用例**零覆盖**（对抗审计自写用例：5013ms 才结束） |

⚠️ 上表**刻意不写成「已修」**：这些是无牙登记，不是缺陷。为它们编恒真用例是本仓库
明令禁止的形态。

## 七、未验证 / 残余风险

1. **生产可达点**：只在 stub 里实证了 P0 的机制；两路审计都**没有找到**生产代码在
   `abort` 监听里同步抛 `AbortError`。查到 5 处同步 abort 拒绝点
   （`src/model-gate.ts:190`、`src/serial-queue.ts:125`、`src/cline-oauth.ts:138`、
   `src/qoder-oauth.ts:81`、`src/zcode-captcha.ts:1130`），名字都**不是** `AbortError`
   ⇒ 当前被折算成 `resolved: false`（预期）。故 P0 属「结构上可达、生产零实测」。
2. **预算 abort 是否会污染下游目录缓存**：`src/remote-catalog-gate.ts` 的 `run()` 把
   abort 当「没拿到目录」⇒ 置 30 秒冷却；`src/astudio-adapter.ts` ⇒ 60 秒冷却。
   两处**都会**被误伤。但当前 `signal` 在骨架层被**丢弃**
   （`src/model-catalog.ts` 的 `resolveModel(provider, model, _signal)` 不使用它），
   故「半成品缓存」当前**不可达**。这条依赖是**隐式的、无守卫**
   —— 将来有人把 signal 串下去，就会把 3 秒预算变成 30/60 秒的渠道冷却。
3. **真实 13 候选池（含 autoclaw DNS/TCP ETIMEDOUT 21.6s）的端到端耗时**：
   沙箱禁止真实网络，未复现。PR 声称的 `3011 / 0 / 0 ms` 我只在桩上得到量级相符
   （`3009 / 0 / 0`），**不算独立复验**。
4. **`getAvailableAccount` 的串行**（`availableByModel`）未改动 —— PR 声称
   「实测 14 家 43 账号串行仅 11.2s，已排除」，本次未复核该数字。
