# DSH Mobile Persistent Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机点击一次连接链接完成配对，随后以固定中继和保存的配对恢复同一电脑连接。

**Architecture:** 保留现有 peer v1 AES-GCM 数据协议。新增用户账号下的固定 Cloudflare Worker/SQLite Durable Object 密文中继；桌面独占配对配置与连接生命周期，Android 负责外部链接 admission、启动就绪和选择连接类型。连接恢复不重放业务请求。

**Tech Stack:** Node.js ESM、ws、Cloudflare Workers/Durable Objects、Kotlin/Android、Node test、Miniflare/workerd、Robolectric。

---

## Verified progress (2026-10-26)

- Fixed private relay deployed at `dsh-peer-01a17284.jwoo1982217.workers.dev`; authenticated public ciphertext forwarding, revocation and same-pair recovery passed. The administration key stays in private local credentials.
- Shared peer: desktop 53/53, exact alpha.1 phone 53/53, stable phone entry 11/11. Installer proxy resolution and preservation guards: 4/4 on each SDK. Spec and quality reviews passed.
- Android: 50 focused JVM tests plus disposable-UID Android upgrade/recovery tests passed. Formal Samsung upgraded with `adb install -r` to 0.2.17/code122 after an observed-idle, fully verified recovery point. All 57 original session IDs remain; 12,171 existing protected files checked, with only the five expected peer program replacements and one verified appended session-end record. All 14 tree/profile peer files match signed APK assets. Fixed-host App Link is verified.
- Phone public service reachability passed on Wi-Fi, mobile data and restored Wi-Fi. This does not yet prove a paired cross-network reconnect.
- Official desktop activation completed after verified idle: core51381, all356 original sessions retained, fixed managed relay registered and waiting for phone. A cold-start timeout exposed a managed local-relay error-forwarding bug; desktop-only repair passed58/58 and independent5/5. The reviewed180s activation waiter passed6/6 with same-process confirmation and configuration-only resume.
- Pending: real phone pairing, actual computer page and paired restart/network-switch acceptance. Phone USB is disconnected. Follow-up dsh-2 deleted because user/device action is required; do not restart the already loaded desktop again.

## Execution and preservation

- Canonical desktop: `<desktop-source>`.
- Canonical phone: `<phone-source>`.
- Registered task: `<local-task-root>/dsh-mobile-one-click-20261025`; all large test/build outputs go in `generated/`.
- Baseline manifests and original index hashes are saved in that task. Never stash, reset, bulk-add, switch the shared checkout branch, or overwrite another task's files. Root performs any scoped commits; implementation agents do not commit.
- User approved the written design and explicitly requested continued execution. Do not ask another execution-choice question. Preserve active DSH tasks and user data; cloud authorization is handled after local readiness.

## Task 1 — Private fixed cloud relay

Files: create `remote-relay/worker.mjs`, `remote-relay/wrangler.jsonc`, `remote-relay/package.json`, `remote-relay/worker.test.mjs`, `remote-relay/README.md`.

- [ ] Write failing real-runtime tests for unauthorized registration/upgrade, successful two-peer ciphertext forwarding, persistent authorization across socket reconnect, authenticated same-role replacement, wrong proof, revoked room, and oversized frame.
- [ ] Pin local tooling; install once in the registered generated directory and reuse it. Run Miniflare/workerd with a temporary SQLite-backed namespace and no real account.
- [ ] Implement this exact administration/connection contract:

```js
// Admin key is a Worker secret, never present in a phone link.
// POST /admin/rooms, Authorization: Bearer <ADMIN_KEY>
// body: { room: /^[a-f0-9]{32}$/, proof: /^[a-f0-9]{64}$/ }
// Idempotent for same proof; incompatible existing proof is rejected.
// DELETE /admin/rooms/<room> revokes access and closes both sockets.
// GET /health => 200, no identities or credentials.
// GET /relay?room=<room>, websocket upgrade,
// Authorization: Bearer <relayProof(pair)>; reject before accept if unregistered.
// Existing JSON join message must match that room/proof/phone|computer role.
// Subsequent handshake/session bytes remain opaque, max 1 MiB.
// Same-role authenticated replacement closes the old socket; stale close cannot clear new socket.
```

