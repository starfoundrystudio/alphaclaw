# DRAFT — not opened. Needs Bill's review before anything is pushed to openclaw/openclaw.

- Local branch: `fix/slack-socket-mode-proxy-dispatcher` in `/Users/billk/Development/openclaw-slack-socket-proxy`
- Base: `upstream/main` 21cbb3cd724; commit 88758c90b1e
- Would push to: `bill-starfoundry/openclaw` (fork), PR against `openclaw/openclaw:main`, "Allow edits from maintainers" on

**Title:** fix(slack): Socket Mode never connects when HTTPS_PROXY is set

---

Closes #<issue-number>

## What Problem This Solves

Fixes: the Slack channel in Socket Mode never connects, and receives no events, when the Gateway has `HTTPS_PROXY`/`HTTP_PROXY` set (2026.9.5).

## User Impact

User impact: proxied Gateways receive Slack events again, with the Socket Mode WebSocket going through the configured proxy. Gateways without a proxy and Gateways running on Bun behave exactly as before.

## Why This Change Was Made

Since #147421 the provider passes the runtime's undici 8 env-proxy dispatcher to Socket Mode. `@slack/socket-mode` 3 opens its WebSocket with its own undici 7, and a dispatcher from another undici copy fails the handshake at once (close 1006, empty error).

This change gives Socket Mode its own dispatcher, built from the undici copy Socket Mode uses, as #112963 originally did. The Web API dispatcher keeps using the shared runtime helper, which is paired with the runtime fetch, so #147421's Bun networking fix is untouched.

Bun is handled deliberately:

- The Socket Mode undici is loaded through the explicit `undici/index.js` subpath, the same technique the runtime uses to avoid Bun's bare-`undici` substitution.
- Under Bun, Socket Mode's bare `require("undici")` returns Bun's shim, whose WebSocket is Bun's native one and ignores `dispatcher`. So on Bun the Socket Mode connection is identical with the old dispatcher, the new one, or none.
- If the undici copy cannot be loaded, the function returns `undefined`, the same fallback the Web API dispatcher uses on errors.

Not passing a dispatcher at all was rejected: Socket Mode's default is a direct `undici.Agent`, so proxy-only Gateways would lose Socket Mode entirely.

## Evidence

- New `extensions/slack/src/socket-mode-dispatcher.test.ts`: no proxy env keeps the default; the dispatcher is an instance of Socket Mode's own undici `EnvHttpProxyAgent`; managed proxy CA mode works; and an offline end-to-end test opens Socket Mode's WebSocket through a local HTTP CONNECT proxy to a local echo server and asserts the echo and the CONNECT.
- Slack extension suite: 173 files, 3137 tests passed. `pnpm tsgo:extensions` passes. oxlint and oxfmt clean on the changed files.
- Node 24.18, the real module against a local CONNECT proxy and echo WebSocket:

  | Socket Mode dispatcher | Result | Through proxy |
  | --- | --- | --- |
  | New Socket Mode dispatcher | echo received | yes |
  | Current Web API dispatcher (2026.9.5 behavior) | close 1006 | no |
  | None | echo received | no, direct |

- Bun 1.3.12, the new loader chain against the same local setup: the subpath undici loads and `EnvHttpProxyAgent` is constructed; Socket Mode's `WebSocket` is Bun's native one; the connection result is identical with the new dispatcher and with none, and neither touches the proxy. This matches the pre-regression behavior on Bun.
- Live: the equivalent change applied to an installed `@openclaw/slack@2026.9.5` on a Linux Gateway whose only egress is an HTTP CONNECT proxy. Socket Mode connected, zero WebSocket errors, DMs answered; the Gateway's only outbound connection was to the proxy.

Gaps:

- Public Bun 1.3.12 cannot load the runtime's undici 8 (`webidl.util.markAsUncloneable`), so the full provider could not be run under public Bun. The repo's Bun lane should confirm on its Bun build.
- Bun's native WebSocket still ignores the proxy for Socket Mode. That predates this change and is out of scope here.
- `pnpm tsgo:extensions:test` fails on upstream `main` in an unrelated qa-lab Discord test (missing `assertHealthy`); no Slack errors.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
