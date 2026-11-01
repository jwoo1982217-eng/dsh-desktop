# PR：AutoClaw 401 按需续期这条腿从未接线

一个小而独立的 bugfix，一个提交，只动 **AutoClaw 两站的接线** + 一个 spec 文件：

```
fix(autoclaw): 401 按需续期这条腿从未接线 ⇒ 401 不续期不重发、被归 AUTH、客户端替换成「API 密钥无效」
```

> ⚠️ 本 PR **刻意不含**任何 minimax / 其他 provider 改动（与并行的那条 minimax 续期重构**完全正交**：
> 两个提交在 `src/index.ts` 里的 hunk 区间互不重叠，cherry-pick 到 `origin/master` 实测零冲突）。
>
> 行号一律以**本 PR 分支**（基于 `origin/master`）为准。

---

## 一、缺陷现象

> 「AutoClaw 模型经常报 **API 密钥无效**」

用户侧看到的只有这一句固定文案 —— 上游原始报文、HTTP 状态码、账号名**全都不出现**。
这正是本仓库反复踩过的 `AUTH` 码形态：错误信息被客户端换掉，用户拿不到任何可排查的东西。

关键观察是「**经常**」而不是「**一直**」：账号大部分时间能用，只是隔一阵子就撞一次墙，
而且撞上之后**不会自己好**，只能重新登录。

## 二、根因：`options.refresh` 从未注入 → 401 是一条死路

三段，逐段可验证：

### ① 适配器的 401 重试判据被 `&& this.options.refresh` 把门

`src/autoclaw-adapter.ts:636`：

```ts
if (!response.ok && (response.status === 401 || response.status === 403) && this.options.refresh) {
```

⇒ **没有传这个回调时，整段 `if` 不执行**：既不续期、也不重发，直接把 401 原样抛出去。
这段的意图从代码本身就能读出来（`src/autoclaw-adapter.ts:636-659`）：续一次 →
`resolveCredential` 取新凭据 → `buildAutoclawHeaders` 重建头 → **用同一个 payload 再 POST 一遍**；
重试失败也被 `catch` 吞掉（`:656-658`），以免掩盖原始 401。
**缺的从来不是这块实现，而是「有没有人来喂它」。**

### ② 两个注册点自 AutoClaw 首次接入起**从未传过它**

`src/index.ts` 里有两处 `registerAutoclawLlm(...)`（国内版 `autoclaw` / 国际版 `autoclawintl`），
两处的 options 对象里**没有任何 `refresh` 键**：

| 证据 | 结果 |
|---|---|
| `git show <origin/master>:src/index.ts` 的两处 autoclaw 注册块（`:3483` / `:3571` 起的 options 对象） | `refresh` 键**零命中**；同一区间里唯一的 `refresh` 出现在其后的 **accio** 注册块（`:3645`） |
| `git log -S"autoclaw.refreshAccountCredential" --oneline --all` | 补丁前**零命中**（只有本 PR 的两个提交） |
| `git log --oneline --all -- src/autoclaw-adapter.ts` | 401 分支从 `6da5505`（首次接入）起就在，**从未被喂过回调** |

对照同一文件里 accio 的接线（`src/index.ts:3704-3720`，真实现）——它老老实实
`getAvailableAccount` 取号 → `refreshAccountCredential(entry.credentialRef, pool, entry.id)`；
buddy / trae / qoder / lobsterai / cline / minimax / gemini / looma / raccoon **全都有**。
**只有 autoclaw 两站是空的**，而它恰好是唯一把「401 才续期」写成硬判据的一家。

### ③ 401 落到 `AUTH` ⇒ 客户端把 message 换成「API 密钥无效」并丢掉原文

`src/autoclaw.ts:598-601`：

```ts
export function autoclawHttpErrorCode(status: number, body: string): string {
  if (isAutoclawQuotaError(body)) return 'QUOTA_EXCEEDED'
  if (isAutoclawAuthError(body)) return 'AUTH'
```

而 `isAutoclawAuthError`（`src/autoclaw.ts:577-584`）命中的第一条就是 `'invalid token'`
（`src/autoclaw.ts:579`）—— 上游 401 的典型报文。

⇒ 归 `AUTH`。而 `AUTH` 的后果**本仓库自己记过两遍**：

- `src/autoclaw.ts:555-556`（`isAutoclawQuotaError` 上方，现成的自记）：
  「`AUTH` 码会把 message 一起吞掉，用户只看到「API 密钥无效」」；
- `docs/agent-notes/client-ui.md:170`：
  「即 `AUTH` 会**把整条 message 换成「API 密钥无效」**」，
  同文件 `:421` 的对照表逐字记着修后/修前：「报文与指路文案全丢」。

### 三段串起来

