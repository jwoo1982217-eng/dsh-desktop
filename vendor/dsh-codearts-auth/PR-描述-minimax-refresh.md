# PR：MiniMax 续期机制重构 —— 定时批量轮换改为「按需 + 60s 错峰巡检」

架构性改动，一个提交，修的是「**一失效就是一大片**」这个系统性形态：

```
feat(minimax): 续期机制重构 —— 定时批量轮换改为按需 + 60s 错峰巡检（修「一失效就是一大片」）
```

> ⚠️ 本 PR **刻意不含**登录流程改动、**不含**身份/昵称逻辑改动（继续用上游的
> `inheritMinimaxIdentity`）、**不含**其他 provider 改动。
>
> 行号说明：标 `[旧形态]` 的按 `origin/master`，其余按**本 PR 分支**。

---

## 一、缺陷现象

> 「凭据经常过期失效，**一失效就是一大片**，每次都要一个个点回来」

三个要点，缺一不可：

1. **经常** —— 不是偶发；
2. **一大片**（不是一条）—— 全池在**同一时刻**一起失效，说明它们共享同一个时间判据；
3. **要一个个点回来** —— 失效的账号**无法自动恢复**，`refresh_token` 已经烧掉了。

第 2 点是最关键的信号：独立账号的凭据寿命本应互相独立，**同时失效只有一个解释 —— 它们的
过期时刻被同一段代码焊在了一起**。

## 二、根因（旧形态：三条腿互相咬合）

### ① 30min tick × 1h 提前量 × 1h 寿命 ⇒ 每个 tick 都命中刷新窗口

```
src/index.ts:4354          const REFRESH_INTERVAL_MS = 30 * 60 * 1000
src/refresh.ts:2           export const REFRESH_LEAD_MS = 3_600_000      // 1h 提前量
access_token TTL           ≈ 1h（上游下发）
```

`refreshAccountWithReconcile` 的判据是「距过期不足 `REFRESH_LEAD_MS` 就刷」。
**1h 提前量 ≥ 1h 寿命 ⇒ 窗口恒大于寿命**，于是**每一个 tick、每一个可续期账号都触发一次 grant**：

> **≈ 48 次轮换/天/账号**（30min tick 一天 48 次，次次命中）。

`[旧形态]` 的落点：`src/minimax-auth.ts:433` 的 `refreshAll` 逐账号调
`refreshAccountWithReconcile`（`:450`）→ `refreshCredentialFor`（`:458`）**真发 grant**。

### ② 循环顺序执行 ⇒ 全池的过期时刻焊死在同一秒窗

`for (const entry of accounts)` 逐条续期，每次续期成功后 `expiresAt = now + TTL`。
后一个账号的 `now` 只比前一个晚几十毫秒 ⇒ **全池的过期时刻落在同一秒区间内**。

**本机实测（5 个账号）**：`expiresAt` 落点相差 **3 秒**。

⇒ 这是一个**同步失效域**：一次系统性失败（断网 / 上游抖动 / 关机跨窗）**必然全池同时报废**。
用户看到的「一大片」，就是这条顺序循环的几何后果。

### ③ refresh_token 单次有效 + 每次轮换 ⇒ 一次响应丢失 = 一个账号报废

上游的 `refresh_token` 是**一次性**的（每次 grant 轮换一把新的）。
「48 次/天」不是为了刷新 —— 那是 **48 次/天的丢包风险**：
grant 已经在上游生效、而响应在回程丢了（断网/超时/宿主被关），
本地手里那把 RT 就是**死票** ⇒ 账号报废，只能重新登录。

⇒ 第 ① 条把轮换频率推到理论上限，第 ③ 条让每一次轮换都是不可逆的赌注，
两条叠加就是「经常失效 + 要一个个点回来」。

## 三、设计依据：官方实现本来就是**按需**制

这不是「换一种写法试试」，而是**回到上游的形态**：

