/**
 * 共享的 **Chromium 会话**：起一个 chromium、接上 CDP 通道、把它（连同窗口）干净地收掉。
 *
 * ## 为什么抽出来（2026-10-08）
 *
 * 本仓库原本只有 ZCode 需要外挂 chromium（阿里云 captcha）。库库AI（百度 GenFlowPro）
 * 的登录是 **cookie 登录而非 OAuth**（见 `docs/agent-notes/providers-kukuai.md` §5.4），
 * 要把 `.baidu.com` 上的 **HttpOnly** cookie 取回来，同样只能靠「自己起浏览器 + CDP」。
 *
 * 于是「起 chromium」这件事有了第二个调用方。而下面这些**每一条都是真实缺陷换来的**，
 * 各写一份必然分叉（分叉的方向恒定是「漏修的那份」）：
 *
 * | 缺陷 | 症状 | 修法 |
 * |---|---|---|
 * | 不监听 `'error'` | spawn 失败时**未捕获异常直接杀掉整个宿主** | `child.once('error', …)` |
 * | 只杀主进程 | chromium 是多进程（实测 13 个），子进程变孤儿 | `taskkill /T` / 进程组 |
 * | 异步 `taskkill` | 调用方以为清理完了，旧实例还占着端口 | `spawnSync` |
 * | 端口纯随机 | 连到旧实例 → `child` 指向死进程 → 整棵树泄漏 | 探测空闲端口 + 校验应答端口 |
 * | 一次性 `rmSync` | 句柄未释放，残留数十个 profile 目录 | 退避重试 |
 * | 窗口进任务栏 | 每次刷新都在任务栏闪烁（用户报障） | `WS_EX_TOOLWINDOW` / EWMH / 最小化 |
 *
 * ## 与 ZCode 的关系
 *
 * `src/zcode-captcha.ts` 的 `ZcodeCaptchaBrowser` 改为**组合**本模块的
 * {@link ChromiumSession}，captcha 专属的东西（反检测补丁、页面池、DOM 重置、
 * 表达式构造）全部留在那边。本模块**不含任何 captcha 语义**。
 *
 * ⚠️ 浏览器**发现**（{@link browserCandidates} 一族）与**窗口隐藏**也在这里：
 * 它们回答的是「哪个 chromium 可用」「怎么让它别打扰用户」，同属浏览器设施。
 */
/**
 * 从 `PATH` 里的 scoop shim 反推 scoop 的**真实根目录**（Gitee issue IKQ4JN）。
 *
 * ## ⚠️⚠️ 为什么需要它（真实缺陷，报障人实测）
 *
 * scoop 的根目录有**四档**解析顺序（`apps/scoop/current/lib/core.ps1`）：
 *
 * ```powershell
 * $scoopdir = $env:SCOOP, (get_config ROOT_PATH), "$PSScriptRoot\..\..\..\..",
 *             "$([System.Environment]::GetFolderPath('UserProfile'))\scoop" |
 *             Where-Object { $_ } | Select-Object -First 1 | Get-AbsolutePath
 * ```
 *
 * 而 {@link windowsBrowserCandidates} 原先**只抄了第 1 档与第 4 档**，
 * 跳过了第 2 档（`ROOT_PATH`，即 `<root>\config.json` 里的 `root_path`）
 * 与第 3 档（scoop 自身安装位置）。
 *
 * ⇒ **用 `root_path` 把根挪到别的盘（`D:\System_Tools\Scoop`）的机器上，
 * 环境变量是空的、`~/scoop` 也不存在，两条腿同时落空 ⇒ 一个 chromium 都找不到**，
 * 而报错被包装成「设备信誉不足」（见 `zcode-auth.ts` 的 captcha 退避），
 * 用户会去查完全无关的方向。
 *
 * ## 为什么从 `PATH` 反推，而不是直接读 `<root>\config.json`
 *
 * 读 config 需要**先知道 root**（鸡生蛋），而 scoop 的配置可能落在两处：
 * 默认 `~/.config/scoop/config.json`、便携布局 `<root>\config.json`。
 * 反过来，**scoop 的 shims 目录一定在 `PATH` 里**（否则 `scoop` 命令都用不了），
 * 且它恒为 `<root>\shims` ⇒ 这是唯一「不需要先知道 root」的入口。
 *
 * ## 判据为什么要求 `scoop.cmd` / `scoop.ps1` 存在
 *
 * 只按目录名 `shims` 匹配会误命中**任意**叫 `shims` 的目录（例如某些 SDK 的
 * `shims` 子目录）。要求该目录里真有 scoop 自己的 shim，才认它是 scoop 根。
 *
 * ## ⚠️ 这是本模块**唯一**读文件系统的候选来源
 *
 * {@link browserCandidates} 的其余部分都是纯字符串计算（可跨平台断言），
 * 本函数却必须 `existsSync`。故它**单独成一个函数**、且入参可注入 `env`，
 * 让「PATH 里有没有 shims」这一格能在任何平台上被单测锁住。
 *
 * @param env 环境（注入以便单测；`PATH` 与 `Path` 都认 —— Windows 上两者都出现过）
 * @param exists 存在性判据（注入以便单测，默认 `existsSync`）
 */
export declare function scoopRootFromPath(env: Record<string, string | undefined>, exists?: (path: string) => boolean): string | undefined;
/**
 * Windows「App Paths」里登记的 Chromium 可执行文件（**带缓存**）。
 *
 * ⚠️ **缓存只对默认查询器生效**（注入了 `query` 的调用点 —— 即单测 ——
 * 走的是**未缓存**那条路，保留确定性）。
 */
