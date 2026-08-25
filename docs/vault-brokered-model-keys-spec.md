# Vault-Brokered Model API Keys — Spec

**Status:** Draft for review (2026-08-25). No code yet, per program practice: spec before code.
**Scope:** Model/gateway provider credentials whose auth method is a static API key, on Agent Vault-managed (gateway-topology) instances. OAuth and subscription routes are out of scope.

## 1. Problem

`auth-profiles.js` maps ~30 API-key providers to env vars (`kApiKeyEnvVarByProvider`). When a user configures a model, the models route writes the raw key three places: the `.env` file, the per-agent OpenClaw auth store (`openclaw-agent.sqlite`), and (as a reference) `openclaw.json`. All three are agent-readable and vault-invisible.

This contradicts the AGENTS.md doctrine ("Agent Vault is mandatory; never add third-party credentials to Envars"), and the contradiction has a known failure mode: the milo Discord incident, where the agent — following doctrine — directed the customer to put a credential in the vault where nothing read it. Model keys are the credential class where that confusion is most likely to recur (users routinely ask their agent for help with a model key) and the most valuable one (these keys carry spend).

## 2. Why this class needs zero transport work

Unlike channel tokens (websockets that direct-dial), model API calls are ordinary in-process HTTPS fetches:

- `proxy.enabled` in `openclaw.json` routes every in-process fetch through the vault proxy shim → vault MITM (CA already installed at token claim).
- CLI spawns carry the proxy env via `buildAgentVaultRuntimeEnv` (the vault-env class; see memory — verify each spawn family at implementation time).
- The vault proxy already performs credential substitution for services with `substitutions` (the mechanism live for `TEAMYOU_API_KEY`).

So brokering model keys is **pure configuration**: a vault service per provider host, a placeholder where the raw key lives today, and header substitution at the proxy.

## 3. Design overview

**The placeholder contract.** For a brokered provider, the value stored everywhere the raw key lives today becomes the vault substitution placeholder — `defaultPlaceholderForKey(credKey)`, e.g. `ANTHROPIC_API_KEY` → `__anthropic_api_key__`:

- `.env`: `ANTHROPIC_API_KEY=__anthropic_api_key__`
- auth store profile: `{ type: "api_key", provider: "anthropic", key: "__anthropic_api_key__" }`

The real key exists only in the vault. Any consumer — OpenClaw's model client, a skill shelling out `curl` with `$ANTHROPIC_API_KEY`, an agent script — sends the placeholder to the provider host, the proxy substitutes it in flight, and auth works. The same request off-box, or on-box but bypassing the proxy (NAT path), carries a worthless string and fails 401. That is the desired failure direction.

**Brokered-ness is detected by value shape**, not a schema flag: `isVaultPlaceholderValue(v)` = matches `/^__[a-z0-9_.~-]+__$/`. This avoids adding fields to profile objects that OpenClaw also reads, and makes every code path (validation, UI badges, reconcile) idempotent. The existing bidirectional sync machinery (`syncEnvVarsForProfiles`, `syncProfilesFromEnvVars`) propagates placeholders verbatim with no changes.

**Vault service shape** (via the existing `ensureServiceAccess` proposal flow):

```json
{
  "service": {
    "name": "model-anthropic",
    "host": "api.anthropic.com",
    "auth": { "type": "passthrough" },
    "substitutions": [
      { "key": "ANTHROPIC_API_KEY", "placeholder": "__anthropic_api_key__", "in": ["header"] }
    ]
  },
  "credentials": [
    { "key": "ANTHROPIC_API_KEY", "description": "Anthropic API key (model access)", "obtain": "https://console.anthropic.com/settings/keys" }
  ]
}
```

Choices baked in:

- **Substitution, not auth-injection.** `auth.type: passthrough` + substitutions, rather than `api-key`/`bearer` injection. Substitution is deterministic regardless of which header/surface the client uses, works for shell consumers, and doesn't depend on the vault's inject-vs-reject behavior when a client supplies its own header.
- **Credential key = env var name** (`ANTHROPIC_API_KEY`). Keeps reconcile matching, `.env` naming, and vault slot naming one vocabulary.
- **Bare host, no path restriction.** OpenClaw also calls provider usage/quota endpoints on the same hosts (`api.deepseek.com/user/balance`, `api.z.ai/api/monitor/...`); a path-scoped matcher would break them.
- **Canonical service names `model-<provider>`,** exported from one module that both the models UI flow and the agent-facing `ensure_service_access` guidance use — otherwise the agent and the UI create divergent duplicate services for the same host.

## 4. Provider service map

New module `lib/server/agent-vault/model-provider-services.js`: provider id → `{ serviceName, hosts[], credKey, placeholder, surfaces, obtainUrl }`. Hosts observed in `openclaw@2026.7.1` dist (verify each against the resolved provider registry at implementation time; this is the authored starter set):

