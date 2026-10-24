# PR #118 审计报告：AStudio 接入 + autoclaw 非法档位修复

> 审计对象：Gitee PR #118（作者 yakumo12）`feat(astudio): 接入 AStudio（讯飞 AstronStudio）Provider + 修复 autoclaw 非法思考档位静默计费`
> head 分支 `feat/astudio-provider`（`be20d565`），base `master`（`25af1eb`）
> 本地合并提交：**`8b1ef43`**（`merge: 合并 master (25af1eb) 到 feat/astudio-provider`，冲突 1 处已解决）
> 审计日期：2026-10-18

## 0. 环境与基线

| 项 | 结果 |
|---|---|
| 合并冲突 | 仅 1 处：`tests/unit/aggregate-adapter.spec.ts` 的 describe docstring。master 侧新增 `warmCatalog()` 辅助函数，PR 侧新增 `AGGREGATE_EXEMPT_PROVIDER_IDS` 豁免集并改写措辞 ⇒ **两侧内容全部保留** |
| `pnpm test`（合并后全量） | **9640 passed / 6 skipped / 0 failed**（381 文件通过 + 1 跳过） |
| `pnpm typecheck` | 0 error |
| `pnpm build:client` | 通过（注册 id `dsh-providers-hub`，与 `package.json.name` 一致） |

审计方式：1 轮常规审计 + 1 轮对抗性审计（变异验证），各自在**独立 git worktree** 中进行（`dh-wt-audit` / `dh-wt-adv`），主工作区全程只读、结束时零污染。

## 1. 结论摘要

**描述的问题①「接入 AStudio provider」——接线完整、测试充分，但未完全解决**：存在 1 条 P1 功能缺陷（硬编码作者本机路径），使"一键导入本机凭据"这条**默认登录路径**对非作者机器 100% 失败，且报错文案误导。

**描述的问题②「修复 autoclaw 非法档位静默计费」——已解决**，且作者自称的三处变异**逐条复现**。

**其他问题**：3 条 P1、6 条 P2、4 条 P3。其中最值得注意的是**同型同构的另一半（astudio）档位拦截整条链路零守卫**，以及**一处只有合并最新 master 才暴露的恒真守卫**。

| 级别 | 数量 | 编号 |
|---|---|---|
| P1 | 3 | P1-1 硬编码本机路径；P1-2 astudio 档位拦截零守卫；P1-3 播报档位 ≠ 门禁档位 |
| P2 | 6 | P2-1 豁免守卫恒真（合并暴露）；P2-2 autoclaw warn 生产接线零守卫；P2-3 `saveCredential` 留痕零守卫；P2-4 注释与实现相反；P2-5 auth 格吞掉指路文案；P2-6 新笔记未登记索引 |
| P3 | 4 | P3-1 `inputModalities` 动态变 image 但无上行通路；P3-2 播报与门禁的档位集合口径不一；P3-3 `displayName ≠ label`；P3-4 纯函数对非字符串输入无防御 |
| 描述失实 | 3 | 「`inputModalities` 恒 `['text']`」；「181 例」实为 178；「上游全量守卫同步」无法验证 |

## 2. P1（必须修）

### P1-1 硬编码作者本机路径，默认登录路径对普通用户必然失败

- **位置**：`src/astudio-product.ts:223`
  ```ts
  sessionFilePath: 'E:\\Users\\lin1\\AppData\\Local\\Programs\\AStudio Data\\userdata\\astron-session.json',
  ```
- **消费链（唯一，无动态推导）**：`src/astudio-auth.ts:119-126` 的 `astudioSessionFilePath` —— env 有覆盖就用 env，否则 `return product.sessionFilePath`（**没有任何基于 `os.homedir()` / `%LOCALAPPDATA%` 的推导**）。
- **触发路径**：客户端默认档就是它 —— `plugin-src/client/jet-hub.js:2783` `useState('local')`、`:4312` 卡片「⚡ 一键导入本机桌面端凭据」、`plugin-src/client/new-account.js:120` `astudioLoginMethod ?? 'local'` ⇒ `account.create` 走 `src/jet-hub-rpc.ts:4600-4611`，`importLocalSession` 读不到就抛。
- **后果比"报错"更糟**：`src/astudio-auth.ts:827-830` 的文案写
  > 「未在本机找到可用的 AStudio 登录会话（astron-session.json 不存在、不可读，或缺少 modelBearerToken）。**请先启动 AStudio 客户端并登录**，再新建该账号。」

  而真实原因是**插件在看一个用户机上不存在的路径**。用户客户端本来就登录着，照做**永远不成功**，且无法从文案推知唯一自救手段（`DSH_ASTUDIO_SESSION_FILE`）。
- **零守卫**：`tests/unit/astudio-auth.spec.ts:367-371` 只断言 `astudioSessionFilePath({}) === ASTUDIO.sessionFilePath` —— 这是**对常量自身的同义反复**，把路径改回硬编码也不会红。
- **修法（仓库已有现成先例，直接照抄）**：`src/chromium-session.ts:56,78` 用 `env.LOCALAPPDATA` 拼接；`src/zcode.ts:16` 同法登记 `%LOCALAPPDATA%\Programs\ZCode\…`。即
  ```ts
  join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
       'Programs', 'AStudio Data', 'userdata', 'astron-session.json')
  ```
  保留 `DSH_ASTUDIO_SESSION_FILE` 覆盖。
