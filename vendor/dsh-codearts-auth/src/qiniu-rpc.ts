/**
 * qiniu 专用 RPC 的**方法处理函数**（不是自注册端点）。
 *
 * ## ⚠️⚠️ 为什么是「被主 switch 调用」而不是「自己注册」
 *
 * 这一条是 opencode 用真实事故换来的（`src/opencode-rpc.ts` 模块头有完整记录）：
 * 它最初在这里调 `rpc.register('jet-hub', handler)`，以为能与 `jet-hub-rpc.ts`
 * 并存。真机报障：
 *
 * ```
 * 添加失败：unknown method: opencode.addAnonymous
 * ```
 *
 * 根因：**Jet Hub 只有一条通道** —— `jet-hub-rpc.ts` 的
 * `connection.fetch.register({ path: JET_HUB_API_PATH })`，它把 `call.method`
 * 交给一个穷举 `switch`，`default` 分支直接回 `unknown method` 且**不让路**。
 *
 * ⇒ 本文件只导出 {@link handleQiniuRpc}，由 `jet-hub-rpc.ts` 的
 * `handleMethod` 在 `default` **之前**调用（对不认识的方法返回 `undefined`，
 * 让主 switch 继续匹配）。
 *
 * ## 为什么 qiniu 需要自己的方法（而不是复用 account.create）
 *
 * 七牛云的凭据是用户**手工粘贴的 API Key**，没有 OAuth 授权页 ⇒ `account.create`
 * 那条「先返回 loginUrl、后台等回调」的两步式路径对它**根本不适用**。
 * 本插件已有先例（opencode）：前端在最前面改道，直接调 provider 自己的
 * addAccount 方法。**这是本仓库第二家不跳浏览器的 provider。**
 *
 * 与 opencode 的差异（都来自协议事实，不是风格）：
 *
 * | | opencode | qiniu |
 * |---|---|---|
 * | 凭据字段 | `api_key` | `access_token`（AccountPool 身份反查要求，见 `qiniu.ts` 模块头） |
 * | 账号去重 | 按 key 尾段派生 id（同 key 复用） | 同左 |
 * | 失效模式 | 形状校验 `[A-Za-z0-9_.-]{20,}`（原 `sk-`，2026-10-22 起上游也发 `oc_sk_…`） | 形状校验 `[A-Za-z0-9_.-]{16,}`（**不绑死前缀**，理由同左） |
 * | 匿名槽 | 有（字面量 `public`） | **没有** —— 七牛云必须持 Key 才能调用 |
 *
 * @module src/qiniu-rpc.ts
 */

import { createHash } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { ProviderAccountEntry } from './types.js'
import { QINIU } from './qiniu-product.js'
import { parseQiniuCredential } from './qiniu-auth.js'
import { maskQiniuKey } from './qiniu.js'

export interface RpcQiniuAddAccountRequest {
  apiKey: string
  nickname?: string
}

export interface RpcQiniuAddAccountResponse {
  accountId: string
  /** true = 该 Key 之前已添加过，本次只是复用。 */
  existed: boolean
}

export interface RpcQiniuSetApiKeyRequest {
  accountId: string
  apiKey: string
}

export interface RpcQiniuSetApiKeyResponse {
  accountId: string
  /** 打码后的新 Key（`前4…尾4`）—— **刻意不回传明文**，理由见方法实现。 */
  masked: string
  /**
   * true = Key 变了 ⇒ 账号 id 也随尾段变了，账号被**重建**在新的 id 下。
   * ⚠️ 客户端据此必须**关闭并重开**面板（旧的 id 已不存在）。
   */
  renamed: boolean
}

/** 账号池的最小依赖面（结构化类型，避免绑定具体类）。 */
export interface QiniuPoolLike {
  listAccountsByProvider(provider: string): Array<{ id: string; enabled: boolean; credentialRef: string; nickname?: string }>
  // ⚠️ 入参用 `ProviderAccountEntry`（而不是 `Record<string, unknown>`）：
  // 后者与 `AccountPool.addAccount(entry: ProviderAccountEntry)` **不可赋值**
  // （参数逆变，tsc 直接报 TS2345），接线处就得写断言或 any。
  addAccount(entry: ProviderAccountEntry): Promise<void>
  /** 改 Key 时要移除**旧**账号（id 随尾段变）—— 见 {@link RpcQiniuSetApiKeyResponse.renamed}。 */
  removeAccount(accountId: string): Promise<void>
}

/**
 * Key 形状：至少 16 位 `[A-Za-z0-9_.-]`，**不绑死前缀**。
 *
 * ⚠️ 这只是**形状**校验（挡手滑/占位符），**不是**有效性验证：
 * 真 Key 仍要等第一次真实请求才知道。
 *
 * 官方依据：七牛云《批量创建API Key》文档明示 Key「以 `sk-` 开头」，长度与
 * 字符集未给约束。故判据取与上游命名无关的共性形状，**不写死 `^sk-`** ——
 * 本仓库 opencode 的 Issue IKPLRU 实测过绑死前缀的代价（上游换发 `oc_sk_…`
 * 后旧闸门把新 Key 全数拒收，用户一个账号都加不进来，且完全无法自救）。
 */
