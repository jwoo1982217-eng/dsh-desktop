# Gitee PR !117（qoder 未开通判据）审计记录

- 审计分支：`audit/pr117`（PR 提交 `a964222` + merge master `7ace87a` = `9f394af`）
- 净改动：`git diff master...HEAD` 仅两个文件
  - `src/qoder-credits.ts`（判据重写 + 删 `fetchQoderUsageRaw`）
  - `tests/unit/qoder-not-activated.spec.ts`（重写）
- 合并后基线：`pnpm test` = **9209 passed / 0 failed**（366 文件，5 skipped）
- PR 声称修复：Issue IKJSHK —— `qoder`/`qodercn` 11 个账号里 7 个**已开通**账号被误判
  「未开通每日领取」。
- 审计方式：**主审 + 对抗性审计两路 subagent 并行** + 自查端到端复现 + 隔离 worktree 变异验证。

## 一、结论摘要

| 维度 | 结论 |
|---|---|
| 是否解决 IKJSHK 的**误报** | ✅ 是。判据不再依赖 `addOnQuota`，「有 `CLAIM_BENEFIT`」一律判已开通 |
| 是否引入新问题 | ⚠️ **未修复的 P0 原样保留**（不是新引入，是**旧误报被固化并获得「抓包实证」背书**）；另有 P1×3 / P2×2 |
| 守卫网是否有牙 | ⚠️ 7/9 有牙，**1 条无牙**（`!showCampaign` 那半句）、1 条弱牙 |
| 修复是否已实施并验证 | ✅ 已在本分支实施并验证（见第五节） |

## 二、确认缺陷

### 🔴 P0-1：判「未开通」的形态与「缺 machine 头」逐项同形 —— 未修复的原误报

新判据（`src/qoder-credits.ts:172-187`）的第三态是：

```ts
if (!campaigns.showCampaign || campaigns.campaigns.length === 0) return false
return true   // 非空 + showCampaign:true + 无 CLAIM_BENEFIT ⇒ 判「未开通」
```

**但本仓三处抓包/消融记录表明「缺 machine 头」返回的正是这一形态**：

| 来源 | 记载 |
|---|---|
| `src/qoder-machine.ts:32-36` | 「仅 ClientType:'10' ⇒ showCampaign:true, claimable:false，**1 条 VIEW_DETAILS**」 |
| `src/qoder-product.ts:315` | 同一张消融表 |
| `src/qoder-credits.ts:206`（本文件内） | 同一张表又抄了一遍 |
| `docs/agent-notes/misc.md:589` | 同表：「＋MachineToken/MachineType 去掉任一个 ⇒ ❌ 退回 1 条」 |

该形态 = 非空数组 ✅ + `showCampaign:true` ✅ + 无 `CLAIM_BENEFIT` ✅ ⇒ **正好落在 `return true`**。
且 `claimableCampaigns()` 恒筛出 0 个 ⇒ 两个调用点的前置条件
`claimable.length === 0`（`:536`/`:679`）**恒满足** ⇒ 判据必被求值。

**该形态是纯插件用户的常态**：`src/qoder-machine.ts:59-61` 明确「读不到身份就
**不带这两个头、照常发请求**」，而 `qoder-machine.ts:279-282` 自己记录
exe 定位失败 / 陈旧缓存这条路 **2026-09-25 已复发过一次**。

#### ✅ 端到端复现（隔离 worktree，临时用例，审计后已删除）

把 `QODER_MACHINE_TOKEN_PATH` / `QODER_RUNTIME_INFO` 指到不存在的位置，
跑真实 `claimQoderDailyCheckin`：

```
[P1-1] 请求头是否带 machine 头 = { token: false, type: false }
[P1-1] isQoderNotActivated(缺machine头形态) = true
[P1-1] outcome = {"kind":"inactive",
  "message":"该账号尚未在 Qoder 侧开通每日领取（每日 100 Credits）。
             请先用 Qoder 官方客户端登录一次该账号，开通后再回来领取。",
  "actionRequired":true}
```

**用户可见症状**：已开通账号被提示「尚未开通，请先用官方客户端登录一次」——
而真正缺的是机器头，**装了客户端也未必拿到**（同一条复发路径 + spawn 超时），
用户按指引白跑一趟。`usage-badge.js:1515` 还会因此把 tone 转 `warn`。
影响 `qoder` 与 `qodercn` **两个渠道的全部账号**（两者 `sashClientType` 同为 `'10'`，
共用同一实现，见 `qoder-product.ts:511`/`:690`）。

