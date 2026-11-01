/**
 * ★★ **AStudio 的黑名单与「供应商整体关闭」必须真的生效**（Gitee issue IKP8OF 的审计副产物）。
 *
 * ## 为什么需要本文件
 *
 * `ikp8of-provider-closed.spec.ts` 里有一条**派生式普查**：
 * 「每处 `createModelCatalog` 的 deps 段里必须出现 `accountPool`」。
 * 它是**源码文本判据**，而本仓库已多次实测过这类判据的弱点。本轮实测：
 *
 * | 注入的变异（`src/astudio-adapter.ts`） | 该普查的判定 |
 * |---|---|
 * | 把整个 deps 改成 `{}` | ✅ 变红（能抓到） |
 * | 改成 `{ accountPool: undefined as unknown as AccountPool }` | ❌ **18 条全绿** |
 *
 * 第二种正是**最像重构**的回归形态，而它的用户后果与彻底删掉完全一致
 * （`?.` 让缺失变成静默 no-op）。⇒ 判据必须打在**行为**上。
 *
 * ## 本文件测什么
 *
 * 用**真实的 `AccountPool`** + **真实的 `AstudioAdapter`**，只翻转「用户关了
 * 这个模型 / 关了整个供应商」这一个变量，断言 `listModels` 的返回值：
 *
 * - 关闭单个模型 ⇒ 该模型消失、其余仍在（防「返回值恒空」的假绿）；
 * - 关闭整个供应商 ⇒ 全空；
 * - **目录变长之后**仍全空（意图与目录快照无关 —— 这正是 IKP8OF 的形态）。
 *
 * ⚠️ 每条都带**对照组**（未关闭时必须非空），否则空数组断言恒真。
 */
import { describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { AstudioAdapter } from '../../src/astudio-adapter.js'
import { ASTUDIO } from '../../src/astudio-product.js'
import type { AstudioCatalogModel, AstudioCredential } from '../../src/astudio.js'

/**
 * 造一个真实 `AccountPool`（`stored` 就是"磁盘"，整体替换语义与生产一致）。
 *
 * ⚠️⚠️ **必须带一个「已登录账号」**：`createModelCatalog` 的 `listModels` 第一道
 * 门控是 `providerCatalogVisible`（`DSH_HIDE_MODELS_WITHOUT_ACCOUNT` **默认开启**）
 * ⇒ 没有可解析凭据的账号时它直接返回 `[]`。第一版本文件就漏了这一点，
 * 三条用例红在「对照组目录本就为空」（那是**另一条**返回 `[]` 的路径，
 * 与黑名单无关 —— 正是本仓库记录过的假绿形态）。
 *
 * ⇒ 这里同时给账号条目与可解析的凭据，让门控通过；判据才只受黑名单影响。
 */
function makePool(stored: Record<string, unknown> = {
  accounts: [{
    id: 'astudio-1',
    provider: 'astudio',
    nickname: 'a1',
    enabled: true,
    credentialRef: 'ASTUDIO_ACCOUNT_1',
    createdAt: 1,
    refreshable: true,
  }],
  disabledModels: {},
}): AccountPool {
  return new AccountPool({
    get: (key: string) => key === 'settings'
      ? {
          register: () => ({
            get: () => stored,
            replace: async (value: Record<string, unknown>) => {
              for (const k of Object.keys(stored)) delete stored[k]
              Object.assign(stored, value)
            },
          }),
        }
      : undefined,
    logger: { warn: () => {}, info: () => {} },
    credentials: {
      describe: async () => ({ configured: true, writable: true }),
      // ★ 门控（`hasLoggedInAccount` → `resolveCredentialByRef`）要求能解析出凭据。
      // ⚠️⚠️ 返回形状是 `{ value: <JSON 字符串> }`，**不是**裸对象 ——
      //    `AccountPool.resolveCredentialByRef` 会 `JSON.parse(resolved.value)`。
      //    第一版给了裸对象 ⇒ `resolved.value` 是 undefined ⇒ parse 抛错被 catch
      //    吞成 undefined ⇒ `hasLoggedInAccount` 恒 false ⇒ 门控直接返回 `[]`。
      //    （这就是本目录里反复记录的「假绿形态」的镜像：对照组先红了，说明判据
      //     打在**另一条**返回 `[]` 的路径上。）
      resolve: async (ref: string | { id?: string }) => {
        const id = typeof ref === 'string' ? ref : ref?.id
        return id === 'ASTUDIO_ACCOUNT_1'
          ? { value: JSON.stringify({ access_token: 'stub' }) }
          : undefined
      },
      set: async () => {},
      unset: async () => {},
    },
  } as never)
}

function remoteModel(id: string): AstudioCatalogModel {
  return {
    id,
    name: id.toUpperCase(),
    visibility: 'list',
    contextWindow: 200_000,
    maxTokens: 64_000,
    inputModalities: ['text'],
  } as AstudioCatalogModel
}

/**
 * 造一个接上了**真实 accountPool** 的适配器。
 *
 * ⚠️ `remote` 是**可变数组**：调用方可以往里 push，模拟「目录在关闭之后继续变长」。
 */
function makeAdapter(pool: AccountPool, remote: AstudioCatalogModel[]): AstudioAdapter {
  return new AstudioAdapter({
    product: ASTUDIO,
    accountPool: pool,
    resolveCredential: async () => ({ access_token: 'stub' }) as AstudioCredential,
    fetchRemoteModels: async () => remote,
  })
}

describe('★★ AStudio：模型级黑名单必须真的过滤（行为判据，替代源码文本判据）', () => {
  it('★★ 关闭单个模型 ⇒ 它从 listModels 消失，其余仍在', async () => {
    const pool = makePool()
    const remote = [remoteModel('m-a'), remoteModel('m-b'), remoteModel('m-c')]
    const adapter = makeAdapter(pool, remote)

    // ★ 对照组：未关闭时必须非空（否则下面的断言恒真）。
    const open = await adapter.listModels('astudio')
    expect(open.map((m) => m.id), '对照失败：目录本就为空 ⇒ 本用例会假绿')
      .toEqual(['m-a', 'm-b', 'm-c'])

    await pool.setModelDisabled('astudio', 'm-b', true)

    const listed = await adapter.listModels('astudio')
    expect(
      listed.map((m) => m.id),
      '★★ 用户关掉的模型仍出现在选项里 ⇒ 黑名单对 astudio 静默失效'
      + '（deps 里 `accountPool` 缺失或为 undefined 时 `?.` 会静默跳过）',
    ).toEqual(['m-a', 'm-c'])
  })

  it('★★ 关闭整个供应商 ⇒ listModels 恒空', async () => {
    const pool = makePool()
    const remote = [remoteModel('m-a'), remoteModel('m-b')]
    const adapter = makeAdapter(pool, remote)

    expect((await adapter.listModels('astudio')).length, '对照失败：目录本就为空').toBe(2)

    await pool.setProviderClosed('astudio', true)

    expect(
      await adapter.listModels('astudio'),
      '★★ 关闭整个供应商后 astudio 仍播出模型 ⇒ 模型选择器里照样能选（本 issue 的形态）',
    ).toEqual([])
  })

  /**
   * ★★ **目录变长之后**仍必须全空 —— 这是 IKP8OF 的核心判据。
   *
   * 关闭时只把**当时目录**写进黑名单（此处连黑名单都没有：走的是「意图」腿）；
   * 目录随后变长（上游上线新模型 / 远端目录从兜底表恢复）⇒ 新 id 不在黑名单里
   * ⇒ 若只判黑名单，它们**仍可选**。
   */
  it('★★ 关闭整个供应商后目录变长 ⇒ 新模型也不得可选', async () => {
    const pool = makePool()
    const remote = [remoteModel('m-a'), remoteModel('m-b')]
    const adapter = makeAdapter(pool, remote)
    await adapter.listModels('astudio') // 让目录落地

    await pool.setProviderClosed('astudio', true)

    // ★ 目录变长 + 强制重读（模拟后台刷新器 / 用户点「同步模型」）。
    remote.push(remoteModel('late-1'), remoteModel('late-2'))
    await adapter.refresh()

    expect(
      await adapter.listModels('astudio'),
      '★★ 目录变长后新模型仍可选 ⇒ 关闭不持久（IKP8OF 的原症状）',
    ).toEqual([])
  })

  it('★ 反向：重新打开供应商 ⇒ 模型恢复可选（不是死状态）', async () => {
    const pool = makePool()
    const remote = [remoteModel('m-a'), remoteModel('m-b')]
    const adapter = makeAdapter(pool, remote)
    await pool.setProviderClosed('astudio', true)
    await pool.setProviderClosed('astudio', false)

    const listed = await adapter.listModels('astudio')
    expect(listed.map((m) => m.id), '★ 打开后模型必须恢复').toEqual(['m-a', 'm-b'])
  })

  /**
   * ★★ **持久化**：换一个实例（= 重启 DSH）后关闭意图仍生效。
   *
   * ⚠️ 用**同一份 `stored`** 造第二个池，与生产「重启后读 state.json」同形。
   *    这条守的是「意图没落盘」——只测同一实例内的行为抓不到它。
   */
  it('★★ 重启（新池 + 新适配器，同一份落盘）后仍不得播出模型', async () => {
    // ⚠️ 必须带已登录账号（门控见  的说明）。
    const stored: Record<string, unknown> = {
      accounts: [{
        id: 'astudio-1', provider: 'astudio', nickname: 'a1', enabled: true,
        credentialRef: 'ASTUDIO_ACCOUNT_1', createdAt: 1, refreshable: true,
      }],
      disabledModels: {},
    }
    const before = makePool(stored)
    const remote = [remoteModel('m-a')]
    await makeAdapter(before, remote).listModels('astudio')
    await before.setProviderClosed('astudio', true)
    expect(stored.providerClosed, '★ 意图必须真的落盘').toEqual({ astudio: true })

    const restarted = makePool(stored)
    const listed = await makeAdapter(restarted, remote).listModels('astudio')
    expect(
      listed,
      '★★ 重启后意图丢失 ⇒ 关闭不持久（目录一变长就翻回「已打开」）',
    ).toEqual([])
  })
})
