# DSH desktop bounded memory summary

User approved opening summary, on-demand history recall, correction and forgetting on 2026-11-03. Implement in the existing desktop knowledge-link, without importing entire Codex chats or replacing Noema.

- [x] Add an atomic, revisioned local summary store: keyed preferences/project/progress entries, provenance, project scope, bounded output, tombstones. Preserve old revisions as hashes rather than discarded personal text. Respect memory freeze, recall off, local-main-session boundaries.
- [x] Inject the small current summary through the existing native runtime-context hook; retain query-dependent history. Reject obsolete/suppressed history, invalidate stale cached injections. Saving and correction require an exact quote from the current user turn; settings can directly edit/forget. Do not turn assistant conjectures into accepted facts.
- [x] Add settings controls to inspect/add/correct/forget entries, using revision checks and textContent. Add model tools for explicit user memory requests with current-turn provenance.
- [x] Validate persistence, project isolation, off/freeze, bounds, malformed storage, correction/forget and native SDK request assembly. Run existing recall/shared-memory regressions.
- [x] Back up only changed live plugin files; deploy atomically. Check sessions before normal idle restart, verify live routes and preserved configuration; restore program files if activation fails. No APK/PKG/build copies, no push.

Small source files, fixtures and receipts only. Existing task-artifact budget is exceeded; no large generated output or dependency copies will be created.

## Activation correction
The signed selective updater initially refused the edited managed automatic-recall.mjs. Its original bytes were restored; summary-recall.mjs now subclasses the existing history controller, and index.mjs selects the additive layer. The original LaunchAgent resumed and owns core16692. A redundant recovery borrower was stopped without stopping that core. The GUI briefly displayed ERR_ABORTED(-3) during reconnection; the official DSH → reconnect action restored the real chat window. No launcher or signed app modification was made. The in-app summary edit/forget UI passed against an isolated store; live APIs and configuration preservation were separately checked.