const KEY_PATTERN = /^[A-Za-z0-9_.-]{16,}$/

/**
 * 账号 id / credentialRef 由 Key 尾段派生，使重复 Key 落到同一账号。
 *
 * ⚠️⚠️ **ref 名必须是合法标识符**（2026-10-29 审计 P1）：宿主的
 * `credentialRef()` 只认 `/^[A-Za-z_][A-Za-z0-9_]*$/`（见
 * `node_modules/@deepseek-ai/dsh-credentials` 的 `REF_PATTERN`），而本家的
 * Key 形状闸放行 `[A-Za-z0-9_.-]`（**刻意不绑死前缀**，见 `KEY_PATTERN`）⇒
 * 末 8 位含 `.`/`-` 的 Key 会把 `QINIU_ACCOUNT_` 拼成 `QINIU_ACCOUNT_BBB-CCDD`，
 * 这个串一进 `credentialRef()` 就 **抛 TypeError**：
 *
 * ```text
 * credential ref "QINIU_ACCOUNT_BBB-CCDD" must match /^[A-Za-z_][A-Za-z0-9_]*$/
 * ```
 *
 * 后果是「任何末 8 位带连字符/点的 Key 都加不进账号」，用户看到一句英文正则 ——
 * 与 opencode 的 Issue IKPLRU 同型（形状闸放宽后派生侧没跟上），故修法照抄
 * `src/opencode-rpc.ts:208-221`：
 *
 * - **尾段本来就合法** ⇒ 逐字节不变（保护存量凭据引用，否则老账号会被当成新账号）；
 * - **尾段不合法** ⇒ 剥掉非标识符字符 + 追加 key 的 sha256 前 8 位，
 *   使 `…bb-ccdd` 与 `…bb_ccdd` 不会撞成同一个 ref（撞了会后者覆盖前者凭据）。
 */
export function qiniuSlotNamesOf(apiKey: string): { id: string; refName: string } {
  const tail = apiKey.slice(-8)
  const upper = tail.toUpperCase()
  // ⚠️ 前缀必须是 `QINIU` —— `jet-hub-store.ts` 的
  // `REF_PREFIX_TO_PROVIDER` 按它反推 provider，漏登记会让
  // `QINIU_ACCOUNT_*` 的账号在 `state.json` 缺失时**静默消失**。
  const refName = /^[A-Z0-9_]*$/.test(upper)
    ? `QINIU_ACCOUNT_${upper}`
    : `QINIU_ACCOUNT_${upper.replace(/[^A-Z0-9_]/g, '')}_${createHash('sha256').update(apiKey).digest('hex').slice(0, 8).toUpperCase()}`
  return { id: `${QINIU.id}-${tail.toLowerCase()}`, refName }
}

/**
 * 处理一个 qiniu RPC 方法。
 *
 * @returns `{ok:true, value}` / `{ok:false, error}`；**方法不认识时返回
 *          `undefined`**，让主 switch 继续往下走（它自己的 `default`
 *          分支仍能给出 `unknown method`，语义归属清晰）。
 *
 * ⚠️ 不认识时**必须**返回 `undefined` 而不是 `{ok:false}`：主 switch 会在
 * `default` 之前调用本函数，若本函数对未知方法也回信封，别的 provider 的
 * 方法名就会被误判成「格式错误」而不是「没这个方法」。
 */
