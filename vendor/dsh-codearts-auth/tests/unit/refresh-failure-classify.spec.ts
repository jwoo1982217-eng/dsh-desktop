/**
 * ★★ **续期失败分类器**的守卫（`src/refresh-failure.ts`）。
 *
 * ## 为什么单独建一个文件
 *
 * 这个模块是**两家共用的安全关键判据**：它决定「一把 refresh_token 是不是死了」。
 * 判错的代价是不对称的 ——
 *
 * - 误判成终态 ⇒ 健康账号被标 `refreshable:false`（**单向门**，永不自愈）
 *   ⇒ 用户被要求重新登录；
 * - 漏判终态 ⇒ 死号每 30 分钟白撞一次上游。
 *
 * 两轮审计（实现审计 + 红队对抗）在这个模块上打穿了 **5 处**，全部是同一类错误：
 * **拿宽泛的文案特征去覆盖结构化信息**。本文件的每一格都对应一处实测击穿。
 *
 * ## 变异验证（逐条跑过，全部变红）
 *
 * | 变异 | 本文件里哪一格抓住它 |
 * |---|---|
 * | 状态码白名单复活（`=== 400 \|\| === 200`） | 「422 / 别的 4xx」那格 |
 * | 宽词 `timeout`/`network`/`proxy` 复活 | 「描述字段含触发词」那格 |
 * | `details` 去掉形状守卫 | 「`details: null` 不得崩」那格 |
 * | `statusOf` 不再只认数字 | 「字符串状态码」那格 |
 * | `refreshFailureFromResponse` 只读一把键 | 「业务码信封 `msg`」那格 |
 */
import { describe, expect, it } from 'vitest'
import {
  RefreshFailureError,
  isDefinitiveRefreshRejection,
  isRefreshTransportFailure,
  isTerminalRefreshFailure,
  refreshFailureFromResponse,
} from '../../src/refresh-failure.js'

/** AutoClaw 的自有词汇表（生产里在 `autoclaw-auth.ts` 显式声明）。 */
const AUTOCLAW_TERMS = ['Invalid token', 'invalid_token'] as const

/** 造一个「传输层」错误：`fetch failed` + `cause` 上的真因。 */
function transportError(cause: unknown): TypeError {
  const error = new TypeError('fetch failed')
  ;(error as unknown as { cause?: unknown }).cause = cause
  return error
}

describe('★★ 终态判据：三类**必经**报文必须判对（审计只在这三类上打穿）', () => {
  it('★★ 400 invalid_grant ⇒ 终态（唯一标准判据）', () => {
    expect(isTerminalRefreshFailure(
      new RefreshFailureError('x：HTTP 400 invalid_grant', { status: 400, oauthError: 'invalid_grant' }),
    )).toBe(true)
  })

  it('★★ 5xx / 429 一律**非**终态（含报文里带 expired / revoked 宽词的形态）', () => {
    for (const [status, oauthError] of [
      [503, 'token expired'],
      [500, 'upstream session expired'],
      [502, 'revoked'],
      [429, 'rate limited, key expired soon'],
      [408, 'timeout'],
    ] as const) {
      expect(
        isTerminalRefreshFailure(new RefreshFailureError(`x：HTTP ${status} ${oauthError}`, { status, oauthError })),
        `HTTP ${status} 被判成终态 ⇒ 一次网关抖动/限流就把健康账号标成「需重登」`,
      ).toBe(false)
    }
  })

  it('★★ 传输层失败一律**非**终态（含 `certificate has expired` 这个经典陷阱）', () => {
    expect(isRefreshTransportFailure(transportError(new Error('certificate has expired')))).toBe(true)
    expect(isTerminalRefreshFailure(transportError(new Error('certificate has expired')))).toBe(false)
    expect(isTerminalRefreshFailure(transportError(Object.assign(new Error('x'), {
      code: 'UND_ERR_HEADERS_TIMEOUT',
    })))).toBe(false)
    expect(isTerminalRefreshFailure(transportError(Object.assign(new Error('x'), {
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
    })))).toBe(false)
  })
})

