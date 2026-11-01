export interface OpencodeHarnessTool {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
}
export interface OpencodeWireTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        strict?: boolean;
    };
}
/** 只做 DSH → OpenAI 格式转换，别名统一在请求边界分配。 */
export declare function buildOpencodeTools(tools: readonly OpencodeHarnessTool[] | undefined): OpencodeWireTool[];
type RecordValue = Record<string, unknown>;
export interface OpencodeRequestShape {
    payload: RecordValue;
    /** 上游别名 → DSH 原名，仅存在于本次请求，绝不写入会话。 */
    toolAliases: ReadonlyMap<string, string>;
    toolsDisabled: boolean;
}
/**
 * 客户端工具的上游别名前缀。
 *
 * ⚠️ **唯一定义处**：响应层的剔除判据要用它区分「我们自己的产物」（`dsh_` 开头 ⇒
 * 别名表或历史重命名可能有缺陷）与「模型幻觉的名字」—— 两处各写一份字面量
 * 会在改前缀时静默漂移（本仓库已登记「一文件两套同义判据」这条判据）。
 */
export declare const ALIAS_PREFIX = "dsh_";
/** 兼容既有纯 payload 调用；生产链路用 buildOpencodeRequest 同时取回响应映射。 */
export declare function ensureFreeLaneShape(payload: RecordValue): RecordValue;
export interface OpencodePayloadInput {
    model: string;
    messages: ReadonlyArray<RecordValue>;
    system?: string;
    tools?: readonly OpencodeHarnessTool[];
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: string;
}
export declare function buildOpencodeRequest(input: OpencodePayloadInput): OpencodeRequestShape;
export declare function buildOpencodePayload(input: OpencodePayloadInput): RecordValue;
export {};
//# sourceMappingURL=opencode-messages.d.ts.map