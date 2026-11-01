# DSH private fixed relay

This Worker forwards the existing peer v1 text/binary frames without interpreting or storing ciphertext, requests, model settings, files, or business operations. Only authorization metadata (room, relay proof, revocation state and authorization generation) and pending-join alarms are stored in a SQLite Durable Object per room. It borrows no third-party service or credentials.

## Local verification

Use Node 22 or later. `package.json` pins Wrangler 4.152.0, Miniflare 4.20260730.0 and ws 8.22.0. Tests use the stable Miniflare API; Wrangler's separately pinned internal Miniflare dependency is newer. Install dependencies in this directory using the pinned package lock, or link an existing compatible shared dependency installation as `node_modules`. Do not copy another repository or runtime.

```sh
cd /path/to/dsh-desktop/remote-relay
RELAY_TEST_ARTIFACTS=/path/to/task-artifacts node --test --test-concurrency=1 worker.test.mjs
WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler deploy --dry-run --config wrangler.jsonc --outdir /path/to/task-artifacts/dry-run
```

The test server uses actual local workerd and SQLite storage. WebSocket tests cross a real loopback TCP connection. Tests cover admission, exact opaque forwarding, reconnect, stale-role replacement, explicit hibernation eviction, revocation, full runtime restart, frame limits, transport ping/pong and the landing routes. The landing script is additionally exercised with synthetic fragments. Local results do not establish public Internet reachability or phone runtime behavior.

## Deployment after review and account authorization

Prerequisites: the user's Cloudflare account on Workers Free, an enabled `workers.dev` account subdomain, permission to deploy Workers and create SQLite Durable Objects, and a separately saved strong random admin key. No custom domain, paid plan, payment method or third-party relay account is required by this configuration. Run the following only after the user authorizes account access and deployment.

```sh
cd /path/to/dsh-desktop/remote-relay
./node_modules/.bin/wrangler login
./node_modules/.bin/wrangler whoami
./node_modules/.bin/wrangler deploy --config wrangler.jsonc
```

Confirm the intended account at `whoami`. The first deploy creates the `RelayRoom` namespace through migration `v1` with `new_sqlite_classes`; do not replace it with a legacy KV namespace. Until `ADMIN_KEY` exists, room registration fails closed. Set the secret through stdin; this zsh example reads without echo and never puts the key in Wrangler arguments, source, links or logs:

```zsh
set +x
read -rs 'relay_admin_key?ADMIN_KEY (saved securely): '
printf '\n'
printf '%s' "$relay_admin_key" | ./node_modules/.bin/wrangler secret put ADMIN_KEY --config wrangler.jsonc
unset relay_admin_key
```

