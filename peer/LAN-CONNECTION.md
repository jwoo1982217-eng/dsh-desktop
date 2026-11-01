# Same-pair local and remote connection

The saved pairing and the phone's Computer entry stay unchanged. New peers prefer an authenticated local-network carrier, keeping the existing relay as a warm fallback. Leaving the local network falls back to that relay; returning prefers LAN again. Older peers continue using the original relay protocol.

The computer exposes a ciphertext-only WebSocket endpoint on a dynamically allocated port. Pair-authenticated UDP discovery uses port 40831; encrypted relay announcements and a small per-pair private cache also supply candidates. Candidates are literal private IPv4 addresses. Local carriers bypass HTTP proxy selection and retain the existing end-to-end encrypted peer handshake. They do not expose the desktop browser cookie or authenticated web server. The cache contains endpoints, never pair secrets or model credentials.

A bounded ordered channel acknowledges and deduplicates frames across the two carriers. A warm route change keeps existing proxy HTTP and WebSocket sessions. Losing every route rejects pending operations; reconnection does not submit a new copy of a previous operation. A core process restart is not required for choosing a route.

`/phone-peer` status and loopback `/__dsh_peer_status` report `route: lan | relay | offline`. The phone badge reports the same route. Relay control traffic can remain connected while application traffic uses LAN.

Optional MCP initialization happens after device connection registration, so a slow external tool does not delay the Computer entry. Normal desktop installation and Android runtime packaging must include `lan-link.mjs`, `lan-network.mjs`, `tunnel.mjs`, and their existing protocol/relay/proxy dependencies.

Validation covers real sockets, LAN with no working relay, authenticated broadcast discovery, old-peer compatibility, rejected unrelated pairings, a 762 KB WebSocket payload, ordered once-only delivery after lost acknowledgements, warm fallback, and full-disconnect recovery without replay. Device verification should additionally record the actual private socket address and original page behavior. An online flag alone is insufficient.