export declare function windowsRegisteredBrowserPathsCached(nowMs?: number): string[];
/** 清掉注册表查询缓存（**仅供单测**，避免用例之间互相污染）。 */
export declare function resetRegistryPathsCache(): void;
/**
 * Windows「App Paths」里登记的 Chromium 可执行文件。
 *
 * ⚠️⚠️⚠️ **编码是本函数最容易错的一格**（2026-10-30 四路审计 P0 D-01 定案）：
 *
 * `reg.exe` 的输出**不是 UTF-8**，而是**系统 OEM 代码页**
 * （中文 Windows = **GBK/CP936**，英文 = CP1252）。旧实现写死
 * `encoding: 'utf8'` ⇒ 路径里的中文被解成 **U+FFFD**（**不可逆**）⇒
 * 拼出**不存在的目录** ⇒ 「便携版已修好」在中文路径下**从未成立**。
 *
 * 实测取证（本机中文 Windows，写入临时 HKCU 键后删除）：
 * ```
 * stdout hex: …28 c4 ac c8 cf 29…  REG_SZ  …44 3a 5c d6 b5 c5 eb…
 *              ↑↑↑↑↑↑↑↑ GBK 的「默认」二字    ↑↑↑↑↑↑ GBK 的「我的工具」
 * utf8 解码 => "…    (Ĭ��)    REG_SZ    D:\�ҵĹ���\Chrome\App\chrome.exe"
 * gbk  解码 => "…    (默认)    REG_SZ    D:\我的工具\Chrome\App\chrome.exe"  ✅
 * ```
 *
 * ⇒ 修法：**取原始字节**（`encoding: 'buffer'`）再按**系统代码页**解码。
 * ⚠️ 代码页**必须按系统语言选**（见 {@link registryCodePage}）——
 * **不能无条件先试 `gb18030`**（英文 Windows 上会把 1252 的字节解成别的字符）。
 * ⚠️ Node 内置 `TextDecoder` 支持 `gb18030` / `windows-1252`（实测 Node 22 可用）。
 *
 * ⚠️ **更稳的替代**：`reg export` 输出 **UTF-16LE**（无代码页歧义）⇒
 * 用 `TextDecoder('utf-16le')` 解即可。本实现**不用**它是因为 `reg export`
 * 需要导出整棵子树、输出体积大得多；`/ve` 单值查询 + 代码页解码已足够，
 * 且**存在性过滤**（见下）会把解错的路径直接筛掉。
 */
export declare function windowsRegisteredBrowserPaths(query?: (key: string) => {
    status: number | null;
    stdout: string;
}): string[];
/**
 * 本机 `reg.exe` 输出用的**代码页**（`'gb18030'` 或 `'windows-1252'`）。
 *
 * ⚠️⚠️⚠️ **不能无条件先试 `gb18030`**（2026-10-30 第二轮审计发现并修）：
 * 两个解码器**都能解任何字节序列**（`fatal: false`）⇒ 「先试 gb18030」在
 * **英文 Windows**（代码页 1252）上会把 1252 的字节解成**别的字符**：
 * ```
 * 路径 C:\Users\José\Chrome
 *   gb18030    ⇒ "C:\Users\Jos閈\Chrome"   ← 错了
 *   windows-1252 ⇒ "C:\Users\José\Chrome"  ✅
 * ```
 * ⇒ 在英文系统上，路径被解错 ⇒ **存在性过滤把它筛掉** ⇒ 整条注册表腿
 * **静默失效**（比「解成 U+FFFD」更难发现，因为它至少还是有效文本）。
 *
 * ⚠️⚠️⚠️ **判据源必须是「注册表里的 OEMCP」，不能是 `Intl` 的 locale**
 * （2026-10-30 第二轮审计 P1-1 修）：第一版按 `Intl.DateTimeFormat()
 * .resolvedOptions().locale` 判「CJK ⇒ GBK」⇒ **ja / ko / zh-TW 全错**：
 * - 日文 Windows 的 OEMCP 是 **932（Shift-JIS）** ⇒ `gb18030` 会把 `あ`(82 A0)
 *   解成 `偁`；
 * - 韩文是 **949（EUC-KR）**；
 * - **繁体中文是 950（Big5）** ⇒ `gb18030` 会把 `中` 解成 `い`。
 * ⚠️ 而且 `Intl` 的 locale 是**用户区域格式**、**不一定等于 UI 语言**
 * （「英文 UI + 中文区域格式」的机器会分叉）。
 *
 * ⇒ 修法：读**权威**的 OEM 代码页
 * `HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage` 的 `OEMCP` 值
 * （实测本机 = **936**；命令形态是 `reg query <key> /v OEMCP`）。
 * ⇒ 一次覆盖 936 / 932 / 949 / 950 / 1252 / 65001 六档，且**不依赖语言**。
 */
export type RegistryEncoding = 'gb18030' | 'shift_jis' | 'euc-kr' | 'big5' | 'windows-1252' | 'utf-8';
/**
 * OEM 代码页数值 → `TextDecoder` 的编码名。
 *
 * ⚠️ 只列**实测会用到的**几档（其余一律退回 `windows-1252` —— 存在的
 * 后果只是「解错 ⇒ 存在性过滤筛掉 ⇒ 找不到」，**安全降级**，不会误命中）。
 */