describe('★★ 结构化信息必须**优先于**文案启发式（红队打穿的第一处）', () => {
  it('★★★ `400 invalid_grant` + 描述含 `timed out` ⇒ 仍必须判终态', () => {
    /**
     * ⚠️ 修前的死法：`TRANSPORT_MESSAGES` 里含裸 `timeout`，而
     * `refreshFailureFromResponse` 会把 `error_description` 拼进 message
     * ⇒ 一个**真终态**报文在第①步就被判传输层 ⇒ 死号永不标死、退化成无限 401。
     */
    const error = refreshFailureFromResponse('MiniMax 续期失败', 400, {
      error: 'invalid_grant',
      error_description: 'the token is for a session that timed out',
    })
    expect(isTerminalRefreshFailure(error), '描述里的 "timed out" 把真终态吃掉了').toBe(true)
  })

  it('★ 描述含 `proxy` / `network` / `certificate` 同样不得翻转结论', () => {
    for (const described of ['via proxy', 'network hiccup', 'certificate rotated']) {
      const error = refreshFailureFromResponse('x', 400, {
        error: 'invalid_grant',
        error_description: described,
      })
      expect(isTerminalRefreshFailure(error), `描述 "${described}" 翻转了结论`).toBe(true)
    }
  })

  it('★ 反向：`503` + 同样的描述 ⇒ 仍是**非**终态（网关问题与这把 RT 无关）', () => {
    const error = refreshFailureFromResponse('x', 503, {
      error: 'invalid_grant',
      error_description: 'session that timed out',
    })
    expect(isTerminalRefreshFailure(error)).toBe(false)
  })
})

describe('★ 状态码闸门是**黑名单**而不是白名单（红队打穿的第二处）', () => {
  it('★ 422 / 400 / 200 上的自家词汇都参与判定', () => {
    expect(isTerminalRefreshFailure(
      new RefreshFailureError('x：HTTP 422 invalid_grant', { status: 422, oauthError: 'invalid_grant' }),
    ), '只有 400/200 被放行 ⇒ 别的 4xx 表达拒绝时整格被跳过').toBe(true)
    expect(isTerminalRefreshFailure(
      new RefreshFailureError('x：HTTP 200 Invalid token', { status: 200, oauthError: 'Invalid token' }),
      AUTOCLAW_TERMS,
    ), '业务码信封（HTTP 200 + code 非 0）必须能判终态').toBe(true)
    /**
     * ⚠️⚠️ **`403` 的口径（2026-10-27 自审统一）**：判**非**终态。
     *
     * 此前终态判据只排了 `401`、而 `isDefinitiveRefreshRejection` 排了 `403`
     * ⇒ **两处口径分叉**（同一份 `403 Invalid token` 在终态判据里 true、
     * 在「确定性拒绝」里 false）。
     *
     * 取「不判终态」的理由：`403` 是「禁止访问」，真实世界里更常见于
     * **WAF / 风控 / 地域封锁 / 代理拒绝**（本仓库有实测：国际站按出口 IP
     * 分流时回与凭据失效**逐字同形**的拒绝）—— 都不说明**这一把** RT 死了。
     * 判错的代价是「账号报废、必须重登」，漏判只是「每 30 分钟白撞一次」。
     */
    expect(isTerminalRefreshFailure(
      new RefreshFailureError('x：HTTP 403 Invalid token', { status: 403, oauthError: 'Invalid token' }),
      AUTOCLAW_TERMS,
    ), '★ `403` 不得判终态（WAF/风控/地域封锁与「RT 死了」是两件事）').toBe(false)
    // 反向自证：同一份错误在「确定性拒绝」判据里也必须是 false（两处口径一致）
    expect(isDefinitiveRefreshRejection(
      new RefreshFailureError('x：HTTP 403 Invalid token', { status: 403, oauthError: 'Invalid token' }),
    ), '两处口径必须一致（403 都不是「确定性拒绝」）').toBe(false)
  })
  it('★ 但 401 仍是**非**终态（客户端认证问题，不说明这把 RT 死了）', () => {
    expect(isTerminalRefreshFailure(
      new RefreshFailureError('x：HTTP 401 Invalid token', { status: 401, oauthError: 'Invalid token' }),
      AUTOCLAW_TERMS,
    )).toBe(false)
  })
})

