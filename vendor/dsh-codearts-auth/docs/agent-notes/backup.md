<!-- 搬自 AGENTS.md（2026-10-06 拆分：注入预算 65,536 B，超出部分每轮被截断永不可见）。
     内容逐字节原样保留；本文件按需阅读，不进每轮注入。 -->

## ⚠️ 账号备份：三种「只加不覆盖」的语义边界（选账号导出 / 合并导入 / 第三方转换）

「备份」不是单一功能，而是**四条语义互不相同的路径**共用一个端点族
（`backup.export` / `backup.import` / `backup.status`）。改动前先认清自己在哪一条上：

| 路径 | 语义 | 落点 |
|---|---|---|
| 导出全部 | 自包含快照 | `exportBackup(pool, cred)` |
| **选账号导出** | 只打包选定账号，**黑名单与锁定表仍全量** | `exportBackup(..., { accountIds })` |
| **整体还原** `replace` | 账号池 + 黑名单 + 锁定表**整体替换** | `importBackup(..., { mode: 'replace' })` |
| **合并追加** `merge` | 只追加账号，**不碰**黑名单 / 锁定表 / 他人凭据 | `importBackup(..., { mode: 'merge' })` |

⚠️ **模式必须取白名单，不能透传请求里的字符串**：
`const mode = req?.mode === 'merge' ? 'merge' : 'replace'`。
未知值会被 `?? 'replace'` 静默当成**整体替换** —— 用户以为只加一个账号，实际账号池
被清空，**不可逆**。这是本层唯一一个「写错就毁数据」的地方。

### ⚠️ 裁剪必须发生在**发请求之前**，且要裁三处

判重虽然在**后端**，但后端只知道「这份载荷里有哪些账号」，**不知道用户在界面上勾了哪几个**。
故 `plugin-src/client/backup-payload.js` 的 `trimBackupPayload()` 必须先裁：

1. `accounts` —— 只留选中 id；
2. `credentials` —— 只留被选中账号**实际引用**的 ref；
3. `disabledModels` —— 置空表（合并模式本就不消费它）。

⚠️ **第 2 条是安全边界，不是优化**：备份里那些**不在勾选范围内**的 `credentialRef`
可能已被本机现有账号占用，回写等于**覆盖现有账号的凭据**，与「只增加不覆盖」的承诺相反。

⚠️ **「全部账号」也必须裁**（不能图省事把原始载荷直接发出去）：原始载荷的
`credentials` 还含**账号池之外**的独立凭据 ref（各 provider 的默认单凭据），
那些 ref 在合并语义下同样不该被回写。

⚠️ 同理，`importBackup` 的 `merge` 分支**只写被采纳账号引用的凭据**
（`credentialsToWrite`），绝不回写 `payload.credentials` 全表。`replace` 才逐条写全表。

⚠️ **前端 `exportIds` 的三态语义不能合并**：`null` = 导出全部；
**空集 = 用户勾了但一个都没选，必须报错**；非空集 = 导出这些。
把空集当「全部」会让用户拿到一份含全部账号的文件，与「只导一个」的意图相反（**泄漏面变大**）。

### ⚠️ 合并导入的判重是**三层**，第 2 层才是关键

`importBackup` 在 `mode: 'merge'` 下依次判：

1. 池里已有的 **`id`**；
2. 池里已有的**身份**（凭据里的 `user_id` / `uid` / `userid` / `account_id`，
   `opencode` 另有 `api_key` —— 字段候选表见下）；
3. **备份文件内部**重复的 `id`（同一份文件手工编辑后可能出现两条同 id）。

⚠️⚠️ **只按 `id` 判重是不够的**：插件自己登录时 `id` 由 `shortId()` **随机**生成
（`buddy-a1b2c3d4`），而从第三方文件转换来的 id 是**确定性哈希**（见下节）。
同一个人因此有**两套 id**，只比 id 会把他重复加进池里 —— 而用户在「从别人的备份里挑
账号」时，最常见的情形恰恰是「**这个号我已经手登过了**」。这就是第 2 层存在的理由。

⚠️ **第 3 层不能省**：重复条目会在池里留下两条同 id 的账号，之后
`updateAccount` / `removeAccount` 按 id 查找**只会命中第一条**，出现「删不掉、改不动」
的**幽灵账号**。同一理由要求 `AccountPool.mergeAccounts` 内部也自带去重（两层各判一次
不算冗余：一个是「相对现有池」，一个是「相对本批次」）。

⚠️ **判不出身份时按「无法判断」跳过该条**，不要当成「不匹配」或直接报错：
凭据缺失/损坏是常态（跨版本迁移尤其），不该让一次判重失败阻断整体导入。

#### ⚠️ 身份字段候选表 `IDENTITY_FIELDS`（每个 provider 都要有归属）

| 字段 | 写在哪些 provider 的凭据里 | 出处 |
|---|---|---|
| `user_id` | `buddy` / `workbuddy` / `lobsterai` / `raccoon` / `zcode` | 各自登录与续期写入点 |
| `uid` | `qoder` / `qodercn` / `trae` | 同上 |
| `userid` | `loomy`（讯飞用户 id，18 位数字串） | `LoomyCredential.userid` |
| `account_id` | `cline`（`usr-…`）/ `minimax` | 两个 `*Credential` 接口 |
| `sub` | `gemini`（OIDC `sub`，21 位数字串） | `GeminiCredential.sub` |
| `api_key` | `opencode`（**仅账号槽**，见下） | `opencode-rpc.ts` 写入的 `{api_key, nickname}` |

