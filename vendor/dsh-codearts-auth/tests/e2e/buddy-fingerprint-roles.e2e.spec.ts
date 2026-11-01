/**
 * 实测凭据：**腾讯系内容级风控扫描哪些消息角色**（2026-10-12 补测）。
 *
 * ## 为什么这个文件必须**入库**
 * 「`assistant` **正文**会被风控拦、而 `reasoning_content` / `tool_calls.arguments`
 * / `user` / `tool` 结果**不会**」这条结论，已被写进
 * `src/openai-gateway/tencent-fingerprint.ts` 的**实现约束**（决定改写范围），
 * 并有单测锁住。单测只能锁「代码按那个范围做」，**锁不住那个范围本身对不对** ——
 * 而当初翻车的正是这一点：assistant 那一格从未测过，且当时的探针把触发句改写成了
 * 转述形态（服务端逐字符匹配 ⇒ 那个形态不含触发串 ⇒ **空跑**却得出「assistant 放行」）。
 *
 * ⚠️ 本文件因此是那条结论的**唯一可复核凭据**。别把它挪回被 gitignore 的 `scripts/`。
 *
 * ## 触发串从哪里来
 * ⚠️ **刻意不在源码里写那句字面量**：源码会经 tool-call.arguments 进入当前会话
 * 历史，于是**本会话自己的** buddy 请求也开始被拦 —— 观察者污染实验对象
 * （这正是 2026-10-12 那次报障的机制）。故运行时从本仓库的
 * `docs/agent-notes/providers-buddy.md` 读那一行原文，全程不打印。
 *
 * ## 闸门（消耗极小额度：每例 `max_tokens=16`，被拒不耗额度）
 *   DSH_BUDDY_FINGERPRINT_E2E=1 + DSH_BUDDY_FINGERPRINT_E2E_CONFIRM=yes
 *   已绑成脚本：`pnpm test:e2e:buddy-fingerprint`（2026-10-21 补，本文件此前没有入口）
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { productById, resolveUserAgent } from '../../src/product.js'
import { credentialFor } from './image-probe-shared.js'

const ENABLED = process.env.DSH_BUDDY_FINGERPRINT_E2E === '1'
const CONFIRMED = process.env.DSH_BUDDY_FINGERPRINT_E2E_CONFIRM === 'yes'

/**
 * 触发串：取自记录该指纹的文档，取「首次出现该字面量的那一行」，不打印。
 *
 * ⚠️⚠️ **拼进夹具时必须用 JSON 转义后的形态**（见 `wireOf`）—— 文档那一行现在是
 * ``（`$Js="Main branch (you will usually use this for PRs)"`，拼在`` ，
 * 既含**双引号**又带行尾 `\r`：直接 `replaceAll` 进 JSON 文本会得到
 * `Expected ',' or '}' after property value`（2026-10-21 实测，角色矩阵里
 * `reasoning_content` / `tool_calls` 两条用例就是红在这里）。
 * 那是**夹具缺陷**、与「指纹拦不拦」无关 —— 别把它读成指纹结论。
 */
function loadTriggerLine(): string {
  const doc = readFileSync('docs/agent-notes/providers-buddy.md', 'utf8')
  const line = doc.split('\n').find((l) => /usually\s+use\s+this\s+for\s+PRs/i.test(l))
  if (typeof line !== 'string' || line.trim().length === 0) {
    throw new Error('在 docs/agent-notes/providers-buddy.md 里找不到触发串那一行 —— 文档被改动后请同步本探针')
  }
  return line
}

/**
 * 把 `tail` 里的 `TRIGGER` 占位符替换成触发串，并**保证结果是合法 JSON**。
 *
 * 做法：先把触发串 `JSON.stringify` 一次再剥掉外层引号 ⇒ 得到「已转义的字符串体」，
 * 再替换进 JSON 文本。这样引号、反斜杠、`\r` 都被正确转义，夹具不会因为
 * 「文档那一行长什么样」而静默爆掉（旧写法直接塞原文）。
 */
function wireOf(tail: unknown): unknown[] {
  const escaped = JSON.stringify(loadTriggerLine()).slice(1, -1)
  // ⚠️ 断成 `unknown[]` 而不是让 `JSON.parse` 的 `any` 漏出去：调用点要 `...wire` 展开，
  // 返回 `unknown` 会当场 `TS2488`（本文件不在 `tsconfig.tests.json` 白名单里 ⇒
  // `pnpm test` 只转译、不做类型检查，这类错只有单独跑一次 tsc 才看得到）。
  return JSON.parse(JSON.stringify(tail).replaceAll('TRIGGER', escaped)) as unknown[]
}

/**
 * ⚠️⚠️ **按站点取候选账号**（2026-10-21 修，实发时发现）。
 *
 * 两站是**不同后端**（`buddy` = CodeBuddy 中国版 / `workbuddy` = WorkBuddy 国际版），
 * **账号不能混用**；旧实现给两站发的是同一个 `BUDDY_*` 账号 ⇒ `workbuddy` 那一格
 * **恒 `HTTP 401`**（状态码与指纹无关，`expectContentBlocked` 只会说「不是内容级拦截」）。
 * 这与本文件反复强调的那条纪律同源 —— **发错站点会得到与指纹无关的身份错误**，
 * 只是这一次错的是凭据而不是请求头。
 *
 * ⚠️ 解析**必须复用** `credentialFor()`（`image-probe-shared.ts`）：凭据是 YAML
 * 单引号标量、值一长（workbuddy 那条 2,165 字符）就会被**折行**成多行，
 * 按行正则或手扫大括号都会读到坏 JSON —— 那模块的文件头就记着这个坑
 * （「表现为只有国际版解析失败，极易误判成产品问题」）。本文件第一版正是这么踩的。
 *
 * ⚠️ 返回的是**候选**（按文件顺序），最终钉哪一个由 {@link pinnedCredentialFor}
 * 的**基线筛**决定 —— 本文件一直写着「探针必须先筛基线放行的账号再固定用它」，
 * 但 2026-10-21 之前实现只取第一个，于是「第一个账号恰好被限流」会让**每一条**
 * 断言都红在 429 上（与指纹毫无关系）。
 */
