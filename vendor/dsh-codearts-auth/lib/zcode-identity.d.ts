/**
 * 官方 ZCode 的 system 身份块（**3012 准入的唯一开关**）。
 *
 * ## 为什么必须内置这段文本
 *
 * 上游对 `/zcode-plan/anthropic` 通道做**请求体内容检查**：`system` 字段
 * 缺少官方的身份块结构时，直接返回
 * `\{"code":3012,"msg":"request has been blocked due to unusual activity."\}`（实测）。
 *
 * 实测矩阵（同账号、同 captcha 来源）：
 *
 * | system 内容 | 字符数 | 结果 |
 * |---|---|---|
 * | 无 system | 0 | ✗ 405 + `3012` |
 * | 仅 cliPrefix | 42 | ✗ 405 + `3012` |
 * | **cliPrefix + stable（全部三段）** | **2898** | **✓ 200** |
 * | 完整四块（含 dynamic 段） | 7599 | ✓ 200 |
 *
 * ⇒ **判据是「身份块是否存在」**，不是「块数多少」或「字符数够不够」，
 * 也与 HTTP 头、运行时（Electron / curl / Node）无关。上游 curl 带完整块同样 200。
 *
 * ⚠⚠⚠ **上面这两句已被 2026-10-25 的对照实验推翻一半，改本文件前必须连它一起读**
 * （见 {@link buildZcodeSystemBlocks} 头注释的表）：身份块**仍**是必要条件
 * （缺了必然 405），但「**块数不是判据**」是**错的** —— 在 3 块之上再追加第 4 块
 * 会让请求**必然** 405 + 3012，且与第 4 块的长度无关。⇒ 现行不变量是
 * 「**system 恒为官方的 3 类**」，调用方 system 走 messages。
 * 保留原文只为留下「这条结论曾经怎么来的」；**不要**据此把第 4 块加回来。
 *
 * ⚠⚠ **2026-10-03 复测修正了两条旧说法**（issue IKJI0Y 驱动，本机三个账号、
 * 17 次请求）。**改本文件前先读那两条**：
 *
 * 1. **HTTP 状态码是 `405`**，不是 `403`。排查时别按 403 找。
 * 2. **日期块在这个窗口不是判据**（`withContextPrefix` 去掉照样 200）。
 *    它仍照发（官方如此、零成本），但它与身份块是**必要非充分**的关系，
 *    ❌ **不要再把它写成「3012 的最后一个开关」当成唯一结论** ——
 *    那句来自早期窗口，见 {@link withContextPrefix}。
 *    本次逐项排除的**非判据**还有：HTTP 头、版本头（`3.14.3`/`3.14.4`/`4.0.0`）、
 *    请求频率（单账号无间隔连发 6 发）、多轮历史（`tool_use`/`tool_result`）、
 *    `tools` 声明、账号池中的其它账号。完整矩阵见 README 的 ZCode 章节。
 *
 * ⚠ 即便如此，「身份块达标仍 3012」**目前没有已知解释**。遇到时的可观测信息
 * 由 `src/zcode-diagnostics.ts` 打进错误文案（账号序号 / 计数 / 间隔 /
 * **实测**身份块字符数 / 日期块有无），诊断行**不含任何凭据**。
 *
 * ## ⚠ 维护警告（来自 `dsh-free-glm/patches/zcode-official-identity.ts`）
 *
 * 上游策略与此结构**强耦合**：官方客户端升级后若改变身份块结构，
 * 需要同步更新本文件，否则会重新出现 3012 —— 而
 * **3012 有账号冷却惩罚**（30 分钟；24h 内第 3 次起 24h；**5 次停用**）。
 * **不要为了调试反复触发。**
 *
 * ## 本文件里的文本从哪来
 *
 * `dsh-free-glm/patches/zcode-official-identity.ts` 从同类项目
 * `a137460387/zcode2api` 的 `src/upstream/zcode-system.json` 提取，
 * 该项目由官方 3.11.2 bundle 反解。本仓库按**程序化提取**（esbuild 编译后
 * 读常量再字面量化）落地，避免手抄引入偏差。
 *
 * ⚠ **2026-10-25 已按官方新版重新提取一次** —— 那次正是本节警告的应验：
 * 官方 2026-10-23 升级客户端后，stable 段从「identity + desktop + `# Working style`」
 * （2856 字符）变成「identity + desktop（新增 `### Interactive views`）」
 * （2590 字符，官方 bundle 里 `# Working style` 出现 0 次）。
 * 旧文本在线上表现为 `HTTP 405 · request has been blocked due to unusual activity`。
 *
 * 提取方式（可复现）：从官方 bundle
 * `D:\ZCode\resources\glm\zcode.cjs` 里读
 * `oua`（cliPrefix 常量）、`d0o`（安全声明）、`okn()`（Harness 块）、
 * `Ekn()`（`Pda("ZCode Desktop Context","desktop_context",[…])`），
 * 按 `assembleSystemMessages` 的拼法还原。**不要再改回手抄文本。**
 */
