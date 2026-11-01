/**
 * `src/network-hint.ts` —— 「连不上」的统一判据与提示。
 *
 * ## 这些用例守的是什么
 *
 * 该模块是从 `gemini-proxy.ts` 的 `geminiNetworkHint` 抽出来的**全仓唯一一份**
 * 判据。抽出来的动机是真实的报障：Qoder 国际版被 SNI 阻断时，面板只显示
 * 「积分查询失败（凭据失效或响应异常）」—— 把**网络不通**说成**凭据问题**，
 * 用户于是反复重新登录，永远修不好。
 *
 * ⇒ 用例分两组：① 判据（哪些错误算「出不去」、哪些**不算**）② 文案
 *（能不能让人据此做对一件事）。
 */

import { describe, expect, it } from 'vitest'

import {
  NETWORK_BLOCKED_CODE_RE,
  collectCauseCodes,
  collectRefusedTargets,
  isNetworkBlocked,
  networkBlockedHint,
  targetsProxyEntry,
} from '../../src/network-hint.js'

/** 造一个带 cause 链的 `fetch failed`（Node/undici 的真实形态）。 */
function fetchFailed(code: string, depth = 1): Error {
  let error: Error = new Error(`leaf ${code}`) as Error & { code?: string }
  ;(error as Error & { code?: string }).code = code
  for (let i = 1; i < depth; i += 1) {
    error = new TypeError('fetch failed', { cause: error })
  }
  return error
}

describe('collectCauseCodes（沿 cause 链收码）', () => {
  it('单层 cause：取到码', () => {
    const error = new TypeError('fetch failed', { cause: fetchFailed('UND_ERR_CONNECT_TIMEOUT') })
    expect(collectCauseCodes(error)).toEqual(['UND_ERR_CONNECT_TIMEOUT'])
  })

  it('多层 cause：能穿到底', () => {
    const error = new TypeError('fetch failed', {
      cause: new TypeError('nested', { cause: fetchFailed('ECONNRESET') }),
    })
    expect(collectCauseCodes(error)).toEqual(['ECONNRESET'])
  })

  it('无码时返回**空数组**而不是 undefined（调用方据此区分「有码不在表里」与「无码」）', () => {
    const codes = collectCauseCodes(new Error('HTTP 500'))
    expect(Array.isArray(codes)).toBe(true)
    expect(codes).toEqual([])
  })

  it('重复码去重', () => {
    const inner = fetchFailed('ENOTFOUND')
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new TypeError('mid', { cause: inner }), { code: 'ENOTFOUND' }),
    })
    expect(collectCauseCodes(error)).toEqual(['ENOTFOUND'])
  })

  it('病态自引用链不会死循环（遍历有上限）', () => {
    const loop: Error & { cause?: unknown } = new Error('loop')
    loop.cause = loop
    expect(() => collectCauseCodes(loop)).not.toThrow()
  })
})

describe('isNetworkBlocked（判「出不去」）', () => {
  it.each([
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'ENOTFOUND',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ECONNRESET',
  ])('%s ⇒ 是', (code) => {
    expect(isNetworkBlocked(fetchFailed(code), false)).toBe(true)
  })

  it('aborted=true 时**不看码**也算（自 arm 的超时没有 UND_ERR_* 码）', () => {
    // ⚠️ 这是 IKLTZ2 审计 P2-2 的实际教训：`AbortSignal.timeout()` 触发的
    //    墙外连接超时没有错误码，只靠码表判会漏掉主症状。
    expect(isNetworkBlocked(new Error('This operation was aborted'), true)).toBe(true)
  })

  it('普通业务错误不算（HTTP 500 / 401 都不是「出不去」）', () => {
    expect(isNetworkBlocked(new Error('HTTP 500'), false)).toBe(false)
    expect(isNetworkBlocked(new Error('unauthorized'), false)).toBe(false)
  })

  it('⚠️ 判据读码不读 message：message 含 ENOTFOUND 但无 code ⇒ 不算', () => {
    // 反例守卫：若实现改成读 message，这条会红。读 message 会把「服务端
    // 恰好回了这段文字」误判成网络故障。
    expect(isNetworkBlocked(new Error('ENOTFOUND in a log line'), false)).toBe(false)
  })
})