#### ⚠️ 关键定性更正（主审 subagent 独立核对，采纳）

**这不是「修了 A 引入 B」**——旧判据在同一形态下**同样判 true**
（无 `CLAIM_BENEFIT` + `addOnQuota` 缺失，后者此时也确实缺失）。
所以准确说法是：**IKJSHK 的原误报从未被修复，PR 只是把它换了个写法，
并写成「刻意选择 + 标注『抓包实证』」**。

⚠️ 但**确实有一处加重**（对抗审计）：旧判据有两条腿，`addOnQuota` 存在时能救回
一部分账号；新判据**一条腿都没有**，任何只回 `VIEW_DETAILS` 的形态 **100% 误报**。

#### 反驳路径（两路 subagent 均尝试，均不成立）

| 可能的反驳 | 为何不成立 |
|---|---|
| 「文案让用户装客户端，装了就有头」 | 不成立：`qoder-machine.ts:279-282` 记着复发路径，且 spawn 超时 / GUI 环境失败；且因果说反（缺的是插件侧设备身份，不是账号侧开通） |
| 「空列表形态已被守卫覆盖」 | 不成立：实测形态**非空**，绕过了 `length === 0` 那条 |
| 「非空无 benefit 只可能是未开通账号」 | 不成立：`misc.md:589` 就是「已开通账号 + 缺 machine 头」的反例，且该表是**同账号只改头**的消融实验，证据强度高于 PR 引用的「2026-09-26 实测」 |

### 🟡 P1-1：`!showCampaign` 那条守卫**无牙**（对抗审计发现，已实测确认）

删掉 `!campaigns.showCampaign` 半句（保留 `length === 0`），PR 的 9 条断言**全绿**。
而 `parseQoderCampaigns:433` 对该字段用的是**零余量严格比较** `root.showCampaign === true`
（同文件 `readNumber`/`readString` 都容错，唯独这里不容错），且**无容错测试**。
服务端一旦改成字符串 `"true"` ⇒ 判据恒 false ⇒ 整条「未开通」提示静默失效。

### 🟡 P1-2：证据强度不对称（`src/qoder-credits.ts:154`）

表格把「含任意 `CLAIM_BENEFIT` ⇒ 已开通每日领取」列为**有抓包依据**，
但两份 fixture（`qoder-claim.spec.ts:72-124`）里的 `CLAIM_BENEFIT`
**都是每日领取那一条**（`campaignKey: 'act-20260921-308'`）。仓库无证据表明
「未开通每日领取的账号不会下发**非每日**活动的 `CLAIM_BENEFIT`」。
判据实际读的是「服务端下发过**任意**福利活动」，文案宣称的是「未开通**每日领取**」
⇒ 真未开通但服务端推了运营福利时，当天 100 Credits **静默漏领且零出路提示**。

**补强证据（审计追加 grep）**：
- ⚠️ 本仓**目前也没有能力区分**——`campaignKey` 全仓只用于填 `activityName`
  展示（`qoder-credits.ts:591`），**没有任何地方按它分流**。所以这不是
  「判据写错了」，而是「判据想表达的意思超出数据能支撑的范围」。
- 运营类活动在服务端**确实存在**（`docs/agent-notes/misc.md:639` 记着
  「实测还有 `VIEW_DETAILS` 型活动，如『Pro 首月翻倍』」）——只是现有样本里
  它们恰好是 `VIEW_DETAILS` 而非 `CLAIM_BENEFIT`，样本量不足以支撑对称外推。
- ⚠️ 收紧判据（例如按 `campaignKey` 匹配 `act-*`）**被明确否决**：需要臆造
  `campaignKey` 的生成规则，本仓无此证据 —— 那正是 PR 自己反对的
  「凭空发明线上协议」，属同类错误。

#### ✅ 处置（用户选方案 1，2026-10-18）：**如实标注，不动逻辑**

零行为变更地登记该边界：
- `isQoderNotActivated` 的判据表第一行依据栏补上「⚠️ 证据边界见下方」；
- 新增「这一格的证据强度」小节：写清「判据读的是**任意**福利、文案宣称的是
  **每日**领取」不等价、样本量的局限、本仓无分流能力、**已知漏报边界**
  （当天额度静默漏领且零出路提示）、以及 ⏳ 待真机取证项；