```
401（AT 到期）
  → src/autoclaw-adapter.ts:636 的 && this.options.refresh 为 falsy ⇒ 不续期、不重发
  → src/autoclaw.ts:579 命中 'invalid token' ⇒ src/autoclaw.ts:601 归 'AUTH'
  → 客户端换成固定文案「API 密钥无效」、丢掉上游原文
  → 用户：不知道是过期、不知道是哪个号、也不知道点一下「刷新」就能好
```

**这就是「模型经常报 API 密钥无效」的直接来源。** 不是密钥真的无效，而是这条请求**没被给过第二次机会**。

## 三、为什么是「经常」而不是「一直」（触发窗口）

定时批量续期这条腿**是工作的**，所以正常时段账号一直是好的：

- `src/autoclaw-auth.ts:247` 的 `refreshAll` 由注册表派生，覆盖 autoclaw 两站；
- 驱动它的是全局调度器 `src/index.ts:4320`：`const REFRESH_INTERVAL_MS = 30 * 60 * 1000`；
- lead-time 判据是 `src/refresh.ts:2` 的 `REFRESH_LEAD_MS = 3_600_000`（1h 提前量）。

**实测旁证（2026-10-25 取证）**：凭据里的 access token 解出的 `iat` 是新的、剩余寿命 8.5h，
说明续期**确实成功过**（不是 RT 死了、也不是网络不通）。

但这条腿有三个结构性的空窗，任一命中就会让 AT 在**无人续期**的情况下走到过期：

| 空窗 | 证据 | 性质 |
|---|---|---|
| 30 分钟粒度：tick 之间不可能有第二次机会 | `src/index.ts:4320` | 代码级确定 |
| `refreshable === false` 的账号被**整段跳过** | `src/autoclaw-auth.ts:250` 的 `if (!entry.refreshable) continue` | 代码级确定 |
| 宿主重启 / 休眠 / 某一轮失败把窗口拉长 | 无持久化补偿：过期后没有任何路径会重试 | 结构性 |

窗口一旦命中，**过期后的每一个请求都是 401，且永远不会自愈** —— 因为按需续期这条腿根本不存在。

> ⚠️ **证据强度如实标注**：上表第 2 行（`refreshable:false`）是代码里唯一**显式**的跳过条件，
> 但「报障者命中的就是这一格」**未实测**（拿不到当时的账号池快照）。本 PR 不依赖这个归因成立：
> 无论窗口由哪一条打开，**补上按需续期后 401 都能自愈一次**，这才是修法的落点。

## 四、实测排除项（先证明「不是别的原因」）

在动手前逐条排掉了几种更常见的误诊，全部有实测记录（2026-10-25）：

| 假设 | 实测 | 结论 |
|---|---|---|
| refresh_token 已失效 ⇒ 只能重登 | 凭据 JWT：AT 剩 **8.5h**、RT 剩 **24.5 天**，`iat` 显示续期成功过 | ❌ 排除 |
| 头名用错（两家端点要求不同） | 该不对称**真实存在**：`autoclaw-model-config` 只认 `Authorization`、`chat/completions` 只认 `X-Authorization`；但现有实现**两处都用对了**（`src/autoclaw-adapter.ts:327-336` 有长篇注释与实测日期） | ❌ 排除 |
| 积分/钱包接口挂了拖垮认证 | `wallets` 与 `model-config` 均 **200** | ❌ 排除 |
| 账号被上游封禁 | 同一份 token 换个时刻能正常推理 | ❌ 排除 |

⇒ 剩下的唯一未被覆盖的分支，就是**「401 之后没有任何自愈动作」**这一条。

## 五、修法：两站各补一条 `refresh`，与 accio 同构

`src/index.ts:3580`（国内版）与 `src/index.ts:3649`（国际版）：

```ts
refresh: async () => {
  const available = await pool.getAvailableAccount(AUTOCLAW.id, '')
  if (available) {
    await autoclaw.refreshAccountCredential(
      available.entry.credentialRef, pool, available.entry.id,
    )
  } else {
    await autoclaw.refresh()
  }
},
```

要点三条：

1. **续「解析凭据时所用的那一个」账号**，而不是默认单凭据 ref —— 否则续的是另一个号，
   用户会看到「刚登录好却一直认证失败」。用 `getAvailableAccount` 取号与 accio 逐格同形。
2. ⚠️ **必须传 `pool + entry.id`**：续期成功后要把新的 `expiresAt` **写回账号池**，
   否则 UI 一直显示「已过期」而实际能正常发消息（**issue !IKIRTT 的形态**，
   该坑在本仓库的 minimax / accio 两处都留过注释）。
3. **两个站点各一条**（本仓库既有纪律：双站点每处都要到位，漏一处即该站静默失效）。
   池里没有账号时退各自实例的无参 `refresh()`（`AutoclawAuth` 有这个入口）。

