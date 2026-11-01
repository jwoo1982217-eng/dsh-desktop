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

import type { NormalizedProxy } from './opencode.js'

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
export const OPENCODE_BUN_TLS_OPTIONS = {
  minTlsVersion: 'TLS1.2',
  maxTlsVersion: 'TLS1.3',
  /** Bun 不启用 GREASE。 */
  greaseEnabled: false,
  /** 扩展顺序固定（BoringSSL 默认会随机化，必须显式关掉）。 */
  permuteExtensions: false,
  /** ALPN 只有 `http/1.1` —— 上游按它判「不是浏览器」的那一半。 */
  alpnProtocols: ['HTTP1'],
  curvesList: 'X25519MLKEM768:X25519:P-256:P-384',
  cipherList: [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
    'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
    'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
    'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
    'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
    'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
    'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA',
    'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA',
    'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA',
    'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
    'TLS_RSA_WITH_AES_128_GCM_SHA256',
    'TLS_RSA_WITH_AES_256_GCM_SHA384',
    'TLS_RSA_WITH_AES_128_CBC_SHA',
    'TLS_RSA_WITH_AES_256_CBC_SHA',
  ].join(':'),
  sigalgsList: [
    'ECDSA+SHA256',
    'RSA-PSS+SHA256',
    'RSA+SHA256',
    'ECDSA+SHA384',
    'RSA-PSS+SHA384',
    'RSA+SHA384',
    'RSA-PSS+SHA512',
    'RSA+SHA512',
    'RSA+SHA1',
  ].join(':'),
  enableOcspStapling: true,
  sessionTicket: true,
  enableSignedCertTimestamps: true,
  renegotiation: true,
} as const

/**
 * `wreq-js` 的最小本地类型（**刻意不从包里 import 类型**）。
 *
 * ⚠️ 理由：`wreq-js` 是**按平台分发**的可选依赖，装不到匹配包时整个包可能
 * 解析失败。若这里 `import type { RequestOptions } from 'wreq-js'`，`tsc`
 * 会在这种机器上直接报错 ⇒ 把「运行期可回退」退化成「编译期必装」。
 * 类型只用于本文件内部收敛，形状以 3.2.0 的 `.d.ts` 为准。
 */
interface WreqRequestInit extends RequestInit {
  /** 浏览器预设（本模块**不用**它 —— 实测四个预设全 429）。 */
  browser?: string
  os?: string
  /** 自定义模拟参数（本模块只用 `tlsOptions`）。 */
  emulation?: { tlsOptions?: Record<string, unknown> }
  /** 逐请求代理（与 `NormalizedProxy.url` 同形）。 */
  proxy?: string
}

interface WreqModule {
  fetch: (input: string, init: WreqRequestInit) => Promise<Response>
}

/** 动态加载结果（`undefined` = 本机不可用，调用方必须回退）。 */
let wreqModule: WreqModule | undefined
/** 加载是否已经尝试过（失败也置位，避免每个请求都重试一次 500 ms 的解析失败）。 */
let wreqLoadAttempted = false
/** 最近一次加载失败的原因（面板/日志用）。 */
let wreqLoadError: string | undefined

/** 本机是否有可用的 Bun 指纹传输（诊断与日志用）。 */
export function bunTlsUnavailableReason(): string | undefined {
  return wreqLoadError
}

/** 重置加载状态（**仅供单测**：让「缺席回退」用例能反复驱动）。 */
export function resetBunTlsLoaderForTests(): void {
  wreqModule = undefined
  wreqLoadAttempted = false
  wreqLoadError = undefined
}

/**
 * 惰性加载 `wreq-js`。
 *
 * ⚠️ **失败只记一次**：`wreq-js` 解析失败是个**平台级**结论（没有匹配的预编译
 * 包 / 被 Electron 的 asar 真空规则挡住 / 用户手工删过 node_modules），
 * 每个请求重试只是白白多付一次模块解析开销。
 */
