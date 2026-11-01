import { describe, expect, it, vi } from 'vitest'
import { fetchMagicrewCatalogModels } from '../../src/magicrew-catalog.js'
import { MAGICREW, MAGICREW_MODELS_PATH } from '../../src/magicrew-product.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 包一层假 fetch，既能给假响应，又能检查请求头。
 *
 * ⚠️ 收的是**工厂**：`Response` 的 body 只能读一次，同一实例重复使用会在
 * 第二条断言上抛 `Body is unusable`（与业务无关的假红）。
 */
function fakeFetch(
  makeResponse: () => Response,
): typeof fetch & { mock: { calls: unknown[][] } } {
  return vi.fn(async () => makeResponse()) as unknown as typeof fetch
    & { mock: { calls: unknown[][] } }
}

function responseFactory(body: unknown, status = 200): () => Response {
  return () => jsonResponse(body, status)
}

describe('fetchMagicrewCatalogModels', () => {
  it('正常解析：data.models 归一成 { id, name, vision }，label 前导空格被 trim', async () => {
    const fetchImpl = fakeFetch(responseFactory({
      code: 1000,
      data: {
        models: [
          // ⚠️ 上游真实形态带前导空格。
          { value: 'deepseek-v4.1-flash', label: ' DeepSeek V4.1 Flash', vision: true },
          { value: 'glm-5', label: 'GLM 5', vision: false },
          // 无 label ⇒ name 回落到 id。
          { value: 'kimi-k3.1-pro', vision: true },
          // ⚠️ vision 是**严格布尔**：`1` / `"true"` 都不得判成有视觉能力。
          { value: 'qwen3.8-max', label: 'Qwen3.8 Max', vision: 1 },
          { value: 'mimo-v2.6-pro', label: 'MiMo V2.6 Pro', vision: 'true' },
        ],
      },
    }))

    const models = await fetchMagicrewCatalogModels({
      jwt: 'jwt-abc',
      organizationCode: '',
      fetchImpl,
    })

    expect(models).toEqual([
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', vision: true },
      { id: 'glm-5', name: 'GLM 5', vision: false },
      { id: 'kimi-k3.1-pro', name: 'kimi-k3.1-pro', vision: true },
      { id: 'qwen3.8-max', name: 'Qwen3.8 Max', vision: false },
      { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', vision: false },
    ])

    // 打的是产品 host + 目录路径，且带 JWT 与 Origin。
    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(url).toBe(`${MAGICREW.host}${MAGICREW_MODELS_PATH}`)
    expect(init.headers.authorization).toBe('Bearer jwt-abc')
    expect(init.headers.origin).toBe(MAGICREW.webOrigin)
    // ⚠️ organizationCode 为空时**不带**该头。
    expect(init.headers['organization-code']).toBeUndefined()
  })

  it('业务码非 1000 时抛错（不是静默返回空数组）', async () => {
    const fetchImpl = fakeFetch(responseFactory({ code: 403, message: 'token无效' }))

    await expect(fetchMagicrewCatalogModels({
      jwt: 'jwt-abc',
      organizationCode: 'org-1',
      fetchImpl,
    })).rejects.toThrow(/模型目录业务码 403/)

    // 非空 organizationCode 时必须带上该头（国际站强制）。
    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(init.headers['organization-code']).toBe('org-1')
  })

  it('非 JSON 响应时抛可读错误，并含响应前 200 字', async () => {
    const body = '<html>502 Bad Gateway</html>'
    const fetchImpl = fakeFetch(() => new Response(body, {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }))

    await expect(fetchMagicrewCatalogModels({
      jwt: 'jwt-abc',
      organizationCode: '',
      fetchImpl,
    })).rejects.toThrow(/不是 JSON/)

    await expect(fetchMagicrewCatalogModels({
      jwt: 'jwt-abc',
      organizationCode: '',
      fetchImpl,
    })).rejects.toThrow(body)
  })

  it('缺 value 的条目被跳过（不产生空 id 条目）', async () => {
    const fetchImpl = fakeFetch(responseFactory({
      code: 1000,
      data: {
        models: [
          { label: '没有 value', vision: true },
          { value: '', label: '空串 value', vision: true },
          { value: 42, label: '类型不对', vision: true },
          null,
          { value: 'glm-5', label: 'GLM 5', vision: false },
        ],
      },
    }))

    const models = await fetchMagicrewCatalogModels({
      jwt: 'jwt-abc',
      organizationCode: '',
      fetchImpl,
    })

    expect(models).toEqual([{ id: 'glm-5', name: 'GLM 5', vision: false }])
    expect(models.every((model) => model.id.length > 0)).toBe(true)
  })
})
