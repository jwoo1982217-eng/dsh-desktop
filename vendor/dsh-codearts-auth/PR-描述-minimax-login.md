# PR：MiniMax Code 登录「链接自带旧会话」+ 续期丢身份（token 过期相关）

两个真缺陷、一个提交，均为 **MiniMax 登录/token 生命周期**问题：

```
fix(minimax): 登录链接复用旧会话导致换号失败 + 续期丢身份致去重失效
```

> ⚠️ 本 PR **刻意不含**任何 UI / 供应商列表改动（范围仅限 token 与登录态）。

---

## 一、缺陷 1：登录链接一打开就自带旧 session（用户报障原文）

> 「jethub 插件的 minimaxcode 登录会导致旧 session 掉登录状态，登录链接一打开就自带旧 session 登录态」

### 根因（实测，不是推测）

`account.create` 返回的 `loginUrl` 是设备码授权页 `verification_uri_complete`：

```
https://account.minimax.cn/oauth-authorize?user_code=QJNX-CZXV
```

**`user_code` 不含任何身份信息** —— 身份完全来自浏览器 cookie。于是：

- 浏览器里已有 MiniMax 网页会话 ⇒ 打开即**复用该会话**，直接显示**上一个号**的「授权」按钮；
- 用户点「新建账号」想加一个新号，结果又登回同一个号；**旧号的两份 token 互相取代**，
  表现为「旧的那条掉登录」。

### 为什么不能靠 URL 参数解决（已逐一证伪）

实测向授权页追加 5 个「强制重新登录」类参数，页面 chunk 里这些词**命中数全为 0**，
只是被塞进 Next router 的 query，**服务端与页面都不理会**：

| 参数 | 结果 |
|---|---|
| `prompt=login` / `prompt=consent` / `prompt=select_account` | 页面 200，无任何重定向或登录要求 |
| `force_login=1` / `relogin=1` | 同上 |

### 修法：复刻上游「切换账号」按钮背后的那一次请求

上游页面自己的「切换账号」按钮走的是：

```
GET https://account.minimax.cn/oauth2/device/authorize?user_code=<UC>     ← 不带 cookie
→ 401 {"error":"login_required",
        "login_url":"/unified-login?login_redirect=%2Foauth-authorize%3Fclient_id%3Dmcode-public%26user_code%3D<UC>"}
```

关键在于那个 `login_url` **自带 `login_redirect=<原授权页>`**：
用户在统一登录页登录完成后**自动回到授权页并放行新账号**。

⇒ 宿主用**无 cookie** 的纯 GET 换出这条链接，作为 `forcedLoginUrl` 下发给客户端，
由**客户端在用户自己的浏览器里**打开。

新增（`src/minimax-oauth.ts`）：

- `resolveMinimaxForcedLoginUrl()` —— **白名单判据**，不信任服务端拼的跳转目标：
  ① 必须与 `accountHost` **同 origin**；② 路径必须是 `/unified-login`；
  ③ `login_redirect` 必须解析到**本站** `/oauth-authorize` 且 `user_code` **与本次一致**。
  三条任一不过即返回 `undefined`（**不采信**）。最终 URL 由本地用 `URLSearchParams` **重编码**，不搬运上游原文。
- `buildMinimaxForcedLoginUrl()` —— 纯本地兜底拼法（不依赖上游）。
- `fetchMinimaxForcedLoginUrl()` —— **永不抛错**：网络/超时/非 JSON/上游给了恶意 URL
  一律退回本地兜底；`user_code` 为空才返回 `undefined`。
  请求**不带 `Authorization`**（仓库有过「诊断请求烧掉 refresh_token」的事故）。

⚠️ 这条链路**不消耗任何凭据**，因此可以安全地在每次「新建账号」时调用。

## 二、缺陷 2：续期把 `user_id` / `nickname` 丢掉 → 同账号去重失去判据

