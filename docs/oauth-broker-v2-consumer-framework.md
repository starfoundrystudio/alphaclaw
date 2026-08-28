# OAuth Broker v2 — Policy, Grant, and Consumer Framework

**Status:** ARCHITECTURE SPIKE 2026-08-27. This document defines the recommended
next phase after the Codex seam. It is not yet an implementation decision or a
release commitment. The existing schema-v1 broker and Codex integration remain
authoritative until v2 is approved and shipped.

**Why this companion exists:** `oauth-refresh-broker-spec.md` correctly defines
the custody boundary, but its original gog plan assumed another proactive
credential-store rewrite. Inspection of gog and of AlphaClaw's multi-account
Google setup exposed a more general seam: applications that accept a short-lived
access token should receive one at invocation time. That pattern should be a
framework, not a new refresh implementation for every OAuth application.

## 1. Goals and non-goals

Goals:

- Keep refresh tokens and OAuth client secrets durably off the workload VPS.
- Preserve the honest trust model: the workload, including `root`, can read and
  use a live access token, but cannot recover the durable grant from disk.
- Support more than one account and OAuth client for the same provider.
- Make standard OAuth providers mostly declarative gateway policy rather than a
  bespoke broker implementation.
- Make consumer integration a narrow access-token delivery seam rather than
  duplicating refresh, rotation, caching, revocation, and storage logic.
- Keep gateway egress destinations and request shapes controlled by reviewed
  gateway policy, never by workload input.
- Preserve schema-v1 Codex behavior through a rolling migration.

Non-goals:

- Pretend every credential called "OAuth" has the same lifecycle.
- Hide a live access token from a root-capable workload that must use it.
- Turn the broker into an arbitrary HTTP proxy or accept provider URLs from the
  workload.
- Automatically support an application that can only consume its own durable
  refresh-token store. Such a consumer needs a supported injection seam, an
  upstream change, or an explicit risk decision.
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

## 4. Gateway object model

Schema v2 should separate three concepts currently collapsed into one sealed
grant record.

### 4.1 Provider policy

A gateway-installed, versioned policy defines the trusted OAuth protocol:

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

The workload supplies a `policy_id`; it never supplies an endpoint, arbitrary
header, request template, or response parser. Standard providers should use a
strict declarative schema. An unusual provider may use a small reviewed driver,
but the driver is installed with the gateway asset and referenced by name.

### 4.2 Client registration

A client registration represents the OAuth application, independently of a
user's consent grant:

- stable opaque `client_registration_id`;
- `policy_id`;
- client ID;
- sealed client secret or private key when applicable;
- exact allowed redirect URI set; and
- non-secret display metadata.

Owner-supplied client credentials are entered through AlphaClaw as today, but
the durable copy is deposited on the gateway. AlphaClaw may retain the client
ID and display metadata; it must not retain the client secret.

### 4.3 User grant

A grant represents one account's consent:

- stable opaque `grant_id`;
- `policy_id` and `client_registration_id` references;
- sealed refresh token and any provider-rotated replacement;
- consented scopes and whether that set is authoritative;
- sealed cached access token;
- non-secret account/display metadata; and
- expiry, refresh, and revocation status timestamps.

`grant_id` must be independent of provider email and safe to expose on the
workload. AlphaClaw's Google account state can map `(client, normalized email)`
to it. The gateway must reject a grant whose policy and client-registration
references disagree.

## 5. Recommended schema-v2 operations

Exact field names can change during implementation, but the capability split
should remain:

| Operation | Purpose | Secret returned to workload? |
| --- | --- | --- |
| `status` | List non-secret policy/client/grant health and denial state | No |
| `client_put` | Create or replace a sealed client registration under a gateway policy | No |
| `client_delete` | Remove a registration only when no live grants reference it, unless explicitly cascading | No |
| `authorization_start` | Validate policy, client, redirect URI, scopes, and grant intent; create a short-lived one-time transaction; return the provider authorization URL | No |
| `authorization_complete` | Validate transaction/state, exchange the authorization code on the gateway, and atomically store the resulting grant | At most the initial short-lived access token and non-secret metadata |
| `access_token` | Resolve `grant_id`, refresh/cache under its policy, and return a scoped short-lived lease | Yes, access token only |
| `revoke` | Serialize against refresh, attempt provider revocation, and delete the local grant regardless of provider outcome | No |

`authorization_start` / `authorization_complete` are preferred over a generic
`deposit` for owner-supplied confidential clients. They keep both the OAuth
client secret and refresh-token response out of durable workload storage and
give the gateway control of state, redirect URI, scope, and exchange shape.
Schema-v1 `deposit` remains supported for the existing Codex seam during the
migration.