export declare function encodingForOemCodePage(codePage: number): RegistryEncoding;
/** `HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage` 里 `OEMCP` 值的路径。 */
export declare const OEM_CODEPAGE_REG_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\\OEMCP";
/**
 * 读本机的 **OEM 代码页**（权威来源）。
 *
 * ⚠️ 读不出来时返回 `undefined` ⇒ 调用方退回 locale 启发式（再退回 1252）。
 */
export declare function readOemCodePage(query?: (key: string, args: readonly string[]) => {
    status: number | null;
    stdout: string;
}): number | undefined;
/**
 * 本机 `reg.exe` 输出用的**代码页**。
 *
 * ⚠️ **优先读注册表的 OEMCP**（权威、与 UI 语言一致）；
 * ⚠️ 读不到时退回 **locale 启发式**（次优，但比「无条件先试 gb18030」好得多）。
 */
export declare function registryCodePage(oemCodePage?: number, locale?: string): RegistryEncoding;
/**
 * 把 `reg.exe` 的原始输出字节按**系统 OEM 代码页**解码成文本。
 *
 * ⚠️ 中文 Windows 的 OEM 代码页是 **936（GBK）**；英文是 **1252**。
 * ⚠️ **不能**用 UTF-8（中文会变 U+FFFD，不可逆）—— 见
 * {@link windowsRegisteredBrowserPaths} 的头部注释。
 * ⚠️ **也不能**无条件先试 `gb18030`（英文系统上会解错）—— 见
 * {@link registryCodePage}。
 *
 * @param raw - `reg.exe` 的原始输出字节（`encoding: 'buffer'` 拿到的）。
 * @param encoding - 代码页（缺省按 {@link registryCodePage} 判定）。
 */
export declare function decodeRegistryOutput(raw: Buffer | string | undefined, encoding?: RegistryEncoding): string;
/**
 * 把 `reg.exe` 的原始输出字节解码成文本，**并在首选编码解出 U+FFFD 时重试**。
 *
 * ⚠️⚠️ **为什么需要重试**（2026-10-30 第二轮审计）：首选编码**猜错**时，
 * `TextDecoder`（`fatal: false`）**不会抛** ⇒ 只会产出 **U+FFFD** ⇒ 路径被
 * 存在性过滤筛掉 ⇒ 整条注册表腿静默失效。
 *
 * ⇒ 判据：「解出来的文本含 U+FFFD」⇒ 说明这个编码**大概率不对** ⇒
 * 依次试**其它**候选编码，取**第一个不含 U+FFFD** 的。
 *
 * ⚠️⚠️ **但 U+FFFD 也不够**（2026-10-30 第二轮审计）：`gb18030` 解 1252 的 `é`(0xE9)
 * 得到的是 `闈`（U+95C8）——一个「合法」字符，**不含 U+FFFD**！
 * ⇒ 判据必须再加一条：「**备选解码的结果与首选不同**」⇒ 首选可疑 ⇒ 取那个。
 *
 * ⚠️ 候选顺序：首选（权威 OEMCP）→ 1252 → 936 → 932 → 949 → 950 → UTF-8。
 * ⚠️ ⚠️ **纯 ASCII 的输出**（路径里没有非 ASCII）⇒ 任何编码都解得出**同样**
 * 的结果 ⇒ 第一个候选直接命中 ⇒ **零额外开销**（这是绝大多数情况）。
 */
export declare function decodeRegistryOutputWithFallback(raw: Buffer | string | undefined, preferred?: RegistryEncoding): string;
/**
 * 已登记浏览器的默认与便携版 User Data 目录。
 *
 * ⚠️⚠️ **布局不能硬编码「两级」**（2026-10-30 四路审计 P0 D-02 修）：
 * 旧实现用 `dirname(dirname(executable))` —— 它只对 `<install>/App/chrome.exe`
 * 这一种布局成立：
 * ```
 * <install>/App/chrome.exe       → dirname(dirname) = <install>       ✅
 * <install>/chrome.exe           → dirname(dirname) = <install> 的父级 ❌ 高一级
 * <install>/Chrome/App/chrome.exe→ dirname(dirname) = <install>/Chrome ✅（恰好）
 * ```
 * ⇒ 高一级 ⇒ 拼出 `<父级>/Data` ⇒ **永远读不到** ⇒ 静默 0 结果。
 *
 * ⇒ 修法：**逐级向上探测**，取**存在** `Data/Default` 或 `User Data/Default`
 * 的那一级（最多 4 级）。`existsSync` 判据同时把「解错的路径」筛掉。
 *
 * ⚠️ 便携版 Chrome **不注册 App Paths**（那是**安装器**的行为）⇒ 这条腿
 * 在**最需要它的场景**下恒不产出；真兜底是 `MAGICREW_CHROME_USER_DATA`
 * （见 `src/magicrew-local-browser.ts`）。本函数仍值得保留：① 少数工具
 * 确实会登记；② `Data` 候选对**已注册**的绿色版软件仍然有效。
 */
