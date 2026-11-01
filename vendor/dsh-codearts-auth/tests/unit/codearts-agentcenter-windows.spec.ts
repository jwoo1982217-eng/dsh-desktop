import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchCodeArtsRemoteModels, fetchSignedGet, readAgentCenterWindow,
  SNAP_AGENT_CENTER_DETAIL_URL, SNAP_AGENT_CENTER_USERAGENTS_URL, SNAP_MODEL_BUILTIN_URL,
} from '../../src/models.js'
import { canonicalQueryOf, isSignedQueryValueSafe, signRequestHuawei } from '../../src/sign.js'
import type { CodeArtsCredential } from '../../src/types.js'

function makeCredential(): CodeArtsCredential {
  return {
    access_key_id: 'AKTEST',
    secret_access_key: 'SKTEST',
    security_token: 'STTEST',
    expires_at: '2026-12-31T00:00:00Z',
    refresh_token: 'rt',
    code_verifier: 'cv',
    dpop_private_key_jwk: 'jwk',
  } as CodeArtsCredential
}

function makeFetcher(routes: Record<string, { status?: number; body: string }>) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers: new Headers(init?.headers) })
    const route = routes[url]
    if (route === undefined) return new Response('', { status: 404 })
    return new Response(route.body, { status: route.status ?? 200 })
  }
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

/**
 * 实测 2026-10-30 的 AgentCenter `useragents` 响应形状 —— **字段名是 `agent_id`**。
 *
 * ⚠️⚠️ 这份 fixture 曾经写成 `{ id: … }`，而**上游根本没有 `id` 键**（17 个 agent
 * 逐条核对）⇒ 生产代码读 `a['id']` 恒 `undefined` ⇒ AgentCenter 窗口腿**全量
 * 静默失效**，而本文件当时的 9 条用例**全绿**（fixture 比生产代码错得一样）。
 * ⇒ **fixture 必须逐字对齐上游真实键名**，自造一个「看起来合理」的键名等于
 * 把 bug 一起冻进测试。这条教训已登进 providers-codearts.md。
 */
const USERAGENTS_BODY = JSON.stringify({
  total: 17,
  agents: [
    { agent_id: 'agent-secondary', agent_name: 'CodeAgent2', is_primary_agent: false },
    { agent_id: 'agent-primary', agent_name: 'CodeAgent', is_primary_agent: true },
  ],
})

const DETAIL_BODY = JSON.stringify({
  gpts: {
    models: [
      /**
       * ⚠️⚠️ **条目里没有 `model_id`**（2026-10-30 真机实测）—— 键全集是
       * `model_alias, model_name, model_type, model_mode, model_parameters,
       * credit, notice, model_tag`。首版 fixture 自造了 `model_id` ⇒ 生产代码
       * 读它恒空 ⇒ 8 条全被 `continue` 掉 ⇒ **窗口腿第二次静默失效而用例全绿**。
       * ⇒ 这里的条目**只用上游真实存在的键**，且刻意**不带** `model_id`。
       */
      { model_alias: 'GLM-5.2', model_name: 'GLM-5.2', model_parameters: { context_window: 202752, max_tokens: 65536 } },
      { model_alias: 'deepseek-v4.1-flash-1017', model_name: 'DeepSeek V4.1', model_parameters: { context_window: 1048576, max_tokens: 65536 } },
      { model_alias: 'kimi-k3', model_name: 'Kimi K3', model_parameters: { context_window: 1048576, max_tokens: 65536 } },
      { model_alias: 'Qwen3-VL-235B', model_name: 'Qwen3 VL', model_parameters: { context_window: 1048576 } },
      { model_alias: 'no-window-model', model_name: 'NoWindow', model_parameters: { max_tokens: 1024 } },
      { model_alias: 'bad-window', model_name: 'Bad', model_parameters: { context_window: '1048576' } },
    ],
  },
})

/** builtin 只给 GLM-5.2（kimi-k3 缺席 = 实测 builtin 漏发该模型的形态）。 */
const BUILTIN_BODY = JSON.stringify({
  count: 1,
  builtinModels: [{ model_id: 'GLM-5.2', model_name: 'GLM-5.2' }],
})

