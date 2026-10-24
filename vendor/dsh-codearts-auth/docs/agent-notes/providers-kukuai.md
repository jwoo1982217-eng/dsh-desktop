# 库库AI（百度 GenFlowPro）provider 接入实测笔记

> 2026-10-08 起，阶段 B 的**实测事实**逐条登记在这里。
> ⚠️ 与 `docs/superpowers/specs/...-design.md` §1.5 / §4 的说法**冲突时以本文件为准**
> —— 下面是**本机跑出来的**，那份是**逆向推断的**。冲突处已逐条标注。

## 0. 只读铁律（不可违反）

- 库库AI 的 cookie 库在 `%APPDATA%\baidugenflowpro\Network\Cookies` 与
  `%APPDATA%\baidugenflowpro\Partitions\genflow-auth\Network\Cookies`。
  **绝不写那个目录** —— 写坏会让用户的 IDE 掉登录态。
  读的时候**先 `copyFileSync` 到临时目录**，再用 `new DatabaseSync(snap, { readOnly: true })`。
- 写端点（`rewardClaim` / `taskComplete` / `inviteBind` / `sendmsg`）必须经用户**显式授权**
  才发。仓库惯例是 `<PREFIX>_E2E_CONFIRM=yes` 闸门。

## 1. 登录态：**全明文，不需要 DPAPI / os_crypt**

实测（2026-10-08，两次独立复测一致）：

| 库 | 行数 | `encrypted_value` 非空 | 关键 cookie |
|---|---|---|---|
| 主库 `Network/Cookies` | 5 | **0** | `BDUSS` 192B、`BDUSS_BFESS` 192B、`STOKEN` 64B、`gfprotpl` 10B |
| `Partitions/genflow-auth/Network/Cookies` | 14 | **0** | `BAIDUID` 37B、`STOKEN` 64B、`gfprotpl` 10B、`PANPSC` 343B、`PP*` |

⇒ design doc §1.5.6 的前提**成立**：值都在明文 `value` 列，读登录态**不需要**
`Local State` 里的 `os_crypt.encrypted_key`，也不需要 `DPAPI`。
（`Local State` 确实有 `encrypted_key`，但**本 provider 用不到**。）

⚠️ **`BDUSS` 只在主库**，`STOKEN` 两库都有 ⇒ 取 cookie 要**两库合并**，不能只看主库。

## 2. `homenew` 的真实请求参数（design doc §4.2 这里**是错的**）

design doc 说公共参数是 `app_id=123971023, channel=chunlei, version 1.6.7.134`。
**实测**：

- **不传任何参数** ⇒ `HTTP 400 errno=2 show_msg="params error"`。
- 必需的**常量** query（从 IDE 自己的磁盘缓存抓到的真实 URL 得到，不是猜的）：

  ```
  clienttype=400 & app_id=123971023 & web=1 & channel=chunlei & version=1.6.8
  ```

- ⚠️ `version` 实测已是 **1.6.8**（客户端 `package.json` 的 `win_version` 是 `1.6.7.134`，
  但请求里发的是 `1.6.8`）。
- ⚠️ **`bdstoken` / `uinfo` / `uk` 都不是必需的** —— 逐个二分验证：补或不补都是 `200 errno=0`。
  （IDE 的真实 URL 里带它们，但那是引擎统一注入的，服务端并不强校验。）

⚠️ 这套公共参数由**原生引擎**（`getParamById(APP_PARAM_ID_COMMON_PARAM)`）注入，
源码里 `credits-activity-api` 传给 `http.get` 的 `params` 是**空对象** `{}`
（`var t = {}`）—— 所以**照着源码抄 `{}` 会 400**，必须照实测 URL 补常量。

`.tmp-kuku/` 里区分：`createAuthCommonParams()` 只服务**活跃上报**（`reportActivity` /
`requestUserReport`），**不是** credits 的公共参数 —— design doc §4.2 把两者混为一谈了。

## 3. 余额与任务：**两个不同的端点**

⚠️ design doc §1.5.3 说 `freepoint/homenew` 回「**余额**+任务列表」。**实测错了**：
`homenew` 的 `data` 下**只有 `activities`，没有任何数值字段**（探针会显式打这一行）。

### 3.1 余额：`GET /bizapi/gfpro/getgfvipremain`

⚠️ **不在 `freepoint` 前缀下**，路径首段是 `/bizapi/`。

- 信封是 `{status:{code,msg,sLogid}, data:{…}}` —— 与 `freepoint` 的
  `{errno, show_msg, data}` **不是同一个信封**，判成功要看 `status.code === 0`。
- 积分在 `data.list[]` 里 **`assetType === 1`** 那一条的 `totalPoint`。
  ⚠️ **`totalPoint` 是字符串**（实测 `"500"`），不是数值 ⇒ 必须 `Number()`。
  ⚠️ 客户端也**按 `assetType` 取，不按 `assetName`**（`data.list.find(e => e.assetType === 1)?.totalPoint ?? 0`），
  虽然实测 `assetType=1` 的 `assetName` 恰好是 `"token"`。
- 实测资产：`1/token=500`（**这是积分**）、`2/duration=7200`、`3/scheduled_task=2`、`4/realtime_t=0`。

### 3.2 任务列表：`GET /api/genflowpro/freepoint/homenew`

信封 `{errno, show_msg, newno, request_id, server_time, data}` —— ⚠️ **信封在顶层**，
**不是** `body.data.errno`（早期版本在这里判错过一次，把 `errno=2` 误报成 ok）。

结构 `data.activities[] → tabs[] → tasks[]`，实测：