export declare function registeredBrowserUserDataRoots(paths?: readonly string[]): string[];
/**
 * 浏览器可执行文件的**候选链**（按优先级，`ZCODE_CHROME_PATH` 恒排第一）。
 *
 * ## 为什么抽成**纯函数**
 *
 * 候选链按平台分叉后，**macOS / Linux 分支在本仓库的 Windows CI 上一次都执行不到** ——
 * 直接写在 `findBrowserExecutable()` 里，这些路径会永远「静默通过」，
 * 直到用户报障（IKJKNT 就是 macOS 那条的先例）。
 * 抽出来后它们是纯字符串计算，可在任何平台断言。
 *
 * 三个入参都可注入，正是为了这个：`platform` 定分支、`env` 造 scoop /
 * `ZCODE_CHROME_PATH`、`home` 造 `~/Applications` 与 `~/.local/share/flatpak`。
 *
 * ## ⚠⚠ **`else` 分支是 Windows —— 别把它当「非 Win 也走这儿」
 *
 * 三个平台的分支必须**显式**列全。历史上 `linux` 落在 else 里拼出一套
 * `PROGRAMFILES` / `msedge.exe`（Linux 上全不存在 ⇒ 恒找不到浏览器），
 * 与 macOS 那条**完全同型**。**新增平台时务必在这里加一条显式分支。**
 *
 * ## ⚠ 两个必须防的坑（都实测踩过）
 *
 * ### 1. 空环境变量会产生**相对路径**
 *
 * `join('', 'Google', 'Chrome', …)` 返回 `Google\Chrome\…` —— 一个**相对路径**，
 * `existsSync` 会相对**当前工作目录**解析。于是「当前目录下恰好有个同名文件」
 * 会被误判成浏览器，而真正的浏览器却找不到。
 *
 * ⇒ {@link findBrowserExecutable} 只接受**绝对路径**候选（`isAbsolute` 过滤）。
 *
 * ### 2. `USERPROFILE` 不等于家目录
 *
 * scoop 的安装位置在 `~/.scoop` 或 `~/scoop` 下，而 `~` 应当用
 * `os.homedir()` 求（它还会看 `HOME`，且在 `USERPROFILE` 被改写时仍正确）。
 * 用 `process.env.USERPROFILE` 拼路径会在「环境变量异常/被沙箱改写」时失效 ——
 * 实测：把 `USERPROFILE` 指到沙箱后，原本可用的 scoop chromium 就找不到了。
 */
export declare function browserCandidates(input?: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    home?: string;
    /**
     * 存在性判据（**仅** Windows 分支的 scoop PATH 反推用得上，见
     * {@link scoopRootFromPath}）。
     *
     * ⚠️ 注入它是为了让「PATH 里有没有 scoop shims」这一格能**跨平台单测** ——
     * 本仓库 CI 与开发机都是 Windows，但 darwin / linux 分支也必须可断言
     * （IKJKNT 的教训：不可测的分支会静默烂掉）。
     */
    exists?: (path: string) => boolean;
}): string[];
/** 在候选链里挑第一个**存在**的绝对路径。 */
export declare function findBrowserExecutable(): string | undefined;
/**
 * 找不到浏览器时的**用户可执行提示**（按平台说人话）。
 *
 * ## 为什么必须分平台（Gitee issue IKJKNT）
 *
 * 修复前是单一口径：「已尝试 scoop chromium / Chrome / Chromium / Edge；
 * 可用 ZCODE_CHROME_PATH 显式指定 **chrome.exe** 路径。」
 * —— macOS 上 **scoop 根本不存在**、`chrome.exe` 也不是那个文件名
 * （见 {@link MAC_BROWSER_BUNDLES}），用户照着提示做只会更懵。
 * 回归用例见 `tests/unit/zcode-browser-macos.spec.ts`。
 *
 * ⚠ 第二个参数（环境变量名）是抽到共享模块时加的，**默认值保持 zcode 的
 * 原样文案**；库库AI 传自己的变量名，用户看到的出路才不会指错。
 *
 * ## ⚠️⚠️ 第三参 `detail`：把「已尝试什么」与「本进程看到什么」摊开（IKQ4JN 附带建议 1/3）
 *
 * 原文案只说**类别名**（「已尝试 scoop chromium / Chrome / …」），于是：
 *
 * - 用户不知道自己机器上的 `~/scoop` 到底解析成了什么；
 * - 设了 `ZCODE_CHROME_PATH` 却「还是找不到」时，无法判断是**变量没生效**
 *   （从旧终端重启 ⇒ 新进程继承旧环境快照）还是**路径写错**。
 *   —— 这一条会让用户陷入死循环（他以为设了，插件以为没设）。
 *
 * ⇒ 调用方把 {@link findBrowserExecutable} 的**完整候选数组**与本进程读到的
 * 变量值传进来，两者一起回显。**只回显，不参与任何判据** —— 判据仍在
 * `findBrowserExecutable` 一处。
 *
 * ⚠️ 省略 `detail` ⇒ 输出与修复前**逐字节相同**（老调用方与既有用例不受影响）。
 */
export declare function browserNotFoundMessage(platform?: NodeJS.Platform, overrideEnvName?: string, detail?: {
    /** 本次实际尝试过的候选（原样顺序）。 */
    tried?: readonly string[];
    /** 本进程读到的 override 值（`undefined` = 变量不存在）。 */
    overrideValue?: string | undefined;
}): string;
/**
 * 该可执行文件是否是**系统 Edge**（候选链的最后几档）。
 *
 * ## 为什么单独抽成纯函数
 * 「实际用了哪个浏览器」需要被**告警**（issue IKJLB1 的期望行为 2：
 * 用户不知道系统在拿 Edge 兜底）。告警条件必须可测，故不留在启动流程里。
 *
 * ⚠️ 判据是**文件名**（不区分大小写），而不是路径里搜 `Edge`：
 * 前者对 `…\Microsoft\Edge\Application\msedge.exe`、scoop 布局、
 * macOS 的 `…/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` 以及
 * 用户经 `ZCODE_CHROME_PATH` 指向的 Edge 副本都成立；
 * 后者会把路径中恰好含 "Edge" 字样的第三方 chromium 误报成系统 Edge。
 *
 * ⚠⚠ **macOS 那个名字是同型缺陷的修复**（2026-10-03，issue IKJKNT）：
 * 原判据只认 `msedge.exe`，而 macOS 包内二进制叫 **`Microsoft Edge`**
 * （无扩展名）⇒ Mac 用户落到 Edge 兜底时**一声不吭**，与 IKJLB1
 * 的期望行为 2 直接冲突。补这个别名时别把判据改成 `includes('edge')`
 * —— 那会把 `Brave Browser` 之类的路径误伤。
 */