function credentialRefsOf(site: typeof SITES[number]): string[] {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  // `\b` 让 `BUDDY_*` 不会误取 `WORKBUDDY_*`（`K` 是词字符，其间无边界）。
  const accountPattern = site.name === 'workbuddy'
    ? /\bWORKBUDDY_ACCOUNT_[0-9A-F]+\b/g
    : /\bBUDDY_ACCOUNT_[0-9A-F]+\b/g
  const accounts = [...new Set(text.match(accountPattern) ?? [])]
  if (accounts.length > 0) return accounts
  // 回退：老形态的单条 `*_ACCESS_TOKEN`（无账号池时的写法）。
  const legacy = site.name === 'workbuddy' ? 'WORKBUDDY_ACCESS_TOKEN' : 'BUDDY_ACCESS_TOKEN'
  return text.includes(`${legacy}:`) ? [legacy] : []
}

/** 取某个 ref 的凭据并校验 `access_token` 可用。 */
function credentialOf(ref: string): Record<string, unknown> {
  const cred = credentialFor(ref)
  if (typeof cred.access_token !== 'string' || cred.access_token.length === 0) {
    throw new Error(`凭据 ${ref} 里没有可用的 access_token`)
  }
  return cred
}

const ENDPOINT = 'https://copilot.tencent.com'
const MODEL = process.env.DSH_BUDDY_FINGERPRINT_MODEL ?? 'step-5-preview'

/**
 * 腾讯系两个端点（IKLS2L 要求**两站分别实测**：它们共用同一个 `BuddyAdapter` 类，
 * 但产品配置与网关不同 ⇒「buddy 过了」推不出 workbuddy 也过）。
 *
 * ⚠️ 这里**只留端点**，`X-Domain` / `X-Product-Code` / `X-IDE-*` / UA 全部由
 * `src/product.ts` 的产品配置现算（见 `headersOf`）—— 手抄第二份头值必然漂移，
 * 而漂移的症状正是「发错站点 → 与指纹无关的身份错误」。
 */
const SITES = [
  { name: 'buddy', endpoint: ENDPOINT },
  { name: 'workbuddy', endpoint: 'https://www.workbuddy.ai' },
] as const

/**
 * ⚠️⚠️ **头必须照 `BuddyAdapter` 的装配来**（2026-10-21 修：本文件原先给两站硬编码
 * 了同一套 CodeBuddy 头值，于是 `workbuddy` 恒被**渠道校验**拦下 ——
 * `400 / 11128 / msg=request illegal`，与指纹毫无关系）。
 *
 * 「谁是对的头值」**只有一份权威**：`src/product.ts` 的产品配置。故这里一律从它取，
 * 不再手抄任何字面量 —— 两站差异不止 UA：
 *
 * | 头 | buddy | workbuddy |
 * |---|---|---|
 * | `X-Product-Code` | `codebuddy` | `workbuddy` |
 * | `X-IDE-Name` / `X-IDE-Type` / `X-Product` | `CodeBuddy` | `WorkBuddy` |
 * | `X-IDE-Version` | `4.12.2` | 产品的 `clientVersion` |
 *
 * ⚠️ 另外三枚 `X-Conversation-*` 与 `X-Agent-Purpose` 也照发：IKM7SG 实测
 * 「三头准入」是**按账号**的硬需求（本文件的 `11128` 子原因分类正是为它设的）。
 * ⚠️ `X-Domain` 用 `||` 而非 `??`（凭据里的 `domain` 字段缺失时是**空串**）。
 */
function headersOf(
  cred: Record<string, unknown>, site: typeof SITES[number], model: string,
): Record<string, string> {
  const product = productById(site.name)
  if (product === undefined) throw new Error(`没有 ${site.name} 的产品配置`)
  const conversationId = randomUUID().replace(/-/g, '')
  return {
    Authorization: `Bearer ${String(cred.access_token)}`,
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'X-Domain': product.apiDomain || String(cred.domain ?? ''),
    'X-Product-Code': product.productCode,
    'X-Agent-Purpose': 'conversation',
    'X-Conversation-ID': conversationId,
    'X-Conversation-Request-ID': conversationId,
    'X-Conversation-Message-ID': conversationId,
    'X-IDE-Name': product.attributionName,
    'X-IDE-Type': product.attributionName,
    'X-IDE-Version': product.clientVersion,
    'X-Product': product.attributionName,
    // UA 按**模型族**分档（两站、乃至同一站的不同模型线都不同）。
    'User-Agent': resolveUserAgent(product, model),
  }
}

