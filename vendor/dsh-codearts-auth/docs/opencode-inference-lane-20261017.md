# OpenCode /inference 快通道接入（2026-10-17）

## 背景

JetHub 的 `opencode` 槽位此前接的是**本机 OpenCode serve**（`OpencodeLocalAdapter`）：
请求经本地 CLI 服务、原生会话握手与工具回传，免费档体感慢。

2026-10-15 起旧 `/zen` 的匿名档被上游 TLS/HTTP 指纹门禁锁死（第三方直发 403
`FreeTierError`），但上游同时开放了 OpenAI 兼容入口
`https://opencode.ai/inference`：**不校验 TLS 指纹**（Node fetch 实测可用），
只校验请求形态，免费模型用 `Bearer public` 即可调用。

## 改动

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `src/opencode-inference.ts` | 新增 | 降序 `ses_` 会话编码、四会话头 + 40hex 工程头、官方 shell/edit/glob/grep/read 工具定义、`prepareInferencePayload` |
| `src/opencode-product.ts` | 修改 | `OPENCODE.inferenceBaseUrl/ChatPath/UserAgent`；`OPENCODE_INFERENCE_MODELS`（9 个实测免费模型）；`usesInferenceLane()`；`mergeInferenceModels()` |
| `src/opencode-adapter.ts` | 修改 | 按模型分流：实测表内模型走 `/inference`（强制 stream + 官方工具集 + 降序会话 + 无 `x-opencode-request`），其余保持 `/zen`；403 FreeTierError 换会话重试一次 |
| `src/opencode-hybrid-adapter.ts` | 新增 | `OpencodeHybridAdapter`：同一 provider id 下，快通道模型直连 `/inference`，其余委托本地服务；目录取并集 |
| `src/index.ts` | 修改 | 注册 hybrid 适配器（`openocdeLocalAdapter` + `createOpencodeInferenceAdapter()`），RPC 仍委托本地服务 |
| `tests/unit/opencode-*.spec.ts` | 新增/修改 | 会话形状、头集、工具替换、分流、重试、目录合并；旧 lane 用例改用 `/zen` 模型锁定原语义 |

## 上游协议要点

| 要素 | 值 |
| --- | --- |
| endpoint | `POST https://opencode.ai/inference/v1/chat/completions` |
| 鉴权 | `Bearer public`（无效 key 会 401，故免费档固定 public） |
| UA | `opencode/latest/2.0.29/cli` |
| 会话头 | `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `X-Session-Id` 同值 |
| 会话编码 | `ses_` + 12 位降序时间（`^[0-9a-f]{9}f[c-f][0-9a-f]`）+ 14 位 base62 |
| 工程头 | 裸 40 位小写 hex（`prj_` 前缀 403） |
| 禁止头 | `x-opencode-request`（带上即 403） |
| body | `stream: true`；`tools` 必须含官方 shell/read 等定义（逐字节校验） |

## 模型（2026-10-17 逐个实测回话）

`deepseek-v4.1-flash-free`、`glm-5.3-flash-free`、`longcat-2.5-preview-free`、
`mimo-v2.6-flash-free`、`nemotron-3.5-lightning-free`、`nemotron-3.5-super-vl-free`、
`space-bunny-free`、`beam-free`、`big-pickle`。

## 验证

- `vitest`：opencode 相关 7 个 spec、134 个用例通过（含新增 24 个）。
- 真实网络：用构建后的 `lib/` 实例化 hybrid + 匿名槽，`deepseek-v4.1-flash-free`
  返回正文「直连」（49 个 chunk，含 reasoning 流）。
- 部署：`~/.dsh/profiles/web/node_modules/dsh-codearts-auth/lib` 仅替换
  `index.js`、`opencode-product.js`、`opencode-adapter.js`、`opencode-inference.js`、
  `opencode-hybrid-adapter.js`，其余保持原构建产物。
- **需重启 DSH 后生效**（插件在进程启动时加载）。

## 已知边界

- 免费额度按出口 IP 记账；机房/公共代理 IP 会被 403。
- 快通道固定 `public`，不消耗账号 key；账号/付费模型仍走原 `/zen` 或本地服务。
- 目录里文本模态（能力表未预热），图片输入不投影到快通道。
- 旧 `/zen` 匿名档仍不可用（上游指纹门禁），报错文案已改为引导用 `/inference` 模型。