export declare function isEdgeExecutable(executable: string): boolean;
/**
 * **浏览器部署错误**：本机没配好（找不到可执行文件 / 起不来），
 * 重试一万次也不会成功。
 *
 * ## ⚠️⚠️ 为什么需要把它与其它错误区分开（Gitee issue IKQ4JN 根因②）
 *
 * 上层（`zcode-auth.ts`）把 captcha 产出失败记进**设备信誉退避**
 * （{@link CaptchaBackoff}）—— 那是对的：`mintOnPage` 抛错说明本机产出能力
 * 出了问题，继续试只会更糟。
 *
 * 但**「找不到浏览器」不是产出能力问题，是部署问题**。原实现一视同仁，
 * 于是第 3 次点击就进入 60s 冷却，用户看到的是
 * 「captcha 产出处于冷却中…这通常意味着**设备信誉不足**」
 * —— 把「本机没装浏览器」说成「设备信誉不足」，方向完全相反。
 * 报障人原话：「本次排查最耗时的就是这一步：我一开始真去查了设备信誉」。
 *
 * ## 为什么用**带标记的错误类**而不是字符串匹配
 *
 * 本仓库明列「判据必须打在行为上，源码/文案正则有假红假绿」。message 会随
 * 文案微调漂移（而文案本来就要为可读性改），类与字段不会。
 *
 * ## ⚠️ 本模块**不** import `captcha-backoff.ts`
 *
 * 那样会让「通用浏览器模块」反向依赖 zcode 的 captcha 语义，且 `captcha-backoff`
 * 将来若 import 别的东西就可能成环。⇒ 这里只抛一个**自带 `deployKind` 标记**
 * 的错误，由上层（`zcode-auth.ts`）判它是否要计入退避 —— 判据落在上层，
 * 本模块保持平台中立。
 */
export declare class BrowserDeploymentError extends Error {
    /** 机器可读细分类（不参与任何文案判据，仅供上层分流与日志聚合）。 */
    readonly deployKind: 'browser-not-found' | 'browser-spawn-failed';
    constructor(message: string, deployKind: 'browser-not-found' | 'browser-spawn-failed');
}
/**
 * 该错误是否属于「浏览器部署错误」。
 *
 * ⚠️ 判据用 **`deployKind` 字段**而不是 `instanceof`：跨模块副本（两个不同
 * 路径的包各有一份模块实例）时 `instanceof` 会因类身份不同而**假红**
 * —— 本仓库记过这条教训。字段判据对副本免疫。
 *
 * ⚠️ 但仍然要求 `name` 也对，避免恰好也叫 `deployKind` 的第三方错误误判。
 */
export declare function isBrowserDeploymentError(error: unknown): boolean;
/**
 * 把窗口从**任务栏**移除（按平台分派；整体失败静默）。
 *
 * ## 为什么需要（用户报障，2026-09-29）
 *
 * > captcha 的 chromium 每次刷新页面完成都会在任务栏**闪烁提示**；
 * > 任务栏自动隐藏时会不停浮出，挡住屏幕最下面一排。
 *
 * 根因（Win32 实测）：主窗口缺 `WS_EX_TOOLWINDOW`（`0x80`），
 * 而 `--window-position=-32000,-32000`（移出屏幕）**不足以**让它不进任务栏 ——
 * 页面一渲染就获得任务栏按钮，有按钮就有东西可闪。
 *
 * ## 实测取证（Windows，13 个窗口）
 *
 * | 项 | 结果 |
 * |---|---|
 * | 打上后 `inTaskbar` | 13 个窗口**全部 false** |
 * | 连续 3 次 mint 后样式是否被重置 | **全部保持**（不会被 chromium 重置） |
 * | 对 captcha 功能的影响 | mint 仍成功（1802~1950ms） |
 * | 成本 | 约 1.2 秒（**这是这一步 PowerShell 自身的耗时，不是 mint 的耗时**）；**只需在启动时做一次**，可与约 3.7 秒的启动并行 ⇒ 几乎免费 |
 *
 * ⚠ **失败必须静默**：这是「减少打扰」的优化，不是功能依赖。
 * 借外部工具都有失败可能（策略限制/无权限/未安装），此时最坏结果是回到
 * 修复前的行为（窗口在任务栏），**绝不能让 captcha 因此不可用**。
 *
 * ⚠ 调用**时机**由 {@link ChromiumSession} 保证：必须在页面渲染**之前**
 * （否则窗口已获得任务栏按钮）。
 *
 * @param pid 目标浏览器主进程 pid。
 * @param log 诊断回调（可选）。macOS 藏窗失败时用它告警一次，原因见
 *   {@link hideWindowMacos}：失败被静默吞掉，用户报「窗口还是弹出来」时
 *   没有这条日志就只能猜。
 */
