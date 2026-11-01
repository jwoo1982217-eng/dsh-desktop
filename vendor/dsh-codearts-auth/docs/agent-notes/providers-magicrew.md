# 超级麦吉（Magicrew）provider 笔记

> ⚠️ 本文件是**知识库**而非运行时依赖（`src/` 不引用它）。改实现前先读这里。

## ⚠️⚠️ 便携版浏览器导入：注册表那条腿（2026-10-30 四路审计修）

Gitee PR !162 声称「扫描 Windows App Paths 对应的便携版 `Data` / `User Data`」，
审计查出 **5 个真缺陷 + 14 处无牙守卫**（`Data` 候选这个**核心修复本身零覆盖**）。
**全部已修并补上守卫**。

### 真缺陷与修法

| # | 缺陷 | 修法 |
|---|---|---|
| **P0** | **`reg.exe` 输出不是 UTF-8**，是**系统 OEM 代码页**（中文 Windows = GBK）⇒ `encoding:'utf8'` 把中文解成 **U+FFFD（不可逆）** ⇒ 拼出不存在的目录；且 `basename()` 守卫只看 ASCII 后缀 ⇒ **乱码路径照样通过** | `encoding:'buffer'` 取原始字节 + `decodeRegistryOutput()`；⚠ **代码页必须读权威的 `OEMCP`**（`HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage` 的 `OEMCP` 值，本机 = **936**）—— **不能**按 locale 猜（ja=932 SJIS / ko=949 / **zh-TW=950 Big5**，都不是 GBK）；⚠ 且 `Intl` 的 locale 是**用户区域格式**、不一定等于 UI 语言 |
| **P0** | **`dirname(dirname(exe))` 硬编码两级** ⇒ `<install>/chrome.exe` 布局**高一级** ⇒ 永远读不到 | **逐级向上探测**（起点是 **exe 所在目录**，最多 4 级）+ 存在性判据（该级下有 `Data/Default` 或 `User Data/Default`） |
| **P1** | **核心修复零守卫**：删掉 `join(install,'Data')` ⇒ 全部用例**全绿** | 补**行为级**守卫（造真实目录树，断言 `Data` 根被认出来；两种布局各一条） |
| **P1** | **`spawnSync` 无 `timeout`** ⇒ `reg` 卡住即**无限期冻结** Electron 主进程 | 加 `timeout: 5_000`（同仓 `killProcessTree` 的 `taskkill` 早有 `timeout: 10_000` ⇒ 同纪律漏了） |
| **P1** | **`chrome://newtab/` 被抢**：实测 `new URL('chrome://newtab/').hostname` = `'newtab'`（**非空**）⇒ 旧兜底 `?? pages[0]` 会**导航用户正在看的标签页** | 只导**空白页**（**前缀**匹配：`about:blank` / `chrome://newtab` / `chrome://new-tab-page` / `chrome-search://local-ntp` / `edge://newtab` …）；**没有空白页就不导航** |
| **P1** | **导航失败 ⇒ 删号**：`ensureLoginPage` 抛错 ⇒ `failLogin` ⇒ **占位账号被删**，而**窗口还开着**、用户可自己登录 | 导航失败**只记 warn、不抛**（`cdp === undefined` 仍抛）+ **接线级兜底 try** + 行为级守卫（注入抛错的 `ensureLoginPage` ⇒ 断言**不抛**且 **dispose 未被调用**） |
| **P2** | **标准安装推出垃圾路径**（`C:\Program Files\Google\Data`）⇒ 污染目录列表 + 扫无关目录的 localStorage | **存在性过滤**（一处同时治编码错/布局错/垃圾路径） |
| **P2** | 每次 `magicrewBrowserRoots()` 同步跑 8 次 `reg query`（实测 **399~550ms**），`readLocalBrowserCreds` 对 2 个 hostname 各调一次 ⇒ **~1.1s 事件循环冻结** | **进程级缓存**（5 分钟 TTL，`windowsRegisteredBrowserPathsCached`）+ 可注入查询器 |
| **P2** | `REG_EXPAND_SZ` 的 `%VAR%` 展开会把**不存在**的变量替换成**空串** ⇒ 路径被**改短** ⇒ 误命中别的路径 | 只展开**环境里真的有**的变量；不存在的**原样保留**（⇒ 存在性过滤正确筛掉） |
| **P3** | `basename(executable) !== name` **误杀系统 Edge**（实测 `App Paths\msedge.exe` 的值是 `Microsoft Edge.exe`）⇒ 生产函数本机返回 `[]` | 判据改成「值是个存在的 `.exe`」（产品归属由**注册项键名**保证） |
| **P3** | `/\bREG_SZ\b/i` **不匹配 `REG_EXPAND_SZ`**（`\b` 在 `_` 前不成立）⇒ 含 `%VAR%` 的默认值被漏 | 正则改成 `/\bREG_(?:EXPAND_)?SZ\b/i` + 环境变量展开 |
| **P3** | 导航复用 3 秒的凭据超时 ⇒ 真机实测黑洞地址 15 秒未返回 ⇒ 用户看到内部超时文案 | 导航独立用 `CDP_NAVIGATE_TIMEOUT_MS = 30_000` |

### ⚠️⚠️ 前提本身不成立（**未修已登记**）

**便携版 Chrome 不注册 App Paths**（那是**安装器**的行为）⇒ 这条腿在**最需要它的
便携版场景**下恒不产出（实测本机 `App Paths` 下只有 Edge/360 系/magpie，
**无 `chrome.exe` / `chromium.exe`**）。

⇒ **真兜底只有 `MAGICREW_CHROME_USER_DATA`**（环境变量）。
⇒ 注册表那条腿保留的价值：① 少数工具确实登记；② `Data` 候选对**已注册**的
绿色版软件仍然有效。

### ⚠️⚠️ about:blank 竞态**真机未复现**

真机（scoop chromium 154）实测：带 URL 启动时 CDP 就绪那一刻 page URL
**已经是**目标 URL；**不带** URL 时是 **`chrome://newtab/`**（**不是**
`about:blank`）⇒ 真机上 `ensureMagicrewLoginPage` 走的是「同站点不导航」分支。

⇒ PR !162 的那条声称（「用户面对 about:blank」）**前提未成立**。
⇒ 但「空白页总得处理」仍然成立 ⇒ 本次改成**只导空白页**（三种形态）。
⇒ ⚠️ **未修已登记**：是否该**改用 `Target.createTarget` 新开一个标签页**
（而不是抢现有空白页）—— 需要真实环境评估（用户可见行为变更）。

### ⚠️ 关于 leveldb 读取

读取方是 `magicrewProfilesOf(root)`（只认 `Default` 与 `Profile N`）+
`join(root, profile, 'Local Storage', 'leveldb')` ⇒ **相对结构**是
`<root>/<profile>/Local Storage/leveldb` ⇒ 便携版的 `Data` 根**只要**
profile 目录名是 `Default` / `Profile N` 就**同构**。
⚠️ **便携版实际的 profile 目录名零实测**（本机无便携版 Chrome）。

⚠️ **未修已登记**：leveldb **单文件**读失败被静默跳过（可能只剩半条记录）⇒
「读不到」与「用户没登录」同形且零日志（U1）。