/** 第一块：CLI 身份前缀（官方以此开头，42 字符）。 */
export declare const OFFICIAL_CLI_PREFIX: string;
/**
 * 第二块：stable 段（多段用 `\n\n` 连接）。
 *
 * ⚠ 只发**准入必需**的部分。官方完整身份块还含 5KB 的 dynamic 段
 * （`# Communicating with the user` / `# Context management`），
 * 那些是**给 ZCode 内 coding agent 的行为指令**，与准入无关 ——
 * 且它们会被放在 system 开头，**压过调用方（DSH）自己的 prompt**，
 * 表现为「啰嗦、慢」。故此处不含 dynamic 段。
 */
export declare const OFFICIAL_STABLE_SECTIONS: readonly string[];
/** 官方预期的 `cliPrefix + stable` 合计长度（供自检与单测断言）。 */
export declare const OFFICIAL_IDENTITY_CHARS = 2632;
/** Anthropic Messages 的内容块（ZCode 只接受 `text` 块）。 */
export interface ZcodeTextBlock {
    type: 'text';
    text: string;
    cache_control?: {
        type: 'ephemeral';
    };
}
/**
 * 构造官方形态的 `system` 块数组。
 *
 * ## 结构（逐字复刻官方，**不要"优化"**）
 *
 * ```
 * block[0] = cliPrefix（42 字符）          ← 准入必需
 * block[1] = stable（2590 字符）           ← 准入必需
 * block[2] = "# Environment" 段
 * ```
 *
 * ⚠ **恒为 3 块，绝不多也不少。**
 *
 * ## ★ 为什么不把调用方的 system 追加进来（2026-10-25 实测修复）
 *
 * 本函数**此前**会把 `callerSystem` 追加成 `block[3]`，注释里写的理由是
 * 「官方身份块必须处在开头位置」。**那个理由是错的** —— 上游的判据不是
 * 「身份块在开头」，而是「**system 数组的形状像不像官方客户端**」。
 *
 * 三轮对照实验（同一时间、同一账号、同一 URL 与全部 18 个请求头，
 * 只改请求体）：
 *
 * | system 块数 | 请求体 | 结果 |
 * |---|---|---|
 * | 3 块 `42 + 2590 + 275` | 只有一句话 | **HTTP 200** |
 * | 4 块（第 4 块 = caller system） | 同上 | **HTTP 405 + 3012** |
 * | 3 块（caller system 改放进 messages） | 同上 | **HTTP 200** |
 *
 * 追加的第 4 块**与它的长度无关**：2 062 字符照样 405，25 428 字符也 405 ——
 * 只要它在，就 405。而把它挪进首轮 user 消息后，模型**照样读到了**那段约定
 * （实测 thinking 里明确复述「The user has set up a workspace convention
 * specifying Simplified Chinese」），**功能没有任何损失**。
 *
 * ⇒ 结论：**调用方内容走 messages，system 恒为官方的 3 类。**
 * 注入见 {@link withCallerSystem}。
 *
 * ⚠ 只有**最后一块**带 `cache_control: {type:'ephemeral'}`。
 *
 * @param options.cwd  工作目录。
 *        官方实现声明「cwd is never "unknown" in real traffic」，
 *        故调用方必须给真值。
 * @param options.provider 展示用的 provider id（进 environment 段）。
 * @param options.model 模型名（进 environment 段的 poweredByLine）。
 */
