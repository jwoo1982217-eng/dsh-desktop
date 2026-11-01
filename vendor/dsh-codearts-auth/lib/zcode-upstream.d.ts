/**
 * ZCode 上游 HTTP 客户端（额度 / 签到 / 模型目录）。
 *
 * ## 这一层与其它 provider 的差异
 *
 * 其它 provider 的「额度 / 签到」是各家私有协议；ZCode 这套的**特点**是
 * 同一组请求头要在三处复用，且**鉴权要求按端点不同**（实测）：
 *
 * | 端点 | 需要 `Authorization: Bearer <jwt>` | 需要 `X-Device-Mid` |
 * |---|---|---|
 * | `GET /zcode-plan/billing/balance` | **是**（缺则 401） | **是**（缺则 400 code 3001） |
 * | `GET /zcode-plan/billing/preview` | 否 | 是 |
 * | `POST /api/v1/event/report` | 否 | 是 |
 * | `POST /zcode-plan/billing/claim` | **是** | 是（另需 captcha 头） |
 * | `GET /api/v1/client/configs` | **是** | 是 |
 *
 * ⚠ 这两条都踩过：不带 `Authorization` 查额度得 **401**；
 * 不带 `X-Device-Mid` 得 **400 `{"code":3001,"msg":"parameter error"}`**。
 *
 * ## 签到为什么要「补激活上报」
 *
 * 服务端**不会主动推送**活动。`preview` 的内容依赖**客户端活跃信号**：
 *
 * ```
 * 补 POST /api/v1/event/report {app_launch, app_daily_active} 之前：
 *   preview → {"code":0,"data":{"plans":[]}}          ← 空
 * 补之后：
 *   preview → {"code":0,"data":{"plans":[{plan_id:"zcode-v3-start-plan-trust-…"}]}}
 * ```
 *
 * **⇒ 「每日随机派发」不是随机推送，而是「服务端按活跃信号决定要不要给」。**
 * 所以要领额度必须**先补两条事件**，再查 preview，再 claim。
 */
import type { ZcodeCredential } from './zcode.js';
import type { ZcodeRemoteModelLike } from './zcode-product.js';
/**
 * ⚠ **只取类型**：`zcode-captcha.ts` 反过来不 import 本文件，故无循环。
 * 用 `import type` 是为了在编译后**不产生运行时依赖** —— captcha 那侧会拉起
 * `chromium-session.js`（含 `node:child_process`），而本文件的调用方里有
 * 只需要「读配置」的纯网络路径。
 */
import type { ZcodeCaptchaConfig } from './zcode-captcha.js';
/** ZCode 平台 origin（官方默认）。 */
export declare const ZCODE_ORIGIN = "https://zcode.z.ai";
/** 免费额度通道的 Anthropic 端点。 */
export declare const ZCODE_PLAN_MESSAGES_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";
/**
 * 按通道返回「Messages」端点。
 *
 * ⚠ **积分制（`start-plan`）无论账号是 bigmodel 还是 zai，都走 `zcode.z.ai`**
 * —— 官方分派表（`resources/config/provider/zcode-builtin.json`）的规则 2/5
 * 明确如此，2026-10-03 实测复核。**不要**因为账号是国际版就改域名。
 *
 * ⚠ 订阅制（`coding-plan`）才走 `api.z.ai`（官方规则 0/1，2026-10-03 实测
 * `GET https://api.z.ai/api/anthropic/v1/models` 返回 200 + 11 个模型）。
 */
export declare function zcodeMessagesUrl(channel: 'start-plan' | 'coding-plan'): string;
/** 额度余额端点（**需要 Authorization**）。 */
export declare const ZCODE_BILLING_BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
/** 可领活动预览端点（**不需要 Authorization**）。 */
export declare const ZCODE_BILLING_PREVIEW_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/preview";
/** 领取端点（**需要 Authorization + captcha**）。 */
export declare const ZCODE_BILLING_CLAIM_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/claim";
/** 客户端活跃上报端点（**不需要 Authorization**）。 */
export declare const ZCODE_EVENT_REPORT_URL = "https://zcode.z.ai/api/v1/event/report";
/** 客户端配置端点（captcha 配置与模型池都从这里来）。 */
export declare const ZCODE_CLIENT_CONFIGS_URL = "https://zcode.z.ai/api/v1/client/configs";
/**
 * 营销投放查询端点（**只读**）。
 *
 * ## 来源（逆向官方 `app.asar` 实证，2026-10-23）
 *
 * 官方 Electron 产物的 `createMarketingTouchService`（scoop 安装版
 * `resources/app.asar` → `out/host/index.js`）：
 *
 * ```js
 * GET  /api/v1/marketing/touch?seq=<n>          // 查投放（deliveries[]）
 * POST /api/v1/marketing/touch/action           // 回执 {campaign_id, action_type}
 * ```
 *
 * 请求头只有四个：`X-Device-Mid` / `X-Client-Language` /
 * `X-ZCode-App-Version` /（可选）`Authorization`。
 */
