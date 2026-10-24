# AutoClaw 核心模型规格与调用清单 (Model Catalog)

> 本文档通过智谱官方生产配置端点（`GET /autoclaw-proxy/proxy/autoclaw-model-config` 与 `GET /autoclaw-proxy/proxy/third-party-provider-config`）实测探测提取，记录 AutoClaw 平台全部可用模型的真实参数、上下文窗口规格、调用标识与场景建议。

---

## 1. 核心模型参数总览表

| 序号 | 外部调用标识 (Gateway ID) | 内部模型 ID (Model ID) | 显示名称 | 真实输入上下文 (Context Window) | 最大输出 Token (Max Tokens) | 思考链 (Reasoning) | 输入模态 (Modalities) | 积分消耗等级 | 推荐使用场景 |
| :---: | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **1** | **`autoclaw/zai_glm-5.3-flash`** | `zai_glm-5.3-flash` | **GLM-5.3 Flash** | **1,048,576 (1M)** | **131,072 (128K)** | ✅ 支持 | 纯文本 | **极低 (扣点)** | **主力推荐**：日常 Agent 对话、快速代码补全、长文档检索，速度极快 |
| **2** | **`autoclaw/zaicoding_glm-5.3`** | `zaicoding_glm-5.3` | **GLM-5.3 Coding** | **1,048,576 (1M)** | **307,200 (300K)** | ✅ 支持 | 纯文本 | 高 | **代码特化**：复杂工程重构、跨文件架构分析、超长代码生成（支持 300K 超长输出） |
| **3** | **`autoclaw/zai_auto`** | `zai_auto` | **AutoClaw Auto** | **1,048,576 (1M)** | **393,216 (384K)** | ✅ 支持 | 纯文本 | 高 | **智能路由**：官方根据任务难度自动分流（底层调度 deepseek-v4-pro 等旗舰），超大输出上限 |
| **4** | **`autoclaw/zai_auto-fast`** | `zai_auto-fast` | **AutoClaw Auto Fast** | **1,048,576 (1M)** | **131,072 (128K)** | ✅ 支持 | **文本 + 图片** | 中 | **多模态与极速**：支持传入图片/UI设计图进行多模态视觉理解与代码还原 |

---

## 2. 各模型深度规格详情

### 2.1 `zai_glm-5.3-flash`（主力低消耗模型）
* **定位**：高性价比主力模型，兼顾超低延迟与超长上下文。
* **输入窗口**：**1,048,576 Tokens（1M）**。
* **输出限制**：**131,072 Tokens（128K）**。
* **思考能力（Reasoning）**：支持。在流式输出中会优先吐出 `reasoning_content`，随后输出最终答案 `content`。
* **扣减机制**：依然走统一积分钱包扣减（实测每次请求扣减约 1 点积分），并非脱离钱包的免费模型；钱包积分耗尽后同样会被限制。

### 2.2 `zaicoding_glm-5.3`（全新旗舰 Coding 模型）
* **定位**：专为复杂软件开发与长代码仓库级任务设计。
* **输入窗口**：**1,048,576 Tokens（1M）**。
* **输出限制**：**307,200 Tokens（300K）**（全平台最高档位单次输出之一）。
* **超时策略**：官方网关默认配置 `timeout: "7200"`（2小时超长连接保持）。
* **推理档位**：支持 `low`、`high`、`max` 三级 Reasoning Effort 调度。

### 2.3 `zai_auto`（智能决策自动流）
* **定位**：根据用户的 Prompt 复杂度与上下文长度，自动路由最佳后端模型。
* **输入窗口**：**1,048,576 Tokens（1M）**。
* **输出限制**：**393,216 Tokens（384K）**。
* **底层引擎**：官方云端配置标记其自动派生调度至 `deepseek-v4-pro`。

### 2.4 `zai_auto-fast`（极速匹配 + 多模态图文）
* **定位**：AutoClaw 体系内目前唯一**支持图文多模态**的通道。
* **输入模态**：`["text", "image"]`。
* **输入窗口**：**1,048,576 Tokens（1M）**。
* **输出限制**：**131,072 Tokens（128K）**。
* **适用场景**：前端组件还原、截图报错诊断、架构图识别与解析。

---

## 3. 调用入参与网关约束规范

在调用 AutoClaw 模型时，需遵循以下官方网关硬性约束（Provider 适配层已自动处理）：

1. **`max_tokens` 阈值**：
   * 官方网关要求 `max_tokens >= 10000` 或**完全不传递**。
   * 若传递 `< 10000`（如常见 IDE 默认的 4096），网关会返回 `406 Not Acceptable`。
   * Provider 发包层已统一安全防护为 `Math.max(16384, options.maxTokens)`。
2. **System Prompt 白名单**：
   * `messages[0]` 必须完全精确匹配 `You are AutoClaw. Answer the user directly and concisely`。
   * 自定义提示词需作为 `messages[1]` 紧随其后发送。
3. **函数调用（Tools）**：
   * 兼容标准 OpenAI `tools: [{ type: "function", function: { name, description, parameters } }]`。

---

## 4. 建议思考强度 (Reasoning Effort) 规格与推荐配置

通过官方模型配置端点实测探测，AutoClaw 具备完整的思考强度（Reasoning Effort）分级调节能力：

| 思考档位 ID (Wire Value) | 客户端规范映射 | 显示名称 | 特性与行为 | 适用推荐场景 |
| :---: | :---: | :--- | :--- | :--- |
| **`low`** | `low`, `minimal` | **快速思考 (Low)** | 缩短推理链，极速产出首字与答案 | 简短问答、单元测试补全、日常文本编写 |
| **`high`** | `high`, `medium` | **深度思考 (High)** | **【官方推荐默认】** 完整展开推导演算 | 算法编写、复杂 Bug 排查、跨函数重构 |
| **`max`** | `max`, `xhigh`, `ultra` | **极限推理 (Max)** | 深度递归验证，调用最大预算推理 | 系统级架构设计、数学推导、核心逻辑安全性审计 |

* **网关与客户端适配**：
  - OpenAI 兼容网关会在 `/v1/models` 中向 Cursor、Continue、ZCode 等客户端完整广播上述 3 个档位及 `defaultEffort: "high"`；
  - 客户端通过标准字段 `reasoning_effort: "low" | "medium" | "high" | "max"` 传递时，网关与适配器会自动映射为上游网关的 `reasoning_effort` 与 `thinking_level` 参数，保证推理深度精准生效。

