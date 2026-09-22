# DRAFT — not filed. Needs Bill's review before anything is posted to openclaw/openclaw.

**Title:** [Bug]: Slack Socket Mode never connects when HTTPS_PROXY is set (2026.9.4+): undici 8 proxy dispatcher passed to @slack/socket-mode's undici 7 WebSocket

---

### Summary

Since 2026.9.4, the Slack channel in Socket Mode cannot connect on any Gateway
that has `HTTPS_PROXY`/`HTTP_PROXY` set. The WebSocket handshake fails
immediately with an empty error, the channel retries forever, and no events are
received. Slack Web API calls (`auth.test`, `apps.connections.open`) keep
working, so the channel looks configured and the probe is green.

### Environment

- openclaw `2026.9.5` (also affects `2026.9.4`), `@openclaw/slack@2026.9.5`
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
// Run from the installed @openclaw/slack package with HTTPS_PROXY set.
import { createRequire } from "node:module";
const req = createRequire(require.resolve("@slack/socket-mode/package.json"));
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
| Same client, **no** `dispatcher` option (Socket Mode builds its own env-proxy dispatcher) | Connects, `hello`, pongs within 0.1 s, stable 25 s |
| `dispatcher` = `new EnvHttpProxyAgent()` from socket-mode's undici 7 | Connects, stable |
| Same, with `@openclaw/proxyline` managed mode installed | Connects, stable |
| `dispatcher` = `createHttp1EnvHttpProxyAgent(...)` (OpenClaw's undici 8) | Fails at handshake, close 1006 |

Removing `dispatcher: slackDispatcher` from the `createSlackBoltApp(...)` call in
the installed `dist/.setup/provider-*.mjs` makes the Gateway's Slack channel
connect (`socket mode connected`, zero errors) through the same proxy.

### Suggested fix

Either of:

1. Build the Socket Mode dispatcher with the undici copy that `@slack/socket-mode`
   uses (as #112963 did), keeping `createHttp1EnvHttpProxyAgent` for Web API
   fetch; under Bun, fall back to option 2.
2. Stop passing `dispatcher` to `SocketModeReceiver` and let Socket Mode build
   its default env-proxy dispatcher, which honours `HTTPS_PROXY`/`NO_PROXY`.

A regression test that opens a Socket Mode connection through a local CONNECT
proxy (as in #112963's evidence) would catch this class of mismatch.

### Related

- #128809 — reconnects leak sockets; ping-timeout warnings are suppressed, which
  hid this failure mode (only the empty `SMWebsocketError` reaches the log).
