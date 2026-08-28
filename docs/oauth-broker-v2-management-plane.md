# OAuth Broker v2 — Owner Management Plane

**Status:** SHELVED BY OWNER 2026-08-28. The connector/grant/
binding object model in `oauth-broker-v2-consumer-framework.md` remains an
architecture record, not an active implementation gate.
This document maps that model onto the provisioned dual-VPS topology and
recommends the owner-authentication, consent, SSRF, audit, and recovery
contracts. It is intentionally a consultation gate: no schema-v2 gateway
protocol or production management route should be implemented until the owner
approves or revises the decisions in section 12.

## 1. Recommendation

Use the existing TeamYou-to-gateway owner authorization pattern, but do not
reuse Agent Vault sessions or send connector secrets through TeamYou:

1. TeamYou authenticates the human, verifies that they own the active OpenClaw
   instance, and signs a five-minute, one-time OAuth-administration claim.
2. The browser follows that claim to an OAuth administration surface on the
   gateway's existing Tailscale-only operator origin.
3. The gateway verifies and consumes the claim, then creates a separate,
   short-lived OAuth-administration session.
4. Connector metadata and client credentials are submitted from the browser
   directly to the gateway. They never pass through TeamYou or the workload.
5. The gateway owns authorization state, the provider callback, code exchange,
   grant storage, refresh, rotation, and revocation.
6. The workload forced-command identity can list non-secret status, request an
   access-token lease, and revoke a grant. It cannot create or mutate a
   connector or complete an authorization-code exchange.

This removes the draft framework's proposed enrollment capability from the
ordinary workload path. A sudo-capable compromised workload can still use a
live access token—as it must be able to—but cannot turn the gateway into a
client-secret-bearing HTTP client to an attacker-selected endpoint.

## 2. Existing path being reused

The production TeamYou provisioning path already supplies the necessary owner
identity root:

- TeamYou's `agent-vault-enrollment-service.ts` verifies the Clerk user owns an
  active, non-destroyed instance, obtains the instance's Tailscale-only operator
  origin, and signs a five-minute Ed25519 claim containing an exact audience,
  instance ID, owner ID, return path, one-time `jti`, and timestamps.
- The gateway has the corresponding public key and provisioned owner identity.
- `alphaclaw-agent-vault-bootstrap` verifies exact claim fields, signature,
  purpose, audience, instance, lifetime, owner, and replay state before it
  creates a managed browser session.
- Tailscale Serve exposes Agent Vault on a named service origin that is distinct
  from the workload UI and is reachable by the owner's browser, not by TeamYou's
  server-side runtime.

The OAuth management plane should reuse that **authorization pattern and trust
root**, not the Agent Vault application session. OAuth administration receives
its own claim purpose, verifier path, cookie, CSRF state, lifetime, audit log,
and service process.

## 3. Trust boundaries

| Principal or component | Trusted to do | Explicitly not trusted to do |
| --- | --- | --- |
| TeamYou owner session | Establish the current human owns the instance; issue a short-lived gateway audience claim | Receive or retain OAuth client secrets, authorization codes, refresh tokens, or access tokens |
| Owner browser | Carry a one-time claim to the gateway and submit owner-entered connector data over Tailscale HTTPS | Act as durable secret storage |
| Gateway OAuth admin service | Verify owner claims; validate connector policy; conduct consent; invoke broker management mode | Accept management authorization from the workload identity |
| Gateway broker/store | Seal client credentials and grants; make policy-constrained provider requests; issue leases | Accept request-selected endpoints, headers, parsers, or arbitrary HTTP bodies |
| Workload, including `root` | Read non-secret connector/grant status; obtain and use live access tokens; request local revocation | Create/change connectors, retrieve client secrets or refresh tokens, or perform code exchange |
| OAuth provider | Authorize the user and issue/revoke tokens according to the connector contract | Define runtime destinations dynamically through a workload request |