describe('collectRefusedTargets（定位失败目标）', () => {
  /** Node「真实形态」的 `ErrnoException`：结构化字段齐全。 */
  function refused(host: string, port?: number): Error {
    const message = port === undefined
      ? `getaddrinfo ENOTFOUND ${host}`
      : `connect ECONNREFUSED ${host}:${port}`
    return Object.assign(new Error(message), {
      code: port === undefined ? 'ENOTFOUND' : 'ECONNREFUSED',
      address: host,
      ...(port === undefined ? {} : { port }),
    })
  }

  it('从**结构化字段**取目标（`fetch failed` 包了一层也能取到）', () => {
    const error = new TypeError('fetch failed', { cause: refused('127.0.0.1', 7897) })
    expect(collectRefusedTargets(error)).toEqual([{ host: '127.0.0.1', port: 7897 }])
  })

  it('包装层只剩 message 时**退回报文解析**（SOCKS 握手 / 自建 dispatcher 的形态）', () => {
    // 没有任何 address / port 字段，只有一句人写的报文。
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7897'), { code: 'ECONNREFUSED' }),
    })
    expect(collectRefusedTargets(error)).toEqual([{ host: '127.0.0.1', port: 7897 }])
  })

  it('⚠️ 只剩**结构化字段**时也要取到（包装层把 message 改写过，地址只在 errno 字段上）', () => {
    // 反例守卫：这条专打「结构化字段」那条腿 —— 上面那条的 message 里
    // 自带地址，报文解析能兜住，**取不到结构化腿失效**。
    const rewritten = Object.assign(new Error('socket hang up'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 7897,
    })
    expect(collectRefusedTargets(rewritten)).toEqual([{ host: '127.0.0.1', port: 7897 }])
  })

  it('⚠️ **只有「目标确定」的码才收**：连接超时带着 address 也不算「没人监听」', () => {
    // 反例守卫：`UND_ERR_CONNECT_TIMEOUT` 说明连接**还没建立**（对端可能只是慢），
    // 把它算成「端口无人监听」会把用户赶去关代理 —— 与我们要修的误归因同型。
    const timeout = Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
      address: '127.0.0.1',
      port: 7897,
    })
    expect(collectRefusedTargets(timeout)).toEqual([])
  })

  it('⚠️ `ECONNRESET` 同样不收（本地代理在跑，是它后面的节点被切断）', () => {
    const reset = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
      address: '127.0.0.1',
      port: 7897,
    })
    expect(collectRefusedTargets(reset)).toEqual([])
  })

  it('读不到任何目标时返回**空数组**而不是 undefined', () => {
    const targets = collectRefusedTargets(new Error('HTTP 500'))
    expect(Array.isArray(targets)).toBe(true)
    expect(targets).toEqual([])
  })

  it('只有一个目标时也能解析 IPv6 方括号形态', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED ::1:7897'), { code: 'ECONNREFUSED' })
    expect(collectRefusedTargets(error)).toEqual([{ host: '::1', port: 7897 }])
  })

  it('去重：同一目标在 cause 链里出现两次只算一个', () => {
    const inner = refused('127.0.0.1', 7897)
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new TypeError('mid', { cause: inner }), {
        code: 'ECONNREFUSED',
        address: '127.0.0.1',
        port: 7897,
      }),
    })
    expect(collectRefusedTargets(error)).toHaveLength(1)
  })

  it('病态自引用链不会死循环', () => {
    const loop: Error & { cause?: unknown } = Object.assign(new Error('loop'), { code: 'ECONNREFUSED' })
    loop.cause = loop
    expect(() => collectRefusedTargets(loop)).not.toThrow()
  })
})

