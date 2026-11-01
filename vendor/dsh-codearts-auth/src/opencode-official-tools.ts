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
import type { OpencodeWireTool } from './opencode-messages.js'

/** 内置工具集的名字（顺序即发送顺序，与官方客户端一致）。 */
export const RESERVED_BUILTIN_TOOL_NAMES = [
  'edit', 'glob', 'grep', 'question', 'read', 'shell', 'skill', 'subagent', 'webfetch', 'websearch', 'write', 'execute'
] as const

/** 发给上游的桩描述：明确禁止模型选中它们。 */
export const RESERVED_TOOL_DESCRIPTION = 'Reserved for the host runtime; do not call or select this function. Use tools explicitly supplied by the user instead.'

/**
 * 参数 schema 常量。**只读**：每次构造请求都深拷贝一份，避免调用方改坏共享对象。
 * 键顺序、`required`、`additionalProperties`、`strict` 都按官方形态保留。
 */
const BUILTIN_TOOL_PARAMETERS = {
  edit: {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "File to edit"
      },
      "oldString": {
        "type": "string",
        "description": "Exact text to find and replace"
      },
      "newString": {
        "type": "string",
        "description": "Text to replace oldString with (must differ from oldString)"
      },
      "replaceAll": {
        "type": "boolean",
        "description": "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false."
      }
    },
    "required": [
      "path",
      "oldString",
      "newString"
    ],
    "additionalProperties": false
  },
  glob: {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "Glob pattern to match files against"
      },
      "path": {
        "type": "string",
        "description": "Directory to search. Defaults to the current working directory."
      },
      "hidden": {
        "type": "boolean",
        "description": "Include hidden files and directories (default: false)."
      },
      "limit": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "description": "Maximum number of matching files to return (default: 100)"
      }
    },
    "required": [
      "pattern"
    ],
    "additionalProperties": false
  },
  grep: {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "minLength": 1,
        "description": "Regular expression or literal text to match in file contents."
      },
      "path": {
        "type": "string",
        "description": "File or directory to search. Defaults to the current working directory."
      },
      "include": {
        "type": "string",
        "description": "Glob pattern to filter files (for example, \"*.js\" or \"*.{ts,tsx}\")"
      },
      "literal": {
        "type": "boolean",
        "description": "Treat `pattern` as exact text instead of a regular expression (default: false)."
      },
      "caseSensitive": {
        "type": "boolean",
        "description": "Use case-sensitive matching (default: true)."
      },
      "limit": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "description": "Maximum number of matching lines to return (default: 100)"
      }
    },
    "required": [
      "pattern"
    ],
    "additionalProperties": false
  },
  question: {
    "type": "object",
    "properties": {
      "questions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "question": {
              "type": "string",
              "description": "Complete question"
            },
            "header": {
              "type": "string",
              "description": "Very short label (max 30 chars)"
            },
            "options": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "label": {
                    "type": "string",
                    "description": "Display text (1-5 words, concise)"
                  },
                  "description": {
                    "type": "string",
                    "description": "Explanation of choice"
                  }
                },
                "required": [
                  "label",
                  "description"
                ],
                "additionalProperties": false
              },
              "description": "Available choices"
            },
            "multiple": {
              "type": "boolean"
            }
          },
          "required": [
            "question",
            "header",
            "options"
          ],
          "additionalProperties": false
        },
        "minItems": 1,
        "description": "Questions to ask"
      }
    },
    "required": [
      "questions"
    ],
    "additionalProperties": false
  },
  read: {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "File or directory to read"
      },
      "offset": {
        "type": "integer",
        "minimum": 0,
        "description": "The line or directory entry to start reading from (1-based)"
      },
      "limit": {
        "type": "integer",
        "minimum": 0,
        "description": "The maximum number of lines or directory entries to read (defaults to and capped at 2000)"
      }
    },
    "required": [
      "path"
    ],
    "additionalProperties": false
  },
  shell: {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "Shell command string to execute"
      },
      "workdir": {
        "type": "string",
        "description": "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."
      },
      "timeout": {
        "type": "integer",
        "minimum": 0,
        "description": "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."
      },
      "background": {
        "type": "boolean",
        "description": "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."
      }
    },
    "required": [
      "command"
    ],
    "additionalProperties": false
  },
  skill: {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "description": "The ID of an available skill or a skill explicitly referenced by the user"
      }
    },
    "required": [
      "id"
    ],
    "additionalProperties": false
  },
  subagent: {
    "type": "object",
    "properties": {
      "agent": {
        "type": "string",
        "description": "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead."
      },
      "description": {
        "type": "string",
        "description": "A short 3-5 word label for the task, displayed to the user"
      },
      "prompt": {
        "type": "string",
        "description": "The task for the subagent to perform"
      },
      "model": {
        "type": "string",
        "description": "NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as \"providerID/modelID\", or \"providerID/modelID#variant\" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first."
      },
      "sessionID": {
        "type": "string",
        "pattern": "^ses",
        "description": "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation."
      },
      "background": {
        "type": "boolean",
        "description": "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress."
      }
    },
    "required": [
      "agent",
      "description",
      "prompt"
    ],
    "additionalProperties": false
  },
  webfetch: {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "The HTTP or HTTPS URL to fetch content from"
      },
      "format": {
        "type": "string",
        "enum": [
          "text",
          "markdown",
          "html"
        ],
        "description": "The format to return the content in. Defaults to markdown."
      },
      "timeout": {
        "type": "number",
        "exclusiveMinimum": 0,
        "maximum": 120,
        "description": "Optional timeout in seconds (maximum: 120)"
      }
    },
    "required": [
      "url"
    ],
    "additionalProperties": false
  },
  websearch: {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Websearch query"
      }
    },
    "required": [
      "query"
    ],
    "additionalProperties": false
  },
  write: {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Path to the file to write to"
      },
      "content": {
        "type": "string",
        "description": "Content to write to the file"
      }
    },
    "required": [
      "path",
      "content"
    ],
    "additionalProperties": false
  },
  execute: {
    "type": "object",
    "properties": {
      "code": {
        "type": "string"
      }
    },
    "required": [
      "code"
    ],
    "additionalProperties": false
  },
} as const

/** 构造整套内置工具。每次返回全新对象，调用方可安全改写。 */
export function officialBuiltinTools(): OpencodeWireTool[] {
  return RESERVED_BUILTIN_TOOL_NAMES.map((name) => ({
    type: 'function',
    function: {
      name,
      description: RESERVED_TOOL_DESCRIPTION,
      parameters: structuredClone(BUILTIN_TOOL_PARAMETERS[name] as Record<string, unknown>),
      strict: false,
    },
  }))
}
