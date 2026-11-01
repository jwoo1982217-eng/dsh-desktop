/**
 * Qiniu 接线完整性守卫（镜像 modelscope-wiring.spec.ts）。
 *
 * ## 守的失效形态
 *
 * 适配器支持「按账号池过滤黑名单 / 关闭意图」，但 index.ts 的
 * registerQiniuLlm(ctx, { ... }) 没传 accountPool ⇒ `?.()` 恒为 undefined
 * ⇒ 过滤退化成「不过滤」。症状：用户关掉的模型仍出现在选择器里，
 * 且类型检查通过、适配器自测全绿、无报错无日志。
 *
 * 「实参里有没有传池」没有可观测行为（适配器自测替身本来就带池）⇒ 只能对
 * 源码做剥注释后的文本判据，并额外排除 undefined / null / {}。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { QiniuAdapter } from '../../src/qiniu-adapter.js'
import { QINIU } from '../../src/qiniu-product.js'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

function poolStub(disabled: readonly string[] = []): never {
  return {
    disabledModelsFor: () => new Set(disabled),
    providerClosedFor: () => false,
  } as never
}

describe('Qiniu 接线完整性', () => {
  it('index.ts 的 qiniu 注册实参里必须带真 accountPool（剥注释后判定 + 死分支常量检测）', () => {
    const source = readFileSync(REPO + 'src/index.ts', 'utf8')
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n')
    const at = code.indexOf('registerQiniuLlm(')
    expect(at, 'index.ts 里找不到 registerQiniuLlm 调用点').toBeGreaterThan(-1)
    const tail = code.slice(at, at + 4000)
    const end = tail.indexOf('\n  })')
    const call = end > 0 ? tail.slice(0, end) : tail
    expect(
      call,
      'registerQiniuLlm 的实参里没有 accountPool ⇒ 黑名单与「关闭供应商」双双失效',
    ).toMatch(/accountPool:\s*pool\b/)
    expect(
      /accountPool:\s*(undefined|null)/.test(call),
      'accountPool 被写成 undefined / null ⇒ 骨架的 ?. 让它变成静默 no-op',
    ).toBe(false)
    // ⚠️ 2026-10-31 对抗审计 M10b 补牙：源文本判据可被 `if(false)` 死分支短路
    //（client-ui.md 记录的旁路形态在 qiniu 上真实复现——变异
    // `...(false ? { accountPool: pool } : {})` 后 2 条用例全绿）。
    // 判据：registerQiniuLlm 调用块内**不得出现恒假条件**包住 accountPool
    // （与 client-ui.md 的「常量假条件检测」同款判据）。
    expect(
      /(?:if\s*\(\s*false\s*\)|\?\s*\(\s*\{\s*accountPool|\.\.\.\(\s*false\s*\?)/.test(call),
      'accountPool 被 if(false)/恒假三元包进死分支 ⇒ 源文本判据被短路（变异 M10b 形态）',
    ).toBe(false)
  })

  it('池里的黑名单模型不得出现在 listModels（真实过滤，非恒真）', async () => {
    // 兜底表刻意置空 ⇒ 必须让远端目录有模型，否则「过滤掉一个」无从断言。
    const fakeFetch = async () => new Response(JSON.stringify({
      data: [
        { id: 'deepseek-v3', context_length: 65536 },
        { id: 'moonshotai/kimi-k3', context_length: 131072 },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })

    const listIds = async (pool: never) => {
      const adapter = new QiniuAdapter({
        slots: async () => [{ id: 'a1', apiKey: 'qiniu-testkey-0123456789abcdef' }],
        product: QINIU,
        accountPool: pool,
        fetchRemoteCatalog: fakeFetch,
      } as never)
      return (await adapter.listModels(QINIU.id)).map((m) => m.id)
    }

    const all = await listIds(poolStub([]))
    expect(all, '远端目录没被读到 ⇒ 下面的过滤断言会恒真').toContain('moonshotai/kimi-k3')
    const filtered = await listIds(poolStub(['moonshotai/kimi-k3']))
    expect(filtered, '池里的黑名单没有生效 ⇒ 用户关掉的模型仍出现在选择器里')
      .not.toContain('moonshotai/kimi-k3')
    expect(filtered).toContain('deepseek-v3')
  })
})
