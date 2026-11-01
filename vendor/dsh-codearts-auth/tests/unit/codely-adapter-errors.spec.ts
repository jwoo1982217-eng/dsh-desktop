/**
 * Codely 推理的**错误归类**守卫。
 *
 * ## 为什么必须有
 *
 * 2026-10-20 用户报障：界面显示「**API 密钥无效**」，但凭据完全正常
 * （5 个账号换发 `cli_api_key` 全部 200）。真实原因是：
 *
 * ```
 * DeepSeek-V4.1-Flash → 401
 * {"error":{"type":"team_model_access_denied","message":"team not allowed to
 *  access model. This team can only access models=['alias-only-proxy-models']"}}
 * ```
 *
 * 即**目录里列出的模型 ≠ 团队可访问**（`/api/model-status` 是全局目录，
 * 团队策略在网关侧另判），而 `codely-basic` 正常。
 *
 * 而我当时把它归成 `AUTH` ⇒ DSH 客户端 `failureMessage()` 只要 `code === 'AUTH'`
 * 就把整条 message 换成「API 密钥无效」⇒ 用户去重登，**全是无效动作**
 * （`docs/agent-notes/client-ui.md` 已记录三次同款事故）。
 *
 * ⇒ 本文件锁两件事：① 模型权限类 401 **必须** `PERMISSION_DENIED` 且文案指路；
 *   ② 非权限类失败不得被吞成 `AUTH`。
 */

import { describe, expect, it } from 'vitest'
import { CodelyAdapter } from '../../src/codely-adapter.js'
import { CODERLY } from '../../src/codely-product.js'

/** 造一个 adapter：换发固定 200，推理请求按 `chatResponse` 返回。 */
const adapterWith = (chatResponse: Response) => new CodelyAdapter({
  credentialProvider: async () => ({ access_token: 'eyJ.test.token', refresh_token: 'r', obtained_at: 0 }) as never,
  fetchImpl: (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/api-token/cli-api-key')) {
      return new Response(JSON.stringify({ cli_api_key: 'sk-test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return chatResponse
  }) as never,
})

/** 把 async generator 跑完（错误会在迭代时抛）。 */
const drain = async (adapter: CodelyAdapter, model: string) => {
  const chunks: unknown[] = []
  for await (const chunk of adapter.stream({
    model,
    messages: [{ role: 'user', content: 'hi' }],
  } as never)) {
    chunks.push(chunk)
  }
  return chunks
}

const deniedBody = JSON.stringify({
  error: {
    type: 'team_model_access_denied',
    message: "team not allowed to access model. This team can only access models=['alias-only-proxy-models']. Tried to access DeepSeek-V4.1-Flash",
  },
})

describe('Codely 推理错误归类', () => {
  it('① 团队模型权限拒绝 → PERMISSION_DENIED，且文案指路到 codely-* 模型', async () => {
    const adapter = adapterWith(new Response(deniedBody, { status: 401 }))
    let caught: unknown
    try {
      // ⚠️ 用**目录内**的模型：目录外的模型会先被前置校验拦下（见 ④），
      //    那样就测不到「上游 401 denied」这条归类了。
      await drain(adapter, 'codely-basic')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()
    const text = String((caught as Error).message)
    // ⚠️ 关键：文案必须自己说清「换模型」，不能只说上游 401
    expect(text).toMatch(/团队的可访问范围/)
    expect(text).toMatch(/codely-basic/)
    // ⚠️ 关键：绝不能再是 AUTH（那会被客户端换成「API 密钥无效」）
    expect((caught as { code?: string }).code).toBe('PERMISSION_DENIED')
  })

  it('② 非权限类 500 → SERVER（不得归 AUTH）', async () => {
    const adapter = adapterWith(new Response('upstream boom', { status: 500 }))
    let caught: unknown
    try {
      await drain(adapter, 'codely-basic')
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string }).code).toBe('SERVER')
  })

  it('③ 无凭据 → PERMISSION_DENIED + 指路「账号池登录」（不是「密钥无效」）', async () => {
    const adapter = new CodelyAdapter({ credentialProvider: async () => undefined })
    let caught: unknown
    try {
      await drain(adapter, 'codely-basic')
    } catch (error) {
      caught = error
    }
    const text = String((caught as Error).message)
    expect(text).toMatch(/账号池/)
    expect((caught as { code?: string }).code).toBe('PERMISSION_DENIED')
  })

  /**
   * ④ **目录外模型 ⇒ 前置拦截**（不打上游）。
   *
   * 真实报障 2026-10-20：宿主记住了旧选择（`DeepSeek-V4.1-Flash`），
   * 即使目录已清理，用户点发送仍会每轮 401。本条把「不在可用目录 ⇒ 直接报错
   * 并列出可用项」钉成行为，且**断言零上游请求**（不浪费一次注定失败的网络往返）。
   */
  it('④ 目录外模型 ⇒ 前置报错并列出可用模型（不发请求）', async () => {
    let chatCalled = 0
    const adapter = new CodelyAdapter({
      credentialProvider: async () => ({ access_token: 'eyJ.test.token', refresh_token: 'r', obtained_at: 0 }) as never,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/api-token/cli-api-key')) {
          return new Response(JSON.stringify({ cli_api_key: 'sk-test' }), { status: 200 })
        }
        chatCalled += 1
        return new Response('{}', { status: 200 })
      }) as never,
    })
    let caught: unknown
    try {
      await drain(adapter, 'DeepSeek-V4.1-Flash')
    } catch (error) {
      caught = error
    }
    const text = String((caught as Error).message)
    expect(text).toMatch(/不在你当前的可用目录里/)
    expect(text).toMatch(/codely-basic/)
    expect((caught as { code?: string }).code).toBe('PERMISSION_DENIED')
    expect(chatCalled, '目录外模型不应发出推理请求').toBe(0)
  })
})

