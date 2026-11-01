/**
 * Qiniu 目录解析 + 缓存的守卫。
 *
 * ## 为什么值得单独测（而不是只靠适配器集成测）
 *
 * 七牛云实测（2026-10-29 直连 `GET https://api.qnaigc.com/v1/models`，HTTP 200）：
 * 每条带 `context_length` 与 `max_tokens`（部分为 0），**不下发模态**。三件事各自
 * 都能静默出错：
 *
 * ① 窗口取错字段名 ⇒ 恒 0 ⇒ DSH 算不出自动压缩阈值（既不报错也不提示）；
 * ② 模态「未知当支持」⇒ 图被发到不收图的上游 ⇒ **模型对图片幻觉出答案**；
 * ③ 缓存不按 apiKey 分存 ⇒ 新加账号迟迟看不到自己那批模型。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearQiniuCatalogCache,
  loadQiniuCatalog,
  parseQiniuCatalog,
} from '../../src/qiniu-adapter.js'
import { QINIU_FALLBACK_MODELS } from '../../src/qiniu-product.js'

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => { clearQiniuCatalogCache() })

describe('parseQiniuCatalog', () => {
  it('★ 窗口按 context_length → context_window → limit.context 三级取值', () => {
    const entries = parseQiniuCatalog({
      data: [
        { id: 'deepseek/deepseek-v4.1-flash', context_length: 131_072 },
        { id: 'glm-4.5', context_window: 200_000 },
        { id: 'qwen-turbo', limit: { context: 32_768 } },
      ],
    })
    expect(entries.map((e) => [e.id, e.contextWindow])).toEqual([
      ['deepseek/deepseek-v4.1-flash', 131_072],
      ['glm-4.5', 200_000],
      ['qwen-turbo', 32_768],
    ])
  })

  it('★ context_length 优先于同条目的另两种写法（顺序 = 权威度）', () => {
    const [entry] = parseQiniuCatalog({
      data: [{ id: 'm', context_length: 1000, context_window: 2000, limit: { context: 3000 } }],
    })
    expect(entry!.contextWindow).toBe(1000)
  })

  it('★ 窗口缺失或 <=0 时留 0 哨兵（绝不编造数字）', () => {
    const entries = parseQiniuCatalog({
      data: [{ id: 'a' }, { id: 'b', context_length: 0 }, { id: 'c', context_length: -1 }],
    })
    expect(entries.map((e) => e.contextWindow)).toEqual([0, 0, 0])
  })

  it('★★ 模态未知 ⇒ 按不支持图片处理（硬约定：声明支持就必须真支持）', () => {
    const entries = parseQiniuCatalog({ data: [{ id: 'a', context_length: 8000 }] })
    expect(entries[0]!.supportsImage, '未知当支持 ⇒ 模型会对图片幻觉出答案').toBe(false)
    // 只有远端明确列出 image 才算支持。
    const withImage = parseQiniuCatalog({
      data: [{ id: 'b', modalities: { input: ['text', 'image'] } }],
    })
    expect(withImage[0]!.supportsImage).toBe(true)
    const textOnly = parseQiniuCatalog({ data: [{ id: 'c', modalities: { input: ['text'] } }] })
    expect(textOnly[0]!.supportsImage).toBe(false)
  })

  it('★ id 原样保留（不得剥厂商前缀）+ 去重 + 跳过非法条目', () => {
    const entries = parseQiniuCatalog({
      data: [
        { id: 'moonshotai/kimi-k3' },
        { id: 'moonshotai/kimi-k3' },
        { id: '  z-ai/glm-5.3  ' },
        { id: '' },
        { id: 42 },
        null,
        'not-an-object',
      ],
    })
    expect(entries.map((e) => e.id)).toEqual(['moonshotai/kimi-k3', 'z-ai/glm-5.3'])
  })

  it('name 缺省时回退到 id（不产出空展示名）', () => {
    const [entry] = parseQiniuCatalog({ data: [{ id: 'qiniu/conatus-free' }] })
    expect(entry!.name).toBe('qiniu/conatus-free')
  })

  it('非 {data:[…]} 形状 ⇒ 空数组（不抛）', () => {
    expect(parseQiniuCatalog(null)).toEqual([])
    expect(parseQiniuCatalog({})).toEqual([])
    expect(parseQiniuCatalog({ data: 'nope' })).toEqual([])
  })
})

describe('loadQiniuCatalog', () => {
  it('★ 按 apiKey 分存缓存（不同账号互不覆盖）', async () => {
    const seen: string[] = []
    const fetchCatalog = async (apiKey: string) => {
      seen.push(apiKey)
      return json({ data: [{ id: apiKey + '-model', context_length: 8000 }] })
    }
    const a = await loadQiniuCatalog(fetchCatalog, 'key-a')
    const b = await loadQiniuCatalog(fetchCatalog, 'key-b')
    expect(a.map((m) => m.id)).toEqual(['key-a-model'])
    expect(b.map((m) => m.id)).toEqual(['key-b-model'])
    // 再读一次：命中缓存，不再发请求。
    await loadQiniuCatalog(fetchCatalog, 'key-a')
    expect(seen).toEqual(['key-a', 'key-b'])
  })

  it('★ ttlMs=0 强制重拉（RPC 的「刷新目录」靠它）', async () => {
    let calls = 0
    const fetchCatalog = async () => {
      calls += 1
      return json({ data: [{ id: 'm', context_length: 8000 }] })
    }
    await loadQiniuCatalog(fetchCatalog, 'k', 0)
    await loadQiniuCatalog(fetchCatalog, 'k', 0)
    expect(calls).toBe(2)
  })

  it('★ 上游失败/空目录 ⇒ 回退兜底表（77 条实测快照），不抛错也不给空菜单', async () => {
    // ⚠️ 判据是「等于兜底表本身」而不是「长度 >0」：长度 >0 只是同义反复，
    //    有人把兜底表换成别的表照样绿。这里直接拿 QINIU_FALLBACK_MODELS 对拍，
    //    并额外断言「回来的是同一批 id」——回退路径一旦返回半张表就立刻红。
    const fallbackIds = QINIU_FALLBACK_MODELS.map((m) => m.id)
    const failing = async () => { throw new Error('boom') }
    const a = await loadQiniuCatalog(failing, 'k')
    expect(a.map((m) => m.id)).toEqual(fallbackIds)

    const notOk = async () => new Response('{}', { status: 500 })
    const b = await loadQiniuCatalog(notOk, 'k2')
    expect(b.map((m) => m.id)).toEqual(fallbackIds)

    // 空目录：既不能当成「有缓存」（否则会写入零条缓存并长期遮蔽兜底表），
    // 也不能把菜单变空（`closed = total > 0 && disabled === total` 判不出 ⇒ 静默）。
    const empty = async () => json({ data: [] })
    const c = await loadQiniuCatalog(empty, 'k3')
    expect(c.map((m) => m.id)).toEqual(fallbackIds)
  })
})