export declare const ZCODE_MARKETING_TOUCH_URL = "https://zcode.z.ai/api/v1/marketing/touch";
/** 营销动作回执端点（`action_type` 实测只有 `confirm` / `cancel`）。 */
export declare const ZCODE_MARKETING_ACTION_URL = "https://zcode.z.ai/api/v1/marketing/touch/action";
/**
 * ★★ **受版本门控的功能**所需的**最低客户端版本**（实测，2026-10-23）。
 *
 * ## 门控在**两个端点上都成立**（两条独立实测）
 *
 * ### ① 营销投放（同一账号、同一套头，**只改这一个头**）
 *
 * | `X-ZCode-App-Version` | `GET /marketing/touch` 的 `data.deliveries` |
 * |---|---|
 * | `3.14.3`（本插件此前写入凭据的版本） | **`[]`（空）** |
 * | `3.16.3`（用户装的官方版） | `[{campaign_id:"2113475573403824128", …}]` |
 *
 * ### ② **领取**（`POST /zcode-plan/billing/claim`，2026-10-23 真机一发定音）
 *
 * | `X-ZCode-App-Version`（**其余头完全相同**） | claim 返回 |
 * |---|---|
 * | `3.14.3` | **`400 / code 1004 "no permission"`**（官方文案 `manualClaimPlan.claim.failure.ineligible` = 「当前账号或**客户端版本**不满足领取条件」） |
 * | `3.16.2` | **`200 / code 0`** + `data.plan.{user_plan_id, status:"active", entitlements:[3 亿 + 2 亿]}` ★ |
 *
 * ⇒ 只抬营销请求的版本**不够**：`1004` 会让「拿到了活动却领不到」，
 *   而它**看起来像账号没资格**（极具误导性）。两个端点必须**同抬**。
 *
 * ⚠ 官方客户端的 claim 也报自己的版本（`app.asar` → `out/host/index.js` 的
 *   `claimManualPlan`：`'X-ZCode-App-Version': Ir`；本机 `Ir` 即客户端版本
 *   `3.16.2`，同文件 `var Vu="3.16.2"`）⇒ **我们报 3.14.3 才是那个异类**。
 *
 * ⚠ **只对这两条门控路径覆盖版本**（`zcodeVersionGatedAppVersion()`），
 *   不改凭据里的 `app_version`、也**不**全局抬 `ZCODE_APP_VERSION_FALLBACK`：
 *   推理路径的既有实测结论（含 `3012` 的消融矩阵）都是在 3.14.3 上取到的，
 *   无证据地整体抬版本会把这些结论一起作废。
 *
 * ⚠ **下限未二分**：营销侧只测了 `3.14.3` 空 / `3.16.3` 有；领取侧测了
 *   `3.14.3` 失败 / `3.16.2` 成功。取 `3.16.3` 是该区间内的保守上界，
 *   **不声称它是最低下限**。
 */
export declare const ZCODE_VERSION_GATED_MIN_APP_VERSION = "3.16.3";
/**
 * 该宿主该发的平台三件套（三值同源，见上方注释）。
 *
 * ⚠ 两个形参都**必须入参化**（默认取真实宿主）：三件套的自洽性只在「非 win32
 * 宿主」上才可能出问题，而 CI / 开发机大多是 win32 ⇒ 不注入就**永远测不到**那条
 * 分支。2026-10-25 审计实测：在 Windows 上把 `X-Os-Version` 换回 `os.release()`
 * 后，宿主机相关的断言**全绿** —— 因为本机的 `os.release()` 恰好就是
 * `10.0.26100`，与伪装值逐字相同。故内核版本也必须能注入。
 */