- 官方开源 CLI `MiniMax-AI/minimax-code` 的 `packages/oauth-core`：
  `getAccessToken({ minValidityMs: 30_000 })` —— **纯按需刷新，全仓库没有定时轮换器**；
- 定时批量轮换是**本插件自己加的**（而且加在一个一次性 RT 的协议上）。

⇒ 本 PR 的分工：**轮换交给「需要的时候」和「临死之前」，定时器只负责对账与巡检。**

## 四、修法（逐条）

### 4.1 `refreshAll` 改为**只对账**，不再发 grant

`src/minimax-auth.ts:538`：循环体里原来的 `refreshAccountWithReconcile` 换成
`syncAccountExpiry`（`:555`）—— 把凭据里的真实 `expiresAt` **镜像回账号池**（UI 读池值），
保持「凭据被别处更新过而索引没跟上」的自愈能力，但**不再写凭据**。

保留的纪律：只按 `refreshable` 过滤、不看 `enabled`；凭据缺失/损坏仍标 `refreshable:false`；
单账号失败不拖住其余。

### 4.2 新增 `MinimaxAuth.startRenewPatrol()`：60s 巡检 + 按账号散列错峰

`src/minimax-auth.ts:832`，接线在 `src/index.ts:4349-4350`（**两站各一条**）：

| 常量 | 值 | 出处 |
|---|---|---|
| `MINIMAX_RENEW_PATROL_INTERVAL_MS` | 60s | `src/minimax-auth.ts:128` |
| `MINIMAX_RENEW_MARGIN_MS` | 5min | `src/minimax-auth.ts:124` |
| `MINIMAX_RENEW_JITTER_SPAN_MS` | 0–10min（**按账号 djb2 散列**） | `:126` + `renewJitterMs`（`:140`） |

- **为什么散列而不是随机**：`renewJitterMs(accountId, span)` 是账号 id 的确定性函数
  ⇒ 「错峰」不会退化成「洗牌」；同一个账号每次算出的抖动相同，**续期时刻稳定可预期**。
- margin 5min + 抖动 0–10min ⇒ 每个账号的续期时刻**天然错开**，
  全池再也不共享一个秒窗（第 ② 条根因被结构性拆除）。
- 幂等（重复调用不叠加定时器）、**立即先跑一轮**（宿主重启后不该等满 60s）、
  `unref()`（`:870`，不阻止进程退出）。

### 4.3 请求前预判：`isMinimaxExpiringWithin(credential, 60_000)`

`src/minimax.ts:179` 新增，替换适配器里的 `isMinimaxExpired`：

```
[旧形态] src/minimax-adapter.ts:687   isMinimaxExpired(credential)              // 已过期才续
[新形态] src/minimax-adapter.ts:701   isMinimaxExpiringWithin(credential, 60_000)
```

语义与官方 `minValidityMs` 一致：**临死前就换**，而不是让用户的请求撞在正在死掉的 token 上。
60s 取官方 30s 的两倍宽（一次 grant 实测 ~300ms，够覆盖慢网下的整轮续期）。
常量在 `src/minimax-adapter.ts:78`（`MINIMAX_ONDEMAND_MIN_VALIDITY_MS`）。

### 4.4 401 精准续期：续「上次选中的那个账号」，而不是「池内第一个可用账号」

`src/index.ts:3107` 记 `lastPickedMinimaxAccount`（在 `resolveCredential` 的
`reportAccount` 回调里赋值，`:3116`），401 时优先续**它**；找不到才退
`getAvailableAccount`。国际版同形。

理由：选号与 401 之间隔着一整轮请求，池序没变但账号状态可能变了 ——
旧写法续的可能是另一个号，用户的请求仍然 401。

### 4.5 轮换纪律（把「一次性 RT」当不可逆操作对待）