- **建议补的守卫**：断言默认 `sessionFilePath` **不含固定盘符/用户名段**（或落在 `homedir()` / `LOCALAPPDATA` 之下）——否则这类"作者机路径"永远无人发现。

### P1-2 astudio 的档位本地拦截整条链路零守卫

- **位置**：`src/astudio.ts:1078`（`astudioEffortForRequest`）+ 调用点 `src/astudio-adapter.ts:356-364`（门禁）、`:383`（下发）。
- **事实**：该函数在任何测试文件里**零直接调用**；`reasoning_effort` / `reasoningEffort` 在 `tests/unit/astudio-*.spec.ts` 里**零命中**；4 份 astudio spec（178 例）中**没有一条**档位用例。
- **实证（变异）**：把门禁整块换成裸透传（保留 `undefined` 守卫）+ 删掉留痕 ⇒
  - 定向 5 份 spec：**226 例全绿**
  - 全量 `tests/unit`：**零红**（与干净基线逐例一致）
- **对照**：同 PR 的 autoclaw 侧同一位置有 3~7 条用例变红。
- **后果**：PR 自称"两家同为『非法值静默按最大档跑』，判据必须都在本地"——**判据在，守卫不在**。这里若发生真回归（例如有人把 `decision.effort` 改回 `String(options.reasoningEffort)`），CI 全绿，而上游对非法档位回 200 并按最贵档跑，用户为 max 付钱却看到"未思考"。
- **修法**：把 `tests/unit/autoclaw.spec.ts:1094` 起的 `describe('★★ 思考档位本地拦截')` 同型复制到 astudio（集合内原样发 / 集合外不发 / 丢弃留痕 / 合法档位无告警 / 未指定不发 / 判据本身）。

### P1-3 「播报的档位」与「门禁的档位」不是同一份数据（潜伏）

- **位置**：门禁读 `declared?.efforts`（**原始数组**，`src/astudio-adapter.ts:358`）；而宿主被告知的是 `astudioReasoningOf()` 的输出（`src/astudio-adapter.ts:262` 调用 → `src/astudio.ts:736-745`），后者有「只有 `defaultEffort` ⇒ **单档**」这一腿。
- **端到端实证**（临时探针，已删）：
  ```
  播报（resolveModel）: ["high"]
  实际上行 reasoning_effort = undefined
  warn = ["[astudio] 丢弃思考档位 high：上游目录未对该模型声明任何思考档位"]
  ```
  ⇒ 远端只给 `default_reasoning_level` 而不给 `supported_reasoning_levels` 时，用户**唯一可选**的档位被丢弃，且 warn 文案本身是**假的**（该模型确实对宿主声明了 `['high']`）。
- **同族不一致**：autoclaw 无此分歧（播报与门禁共用同一常量 `AUTOCLAW_DECLARED_EFFORTS`）。
- **可达性**：本家远端当前恒给档位数组（fact 380），故属**潜伏**；但 `astudioReasoningOf` 刻意实现了单档形态、`astudioCatalogToFallback`（`src/astudio.ts:1173`）原样保留它，同仓库兄弟渠道 accio 有 6 条这样的模型。
- **修法**：门禁改用与播报同源的集合（即 `astudioReasoningOf(...).efforts.map(e => e.id)`），不要读原始字段。

## 3. P2（应当修）

### P2-1 新豁免守卫的「僵尸豁免探测器」恒真 —— **只有合并最新 master 才暴露**

- **位置**：`tests/unit/aggregate-adapter.spec.ts:177-222` 的用例③（断言豁免项不出现在聚合实际拉取的渠道里），其 docstring `:70-72` 自称"将来把某家加进 `AGGREGATE_CHANNELS` 而忘了清空本集合 ⇒ 豁免用例立刻变红并点名"。
- **实证无牙**：把 `'astudio'` 加进 `src/aggregate-adapter.ts` 的 `AGGREGATE_CHANNELS` ⇒ `aggregate-adapter.spec.ts` **132 passed / 0 failed**（全绿）。
- **根因**：用例③的 `:205-206` **漏了 `await warmCatalog(adapter)`**，而同文件其他用例都有它。master 侧的 `a80ab4a`（"目录加载不同步等上游"）引入 `catalogForListModels` 后，**冷调 `listModels` 不再同步扇出** ⇒ 打印实测 `AUDIT-SEEN=["codearts","buddy","workbuddy"]` ⇒ `seenSet.has('astudio')` 恒为 `false`，与白名单内容无关。
- **为何只有合并才暴露**：PR head（`be20d565`）的该文件里 `await warmCatalog(` 出现 **0 次**（作者最后一次 merge 上游停在 `82da5df`，早于 `a80ab4a` / `d461068`）；master 有 28 次。合并后 PR 的用例③落到新契约下即恒真。
- **生产无漏洞**：真正的兜底是 `tests/unit/expiry-runtime-parity.spec.ts:226`，同一变异下 **1 failed**（点名 astudio 不在 `WIRED_EXPIRY_PROVIDERS`）。
- **修法**：用例③的 `adapter.listModels(...)` 前补 `await warmCatalog(adapter)`（保留反向真子集断言）。

### P2-2 autoclaw 的 `warn` 生产接线零守卫

