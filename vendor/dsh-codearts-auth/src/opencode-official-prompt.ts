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
export const OPENCODE_OFFICIAL_PROMPT_TEMPLATE = `You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals.

# Harness
- Only the tools explicitly provided in this request are available. Use them when they help; never assume other tools exist.
- Responses are rendered as GitHub-flavored Markdown.
- \`<system-reminder>\` blocks are harness instructions, not user-authored content. Read and follow them.

# Communication
- Use clear file paths when referring to files.
- Keep responses clear and concise, and avoid unnecessary technical jargon.

# Working in codebases
- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.
- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.

# Your Model
- Name: {{MODELNAME}}
- Provider ID: opencode
- Model ID: {{MODEL}}
Today's date: {{DATE}}

Here is some useful information about the environment you are running in:
<env>
  Working directory: {{WORKDIR}}
</env>
`

/**
 * 工作目录常量。
 *
 * ⚠️ **必须是相对路径 `./`**，不能是本机真实路径：官方客户端不会把客户端 cwd
 * 上报给 API，而绝对路径会让模型以为自己能直接访问那个目录。
 */
const WORKDIR = './'

/**
 * 模型展示名（`big-pickle` → `Big Pickle`）。
 *
 * 按 `-` 切分后逐段首字母大写（与官方客户端的展示名口径一致）。
 */
export function opencodeDisplayName(model: string): string {
  const parts = model.split('-')
  const out: string[] = []
  for (const part of parts) {
    if (part.length === 0) continue
    out.push(part.slice(0, 1).toUpperCase() + part.slice(1))
  }
  return out.length > 0 ? out.join(' ') : model
}

/**
 * 提示词里的日期（`Sun Oct 26 2026`，UTC）。
 *
 * ⚠️ 入参化以便单测钉住：直接用 `new Date()` 写断言会随运行日漂移。
 */
export function opencodePromptDate(now: Date = new Date()): string {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const weekday = weekdays[now.getUTCDay()] ?? 'Sun'
  const month = months[now.getUTCMonth()] ?? 'Jan'
  const day = String(now.getUTCDate()).padStart(2, '0')
  return `${weekday} ${month} ${day} ${now.getUTCFullYear()}`
}

/** 渲染官方形态提示词（四个占位符全部替换）。 */
export function renderOpencodeOfficialPrompt(model: string, now: Date = new Date()): string {
  return OPENCODE_OFFICIAL_PROMPT_TEMPLATE
    .replaceAll('{{MODEL}}', model)
    .replaceAll('{{MODELNAME}}', opencodeDisplayName(model))
    .replaceAll('{{DATE}}', opencodePromptDate(now))
    .replaceAll('{{WORKDIR}}', WORKDIR)
}

/**
 * 把官方提示词与调用方（DSH）自己的 system 合并成**同一条** system 消息。
 *
 * ⚠️ **必须拼在 DSH 的 system 之前、且只产生一条 system 消息**：
 * 实测「官方提示词在、但 system 不是第一条消息」⇒ 429（见文件头的对照表）。
 * DSH 自己的提示词（含它的工具约定与身份句）**保留在后面**，不改写、不删除。
 */
export function mergeSystemWithOfficialPrompt(official: string, system?: string): string {
  const own = system?.trim() ?? ''
  return own.length > 0 ? `${official}\n\n${own}` : official
}