⚠️ **新增一个 provider 时必须通读它的凭据形状**，再决定要不要补字段。漏一个字段的
后果**不是报错**，而是那个 provider 的「**这个号我已经手登过了**」场景**必然**多出
一条重复账号 —— 判重静默退化成纯 `id` 比对，而 id 在插件侧是随机的、在第三方转换
路径里是确定性的（见下节），同一个人天然有两套 id。

⚠️ **绝不能把轮换令牌当身份**（`access_token` / `refresh_token`）：它们每次续期都会变，
拿它们当键会让**续期后的同一个账号**被判成新账号；顺带也没必要把凭据核心内容搬进键里。

⚠️ **`gemini` 只收 `sub`、不收 `email`**（两者都写在 `GeminiCredential` 顶层）：
`sub` 是 OIDC 的**稳定主体标识**（换邮箱、改昵称都不变），上游正是拿它当账号 id
用的（`gemini-auth.ts` 的 `persistLogin` 返回 `{ accountId: credential.sub }`，
`geminiAccountLabel` 则是「邮箱优先、回退 sub」，两者用途不同）；
而 `email` **会随用户改邮箱而变** —— 拿它当身份会让同一个账号在改邮箱后被判成
新账号，与上面「轮换令牌不得当身份」是同一类错误。
⚠️ **`sub` 在本仓库只有 gemini 写在凭据顶层**（minimax 那个 `sub` 是从 JWT 里解出来的、
**不落顶层字段**），故加进通用表不会让别的 provider 误命中。

⚠️ **`opencode` 必须单独处理，且匿名槽必须排除**：
- 它的凭据**只有** `api_key`（上表四个字段一个都没有）⇒ 账号槽的 `api_key` 就是身份；
- 但**匿名通道**的 `api_key` 恒为 `OPENCODE.anonymousKey`（字面量 `public`），
  **全部匿名槽共用同一个值**。上游把「多条匿名通道各走各的出口（不同出口 IP =
  不同配额桶）」当**能力**提供（见 `src/opencode-auth.ts` 的 `listIdentitySlots` 注释），
  故**不能**拿它当身份：那会把用户刻意添加的第二条匿名通道判成「已存在」而**拒绝导入**。
- 排除之后匿名槽退回纯 `id` 判重 —— 它们本就无法互相区分，这是唯一正确的口径。

### ⚠️ `AccountPool.mergeAccounts` 必须只调 `writeAccounts`

- **只调 `writeAccounts`**（黑名单取**当前**值），因此**不改**黑名单、
  也**不触碰**锁定表（它住在独立文档 `permanent-locks.json`，见本文件「锁定永久积分」一节）。
  ⇒ **不要**为了「顺手统一」把它改成调 `replaceAll`：那会连带覆盖黑名单与锁定表。
- ⚠️ **`added.length === 0` 时必须早退**（不落盘、不返回）：否则每次「全部已存在」的
  导入都会触发一次无意义的写入与目录广播。
- ⚠️ 入参同样经 `sanitizeAccounts` 归一化 —— 数据来自用户提供的文件，坏条目丢弃而不是
  写进池里**反复触发选号失败**。

### ⚠️ 第三方账号列表：识别、provider 分派、确定性 id

用户手上常见的是**别的工具**产生的 CodeBuddy 账号列表（裸数组，账号对象里直接带
`access_token` / `refresh_token`），结构与本插件备份**完全不同**。直接丢给「恢复」只会
得到「该备份文件里没有账号」（取不到 `accounts`）。转换实现在
`plugin-src/client/backup-convert.js`（纯函数，可单测）。

- ⚠️ **必须先排除本插件自己的备份**（`format` 命中即返回 `false`）：本插件备份里
  `credentials` 也是对象，按「对象里有令牌」判会**误判**。
- ⚠️ **空的裸数组也算第三方外形**（`[]`）：它无论如何都不是合法备份，认成第三方至少能
  给出「里面没有账号」这种**可操作**的提示，而不是「备份内容不是对象」这种无从下手的报错。
  包装对象（`accounts` / `data` / `items` / `list`）同理，但**只认这几个键** ——
  否则任何 `{ foo: [] }` 都会被当成账号列表吞掉。
- ⚠️ **provider 按 JWT `iss` 的 host 分派**：含 `workbuddy` → 国际版，否则 → `buddy`。
  两者是**不同路由**，认错会把凭据发到**错误的端点**。认不出时保守回落 `buddy`（中国版最常见）。
- ⚠️ **id 必须确定性生成**（`stableShortId` = uid 的 FNV-1a 哈希），不能随机：
  这样**同一份文件导入两次，第二次全部判为「已存在」而跳过**，不堆重复账号。
  ⚠️ 哈希而非「取 uid 前 8 位」：uid 形态在不同工具里不一致（UUID / 带前缀的四十位 hex /
  纯数字），逐分支处理既啰嗦又易漏。
- ⚠️ **同批次内要再防一次 id 撞车**（重复 uid 是真实可能的：同一份文件里手工粘了两遍
  同一个人），撞了就追加 `index` 再哈希并给出 warning。
- ⚠️ **`refresh_expires_at` 的推导有优先序**：直接字段 → `auth_raw` 的
  `expiresIn`/`refreshExpiresIn` **差值**补算 → refresh_token 的 JWT `exp` 兜底。
  差值公式已实测与本机真实凭据**逐毫秒相等**（432000000ms）；JWT `exp` 比公式**早约 1 秒**
  （向下取整到秒），故**只能作兜底**。