- **位置**：`src/autoclaw-adapter.ts:626`（`warn: options.warn ?? ((m) => { ctx.logger.warn(m) })`）。
- **生产当前正确**，但把兜底改成 `() => {}` 后**全量 9630 例零红**。原因：`tests/unit/autoclaw.spec.ts:1112` 自己注入了 `warn`，永远走不到 `??` 兜底分支。
- **后果**：将来有人删掉这一行，"丢弃留痕"在**生产**上静默消失而测试仍全绿。
- **同族不同构**：astudio 侧的 warn **不在** `registerAstudioLlm` 内（`:528-534` 不传，兜底是 `console.warn`），而是在调用点 `src/index.ts:2359` 注入。

### P2-3 `saveCredential` 的「写回失败必须留痕」零行为守卫，且文本断言可被注释满足

- **位置**：`src/astudio-auth.ts:454-462`；断言 `tests/unit/astudio-auth.spec.ts:180` 的 `/warn|logger/`。
- **实证**：`FakeStore.set`（`astudio-auth.spec.ts:85-88`）**永不抛错** ⇒ catch 体在测试里不可达。删掉真实 `this.warn(...)`、只留一句含 `"warning"` 的**注释** ⇒ 定向 53 绿 + 全量绿。
- 该防线今天靠"人不会删"，不靠守卫。

### P2-4 注释与实现相反（`claim` 能力）

- **位置**：`src/provider-credits.ts:468-470` 写「⚠️ **刻意不提供 `claim`**：AStudio 没有签到端点，能力矩阵里 `dailyCheckin: false` ⇒ 客户端根本不渲染「一键领取积分」」，而紧接 `:475-476` 就实现了 `claim: async (c) => await claimDaily(...)`；`src/provider-registry.ts:460` 是 `dailyCheckin: true`；客户端**会**渲染按钮（`plugin-src/client/credits-capabilities.js:65-80` 从 registry 派生）。
- **成因**：被本 PR 自己的文档推翻的旧结论残留 —— `docs/agent-notes/providers-astudio.md:66-81` §3 明确记录"推翻早期『AStudio 无签到端点』的推论"。
- **影响**：非运行时缺陷，但按注释删掉 `claim` 会**静默**干掉一键签到（客户端照旧渲染按钮 ⇒ 点了报错），属"一文件两套同义判据/注释说谎"形态。
- **修法**：删 `:468-470`，改为指向 `providers-astudio.md` §3。

### P2-5 auth 格用 `AUTH`，吞掉"去客户端重新登录"这句唯一指路文案

- **位置**：`src/astudio.ts:560` auth 格 `llmCode: 'AUTH'`，文案含「仍失败请在 AStudio 客户端重新登录」；适配器终态同样抛 `AUTH`（`src/astudio-adapter.ts:429-433`）。
- **仓库红线**：`src/officeace-lock.ts:312-316`「错误码必须避开 `AUTH`/`QUOTA`/`ACCOUNT_QUOTA`：DSH 客户端会把这三个码的报文整段替换成通用文案……（本仓库红线）」；`docs/agent-notes/client-ui.md:164` 取证于 `@deepseek-ai/dsh-client-ui-chat/lib/client.js:1229-1234` 并标注「**通用教训，不限本 provider**」。
- **自洽性检查**：同文件 `:561-565` 的 `model-not-found` 刻意选 `PERMISSION_DENIED`，理由写「保住上面那句真实原因」；`:522-523` 同义 ⇒ **同一条标准下 auth 格应当同样避开 `AUTH`**。作者给 auth 格的理由（`src/astudio.ts:518-523`「本家确实要用户去重新登录，所以这条替换在 auth 格是可接受的」）不满足红线的原始判据 —— 红线判的是「**文案本身就是出路**」，而本家的出路是"到 AStudio 桌面端用微信重新登录"，不是"改一个 API 密钥"（本家凭据从不经 DSH 输入）。
- **如实降级为 P2 的理由**：Jet Hub 面板的 AStudio 卡片另有指路（`src/astudio-oauth.ts:69-77` 的 `ASTUDIO_MANUAL_RELOGIN_HINT` / `ASTUDIO_NO_LOCAL_SESSION_MESSAGE`，后者含 env 提示）⇒ 属**指引质量下降**而非死路。
- **诚实标注**：替换机制本身在闭源客户端，`node_modules/@deepseek-ai` 全量 grep「密钥无效」零命中 ⇒ 引用的是仓库文档化的红线，**未实测到替换行为本身**。
- **修法建议**：终态两处改用不被替换的码，例如 `INVALID_CREDENTIAL`（`@deepseek-ai/dsh-llm/lib/types/error.d.ts:33-40` 明说它「Deliberately outside the default retryable set」、语义正是"凭据被拒"）；首跳 401 的内部重取路径不动。

### P2-6 新增笔记未登记进 AGENTS.md 索引

- **事实**：`AGENTS.md` 全文 `astudio|AStudio`（忽略大小写）**零命中**；AGENTS.md 的「深细节索引」引用 **17** 份笔记，`docs/agent-notes/` 实有 **19** 份，差集 = `providers-astudio.md`（本 PR）+ `pr102-manual-acceptance.md`（既有）。
- **后果**：AGENTS.md 自己规定「改某 provider 前先读它的笔记」「触发条件命中时才读对应文件」，而这份 81 行笔记是本 PR 全部协议事实的唯一登记处（双域不共用前缀 / `/model-gateway/v1/models` 恒 404 / HTTP200+code 信封 / 80000 终态 / 非法档位按最贵档跑 / context-window 与 max_output 实测表）。索引缺失 = 后续维护者按 AGENTS.md **找不到它**。
- **修法**：在 AGENTS.md 索引补一行，并把「双域不共用前缀 / 80000 走终态 / 非法档位按最贵档」三条要点写进同一行。