/**
 * ⚠️⚠️ **`11128` 有两个子原因，`code` 完全相同，只有 `msg` 不同**（2026-10-18，IKLYCT 取证时踩到）：
 * - `Illegal API invocation from an unapproved channel` = **内容级**（本文件要治的）
 * - `request illegal` = **渠道校验**（IKM7SG：按账号要求三头，缺任一即 400）
 *
 * 取证第一版探针是**轮换账号**的，于是把「某账号要求三头」读成了内容指纹的
 * 匹配语义，实测出「51 字符前缀被拦、69 字符超集反而放行」这种**非单调**的假结论
 * —— 若照它定 `find` 的长度，就会登记一条覆盖不全的规则（症状：仍有变体被拦，
 * 且症状与「完全没修」同形）。
 *
 * ⇒ 下面 `probe()` 做三件事，缺一不可：
 *   ① **基线筛账号**：第一次调用先把 `firstCredential(site)` 固定下来，后续**同一站**全部
 *      用**同一个**（⚠️ 2026-10-21 起**按站点**固定 —— 两站后端不同、账号不通用，
 *      见 `firstCredential` 的注释）；
 *   ② **分开计数**：`kind: 'CHANNEL'` 的结果**不算**内容级命中，断言里单列；
 *   ③ **msg 逐格可见**：报错信息里带上 `msg`，便于人核对归属。
 *
 * ⚠️ `firstCredential(site)` 恒返回该站的**同一个**账号（每次进程一条），所以
 * 「轮换账号」是取证脚本的做法、不是本文件的行为 —— 本文件在这三点上更强：
 * 它把 `msg` 带进断言，**从断言层面**区分两类 11128，而不只是靠人读日志。
 */
type ProbeKind = 'OK' | 'INLINE' | 'CONTENT' | 'CHANNEL' | 'OTHER'

interface ProbeResult {
  /** 「**内容级**被拦」——只有这一种才是本文件要测的。 */
  blocked: boolean
  code?: string
  kind: ProbeKind
  /** 断言失败时打印用（不含凭据）。 */
  detail: string
}

/** 账号只解析一次并**按站点**固定：见上方「11128 有两个子原因」的说明。 */
const pinnedCredentials = new Map<string, Record<string, unknown>>()

function classifyBody(status: number, body: string): { kind: ProbeKind; code?: string; detail: string } {
  if (status === 200) {
    // 200 里也可能内嵌错误帧（IKJNA1 记录过这种形态）
    const code = /"code":(\d+)/.exec(body)?.[1]
    if (code === undefined) return { kind: 'OK', detail: '200' }
    return {
      kind: 'INLINE', code,
      detail: `HTTP 200 但流内含 code ${code}：${body.replace(/\s+/g, ' ').slice(0, 140)}`,
    }
  }
  const code = /"code":(\d+)/.exec(body)?.[1]
  const msg = /"msg":"([^"]*)/.exec(body)?.[1] ?? ''
  const detail = `HTTP ${status} code=${code ?? '?'} msg=${msg || '(无 msg)'}`
  if (code === '11128') {
    return /unapproved channel/i.test(msg)
      ? { kind: 'CONTENT', code, detail }
      : { kind: 'CHANNEL', code, detail }
  }
  return { kind: 'OTHER', code, detail }
}

/** 发一次最小流式请求并分类结果（**不选账号、不做断言**）。 */
async function rawProbe(
  cred: Record<string, unknown>, site: typeof SITES[number], messages: unknown[],
): Promise<ProbeResult> {
  const res = await fetch(`${site.endpoint}/v2/chat/completions`, {
    method: 'POST', headers: headersOf(cred, site, MODEL),
    // ⚠️ `stream:true` **必须发**：两端点对非流式请求都回
    // `400 / code 11101 Non-stream chat request is currently not supported`，
    // 不带它会把「不支持非流式」误读成风控拦截（IKLS2L 探针第一版就踩了）。
    body: JSON.stringify({ model: MODEL, messages, stream: true, max_tokens: 16 }),
  })
  const body = await res.text()
  const { kind, code, detail } = classifyBody(res.status, body)
  return { blocked: kind === 'CONTENT' || kind === 'INLINE', code, kind, detail }
}

/**
 * 按站点**筛出基线可放行的账号**并固定（本文件一直声明的那条纪律，2026-10-21 才落地）。
 *
 * 判据是「中性 system + 一句话 ⇒ 拿到干净的 200（`kind === 'OK'`）」：
 * `401`（拿错站的账号）、`11128 / request illegal`（按账号的渠道门控）、`429`（限流）
 * **都不算** —— 它们全是**账号属性**，与「这条指纹生效/失效」无关；混进断言只会
 * 把结论带歪（2026-10-21 实发就是这样：第一个 workbuddy 账号恰好被限流，
 * 于是本文件的**每一条**断言都红在 `429 / code 6004` 上）。
 *
 * 全部候选都不可用时**抛出并逐条列出原因** —— 不静默跳过，否则「根本没跑」
 * 会看起来像「通过」。
 */
async function pinnedCredentialFor(site: typeof SITES[number]): Promise<Record<string, unknown>> {
  const cached = pinnedCredentials.get(site.name)
  if (cached !== undefined) return cached
  const refs = credentialRefsOf(site)
  if (refs.length === 0) {
    throw new Error(`磁盘上没有 ${site.name} 的凭据（请先在 Jet Hub 登录该渠道）`)
  }
  const notes: string[] = []
  for (const ref of refs) {
    const cred = credentialOf(ref)
    const baseline = await rawProbe(cred, site, [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'reply OK' },
    ])
    if (baseline.kind === 'OK') {
      pinnedCredentials.set(site.name, cred)
      return cred
    }
    notes.push(`${ref}: ${baseline.detail}`)
  }
  throw new Error(
    `${site.name}: ${refs.length} 个候选账号都拿不到基线 200 —— 换账号 / 换模型 / 稍后重跑，`
    + `**别把下面的红读成指纹结论**。逐条：${notes.join(' ｜ ')}`,
  )
}

async function probe(
  messages: unknown[],
  site: typeof SITES[number] = SITES[0],
): Promise<ProbeResult> {
  return rawProbe(await pinnedCredentialFor(site), site, messages)
}

/**
 * 断言「被**内容级**拦截」。
 *
 * ⚠️ `CHANNEL`（渠道校验）**不算**通过也不算失败：它是**账号**属性，与本条指纹无关。
 * 若它在一次真实运行里出现，说明该账号要求三头（IKM7SG）—— 换账号重跑，
 * **绝不能**把它读成「这条指纹生效/失效」。
 */