- ⚠️ **不写 `scope`**：真实凭据里有，但插件**从不读取** `scope` 发请求（只在续期时原样带回），
  第三方文件里也没有 —— 与其猜一个可能不准的值，不如省略。缺字段不会被判为无效凭据。
- ⚠️ 转换后**不带 `permanentLocks`**、且 `disabledModels` 置空：让这份载荷即便被当成
  「整体还原」也不会改动模型开关与锁定状态。
- ⚠️ 转换路径**不询问口令**（它不是加密容器），也**不拉 `backup.status`**
  （第三方文件里没有本机账号信息，覆盖提示无意义）；并**默认落到 `merge` 模式**。

- ⚠️ **前端有个源码级守卫要绕开**：`tests/unit/model-filter.spec.ts` 有一道
  **不区分文件位置**的字符串回归墙（防止 `ModelListPanel` 的多选勾选被重新引入）。
  故 `doExport` 里的变量名刻意用 `exportIdList`，**不要**改成被禁用的那个名字。
  守卫本身是对的，不该为这里放宽。

### ⚠️ 与「永久积分锁定表」的交叉点（容易改坏，两个方向）

上游已把锁定表移出 `getStateSnapshot()`，**导出必须走 `permanentLocksSnapshot()`**
（漏改 = 备份里的锁定永远是空表）。本功能**叠加**在其上，两条约束要一起读：

- **选账号导出不得过滤锁定表**：`accountIds` 只作用于 `accounts` / `credentials`；
  锁定表与黑名单**仍全量**，产物才是一份**可整体还原的自包含快照**。
  给过滤加范围时**别顺手把锁定表也过滤掉**。
- **合并导入不得替换锁定表**：`merge` 只调 `mergeAccounts`，不传黑名单、不传锁定表，
  让池**保持当前值**（否则从别人的备份合并一个账号会**静默解锁**自己的永久积分）。

### ⚠️ 合并导入与 `pruneAccountsWithForeignDomain` 的交叉点（残余风险，2026-10-07 发现）

**结论：当前不会误删，但两个判据的语义不自洽，是一个未被测试覆盖的静默删除路径。**

`src/index.ts:333` 在启动时对 `workbuddy` 调 `pruneAccountsWithForeignDomain`，
判据是「凭据里的 `domain` **不等于** `product.apiDomain` 就删账号」。而
**`domain` 的语义是「登录时站点（token 的 `iss` 主机）」快照**，不是请求端点域名 ——
`src/buddy-adapter.ts:1958-1962` 明文写着这一点，且 `X-Domain` 实际以
`this.product.apiDomain || credential.domain` 取值，凭据里的 `domain` 只是**兜底**。

**本机实测（只读 `~/.dsh/.credentials.yaml`，20 个腾讯系账号）证明同一 provider 的
`domain` 合法地存在多种值**：

| provider | `apiDomain`（比对基准） | 凭据里实际出现的 `domain` |
|---|---|---|
| `buddy` | `copilot.tencent.com` | `www.codebuddy.cn`（12 条）、`copilot.tencent.com`（8 条） |
| `workbuddy` | `www.workbuddy.ai` | `www.workbuddy.ai`（1 条） |

⇒ `domain ≠ apiDomain` **并不蕴含**「凭据发不到当前端点」：buddy 那 12 条
`www.codebuddy.cn` 的账号一直是正常可用的（`www.codebuddy.cn` 是它的登录站，
见 `src/buddy.ts:26` 的 `WEBSITE_HOME`）。该判据之所以在 buddy 上没出事，
**只是因为上游恰好没对 `CODEBUDDY` 调用这个函数**（唯一调用点是 `WORKBUDDY`）。

**为什么现在仍安全**：workbuddy 的 realm 恰好就是 `www.workbuddy.ai`
（`backup-convert.spec.ts` 的样例 `iss` 即此值），与本机唯一那条真实 workbuddy
凭据一致 ⇒ **当前 0 个账号被命中**。

**为什么值得记**：
1. **合并导入放大了触发面**：本功能让「跨机搬账号」变常见，一旦导入的 workbuddy
   凭据 `iss` 与 `apiDomain` 不同（例如国际版另有 realm 主机、或将来改登录站），
   启动时会被**静默删除**——只留一行 `ctx.logger.info`，用户看到的是「账号自己没了」。
2. **`pruneAccountsWithForeignDomain` 的用例只覆盖了「domain 指向旧端点」这一形态**
   （`account-pool.spec.ts` 的 `describe('pruneAccountsWithForeignDomain')`），
   **没有**「domain 是合法登录站但 ≠ apiDomain」的反例用例。这正是 buddy 那 12 条
   账号的形态 —— 若该函数将来被推广到 `CODEBUDDY`，会一次性删掉它们全部。
3. ⚠️ **推广前必须先修判据**：应改判「端点是否可达 / `domain` 是否属于该产品的
   已知 realm 集合」，而不是与 `apiDomain` 精确比对。不要直接套用。

### ⚠️⚠️ 第二轮独立审计（2026-10-07）：六条缺陷与修法（**已被对抗审计实测证伪**）

第一轮审计后做了一轮**正向 + 对抗**双审计，两个审计员在**独立 worktree** 里跑，
共证伪 6 条。逐条记在这里，**它们都是「声明与实际不符」或「边界输入未防御」**：

