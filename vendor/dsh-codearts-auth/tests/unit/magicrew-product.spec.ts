import { describe, expect, it } from 'vitest'
import {
  MAGICREW,
  MAGICREW_DEFAULT_EFFORT,
  MAGICREW_FALLBACK_CONTEXT_WINDOW,
  MAGICREW_MIN_MAX_TOKENS,
  MAGICREW_REASONING_EFFORTS,
  magicrewFallbackModelOf,
} from '../../src/magicrew-product.js'

describe('magicrew 产品常量', () => {
  it('★ 国内站常量：host 与 org 需求按实测（国内站不强制 org）', () => {
    expect(MAGICREW.id).toBe('magicrew')
    expect(MAGICREW.site).toBe('cn')
    expect(MAGICREW.host).toBe('https://i-magic-service.letsmagic.cn')
    // 实测 2026-10-28：国内站缺 organization-code 仍 200；国际站缺了是 HTTP 500 裸文本
    expect(MAGICREW.needsOrgOnGateway).toBe(false)
  })

  it('★ 静态兜底表覆盖 27 条真实模型（2026-10-28 快照）', () => {
    expect(MAGICREW.fallbackModels).toHaveLength(27)
    // 抽查三条（覆盖 1M / 327K / 131K 三档，且 vision 真假各一）
    expect(magicrewFallbackModelOf('deepseek-v4.1-flash')).toMatchObject({
      id: 'deepseek-v4.1-flash',
      contextWindow: 1_048_576,
      supportsImage: true,
    })
    expect(magicrewFallbackModelOf('glm-5.3-flash')).toMatchObject({
      contextWindow: 327_680,
      supportsImage: true,
    })
    expect(magicrewFallbackModelOf('glm-4.5')).toMatchObject({
      contextWindow: 131_072,
      supportsImage: false,
    })
  })

  it('★ 目录里没有的 id 返回 undefined（不编造）', () => {
    expect(magicrewFallbackModelOf('glm-5.2')).toBeUndefined()
    expect(magicrewFallbackModelOf('')).toBeUndefined()
  })

  it('★ 档位只有两档（实测：none 真开关，其余档位强度不被区分）', () => {
    expect([...MAGICREW_REASONING_EFFORTS]).toEqual(['none', 'high'])
    expect(MAGICREW_DEFAULT_EFFORT).toBe('high')
    // 每条都声明这两档 —— 否则用户在「关闭思考」与「开启」之间没有选择
    for (const model of MAGICREW.fallbackModels) {
      expect([...(model.reasoningEfforts ?? [])]).toEqual(['none', 'high'])
    }
  })

  it('★ max_tokens 下限是 512（实测 64 会被 reasoning 吃满、正文为空）', () => {
    expect(MAGICREW_MIN_MAX_TOKENS).toBe(512)
  })

  it('★ 未知 id 的兜底窗口是具名常量（避免上下文占用条整条消失）', () => {
    // 依据：codearts 的真实报障 —— contextWindow === undefined 时
    // dsh-client-ui-conversation 的 contextOccupancy() 返回 null、ContextMeter 不渲染。
    expect(MAGICREW_FALLBACK_CONTEXT_WINDOW).toBe(1_048_576)
  })
})
