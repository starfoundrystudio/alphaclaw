# OpenClaw 2026.9.4 upgrade — W5b closeout

## Outcome

Advanced OpenClaw Control UI access is now a distinct, acknowledgement-gated
surface. A normal Clawbridge login is necessary but no longer sufficient to
reach it. The user must accept the TeamYou warning, and AlphaClaw records that
acceptance before issuing a signed token tied to the current Clawbridge login
session.

Contract reference: `teamyou.managed-capabilities/v1@2026-09-18.1`

## Access contract

- The native Control UI lives only under `/openclaw`; the prefix is preserved
  through the proxy so OpenClaw 2026.9.4 can generate correct routes, assets,
  service-worker URLs, deep links, and WebSocket connections.
- Direct navigation and Clawbridge launches both require a signed advanced
  acknowledgement. Direct HTML navigation is sent to a TeamYou-branded
  interstitial; API, asset, service-worker, and WebSocket requests fail closed.
- The acknowledgement token is HMAC-signed and bound to the setup-session ID,
  setup-session expiry, managed instance ID, warning version, and managed
  contract revision. A new login, expired session, warning revision, contract
  revision, instance change, or invalid signature requires acknowledgement
  again.
- Every successful acknowledgement is appended to the auth database with the
  available user identity, setup-session ID, instance ID, warning version,
  managed contract revision, client address, and timestamp.
- Proxied Control UI HTML receives the persistent amber
  `Advanced — unmanaged changes` label. The label CSS is itself behind the same
  gate.

## Bypass coverage

| Path | Enforcement |
| --- | --- |
| `/openclaw` and native deep links | Clawbridge auth plus signed acknowledgement |
| Control UI assets and `/openclaw/sw.js` | Same `/openclaw` namespace gate |
| Control UI WebSocket | Setup-session validation plus signed acknowledgement |
| Legacy root WebSocket | Rejected; only the `/openclaw` Gateway namespace is proxied |
| Unknown Gateway `/api/*` fallback | Signed acknowledgement required after normal setup auth |
| Root-scoped legacy Control UI service worker | Replaced by a self-unregistering cache cleanup worker |
| Gateway network listener | Reconciled to `gateway.bind = "loopback"` |

Loopback binding prevents customer access around AlphaClaw's HTTP boundary. It
does not attempt to treat a privileged local process on the managed host as an
independent security boundary.

## Delivery to existing managed hosts

The change is idempotent and arrives through the normal AlphaClaw upgrade and
managed boot path:

- auth database initialization creates the acknowledgement audit table with
  `CREATE TABLE IF NOT EXISTS`;
- managed gateway reconciliation runs before Gateway startup and enforces
  `gateway.bind = "loopback"` plus `gateway.controlUi.basePath = "/openclaw"`;
- the updated Clawbridge bundle, interstitial, proxy gate, and root service
  worker ship in the AlphaClaw package.

No discontinued standalone-to-managed import path is involved.

## Deliberate scope boundary

W5b does not cap the native Gateway device scopes requested by the Control UI.
OpenClaw uses those scopes for its normal advanced-console functions, and
silently reducing them would make the UI partially fail rather than establish
a reliable read-only boundary. Managed configuration remains read-only through
the existing runtime policy; access containment is provided by the signed
AlphaClaw gate, loopback-only Gateway, and the agent policy established in W5a.

## Verification

- `npm run build:ui`
- Focused security, auth, proxy, Gateway, contract, and frontend suite: 9 files
  and 119 tests passed.
- Full suite: 163 files and 1,461 tests passed.
- Browser verification in the built-in in-app browser confirmed the rebuilt
  warning modal, disabled-until-accepted action, successful acknowledgement,
  acknowledged-session state, and no browser console errors.
- OpenClaw 2026.9.4 schema inspection confirmed `gateway.bind = "loopback"` and
  `gateway.controlUi.basePath` are current native configuration fields.
- Runtime dependency check confirmed AlphaClaw resolves Express 4.22.1 while
  OpenClaw retains its own Express 5.2.1 subtree.
- `git diff --check`
