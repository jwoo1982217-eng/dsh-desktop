/**
 * OpenCode 免费通道的 **Bun 传输层指纹**（`wreq-js` / Rust + BoringSSL）。
 *
 * ## 为什么必须有这一层（2026-10-26 真机实测，非推断）
 *
 * 上游的免费档按**传输层指纹**判定「是不是官方客户端」：同一份 body、同一套
 * 请求头、同一个出口 IP 下逐格对照 ——
 *
 * | 运行时 | 结果 |
 * |---|---|
 * | Node `fetch`（undici / OpenSSL） | **429 `FreeUsageLimitError`** |
 * | `curl.exe`（OpenSSL） | **429** |
 * | `wreq-js` + **浏览器预设**（chrome_149 / chrome_133 / firefox_133 / safari_18） | **全 429** |
 * | `wreq-js` + **Bun 形状的 `tlsOptions`** | **200** ✅ |
 *
 * ⇒ 关键是「**Bun 的 ClientHello**」，不是「某个浏览器」。所以下面的参数是
 *   按 Bun 的握手形状逐项定的，不是一个可随意替换的「伪装档位」。
 *
 * ⚠️ Node 侧**做不到**这件事：`node:tls` 不暴露 cipher/extension **顺序**，
 * 而 Bun 的 JA4 恰恰由顺序决定（无 GREASE、ALPN 只有 `http/1.1`、
 * 首个 key share 是 `X25519MLKEM768`）。这就是本文件存在的全部理由。
 *
 * ## 边界：只换「一次 HTTP 事务」，协议逻辑一行不动
 *
 * 本模块只做「发请求 → 拿回一个原生 `Response`」，**不理解** OpenCode 协议。
 * session id 算法、`dsh_` 工具别名、内置工具集门禁、响应归一、错误分类、槽轮换
 * 全部仍在原处（`opencode.ts` / `opencode-messages.ts` / `opencode-stream.ts` /
 * `opencode-adapter.ts`）。⇒ 不会出现「两套协议判据」。
 *
 * ## ⚠️ 缺席必须回退，不是可选优化
 *
 * `wreq-js` 的平台包是 `optionalDependencies`（按 os/cpu 分发），且装了却没有
 * 匹配预编译包时 npm 会**回退到源码编译**（需要 Rust）。用户机器上完全可能
 * 加载不到 ⇒ 本模块把「加载失败」如实报出来并让调用方回退到常规 fetch：
 * 免费通道会 429（与改动前同形），付费通道与目录/面板**完全不受影响**。
 */
import type { NormalizedProxy } from './opencode.js';
/**
 * Bun ClientHello 的 TLS 层参数（JA4 `t13d1713h1`）。
 *
 * 逐项依据：
 *
 * | 字段 | 依据 |
 * |---|---|
 * | `minTlsVersion` / `maxTlsVersion` | Bun 支持 TLS 1.2 / 1.3 |
 * | `greaseEnabled: false` | Bun 不发 GREASE 扩展 |
 * | `permuteExtensions: false` | Bun 的扩展顺序固定（BoringSSL 默认随机化，必须显式关） |
 * | `alpnProtocols: ['HTTP1']` | Bun 对 zen 端点只协商 `http/1.1` |
 * | `curvesList` | 首个 key share 是 `X25519MLKEM768` |
 * | `cipherList` | 17 项，**顺序即指纹**，别排序、别去重 |
 * | `sigalgsList` | 9 项 |
 * | `enableOcspStapling` / `enableSignedCertTimestamps` / `sessionTicket` / `renegotiation` | Bun 的握手里这几项都在场 |
 *
 * ⚠️ **别凭直觉加扩展**：多一个或少一个扩展都会改变 JA4，而 JA4 是门禁的判据。
 * 动这里必须重新用真机请求验证一次是否仍 200。
 */
export declare const OPENCODE_BUN_TLS_OPTIONS: {
    readonly minTlsVersion: "TLS1.2";
    readonly maxTlsVersion: "TLS1.3";
    /** Bun 不启用 GREASE。 */
    readonly greaseEnabled: false;
    /** 扩展顺序固定（BoringSSL 默认会随机化，必须显式关掉）。 */
    readonly permuteExtensions: false;
    /** ALPN 只有 `http/1.1` —— 上游按它判「不是浏览器」的那一半。 */
    readonly alpnProtocols: readonly ["HTTP1"];
    readonly curvesList: "X25519MLKEM768:X25519:P-256:P-384";
    readonly cipherList: string;
    readonly sigalgsList: string;
    readonly enableOcspStapling: true;
    readonly sessionTicket: true;
    readonly enableSignedCertTimestamps: true;
    readonly renegotiation: true;
};
/** 本机是否有可用的 Bun 指纹传输（诊断与日志用）。 */
export declare function bunTlsUnavailableReason(): string | undefined;
/** 重置加载状态（**仅供单测**：让「缺席回退」用例能反复驱动）。 */
export declare function resetBunTlsLoaderForTests(): void;
/**
 * 用 Bun 指纹发一次请求，返回**原生 `Response`**。
 *
 * ## 为什么必须重新包一层 `new Response(...)`
 *
 * `wreq-js` 返回的 `Response` 来自它自己的 realm，**`instanceof Response` 为 false**
 * （实测：`ctor.name === 'Response'` 但原型链不同）。而本仓库下游要过
 * `normalizeOpencodeResponse` → `consumeOpenAiSse`，前者会 `response.body.pipeThrough`，
 * 后者按原生 `RequestInit`/`Response` 语义判空 —— 跨 realm 对象在这些路径上是
 * 未定义行为。重新包一层是**零拷贝**的（body 是同一个 `ReadableStream`）。
 *
 * @param proxy 逐请求代理；`undefined` = 直连。
 */
export declare function bunTlsFetch(input: string, init: RequestInit, proxy: NormalizedProxy | undefined): Promise<Response>;
/**
 * `wreq-js` 不可用（本机没有匹配的预编译包等）。
 *
 * ⚠️ 单独一类而不是复用 `TypeError`：调用方要能**只对这一类**回退，
 * 而把「请求真的失败了」也当成「装不上」会把 401/429 吞成一次静默重发。
 */
export declare class BunTlsUnavailableError extends Error {
    constructor(reason: string | undefined);
}
/** 显式导出加载状态，供接线层决定要不要打一条 warn（只在首次不可用时提示）。 */
export declare function ensureBunTlsLoaded(): Promise<boolean>;
//# sourceMappingURL=opencode-bun-tls.d.ts.map