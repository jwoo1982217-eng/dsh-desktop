/**
 * Port of the body-level shaping of opencode2api
 * `gateway.prepareAnonymousBody` — the fields a 2.x chat body always carries.
 *
 * The reference forces `stream: true` on every anonymous body because it is
 * itself a streaming proxy. The plugin controls streaming itself (its harness
 * lane is always streamed, its probe lane may not be), so that step is not
 * ported — see SYNC.md, deviation #5. What is ported:
 *
 * - `stream_options.include_usage: true` on a streamed chat body
 *   (`ensureAnonymousChatUsage`), so the lane's usage frames survive shaping;
 * - `max_completion_tokens: 32000` when the caller named no ceiling
 *   (`ensureV2CompletionLimit`), so the free tier always sees the client's
 *   own ceiling.
 *
 * Both apply to the Chat wire only; the Anthropic and Responses lanes keep
 * their own required fields (`max_tokens` / `max_output_tokens`).
 *
 * @module src/o2a/gateway-body.js
 */

import { V2_COMPLETION_LIMIT } from './version.js'

/** `stream_options.include_usage: true` on a streamed chat body (`ensureAnonymousChatUsage`). */
export function ensureChatUsage(payload, shape) {
  if (shape !== 'chat') return false
  if (payload.stream !== true) return false
  if (payload.stream_options && typeof payload.stream_options === 'object' && !Array.isArray(payload.stream_options)) {
    if (payload.stream_options.include_usage === true) return false
    payload.stream_options = { ...payload.stream_options, include_usage: true }
    return true
  }
  payload.stream_options = { include_usage: true }
  return true
}

/** The 2.x completion ceiling when the caller named none (`ensureV2CompletionLimit`). */
export function ensureV2CompletionLimit(payload, shape) {
  if (shape !== 'chat') return false
  if (payload.max_completion_tokens !== undefined) return false
  if (payload.max_tokens !== undefined) return false
  payload.max_completion_tokens = V2_COMPLETION_LIMIT
  return true
}