```
activity_key=genflow_free_points  activity_name=免费领积分  period_no=4
  tab_key=daily  tab_name=每日免费领
    daily_login             LOGIN             claimable=50   max=50   single=50
    daily_chat              CHAT              claimable=0    max=50   single=50
    daily_invite_visit      INVITE_VISIT      claimable=0    max=150  single=50
    daily_invite_download   INVITE_DOWNLOAD   claimable=0    max=300  single=100
```

⚠️ 新出现了一个 design doc §1.5.3 任务表里**没有**的 `daily_invite_download`
（`INVITE_DOWNLOAD`）⇒ 任务表**不能写死**，要按 `task_type` 归类。

### 3.3 单任务状态：`GET /api/genflowpro/freepoint/taskstatus?task_key=…`

design doc §1.5.3 没提这个端点。实测 `task_key` 参数**有效**（返回该任务的 `task_status`）：

```
daily_login               → errno=0  task_status="FINISHED"     （已领过）
daily_chat                → errno=0  task_status="UNFINISHED"
daily_invite_visit        → errno=0  task_status="UNFINISHED"
daily_invite_download     → errno=0  task_status="UNFINISHED"
this_key_does_not_exist   → errno=0  task_status="UNFINISHED"   （❓ 未知 key 不报错，见 §6）
```

## 4. 领积分是**写操作**（design doc §1.5.4 这里**是错的**）

⚠️ design doc §1.5.4 说「登录+对话是**服务端自动发放**，客户端从不调 `rewardClaim`」，
并把 kukuai 类比 raccoon 的「没有可调用的签到端点」。**实测推翻**：

`POST /api/genflowpro/freepoint/rewardClaim`

- **参数放 query，不是 body**。放 body 会得到
  `errno=2` + `RewardClaimReqDto.activity_key Error:Field validation for 'activity_key' failed on the 'required' tag`
  （三个字段各报一次）。客户端签名是 `post(url, headers, params)`，第三个参数才是参数。
- 参数形状（asar 逐字实测自 UI 点击处理函数）：

  ```
  activity_key = <activity.activity_key>
  period_id    = <activity.period_no>      ← ⚠️ 请求键 period_id，值取自响应字段 period_no
  task_key     = <task.task_key>
  ```

- 成功响应：`{errno:0, data:{claim_status:"SUCCESS", claimed_point:50}}`。

**实测证据（2026-10-08，已获用户显式授权）**：

| | 之前 | 之后 |
|---|---|---|
| 积分余额（`getgfvipremain`） | **500** | **550** |
| `daily_login` 的 `task_status` | `UNFINISHED` | `FINISHED` |
| `daily_login` 的 `claimable_point` | 50 | 0 |

⇒ 余额真的 +50，任务状态真的翻转。**「服务端自动发放」不成立。**

### 4.1 `autoClaim` **不是**自动发放机制

asar 里 `autoClaim` 只有 **3 处命中，全部在 UI 对象构造里**（
`...s ? { autoClaim: !0 } : {}`，`s = Ji.has(task_type)`，`Ji = new Set(['LOGIN','CHAT'])`），
**没有任何读取方、没有任何发请求的路径**。它只是「这个任务会自动领取」的**展示标记**。

⇒ **不要**照它实现「免调用领取」。领取只能靠调 `rewardClaim`。

## 5. IDE 的登录机制：**cookie 登录，不是 OAuth**

实测（asar 逐字）：

```
lo = "https://passport.baidu.com/v3/login/api/auth"   ← 登录窗口加载的就是这个网页登录页
po = "persist:genflow-auth"                            ← 专用 partition
mo = ["BDUSS","BDUSS_BFESS","PTOKEN","PTOKEN_BFESS","PASS_STOKEN","STOKEN"]
```

三步：

1. 受管控 webview 打开 `passport.baidu.com/v3/login/api/auth`（**网页**登录页，非 OAuth 授权页）；
2. 从 `persist:genflow-auth` partition 读 cookie；
3. **若没有 `STOKEN`**：用 `bduss + ptoken` POST 回 `login/api/auth`，
   取响应里的 `stoken_list.genflowpro`（`Ar()`，失败抛 `GET_STOKEN_EMPTY` / `GET_STOKEN_FAILED:<n>`）。

⇒ **没有 OAuth 的 `client_id` / `redirect_uri` / `authorization_code` 交换**
（asar 里搜到的 `OAUTH_*` 全属于 MCP skill 的 `authType`，与此无关）。

⚠️ 三步**都不依赖 IDE**。

### 5.1 ⚠️⚠️ 登录方式：**账号密码 / 短信 / 四个第三方**，**没有二维码**

> ⚠️ 本节曾一度写成「kuku 支持扫码登录、可实现零 Chromium 登录」。**那是错的**，
> 已据权威证据撤回。错误成因见 §5.1.1 —— 它是本 provider 上最重要的一条教训。

**权威证据一：真实登录页的 bundle 配置**（`https://kuku.baidu.com/genflowpro/login`
引用的 `genflow-login/js/index.o61gd118.js`，119284B，逐字）：

```js
function Vo(e){return{
  product:`genflowpro`, loginType:1, loginVersion:`v5`,
  sms:5, safeFlag:0, overseas:0,
  userPwdLogin:0, qrcodeLogin:0, qrcode:0,        // ← 二维码登录 = 0（关闭）
  hideLogo:1, authsiteLogin:Bo(),                  // ← 第三方登录
  authsiteCfgLogin:{act:`implicit`}, charset:`utf8`, ...
}}
function Bo(){let e=[`tsina`,`qzone`,`weixin`,`dingtalk`];   // 微博 / QQ / 微信 / 钉钉
  return zo(`appleSign`)===`true`&&e.push(`apple`), e}
```

