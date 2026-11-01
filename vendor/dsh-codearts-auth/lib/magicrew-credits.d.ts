/**
 * Magicrew 的积分余额与**聚合临期折算**。
 *
 * ## 报文（实测 2026-10-28）
 *
 * ```json
 * GET /api/v1/quota/points/total → { code: 1000, data: {
 *   total_points: 1093,
 *   expiring_quota_details: [{ quota_id, expires_at: "2026-11-27 13:47:42", remaining_points: 93 }]
 * }}
 * ```
 *
 * ## ⚠️ `expires_at` **无时区** ⇒ 按 UTC+8 解释
 *
 * 上游给的是 `2026-11-27 13:47:42`（不带偏移）。按北京时间解析的依据：
 * magpie 侧用的就是 UTC+8（`beijingDay`），且其「每日积分北京时间 23:59 到期」
 * 已实跑吻合。⚠️ 若上游将来改按 UTC 存，折算会**差 8 小时**（早或晚到期）。
 *
 * ## ⚠️ 倍率口径：`input_points ÷ 2000`
 *
 * 逐个核对：`deepseek-v4.1-flash` 0.10×2000=**200** ↔ 实测 200；
 * `qwen3.5-flash` 0.01×2000=**20**；`qwen3.8-max` 0.60×2000=**1200**。
 */
import { type MagicrewProduct } from './magicrew-product.js';
import type { CreditBalance } from './credits.js';
/**
 * 解析 `2026-11-27 13:47:42`（**无时区**）为毫秒时间戳，按 UTC+8 解释。
 *
 * 解析不出来返回 `undefined`（**不编造**）。
 */
export declare function magicrewParseExpiresAt(text: string): number | undefined;
export declare function fetchMagicrewBalance(params: {
    jwt: string;
    organizationCode: string;
    product?: MagicrewProduct;
    fetchImpl?: typeof fetch;
}): Promise<CreditBalance | undefined>;
/** 从计费条目算倍率；缺价格返回 `undefined`（**不猜**）。 */
export declare function magicrewRateOf(entry: {
    input_points?: unknown;
}): number | undefined;
/**
 * 该模型是否**免费**：厂商**已知**声明 `input_points === 0`。
 *
 * ⚠️ 不得用 `magicrewRateOf(entry) === 0` 反推：那是「值恰好为 0」，而这里要的是
 * 「**已知且**为 0」。一旦哪天有人把「未知」压成 0（或上游补了个 0 占位），
 * `rate === 0` 就会把**没有价格的模型全判成免费**。故判据与倍率共用
 * {@link magicrewPointsOf}（同一套「已知」），先判已知、再判值。
 */
export declare function magicrewIsFree(entry: {
    input_points?: unknown;
}): boolean;
/**
 * 拉每个模型的计费（用于「免费 / 倍率」标记）。失败返回空对象（不挡列表）。
 *
 * ## ⚠️ 以下形状**未取证**
 *
 * `POST { model_ids: [...] }` 在本仓**只此一处**，没有任何材料取证过这个请求体
 * 与它换回的响应；设计规格 §1.7 的**唯一实发报文是单对象**：
 *
 * ```json
 * { "model_id": "deepseek-v4.1-flash", "billing_type": "TextTokens",
 *   "input_points": 200, "output_points": 800 }
 * ```
 *
 * ⇒ 故这里同时兼容**对象与数组**两种（数组 = 既有假设，对象 = §1.7 实测形状）。
 * 若上游确认为其一，请收紧并补真机取证。
 */
export declare function fetchMagicrewModelPoints(params: {
    jwt: string;
    organizationCode: string;
    modelIds: readonly string[];
    product?: MagicrewProduct;
    fetchImpl?: typeof fetch;
}): Promise<Record<string, {
    inputPoints?: number;
    outputPoints?: number;
}>>;
/**
 * 聚合折算原语：该账号的积分**最早作废时刻**。
 *
 * ## ⚠️⚠️ 必须**自己取数**（`src/provider-runtime.ts:218-231` 的契约）
 *
 * `cachedBalance` 只是**共享读数入口**（`src/balance-cache.ts`），不是唯一来源：
 * 它缺席、返回 `null`（查询失败）、或返回 `undefined`（本次没有共享读数）时，
 * **必须回落到自己发请求**（{@link fetchMagicrewBalance}）。
 *
 * 折算的可用性**不得**依赖那份缓存 —— 否则「未接线」会变成「该渠道折算恒
 * {@link UNUSABLE}」⇒ 该渠道在聚合候选表里**静默消失**（本仓库复发过三次的形态）。
 *
 * - 有余额 + 有到期批次 ⇒ 最早那个批次的时刻（`rankCandidates` 据此排先后）
 * - 有余额但无到期批次 ⇒ {@link NEVER}（**长期积分**：排最后但**不剔除**）
 * - 余额为 0 / 取数失败（`fetchMagicrewBalance` 返回 `undefined`） ⇒ {@link UNUSABLE}（**剔除**）
 *
 * ⚠️ 「有余额但无到期时间」必须是 `NEVER` 而**不是** `UNUSABLE`：
 * 后者会把一个真能用的渠道从聚合轮换里剔掉。
 * ⚠️ 反之「余额为 0」必须 `UNUSABLE`：否则余额耗尽的账号仍会被选中、请求随即失败。
 */
export declare function magicrewExpiry(params: {
    jwt: string;
    organizationCode: string;
    /**
     * 共享读数；**缺席、返回 null 或 undefined 时都必须自己发请求取**
     * （`src/provider-runtime.ts:218-231` 的契约：折算可用性不得依赖缓存）。
     */
    cachedBalance?: () => Promise<CreditBalance | null | undefined>;
    product?: MagicrewProduct;
    fetchImpl?: typeof fetch;
    /** 判 `expiresAt > now` 用的时钟（可注入，单测不必等真时间）。 */
    now?: number;
}): Promise<number>;
//# sourceMappingURL=magicrew-credits.d.ts.map