`refreshMinimaxCredential()` → `parseMinimaxTokenGrant()` 只构造**令牌五件套**
（`access_token` / `refresh_token` / `token_type` / `expires_at` / `scope`），
**不认识** `nickname` / `user_id`；而续期结果会被 `ctx.credentials.set` **整体覆盖**旧凭据。

定时续期 **30 分钟一轮**，`SELF_HEAL_REFRESHABLE_PROVIDERS` 还会在积分查询前补一次
⇒ 这个丢失**必然发生**（不是边角情况）。后果：

| 丢失字段 | 后果 |
|---|---|
| `nickname` | 账号卡片退回内部 id `minimax-xxxx`（IKP8UA 复发） |
| `user_id` | **同账号去重失去唯一判据** ⇒ 一个号可无限建卡、各持一份 token |

本机实测：三份 `MINIMAX_ACCOUNT_*` 凭据**零份**带 `user_id`、仅一份带 `nickname`。

### 修法

1. `persistLogin` 把身份查询拿到的 `userID` 落进凭据（`user_id`）并回传；
   此前它**只用来拼昵称、随后被丢弃**（`fetchMinimaxUserIdentity` 一直能拿到）。
2. 新增纯函数 `inheritMinimaxIdentity(refreshed, previous)`（在 `src/minimax.ts`，
   刻意**不**放在 `minimax-auth.ts` —— 后者顶层 import cordis，纯函数留在协议层才可独立测），
   收口在**唯一**的续期出口 `refreshCredentialFor()`。本文件有 4 条续期路径，逐点补必漏一处。
3. `account.create` 的 minimax 分支补**同账号去重**（此前是唯一缺这条的 provider；
   `zcode` / `officeace` / `autoclaw` 都有）：按 `user_id` 查
   `findAccountIdByIdentityField`，命中则**不删条目**、标停用 + 改名
   （删掉会让 `login.poll` 把「登录成功」显示成失败）。查重失败**不影响登录结论**。

## 三、⚠️ 明确**不做**的事（审阅请重点看这节）

- **不调 `openIncognitoWindow`**（宿主侧无痕窗口）。用户明确要求：「宿主开窗那一套废弃，只要 token 过期这件工作」。
  现实依据：**宿主能开窗 ≠ 用户能看见窗口**。无头部署（只有 Xvfb `:99`，用户经隧道用远端浏览器访问）下，
  宿主开窗后返回 `incognitoOpened: true`，客户端照契约跳过 `window.open` ⇒ 窗口画在没人看的虚拟屏上
  ⇒ 用户看到「点击新增账号不会跳转登录页」。本 PR 的返回值里**不含** `incognitoOpened`。
- 不改 `src/login.ts`、不改 `defaultBrowserExecutable()`、不加 Linux 浏览器候选链。
- 不含任何供应商列表 / 移动端导航 / 抽屉等 UI 改动。

## 三之二、方案 A：先登出、再打开授权页（2026-10-24 追加，用户报障驱动）

> 「登录完成后浏览器的 cookie 可以删掉吗？现在要手动清理浏览器 token 不然还是会带上个账号登录态」

### 为什么 `forcedLoginUrl` 不够

`forcedLoginUrl` 只保证「这条链接**要求**登录」（CDP 实测：全新浏览器打开它停在
`/unified-login`，显示微信扫码 / 手机号 / 账号密码登录表单，**无「授权」按钮**）。
但它**不主动注销**浏览器里已存在的会话 —— 用户的实际症状正是旧 `_sid` 仍在：
登录完成后新会话覆盖旧的，下次又带「上一个号」，只能手动清 cookie。

### 修法（两跳）

上游登出端点（**两个站点都有**，实测 2026-10-24）：

```
GET https://account.minimax.cn/oauth2/logout
  → 302 Location: /unified-login
  → Set-Cookie: _sid=; path=/; HttpOnly; secure; SameSite=Lax
GET https://account.minimax.io/oauth2/logout      （国际站同形）
```

