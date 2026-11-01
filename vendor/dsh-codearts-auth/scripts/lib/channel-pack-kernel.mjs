// Minimal host contracts for the generated channel pack's offline mount test.
// Provider implementation, pool persistence and RPC handlers remain real.
export class Service {
  constructor(ctx, name) { this.ctx = ctx; ctx.provide(name, this) }
}
export class HarnessError extends Error {
  constructor(message, code, options) { super(message, options); this.code = code; this.status = options?.status }
}

export class LlmAdapter {}
export class LlmError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
export const credentialRef = value => value
export const ReasoningEffortId = value => value
export const ToolCallId = value => value
export const createUserMessage = value => value
export const attributionHeaders = () => ({})
export const ProviderRequestId = value => value
export const contentHasImage = content => Array.isArray(content) && content.some(part => part?.type === 'image')
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED'
export const isContextWindowExceededError = error => error?.code === CONTEXT_WINDOW_EXCEEDED_CODE
export const isQuotaExceededError = error => error?.code === QUOTA_EXCEEDED_CODE
const schema = new Proxy(() => schema, { get: () => schema })
export default schema

export const createToolResultMessage = ({callId, content, isError}) => ({id: 'fixture', role: 'tool', toolCallId: callId, content, isError, source: {kind: 'tool', callId}})