- 「必须与…」段补「两个方向都要读」：误报方向已由第三腿挡住，
  **漏报方向未修、待取证**；
- 代码内 `hasBenefit` 那行补同一警示；
- 测试文件头部同步登记这两处**未验证边界**（含「不要在修 bug 时顺手优化掉」的告诫）。

**刻意不做的事**：不写任何对称外推去「补偿」这处不对称 —— 那只会用同类
未验证假设替换同类未验证假设。此处适用的正是本文件自己写下的取证纪律
（「用未经验证的信号代替服务端语义，正是本缺陷反复踩坑的根源」）：
**不假装这条等价关系已被验证**。

**验证**：`git diff` 剔除注释行后**为空**（零实质代码改动）；
qoder 三个 spec **52 passed** 不变；全量 **9214 passed / 0 failed**；`tsc --noEmit` exit 0。

### 🟡 P1-3：跨文件三套口径（`VIEW_DETAILS` 的语义）

`qoder-machine.ts:32/59/196` 记为「缺 machine 头（请求头问题、且当时判成误判）」；
`qoder-credits.ts:182` 判为「未开通（账号问题）」；
`qoder-not-activated.spec.ts` 称「实测形态」但 fixture 写 `claimable:true`
（与实测 `claimable:false` 不符）。
另：`docs/agent-notes/misc.md:589-597` 至今仍把单条 `VIEW_DETAILS` 记为缺 machine 头、
未随 PR 更新 ⇒ **下一个人照着它会把 P0-1 当成设计**。
`docs/agent-notes/providers-qoder.md` 无「每日领取」一节，事故全堆在 `misc.md`。

### 🟢 P2-1：claim 路径上的死代码腿（`src/qoder-credits.ts:177`）

claim 路径进入判据需 `targets.length===0 && !claimedBefore` ⇒ 此时不可能存在
任何 `CLAIM_BENEFIT` ⇒ `hasBenefit` 在 claim 路径**恒 false**。
它�� status 路径可达且**必要**。不是缺陷，是可登记的不可达分支。

### 🟢 P2-2：严格字面量的放大机制（`src/qoder-credits.ts:177` / `:562-566`）

`actionType === 'CLAIM_BENEFIT'` 零归一（大小写变化 ⇒ `hasBenefit` 永假），
且 `claimableCampaigns()` 用**同一字面量** ⇒ claimable 恒空 ⇒ 自动落入判据分支
⇒ 全量账号被告知「去官方客户端登录」。既有硬编码，但本 PR 删掉第二条腿后
**升级为单点故障**——这个变化由本 PR 造成。

## 三、已核实无问题

- ✅ **无悬空引用**：`fetchQoderUsageRaw` 全仓零引用（含 `plugin-src/client/`）；
  `QODER_USAGE_PATH` 仍被 `src/qoder-credits.ts:319` 与 `tests/unit/qoder-credits.spec.ts:47` 使用。
- ✅ **两处调用点真同源无分叉**：`:539` 与 `:699` 同调 `isQoderNotActivated(parsed)`，
  `parsed` 同出 `loadCampaigns`（`:518`/`:666`）；前置条件也一致——
  claim 路径 `targets.length===0` 后先 `claimedBefore` 短路（`:685-693`），
  status 路径在 `todayCheckedIn`（`:534`）后才走判据。
- ✅ **`actionRequired` 契约未被触碰**：`credits.ts:92`/`:166` 语义不变；
  客户端 `usage-badge.js:850`/`:1511`、`jet-hub.js:7305` 均按 `=== true` 显式判定，
  符合「前端不靠文案猜」约定。
- ✅ **`active` 仍恒 true**（`:543`）；活动刷新时刻判据（`hasQoderCampaignRefreshedToday`）
  与 `NOT_REFRESHED_YET_HINT` 分支未被破坏。
- ✅ tsc 干净；PR 原状态下全量 9209 条单测绿。

## 四、PR 原状态的守卫网评估（变异验证，隔离 worktree）

| # | 变异 | 结果 |
|---|---|---|
| 1 | `if (!showCampaign \|\| length===0)` → `if (false)` | 🔴 3 failed |
| 2 | benefit 判据收窄为 `CLAIM_BENEFIT && CLAIMABLE` | 🔴 3 failed |
| 3 | 整个函数恒 `return false`（等价漏报退化） | 🔴 4 failed |
| 4 | 删 `!campaigns.showCampaign` 半句 | 🟢 **全绿 = 无牙**（对抗审计） |

