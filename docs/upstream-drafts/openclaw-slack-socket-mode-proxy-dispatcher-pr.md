# Opened upstream: https://github.com/openclaw/openclaw/pull/155841

- Local branch: `fix/slack-socket-mode-proxy-dispatcher` in `/Users/billk/Development/openclaw-slack-socket-proxy`
- Base: `upstream/main` 1b2c512c1eb; commits cff6d8c182f and 65a8a0e0612
- Would push to: `bill-starfoundry/openclaw` (fork), PR against `openclaw/openclaw:main`, "Allow edits from maintainers" on

**Title:** fix(slack): Socket Mode never connects when HTTPS_PROXY is set

---

Closes #155840

## What Problem This Solves

Fixes: on Node, the Slack channel in Socket Mode never connects, and receives no events, when the Gateway has `HTTPS_PROXY`/`HTTP_PROXY` set (2026.9.5).

## User Impact

User impact: proxied Node Gateways receive Slack events again, with the Socket Mode WebSocket going through the configured proxy. Gateways without a proxy behave as before. Bun also behaves as before, which means its native Socket Mode WebSocket still ignores the proxy; Bun proxy support remains unresolved and is not claimed by this fix.

## Why This Change Was Made

Since #147421 the provider passes the runtime's undici 8 env-proxy dispatcher to Socket Mode. `@slack/socket-mode` 3 opens its WebSocket with its own undici 7. Its WebSocket supplies the legacy dispatch-handler interface, while undici 8 requires `onRequestStart`/`onResponseError`, so the dispatcher rejects it with `UND_ERR_INVALID_ARG: invalid onRequestStart method`; Socket Mode surfaces that as close 1006 with an empty error.

This change gives Socket Mode its own dispatcher, built from the undici copy Socket Mode uses, as #112963 originally did. The Web API dispatcher keeps using the shared runtime helper, which is paired with the runtime fetch, so #147421's Bun networking fix is untouched.

Bun is handled deliberately:

- The Socket Mode undici is loaded through the explicit `undici/index.js` subpath, the same technique the runtime uses to avoid Bun's bare-`undici` substitution.
- Under Bun, Socket Mode's bare `require("undici")` returns Bun's shim, whose WebSocket is Bun's native one and ignores `dispatcher`. So on Bun the Socket Mode connection is identical with the old dispatcher, the new one, or none.
- A malformed proxy URL retains the Web API dispatcher's existing direct-connection fallback. Failure to load Socket Mode's matching undici is allowed to surface rather than silently bypassing a configured proxy.

Not passing a dispatcher at all was rejected: Socket Mode's default is a direct `undici.Agent`, so proxy-only Gateways would lose Socket Mode entirely.

## Evidence

- New `extensions/slack/src/socket-mode-dispatcher.test.ts`: no proxy env keeps the default; the dispatcher is an instance of Socket Mode's own undici `EnvHttpProxyAgent`; a trusted `wss://` handshake uses only `HTTPS_PROXY` and asserts its CONNECT target; a separate HTTPS-proxy case first fails without the managed proxy CA, then succeeds with it; and a plain `ws://` end-to-end case remains covered.
- Provider-boundary coverage starts the Slack monitor and proves the dispatcher handed to `SocketModeReceiver` comes from Socket Mode's own undici copy.
- Final candidate after rebasing onto current `upstream/main` (2026-09-22): `node --import ./scripts/tsx.mjs scripts/test-extension.mts slack` passed 174 files and 3140 tests. `pnpm tsgo:extensions` passes. oxlint and oxfmt are clean on the changed files.
- Node 24.18, the real module against a local CONNECT proxy and echo WebSocket:

  | Socket Mode dispatcher | Result | Through proxy |
  | --- | --- | --- |
  | New Socket Mode dispatcher | echo received | yes |
  | Current Web API dispatcher (2026.9.5 behavior) | close 1006 | no |
  | None | echo received | no, direct |

- Bun 1.3.12, the new loader chain against the same local setup: the subpath undici loads and `EnvHttpProxyAgent` is constructed; Socket Mode's `WebSocket` is Bun's native one; the connection result is identical with the new dispatcher and with none, and neither touches the proxy. This matches the pre-regression behavior on Bun.
- Live: the equivalent change applied to an installed `@openclaw/slack@2026.9.5` on a Linux Gateway whose only egress is an HTTP CONNECT proxy. Socket Mode connected, zero WebSocket errors, DMs answered; the Gateway's only outbound connection was to the proxy.

Gaps:

- Public Bun 1.3.12 cannot load the runtime's undici 8 (`webidl.util.markAsUncloneable`), so the full provider could not be run there. Bun 1.4.0 can load it and the Socket Mode loader/WebSocket behavior was checked there, but the full Slack provider was not exercised under Bun. The public Bun CI lane currently covers launcher and module-generation paths rather than Slack Socket Mode.
- Bun's native WebSocket still ignores the proxy for Socket Mode. That predates this change and is out of scope here.
- `pnpm tsgo:extensions:test` fails on upstream `main` in an unrelated qa-lab Discord test (missing `assertHealthy`); no Slack errors.