export declare function hideWindowFromTaskbar(pid: number, log?: (message: string) => void): void;
/**
 * macOS：把该 pid 的 chrome 窗口**最小化**（`set miniaturized of every window to true`）。
 *
 * ## 为什么是最小化（而非 osascript 移屏 / 1x1）
 *
 * 真机（macOS，主屏 0,0 1470×956）对 4 种藏法逐一验证了「窗口是否仍挂在
 * 屏幕可见区」与「captcha 是否仍能 mint」：
 *
 * | 藏法 | 命令 | captcha 实测 |
 * |---|---|---|
 * | 最小化 | `set miniaturized … to true` | **稳**（10/10 mint OK，paramLen 280） |
 * | 移到 -32000 | `set position … to {-32000,-32000}` | **偶发 `F001`**（窗口离屏时 SDK 取证帧偶尔拿到空 canvas） |
 * | 1×1 缩到角 | `set size … to {2,2}` | 偶发 F001（同上，渲染尺寸过小触发 SDK 重试） |
 * | `--headless=new` | （启动参数） | 一律 `F001`，**不可用** |
 * | `chrome-headless-shell.exe` | （候选） | 一律 `F001`（issue IKQ4JN 实测），**不可加进候选链** |
 *
 * 结论：macOS 上**最小化是唯一同时满足「不挡屏幕」与「mint 稳定」**的做法。
 * 最小化后窗口缩到屏幕右下角（Dock 区），肉眼几乎不可见，且不破坏 captcha。
 *
 * ## 为什么不用 osascript `set position`（移屏）
 *
 * `--window-position=-32000,-32000` 已经传给了 chromium，但
 * **macOS 的 WindowServer 会把离屏窗口钳回屏幕内**（与 `--headless` 相反，
 * 这是系统行为，不是 chromium 行为）。所以「移屏」这条在 macOS 上等于没移。
 * 最小化则不受该钳制影响（窗口仍在屏幕坐标系内，只是缩到角上）。
 *
 * ## ⚠⚠ 依赖：宿主必须已授予 macOS「辅助功能」权限（与 Linux 的 wmctrl 不同）
 *
 * | | Linux | macOS |
 * |---|---|---|
 * | 机制 | WM 协议（EWMH 客户端消息） | `osascript` 驱动 System Events 的 UI 脚本 |
 * | 依赖 | 外部工具 `wmctrl` | 系统自带 `osascript`，**但 UI 脚本需宿主被授予「辅助功能」权限** |
 * | 缺了怎么办 | `apt install wmctrl`，一条命令 | 系统设置 → 隐私与安全性 → 辅助功能 → 勾选宿主，**通常还要重启应用** |
 * | 用户知道吗 | 报错会说「没装 wmctrl」 | **大多数人不知道这个权限存在**，且授权可能随应用升级被重置 |
 *
 * ⇒ 未授权时 `osascript` 非零退出，被本函数的静默语义吞掉，**窗口照常弹出**。
 * 这是「减少打扰」的优化失效，不是功能故障；用户报「窗口还是弹出来」时先查这一项。
 *
 * ## 接入与失败语义（与 Windows/Linux 侧对称）
 *
 * - **失败必须静默**：这是「减少打扰」的优化，不是功能依赖。`spawn` 的
 *   `error`/非零退出都直接吞掉，最坏结果回到修复前的行为（窗口正常弹出），
 *   **绝不能让 captcha 因此不可用**。
 * - 与 Windows 侧一样用 `windowsHide: true` + `stdio: 'ignore'` 异步 fire-and-forget。
 * - **只按 pid 匹配**（`unix id`），刻意没有「按进程名兜底」—— 理由与代价见
 *   {@link hideWindowMacos} 的函数头。
 * - ⚠ 本函数是**唯一**拼 AppleScript 的地方，且**只插值一个整数**：
 *   没有字符串插值 ⇒ 没有引号/反斜杠转义问题（初版的进程名兜底栽在这里）。
 *
 * @param pid 目标浏览器主进程 pid。
 * @returns `osascript` 参数数组（`-e <script>`），纯函数便于单测锁死。
 */
export declare function buildMacosMiniaturizeArgs(pid: number): string[];
/**
 * 构造「把窗口加入 `_NET_WM_STATE_SKIP_TASKBAR`」的 `wmctrl` 参数。
 *
 * ⚠ `-i` 必带：让 `-r` 按**窗口 id** 匹配（`0x...`），而不是按标题 ——
 * 标题里有空格/括号（chromium 的标题是「新标签页 - Chromium」）会被误解析。
 *
 * ⚠ **只加 `skip_taskbar`，不加 `skip_pager`**：前者即「不出现在任务栏」
 * （这正是要的）。`skip_pager` 是「不出现在工作区切换器」，与本次目的无关，
 * 多加会改变用户对窗口的既有预期（用户没要求隐藏工作区条目）。
 *
 * ⚠ 也**不**用 `-b add,hidden`（最小化）：chromium 已经用
 * `--window-position=-32000,-32000` 移出屏幕，再改最小化状态会与
 * captcha 流程的窗口假设冲突（那些流程依赖窗口"存在且可渲染"）。
 */