⇒ **`qrcodeLogin:0` / `qrcode:0` 就是「不提供二维码登录」**。`Bo()` 给出的四个
第三方恰好对应用户截图里那四个小按钮。

**权威证据二：用户截图**（2026-10-08，用户实测本机 IDE）。界面为
「账号登录 / 短信登录」两个 tab + 表单（手机号/用户名/邮箱 + 密码）
+ 底部四个第三方图标（微博 / QQ / 微信 / 飞书）。**页面上没有二维码入口。**

⚠️ 用户口述的第四个是「飞书」，bundle 里是 `dingtalk`（钉钉）—— 两者**不一致**。
以**页面截图**为准（截图上第四个图标形似飞书），bundle 的 `dingtalk` 可能是
该 SDK 版本对同一槽位的命名。**实现时不要把厂商名写死**，按 UI 呈现为准。

**权威证据三：asar 里 `getqrcode` / `unicast` / `channel_v` 各 0 处命中**
（`qrcode` 20 处均与本登录无关）—— IDE 从不走二维码。

⚠️ **登录窗口加载的是 `qa = "https://kuku.baidu.com/genflowpro/login"`**
（再挂 `?at=<ts>&openAtlogin=<bool>`），**不是** `passport.baidu.com/...`。
那个 bundle 自己 `document.createElement('script')` 动态加载
`https://passport.baidu.com/passApi/js/wrapper.js` 来渲染 passport 表单。

### 5.1.1 ⚠️⚠️ 错误成因：把「SDK 有这个能力」当成「本产品开放了这个入口」

**我当时的推理**：`GET /v2/api/getqrcode?...&tpl=genflowpro` 返回
`{"errno":0,"sign":"…","imgurl":"…","prompt":"登录后**威马**将获得百度账号的公开信息…"}`，
于是断定「kuku 支持扫码」。

**三处反面/矛盾证据我都有，却全部解释错了**：

| 我看到的 | 我错误的解释 | 正确的解释 |
|---|---|---|
| `prompt` 里写的是**「威马」**（一家车企，与库库无关） | 忽略了 | `tpl=genflowpro` **不是已注册模板**，服务端**回退到某个默认模板** ⇒ 该响应**不证明** kuku 支持扫码 |
| asar 里 `getqrcode`/`unicast` **0 处命中** | 「二维码是 passport 远程网页的能力，不在 IDE 里」 | 这个产品**根本不走**二维码 |
| bundle 里 `#TANGRAM__PSP_4__QrcodeTitle` | 「有二维码 DOM，说明支持」 | 那是 **passport SDK 的通用 DOM 定位代码**，元素不存在时什么都不做 |

⇒ **教训（可推广）**：
1. **`tpl=<产品名>` 的响应不等于该产品开放了该功能** —— passport 这类多租户
   登录服务对**未注册的 tpl 会回退到默认模板并照样回 200**。
   验真的判据是**该产品自己的配置**（这里是登录页 bundle 的 `qrcodeLogin:0`），
   不是「我用它的 tpl 调通用端点拿到了 200」。
2. **响应里出现的第三方品牌名是「模板回退」的指纹**（「威马」/「登录后 xx 将获得…」）。
   看到与本产品无关的品牌名，应当**立即怀疑模板回退**，而不是继续往下推。
3. **「某 SDK 具备某能力」与「某产品开放了该能力」是两个问题**，
   前者不能推出后者。判据要落在**产品的**配置/UI 上。
4. **用户的界面实测优先于任何 API 层推断** —— 用户两次指出「没看到扫码」，
   而我有一次已经据此改口、却被 `errno:0` 又拉回了错的方向。

### 5.2 ⚠️ B1 的形态（**已定案**，2026-10-08 用户决策）

登录**只能**走下列已开放的方式（二维码不在其中）：

| 方式 | 纯 HTTP 可行性 | 说明 |
|---|---|---|
| 账号密码 | **未验证**，且很可能**不行** | 需 `getpublickey` 加密密码 + **风控指纹**（IDE 缓存里实测出现过 `fingerprint.js` / `mkd_v2.js` / `wappass.baidu.com/static/sdk-machine`）。纯 HTTP 伪造指纹正是 zcode 需要 Chromium 的同一类问题 |
| 短信验证码 | **未验证**，且同样有风控 | 需真实收短信，且发码/校验都过风控 SDK |
| 第三方（微博/QQ/微信/飞书） | **未验证** | 标准 OAuth，但 `act:'implicit'`（隐式流）⇒ 凭据在**跳转 URL 的 fragment** 里，纯 HTTP 需要拦截跳转 |

**定案（用户 2026-10-08 选择）**：**插件自己 spawn chromium + CDP**，
由用户在**我们启动的浏览器**里完成登录，我们用 CDP 读 cookie。
同时用户**明确要求严守**「不读本机 IDE 数据」那条仓库决策（§5.4.3）——
故读 `%APPDATA%\baidugenflowpro` 的路线**被排除**，CDP 是唯一零手动的路径。

用户原话的疑问「为什么不用 web / desktop 自己的环境打开认证网页，而要 CDP？」
—— 答案是**打开认证页本来就不需要 CDP**（`window.open(loginUrl)` 就够，
这也是 Jet Hub 现在对所有 provider 的做法）；**需要 CDP 的只有一件事：
把 `.baidu.com` 上的 HttpOnly cookie 取回来**。两者的边界见 §5.4。

⚠️ **`STOKEN` 的产出方式仍是 B1 的核心未知量**（§6 U-E）：本方案不改变这一点，
只是把「谁来承载风控」交给真实 chromium 内核。

