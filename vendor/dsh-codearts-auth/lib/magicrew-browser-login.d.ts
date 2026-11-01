/**
 * 超级麦吉（magicrew）**网页版登录**：开一个**独立 profile** 的浏览器窗口、让用户在里面
 * 完成登录，再从那个 profile 的 localStorage 里把凭据读回来。
 *
 * ## 三条登录路径里的第 ② 条
 *
 * | # | 路径 | 门槛 | 实现 |
 * |---|---|---|---|
 * | ① | 从本机浏览器已登录态导入（免开窗） | 零（用户日常浏览器里已登过） | `magicrew-local-browser.ts` |
 * | ② | **网页版登录（本文件）** | 低（开一个干净窗口，用户扫码/输密码） | `startMagicrewBrowserLogin` |
 * | ③ | 手机号 + 密码（宿主侧直接调上游） | 中（要密码，且上游有风控） | `loginMagicrew` |
 *
 * ②存在的原因：①在「用户从没在本机浏览器登过这个站」「用户用的是另一个 profile」
 * 两种情形下**读不到**（且那两种情况与「没登录」在结果上同形）；③要用户把密码交给插件。
 * ②是唯一「用户自己看着官方页面登录、凭据自然落盘」的路径。
 *
 * ## ⚠️⚠️ 为什么必须有**独立 profile**（不是复用用户真实浏览器）
 *
 * 两个理由，各自都踩过：
 *
 * 1. **不能碰用户的 profile**：真实 profile 里有用户的全部 cookie / 会话 / 书签，
 *    且**已被用户自己的浏览器进程独占**（`SingletonLock`）—— 拿它起第二个实例，
 *    Chromium 会把 URL 转交给已存在的实例、自己退出（CDP 端口永远不就绪）。
 * 2. **独立 profile 让「读到的凭据只可能是本次登录写进去的」**：一次性目录从空开始，
 *    于是「读到凭据」这件事本身就能当登录完成的判据。⚠️ 参考实现
 *    （`magpie-magicrew-auth/src/browser-login.mjs` 的 `newProfileDir` 注释）记录过
 *    复用目录的后果：第二个账号登录时一秒内读到**上一个账号**的 jwt ⇒ 建不出新账号
 *    （同一个 accountId/uid 被按契约判成「替换旧账号」）。
 *
 * ## ⚠️⚠️ 打开的是**网页域** `product.webOrigin`，不是 API 子域 `product.host`
 *
 * magicrew 的网页在 `https://www.letsmagic.cn`、API 在
 * `https://i-magic-service.letsmagic.cn`（`product.host`）。localStorage 的 key 是
 * `_https://<origin>\x00\x01<name>`，而**用户只会、也只能在网页域上登录** ——
 * 打开 API 子域会得到一个没有页面的域名（用户当场就懵），按它去扫 localStorage
 * 则**恒读不到**且完全静默。这两格都真实发生过（上一个任务踩过第一个）。
 *
 * ## 读凭据：复用 `magicrew-local-browser.ts`，**不要**重写一份配对逻辑
 *
 * 凭据的配对判据（`"key":"authorization"` × `"key":"organizationCode"`、按 origin
 * 截断窗口、每把 jwt 配**它自己后面**最近的组织码）是**上游错配 ⇒ HTTP 200 +
 * `code:403`** 换来的，只允许有一份实现。⇒ 本文件只做三件事：把
 * `readMagicrewLocalCreds` 的 `roots` 指到**本次的临时 profile 目录**、通过 CDP 读
 * **实时** localStorage、以及轮询。
 *
 * ## ⚠️⚠️ 必须「CDP 实时优先、磁盘兜底」——**只读磁盘是本模块曾经的真缺陷**
 *
 * 真机报障（2026-10-29）：用户在这个窗口里**登录成功**了，插件仍显示「尚未配置账号」，
 * 「网页版登录」白转 4 分钟。根因不是路径错、不是匹配逻辑错：
 *
 * - Chromium 把 localStorage **缓在内存**，只有关窗（或批量提交）才刷到
 *   `<profileDir>/Default/Local Storage/leveldb` ⇒ 「登录完那一刻」磁盘里**还没有**
 *   ⇒ 每 500ms 读一次永远是 `undefined` ⇒ 4 分钟超时。实测可复现：我们起的 profile
 *   目录路径是对的（`Default/Local Storage/leveldb` 存在）、用户真实浏览器里的
 *   leveldb 里两个 key 确实相邻（匹配逻辑没问题），但**那一刻**我们这份 leveldb
 *   是空的。
 * - CDP 通路实测可用：`Target.getTargets` → `Target.attachToTarget { flatten: true }`
 *   → `Runtime.evaluate`（带 `sessionId`）能读到页面里的实时 `localStorage`。
 *
 * ⇒ 读凭据的**主路径**是 {@link readCredentialViaCdp}（实时），
 * {@link createProfileCredentialReader}（磁盘）降级为**兜底**（老 Chromium /
 * `--remote-allow-origins` 限制下 CDP 可能不可用）。⚠️ **两腿都要留**：删掉磁盘那条腿
 * 会让「CDP 不可用」的机器变成必然失败；删掉 CDP 那条腿就退回本次报障。
 *
 * ## 浏览器基础设施：全部来自 `chromium-session.ts`
 *
 * 起 chromium / 挑空闲调试端口 / 校验应答端口 / 监听 `'error'` / `taskkill /T` /
 * profile 目录退避重试删除 —— 每一条都是真实缺陷换来的（见该模块头那张表）。
 * 这里**不重写**任何一条，只组合 {@link ChromiumSession}。
 */