| Provider | Host(s) | Surfaces | Notes |
| --- | --- | --- | --- |
| anthropic | `api.anthropic.com` | header | `x-api-key` |
| openai | `api.openai.com` | header | Bearer |
| google | `generativelanguage.googleapis.com` | header, query | `x-goog-api-key` and legacy `?key=` |
| openrouter | `openrouter.ai` | header | |
| moonshot / kimi-coding | `api.moonshot.ai` | header | shared host, shared or distinct slots — see §9 Q4 |
| mistral | `api.mistral.ai` | header | |
| xai | `api.x.ai` | header | |
| together | `api.together.xyz` | header | |
| novita | `api.novita.ai` | header | |
| nvidia | `integrate.api.nvidia.com` | header | |
| minimax | `api.minimax.io`, `api.minimaxi.com` | header | two hosts → two services, one slot |
| cohere | `api.cohere.ai` | header | |
| deepseek | `api.deepseek.com` | header | |
| deepgram | `api.deepgram.com` | header | `Token` scheme |
| voyage | `api.voyageai.com` | header | |
| zai | `api.z.ai` | header | |
| synthetic | `api.synthetic.new` | header | |
| opencode | `opencode.ai` | header | zen endpoint |
| ollama-cloud | `ollama.com`, `ai.ollama.com` | header | |
| xiaomi | `api.xiaomimimo.com`, `token-plan-sgp.xiaomimimo.com` | header | |
| volcengine(-plan) | `ark.cn-beijing.volces.com` | header | |
| byteplus(-plan) | `ark.ap-southeast.bytepluses.com` | header | |
| groq / cerebras / fireworks / venice / kilocode / tencent-tokenhub | verify at impl | header | not in the dist sweep; confirm hosts before enabling |
| vercel-ai-gateway | `ai-gateway.vercel.sh` (verify) | header | `vck_` prefix rule needs the §7 exemption |
| cloudflare-ai-gateway | `gateway.ai.cloudflare.com/...` | header | account-scoped path — build host matcher from the user's configured gateway URL |

**Excluded from brokering** (stay on the current env path, unchanged):

- `vllm` and any provider with a user-overridden `baseUrl`: self-hosted/loopback endpoints go direct through the shim and never hit the vault; off-box custom hosts fall back to env with a UI note.
- OAuth/subscription routes: `claude-cli`, Codex OAuth, GitHub Copilot.
- Any provider whose client encodes the key (e.g. basic-auth base64) so the placeholder wouldn't appear verbatim — none known in the current list, but it's a hard precondition per provider.

## 5. Credential lifecycle