## 4. P3 / 观察项

- **P3-1 `inputModalities` 会动态变成 `['text','image']`，而本家没有图片上行通路**：`src/astudio-adapter.ts:244` 是 `model.supportsImage === true ? ['text','image'] : ['text']`（**不是** PR 描述所称的"恒 `['text']`"），而 `supportsImage` 取远端 `input_modalities` 是否含 image（`src/astudio.ts:1175`）。astudio **没有** `readImage` 注入（`src/index.ts:2338` 明确说明；对比 accio/autoclaw/buddy 都有）。⇒ 若上游某个模型声明 image，我们会声明支持图片但发不出图，模型收到纯文本 ⇒ **幻觉**坑（accio 笔记记载的同型形态）。当前不可达（远端六模型全 text、兜底表 `supportsImage` 全 false）。**PR 描述"上游加视觉模型即自动生效"把"声明生效"误当成了"能力生效"。**
- **P3-2 播报与门禁的档位集合口径不一**：同一模型 `listModels` 给 `undefined`、`resolveModel` 给 `["high"]`（见 P1-3）。
- **P3-3 astudio 是全表唯一 `displayName ≠ label` 的 provider**：`src/provider-registry.ts:455-456`（`label: 'AStudio (讯飞)'` / `displayName: 'AStudio'`，其余 20 条逐条相同）。且 `src/astudio-product.ts:215` 注释把"rail 宽度算式依赖它"挂在 `displayName` 上，实际 rail 用 `label`（`plugin-src/client/jet-hub.js:175-182`）。守卫只覆盖 zcode（`tests/unit/zcode-wiring.spec.ts:420-424`）。
- **P3-4 两个纯函数对非字符串输入无防御**：`autoclawEffortForRequest` / `astudioEffortForRequest` 收到 `number/boolean/array/object/symbol` 会抛 `requested.trim is not a function`（当前不可达 —— 两个调用点都先 `String(...)`，但该隐性契约无守卫）。另 `declared` 传字符串会退化成子串匹配（`declared='max'` 时 `'ax'` 被判合法）。
- **观察项（非缺陷）**：`src/provider-credits.ts` 注释称自愈豁免表"刻意豁免的两家"，实际表里有三家（+modelscope）—— 既有代码问题，非本 PR 引入。
- **观察项（非缺陷）**：四个 1M 模型用 `contextWindow: 1_000_000`（上游标称），而文档登记真网硬上限 1,024,000。取标称是**保守**的（更早触发溢出压缩），代码里没写明该取舍，只有 doc 有。

## 5. 验证通过的点（审计的"绿"）

| 面 | 结论 |
|---|---|
| 接线完整性（10 个点） | **无漏接**。`provider-registry.ts:454-464`、`index.ts` 的 import/构造/`stop()`/`modelAdapters`/能力注册表/`auths`、`SELF_HEAL_REFRESHABLE_PROVIDERS`（`jet-hub-rpc.ts:2218`）、`jet-hub-store.ts:1008` 前缀表（**同款坑第六次**，已登记）、`provider-credits.ts:472-478`、客户端三处（图标/CSS/弹窗分支，均从 registry 派生）。`provider-runtime.ts` 本就没有 per-provider 表（实例由 `index.ts:3823-3854` 的循环注册）⇒ 不是漏接 |
| 聚合「有意不接」 | 登记在两处（`aggregate-adapter.ts:1168-1172` + 测试豁免集 `aggregate-adapter.spec.ts:91`），且与 `WIRED_EXPIRY_PROVIDERS` 自洽；真兜底守卫 `expiry-runtime-parity.spec.ts:226` **有牙**（变异下 1 failed） |
| `SELF_HEAL` 自愈接线 | 删掉 `ASTUDIO.id` 行 ⇒ `credits-balance-self-heal.spec.ts` **4 failed**（含"每个有余额能力的渠道都必须在自愈 Set 里"）⇒ **有牙** |
| autoclaw 修复 | 判据三情形齐全（集合外丢弃 / 未声明也拦 / 未指定不发）；集合同源（`autoclaw-product.ts:203` 同时被声明侧 `:349` 与判据侧 `:475` 使用）；`warn` 接在**生产**默认路径。**作者自称的三处变异逐条复现**（裸透传→红、`if(false)` 短路→红、判据短路→3 红）；另有反向变异（合法档位也丢→红）⇒ **双向有牙** |
| 端点级打穿 | 21 类畸形输入（`HIGH`/`High`/`hıgh`/`high\0`/`\u200Bhigh`/`high\u200B`/`42`/`true`/数组/对象/`Symbol`）下，两家返回值**从未落在声明集合之外**；大小写与不可见字符一律 fail-closed；NBSP/全角空格/`\n` 被 `trim` 后放行（语义正确）。无输入能让"丢弃"判定失效 |
| 错误码分类 | 质量高：`model-not-found`→`PERMISSION_DENIED`（保住原文 + 在 `dead-model-store` 的 `IGNORED_CODES` 里 ⇒ 不误记"已下架" + 不在 `DEFAULT_RETRYABLE_CODES` ⇒ 不白退避）；`quota`→字面量 `QUOTA_EXCEEDED`（避开 harness 的 `'QUOTA'` 常量）；`rate-limit`→`RATE_LIMITED`→经唯二改名表→`RATE_LIMIT`（`src/astudio.ts:554-584`、`astudio-adapter.ts:93-101`） |
| 登录分支数据安全 | 三段式（`persistLogin` 与 `pool.updateAccount` **分开两个 try**）+ 单飞表 `astudioExchangeInFlight` + `failLogin` 三态（`jet-hub-rpc.ts:2920`：先判 `loginCredentialLanded`、`entry==='unknown'` 不删号"宁可留卡片"）⇒ 符合历史上被两轮独立审计打穿后的修法，**未复现"登录成功却删号"** |
| 本地 Carrier Server 安全 | `listenOnRandomPort` 用 `server.listen(0, '127.0.0.1')` —— **只监听回环 + 随机端口**（不是通配地址）；`readJsonBody` 有 **64 KB** 上限；无 CORS 通配头 ⇒ **通过** |
| 目录骨架兼容 master 新契约 | 用 `createModelCatalog` 共享骨架（三态 + `listAllModels` 同步契约），已实现 `prepareCall`（PR!66 要求）；`syncCatalogEntries` 冷缓存返回兜底表 6 条（非空）⇒ 与 `a80ab4a` 后的"冷调不扇出"契约**兼容**；`model-catalog-parity.spec.ts` 的 CASES 已加 astudio 条目（零网络），且 `CASES` 从 `PROVIDER_REGISTRY` 派生 ⇒ 漏加会红 |
| 客户端位置参数隔离 | astudio 占第 4 位、autoclaw 第 5 位，`new-account-dialog.spec.ts` 有行为用例（"恰好一个专属字段"+ 双向串台反向断言） |
| `inputModalities` fail-closed | 缺省时 `?? []` ⇒ 判为不支持（**不是**"省略=未知=放行"）⇒ 正确 |

