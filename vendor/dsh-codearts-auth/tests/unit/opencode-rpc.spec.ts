import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleOpencodeRpc, type OpencodePoolLike } from '../../src/opencode-rpc.js'
import { deriveProjectId } from '../../src/opencode.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * ⚠️ **代理路径的 fetch 来自外部 undici**（`proxyFetch` 与 dispatcher 同源，
 * 见 issue IKK4BY），故 `vi.stubGlobal('fetch', …)` **拦不到它** ——
 * 必须单独给 undici 的 fetch 装替身。
 *
 * ⚠️ 用 `importOriginal` 展开而不是整模块替换：`ProxyAgent` / `Pool` 必须保持
 * **真实**，否则 `buildProxyDispatcher` 会失去构造能力（那测的就不是本 provider 了）。
 */
const undiciFetchSpy = vi.hoisted(() => vi.fn())
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: undiciFetchSpy,
}))

/**
 * ⚠️ 统一在 `afterEach` 收尾，**不要**在各用例里手写 `mockReset()`：
 * 手写版一旦某条断言在中途抛错，那行 `mockReset()` 就被跳过，
 * 被污染的替身会**泄漏到下一条用例**（表现为随机性的假失败，极难排查）。
 */
afterEach(() => {
  undiciFetchSpy.mockReset()
  vi.unstubAllGlobals()
})

interface Result { ok: boolean; value?: unknown; error?: { message: string } }

/**
 * 最小宿主替身。
 *
 * ⚠️ 真机报障「unknown method: opencode.addAnonymous」的根因是**注册方式错了**
 * （本模块曾自己 `rpc.register`，而 Jet Hub 唯一通道是 `jet-hub-rpc.ts` 的
 * `handleMethod`）。故这里直接调 {@link handleOpencodeRpc} —— 与真实链路一致。
 * 另有源码文本断言锁死「并入主 switch」这条约定（见文件末尾 describe）。
 */
function harness() {
  const ctx = {
    credentials: {
      set: vi.fn(async () => {}),
      // ⚠️ `resolve` 是 P1-1 修复（「凭据读不到 ⇒ 必须覆盖写」）承重的那条腿：
      // 默认返回 undefined（= 还没有凭据），要模拟「凭据完好」的用例自己 mock。
      resolve: vi.fn(async () => undefined as { value: string; source: string } | undefined),
    },
    logger: { info: () => {}, warn: () => {} },
  }
  const pool = {
    listAccountsByProvider: vi.fn(() => [] as Array<{ id: string; enabled: boolean; credentialRef: string }>),
    addAccount: vi.fn(async () => {}),
    updateAccount: vi.fn(async () => {}),
    setOpencodeProxy: vi.fn(async () => {}),
    updateOpencodeFingerprintGeneration: vi.fn(async () => {}),
    opencodeFingerprintGenerationFor: vi.fn(() => 0),
  }
  const call = async (method: string, payload: unknown): Promise<Result | undefined> => {
    const result = await handleOpencodeRpc(
      ctx as never, pool as unknown as OpencodePoolLike, method, payload,
    )
    return result as Result | undefined
  }
  return { call, pool, ctx }
}

