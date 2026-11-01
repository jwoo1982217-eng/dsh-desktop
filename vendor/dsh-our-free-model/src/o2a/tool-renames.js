/**
 * Port of opencode2api `internal/protocol/tools.go` — the opaque renaming of
 * client tools that keeps another client's vocabulary off the free-tier wire.
 *
 * Upstream fact (`ClientToolWireName`): the free tier refuses a shaped body
 * that still carries a foreign client's tool vocabulary — Claude Code's
 * `ReportFindings` and `ScheduleWakeup` together are enough, and dropping
 * either name lifts the refusal — so **no** client tool name may reach the
 * wire, whatever the client is. Every named client tool is therefore renamed
 * to `clint_` + 12 hex of its name digest; the digest keeps one client tool on
 * one wire name across requests, and collisions take a `_2`, `_3`, … suffix.
 * The rename is invertible and the response side maps wire names back.
 *
 * The plugin's legacy `read_client`-style aliases and its two-entry
 * compatibility table (2026-10-30) are superseded by this: renaming everything
 * is the general form of the same fix.
 *
 * @module src/o2a/tool-renames.js
 */

import crypto from 'node:crypto'

/** Marks every client tool the shaper renames (`ClientToolPrefix`). */
export const CLIENT_TOOL_PREFIX = 'clint_'

/** How many hex characters of the digest a wire name carries (`clientToolDigestLength`). */
export const CLIENT_TOOL_DIGEST_LENGTH = 12

/** The longest tool name the upstreams accept (`toolWireNameLimit`). */
export const TOOL_WIRE_NAME_LIMIT = 64

/**
 * Characters ignored when matching a tool name by shape, after case:
 * `todo_write`, `todo-write`, `todo.write` and `todowrite` all fold to one key
 * (`toolNameSeparators`).
 */
const TOOL_NAME_SEPARATORS = '_.- \t\r\n'

/** Lowercase `name` and drop the separators agents spell tool names with (`foldToolName`). */
const SEPARATOR_SET = new Set(TOOL_NAME_SEPARATORS)
export function foldToolName(name) {
  let out = ''
  for (const char of String(name ?? '').toLowerCase()) {
    if (!SEPARATOR_SET.has(char)) out += char
  }
  return out
}

/** The opaque wire name for one client tool (`ClientToolWireName`). */
export function clientToolWireName(name, used) {
  const taken = used instanceof Set ? used : new Set()
  const digest = crypto.createHash('sha256').update(String(name)).digest('hex')
  let clean = digest.slice(0, CLIENT_TOOL_DIGEST_LENGTH)
  const max = TOOL_WIRE_NAME_LIMIT - CLIENT_TOOL_PREFIX.length
  if (clean.length > max) clean = clean.slice(0, max)
  const base = CLIENT_TOOL_PREFIX + clean
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  for (let suffix = 2; ; suffix += 1) {
    const tag = `_${suffix}`
    const cut = Math.min(TOOL_WIRE_NAME_LIMIT - tag.length, base.length)
    const candidate = base.slice(0, cut) + tag
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

/**
 * The rename set of one shaped request (`ToolRenames`), as a `Map` from wire
 * name back to client name so existing consumers keep working — the plugin's
 * stream decoder has always received exactly such a map. The extra methods are
 * the Go API: forward lookup, response-side {@link resolve} with the folded
 * fallbacks, and prefix probes for streaming.
 */
export class ToolRenameMap extends Map {
  constructor() {
    super()
    this.#byClient = new Map()
    this.#byCase = new Map()
    this.#byShape = new Map()
  }

  /** Records one client→wire mapping (`Add`). Conflicts keep the first allocation. */
  add(client, wire) {
    if (!client || !wire || client === wire) return
    if (this.#byClient.has(client)) return
    if (this.has(wire)) return
    this.#byClient.set(client, wire)
    this.set(wire, client)
    bindFolded(this.#byCase, String(client).toLowerCase(), client)
    bindFolded(this.#byShape, foldToolName(client), client)
  }

  /** The wire name registered for an exact client name (`Wire`). */
  wireOf(client) {
    return this.#byClient.get(client)
  }

  /** Whether any wire name starts with `prefix` (`HasPrefix`). */
  hasPrefix(prefix) {
    if (!prefix) return false
    for (const wire of this.keys()) {
      if (wire.startsWith(prefix)) return true
    }
    return false
  }

  /** Whether a wire name is longer than `prefix` and starts with it (`HasLongerPrefix`). */
  hasLongerPrefix(prefix) {
    if (!prefix) return false
    for (const wire of this.keys()) {
      if (wire.length > prefix.length && wire.startsWith(prefix)) return true
    }
    return false
  }

  /**
   * Map a name the upstream reported back to the name the client declared
   * (`Resolve`): an exact wire name restores; a `clint_` prefix is stripped as
   * best-effort recovery; a name that differs from exactly one declared client
   * tool in case, or in case and separators, folds onto that tool. A name two
   * tools fold to is never guessed between.
   */
  resolve(wire) {
    if (!wire) return wire
    const exact = this.get(wire)
    if (exact !== undefined) return exact
    let client = wire
    if (client.startsWith(CLIENT_TOOL_PREFIX)) {
      const rest = client.slice(CLIENT_TOOL_PREFIX.length)
      if (rest !== '') client = rest
    }
    if (this.#byClient.has(client)) return client
    const caseMatch = this.#byCase.get(client.toLowerCase())
    if (caseMatch !== undefined) return caseMatch !== '' ? caseMatch : client
    const shapeMatch = this.#byShape.get(foldToolName(client))
    if (shapeMatch !== undefined && shapeMatch !== '') return shapeMatch
    return client
  }

  #byClient
  #byCase
  #byShape
}

/** Records `client` under `key`, marking a key two clients share as ambiguous (`bindFolded`). */
function bindFolded(folded, key, client) {
  if (!key) return
  const existing = folded.get(key)
  if (existing === undefined) {
    folded.set(key, client)
    return
  }
  if (existing !== client) folded.set(key, '')
}
