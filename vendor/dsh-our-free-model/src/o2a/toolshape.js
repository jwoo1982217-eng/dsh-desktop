/**
 * Port of opencode2api `internal/gateway/toolshape.go` —
 * `renameAndCompleteTools` and `rewriteToolReferences`: make the tool list read
 * as an official CLI session.
 *
 * The walk, per shaped request:
 *
 * 1. Legacy `functions` arrays (the pre-tools OpenAI shape) are converted to
 *    the wire's tool shape and renamed like any other client tool.
 * 2. Every named client tool is renamed to an opaque `clint_` wire name (see
 *    tool-renames.js — the free tier refuses bodies that still carry another
 *    client's vocabulary). Responses built-ins and Anthropic server tools have
 *    no client name and are left untouched.
 * 3. The full official tool set for the lane is appended (official-tools.js).
 * 4. Every outbound reference to a client tool is renamed with it — named
 *    `tool_choice` (including the Responses `allowed_tools` form), legacy
 *    `function_call`, and the tool-call history each wire keeps — so the body
 *    stays self-consistent. String choices pass through untouched.
 *
 * Documented deviations from the Go original, all plugin-side necessities:
 *
 * - **Clone, don't mutate.** Go owns the payload it parsed, so `setToolName`
 *   edits entries in place; the plugin's caller tool objects are shared with
 *   the host harness, so a renamed entry is replaced with a shallow copy and
 *   the caller's object is left untouched.
 * - **Idempotence.** Go shapes a fresh body once per request. The plugin can
 *   shape an already-shaped body (retried turns), so (a) a name whose
 *   definition is verbatim-official is treated as the official declaration and
 *   not renamed or re-appended (`options.keep`), and (b) a name already
 *   carrying the `clint_` prefix is a wire name from a previous pass and is
 *   left alone.
 *
 * @module src/o2a/toolshape.js
 */

import { ToolRenameMap, CLIENT_TOOL_PREFIX, clientToolWireName } from './tool-renames.js'
import { V2_OFFICIAL_TOOL_ORDER, officialTool, renamableToolName } from './official-tools.js'

/**
 * Shape the tool list of `payload` in place (`renameAndCompleteTools`).
 *
 * @param {object} payload - request body, mutated in place
 * @param {'chat'|'flat'|'claude'} shape - the wire shape the body speaks
 * @param {object} [options]
 * @param {Set<string>} [options.keep] - official tool names already declared
 *   verbatim; left untouched and not appended again
 * @returns {{ renames: ToolRenameMap, injected: string[] }} the rename set and
 *   the official names this pass appended
 */
export function renameAndCompleteTools(payload, shape, { keep } = {}) {
  if (shape !== 'chat' && shape !== 'flat' && shape !== 'claude') {
    return { renames: new ToolRenameMap(), injected: [] }
  }
  const renames = new ToolRenameMap()
  const used = new Set()
  const keepNames = keep instanceof Set ? keep : new Set()
  let items = Array.isArray(payload.tools) ? [...payload.tools] : []
  if ((shape === 'chat' || shape === 'flat') && Array.isArray(payload.functions)) {
    items = items.concat(convertLegacyFunctions(payload.functions, shape, renames, used))
    delete payload.functions
  }
  const shaped = []
  for (const item of items) {
    const name = renamableToolName(shape, item)
    if (name === null) {
      shaped.push(item)
      continue
    }
    // An already-shaped body's officials and wire names are not client tools.
    if (keepNames.has(name) || name.startsWith(CLIENT_TOOL_PREFIX)) {
      shaped.push(item)
      continue
    }
    let wireName = renames.wireOf(name)
    if (wireName === undefined) {
      wireName = clientToolWireName(name, used)
      renames.add(name, wireName)
    }
    shaped.push(wireName !== name ? withToolName(shape, item, wireName) : item)
  }
  const injected = []
  for (const name of V2_OFFICIAL_TOOL_ORDER) {
    if (keepNames.has(name)) continue
    shaped.push(officialTool(shape, name))
    injected.push(name)
  }
  payload.tools = shaped
  rewriteToolReferences(payload, shape, renames)
  return { renames, injected }
}

/** Replace a renamed entry with a shallow copy carrying the wire name (`setToolName`, cloning variant). */
function withToolName(shape, entry, name) {
  if (shape === 'chat') {
    return { ...entry, function: { ...entry.function, name } }
  }
  return { ...entry, name }
}

