/**
 * Loomy（讯飞）产品配置。
 *
 * ## 为什么新建 `LoomyProduct` 而不复用既有类型
 *
 * `BuddyProduct` / `LobsteraiProduct` / `QoderProduct` 的字段全部围绕各自
 * 协议设计（归属头、refresh 载荷、WASM 签名参数…），对 Loomy 无一有意义。
 * Loomy 需要的是：两个 base URL（账号 vs 业务）、讯飞 AccessKey、
 * 以及一张兜底模型表。故定义**平行**的接口 —— 共用的是架构**模式**
 * （产品差异收敛到单一真相源），不是那个类型。
 *
 * ## 数据来源
 *
 * - base URL / appId：官方客户端配置；公开源码保留这些协议标识。
 * - 账号应用 AccessKey：仅从本地启动环境读取，不随源码分发。
 * - 兜底模型表：2026-09-26 用本机登录态实测 `GET /api/v1/models` 取得
 *   （11 条中 `type==='chat'` 的 8 条）。
 *
 * ## ⚠️ AccessKey 的定位
 *
 * 它只用于**讯飞账号**端点（`account.xfinfr.com`）的 HMAC-SHA1 签名
 * （短信验证码登录）。业务与推理端点用的是用户登录后的 `session`，
 * 与 AccessKey 无关。AccessKey 是应用认证材料，不是用户 session；
 * 公开版本不内置它，缺少配置时在账号网络请求前明确报错。
 */
import { LOOMY_ACCOUNT_BASE, LOOMY_API_BASE } from './loomy.js';
/** 账号动作时读取本地配置；缺项提示只包含变量名，避免泄露配置值。 */
function requireLoomyEnvironment(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Loomy 账号应用访问配置缺失：请在本地启动环境设置 ${name}；未发送账号请求。`);
    }
    return value;
}
/**
 * 兜底模型目录（8 个 chat 模型）。
 *
 * 来源：2026-09-26 实测 `GET /api/v1/models`，取 `type === 'chat'` 的条目。
 * 顺序**照抄远端返回顺序**，不重排 —— 重排会让「与远端对比」这类排查失去可比性。
 *
 * ⚠️ `name` 已按 `loomyDisplayName` 规范化（远端原值是三种括号风格混用）。
 * ⚠️ `contextWindow` 用远端 `context_length`。`spark-x` 是**已知分歧**：
 * 远端声明 1048576，而 Loomy 客户端用本地表
 * `MODEL_CONTEXT_OVERRIDES = { 'spark-x': 262144 }` 强制降到 262144。
 * 本表**先采信远端**；若实测长上下文被拒，改为 262144（见设计文档 §11）。
 */
/**
 * 实测的思考档位（8 个 chat 模型**完全一致**，2026-09-28 用真实凭据采集）。
 *
 * ⚠️ 抽成常量而不是逐条写 8 遍：远端对全部 chat 模型下发同一份档位，
 * 逐条重复只会让将来上游变更时漏改其中几条。
 * ⚠️ 远端可用时**优先用远端的 `reasoning_efforts`**，本常量只在远端整体失败时
 * 顶替（与 `contextWindow` 同策略）。
 */
const LOOMY_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];
/**
 * 本插件选用的默认档位（**用户要求 `high`**）。
 *
 * ⚠️ 远端 `default_reasoning_effort` 声明的是 **`low`**，这里**有意不沿用** ——
 * DSH 的「用户没选时发哪个档」完全取适配器声明的 `defaultEffort`
 * （见 `loomy-adapter.ts` 的 `LOOMY_PREFERRED_DEFAULT_EFFORT` 说明）。
 * 兜底表与适配器常量必须一致，否则「远端可用」与「远端失败」两条路径默认档不同。
 */
const LOOMY_DEFAULT_EFFORT = 'high';
const LOOMY_FALLBACK_MODELS = [
    { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731 · x3.0', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'MiniMax-M3', name: 'MiniMax M3 · x4.0', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'Kimi-k2.6', name: 'Kimi k2.6 · x6.5', contextWindow: 262_144, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'qwen-3.8-max', name: 'Qwen 3.8 Max · x12.0', contextWindow: 1_000_000, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash · x0.8', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'qwen3.8-flash', name: 'qwen 3.8 flash · x0.8', contextWindow: 1_000_000, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'spark-x', name: 'Spark X2.5 · x0.1', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
    { id: 'mimo-v2.5', name: 'MiMo V2.5 · x3.3', contextWindow: 1_048_576, efforts: [...LOOMY_EFFORTS], defaultEffort: LOOMY_DEFAULT_EFFORT },
];
/**
 * Loomy provider 配置。
 */
export const LOOMY = {
    id: 'loomy',
    displayName: 'Loomy (讯飞)',
    apiBase: LOOMY_API_BASE,
    accountBase: LOOMY_ACCOUNT_BASE,
    // 延迟读取：未配置 Loomy 时仍可载入插件和使用其他供应商。
    get accessKeyId() { return requireLoomyEnvironment('CMDC_PAK_LOOMY_ACCESS_KEY_ID'); },
    get accessKeySecret() { return requireLoomyEnvironment('CMDC_PAK_LOOMY_ACCESS_KEY_SECRET'); },
    appId: 'GM3LOOMY',
    defaultCredentialRef: 'LOOMY_ACCESS_TOKEN',
    fallbackModels: LOOMY_FALLBACK_MODELS,
};
/** 全部 Loomy 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_LOOMY_PRODUCTS = [LOOMY];
/**
 * 按 provider id 取 Loomy 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）/ `lobsteraiProductById` 等分开：
 * 各自返回**不同类型**，合并会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function loomyProductById(id) {
    return ALL_LOOMY_PRODUCTS.find((product) => product.id === id);
}
//# sourceMappingURL=loomy-product.js.map