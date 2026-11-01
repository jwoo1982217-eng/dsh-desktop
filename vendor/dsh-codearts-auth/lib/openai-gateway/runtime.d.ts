import type { ApiKeySource } from './auth.js';
import { type OpenAiGateway } from './server.js';
import type { RpcGatewayLastError } from '../types.js';
/**
 * 网关的**运行时控制面**：让 Jet Hub 设置页能在不重启 DSH 的情况下启停网关。
 *
 * ## 为什么用模块级单例
 *
 * `registerJetHubRpc()` 在 `src/index.ts` 里**先于** `mountOpenAiGateway()`
 * 被调用（前者要拿到账号池，后者要挂 HTTP server），所以 RPC 层拿不到网关实例
 * 本身。改调用顺序会把「RPC 装配」和「网关启停」耦在一起，收益很小。
 *
 * 因此这里只暴露**工厂 + 期望状态**，由 `mountOpenAiGateway()` 把自己注册进来，
 * RPC 层只负责改「期望状态」并请求收敛。两侧不需要互相持有引用。
 *
 * ## 开关的两个来源，谁说了算
 *
 * - `DSH_OPENAI_GATEWAY_ENABLED`：进程级、运维口径，**优先级更高**；
 * - 持久化的 `gatewayEnabled`：设置页里的用户选择。
 *
 * 实际运行条件是二者的**与**。所以 `DSH_OPENAI_GATEWAY_ENABLED=0` 时，
 * 设置页里即便显示为「已打开」，网关也不会监听端口 —— 这与「显式停用就是
 * 停用」的直觉一致，也避免了 env 一关、UI 一开就悄悄恢复监听的意外。
 */
/**
 * 由 `mountOpenAiGateway` 注册，用于按需创建网关实例。
 *
 * ⚠️ 契约要求**永不抛出**：工厂体内会同步执行 `resolveGatewayConfig()`（端口
 * env 非法即抛）与 `loadOrCreateApiKey()`（home 不可写即抛），这些都必须由
 * 工厂自己记日志并返回 `undefined`，不能冒泡到这里 —— 这里是设置页同步
 * handler 的下游，抛出去会变成用户可见的报错。
 */
type GatewayFactory = () => OpenAiGateway | undefined;
/**
 * 注册网关实例工厂（由 `mountOpenAiGateway` 调用，只应注册一次）。
 *
 * 这里顺手把实例的密钥记到 {@link lastApiKey}：工厂是唯一会创建实例的地方，
 * 在这里捕获就保证「设置页读到的 key」与「网关在用的 key」**必然**同源 ——
 * 多开一条读密钥的通道就有可能读到不一致的那份，症状是复制出去一律 401。
 */
export declare function registerGatewayFactory(create: GatewayFactory): void;
/** 读取用户选择的期望状态。 */
export declare function gatewayDesiredEnabled(): boolean;
/** 记录用户选择的期望状态（**不**启停，由 {@link applyGatewayDesiredState} 收敛）。 */
export declare function setGatewayDesiredEnabled(enabled: boolean): void;
/** 读取「允许局域网访问」的期望状态。 */
export declare function gatewayDesiredAllowLan(): boolean;
/** 记录「允许局域网访问」的期望状态（**不**重建实例，由收敛完成换绑）。 */
export declare function setGatewayDesiredAllowLan(allowLan: boolean): void;
/** 网关当前是否真的在监听端口。 */
export declare function isGatewayRunning(): boolean;
/** 网关当前实际监听的地址；未运行时返回 `undefined`（设置页据此显示端口）。 */
export declare function gatewayAddress(): {
    host: string;
    port: number;
} | undefined;
/**
 * 网关正在使用的密钥来源（值 + 文件路径 + 是否来自环境变量）。
 *
 * 密钥在 `createOpenAiGateway()` 时就已解析，因此**网关未运行时也能返回** ——
 * 用户恰恰需要在停用状态下就能复制 key 去配外部客户端。
 *
 * ⚠️ 拿不到时返回 `null`（网关被 env 停用、初始化失败、或还没创建实例），
 * 由调用方决定如何提示；**不要**在这里造一个占位 key，那会让用户复制到一个
 * 永远 401 的串。
 */
export declare function gatewayApiKey(): ApiKeySource | null;
/**
 * 把实际运行状态收敛到期望状态。
 *
 * 幂等：已是目标状态时什么都不做，因此 RPC 与插件启动路径都能放心调用。
 * 启动失败（端口冲突等）只记日志并把 `running` 复位，**不抛**——调用方是
 * 设置页的同步 handler，抛错会变成用户可见的报错弹窗，而网关失败本来就不该
 * 影响 Jet Hub 其它功能。
 *
 * ⚠️ **host 也是期望状态的一部分**（v7，2026-10-20）：「允许局域网访问」开关
 * 翻转会改变监听地址，而 `listen()` 的绑定地址在创建时定格——改绑只能**关闭
 * 旧实例再重建**。收敛判据必须与工厂**同源**（`isGatewayHostFromEnv` 参与
 * 计算）：env 显式给了 host 时开关不生效，期望通配恒为 `false`，此时若拿
 * `desiredAllowLan` 裸比较，会因「重建后仍绑 env 地址」而**永远失配、反复重建**。
 *
 * ⚠️ **本函数必须可重入**（Issue #11 审计发现）：用户连点开关时两次收敛会重叠，
 * 而原实现是「读 `running` → 置 `undefined` → `await close()` → 重建」，两次
 * 调用会各自持有一个旧实例、各自重建，实测事件序列为
 * `close#1:begin → start#2 → close#1:end → start#3`（**start 2 次、close 只
 * 完成 1 次**）⇒ 第一个实例被永久泄漏。修法是把整个收敛体串行化。
 */
export declare function applyGatewayDesiredState(): Promise<void>;
/**
 * 最近一次收敛留下的「期望运行但未监听」原因（`null` = 无异常）。
 *
 * ⚠️ 与 `isGatewayRunning()` 配对使用：`running === false` 且本值为 `null`
 * 表示「用户/env 主动关闭」，非 `null` 才是异常 —— 面板据此区分两种「没在跑」。
 */
export declare function gatewayLastError(): RpcGatewayLastError | null;
/** 插件卸载时调用：停掉网关并清空工厂，避免热重载后残留旧实例的引用。 */
export declare function disposeGatewayRuntime(): Promise<void>;
export {};
//# sourceMappingURL=runtime.d.ts.map