## 6. PR 描述与事实不符处（3 条）

1. **「`inputModalities` 恒 `['text']`」** —— 代码是 `model.supportsImage === true ? ['text','image'] : ['text']`（`src/astudio-adapter.ts:244`），会随远端动态变（见 P3-1）。
2. **「astudio 侧 4 份 spec（登录/凭据/流式/错误，181 例）」** —— 实测 **178**（auth 53 + errors 38 + stream 36 + login-credits 51）。
3. **「上游全量守卫同步」** —— 未给出判据，无法验证。

## 7. 方法论与证据强度

- 两轮审计各自在独立 worktree 中执行（`dh-wt-audit` / `dh-wt-adv`），主工作区全程只读；结束时 `git status --short` 在两处均为**空**。
- 变异纪律：每次变异后打印**实际被改动的片段** + `git diff --stat` 确认落地，**无 PATCH-NOT-APPLIED**；基线（干净树）与各变异的全量结果逐例对比。
- PR 引用的取证文档**真实存在**且内容吻合：`docs/audit/pr111-autoclaw-audit.md:26` 的取证表确实写着「非法档位值是否被拒 | ❌ **不被拒**（turbo/ultra/off 全 200）| 真实请求」。
- **如实的证据强度标注**：
  - P1-3 / P3-1 是**潜伏**（当前远端与兜底表都不可达），靠代码路径与旁证支持；
  - P2-5 的报文替换发生在闭源客户端，**未实测到替换行为本身**，引用的是仓库文档化的红线；
  - P1-1 的"非作者机 100% 失败"由默认档位链（客户端默认 `'local'`）+ 无动态推导推出，**未在真机验证**；
  - 未做 e2e / 真机验证；`spark-x2.5-4b` 等远端新条目能力数值、图片通路均未真机复核。
- 环境坑（供他人复现）：audit worktree 的 `node_modules` 是目录联接，`pnpm vitest run` 会触发 pnpm 自动安装并报 `workspace hoist directory is not a real directory`；改用 `node node_modules/vitest/vitest.mjs run <spec>`。

## 8. 复现与残留物

```powershell
# 复现主结论（在任一 worktree 或主工作区）
node node_modules/vitest/vitest.mjs run tests/unit/astudio-auth.spec.ts `
  tests/unit/astudio-errors.spec.ts tests/unit/astudio-stream.spec.ts `
  tests/unit/astudio-login-credits.spec.ts tests/unit/autoclaw.spec.ts

# 复现 P2-1（把 astudio 塞进 AGGREGATE_CHANNELS 后豁免用例仍全绿）
node node_modules/vitest/vitest.mjs run tests/unit/aggregate-adapter.spec.ts        # 期望被抓住，实测 132 passed
node node_modules/vitest/vitest.mjs run tests/unit/expiry-runtime-parity.spec.ts    # 真正兜住：1 failed
```

本地残留物（审计用，可随时删除）：

```powershell
git worktree remove --force D:\jet\code\js\dh-wt-audit
git worktree remove --force D:\jet\code\js\dh-wt-adv
```

合并结果落在分支 `pr118-astudio` 的提交 `8b1ef43`（本地，未推送）。

---

# 第二部分：本地修复与变异验证（2026-10-18）

修复提交 **`f09a2e7`**（在 `8b1ef43` 之上），随后追加注释订正提交。
`pnpm test`：**9653 passed / 6 skipped / 0 failed**（修前 9640，差额 = 新增守卫 13 例）；`pnpm typecheck` 0 error；`pnpm build:client` 通过。

