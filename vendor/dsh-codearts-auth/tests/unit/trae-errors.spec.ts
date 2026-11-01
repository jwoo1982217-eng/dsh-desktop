/**
 * TRAE 错误分类单元测试。
 *
 * 覆盖 `src/trae-errors.ts` 的 `classifyTraeError` 判定顺序与三个策略函数。
 * 判定顺序是本模块的核心契约（对齐 Go 端 `Classify` + `SOLOStreamError.Kind`），
 * 顺序错了会让「配额耗尽」被误判成可重试错误而反复重试一个永远不会成功的账号。
 */

import { describe, expect, it } from 'vitest'
import {
  classifyTraeError,
  classifyTraeStreamCode,
  isRotatableTraeStreamCode,
  isTraeTerminalError,
  recordsTraeRateLimit,
  shouldRotateTraeAccount,
} from '../../src/trae-errors.js'
import { traeCooldownFor } from '../../src/trae-cooldown-table.js'

describe('TRAE 错误分类', () => {
  it('body 含 1005 + plan 判为 hard-plan（权益不足）', () => {
    expect(classifyTraeError(400, '{"code":1005,"msg":"plan limit reached"}')).toBe('hard-plan')
    expect(classifyTraeError(200, '1005 plan')).toBe('hard-plan')
  })

  it('仅出现 1005 但不含 plan 字样时不判 hard-plan', () => {
    // 避免把无关的 code 1005 误判成权益不足。
    expect(classifyTraeError(400, '{"code":1005}')).toBe('client')
  })

  it('body 含 4008 判为 quota-exceeded（ide_credits 耗尽）', () => {
    expect(classifyTraeError(400, '{"code":4008}')).toBe('quota-exceeded')
    expect(classifyTraeError(200, 'Your requests have exceeded the quota')).toBe('quota-exceeded')
  })

  it('body 含 4011 判为 soft-rate（请求频率超限）', () => {
    expect(classifyTraeError(400, '{"code":4011}')).toBe('soft-rate')
  })

  it('quota-exceeded 优先于 4011（4008 更严重）', () => {
    expect(classifyTraeError(400, '4008 4011')).toBe('quota-exceeded')
  })

  it('HTTP 401 判为 session-dead（需重新登录）', () => {
    expect(classifyTraeError(401, '')).toBe('session-dead')
    expect(classifyTraeError(401, 'token invalid')).toBe('session-dead')
    expect(classifyTraeError(401, 'please login again')).toBe('session-dead')
  })

  it('HTTP 429 判为 soft-rate', () => {
    expect(classifyTraeError(429, 'too many requests')).toBe('soft-rate')
  })

  it('HTTP 404 判为 not-found', () => {
    expect(classifyTraeError(404, '')).toBe('not-found')
  })

  it('5xx 判为 server', () => {
    expect(classifyTraeError(500, '')).toBe('server')
    expect(classifyTraeError(503, 'service unavailable')).toBe('server')
  })

  it('其他 4xx 判为 client', () => {
    expect(classifyTraeError(400, 'bad param')).toBe('client')
    expect(classifyTraeError(403, '')).toBe('client')
  })

  it('2xx/3xx 判为 none', () => {
    expect(classifyTraeError(200, '')).toBe('none')
    expect(classifyTraeError(204, '')).toBe('none')
  })

  it('body 关键词优先于状态码（上游用 400 + 文案表达配额耗尽）', () => {
    // 若先按状态码判，400 会落到 client，于是反复重试一个永远不会成功的账号。
    expect(classifyTraeError(400, '4008')).toBe('quota-exceeded')
    expect(classifyTraeError(400, '1005 plan')).toBe('hard-plan')
  })
})

/**
 * ★ 流内 `event:error` 的**结构化码**入口（2026-10-24 真实报障）。
 *
 * 报障现场：上游用 HTTP 200 + SSE `event:error` 下发 `code=1005` 而 **`message`
 * 为空**，两个账号同被同一模型（`kimi-k3.1-pro`）拒，用户只看到
 * `trae:  (code=1005)`（冒号后**两个空格**）与徽章 `QUOTA_EXCEEDED`。
 *
 * 旧实现在换号循环里把 `{ code, message }` 序列化成 JSON 再喂**文案**表，
 * 而文案表的 `hard-plan` 还要求 `plan` 关键词 ⇒ 判 `'none'` ⇒ 冷却 **0ms**
 * ⇒ 限流标记写在失败那一瞬间、下次选号**立刻又选回同一个号**。
 */
