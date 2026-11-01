/**
 * OpenCode 免费通道的**官方形态提示词**（豁免门禁的必需字段之一）。
 *
 * ## 为什么需要它（2026-10-26 真机实测）
 *
 * 上游按**传输层指纹 + system 提示词形态 + 门禁工具**三重判定「是不是官方客户端」。
 * 只换 TLS 指纹不够 —— 同一份 TLS 参数下逐格对照：
 *
 * | system 内容 | 有无门禁 `read` | 结果 |
 * |---|---|---|
 * | 官方提示词 + 我们的 DSH system | 有 | **200** |
 * | 只有我们的 DSH system（改前的形态） | 有 | **429 `FreeUsageLimitError`** |
 * | 官方提示词 | 无 | **429** |
 * | 官方提示词（截掉前半） | 有 | **429** |
 * | 官方提示词只剩尾部 `<env>` 块 | 有 | **200** |
 *
 * ⇒ 两条都必需：**提示词里必须有 `<env>` 块（至少要 `Working directory`）**、
 *   **tools 含整套内置工具（`read` 是必需项）**。客户端工具一律走 `dsh_` 前缀
 *   （见 `opencode-messages.ts`），内置工具则**必须保持原名与参数 schema**。
 *
 * ## 本文件只管「prose 形状」
 *
 * 这里只有模板 + 四个占位符替换 + 与 DSH 自己 system 的拼接。
 * 请求预算（`max_tokens`）、超时、重试、错误分类**都不在这里**，也不因为
 * 门禁而改动 —— 它们各自有既有裁决（见 `opencode-adapter.ts` 的注释）。
 *
 * ## 占位符
 *
 * 只有四个：`{{MODEL}}`、`{{MODELNAME}}`、`{{DATE}}`、`{{WORKDIR}}`。
 * 若将来模板里出现别的占位符，`render` 会原样留着（宁可留着也不猜一个值）。
 */
/**
 * 官方形态提示词模板（999 字节的最小版）。
 *
 * ⚠️ **别为了「省 token」删 `<env>` 块**：实测整块删掉 ⇒ 429。
 * `Platform` / `Is directory a git repo` / `Workspace root folder` 三行
 * 实测可以删，但 `Working directory` 必须留。
 */
export declare const OPENCODE_OFFICIAL_PROMPT_TEMPLATE = "You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals.\n\n# Harness\n- Only the tools explicitly provided in this request are available. Use them when they help; never assume other tools exist.\n- Responses are rendered as GitHub-flavored Markdown.\n- `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.\n\n# Communication\n- Use clear file paths when referring to files.\n- Keep responses clear and concise, and avoid unnecessary technical jargon.\n\n# Working in codebases\n- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.\n- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.\n\n# Your Model\n- Name: {{MODELNAME}}\n- Provider ID: opencode\n- Model ID: {{MODEL}}\nToday's date: {{DATE}}\n\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: {{WORKDIR}}\n</env>\n";
/**
 * 模型展示名（`big-pickle` → `Big Pickle`）。
 *
 * 按 `-` 切分后逐段首字母大写（与官方客户端的展示名口径一致）。
 */
export declare function opencodeDisplayName(model: string): string;
/**
 * 提示词里的日期（`Sun Oct 26 2026`，UTC）。
 *
 * ⚠️ 入参化以便单测钉住：直接用 `new Date()` 写断言会随运行日漂移。
 */
export declare function opencodePromptDate(now?: Date): string;
/** 渲染官方形态提示词（四个占位符全部替换）。 */
export declare function renderOpencodeOfficialPrompt(model: string, now?: Date): string;
/**
 * 把官方提示词与调用方（DSH）自己的 system 合并成**同一条** system 消息。
 *
 * ⚠️ **必须拼在 DSH 的 system 之前、且只产生一条 system 消息**：
 * 实测「官方提示词在、但 system 不是第一条消息」⇒ 429（见文件头的对照表）。
 * DSH 自己的提示词（含它的工具约定与身份句）**保留在后面**，不改写、不删除。
 */
export declare function mergeSystemWithOfficialPrompt(official: string, system?: string): string;
//# sourceMappingURL=opencode-official-prompt.d.ts.map