## 9. 修复清单

| # | 项 | 改动 | 位置 |
|---|---|---|---|
| 1 | **目录 20 分钟 TTL 未接入**（用户关注的"模型列表定期更新缓存"） | 入口加 `isCatalogFreshFor` gate；**仅成功时**写新字段 `catalogAt`；`now` 可注入（与其余 11 家同款约定）；失败冷却与 TTL 统一到同一份可注入时钟（原冷却用 `Date.now()`） | `src/astudio-adapter.ts` |
| 2 | **后台目录刷新器未接入** | `createModelCatalog` 补 `refresh` 回调；适配器新增 `refresh()` 实例成员转发 `this.catalog.refresh?.()`（`index.ts:3566` 的 `refreshOf` 唯一入口） | 同上 |
| 3 | **硬编码开发机 session 路径**（P1-1） | 新增 `defaultAstudioSessionFilePath(env)` 按 `LOCALAPPDATA` 推导（缺失回落 `homedir()`）；`ASTUDIO.sessionFilePath` 改为**可选**且不再持有字面量；`astudioSessionFilePath` 的回落改为**按传入 env 推导**（原为读静态字段 ⇒ 两个输入不同源、默认值那一腿测不动） | `src/astudio-product.ts`、`src/astudio-auth.ts` |
| 4 | **门禁档位与播报档位不同源**（P1-3） | 门禁改用 `astudioReasoningOf()` 的输出（含"只有 `defaultEffort` ⇒ 单档"腿），不再读原始 `efforts` | `src/astudio-adapter.ts` |
| 5 | **守卫补齐** | 新建 `tests/unit/astudio-catalog-effort.spec.ts`（12 例：目录 TTL 4 + 强制重拉/刷新入口 2 + 档位拦截 6）；`astudio-auth.spec.ts` 补 session 路径**行为**断言（原断言是对常量的同义反复） | tests |
| 6 | 注释失实（P2-4） | `provider-credits.ts` 的 astudio 段订正（原文称"刻意不提供 claim / dailyCheckin: false"，而同段就实现了 claim、registry 也是 true） | `src/provider-credits.ts` |
| 7 | 豁免守卫恒真（P2-1） | `aggregate-adapter.spec.ts` 用例③补 `await warmCatalog(adapter)`（Task 7 后冷调不再扇出 ⇒ 原断言恒真） | tests |

## 10. 变异验证（每项独立注入，跑完还原）

判据：把守卫**删腿/改坏**后，其声称会红的用例必须真红。按**行号**替换（规避 CRLF 静默不生效与子串歧义），每次替换后**重读该行**确认落地（无 `PATCH-NOT-APPLIED`）。

| 变异 | 目标 | 期望红的用例 | 实测 |
|---|---|---|---|
| M1 | 禁用目录 TTL gate（`&& false`） | 满 20 分钟必须重拉 | **3 failed / 9 passed** ✅ 有牙 |
| M2 | `refresh()` 改名（去掉刷新器入口） | 必须暴露 `refresh()` | **1 failed / 11 passed** ✅ 有牙 |
| M3 | 档位判据短路（`true \|\| set.includes(...)`） | 集合外不发该字段 | **2 failed / 10 passed** ✅ 有牙 |
| M4 | 门禁改回读**原始** `efforts`（P1-3 回归） | 单档模型必须放行 | **1 failed / 11 passed** ✅ 有牙 |
| M5 | session 路径改回硬编码（P1-1 回归） | 默认路径必须按当前用户推导 | **2 failed / 52 passed** ✅ 有牙 |
| M6 | `refreshCatalog` 只删 `catalogAt = 0` | 必须无视 TTL 真重拉 | **0 failed / 12 passed** ⚪ **无牙**（见下） |
| M6' | `refreshCatalog` **两条清腿都删** | 同上 | **1 failed / 11 passed** ✅ 有牙 |
| M6'' | `refreshCatalog` 只删 `remoteModels = undefined` | 同上 | **0 failed / 12 passed** ⚪ **无牙**（见下） |
| M7 | 把 `astudio` 塞进 `AGGREGATE_CHANNELS` | 豁免用例③点名 | **22 failed / 110 passed** ✅ 有牙（P2-1 修复生效） |

### 如实登记：M6 / M6'' 是**互为冗余的两条腿**，不是漏判据

`loadModels` 的 gate 是**合取** `remoteModels !== undefined && isCatalogFreshFor(…)`，
而 `isCatalogFresh` 对 `at === 0` **恒判陈旧**（`model-catalog.ts:255`）
⇒ 清掉任一条都足以让 gate 失效，故**单独删任一条行为逐例不变**；**两条都删**才退化。
⇒ `refreshCatalog` 的不变式是「**至少清一条**」而非「必须清某一条」。
两条都保留是防御（与新增的 `catalog.refresh` 回调同款写法），但**已在代码注释与用例注释里
订正为"不得把任一条单独说成承重腿"** —— 初版注释把 `catalogAt = 0` 写成承重腿，
那是**假因果**（本仓库明令的失效形态），已由本轮的变异实测推翻并订正。

## 11. 本次修复**未**覆盖、需要单独决策的项（如实登记）