function expectContentBlocked(r: ProbeResult): void {
  expect(r.detail, `渠道校验（${r.kind}）不是内容级拦截：换个账号重跑，别把它读成指纹结论`).toMatch(/unapproved channel/)
  expect(r.code).toBe('11128')
}

describe.skipIf(!ENABLED || !CONFIRMED)('腾讯系内容级风控：角色矩阵（2026-10-12 实测依据）', () => {
  it('基线：不含触发串的请求必须 200（否则本文件全部结论作废）', async () => {
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it('★ assistant 正文含触发串会被拦（这是本次修复扩大的那一格）', async () => {
    const trigger = loadTriggerLine()
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: trigger },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked, `assistant 正文应被拦，但拿到的是 ${r.detail}`).toBe(true)
    expectContentBlocked(r)
  }, 60_000)

  it('改写该句后放行（证明「改写」是有效修法，而不只是「恰好躲过」）', async () => {
    const trigger = loadTriggerLine()
    const safe = trigger.replace(/usually\s+use\s+this\s+for\s+PRs/gi, 'typically merged into PRs')
    const r = await probe([
      { role: 'system', content: `You are a helpful assistant.\n${safe}` },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it.each([
    ['user', [{ role: 'user', content: 'note' }]],
    ['assistant 的 reasoning_content', [{ role: 'assistant', content: 'Noted.', reasoning_content: 'TRIGGER' }]],
    ['tool_calls[].arguments', [{
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: 'TRIGGER' } }],
    }]],
  ])('%s 含触发串**不拦**（这三格刻意不改写，改了只是篡改证据）', async (_label, tail) => {
    const trigger = loadTriggerLine()
    const wire = wireOf(tail)
    // tool_calls 分支要补上配对的 tool 结果，否则会被「配对不完整」先拒
    const messages: unknown[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      ...wire,
      { role: 'user', content: 'reply OK' },
    ]
    if (_label.startsWith('tool_calls')) {
      messages.splice(messages.length - 1, 0, { role: 'tool', tool_call_id: 'c1', content: trigger })
    }
    const r = await probe(messages)
    expect(r.blocked).toBe(false)
  }, 60_000)
})

/**
 * ## 第二条指纹：**Claude Code 的身份句**（Gitee issue IKLS2L，2026-10-14）
 *
 * 与上面 ZCode 那条同为腾讯内容级风控，但**锚点语义相反**。本节的结论
 * （「行首锚定、后缀自由」）已被写进 `src/openai-gateway/tencent-fingerprint.ts`
 * 的注释 —— 单测只能锁「代码按那个范围做」，**锁不住那个范围本身对不对**，
 * 所以这一节是那条相反结论的**唯一可复核凭据**。
 *
 * ⚠️ 与上面 ZCode 那条不同，这句字面量**可以**写在源码里：改写已覆盖
 * `system` 与 `assistant` 正文两处，「排查这个风控 bug 的会话」不会再拦死自己。
 */
describe.skipIf(!ENABLED || !CONFIRMED)('腾讯系内容级风控：Claude Code 身份句（IKLS2L 实测依据）', () => {
  const CLAUDE_TRIGGER = "You are Claude Code, Anthropic's official CLI for Claude"
  const CLAUDE_REWRITE = "You are Claude Code, Anthropic's CLI for Claude"
  /** Claude Code v2.1.295 内建的另外两个身份句常量（issue 从二进制读出）。 */
  const SDK_VARIANT = `${CLAUDE_TRIGGER}, running within the Claude Agent SDK.`
  const AGENT_VARIANT = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

  it.each(SITES.map((s) => [s.name, s] as const))(
    '★ %s：身份句在 system **被拦**，改写后放行（本条登记的全部依据）',
    async (_name, site) => {
      const blocked = await probe(
        [{ role: 'system', content: CLAUDE_TRIGGER }, { role: 'user', content: 'reply OK' }], site)
      expect(blocked.blocked, `${site.name}: 身份句实测应被拦，但拿到的是 ${blocked.detail}`).toBe(true)
      expectContentBlocked(blocked)
      // 改写是**有效修法**，不只是「恰好躲过」：同一位置换等义措辞即 200。
      const fixed = await probe(
        [{ role: 'system', content: CLAUDE_REWRITE }, { role: 'user', content: 'reply OK' }], site)
      expect(fixed.blocked, `${site.name}: 改写后应放行`).toBe(false)
    }, 120_000)

  it.each(SITES.map((s) => [s.name, s] as const))(
    '★ %s：SDK 变体也被拦，且同一条登记（`find` 不带尾句点）即可救它',
    async (_name, site) => {
      const blocked = await probe(
        [{ role: 'system', content: SDK_VARIANT }, { role: 'user', content: 'reply OK' }], site)
      expect(blocked.blocked, `${site.name}: SDK 变体实测应被拦，但拿到的是 ${blocked.detail}`).toBe(true)
      expectContentBlocked(blocked)
      const fixed = await probe([{
        role: 'system',
        content: SDK_VARIANT.replace(CLAUDE_TRIGGER, CLAUDE_REWRITE),
      }, { role: 'user', content: 'reply OK' }], site)
      expect(fixed.blocked).toBe(false)
    }, 120_000)

  it('★ assistant **正文**放身份句也被拦（历史重放路径的成因）', async () => {
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: CLAUDE_TRIGGER },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked, `assistant 正文应被拦，但拿到的是 ${r.detail}`).toBe(true)
    expectContentBlocked(r)
  }, 60_000)

  /**
   * ⚠️⚠️ **本条的锚点与 ZCode 那条相反**：身份句**只在文本开头**被拦。
   *
   * 这一格是 issue 描述（「子串精确匹配、位置无关」）被**实测推翻**的地方，
   * 也是「将来加新指纹时探针必须两侧都测」这条纪律的依据 ——
   * 只测句中会得到「已放行」的**假阴性**，据此删掉一条仍必需的登记就重开 bug。
   */
  it.each([
    ['前接空格', ` ${CLAUDE_TRIGGER}`],
    ['前接换行', `\n${CLAUDE_TRIGGER}`],
    ['前接中文前言', `前言。${CLAUDE_TRIGGER}`],
    ['双换行包裹', `\n\n${CLAUDE_TRIGGER}\n\n`],
  ])('★ 锚点实测：%s ⇒ **放行**（该指纹行首锚定，不是位置无关）', async (_label, system) => {
    const r = await probe([{ role: 'system', content: system }, { role: 'user', content: 'reply OK' }])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it.each([
    ['后接尾句点', `${CLAUDE_TRIGGER}.`],
    ['后接中文句号', `${CLAUDE_TRIGGER}。`],
    ['后接长正文', `${CLAUDE_TRIGGER}\n\n${'padding. '.repeat(50)}`],
  ])('★ 锚点实测：%s ⇒ **仍被拦**（后缀自由，前导字符一个都不容忍）', async (_label, system) => {
    const r = await probe([{ role: 'system', content: system }, { role: 'user', content: 'reply OK' }])
    expect(r.blocked, `后缀自由应仍被拦，但拿到的是 ${r.detail}`).toBe(true)
    expectContentBlocked(r)
  }, 60_000)

  it('★ 逐字符匹配：少一个字母放行、多一个字母仍被拦', async () => {
    const fewer = CLAUDE_TRIGGER.replace(/Claude$/, 'Claud')
    const more = `${CLAUDE_TRIGGER}X`
    expect((await probe([{ role: 'system', content: fewer }, { role: 'user', content: 'reply OK' }])).blocked).toBe(false)
    const moreResult = await probe([{ role: 'system', content: more }, { role: 'user', content: 'reply OK' }])
    expect(moreResult.blocked).toBe(true)
    expectContentBlocked(moreResult)
  }, 90_000)

  it('★ 第三个常量（`Claude agent`）实测**放行** ⇒ 刻意不登记它', async () => {
    // 「表能加就加」是错的：多登记一条会替上游无谓改写用户提示词并破坏前缀缓存。
    // 本用例钉住「它确实不该被登记」——若某天它开始被拦，这里会红。
    const r = await probe([{ role: 'system', content: AGENT_VARIANT }, { role: 'user', content: 'reply OK' }])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it('★ user 角色放身份句不拦（故该角色刻意不改写）', async () => {
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: CLAUDE_TRIGGER },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked).toBe(false)
  }, 60_000)
})

/**
 * ## 第三条指纹：Claude Code system 的**反馈句**（Gitee issue IKLYCT，2026-10-18）
 *
 * ```
 * To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues
 * ```
 *
 * ### 为什么这一条比身份句更严重
 *
 * 身份句只有 cc-switch 的 `mrt()` 探测路径漏传前缀时才注入（实测约 34% 窗口）；
 * 本句属于 Claude Code system prompt 的**固定段落** —— 客户端把默认 system
 * 整份发过来就**必然**带上 ⇒ **漏登记 = 必然命中**。用户侧实测单日白撞 647 次。
 *
 * ### ⚠️⚠️ 本节两端点**各测一遍**（issue 的「未验证项」由此结清）
 *
 * issue 只验证了 `buddy` 一端，`workbuddy` 因限流未测。下面对 `SITES` 两站都跑 ——
 * 两站共用 `BuddyAdapter` 类但**产品配置与网关不同** ⇒「一站过了」推不出另一站也过。
 *
 * ### ⚠️ 本条的 `find` 长度由「砍掉半句」那两格定死
 *
 * 实测砍掉前半或砍掉后半都**放行** ⇒ 子串本身不触发 ⇒ `find` 必须写整句。
 * 照抄别条 find 的长度会漏改写，而漏改写的症状是「登记了却仍每轮 400」，极难归因。
 *
 * ### ⚠️ 锚点是**位置无关**（与身份句的行首锚定相反）
 *
 * 「锚点结论不可跨条推用」这条纪律在这里第二次被印证：照身份句那条的结论
 * 写探针（前接前言就放行）会得到**假阴性**，据此删掉登记就重开这个 bug。
 */
describe.skipIf(!ENABLED || !CONFIRMED)('腾讯系内容级风控：Claude Code 反馈句（IKLYCT 实测依据）', () => {
  const FEEDBACK_TRIGGER = 'To give feedback, users should report the issue at '
    + 'https://github.com/anthropics/claude-code/issues'
  const FEEDBACK_REWRITE = 'To give feedback, users should report the issue at the project issue tracker'

  it.each(SITES.map((s) => [s.name, s] as const))(
    '★ %s：整句被拦，改写后放行（本条登记的全部依据；issue 未验证的 workbuddy 由这一格结清）',
    async (_name, site) => {
      const blocked = await probe(
        [{ role: 'system', content: FEEDBACK_TRIGGER }, { role: 'user', content: 'reply OK' }], site)
      expect(blocked.blocked, `${site.name}: 整句实测应被拦，但拿到的是 ${blocked.detail}`).toBe(true)
      expectContentBlocked(blocked)
      // 改写是**有效修法**，不只是「恰好躲过」：同一位置换等义措辞即 200。
      const fixed = await probe(
        [{ role: 'system', content: FEEDBACK_REWRITE }, { role: 'user', content: 'reply OK' }], site)
      expect(fixed.blocked, `${site.name}: 改写后应放行`).toBe(false)
    }, 120_000)

  it.each([
    ['前接 Note:', `Note: ${FEEDBACK_TRIGGER}`],
    ['前接行首装饰', `  - ${FEEDBACK_TRIGGER}`],
    ['后接换行文本', `${FEEDBACK_TRIGGER}\n后接无关文本`],
    ['全大写', FEEDBACK_TRIGGER.toUpperCase()],
  ])('★ 锚点实测：%s ⇒ **仍被拦**（该指纹位置无关，不是行首锚定）', async (_label, system) => {
    const r = await probe([{ role: 'system', content: system }, { role: 'user', content: 'reply OK' }])
    expect(r.blocked, `位置无关应仍被拦，但拿到的是 ${r.detail}`).toBe(true)
    expectContentBlocked(r)
  }, 60_000)

  it.each([
    ['砍掉前半', 'users should report the issue at https://github.com/anthropics/claude-code/issues'],
    ['砍掉后半', 'To give feedback, users should report the issue'],
    ['只留 URL', 'https://github.com/anthropics/claude-code/issues'],
    ['换 org/repo', FEEDBACK_TRIGGER.replace('anthropics/claude-code', 'other/repo')],
    ['换域名', FEEDBACK_TRIGGER.replace('anthropics/claude-code', 'example/project')],
    ['改一个词', FEEDBACK_TRIGGER.replace('report the issue', 'file the issue')],
  ])('★ 逐字符实测：%s ⇒ **放行**（`find` 必须写整句，且不得泛化）', async (_label, system) => {
    const r = await probe([{ role: 'system', content: system }, { role: 'user', content: 'reply OK' }])
    expect(r.blocked).toBe(false)
  }, 60_000)

  it('★ assistant **正文**也被拦（历史重放路径的成因，与另两条同型）', async () => {
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: FEEDBACK_TRIGGER },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked, `assistant 正文应被拦，但拿到的是 ${r.detail}`).toBe(true)
    expectContentBlocked(r)
  }, 60_000)

  it('★ 非首位 system 同样被拦（故所有 system 都要改）', async () => {
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'x' },
      { role: 'system', content: FEEDBACK_TRIGGER },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked, `非首位 system 应被拦，但拿到的是 ${r.detail}`).toBe(true)
    expectContentBlocked(r)
  }, 60_000)

  it.each([
    ['user', [{ role: 'user', content: `note: ${FEEDBACK_TRIGGER}` }]],
    ['assistant 的 reasoning_content', [{ role: 'assistant', content: 'Noted.', reasoning_content: FEEDBACK_TRIGGER }]],
    ['tool 结果', [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: `docs: ${FEEDBACK_TRIGGER}` },
    ]],
  ])('★ %s 含反馈句**不拦**（这三格刻意不改写，改了只是篡改证据）', async (_label, tail) => {
    const messages: unknown[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      ...tail,
      { role: 'user', content: 'reply OK' },
    ]
    const r = await probe(messages)
    expect(r.blocked).toBe(false)
  }, 60_000)
})