import type { MagicrewCredential } from './magicrew-auth.js';
import { readMagicrewLocalCreds } from './magicrew-local-browser.js';
import { type MagicrewProduct } from './magicrew-product.js';
/**
 * 默认等待用户完成登录的上限（**4 分钟**）。
 *
 * ## ⚠️ 为什么是 4 分钟而不是 5 分钟
 *
 * 客户端的登录轮询上限是 **5 分钟**（`plugin-src/client/jet-hub.js` 的
 * `deadline = Date.now() + 300000`，是客户端自己的表、不是服务端超时）。
 * 两边的上限若相同，宿主给出的终态（「等超时了」）会与客户端收表**几乎同时**发生，
 * 用户大概率只看到「登录超时」那句泛化文案、看不到真正的终态原因。
 * ⇒ 宿主必须**早于**客户端收口，留一分钟余量把原因送到眼前。
 *
 * ⚠️ 同时它也是「用户实际需要多久」的实测区间上限（扫码/输密码 2–5 分钟）。
 */
export declare const MAGICREW_BROWSER_LOGIN_TIMEOUT_MS = 240000;
/** 轮询间隔（毫秒）。 */
export declare const MAGICREW_BROWSER_LOGIN_POLL_MS = 500;
/**
 * 一次已起好的网页登录会话。
 *
 * ⚠️ 两个方法就是全部契约：`waitForCredential` **绝不**用抛错表示「用户还没登完」
 * —— 那是正常路径（用户正在输密码），抛错会把「等待」与「失败」混成一件事。
 */