### 5.3 ⚠️⚠️ `STOKEN` 的判据是**域**，不是「有没有」—— 本节前半段的结论已被推翻

> ⚠️ **2026-10-08 更正**：本节原先写「`STOKEN` **必需**，仅 `BDUSS` 会 `errno=-6`」。
> 那个结论**方向对、判据错**：真正的判据是 **`STOKEN` 的 `domain` 必须是
> `.kuku.baidu.com`**，`passport` 域那份**反而会让服务端判「未登录」**。
> 成因是**两份同名 `STOKEN`**，而我当时**按 cookie 名去重**了。详见 §5.3.1。

**原始实测**（逐级削减 cookie，三个只读端点对照）：

| cookie 集合 | 余额 `getgfvipremain` | 任务 `homenew` | 模型 `model/list` |
|---|---|---|---|
| **仅 `BDUSS`** | HTTP 200 `550` | **HTTP 200 `errno=-6`** ⚠️ | HTTP 200 `status.code=0` |
| `BDUSS` + `STOKEN` | HTTP 200 `550` | HTTP 200 `errno=0` | HTTP 200 `status.code=0` |
| 再加 `gfprotpl` / `BAIDUID` 系 | 同上 | 同上（无进一步变化） | 同上 |

⇒ 当时读成「`STOKEN` 不是可选的」，而**正确答案是「必须是 kuku 域那份」**：
那次实验里的 `STOKEN` 恰好取自 **kuku 域**（IDE 的 cookie 库），所以"加了就对"。

⚠️ 而 `model/list` 与余额端点**只看 `BDUSS`**，与 `STOKEN` 无关（两个变体都成功）。

#### 5.3.1 ★★ 同名 cookie 的域陷阱（**推翻性实测**）

一次真实登录后（§5.4.5 的 CDP 原型），全量 cookie 里有**两份 `STOKEN`，值不同**：

```
STOKEN  .passport.baidu.com  len=64  session=Y   ← passport 登录当场种下
STOKEN  .kuku.baidu.com      len=64  session=n   ← kuku 自己又种了一份（持久）
```

按 `(name)` 去重取一个（我最初的做法，也是**最自然的写法**）会**随机**命中其中一份。
实测四个变体打 `homenew`：

| 变体 | `homenew` |
|---|---|
| **只发 `.kuku.baidu.com` 域的 `STOKEN`**（= 浏览器语义） | ✅ `errno=0` |
| 只发 `.passport.baidu.com` 域的 `STOKEN` | ❌ `errno=-6` **未登录** |
| 完全不带 `STOKEN` | ❌ `errno=-6` |
| 两份都发（同名两次） | ✅ `errno=0` |

⇒ **三条实现约束**（写进 B1 时必须遵守）：

1. **cookie jar 必须按 `(name, domain)` 存，不能按 `(name)` 去重** ——
   按名去重是「一个语义两套实现」的温床，且**失败方向是静默的**（表现为「未登录」，
   而用户明明刚登录成功，极难归因）。
2. **发请求前按目标域筛**（`domainMatches(host, cookie.domain)`），
   复刻浏览器语义 —— 别把 `.passport.baidu.com` 的 cookie 发给 `kuku.baidu.com`。
3. `domain` 为空串的 cookie（实测有**一个名为空串的 cookie** 在 `kuku.baidu.com` 域，
   `len=9`）要**过滤掉**：空名 cookie 拼进 `Cookie` 头会产出 `=value` 这种畸形项。
   ⚠️ 实测它不影响请求结果，但**会污染日志与去重逻辑**，且是「空键」这类静默陷阱。

⚠️ **`STOKEN` 是 session cookie**（`session=Y` 且无 `expires`）⇒
**关掉浏览器就没了**，B1 **必须在登录后立刻把它落库**，不能指望复用。

**`STOKEN` 的来源（读 asar + 10 个端点实测）**：

- `mo` 白名单里**含 `STOKEN`** ⇒ 它是**登录成功时 passport 种下的 cookie**；
- `kr(cookies)` 只挑 `BDUSS`/`BDUSS_BFESS`/`PTOKEN`/`PTOKEN_BFESS`/`PASS_STOKEN`
  —— **不含 `STOKEN`**，故它不是 `kr` 的产物；
- `readLoginCookies()` 返回 `{...r, ...cookies.STOKEN ? {stoken: cookies.STOKEN} : {}}`
  —— `STOKEN` **直接从全量 cookie 域取**；
  ⚠️ 这行 asar 代码正是 §5.3.1 那个陷阱的**镜像**：`cookies.STOKEN` 这种"按键取值"
  在**同名多域**时必然只能反映其中一份 —— IDE 之所以没事，是因为它读的是
  `persist:genflow-auth` partition 的 cookie（**只有 kuku 域那份**）。
- **实测 10 个端点（kuku 三个 + passport 四个 + pan 两个 + 首页）无一铸造 `STOKEN`**
  （`set-cookie` 里只有 `PANPSC`/`BDUSS_BFESS`/`BAIDUID`/`BAIDUID_BFESS`）。

⚠️ `exchangeStoken()` 是**另一条**路径（`bduss + ptoken` → `stoken_list.genflowpro`），
**前置条件是 `PTOKEN`**（`if (!e.ptoken) throw Error("PTOKEN_EMPTY")`），
而**本机 IDE 的 cookie 里没有 `PTOKEN`/`PASS_STOKEN`**（§5.3.2 有更正）。
实测拿 `BDUSS` 打那个端点是
`{"code":0,"message":"","errno":4,"errmsg":"unknow error(110003)"}` —— 与 IDE 里
现有 `STOKEN` 并存，说明**它并非 IDE 那个 `STOKEN` 的来源**。

