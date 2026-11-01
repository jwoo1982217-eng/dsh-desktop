/**
 * 从**本机浏览器的 localStorage** 里读 magicrew 登录态 —— 不开窗口、不让用户粘任何东西。
 *
 * 这是超级麦吉三种登录方式里**最简单、无门槛**的一条：用户只要在 Edge / Chrome 里
 * 登录过 `www.letsmagic.cn`，凭据就已经躺在磁盘上了。
 *
 * ## ═══ 为什么需要这条路 ═══════════════════════════════════════════════
 *
 * magicrew 没有 OAuth 回调通道，所以「用户在网页上登录成功」这件事，插件原本只能靠
 * 「自己起的那个浏览器」知道。于是有一个反复被报的现象：**用户在自己浏览器里登好了，
 * 插件里却没有多出账号** —— 因为那是另一个浏览器。
 *
 * 但凭据其实就躺在本地：Chromium 系（Edge / Chrome / Brave / 国产 Chromium 系）把
 * localStorage 明文写在
 *
 *     <User Data>/<Default|Profile N>/Local Storage/leveldb/*.log|*.ldb
 *
 * 里，key 是 `_<origin>\x00\x01<name>`，值是 JSON。
 *
 * ## ═══ 读法（与参考实现逐条对齐）═══════════════════════════════════════
 *
 * 把 leveldb 目录按 **latin1** 拼成文本 → 以站点 host 出现的位置开一个 **2000 字节
 * 窗口** → 在窗口里找 `"key":"authorization"` 与 `"key":"organizationCode"`。
 *
 * ⚠️ LevelDB **按 key 排序**，同一 origin 的记录（theme / i18n / userInfo /
 * authorization / organizationCode …）挨在一起，所以窗口内配对是可靠的
 * （实测本机 Edge：`www.letsmagic.cn` 命中、`www.magicrew.ai` 不命中，不会串）。
 * ⚠️ 窗口必须按 **origin** 截断：两个站点的记录可能相邻（用户两个都登录过），
 * 2000 字节的窗口会把国际站的 org 配到国内站的 jwt 上。
 *
 * 成本：本机 Edge 27 MB / 34 ms；全扫通常 < 300 ms。
 *
 * ## ⚠️ 只读
 *
 * 不写文件、不改浏览器数据、不碰 cookie。本模块唯一的副作用是 `readdirSync` /
 * `readFileSync`。
 *
 * ## ⚠️ 不读 magpie 自己的目录
 *
 * 参考实现（`magpie-magicrew-auth/src/local-browser.mjs`）与它同目录，但**刻意不读**
 * `~/.config/magpie` —— 那是 magpie 的落点，本插件不该依赖另一个产品的私有目录。
 */
/**
 * 窗口宽度。
 *
 * 同一个 origin 的若干条记录挤在一起，2000 字节足够覆盖到 `organizationCode`；
 * 太小会漏、太大可能跨到另一个站点。
 */
export declare const MAGICREW_LOCAL_WINDOW = 2000;
/** 登录态（本模块的产物）。⚠️ 字段名由调用方转成 `MagicrewCredential`（`jwt` 同名）。 */
export interface MagicrewLocalCreds {
    /** 网页 JWT。 */
    readonly jwt: string;
    /** 组织码 —— 必须与 jwt 配对（错配会得到 HTTP 200 + `code:403`）。 */
    readonly organizationCode: string;
    /** JWT `exp` 对应的毫秒时刻；解不出来就没有该字段（**不编造**）。 */
    readonly expiresAt?: number;
}
export interface MagicrewLocalBrowserOptions {
    /** 时钟注入（毫秒），只用于「同一份数据里有多把凭据时挑哪把」。 */
    readonly now?: number;
    /**
     * 注入的浏览器 User Data 根目录（**单测专用**）。
     *
     * ⚠️⚠️ 单测**绝不能**扫真实浏览器目录：那里的数据随机器而变，
     * 用例会「在开发机上绿、在 CI 上红」，还会读到真实用户的登录态。
     * 缺省走 {@link magicrewBrowserRoots}。
     */
    readonly roots?: readonly string[];
}
/** 一个浏览器的 User Data 根目录（`browser` 仅用于日志/诊断）。 */
export interface MagicrewBrowserRoot {
    readonly browser: string;
    readonly root: string;
}
/**
 * 各平台的浏览器 User Data 根目录；不存在就跳过。
 *
 * ⚠️ Windows 为主（本插件用户面），macOS / Linux 照参考实现给全 —— 少一行
 * 只意味着「那个浏览器上的已登录态读不到」，不会报错，极难发现。
 */
export declare function magicrewBrowserRoots(): readonly MagicrewBrowserRoot[];
/** 一个 User Data 根目录下的 profile 目录名（`Default` / `Profile 1` …）。 */
export declare function magicrewProfilesOf(root: string): string[];
/**
 * 一个 User Data 根目录下**全部 profile** 的 leveldb 文本。
 *
 * ⚠️ 多 profile 之间用 `\n` 隔开：不隔开时前一个 profile 的尾部与后一个的头部
 * 会拼成一条**不存在的**记录（可能凭空造出一对 jwt × org）。
 */
export declare function leveldbTextFor(root: string): string;
/** jwt 里的 `iat` / `exp`；解不出来返回 0（**不猜**）。 */
export declare function jwtTimes(jwt: string): {
    iat: number;
    exp: number;
};
/**
 * 在 host 每一次出现的位置开窗，取窗口内同一 origin 的 `jwt × organizationCode`。
 *
 * 截断点 = 「下一个**不同站点**的 origin」，同站点的多条记录不截断。
 *
 * ⚠️ 每把 jwt 配**它自己后面**最近的那个组织码：LevelDB 按 key 排序
 * （`authorization` < `organizationCode`），同一批写入的挨在一起；取「窗口内第一个
 * org」会在同一站点存过多套凭据时配错（症状：HTTP 200 + `code:403` 且极难归因）。
 */
export declare function credsNear(text: string, hostname: string, window?: number): {
    jwt: string;
    organizationCode: string;
}[];
/**
 * 读本机浏览器里属于这个站点的登录态。
 *
 * @param hostname 站点 host，例如 `www.letsmagic.cn`（与 localStorage key 里的
 *                 origin 同源，**不是** API 子域）
 * @returns 取 iat 最新的那份凭据；读不到返回 `undefined`（调用方降级到窗口登录）。
 *
 * ⚠️⚠️ **过期与否不在这里拦**：同一份 leveldb 里可能同时留着一旧一新两套记录
 * （用户重登过），此时优先给**未过期**的那份；但如果**只有**过期的那份，照样返回
 * —— 「凭据过期」由调用方（以及上游）判定，在这里拦掉会让「刚过期但 refresh_token
 * 还能用」的账号**白丢一条自救路径**。
 */
export declare function readMagicrewLocalCreds(hostname: string, options?: MagicrewLocalBrowserOptions): MagicrewLocalCreds | undefined;
//# sourceMappingURL=magicrew-local-browser.d.ts.map