const FULL_ROUTES: Record<string, { body: string }> = {
  [SNAP_AGENT_CENTER_USERAGENTS_URL]: { body: USERAGENTS_BODY },
  [`${SNAP_AGENT_CENTER_DETAIL_URL}?agent_id=agent-primary`]: { body: DETAIL_BODY },
  [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
}

let cacheDirToRemove: string | undefined

beforeEach(() => {
  // AgentCenter 窗口只进 RemoteModel，不落 benefit 缓存；但 fetchCodeArtsRemoteModels
  // 会写 models/benefit 缓存（目录非空）—— 用临时目录隔离，别污染真实用户缓存。
  cacheDirToRemove = mkdtempSync(join(tmpdir(), 'codearts-agentcenter-'))
  process.env['DSH_CODEARTS_CACHE_DIR'] = cacheDirToRemove
})

afterEach(() => {
  delete process.env['DSH_CODEARTS_CACHE_DIR']
  if (cacheDirToRemove !== undefined) rmSync(cacheDirToRemove, { recursive: true, force: true })
  cacheDirToRemove = undefined
  vi.useRealTimers()
})

describe('canonicalQueryOf（signer 排序 query）', () => {
  it('sorts parameters by key (and by value on tie)', () => {
    expect(canonicalQueryOf('?offset=0&limit=100')).toBe('limit=100&offset=0')
    expect(canonicalQueryOf('?b=2&a=1')).toBe('a=1&b=2')
    expect(canonicalQueryOf('?a=2&a=1')).toBe('a=1&a=2')
  })

  it('handles empty, bare and roundtrip-safe values', () => {
    expect(canonicalQueryOf('')).toBe('')
    expect(canonicalQueryOf('?')).toBe('')
    expect(canonicalQueryOf('?onlykey')).toBe('onlykey=')
    expect(canonicalQueryOf('?k=a%20b')).toBe('k=a%20b')
    expect(canonicalQueryOf('a=1')).toBe('a=1')
  })

  it('signRequestHuawei signs the same canonical query regardless of wire order (2×2 evidence, faked clock)', async () => {
    // x-sdk-date 是秒级 ISO —— 假时钟钉死，两发才可比。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T04:00:00Z'))
    const a = await signRequestHuawei('AK', 'SK', 'ST', 'GET',
      'https://snap-access.cn-north-4.myhuaweicloud.com/v1/x?offset=0&limit=100', new Uint8Array())
    const b = await signRequestHuawei('AK', 'SK', 'ST', 'GET',
      'https://snap-access.cn-north-4.myhuaweicloud.com/v1/x?limit=100&offset=0', new Uint8Array())
    // 修前：raw query 进 canonical ⇒ 两种 wire 顺序签名不同（服务端按 sorted 重算
    // ⇒ offset,limit 顺序 401 verify ak sk signature fail，2026-10-29 四轮实测）。
    expect(a.get('Authorization')).toBe(b.get('Authorization'))
  })
})

describe('readAgentCenterWindow', () => {
  it('accepts positive integers only (no string coercion, no zero/negative)', () => {
    expect(readAgentCenterWindow({ model_parameters: { context_window: 202752, max_tokens: 65536 } }))
      .toEqual({ contextWindow: 202752 })
    // ⚠️⚠️ `max_tokens` **刻意不取**（2026-10-30 第二轮审计 D-4 修）：
    //    它唯一的去处 `CatalogEntry.maxTokens` ⇒ `defaultMaxTokens` ⇒ 宿主
    //    `dsh-compaction-basic` 的 `reservedCompletionTokens` 把它**从上下文窗口里
    //    扣掉** ⇒ 压缩触发点 162,201→109,772；窗口 131,072 的模型 ⇒ 宿主
    //    **抛** `TargetPressureConfigError`（不是降级）。
    //    ⇒ 「上游声明」与「我们默认发」被混为一谈 ⇒ 一并移除（且不留死字段）。
    expect(readAgentCenterWindow({ model_parameters: { context_window: 202752, max_tokens: 65536 } }))
      .not.toHaveProperty('maxOutputTokens')
    expect(readAgentCenterWindow({ model_parameters: { context_window: '1048576' } })).toEqual({})
    expect(readAgentCenterWindow({ model_parameters: { context_window: 0 } })).toEqual({})
    expect(readAgentCenterWindow({ model_parameters: { context_window: -1 } })).toEqual({})
    expect(readAgentCenterWindow({ model_parameters: { context_window: 1.5 } })).toEqual({})
    expect(readAgentCenterWindow({ model_parameters: null })).toEqual({})
    expect(readAgentCenterWindow({})).toEqual({})
  })
})

describe('AgentCenter 动态窗口合并', () => {
  it('enriches builtin models and adds unseen ids (kimi-k3), filtering VL and windowless entries', async () => {
    const { fetcher, calls } = makeFetcher(FULL_ROUTES)
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const glm = models.find((m) => m.id === 'GLM-5.2')
    expect(glm?.contextWindow).toBe(202752)
    // ⚠️ `maxOutputTokens` **刻意不再往 `RemoteModel` 上带**（2026-10-30 审计 P1-1 修）：
    //    上游的「单次输出上限」经 `CatalogEntry.maxTokens` ⇒ `defaultMaxTokens`
    //    ⇒ 会被宿主 `dsh-compaction-basic` 当成「输出侧预留」**从窗口里扣掉**
    //    ⇒ GLM-5.2 压缩触发点 162,201 → 109,772（−32%）。
    //    ⇒ 它**只**留在 AgentCenter 的原始响应里（`readAgentCenterWindow` 仍读它），
    //    但**不**进入目录条目、**不**影响任何出站预算。
    expect(glm?.maxOutputTokens).toBeUndefined()
    const kimi = models.find((m) => m.id === 'kimi-k3')
    expect(kimi?.contextWindow).toBe(1048576)
    // ⚠️ 名称来自 `model_alias`（上游真实键，见 DETAIL_BODY 注释）——**不是**自造的
    //    `model_id`。2026-10-30 实测 `gpts.models[]` 里**没有 `model_id`**，
    //    首版按它取值 ⇒ 恒空 ⇒ 8 条全被丢弃（本文件曾因此全绿而生产静默失效）。
    expect(kimi?.name).toBe('Kimi K3')
    const ds = models.find((m) => m.id === 'deepseek-v4.1-flash-1017')
    expect(ds?.contextWindow).toBe(1048576)
    expect(models.find((m) => m.id === 'Qwen3-VL-235B')).toBeUndefined()
    expect(models.find((m) => m.id === 'no-window-model')).toBeUndefined()
    expect(models.find((m) => m.id === 'bad-window')).toBeUndefined()
    // primary agent 选择：detail 请求的是 is_primary_agent=true 的那条
    const detailCall = calls.find((c) => c.url.startsWith(SNAP_AGENT_CENTER_DETAIL_URL))
    expect(detailCall?.url).toBe(`${SNAP_AGENT_CENTER_DETAIL_URL}?agent_id=agent-primary`)
  })

  it('★★ AgentCenter 独有模型**只作窗口源、不进目录**（2026-10-30 审计 P1-2 修）', async () => {
    // ⚠️ 动机：AgentCenter **不下发倍率** ⇒ 进目录就是裸名 ⇒
    //    `priceFactorFromName('Kimi K3')` = `Infinity` ⇒ 聚合候选恒排最后、
    //    永远不被挑中（静默）。与 `providers-accio.md` §7 同型。
    const { fetcher } = makeFetcher(FULL_ROUTES)
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const kimi = models.find((m) => m.id === 'kimi-k3')
    expect(kimi, 'kimi-k3 仍要出现在拉取结果里（窗口源）').toBeDefined()
    expect(kimi?.windowOnly, '必须标记为「只作窗口源」').toBe(true)
    // ⚠️ **目录里已有的模型不能被标成 windowOnly**（否则它会从目录消失）
    expect(models.find((m) => m.id === 'GLM-5.2')?.windowOnly).toBeUndefined()
  })

  it('signs agent-type / x-language (routing headers) into SignedHeaders', async () => {
    const { fetcher, calls } = makeFetcher(FULL_ROUTES)
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ua = calls.find((c) => c.url === SNAP_AGENT_CENTER_USERAGENTS_URL)
    expect(ua).toBeDefined()
    const auth = ua?.headers.get('Authorization') ?? ''
    // 修前：路由头只在签名**后**追加 ⇒ 不在 SignedHeaders 里（AgentCenter 按同口径
    // 从严 —— 去 x-language 真机 400 TM.00001001）。
    expect(auth).toContain('agent-type;host;x-language;')
    expect(ua?.headers.get('agent-type')).toBe('AgentCenter')
    expect(ua?.headers.get('x-language')).toBe('zh-cn')
  })

  it('★★ **两次** AgentCenter 请求都带路由头（2026-10-30 审计 P2 D3 修）', async () => {
    // ⚠️⚠️ 旧守卫只查 `useragents` 一步 ⇒ 变异「`detail` 那一步的
    //    `signedExtras` → undefined」或「改走 unsigned 腿」**全绿**。
    //    ⇒ 上游若按从严口径处理 detail ⇒ detail 恒 400 ⇒ **窗口恒空**
    //    ⇒ 整个 PR 的核心功能**静默失效**（症状与「没接 AgentCenter」同形）。
    //    ⇒ 判据必须是**普查**：两次请求都要带。
    const { fetcher, calls } = makeFetcher(FULL_ROUTES)
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const acCalls = calls.filter((c) => c.url.includes('/v1/agent-center/'))
    expect(acCalls.length, '两步都要发').toBe(2)
    for (const call of acCalls) {
      const auth = call.headers.get('Authorization') ?? ''
      expect(auth, `${call.url} 缺路由头签名`).toContain('agent-type;host;x-language;')
      expect(call.headers.get('agent-type')).toBe('AgentCenter')
      expect(call.headers.get('x-language')).toBe('zh-cn')
    }
  })

  it('★★ query 值不在安全集 ⇒ **不发这个请求**（避免验签分叉）', async () => {
    // ⚠️ `canonicalQueryOf` 的往返在安全集外可能与服务端口径分叉
    //    （`+` 在表单语义下是空格、`&`/`=` 会被重编码）⇒ 静默 401。
    //    ⇒ 宁可不发（退化到静态兜底表），也不要静默 401。
    //
    // ⚠️⚠️ **判据说明**（2026-10-30 修）：本仓**自己**构造的 URL 都是安全的
    //    （`offset=0&limit=100` 字面量；`agent_id` 走 `encodeURIComponent`
    //    ⇒ 往返幂等）⇒ 这道闸是**纯防御**，当前不拦任何真实请求。
    //    ⇒ 故它的牙口在**直接测闸门本身**（下面这条），而不是指望某条
    //    目录请求被拦下（那需要一个「上游给出带 `+` 的 agent_id」的构造，
    //    而 `encodeURIComponent` 已经把它变成了 `%2B` ⇒ 拦不到）。
    expect(isSignedQueryValueSafe('https://x/y?offset=0&limit=100')).toBe(true)
    // ⚠️ **已百分号编码**的字符是**安全**的（往返幂等，实测逐个核对）
    expect(isSignedQueryValueSafe('https://x/y?agent_id=a%2Bb')).toBe(true)
    expect(isSignedQueryValueSafe('https://x/y?q=a%20b')).toBe(true)
    // ⚠️ 危险形态：**裸** `+`（表单语义下是空格）、裸空格、裸 `%`
    expect(isSignedQueryValueSafe('https://x/y?q=a+b')).toBe(false)
    expect(isSignedQueryValueSafe('https://x/y?q=a b')).toBe(false)
    expect(isSignedQueryValueSafe('https://x/y?q=a%b')).toBe(false)
    // ⚠️ **键**也要查（键同样参与 canonical 的编码往返）
    expect(isSignedQueryValueSafe('https://x/y?a+b=1')).toBe(false)
    // ⚠️ 值里的裸 `&`/`=` **不会**进 value（`&` 是分隔符、`=` 只切第一处）
    //    ⇒ 这样的 query 反而**安全**（两侧口径一致）
    expect(isSignedQueryValueSafe('https://x/y?q=a&b=c')).toBe(true)
    // 无 query ⇒ 安全
    expect(isSignedQueryValueSafe('https://x/y')).toBe(true)
    expect(isSignedQueryValueSafe('https://x/y?')).toBe(true)
  })

  it('★★ 安全集必须覆盖 `encodeURIComponent` 的**完整**不编码集（2026-10-30 第二轮审计修）', () => {
    // ⚠️⚠️ `encodeURIComponent` **不编码** `A-Z a-z 0-9 - _ . ! ~ * ' ( )`
    //    ⇒ 若安全集漏了其中任何一个 ⇒ **本仓自己拼的 URL**
    //    （`queue/status?model=${encodeURIComponent(model)}`）会被闸门
    //    **静默丢弃** ⇒ 用户手填一个带 `!` / `(` 的模型 id ⇒
    //    **排队状态查询永远失败**（而 chat 请求不走这道闸门 ⇒ 症状极隐蔽）。
    for (const ch of ['!', '~', '*', "'", '(', ')', '-', '_', '.']) {
      const enc = encodeURIComponent(ch)
      expect(isSignedQueryValueSafe(`https://x/y?v=${enc}`), `${ch} 必须安全`).toBe(true)
    }
    // ⚠️ 反向对照：真正的危险形态**仍必须被拦**（闸门不能变成「什么都不拦」）
    expect(isSignedQueryValueSafe('https://x/y?v=a+b')).toBe(false)
    expect(isSignedQueryValueSafe('https://x/y?v=a b')).toBe(false)
  })

  it('★★ **小写**十六进制必须被拦（`%2b` 往返会变成 `%2B`）', () => {
    // ⚠️ `decodeURIComponent('%2b')` = `'+'` ⇒ `encodeURIComponent('+')` = `'%2B'`
    //    ⇒ **字节变了** ⇒ 与服务端可能分叉 ⇒ 必须拦。
    //    （`encodeURIComponent` 恒产**大写**十六进制 ⇒ 本仓自己拼的 URL 不会
    //    出现小写 ⇒ 这条只防「上游给了小写」这种情况。）
    expect(isSignedQueryValueSafe('https://x/y?v=a%2Bb')).toBe(true)
    expect(isSignedQueryValueSafe('https://x/y?v=a%2bb')).toBe(false)
  })

  it('★★ 安全集闸门在**签名器内部**（覆盖全部签名请求，2026-10-30 第二轮审计 P1 N-3 修）', async () => {
    // ⚠️⚠️ 原先闸门只在 `src/models.ts` 的 `fetchSignedGet` 里 ⇒ **4 条带 query
    //    的签名 GET 只盖了 1 条**（`queue/status` / `ops/delivery` / benefit
    //    claim 那几条**不过闸门**）⇒ 同一个 signer **两条腿两套防护口径**。
    // ⇒ 现在判据在**签名器内部** ⇒ 全部经它的请求都受保护。
    // ⚠️ 判据：**抛错**（⇒ 调用方的 try/catch 把它变成「这次请求没发出去」
    //    ⇒ 退化为上一次成功的值或空 ⇒ 静默降级而非崩溃）。
    await expect(signRequestHuawei(
      'AK', 'SK', 'ST', 'GET', 'https://x/y?agent_id=a+b', new Uint8Array(),
    )).rejects.toThrow(/安全集/)
    // ⚠️ 反向对照：安全 query ⇒ 正常签名（闸门不能变成「什么都不能签」）
    const headers = await signRequestHuawei(
      'AK', 'SK', 'ST', 'GET', 'https://x/y?agent_id=a%2Bb', new Uint8Array(),
    )
    expect(headers.get('Authorization')).toContain('SDK-HMAC-SHA256')
  })

  it('AgentCenter failure degrades to no windows without blocking the catalog', async () => {
    // useragents 404 ⇒ 窗口表为空 ⇒ builtin 目录照常返回（无窗口字段）
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models).toContainEqual({ id: 'GLM-5.2', name: 'GLM-5.2' })
    // detail 失败同理
    const { fetcher: f2 } = makeFetcher({
      [SNAP_AGENT_CENTER_USERAGENTS_URL]: { body: USERAGENTS_BODY },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const models2 = await fetchCodeArtsRemoteModels(makeCredential(), f2)
    expect(models2).toContainEqual({ id: 'GLM-5.2', name: 'GLM-5.2' })
  })

  it('malformed useragents / detail bodies return an empty window map (no throw)', async () => {
    for (const body of ['not-json', JSON.stringify({ agents: 'x' }), JSON.stringify({ agents: [] }), '{}']) {
      const { fetcher } = makeFetcher({
        [SNAP_AGENT_CENTER_USERAGENTS_URL]: { body },
        [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
      })
      const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
      expect(models.find((m) => m.id === 'GLM-5.2')).toBeDefined()
    }
    // agents 存在但 detail 坏
    const { fetcher } = makeFetcher({
      [SNAP_AGENT_CENTER_USERAGENTS_URL]: { body: USERAGENTS_BODY },
      [`${SNAP_AGENT_CENTER_DETAIL_URL}?agent_id=agent-primary`]: { body: 'garbage' },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models.find((m) => m.id === 'GLM-5.2')).toBeDefined()
    expect(models.find((m) => m.id === 'kimi-k3')).toBeUndefined()
  })

  it('falls back to the first agent when no is_primary_agent flag exists', async () => {
    const { fetcher, calls } = makeFetcher({
      // ⚠️ 用上游真实键名 `agent_id`（见 USERAGENTS_BODY 的注释）
      [SNAP_AGENT_CENTER_USERAGENTS_URL]: { body: JSON.stringify({ agents: [{ agent_id: 'first-agent' }] }) },
      [`${SNAP_AGENT_CENTER_DETAIL_URL}?agent_id=first-agent`]: { body: DETAIL_BODY },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const detailCall = calls.find((c) => c.url.startsWith(SNAP_AGENT_CENTER_DETAIL_URL))
    expect(detailCall?.url).toBe(`${SNAP_AGENT_CENTER_DETAIL_URL}?agent_id=first-agent`)
  })

  /**
   * ⚠️⚠️ 守卫：**`agent_id` 字段名**（2026-10-30 真实缺陷的回归）。
   *
   * 生产代码曾读 `a['id']`，而上游只有 `agent_id` ⇒ 恒 undefined ⇒ 整条窗口腿
   * 静默失效，而当时的 9 条用例全绿（fixture 也写了错的 `id`）。
   * 本用例刻意喂**只带 `agent_id`、不带 `id`** 的形状：
   * 若生产代码再退回只读 `id` ⇒ 拿不到窗口 ⇒ 本用例红。
   */
  it('⚠️ 必须按上游真实字段名 agent_id 取 agent（只带 id 的实现会红）', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_AGENT_CENTER_USERAGENTS_URL]: {
        body: JSON.stringify({
          agents: [{ agent_id: 'real-agent', agent_name: 'CodeAgent', is_primary_agent: true }],
        }),
      },
      [`${SNAP_AGENT_CENTER_DETAIL_URL}?agent_id=real-agent`]: { body: DETAIL_BODY },
      [SNAP_MODEL_BUILTIN_URL]: { body: BUILTIN_BODY },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    // 窗口成功挂上 ⇒ agent 被正确取到（取不到则会退化成无窗口的 builtin 目录）
    expect(models.find((m) => m.id === 'GLM-5.2')?.contextWindow).toBe(202752)
    expect(models.find((m) => m.id === 'kimi-k3')?.contextWindow).toBe(1048576)
  })
})
