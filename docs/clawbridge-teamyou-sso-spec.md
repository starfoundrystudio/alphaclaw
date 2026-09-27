# Clawbridge sign-in via TeamYou: contract spec

_Phase 1 of TeamYou project `ATxHBwlvEdsK`. Drafted 2026-09-26. Status: **approved 2026-09-26** with all §11 recommendations._

This spec fixes the contract between TeamYou, AlphaClaw and clawctl so the three repos can be built independently. Plan and decisions are in the project doc ("Clawbridge sign-in via TeamYou — plan").

## 1. Scope

- **In scope.**
  - New managed instances: TeamYou-provisioned, plus clawctl-provisioned ones that have a TeamYou owner.
  - The customer reaches Clawbridge on:
    - the setup site (`https://<slug>.openclaw.teamyou.ai`);
    - the private dashboard (`ALPHACLAW_SETUP_URL`, today `https://<gateway>.<tailnet>.ts.net`);
    - the OpenClaw Control UI proxied under it (`/openclaw/…`).
  - All of these are reached by signing in to TeamYou. No setup password.
- **Unchanged.**
  - Self-hosted AlphaClaw keeps password login.
  - clawctl instances created **without** `--owner-clerk-user-id` have no TeamYou owner, so they keep the password.
  - The OpenClaw gateway token, `/v1`, webhooks, `/oauth`, `/gmail-pubsub` and the Google/Codex callbacks are not touched.
- **Out of scope.**
  - Migrating existing instances (fleet upgrade process).
  - The optional operator login-link command.
  - Teammate access (instances are single-owner).

## 2. Flow

1. **The user starts from TeamYou.** This happens in one of three ways.
   - The instance widget ("Finish setup", "Open ClawBridge", "Open OpenClaw", the tile). This calls a server action directly; no interstitial.
   - The TeamYou entry page `/openclaw/clawbridge/<instanceId>?return_to=…`. This is reached from Clawbridge's login redirect, the setup handoff button, or bookmarks. It shows a **Continue to Clawbridge** button, and the claim is only minted on that click (see §7).
2. **TeamYou checks ownership and signs a claim** (§3), then navigates to `<aud>/auth/teamyou?claim=<jws>`.
3. **AlphaClaw verifies the claim** (§5). It burns the `jti`, sets the `setup_token` session cookie, and responds with a 303 to `return_to`.
4. **Later visits.**
   - With a valid session, the dashboard works normally.
   - With no session, the login page sends the browser to the TeamYou entry URL with the requested route. The loop ends at TeamYou if the user is not signed in there, or not the owner.

## 3. Claim

- **Format.** A compact JWS:

  ```
  { "alg": "EdDSA", "typ": "JWT", "kid": "teamyou-clawbridge-v1" }
  ```

  It is signed with **`TEAMYOU_CLAWBRIDGE_SSO_PRIVATE_KEY`** (Ed25519, PEM or base64 PEM). This key is separate from `TEAMYOU_AGENT_VAULT_ENROLLMENT_PRIVATE_KEY` by decision, so a claim can never be accepted by the other verifier.
