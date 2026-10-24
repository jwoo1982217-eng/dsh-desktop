# AutoClaw（智谱清言桌面端）provider 笔记

## 积分余额与「逐批次到期」（PR 115，2026-10-17 两轮独立审计 + 变异验证）

### ⚠️⚠️⚠️ P0：**流水的 `amount` 是「历史发放额」，不是「该批次剩余额」**

PR 115 用 `/agent-assetmgr/api/v1/ledgers_std` 的流水给每个积分包补
`deductionEndTime`，实现里把每笔 `credit` 的 `amount` **直接当 `remaining` 求和**。

**流水是历史账变**：一笔 `credit` 记的是「某时刻发放了 N 分」，此后消耗走独立的
`debit` 行，而**上游没有下发任何「该批次已消耗多少」的字段**
⇒ 拿 `amount` 当剩余额 = **拿发放上限当余额**。

⇒ **用户一旦消耗过积分，批次和就 ≠ `total_balance`**，守恒校验恒不成立 ⇒
永远回退钱包包 ⇒ **逐批次分档（含红色「临期」+ 倒计时）永不出现**，
表现为「**刚登录那会儿对、用一段时间后静默失效**」，无报错、无日志。

**必须逐格对照 `src/trae-credits.ts:378`** —— 那边是同款「条目级到期」问题，
但服务端给了 `quota.credits_limit`（上限）**与** `usage.credits_amount`（已用）
**两腿**，所以能折算 `remaining = creditsLimit - used`。
⚠️ **教训可推广：「同款问题」只共享问题形状，不共享解法是否成立**。
照抄别家的判据前先确认**它依赖的那条腿在你家也在**。

✅ 当前取舍：守恒校验当**安全网**（不守恒就回退钱包包，绝不给错数）。
⚠️ **未解决**：要让「消耗后仍能正确分档」，必须由上游下发批次剩余
（`wallet_remaining` 之类）。**在那之前不得声称本渠道已支持按批次分档**，
registry 的 `usesExpiryWindow: true` 只是「把 `windowDays` 回传下去」的**能力开关**。

⚠️ **取证不可复核**：PR 注释引用的 `scripts/probe-autoclaw-expiry.mjs`
**在本仓库不存在**（只有 `probe-autoclaw-reasoning.mjs` / `probe-autoclaw-vision.mjs`）；
`docs/audit/pr111-autoclaw-audit.md` 亦明确记载钱包接口 `wallets[]`
**没有任何时间字段**。⇒ 那句「实测 28/28 全带值、守恒 20700」**不得当作实测证据**。

### ⚠️ `display` 必须按官方口径**严格**判断（这是原报障的根）

用户报障「红色每日 0」的真正修复点在**过滤判据**，不在批次包。

| 写法 | 缺 `display` 字段时 | 后果 |
|---|---|---|
| `typeof cast.display === 'boolean' ? cast.display : true` | **fail-open，判为可见** | 「每日积分」池原样回归 ⇒ **原症状逐字复现** |
| `cast.display === true`（官方 `main.cjs readWallets`） | 判为不可见 | ✅ |

⚠️ 实测钱包响应里**每个池都带 `display`**，严格判断不会误伤真实数据；
但**不能**反过来「宽松更安全」—— 宽松正好放回 bug。

### ⚠️ 批次包名**不得**命中「当日池」名单（否则整段三档被短路）

`plugin-src/client/credit-expiry.js` 的 `DAILY_POOL_NAMES = ['每日赠送','每日积分']`
是**精确相等**匹配，而 `plugin-src/client/usage-badge.js:1459-1463` 是**先判先 return**：
`formatPoolSplitLine(...)` 非 null 就单段返回，**根本走不到**
`splitCreditsByExpiry` 的三档 + 倒计时。

⇒ 上游只要下发一条描述为「每日积分」的发放，本渠道就会被误判成 Loomy / Raccoon
那种**当日重置池**，渲染出无色的「长期 X · 每日 Y」，
**恰恰把红色临期 + 倒计时整段短路掉**，还把批次到期语义说反
（本渠道每日签到分是发放进余额、按批次到期，不是当日重置）。

