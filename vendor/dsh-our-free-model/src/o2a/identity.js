/**
 * Port of opencode2api `internal/identity/request.go` — the session and project
 * identity the upstream free tier inspects.
 *
 * Upstream facts (each verified by the reference project, dates in its comments):
 *
 * - The free tier validates the session id's **encoding**, not just the `ses_`
 *   shape: the twelve hex digits must be the descending `~(ts_ms << 12 | counter)`
 *   value with counter 1–63 (low 12 bits `0xfc0–0xfff`); anything else 403s.
 * - The timestamp inside a session must also stay plausible. A session dated
 *   more than about a year from now, in either direction, is answered with HTTP
 *   429 "Free usage limit reached" — the same message a genuinely exhausted
 *   egress receives — so a purely hash-derived timestamp (which lands in 1970)
 *   fails every request. The mint below draws the date from a slow clock
 *   instead: today's UTC midnight minus a hash-derived offset of at most
 *   {@link SESSION_TIMESTAMP_WINDOW_MS}.
 * - `bootNonce` separates the sessions one process derives from those its
 *   earlier runs derived, so a restart re-mints while a single run keeps one
 *   stable id per conversation signal.
 * - Free-tier quota is ledged per **project id × egress**, so a shared project
 *   id is one shared bucket. When the caller names no project, one is minted
 *   per request ({@link randomProjectID}); a named `global` or 40-hex git
 *   commit is kept verbatim (`headers.projectID`).
 *
 * The JS port adds {@link sessionPhaseMs} / {@link phaseAgeMs}, which decode
 * the time phase back out of a session id. The gateway never needs them (it
 * only mints); the plugin uses them to re-mint persisted sessions whose phase
 * left the accepted window — e.g. ids carried over from the pre-port era —
 * instead of replaying a dead id forever.
 *
 * @module src/o2a/identity.js
 */

import crypto from 'node:crypto'

/** `ses_` + 12 hex + 14 base62 — the shape the free tier accepts since 2026-09-16. */
export const CANONICAL_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/**
 * The descending time part: 9 free hex digits, then `f[c-f]`, then one free
 * digit — exactly the counter window 1–63 (`0xfff` down to `0xfc0`).
 */
export const DESCENDING_TIME_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/

export const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** How far before today a synthesized session's timestamp may fall (`sessionTimestampWindow`). */
export const SESSION_TIMESTAMP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The per-process session salt (`bootNonce`). Mixed into every synthesized
 * session: stable within one process run, fresh after a restart.
 */
const BOOT_NONCE = crypto.randomBytes(16)

/** Whether `signal` is a session the official client's `Identifier.descending()` minted. */
export function isOfficialSessionID(signal) {
  return typeof signal === 'string'
    && CANONICAL_SESSION_RE.test(signal)
    && DESCENDING_TIME_RE.test(signal.slice(4, 16))
}

/**
 * The canonical session for `signal`, stable for the life of the process
 * (`CanonicalSessionID`). An official client-minted session is kept verbatim to
 * preserve upstream prompt-cache affinity; every other signal is re-encoded.
 */
export function canonicalSessionID(signal, now = Date.now()) {
  if (isOfficialSessionID(signal)) return signal
  const digest = crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from('ses\0'), BOOT_NONCE, Buffer.from([0]), Buffer.from(String(signal))]))
    .digest()
  const timePart = descendingTimePart(now, digest)
  const randomPart = base62Fixed(digest.subarray(6, 16), 14)
  return `ses_${timePart}${randomPart}`
}

/**
 * The width of the time phase a session id carries. The wire's time part is 12
 * hex characters = 48 bits = `(ms << 12 | counter)` truncated to 48 bits — the
 * reference does the same truncation (`^current & 0xFFFFFFFFFFFF`) — so the
 * decodable time is the low 36 bits of the millisecond clock, a phase that
 * repeats every {@link SESSION_PHASE_MS} (~795 days), not an absolute date.
 */
export const SESSION_PHASE_MS = 2n ** 36n

/**
 * Decode the millisecond time phase a canonical session id carries, or null
 * when the id does not carry the descending encoding. JS-side addition — see
 * the module header. Compare it against {@link currentTimePhaseMs}, never
 * against the absolute clock.
 */
export function sessionPhaseMs(id) {
  if (!isOfficialSessionID(id)) return null
  const inverted = BigInt(`0x${id.slice(4, 16)}`)
  const current = ~inverted & 0xffffffffffffn
  return Number(current >> 12n)
}

/** The current clock's 36-bit millisecond phase — the value ids are dated in. */
export function currentTimePhaseMs(now = Date.now()) {
  return now % Number(SESSION_PHASE_MS)
}

/** How long ago, within the phase cycle, `phase` sits relative to now's phase. */
export function phaseAgeMs(phase, now = Date.now()) {
  const nowPhase = BigInt(now % Number(SESSION_PHASE_MS))
  const age = (nowPhase - BigInt(phase)) % SESSION_PHASE_MS
  return Number((age + SESSION_PHASE_MS) % SESSION_PHASE_MS)
}

/**
 * Render a plausible recent timestamp in the descending layout
 * (`descendingTimePart`): today's UTC midnight minus a hash-derived offset of
 * at most {@link SESSION_TIMESTAMP_WINDOW_MS}, shifted `<< 12 | 1`, inverted.
 * The hash only picks the offset; it never supplies the date.
 */
export function descendingTimePart(now = Date.now(), hash) {
  const offset = (((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0) % SESSION_TIMESTAMP_WINDOW_MS
  const midnight = Math.floor(now / 86400000) * 86400000
  const base = midnight - offset
  const inverted = ~((BigInt(base) << 12n) | 1n) & 0xffffffffffffn
  return inverted.toString(16).padStart(12, '0')
}

/** Render `bytes` as exactly `width` base62 characters, big-endian (`base62Fixed`). */
export function base62Fixed(bytes, width) {
  let n = 0n
  for (const byte of bytes) n = (n << 8n) | BigInt(byte)
  const out = new Array(width)
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = BASE62_ALPHABET[Number(n % 62n)]
    n /= 62n
  }
  return out.join('')
}

/** `prefix` + "_" + `size` random bytes in hex (`RandomID`). */
export function randomID(prefix, size) {
  return `${prefix}_${crypto.randomBytes(size).toString('hex')}`
}

/**
 * A project id in the shape the official CLI sends — the 40-character hex of a
 * git root commit — minted per request when the client names no project
 * (`RandomProjectID`).
 */
export function randomProjectID() {
  return crypto.randomBytes(20).toString('hex')
}
