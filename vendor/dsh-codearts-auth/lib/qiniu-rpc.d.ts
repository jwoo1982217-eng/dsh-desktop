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
import type { Context } from '@deepseek-ai/cordis';
import type { ProviderAccountEntry } from './types.js';
import { parseQiniuCredential } from './qiniu-auth.js';
export interface RpcQiniuAddAccountRequest {
    apiKey: string;
    nickname?: string;
}
export interface RpcQiniuAddAccountResponse {
    accountId: string;
    /** true = 该 Key 之前已添加过，本次只是复用。 */
    existed: boolean;
}
export interface RpcQiniuSetApiKeyRequest {
    accountId: string;
    apiKey: string;
}
export interface RpcQiniuSetApiKeyResponse {
    accountId: string;
    /** 打码后的新 Key（`前4…尾4`）—— **刻意不回传明文**，理由见方法实现。 */
    masked: string;
    /**
     * true = Key 变了 ⇒ 账号 id 也随尾段变了，账号被**重建**在新的 id 下。
     * ⚠️ 客户端据此必须**关闭并重开**面板（旧的 id 已不存在）。
     */
    renamed: boolean;
}
/** 账号池的最小依赖面（结构化类型，避免绑定具体类）。 */
export interface QiniuPoolLike {
    listAccountsByProvider(provider: string): Array<{
        id: string;
        enabled: boolean;
        credentialRef: string;
        nickname?: string;
    }>;
    addAccount(entry: ProviderAccountEntry): Promise<void>;
    /** 改 Key 时要移除**旧**账号（id 随尾段变）—— 见 {@link RpcQiniuSetApiKeyResponse.renamed}。 */
    removeAccount(accountId: string): Promise<void>;
}
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
export declare function qiniuSlotNamesOf(apiKey: string): {
    id: string;
    refName: string;
};
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
export declare function handleQiniuRpc(ctx: Context, pool: QiniuPoolLike, method: string, payload: unknown): Promise<unknown>;
/** 供单测用：判断一个 ref 是否是本 provider 的账号 ref。 */
export declare function isQiniuAccountRef(ref: string): boolean;
export { parseQiniuCredential };
//# sourceMappingURL=qiniu-rpc.d.ts.map