export interface MagicrewBrowserLogin {
    /**
     * 收掉浏览器。**必须**在 `finally` 里调（否则窗口残留）。
     *
     * ⚠️ **幂等**：重复调用不炸（`finally` + 错误路径可能都会走到它）。
     */
    close(): void;
    /**
     * 等待用户在窗口里完成登录，返回凭据；超时 / 已收窗 ⇒ `undefined`。
     *
     * ⚠️ 不抛错（见接口头的说明）。
     */
    waitForCredential(timeoutMs: number): Promise<MagicrewCredential | undefined>;
}
/** {@link startMagicrewBrowserLogin} 的选项。 */
export interface MagicrewBrowserLoginStartOptions {
    /** 产品（国内 / 国际站）。缺省 {@link MAGICREW}。 */
    product?: MagicrewProduct;
    /**
     * 注入点：**单测用假会话，绝不真起浏览器**。
     *
     * ⚠️ 单测**必须**走它（或缺省的 `createChromiumMagicrewLogin` 的
     * `resolveBrowser: () => undefined`）：真起浏览器会在用户桌面弹出窗口
     * ——本仓库记过两次「单测弹出真实浏览器窗口」的真实污染。
     */
    sessionFactory?: (url: string) => Promise<MagicrewBrowserLogin>;
    /** 等待用户完成登录的上限（缺省 {@link MAGICREW_BROWSER_LOGIN_TIMEOUT_MS}）。 */
    timeoutMs?: number;
    /**
     * 诊断输出（透传给 {@link createChromiumMagicrewLogin} 的 `log`）。
     *
     * ⚠️ 必须由**生产**接线接上（见 `magicrew-auth.ts` 的 `loginViaBrowser`）：
     * 放弃等待时那一行「CDP 与磁盘都没读到凭据」是下次报障时唯一能区分
     * 「用户没登」与「我们读的方式坏了」的东西。缺了它，那行日志等于不存在。
     */
    log?: (message: string) => void;
}
/** CDP 通道（只声明本文件用到的那个方法 ⇒ 单测注入假 `send` 即可）。 */
interface CdpChannel {
    send(method: string, params?: Record<string, unknown>, timeoutMs?: number, sessionId?: string): Promise<unknown>;
}
/** 一次「实时读」的结果。 */
export interface MagicrewRealtimeRead {
    /** 读到了就是它。 */
    readonly credential?: MagicrewCredential;
    /**
     * 本次读**失败**的原因（CDP 不可用 / 通道抛错 / 返回不可解析）。
     *
     * ⚠️ `undefined` 有两种含义，**刻意不区分**：① 读到了凭据；② 读通了但用户还没登完
     * （`localStorage` 空 / 缺组织码）—— 后者是**正常路径**，不是故障。
     */
    readonly failure?: string;
}
/**
 * 通过 CDP 读**实时** localStorage。
 *
 * ⚠️ **必须走它而不是读磁盘**：Chromium 把 localStorage 缓在内存，不关浏览器不落盘
 * （真机报障 2026-10-29 —— 磁盘读取的 4 分钟等待里永远是 undefined）。
 *
 * @param session 带 `cdp` 通道的会话（`ChromiumSession` 即可）。
 * @param hostnames 站点 host（**网页域**，例如 `www.letsmagic.cn`；`www.` 前后互认）。
 * @returns 读到 ⇒ 凭据；未登完 / CDP 不可用 ⇒ `undefined`（**绝不抛**，下一轮重试）。
 */
export declare function readCredentialViaCdp(session: {
    cdp: CdpChannel | undefined;
}, hostnames: readonly string[]): Promise<MagicrewCredential | undefined>;
/**
 * 同 {@link readCredentialViaCdp}，但把**失败原因**一并带出来。
 *
 * ⚠️ 存在的理由只有一个：那条「放弃等待」的诊断（见
 * {@link createMagicrewCredentialWaiter} 的 `log`）要能说清「CDP 为什么没读到」。
 * 生产接线用的就是它（把 `failure` 交给等待循环），单测也用它断言「`n === 0`
 * 是正常未完成态、**不是**读失败」—— 这两件事在 `credential` 上同形（都
 * `undefined`），只有 `failure` 能分开。
 */
export declare function readCredentialViaCdpDetailed(session: {
    cdp: CdpChannel | undefined;
}, hostnames: readonly string[]): Promise<MagicrewRealtimeRead>;
/**
 * 造一个「从**本次临时 profile**里读 magicrew 凭据」的读函数。
 *
 * ## ⚠️⚠️ 这就是本模块与「本机浏览器导入」的**唯一**实质差异
 *
 * `readMagicrewLocalCreds` 缺省会扫**用户真实浏览器**的 User Data 根目录
 * （`magicrewBrowserRoots()`）。而网页版登录用的是 `mkdtempSync` 出来的临时目录，
 * 真实目录里**永远是空的**（用户在日常浏览器里登过也不在临时 profile 里）
 * ⇒ 不把 `roots` 指过去，`waitForCredential` 会**恒等到超时**，且完全静默。
 *
 * ⚠️ 注入 `roots: [profileDir]` 也让本函数在单测里可断言：给一个临时目录、
 * 里面写一段 leveldb 文本，就能验证「读得到」与「读的是哪个 origin」。
 *
 * @param profileDir 本次会话的 `--user-data-dir`（`ChromiumSession.userDataDir`）。
 * @param hostname   站点 host（**网页域**，见文件头）。
 */