describe('★★ 形状守卫：脏输入不得绕过判据（红队打穿的第三、四处）', () => {
  it('★★ `details: null` 不得抛 TypeError', () => {
    const error = new RefreshFailureError('x', null as never)
    expect(() => isRefreshTransportFailure(error)).not.toThrow()
    expect(() => isTerminalRefreshFailure(error)).not.toThrow()
  })

  it('★★ 字符串状态码 `"400"` 不得让判据静默失配', () => {
    /**
     * ⚠️ 修前的死法：`status?: number` 是**声明**不是运行时保证，第三方适配器
     * 传 `status: '400'` 时 `'400' >= 500` 与 `'400' === 400` 都是 `false`
     * ⇒ 状态码判据整格跳过、终态判定被绕过。现在 `statusOf` 只认数字。
     */
    const error = new RefreshFailureError('x：HTTP 400 invalid_grant', {
      status: '400' as never,
      oauthError: 'invalid_grant',
    })
    expect(isTerminalRefreshFailure(error), '字符串状态码让判据静默跳过了').toBe(true)
  })

  it('★ `details.transport: true` 是最高优先级的传输层标记（先于其它一切）', () => {
    const error = new RefreshFailureError('看起来像终态 invalid_grant', {
      transport: true,
      oauthError: 'invalid_grant',
      status: 400,
    })
    expect(isRefreshTransportFailure(error)).toBe(true)
    expect(isTerminalRefreshFailure(error)).toBe(false)
  })
})

describe('★★ 业务码信封的两把键都要读（红队打穿的第五处）', () => {
  it('★★ 显式键读不到时回退另一把键', () => {
    // AutoClaw 的 OAuth 形态：只有 `error`
    const oauthShaped = refreshFailureFromResponse('x', 400, { error: 'Invalid token' }, 'msg')
    expect(oauthShaped.details.oauthError, '只读 msg ⇒ 丢掉了 error 形态').toBe('Invalid token')
    // AutoClaw 的业务码信封：只有 `msg`
    const envelopeShaped = refreshFailureFromResponse('x', 400, { code: 401, msg: 'Invalid token' })
    expect(envelopeShaped.details.oauthError, '只读 error ⇒ 业务码信封的结构化信息整段丢失').toBe('Invalid token')
  })

  it('★ 两把键都没有时 `oauthError` 是 undefined（退回文案启发式）', () => {
    const error = refreshFailureFromResponse('x', 400, { code: 5 })
    expect(error.details.oauthError).toBeUndefined()
    expect(isTerminalRefreshFailure(error)).toBe(false)
  })
})

describe('★ 词边界：不得把 `invalid_grant_x` 之类当成终态', () => {
  it('精确词才命中；下划线/字母延伸不算', () => {
    expect(isTerminalRefreshFailure(new Error('invalid_grant'))).toBe(true)
    expect(isTerminalRefreshFailure(new Error('x invalid_grant y'))).toBe(true)
    expect(isTerminalRefreshFailure(new Error('invalid_grant_expired'))).toBe(false)
    // AutoClaw 的多词词汇
    expect(isTerminalRefreshFailure(new Error('Invalid token'), AUTOCLAW_TERMS)).toBe(true)
    expect(isTerminalRefreshFailure(new Error('Invalid tokens'), AUTOCLAW_TERMS)).toBe(false)
  })

  it('★ 文案里带 5xx / 429 的一律不判死（有些实现把状态码写进 message）', () => {
    expect(isTerminalRefreshFailure(new Error('HTTP 500: invalid_grant'))).toBe(false)
    expect(isTerminalRefreshFailure(new Error('HTTP 429: invalid_grant'))).toBe(false)
  })
})