| # | 级别 | 缺陷 | 修法落点 |
|---|---|---|---|
| 1 | **Critical** | `sinkAccountToProviderEnd` 按 **`id`** 匹配（`findIndex`/`filter`），池里两条同 id 时写出 `undefined` 空洞 ⇒ 该 provider 的 `getAvailableAccount`/`listAccounts` 全部抛 TypeError（**整条推理链崩**），且空洞经 `JSON.stringify` 变 `null`、重启后被丢弃 ⇒ **账号永久丢失** | 改按**对象引用**（`group.indexOf(entry)` / `a !== entry`）+ 长度不变式兜底；**根治**是 `sanitizeAccounts` 按 id 去重 |
| 2 | High | merge 的「只增加不覆盖」被 **`credentialRef` 撞车**打穿：前三层判重只决定「账号条目要不要追加」，而凭据写入用**另一套键**（ref），该维无人检查 ⇒ 备份里一条全新 id/身份的账号会**静默覆盖本机另一账号的凭据**。⚠️ **客户端 `trimBackupPayload` 挡不住**（撞车的 ref 就在勾选范围内，裁剪只解决「范围外」） | `importBackup` 加第 ④ 层：`credentialRef → 占用者 id` 表，命中即**连账号条目一起拒绝**（否则会落下无凭据的账号） |
| 3 | High | `pruneAccountsWithForeignDomain` 的判据 `domain !== apiDomain` **语义不成立**：`domain` 是「**登录站**」（token 的 `iss` 主机），不是端点域名；`X-Domain` 实际以 `product.apiDomain \|\| credential.domain` 取值。把「**未知**」当「失配」⇒ 跨机导入的 workbuddy 账号（`auth.workbuddy.ai` 等合法 realm）**下次启动被静默删除**，日志仅 `info` | 判据改「**确证属于其它产品**」：产品配置加 `knownDomains`，只有命中**别的产品**的域集合才删，未知域**保守保留**；`info` → `warn` |
| 4 | High | UI「限额中」判据 `v > Date.now()` 与宿主 `now >= resetAt` 对**非数字脏值**结论相反（UI 不显示、宿主判为受限并排除）⇒ 显示与行为分叉。脏值**可达**：`sanitizeAccounts` 对 `modelRateLimits` 原样透传 | `sanitizeAccounts` 过滤脏值（只留有限正数，与 `updateModelRateLimit` 的写入守卫同源） |
| 5 | High | `trimBackupPayload` 把 `disabledModels` 置空表，注释称「无论被当成哪种模式都不会改动模型开关」——**与实现相反**：`replaceAll` 收到空表执行 `sanitizeDisabledModels({})` = `{}`，即**整体清空黑名单**（实测用户开关被静默清空） | `trimBackupPayload` **原样保留** `disabledModels`（`accountIds` 本就只作用于 `accounts`/`credentials`） |
| 6 | Medium | `IDENTITY_FIELDS` 漏了 **codearts**（真实凭据只有 `access_key_id`，本机实测确认无 `user_id`/`uid`/`account_id`/`sub`）⇒ 该 provider「同一个号我已手登过」**必然**重复导入 | 加入 `'access_key_id'`（与 `service.ts` 的 `identityOf` 同源） |
| 7 | Medium | `importBackup` 对 `accounts` 里的 `null` 抛 `TypeError`，且抛点在「**凭据已写、账号池已替换**」之后 ⇒ 数据已落地但调用方收到失败；`assertBackupPayload` 不校验元素类型 | `assertBackupPayload` 在**校验阶段**拒绝非对象元素（校验在前 ⇒ 抛错时零副作用） |
| 8 | Low | `mergeAccounts` 只调 `writeAccounts`，**不走 `notifyAccountAdded`** 收口 ⇒ 合并导入的账号在最长 60 秒内对 aggregate 路由不可见 | `mergeAccounts` 在 `finally` 里逐个 `notifyAccountAdded`（与 `addAccount` 同款语义） |

⚠️ 三条**必须记住**的实现约束（都在反向验证里被锁死）：

- **`...candidate` 的展开顺序**（第 4 条）：`{ ...candidate, modelRateLimits: <过滤后> }` ——
  若写成 `{ ...candidate, ...sanitize(...) }` 且放在 `...candidate` **之前**，
  原始脏值会把过滤结果**整个覆盖回去**，修复静默失效（第一版正是如此，
  被新写的用例当场抓红）。
- **两道防线都要有**（第 1 条）：`sanitizeAccounts` 去重是**输入侧**根治，
  但 `sinkAccountToProviderEnd` 自身也必须有不变式 —— 池里的数据可能来自任何
  未经归一化的路径，且**历史遗留数据已存在磁盘上**。

### ⚠️⚠️ 第三轮审计（2026-10-07，验证第二轮修复）：4 条新缺陷 + 1 条恒真测试

第二轮修复提交（`f296d01`）又经一轮**正向 + 对抗**验证审计。**8 条修复全部被确认生效**，
但**修复本身引入了 4 条新缺陷**，另有 1 条测试被证明是**恒真同义反复**：