export declare function createProfileCredentialReader(profileDir: string, hostname: string, deps?: {
    readCreds?: typeof readMagicrewLocalCreds;
}): () => MagicrewCredential | undefined;
/** {@link createMagicrewCredentialWaiter} 的依赖（全部可注入 ⇒ 零真实浏览器、零真实等待）。 */
export interface MagicrewCredentialWaiterDeps {
    /**
     * 读一次**磁盘**（`undefined` = 还没出现）。
     *
     * ⚠️ 这是**兜底**（CDP 不可用的老 Chromium）。主路径见 {@link readRealtime}。
     */
    read: () => MagicrewCredential | undefined | Promise<MagicrewCredential | undefined>;
    /**
     * 读一次**实时** localStorage（CDP，见 {@link readCredentialViaCdp}）。
     *
     * ⚠️ 给了它就**先走它**：Chromium 把 localStorage 缓在内存，磁盘上「用户登录完那一刻」
     * 还没有（真机报障 2026-10-29）。不给则退化成纯磁盘轮询（老用例与降级路径）。
     */
    readRealtime?: () => MagicrewRealtimeRead | Promise<MagicrewRealtimeRead>;
    /** 时钟（毫秒）。缺省 `Date.now`。 */
    now?: () => number;
    /** 等待原语。缺省 `chromium-session` 的 `sleep`（可 `unref`）。 */
    sleep?: (ms: number) => Promise<void>;
    /** 轮询间隔（缺省 {@link MAGICREW_BROWSER_LOGIN_POLL_MS}）。 */
    pollIntervalMs?: number;
    /** 会话是否已收（收窗后立刻放弃等待，不必等到超时）。 */
    isStopped?: () => boolean;
    /**
     * 诊断输出（缺省静默）。
     *
     * ⚠️ 唯一用途：**放弃等待时记一行**「CDP 与磁盘都没读到凭据（CDP 尝试 N 次 /
     * 最后一次 CDP 失败原因：…）」。下次报障时这一行直接区分「用户没登」与
     * 「我们读的方式坏了」—— 少了它，两者在日志里同形。
     */
    log?: (message: string) => void;
}
/**
 * 轮询等待凭据 —— **本模块唯一的等待逻辑**（会话类与单测共用它，不写第二份）。
 *
 * 语义（每条都有用例钉住）：
 * 1. **先读一次再判停止/超时**：`timeoutMs = 0` 时也要给一次机会（否则「刚登完就
 *    超时」这种边界会被判成没登录）；同理，用户登完顺手关窗那一刻凭据已在磁盘上，
 *    停止判据必须**后于**读取（详见循环里的注释）。
 * 2. **每轮先实时（CDP）、再磁盘（兜底）**：顺序是语义，不是风格 —— 见文件头
 *    「必须 CDP 实时优先」。⚠️ 磁盘那条腿**不许删**（CDP 不可用的机器上它是唯一出路）。
 * 3. 到点返回 `undefined`，**不抛错**（见 {@link MagicrewBrowserLogin} 接口头）。
 * 4. 已收窗 / 浏览器已退出 ⇒ 立刻 `undefined`（不必耗满预算）。
 * 5. 每轮最多睡到**剩余预算**为止（不越过 deadline 多睡一格）。
 */
export declare function createMagicrewCredentialWaiter(deps: MagicrewCredentialWaiterDeps): (timeoutMs: number) => Promise<MagicrewCredential | undefined>;
/** 这个 URL 是不是「空白页 / 新标签页」（⇒ 可以安全地导航它）。 */
export declare function isBlankPageUrl(url: string): boolean;
/**
 * 把「初始仍是空白页」的窗口导航到登录页。
 *
 * CDP 就绪早于首屏导航时，启动参数里的 URL 可能尚未落到 page target。
 * 此时不能让用户面对空白页；已有同站点页面则不重复导航。
 *
 * ⚠️⚠️ **失败不抛**（2026-10-30 四路审计 P1 D-06 修）：
 * 旧实现抛错 ⇒ 冒泡到 `createChromiumMagicrewLogin` 的 catch ⇒
 * `session.dispose()` ⇒ `loginViaBrowser` 抛 ⇒ RPC 层 `failLogin` ⇒
 * **占位账号被删、整条登录腿失败** —— 而此时**窗口还开着**、用户完全可以
 * 自己操作 ⇒ 用户看到「登录失败」却明明有个窗口在。
 *
 * ⇒ 现在改成：**导航失败只记一条 warn，登录流程继续**（窗口留着，用户可以
 * 自己在里面登录；凭据等待循环照样能读到）。
 * ⚠️ 与同文件既有纪律同口径：`attemptCredentialViaCdp` 是「任何一步失败都
 * **返回**不抛」。
 * ⚠️ **唯一的例外**：`cdp === undefined`（通道压根没就绪）仍然抛 —— 那时连
 * 「窗口开着」都不成立。
 *
 * @param url - 登录页 URL。
 * @param log - 诊断出口（缺省不记）。
 */