⚠️ 另一路（对抗审计）另判 `:151` `not.toHaveProperty('actionRequired')`
只锁「键不存在」不锁「为 false」⇒ 弱牙。

## 五、修复（本分支已实施并验证）

### 修法：给判据加第三腿 ——「本次请求是否真的带上了成对 machine 头」

**关键洞察**（对抗审计提出，已验证）：这条区分信号**一直在插件自己手上** ——
`creditsHeaders` 的返回值里就有 `Cosy-MachineToken`。
所以 `qoder-credits.ts:156` 那句「与『未开通』不可区分」的能力声明**是假的**。

改动三处：

1. `loadCampaigns` 返回 `{ campaigns, machineHeadersPresent }`
   （在 `creditsHeaders` 之后立刻算，零额外请求）。
2. `isQoderNotActivated(campaigns, machineHeadersPresent = false)` 新增第二参；
   **缺头立即 `return false`**；第二参**省略时视作 false**（保守）。
3. 两个调用点（`:539` / `:699`）传入该标志；两处 `loadCampaigns` 解构处同步改。

### 修复后的守卫网

新增夹具与用例（`tests/unit/qoder-not-activated.spec.ts`，9 → 14 条）：

- `CAMPAIGNS_NO_MACHINE_HEADER`：缺 machine 头的**实测**形态（`claimable:false`，
  修正了原 fixture 与实测不符的问题）。
- `CAMPAIGNS_NONEMPTY_SHOW_FALSE`：**锁住 P1-1 那条无牙的腿**。
- `withMachineIdentity` / `withoutMachineIdentity` 夹具（同型于
  `qoder-claim.spec.ts:152`），让走真实产品函数的用例能显式控制机器头 ——
  否则测试机没装 Qoder 客户端时，「未开通」几条会因拿不到身份而被保守判 false。
- 端到端用例两条：缺头时 **claim 路径与 status 路径**都不得输出「官方客户端」指引。

### 修复验证结果

| 验证 | 结果 |
|---|---|
| qoder 相关四个 spec | ✅ **55 passed**（含新增 14 + 3） |
| 全量 `pnpm test` | ✅ **9214 passed / 0 failed**（基线 9209 + 5） |
| 变异：去掉 `if (!machineHeadersPresent) return false` | 🔴 **4 failed**（新守卫有牙） |
| 变异：删 `!campaigns.showCampaign` 半句 | 🔴 **1 failed**（P1-1 的无牙腿已补牙） |
| 变异：两处调用点传反 `machineHeadersPresent` | 🔴 **4 failed**（两条路径都被锁） |
| 「真未开通仍必须提示」未被写成漏报 | ✅ 已断言（头齐全 + `VIEW_DETAILS` ⇒ 仍置 `actionRequired:true`） |

## 六、处置建议

| # | 问题 | 级别 | 状态 |
|---|---|---|---|
| 1 | 判「未开通」形态与「缺 machine 头」同形 | **P0** | ✅ **已修**（第三腿 + 5 条新守卫，全量绿） |
| 2 | `!showCampaign` 守卫无牙（严格布尔零余量） | P1 | ✅ **已补夹具锁死**（严格性本身仍待登记） |
| 3 | 「非每日活动的 `CLAIM_BENEFIT`」证据强度不对称 | P1 | ✅ **已如实标注**（零行为变更，见第二节 P1-2 处置）；⏳ 逻辑本身待真机取证 |
| 4 | 跨文件三套口径（`VIEW_DETAILS` 语义） | P1 | ⏳ 建议：更新 `misc.md:589-597`、给 `providers-qoder.md` 补「每日领取判据」一节、往 `AGENTS.md` 登记 |
| 5 | 注释把保护腿放错位置（`:156` 称防「头不全」但真实形态非空） | P2 | ✅ 已随修复改正 |
| 6 | `actionType` 零归一 + 两条腿共用字面量 | P2 | ⏳ 建议：判据改用与 `claimableCampaigns` 同一归一化函数 |
| 7 | `hasBenefit` 在 claim 路径不可达 | P2（登记） | ⏳ 建议在注释里登记 |