# OAuth Broker v2 — Connector, Grant, and Consumer Framework

**Status:** SHELVED BY OWNER 2026-08-28. Retained as an architecture record;
current implementation work is limited to the known Claude subscription and
gog CLI seams.
This document defines the recommended next phase after the Codex seam. The
revision incorporates the
Vercel Connect distinction between owner-managed connector registration and
runtime token retrieval: standard OAuth/OIDC providers and token-compatible
CLIs should be addable without an AlphaClaw or gateway release. It is not yet an
shipping implementation or a release commitment. The existing schema-v1 broker
and Codex integration remain authoritative until v2 is implemented and shipped.
The proposed owner-authentication, consent, SSRF, audit, and recovery contracts
are in `oauth-broker-v2-management-plane.md` and must be reviewed before
schema-v2 gateway code.

**Why this companion exists:** `oauth-refresh-broker-spec.md` correctly defines
the custody boundary, but its original gog plan assumed another proactive
credential-store rewrite. Inspection of gog and of AlphaClaw's multi-account
Google setup exposed a more general seam: applications that accept a short-lived
access token should receive one at invocation time. That pattern should be a
framework, not a new refresh implementation for every OAuth application. The
first draft still made provider policy a gateway release artifact; this revision
corrects that scaling limitation by introducing owner-created Custom OAuth/OIDC
connectors and user-created consumer bindings.

## 1. Goals and non-goals

Goals:

- Keep refresh tokens and OAuth client secrets durably off the workload VPS.
- Preserve the honest trust model: the workload, including `root`, can read and
  use a live access token, but cannot recover the durable grant from disk.
- Support more than one account and OAuth client for the same provider.
- Let an owner add a standards-compliant OAuth/OIDC provider as validated
  connector data without publishing a gateway asset or AlphaClaw release.
- Let a user bind an unknown CLI to a grant without an AlphaClaw release when
  the CLI accepts an externally supplied access token.
- Keep built-in provider templates and known-CLI bindings for tested defaults
  and good UX without making them the only supported path.
- Make consumer integration a declarative access-token delivery seam rather
  than duplicating refresh, rotation, caching, revocation, and storage logic.
- Separate owner-authorized connector management from the workload's ordinary
  token-use capability.
- Keep gateway egress destinations and request shapes controlled by reviewed
  connector configuration, never by a token request from the workload.
- Preserve schema-v1 Codex behavior through a rolling migration.

Non-goals:

- Pretend every credential called "OAuth" has the same lifecycle.
- Hide a live access token from a root-capable workload that must use it.
- Turn the broker into an arbitrary HTTP proxy or accept provider URLs from the
  workload.
- Automatically support an application that can only consume its own durable
  refresh-token store. Such a consumer needs a supported injection seam, an
  upstream change, or an explicit risk decision.
- Guarantee that every product labeled OAuth follows standard OAuth/OIDC
  metadata and token contracts. Non-standard dialects may still require a
  reviewed connector driver.
- Solve upgrades of existing dual-VPS instances. That remains part of the
  separate topology upgrade program; the design here must be roll-forward
  compatible, but its first target can be fresh provisions.

## 2. Findings from the gog spike

AlphaClaw and the clawctl host assets currently pin gog `0.11.0`. That release
only reads stored refresh tokens and refreshes them internally.

gog `0.12.0` (commit `c18c58c8daadce2d6b4a6cf4fe95b1e3817bae1b`,
released 2026-03-09) added `--access-token` / `GOG_ACCESS_TOKEN`. Source and
release-binary inspection established that this mode:

- constructs a static OAuth token source;
- bypasses OAuth client credential reads;
- bypasses keyring reads and writes;
- performs no automatic refresh; and
- accepts an explicit `--account` as the account label used by commands.

A release-binary probe ran a real Gmail command with an intentionally invalid
direct token and an empty temporary `XDG_CONFIG_HOME`. The command reached
Google and failed with the expected 401 without creating a credentials file,
keyring, or gog configuration directory. The upstream source tests also assert
that neither the credential reader nor secrets store is opened in this mode.

`0.12.0` is the **capability floor**, not automatically the production pin. A
current gog release should be selected by a separate bounded upgrade review.

This makes invocation-time access-token injection the safest gog seam. It also
exposes two constraints that schema v1 cannot represent:

1. AlphaClaw supports up to five Google accounts and named OAuth clients, while
   schema v1 keys a grant only by `(consumer, provider)`. It can hold only one
   `gog/google` grant.
2. Agents invoke `gog` directly. Changing only AlphaClaw's internal `gogCmd`
   would leave agent shell commands on the legacy keyring path.

