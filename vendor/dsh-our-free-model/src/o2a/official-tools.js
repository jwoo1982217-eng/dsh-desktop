/**
 * Port of opencode2api `internal/gateway/toolshape.go` — the official OpenCode
 * toolset that makes a shaped body read as a genuine CLI session.
 *
 * The free tier validates agent-shaped traffic per lane generation. The
 * reference appends the **complete** official tool set of the 2.x client
 * (13 tools, captured verbatim in `assets/opencode_tools.json`, embedded
 * upstream as `opencode_tools.json`) after renaming every client tool. The
 * plugin's earlier two-tool gate (`read` + `shell` only) is a strict subset:
 * those two definitions in the captured file are byte-identical to the ones
 * the plugin used to hardcode.
 *
 * Rendering per wire shape (`officialTool`): the 2.x Chat shape marks every
 * tool `strict: false`, as the client does; the flat Responses shape and the
 * Anthropic Messages shape carry the captured definitions verbatim. The shell
 * description names the shell the host actually has — a Windows host says
 * powershell where a Unix host says bash (`v2ShellDescription`).
 *
 * @module src/o2a/official-tools.js
 */

import { officialToolsText } from './asset-source.js'

/** Tool order of the captured file, made explicit because JSON key order is (`v2OfficialToolOrder`). */
export const V2_OFFICIAL_TOOL_ORDER = Object.freeze([
  'edit', 'execute', 'glob', 'grep', 'question', 'read', 'shell',
  'skill', 'subagent', 'webfetch', 'websearch', 'write', 'patch',
])

let officialTools

function loadOfficialTools() {
  if (officialTools !== undefined) return officialTools
  officialTools = new Map()
  try {
    const parsed = JSON.parse(officialToolsText())
    for (const [name, definition] of Object.entries(parsed)) {
      if (definition && typeof definition.description === 'string' && definition.parameters) {
        officialTools.set(name, definition)
      }
    }
  } catch {
    // An unreadable asset degrades every definition to the placeholder below;
    // the names are still appended, which is what the gate checks first.
  }
  return officialTools
}

/** The captured definition for one official name (`officialToolDefinition`). */
export function officialToolDefinition(name) {
  return loadOfficialTools().get(name)
}

/**
 * Render the shell tool description for the host platform (`v2ShellDescription`).
 * The 2.x client describes the shell it actually has.
 */
export function v2ShellDescription(base, platform = process.platform) {
  if (platform !== 'win32') return base
  return base.replace('on Linux using bash', 'on Windows using powershell')
}

/** Render one official definition in the wire shape the protocol expects (`officialTool`). */
export function officialTool(shape, name) {
  let description = `Agent tool ${name}`
  let parameters = { type: 'object', properties: {} }
  const definition = officialToolDefinition(name)
  if (definition !== undefined) {
    description = definition.description
    if (definition.parameters != null) parameters = structuredClone(definition.parameters)
  }
  if (name === 'shell') description = v2ShellDescription(description)
  if (shape === 'claude') {
    return { name, description, input_schema: parameters }
  }
  if (shape === 'flat') {
    return { type: 'function', name, description, parameters }
  }
  return {
    type: 'function',
    function: { name, description, parameters, strict: false },
  }
}

/** The full official set for a wire shape, in captured order (`officialToolset`). */
export function officialToolset(shape) {
  return V2_OFFICIAL_TOOL_ORDER.map(name => officialTool(shape, name))
}

/**
 * The client tool name of one definition, or null when the entry is a built-in
 * the shaper must leave alone (`renamableToolName`): Responses built-in tools
 * (web search and similar) and Anthropic server tools carry a `type` outside
 * the function/custom spellings and have no client name.
 */
export function renamableToolName(shape, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  if (shape === 'chat') {
    const name = entry.function?.name
    return typeof name === 'string' && name !== '' ? name : null
  }
  const type = typeof entry.type === 'string' ? entry.type : ''
  if (shape === 'flat') {
    if (type !== '' && type !== 'function' && type !== 'custom') return null
  } else if (shape === 'claude') {
    if (type !== '' && type !== 'custom') return null
  }
  const name = entry.name
  return typeof name === 'string' && name !== '' ? name : null
}