export declare function zcodeClientPlatform(hostPlatform?: NodeJS.Platform, hostOsVersion?: string): {
    platform: string;
    osCategory: string;
    osVersion: string;
};
/**
 * 构造 ZCode 的「来源标识」请求头。
 *
 * ## ★ 这些头的值以官方客户端的真实抓包为准（2026-10-25 逐字对齐）
 *
 * 官方 GUI 的一次 `/v1/messages` 带 **18 个头**。本函数此前只发 10 个，
 * 且其中**两个的值与官方不符**：
 *
 * | 头 | 官方 | 本函数（改前） |
 * |---|---|---|
 * | `x-release-channel` | `production` | `stable` ✗ |
 * | `x-platform` | `win32-x64` | `win32` ✗ |
 *
 * 并缺 7 个官方每次都带的头：`x-title` / `x-os-version` / `x-zcode-agent` /
 * `x-session-id` / `x-zcode-session-type` / `x-request-id` / `x-zcode-trace-id`。
 *
 * ⚠ 旧注释写「实测它们不是 3012 的判据」—— 那是**旧版客户端**上取到的结论。
 * 上游在 2026-10-23 升级到 `3.16.3` 之后，`405 + unusual activity` 开始在
 * **所有**插件请求上稳定出现（跨账号、跨会话），而官方客户端同账号同网络正常
 * ⇒ 头的形状重新成为首要嫌疑，故此处逐字对齐抓包。
 *
 * ⚠ `X-Device-Mid` **仍是硬需求**（缺它 billing 全家桶回 400）。
 */
