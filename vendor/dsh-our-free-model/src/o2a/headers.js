/**
 * Port of opencode2api `gateway.setV2Headers` — the OpenCode 2.x CLI header set
 * the v2 gates fingerprint.
 *
 * Upstream facts (each one is a refusal on its own, see the reference):
 * - `x-opencode-session` (conversation affinity), `x-session-affinity` and
 *   `X-Session-Id` carry the canonical session; `x-opencode-session-id` carries
 *   the client's child session when one exists (a subagent keeps its child id
 *   while affinity stays on the parent) and the session itself otherwise.
 * - `x-opencode-project` is a bare 40-character hex id. A canonical `prj_*`
 *   style project is rejected, so any caller project that is not the literal
 *   `global` or a 40-hex git commit is hashed into the shape (`projectID`).
 *   `projectID` is stable: one project maps to one upstream id, masking the
 *   caller's spelling.
 * - `x-opencode-request` is the v1 lane's header; the v2 gate rejects it, so
 *   it is never sent.
 * - Anthropic requests on the v2 lane carry the `anthropic-beta` header and a
 *   `beta=true` query on the endpoint (`upstreamRequest.withAnthropicBeta`).
 *
 * The plugin adds the lane's own transport fields around the port: the pooled
 * keyless credential `Authorization: Bearer public` (`upstreamRequest`), the
 * JSON content type, and the `accept` value the caller's streaming needs.
 *
 * @module src/o2a/headers.js
 */

import crypto from 'node:crypto'
import { ANONYMOUS_CREDENTIAL, CLIENT_UA } from './version.js'
import { randomProjectID } from './identity.js'

/** The 40-hex shape of a git root commit, which `projectID` keeps verbatim. */
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/

/**
 * Render one project signal into the upstream project id (`gateway.projectID`):
 * a genuine git commit hash or `global` is kept verbatim, any other project is
 * hashed into the same 40-character lowercase hex shape. The value itself is
 * not checked upstream, only its shape.
 */
export function projectID(project) {
  if (project === 'global' || GIT_COMMIT_RE.test(String(project))) return project
  const sum = crypto.createHash('sha256').update(`opencode-project\0${project}`).digest()
  return sum.subarray(0, 20).toString('hex')
}

/**
 * The v2 header set for one request (`setV2Headers`).
 *
 * @param {object} options
 * @param {string} options.session - the canonical conversation-affinity session
 * @param {string} [options.childSession] - the client's own child session for
 *   `x-opencode-session-id`; defaults to `session`
 * @param {string} [options.project] - caller project signal; defaults to a
 *   fresh 40-hex id per request, the quota-spread the reference mints when the
 *   client names no project
 * @param {boolean} [options.stream] - unused for the header set (the reference
 *   sends no `accept` at all on the v2 lane — captured 2026-10-31 from its
 *   outbound bytes); kept for signature compatibility
 * @param {string} [options.accept] - explicit `accept` override; emitted only
 *   when the caller names one (GET document fetches)
 * @param {boolean} [options.anthropic] - add the Messages-lane beta header
 * @param {string} [options.userAgent] - UA override; the lane pins
 *   {@link CLIENT_UA} (the attribution hook in src/http.js resolves to it)
 * @returns {Record<string, string>}
 */
export function gatewayHeaders({ session, childSession, project, stream, accept, anthropic, userAgent } = {}) {
  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${ANONYMOUS_CREDENTIAL}`,
    'user-agent': userAgent ?? CLIENT_UA,
    'x-opencode-client': 'cli',
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-session': session,
    'x-opencode-session-id': childSession ?? session,
    'x-opencode-project': projectID(project ?? randomProjectID()),
  }
  if (accept) headers['accept'] = accept
  if (anthropic) headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14'
  return headers
}