- [ ] Use WebSocket hibernation attachments to retain socket identity; keep pairing authorization in DO storage. Do not save ciphertext or user requests. A service deploy/restart can disconnect sockets but must not erase pairing authorization.
- [ ] Retain only bounded room/socket metadata, validate routes/method/body sizes, compare authorization safely, and redact errors. No unauthenticated open relay.
- [ ] Document free-plan deployment, secrets via stdin, health/revoke/rollback commands, stable workers.dev origin, quotas and real-network acceptance. Do not deploy or create billing resources yet.
- [ ] Add a public static `/connect` bridge: capability remains in the browser fragment, an explicit Open DSH button links to the existing custom scheme. Add optional `/.well-known/assetlinks.json` for configured valid `ANDROID_CERT_SHA256` and `com.dshphone`; otherwise return 404. The exact deployed host can be supplied to Android's verified App Link manifest at final build; bridge remains the generic fallback. Test actual route responses without exposing fragments to the server.
- [ ] Run real runtime tests, then independent spec and quality reviews; fix all actionable findings.

## Task 2 — Desktop and shared peer recovery

Files: modify `peer/tunnel.mjs`, `peer/index.mjs`, `peer/page.html`, `scripts/install-desktop-peer.mjs`; add focused `peer/reconnect.test.mjs`, `peer/remote-service.mjs`, corresponding tests and installer coverage. Copy only these owned deltas to the phone peer source after validating its baseline.

- [ ] First reproduce websocket blackhole, stale close callback and repeated-start failures with local real servers. Cover pending non-idempotent call rejection without replay.
- [ ] Give each socket a generation, clean old retry/watchdog timers, bound initial handshake, detect dead sockets with ping/pong, and reconnect using jittered capped backoff. `stop()` invalidates pending callbacks; an explicit `reconnect()` repairs the transport without replacing the pair.
- [ ] Preserve the existing configured outbound proxy for WSS too: prefer optional SDK `proxyRouteFor()` (alpha.4); older phone SDK may lack that package. Use a per-connection native HTTP(S) Agent with the resolved HTTP proxy, never mutate global agents or silently ignore a selected proxy. Current Mac Node 24.14 and phone Node 26 support native `proxyEnv`; support detection must reject a selected proxy on older unsupported Node with an actionable error. Verify a synthetic proxy route and local/direct bypass. Reference: https://nodejs.org/api/http.html#built-in-proxy-support .

```js
// Runtime socket address only; stored pair.relay remains a clean fixed URL.
const address = new URL(pair.relay);
address.searchParams.set('room', pair.room);
const options = { headers: { Authorization: `Bearer ${relayProof(pair)}` } };
// Existing relay accepts this query/header; peer v1 ciphertext format is unchanged.
```

- [ ] Add private desktop remote-service settings (fixed relay + admin key in credentials), with status returning only readiness/hostname and no secret. Admin registration is idempotent and bounded; errors never echo credentials. Configuration and new-pair operations validate before mutating saved pair.
- [ ] Keep old `create` explicit rotation semantics. Add `prepare` that reuses the current pair and a `reconnect` action that never rotates credentials. Existing phone `pair` with the identical pair is idempotent. Expose useful connection phase/errors without leaking links.
- [ ] Make the primary desktop action “连接手机/复制连接链接”; keep advanced/manual legacy relay configuration available. Do not regenerate when revealing a saved link. Initial phone admission still requires deliberate confirmation.
- [ ] Preserve the old custom-scheme `link` and add an HTTPS `shareLink` at the fixed relay origin `/connect#<pairCode>` for managed services. UI copying prefers `shareLink`; no secret in the query or server request. Phone admission checks that any HTTPS bridge origin matches the decoded fixed relay origin.
- [ ] Diagnose the current live startup error independently using bounded read-only inspection or isolated reproduction. Do not change official runtime until a tested cause and reversible activation procedure exist.
- [ ] Update installer explicit file whitelist and run native plugin integration with synthetic credentials. Verify old peer/Pocket/model gateway/API sync behavior remains available. Complete spec and quality reviews.

## Task 3 — Android deep link and remembered computer

Files: add `app/src/main/java/com/dshphone/PeerConnection.kt` and focused Robolectric tests; minimally modify `MainActivity.kt`, `PocketConnection.kt`, `AndroidManifest.xml`. Reuse existing startup/readiness infrastructure.