/** Turn the pre-tools `functions` array into wire-shaped, renamed entries (`convertLegacyFunctions`). */
function convertLegacyFunctions(entries, shape, renames, used) {
  const converted = []
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const name = typeof raw.name === 'string' ? raw.name : ''
    if (name === '') continue
    let wireName = renames.wireOf(name)
    if (wireName === undefined) {
      wireName = clientToolWireName(name, used)
      renames.add(name, wireName)
    }
    const description = typeof raw.description === 'string' ? raw.description : undefined
    const parameters = raw.parameters ?? { type: 'object', properties: {} }
    if (shape === 'chat') {
      const fn = { name: wireName, description, parameters }
      if (raw.strict !== undefined) fn.strict = raw.strict
      converted.push({ type: 'function', function: fn })
    } else {
      const tool = { type: 'function', name: wireName, description, parameters }
      if (raw.strict !== undefined) tool.strict = raw.strict
      converted.push(tool)
    }
  }
  return converted
}

/**
 * Rename every outbound reference to a client tool (`rewriteToolReferences`):
 * named `tool_choice` (including legacy Chat and Responses `allowed_tools`
 * forms), legacy `function_call`, and the tool-call history each wire keeps.
 * String choices pass through untouched. Copy-on-write: the caller's history
 * objects are shared with the host harness, so renamed rows are replaced with
 * shallow copies instead of edited in place (see the deviations note above).
 */
function rewriteToolReferences(payload, shape, renames) {
  if (renames.size === 0) return
  const renamed = container => {
    if (!container || typeof container !== 'object') return null
    const name = container.name
    if (typeof name !== 'string') return null
    const wireName = renames.wireOf(name)
    return wireName !== undefined && wireName !== name ? wireName : null
  }
  if (shape === 'chat') {
    const choice = objectOf(payload.tool_choice)
    if (choice) {
      if (choice.function && typeof choice.function === 'object') {
        const wire = renamed(choice.function)
        if (wire !== null) payload.tool_choice = { ...choice, function: { ...choice.function, name: wire } }
      } else {
        const wire = renamed(choice)
        if (wire !== null) payload.tool_choice = { ...choice, name: wire }
      }
    }
    const call = objectOf(payload.function_call)
    if (call) {
      const wire = renamed(call)
      if (wire !== null) payload.function_call = { ...call, name: wire }
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i]
      if (!message || typeof message !== 'object') continue
      let next = null
      const fnCall = objectOf(message.function_call)
      if (fnCall) {
        const wire = renamed(fnCall)
        if (wire !== null) next = { ...message, function_call: { ...fnCall, name: wire } }
      }
      if (Array.isArray(message.tool_calls)) {
        const calls = message.tool_calls.map(entry => {
          const fn = objectOf(entry?.function)
          if (!fn) return entry
          const wire = renamed(fn)
          return wire !== null ? { ...entry, function: { ...fn, name: wire } } : entry
        })
        if (calls.some((entry, j) => entry !== message.tool_calls[j])) {
          next = { ...(next ?? message), tool_calls: calls }
        }
      }
      if (next !== null) messages[i] = next
    }
    return
  }
  if (shape === 'flat') {
    const choice = objectOf(payload.tool_choice)
    if (choice) {
      let next = null
      const wire = renamed(choice)
      if (wire !== null) next = { ...choice, name: wire }
      if (Array.isArray(choice.allowed_tools)) {
        const allowed = choice.allowed_tools.map(entry => {
          if (!entry || typeof entry !== 'object') return entry
          const entryWire = renamed(entry)
          return entryWire !== null ? { ...entry, name: entryWire } : entry
        })
        if (allowed.some((entry, j) => entry !== choice.allowed_tools[j])) {
          next = { ...(next ?? choice), allowed_tools: allowed }
        }
      }
      if (next !== null) payload.tool_choice = next
    }
    const input = Array.isArray(payload.input) ? payload.input : []
    for (let i = 0; i < input.length; i += 1) {
      const item = input[i]
      const type = typeof item?.type === 'string' ? item.type : ''
      if (type !== 'function_call' && type !== 'custom_tool_call') continue
      const wire = renamed(item)
      if (wire !== null) input[i] = { ...item, name: wire }
    }
    return
  }
  const choice = objectOf(payload.tool_choice)
  if (choice) {
    const wire = renamed(choice)
    if (wire !== null) payload.tool_choice = { ...choice, name: wire }
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) continue
    const content = message.content.map(block => {
      if (block?.type !== 'tool_use') return block
      const wire = renamed(block)
      return wire !== null ? { ...block, name: wire } : block
    })
    if (content.some((block, j) => block !== message.content[j])) {
      messages[i] = { ...message, content }
    }
  }
}

function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}