/**
 * ## 第四条指纹：**DSH 自己的 system 身份首句**（2026-10-20 登记，2026-10-21 换措辞）
 *
 * 与前三条的本质差别：它不是别的客户端泄漏进来的，而是**DSH 每轮必带的 `base` 首句**
 * —— 换会话、清历史都躲不掉，只能靠 `src/openai-gateway/tencent-fingerprint.ts` 那张表。
 *
 * ## ⚠️ 验收条件：**当前 `replace` 的措辞必须实测放行**
 *
 * 旧串 `You are an AI agent built on the DeepSeek Harness runtime` 是 2026-10-20
 * 实测放行的；2026-10-21 按用户要求换成了**官方同形**措辞
 * （`You are an AI coding assistant, powered by a large language model`，
 * 依据是 CodeBuddy 客户端自己那条会话的 system 首句形态）。换措辞时那一格是
 * **唯一依据** —— 它若红，要改的是**措辞**，不是断言。
 *
 * ✅ **2026-10-21 实发结果**（`deepseek-v4.1-flash`）：`buddy` 站新措辞拿到干净的
 * 200；`workbuddy` 站本来就放行（见下）⇒ 换措辞**验收通过**。
 *
 * ## ⚠️⚠️ 本句是**端点相关**的（本条登记时没测过这一格）
 *
 * 见下面 `DSH_BLOCKING_SITES` 那张对照表：同一句在 `copilot.tencent.com` 被拦、
 * 在 `www.workbuddy.ai` **放行**，且 `step-5-preview` 与 `deepseek-v4.1-flash`
 * **两个模型都测过** ⇒ 这是**站点差异、不是模型差异**。
 *
 * ⚠️ 因此本节里**不带 `site` 参数**的用例（assistant 正文 / 锚点 / 整段形态）
 * 全部打在**默认站点 `buddy`** 上 —— 只有那一站这条指纹是活的，那些「仍被拦」
 * 的断言放错站点会红得莫名其妙。
 *
 * ⚠️ 与 ZCode 那条不同，这句字面量**可以**写在源码里：改写已覆盖 `system` 与
 * `assistant` 正文两处（见 `tencent-fingerprint.ts` 的实现约束）。
 *
 * 跑法：`pnpm test:e2e:buddy-fingerprint`（双闸门已绑好）；
 * 指定模型：`DSH_BUDDY_FINGERPRINT_MODEL=deepseek-v4.1-flash pnpm test:e2e:buddy-fingerprint`。
 */