export declare function buildZcodeHeaders(credential: Pick<ZcodeCredential, 'device_mid' | 'app_version'>, options?: {
    authorization?: string;
    json?: boolean;
    captcha?: {
        param: string;
        region: string;
    };
    /**
     * 覆盖 `app_version`（默认取凭据里的）。
     *
     * ⚠ 使用者**只有两处**，且都是实测过版本门控的
     * （见 {@link ZCODE_VERSION_GATED_MIN_APP_VERSION}）：
     * ① 营销投放查询 `fetchZcodeMarketingPlans`（版本低 ⇒ 投放为空）；
     * ② **领取** `claimZcodePlan`（版本低 ⇒ `1004 no permission`，真机一发定音）。
     * 两者都必须按请求覆盖，**不得**改凭据本身。
     *
     * ★ 未显式覆盖时走 {@link zcodeVersionGatedAppVersion}（凭据版本与
     * `3.16.3` 取较大者），**不再直接回落到凭据里的旧版本**。
     *
     * 依据（2026-10-25 真机取证）：官方客户端在 2026-10-23 升级到 `3.16.3`
     * 之后，本插件发的**推理**请求开始稳定 `405 + request has been blocked
     * due to unusual activity`（跨账号、跨会话；官方客户端同账号同网络正常）。
     * 版本号是当时**唯一**与官方不一致的请求特征 —— 身份块已逐字对齐（2632
     * 字符）、其余 11 个官方头（`Suc` 全量）也全部对齐 ⇒ 版本号成为首要嫌疑。
     */
    appVersion?: string;
    /**
     * 覆盖平台三件套（**仅供测试**：非 win32 分支无法在 Windows 主机上自然触发）。
     * 生产调用一律不传 ⇒ 走 {@link zcodeClientPlatform}。
     */
    platform?: {
        platform: string;
        osCategory: string;
        osVersion: string;
    };
}): Record<string, string>;
/** 一次额度桶（`balances[]` 的一项）。 */
export interface ZcodeBalanceBucket {
    planId?: string;
    /** 展示名（实测为模型名，如 `GLM-5.3-Flash`）。 */
    showName?: string;
    /**
     * ★ **计量单位** —— 上游明确下发，实测为 `"token"`。
     *
     * ⚠ **真实缺陷**（用户报障）：「智谱 plan 给的不是积分是 tokens，
     * 应该显示 `Token: xx.yyM` 这种格式」。
     *
     * 上游 `billing/balance` 的桶里有两个字段直接说明单位：
     * ```json
     * { "meter": "model_usage", "unit_type": "token",
     *   "total_units": 100000000, "used_units": 5460725,
     *   "remaining_units": 94539275 }
     * ```
     * 此前我们把它当泛化的「积分」渲染，于是界面显示 `94539275`（无单位、
     * 且量级看起来像积分），而正确形态是 **`94.54M` tokens**。
     */
    unitType?: string;
    /** 计量口径（实测 `model_usage`）。 */
    meter?: string;
    totalUnits?: number;
    usedUnits?: number;
    remainingUnits?: number;
    availableUnits?: number;
    /** 到期时间（Unix 秒）。 */
    expiresAt?: number;
    /**
     * ★★ **该桶专属的模型**（上游 `capabilities`，实测形状 `["model:glm-5.3"]`）。
     *
     * ## 为什么必须读它（真实缺陷，用户报障 2026-10-12）
     *
     * **用户报障原文**：「智谱账号送的 8m 算力其中分为 5.3-3m 和 5.3flsh-5m，
     * 插件判断这个账号没用完，就不会切换下一个账号使用」。
     *
     * 本机**只读实测**（`scripts/probe-zcode-plan-buckets.mjs`，启用账号）：
     *
     * ```json
     * [bucket] show_name=GLM-5.3        capabilities=["model:glm-5.3"]
     *          total_units=3000000   remaining_units=3000000
     * [bucket] show_name=GLM-5.3-Flash  capabilities=["model:glm-5.3-flash"]
     *          total_units=5000000   remaining_units=5000000
     * ```
     *
     * ⇒ **8M 就是这两个桶（3M + 5M），且上游明确下发了模型归属。**
     * 而此前本类型**没有这个字段**，`fetchZcodeBalance` 把它整体丢弃 ⇒
     * 插件只知道「总剩余 8M」，于是 GLM-5.3 的 3M 烧光、Flash 的 5M 还在时，
     * 折算层仍判「这账号有额度」（判据是全桶汇总的 `remaining > 0`）⇒
     * **该模型的标记永远不写**，auto/aggregate 继续把它当可用候选派发 GLM-5.3。
     *
     * ⚠️ **缺失/为空 ⇒ 视为「通用桶」**（覆盖所有模型），**不要**当成「不覆盖任何模型」：
     * 后者会让一个仍有余额的通用桶（如赠送的 1 亿 token）被忽略 ⇒ 一个**确实可用**
     * 的账号被判成「该模型已耗尽」而被**误封**（方向相反的错误，代价更大）。
     * 判据见 `zcode-entitlements.ts` 的 `bucketCoversModel`。
     */
    capabilities?: readonly string[];
    /**
     * 权益 id（实测 `ent_2_0817_glm_5p3` / `ent_2_0817_glm_5p3f`）。
     *
     * ⚠ **不参与任何判定** —— 判定一律走 {@link capabilities}
     *（它是上游下发的**语义**字段；`entitlement_id` 是命名约定，改版就可能变）。
     *
     * ⚠️⚠️ **它当前是「只写不读」的数据**（审计指出 2026-10-12）：`src/` 与
     * `plugin-src/client/` 里**零消费方**（唯一读者是本模块的单测）。
     * 保留它的理由是**排查留证**：出问题时能一眼看出「是哪个 entitlement
     * 在起作用」，而 `capabilities` 只给模型维度、给不出计划维度。
     * ⇒ 别把它当「已接线」的字段用；要用它请先加消费者（并删掉这句说明）。
     */
    entitlementId?: string;
}
/** 余额查询结果。 */
export interface ZcodeBalanceResult {
    /** 是否为「企业版」等不下发额度数字的形态（此时 buckets 为空）。 */
    enterprise?: boolean;
    buckets: readonly ZcodeBalanceBucket[];
    /** 汇总剩余额度（所有桶累加）。 */
    remaining: number;
    /** 汇总总量。 */
    total: number;
    /** 最早到期时间（Unix 秒），用于展示解禁时刻。 */
    expiresAt?: number;
    /** 显示名（首个桶的模型名）。 */
    planName?: string;
    /**
     * ★ 可领活动摘要（来自 `billing/preview`）。
     *
     * ⚠ **必需存在的原因**（2026-10-03 实测）：每日赠送的 start-plan 额度
     * **不在 `buckets` 里**，只在 `preview.plans` 里 ——
     * 同一账号 `balances` 返回 0 个桶、`preview` 返回 `…start-plan-trust-1003`。
     * 只读 `buckets` 会让面板显示 0，而用户实际能领 1 亿 tokens。
     *
     * ⚠ 取不到时是**空数组**（不 undefined）：preview 失败属降级，
     * 绝不能让它影响 `remaining`/`total` 本身。
     */
    claimablePlans: ZcodeClaimablePlanSummary[];
    /** preview 查询成功；失败不能推断为已领取。 */
    claimablePlansKnown?: boolean;
    /** 已领取且未过期的活动，包括待生效权益。 */
    ownedPlanIds?: readonly string[];
    /** 已领取但尚未生效；不计入当前可用余额。 */
    pendingGrants?: readonly ZcodePendingGrant[];
    pendingPlans: ZcodePendingPlan[];
}
export interface ZcodePendingGrant {
    planId: string;
    name: string;
    amount: number;
    unit: string;
    effectiveAt: number;
}
export declare function describeZcodePendingGrants(grants?: readonly ZcodePendingGrant[]): string;
/** 「已领但未生效」的计划（`status: active` 且 `effective_at` 未到）。 */
export interface ZcodePendingPlan {
    planId: string;
    name?: string;
    /** 合计额度（同 `unitType` 才相加，规则同营销投放那条）。 */
    grantUnits?: number;
    unitType?: string;
    /** 生效时刻（Unix 秒）。 */
    effectiveAt?: number;
    /** 到期时刻（Unix 秒）。 */
    endsAt?: number;
}
/** 一次可领活动。 */
export interface ZcodeClaimablePlan {
    planId: string;
    priority: number;
    name?: string;
    /**
     * ★ 本次领取能拿到的**额度数值**（实测自 `plan.entitlements[].grant_units`）。
     *
     * ⚠ 上游**不在** plan 顶层给额度，只在 `entitlements[]` 里。拿不到时
     *   留 undefined —— 此时 `toClaimOutcome` 退回 0（不谎报）。
     */
    grantUnits?: number;
    /**
     * ★ 额度单位（`'token'` / 缺省按积分）。
     *
     * ⚠ ZCode 下发 `unit_type: "token"`，**不是**积分 —— 展示必须走
     *   `formatUnits`/`unitLabel`（`plugin-src/client/credits-format.js`）。
     */
    unitType?: string;
    /**
     * ★ 若该 plan 来自**营销投放**（{@link fetchZcodeMarketingPlans}），
     *   这里是它所属的 `campaign_id`。
     *
     * 用途只有一个：领取成功后回报
     * `POST /marketing/touch/action {campaign_id, action_type:'confirm'}`，
     * 让服务端不再重复投放同一个活动（否则每次签到都会为一个**已领过**的
     * plan 再 mint 一次 captcha —— 那是设备级配额，见 `captcha-backoff.ts`）。
     *
     * ⚠ 来自 `billing/preview` 的 plan **没有**这个字段（preview 不走营销系统）。
     */
    marketingCampaignId?: string;
}
/** 领取结果。 */
export interface ZcodeClaimOutcome {
    planId: string;
    /** 上游业务码：`0` 成功、`1003` 已领取（幂等成功）。 */
    code?: number;
    ok: boolean;
    /** 已领取过（幂等，视为成功）。 */
    alreadyClaimed?: boolean;
    httpStatus?: number;
    message?: string;
    /**
     * 上游的 `logid`（排障凭据，2026-10-12 新增）。
     *
     * ⚠ 与推理侧同源：由 {@link extractZcodeLogId} **双来源**取
     * （体顶层 `logid` 优先，HTTP 头 `x-request-id` 兜底）——
     * 后者让**边缘 HTML 页**也有凭据可取。
     * ⚠ 取不到即 `undefined`，不编造（诊断行会整项省略）。
     */
    logId?: string;
}
/**
 * 查余额。
 *
 * ⚠ **`Authorization` 必需**（缺则 401）；`X-Device-Mid` 也必需
 * （缺则 400 code 3001）。
 *
 * 企业版（`displayMode: "enterprise"`）不下发额度数字、只给外部链接 ——
 * 此时返回 `{enterprise:true, buckets:[]}`，**不要**显示成 0
 * （0 是「已用光」的语义）。
 */