export declare function buildZcodeSystemBlocks(options: {
    cwd: string;
    provider?: string;
    model?: string;
    platform?: string;
    osVersion?: string;
}): ZcodeTextBlock[];
/**
 * 构造官方形态的 `# Environment` 段。
 *
 * 官方每个会话都会告诉模型它的运行环境。不发的实测后果：
 * 问「Which model are you?」只能答出笼统的 "GLM" —— 因为它**没被告知**
 * 自己在 `zcode/glm-5.3-flash`、也不知道工作目录与平台。
 *
 * 这不只是自我认知问题：不知道 `Platform` / `Shell` 会以为该给 bash 命令
 * （而这里是 PowerShell），不知道工作目录会用相对路径瞎猜。
 */
export declare function buildEnvironmentSection(options: {
    cwd: string;
    provider?: string;
    model?: string;
    platform?: string;
    osVersion?: string;
}): string;
/** 本地时区的 ISO 日期（官方用本地日期，**不是** UTC）。 */
export declare function formatLocalIsoDate(date?: Date): string;
/**
 * 构造 `<system-reminder>` 上下文块。
 *
 * ⚠ 形态细节（逐字复刻，不要"优化"）：
 * - 整块是**一个** `{type:'text'}`，插到 `content` **数组**最前面 ——
 *   不是拼进文本字符串（后者会改变结构，仍被判为裸请求）
 * - `outro` 前有 **6 个空格**缩进
 * - 空行由 `join('\n')` 里的空串产生
 * - 日期用**本地时区**的 ISO 日期
 */
export declare function buildContextPrefixBlock(now?: Date): ZcodeTextBlock;
/**
 * 给**首轮 user 消息**的 content 数组最前面插入日期块。
 *
 * 规则（官方行为）：
 * - 只处理第一条消息，且它必须是 `role === 'user'`
 * - **幂等**：已以 `<system-reminder>` 开头则不重复插
 * - 纯文本 content 会被转成块数组（官方就是数组形态）
 *
 * ⚠ `callerSystem` 见 {@link withCallerSystem} —— 它同样插在首轮 user 消息上，
 * 但**排在日期块之后**（官方形态是日期块打头）。
 */
export declare function withContextPrefix<T extends {
    role: string;
    content: unknown;
}>(messages: readonly T[], now?: Date): Array<Record<string, unknown>>;
/**
 * 把调用方的 system（DSH 的完整 prompt / AGENTS.md 规则）作为**首轮 user
 * 消息的一个 text 块**注入。
 *
 * ## ★ 为什么不放进 `system` 数组（2026-10-25 实测）
 *
 * 见 {@link buildZcodeSystemBlocks} 头注释的对照实验表：把调用方内容追加成
 * `system[3]` 会让请求**必然**收到 `405 + 3012 unusual activity`，
 * 而与它多长无关（2 KB 与 25 KB 一样 405）；改成注入 messages 后同一请求
 * **200**，且模型照样遵循了那段约定。
 *
 * ## 形态（与日期块同族的做法）
 *
 * - 插到**首轮 user 消息** `content` 数组的**末尾之后**（若已有日期块，
 *   排在它后面；否则排在最前）
 * - 纯文本 content 转成块数组
 * - 空 / 纯空白 ⇒ 原样返回（不塞空块）
 * - **幂等**：调用方内容已存在则不重复插
 *
 * ## ⚠⚠ 首条不是 user 时：退化为「插到**第一条 user 消息**」
 *
 * 改前这里是 `if (first.role !== 'user') return out` —— 也就是说 DSH 的整份
 * system（含 `AGENTS.md` 规则）会**静默蒸发**，无日志、无报错（2026-10-25 审计）。
 * 而改前它进 `system[]` 时与首条 role **无关**，任何形态都不会丢 ⇒ 这是本修法
 * 引入的**能力回退**，必须补上。
 *
 * ⇒ 现在的语义：
 * - 首条是 user ⇒ 插首条（既有行为）；
 * - 首条不是 user ⇒ 插**第一条 user 消息**；
 * - 一条 user 消息都没有 ⇒ 仍然原样返回（没有合法落点，无从注入；此时
 *   `serializeMessages` 那条路径本身也产不出可用的对话）。
 */
export declare function withCallerSystem(messages: readonly Record<string, unknown>[], callerSystem: string | undefined): Array<Record<string, unknown>>;
//# sourceMappingURL=zcode-identity.d.ts.map