async function loadWreq(): Promise<WreqModule | undefined> {
  if (wreqLoadAttempted) return wreqModule
  wreqLoadAttempted = true
  try {
    // ⚠️ 说明符放在变量里，**不要写成字面量** `import('wreq-js')`：
    // ① `tsc` 会为字面量做模块解析，把这层「运行期可缺席」变成编译期强依赖；
    // ② 打包器/asar 真空规则也更倾向于对字面量做静态改写。
    // 本项目刻意**不** import 它的类型（见文件头的 `WreqModule` 说明）。
    const specifier = 'wreq-js'
    const loaded = await import(specifier) as unknown as Partial<WreqModule>
    if (typeof loaded.fetch !== 'function') {
      wreqLoadError = 'wreq-js 已安装但未导出 fetch'
      return undefined
    }
    wreqModule = { fetch: loaded.fetch }
    return wreqModule
  } catch (error) {
    // ⚠️ 只记 message：加载失败的真因可能是 `Cannot find module` 或
    // `*.node is not a valid Win32 application`，两者都会体现在 message 里。
    wreqLoadError = error instanceof Error ? error.message : String(error)
    return undefined
  }
}

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
export async function bunTlsFetch(
  input: string,
  init: RequestInit,
  proxy: NormalizedProxy | undefined,
): Promise<Response> {
  // ⚠️ **单测闸门**（2026-10-30 合并审计补）：`DSH_UNIT_TEST_NO_WREQ=1` 时一律
  // 抛 {@link BunTlsUnavailableError}，让适配器走 `proxyFetch` 回退。
  //
  // 为什么必须有它：本机**装得到** `wreq-js` 时（Windows x64 等主流平台），
  // 适配器单测的传输层桩（`vi.stubGlobal('fetch')` / `vi.mock('undici')`）
  // 全部被本函数**绕过** ⇒ 几十条用例对上游真发请求，实测拿到 401
  // `Invalid credential` / 429 `free_usage_limit`（真实上游响应），假红一片。
  // 作者环境装不到 wreq-js、走回退恰好全绿 ⇒ 该缺陷在他机器上**不可见**。
  //
  // 闸门放在 `bunTlsFetch` 入口而不是 `loadWreq()` 里：加载器测试
  // （`ensureBunTlsLoaded` 的两分支）不碰网络、保持真覆盖；e2e 用独立
  // vitest 配置（`vitest.e2e.config.ts`，不注入该 env），真机验收不受影响；
  // 生产环境不设该 env，行为逐字节不变。
  if (process.env.DSH_UNIT_TEST_NO_WREQ === '1') {
    throw new BunTlsUnavailableError('单测闸门 DSH_UNIT_TEST_NO_WREQ=1：禁用 Bun 指纹真传输层（单测禁止真发网络）')
  }
  const module = await loadWreq()
  if (module === undefined) throw new BunTlsUnavailableError(wreqLoadError)
  const wreqInit: WreqRequestInit = {
    ...init,
    // ⚠️ 刻意**不传** `browser` / `os`：实测四个浏览器预设全部 429，
    // 传了反而把「Bun 形状」顶成浏览器形状。
    emulation: { tlsOptions: { ...OPENCODE_BUN_TLS_OPTIONS } },
    ...proxy === undefined ? {} : { proxy: proxy.url },
  }
  const response = await module.fetch(input, wreqInit)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * `wreq-js` 不可用（本机没有匹配的预编译包等）。
 *
 * ⚠️ 单独一类而不是复用 `TypeError`：调用方要能**只对这一类**回退，
 * 而把「请求真的失败了」也当成「装不上」会把 401/429 吞成一次静默重发。
 */
export class BunTlsUnavailableError extends Error {
  constructor(reason: string | undefined) {
    super(`opencode: Bun 指纹传输不可用（${reason ?? '未知原因'}），已回退到常规 fetch`)
    this.name = 'BunTlsUnavailableError'
  }
}

/** 显式导出加载状态，供接线层决定要不要打一条 warn（只在首次不可用时提示）。 */
export async function ensureBunTlsLoaded(): Promise<boolean> {
  return (await loadWreq()) !== undefined
}