| 纪律 | 落点 | 解决什么 |
|---|---|---|
| **单飞闸门** `renewInFlight` | `:233` / `:490` / `:718-729` | 巡检 / 请求路径 / 401 强刷**共用一把锁** ⇒ 同一个 RT 不会被并发轮换两次（第二次必然 `invalid_grant`） |
| **非终态失败同 RT 重试一次**（隔 1.5s） | `MINIMAX_RENEW_RETRY_DELAY_MS`（`:130`） | 抖动/5xx 不该消耗一把新票 |
| **终态失败回退历史代际 RT**（新→旧 3 把） | `previous_refresh_tokens`（`:132`）+ `grantWithSalvage`（`:665`） | 断链抢救：万一某次 grant 响应丢了，还有上一代可以试 |
| **CAS 落盘** | `renewEntryInner` 里的重读比对（`:760-773`） | grant 期间凭据被别人（登录 / RPC 续期）写过 ⇒ **丢弃本次结果**，绝不覆盖更新的会话 |
| **`refresh-journal.jsonl` 全量留痕** | `src/minimax-refresh-journal.ts`（新文件） | 「换钥匙」这种高危操作此前既不知道频率也不知道死因 |

journal 形态：JSONL 一行一条（`appendFile` 按行原子）、**fire-and-forget**（磁盘错误静默，
观测设施绝不反噬续期主路径）、>5MB 轮转 `.old`、**未注入 `journalHome` 则不写盘**
（否则单测会把日志写进用户真实的 `~/.dsh`）。触发源分四类：
`patrol` / `ondemand` / `forced` / `recover`。

### 4.6 与上游 `inheritMinimaxIdentity` 的配合

续期响应只带**令牌五件套**；`nickname` / `user_id` / `previous_refresh_tokens`
等非令牌字段由上游的 `inheritMinimaxIdentity` 继承。
**本 PR 保持上游那套实现不动**（此前本地试验版曾自己改过身份逻辑，已回退）。

## 五、实测效果（本机 9 小时）

| 指标 | 旧形态 | 新形态（实测） |
|---|---|---|
| 巡检续期次数 | — | **37 次，全部成功** |
| `invalid_grant` | 每次丢包必然产生 | **0 次** |
| 各账号续期时刻 | 同一秒窗内（相差 3s） | **00:00 / 00:10 / 00:17 / 00:35 / 00:50**（彼此错开） |
| 轮换频率 | ≈48 次/天/账号 | ≈24–32 次/天/账号，且**不同账号不同刻** |

最后一行是本 PR 的核心验收点：**「一大片」这个形态在结构上不可能再出现**。

## 六、验证

- `pnpm test`：**10926 passed / 0 failed**（含本 PR 新增用例）；
  `tsc` 0 错误；`pnpm run build:all` exit 0。
- `tests/unit/minimax-auth.spec.ts` 新增 **8 条** `renewEntry` 用例，覆盖 **6 类能力**：

| # | 用例 | 守的能力 |
|---|---|---|
| 1 | 按条目自身 `credentialRef` 对账，**但不写凭据** | reconcile-only |
| 2 | 凭据已过期也**不发请求** | reconcile-only（轮换权已移交巡检） |
| 3 | 剩余远超 margin ⇒ 不发请求 | margin（轮换次数是风险预算） |
| 4 | 已过期 ⇒ 发 grant、写回**自己的 ref**、池镜像更新、旧 RT 压栈 | margin + 落盘 |
| 5 | 同 ref 并发只发**一份** grant | 单飞 |
| 6 | grant 期间凭据被改写 ⇒ **丢弃结果** | CAS |
| 7 | 当前 RT 终态 → 回退历史代际 RT 成功 ⇒ 救回 | 旧 RT 抢救 |
| 8 | 终态全失败 ⇒ 抛终态错误 + 池标 `refreshable:false` | 终态标记 |

- 另有 `tests/unit/minimax-identity-inherit.spec.ts` / `minimax-proxy.spec.ts` /
  `minimax-rpc.spec.ts` / `minimax-adapter.spec.ts` 的增量调整（跟随新判据）。