describe.skipIf(!ENABLED || !CONFIRMED)('腾讯系内容级风控：DSH 身份首句（2026-10-20/21 实测依据）', () => {
  const DSH_TRIGGER = 'You are an AI agent powered by DeepSeek Harness'
  const DSH_REWRITE = 'You are an AI coding assistant, powered by a large language model'

  /**
   * ⚠️⚠️ **本句是端点相关的**（2026-10-21 两站对照实测；本条 2026-10-20 登记时
   * **只测过 `copilot.tencent.com`**，国际站那一格从没测过）：
   *
   * | 站点 | 裸串（`step-5-preview`） | 裸串（`deepseek-v4.1-flash`） |
   * |---|---|---|
   * | `copilot.tencent.com`（buddy） | ❌ 400/11128 | ❌ 400/11128 |
   * | `www.workbuddy.ai`（workbuddy） | ✅ 200 | ✅ 200 |
   *
   * 两个模型都测过 ⇒ **站点差异**、不是模型差异。登记表对 `workbuddy` 仍保留这条
   * 改写：措辞语义等义、对该站无害，而国际站哪天也上名单时它就是现成的防线。
   *
   * ⚠️ 下面这一格**把实测事实钉住**：没被拦的站断言「放行」⇒ 上游哪天开始拦就会红，
   * 提醒维护者把该站移进 `DSH_BLOCKING_SITES`；否则断言会与事实悄悄脱节
   * —— 本节第一版照抄邻节的「两站都测」写法，把没测过的那格当成了已知，实测当场红。
   */
  const DSH_BLOCKING_SITES: readonly string[] = ['buddy']

  it.each(SITES.map((s) => [s.name, s] as const))(
    '★ %s：裸串的实测结论 + **当前 `replace` 的措辞实测放行**（换措辞的验收条件）',
    async (name, site) => {
      const raw = await probe(
        [{ role: 'system', content: DSH_TRIGGER }, { role: 'user', content: 'reply OK' }], site)
      if (DSH_BLOCKING_SITES.includes(name)) {
        expect(raw.blocked, `${name}: 裸串实测应被拦，但拿到的是 ${raw.detail}`).toBe(true)
        expectContentBlocked(raw)
      } else {
        expect(raw.kind, `${name}: 裸串在 2026-10-21 实测**放行**；若红了说明上游改了名单 ⇒ `
          + `把 ${name} 移进 DSH_BLOCKING_SITES（拿到的是 ${raw.detail}）`).toBe('OK')
      }
      // 无论该站拦不拦，「当前 replace 的措辞」都必须能过 —— 这是换措辞的验收条件。
      const fixed = await probe(
        [{ role: 'system', content: DSH_REWRITE }, { role: 'user', content: 'reply OK' }], site)
      // ⚠️ 断言 `kind === 'OK'` 而不是 `blocked === false`：后者的 `CHANNEL`
      // （按账号的渠道门控，见 `expectContentBlocked` 注释）也会是 false ⇒ 会把
      // 「账号拿不到准入」误读成「新措辞放行」。`OK` 才是干净的 200。
      expect(fixed.kind, `${name}: 新措辞应拿到干净的 200；拿到 ${fixed.detail}`).toBe('OK')
    }, 120_000)

  it('★ assistant **正文**放首句也被拦（历史重放路径的成因，与另三条同型）', async () => {
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: DSH_TRIGGER },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked, `assistant 正文应被拦，但拿到的是 ${r.detail}`).toBe(true)
    expectContentBlocked(r)
  }, 60_000)

  it('★ 锚点实测：前接任意前缀 ⇒ **放行**（该指纹行首锚定，与 ZCode / 反馈句相反）', async () => {
    // 这一格是「锚点结论不可跨条推用」的又一例：按 ZCode 那条「位置无关」的直觉
    // 写探针，会把「前接前言即放行」误读成「这条指纹已失效」。
    const r = await probe([
      { role: 'system', content: `You are a helpful assistant.\n\n${DSH_TRIGGER}` },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.kind, `前接前缀应放行；拿到 ${r.detail}`).toBe('OK')
  }, 60_000)

  it.each([
    ['后接尾句点', `${DSH_TRIGGER}.`],
    ['后接正文', `${DSH_TRIGGER}.\n\nYou are a coding agent. Reply OK.`],
  ])('★ 锚点实测：%s ⇒ **仍被拦**（后缀自由；`find` 不带尾句点即可一条覆盖）', async (_label, system) => {
    const r = await probe([{ role: 'system', content: system }, { role: 'user', content: 'reply OK' }])
    expect(r.blocked, `后缀自由应仍被拦，但拿到的是 ${r.detail}`).toBe(true)
    expectContentBlocked(r)
  }, 60_000)

  it('★ 身份句改写后 + 长正文 ⇒ **放行**（⚠️ 本格**只覆盖身份句**，多出现位置见第 5 节）', async () => {
    // ⚠️⚠️ 这一格曾经用 `'padding. '.repeat(200)` 冒充「长正文」，于是**自以为**覆盖了
    // 「真实整段」——而真实整段里 `DeepSeek Harness` 还有另外两处（其中 Web 运行面那句
    // **单独就能拦**）⇒ 2026-10-21 的真实报障正是从这里漏过去的。
    // 本格现在只声明它真正测到的东西：**身份句**改写后能过；
    // 「多出现位置」那一格由第 5 节的 `★★` 用例负责（那一格才是报障者的原话）。
    const system = `${DSH_REWRITE}.\n\nYou are a coding agent. Use the tools.\n\n${'padding. '.repeat(200)}`
    const r = await probe([{ role: 'system', content: system }, { role: 'user', content: 'reply OK' }])
    expect(r.kind, `改写后的整段 system 应放行；拿到 ${r.detail}`).toBe('OK')
  }, 60_000)
})