The production seam therefore needs an executable shim in the agent's normal
`PATH`. The shim selects an account-specific grant, asks the broker for an
access token, places it only in the child environment, and `exec`s the real gog
binary. No refresh token or access-token file is created.

## 3. Credential and consumer classes

New OAuth use cases should be classified before implementation:

| Class | Consumer behavior | Safe broker seam |
| --- | --- | --- |
| Lease-compatible | Accepts a caller-supplied bearer token through an environment variable, flag, callback, or in-memory API | Request a short-lived lease at invocation or shortly before use. Preferred. |
| Fixed self-refreshing store | Insists on reading and rewriting its own refresh-token store | Use an upstream injection feature, a reviewed shim/patch, or fail closed. Do not copy the durable grant back to the workload merely for compatibility. |
| Proof-bound or signing | Requires DPoP, mTLS, request signing, or another private-key operation | Keep the proof key on the gateway and expose a narrow signing/proxy operation; returning a bearer token may be insufficient. |
| Service account / workload identity | Uses a private key, ambient cloud identity, or delegated service principal rather than a user refresh grant | Treat as a separate credential class. Prefer workload identity or gateway-side signing; do not force it into the refresh-grant schema. |

There will still be a small consumer seam: the system must know *where* a
particular program accepts a lease and *which account* a command means. The
scalable objective is to make that seam declarative or very small, not to claim
that arbitrary binaries can be integrated without any knowledge of them.

### 3.1 What "arbitrary" means

Provider compatibility and consumer compatibility are different problems:

| Question | Generic path | Hard limit |
| --- | --- | --- |
| Can an owner connect a previously unknown standard OAuth/OIDC provider? | Create a Custom OAuth/OIDC connector containing validated provider metadata, client registration, redirect URIs, and scope ceiling. No product release. | A non-standard token dialect or proof scheme may need a reviewed driver. |
| Can a user run a previously unknown CLI with that grant? | Create a consumer binding describing the grant and the CLI's environment-variable, credential-process, stdin, or flag seam. No product release. | A CLI that insists on owning a local refresh token cannot be made brokered by configuration alone. |

This is also the boundary in hosted brokers such as Vercel Connect. Their
generic connector centralizes consent and token issuance, but consuming code
still calls an SDK, CLI, or HTTP token API and passes the result to the target
service. It does not transparently retrofit a refresh-token-only executable.

## 4. Gateway object model

Schema v2 should separate four concepts currently collapsed into one sealed
grant record.

### 4.1 Connector type

A connector type is gateway code that implements a protocol family. The first
types should be:

- `standard-oauth2`, driven by validated connector metadata;
- `oidc`, using validated issuer discovery and PKCE where applicable; and
- named built-in drivers only for providers whose behavior cannot be expressed
  safely by the standard schemas.

The standard types define the allowed fields and protocol behavior, including:

- authorization, token, and revocation endpoints;
- redirect behavior (redirects remain rejected for token/revocation calls);
- authorization-code and refresh request encodings;
- client authentication method (`none`, body secret, HTTP Basic, private-key
  JWT, or a named reviewed driver);
- authorization response type and PKCE requirements;
- permitted request parameters and fixed headers;
- access-token and refresh-rotation response fields;
- expiry calculation;
- scope syntax, allowed scope set, and narrowing behavior; and
- optional metadata/userinfo behavior.

The workload never supplies an endpoint, arbitrary header, request template, or
response parser as part of a token request. Adding a genuinely new protocol
type remains a reviewed gateway-code change; adding another provider that fits
an existing type does not.

### 4.2 Connector

A connector is an owner-managed instance of a connector type. It combines the
provider metadata and OAuth client registration needed to authorize grants:

- stable opaque `connector_id` and connector-type/version reference;
- authorization, token, revocation, issuer, and optional userinfo metadata;
- client ID;
- sealed client secret or private key when applicable;
- exact allowed redirect URI set; and
- allowed scope ceiling, authentication method, PKCE requirements, and
  non-secret display metadata.

Connectors may come from built-in templates (for example Google or OpenAI) or be
Custom OAuth/OIDC connectors entered by the owner. Owner-supplied client
credentials are deposited on the gateway. AlphaClaw may retain the connector
ID, client ID, endpoint origins, and display metadata; it must not retain the
client secret.

Connector creation, endpoint changes, client-secret rotation, redirect changes,
and scope-ceiling changes are **management-plane actions**. The normal
workload broker identity must not have this capability. Otherwise a compromised
sudo-capable workload could redefine a token endpoint and turn the gateway into
an arbitrary secret-bearing HTTP client. Management requires an externally
authenticated owner action, such as a TeamYou owner session or a distinct
short-lived gateway administration capability.

