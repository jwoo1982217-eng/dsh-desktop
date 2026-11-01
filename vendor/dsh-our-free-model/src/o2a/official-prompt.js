/**
 * Port of opencode2api `internal/gateway/opencode_prompt.go` — the official CLI
 * system prompt the free tier's abuse checks expect.
 *
 * The free tier accepts only agent-shaped requests, and its checks validate
 * the system prompt the official CLI sends. `assets/opencode_prompt_v2.txt` is
 * the CLI's own wording, embedded upstream as `opencode_prompt_v2.txt`, and the
 * environment block plus the built-in skill listing are appended exactly as the
 * CLI assembles them. The marker (`opencodePromptMarker`) keeps a client that
 * already sends the prompt from getting a duplicate.
 *
 * Injection per wire (`injectOfficialPrompt` → the three injectors):
 * - Responses: the prompt is prepended to `instructions`.
 * - Anthropic: the prompt is prepended to the top-level `system`.
 * - Chat: the prompt is prepended to the first system/developer message.
 *
 * One documented deviation from the Go injector, in the Chat branch: the
 * reference folds every system/developer message's text into one rebuilt
 * message, which would drop block objects — and the plugin must preserve a
 * caller's blocks (their identity and any `cache_control` marking survive the
 * round trip). This port prepends the prompt to the first system/developer
 * message — a new text block for block content, a join for string content —
 * and leaves additional system messages in place. The marker check upstream
 * reads the prompt text, not the message count, so the gate is satisfied the
 * same way.
 *
 * @module src/o2a/official-prompt.js
 */

import { officialPromptText } from './asset-source.js'

let promptCache

/** The CLI's base prompt, read once (`opencodePromptV2`). */
export function officialPrompt() {
  if (promptCache !== undefined) return promptCache
  promptCache = officialPromptText()
  return promptCache
}

/** Identifies a body that already carries the official prompt (`opencodePromptMarker`). */
export const OFFICIAL_PROMPT_MARKER = 'You are opencode, an interactive CLI tool'

/** The built-in skill listing the CLI appends after its environment block (`opencodeSkills`). */
export const OFFICIAL_SKILLS = `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>customize-opencode</name>
    <description>Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.</description>
    <location>&lt;built-in&gt;</location>
  </skill>
</available_skills>`

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// The working directory is resolved once per process (`opencodeEnvOnce`); a
// platform without one falls back to the official container path.
let cachedWorkDir

function workDir() {
  if (cachedWorkDir !== undefined) return cachedWorkDir
  let directory = ''
  try { directory = process.cwd() } catch { directory = '' }
  directory = String(directory).trim()
  if (directory === '' || directory === '.') directory = '/workspace'
  cachedWorkDir = directory
  return directory
}

/** The `<env>` block the CLI puts after its base prompt (`opencodeEnvironment`). */
export function officialEnvironment(model, directory = workDir()) {
  const apiModel = String(model ?? '').replace(/^opencode\//, '').trim() || 'unknown'
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const now = new Date()
  const date = `${WEEKDAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${String(now.getUTCDate()).padStart(2, '0')} ${now.getUTCFullYear()}`
  return [
    `You are powered by the model named ${apiModel}. The exact model ID is opencode/${apiModel}`,
    'Here is some useful information about the environment you are running in:',
    '<env>',
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    '  Is directory a git repo: yes',
    `  Platform: ${platform}`,
    `  Today's date: ${date}`,
    '</env>',
  ].join('\n')
}

/** The full CLI system prompt for `model` (`opencodeSystemPrompt`). */
export function officialSystemPrompt(model, directory) {
  const base = officialPrompt()
  if (base === '') return ''
  return `${base}${officialEnvironment(model, directory)}\n${OFFICIAL_SKILLS}`
}

/** Flatten a value into its text fragments (`textFragments`): string, block list, or block object. */
export function textFragments(value) {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value]
  if (Array.isArray(value)) return value.flatMap(item => textFragments(item))
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return textFragments(value.text)
    if (value.content !== undefined) return textFragments(value.content)
  }
  return []
}

/** Whether any text inside `value` already contains the marker (`carriesOpenCodePrompt`). */
export function carriesOpenCodePrompt(value) {
  return textFragments(value).some(part => part.includes(OFFICIAL_PROMPT_MARKER))
}

/**
 * Prepend the official CLI system prompt to a shaped payload
 * (`injectOfficialPrompt`). Reports whether the payload changed; a body that
 * already carries the marker is left untouched, so repeated shaping cannot
 * duplicate the prompt. See the module header for the Chat-branch deviation.
 *
 * @param {object} payload - request body, mutated in place
 * @param {'chat'|'flat'|'claude'} shape - the wire shape the body speaks
 * @param {object} [options]
 * @param {string} [options.workDir] - working directory for the env block
 * @param {string} [options.model] - model for the env block; defaults to payload.model
 * @returns {boolean}
 */
export function injectOfficialPrompt(payload, shape, { workDir, model } = {}) {
  if (!payload || typeof payload !== 'object') return false
  if (shape !== 'chat' && shape !== 'flat' && shape !== 'claude') return false
  const prompt = officialSystemPrompt(model ?? payload.model, workDir)
  if (prompt === '') return false
  if (shape === 'claude') return injectAnthropicPrompt(payload, prompt)
  if (shape === 'flat') return injectResponsesPrompt(payload, prompt)
  return injectChatPrompt(payload, prompt)
}

/** Prepend the prompt to the first system/developer message (`injectChatPrompt`). */
function injectChatPrompt(payload, prompt) {
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  let anchorIndex = -1
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (!message || typeof message !== 'object') continue
    const role = message.role
    if (role !== 'system' && role !== 'developer') continue
    if (carriesOpenCodePrompt(message.content)) return false
    if (anchorIndex === -1) anchorIndex = i
  }
  if (anchorIndex === -1) {
    payload.messages = [{ role: 'system', content: prompt }, ...messages]
    return true
  }
  const anchor = messages[anchorIndex]
  if (Array.isArray(anchor.content)) {
    messages[anchorIndex] = { ...anchor, content: [{ type: 'text', text: prompt }, ...anchor.content] }
  } else if (typeof anchor.content === 'string' && anchor.content.trim() !== '') {
    messages[anchorIndex] = { ...anchor, content: `${prompt}\n\n${anchor.content}` }
  } else {
    messages[anchorIndex] = { ...anchor, content: prompt }
  }
  return true
}

/** Prepend the prompt to the top-level system value (`injectAnthropicPrompt`). */
function injectAnthropicPrompt(payload, prompt) {
  const exists = payload.system !== undefined
  if (exists && carriesOpenCodePrompt(payload.system)) return false
  if (!exists) {
    payload.system = prompt
    return true
  }
  if (Array.isArray(payload.system)) {
    payload.system = [{ type: 'text', text: prompt }, ...payload.system]
  } else if (typeof payload.system === 'string' && payload.system.trim() !== '') {
    payload.system = `${prompt}\n\n${payload.system}`
  } else {
    payload.system = prompt
  }
  return true
}

/** Prepend the prompt to the Responses instructions (`injectResponsesPrompt`). */
function injectResponsesPrompt(payload, prompt) {
  const exists = payload.instructions !== undefined
  if (exists && carriesOpenCodePrompt(payload.instructions)) return false
  if (exists && typeof payload.instructions === 'string' && payload.instructions.trim() !== '') {
    payload.instructions = `${prompt}\n\n${payload.instructions}`
    return true
  }
  payload.instructions = prompt
  return true
}