⚠️ 它**不接受任何回跳参数**（实测 11 个参数名：`redirect` / `redirect_url` /
`return_to` / `returnTo` / `url` / `service` / `target` / `to` / `continue` /
`next_url` / `next`，`Location` 恒为 `/unified-login`）⇒ **必须两跳**，由客户端负责顺序。

客户端行为（`plugin-src/client/jet-hub.js`）：

1. 若宿主下发了 `logoutUrl`，**先弹确认**（`confirm`）；
2. 确认后 `window.open(logoutUrl)`（**导航**而非 `fetch` —— 要真实写入那个清 `_sid` 的 `Set-Cookie`）；
3. 延迟 **900ms**（实测登出全链路 0.19s、冷启动 2.9s ⇒ 900ms 覆盖慢网；跨源拿不到 load 回调）；
4. 再 `window.open(forcedLoginUrl)`；
5. 用户**取消**则跳过登出、直接开 `forcedLoginUrl`（仍是有效修法，只是可能带回旧会话）。

### ⚠️⚠️ 副作用（必须让用户知道，故不得静默）

登出的作用域是**整个 `account.minimax.cn` 网页会话** ⇒ 用户在同一浏览器里登录的
MiniMax **网页版**会被一起登出（登录完成后新会话立即重建，影响很小但真实存在）。
⇒ 客户端**先 `confirm` 再执行**，文案明确写「将退出 MiniMax 网页登录（含网页版会话）」。

### 两站各用各的域

`logoutUrl` 由 `${minimaxProduct.accountHost}${MINIMAX_WEB_LOGOUT_PATH}` 拼出，
**不写死 `.cn`** —— 国际站账号在 `.io` 域，写死会让国际站用户清不到 cookie。

### 只在「新建账号」路径

其它 provider 的授权页不在该 cookie 域，登出无意义且有害 ⇒ 仅 minimax 系下发；
且**只有真的拿到了 `forcedLoginUrl` 才给 `logoutUrl`**（否则登出后无处可去，
用户停在空白登录页，比不登出更糟）。

### 验证

- CDP 实测（无会话浏览器）：`forcedLoginUrl` → 停在 `/unified-login`，登录表单可见
  （微信扫码 / 手机号 / 账号密码 / 获取验证码 / 立即登录），**无「授权」字样**。
- `logout` 端点两站实测：均 `302 → /unified-login` + `Set-Cookie: _sid=; …; HttpOnly`。
- 4 个变异全部**有牙**：客户端不读 `logoutUrl`（2 红）／登出与授权页顺序颠倒（1 红）／
  去掉 `confirm` 变静默（1 红）／服务端不下发 `logoutUrl`（2 红）。

> ⚠️ **未验证的一半（如实登记）**：我没有用户的 MiniMax 账号，**无法构造合法的
> 既有会话**（`_sid` 是 HttpOnly，只能由真实登录产生）⇒ 「已有旧会话时 `forcedLoginUrl`
> 是否仍要求重登」这一格**未实测**。方案 A 正是为覆盖这一格而加（登出把旧会话清掉，
> 之后无论原行为如何都必然要求登录）。

## 四、客户端改动（`plugin-src/client/jet-hub.js`）

```js
const forcedLoginUrl = typeof res.forcedLoginUrl === 'string' && res.forcedLoginUrl.length > 0
  ? res.forcedLoginUrl : '';
if (forcedLoginUrl !== '') { /* MiniMax：保证需要登录 */ }
else { /* 其余 provider：既有 window.open(loginUrl) 原样保留 */ }
```

- 判据用 `typeof === 'string' && length > 0`：**老宿主**不返回该字段（`undefined`）⇒ 自然退回旧行为（升级期安全阀）。
- ⚠️ `window.open(loginUrl, …)` 与 `setLoginUrlForManual(loginUrl)` 两条字面量**刻意保留**
  —— 它们是其余 12 家 provider 的唯一通路，且被 `codearts-incognito-login.spec.ts` ④ 与
  `login-link-copy.spec.ts` 当作锚点（替换过一次，实测变红）。

## 五、验证

### 单测（新增）