export async function handleQiniuRpc(
  ctx: Context,
  pool: QiniuPoolLike,
  method: string,
  payload: unknown,
): Promise<unknown> {
  const fail = (message: string) => ({ ok: false as const, error: { code: 'bad-request', message } })
  const done = <T>(value: T) => ({ ok: true as const, value })
  try {
    switch (method) {
      case 'qiniu.addAccount': {
        const req = (payload ?? {}) as RpcQiniuAddAccountRequest
        const apiKey = typeof req.apiKey === 'string' ? req.apiKey.trim() : ''
        if (!KEY_PATTERN.test(apiKey)) {
          return fail(
            'API Key 形状不对（通常以 sk- 开头、至少 16 位；'
            + '可在 https://portal.qiniu.com/ai-inference/api-key 创建）',
          )
        }
        const { id, refName } = qiniuSlotNamesOf(apiKey)
        // ⚠️ 重复 Key 必须**复用**同一账号：同 Key 加两次会让用户误以为是
        // 两个独立额度桶，实际请求仍会打到同一份额度上（并在限额时一起被跳过）。
        if (pool.listAccountsByProvider(QINIU.id).some((a) => a.id === id)) {
          return done({ accountId: id, existed: true } satisfies RpcQiniuAddAccountResponse)
        }
        const nickname = typeof req.nickname === 'string' && req.nickname.trim().length > 0
          ? req.nickname.trim()
          : `Qiniu ${apiKey.slice(-6)}`
        await ctx.credentials.set(credentialRef(refName), JSON.stringify({
          // ⚠️ 字段名必须是 `access_token`（AccountPool 身份反查用，见 qiniu.ts）。
          access_token: apiKey,
          nickname,
        }))
        await pool.addAccount({
          id,
          provider: QINIU.id,
          nickname,
          enabled: true,
          credentialRef: refName,
          // ⚠️ 七牛云**没有 refresh 端点**（API Key 是静态材料，默认长期有效），
          // 标 true 会让 UI 显示「可自动续期」——一个永远不会发生的承诺。
          refreshable: false,
          createdAt: Date.now(),
        })
        return done({ accountId: id, existed: false } satisfies RpcQiniuAddAccountResponse)
      }

      case 'qiniu.setApiKey': {
        const req = (payload ?? {}) as RpcQiniuSetApiKeyRequest
        if (typeof req.accountId !== 'string' || req.accountId.length === 0) {
          return fail('缺少 accountId')
        }
        const apiKey = typeof req.apiKey === 'string' ? req.apiKey.trim() : ''
        if (!KEY_PATTERN.test(apiKey)) {
          return fail(
            'API Key 形状不对（通常以 sk- 开头、至少 16 位；'
            + '可在 https://portal.qiniu.com/ai-inference/api-key 创建）',
          )
        }
        const old = pool.listAccountsByProvider(QINIU.id).find((a) => a.id === req.accountId)
        if (!old) return fail(`未找到账号 ${req.accountId}`)

        const { id, refName } = qiniuSlotNamesOf(apiKey)
        if (id === req.accountId) {
          // ⚠️ 同一条 Key：只刷新凭据内容，**不动**账号（否则会先删后建、
          //    期间面板上的这条账号会短暂消失，用户可能重复点击）。
          await ctx.credentials.set(credentialRef(refName), JSON.stringify({
            access_token: apiKey,
            // ⚠️ 昵称**沿用旧的**：改 Key 不该顺手把用户起的名字冲掉。
            nickname: typeof old.nickname === 'string' && old.nickname.length > 0
              ? old.nickname
              : `Qiniu ${apiKey.slice(-6)}`,
          }))
          return done({ accountId: id, masked: maskQiniuKey(apiKey), renamed: false } satisfies RpcQiniuSetApiKeyResponse)
        }

        // ⚠️⚠️ **Key 变了 ⇒ 账号 id 随尾段变**（`id` 由 Key 尾 8 位派生，见
        //    `qiniuSlotNamesOf`）⇒ 这不是「改一个字段」，而是**换一条账号**。
        //    必须显式新建 + 移除旧的，否则会出现两个账号共用一份凭据的错象。
        //    ⚠️ 顺序刻意是「先建后删」：反过来的话，若新建失败（磁盘/权限）
        //    用户就**连旧账号一起丢了** —— 删除不可逆（本仓库记过多起同类事故）。
        const target = pool.listAccountsByProvider(QINIU.id).find((a) => a.id === id)
        if (target) {
          return fail(`该 API Key 已对应另一个账号（${id}），请直接编辑那个账号，避免同一 Key 出现两次`)
        }
        await ctx.credentials.set(credentialRef(refName), JSON.stringify({
          access_token: apiKey,
          // ⚠️ 昵称**继承旧的**（含用户手改过的），别让改 Key 顺手改名。
          nickname: typeof old.nickname === 'string' && old.nickname.length > 0
            ? old.nickname
            : `Qiniu ${apiKey.slice(-6)}`,
        }))
        await pool.addAccount({
          id,
          provider: QINIU.id,
          nickname: typeof old.nickname === 'string' && old.nickname.length > 0
            ? old.nickname
            : `Qiniu ${apiKey.slice(-6)}`,
          // ⚠️ 停用状态**继承**旧的：用户特意关掉的账号不该被改 Key 顺手启用。
          enabled: old.enabled,
          credentialRef: refName,
          // ⚠️ 同 `addAccount`：静态 API Key，没有 refresh 端点 ⇒ 诚实记 false。
          refreshable: false,
          createdAt: Date.now(),
        })
        await pool.removeAccount(req.accountId)
        return done({ accountId: id, masked: maskQiniuKey(apiKey), renamed: true } satisfies RpcQiniuSetApiKeyResponse)
      }

      default:
        // ⚠️ 返回 `undefined`（不是错误信封）：方法不属于 qiniu，
        // 让主 switch 继续匹配 —— 它自己的 `default` 会给出
        // `unknown method`，那才是准确的归属。
        return undefined
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** 供单测用：判断一个 ref 是否是本 provider 的账号 ref。 */
export function isQiniuAccountRef(ref: string): boolean {
  return /^QINIU_ACCOUNT_[0-9A-Za-z]+$/.test(ref)
}

export { parseQiniuCredential }