⇒ **B1 必须让登录流程产出 `BDUSS` + `.kuku.baidu.com` 域的 `STOKEN`**，
且**登录后立刻落库**（它是 session cookie）。

#### 5.3.2 ⚠️ `PTOKEN` 其实**有**（更正 §5.3 的旧说法）

旧文写「本机没有 `PTOKEN`」—— 那是**只看 IDE 的 cookie 库**得出的。
CDP 原型里一次真实登录后实测**三件套同时出现**（同一秒）：

| cookie | len | domain | HttpOnly | session |
|---|---|---|---|---|
| `BDUSS` | 192 | `.baidu.com` | Y | **Y** |
| `STOKEN` | 64 | `.passport.baidu.com` | Y | **Y** |
| `PTOKEN` | 32 | `.passport.baidu.com` | Y | **Y** |

⇒ ① **登录当场就种下，不需要任何兑换步骤**（三者同一毫秒级出现，见 §5.4.5 的时间线）；
② `exchangeStoken` 那条路**现在是可用的**（有 `PTOKEN`）—— 但**不需要**它，
因为 `STOKEN` 已经直接在 cookie 里；
③ IDE 的 cookie 库里没有 `PTOKEN` 可能是**它自己没取/取了没存**，
不影响我们用 CDP 的路线。

⚠️ **但「哪种登录方式会种下 `STOKEN`」尚未实测**（见 §6 U-E）。
`STOKEN` 出现在 `mo` 白名单里，说明它由 passport 在**登录成功回调**时下发；
「扫码流程一定给」这个说法**已随 §5.1 一并撤回**（扫码本来就不开放）。

### 5.4 ⚠️⚠️ 「为什么必须 CDP」的完整取证（2026-10-08 实测）

用户质疑：「为什么不用 web / desktop 自己的环境打开认证网页，而要 CDP？」
⇒ **打开认证页确实不需要 CDP**；需要 CDP 的**唯一**理由是**读 HttpOnly cookie**。
下面是逐条实测，不是推断。

#### 5.4.1 现有 7 家能用 `window.open` 是因为它们是 **OAuth**，kuku 不是

| | 现有 7 家（OAuth） | kuku（passport） |
|---|---|---|
| 凭据怎么来 | **回调到我们自己的**本地服务器（`127.0.0.1:<port>`） | **种成 `.baidu.com` 的 HttpOnly cookie** |
| `login.poll` 轮询谁 | **我们自己的**状态 | 没有任何东西可轮询 |
| 窗口用谁的无所谓 | ✅ 无所谓（数据回到我们这） | ❌ **关键就在这里** |

kuku 没有 OAuth：实测 `bduss` / `stoken` 在登录页 bundle 里**各 0 处命中**，
`OnLoginSucceed` 只透传 passport 的 `loginSuccess` 参数、**参数里没有凭据**。
另测 `passport.baidu.com` 的 OAuth 端点：`/oauth/2.0/authorize` **404**、
`/oauth/authorize` **404**、`/v2/api/oauth` 302 到 `error.html`。
⇒ **没有 `client_id` / `redirect_uri` / `authorization_code` 交换。**

#### 5.4.2 DSH **不是** Electron，也不向插件暴露 cookie（我先前查错过一次）

⚠️ 我第一轮查的是 **npm 依赖树**，据此说「DSH 不是 Electron」—— 那只说对了一半：

- **插件的宿主进程**确实是纯 Node（依赖只有 commander / js-yaml / cordis，
  **无 electron / playwright / puppeteer**）⇒ **拿不到 `session.cookies`**；
- 但 **DSH Desktop 的 Electron 壳**里**确实**有一个可加载任意 HTTP(S) 的浏览器
  标签页（`@deepseek-ai/dsh-client-ui-sidebar-browser`，`ElectronWebViewImpl`
  带 `loadUrl` / `goBack` / `goForward` / `reload`）。

**然而它对插件不可编程**：那个 `bridge` 是「Electron 主进程 ↔ 渲染进程」的
**内部通道**，不是 cordis 服务。实测：宿主侧 `@deepseek-ai/*` 里
**没有任何** webview / BrowserWindow / executeJavaScript 服务包
（只有 `dsh-host-webserver`、`dsh-host-open-in-app` 等）。

#### 5.4.3 ⚠️ 为什么 captcha 能用 Desktop 载体、登录却不能用

**数据流方向不同** —— 这是本节最关键的一条对照：

| | 数据往哪走 | 需要的能力 |
|---|---|---|
| **captcha**（`captcha-carrier.ts`，已有） | webview 里**产出** param → **主动交回**插件 | 只需 **client→host** 回传一个字符串 |
| **登录**（B1，要做） | 凭据**留在**浏览器 cookie 里 → 插件**要去取** | 需要 **host→guest 读 HttpOnly** |

captcha 那条路是 `captcha-supply.ts` 的**供给槽**：客户端在 webview 里跑完 SDK
把 param **主动交上来**，数据是浏览器**给我们**的。而 passport **不会**主动交凭据
（§5.4.1 实测 bundle 里 0 处命中）⇒ 即便把登录页塞进那个 webview，
**也没有 API 去读它的 cookie**，除非我们持有那个浏览器实例的调试端口 —— 也就是 CDP。

#### 5.4.4 同源策略侧的两个猜想：一个否掉，一个仍否掉