| # | 级别 | 缺陷 | 修法落点 |
|---|---|---|---|
| 9 | **High（我自己的修复不完整）** | 去重只放在 `sanitizeAccounts`，但 **`addAccount` 不经过它**（直接 `writeAccounts`）。而 `addAccount` 有 20+ 调用点（各 `*-auth.ts` 登录落库、`account.create`、`opencode-rpc`、`ensureDefaultAnonymousSlot`）⇒ 「池里两条同 id」**仍可达**。后果不是崩溃（长度不变式兜底会拦下空洞），而是**沉底静默失效**：兜底返回 `null` ⇒ 顺序不变 ⇒ 限额号解禁后仍抢占首位 ⇒ **用户报障原样复现** | 去重下沉到 **`writeAccounts`（唯一写入收口点）**；`sanitizeAccounts` 的去重**保留**（职责不同：入口清洗 vs 结构性保证） |
| 10 | Medium | `accountsSkipped` 与 `accountsImported` **自相矛盾**：文件 `[A,A,B]` 且 A/B 都是新账号时，A 的第一条被**采纳**，但重复统计仍把 A 报成「已跳过」⇒ 同一个 id 既报「新增」又报「已跳过」（UI 用 `accountsSkipped.length` 渲染文案） | 重复统计移到采纳循环**之后**，判据用 `!acceptedIds.has(id)` 差集 |
| 11 | Low | `accountsSkipped` **重复上报**：文件 `[A,A]` 且 A 已被池占用时得到 `['A','A']`（UI 显示「2 个已存在」而实际只有 1 个） | 同上，加 `!accountsSkipped.includes(id)` 收敛 |
| 12 | Low | `providerOfAccountRef` 是**死代码**（零调用点），注释声称的用途（ref 占用检查）由 `backup.ts` 自建的 `refOwners` 承担 —— 注释与实现分叉 | 让它**真正被使用**：`importBackup` 加**第 ⑤ 层**「ref 前缀必须与 `entry.provider` 一致」（跨 provider 误用会让 buddy 去解析 AK/SK 形状的凭据） |
| 13 | 观察 | `backup.spec.ts` 的「同批次 ref 守卫」用例是**恒真同义反复**：凭据带 `user_id` ⇒ 第②层身份判重抢先命中，**永远走不到第④层**（删掉第④层的 `refOwners.set` 全绿） | 凭据改为**无身份字段**（`{"access_token":"T"}`），用例才真正压到第④层 |

⚠️ **第 9 条是「修复把崩溃换成了静默失效」的典型**：它比崩溃更难发现（无报错、无日志），
症状恰好是**用户最初报障的那个**「额度轮不完」。教训：**去重必须放在唯一写入收口点**，
而不是「我以为所有路径都经过的那个归一化函数」—— 判断收口点时要**枚举全部写入调用方**
（`grep 'writeAccounts('` 与 `this.cache =`），不要靠印象。

⚠️ 另修正 3 处**注释不实**（同一条铁律：注释与实现必须一致）：
- `WORKBUDDY.knownDomains` 的注释曾称「收录 `.ai` 与 `.cn` 两个 realm」，实际**一个 `.cn` 都没有**。
- `sanitizeModelRateLimits` 的注释曾称与 `updateModelRateLimit` 的守卫「同源」，
  实际**判据不同**（读取侧只留正数，写入侧接受 0/负数）—— 只是**行为等价**
  （`0`/负数在选号判据里都等价于「不受限」）。已改为如实说明「判据不同、行为等价」。
- `providerOfAccountRef` 的注释声称用于 ref 占用检查 —— 现已真正接入（第⑤层）。

⚠️ **反向验证（2026-10-07 第四轮，逐条实测；还原用文件副本回拷）**：

| 变异 | 结果 |
|---|---|
| `writeAccounts` 去掉 id 去重 | `account-pool.spec.ts` **2 条**变红 |
| 重复 id 改回无条件上报 | `backup.spec.ts` **3 条**变红 |
| 去掉第⑤层 ref 前缀校验 | `backup.spec.ts` **1 条**变红 |

⚠️ **`accountsSkipped` 的语义已收窄**（第 10/11 条）：它表示「哪些**账号**被跳过了」，
同一个 id 只出现一次，且**被采纳的账号绝不出现**。「文件里有重复条目」这件事不再由它表达。
若将来要提示「文件内有重复」，请另加字段，**不要**把它改回无条件上报。

⚠️ 反向验证（2026-10-07 第三轮，逐条实测；还原用文件副本回拷）：

| 变异 | 结果 |
|---|---|
| `sinkAccountToProviderEnd` 改回按 `id` 匹配 | `account-pool.spec.ts` **1 条**变红 |
| 去掉 `sanitizeAccounts` 的 id 去重 | `jet-hub-store.spec.ts` + `backup.spec.ts` **4 条**变红 |
| 去掉 `modelRateLimits` 脏值过滤 | `jet-hub-store.spec.ts` **3 条**变红 |
| 去掉 `refOwners`（第 ④ 层 ref 占用检查） | `backup.spec.ts` **1 条**变红 |
| 从 `IDENTITY_FIELDS` 移除 `access_key_id` | `backup.spec.ts` **1 条**变红 |
| 去掉 `accounts` 元素类型校验 | `backup.spec.ts` **1 条**变红 |
| `prune` 改回「`domain !== apiDomain` 就删」 | `account-pool.spec.ts` **3 条**变红 |

### ⚠️⚠️ 第四轮审计（2026-10-07，验证第三轮修复）：5 条新缺陷

第三轮修复（`e5e0c10`）又经一轮对抗审计，打穿 5 条。**最严重的是 D1（High）**：