**A. Fresh configure (vault connected) — the steady state.**
1. User picks a model in the Models UI. For a brokered-capable provider with no credential, the UI shows "Store key in Agent Vault" instead of a raw key input.
2. `POST /api/models/vault-key {provider}` → server builds the request from the provider map → `agentVaultService.ensureServiceAccess`.
3. If the vault already has service+credential → server immediately writes the placeholder profile + env, syncs config refs, returns `{status:"active"}`.
4. Otherwise a proposal is created; the UI shows the TeamYou approval link (reuse the credentials page's `pending-proposal` component) and polls. The **owner enters the actual key in TeamYou** during approval — the key never touches alphaclaw. On availability, server writes placeholders as in step 3 and marks the model catalog stale.

**A½. What the Models screen shows** (`provider-auth-card.js` + models-tab "Needs auth" chip):

Everything up to credential entry is unchanged — model rows, the "Needs auth" chip, and the per-provider Authentication card all render as today. Only the card's interior changes, and only when the vault runtime is connected:

| Card state | Renders | Badge |
| --- | --- | --- |
| Not configured | "Store key in Agent Vault" button (no `SecretInput` at all) + the existing "Get" console link → `POST /api/models/vault-key` | "Not configured" |
| Pending approval | The credentials page's `PendingProposal` block (slot, host, "Review proposal" → TeamYou, where the **owner enters the key value during approval**); card polls proposal status | "Approval pending" |
| Active | Passive state; note that rotation happens in TeamYou | "Connected · Agent Vault" |
| Raw key on-box (pre-vault/onboarding) | Today's connected card + migrate banner → same flow as Not configured; reconcile overwrites raw with placeholder on completion | "Connected" + banner |

The "Needs auth" chip clears through the existing `hasCredentialValue` path — the placeholder *is* the profile value — and the UI tells brokered from raw purely via `isVaultPlaceholderValue`, so migrated providers render correctly with no extra state. Vault not connected (non-managed, pre-claim, onboarding): the card is exactly today's `SecretInput`. Codex OAuth / Claude CLI card sections: untouched.

**B. Onboarding / vault not yet ready — the bootstrap lane.**
The vault runtime token is claimed post-onboarding (needs tailnet + owner enrollment), so onboarding keeps collecting a raw key into env exactly as today. This is a deliberate, documented exception to the doctrine, closed by lane C. End-state (future, ties into the parked onboarding-async redesign): TeamYou-provisioned instances pre-seed model-key slots at provision time so onboarding never handles a raw key.

**C. Migration of an existing raw key.**
The runtime token is proposal-only — alphaclaw *cannot* copy an on-box secret into the vault. Migration therefore needs one owner action: Models UI banner on raw-keyed brokered-capable providers → creates the proposal → owner approves **and re-enters the key value** in TeamYou → reconcile (below) flips placeholder in and scrubs the raw value from `.env` and the auth store (best-effort scrub; sqlite page residue acknowledged). Note `runModelsGitSync` only syncs `openclaw.json` — auth references there are provider/mode only, never values — so nothing raw reaches git.

**D. Reconcile (extends `reconcileLegacyCredentials`).**
`kAgentVaultRuntimeReplacements` entries gain a `mode`: existing `TEAMYOU_API_KEY` keeps `mode: "remove"`; model providers get `mode: "placeholder"`. When the vault reports service+credential available for a placeholder-mode key and the local value isn't already the placeholder: rewrite the profile key and env value to the placeholder (never delete the profile — an unconfigured provider breaks model routing), then restart the runtime. Idempotent via `isVaultPlaceholderValue`.

**E. Rotation & revocation.**
Rotation is TeamYou-only: owner updates the credential value; placeholders on-box are stable; no alphaclaw touch, no restart. This is a material operational win over today (rotation currently means re-pasting into alphaclaw). Revocation → requests 401; OpenClaw's profile failover marks the profile bad (cosmetic); a discover-driven "credential missing" warning in the Models UI is a nice-to-have.

## 6. Raw-key policy on managed instances

When the vault is connected, `PUT /api/models/config` and `PUT /api/models/auth/:profileId` **reject raw `api_key` values for brokered-capable providers** (400 pointing at the vault flow), and the envars route gets the same gate for the mapped env keys (the envars UI already classifies the `ai` group as vault-credential class — verify and extend its existing enforcement). When the vault is not connected (onboarding, non-managed installs, outage before first claim), the current raw path stands. This makes the UI, the API, and AGENTS.md tell one story — the fix for the doctrine-conflict class.

## 7. Validation and readiness semantics

- `provider-credential-validation.js`: skip prefix rules (e.g. Vercel's `vck_`) when `isVaultPlaceholderValue(value)` — otherwise the placeholder can never be stored.
- `validateModelProviderCredentials` (models.js): a placeholder profile counts as configured. It only exists post-availability (written by flows A/C/D), so no live discover call is needed on the hot path.
- Model catalog probes (`openclaw models status`, `models set`) shell out — confirm `gatewayEnv()` carries the vault runtime env (the twice-bitten vault-env class) so probe traffic gets substitution too.

## 8. Failure modes

- **Vault proxy down:** model calls fail on managed instances regardless of key storage (proxy.enabled routes them there today). No new blast radius.
- **Placeholder exfiltrated:** worthless off-box; on-box it only works through the proxy to the pinned provider host, where every use is a vault-visible, policy-enforceable flow (Phase 3 scanning sees model traffic; keys never do the invisible-socket trick channels do).
- **Agent asked for the key:** the agent can read only the placeholder; doctrine and reality finally agree for this class.
- **NAT path bypass:** proxy-unaware traffic to a provider host carries the placeholder and 401s — fails closed for auth even where egress is open.

## 9. Open questions for Bill

1. **Hard-block vs warn** on raw keys when vault is connected (§6 specs hard-block; confirm).
2. **Auto-create migration proposals** on first vault claim for already-raw-keyed providers, or strictly UI-initiated? (Spec says UI-initiated; auto-creating surprises the owner with a TeamYou approval queue.)
3. Confirm **credential-key naming = env var name** (spec assumes yes).
4. `moonshot`/`kimi-coding` and `volcengine`/`-plan` share hosts and env keys today — one shared slot per host, or per-provider slots? (Spec assumes shared, matching the shared env var.)
5. Multi-key failover (several profiles per provider): numbered slots (`ANTHROPIC_API_KEY_2` + own placeholder) fit within the 10-substitution cap — include in v1 or defer? (Spec defers.)

## 10. Rollout

- **Phase A (server, no UI):** provider service map · placeholder helpers · validation exemptions · reconcile `mode: "placeholder"` · `POST /api/models/vault-key` + status polling. Testable end-to-end via API on the enforced test instance.
- **Phase B (UI):** Models settings vault-first credential flow + migrate banner; envars-route gate.
- **Phase C (doctrine):** AGENTS.md model-key guidance (route users to Models settings; agent `ensure_service_access` uses the canonical `model-<provider>` names from the shared map).
- **Phase D (future):** TeamYou provision-time key seeding; folds into the parked onboarding redesign.

Verification per phase on `alphaclaw-egress-enforced-1`: configure Anthropic via the vault flow, confirm `.env`/sqlite hold only placeholders, live model call succeeds through the proxy, direct (NO_PROXY-forced) call 401s, rotation in TeamYou takes effect without restart.