export declare function fetchZcodeBalance(credential: ZcodeCredential, fetchImpl?: typeof fetch): Promise<ZcodeBalanceResult | undefined>;
/**
 * 从 `billing/balance` 的 `plans[]` 里挑出「**已领、但还没生效**」的计划。
 *
 * ## 判据（三条，缺一不可）
 *
 * | 条件 | 为什么 |
 * |---|---|
 * | `status === 'active'` | 只有 active 的计划是「已领到、未作废」 |
 * | 有 `entitlements[].effective_at` | **生效时刻**；缺它就无法判断「还没生效」 |
 * | `effective_at` **晚于现在** | 已生效的计划会变成 `balances` 里的桶 ⇒ 不该重复计入 |
 *
 * ⚠ **只统计 `effective_at` 未到的那部分 entitlement**（不是整个 plan）：
 *   同一 plan 里可能混着已生效与未生效的条目。
 * ⚠ **额度按同 `unit_type` 求和**（与营销投放那条同规则），单位不同不混加。
 *
 * @param nowUnixSeconds 「现在」（Unix 秒）。留成参数是为了可测。
 */
export declare function pendingPlansOf(rawPlans: unknown, nowUnixSeconds?: number): ZcodePendingPlan[];
/** `ZcodeBalanceResult` 里由 `preview` 带出的可领活动。 */
export interface ZcodeClaimablePlanSummary {
    planId: string;
    showName?: string;
    amount?: number;
}
/**
 * 补客户端活跃信号。
 *
 * ⚠ **这一步不能省**：不补这两条事件，`preview` 恒为空 `plans: []` ——
 * 于是「今天可领」永远是「没有可领」，用户以为签到坏了。
 *
 * 幂等（服务端按 device_mid + 日期去重），故每次查 preview 前都可以补。
 */