describe('分派归属（真实事故 2026-10-02）', () => {
  const hubRpc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/jet-hub-rpc.ts'),
    'utf8',
  )

  it('⚠️ 不认识的方法返回 undefined（让主 switch 继续匹配，而非自己回错误信封）', async () => {
    const { call } = harness()
    // 若这里回 {ok:false}，别的 provider 的方法名会被误判成「格式错误」。
    expect(await call('some.other.method', {})).toBeUndefined()
  })

  it('⚠️ 本模块不再自注册端点（那是真机报障的根因）', () => {
    const rpcSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/opencode-rpc.ts'),
      'utf8',
    )
    // ⚠️ 只看**代码行**：模块头注释里刻意保留了这句「我最初在这里调
    // `rpc.register`…」作为后人提醒，它不该让这条断言变红。
    const code = rpcSource.split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n')
    expect(code).not.toMatch(/rpc\.register\(/)
    expect(rpcSource).not.toMatch(/export function registerOpencodeRpc/)
  })

  it('⚠️ 主 handleMethod 在 switch 之前先试 opencode 分支', () => {
    // Jet Hub 只有一条通道（connection.fetch.register → handleMethod），
    // 若不并入它的 switch，所有 opencode.* 方法都落在 default → unknown method。
    //
    // ⚠️⚠️ **不得用固定字符窗口切片**（2026-10-17 修）：原判据是
    //    `slice(at, at + 900)`，而本 fork 在同一函数里新增了 `modelscope.` 改道分支
    //    及其注释 ⇒ `switch (method)` 被挤出那 900 字符 ⇒
    //    `body.indexOf('switch (method)')` 变成 -1，而 `177 < -1` 为假 ⇒ 假红。
    //    ⚠️ **判据没抓住先怀疑判据本身**（本仓库反复记录的教训）：
    //    魔数窗口对本文件里「任何新增分支/注释」都是定时炸弹，与被测行为无关。
    // ⇒ 改为**锚点式**：从 `handleMethod` 起，取到**第一个** `switch (method)` 为止。
    const at = hubRpc.indexOf('async function handleMethod(')
    expect(at, 'handleMethod 不存在').toBeGreaterThan(-1)
    const sw = hubRpc.indexOf('switch (method)', at)
    expect(sw, 'handleMethod 里没有 switch (method)').toBeGreaterThan(at)
    const body = hubRpc.slice(at, sw)
    expect(body).toMatch(/handleOpencodeRpc\(/)
  })
})

const VALID_KEY = `sk-${'a'.repeat(48)}`
/**
 * opencode 2026-10-22 起签发的新形态（Gitee **IKPLRU**）。
 * ⚠️ 这个 fixture 的**判据必须是「被接受」**，不是「被拒绝」——
 * 上游改前缀不是缺陷，插件的形状闸跟着它一起改才是。
 */
const OC_SK_KEY = `oc_sk_1a2b3c4d5e6f${'0'.repeat(24)}`