修法：批次包名命中名单时加「（批次）」后缀。
⚠️ **不要改客户端那份名单** —— 它是**共享**判据，为一个渠道改会影响其余五家；
且名单语义是「服务端按语义分开的当日池」，本渠道的池是**按到期时刻聚合**的，
两者本就不该共用同一份名字表。

⚠️ **两份名单各存一处**（`src/**` 是 TS、`plugin-src/client/**` 是 esbuild 的 JS，
**不共享模块图**）⇒ 宿主侧副本的同步锁在
`tests/unit/autoclaw-credits.spec.ts` 的「宿主侧当日池名单副本逐字一致」那条。

### ⚠️ 守卫判据的两个血泪点（本轮审计实测）

1. **「隐藏池余额恰好为 0」会让守卫无牙**：夹具里隐藏池余额都是 0 时，
   把过滤器换成「按 `balance === 0` 剔除」（同样让隐藏池不输出）**依然全绿**
   ⇒ 对「判据是 display」**零判别力**。**必须把隐藏池余额取非 0** 才钉得住。
2. **「packages 长度为 1」区分不了两条路径**：「守恒不成立」与「流水失败」
   产出**同形**结果 ⇒ 只断言长度等于恒真残留。要断言「真被问过流水端点」
   **且**「回退包里一个 `deductionEndTime` 都没有」才有牙。

⚠️ **更要紧的一条**：原 PR 的验收夹具到期时刻距**真实当前** ~76.7 天
⇒ 落在 15 天窗口外 ⇒ 即便全绿，实际只会渲染黄色「长期」，
永远不是红色「临期 + 倒计时」——**而那正是用户诉求本体**。
⇒ 断言「`deductionEndTime` 被算出来」**不等于**断言「会变红」；
必须把批次真正喂给 `splitCreditsByExpiry` 并断言 `expiring` 与 `earliestExpiringAt`。

### ⚠️ 其余已修的小项

- **负数 `amount`（冲正/退款）一律丢弃**（判据 `<= 0` 而非 `=== 0`）：
  并进批次会让 `remaining` 变负，而客户端 `splitCreditsByExpiry` **静默 skip**
  `remaining <= 0`（`credit-expiry.js:99`）⇒ 合计与总额悄悄脱钩。
- **永久桶按描述分列**，不再用「单一累加器 + 取第一条名」的哨兵：
  哨兵初值恰等于默认名 `'其他积分'` ⇒ **首条真名恰为「其他积分」时哨兵不会被替换，
  被下一条顶掉**，活动赠送与注册奖励被混为一谈。
- **`metadata.description` 是空串时回退顶层 `description`**：`??` 不落空串
  ⇒ 原实现会把包名打成通用兜底「积分发放」。
- **兜底造包只在 `total > 0` 时做**：全部钱包 `display:false` 且零余额时
  凭空造 `remaining: 0` 的死包是纯噪声。
- **整段翻页共用一份时间预算**：原先每页各 arm 一次 15s，
  钱包 1 + 流水 5 = **最坏 90s**，超过徽标 **60s** 轮询周期 ⇒ 请求叠加。

### ⚠️ 聚合折算：`autoclawExpiry` 恒为 `NEVER`

`src/aggregate-expiry.ts` 的 `autoclawExpiry` 复用 `sharedPackageExpiry`
（取有效包 `deductionEndTime` 最小值）⇒ 走钱包包（无 `deductionEndTime`）时恒 `NEVER`。
⚠️ 这与 registry 那条「尽力而为」的注释**口径一致、不冲突**，别去改它。

⚠️ 但注意：`WIRED_EXPIRY_PROVIDERS` 里 autoclaw 的**注释**声称折算取的是
「有余额无到期 ⇒ NEVER」（`aggregate-expiry.ts:957-975`）—— 该注释描述的是
**回退路径**，两种路径都自洽，改动任一侧时同步另一侧的注释。