- `tests/unit/minimax-forced-login.spec.ts`（21 条）
  - 白名单 6 格：跨站 `login_url` / `login_redirect` 指外站 / `user_code` 不一致 / 路径不对 / 缺字段 / 非字符串 ⇒ 全部拒绝
  - 失败退回 4 格：网络抛错 / 上游回恶意 URL / 非 JSON / 请求**不带 Authorization**
  - 接线 4 格：minimax 分支**不得**调 `openIncognitoWindow`、返回值**不得**含 `incognitoOpened`、必带 `forcedLoginUrl`、客户端在 `incognitoOpened===true` 时**仍自己开窗**
- `tests/unit/minimax-identity-inherit.spec.ts`（7 条）
  - 纯函数 3 格 + `refreshCredentialFor` 必须调用 `inheritMinimaxIdentity`（**缺 cordis 环境下的唯一守卫**）
  - 前提自检：续期响应本身不含身份字段（否则上面几格恒真、无牙）

> ⚠️ 依赖 `@deepseek-ai/cordis` 的两格用 `it.skipIf()`：本机 checkout 未装 dsh peer 依赖时
> 必须 **SKIP 而非 PASS**（仓库铁律）。安装完整的 checkout 里会真跑。

### 变异验证（三个都**有牙**）

| 变异 | 结果 |
|---|---|
| 续期改成 `return refreshed`（不继承身份） | 1 条红 |
| minimax 分支加回 `incognitoOpened: openIncognitoWindow(…)` | 2 条红 |
| 客户端把 `forcedLoginUrl` 恒置空 | 1 条红 |

回归：`codearts-incognito-login` / `officeace-incognito-login` / `login-link-copy` / `minimax-oauth` 共 79 passed。
全量套件与本分支基线**逐文件对照无新增失败**（基线里的 244 个失败文件均为本机缺 peer 依赖所致，与本次无关）。

### 真机实测（上游，2026-10-24）

```
user_code = 3RR7-NZ2L
原始授权链接 = https://account.minimax.cn/oauth-authorize?user_code=3RR7-NZ2L
强制重新登录 = https://account.minimax.cn/unified-login?login_redirect=%2Foauth-authorize%3Fuser_code%3D3RR7-NZ2L
```
`/unified-login` 对无会话浏览器返回登录页（页面不含 `user_code`、不含账号信息）⇒ 确认「先登录、后回授权页」。

## 六、涉及文件

| 文件 | 变化 |
|---|---|
| `src/minimax-product.ts` | +2 端点常量（`MINIMAX_DEVICE_AUTHORIZE_PATH` / `MINIMAX_WEB_LOGOUT_PATH`），含实测依据 |
| `src/minimax-oauth.ts` | +3 纯/半纯函数（解析白名单 / 本地兜底 / 拉取） |
| `src/minimax.ts` | `MinimaxCredential.user_id`；`inheritMinimaxIdentity()` |
| `src/minimax-auth.ts` | `startLogin` 带出 `forcedLoginUrl`；`persistLogin` 落 `user_id`；续期继承身份 |
| `src/jet-hub-rpc.ts` | minimax 分支：去重 + 回传 `forcedLoginUrl`（**不**开窗） |
| `src/types.ts` | `RpcCreateAccountResponse.forcedLoginUrl?`（含三条纪律） |
| `plugin-src/client/jet-hub.js` | 优先 `forcedLoginUrl`，保留 `loginUrl` 回退 |
| `tests/unit/minimax-*.spec.ts` | 两个新守卫文件 |

## 七、审阅建议顺序

1. `src/minimax-oauth.ts` 的 `resolveMinimaxForcedLoginUrl` —— 白名单判据是否够严（防开放重定向）；
2. `src/minimax.ts` 的 `inheritMinimaxIdentity` + `minimax-auth.ts` 的收口位置（为什么只改一处）；
3. `src/jet-hub-rpc.ts` 的去重处置（为什么**不删**条目）；
4. 第三节「明确不做的事」是否与你的预期一致。