describe('opencode.addAccount', () => {
  it('key 形状非法时拒绝且不写池', async () => {
    const { call, pool } = harness()
    const r = await call('opencode.addAccount', { apiKey: 'not-a-key' })
    expect(r.ok).toBe(false)
    // ⚠️ 断言**不再**点名某个前缀（`sk-`）——文案里点名就等于把判据绑回前缀。
    expect(r.error?.message).toContain('形状不对')
    expect(pool.addAccount).not.toHaveBeenCalled()
  })

  it('key 过短拒绝（不足 20 位）', async () => {
    const { call, pool } = harness()
    expect((await call('opencode.addAccount', { apiKey: 'sk-short' })).ok).toBe(false)
    expect(pool.addAccount).not.toHaveBeenCalled()
  })

  it('⚠️ IKPLRU：新形态 `oc_sk_` key 必须被接受（前缀判据不得绑死 sk-）', async () => {
    const { call, pool, ctx } = harness()
    const r = await call('opencode.addAccount', { apiKey: OC_SK_KEY, nickname: '新形态' })
    expect(r.ok, `oc_sk_ key 被拒：${JSON.stringify(r)}`).toBe(true)
    expect(ctx.credentials.set).toHaveBeenCalledTimes(1)
    expect(pool.addAccount).toHaveBeenCalledTimes(1)
    // 凭据里存的必须是原样 key（形状闸不得改动它）。
    const value = String((ctx.credentials.set as never as { mock: { calls: [string, string][] } }).mock.calls[0]![1])
    expect((JSON.parse(value) as { api_key: string }).api_key).toBe(OC_SK_KEY)
  })

  it('⚠️ 尾段含 `-` 的 key：credentialRef 不得抛错（ref 归一化到 POSIX 标识符）', async () => {
    // 实测（2026-10-22）：旧实现把尾段原样拼进 ref，而 `credentialRef()`
    // 只认 `[A-Za-z_][A-Za-z0-9_]*` ⇒ 抛 TypeError，用户看到的是
    // `credential ref "…" must match …` 这条与 key 无关的报错、账号写不进去。
    const { call, pool, ctx } = harness()
    const key = `sk-${'a'.repeat(40)}-d-e-f-g`
    const r = await call('opencode.addAccount', { apiKey: key })
    expect(r.ok, `含短横线的 key 被拒：${JSON.stringify(r)}`).toBe(true)
    const ref = String((ctx.credentials.set as never as { mock: { calls: [string, string][] } }).mock.calls[0]![0])
    expect(ref).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    expect(ref).toContain('OPENCODE_ACCOUNT_')
    expect(pool.addAccount).toHaveBeenCalledTimes(1)
  })

  /**
   * ★★ P2（2026-10-25 审计 A1-F1）：ref 归一化不得让两条不同 key 撞成同一引用。
   *
   * ## ⚠️ 这对输入必须是「**两条都走归一化分支**、且剥完非法字符后相同」
   *
   * 旧用例选的是 `…ab-cd` vs `…ab_cd` —— 而 `ab_cd` 的尾 8 位**本身合法**
   * （`[A-Z0-9_]*` 通过），走的是**合法分支**、堆本不带 hash ⇒ 两者分支就不同、
   * ref 天然不同，**与 hash 腿完全无关**。审计实测：把 hash 后缀整段删掉，
   * 该用例仍然 **33 passed 全绿**（守卫无牙）。
   *
   * 真会撞的是 `…ab-cd` vs `…ab.cd`：两者都不合法、剥掉 `-`/`.` 后都是
   * `AB` ⇒ **去掉 hash 就变成同一个 ref**（实测 `OPENCODE_ACCOUNT_AAAABCD`）。
   */
  it('★★ P2：两条都走归一化且剥完相同的 key，其 ref 必须不同（锁 hash 腿）', async () => {
    const { call, ctx } = harness()
    const base = `sk-${'a'.repeat(40)}`
    await call('opencode.addAccount', { apiKey: `${base}ab-cd` })
    await call('opencode.addAccount', { apiKey: `${base}ab.cd` })
    const calls = (ctx.credentials.set as never as { mock: { calls: [string, string][] } }).mock.calls
    expect(calls).toHaveLength(2)
    // 枢轴：两条 key 落到的凭据引用必须不同 —— 否则后添加的会**覆盖**前者的凭据
    expect(calls[0]![0]).not.toBe(calls[1]![0])
    // 反向自证：两者的「剥完非法字符」形态确实相同（证明这对输入真的需要 hash
    // 才能区分；若哪天归一化规则改了，这条会提醒我们这对已不再是「真撞对」）
    const stripped = (ref: string): string => ref.replace(/_[0-9A-F]{8}$/, '')
    expect(stripped(String(calls[0]![0]))).toBe(stripped(String(calls[1]![0])))
  })

  /**
   * ★★ P2（2026-10-25 审计 A1-F2 / B1）：**合法尾段**的 ref 必须逐字节不变。
   *
   * ## 为什么这条必须单独守卫
   *
   * PR 自己声明的不变量是「只在尾段不合法时归一化 ⇒ 合法尾段的 ref 逐字节
   * 不变 ⇒ 存量账号的凭据引用不动」。审计实测：把「合法分支也追加 hash」
   * 注入后，opencode 全目录 19 个 spec + backup + jet-hub-store 共
   * **21 文件 / 481 passed 全绿** —— 这条不变量**零守卫**。
   *
   * ⚠️ 严重度是 P2 而不是 P1（审计 B1 的 REFUTED）：`credentialRef` 是**池里
   * 存档的字符串**，不会被「用 key 重新算一遍」，所以存量**条目**不会被改写；
   * 破的是「新建账号的 ref 公式」，属形态漂移。但它是**公式**的守卫，成本极低，
   * 值得钉死 —— 而且它同时防住「改名后 ACCOUNT_REF_RE 识别面再缩小」。
   */
  it('★★ P2：合法尾段的 ref 公式逐字节锁定（防公式漂移）', async () => {
    const cases: Array<[string, string]> = [
      ['12345678', 'OPENCODE_ACCOUNT_12345678'],
      ['ABCDEF12', 'OPENCODE_ACCOUNT_ABCDEF12'],
      ['________', 'OPENCODE_ACCOUNT_________'],
      ['A_B_C_D_', 'OPENCODE_ACCOUNT_A_B_C_D_'],
    ]
    for (const [tail, expected] of cases) {
      const { call, ctx } = harness()
      // ⚠️ 前置条件自证：这些尾段确实走**合法分支**（否则本用例测错了分支）
      expect(/^[A-Z0-9_]*$/.test(tail.toUpperCase()), tail).toBe(true)
      await call('opencode.addAccount', { apiKey: `sk-${'a'.repeat(40)}${tail}` })
      const ref = String((ctx.credentials.set as never as { mock: { calls: [string, string][] } }).mock.calls[0]![0])
      expect(ref, tail).toBe(expected)
    }
  })

  /**
   * ★★ P2（2026-10-25 审计 A1-F14 / B1）：账号槽 id **不得伪装成匿名槽**。
   *
   * ## 缺陷
   *
   * 账号槽 id 是 `opencode-${key 尾 8 位小写}`，而「匿名通道」的判据是
   * **id 前缀** `opencode-anon-`（`src/index.ts` 的 `ensureDefaultAnonymousSlot`
   * 与客户端 `jet-hub.js` 的 `isAnonymousAccountId` 都这么判）。于是尾 8 位
   * 恰为 `anon-abc` 之类的 key 会产出 `opencode-anon-abc` ⇒
   *
   * 1. 客户端把它标成「匿名」（不计额度、走匿名文案）；
   * 2. `ensureDefaultAnonymousSlot` 以为「已经有匿名通道了」⇒ **永久跳过**
   *    创建默认匿名槽 ⇒ 零账号新用户**失去免费通道**，且零报错。
   *
   * ⚠️ 本 PR 之前这条路径**不可达**：base 的实现把尾段原样拼进 `credentialRef()`，
   * 含 `-` 的尾段会抛 TypeError ⇒ 根本进不了池。本 PR 放宽字符集后才成立
   * ⇒ 属**本 PR 新引入的可达静默功能损失**。
   */
  it('★★ P2：key 尾段形如 `anon-abc` 时，账号槽 id 不得落进匿名槽命名空间', async () => {
    const { call, pool } = harness()
    // 尾 8 位 = `anon-abc`（合法字符集内，KEY_PATTERN 会放行）
    const key = `sk-${'a'.repeat(40)}anon-abc`
    expect(key.length).toBeGreaterThan(20)
    const r = await call('opencode.addAccount', { apiKey: key })

    expect(r.ok).toBe(true)
    const entry = pool.addAccount.mock.calls[0]![0] as Record<string, unknown>
    const id = String(entry.id)
    // 枢轴：不得以匿名槽前缀开头（否则 ensureDefaultAnonymousSlot 跳过创建，
    // 客户端也会把它渲染成匿名通道）
    expect(id.startsWith('opencode-anon-')).toBe(false)
  })

  it('★★ P2：`anon-` 尾段与真实匿名槽共存时，两者 id 必须不同', async () => {
    const { call, pool } = harness()
    const r = await call('opencode.addAccount', { apiKey: `sk-${'a'.repeat(40)}anon-abc` })
    const accountId = (r.value as { accountId: string }).accountId
    const anon = await call('opencode.addAnonymous', {})
    const anonId = (anon.value as { accountId: string }).accountId
    expect(accountId).not.toBe(anonId)
    // 真实匿名槽仍必须满足自己的前缀判据（这条反向守卫防「把匿名槽也改名」）
    expect(anonId).toMatch(/^opencode-anon-[0-9a-f]{6}$/)
    expect(pool.addAccount).toHaveBeenCalledTimes(2)
  })

  it('合法 key 写入凭据 + 账号池条目', async () => {
    const { call, pool, ctx } = harness()
    const r = await call('opencode.addAccount', { apiKey: VALID_KEY, nickname: '主号' })
    expect(r.ok).toBe(true)
    expect((r.value as { existed: boolean }).existed).toBe(false)
    expect(ctx.credentials.set).toHaveBeenCalled()
    expect(pool.addAccount).toHaveBeenCalledTimes(1)
    const entry = pool.addAccount.mock.calls[0]![0] as Record<string, unknown>
    expect(entry.provider).toBe('opencode')
    expect(entry.nickname).toBe('主号')
    expect(entry.enabled).toBe(true)
    // ⚠️ 手动 key 不可续期，标 true 是不实承诺
    expect(entry.refreshable).toBe(false)
  })

  it('⚠️ 写入的凭据里指纹由 key 派生（每账号指纹独立）', async () => {
    const { call, ctx } = harness()
    await call('opencode.addAccount', { apiKey: VALID_KEY })
    const value = String((ctx.credentials.set as never as { mock: { calls: [string, string][] } }).mock.calls[0]![1])
    const cred = JSON.parse(value) as { api_key: string; fingerprint: { projectId: string; generation: number } }
    expect(cred.api_key).toBe(VALID_KEY)
    expect(cred.fingerprint.projectId).toBe(deriveProjectId(VALID_KEY, 0))
    expect(cred.fingerprint.generation).toBe(0)
  })

  it('⚠️ 凭据值里不含明文指纹以外的可推信息（只有 api_key 与派生量）', async () => {
    const { call, ctx } = harness()
    await call('opencode.addAccount', { apiKey: VALID_KEY })
    const value = String((ctx.credentials.set as never as { mock: { calls: [string, string][] } }).mock.calls[0]![1])
    expect(Object.keys(JSON.parse(value) as object).sort()).toEqual(['api_key', 'fingerprint', 'nickname'])
  })

  it('未给昵称时按 key 尾段自动命名（可区分多个账号）', async () => {
    const { call, pool } = harness()
    await call('opencode.addAccount', { apiKey: VALID_KEY })
    const entry = pool.addAccount.mock.calls[0]![0] as Record<string, unknown>
    expect(String(entry.nickname)).toContain(VALID_KEY.slice(-6))
  })

  it('重复 key 复用同一账号（不产生第二个条目）', async () => {
    const { call, pool, ctx } = harness()
    // ⚠️ 夹具必须**模拟真实**：池里那条账号是因为之前成功添加才存在的，
    //    所以它的凭据**一定读得到**且 api_key 与本次相同。旧夹具只 mock 了
    //    `listAccountsByProvider` 却不给凭据（= 「账号在、凭据缺」的坏态），
    //    那是另一个场景（见下面 P1 的两条用例），不是「重复 key 复用」。
    ctx.credentials.resolve.mockResolvedValue({ value: JSON.stringify({ api_key: VALID_KEY, nickname: '主号' }), source: 'file' })
    const first = await call('opencode.addAccount', { apiKey: VALID_KEY })
    const id = (first.value as { accountId: string }).accountId
    pool.listAccountsByProvider.mockReturnValue([{ id, enabled: true, credentialRef: 'X' }])
    const second = await call('opencode.addAccount', { apiKey: VALID_KEY })
    expect((second.value as { existed: boolean }).existed).toBe(true)
    expect(pool.addAccount).toHaveBeenCalledTimes(1)
  })

  /**
   * ★★ P1（2026-10-25 审计 B1-1）：池里有账号、**凭据却读不到**时，
   * 粘贴正确 key 必须是**修复**，不能被 `existed` 挡回去。
   *
   * ## 为什么这是 P1 而不是「无害的静默复用」
   *
   * 「账号在、凭据缺」是**产品自己能造出来的**状态：`exportBackup` 遇到凭据
   * 缺失的账号时把账号写进备份、凭据从字典里略掉（只留一条 warning），
   * 用 replace 模式导回就得到 `imported=1, credentialsImported=0`。
   * 其它来源：`.credentials.yaml` 被清理/部分损坏、第三方备份转换器、手工编辑。
   *
   * 旧实现在这里直接 `return existed:true`（源码里 `existed:true` 的下标
   * **严格早于** `credentials.set` ⇒ 是**根本没走到写**，不是写失败），于是：
   *
   * 1. 用户看到「该 key 已存在，已为你定位到原有账号」——**以为修好了**；
   * 2. 凭据一个字节都没落盘；
   * 3. 该账号在推理路径被 `parsed.api_key ?? OPENCODE.anonymousKey` 降级成
   *    匿名免费通道 ⇒ 付费 key 完全失效，而**面板卡片一切正常、零日志**；
   * 4. opencode 只有 5 个 RPC 方法、**没有** `setApiKey` ⇒ 唯一出路是
   *    「先删后加」，而用户没有任何线索指向这一步。
   *
   * ⇒ 判据：命中同 id 时**必须先确认凭据真的在**，不在就覆盖写并如实回报。
   */
  it('★★ P1：池里有同 id 但凭据读不到 ⇒ 必须写入凭据（不得被 existed 挡回）', async () => {
    const { call, pool, ctx } = harness()
    const id = `opencode-${VALID_KEY.slice(-8).toLowerCase()}`
    pool.listAccountsByProvider.mockReturnValue([{ id, enabled: true, credentialRef: 'OPENCODE_ACCOUNT_OLD' }])
    // 凭据读不到（undefined = 这条 ref 在凭据存储里不存在）
    ctx.credentials.resolve.mockResolvedValue(undefined)

    const r = await call('opencode.addAccount', { apiKey: VALID_KEY })

    expect(r.ok).toBe(true)
    // 枢轴断言 1：**必须**真的写凭据（修复前这里是 0 次）
    expect(ctx.credentials.set).toHaveBeenCalledTimes(1)
    const value = String((ctx.credentials.set as never as { mock: { calls: [string, string][] } }).mock.calls[0]![1])
    expect((JSON.parse(value) as { api_key: string }).api_key).toBe(VALID_KEY)
    // 枢轴断言 2：不得再声称「已存在」—— 那是让用户以为修好了的那句话
    expect((r.value as { existed: boolean }).existed).toBe(false)
    // 枢轴断言 3：不新增条目（否则同一把 key 会有两条账号）
    expect(pool.addAccount).not.toHaveBeenCalled()
    // 枢轴断言 4：**写进去的凭据必须落在池条目实际引用的那个 ref 上**，
    // 否则写进去没人引用（等于没修）。该 ref 本来合法 ⇒ 不需要 updateAccount；
    // 若实现改用了新 ref 却忘了纠正引用，这里的相等断言会变红。
    const writtenRef = String((ctx.credentials.set as never as { mock: { calls: [string, string][] } }).mock.calls[0]![0])
    expect(writtenRef).toBe('OPENCODE_ACCOUNT_OLD')
  })

  it('★★ P1：凭据存在但**内容损坏**（非 JSON / 缺 api_key）⇒ 同样必须修复', async () => {
    for (const broken of ['不是 JSON', '{}', JSON.stringify({ api_key: '' })]) {
      const { call, pool, ctx } = harness()
      const id = `opencode-${VALID_KEY.slice(-8).toLowerCase()}`
      pool.listAccountsByProvider.mockReturnValue([{ id, enabled: true, credentialRef: 'OPENCODE_ACCOUNT_OLD' }])
      ctx.credentials.resolve.mockResolvedValue({ value: broken, source: 'file' })

      const r = await call('opencode.addAccount', { apiKey: VALID_KEY })

      expect(r.ok, broken).toBe(true)
      expect(ctx.credentials.set, broken).toHaveBeenCalledTimes(1)
      expect((r.value as { existed: boolean }).existed, broken).toBe(false)
    }
  })

  it('⚠️ 反向对照：凭据完好且 api_key 不同 ⇒ 仍按「已存在」复用，**不覆盖**别人的凭据', async () => {
    // 这条防「凡命中就覆盖写」的过度修复：同尾段但**不同 key** 时，
    // 覆盖会给那个账号换成另一把 key（用户以为在加新号，实际改掉了旧号）。
    const { call, pool, ctx } = harness()
    const id = `opencode-${VALID_KEY.slice(-8).toLowerCase()}`
    pool.listAccountsByProvider.mockReturnValue([{ id, enabled: true, credentialRef: 'OPENCODE_ACCOUNT_OLD' }])
    ctx.credentials.resolve.mockResolvedValue({ value: JSON.stringify({ api_key: `sk-${'b'.repeat(48)}` }), source: 'file' })

    const r = await call('opencode.addAccount', { apiKey: VALID_KEY })

    expect((r.value as { existed: boolean }).existed).toBe(true)
    expect(ctx.credentials.set).not.toHaveBeenCalled()
  })
})