/**
 * **能力矩阵守卫**（2026-10-20 真凭据逐模型实测，5 模型 × 2 请求）。
 *
 * | 模型 | 工具 | 推理 | 图片 |
 * |---|---|---|---|
 * | `codely-basic` | ✅ | ❌ | ✅ |
 * | `codely-flash` / `codely-air` | ✅ | ✅ | ✅ |
 * | `codely-core` | ✅ | ✅ | ❌ `Model only supports text` |
 * | `codely-vl` | ✅ | ✅ | ❌ `invalid_parameter_error` |
 *
 * ⚠️ **`codely-vl` 名字带 vl（vision-language）却拒图** —— 这张表的作用就是拦住
 * 「按名字猜能力」这种改法。改判据时先重跑实测，再改 `CODERLY_IMAGE_MODELS`。
 * ⚠️ 三态：`['text']` 是**明确不支持**（宿主会把图片投影成文本占位）；
 * **省略**则是「未知」⇒ 宿主放行图片 ⇒ 仍然 400。两者不可合并。
 */
describe('Codely 能力矩阵（逐模型实测）', () => {
  it('图片模态按实测声明：basic/flash/air 收图，core/vl 明确只文本', async () => {
    // 无凭据 ⇒ 走兜底表、无目录门控 ⇒ 拿到的就是「当前团队可访问」的 5 个
    const adapter = new CodelyAdapter({})
    const models = await adapter.listModels(CODERLY.id)
    const byId = new Map(models.map((model) => [model.id, model]))

    for (const id of ['codely-basic', 'codely-flash', 'codely-air']) {
      expect(byId.get(id)?.inputModalities, `${id} 实测收图，应声明 image`).toContain('image')
    }
    for (const id of ['codely-core', 'codely-vl']) {
      expect(byId.get(id)?.inputModalities, `${id} 实测拒图，只应声明 text`).toEqual(['text'])
    }
  })
})