export declare function reportZcodeActivation(credential: ZcodeCredential, fetchImpl?: typeof fetch): Promise<void>;
/** 查当前可领的活动。 */
export declare function fetchZcodeClaimablePlans(credential: ZcodeCredential, fetchImpl?: typeof fetch): Promise<readonly ZcodeClaimablePlan[]>;
/** 比较两个点分版本号（只看数字段，缺失段按 0；非数字段取前导数字）。 */
export declare function compareZcodeAppVersion(a: string, b: string): number;
/**
 * **受版本门控的请求**该用的 `app_version`：**凭据里的版本与最低版本取较大者**。
 *
 * 使用者只有两处（都是实测门控过的）：{@link fetchZcodeMarketingPlans} 与
 * {@link claimZcodePlan}。**其余请求一律用凭据里的版本**（见常量注释里的理由）。
 *
 * ⚠ 取较大者（而不是恒定 3.16.3）是为了**向前兼容**：用户若在更新的官方版上
 * 登录（凭据里写着 3.17.x），就用它自己的版本号，而不是把它降级成 3.16.3。
 * 依据与「为什么不能改凭据本身」见 {@link ZCODE_VERSION_GATED_MIN_APP_VERSION}。
 */
export declare function zcodeVersionGatedAppVersion(credential: Pick<ZcodeCredential, 'app_version'>): string;
/**
 * **不受门控**的请求（query / body 里的 `app_version`）该用的版本。
 *
 * ⚠ 与 {@link zcodeVersionGatedAppVersion} 的分工必须分清：
 * - 本函数 = 「凭据里的版本，但必须是干净的 semver」⇒ 拿不到干净的就用兜底值；
 * - 门控版 = 「与 `3.16.3` 取较大者」⇒ 只给**实测过门控**的路径（见常量注释）。
 *
 * ## 为什么必须存在（2026-10-25 审计打穿）
 *
 * 改前这些站点写的是 `credential.app_version ?? ZCODE_APP_VERSION_FALLBACK` ——
 * `??` **只挡 `undefined`/`null`**，于是空串会发出 `app_version=`、脏值会原样
 * 发出（换行注入会让 `Headers()` 抛 `TypeError`）。而同一请求的头走门控、
 * query 走凭据 ⇒ 还会出现「同一请求里两个版本号」的自相矛盾。
 */
export declare function zcodeCredentialAppVersion(credential: Pick<ZcodeCredential, 'app_version'>): string;
/**
 * 从营销投送物里取出**可领 plan**（纯函数，便于单测）。
 *
 * 判据是按钮的 action：`{type:'claim_zcode_plan', args:{plan_id}}`
 * —— 官方 renderer 里这条 action 被翻译成 `{type:'claim_plan', planId}` 交给
 * 主进程的 `claimManualPlan()`，后者调的正是我们既有的
 * `POST /zcode-plan/billing/claim`（**带 captcha**）。
 *
 * ⚠ 其余 action（`close` / `open_url` / `navigate` / `copy_text`）一律**不是**领取，
 * 不得混进来（`close` 尤其危险：把它当领取会对着一个空 plan_id 发请求）。
 */
