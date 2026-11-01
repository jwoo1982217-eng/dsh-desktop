/**
 * OpenCode 免费通道的**内置工具集**（请求形状门禁的一部分）。
 *
 * ## 为什么是「整套」而不是只发 `read`（2026-10-27）
 *
 * 上游按「传输层指纹 + system 提示词形态 + 内置工具集」判定请求是不是官方客户端。
 * 早先的实测只确认了「只带 `read` 也能过」，于是本插件只注入一个 `read` 桩；
 * 但官方客户端实际会**整套**发送内置工具（`edit` / `glob` / `grep` / `question` /
 * `read` / `shell` / `skill` / `subagent` / `webfetch` / `websearch` / `write` /
 * `execute`），工具集本身也是形状的一部分。故改为整套发送。
 *
 * ⚠️ **描述统一换成「禁止调用」**（`RESERVED_TOOL_DESCRIPTION`）：这些工具只是
 * 形状要求，客户端（DSH）执行不了；真被模型选中也只能在响应侧剔除
 * （见 `opencode-stream.ts`）。名字与参数 schema **必须保持上游形态** ——
 * 改名、空 `properties`、缺字段都会被门禁拒绝。
 *
 * ⚠️ 工具定义里的顶层描述在发送前**恒被覆盖**，这里只保留参数 schema；
 * 原文案不参与判定，也没有必要跟着上游变。
 */
import type { OpencodeWireTool } from './opencode-messages.js';
/** 内置工具集的名字（顺序即发送顺序，与官方客户端一致）。 */
export declare const RESERVED_BUILTIN_TOOL_NAMES: readonly ["edit", "glob", "grep", "question", "read", "shell", "skill", "subagent", "webfetch", "websearch", "write", "execute"];
/** 发给上游的桩描述：明确禁止模型选中它们。 */
export declare const RESERVED_TOOL_DESCRIPTION = "Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead.";
/** 构造整套内置工具。每次返回全新对象，调用方可安全改写。 */
export declare function officialBuiltinTools(): OpencodeWireTool[];
//# sourceMappingURL=opencode-official-tools.d.ts.map