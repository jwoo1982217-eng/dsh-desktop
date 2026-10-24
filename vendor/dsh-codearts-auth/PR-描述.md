# PR：MiniMax Code **国际版**渠道 + MiniMax 请求的**传输级重试**

一个功能 + 一个健壮性修复，合并为**单个提交**，便于一次性审阅：

```
feat(minimax): 新增国际站渠道（双站点共用实现）+ 传输级重试
```

---

## 一、为什么做

原 `minimax` 渠道只覆盖 **MiniMax Code 中国版**（`agent.minimax.cn`）。而 MiniMax Code
**国际版是独立的账号体系与独立的 API 主机**（`agent.minimax.io`），且国际站同样有
「每日签到送积分」的活动 —— 也就是说，只用中国版会**少一个可用渠道、也少一份每日积分**。

本 PR 把国际版作为**并列渠道**加上。

### ⚠️ 关键设计决策（请重点审阅）：为什么用**两个 provider id**，而不是
「单 id + 站点落在凭据里」

需求沟通过程中我先做过「同 id」方案，被否掉，最终确认走**双 id**。理由是**实测的**，
不是偏好：

1. **模型目录按 provider 缓存一份**。单 id 下两个站点会**争用同一份目录缓存**，
   于是另一站的模型要么进不了列表、要么被静默回退成本站模型；
2. **且 MiniMax 对不存在的模型名回 `HTTP 200` + 静默回退**（不是报错）——
   这意味着「回退错了」在界面上**完全看不出来**，用户会在国际站面板里看到中国站的
   模型名并以为可用。

⇒ 两个站点必须是两个 provider id：`minimax`（中国版，原有）、`minimaxintl`（国际版，新增）。
它们**共用同一套实现**（同一个适配器类、同一套 OAuth、同一套积分逻辑），
差异**全部**收敛在 `src/minimax-product.ts` 的一份产品常量里（只差 6 个字段：
`id` / `displayName` / `accountHost` / `apiHost` / `region` / `defaultCredentialRef`）。

---

## 二、做了什么

### 1. 新增国际站渠道 `minimaxintl`

`src/minimax-product.ts` 新增 `MINIMAX_INTL` 常量：

| 字段 | 中国版 `minimax` | 国际版 `minimaxintl` |
|---|---|---|
| `accountHost` | `account.minimax.cn` | **`account.minimax.io`** |
| `apiHost` | `agent.minimax.cn` | **`agent.minimax.io`** |
| `region` | `cn` | **`en`** |
| `defaultCredentialRef` | `MINIMAX_ACCESS_TOKEN` | **`MINIMAXINTL_ACCESS_TOKEN`** |
| 显示名 | `MiniMax Code (中国版)` | `MiniMax Code (国际版)` |

（账号凭据实际落在 `MINIMAX_ACCOUNT_*` / `MINIMAXINTL_ACCOUNT_*`，
上面的 `defaultCredentialRef` 只是单凭据时代的兼容缺省值。）

⚠️ **两个站点的账号不互通、API 主机也不同**（均已实测：跨站互打一律 401），
故它们是**两个独立面板** —— 各自在自己的面板里点「+ 新建账号」即可，**无需选择站点**。

### 2. ⚠️⚠️ 两站共用实现的**代价：一串接线点必须逐个到位**（请重点审阅）

这是本 PR **最容易出错的地方**，也是需求里明确的告警点：

> 两站共用适配器类 ⇒ `probeById` / `WRITES_RATE_LIMIT_PROVIDERS` / `SELF_HEAL` /
> ref 前缀表 / 积分表**每处都要两站到位**，漏一处**静默失效**。

本 PR 逐处补齐（**7 个宿主侧文件 + 2 个客户端文件**）：

| 接线点 | 文件 | 漏掉的症状 |
|---|---|---|
| 渠道声明 | `src/provider-registry.ts` | 面板**根本不出现** |
| 探测（「重测」按钮） | `src/index.ts` 的 `probeById` | ⚠️ 用**错误的主机**发探测 ⇒ 必然 401 ⇒ 限流标记**永远清不掉** |
| 适配器实例 + 续期目标 + `auths` 对象 | `src/index.ts` | 渠道不可推理 / 账号不自愈 |
| 自愈续期清单 + auth 接口 | `src/jet-hub-rpc.ts` | 过期账号在积分端点**永不自愈**（报「未登录」而上游只需一次 refresh），且**日志零字** |
| 凭据 ref 前缀表 | `src/jet-hub-store.ts` | 凭据读不出 / 归属错站 |
| 积分能力表 | `src/provider-credits.ts` | 积分行不显示 |
| 聚合参与渠道清单 | `src/aggregate-adapter.ts` | 它的模型**永不进聚合目录、静默不可见** |
| 客户端图标 | `plugin-src/client/provider-icons.js` | 图标缺失 |
| 客户端样式 | `plugin-src/client/jet-hub-styles.js` | 样式不生效 |