/**
 * ## 第五条指纹：**DSH Web 运行面的开头两句**（2026-10-21 真实报障）
 *
 * 出自 `@deepseek-ai/dsh-harness-dev-context` 的 `WEB_SURFACE_PROMPT`；
 * 该插件**只在 Web 运行时挂载**（它 README 原话：`--help` 与非 Web 组合从不挂载）
 * ⇒ CLI / 桌面面的 system 里**没有这句**，任何取自那些面的「真实整段」都测不到它。
 *
 * ## ⚠️⚠️ 本节要害 = 「多出现位置」那一格（`★★`）
 *
 * 报障者的原话是「**只测单句的用例永远抓不到这一格**」—— 完全正确：
 * 第 4 节发的是**单句**载荷，而真实 system 里 `DeepSeek Harness` 出现 **3 次**，
 * **只改第 1 行**的形态在 buddy 站**仍被整轮 400/11128**（本节 `★★` 复现的就是它）。
 *
 * ⚠️ 载荷是**同形**文字（逐字节取自真实 system，但与 DSH 的源码解耦）：
 * 它锁得住「换了措辞会被拦」，**锁不住**「DSH 改了那两句而 `find` 没跟上」——
 * 后者的守卫是单测里那条**读本机会话落盘**的漂移用例。
 *
 * 跑法：`pnpm test:e2e:buddy-fingerprint`。
 */