export declare function buildLinuxSkipTaskbarArgs(windowId: string): string[];
/**
 * 从 `wmctrl -lp` 的输出里筛出**属于指定 pid** 的窗口 id。
 *
 * 输出格式（每行，字段以空白分隔）：
 * ```
 * 0x0320000a  0 12345  hostname  Window Title
 * └─ 窗口 id  │  └─ pid
 *            └─ 桌面号
 * ```
 *
 * ⚠ **标题可能含任意空白**，故只能按「前 4 个字段」切分，**不能**整体
 * `split(/\s+/)` 后取全部 —— 那样标题会被拆散（对本用途无害，但会让人
 * 误以为解析"完全正确"）。
 *
 * ⚠ 只取**前 4 个字段**：第 4 列（hostname）之后全是标题。
 * 用 `split(/\s+/, 5)`（限 5 段）恰好把标题保留为最后一段。
 *
 * @returns 属于该 pid 的窗口 id（形如 `0x0320000a`）；解析不到就返回空数组。
 */
export declare function parseWmctrlList(output: string, pid: number): string[];
/** 极简 CDP 客户端（用 Node 内置 WebSocket，**零第三方依赖**）。 */
export declare class CdpConnection {
    private readonly ws;
    private nextId;
    private readonly pending;
    constructor(ws: WebSocket);
    /**
     * 发送一条 CDP 命令并等结果。
     *
     * ⚠️ **`sessionId` 是给页面级命令用的**（2026-10-08 实测踩到）：
     * 浏览器级端点只认 `Target.*` / `Storage.*` / `Browser.*` 这类命令；
     * 一旦用 `Target.attachToTarget { flatten: true }` 拿到 `sessionId`，
     * **此后每条页面级命令都必须带上它**，否则命令落在**浏览器端点**上，
     * 回报的是一句含糊的 `-32601 'XXX' wasn't found`
     * —— 看起来像「API 不存在」，实际是「你没说要发给哪个页面」。
     *
     * ⚠️ 同一条实测还纠正了两个流传的说法：**浏览器级没有**
     * `Network.getAllCookies`，也**没有**浏览器级 `Network.getCookies`
     * （都回 `-32601`）。要读 cookie，浏览器级的唯一可用命令是
     * `Storage.getCookies`，且**不需要 `sessionId`**。
     */
    send(method: string, params?: Record<string, unknown>, timeoutMs?: number, sessionId?: string): Promise<unknown>;
    close(): void;
}
/** 可被 `unref` 的 sleep（生产由 HTTP server 撑着 event loop）。 */
export declare const sleep: (ms: number) => Promise<void>;
/** {@link ChromiumSession} 的启动选项。 */
export interface ChromiumSessionOptions {
    /** 可执行文件；缺省用 {@link findBrowserExecutable} 自动探测。 */
    executablePath?: string;
    /** 调试端口；缺省挑一个空闲的。 */
    debugPort?: number;
    /**
     * 是否把窗口藏起来（默认 **true** —— 不打扰用户）。
     *
     * ⚠️ 库库AI 的登录**必须可见**（用户要自己操作），故它传 `false`。
     */
    hideWindow?: boolean;
    /** 临时 profile 目录的前缀（便于在 `%TEMP%` 里认领）。 */
    profilePrefix?: string;
    /** 就绪等待上限（毫秒，默认 30000）。 */
    readyTimeoutMs?: number;
    /** 窗口尺寸（`宽,高`）。 */
    windowSize?: string;
    /** 启动后要打开的地址（缺省不开页面，由调用方用 CDP 建 target）。 */
    initialUrl?: string;
    /** 追加的命令行开关。 */
    extraArgs?: string[];
    /**
     * 错误文案的**产品前缀**（如 `zcode`）。
     *
     * ⚠️ 抽成参数是为了让既有产品的报错**逐字不变** —— 那些文案有回归用例锁着。
     */
    label?: string;
    /**
     * 「找不到浏览器」文案里紧跟其后的括注（默认空）。
     *
     * ⚠️ 同样是为了**逐字保持**既有产品的报错（zcode 原句带
     * 「（用于产出阿里云 captcha）」）。新调用方不需要就留空。
     */
    notFoundHint?: string;
    /**
     * Edge 兜底告警里的产品名（默认取 {@link label}）。
     *
     * ⚠️ 也是**逐字保持**用的：zcode 原句写的是 `zcode captcha`，
     * 而它的错误码前缀是 `zcode` —— 两个口径不同，故必须能分开给。
     */
    edgeLabel?: string;
    /** 提示用户「换浏览器」时用的环境变量名（默认 `ZCODE_CHROME_PATH`）。 */
    overrideEnvName?: string;
    /** 诊断输出（缺省静默）。 */
    log?: (message: string) => void;
}
/**
 * 一个常驻的 chromium 会话：进程 + 调试端口 + CDP 通道。
 *
 * 生命周期：`start()` → 用 `cdp.send(…)` → `kill()`（只杀进程树 + 关通道）
 * 或 `dispose()`（再删临时 profile）。
 *
 * ⚠️ **`dispose()` 必须被调用**，否则会留下一个孤儿 chromium
 * （约 200-400MB）；`kill()` 与 `dispose()` 的分工见各自注释。
 */