export declare function ensureMagicrewLoginPage(session: {
    cdp: CdpChannel | undefined;
}, url: string, log?: (message: string) => void): Promise<void>;
/** {@link createChromiumMagicrewLogin} 的依赖（生产缺省全接线；单测逐个注入）。 */
export interface ChromiumMagicrewLoginDeps {
    /** 产品常量（只用于诊断文案）。 */
    product?: MagicrewProduct;
    /**
     * 浏览器探测（缺省 {@link findBrowserExecutable}）。
     *
     * ⚠️ **可注入是为了能测「找不到浏览器」那条路**：真机上有浏览器时那条路永远走不到，
     * 而它恰恰是用户最常见的失败（本机没装 Chromium 内核浏览器）。
     */
    resolveBrowser?: () => string | undefined;
    /** 平台（只影响「找不到浏览器」的文案措辞）。缺省 `process.platform`。 */
    platform?: NodeJS.Platform;
    /** 显式指定可执行文件（跳过探测）。 */
    executablePath?: string;
    /** 浏览器就绪上限（缺省 `ChromiumSession` 的 30 秒）。 */
    readyTimeoutMs?: number;
    /** 等待用户完成登录的上限（缺省 {@link MAGICREW_BROWSER_LOGIN_TIMEOUT_MS}）。 */
    timeoutMs?: number;
    /** 轮询间隔。 */
    pollIntervalMs?: number;
    /** 读凭据原语（单测注入）。 */
    readCreds?: typeof readMagicrewLocalCreds;
    /** 登录页导航原语（单测注入，验证 about:blank 修复而不起真实浏览器）。 */
    ensureLoginPage?: typeof ensureMagicrewLoginPage;
    /** 实时读凭据原语（缺省 {@link readCredentialViaCdp}；单测注入假 session）。 */
    readRealtime?: (session: {
        cdp: CdpChannel | undefined;
    }) => Promise<MagicrewRealtimeRead>;
    /** 等待原语（单测注入 ⇒ 零真实等待）。 */
    sleep?: (ms: number) => Promise<void>;
    /** 时钟（单测注入）。 */
    now?: () => number;
    /** 诊断输出（缺省静默）。 */
    log?: (message: string) => void;
}
/**
 * 起浏览器并打开 magicrew 网页登录页（**独立 profile、可见窗口**）。
 *
 * 找不到浏览器 ⇒ 抛 {@link BrowserDeploymentError}（`deployKind: 'browser-not-found'`），
 * 文案里带 {@link browserNotFoundMessage} 的分平台提示与本次**真的尝试过**的候选清单。
 *
 * ⚠️ 这是**唯一**会 `spawn` 浏览器的函数；单测只允许以
 * `resolveBrowser: () => undefined`（测找不到那条路）或干脆不调它。
 */
export declare function createChromiumMagicrewLogin(url: string, deps?: ChromiumMagicrewLoginDeps): Promise<MagicrewBrowserLogin>;
/**
 * 起浏览器打开 magicrew 登录页（独立 profile），返回一个「等用户登完」的会话。
 *
 * ## ⚠️ 打开的 URL 是 `product.webOrigin`，**不是** `product.host`
 *
 * 理由见文件头第二段（API 子域上用户根本没法登录）。这一条有单测钉住
 * （断言注入的 `sessionFactory` 收到的就是 `webOrigin`），因为写错了**不会报错**、
 * 只会永远等不到凭据。
 *
 * @example
 * ```ts
 * const login = await startMagicrewBrowserLogin({ product: MAGICREW })
 * try {
 *   const credential = await login.waitForCredential(120_000)
 * } finally {
 *   login.close()   // ⚠️ 必须：否则窗口与进程残留
 * }
 * ```
 */
export declare function startMagicrewBrowserLogin(options?: MagicrewBrowserLoginStartOptions): Promise<MagicrewBrowserLogin>;
export {};
//# sourceMappingURL=magicrew-browser-login.d.ts.map