⚠️ 这些**都不是「看起来像坏了」的失败，而是静默失效**（界面缺项或功能不工作、
没有任何报错），故本 PR 的用例对它们**逐键点名**（见下「测试」）。

📌 **一处刻意的「不改」**：`src/provider-runtime.ts` **不需要**为国际版加条目 ——
它从 `PROVIDER_REGISTRY` 派生。加一份反而是多余的第二份真源。

### 3. 传输级重试（`fetch failed` 的真实缺陷）

**报障现象**：「模型连接测试失败，显示 `fetch failed`」「积分查询及领取失败」。

**本机取证**（同一凭据、同一端点、连打 10 次）：

```
签到 (signin/status): 成功 5/10 —— 失败全是
  fetch failed ← self-signed certificate in certificate chain [SELF_SIGNED_CERT_IN_CHAIN]
目录 (models)       : 成功 10/10
```

⇒ 环境里的 **HTTPS 检查代理**（企业 / 杀软 / 代理软件的 MITM 证书）约 **50%** 概率
打断到本家的请求。**这是环境问题，但症状落在插件上**：一次偶发中断 = 整轮请求失败。

**修法**：`src/minimax.ts` 新增 `minimaxFetchWithRetry` + `isMinimaxTransportError`，
**三处共用同一份**（不各写一份 —— 同义判据分两处必然漂移）：

- 推理（`src/minimax-adapter.ts` 的 `send()`）
- 目录（`src/minimax-auth.ts` 的 `fetchRawModels`）
- 签到 / 积分（`src/minimax-credits.ts` 的 `requestEnvelope`）

**效果实测**：裸 `fetch` **5/10** → 走本函数（插件真实代码路径）**10/10**。

**四条边界**（每条都做了变异验证，见下）：

1. **只重试传输错误，绝不重试 HTTP 状态错误** —— 4xx/5xx 是服务端的**明确答复**
   （401 要续期、402 要充值、429 要冷却），重发只会原样失败且掩盖真因；
2. **abort 绝不重试** —— 用户点了停止还继续发是**不可接受**的行为；
3. **真因在 `cause` 里** —— undici 把底层错误包成一句 `TypeError: fetch failed`，
   判据必须**沿 `cause` 链**找；只读 `message` 会漏掉
   `SELF_SIGNED_CERT_IN_CHAIN` / `UND_ERR_*` / `ECONNRESET`
   （变异验证：改成只读 `message` ⇒ **4 条用例变红**）；
4. **重试耗尽时抛最后一次的原错误对象** —— 保住 `cause` 链，真因仍可见
   （换成自定义文案会让用户再也看不到「自签证书」这类唯一出路）。

---

## 三、真机验证（国际版可用性）

⚠️ 提 PR 前必须说清一件事：**中途我曾把一次上游故障窗口误判为「国际站要求网关签名、
不可用」**，并据此写下过错误结论。该结论**已被证伪**，原因与教训已写进
`docs/agent-notes/providers-loomy-raccoon-minimax.md`：

> 决定性证据是**官方客户端自己也连不上**（`Code: 50112` = 官方 mcode 的
> `LLM_AUTH_ERROR` 枚举），且探针抓到的官方推理请求头**也只有 `Authorization: Bearer`**
> —— 与本插件实现逐字相同。故障恢复后，同样的请求**全部 200**。

改用真实国际站账号逐端点实测的结果：

| 端点 | 结果 |
|---|---|
| `POST /mavis/api/v1/llm/v1/messages`（推理） | ✅ **200 + 真实 SSE**（认证只需 `Authorization: Bearer`） |
| `GET /minimax-cloud/api/v1/signin/status`（签到） | ✅ **200**（真实签到面板） |
| `GET /minimax-cloud/api/v1/credit/details`（积分） | ✅ **200**（真实余额） |
| `GET /mavis/api/v1/models?region=en&buildEnv=prod`（目录） | ✅ **200**（4 个模型） |