Gateway `root` remains inside the durable-secret custody boundary. This design
does not claim to protect gateway secrets from a compromised gateway root. It
protects them from the separately compromised, sudo-capable workload VPS.

## 4. Network and service layout

For the first implementation, reserve `/oauth-admin/` on the gateway's existing
Tailscale-only Agent Vault service origin:

```text
TeamYou (owner auth and signed claim only)
       |
       | 303 with one-time owner claim
       v
https://<operator-service>.<tailnet>.ts.net/oauth-admin/*
       |
       | Tailscale Serve -> Caddy loopback route
       v
alphaclaw-oauth-admin (new gateway-local service)
       |
       | local management invocation; never exposed by SSH forced command
       v
alphaclaw-gateway-oauth-broker --management
       |
       +--> sealed connector/grant store
       +--> validated public OAuth endpoints
```

Reusing the operator origin avoids provisioning and ACL management for a second
Tailscale service. The OAuth service remains separate from Agent Vault despite
sharing an origin. It uses a distinct cookie scoped to `/oauth-admin/`, ignores
all other cookies, never logs request headers or bodies, and receives a Caddy
route before Agent Vault's catch-all route.

If sharing the origin later proves operationally confusing, the path can move
to a distinct Tailscale service without changing connector, grant, or workload
protocol schemas. That is not recommended for the first fresh-provision target.

## 5. Owner claim and browser session

TeamYou should issue this exact-shape claim after its existing instance-owner
lookup succeeds:

```json
{
  "v": 1,
  "purpose": "oauth_connector_admin_session",
  "instance_id": "inst_...",
  "owner_clerk_user_id": "user_...",
  "aud": "https://<operator-service>.<tailnet>.ts.net",
  "jti": "<uuid>",
  "iat": 1787870000,
  "exp": 1787870300
}
```

The first version should reuse the already deployed TeamYou Agent Vault
Ed25519 signing key and gateway public key. Exact claim-purpose and field-set
checks provide domain separation; no connector secret or operation payload is
placed in the claim. Generalizing the operational key name can happen later as
a non-breaking key rotation, rather than requiring another production secret
before the framework can ship.

`GET /oauth-admin/authorize?claim=...` must:

- accept only one claim parameter and enforce a request-target size limit;
- verify the Ed25519 header and signature, exact field set, purpose, instance,
  exact operator-origin audience, owner ID, `iat`, `exp`, and maximum lifetime;
- atomically consume `jti` before minting a session, retaining a bounded replay
  journal across service restarts;
- compare the claim owner with the owner initialized during provisioning; and
- redirect with 303 so the claim is removed from browser history and the next
  request URL.

The resulting cookie should contain at least 256 bits of randomness, be stored
only as a hash by the service, and use `HttpOnly; Secure; SameSite=Strict;
Path=/oauth-admin/`. Recommended absolute lifetime is 30 minutes with a
15-minute idle timeout. Service restart invalidates sessions.

Every state-changing request also requires a session-bound CSRF value and an
exact same-origin `Origin` header. Form endpoints accept one documented content
type, enforce bounded bodies, and never reflect secret values after submission.

## 6. Browser management surface

The first surface can be server-rendered HTML; a TeamYou-hosted form would put
client secrets through TeamYou and is therefore the wrong boundary. Required
gateway routes are:

| Route | Purpose |
| --- | --- |
| `GET /oauth-admin/authorize` | Exchange the one-time TeamYou claim for the OAuth admin session |
| `GET /oauth-admin/connectors` | List non-secret connector versions and grant health |
| `GET/POST /oauth-admin/connectors/new` | Display and create a built-in or Custom OAuth/OIDC connector |
| `GET/POST /oauth-admin/connectors/{id}/edit` | Review changes and create an immutable connector version |
| `POST /oauth-admin/connectors/{id}/delete` | Delete only with no live grants, or enter explicit cascade/revoke flow |
| `POST /oauth-admin/connectors/{id}/authorize` | Create a one-time consent transaction and redirect to the provider |
| `GET /oauth-admin/callback` | Validate state, exchange the code, seal the grant, and show the result |
| `POST /oauth-admin/grants/{id}/revoke` | Deny locally first, then close out remote revocation |

