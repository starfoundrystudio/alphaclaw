# Spike: hosting a Clawbridge page inside the Control UI (2026-09-16)

Status: **PASSED** on a local rig (no AlphaClaw, no dual-VPS). Result feeds
[`05-clawbridge-vs-control-ui.md`](05-clawbridge-vs-control-ui.md) §4.2.

## Rig

- `openclaw@2026.9.4` installed into a scratch directory on macOS, Node
  v24.18.0, headless `openclaw onboard --non-interactive --accept-risk
  --skip-health --skip-bootstrap --auth-choice skip --flow quickstart
  --gateway-bind loopback --gateway-port 18989 --gateway-auth token
  --no-install-daemon --json`. Observation: the fresh 9.4 config already uses
  keyed `agents.entries` (confirms matrix B1 for new provisions).
- Config patched to: `gateway.auth.mode: "trusted-proxy"`,
  `gateway.trustedProxies: ["127.0.0.1"]`, `trustedProxy.allowLoopback: true`,
  `userHeader: x-forwarded-user`, `requiredHeaders: [x-forwarded-proto,
  x-forwarded-host]`, `deviceAutoApprove` (read/write/approvals/questions),
  `identityScopes` (`bill@example.com` → `operator.admin`,
  `reader@example.com` → `operator.read`), `gateway.controlUi.basePath:
  "/openclaw"`, `allowedOrigins: [http://localhost:8080]`,
  `embedSandbox: "trusted"`, `communityInvite: false`, `environment: {label:
  "spike", color: "amber"}`, `gateway.terminal.enabled: false`,
  `gateway.cliAgents.enabled: false`, `plugins.load.paths` → local spike
  plugin, `plugins.entries.clawbridge-spike.enabled: true`.
- A 90-line Node front door on `:8080` standing in for Clawbridge: serves
  `/spike.html` (sets an `HttpOnly` cookie, opens a WebSocket, writes to
  localStorage, calls `/spike/whoami` with credentials) and reverse-proxies
  everything else, including WebSocket upgrades, to the Gateway with
  `x-forwarded-user`, `x-forwarded-proto`, `x-forwarded-host`, and a
  non-loopback `x-forwarded-for` (as on the tailnet).
- Throwaway plugin (`openclaw.plugin.json` + `index.js` using
  `definePluginEntry`): `api.registerHttpRoute({ path: "/clawbridge-spike",
  auth: "gateway", match: "exact" })` returning an HTML document that frames
  `/spike.html`, and `api.session.controls.registerControlUiDescriptor({
  surface: "tab", id, label: "Clawbridge", group: "control", slug:
  "clawbridge", path: "/clawbridge-spike", requiredScopes })`. Loaded from a
  local path; the Gateway logs an "unverified source" warning but loads it.

## Results (verified in a real Chrome profile)

| Check | Result |
| --- | --- |
| Trusted-proxy sign-on through the front door | No token prompt, no device-pairing modal; Gateway audit log shows `identity scope grant elevated … addedScopes=operator.admin`. |
| `basePath: /openclaw` behind the proxy | All assets, `control-ui-config.json`, and routes served under the prefix; no rewrite needed. |
| Environment label | "spike" badge and title suffix rendered before and after sign-in. |
| Sidebar entry from a plugin tab descriptor | "Clawbridge" appears in the control group; `/openclaw/clawbridge` slug deep link opens it. |
| Plugin route rendered in the tab frame | The Gateway-served document loaded; bootstrap `pluginFrameGrants` listed the route. |
| Nested same-origin frame to the front door | Loaded; reports `origin=http://localhost:8080`, `framed=true`. |
| Cookie session inside the frame | `/spike/whoami` with `credentials: include` → `cookie: true` (requires `embedSandbox: "trusted"`). |
| WebSocket from inside the frame | `ok:echo:ping`. |
| localStorage inside the frame | `ok`. |
| Scope-based hiding | With `requiredScopes: ["operator.admin"]` and a read-only identity: no sidebar entry, slug deep link falls back to Home. Switching back to the admin identity restores both without a Gateway restart. |
| First-run gate | With no selectable model the Control UI forces Model Setup and hides the sidebar; a configured credential lifts it. Managed onboarding always configures a model, so this only matters for the rig. |

## Caveats found

- The in-app Claude desktop browser blocked the plugin frame's auth probe
  (`ERR_BLOCKED_BY_CLIENT`); real Chrome did not. Not an OpenClaw issue.
- `document.cookie` inside the frame exposed every cookie set for
  `localhost` (cookies are not port-scoped), so on a developer machine the
  stub page could read unrelated local-app cookies. In production Clawbridge
  has its own hostname; the session cookie should still be `HttpOnly` and
  the embed page must not print cookies.
- `embedSandbox: "trusted"` grants `allow-same-origin` to every plugin tab
  frame, not only ours; acceptable on managed instances because the plugin
  set is controlled (deny-list, single enablement writer).
- Changing the tab's `requiredScopes` required a Gateway restart (plugin
  code change); identity changes did not.

## What the real implementation needs

1. A managed Clawbridge plugin (bundled into the install like the
   usage-tracker and agent-vault plugins) that registers one
   `auth: "gateway"` HTTP route per hosted section and one tab descriptor per
   section with `slug`, `group: "control"`, `order`, and `requiredScopes`.
2. A Clawbridge embed render mode for the hosted routes: no sidebar, no top
   bar, no login redirect when framed (rely on the existing cookie session),
   and the Control UI theme tokens.
3. Managed config: `basePath`, `allowedOrigins`, `embedSandbox: "trusted"`,
   `environment`, `communityInvite: false`, trusted-proxy auth as above with
   Clawbridge setting the identity header from its own session and
   stripping client-supplied forwarded headers.
4. Phase 6 security review of the trusted-proxy configuration (loopback
   bind, host firewall, header stripping, `requiredHeaders`).