export declare function claimablePlansFromMarketingDeliveries(deliveries: unknown): ZcodeClaimablePlan[];
/**
 * 查**营销投放**里的可领 plan（只读）。
 *
 * ## 为什么必须有这条来源（真实缺口，用户报障 2026-10-23）
 *
 * 用户报障原文：「我在 scoop 中装了 zcode 最新版 3.16.3，其中有 1024 程序员节
 * 送的 5 亿 token，把这个领取功能集成在每日签到中一并领取」。
 *
 * 本机**只读实测**（4 个账号、`scripts/probe-zcode-marketing-touch.mjs`）：
 *
 * | 端点 | 结果 |
 * |---|---|
 * | `billing/preview` | `data.plans = []`（**永远是空**） |
 * | `billing/balance` | `data.balances = []` |
 * | `marketing/touch`（`3.16.3`） | `deliveries[0].banner.buttons[1].action = claim_zcode_plan(zcode-v3-start-plan-1024)` |
 *
 * ⇒ **1024 活动根本不走 `preview`**，只在营销投放里。只领 preview 的签到
 * 永远看不到它（而它在 wire 上与「今天没活动」同形 —— 没有任何报错）。
 *
 * ⚠ **版本门控**：见 {@link ZCODE_VERSION_GATED_MIN_APP_VERSION}
 * （同一个账号、同一套头，只有版本号不同：`3.14.3` → `deliveries: []`）。
 *
 * ⚠ **失败一律降级为空数组**，绝不影响 preview 那条主路径（与
 * `fetchClaimablePlans` 同规矩：营销是补充，不是主体）。
 */
export declare function fetchZcodeMarketingPlans(credential: ZcodeCredential, fetchImpl?: typeof fetch): Promise<readonly ZcodeClaimablePlan[]>;
/**
 * 回报一次营销动作（`confirm` / `cancel`）——**写操作，best-effort**。
 *
 * ## 为什么要回报（对应用户可见的代价）
 *
 * 官方 renderer 在动作**成功后**立刻 `p(delivery, 'confirm')`
 * （`out/renderer/assets/styles-n-UNIiNg.js`）。不回报的后果不是「少了记账」，
 * 而是**服务端会继续重复投放同一个 campaign** ⇒ 我们每轮签到都会为一个
 * 已经领过的 plan 再 mint 一次 captcha。captcha 是**设备级**配额
 * （阿里云同设备每小时 150 次，见 `captcha-backoff.ts` 的开头），
 * 为一个已领的 plan 反复消耗它是净负面。
 *
 * ⚠ **只在领取成功/已领取（`code 0` / `1003`）后调用**：`confirm` 的语义是
 *   「本次活动我已处理完」。若在**失败**时回报，就等于告诉服务端
 *   「别再给我看了」—— 用户会**白丢一次领取机会**（`cancel` 语义更明确地
 *   表示放弃，本实现**从不**发送）。
 *
 * ⚠ **不参与 `noteZcodeRequest*` 埋点**：那套是给 `3012` 风控画像统计
 *   「去推理/领取端点的请求」的，营销端点不是风控对象，混进去会污染画像。
 *
 * @returns 只有 `{code:0}` 才算成功（与官方 `z.object({code:z.literal(0)})` 同口径）。
 */
export declare function reportZcodeMarketingAction(credential: ZcodeCredential, campaignId: string, actionType: 'confirm' | 'cancel', fetchImpl?: typeof fetch): Promise<boolean>;
/**
 * 合并两个来源的可领 plan（**按 `planId` 去重 + priority 降序**）。
 *
 * ⚠ **`preview` 优先**：同一 `planId` 同时出现在两边时保留 preview 那份
 *   （它的额度口径是既有实测过的），只把 marketing 的 `campaign_id`
 *   **补进去**（否则那份 plan 领完了却不会回报 confirm）。
 *
 * ⚠ 排序按 `priority` 降序与两个来源各自的约定一致 —— 1024 活动的
 *   `priority` 是 **101**，实测高于每日赠送那条（`fetchZcodeClaimablePlans`
 *   的注释：官方「先领高优先级」），故它会排在最前、先被领取。
 */
