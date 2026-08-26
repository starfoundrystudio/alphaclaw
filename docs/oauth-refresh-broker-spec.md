# OAuth Credentials — Gateway Refresh Broker Spec

**Status:** APPROVED 2026-08-26 — all §7 decisions taken by the owner (recorded inline as D1–D6). Implementation not yet started.
**Companions:** `docs/vault-brokered-model-keys-spec.md` (explicitly excluded OAuth/subscription routes), `docs/vault-brokered-channels-spec.md` (Tier S/te covers OAuth *client* secrets; Tier D covers derived access tokens; this spec covers the class both left open: **user-consent OAuth grants whose durable secret is a refresh token**).

## 1. Problem

Vault substitution protects static keys that ride requests verbatim. OAuth's durable secret — the refresh token — breaks that model twice: it appears in token-endpoint POST *bodies* (solvable, S/te-style), and most providers **rotate it on every refresh**, so the *response* carries a new durable secret that lands on the instance. The vault MITM has no response-capture primitive as shipped, so substitution cannot contain rotation. (agent-vault is open source, so a response-capture primitive *could* be contributed upstream or added in a fork — see §6a for why the broker is still the better design.) Result: refresh tokens sit in plaintext on instance disks, agent-readable, in stores we already have to defend ad hoc (`openclaw-doctor-oauth-guard` exists solely to shield them from doctor runs).

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
| claude CLI | CLI refreshes its own `~/.claude` store; format is theirs and changes | Same proactive-rewrite approach as codex, landing after the codex seam proves the pattern (same program per D2). The rewrite must pin the exact store fields it touches and fail loudly on unrecognized shape rather than guessing | Store-format drift breaks the rewrite silently — mitigated by shape-pinning + loud failure, accepted per D2 |
| gog CLI | gogcli reads `credentials.json` and refreshes itself | Same proactive-rewrite pattern; format is simple JSON we already integrate with. In scope per D2 | Low |

Sequencing within the program (per D2): the codex seam lands first — alphaclaw owns both consent flows end-to-end — and claude-CLI + gog follow in the same release train once it proves the pattern.

## 5. Interim option: at-rest custody sealing (shippable now, weaker)

Phase E's `alphaclaw-keystore-custody` can seal the OAuth stores today (ciphertext on disk, plaintext in tmpfs). Caveats that make this interim-only: these files are **rewritten on every rotation**, so sealing requires a change-watch + re-seal loop (clunky, race-prone), and runtime plaintext remains agent-readable — it buys stolen-disk/backup protection only, with none of the broker's revocation or rotation-containment. Worth shipping only if the broker slips significantly.

## 6. Prior art — Vercel Connect (and why we don't use it directly)

Vercel Connect (reviewed 2026-08-26) is the hosted incarnation of exactly this architecture: durable grants in a broker, short-lived scoped tokens at runtime, requests authenticated by workload identity (deployment OIDC) rather than a bootstrap secret, rotation contained broker-side, one-command revocation. It **validates the design** and contributes three requirements adopted above: identity-for-the-ask (§3, forced-command keys), rotation containment (§3), and issuance-time scope narrowing (§7 Q4 — request down-scoped tokens where providers support it, something substitution can never do).

Direct use is blocked structurally: (a) instances have no Vercel OIDC identity (Hetzner VPSes can't mint deployment tokens; the SDK's `vercelToken` override targets tests/dev, not a customer fleet) — the only shape is TeamYou fronting Connect, at which point TeamYou is the broker and Connect is a backing store; (b) the credentials that matter most — Codex and Claude CLI subscription auth — use **first-party OAuth clients owned by OpenAI/Anthropic** that cannot be registered as Connect connectors at all; (c) the niche Connect does serve (user-consent connectors for Google/Slack/etc.) is already occupied by Composio in our stack, and would move customer grants into Vercel's control plane (custody posture change) at $3/1k token requests. Same reasoning applies to any hosted broker in this category.

## 6a. Alternative considered: response capture in agent-vault (open source)

agent-vault is open source, so the missing response-capture primitive could be contributed upstream or carried in a fork. Deliberately not chosen: (a) generic response capture turns a stateless substituting MITM into a stateful, OAuth-aware component that must parse per-provider token-endpoint responses, extract secrets, and rewrite bodies — a much larger and riskier primitive than the narrow broker; (b) a fork of a security-critical binary is a permanent maintenance tax (the AlphaClaw hard-fork itself is the cautionary precedent), and an upstream contribution has uncertain timeline and acceptance; (c) even with capture, refreshes would still be *initiated by the instance* and span two hosts — the broker keeps the entire exchange on the gateway, which is the simpler trust story. Kept open as a future option: if agent-vault later grows a token-custody/unwrap primitive upstream, it could supersede the broker's storage layer without changing the instance-side contract (same note as the channels spec made for the Phase E KEK).

## 7. Decisions (owner, 2026-08-26)

- **D1 — Broker placement: gateway-host service as specced.** Reuses the custody channel pattern, keys, and revocation semantics; no new TeamYou/vault feature.
- **D2 — Scope: all three consumers in one program** (openclaw/codex, claude CLI, gog). Internal implementation order still lands the codex seam first (we own both consent flows) with claude-CLI and gog in the same release train; the claude-CLI store-format drift risk (§4) is accepted.
- **D3 — KEK-seal the gateway grant files: yes.** Same-host hygiene, uniform with Phase E.
- **D4 — Scope narrowing: protocol carries a `scopes` field from day one; no narrowing behavior built now.** Moot for the current consumers (provider-fixed subscription scopes); the field keeps issuance-time narrowing available for future consumers without a protocol rev.
- **D5 — Existing instances: migrate on next consent.** Grants re-home naturally at re-auth/expiry; no active sweep of current auth stores.
- **D6 — Broker unreachable at refresh time: fail closed.** Consumers error until the gateway returns; no instance-side cached-grant fallback (it would reintroduce the durable secret).

## 8. Phases

- **Phase A — protocol + gateway service** (clawctl): broker forced command, PKI keypair, staging/installer wiring, verification checks — the keystore-custody template applied to a new script. Provenance-stamped bundle → beta pin → soak.
- **Phase B — codex seam** (alphaclaw): consent flows `deposit` instead of writing `refresh` locally; proactive refresh loop rewrites the auth store; watchdog surfaces broker health; doctor-oauth-guard updated (shielding becomes unnecessary for brokered profiles).
- **Phase C — migration + doctrine**: consent-time migration for existing grants (per Q5), AGENTS.md note (OAuth grants are broker-held; placeholders in auth stores are working values).
- **Phase D — remaining consumers** (claude-CLI and gog seams, per D2 all in this program; codex lands first as the pattern-prover within the same train).
- **TeamYou port** mirrors clawctl per the established pattern (gateway-installer + PKI + staging parity), same as Phase E custody.