| # | 级别 | 缺陷 | 修法落点 |
|---|---|---|---|
| D1 | **High** | `sanitizeModelRateLimits` 只判「有限正数」，**放过超出 `Date` 范围的有限数**（如 `1e308`，Date 上界 8.64e15）。落池后下次该 (账号, 模型) 撞限流时，`updateModelRateLimit` 里 `new Date(current).toISOString()` 抛 **`RangeError: Invalid time value`** —— 而 17 个调用点里 **16 个没有 try**（llm-adapter ×3、各 adapter、account-probe ×3）⇒ 异常直接冒到推理路径与「重测」路径。写入侧守卫（`!Number.isFinite`）同样放过它 ⇒ 两侧**都漏这一格** | 抽出**读写共用**的 `isValidResetAtMs`（`jet-hub-store.ts`，上界 `MAX_DATE_MS = 8.64e15`），两侧都调它；`updateModelRateLimit` 的现值也经它过滤（坏现值被新值**覆盖自愈**，且不再对坏值调 `new Date()`） |
| D2 | Medium | 丢弃 `0` 让 UI「重置/重测」按钮**变灰**：`jet-hub.js` 的 `hasAnyLimit` = `Object.keys(modelRateLimits).length > 0` —— **只看键是否存在**。`{m: 0}` 经 `sanitizeAccounts` 后整个键写 `undefined` ⇒ 判据从 `true` 翻 `false` ⇒ **用户无法再手动解禁**。原注释的论证只覆盖**选号侧**，漏了 UI 侧这条独立判据 | 在 `sanitizeModelRateLimits` 的注释里**明确写出这条取舍与代价**（选号侧 `0` 等价于不受限、但 UI 侧依赖键存在），并指明「若收到『重置按钮变灰』报障，改这里 `>= 0` **并同时**改 UI 判据」 |
| D3 | Medium | 方向从「误删」变成「误留」：`providerFromIssuer` 按「host 含子串 `workbuddy`」分派 ⇒ `www.workbuddy.cn` 归 **workbuddy**，而它**既不在** `WORKBUDDY.knownDomains`（只有 `.ai`）**也不在** `CODEBUDDY.knownDomains`（上一轮明确「不放」）⇒ 两边都不命中 ⇒ 保守保留 ⇒ **中国区旧 workbuddy 账号永远清不掉**（反复续期失败）。另：`foreignDomains` 默认 `[]` 是合法调用，此时 prune **静默 no-op 且零日志** | ⚠️ **该条的第一版修法（把该域加进 `CODEBUDDY.knownDomains`）被最终审计证伪、已撤回** —— 见下「域归属两套判据必须同构」。保留的只有两个静默 no-op 分支各补 `logger.warn` |
| D4 | Medium | `providerOfAccountRef` 曾是**死代码**（零调用点），注释声称的用途未实现 | 已在 `e5e0c10` 的第⑤层真正接入（本轮确认） |
| D5 | Low-Medium | `assertBackupPayload` 的校验**收紧过度**：把「任何非对象元素」都硬拒，而实测**只有 `null`** 会在统计环节抛 TypeError（`(1).expiresAt` / `('str').expiresAt` 都不抛）。过宽校验**破坏** `sanitizeAccounts` 的文档化降级行为 —— 一份混了一个 `1` 的旧备份，原本能导入其余全部好账号，现在**一个都导不进来** | 判据收窄为只拒 `null` 与数组；标量放行交给 `sanitizeAccounts` 丢弃 |

**同族未修（本轮一并修）**：