Authorization transactions must be short-lived, one-time, random, sealed or
gateway-stored, bound to the client registration, grant ID, exact redirect URI,
requested scopes, and OAuth state. Completion consumes the transaction even on
a terminal provider response so an authorization code cannot be replayed.

## 6. Workload lease delivery

The generic workload primitive should be an `exec`-style lease injector:

```text
oauth-lease-exec \
  --grant-id <opaque-id> \
  --env GOG_ACCESS_TOKEN \
  -- /usr/local/libexec/gog-real <original arguments>
```

It should:

1. request a lease immediately before launching the child;
2. reject a broker response already inside the consumer's minimum validity
   margin;
3. add the token only to the child environment (or approved flag/stdin seam);
4. avoid logging the environment, request response, or reconstructed command;
5. preserve stdin/stdout/stderr, signals, exit code, and working directory via
   `exec`; and
6. never cache the token on disk.

The generic runner is not an authorization boundary against workload root; root
can call the broker and read the returned access token. Its purpose is correct,
repeatable delivery without durable storage.

Consumer manifests may describe simple delivery seams such as environment
variable name, real executable path, minimum lease lifetime, and fixed scopes.
Argument interpretation that affects grant selection must be implemented by a
small reviewed shim when it cannot be expressed safely.

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

1. The dashboard stores the owner-supplied client registration on the gateway
   and keeps only its opaque ID, client ID, redirect URI, and display name in
   workload state.
2. Connect calls `authorization_start`; the gateway returns a fixed-policy
   Google authorization URL and transaction/state value.
3. Google's callback still lands on AlphaClaw, which forwards the code and
   transaction/state to `authorization_complete`.
4. The gateway exchanges the code with the sealed client secret, stores the
   refresh grant, and returns non-secret grant metadata plus, if needed, the
   first short-lived access token.
5. AlphaClaw maps its account ID/email/client to the opaque `grant_id` and
   deletes legacy gog credentials/keyring artifacts.
6. Dashboard checks and agent commands obtain leases by `grant_id`.
7. Disconnect revokes by `grant_id`, immediately marks the local account
   disconnected, and retains a durable non-secret closeout journal until remote
   revocation has completed, matching the Codex fail-closed lifecycle.

The userinfo/email check should use the new access token (or a policy-pinned
gateway metadata operation) and must verify it matches any requested account.
An email typed before consent is a hint, not proof of the granted identity.

## 8. Compatibility and migration

- The gateway should accept schema v1 and v2 concurrently. Existing Codex
  records and operations remain untouched during the first v2 release.
- New v2 grant filenames/records must not collide with
  `<consumer>__<provider>.json`. Use an opaque-ID namespace and retain the same
  lock, atomic-replace, fsync, sealing, deny-marker, and rotation-containment
  guarantees.
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

1. **Approve this object model and protocol boundary.** In particular, approve
   gateway-owned authorization-code exchange and separate client registrations.
2. **Implement schema v2 in clawctl's gateway asset** while preserving v1.
   Extend subprocess tests for multiple grants under one policy, client/grant
   reference integrity, authorization transaction replay/expiry, scope and
   redirect rejection, refresh rotation, revoke races, at-rest sealing, and
   secret-free status.
3. **Port the exact gateway asset to TeamYou** and open a TeamYou PR. Do not let
   the two vendored copies drift.
4. **Implement a generic AlphaClaw v2 client and lease-exec primitive**, with a
   fake broker and child process tests proving no token is logged or persisted
   and that signals/exit status are preserved.
5. **Perform a bounded gog upgrade review** and choose a production pin at or
   above 0.12.0. Test representative read, write, large-download, Gmail watch,
   multi-account, and error paths with direct-token auth.
6. **Implement the gog shim and Google dashboard migration** using the generic
   primitives. Remove local client-secret and keyring persistence only after
   broker commit, with a crash-recoverable journal.
7. **Publish a new clawctl host-asset bundle** and update the TeamYou pin for a
   fresh beta provision. This phase changes both the gateway broker asset and
   workload-installed executables, so an AlphaClaw package release alone is not
   sufficient.
8. **Run live acceptance** before cutting the beta release.

Stop for owner consultation after steps 1, 2, and 5. Those are material policy,
protocol, and third-party-version decisions; later implementation should not
silently choose them.

## 10. Acceptance criteria for the gog seam

On a fresh dual-VPS provision:

- connect two Google accounts using two named client registrations;
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
single-account scaling problem identified by the owner. Policy + client
registration + grant objects, combined with a generic lease runner, preserve
the security property while keeping future standard OAuth additions bounded.