describe('★ 端点循环的保留优先级：确定性拒绝不得被瞬时错误覆盖', () => {
  it('`400 invalid_grant` 是确定性拒绝；`503` 不是', () => {
    expect(isDefinitiveRefreshRejection(
      new RefreshFailureError('x', { status: 400, oauthError: 'invalid_grant' }),
    )).toBe(true)
    expect(isDefinitiveRefreshRejection(
      new RefreshFailureError('x', { status: 503, oauthError: 'invalid_grant' }),
    ), '503 不是确定性拒绝（它是网关问题）').toBe(false)
    expect(isDefinitiveRefreshRejection(
      new RefreshFailureError('x', { status: 400 }),
    ), '没有结构化 error 字段 ⇒ 不是「确定性拒绝」').toBe(false)
    expect(isDefinitiveRefreshRejection(new Error('x'))).toBe(false)
  })
})

describe('★★ 端到端：AutoClaw 刷新端点两个形态都判得出终态', () => {
  it('★★ HTTP 400 + 业务码信封（400 分支）⇒ 终态', () => {
    const error = refreshFailureFromResponse(
      'AutoClaw token refresh failed',
      400,
      { code: 401, msg: 'Invalid token' },
    )
    expect(isTerminalRefreshFailure(error, AUTOCLAW_TERMS)).toBe(true)
  })

  it('★★ HTTP 200 + 业务码信封（成功分支里的 code 非 0）⇒ 终态', () => {
    const error = refreshFailureFromResponse(
      'AutoClaw token refresh returned non-zero code',
      200,
      { code: 401, msg: 'Invalid token' },
      'msg',
    )
    expect(isTerminalRefreshFailure(error, AUTOCLAW_TERMS)).toBe(true)
  })

  it('★ 反向：同一个信封但 HTTP 503 ⇒ 非终态', () => {
    const error = refreshFailureFromResponse(
      'AutoClaw token refresh failed',
      503,
      { code: 401, msg: 'Invalid token' },
    )
    expect(isTerminalRefreshFailure(error, AUTOCLAW_TERMS)).toBe(false)
  })
})

/**
 * ★★ **端点循环**：确定性拒绝不得被瞬时错误覆盖（红队打穿的那一格）。
 *
 * `refreshAutoclawToken` 会**依次试两个端点**（`/userapi/v1/refresh` 与
 * `/agent-refresh`）。修前 catch 里无条件 `lastError = err` ⇒
 * 端点1 回 `400 invalid_grant`（上游明确说这把 RT 死了）、端点2 回 `503`
 * （网关瞬时抖动）时，抛出去的是 **503** ⇒ 上层判据看不到那次确定性拒绝
 * ⇒ 真死号不标死、退化成每轮白撞。
 */
describe('★★ 端点循环的错误保留优先级（`refreshAutoclawToken`）', () => {
  it('★★ 端点1 = 400 invalid_grant、端点2 = 503 ⇒ 最终必须抛**确定性拒绝**（400 invalid_grant）', async () => {
    const { refreshAutoclawToken } = await import('../../src/autoclaw-oauth.js')
    const { AUTOCLAW } = await import('../../src/autoclaw-product.js')
    let calls = 0
    const fetcher = (async () => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      }
      return new Response('gateway down', { status: 503 })
    }) as unknown as typeof fetch

    const error = await refreshAutoclawToken('RT-X', {
      product: AUTOCLAW,
      fetchImpl: fetcher,
      timeoutMs: 1_000,
    }).then(() => undefined, (err: unknown) => err)

    expect(calls, '必须真的试过两个端点（用例前提）').toBe(2)
    expect(
      isDefinitiveRefreshRejection(error),
      '★★ 瞬时 503 覆盖了确定性 400 invalid_grant ⇒ 上层判据看不到「这把 RT 死了」',
    ).toBe(true)
    // ⚠️ `invalid_grant` 是**默认词表**里的标准码（AutoClaw 的自有词汇是
    //    `Invalid token`）—— 故这里用默认词表，别混用。
    expect(
      isTerminalRefreshFailure(error),
      '★ 被覆盖后终态判定也失效（死号永不标死）',
    ).toBe(true)
  })

  it('★ 反向：端点1 = 503、端点2 = 400 invalid_grant ⇒ 同样保留确定性拒绝', async () => {
    const { refreshAutoclawToken } = await import('../../src/autoclaw-oauth.js')
    const { AUTOCLAW } = await import('../../src/autoclaw-product.js')
    let calls = 0
    const fetcher = (async () => {
      calls += 1
      if (calls === 1) return new Response('gateway down', { status: 503 })
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    }) as unknown as typeof fetch
    const error = await refreshAutoclawToken('RT-X', {
      product: AUTOCLAW, fetchImpl: fetcher, timeoutMs: 1_000,
    }).then(() => undefined, (err: unknown) => err)
    expect(isDefinitiveRefreshRejection(error)).toBe(true)
  })
})

