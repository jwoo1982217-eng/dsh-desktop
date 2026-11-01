/**
 * Codely（Unity 团结引擎）**积分余额**查询。
 *
 * ## 数据来源（2026-10-19 真凭据实测）
 *
 *     GET https://codely.tuanjie.cn/api/user/usage/summary
 *     Authorization: Bearer <access_token>
 *     X-User-Agent: codely-vscode/4.3.0
 *     → 200 {"remaining_points":"2400","is_exhausted":false,
 *            "details":[{"type":"gift_credit","remaining_points":"2400","exhausted":false}]}
 *
 * ⚠️⚠️ **`remaining_points` 是字符串**（`"2400"`），顶层与 `details[]` 里都是
 * —— 必须按「string | number」双形态解析（与 officeace 的 `totalPoint`
 * 同一类坑）；解析不出**不得**回落成 0（0 的语义是「已用光」）。
 *
 * ## ⚠️ details[] 是逐桶结构，必须逐桶映射（zcode 多桶教训）
 *
 * `details[]` 与 zcode 的 `buckets[]` 同型（每桶自己的 `type` / 余量 /
 * `exhausted`）。**不能只取第一桶或只看顶层汇总** —— 多桶账号（如充值积分 +
 * 赠送积分并存）的其余桶会被静默丢掉。顶层 `remaining_points` 是全桶汇总，
 * 与逐桶之和自洽时二者任取其一展示，但**包列表必须逐桶**。
 *
 * ⚠️ 探测过程留档：同域 `/api/user/info`、`/api/points/balance`、
 * `/api/points/summary` 均为 **404**（不是 SPA 假 200，可信）；
 * `usage/summary` 是唯一命中的余额端点。
 *
 * @module src/codely-credits.ts
 */
import { type CodelyCredential } from './codely-auth.js';
import type { ClaimOutcome, CreditBalance } from './credits.js';
/** 积分端点路径（实测 200；同域其余候选均已 404）。 */
export declare const CODELY_USAGE_SUMMARY_PATH = "/api/user/usage/summary";
/**
 * 拉取 Codely 积分余额（`fetchBalanceDetailed` 形态：失败自带可读原因）。
 *
 * ## 失败分类（与 modelscope 同法，压成一句「查询失败」会丢线索）
 *
 * - `401` ⇒ **令牌无效/已过期** ⇒ 重新登录（设备码流程）；
 * - `200` 但缺字段 ⇒ **上游改版** ⇒ 报「读数格式变了」，不显示 0；
 * - 网络/超时 ⇒ 查网络。
 */
export declare function fetchCodelyBalanceDetailed(credential: CodelyCredential, options?: {
    fetcher?: typeof fetch;
}): Promise<{
    balance: CreditBalance | null;
    error?: string;
}>;
/**
 * 签到端点（2026-10-20 真凭据实测，两步都 200）。
 *
 * 来源是**网页 dashboard 的 SPA bundle**（`/static/web/assets/index-*.js`，
 * 官方 CLI 二进制里没有签到调用 —— 它只管推理/余额）。流程与网页一致：
 *
 *     POST /api/points/check-in/init   → 状态（先查，**不发积分**）
 *     POST /api/points/check-in        → 执行（can_check_in === true 时才发）
 *
 * `init` 实测报文（签到前）：
 *
 *     { "month":"2026-10", "timezone":"Asia/Shanghai",
 *       "activity_status":"ACTIVE", "check_in_status":"READY",
 *       "check_in_count":19, "max_count":31, "can_check_in":true,
 *       "levels":[{ "level":1, "status":"COMPLETED", "reward_summary":"+300" },
 *                 …, { "level":20, "status":"CURRENT", "reward_summary":"+300" }, …] }
 *
 * 执行后 `check_in_status:"COMPLETED"`、`check_in_count` +1、`can_check_in:false`。
 */
export declare const CODELY_CHECKIN_INIT_PATH = "/api/points/check-in/init";
export declare const CODELY_CHECKIN_PATH = "/api/points/check-in";
/**
 * 领取 Codely 每日签到积分（**写操作**，幂等判据在 `init` 的 `can_check_in`）。
 *
 * ## 流程（与网页 dashboard 同序，且**绝不跳过 init 直接执行**）
 *
 * 1. `init` 查状态：活动未开放（`activity_status !== 'ACTIVE'`）⇒ `inactive`；
 *    `check_in_status === 'UNAVAILABLE'` ⇒ `failed`（上游的 `error` 字段透传）；
 *    `can_check_in !== true` ⇒ `already-claimed`（含 `PROCESSING` / `CREDIT_PENDING`
 *    这两个「签到已受理、积分未到账」的过渡态 —— 此时再发执行请求只会白打）；
 * 2. `can_check_in === true` 才发 `check-in` 执行；执行后按 `check_in_status`
 *    判成败（`COMPLETED` ⇒ claimed）。
 *
 * ## credit 数额的来源（不编造）
 *
 * 上游**不在执行响应里返回「本次领到多少」**；可用的唯一数字是 `init` 报文
 * `levels[]` 里 `status === 'CURRENT'` 那级的 `reward_summary`（实测 `"+300"`）。
 * 解析不出时如实返回 `credit: 0` + `delayedMessage`（autoclaw 先例：0 不代表
 * 没领到，调用方会刷新余额）—— 绝不拿 `max_count` 或上一级的数字凑数。
 *
 * ⚠️ `streakDays` 刻意给 0：`check_in_count` 是**本月累计次数**，不是连续天数，
 * 塞进「连续 N 天」的展示槽位就是编造读数（provider-runtime 对
 * `fetchStatus` 有同款红线）。Codely 没有连续天数概念。
 */
export declare function claimCodelyDailyCheckIn(credential: CodelyCredential, options?: {
    fetcher?: typeof fetch;
}): Promise<ClaimOutcome>;
//# sourceMappingURL=codely-credits.d.ts.map