1. **master 侧的目录刷新器对全部 12 家都是空转**：`src/index.ts:3566` 调
   `adapter.refresh?.()`，而实测 12 家适配器**原型上都没有 `refresh` 成员**
   （`model-catalog.ts:509` 的 `ModelCatalog.refresh` 只在 **catalog 实例**上，
   不会自动变成适配器成员）；`catalog-refresher-wiring.spec.ts` 的 2 条用例
   **只断言"武装日志"**，没有任何一条断言"真的刷了某家"。
   本次只给 **astudio** 补了该成员 ⇒ astudio 成了**唯一**真正接入的家。
   ⚠️ 一并修 11 家会改动 master 侧 11 个适配器，超出本 PR 范围，建议单独开 PR
   （并同时补一条"至少一家真的被刷"的行为守卫）。
2. **P2-5（auth 格用 `AUTH` 吞掉指路文案）未改**：改动错误码会影响 harness 的
   重试语义（`AUTH` 不在 `DEFAULT_RETRYABLE_CODES`），需要与产品取舍一并决定；
   报告里给了建议（改用 `INVALID_CREDENTIAL`）。
3. **P2-6（`providers-astudio.md` 未登记进 AGENTS.md 索引）未改**：AGENTS.md 有
   111 KB 的并发编辑风险，建议由维护者手工插入一行。
4. **P3-1（`inputModalities` 会随远端变 `['text','image']` 而本家无 `readImage`）未改**：
   当前不可达（远端六模型全 `text`、兜底表 `supportsImage` 全 false）。
   若要修，方向是"无图片上行通路时恒报 `['text']`"或补 `readImage` 注入。
5. **P3-3 / P3-4 未改**（`displayName ≠ label`、纯函数非字符串输入无防御）：
   前者是产品观感取舍，后者当前不可达。

## 12. 用户问题的直接回答（"新 provider 是否接入公用缓存"）

| 机制 | astudio 修前 | 修后 |
|---|---|---|
| 目录 20 分钟 **TTL 缓存**（`isCatalogFresh` / `isCatalogFreshFor`） | ❌ **未接入**（`loadModels` 只判 `remoteModels !== undefined` ⇒ 拉到一次永不重拉；`invalidateCatalogCache` 对本家完全无效） | ✅ 已接入 |
| 后台 **20 分钟目录刷新器**（`createCatalogRefresher`） | ❌ 未接入（且 master 侧 12 家全都没接，见 §11.1） | ✅ astudio 已接入（其余 11 家待单独修） |
| 用户改设置**立即失效**目录（`invalidateCatalogCache`） | ❌ 名义接入、实际无效（因为不读 `isCatalogFresh`） | ✅ 生效 |
| **账号/余额信息缓存**（`balanceCache`） | ✅ 已接入（`fetchBalanceReading` 经 `runtimeOf(provider).credits` 通用分派，astudio 在 `provider-credits` 表里） | ✅ 不变 |
| 失效模型剔除（`withDeadModelPruning`） | ✅ 自动（`pruned()` 包装） | ✅ 不变 |
| 目录共享骨架（`createModelCatalog` / `prepareCall` / 三态） | ⚠️ 用了骨架但缺 `refresh` 回调与 TTL 判据 | ✅ 补齐 |
| 聚合临期折算（`WIRED_EXPIRY_PROVIDERS`） | ✅ 有意不接且已登记（有行为守卫） | ✅ 不变 |
| 凭据续期调度（`refresh-scheduler`） | N/A（本家凭据磁盘无 TTL、无 `expiresAt`） | N/A |

---

# 第三部分：master 侧修正 —— 目录刷新器「空转」（`be42b25` 遗留）

> 提交 `3186eaf`（12 家转发 + 参与度检测）+ `6398087`（补 V6 盲区守卫）
> 触发问题：PR #118 合并后复查"astudio 的 refresh 转发"时发现 **12 家全都没有**。

## 13. 缺陷本体：三环只做了两环

`createCatalogRefresher` 每 20 分钟遍历 `modelAdapters` 并调 **`adapter.refresh?.()`**（`src/index.ts`）。三环缺一不可：

| 环 | 位置 | `be42b25` 状态 |
|---|---|---|
| ① 调用侧 | `index.ts` 的 `refreshOf` | ✅ 加了 |
| ② 能力侧 | `ModelCatalog.refresh?()` + 8 家的 `config.refresh` 回调 | ✅ 加了（8 个文件各 +11 行，就是 `createModelCatalog(config)` 内部那个回调） |
| ③ **中间转发** | 适配器实例上的 `refresh()` 成员 | ❌ **从未落地** |

③ 的取证：`git log -S 'async refresh(): Promise<void>' -- 'src/*-adapter.ts'` 的唯一命中是
`f09a2e7`（本 PR 给 astudio 加的）；`git log -S 'this.refresh ='` 历史上**零命中**。

**漏掉的根源是一句错误论证**（提交信息与 `index.ts` 注释都写了）：

> `modelAdapters` 每项都是 `pruned()` 的 Proxy —— 它对**其余成员原样透传并绑定 this**（`dead-model-store.ts:748-749`）⇒ **新加的 `refresh()` 自动透出，无需改那两张表**

Proxy 透传的是**适配器自己的**成员，而 `refresh()` 加在 **`ModelCatalog`（catalog 实例）**
上 —— 适配器没有转发，Proxy 就无从透出。所以这不是"忘了写代码"，而是**被论证跳过了**。

**为什么完全静默**（三条叠加，缺一条都不会这么久无人察觉）：