/**
 * ★★ **结构化 `oauthError` 必须能独立支撑终态判定**（红队 V9/V12 那一族）。
 *
 * ⚠️ 这一组刻意让 **message 里不含任何终态词**：否则文案兜底那一步会同时命中
 * ⇒ 两条腿互相掩护、判据不可观测（我第一版的 422 用例就是**假绿**，
 * 实测把「结构化优先」整段改成白名单后仍然通过）。
 */
describe('★★ 结构化判据必须独立成立（文案里不得有可兜底的词）', () => {
  it('★★ 422 + 结构化 invalid_grant、文案**不含**该词 ⇒ 仍判终态（白名单会让它整格跳过）', () => {
    const error = new RefreshFailureError('上游拒绝了这次续期', {
      status: 422,
      oauthError: 'invalid_grant',
    })
    expect(error.message).not.toContain('invalid_grant')
    expect(
      isTerminalRefreshFailure(error),
      '★ 状态码闸门若是白名单（只放行 400/200），别的 4xx 表达拒绝时整格被跳过',
    ).toBe(true)
  })

  it('★★ 字符串状态码 `"422"` 不得让判据静默失配（shape 守卫）', () => {
    const error = new RefreshFailureError('上游拒绝了这次续期', {
      status: '422' as never,
      oauthError: 'invalid_grant',
    })
    expect(
      isTerminalRefreshFailure(error),
      '★ `statusOf` 若不剔除非数字，字符串状态码会让所有 `===`/`>=` 判据静默失配',
    ).toBe(true)
  })

  it('★ 业务码信封（HTTP 200）的结构化词也必须独立成立', () => {
    const error = new RefreshFailureError('业务码非 0', { status: 200, oauthError: 'Invalid token' })
    expect(isTerminalRefreshFailure(error, AUTOCLAW_TERMS)).toBe(true)
  })
})

/**
 * ★★ **传输层判据必须窄**（红队 V10 那一族）。
 *
 * 修前 `TRANSPORT_MESSAGES` 含 `timeout` / `proxy` / `network` 这类宽词，
 * 而 `refreshFailureFromResponse` 会把 `error_description` 拼进 message
 * ⇒ 真终态报文被第①步吃掉。这一组用**描述字段**把那个形态钉死。
 */
describe('★★ 描述字段里的"像网络问题"的词不得吞掉真终态', () => {
  it('★★ `error_description` 含 `timed out` / `timeout` / `proxy` / `network` ⇒ 仍判终态', () => {
    for (const described of [
      'the token is for a session that timed out',
      'request timeout while rotating',
      'issued via proxy',
      'network hiccup during rotation',
    ]) {
      const error = refreshFailureFromResponse('MiniMax 续期失败', 400, {
        error: 'invalid_grant',
        error_description: described,
      })
      expect(
        isTerminalRefreshFailure(error),
        `★ 描述 "${described}" 把真终态判成了传输层 ⇒ 死号永不标死、无限 401`,
      ).toBe(true)
    }
  })

  it('★ 对照：真正的传输层失败（`fetch failed` + cause 证书）仍然非终态', () => {
    expect(isTerminalRefreshFailure(transportError(new Error('certificate has expired')))).toBe(false)
  })
})