- **`replaceAll` 也绕过 `notifyAccountAdded`**：上一轮只给 `mergeAccounts` 补了通知，而 `replaceAll` 是备份导入的**默认模式**（影响面比 merge 更大）⇒ 导入后的账号在最长 60 秒内对 aggregate 路由不可见，症状与 merge 那条完全同型。已在 `replaceAll` 的 `finally` 里逐个通知。
- **`sanitizeAccounts` 的注释曾声称「历史遗留的重复条目会在下次载入/**写盘**时自愈」** —— 写盘**不会**自愈（`updateAccount` / `setAccountsEnabled` / `clearModelRateLimits` / `updateModelRateLimit` / `setOpencodeProxy` 等 8 条写路径都不调它）。真正自愈的是**载入路径** + `writeAccounts` 的收口去重。注释已改。

⚠️ **`IDENTITY_FIELDS` 有一个已知「无法判重」的 provider：`minimax`**（不是遗漏，是限制）：
它的 `account_id` 由 `decodeJwtSub(accessToken)` 派生，而真实 token 是 `mmoat_` 前缀、
60 字符、**0 个点** ⇒ 恒 `undefined`；其余字段都不在 `MinimaxCredential` 里。
⇒ 「同一个 minimax 号我已手登过」**必然**多出一条重复账号。
要真正支持需另调服务端 userinfo（属功能增强）。已登记在 `src/backup.ts` 的
`IDENTITY_FIELDS` 注释里，**别以为表里漏了一格就去乱加字段**。

### ⚠️⚠️ 域归属的**两套判据必须同构**（最终审计实测证伪了我第四轮的 D3 修法）

`knownDomains`（精确域表，在 `src/product.ts`）与 `providerFromIssuer`
（子串匹配，在 `plugin-src/client/backup-convert.js`）是**同一件事的两套判据**，
必须对每个域给出**相同归属**。

第四轮我为了「让 prune 能清理中国区旧 workbuddy 账号」，把 `www.workbuddy.cn`
加进了 `CODEBUDDY.knownDomains`。**探针实测暴露该修法制造了新矛盾**：

| 域 | `knownDomains` 归属 | `providerFromIssuer` 归属 | 一致？ |
|---|---|---|---|
| `copilot.tencent.com` | buddy | buddy | ✅ |
| `www.codebuddy.cn` | buddy | buddy | ✅ |
| `codebuddy.cn` | buddy | buddy | ✅ |
| `www.workbuddy.ai` | workbuddy | workbuddy | ✅ |
| `auth.workbuddy.ai` | workbuddy | workbuddy | ✅ |
| `api.workbuddy.ai` | workbuddy | workbuddy | ✅ |
| `workbuddy.ai` | workbuddy | workbuddy | ✅ |
| **`www.workbuddy.cn`**（第四轮误加） | **buddy** | **workbuddy** | ❌ **矛盾** |

⇒ **已撤回**。深查证据后确认**正确修法是「不加」**：

- `knownDomains` 的语义是「凭据里 `domain` 的合法值」= **登录站 / 认证 realm**
  （token 的 `iss` 主机）。而 `www.workbuddy.cn` 是**成长中心网页站**
  （`CODEBUDDY.claimBase` / `webBase`），**不签发 token** ⇒ 永不作为 `iss` 出现
  ⇒ 本就不该进这个表。
- 该域作为 WorkBuddy **realm** 的实证：**没有**。本机 5 条 workbuddy 凭据的 `iss`
  全是 `www.workbuddy.ai`；git 历史里 `WORKBUDDY.apiDomain` 从未是 `.cn`。
- 它作为 realm 出现在**别处**的可能确实存在（第四轮审计的猜测），但**未知域保守保留**
  是刻意取舍（误留的代价远小于误删）⇒ 不该为了「可能漏删」去制造一个**确定的矛盾**。
- 若将来拿到实证，正确修法是**同时**改分派判据与域表，**不要只改一处**。

⚠️ 两条不变式已用测试锁死（`account-pool.spec.ts`）：
① `knownDomains` 的每个域与 `providerFromIssuer` 的归属**必须一致**；
② 两个产品的 `knownDomains` **不得有交集**（交集会让 `own`/`foreign` 同时命中）。

⚠️ **教训**：修「判据不自洽」类缺陷时，**先确认改哪一侧才是语义正确的** ——
把 A 侧的值挪到 B 侧「让它能命中」，可能只是把矛盾从「都不命中」变成「互相矛盾」。
判据的**语义**（这里是「登录站」而非「网页站」）比「让某个流程跑通」更重要。

⚠️ **反向验证（2026-10-07 第五轮，逐条实测；还原用文件副本回拷）**：

| 变异 | 结果 |
|---|---|
| `isValidResetAtMs` 去掉 `Date` 上界（改回「有限正数」） | `jet-hub-store.spec.ts` + `account-pool.spec.ts` **4 条**变红 |
| `replaceAll` 去掉 `notifyAccountAdded` | `account-pool.spec.ts` **1 条**变红 |
| 把 `www.workbuddy.cn` 加回 `CODEBUDDY.knownDomains` | `account-pool.spec.ts` **1 条**变红（域归属矛盾） |
| 元素校验放宽成「任何非对象都拒」 | `backup.spec.ts` **1 条**变红 |

⚠️ **「方向可信、计数不可信」**：两轮独立审计各自复现了作者的反向验证表，
结论都是**每条变异确实会变红（无同义反复）**，但**计数常不准**（第一轮 3/5 不符、
第三轮 2/8 不符）。⇒ 该表只可用于「这条变异有没有判别力」，
**不可**用于「覆盖度已确认」。

### ⚠️⚠️ 第五轮（最终验收 + 对抗）：2 条新缺陷（1 Medium 复合边界）

最终一轮双审计（验收 + 对抗）确认**前四轮全部修复生效、无功能回归**，
但发现 2 条新缺陷 —— 都属「**复合边界**」形态，前三轮的单点探针测不到：

| # | 级别 | 缺陷 | 修法落点 |
|---|---|---|---|
| F1 | **Medium** | **复合边界静默丢号 + 谎报「已存在」**：载荷 `[dup→refA, dup→refB]`，`refA` 被本机占用（第④层拒）、`refB` 空闲且身份全新（**本应被采纳**）。初版实现在采纳循环**之前**先调 `sanitizeAccounts(payload.accounts)`，而它按 id 去重（保留第一条）⇒ 第二条**根本进不了循环** ⇒ `accepted = []` ⇒ 同 id 的**可采纳候选被静默丢弃**，且 `accountsSkipped` 把它报成「已存在（已跳过）」—— 而那个账号**从未存在过**。用户看到的是反向误导 | 去重语义改为「同 id 只采纳**第一条可采纳**的条目」：候选序列改用**逐条清洗**（`sanitizeAccounts([entry])`，不去重），同 id 交给循环内的 `existingIds` 判；**采纳成功后回撤该 id 的「已跳过」记录**（`accountsSkipped.splice`） |
| F2 | Low | `replaceAll` **不调 `writeAccounts`** ⇒ 后者那条「丢弃了 N 条同 id」的告警在**备份导入默认模式（`replace`）下不触发** —— 而 `replace` 恰恰最可能遇到手工编辑的备份。后果：`accountsImported` 报载荷条目数、池里更少，**零 warning** 解释差额 | `replaceAll` 内按同口径补一条 `logger.warn` |

⚠️ **F1 是「复合边界」的典型**：它需要「同 id 重复条目」**与**「第④层 ref 撞车」**同时成立**
才可达 —— 任何单点探针都测不到。教训：**测试要覆盖判据的交叉点**，而不只是每条判据单独成立。

⚠️ **另修正 1 处注释不实**（最终审计实测）：
`sinkAccountToProviderEnd` 的注释曾把 `findIndex` 与 `filter` **并列**描述为「都会出错」，
实测 **`findIndex` 单独改回按 id 不可区分**（0 条测试变红；同 id 时两者都命中第一条）。
⇒ **承重的是 `filter` 那一侧**，只有两者一起改回按 id 才产生空洞。注释已如实标注
「本行按引用写是为语义清晰，不是独立判别点」—— 避免后来人误以为有两道独立的闸门。

⚠️ **登记一条「同族未加固格」**（最终审计，当前不可达）：`ProviderAccountEntry.expiresAt`
与 `modelRateLimits` 来自**同一个威胁模型**（用户可编辑的备份），但只有后者被
`isValidResetAtMs` 加固。`expiresAt` 当前**无崩溃可达**（唯一读它调 `new Date()` 的
`raccoon-auth` 分支被「从凭据算过期」的判据门控），但这是「补了 A 格漏了 B 格」形态 ——
将来若有人把某处判据改成读池值，就会与 `modelRateLimits` 那个 `RangeError` 同型地炸。
已在 `src/types.ts` 的字段声明处写明。

⚠️ **反向验证（2026-10-07 第六轮）**：

| 变异 | 结果 |
|---|---|
| 候选序列改回整批 `sanitizeAccounts`（F1 的静默丢号） | `backup.spec.ts` **1 条**变红 |
| 去掉「采纳后回撤跳过记录」（F1 的谎报） | `backup.spec.ts` **1 条**变红 |
| 去掉 `replaceAll` 的 `dropped` 告警（F2） | `account-pool.spec.ts` **1 条**变红 |

⚠️ **`accountsSkipped` 的最终语义**（三轮收窄后的定稿）：
「哪些**账号**（按 id）**最终没被采纳**」—— 同一个 id 只出现一次；
**被采纳的账号绝不出现**（包括「它的第一条被拒、第二条被采纳」的情形）。
「文件里有重复条目」这件事**不由它表达**，需要提示请另加字段。

### 测试与反向验证

- `tests/unit/backup.spec.ts`（54 条）：选择性导出 / 合并导入**四层**判重 /
  `merge` 不回写其余凭据 / `replace` 兼容旧行为 / `accountsSkipped` 恒空；
  其中 9 条专管**身份字段覆盖度**（cline `account_id` / loomy `userid` /
  gemini `sub` / gemini `email` 不得当身份 / opencode 账号槽 `api_key` /
  opencode 匿名槽不判身份 / 轮换令牌不得当身份 / **codearts `access_key_id`** /
  codearts AK 不同不误伤）。
- `tests/unit/backup-payload.spec.ts`（14 条）：载荷裁剪（含「不修改入参」）、
  **黑名单原样保留**（空表会清空用户开关）与账号摘要。
- `tests/unit/backup-convert.spec.ts`（28 条）：第三方识别、iss 分派、确定性 id、
  字段对齐、坏条目降级。
- `tests/unit/jet-hub-store.spec.ts` 的「归一化」段：`sanitizeAccounts` 的
  **按 id 去重**（含跨 provider）与 **`modelRateLimits` 脏值过滤**。
- `tests/unit/account-pool.spec.ts`：`mergeAccounts` 段（6 条）+ 沉底段
  （含**同 id 两条不产生空洞**的 Critical 回归）+ `pruneAccountsWithForeignDomain`
  段（11 条，含**合法子域保留**、**未知域保守保留**、**未声明 knownDomains 不删**）。

⚠️（关于 `scripts/` 里的 `probe-*.mjs` / `verify-*.mjs`：按本文件「哪些入库、哪些不入库」
一节，它们是**本地指针**，新克隆的仓库里没有 —— 别照着路径去 `import`。）

⚠️ **已做反向验证**（2026-09-30 与 2026-10-02 两轮，逐条实测；还原用
「文件副本回拷 + `Get-FileHash` 比对」）：

| 变异 | 结果 |
|---|---|
| 禁用第 2 层身份判重（`identityKey` 恒 `undefined`） | `backup.spec.ts` **1 条**变红（「id 不同但 user_id 相同」） |
| 让 `merge` 回写 `payload.credentials` 全表 | `backup.spec.ts` **3 条**变红 |
| `mergeAccounts` 去掉文件内重复 id 去重 | `account-pool.spec.ts` **1 条**变红 |
| 身份字段表退回只认 `user_id` / `uid` | `backup.spec.ts` **2 条**变红（cline / loomy 身份判重） |
| 删掉 `opencode` 的 `api_key` 分支 | `backup.spec.ts` **1 条**变红（opencode 账号槽判重） |
| 去掉匿名槽排除（把 `public` 也当身份） | `backup.spec.ts` **1 条**变红（多条匿名通道被判成同一账号） |
| — | 还原后 4 个文件 **214 条全绿** |

⚠️ **做这类变异验证时不要用 `git checkout -- .` / `git restore` / `git stash`**：
本仓库经常带**未提交**的自有改动，那些命令会把它们一并抹掉。用文件副本回拷，
并用 `Get-FileHash` 比对确认还原干净。