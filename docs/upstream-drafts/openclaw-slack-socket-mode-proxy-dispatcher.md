# DRAFT — not filed. Needs Bill's review before anything is posted to openclaw/openclaw.

**Title:** [Bug]: Slack Socket Mode never connects when HTTPS_PROXY is set (2026.9.5): undici 8 proxy dispatcher passed to @slack/socket-mode's undici 7 WebSocket

---

### Summary

Since 2026.9.5, the Slack channel in Socket Mode cannot connect on any Gateway
that has `HTTPS_PROXY`/`HTTP_PROXY` set. The WebSocket handshake fails
immediately with an empty error, the channel retries forever, and no events are
received. Slack Web API calls (`auth.test`, `apps.connections.open`) keep
working, so the channel looks configured and the probe is green.

### Environment

- openclaw `2026.9.5`, `@openclaw/slack@2026.9.5` (#147421 merged 2026-09-14, after 2026.9.4 shipped)
- Node 26.9.0, Linux x64
- Slack channel, `mode` default (Socket Mode), single account
- Gateway process environment has `HTTPS_PROXY`/`HTTP_PROXY` pointing at an
  HTTP CONNECT egress proxy (with its CA in `NODE_EXTRA_CA_CERTS`)

### Symptoms

Gateway log, repeating roughly every 15 s:

```
socket-mode:socket-mode WebSocket error occurred:
socket-mode:socket-mode WebSocket error! SMWebsocketError
[slack] socket mode failed to start; retry 1/∞ in 2s reason="Slack Socket Mode start failed after disconnect without error detail; last SDK log: socket-mode:socket-mode WebSocket error! SMWebsocketError"
```

The error message is empty. DMs to the app get no reply. Slack's `hello` frame
on other connections reports a growing `num_connections` (see also #128809).

### Root cause

`extensions/slack/src/monitor/provider.ts` passes `dispatcher: slackDispatcher`
into `createSlackBoltApp`, which forwards it to `SocketModeReceiver`, and
`@slack/socket-mode` 3.0.1 creates its WebSocket with
`new undici.WebSocket(url, { dispatcher })` using **its own undici 7.29.1**.

`slackDispatcher` comes from `resolveSlackProxyDispatcher()`, which since #147421
returns `createHttp1EnvHttpProxyAgent(...)` from
`openclaw/plugin-sdk/fetch-runtime`, built with **OpenClaw's undici 8.10.x**. An
undici 8 dispatcher used by an undici 7 WebSocket fails the handshake at once
(close code 1006, empty `ErrorEvent`).

`resolveSlackProxyDispatcher()` returns `undefined` when no proxy env is set,
which is why this only affects proxied Gateways.

### History

- #112963 (merged 2026-07-24) migrated to Bolt 5 / socket-mode 3 and introduced
  one shared proxy dispatcher for Web API fetch and Socket Mode. It was built
  with Slack's own undici (resolved from `@slack/socket-mode/package.json`), and
  the PR verified a Socket Mode handshake through a real CONNECT proxy.
- #147421 (merged 2026-09-14, "restore plugin networking under Bun") replaced it
  with the shared `createHttp1EnvHttpProxyAgent`. The PR notes that Slack keeps
  undici 7 because Socket Mode requires that peer version, but the dispatcher
  handed to Socket Mode is now an undici 8 object. Its validation does not
  include a Socket Mode handshake through a proxy.

### Reproduction

On a host with an HTTP CONNECT proxy and a Slack app token (`xapp-…`,
`connections:write`):

```js
// Save as repro.mjs inside the installed @openclaw/slack package; run with HTTPS_PROXY set.
import { createRequire } from "node:module";
const here = createRequire(import.meta.url);
const req = createRequire(here.resolve("@slack/socket-mode/package.json"));
const fr = await import("openclaw/plugin-sdk/fetch-runtime");
const { SocketModeClient } = req("./dist/src/index.js");

const dispatcher = fr.createHttp1EnvHttpProxyAgent(
  fr.resolveEnvHttpProxyAgentOptions(), undefined, process.env);
const client = new SocketModeClient({
  appToken: process.env.SLACK_APP_TOKEN,
  autoReconnectEnabled: false,
  dispatcher,
  clientOptions: { fetch: (u, i) => globalThis.fetch(u, i) },
});
await client.start();
```

Observed: `apps.connections.open` succeeds, then `WebSocket error occurred:`
(empty) and close `1006` about 0.3 s later.

Controls, same host, proxy and token:

| Variant | Result |
| --- | --- |
| `dispatcher` = `new EnvHttpProxyAgent()` from Slack's own undici 7 (resolved next to the plugin, the copy socket-mode uses) | Connects through the proxy, `hello`, stable |
| Same, with that dispatcher pointed at a dead proxy port | Fails, close 1006 (proves the WebSocket uses the proxy) |
| No `dispatcher` option | Connects **directly**, bypassing the proxy: socket-mode's default is a plain `undici.Agent` (`buildDefaultDispatcher`), which ignores `HTTPS_PROXY` |
| `dispatcher` = `createHttp1EnvHttpProxyAgent(...)` (OpenClaw's undici 8) | Fails at handshake, close 1006 |

Replacing `dispatcher: slackDispatcher` in the installed
`dist/.setup/provider-*.mjs` with an `EnvHttpProxyAgent` from Slack's undici
(when a proxy env is set) makes the Gateway's Slack channel connect through the
proxy (`socket mode connected`, zero errors; the Gateway's only outbound
connection is to the proxy).

### Fix

A PR accompanies this issue (draft: `openclaw-slack-socket-mode-proxy-dispatcher-pr.md`).
It builds the Socket Mode dispatcher from the undici copy `@slack/socket-mode`
uses, loaded through the explicit `undici/index.js` subpath the runtime already
uses to avoid Bun's bare-specifier substitution. The Web API dispatcher stays on
`createHttp1EnvHttpProxyAgent`, so #147421's Bun networking fix is untouched.

Under Bun, Socket Mode's WebSocket is Bun's native one, which ignores
`dispatcher`, so Bun behavior is identical before and after (checked on Bun
1.3.12 against a local CONNECT proxy).

Not passing a dispatcher is **not** a fix: Socket Mode's default dispatcher is a
direct `Agent`, so proxy-only deployments would lose Socket Mode entirely (the
proxy support #112963 added).

### Other channels checked (2026.9.5)

Not affected by this mismatch: Discord (REST pairs `createHttp1EnvHttpProxyAgent`
with `fetchWithRuntimeDispatcher`, same undici; the gateway WebSocket uses `ws`
options), Telegram (bundled; OpenClaw fetch + OpenClaw dispatcher, HTTP long
polling), Mattermost and Nextcloud Talk (no own undici/ws dependency), Microsoft
Teams (does not use the shared proxy helper).

### Related

- #128809 — reconnects leak sockets; ping-timeout warnings are suppressed, which
  hid this failure mode (only the empty `SMWebsocketError` reaches the log).