Retain the configured Worker name and account subdomain. Its fixed address is `https://dsh-private-relay.<YOUR_ACCOUNT_SUBDOMAIN>.workers.dev`; the stored pair relay URL is the clean `wss://dsh-private-relay.<YOUR_ACCOUNT_SUBDOMAIN>.workers.dev/relay`. Do not use preview/version URLs as the persistent endpoint. Naming behavior is documented by [Cloudflare workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

```sh
curl --fail --silent --show-error 'https://dsh-private-relay.<YOUR_ACCOUNT_SUBDOMAIN>.workers.dev/health'
```

Expected response: `ok`, without room or device identities. This is a service health check, not end-to-end device acceptance.

## Authorization and wire contract

| Operation | Contract |
| --- | --- |
| Register | `POST /admin/rooms`, `Authorization: Bearer ADMIN_KEY`, JSON `{"room":"<32 lowercase hex>","proof":"<64 lowercase hex>"}`. First registration 201; same room/proof 200; different proof 409. Body at most 512 bytes. |
| Revoke | `DELETE /admin/rooms/<room>`, admin Bearer header, no body. Persists revocation and closes sockets. Repeating is safe. |
| Connect | WebSocket `GET /relay?room=<room>` and `Authorization: Bearer <relayProof(pair)>`. Missing, wrong, unknown and revoked credentials fail before acceptance. |
| Join | Existing first text frame `{"type":"join","room":"...","proof":"...","role":"phone"}` or role `computer`. It must match admission, within 5 seconds and 2048 bytes. |
| Forward | After join, original text/binary payloads pass unchanged, at most 1 MiB per message. Existing `joined`, `peer-online`, `peer-offline` signals are retained. |

The existing `relayProof(pair)` is SHA-256 of `dsh-peer-relay-v1\0` plus the pair secret. **ADMIN_KEY never belongs in a pair, phone link, relay URL, WebSocket join or log.** There is one active joined socket per role; an authenticated same-role join replaces the old socket. Two admitted but unjoined sockets are allowed, with an absolute cap of eight attached sockets including closing sockets. Attachments preserve socket identity and role through hibernation; SQLite preserves authorization through deploys/restarts. A routine Worker deploy can disconnect transports, requiring client reconnect.

Revoked credentials stay rejected after restart. Admin POST of the same room/proof explicitly re-enables it. To change a proof, create a fresh room instead of overwriting an existing identity.

For a manual registration or revocation, use this Python prompt so credentials remain out of CLI arguments and output; choose `register` or `revoke`. The computer onboarding flow may call the same API directly.

```sh
python3 - <<'PY'
import getpass, json, re, urllib.request, urllib.error
host = input('Fixed relay hostname: ').strip()
if not re.fullmatch(r'dsh-private-relay\.[a-z0-9-]+\.workers\.dev', host):
    raise SystemExit('Unexpected hostname')
operation = input('register or revoke: ').strip()
room = input('Room (32 lowercase hex): ').strip()
if operation not in ('register', 'revoke') or not re.fullmatch(r'[a-f0-9]{32}', room):
    raise SystemExit('Invalid operation/room')
admin = getpass.getpass('ADMIN_KEY: ')
data = None
if operation == 'register':
    proof = getpass.getpass('Relay proof (64 lowercase hex): ')
    if not re.fullmatch(r'[a-f0-9]{64}', proof): raise SystemExit('Invalid proof')
    data = json.dumps({'room': room, 'proof': proof}).encode()
path = '/admin/rooms' if operation == 'register' else '/admin/rooms/' + room
req = urllib.request.Request('https://' + host + path, data=data,
    method='POST' if operation == 'register' else 'DELETE',
    headers={'Authorization': 'Bearer ' + admin, 'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(req, timeout=15) as res: print('HTTP', res.status)
except urllib.error.HTTPError as error:
    print('HTTP', error.code)
PY
```

## Direct phone link and optional verified Android App Link

Share `https://<fixed-host>/connect#dsh-peer:1:<base64url-pair>` through the normal pairing flow. The server returns a static page: its script reads only `location.hash`, accepts the `dsh-peer:1:` base64url form up to 2048 characters, and creates an explicit `dsh-phone://peer/connect#...` link. There are no analytics, external requests, automatic navigation, install/download redirects or arbitrary URL handling. Pair data remains in the fragment; the phone performs the final strict pair validation. An installed phone build must already handle the DSH custom scheme. Browser/OS confirmation prompts can still appear.

An optional public Worker variable `ANDROID_CERT_SHA256` enables `GET /.well-known/assetlinks.json`. Configure it in `wrangler.jsonc` under `vars` as one to four comma-separated, colon-delimited SHA-256 certificate fingerprints, obtained from the actual APK signing certificate. It publishes package `com.dshphone` with relation `delegate_permission/common.handle_all_urls`. Any missing/invalid fingerprint returns 404. Example shape (replace with real public fingerprints before deploy):

```json
"vars": { "ANDROID_CERT_SHA256": "AA:BB:...:32 total bytes" }
```

The placeholder is intentionally invalid and must not be copied as a working certificate. After the account's fixed hostname is known, Android must also declare that exact host with `autoVerify` and `/connect` in its manifest; the JSON alone does not enable verified links. Verify both the published file and Android domain-verification state on the signed build. The explicit Open DSH button remains the fallback without verified App Links.

## Limits and transport behavior

Workers Free supports SQLite Durable Objects. At the documentation checked on 2026-10-25, DO allowances include 100,000 requests/day, 13,000 GB-s/day, 5 million row reads/day, 100,000 row writes/day and 5 GB stored data. WebSocket billing applies a 20:1 incoming-message ratio; outgoing messages and protocol pings are not billed as DO requests. Daily limits reset at 00:00 UTC and exceeding a dimension makes those operations fail. Worker request/CPU limits also apply separately. Check current [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Worker limits](https://developers.cloudflare.com/workers/platform/limits/) before deployment. Hibernation reduces idle duration; active transfer still consumes quota.

There is **no application ciphertext queue**. Workers exposes no documented `bufferedAmount`/drain guarantee, so this relay does not claim a hard bound on Cloudflare's internal send buffers. Native send failures close the failed connection and notify the surviving peer; accepting a send is not a delivery acknowledgement. Existing endpoint transfer windows/acknowledgements remain responsible for application flow control. The 1 MiB limit is enforced when workerd delivers a complete message to the handler; Cloudflare may first buffer the incoming message under its own platform limit.

[Hibernation control-frame behavior](https://developers.cloudflare.com/durable-objects/api/base/#websocketmessage) handles client protocol ping/pong automatically without introducing business messages. No text `ping`/`pong` auto-responder is installed. Pending joins use one persisted alarm per room and no recurring timer. The local workerd test observes the Close 1008 frame at about five seconds and can admit a new pending socket before TCP teardown finishes; alarm-originated close handshakes can linger, so test clients bound their close wait to one second. Cloudflare alarm failover/maintenance can add scheduling delay. Current two-peer ciphertext sessions have no recurring application alarm.

## Rollback and required acceptance

Record the deployed version ID. For a compatible previous version of the same Worker and Durable Object schema:

```sh
./node_modules/.bin/wrangler deployments list --config wrangler.jsonc
./node_modules/.bin/wrangler rollback <PREVIOUS_VERSION_ID> --config wrangler.jsonc --message 'Restore previously verified relay code'
```

Rollback changes code, not authorization data. Do not delete the Worker, namespace, migration or storage to roll back. Cross-migration rollback may be unsupported; use a compatible source revision and keep the existing namespace. If the first deployment has no prior version, revoke the affected rooms, or set `workers_dev` to `false` and redeploy to disable the public route while preserving the namespace. Account-side routes and version URLs must also be checked if any are enabled. See [Cloudflare rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

Before claiming delivery, test the deployed hostname with the user's actual signed phone build over both Wi-Fi and mobile data: open the shared HTTPS link, join the computer, complete the encrypted handshake, run a harmless round trip, background/foreground and reconnect, restart each endpoint and verify saved pairing, revoke and verify denial after reconnect. Test idle transport liveness and a representative bounded transfer. Phone/app installation, Android background restrictions, provider routing and regional reachability remain separate acceptance steps. A fixed domain and free plan do not promise universal reachability or continuous availability.