修完的行为变化：401 时**先 grant 一次、再原样重发一次**；成功则用户完全无感，
失败则退回补丁前的原有路径（原始 401 仍按 `AUTH` 分类 —— 见下方诚实边界）。**过期不再等于终态。**

> ⚠️ **诚实边界**：`refresh` 本身失败（RT 也死了）时，`catch` 会吞掉异常，落到
> `src/autoclaw-adapter.ts:661` 的原始 401 分类 ⇒ 用户**仍会**看到「API 密钥无效」。
> 这一格是**正确的**（那个号确实只能重新登录了），本 PR 不掩盖它；
> 它改变的是「本来只需要续一次就能好」的那一类 —— 从**必然失败**变成**自动恢复**。

## 六、守卫 + 变异验证（三项都真有牙）

`tests/unit/autoclaw-lock-wiring.spec.ts` 末尾新增一组（+2 条，文件从 17 条增到 19 条）：

| 用例 | 守什么 |
|---|---|
| ① 国内版与国际版**都注入了非空** `refresh` | 键存在 + 不是 `async () => {}`（「传了等于没传」）+ 调到**本站**的 `refreshAccountCredential` + 池空有兜底 |
| ② 续期必须传 `pool + entry.id` | 传参形态逐字匹配，且**不得**退化成默认单凭据 ref |

⚠️ 断言前**先剥注释**：本文件与 `src` 的注释里到处是 `options.refresh` 这个词，
不去注释的话「删掉真代码」照样绿（这是本仓库的既有教训，用例里写明了）。

**变异验证（本 PR 在 `origin/master` 基线上复跑，2026-10-27）**：

| 变异 | 期望 | 实测 |
|---|---|---|
| M1 删键（国内版 `refresh:` 改名 ⇒ 等价未接线） | 红 | ✅ **1 failed** |
| M2 空实现（国际版换成 `refresh: async () => {}`） | 红 | ✅ **2 failed** |
| M3 续错站（国内版调 `autoclawIntl.refreshAccountCredential`） | 红 | ✅ **1 failed** |
| 还原后基线 | 全绿 | ✅ **19 passed** |

> 每个变异都做了**锚点自证**（`anchor-applied=True`）与**还原自证**（写回后
> `git hash-object src/index.ts` 与 `HEAD` 的 blob 逐字节相等、`git status` 干净）
> —— 避免「变异根本没注入 ⇒ 全绿」这一类假结论。

## 七、⚠️ 明确**不做**的事（审阅请重点看这节）

- **不动任何其他 provider**：`src/index.ts` 的改动只有 autoclaw 两站的 options 对象，
  其余 15 家的接线**一行没碰**。
- **不改适配器**：`src/autoclaw-adapter.ts` 的 401 分支本来就是对的（判据、重发、header 重建都在），
  缺的只是「有没有人来喂它」。本 PR 一行都没改它。
- **不改错误分类**：`AUTH` 的判定与文案链路原样保留。理由：补上续期后 401 会先在
  **HTTP 层**被吃掉并重发，走不到分类那一步；把 `AUTH` 改成别的码是另一件事（会丢上游原文），
  **不在本 PR 范围**。
- **不动 `refreshAll`**：定时批量续期保持原样（它工作正常），本 PR 只补「请求级自愈」。
- 不含任何 minimax / UI / 供应商列表 / 登录流程改动。

## 八、涉及文件

| 文件 | 变化 |
|---|---|
| `src/index.ts` | **+59**：autoclaw / autoclawintl 两个 options 对象各补一条 `refresh`（含证据注释） |
| `tests/unit/autoclaw-lock-wiring.spec.ts` | **+64**：新增一组 2 条守卫（剥注释 + 四处断言 + 反向断言） |
| 合计 | **2 files changed, 123 insertions(+), 0 deletions(-)** |

纯新增、零删除 ⇒ 对既有 17 条用例与全量套件**零回归面**。

## 九、验证

- `tests/unit/autoclaw-lock-wiring.spec.ts`：**19 passed**（分支上实跑，2026-10-27）。
- 全量：`pnpm test` **10926 passed / 0 failed**；`tsc` **0 错误**；`pnpm run build:all` **exit 0**。
- 变异：M1 / M2 / M3 各自变红，还原后全绿（见第六节）。

## 十、审阅建议顺序

1. `src/index.ts:3580` 与 `:3649` 这两条 `refresh` —— 形态是否与 accio（`:3704`）一致、
   两站是否是各自的 service 实例；
2. `tests/unit/autoclaw-lock-wiring.spec.ts` 新组 —— 四条断言是否都能被「真接线」以外的写法绕过
   （推荐直接看第六节的 M1/M2/M3 三行，那是它的牙）；
3. 第二节的三段根因链是否成立（尤其 `src/autoclaw-adapter.ts:636` 那个 `&&`）；
4. 第七节「明确不做的事」是否与你的预期一致。