describe.skipIf(!ENABLED || !CONFIRMED)('腾讯系内容级风控：DSH Web 运行面两句（2026-10-21 实测依据）', () => {
  /** 真实 system 里那两句（221 字符）。⚠️ 与单测里的誊写互为对照。 */
  const WEB_TRIGGER = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.'
  /** 去掉品牌串的等义形态（212 字符）。 */
  const WEB_REWRITE = 'You are interacting with the user through the harness Web GUI whose URL the runtime context names. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.'
  /** 第 4 条已验的**身份句**改写形态，用来拼「多出现」载荷。 */
  const IDENTITY_REWRITE = 'You are an AI coding assistant, powered by a large language model'
  /** 实测只有 buddy 拦（与第 4 条同型）。上游若把名单铺到国际站，这一格会红。 */
  const WEB_BLOCKING_SITES: readonly string[] = ['buddy']

  const sys = (content: string) => [{ role: 'system', content }, { role: 'user', content: 'reply OK' }]

  it.each(SITES.map((s) => [s.name, s] as const))(
    '★ %s：本字面量的实测结论（拦 / 不拦），且**改写后必须干净 200**',
    async (name, site) => {
      const raw = await probe(sys(WEB_TRIGGER), site)
      if (WEB_BLOCKING_SITES.includes(name)) {
        expect(raw.blocked, `${name}: 本字面量实测应被拦，但拿到的是 ${raw.detail}`).toBe(true)
        expectContentBlocked(raw)
      } else {
        expect(raw.kind, `${name}: 本字面量 2026-10-21 实测**放行**；若红了说明上游改了名单 ⇒ `
          + `把 ${name} 移进 WEB_BLOCKING_SITES（拿到的是 ${raw.detail}）`).toBe('OK')
      }
      const fixed = await probe(sys(WEB_REWRITE), site)
      expect(fixed.kind, `${name}: 改写后应拿到干净的 200；拿到 ${fixed.detail}`).toBe('OK')
    }, 120_000)

  it('★ `find` 长度判据：**前 220 字符**实测放行（写短了 = 静默空跑）', async () => {
    const r = await probe(sys(WEB_TRIGGER.slice(0, 220)))
    expect(r.kind, `220 字符前缀实测放行；拿到 ${r.detail}`).toBe('OK')
    // 反向对照（221 = 整条必须被拦）在上一格 `it.each` 里。
  }, 60_000)

  it('★ 位置无关：前接中性前言**仍被拦**（与第 4 条的行首锚定**相反**）', async () => {
    const r = await probe(sys(`You are a helpful assistant.\n\n${WEB_TRIGGER}`))
    expect(r.blocked, `位置无关应仍被拦，但拿到的是 ${r.detail}`).toBe(true)
    expectContentBlocked(r)
  }, 60_000)

  it('★ assistant **正文**放本字面量也被拦（故现有改写范围已覆盖）', async () => {
    const r = await probe([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: WEB_TRIGGER },
      { role: 'user', content: 'reply OK' },
    ])
    expect(r.blocked, `assistant 正文应被拦，但拿到的是 ${r.detail}`).toBe(true)
    expectContentBlocked(r)
  }, 60_000)

  it('★ 旧版形态（`…Web GUI at <url>.`）实测**放行** ⇒ 刻意不登记它', async () => {
    // 反向断言：多登记一条 = 替上游无谓改写提示词并破坏前缀缓存。
    // 若哪天它开始被拦，这里会红 —— 那时才该把它加进表。
    const r = await probe(sys(
      'You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:3080.'))
    expect(r.kind, `旧形态实测放行；拿到 ${r.detail}`).toBe('OK')
  }, 60_000)

  it('★★ 多出现位置（本节要害）：只改第 1 行**仍被拦**，两处都改才放行', async () => {
    // 2026-10-21 报障的现场形态：插件当时只登记了身份句（第 1 行），
    // 而真实 system 里 `DeepSeek Harness` 还有 Web 运行面那一处 ⇒ 整轮 400。
    const shape = (identity: string, web: string) => [
      `${identity}.`,
      '',
      'You are a coding agent. Use the tools to resolve the request.',
      '',
      web,
      '',
      '尾注。',
    ].join('\n')

    const before = await probe(sys(shape(IDENTITY_REWRITE, WEB_TRIGGER)))
    expect(before.blocked, `只改第 1 行应**仍被拦**（报障现场）；拿到的是 ${before.detail}`).toBe(true)
    expectContentBlocked(before)

    const after = await probe(sys(shape(IDENTITY_REWRITE, WEB_REWRITE)))
    expect(after.kind, `两处都改应放行；拿到 ${after.detail}`).toBe('OK')
  }, 120_000)
})