| 猜想 | 实测 |
|---|---|
| 用 `iframe` 嵌 passport 登录页读其 cookie | passport 端点**未设** `X-Frame-Options`（**能嵌**！）—— 但跨源 iframe 内的 cookie **照样读不到**；且 kuku 自己的登录页是 `X-Frame-Options: SAMEORIGIN` |
| 在页面里加载 passport SDK，从 `loginSuccess` 取凭据 | ❌ bundle 里 `bduss`/`stoken` **各 0 处命中**，`loginSuccess` 只报「成功了」，**参数里无凭据** |

#### 5.4.5 ★ CDP 读 HttpOnly cookie：**通道已自证**（支点验证）

因为「未真正登录时 passport 不下发 HttpOnly cookie」，而**不能拿用户账号去登录**，
故改用**自证**：用 CDP 自己种一个 HttpOnly cookie 再读回来 ——
将来读 `BDUSS`/`STOKEN` 走的是**同一条通道**。实测：

| 验证项 | 结果 |
|---|---|
| 浏览器级 `Storage.getCookies` 读 **HttpOnly 持久** cookie 的**值** | ✅ 完整（29 字符） |
| 浏览器级 `Storage.getCookies` 读 **HttpOnly session** cookie（无 `expires`）的值 | ✅ 完整（25 字符） |
| `document.cookie` 能否看到这些 HttpOnly cookie | ✅ **看不到**（**这就是必须 CDP 的证明**） |
| 浏览器级 `Network.getAllCookies` | ❌ `-32601` **不存在** |
| 浏览器级 `Network.getCookies` | ❌ `-32601` **不存在** |
| page 级 `Network.getCookies`（须 `Target.attachToTarget` + `flatten:true` 带 `sessionId`） | ✅ 可用 |

⚠️ **两个 API 级陷阱**（都会让实现白写）：
1. **`Network.getAllCookies` 在浏览器端点上不存在** —— 别照文档想当然；
   **`Storage.getCookies` 是浏览器级唯一可用的那个**，且它**不需要** sessionId。
2. `flatten: true` 的 `attachToTarget` 之后，**每条**命令都必须带 `sessionId`，
   否则命令落到 browser 端点 ⇒ 恒 `-32601`。

#### 5.4.5.1 ★★ 真实登录的 cookie 时间线（**U-E 已答**）

用上述原型（`spawn chromium --remote-debugging-port` + 可见窗口 +
导航到真实登录页 + 每 2 秒 `Storage.getCookies`）跑了一次**真实登录**。
关键观测（`elapsedMs` 是脚本启动起的毫秒）：

```
   6ms     gfprotpl (.kuku.baidu.com, HttpOnly)  BAIDUID (.baidu.com)
 108571ms  BDUSS  (.baidu.com,         len=192, HttpOnly, session)
 108571ms  STOKEN (.passport.baidu.com,len=64,  HttpOnly, session)
 108572ms  PTOKEN (.passport.baidu.com,len=32,  HttpOnly, session)
```

⇒ **U-E 的答案**：**`BDUSS` / `STOKEN` / `PTOKEN` 在登录成功的同一瞬间一起种下**
（三者相差 1~2 毫秒），**不需要任何额外兑换步骤**，且**与具体登录方式无关**
（用户在页面上用哪种方式登，passport 走的是同一条成功回调）。

⚠️ **三者全是 `HttpOnly` + `session`**（`session=Y`，无 `expires`）⇒
**浏览器一关就消失** ⇒ B1 必须在登录后**立刻**落库，不能「等用户下次打开再取」。
这也解释了为什么 §5.4.6 的「直读 profile 库」路线行不通。

⚠️ 实测 `STOKEN` 这时**还种了第二份到 `.kuku.baidu.com`**（`session=n`，持久）——
这正是 §5.3.1 那个域陷阱的数据来源。**两份值不同**。

⚠️ 顺带实测到一个**名为空串的 cookie**（`kuku.baidu.com` 域，`len=9`）——
见 §5.3.1 的第 3 条实现约束。

#### 5.4.6 ⚠️ 「直读我们自己 profile 的 cookie 库」**不可靠**（实测否掉）

一度以为可以省掉 CDP：若我们 spawn 的 chromium 也**明文**存 cookie，直读库即可。
**实测否掉**：用 `taskkill /F` 终止后直读我们自己的 profile，
**cookie 库 0 行**，而同一时刻 CDP 读到 **9 条** ⇒
**强制终止导致 cookie 未落盘**。
⇒ 对**我们自己启动**的浏览器，**必须走 CDP**（它读的是内存里的活 cookie）。
（这与 §1 的 kuku 库不同：那是**正常退出**的 Electron 应用，已落盘。）

#### 5.4.7 ⚠️ 与仓库既有决策的冲突，及用户的裁定

`docs/agent-notes/providers-zcode.md` §十 + `tests/unit/zcode-no-local-credential-read.spec.ts`
记录了 **2026-10-05 用户决策「不读本机 IDE 数据」**（Issue IKJNPZ，
由提交 `2e8bb86` 执行，src 净减约 700 行），理由原话是那套读取
「等价于『任何本地进程都能解密 ZCode 的登录凭据』」，且该插件有自己的完整 OAuth 流程。
仓库还留了一道**静态扫源码**的防回退锁。

而 kuku 的登录态**恰好就在本机**、且**是明文**（§1 实测 `encrypted_value` 长度全 0）——
**本方案与那条被删除的 zcode 能力高度平行**，故必须由用户裁定。

**用户 2026-10-08 裁定：严守该决策，不读本机** ⇒ 排除直读
`%APPDATA%\baidugenflowpro\...\Cookies`，**只走 CDP**（浏览器是我们启动的，
凭据进我们自己的临时 profile，**不碰 kuku 的任何文件**）。