- **Payload.** Exact field set. The verifier rejects any extra or missing field.

  | Field | Value |
  |---|---|
  | `v` | `1` |
  | `purpose` | `"clawbridge_owner_session"` |
  | `instance_id` | `inst_…` (must equal the instance's `OPENCLAW_INSTANCE_ID`) |
  | `owner_clerk_user_id` | the Clerk id of the verified owner |
  | `email` | owner email, lowercased (display and audit only; never an authorization input) |
  | `aud` | the exact origin the user is being sent to (§4) |
  | `return_to` | an allowlisted target (§6) |
  | `jti` | UUID v4, single use |
  | `iat`, `exp` | seconds; `exp - iat` = 300 |

- **Timing.** The verifier allows ±60s clock skew and rejects `exp - iat` > 360.

## 4. Audience selection (TeamYou)

TeamYou reads the owner's instance and picks one target origin.

1. **Dashboard.** If `providerMetadata.access.setup_url` is set, `aud` is its origin. It is recorded by the `instance.network_finalized` webhook, which AlphaClaw's finalize step requires to succeed before the handoff button can appear, so there is no race at handoff.
2. **Setup site.** Otherwise, if the run is `awaiting_user_setup` and `access.bootstrap_url` is set, `aud` is the bootstrap origin. The widget keeps its existing readiness gate.
3. **Neither.** Otherwise no claim is minted, and the page says "Your instance is still being set up."

`operatorConsoleUrl` is not used for `aud`. If it ever differs from `setup_url`, the claim targets `setup_url`. See open question 5.

## 5. AlphaClaw verifier

### Route

`GET /auth/teamyou?claim=…`.

- It is registered **before** the `/auth` `requireAuth` mount.
- It is reachable on the `private` (and `legacy`) surfaces only, and is never added to the public path allowlist. The Funnel origin (`:8443`) also fails the `aud` check.

### Enablement

SSO is enabled only when all of the following are valid:

- **`TEAMYOU_CLAWBRIDGE_SSO_PUBLIC_KEYS`.** A comma-separated `kid:base64url(raw 32-byte Ed25519 key)` list, imported as JWK `{kty:"OKP",crv:"Ed25519",x}`. Several entries allow key rotation with overlap.
- **`TEAMYOU_CLAWBRIDGE_ENTRY_URL`.** Must be `https://<teamyou origin>/openclaw/clawbridge/inst_…`, and its instance must equal `OPENCLAW_INSTANCE_ID`.
- **`OPENCLAW_INSTANCE_ID`.**

Otherwise the route returns 404, and nothing else changes.

### Checks, in order (any failure is a failure)

1. The header is exactly the three fields, and `kid` is known.
2. The Ed25519 signature is valid (`crypto.verify(null, …)`).
3. The exact payload field set, `v`, `purpose`, and `instance_id === OPENCLAW_INSTANCE_ID`.
4. **`aud`** equals the request origin, as derived by `getRequestOrigin`, which is the same logic used by surface classification. The origin must be one of:
   - the `ALPHACLAW_SETUP_URL` origin;
   - the `ALPHACLAW_BOOTSTRAP_URL` origin, **only while `ALPHACLAW_SETUP_URL` is unset**. After finalize, the setup site cannot mint sessions even if it were somehow reachable.
5. **Timing:** `iat`/`exp` within skew and within the lifetime cap.
6. **`return_to`** matches §6.
7. **`jti`** has not been used. It is inserted into the new SQLite table `sso_claim_uses(jti TEXT PRIMARY KEY, exp INTEGER)` in the auth DB **before** the session is issued. Expired rows are pruned on the login-cleanup interval.

### Success

- Set `setup_token`. The payload gains `method:"teamyou"`, `sub:<owner_clerk_user_id>` and `email`.
- The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, 7-day lifetime, plus **`Secure` when the request is HTTPS** (via forwarded proto). Setting `Secure` applies to password sessions too.
- Respond 303 to `return_to`, with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- Access logging must not record the query string.

### Failure

- Respond 303 to `/login.html?sso_error=<code>`, with the same headers.
- Codes: `invalid`, `expired`, `used`, `wrong_instance`, `wrong_address`, `unavailable`.
- Failures count against the existing login throttle.

### Session key

- **`ALPHACLAW_SESSION_SECRET`.** 32 random bytes, base64url, stored in `.env` as a reserved system var that `PUT /api/env` refuses.
  - When SSO is enabled and the var is missing, AlphaClaw generates it at startup and persists it.
  - Self-hosted without SSO does not need it.
- **Key derivation:**

  ```
  HMAC-SHA256(ALPHACLAW_SESSION_SECRET, "clawbridge-session-v1:" + (SETUP_PASSWORD || ""))
  ```

  - If there is no session secret, it falls back to `SETUP_PASSWORD` alone, which is today's behaviour, so self-hosted is unchanged.
  - Binding the password in keeps "change the password to revoke all sessions" working wherever a password exists.
- **Advanced-control cookie.** It uses the same derived key instead of `SETUP_PASSWORD` directly.
- **Rollover.** Existing sessions are invalidated once when the key changes. That is acceptable, because it happens only on managed instances at the SSO rollout.

### Startup

`bin/alphaclaw.js` requires `SETUP_PASSWORD` **unless** SSO is enabled.

### Status API and login page

- **`/api/auth/status`** gains:

  ```
  methods: { password: bool, teamyou: { entryUrl } | null }
  identity: { method, email } | null
  ```

- **`login.html`**, when `teamyou` is available and there is no `sso_error`, redirects to `entryUrl?return_to=<current target>`.
  - The target is mapped from the page's `?next` or hash route per §6; otherwise `/`.
  - With `sso_error`, it shows a short message and an **Open from TeamYou** button.
  - During the transition (both methods present), it shows a small "Use setup password instead" link. When no password is configured the link is hidden and `/api/auth/login` returns 404.
- **Logout** clears cookies and lands on a "Signed out" state with an **Open from TeamYou** button. It does not auto-redirect, which would loop straight back in.
- **Sidebar** shows the signed-in email when `identity.method === "teamyou"`.
- **Password compare.** The password path switches to a constant-time compare (`crypto.timingSafeEqual` over HMAC digests).

### Setup handoff

`WelcomeSetupStep`'s "Open Clawbridge" button, when SSO is enabled, links to the entry URL, read from `/api/auth/status` (`methods.teamyou.entryUrl`), instead of the bare dashboard URL. This removes the second password prompt. The readiness probe is unchanged.

## 6. `return_to` allowlist

The allowlist is identical in TeamYou (TS) and AlphaClaw (JS); each side has its own test table. Accepted, and nothing else (no absolute URLs, no `//`, no backslashes):

| Form | Use |
|---|---|
| `/` | default; the app picks the landing route (first-run chat landing, etc.) |
| `/#/<tab>` where `<tab>` ∈ `general, chat, models, agents, credentials, envars, webhooks, nodes, cron, usage, doctor, watchdog` | deep links |
| `/openclaw/chat?session=main` (exact) | TeamYou's "Open OpenClaw" |

The entry URL's `return_to` query parameter is normalized with the same function. Anything invalid becomes `/` rather than an error, so bookmarks never dead-end.

## 7. TeamYou side

- **`app/(webapp)/openclaw/clawbridge/[instanceId]/page.tsx`.**
  - Clerk-protected.
  - Renders the instance name and a **Continue to Clawbridge** button.
  - The click calls `createClawbridgeSessionAction(instanceId, returnTo)`, which navigates to the returned URL.
  - It never mints on GET. This closes the auto-mint login-CSRF shape noted in the Agent Vault review.
- **`createClawbridgeOwnerSessionUrl`** lives in a new `clawbridge-sso-service.ts`.
  - It reuses the owner lookup: owner-only; lifecycle `active`, or `provisioning` for the setup-site case; not destroyed.
  - It generalizes the Ed25519 signing helper to take `{ key, kid }`, sharing code rather than the key.
- **Widget.** "Finish setup", "Open ClawBridge", "Open OpenClaw" and the tile call the action directly, using the existing blank-tab and `opener = null` pattern from "Open Agent Vault".
- **Key and env delivery** (`bootstrap-claim-service.ts`):

  ```
  TEAMYOU_CLAWBRIDGE_SSO_PUBLIC_KEYS = teamyou-clawbridge-v1:<x>   (derived from the private key)
  TEAMYOU_CLAWBRIDGE_ENTRY_URL       = <claim origin>/openclaw/clawbridge/<instanceId>
  ```

  `SETUP_PASSWORD` keeps being sent until Phase 4.
- **Keys** are separate for production, preview and development, in Vercel env. There is no rotation endpoint. Rotation means adding the new `kid` to fleet envs first, then switching signing.

## 8. clawctl side

- **Bootstrap env** (`src/provisioning/bootstrap-env.ts`): pass through `TEAMYOU_CLAWBRIDGE_SSO_PUBLIC_KEYS` (from `CLAWCTL_TEAMYOU_CLAWBRIDGE_SSO_PUBLIC_KEY`) and `TEAMYOU_CLAWBRIDGE_ENTRY_URL`, only when the instance has a TeamYou owner.
- **Phase 4:**
  - `--setup-password` becomes optional when an owner is set.
  - Fleet metrics (`alphaclaw-metrics-service.ts`) moves off password login to a machine credential. Proposal: a per-instance `ALPHACLAW_METRICS_TOKEN` bearer accepted only on a read-only metrics endpoint.

## 9. Rollout order and compatibility

1. **AlphaClaw beta (Phase 2).** Everything is inert without the new env, so every existing instance and self-hosted install behaves exactly as today.
2. **TeamYou and clawctl deliver the key and entry URL, and rewire links (Phase 3).** The password is still delivered.
   - Instances installed from a channel whose AlphaClaw predates Phase 2 ignore the new env and keep the password.
   - Newer ones redirect to TeamYou and offer "Use setup password instead".
3. **Stop delivering `SETUP_PASSWORD` (Phase 4).** Only when the channel's AlphaClaw version supports SSO; otherwise `bin/alphaclaw.js` would refuse to start. TeamYou must gate this on the resolved AlphaClaw version, not on the channel name.

## 10. Tests (minimum)

- **AlphaClaw.**
  - A verifier matrix: signature, kid, fields, instance, aud (setup vs bootstrap vs Funnel vs a spoofed `X-Forwarded-Host` without gateway provenance), skew, lifetime, replay, `return_to`.
  - Session key derivation and fallback.
  - The startup gate.
  - `/api/auth/status` shape.
  - Login redirect and `sso_error` rendering.
  - Handoff link.
  - The existing password tests unchanged.
- **TeamYou.**
  - Claim shape and `kid`.
  - Owner-only.
  - Audience selection for setup and dashboard states.
  - `return_to` table.
  - No mint on GET.
  - Env delivery.
- **Cross-repo.** One fixture claim signed by TeamYou's helper and verified by AlphaClaw's verifier (checked-in test vector with a test key).

## 11. Decisions (answered 2026-09-26: all recommendations accepted)

1. **Continue click on direct visits.** The TeamYou entry page requires a **Continue** click when reached by link, login redirect or bookmark; widget buttons skip it. Accept the extra click as the anti-forced-login measure? (Recommended: yes.)
2. **Owner-less clawctl instances keep the password.** Confirm. (Recommended: yes; they have no TeamYou identity to sign in with.)
3. **Session lifetime.** Keep 7 days for TeamYou sessions? (Recommended: yes. Shorter only adds TeamYou round-trips.)
4. **Landing route after sign-in** defaults to `/` (the app decides, e.g. first-run chat). OK?
5. **`operatorConsoleUrl`.** If an admin override ever points elsewhere, should the widget prefer it (then `aud` would not match `ALPHACLAW_SETUP_URL`)? (Recommended: ignore it for SSO and use `setup_url`.)