Required release preservation: canonical native files contain unrelated WIP and app/assets 118, while installed Samsung is 120. Root prepared an exact stable121 maintenance source project at task `generated/phone-project` from validated119 APK and source commit `6874bc9aee6b3a767c85dbe5cea4af474ac37ddb`. Native owned deltas must also be applied to that stable source, excluding unrelated canonical WIP. New personal maintenance release is app122/0.2.17/assets122. Add `PhonePeerUpgrade.kt` with journaled, hash-checked tree/profile-only peer program migration from119/120/121 (chain existing tested compaction121 compatibility first), interrupted-write recovery, concurrent-edit/symlink rejection and idempotence. It must not replace the SDK, extensions, accounts or user data. Add minimal recovery/apply hooks to NodeRunner and exact-host manifest placeholder to Gradle. Root packages assets `remote-peer/manifest.json` and `remote-peer/files/<name>` for the five original peer files plus remote-service/transport-proxy, with old/new hashes and lengths; updater consumes only this signed manifest. Validate real old-to-new coverage upgrade in a disposable Android UID and preserve formal com.dshphone until idle/ready.

- [ ] Write failing tests for external Intent resolution, cold/hot intake, invalid link retention, first confirmation, readiness retry, same-pair idempotence and saved peer selection over old Pocket URL.
- [ ] Register only the intended exported entry:

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="dsh-phone" android:host="peer" android:path="/connect" />
</intent-filter>
```

- [ ] Optionally add exact-host HTTPS `/connect` App Link with a build-time `dshRemoteHost` manifest placeholder (safe `.invalid` default). Do not claim wildcard workers.dev hosts. Deployment's optional assetlinks fingerprint must match the checked APK signer; unsupported hosts use the browser bridge and custom scheme.

- [ ] Strictly validate scheme/host/path/fragment and decoded v1 room/secret/relay before changing state. Reject userinfo, query, malformed JSON/Base64, oversized input and external cleartext relay. Never log incoming capability links.
- [ ] Handle both initial Intent and `onNewIntent`, show a first-pair confirmation explaining computer access, wait for local DSH readiness off the UI thread, then send the existing loopback `pair` request using the native authenticated session. Start local service when required without canceling tasks.
- [ ] Remember connection kind after successful admission, not the capability link in ordinary preferences. “电脑” reconnects the saved peer and opens the proxy; Pocket remains selectable and can become preferred again after a successful Pocket connection. Invalid/canceled links leave prior preferences intact.
- [ ] On foreground/network recovery use a deduplicated bounded reconnect/check, preserve user drafts and main-page lifecycle; do not repeatedly reload a healthy remote page. Late callbacks from destroyed Activity/old intent cannot navigate.
- [ ] Run focused Robolectric, manifest and existing Pocket/lifecycle tests, then spec/quality reviews. Follow phone upgrade contract for any APK build/installation.

## Task 4 — Integration, packaging and deployment readiness

- [ ] Run desktop peer tests using `node --import ./scripts/desktop-test-imports.mjs --test peer/*.test.mjs` with task-scoped TMPDIR; phone tests use its existing import hook.
- [ ] Exercise the shipped peer implementation against the real local Worker emulator: pair, identity/UI response, network break, same saved-pair reconnect, service restart, revoke and invalid-link failure recovery. Record observable results, not only mock state.
- [ ] Compare protected input/index manifests and explain any concurrent changes. Retain owned patches and compact test receipts outside generated outputs.
- [ ] Prepare an APK only from validated maintained sources; bump app/assets if runtime resources change and inspect both SDK runtime copies. Never distribute stale ignored resource archives. Keep installed app/data intact until upgrade evidence and actual idle state allow activation.
- [ ] Prepare cloud login/deployment with reviewable configuration and no charges; ask the user only for the account login/authorization required to publish into their account. Never request a password or private key in chat.
- [ ] After authorized deployment, verify fixed HTTPS/WSS health, both device reconnects, computer/app restart and actual mobile-data/Wi-Fi switch; explicitly report any remaining device/authorization limitation.
- [ ] Perform final independent review, status/budget check and task-artifact cleanup with a retained receipt. Record only actually verified reusable experience.