1. `refreshOf(provider): void | Promise<void> | undefined` —— 类型**显式允许** `undefined`，
   `await undefined` 是合法 no-op，`tsc` 不报；
2. 刷新器**不检测"本轮零参与"**：返回 `undefined` 即静默跳过、**不记日志**；
3. 两条守卫都结构性抓不到：`catalog-refresher.spec.ts` 的 8 条**全部直接 `new` 刷新器 +
   自造 `refreshOf` 桩**（绕过装配）；`catalog-refresher-wiring.spec.ts` 的 2 条虽真跑
   `apply()`，但**只断言武装日志**，而 `start()` 与日志不依赖 `refreshOf` 是否拿到函数。

⚠️ `model-catalog.ts` 的注释当时**已经写下这个风险**（"未提供 `config.refresh` 时整个成员
不出现……比一个『调了什么都不做』的假函数更容易发现接线错误"），但**没有实现任何检测**
——实测恰好相反：假函数至少会真发请求。

## 14. 修正内容

| # | 改动 | 位置 |
|---|---|---|
| 1 | **12 家补 `refresh()` 转发**（`await this.catalog.refresh?.()`）：accio / astudio / buddy / lobsterai / loomy / minimax / raccoon / trae / zcode + **codearts**（本轮同时补 `config.refresh`）+ `minimaxintl` / `workbuddy`（与 minimax / buddy **共用适配器类**，自动继承） | 10 个 `*-adapter.ts` |
| 2 | **`createCatalogRefresher` 参与度检测**：本轮**零参与 ⇒ warn**（接线缺口的唯一强信号）；**部分参与 ⇒ info** 记「参与 M/N 家」 | `model-catalog.ts` |
| 3 | **`index.ts` 的 `refreshOf` 明确化**：只在**拿到函数**时返回 Promise，否则 `undefined` ⇒ 让「成员不存在」与「成员存在但返回 void」可区分 | `index.ts` |
| 4 | **守卫 A**：`catalog-refresher.spec.ts` +3 条（零参与 ⇒ warn / 部分参与 ⇒ info / **全部参与不得告警**＝反向） | tests |
| 5 | **守卫 B**：`model-catalog-parity.spec.ts` +1 条 —— **逐家点名** 12 家必须转发，**双向有牙**（漏转发 ⇒ `missing` 红；连 `config.refresh` 都没给 ⇒ 精确集合红，单靠前者会被 `continue` 静默跳过） | tests |
| 6 | **守卫 C**：`catalog-refresher-wiring.spec.ts` +1 条 —— 真跑 `apply()` + 推进一个周期触发 `tick()`，断言「无一家参与」那条 warn **不出现**（见 §15 的 V6） | tests |

## 15. 变异验证（7 项）

| 变异 | 目标 | 实测 |
|---|---|---|
| V1 | 删 zcode 的 `refresh()` 实例成员 | **1 failed** ✅（`missing` 点名 zcode） |
| V2 | 删 zcode 的 `config.refresh` 回调 | **1 failed** ✅（精确集合漏 zcode） |
| V3 | 短路「零参与 warn」 | **1 failed** ✅ |
| V4 | 短路「部分参与 info」 | **1 failed** ✅ |
| V5 | 让零参与 warn **无条件**触发（反向） | **2 failed** ✅ |
| V6 | `index.ts` 的 `refreshOf` **恒返回 `undefined`**（= 缺陷态等价物） | **0 failed / 0 failed** ⚪ **无牙** |
| V6' | 补了守卫 C 之后重跑 V6 | **1 failed** ✅ |

⚠️ **V6 是本次最有价值的发现**：`refreshOf` 的**实际行为**（缺陷本体所在的那一环）当时
**零守卫** —— 改成缺陷态等价物后，wiring 2 条 + parity 49 条**全绿**。同一个盲区在
`be42b25` 里出现过一次（"刷新器自身用例绕过装配"），这是**第二次**。补上守卫 C 后 V6'
变红，盲区闭合。

## 16. ⚠️ 如实登记：**未覆盖** cline / gemini / qoder

这三家**连 `config.refresh` 都没有**，且目录机制与其余 12 家**不同型**，不能照抄一行转发：

| 家 | 拉取入口 | 为何不能直接接 |
|---|---|---|
| `cline` | `private async ensureRemoteModels()` | 入口有 `remoteComplete` **短路**（已完整即 return）⇒ 直接调它不会强制重拉 |
| `gemini` | `private catalogEntries(): readonly CatalogEntry[]` | **同步视图**（`loadCatalog`/`syncCatalog` 都用它），真正的拉取入口在别处 |
| `qoder` | 同上 | 同上 |

⚠️ 另记：这三家同时也**没有**目录 TTL 判据（`isCatalogFresh` / `isCatalogFreshFor`
在本家零命中，与 astudio 修复前同型）⇒ 它们的模型列表更新语义需要**单独评估**
（不是"补一行"，而是先弄清各自的"强制重拉"入口与缓存策略）。

## 17. 验证

- `pnpm test`：**9669 passed / 6 skipped / 0 failed**（修正前 9664，差额 = 新增 5 条守卫）；
- `pnpm typecheck` 0 error；
- 变异：按行号注入 + 重读确认落地，全部 `PATCH-APPLIED`（无 `PATCH-NOT-APPLIED`）；
  worktree 用完即弃，主工作区零污染。