## ⚠️⚠️⚠️ P0：access_token 的真实死线曾按「编造的 7 天」记录 ⇒ 自动续期与积分自愈全部静默跳过（2026-10-19 真实报障，Gitee IKOYEG）

### 现象（用户原话可复现的时序）

dsh web **启动时还能看到积分**，过一会儿变成「AutoClaw 登录凭据失效，请重新登录」。
本次实测：dsh web 22:50:41 启动（正常）→ 23:19 面板报错。

### 实测事实（只读 JWT 元数据，**未对真实凭据发起任何续期请求**）

⚠️ **账号一律以「账号 A/B/C」代称**：本次报障涉及用户**真实账号**，而本仓库铁律是
「注释与用例里的号码一律用**编造的假号** —— 真号会随代码进仓库历史，不可撤回」
（见 `autoclaw.ts` 的 `autoclawDisplayNickname`）。**连掩码号也不写**：
掩码保留前 3 位 + 后 4 位，识别力远高于直觉。

| 账号 | JWT `iat` | JWT `exp`（真实死线） | 池/凭据里的 `expires_at` |
|---|---|---|---|
| 账号 A | 2026-10-18 23:02:36 | **2026-10-19 23:02:36** | 2026-10-25 23:02:41 |
| 账号 B | 2026-10-18 23:03:11 | **2026-10-19 23:03:11** | 2026-10-25 23:03:16 |
| 账号 C | 2026-10-18 23:04:03 | **2026-10-19 23:04:03** | 2026-10-25 23:04:09 |

⇒ access_token **就是明文 JWT**（`user_id/device_id/iat/exp/jti`），寿命恒
**86400s（24 小时）**，死线一到 `/agent-assetmgr/api/v2/wallets` 立刻回
`code 410000`（= `autoclaw-credits.ts` 那句「登录凭据失效」）。而
`expires_at` = 登录时刻 + **恰好 10080 分钟 = 7×86400s**。

### 根因（一条编造的数字，卡死两条链）

`loginAutoclawWithCode` 在上游既不给 `expires_at` 也不给 `expires_in` 时写下
`Date.now() + 7 * 86400_000`。而这份值同时是**唯一**的续期判据：

| 链 | 读点 | 被跳过的方式 |
|---|---|---|
| 定时续期 | `autoclaw-auth.ts` 的 `AUTOCLAW_EXPIRY_ACCESSORS.expiresAtOf` → `shouldRefreshNow` | 判「还有 6 天」⇒ `refreshAll` 每 30 分钟一轮**永远跳过** |
| 积分按需自愈 | `jet-hub-rpc.ts` 的 `healExpiredAccountBeforeBalance`（`entry.expiresAt <= now`） | 池值说 10月25日 ⇒ **点「刷新积分」也不自愈** |

旁证（决定性）：凭据里的 `iat` 至今仍是登录那一刻 ⇒ **从未续期过一次**。
症状形态恒定：**过期前不自愈、过期后也不自愈、日志零字**，UI 还显示
「有效期 10月25日 · 自动续期」（假象）。

### 引入提交与「为什么以前没看到」

- 唯一肇因提交 **`6da5505`**（2026-10-17 00:47，AutoClaw 首次接入）——
  `git log -S"7 * 86400_000" -- src/autoclaw-oauth.ts` 只命中它，且
  `git show 6da5505:src/autoclaw-oauth.ts` 里那一行**逐字相同**。
  ⚠️ **同一次提交**里还写进了 `refreshAccountWithReconcile` 的 lead-time 跳过
  与 `SELF_HEAL_REFRESHABLE_PROVIDERS` 的登记 ⇒ **上线即带病**，不存在
  「以前能自愈、后来被改坏」的过渡版本。后续 `13aa60d`（审计）未触碰任何
  expires 行。
- 与它无关但易被误认成肇因的两处都更早且对本渠道无语义：
  `healExpiredAccountBeforeBalance` = `0523e74`（10-10）、
  `shouldRefreshNow` = `48b2570`（09-28）；`577b27a`（10-18）给 CodeArts 补的
  refresh 寿命腿 autoclaw 未提供 ⇒ 零行为变化。
