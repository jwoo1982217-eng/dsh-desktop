/**
 * MiniMax / MiniMax 国际版的**同账号去重**（2026-10-25 合并审计补修）。
 *
 * ## 为什么单独成模块
 *
 * `jet-hub-rpc.ts` 里那段去重原本只有「查重 + 把新卡停用」一件，而同一语义在
 * `officeace` 分支是**三件套 + 一个反转腿**（见该分支的注释与 2026-10-17 的 P2）。
 * minimax 只搬了第 1 件 ⇒ 实测出两个后果：
 *
 * 1. **原卡被用户手动停用时，两张卡全停用** ⇒ `getAvailableAccount()` 返回
 *    `null`（它按 `enabled` 过滤，`account-pool.ts` 的 `:2314`），而
 *    `login.poll` 仍报「登录成功」⇒ 用户以为登好了，实际该渠道**零可用号**
 *    （若它是唯一账号，模型选择器还会因门控整组消失）。
 *    这与 officeace 2026-10-17 修的 P2 **逐字同形**。
 * 2. **新 token 停在停用卡、旧 token 留在启用卡**，且续期调度器**刻意不看
 *    `enabled`**（`index.ts` 的既有约定）⇒ 同一个上游账号挂**两条续期链**。
 *    MiniMax 的 refresh_token 是轮换式的（本仓库 `jet-hub-rpc.ts` 既有注释记载）
 *    ⇒ 两条链互相作废，症状正是本 PR 要治的「旧的那条掉登录」。
 *
 * ## 三条不变量（与 officeace 逐格同构，判据必须能各自被抓到）
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 命中重复时**不删条目**，只标停用 + 改名 | 删掉会让 `login.poll` 把「登录成功」显示成失败 |
 * | 2 | 新鲜凭据必须**转到保留下来的那张卡**，然后清掉重复卡的凭据 | 两条续期链互相作废 |
 * | 3 | 命中一张**已停用**的原卡时**反转**（新卡可用、原卡标重复并停用） | 零可用号 |
 *
 * ## 刻意与 officeace 的差异
 *
 * `officeace` 的转写走 `auths.officeace.persistLogin(credential, {refName})`
 * —— 它那里凭据是**结构化对象**。minimax 这里的凭据已由 `persistLogin` 落盘
 * （含 `user_id` / `nickname`），故直接**原样搬运那份 JSON**：重新序列化一遍
 * 反而可能丢字段（正是本 PR 要治的「续期丢身份」同型缺陷）。
 */
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { ProviderAccountEntry } from './types.js';
/** 去重的四种结局（测试逐格点名，别把它并成 boolean）。 */
export type MinimaxDedupOutcome = 
/** 拿不到稳定身份（老凭据 / 身份查询失败）⇒ 放弃去重，绝不猜。 */
'skipped-no-identity'
/** 池里没有同 `user_id` 的**另一张**卡 ⇒ 正常新建。 */
 | 'skipped-not-duplicate'
/** 命中一张启用的原卡：新卡停用、凭据转写回原卡。 */
 | 'duplicate'
/** 命中一张**已停用**的原卡：反转（新卡可用，原卡标重复并停用）。 */
 | 'reversed'
/** 读池失败 ⇒ 不做任何破坏性动作（读不到 ≠ 没有）。 */
 | 'error';
export interface MinimaxDedupDeps {
    pool: {
        findAccountIdByIdentityField(provider: string, field: string, identity: string): Promise<string>;
        /** 含已停用账号的按 id 查询（`AccountPool.findAccount` 是**同步**的）。 */
        findAccount?(id: string): ProviderAccountEntry | undefined;
        updateAccount(id: string, patch: Partial<Pick<ProviderAccountEntry, 'nickname' | 'enabled' | 'expiresAt' | 'refreshable'>>): Promise<void>;
    };
    credentials: {
        resolve(ref: CredentialRef): Promise<{
            value: string;
        } | undefined>;
        set(ref: CredentialRef, value: string): Promise<void>;
        unset(ref: CredentialRef): Promise<void>;
    };
    logger?: {
        warn?(message: string): void;
    };
}
export interface MinimaxDedupArgs {
    /** provider id（`minimax` / `minimaxintl`）—— 两站各自独立判重。 */
    providerId: string;
    /** 本次登录新建的账号 id。 */
    newAccountId: string;
    /** 本次登录的凭据 ref **名**（`persistLogin` 刚写进去的那个）。 */
    newCredentialRefName: string;
    /** 稳定身份（`user_id`）。缺失即放弃去重。 */
    identity: string | undefined;
    /** 展示名（含两站前缀，调用方已算好）。 */
    nickname: string;
    /** 新凭据的到期时刻（毫秒），转写到原卡时一起更新。 */
    expiresAtMs?: number;
    /** 新凭据是否可续期。 */
    refreshable?: boolean;
}
/**
 * 执行一次同账号去重。**永不抛错**（登录已成功，去重失败不得改写结论）。
 */
export declare function dedupeMinimaxAccount(deps: MinimaxDedupDeps, args: MinimaxDedupArgs): Promise<{
    outcome: MinimaxDedupOutcome;
    retainedAccountId?: string;
}>;
//# sourceMappingURL=minimax-dedup.d.ts.map