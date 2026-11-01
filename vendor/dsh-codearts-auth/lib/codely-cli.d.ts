/**
 * 驱动**官方 Codely CLI**（`codely.exe`）执行推理。
 *
 * ## ⚠️⚠️ 为什么是「驱动官方进程」而不是自己发 HTTP
 *
 * 推理网关 `codely-litellm.tuanjie.cn` 要求 `X-Codely-Signature`（HMAC），
 * 签名密钥藏在官方客户端的编译产物里 —— 2026-10-20 已穷尽五种手段均未取得
 * （详见 `codely-adapter.ts` 模块头的清单）。与其伪造一个注定 401 的请求，
 * 不如**让官方客户端自己签名**：它本来就带着合法凭据与签名逻辑，我们只需要
 * 它的输出。同一取舍在 `qoder-machine.ts` 里有过先例（「复刻代价高且属重复
 * 造轮子，直接读更可靠」）。
 *
 * 2026-10-20 实测（`codely --help` 与真跑各一次）：
 *
 * ```
 * codely --output-format stream-json -m codely-core --approval-mode yolo --prompt "Say OK"
 * → {"type":"init","session_id":"…","model":"codely-core"}
 *   {"type":"message","role":"user","content":"Say OK","delta":false}
 *   {"type":"message","role":"assistant","content":"OK","delta":true}
 *   {"type":"result","status":"success","stats":{"total_tokens":…,"duration_ms":…}}
 * ```
 *
 * ## 形态与代价（**已知且已被用户接受**，2026-10-20 拍板）
 *
 * - **依赖本机安装**：默认路径见 {@link DEFAULT_CODERLY_CLI_PATH}，可用
 *   `DSH_CODERLY_CLI_PATH` 覆盖；找不到时**明确报错**，不退化成静默空流。
 * - **凭据是 CLI 自己的登录态**（`~/.codely-cli/oauth_creds.json`），
 *   **不是**本插件账号池里的那份 ⇒ 推理侧的换号 / 多账号在 CLI 模式下不成立
 *   （积分、签到仍走插件自己的凭据，不受影响）。
 * - **每次请求起一个进程**（实测端到端 ~3.1s，含进程启动）。
 * - **审批模式由调用方给**：`--approval-mode yolo` 允许 CLI 读写文件、执行命令
 *   —— 这是拍板选的「更接近官方 CLI 的体验」；换成 `ask` 即只读。
 *
 * ## 本模块刻意不做的两件事
 *
 * - **不转发 `reasoning_content`**：实测思考内容是独立字段且正文照常产出，
 *   混进正文会让回答带上思维链噪声（本仓库对「编造读数」一贯说不，这里
 *   选择**丢弃**而不是假装它是正文）。
 * - **不解析工具事件**：工具由 CLI 自己调度执行，本插件只消费最终文本。
 */
/** 覆盖 CLI 路径的环境变量（本机装到别处时用）。 */
export declare const CODERLY_CLI_PATH_ENV = "DSH_CODERLY_CLI_PATH";
/** 官方 CLI 的默认安装路径（实测本机位置）。 */
export declare const DEFAULT_CODERLY_CLI_PATH = "D:\\Program File\\Tuanjie Cowork\\cli\\bin\\win32-x64\\codely.exe";
/**
 * CLI 审批模式。
 *
 * - `yolo`：允许读写文件、执行命令（**默认，用户 2026-10-20 拍板**）；
 * - `ask`：只读问答，CLI 不执行任何工具。
 */
export type CodelyCliApprovalMode = 'yolo' | 'ask';
/** 子进程的最小接口（真实 `ChildProcess` 满足它；测试注入假实现）。 */
export interface CodelyCliChild {
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    on(event: 'exit', listener: (code: number | null) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    kill(signal?: NodeJS.Signals): unknown;
}
/** spawn 的抽象（默认走 `node:child_process` 的 {@link spawn}）。 */
export type CodelyCliSpawner = (file: string, args: readonly string[], options: {
    cwd: string;
    windowsHide: boolean;
}) => CodelyCliChild;
/** CLI 结束时的用量统计（字段来自实测 `result.stats`，缺席即不填）。 */
export interface CodelyCliStats {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    durationMs?: number;
    toolCalls?: number;
}
/** CLI 输出事件（只保留适配器用得到的两种）。 */
export type CodelyCliEvent = 
/** 助手正文增量（`content` 非空时才有）。 */
{
    type: 'delta';
    text: string;
}
/** CLI 正常收尾（`status:"success"`）。 */
 | {
    type: 'result';
    stats: CodelyCliStats | undefined;
};
export interface CodelyCliRunOptions {
    /** 要发给模型的文本（多轮历史由调用方文本化后传入，见适配器）。 */
    prompt: string;
    /** 模型 id（原样传给 `-m`）。 */
    model: string;
    /** CLI 可执行文件路径；缺省时按环境变量 → 默认路径解析。 */
    cliPath?: string;
    /** 工作目录（CLI 的工具在此目录内工作）；缺省 `process.cwd()`。 */
    cwd?: string;
    /** 审批模式，缺省 `yolo`。 */
    approvalMode?: CodelyCliApprovalMode;
    /** 环境变量源（测试注入）；缺省 `process.env`。 */
    env?: NodeJS.ProcessEnv;
    /** 注入的 spawner（测试用）；缺省真 spawn。 */
    spawner?: CodelyCliSpawner;
    /** 取消信号：触发时杀掉子进程。 */
    signal?: AbortSignal;
}
/**
 * 解析 CLI 路径：环境变量 → 默认路径 → 不存在则返回 `undefined`。
 *
 * ⚠️ 环境变量优先是为了让「装到别处」的用户自助修好，而不是改代码；
 *    默认路径**存在性**要真检查（`existsSync`）——直接 spawn 一个不存在的路径
 *    只会拿到一个含义模糊的 ENOENT。
 */
export declare function resolveCodelyCliPath(env?: NodeJS.ProcessEnv): string | undefined;
/** 构造 CLI 参数（顺序与实测一致）。 */
export declare function buildCodelyCliArgs(options: {
    model: string;
    prompt: string;
    approvalMode?: CodelyCliApprovalMode;
}): string[];
/**
 * 跑一次 CLI 并逐块产出事件。
 *
 * ⚠️ 出错一律**抛出**，绝不返回空流：静默空流会让上层显示「模型没说话」，
 * 而真实原因是 CLI 没装 / 没登录 / 模型不被允许 —— 那是本仓库明令禁止的
 * 静默失效形态（autoclaw 与 officeace 都记过同款）。
 */
export declare function runCodelyCli(options: CodelyCliRunOptions): AsyncGenerator<CodelyCliEvent>;
//# sourceMappingURL=codely-cli.d.ts.map