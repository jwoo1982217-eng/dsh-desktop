/**
 * opencode 免费通道「Bun 指纹」e2e（默认跳过）。
 *
 * 闸门：`DSH_OPENCODE_BUN_TLS_E2E=1` + `DSH_OPENCODE_BUN_TLS_E2E_CONFIRM=yes` 双开关。
 *
 * ⚠️ 消耗匿名免费额度，故必须有显式确认开关（沿用本仓库 e2e 惯例）。
 *
 * ## 本文件断言的是**两组对照**，缺一组就没有判别力
 *
 * 1. **改后**（Bun 指纹 + 官方形态提示词）⇒ 必须拿到正文；
 * 2. **改前形态**（同一份 body 走常规 fetch）⇒ 必须 429。
 *
 * ⚠️ 只断言第 1 组是**恒真**的（上游偶发 200 也能过），必须有第 2 组作反向对照。
 */
import { describe, expect, it } from 'vitest'
import { bunTlsFetch, ensureBunTlsLoaded } from '../../src/opencode-bun-tls.js'
import { buildOpencodeRequest } from '../../src/opencode-messages.js'
import { opencodeHeaders } from '../../src/opencode.js'
import { OPENCODE } from '../../src/opencode-product.js'
import { deriveSessionId, deriveRequestId } from '../../src/opencode.js'

const enabled = process.env.DSH_OPENCODE_BUN_TLS_E2E === '1'
  && process.env.DSH_OPENCODE_BUN_TLS_E2E_CONFIRM === 'yes'
const suite = enabled ? describe : describe.skip

const MODEL = 'big-pickle'

/** 用生产链路自己的构件拼请求（不另写一份形状 —— 那正是本仓库的红线）。 */
function buildBody(system?: string): string {
  const request = buildOpencodeRequest({
    model: MODEL,
    messages: [{ role: 'user', content: '只回复两个字：在的' }],
    ...system === undefined ? {} : { system },
    tools: [{ name: 'read', description: '客户端 read 工具', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
  })
  return JSON.stringify(request.payload)
}

function headers(apiKey: string): Record<string, string> {
  return {
    ...opencodeHeaders(
      { projectId: '3f3f7816fd9ceeaf0c3df15f6048b06b7f4e1787', generation: 0 },
      deriveSessionId(),
      deriveRequestId(),
      OPENCODE.defaultUserAgent,
    ),
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${apiKey}`,
  }
}

const url = `${OPENCODE.baseUrl}${OPENCODE.chatPath}`

suite('opencode 免费通道：Bun 指纹 e2e', () => {
  it('Bun 指纹 + 官方形态提示词 ⇒ 200 且有正文；同 body 走常规 fetch ⇒ 429', async () => {
    expect(await ensureBunTlsLoaded()).toBe(true)

    // ① 改后形态：Bun 指纹。给 90 秒（上游首字节实测 2~5 秒，偶发更慢）。
    const okResponse = await bunTlsFetch(url, {
      method: 'POST',
      headers: headers(OPENCODE.anonymousKey),
      body: buildBody('你是 DSH 的助手。'),
      signal: AbortSignal.timeout(90_000),
    }, undefined)
    expect(okResponse.status).toBe(200)
    const okText = await okResponse.text()
    expect(okText).toContain('data:')
    // ⚠️ 判据是「本轮确有产出」，不是「正文长度 > 0」：上游偶发只回思考块。
    expect(okText).not.toContain('FreeUsageLimitError')

    // ② 改前形态：同一份 body 走常规 fetch ⇒ 必须被拒。
    //    ⚠️ 这一组是本文件的**判别力来源**：没有它，第 ① 组在上游偶发 200 时也全绿。
    const rejected = await fetch(url, {
      method: 'POST',
      headers: headers(OPENCODE.anonymousKey),
      body: buildBody('你是 DSH 的助手。'),
      signal: AbortSignal.timeout(90_000),
    })
    const rejectedText = await rejected.text()
    expect(rejected.status).toBe(429)
    expect(rejectedText).toContain('FreeUsageLimitError')
  }, 240_000)

  it('⚠️ 反向对照：Bun 指纹但提示词缺 `<env>` 块 ⇒ 仍 429', async () => {
    // 这一格证明「只换 TLS 不够」——提示词形态是独立的一道门禁。
    const request = buildOpencodeRequest({
      model: MODEL,
      messages: [{ role: 'user', content: '只回复两个字：在的' }],
      system: 'You are an AI coding assistant, powered by a large language model.',
      tools: [{ name: 'read', description: '客户端 read 工具', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
    })
    const payload = request.payload as Record<string, unknown>
    // 人为剥掉官方提示词（模拟改前形态），其余逐字节不变。
    const messages = (payload.messages as Array<{ role: string; content: string }>).map((message) => message.role === 'system'
      ? { ...message, content: 'You are an AI coding assistant, powered by a large language model.' }
      : message)
    const response = await bunTlsFetch(url, {
      method: 'POST',
      headers: headers(OPENCODE.anonymousKey),
      body: JSON.stringify({ ...payload, messages }),
      signal: AbortSignal.timeout(90_000),
    }, undefined)
    const text = await response.text()
    expect(response.status).toBe(429)
    expect(text).toContain('FreeUsageLimitError')
  }, 180_000)
})