Custom connector validation must include:

- HTTPS-only endpoints with no userinfo or fragments;
- rejection of loopback, private, link-local, multicast, metadata-service, and
  other non-public destinations after DNS resolution and again at connection;
- exact issuer validation for OIDC discovery;
- explicit display and approval of endpoint origins, client-auth method,
  redirects, and scope ceiling;
- no token/revocation redirects; and
- immutable versioning or mandatory re-consent when security-relevant connector
  fields change while grants exist.

### 4.3 User grant

A grant represents one account's consent:

- stable opaque `grant_id`;
- `connector_id` and connector-version reference;
- sealed refresh token and any provider-rotated replacement;
- consented scopes and whether that set is authoritative;
- sealed cached access token;
- non-secret account/display metadata; and
- expiry, refresh, and revocation status timestamps.

`grant_id` must be independent of provider email and safe to expose on the
workload. AlphaClaw's Google account state can map `(client, normalized email)`
to it. The gateway must reject a grant whose connector/version reference is
missing, superseded, or incompatible.

### 4.4 Consumer binding

A consumer binding is non-secret workload configuration that explains how to
deliver a lease to a program:

- stable local binding name;
- `grant_id` or an account-to-grant selector;
- absolute executable path or credential-helper identity;
- token delivery method and destination;
- requested scopes and minimum remaining lifetime; and
- optional account-selection rules.

Bindings may be built in or user-created. They may be editable by workload root
because they cannot change provider endpoints, client registrations, grants, or
scope ceilings. A compromised workload can redirect a returned access token to
another local process, but it could already call the token-use operation and
read that short-lived token; the durable-secret boundary is unchanged.

## 5. Recommended schema-v2 operations

Exact field names can change during implementation, but management and use must
remain separate.

Owner-authorized management plane:

| Operation | Purpose |
| --- | --- |
| `connector_create` | Validate and create a built-in or Custom OAuth/OIDC connector, sealing client credentials. |
| `connector_update` | Create a new connector version; require re-consent when security-relevant fields change. |
| `connector_delete` | Remove a connector only when no live grants reference it, unless the owner explicitly cascades revocation. |
| `authorization_start` | Create a gateway-owned, owner-session-bound consent transaction and redirect the browser to the provider. The management-plane proposal removes the need to give this capability to the workload. |
| `authorization_complete` | Receive the provider callback on the gateway, exchange the code, and atomically store the grant. |

Constrained workload use plane:

| Operation | Purpose | Secret returned to workload? |
| --- | --- | --- |
| `status` | List non-secret connector/grant health and denial state visible to the instance | No |
| `access_token` | Resolve `grant_id`, refresh/cache under its connector version, and return a scoped short-lived lease | Yes, access token only |
| `revoke` | Serialize against refresh, attempt provider revocation, and delete the local grant regardless of provider outcome | No |

The pending management-plane recommendation keeps `authorization_start` and
`authorization_complete` on a separately owner-authenticated gateway browser
surface. This is preferable to giving the workload an enrollment capability:
it keeps the OAuth client secret, authorization code, and refresh-token
response out of TeamYou and workload handling while giving the gateway control
of state, redirect URI, scope, and exchange shape. Schema-v1 `deposit` remains
supported for the existing Codex seam during the migration.

Authorization transactions must be short-lived, one-time, random, sealed or
gateway-stored, bound to the connector version, grant intent, exact redirect
URI, requested scopes, owner enrollment authorization, and OAuth state.
Completion consumes the transaction even on a terminal provider response so an
authorization code cannot be replayed.

## 6. Workload lease delivery

The generic workload primitive should be an `exec`-style lease injector driven
by a built-in or user-created binding:

```text
alphaclaw oauth exec --binding gog-work -- gog gmail labels list
```

It should:

1. request a lease immediately before launching the child;
2. reject a broker response already inside the consumer's minimum validity
   margin;
3. add the token through the binding's approved delivery seam;
4. avoid logging the environment, request response, or reconstructed command;
5. preserve stdin/stdout/stderr, signals, exit code, and working directory via
   `exec`; and
6. never cache the token on disk.

The generic runner is not an authorization boundary against workload root; root
can call the broker and read the returned access token. Its purpose is correct,
repeatable delivery without durable storage.

Supported binding types should include:

- environment variable (preferred for most CLIs);
- a credential-process/helper protocol where the CLI supports one;
- stdin or a dedicated inherited file descriptor;
- an argv flag only as an explicit opt-in because process listings and command
  logs may expose it; and
- raw token output as an advanced escape hatch with prominent leakage warnings,
  not the default agent path.

The runner must execute an argv vector directly, never reconstruct a shell
command. A user can create a binding such as:

```yaml
name: acme-work
grant_id: grnt_opaque
executable: /usr/local/bin/acme
delivery:
  type: environment
  name: ACME_ACCESS_TOKEN
minimum_lifetime_seconds: 300
```

That is sufficient for a previously unknown CLI that accepts
`ACME_ACCESS_TOKEN`; no AlphaClaw release or application-specific refresh code
is needed. Argument interpretation that affects multi-account grant selection
still needs declarative selector rules or a small reviewed shim.

### gog shim

The `gog` shim should parse the original arguments plus `GOG_ACCOUNT` and
`--client`/`GOG_CLIENT`, resolve exactly one AlphaClaw Google account, and then
invoke the generic lease runner. Requirements:

- explicit account and client select the matching grant;
- aliases may be supported only if AlphaClaw owns and validates the mapping;
- `auto` or an omitted account is allowed only when exactly one connected grant
  is eligible;
- ambiguity fails closed with a useful error;
- `auth` commands that manage a local keyring are rejected or routed to the
  AlphaClaw dashboard, while non-secret offline commands such as `version` and
  `help` may run without a lease; and
- the access token is injected with `GOG_ACCESS_TOKEN` into the real reviewed
  gog binary (capability floor 0.12.0).

The real binary and shim must not share the same path. A fresh host asset can
install the reviewed gog binary at `/usr/local/libexec/gog-real` and the shim at
`/usr/local/bin/gog`, which is already on both AlphaClaw's service path and the
agent shell path.

## 7. Google consent and lifecycle changes

For a brokered Google account:

1. The owner creates a Google connector from a built-in template (or equivalent
   Custom OAuth connector), and the gateway seals the client registration.
   Workload state keeps only the connector ID, client ID, redirect URI, and
   display metadata.
2. The owner starts account enrollment through a TeamYou-authenticated browser
   redirect to the gateway OAuth administration surface. The gateway creates
   the connector-bound authorization transaction and redirects to Google.
3. Google's callback lands on the gateway's Tailscale-only operator origin.
4. The gateway exchanges the code with the sealed client secret, stores the
   refresh grant and returns only non-secret grant metadata to the owner flow.
5. AlphaClaw maps its account ID/email/client to the opaque `grant_id` and
   deletes legacy gog credentials/keyring artifacts.
6. Dashboard checks and agent commands obtain leases by `grant_id`.
7. Disconnect revokes by `grant_id`, immediately marks the local account
   disconnected, and retains a durable non-secret closeout journal until remote
   revocation has completed, matching the Codex fail-closed lifecycle.

The userinfo/email check should use the new access token (or a connector-pinned
gateway metadata operation) and must verify it matches any requested account.
An email typed before consent is a hint, not proof of the granted identity.

## 8. Compatibility and migration

- The gateway should accept schema v1 and v2 concurrently. Existing Codex
  records and operations remain untouched during the first v2 release.
- New v2 grant filenames/records must not collide with
  `<consumer>__<provider>.json`. Use an opaque-ID namespace and retain the same
  lock, atomic-replace, fsync, sealing, deny-marker, and rotation-containment
  guarantees.
- Connector definitions, versions, and grants live on the gateway. Workload
  state contains only non-secret connector/grant identifiers and bindings.
- A new standards-compliant provider should require a management-plane
  connector record, not a new host-asset bundle. A bundle is required only for
  a new connector protocol/driver or host-installed consumer tooling.
- Fresh provisions are the first target. They can receive the new gateway asset,
  reviewed gog binary, shim, and AlphaClaw UI together.
- Existing Google refresh tokens should migrate at the next explicit consent,
  not through an unattended export. Until reconnect, the legacy account must be
  clearly labeled as locally stored; it must not be silently treated as
  brokered.
- Existing-instance gateway upgrades remain deferred to the separate dual-VPS
  upgrade effort. Schema compatibility allows that effort to roll gateway and
  workload components in either documented order.

## 9. Implementation sequence and consultation gates

1. **Approve this revised object model and capability boundary. COMPLETE
   2026-08-27.** The owner approved beginning the framework with Custom
   OAuth/OIDC connectors, gateway-owned code exchange, and separate connector
   management/workload token-use authority.