describe('targetsProxyEntry（判「是不是代理入口自己没人监听」）', () => {
  /** 造一个「连代理入口被拒」的完整 cause 链（插件真实拿到的形状）。 */
  function refusedAt(host: string, port: number): Error {
    const leaf = Object.assign(new Error(`connect ECONNREFUSED ${host}:${port}`), {
      code: 'ECONNREFUSED',
      address: host,
      port,
    })
    return new TypeError('fetch failed', { cause: leaf })
  }

  it('命中：被拒的正是用户填的代理入口', () => {
    expect(targetsProxyEntry(refusedAt('127.0.0.1', 7897), 'http://127.0.0.1:7897')).toBe(true)
  })

  it('`localhost` 与 `127.0.0.1` 视为同一族（DNS 解析会让报文与输入不同名）', () => {
    expect(targetsProxyEntry(refusedAt('127.0.0.1', 7897), 'http://localhost:7897')).toBe(true)
    expect(targetsProxyEntry(refusedAt('localhost', 7897), 'http://127.0.0.1:7897')).toBe(true)
  })

  it('⚠️ 端口不同 ⇒ **不算**（不得把「目标站点连不上」说成「你的代理没启动」）', () => {
    // 反例守卫：误报会让用户去关代理，而关掉代理可能让另一个本来能通的渠道一起断。
    expect(targetsProxyEntry(refusedAt('127.0.0.1', 7898), 'http://127.0.0.1:7897')).toBe(false)
  })

  it('⚠️ 主机不同 ⇒ **不算**（被拒的是目标站点，处置是换出口而不是启动代理）', () => {
    expect(targetsProxyEntry(refusedAt('8.222.87.223', 443), 'http://127.0.0.1:7897')).toBe(false)
  })

  it('⚠️ 主机不同但**端口相同**也只是巧合 ⇒ 不算（专打「主机不比对」那条腿）', () => {
    // 反例守卫：上面那条的端口也不同，光靠端口比对就能挡住 ⇒ 取不到
    // 「主机不比对」的变异。这里让端口一致，只有主机判据能挡住。
    expect(targetsProxyEntry(refusedAt('10.0.0.5', 7897), 'http://127.0.0.1:7897')).toBe(false)
  })

  it('⚠️ 代理入口**在跑**、是它后面的节点被切断（ECONNRESET）⇒ 不算', () => {
    const reset = Object.assign(new Error('Client network socket disconnected'), {
      code: 'ECONNRESET',
      address: '127.0.0.1',
      port: 7897,
    })
    const error = new TypeError('fetch failed', { cause: reset })
    expect(targetsProxyEntry(error, 'http://127.0.0.1:7897')).toBe(false)
  })

  it('代理地址解析不了 ⇒ 不算（交回调用方的通用文案，不猜）', () => {
    expect(targetsProxyEntry(refusedAt('127.0.0.1', 7897), 'not a url')).toBe(false)
  })
})

describe('networkBlockedHint（文案即出路）', () => {
  it('命中时：带主体名 + 根因码 + 出路', () => {
    const hint = networkBlockedHint({
      error: fetchFailed('UND_ERR_CONNECT_TIMEOUT'),
      aborted: false,
      subject: 'Qoder 国际版（https://openapi.qoder.sh）',
      remedy: '请在能访问该地址的网络下使用，或导出 HTTPS_PROXY。',
    })
    expect(hint).toBeDefined()
    expect(hint).toContain('连不上 Qoder 国际版（https://openapi.qoder.sh）')
    expect(hint).toContain('UND_ERR_CONNECT_TIMEOUT')
    expect(hint).toContain('HTTPS_PROXY')
  })

  it('无码但 aborted ⇒ 提示里不出现空的括号', () => {
    const hint = networkBlockedHint({
      error: new Error('aborted'),
      aborted: true,
      subject: 'Google',
      remedy: '请配代理。',
    })
    expect(hint).toBe('连不上 Google：请配代理。')
    expect(hint).not.toContain('（）')
  })

  it('不命中时返回 undefined（调用方用自己更精确的措辞，不许拿它兜底）', () => {
    expect(networkBlockedHint({
      error: new Error('HTTP 500'),
      aborted: false,
      subject: 'Google',
      remedy: '请配代理。',
    })).toBeUndefined()
  })
})

describe('NETWORK_BLOCKED_CODE_RE 与 refresh.ts 的判据刻意不同', () => {
  it('本表收 ECONNRESET', () => {
    expect(NETWORK_BLOCKED_CODE_RE.test('ECONNRESET')).toBe(true)
  })
})