⚠️ 这条裁定有一个**结构性的额外好处**：不读本机 ⇒ 不需要
`copyToTemp + readOnly` 那套只读铁律（§0），也不再依赖用户是否装了 IDE。

## 6. 尚未查清（下一步要解决）

- **U-A**：`taskstatus` 对**未知 `task_key`** 也回 `UNFINISHED`（不报错）
  ⇒ 不能靠它判「任务不存在」，只能拿它刷新已知任务。
- **U-B**：`period_no` 会随活动周期变（实测 `4`）⇒ 不能缓存，每次领取都要用**当次**
  `homenew` 返回的值。
- **U-C**：`errno=151004`（无活动）在本机**没有复现**（当前有活动）⇒
  「无活动」这条分支只能按 asar 源码实现（`i = 151004` ⇒ 返回 `e.data ?? {activities:[]}`），
  **无法实测**。要在用例里如实标注这一点。
- **U-D**：对话协议（`/wenchain/genflowpro/model/list`、`sendmsg`、
  `sse/msgexchange` 的帧形状与结束判据）**尚未取得** —— 这是 B3 的决策门。
- **U-E**：~~哪种登录方式会种下 `STOKEN`？~~ ⇒ **已答（2026-10-08，§5.4.5.1）**：
  **登录成功的同一瞬间同时种下 `BDUSS` + `STOKEN` + `PTOKEN`**（相差 1~2ms），
  **不需要任何兑换步骤**，且**与登录方式无关**（passport 走同一条成功回调）。
  ⚠️ 但**随之暴露了一个更重要的问题**（见下，已改写为 U-E'）。
- **U-E'**（**取代 U-E，B1 的核心未知量**）：**同名多域 cookie 的取舍规则**。
  实测 `STOKEN` 有**两份、值不同**（`.passport.baidu.com` 与 `.kuku.baidu.com`），
  而**只有 kuku 域那份**能让 `homenew` 回 `errno=0`（§5.3.1）。
  仍需实测确认：
  - 其它关注 cookie（`BDUSS` / `PANPSC` / `ppfuid`）是否也有同名多域？
    （`BDUSS` 实测有 `.baidu.com` 一份；`PANPSC` 有 `.pan.baidu.com` 与
    `.kuku.baidu.com` **两份**；`BAIDUID_BFESS` 有 `.baidu.com` 与 `.hao123.com` 两份）
  - **`.kuku.baidu.com` 那份 `STOKEN` 是哪一步种下的**？（登录时它就已存在，
    但尚不清楚是 kuku 页面自己种的、还是某次 API 往返种的）——
    这决定 B1 是「登录后直接读」还是「登录后还需等一次 API 往返」。
- **U-F**：账号密码登录对风控指纹的依赖程度 —— **已降级为非阻断项**。
  原先它是阻断性未知量（「若风控必需，纯 HTTP 就不可行」）。CDP 方案定案后，
  登录在**真实 chromium 内核**里进行，风控 SDK 拿到的是**真实指纹与真实 origin**，
  **不需要我们伪造** ⇒ 它只剩一个次要影响：**若某种登录方式在自动化浏览器里被拦**，
  要给用户清晰的失败提示。
  ⚠️ **已有正面实测**：本机真实登录**成功**（§5.4.5.1），
  且该 chromium 是**显式带 `--remote-debugging-port`** 启动的 ⇒
  **至少在账号密码 / 短信 / 第三方中有一种不被该配置拦**。
  ⚠️ 但**未记录用户具体用了哪种方式** ⇒ 不能据此宣称「所有方式都不被拦」。
  IDE 缓存里的 `fingerprint.js` / `mkd_v2.js` / `mkd.js` /
  `getpublickey?...&alg=v3&sig=…&shaOne=…` 仍是**已知存在的风控组件**，
  只是它们现在由真实浏览器承载。
- **U-G**（新增）：**CDP 启动的浏览器要不要对用户可见**？⇒ **已定：必须可见**。
  `zcode-captcha.ts` 把窗口移到屏幕外（`--window-position=-32000,-32000`）+
  隐藏任务栏按钮，因为 captcha 是全自动的。而**登录必须让用户看见并操作**，
  故 B1 **不能**复用那个「隐藏窗口」的默认值。
  已按此实现并通过真实登录验证（§5.4.5.1 用的就是可见窗口）。
- **U-H**：**登录完成后如何判定成功**？⇒ **已定（且原候选判据是错的）**。
  实测证明：`BDUSS` **和** `STOKEN`(+passport 域) 在登录成功的**同一瞬间**出现，
  **不能**靠「先出现 `BDUSS`、后出现 `STOKEN`」来分过程态与完成态
  （这两者同毫秒级）。可靠的判据是：
  1. **`BDUSS` 出现，且** 2. **`.kuku.baidu.com` 域的 `STOKEN` 出现**
     （§5.3.1：只有这个域那份能让 `homenew` 回 `errno=0`）；
  3. 建议再打一次**只读**端点（`homenew` 或 `getgfvipremain`）**验真** ——
     这一步才是真正的「可用性」判据，前两条只说明 cookie 到齐了。
  ⚠️ **旧候选判据「先 `BDUSS` 后 `STOKEN`」已被数据推翻**，不要再照它实现。

## 7. 相关文件

- 只读探针：`scripts/probe-kuku-credits.mjs`（`scripts/` 已 gitignore，仅本地）
- 领分实测脚本：`.tmp-kuku/r15-claim-login.mjs`（`.tmp-kuku/` 已 gitignore）
- **B1 最小原型 + U-E 实测**：`.tmp-kuku/r18-cdp-login-probe.mjs`
  （spawn 可见 chromium + CDP 轮询 cookie 时间线；日志 `%TEMP%\kuku-cdp-login.jsonl`）
