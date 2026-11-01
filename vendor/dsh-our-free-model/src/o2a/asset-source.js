/**
 * The two captured official assets the shaping layer loads lazily.
 *
 * Development form: read from `assets/` beside this module, degrading exactly
 * like the previous inline reads (missing files → empty prompt / no
 * definitions). The release bundle replaces this module with inlined
 * constants — `scripts/build-legacy-payload.mjs` swaps it during the
 * `src/o2a.js` build, because the 80-file legacy-upgrader budget cannot afford
 * shipping `src/o2a/assets/` alongside the bundle.
 *
 * @module src/o2a/asset-source.js
 */

import fs from 'node:fs'

const PROMPT_ASSET = new URL('./assets/opencode_prompt_v2.txt', import.meta.url)
const TOOLS_ASSET = new URL('./assets/opencode_tools.json', import.meta.url)

let promptCache

/** The official CLI base prompt, verbatim; `''` when the asset is unreadable. */
export function officialPromptText() {
  if (promptCache !== undefined) return promptCache
  try {
    promptCache = fs.readFileSync(PROMPT_ASSET, 'utf8')
  } catch {
    promptCache = ''
  }
  return promptCache
}

let toolsCache

/** The captured official tool definitions as raw JSON text; `''` when unreadable. */
export function officialToolsText() {
  if (toolsCache !== undefined) return toolsCache
  try {
    toolsCache = fs.readFileSync(TOOLS_ASSET, 'utf8')
  } catch {
    toolsCache = ''
  }
  return toolsCache
}
