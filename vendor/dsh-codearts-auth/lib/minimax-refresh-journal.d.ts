/**
 * MiniMax 续期/身份 **JSONL 日志**（2026-10-24 本地试验版新增）。
 *
 * ## 为什么要有它（对应本次试验的验收方式）
 *
 * 原续期路径只有 `ctx.logger` 的两句话（「已续期」/「续期失败」）——
 * 「换钥匙」这种高危操作**既不知道 frequency 也不知道死因**。试验版要求
 * 一两天内能回答三个问题，全部依赖这份日志：
 *
 * 1. 轮换频率是否真的从「每 30 分钟五连发」降到「每账号各自 ~45-55 分钟」；
 * 2. 401 兜底（`forced`）与请求路径续期（`ondemand`）各触发过几次；
 * 3. 终态 `invalid_grant` 是否出现过、死于抢救链哪一层。
 *
 * ## 形态
 *
 * - **JSONL**（一行一条）：`appendFile` 原子性按行保证，进程崩了最多丢半行；
 * - **fire-and-forget**：任何错误（目录建不出、盘满）都**静默吞掉** ——
 *   日志是观测设施，绝不能反噬续期主路径（与 `syncAccountExpiry` 的
 *   「失败只记日志不上抛」同一纪律）；
 * - **>5MB 轮转**：改名 `.old`（覆盖旧 .old），试验期量级用不到，纯保险；
 * - **必须显式注入 home**（`MinimaxAuth` 的 `journalHome` 选项）：单测不传 ⇒
 *   **绝不写盘** —— 否则单测会把日志写进用户真实的 `~/.dsh`。
 */
/** 日志条目类型。 */
export type MinimaxJournalKind = 'grant' | 'superseded';
/** 续期触发来源。 */
export type MinimaxJournalTrigger = 'patrol' | 'ondemand' | 'forced' | 'recover';
/** 一条日志。字段全部可选除 `ts/provider/accountId/kind`（见模块头三问）。 */
export interface MinimaxJournalEntry {
    ts: number;
    provider: string;
    accountId: string;
    kind: MinimaxJournalKind;
    trigger?: MinimaxJournalTrigger;
    result?: 'ok' | 'error' | 'skipped';
    error?: string;
    latencyMs?: number;
    /** 续期成功后的新过期时刻（毫秒，ISO 化前原值；便于与 state.json 对照）。 */
    newExpiresAt?: number;
}
/** 追加一条日志。`home` 缺省（单测）时**什么都不做**。 */
export declare function appendMinimaxJournal(home: string | undefined, entry: MinimaxJournalEntry): void;
//# sourceMappingURL=minimax-refresh-journal.d.ts.map