export declare function mergeZcodeClaimablePlans(preview: readonly ZcodeClaimablePlan[], marketing: readonly ZcodeClaimablePlan[]): ZcodeClaimablePlan[];
/**
 * 领取一个 plan。
 *
 * ⚠ **captcha 是一次性的**：每个 plan 都必须**重新 mint** 一个新 param。
 * 复用同一个 param 在索要验证的窗口里会得到 `3007`（captcha 校验失败）；
 * 本路径**每个 plan 都现产一个新的**，不去赌上游这一次校不校验。
 *
 * 业务码语义（桥侧实测记录）：
 *
 * | code | 含义 | 处理 |
 * |---|---|---|
 * | `0` | 成功领取 | ok |
 * | `1003` | **已领取过（幂等，不是错误）** | 视为成功 |
 * | `1001` | plan 不存在 | 失败 |
 * | `1002` | 活动已结束 | 失败 |
 * | `1004` | 不符合条件 | 失败 |
 * | `1005` | 名额用完 | 失败 |
 * | `3007` | captcha 失败（需换新 param） | 失败 |
 * | 401 | 未登录 | 失败 |
 */
export declare function claimZcodePlan(credential: ZcodeCredential, planId: string, captcha: {
    param: string;
    region: string;
}, fetchImpl?: typeof fetch): Promise<ZcodeClaimOutcome>;
/**
 * 拉服务端下发的 captcha 配置。
 *
 * ⚠ `platform` 必须是 **`unknown`** —— 实测 `win32` / `win64` / `windows` /
 * `electron` / `desktop` / `linux` 一律 `400 {"code":3001}`。
 * `unknown` 正是官方在非 Electron 上下文的取值。
 *
 * 失败返回 `undefined`，由调用方回退到内置兜底值
 * （{@link ZCODE_CAPTCHA_FALLBACK}）—— **不让配置拉取失败阻塞推理**。
 */
export declare function fetchZcodeCaptchaConfig(credential: ZcodeCredential, fetchImpl?: typeof fetch): Promise<ZcodeCaptchaConfig | undefined>;
/**
 * 从上游拉**模型目录**（含上下文窗口、最大输出、思考档位、视觉能力）。
 *
 * ## ⚠ 为什么要真拉，不能照抄兜底表
 *
 * **真实缺陷**（用户报障）：模型配置页里上下文窗口显示 **1,000,000**、
 * 最大输出 **128,000**，而思考档位选择器**根本没出现** —— 尽管 ZCode IDE
 * 里可以设置。
 *
 * 兜底表当时填的是 `200_000` / `32_768`（**凭空估的**），且模型都标了
 * `supportsImage: true`（但上游说只有 Flash 有 `capabilities.vision`）。
 * ⇒ 这类「能力字段」必须**抄上游**，不能按「同族应该一样」推断。
 *
 * ## 上游形状（`GET /api/v1/client/configs` 的 `data.builtinModels`）
 *
 * ⚠ `builtinModels` 是**对象**（key 不是模型 id，实测为序号字串），
 * 故必须 `Object.values(...)` 而不是数组下标。实测两条：
 *
 * ```json
 * { "modelId": "GLM-5.3-Flash", "contextWindow": 1000000,
 *   "maxCompletionTokens": 128000,
 *   "capabilities": { "vision": true },
 *   "modalities": { "input": ["text","image","video"], "output": ["text"] },
 *   "reasoning": { "levels": { "low": {...}, "max": {...}, "high": {...} },
 *                  "defaultLevel": "max" } }
 * ```
 *
 * ⚠ `reasoning.levels` 的**键序**就是官方展示顺序（实测 low → max → high
 * 的插入序，但客户端按 `low/high/max` 渲染 —— 故我们**显式排序**为
 * `low → high → max`，与 IDE 截图一致；未知档位排在后面保持原序）。
 *
 * 失败返回 `undefined`，由调用方回退兜底表（**不让目录拉取失败让 provider 不可用**）。
 */
export declare function fetchZcodeModels(credential: ZcodeCredential, fetchImpl?: typeof fetch): Promise<ZcodeRemoteModelLike[] | undefined>;
//# sourceMappingURL=zcode-upstream.d.ts.map