## 七、⚠️ 明确**不做**的事（审阅请重点看这节）

- **不改登录流程**：`startLogin` / `persistLogin` / 设备码链路**一行没动**。
- **不改身份/昵称逻辑**：继续用上游 `inheritMinimaxIdentity`；
  本分支**没有**自己那套身份改写（那是本地试验版，已回退）。
- **不动其他 provider**：`src/index.ts` 的改动只在 minimax / minimaxintl 两站
  与其专属巡检接线，其余 15 家一行没碰。
- **不动全局调度器**：`REFRESH_INTERVAL_MS` 仍是 30min（十三家共用，为一家改粒度会波及全部）。
  MiniMax 只是**不再需要**它来轮换 —— 它现在只对账。
- **不做 UI 改动**：不新增按钮、不改面板（`refresh-journal.jsonl` 只是落盘事实来源）。

## 八、诚实边界（如实登记）

1. **`previous_refresh_tokens` 抢救是实验特性**：上游究竟是「只作废被用的那条」还是
   「作废该客户端所有 RT」**未证实**。若是后者，抢救链不过是多花几次注定失败的请求
   —— **没有新增风险**（本来也是要失败的），但它不是保证。
2. **断言不了「永不并发」**：单飞闸门是**进程内**的。多进程/多 profile 同时操作同一份凭据
   仍可能撞车，那一层靠 CAS 兜（丢弃落后结果），不是靠锁。
3. **巡检的准确性依赖宿主 clock**：`Date.now()` 跳变（休眠唤醒/手工改时间）会让 margin
   判据短暂失准；请求前的 60s 预判是这一格的兜底。

## 九、涉及文件

| 文件 | 变化 |
|---|---|
| `src/minimax-auth.ts` | **+448**：`refreshAll` 改对账、`renewEntry`/`renewEntryInner`、`grantWithSalvage`、`startRenewPatrol`、单飞/CAS/抖动 |
| `src/minimax-refresh-journal.ts` | **新文件 +74**：JSONL 留痕（fire-and-forget、5MB 轮转、未注入不写盘） |
| `src/minimax.ts` | **+39**：`isMinimaxExpiringWithin`（保留 `isMinimaxExpired`） |
| `src/index.ts` | **±76**：两站 `journalHome`、`lastPickedMinimaxAccount` 精准续期、两站巡检接线 |
| `src/minimax-adapter.ts` | **±18**：请求前预判改用 `isMinimaxExpiringWithin`（60s） |
| `tests/unit/minimax-*.spec.ts` | **+244/-28**：8 条新用例 + 四个文件的判据跟随 |
| `package.json` | **1 行**：版本号 |

> ⚠️ **提 PR 前需处理**：本分支的 `package.json` 版本是 `0.2.1-rc.2-jet1`
> （本地试验期后缀），且分支上的提交信息是**本地 WIP 描述**
> （`local(jet1): minimax refresh redesign … rebased onto upstream …`）。
> 正式提交前建议：版本号回 `0.2.1-rc.2`（或按发布计划）、提交信息改用本文标题。
> 这两件都**不在本 PR 的代码范围内**，故不动。

## 十、审阅建议顺序

1. `src/minimax-auth.ts` 的 `refreshAll`（`:538`）—— 确认它**真的不再发 grant**（这是拆除「一大片」的前提）；
2. `startRenewPatrol`（`:832`）+ `renewJitterMs`（`:140`）—— 错峰判据是否按账号确定、是否幂等、是否 `unref`；
3. `renewEntry` 的三道纪律：单飞（`:718`）、CAS（`:760`）、抢救（`:665`）——
   尤其 **CAS 的「丢弃结果」** 是不是真的比「覆盖」安全（我认为是，但这是取舍）；
4. `src/index.ts:3116` 的「精准续期」是否比旧的「池内第一个可用账号」更合理；
5. 第六节「明确不做的事」与第八节「诚实边界」是否与你的预期一致。