- 没被更早发现的原因是**物理上只到过这一次死线**：provider 10-17 才进仓库，
  池内账号建于 10-18 23:02 ⇒ 首次死线就是 10-19 23:02。且症状**每 24 小时
  必然复发**，而「手动修法」（重新登录）会重写 `createdAt` 与假有效期、
  把死线顺延并把证据一起重置（≈ 每次报障都自动销毁现场）。

### 修法（同一真源，三条腿）

1. `src/autoclaw.ts` 新增 `autoclawJwtExpiresAtMs`（读 JWT `exp`，**不验签**：
   网关自己也只按 `exp` 判）与 `autoclawAccessTokenExpiresAtMs`
   （**JWT 优先，声明值兜底**）；
2. 三个写入点（`loginAutoclawWithCode` / `refreshAutoclawToken` /
   `probeAutoclawLocalCredential`）与解析点 `parseAutoclawCredential` 共用它；
   **删除 7 天编造** ⇒ 两者都读不到时返回 `undefined`（= 不知道），由
   `shouldRefreshNow(undefined) === true` 放行续期（宁可多刷一次，不可编造）；
3. ⚠️ **纠正点必须是「每次 parse」**：存量坏凭据躺在用户目录里不会自己变，
   parse 一返回真死线，下一轮 `refreshAll` 立刻放行 ⇒ **无需重新登录**即自愈
   （成不成取决于 refresh_token 是否仍被上游接受；不成会按既有终态逻辑
   标 `refreshable:false` 并提示重登）。

### 守卫与变异验证（2026-10-19 实测，本仓库纪律）

新增 8 条用例（`tests/unit/autoclaw.spec.ts` 的「★★ access_token 死线以 JWT 为准」
与登录/续期路径），并与既有 `isAutoclawTokenExpired` 用例互补。变异验证归因：

| 变异 | 结果 | 结论 |
|---|---|---|
| M1：砍掉 `autoclawAccessTokenExpiresAtMs` 的 JWT 腿（`return declaredExpiresAtMs`） | **6 条红** | JWT 权威这条腿有牙 |
| M2：在 `loginAutoclawWithCode` 恢复 `Date.now() + 7 * 86400_000` | **仅 1 条红**（「两者都没有时必须是 undefined」） | ⚠️ 删除兜底这条腿**只**由那一条守着；JWT 那几条**抓不到**它（因为 JWT 优先会掩盖兜底）⇒ 两条腿的守卫不可互相替代 |

⚠️ 还修了一处**零判别力的旧断言**：原用例只写
`expect(cred.expires_at).toBeGreaterThan(Date.now())`，对「+7 天编造」**恒真**
（本次同时补上「差值必须 < 2 天」的量级断言）。这正是缺陷当初漏过测试的地方。

### 未验证项（如实登记）

- **续期端点是否仍接受这批 refresh_token**：未测。本仓库红线是
  「诊断脚本不得对真实凭据发起 refresh」（曾因此烧掉两个真实账号）
  ⇒ 只能由修复后插件的正常 `refreshAll` 去试，其终态由既有逻辑表达。
- **桌面端一键导入路径**（`probeAutoclawLocalCredential`）改为 JWT 优先后，
  若桌面端自写的 `expiresAt` 与 JWT `exp` 不一致，现以 JWT 为准 ——
  本机未登录桌面端，**未真机取证**。本次三个坏账号走的是短信登录路径
  （`expires_at` = 登录时刻 +7 天 ⇒ 该路径不经过 JWT 解析），故与本项无关。
- `parseAutoclawCredential` 里 `expires_in`（相对秒数）分支仍以**读取时刻**
  为基准换算 ⇒ 若某天有实现把相对秒数写进凭据，每次读取都会往后平移。
  当前落盘的是绝对毫秒 `expires_at`，**未触发**，故未改（不扩大范围）。