Connector creation must show the normalized authorization, token, revocation,
issuer, and userinfo origins; client authentication method; exact callback URI;
and scope ceiling before the final POST. Secret inputs are write-only.

The service invokes the broker executable in an explicit local management mode
(for example, `--management`). The SSH forced command invokes it without that
mode and must reject all management operations even if a workload request uses
the same JSON operation name. Separation is based on the gateway-local
invocation path, not on a secret sent by the workload.

## 7. Consent and callback ownership

The gateway should own the callback and authorization-code exchange. The
connector's first supported redirect URI is therefore:

```text
https://<operator-service>.<tailnet>.ts.net/oauth-admin/callback
```

The owner UI displays this exact URI before connector creation so the owner can
register it with the provider. A provider redirect is browser navigation; the
provider does not need direct network access to the private callback host.
Providers that refuse a `.ts.net` redirect or require a publicly hosted relay
are a compatibility extension, not a reason to send code exchange back to the
workload. A later TeamYou relay can carry only the short-lived code and opaque
state through the browser; the client secret and token exchange would remain on
the gateway.

An authorization transaction contains a random one-time state value and is
bound to connector ID/version, exact redirect URI, requested scopes, PKCE
verifier when used, owner ID, creation/expiry, and intended account label. It is
stored on the gateway, expires within ten minutes, and is consumed before a
terminal code exchange. A crash after the provider spends a code but before a
grant is durably committed fails closed and requires consent again.

Because a `SameSite=Strict` admin cookie is correctly absent on the cross-site
provider redirect, the callback authenticates the transaction with its
one-time state and does not require the browser session cookie. It may complete
only the already-bound transaction; it cannot create or edit a connector. The
next same-origin page requires the admin session again.

After success, the admin surface can link back to the known primary AlphaClaw
origin and Models path. Neither TeamYou input nor a query parameter may select
an arbitrary post-consent origin.

## 8. Connector mutation and grant behavior

Connector versions are immutable. Changes to endpoints, issuer, client ID,
client authentication, callback policy, scope ceiling, or client secret create
a new version. For the first standard driver, the old version is retained only
for audit and closeout, its grants are marked `reauthorization_required`, and
access-token issuance fails closed until the owner consents under the new
version. The system must not guess that a generic provider permits refresh
grants to migrate to a new client secret. A later named driver may implement an
explicitly reviewed safe-rotation rule.

Deletion with live grants fails by default. An explicit cascade first marks
each grant denied, durably records closeout work, attempts remote revocation,
and removes the connector version only after local grant custody is closed.
Remote revocation failure must not restore local usability.

This conservative rule costs an extra consent during client-secret rotation,
but it prevents generic framework code from silently applying provider-specific
assumptions.

## 9. SSRF and DNS-rebinding controls

Validation at connector creation is necessary but not sufficient. Every OIDC
discovery, token, refresh, userinfo, and revocation request must use the same
safe outbound transport:

1. Parse and normalize an HTTPS URL. Reject credentials in the authority,
   fragments, invalid ports, encoded host tricks, and non-canonical IP forms.
2. Resolve all A and AAAA answers. Reject the endpoint if any answer is not a
   globally routable unicast address. This includes loopback, private,
   link-local, multicast, documentation/reserved ranges, IPv4-mapped IPv6, and
   known cloud metadata destinations.
3. Dial one of the validated IP addresses directly while preserving the
   original hostname for TLS SNI and certificate verification. Never hand the
   hostname to a library that can resolve it again after validation.
4. Re-resolve and revalidate for each new request. DNS changes are allowed only
   when every answer remains public.
5. Reject redirects for discovery, token, refresh, and revocation in v2.0.
   Authorization redirects occur in the owner's browser and are not broker
   HTTP requests.
6. Enforce connection, response-header, total, and response-size limits. Parse
   only the connector driver's documented response fields.