2. **Design the owner management path before gateway code. PROPOSED
   2026-08-27; OWNER REVIEW REQUIRED.** The recommended contract reuses
   TeamYou's signed owner-claim pattern and the gateway's Tailscale-only operator
   origin, while sending connector secrets browser-to-gateway and keeping the
   provider callback/code exchange on the gateway. See
   `oauth-broker-v2-management-plane.md` for the SSRF, mutation, audit, and
   recovery decisions.
3. **Implement schema v2 in clawctl's gateway asset** while preserving v1.
   Include standard OAuth2/OIDC connector types, connector versioning, multiple
   grants, owner-session consent, and the current locking/sealing/durability
   guarantees. Test private-network/metadata endpoint rejection, DNS rebinding,
   connector/grant integrity, transaction replay/expiry, scope and redirect
   rejection, rotation, revoke races, and secret-free status.
4. **Port the exact gateway asset and management integration to TeamYou** and
   open a TeamYou PR. Do not let the vendored assets drift.
5. **Implement generic AlphaClaw connector/grant status, binding management,
   and lease-exec**, with fake broker/child tests proving no token is logged or
   persisted and that signals/exit status are preserved. Include a test binding
   for an otherwise unknown CLI.
6. **Perform a bounded gog upgrade review** and choose a production pin at or
   above 0.12.0. Test representative read, write, large-download, Gmail watch,
   multi-account, and error paths with direct-token auth.
7. **Implement the gog shim and Google dashboard migration** using the generic
   primitives. Remove local client-secret and keyring persistence only after
   broker commit, with a crash-recoverable journal.
8. **Publish a new clawctl host-asset bundle** and update the TeamYou pin for a
   fresh beta provision. This phase changes both the gateway broker asset and
   workload-installed executables, so an AlphaClaw package release alone is not
   sufficient.
9. **Run live acceptance** before cutting the beta release.

Stop for owner consultation after steps 1, 2, 3, and 6. Those are material
policy, protocol, security-management, and third-party-version decisions; later
implementation should not silently choose them.

## 10. Acceptance criteria for the framework and gog seam

On a fresh dual-VPS provision:

- create a Custom OAuth/OIDC connector through the owner management plane
  without rebuilding or republishing the gateway asset;
- prove the ordinary workload identity cannot create or mutate connectors;
- reject custom endpoints resolving to loopback, private/link-local ranges, and
  cloud metadata services, including a DNS-rebinding test;
- create an environment-variable binding for a test CLI unknown to AlphaClaw
  and prove it receives a lease without product-specific code or token files;
- demonstrate and document the fail-closed error for a refresh-store-only test
  consumer;
- connect two Google accounts using two named connectors/client registrations;
- verify gateway status distinguishes both opaque grant IDs without exposing
  client secrets, refresh tokens, or cached access tokens;
- recursively scan workload files, process arguments, journals, logs, and gog
  keyring paths for the test client secrets and refresh tokens;
- run representative gog commands for each account and prove the intended
  grant was selected;
- prove `gog` direct-token mode never opens the credentials file or keyring;
- let/force an access token expire and confirm the next invocation obtains a
  new lease without writing a refresh token locally;
- rotate a Google refresh token and verify the replacement remains gateway-only;
- deny and restore the broker, confirming commands fail closed and then recover;
- disconnect one account while the other continues to work;
- race refresh with revoke and confirm the revoked grant cannot be resurrected;
- restart AlphaClaw/OpenClaw and reboot both VPSes, confirming the mapping and
  broker custody survive; and
- verify legacy `gog auth` commands cannot recreate a workload-local durable
  grant through the managed shim.

## 11. Recommendation

Proceed with this framework before adding the gog production seam. The current
broker core is a strong foundation, but extending schema v1 with one
`(consumer, provider)` pair per application would create exactly the adapter and
single-account scaling problem identified by the owner. The combination of
owner-managed connectors, per-account grants, and user-defined bindings
preserves the security property and gives us the useful form of arbitrary
support: new standard providers and token-compatible CLIs without product
releases. Refresh-store-only binaries and non-standard OAuth dialects remain
explicit integration cases rather than silently weakening durable-secret
custody.

## 12. External reference model

- [Vercel Connect generic OAuth connector](https://vercel.com/connect/oauth) —
  owner registers an OAuth/OIDC connector; application code requests runtime
  tokens through a common interface.
- [Vercel Connect guide](https://vercel.com/kb/guide/vercel-connect) — separates
  customer-managed Custom OAuth connector registration from SDK/CLI runtime
  token retrieval. This document adopts that separation without adopting
  Vercel's control plane or workload identity.