describe('TRAE 流内结构化码分类（2026-10-24 真实报障回归）', () => {
  it('1005 判 hard-plan（只查码表，不看 message）', () => {
    expect(classifyTraeStreamCode(1005)).toBe('hard-plan')
  })

  it('★ 1005 的冷却必须是 12h，绝不是 0ms（换号形同虚设的根因）', () => {
    // 旧实现：classifyTraeError(0, '{"code":1005,"message":""}') ⇒ 'none' ⇒ 0ms
    expect(traeCooldownFor(classifyTraeStreamCode(1005)!)).toBe(12 * 3_600_000)
  })

  it('4008 / 4011 精确映射（与冷却表逐格对齐）', () => {
    expect(classifyTraeStreamCode(4008)).toBe('quota-exceeded')
    expect(traeCooldownFor(classifyTraeStreamCode(4008))).toBe(24 * 3_600_000)
    expect(classifyTraeStreamCode(4011)).toBe('soft-rate')
    expect(traeCooldownFor(classifyTraeStreamCode(4011))).toBe(60_000)
  })

  it('表外码**没有类别**（不得回落文案表，也不得凭空升级）', () => {
    // ⚠️ 2026-10-25 审计 F-02：旧实现的「表外码回落文案表」在生成路径上
    // **不可达**（唯一的调用点前已被同一张表过滤），而它恰恰把 `{code,message}`
    // 序列化成 JSON 再喂**文案表** —— 那是本 PR 要消灭的形态（旧缺陷正是
    // 「拿 JSON 喂文案表 ⇒ 判 none ⇒ 冷却 0ms」）。死代码 + 复活旧形态 ⇒ 删掉。
    //
    // 新契约：**只认表**。表外码返回 `undefined`，由调用方决定兜底冷却，
    // 绝不尝试从 `message` 文案里猜类别。
    expect(classifyTraeStreamCode(4006)).toBeUndefined()
    expect(classifyTraeStreamCode(4001)).toBeUndefined()
    expect(classifyTraeStreamCode(9999)).toBeUndefined()
    // 反向对照：表内码仍然必须给出类别（删回落不得连带削掉正路）
    expect(classifyTraeStreamCode(1005)).toBe('hard-plan')
  })

  it('isRotatableTraeStreamCode：表内 3 个换号，4001 / 4006 刻意不换号', () => {
    expect(isRotatableTraeStreamCode(1005)).toBe(true)
    expect(isRotatableTraeStreamCode(4008)).toBe(true)
    expect(isRotatableTraeStreamCode(4011)).toBe(true)
    // 4001（模型不可调用）：换账号也是同一个模型被拒
    expect(isRotatableTraeStreamCode(4001)).toBe(false)
    // 4006（体积超限）：另有专用出口 CONTEXT_WINDOW_EXCEEDED，换号无意义
    expect(isRotatableTraeStreamCode(4006)).toBe(false)
  })

  it('换号判据与类别表是同一份（表内码都必须换号）', () => {
    // 反向验证：把 isRotatableTraeStreamCode 改成查一张独立表，此用例仍可能绿 ⇒
    // 故这里同时断言「表内码的类别都该换号」，两腿一起钉住。
    for (const code of [1005, 4008, 4011]) {
      const kind = classifyTraeStreamCode(code)
      expect(kind, String(code)).toBeDefined()
      expect(shouldRotateTraeAccount(kind!), String(code)).toBe(true)
      expect(isRotatableTraeStreamCode(code), String(code)).toBe(true)
    }
  })
})

describe('TRAE 换号策略', () => {
  it('除 none 外每一类都换号（对齐 Go 每个分支都以 continue 结尾）', () => {
    for (const kind of ['hard-plan', 'soft-rate', 'session-dead', 'quota-exceeded', 'not-found', 'server', 'client'] as const) {
      expect(shouldRotateTraeAccount(kind), kind).toBe(true)
    }
    expect(shouldRotateTraeAccount('none')).toBe(false)
  })

  it('只有真正需要冷却的类别才记限流标记', () => {
    // session-dead / server / client 不是限流，记徽章会显示虚假信息。
    expect(recordsTraeRateLimit('hard-plan')).toBe(true)
    expect(recordsTraeRateLimit('soft-rate')).toBe(true)
    expect(recordsTraeRateLimit('not-found')).toBe(true)
    expect(recordsTraeRateLimit('quota-exceeded')).toBe(true)
    expect(recordsTraeRateLimit('session-dead')).toBe(false)
    expect(recordsTraeRateLimit('server')).toBe(false)
    expect(recordsTraeRateLimit('client')).toBe(false)
    expect(recordsTraeRateLimit('none')).toBe(false)
  })

  it('只有 session-dead 是终态（重试无意义）', () => {
    // 用途：TraeAuth.refresh 据此抛 RefreshTokenExpiredError 停止续期。
    // 网络抖动/5xx 必须走可重试路径，否则一次瞬时故障就让用户重新登录。
    expect(isTraeTerminalError('session-dead')).toBe(true)
    for (const kind of ['hard-plan', 'soft-rate', 'quota-exceeded', 'not-found', 'server', 'client', 'none'] as const) {
      expect(isTraeTerminalError(kind), kind).toBe(false)
    }
  })

  /**
   * ★ 冷却表**精确值断言**（PR #64 复审「剩余 1」，2026-10-06）。
   *
   * 维护者反向验证发现：`soft-rate` 60s→7天、`hard-plan` 12h→30天 时
   * **没有任何用例变红**（当时唯一的冷却断言只覆盖 4008 的 24h 区间）——
   * 上一版 `soft-rate` 误设 1h（比正确值大 60 倍）正是这样溜进来的。
   * 表是 `export const` ⇒ 直接精确断言，把三个争议值全部钉死；
   * 未知类别回落 1 小时兜底也一并锁定。
   */
  describe('traeCooldownFor 冷却表精确值（PR #64 复审锁定）', () => {
    it('三个争议类别的精确值', () => {
      // quota-exceeded（4008）：日配额（签到积分，余额 API 实测）⇒ 24h
      expect(traeCooldownFor('quota-exceeded')).toBe(24 * 3_600_000)
      // hard-plan（1005）：trae-errors.ts 既有权威定义 ⇒ 12h
      expect(traeCooldownFor('hard-plan')).toBe(12 * 3_600_000)
      // soft-rate（4011）：频率超限分钟级恢复 ⇒ 60s
      expect(traeCooldownFor('soft-rate')).toBe(60_000)
    })
    it('非争议类别与未知类别兜底', () => {
      expect(traeCooldownFor('not-found')).toBe(3_600_000)
      expect(traeCooldownFor('server')).toBe(3_600_000)
      expect(traeCooldownFor('client')).toBe(3_600_000)
      expect(traeCooldownFor('session-dead')).toBe(0)
      expect(traeCooldownFor('none')).toBe(0)
      // 未知类别回落 1 小时兜底
      expect(traeCooldownFor('unheard-of')).toBe(3_600_000)
    })
  })
})