export declare class ChromiumSession {
    private readonly options;
    private child;
    private ws;
    /**
     * 浏览器级 CDP 通道。
     *
     * ⚠️ 是**公开可写字段**（不是私有 + getter）：既有回归用例直接注入桩
     * （`tests/unit/zcode-page-prepared.spec.ts`），换成访问器会改变它们的写法。
     */
    cdp: CdpConnection | undefined;
    private profileDir;
    private port;
    private starting;
    /**
     * 浏览器**起不来 / 自己没了**的可读原因（由启动流程里的
     * `'error'` / `'exit'` 监听写入，见该处注释）。
     *
     * `undefined` = 一切正常。轮询循环每轮检查它，命中即立刻失败 ——
     * 否则「浏览器秒退」要白等满 `readyTimeoutMs`（默认 30 秒）才报错。
     */
    private spawnFailure;
    private readonly log;
    constructor(options?: ChromiumSessionOptions);
    /** 浏览器是否已就绪。 */
    get ready(): boolean;
    /** 调试端口（诊断与 `/json/list` 用）。 */
    get debugPort(): number;
    /** 浏览器主进程 pid（清理与诊断用）。 */
    get pid(): number | undefined;
    /**
     * 本次会话的临时 profile 目录（即传给 chromium 的 `--user-data-dir`）。
     *
     * ⚠️ 存在的唯一用途：**从**这个目录里读登录态。`magicrew` 的网页版登录
     * （`magicrew-browser-login.ts`）必须把 `readMagicrewLocalCreds` 的 `roots`
     * 指到这里 —— 它缺省扫**用户真实浏览器**的目录，而本会话用的是
     * `mkdtempSync` 出来的一次性目录，不去指就是「恒读不到 + 完全静默」。
     *
     * ⚠️ `undefined` = 还没启动（或已被 {@link dispose} 收掉）。本 getter **只读**：
     * 目录的创建与删除仍由 {@link launch} / {@link dispose} 独占，
     * 别在外部 `rmSync` 它（`dispose()` 里那套退避重试是真实缺陷换来的）。
     */
    get userDataDir(): string | undefined;
    /**
     * 浏览器进程是否**已经退出**（含用户自己关掉了窗口）。
     *
     * ⚠️ 判据是「`child` 已置空**且** `spawnFailure` 已就位」——`launch()` 的 `'exit'`
     * 监听只在**它自己**退出时同时满足这两条（主动 `kill()` 会先把 `child` 置空，
     * 那一刻 `spawnFailure` 仍是 `undefined`；启动前两者也都为空）。
     *
     * 用途：登录类流程（`magicrew-browser-login.ts`）据它**提前**结束等待 ——
     * 用户关窗后若还耗满 4 分钟预算，用户看到的是「明明关掉了却还在转圈」。
     */
    get exited(): boolean;
    /**
     * 浏览器级 WebSocket。
     *
     * ⚠️ 与 {@link cdp} 同理：公开可写，供既有用例注入桩。
     */
    get socket(): WebSocket | undefined;
    set socket(value: WebSocket | undefined);
    /** 启动（幂等：并发调用共享同一次启动）。 */
    start(): Promise<void>;
    private launch;
    /**
     * 终止浏览器进程**树**并清理所有 CDP 连接（**保留**临时 profile）。
     *
     * ⚠ 与 {@link dispose} 的分工：`kill()` 用于「还要重来一次」的场景
     * （captcha 轮询超时后会重新 `start()`），故不能删 profile。
     *
     * ## ⚠ 为什么必须杀**整棵树**（真实缺陷）
     *
     * 早期只写 `child.kill()` —— 那只杀**主进程**。而 Chromium 是
     * **多进程架构**（browser / gpu / renderer / utility 各一个进程），
     * 主进程被 `SIGTERM` 后**子进程会变成孤儿继续运行**。
     *
     * 实测证据（一次被中断的测试后）：
     *   - **12 个** 残留 `chrome.exe` 全指向同一个 `--user-data-dir`
     *   - **28 个**残留的临时 profile 目录
     *
     * 生产影响：**每次会话泄漏约 200MB**（一个 Chromium 实例），
     * 且残留进程占着调试端口，会干扰后续启动（曾让一次 `max` 档位测试
     * 表现得像「卡住 80 秒」，实为旧实例干扰）。
     *
     * 修法：POSIX 用进程组（`detached: true` + `kill(-pid)`），
     * Windows 用 `taskkill /T /F`（`/T` = 含子进程树）。
     */
    kill(): void;
    /**
     * 终止浏览器及其**全部子进程**。
     *
     * ⚠ 不能退回成 `child.kill()`（见 {@link kill} 的说明：会留下孤儿）。
     *
     * ⚠⚠ **必须同步等它做完**（真实缺陷）：早期用异步 `spawn('taskkill', …)`
     * 后立即返回 —— 调用方以为清理完了、紧接着启动下一轮，而旧实例**还活着
     * 占着端口**。若下一轮随机撞到同一端口就会串成：
     * 连到旧实例 → `child` 指向已退出的新进程 → `dispose()` 打空 →
     * **旧实例整棵树泄漏**（实测 10~14 个进程）。
     *
     * 实测对照：`dispose()` 后**立即**下一轮会偶发泄漏；
     * 每轮间隔 2.5 秒则 5/5 干净 —— 正是「没等它退完」的特征。
     *
     * 故改用 `spawnSync`：清理路径阻塞几十毫秒是可接受的，
     * 换来确定性的「返回即已终止」。
     */
    private killProcessTree;
    /**
     * 关闭浏览器并清理临时 profile。
     *
     * ⚠ 删除要**重试几次**：chromium 的子进程刚被 taskkill 掉，
     * 句柄释放有延迟 —— 一次性 `rmSync` 实测会留下 28 个残留目录。
     * 用退避重试（100/500/1500ms），全部失败就交给系统回收临时目录。
     */
    dispose(): void;
}
//# sourceMappingURL=chromium-session.d.ts.map