describe('opencode.addAnonymous', () => {
  it('创建一条 api_key = public 的池条目', async () => {
    const { call, pool, ctx } = harness()
    const r = await call('opencode.addAnonymous', {})
    expect(r.ok).toBe(true)
    expect(pool.addAccount).toHaveBeenCalledTimes(1)
    const entry = pool.addAccount.mock.calls[0]![0] as Record<string, unknown>
    expect(entry.provider).toBe('opencode')
    expect(String(entry.id)).toMatch(/^opencode-anon-[0-9a-f]{6}$/)
    const value = String((ctx.credentials.set as never as { mock: { calls: [string, string][] } }).mock.calls[0]![1])
    expect(JSON.parse(value).api_key).toBe('public')
  })

  it('⚠️ 昵称自动编号（用户可不填）', async () => {
    const { call, pool } = harness()
    await call('opencode.addAnonymous', {})
    const entry = pool.addAccount.mock.calls[0]![0] as Record<string, unknown>
    expect(String(entry.nickname)).toBe('匿名通道 1')
  })

  it('可指定昵称', async () => {
    const { call, pool } = harness()
    await call('opencode.addAnonymous', { nickname: '香港出口' })
    const entry = pool.addAccount.mock.calls[0]![0] as Record<string, unknown>
    expect(entry.nickname).toBe('香港出口')
  })

  it('⚠️ 每次调用创建新条目（不覆盖既有匿名通道）', async () => {
    const { call, pool } = harness()
    await call('opencode.addAnonymous', {})
    await call('opencode.addAnonymous', {})
    expect(pool.addAccount).toHaveBeenCalledTimes(2)
    const ids = pool.addAccount.mock.calls.map((c) => (c[0] as { id: string }).id)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('opencode.setProxy', () => {
  it('合法代理归一后写入账号池', async () => {
    const { call, pool } = harness()
    const r = await call('opencode.setProxy', { accountId: 'opencode-a', proxy: '127.0.0.1:7897' })
    expect(r.ok).toBe(true)
    expect(pool.setOpencodeProxy).toHaveBeenCalledWith('opencode-a', 'http://127.0.0.1:7897')
  })

  it('socks5 归一后写入', async () => {
    const { call, pool } = harness()
    await call('opencode.setProxy', { accountId: 'opencode-a', proxy: 'socks5h://127.0.0.1:1080' })
    expect(pool.setOpencodeProxy).toHaveBeenCalledWith('opencode-a', 'socks5://127.0.0.1:1080')
  })

  it('⚠️ 空串 = 清除代理（回到同 IP 策略），label 说明直连', async () => {
    const { call, pool } = harness()
    const r = await call('opencode.setProxy', { accountId: 'opencode-a', proxy: '  ' })
    expect(r.ok).toBe(true)
    expect(pool.setOpencodeProxy).toHaveBeenCalledWith('opencode-a', '')
    expect((r.value as { label: string }).label).toContain('直连')
  })

  it('非法代理返回可读中文理由且不写池', async () => {
    const { call, pool } = harness()
    const r = await call('opencode.setProxy', { accountId: 'opencode-a', proxy: 'vmess://x' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('不支持')
    expect(pool.setOpencodeProxy).not.toHaveBeenCalled()
  })

  it('accountId 缺失拒绝', async () => {
    const { call } = harness()
    expect((await call('opencode.setProxy', { proxy: 'http://1.2.3.4:8080' })).ok).toBe(false)
  })

  it('⚠️ 回显的 label 对密码脱敏（不回显明文口令）', async () => {
    const { call } = harness()
    const r = await call('opencode.setProxy', { accountId: 'opencode-a', proxy: 'http://u:secret@1.2.3.4:8080' })
    expect((r.value as { label: string }).label).not.toContain('secret')
  })
})

describe('opencode.testProxy', () => {
  it('经代理查出出口 IP 并返回', async () => {
    const { call } = harness()
    const stub = vi.fn(async () => new Response(JSON.stringify({ status: 'success', query: '1.2.3.4', country: 'US' }), { status: 200 }))
    undiciFetchSpy.mockImplementation(stub as never)
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:7897' })
    expect(r.ok).toBe(true)
    expect((r.value as { exitIp: string }).exitIp).toBe('1.2.3.4')
    expect((r.value as { country: string }).country).toBe('US')
    // ⚠️ 断言的仍是**生产不变式**：有代理时必须带上与 fetch 同源的 dispatcher。
    expect(stub.mock.calls[0]![1]).toHaveProperty('dispatcher')
  })

  it('⚠️ 代理路径用的是 undici 自带的 fetch（不是全局 fetch）', async () => {
    // 这条锁死缺陷 IKK4BY 的修法：全局 fetch + 外部 dispatcher 会在
    // Node 22/24 上恒抛 UND_ERR_INVALID_ARG（跨实例 handler 契约冲突）。
    const { call } = harness()
    const globalSpy = vi.fn(async () => new Response('不该被调用', { status: 200 }))
    vi.stubGlobal('fetch', globalSpy as never)
    undiciFetchSpy.mockImplementation(
      (async () => new Response(JSON.stringify({ status: 'success', query: '9.9.9.9' }), { status: 200 })) as never,
    )
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:7897' })
    expect(r.ok).toBe(true)
    expect(globalSpy).not.toHaveBeenCalled()
  })

  it('非法代理直接拒绝（不发请求）', async () => {
    const { call } = harness()
    const stub = vi.fn()
    vi.stubGlobal('fetch', stub as never)
    expect((await call('opencode.testProxy', { proxy: 'ftp://x' })).ok).toBe(false)
    expect(stub).not.toHaveBeenCalled()
  })

  it('代理返回非 2xx 时给出可读失败', async () => {
    const { call } = harness()
    undiciFetchSpy.mockImplementation((async () => new Response('nope', { status: 502 })) as never)
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:7897' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('502')
  })

  it('连接抛错时给出可读失败（不把底层异常抛给 UI）', async () => {
    const { call } = harness()
    undiciFetchSpy.mockImplementation((async () => { throw new Error('ECONNREFUSED') }) as never)
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:7897' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('ECONNREFUSED')
  })

  it('⚠️ `fetch failed` 的根因在 cause 里，必须带出来（issue IKK4BY 第 2 点）', async () => {
    // Node 的 fetch 在传输层失败时 message 恒为 `fetch failed`，真因只在 cause。
    // 只取 message 会让所有故障退化成同一句无信息量的话。
    const { call } = harness()
    const cause = Object.assign(new Error('invalid onRequestStart method'), { code: 'UND_ERR_INVALID_ARG' })
    const failure = Object.assign(new TypeError('fetch failed'), { cause })
    undiciFetchSpy.mockImplementation((async () => { throw failure }) as never)
    const r = await call('opencode.testProxy', { proxy: '127.0.0.1:7897' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('invalid onRequestStart method')
    expect(r.error?.message).toContain('UND_ERR_INVALID_ARG')
  })
})

describe('opencode.rotateFingerprint', () => {
  it('代次 +1 并写回账号池', async () => {
    const { call, pool } = harness()
    pool.opencodeFingerprintGenerationFor.mockReturnValue(2)
    const r = await call('opencode.rotateFingerprint', { accountId: 'opencode-a' })
    expect(r.ok).toBe(true)
    expect((r.value as { generation: number }).generation).toBe(3)
    expect(pool.updateOpencodeFingerprintGeneration).toHaveBeenCalledWith('opencode-a', 3)
  })

  it('从 0 起轮换得到 1', async () => {
    const { call, pool } = harness()
    const r = await call('opencode.rotateFingerprint', { accountId: 'opencode-a' })
    expect((r.value as { generation: number }).generation).toBe(1)
    expect(pool.updateOpencodeFingerprintGeneration).toHaveBeenCalledWith('opencode-a', 1)
  })

  it('accountId 缺失拒绝', async () => {
    const { call } = harness()
    expect((await call('opencode.rotateFingerprint', {})).ok).toBe(false)
  })
})

describe('未知方法', () => {
  it('⚠️ 返回 undefined 而不是错误信封（2026-10-02 语义变更）', async () => {
    // 旧实现回 {ok:false, '未知方法 X'}，那会**抢走**别的 provider 的方法名 ——
    // 主 switch 拿不到 undefined 就无法继续匹配。现交回 undefined，由主 switch
    // 自己的 default 给出 `unknown method`（归属更准确）。
    const { call } = harness()
    expect(await call('opencode.nope', {})).toBeUndefined()
  })
})