7. Never accept a URL, header name/value, body template, response field path, or
   redirect policy from an ordinary workload operation.

For OIDC discovery, the returned `issuer` must exactly match the normalized
configured issuer, and every discovered endpoint goes through the same checks
and owner confirmation. Mixed public/private DNS answers fail closed rather
than selecting only the public answer.

These controls prevent both direct metadata targeting and time-of-check/
time-of-use rebinding. They do not attempt to determine whether a public OAuth
provider is benevolent; the owner is explicitly authorizing the displayed
public origins to receive that connector's client authentication.

## 10. Audit, durability, and recovery

Management and grant events go to a root-owned append-only JSONL journal under
the broker state directory. Each record includes a sequence, timestamp, event
type, connector/grant opaque IDs, connector version, normalized endpoint
origins, scopes, result code, owner-ID hash, and previous-record hash. It must
never include claims, cookies, CSRF values, client secrets, authorization codes,
refresh/access tokens, PKCE verifiers, or URL query strings.

The hash chain detects accidental truncation or mutation; it is not presented
as protection from gateway root. The workload can receive a bounded,
secret-free status projection but cannot append or edit audit records.

State changes retain the existing broker's locking, authenticated sealing,
atomic replace, file and directory `fsync`, and corrupt-record fail-closed
behavior. Additionally:

- connector create/update commits the sealed version before reporting success;
- consent commits the sealed refresh grant before reporting connection;
- consumed owner claims and authorization transactions are durable before any
  external side effect;
- refresh rotation serializes with revoke and cannot resurrect a denied grant;
- revoke marks the grant denied before provider I/O and retains a non-secret
  closeout record for automatic retry; and
- a corrupt connector version denies every referencing grant without exposing
  sealed payloads in status or logs.

Recovery does not depend on TeamYou being online after an owner session has
been established. Starting a new management session does require TeamYou owner
authentication; runtime lease issuance does not.

## 11. Provisioning and release implications

The eventual implementation spans all three repositories:

- **clawctl:** gateway admin service asset, schema-v2 broker management mode,
  Caddy route, systemd unit, owner-claim verifier, safe HTTP transport, and
  gateway tests;
- **TeamYou:** a new authenticated owner entry route and claim purpose, fresh-
  provision metadata advertising OAuth admin support, and byte-identical
  vendored gateway assets; and
- **AlphaClaw:** links into the owner flow, non-secret connector/grant status,
  consumer bindings, and lease execution.

Fresh provisions are the first target. No current code needs a bundle publish
at this design gate. Once implementation is approved and complete, the gateway
and host assets require a new clawctl bundle, TeamYou must pin/deploy it, and an
AlphaClaw beta can consume the new capability. Existing gateway upgrade logic
remains deferred to the separate dual-VPS upgrade program.

The TeamYou entry route must only be offered for an instance whose provisioned
metadata advertises a compatible OAuth admin version. This prevents an owner
from being redirected to a route an older gateway cannot serve.

## 12. Owner decisions requested

Approval of this gate means approving these five choices before schema-v2 code:

1. Reuse the existing gateway Tailscale operator origin under
   `/oauth-admin/`, with a separate service and session, rather than provision a
   second Tailscale service.
2. Reuse the deployed TeamYou Ed25519 owner-claim key with an exact new claim
   purpose, rather than add a second production signing key immediately.
3. Keep connector forms, provider callback, and code exchange on the gateway;
   TeamYou performs owner authentication only and the workload receives no
   enrollment-management capability.
4. Start with the exact Tailscale HTTPS callback displayed to the owner; add a
   public TeamYou callback relay later only for providers that require one.
5. Require re-consent after every security-relevant connector version change,
   including client-secret rotation, until a named provider driver has a
   reviewed safe migration rule.

After these decisions are approved or revised, the next bounded step is the
backward-compatible schema-v2 gateway implementation in clawctl, followed by
another owner review before the TeamYou port and AlphaClaw consumer work.