⇒ 国际站与国内站**协议同形**，「两站只差 6 个字段、共用实现」成立。

⚠️ **但有一条判据必须记牢**：国际站的**目录端点当前是公开的**（无 token、垃圾 token
都返回 200，与国内站不同）⇒ **「能看到模型列表」不构成凭据有效的证据**。
凭据证据看**签到 / 积分 / 推理**三处。本 PR 的 e2e 探针把这一条写成了显式告警。

---

## 四、测试

### 新增单测（37 条）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `tests/unit/minimax-intl.spec.ts` | 23 | 两站产品常量差异（含「除 6 个字段外逐字段相同」）、ref 前缀反查（含**超串前缀**经典坑）、登录 / 续期 / 目录 / 积分 / 推理**各自打对主机**、跨站实例隔离（「各刷各的实例」） |
| `tests/unit/minimax-transport-retry.spec.ts` | 14 | 重试策略与**四条边界**（含 3 条反向断言：非传输错误不重试 / abort 不重试 / 认 `cause` 链） |

### 扩展既有守卫（18 个文件，逐键点名国际版）

⚠️ 光加新用例**守不住**上面那张接线表 —— 那些守卫是**既有的**「逐 provider 点名」
型用例，本 PR 把国际版**加进它们的期望集合**：

`provider-registry` / `provider-registry-consumers` / `provider-runtime-wiring` /
`refresh-bootstrap-wiring` / `jet-hub-rpc-auth-wiring` / `jet-hub-rpc-signature` /
`credits-runtime-parity` / `claim-runtime-parity` / `credits-balance-self-heal` /
`model-catalog-parity` / `credential-resolver` / `minimax-adapter` / `minimax-rpc` /
`buddy-ratelimit-misreport` / `lobsterai-rpc-dispatch` / `zcode-wiring`
＋ 两个 helper（`tests/helpers/provider-sets.ts` / `rpc-refresh.ts`）。

**判别力说明**：这些用例的期望集合**从 `PROVIDER_REGISTRY` 派生或逐键枚举** ——
少加一站的登记，它们会**变红**（这正是它们存在的意义）。本 PR 只改期望值、
不改被测源码，故「全绿」在这里是**有意义的**（不是把断言放宽换来的）。

### 新增 e2e 探针（有闸门，默认跳过）

| 文件 | 说明 |
|---|---|
| `tests/e2e/minimaxintl-probe.e2e.spec.ts` | **只读**：目录 + 签到状态 + 积分余额（**不领取**） |
| `tests/e2e/minimaxintl-claim-probe.e2e.spec.ts` | 真实领取签到积分（状态先行，已领则跳过，不白烧当天机会） |

⚠️ 两个探针**刻意不硬断言**「恰好 4 个模型」：国际站远端模型集与国内站不同，
硬断言会在上游调整模型时假红；判据只到「请求发出去了、并拿到了可解读的响应」，
实际内容**打印**给人核对。

### 反向验证（变异必须变红）

| 变异 | 结果 |
|---|---|
| 去掉「只重试传输错误」闸门 | 1 条变红 |
| 删掉 abort 判断 | 1 条变红 |
| 判据改为只读顶层 `message`（不走 `cause` 链） | **4 条变红** |

---

## 五、验证

| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.json --noEmit` | 通过 |
| `tsc -p tsconfig.tests.json` | 通过 |
| `pnpm test` 全量 | **8401 passed / 0 failed / 21 skipped** |
| 国际版 e2e 探针（真机） | **4/4 通过** |
| `pnpm build:all`（tsc + copy-assets + client 打包） | 通过 |

⚠️ 全量测试的 `21 skipped` 是本仓库**既有的**按 provider 分列的 e2e 闸门（默认跳过），
不是本 PR 引入的。

---

## 六、说明

- 本 PR 基于最新的 `origin/master`（已合并全部 13 个上游提交，无冲突遗留）。
- 不含任何本机路径、用户名、凭据或 token —— 文档里出现的 `~/.minimax/auth/...`
  一类均为**通用 Home 相对路径**。
- `docs/agent-notes/providers-loomy-raccoon-minimax.md` 里同时登记了
  本次的**误判与教训**（上面第三节），供后来者不要再走同一条弯路。