- **CDP 通道支点验证**：`.tmp-kuku/r18-pivot-httponly.mjs`
  （自种 HttpOnly cookie 再读回，证明 `Storage.getCookies` 能读 HttpOnly 的值）
- **STOKEN 域陷阱实测**：`.tmp-kuku/r18-fix-stoken-domain.mjs`
  （四个变体对照，钉死「必须 kuku 域那份」）
- 早期否掉的路线（留档，避免重走）：`.tmp-kuku/r18-verify-cdp-cookies.mjs`（API 名探测）、
  `.tmp-kuku/r18-test-own-profile-encryption.mjs`、`.tmp-kuku/r18-why-cdp.mjs`
- 设计文档（**部分结论已被本文件推翻**）：
  `docs/superpowers/specs/2026-10-08-provider-capability-abstraction-design.md` §1.5 / §4

## 8. 共享浏览器会话：`src/chromium-session.ts`（2026-10-08 抽出）

库库AI 的登录（§5.2 定案的 CDP 方案）与 zcode 的 captcha **都需要同一套东西**：
启动一个受我们控制的 chromium、拿到它的调试端口、连上浏览器级 CDP 通道、
在结束时**把进程树杀干净**。这段实现原先整体长在 `src/zcode-captcha.ts` 里，
现抽成 `src/chromium-session.ts`，两家**共用一份**。

### 8.1 抽的是「编排」，不是协议

| 归 `ChromiumSession` | 归各自（不进共享模块） |
|---|---|
| 找浏览器可执行文件（候选链、Edge 兜底告警） | captcha：注入 SDK、抓 param、复用页池 |
| 选空闲调试端口 + 校验应答端口是自己 | 登录：cookie 罐、轮询判据、落盘 |
| spawn / 就绪轮询 / 端口错配的自保 | |
| 杀进程树（`taskkill /T /F`、POSIX 负 pid） | |
| 临时 profile 的退避重试删除 | |
| 窗口移出屏幕 / 移出任务栏（三平台） | |

⚠️ 差异全部收敛成**构造参数**，不靠子类或分支：
`label` / `notFoundHint` / `edgeLabel` / `overrideEnvName` / `profilePrefix` /
`windowSize` / `hideWindow` / `initialUrl`。zcode 传 `hideWindow: true`（全自动），
库库AI 登录传 `hideWindow: false`（**必须让用户看见并操作**，见 U-G）。

### 8.2 ⚠️⚠️ 抽共享实现最容易丢的东西：**用户可见文案**

重构把原先**写死在 `launch()` 里**的三段文案变成了构造参数。反向验证
（逐个改坏、看护栏红不红）实测：

| 变异 | 重构后的护栏 |
|---|---|
| 删掉 `notFoundHint` | ✗ **全绿**（漏） |
| `edgeLabel` 从 `'zcode captcha'` 改成 `'zcode'` | ✗ **全绿**（漏） |
| `label` 从 `'zcode'` 改成 `'browser'` | ✗ **全绿**（漏） |
| `overrideEnvName` 改名 | ✓ 变红 |

根因：子进程用例的判据是 `toContain('msedge.exe')` / `toContain('Edge')` /
`toContain('ZCODE_CHROME_PATH')` 这种**子串**断言，而**前缀与括注不在任何判据里**
⇒ 文案丢了、前缀变了，子串照样命中。

⇒ 已补源码判据逐个锚定这五个参数（`zcode-captcha-spawn-guard.spec.ts`）。
**教训（通用）**：把字面量改成参数时，「行为没变」不等于「输出没变」——
而输出正是用户唯一能看到的东西。**参数化一处字面量，就要锚定一处文案。**

### 8.3 ⚠️ 源码扫描型护栏**必须跟着实现文件走**

`zcode-taskbar-hide` / `zcode-browser-lifecycle` / `zcode-browser-detection`
这三份用例**扫的是源码文本**。抽走实现后若不改它们的 `SRC` 常量：

- `sourceScope().fn()` 会抛「找不到 function/method」——**吵闹**的失败，能被发现；
- 但 `SRC.toContain(...)` / `SRC.toMatch(...)` 这类**整文件**断言会在一个
  已不含该代码的文件上求值并**静默全绿**。

⇒ 「测试全绿」**不足以**证明护栏还在守。本次逐个变异验证了 **26 个**锚点
（`.tmp-kuku/r21-mutate.mjs`），其中揪出两条**既有**的假绿：

| 假绿 | 机制 |
|---|---|
| `dispose` 的「先杀进程再删目录」 | `indexOf` 找不到返回 **-1**，`-1 < 非负下标` 恒成立 ⇒ **删掉 `this.kill()` 照样绿** |
| 「wmctrl 不存在时静默」 | 只断言处理器**被接上**，从不看处理器**体** ⇒ 改成 `throw` 仍绿（异步处理器逃得出 `try/catch`） |

两条均已加护栏并复验。**通用教训**：`indexOf` 参与比较前必须先 `toBeGreaterThan(-1)`；
「某处理器存在」不等于「该处理器行为正确」。

### 8.4 zcode 侧的 `browserCdp` / `browserWs` 是**转发访问器**

`tests/unit/zcode-page-prepared.spec.ts` 直接往这两个字段注入桩，
故它们在 `ZcodeCaptchaBrowser` 上必须**可读又可写**，实现上转发到
`session.cdp` / `session.socket` —— 避免「同一个通道在两层各存一份」。
`port` 则是只读 getter（转发 `session.debugPort`）。

