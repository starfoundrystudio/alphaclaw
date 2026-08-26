# OAuth Credentials — Gateway Refresh Broker Spec

**Status:** DRAFT 2026-08-26 — for owner review. No implementation started.
**Companions:** `docs/vault-brokered-model-keys-spec.md` (explicitly excluded OAuth/subscription routes), `docs/vault-brokered-channels-spec.md` (Tier S/te covers OAuth *client* secrets; Tier D covers derived access tokens; this spec covers the class both left open: **user-consent OAuth grants whose durable secret is a refresh token**).

## 1. Problem

Vault substitution protects static keys that ride requests verbatim. OAuth's durable secret — the refresh token — breaks that model twice: it appears in token-endpoint POST *bodies* (solvable, S/te-style), and most providers **rotate it on every refresh**, so the *response* carries a new durable secret that lands on the instance. The vault MITM has no response-capture primitive and we don't control the agent-vault binary, so substitution cannot contain rotation. Result: refresh tokens sit in plaintext on instance disks, agent-readable, in stores we already have to defend ad hoc (`openclaw-doctor-oauth-guard` exists solely to shield them from doctor runs).

## 2. Credential inventory

| Credential | Store on instance | Durable secret | Who refreshes today | Notes |
| --- | --- | --- | --- | --- |
| Codex OAuth (ChatGPT subscription) | openclaw auth store (`agents/<id>/auth-profiles.json`; 2026.7.1 also has a sqlite provider-auth store — exact runtime source of truth **verify at impl**) | refresh token | openclaw's codex plugin | Consent flows both run through alphaclaw already: paste flow + device flow (`routes/codex.js`, beta.18) — the exchange happens in alphaclaw's process, so the refresh token is in our hands at consent time. Client is OpenAI's (`app_EMoamEEZ73f0…`); we cannot re-register it anywhere |
| Claude CLI subscription | Claude Code's own auth store under `~/.claude` | refresh token | the claude CLI itself | First-party Anthropic client; store format is the CLI's, not ours. alphaclaw's adopt/login flows wrap the CLI |
| Google (gog CLI) | `gog/credentials.json` | refresh token | gogcli | Our own Google OAuth client — the one entry we could theoretically re-home to a hosted broker; Composio already covers the hosted-broker role for Google/Workspace |
| Composio-linked accounts | Composio's side | — | Composio | Already the broker model; out of scope |
| Channel OAuth client secrets (msteams etc.) | not yet built | client_secret | n/a | Stays Tier S/te body-substitution per the channels spec; NOT this spec |

## 3. Design: refresh broker on the security gateway

Mirror the Phase E custody pattern, applied to token refresh:

- **Durable secret placement.** Refresh tokens live only on the security gateway: root-only files under `/etc/alphaclaw-gateway/oauth-grants/<consumer>/<provider>.json`, optionally sealed under the existing custody KEK (they're on the same host, so KEK-sealing here is belt-and-braces at-rest hygiene, not cross-host custody).
- **The ask is authenticated by workload identity, never a secret.** A dedicated restricted forced-command channel (`alphaclaw-gateway-oauth-broker`, same authorized_keys `restrict,command=` pattern as keystore-custody; per-instance ed25519 keypair issued by the connectivity PKI). Protocol: one JSON request/response per invocation, schema-versioned, mirroring the custody script's conventions.
- **Operations.**
  - `status` → `{ok, grants: [{consumer, provider, expires_at, last_refresh_at}], denied}`
  - `deposit` `{consumer, provider, grant}` → store/replace a grant (used at consent-time migration; grant = refresh token + token-endpoint parameters)
  - `access_token` `{consumer, provider}` → broker performs the token-endpoint exchange **from the gateway**, persists any rotated refresh token, returns `{access_token, expires_at}` only. Caches the current access token until inside a validity buffer (~60s) so repeated asks don't burn refreshes.
  - `revoke` `{consumer, provider}` → delete the grant (and best-effort provider-side revocation where an endpoint exists)
  - Deny marker (`oauth-broker-denied`) — same revocation switch semantics as custody.
- **Rotation is contained by construction.** The token-endpoint response never leaves the gateway; the instance sees access tokens only. This is the property substitution cannot provide.
- **Consent flows are unchanged for the user.** Device/paste/browser flows run as today; at the end, alphaclaw `deposit`s the grant to the broker and deletes the local refresh token. The refresh token transits alphaclaw memory once, at consent time — same honest one-shot exposure as entering a key on the approval page.
- **Egress:** the gateway's own token-endpoint calls (`auth.openai.com`, `console.anthropic.com`/`claude.ai`, `oauth2.googleapis.com`) leave from the gateway's public interface — outside the workload NAT flow logs, same as the vault host's provider dials. Note for the Phase 3 inventory.

### Honest threat statement (same discipline as Tier C)

The agent must be able to *use* access tokens, so a live access token is always readable by a sufficiently capable agent on the instance. The broker protects the **durable** secret: a stolen disk, backup, or snapshot yields nothing that outlives ~1 hour; revocation is one gateway-side action and outstanding access tokens age out; every refresh is a loggable, deniable event at the broker. It does not hide in-flight tokens from the runtime — nothing can.

## 4. The hard part: per-consumer integration seams

The crypto is trivial; the seams are not. Each consumer expects a self-refreshing store:

| Consumer | Seam | Mechanism | Risk |
| --- | --- | --- | --- |
| openclaw codex plugin | openclaw refreshes from its auth store when `expires` nears | alphaclaw **proactive refresh loop**: before expiry (timer, ~5 min margin), ask the broker for a fresh access token and rewrite the auth-profiles entry (`access` + `expires` real, `refresh` stubbed with a non-secret placeholder). openclaw then never needs to refresh | If the loop misses (alphaclaw down at expiry), openclaw attempts refresh with the stub and errors → model calls fail until the loop catches up. Mitigation: refresh-on-boot + watchdog check. **Verify at impl** whether openclaw hard-fails or surfaces a re-auth prompt on refresh failure, and whether the sqlite store shadows the JSON |
| claude CLI | CLI refreshes its own `~/.claude` store; format is theirs and changes | **Phase 2, deliberately.** Same proactive-rewrite approach is possible but the store is a moving target we don't own. Interim: the store is enumerated for at-rest custody (see §5) and excluded from backups/git-sync (verify C0-style hygiene applies) | Store-format drift breaks the rewrite silently |
| gog CLI | gogcli reads `credentials.json` and refreshes itself | Same proactive-rewrite pattern; format is simple JSON we already integrate with. Alternative: keep gog out of scope if Composio remains the strategic path for Google | Low |

Decision principle: **ship the seam we control end-to-end first** (openclaw/codex — where alphaclaw already owns both consent flows), and let phase 2+ consumers prove the pattern before touching stores we don't own.

## 5. Interim option: at-rest custody sealing (shippable now, weaker)

Phase E's `alphaclaw-keystore-custody` can seal the OAuth stores today (ciphertext on disk, plaintext in tmpfs). Caveats that make this interim-only: these files are **rewritten on every rotation**, so sealing requires a change-watch + re-seal loop (clunky, race-prone), and runtime plaintext remains agent-readable — it buys stolen-disk/backup protection only, with none of the broker's revocation or rotation-containment. Worth shipping only if the broker slips significantly.

## 6. Prior art — Vercel Connect (and why we don't use it directly)

Vercel Connect (reviewed 2026-08-26) is the hosted incarnation of exactly this architecture: durable grants in a broker, short-lived scoped tokens at runtime, requests authenticated by workload identity (deployment OIDC) rather than a bootstrap secret, rotation contained broker-side, one-command revocation. It **validates the design** and contributes three requirements adopted above: identity-for-the-ask (§3, forced-command keys), rotation containment (§3), and issuance-time scope narrowing (§7 Q4 — request down-scoped tokens where providers support it, something substitution can never do).

Direct use is blocked structurally: (a) instances have no Vercel OIDC identity (Hetzner VPSes can't mint deployment tokens; the SDK's `vercelToken` override targets tests/dev, not a customer fleet) — the only shape is TeamYou fronting Connect, at which point TeamYou is the broker and Connect is a backing store; (b) the credentials that matter most — Codex and Claude CLI subscription auth — use **first-party OAuth clients owned by OpenAI/Anthropic** that cannot be registered as Connect connectors at all; (c) the niche Connect does serve (user-consent connectors for Google/Slack/etc.) is already occupied by Composio in our stack, and would move customer grants into Vercel's control plane (custody posture change) at $3/1k token requests. Same reasoning applies to any hosted broker in this category.

## 7. Open questions (owner decisions)

- **Q1 — Broker placement:** gateway-host service as specced (recommended: reuses the custody channel pattern, keys, and revocation semantics; no new TeamYou/vault feature), vs. TeamYou-side broker (central fleet visibility, but customer OAuth grants move into the TeamYou/Vercel trust domain).
- **Q2 — Scope:** phase 1 = openclaw/codex only (recommended), with claude-CLI and gog as explicitly sequenced phase 2/3? Or all three at once?
- **Q3 — KEK-seal the gateway grant files?** Same-host KEK means it's hygiene, not custody. Recommended: yes, cheap and uniform with Phase E.
- **Q4 — Scope narrowing:** where providers support down-scoped issuance, should the broker request narrowed tokens per consumer? (Mostly moot for Codex/Claude subscription tokens — provider-fixed scopes — but the protocol should carry a `scopes` field from day one.)
- **Q5 — Existing instances:** migrate on next consent (recommended — grants re-consent naturally on expiry/re-auth) vs. active migration sweep of current auth stores.
- **Q6 — Broker unreachable at refresh time:** fail closed (model calls error until gateway returns — recommended, matches D5 posture) vs. any cached-grant fallback on the instance (reintroduces the durable secret; not recommended).

## 8. Phases

- **Phase A — protocol + gateway service** (clawctl): broker forced command, PKI keypair, staging/installer wiring, verification checks — the keystore-custody template applied to a new script. Provenance-stamped bundle → beta pin → soak.
- **Phase B — codex seam** (alphaclaw): consent flows `deposit` instead of writing `refresh` locally; proactive refresh loop rewrites the auth store; watchdog surfaces broker health; doctor-oauth-guard updated (shielding becomes unnecessary for brokered profiles).
- **Phase C — migration + doctrine**: consent-time migration for existing grants (per Q5), AGENTS.md note (OAuth grants are broker-held; placeholders in auth stores are working values).
- **Phase D — second consumer** (gog or claude-CLI per Q2 outcome), only after the codex seam has soaked.
- **TeamYou port** mirrors clawctl per the established pattern (gateway-installer + PKI + staging parity), same as Phase E custody.
