# Vault-Brokered Channel Credentials — Spec

**Status:** Draft for review (2026-08-25). No code yet, per program practice: spec before code. Companion to `docs/vault-brokered-model-keys-spec.md` (Phases A+B of which are implemented); this spec reuses its machinery — placeholder convention, registry shape, proposal flow, reconcile mode, UI states.
**Scope:** Token-based channel credentials on Agent Vault-managed instances: Telegram bot tokens, Discord bot tokens, Slack bot + app tokens, including multi-account variants (`DISCORD_BOT_TOKEN_<ACCOUNT>`). WhatsApp and Signal are out of scope (see §6).

## 1. Problem

Channel tokens are the credential class that actually produced a customer incident (milo's Discord 401 loop): they are env-based by design (`.env` → `${DISCORD_BOT_TOKEN}` reference in `openclaw.json`), agent-readable, vault-invisible — and AGENTS.md doctrine says the opposite. The models work closed this gap for model keys; channels are the remaining token class, and the UI even exposes a token *readback* endpoint (`GET /api/channels/accounts/token`) that brokering eliminates outright.

## 2. Why channels are harder than model keys — and less hard than the audit assumed

Model keys needed zero transport work because model calls are in-process HTTPS fetches. Channels have long-lived sockets — but the 2026-08-25 transport audit predates a load-bearing fact confirmed in the pinned `openclaw@2026.7.1`: when `proxy.enabled` is set (which the vault claim already does), openclaw installs **`@openclaw/proxyline` in managed mode** — process-global routing that replaces `node:http`/`node:https`, both global agents, and the undici/fetch dispatcher, and *replaces caller-supplied agents* so libraries can't accidentally bypass. Child processes re-install it via `OPENCLAW_PROXY_ACTIVE=1`. Outside its model: code that captured transports before install or owns a private/native stack — which is exactly the Discord plugin case the audit verified.

Per-channel ground truth:

| Channel | Secret(s) | Where the secret travels | Transit today (managed) | Transport work |
| --- | --- | --- | --- | --- |
| Telegram | `TELEGRAM_BOT_TOKEN` | **URL path** of every long-poll/API call (`api.telegram.org/bot<token>/…`) via grammY (global fetch) | Through vault proxy (proxyline) | **None** — pure config, `path` substitution |
| Slack | `SLACK_BOT_TOKEN` (xoxb), `SLACK_APP_TOKEN` (xapp) | REST headers to `slack.com` (Web API + `apps.connections.open`); the Socket-Mode WSS itself uses a short-lived **ticketed URL, no stored secret** | REST expected through proxy (plugin transit **unverified** — §8) | None expected; verify plugin |
| Discord | `DISCORD_BOT_TOKEN` | REST `Authorization: Bot` header to `discord.com` **and** the gateway WSS IDENTIFY payload to `gateway.discord.gg` | **Direct-dials** (audit-verified: private transport; managed proxy never consulted) | Set `channels.discord.proxy` — the plugin's own hook routes **both** WSS and REST through an explicit proxy, no upstream PR |
| WhatsApp | `WHATSAPP_OWNER_NUMBER` + on-disk pairing keys | Number is not a secret; the real credential is Noise-protocol crypto material used in-process | n/a | **Excluded** — not a substitutable token |
| Signal | signal-cli linked-device keys | Local sidecar over loopback (shim direct-dials) | n/a | **Excluded** |

Discord's substitution is the vault docs' own worked example (REST header + `websocket` surface for IDENTIFY). Telegram webhook mode and other inbound-ingress modes stay out of scope — outbound-only modes are the Phase 3 recommendation already on the status board.

## 3. Design

Same placeholder contract as model keys: the value stored in `.env` (and expanded through `${ENV_KEY}` references in `openclaw.json`) becomes `__agent_vault_<env_key_lower>__`; the real token lives only in the vault and is injected at the proxy. `isVaultPlaceholderValue` and the whole models machinery apply unchanged.

**Registry** — new `lib/server/agent-vault/channel-provider-services.js`, same shape as the model registry plus two capabilities the model one lacks:

- **Multiple credential slots per service** (Slack: `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`, both `header`-surface substitutions on one `channel-slack` / `slack.com` service).
- **Account-scoped slots**: the env-key convention `DISCORD_BOT_TOKEN_<ACCOUNT>` already exists (`deriveChannelEnvKey`); each account adds a slot + substitution on the provider's existing service, placeholder `__agent_vault_discord_bot_token_work__`-style. The vault's 10-substitutions-per-service cap bounds this at 10 accounts per provider (5 for Slack) — acceptable, `log`-able.

Canonical services:

| Provider | Service(s) | Substitution surfaces |
| --- | --- | --- |
| telegram | `channel-telegram` → `api.telegram.org` | `path` |
| discord | `channel-discord` → `discord.com`, `channel-discord-2` → `gateway.discord.gg` | `header`, `websocket` |
| slack | `channel-slack` → `slack.com` | `header` |

**Discord transport prerequisite:** on managed instances, alphaclaw sets `channels.discord.proxy` to the literal string `"${OPENCLAW_PROXY_URL}"` — the same env-reference pattern channel tokens already use, so the git-synced `openclaw.json` never carries the runtime proxy token; the gateway child resolves it from the vault runtime env (shim port, credentials in userinfo). This is worth doing **independently of brokering**: it makes Discord's sockets vault-visible for Phase 3 flow scanning even while tokens are still raw. Recommend setting it at vault-claim time for all managed instances.

## 4. Flow changes in alphaclaw

**A. Adding a channel (vault connected)** — mirrors the models card states:

1. Channel add UI: for telegram/discord/slack, the token input is replaced by "Store token in Agent Vault". No `inspect-token` pre-validation (there is no token to inspect); the create flow runs `ensureChannelProviderAccess(provider, accountId)` → proposal with the service(s) + this account's slot(s).
2. Owner approves and enters the token(s) on the gateway vault operator page (TeamYou entry hop, as with model keys).
3. On availability, alphaclaw writes the placeholder(s) to `.env`, then runs the existing `openclaw channels add --channel <ch> --token <placeholder>` path — `syncChannelConfig`'s token→`${ENV_KEY}` rewrite works verbatim on placeholders — and restarts the gateway.
4. Post-approval verification replaces pre-validation: the existing inspect probe runs with the placeholder **through the vault proxy** and must succeed before the flow reports success.

**B. alphaclaw's own probes become proxy-aware.** `telegram-api.js`, `discord-api.js`, `slack-api.js`, `watchdog-notify.js`, and the inspect endpoints call provider APIs directly from the alphaclaw process, which is *not* behind proxyline. With placeholder tokens those calls 401. Add a small `createVaultAwareFetch()` (undici `ProxyAgent` from the runtime store, shim port) used by these modules whenever the token in hand is a placeholder; raw tokens keep the direct path so non-managed installs are untouched.

**C. Raw-token gate.** Once the vault runtime is claimed, the channel routes (`POST/PUT /api/channels/accounts`, inspect endpoints) reject raw tokens for brokered providers, mirroring the models gate. `kManagedChannelCredentialPattern` — the env-classification carve-out that currently *excludes* channel tokens from vault classification — becomes conditional: excluded only until brokering ships, then channel tokens are vault-class and the envars route's existing gate covers them too.

**D. Migration.** Same as model keys: per-account "Move token to Agent Vault" banner → proposal (owner re-enters the token at approval — the runtime token is proposal-only) → reconcile gains channel entries in placeholder mode and flips `.env` values once the vault reports service(s)+slot(s), then restarts. The `${ENV_KEY}` references in `openclaw.json` never change at all.

**E. Token readback.** `GET /api/channels/accounts/token` returns the placeholder for brokered accounts — the UI shows "Stored in Agent Vault" instead of a revealable secret.

## 5. What this closes

- The milo class dies completely: an agent asked to fix a channel token can only route the user to channel settings → vault flow, and doctrine, UI, API, and reality say the same thing. The AGENTS.md stopgap carve-out ("channel tokens go to channel settings, not the vault") becomes *true and vault-consistent* rather than an exception, and the models-spec Phase C doctrine edit and this land as **one** AGENTS.md change.
- Channel sockets stop being invisible: Discord WSS+REST transit the vault (per-channel proxy), Slack/Telegram already transit via proxyline — Phase 3 scanning sees every channel flow.
- Token rotation becomes vault-console-only, no alphaclaw touch, gateway restart not required (substitution reads the vault's current value per request/connect; the Discord WSS picks up rotation on next reconnect).

## 6. Exclusions

- **WhatsApp / Signal**: their credentials are pairing/crypto material used in-process, not substitutable request tokens. `WHATSAPP_OWNER_NUMBER` is not a secret. Unchanged.
- **Inbound webhook modes** (Telegram webhook mode, Gmail push): already broken/deprecated under strict routing; outbound-only modes are the supported path.
- **Non-managed installs**: unchanged raw-env path, as with model keys.

## 7. Failure modes

- Vault proxy down → Discord/Slack/Telegram fail alongside every other brokered flow; no new blast radius on managed instances (NAT path carries placeholders → 401, fails closed for auth).
- `channels.discord.proxy` set but vault runtime absent (mis-sequencing) → `${OPENCLAW_PROXY_URL}` expands empty; plugin must treat empty as "no proxy" — implementation-time verification, with a guard in alphaclaw to only write the key when the runtime exists.
- WSS substitution failure (vault can't parse a frame) → Discord IDENTIFY rejected → channel down but token safe; surfaced by the existing channel status probes.

## 8. Verification prerequisites (before code — Phase A exit criteria)

On `alphaclaw-egress-enforced-1`:
1. **Discord**: set `channels.discord.proxy` to the vault shim URL manually; confirm WSS+REST transit (vault/flow logs), then confirm the vault's `websocket` substitution completes an IDENTIFY with a vaulted token and `header` substitution carries REST.
2. **Slack**: confirm the plugin's Web API + `apps.connections.open` calls transit proxyline (flow logs), and that the ticketed WSS carries no stored secret.
3. **Telegram**: confirm grammY long-poll transits and `path` substitution works end-to-end (`getMe` with placeholder).
4. Confirm `${OPENCLAW_PROXY_URL}` env-expansion is honored in the `channels.discord.proxy` config position, and that empty expansion means direct.
5. Confirm `openclaw channels add` token probes (CLI child process) transit via inherited proxyline (`OPENCLAW_PROXY_ACTIVE=1`) so placeholder adds validate; if the Discord CLI probe uses the plugin's private transport, sequence the proxy config write before `channels add` or add with verification deferred.

## 9. Open questions for Bill

1. Set `channels.discord.proxy` at vault-claim time for **all** managed instances (recommended — Phase 3 visibility win independent of brokering), or only once a Discord token is brokered?
2. Multi-account slots: per-account credential keys as specced (matches env convention), or one shared slot per provider with per-account services? (Spec assumes per-account keys.)
3. Post-approval probe failure handling: block the flow (spec) or activate with a warning?
4. Should Slack's two tokens be approvable in one proposal (spec: yes — one service, two slots, single approval)?

## 10. Rollout

- **Phase A (verification + transport groundwork):** the §8 checklist on the enforced instance; `channels.discord.proxy` managed write. No credential behavior changes.
- **Phase B (server):** channel registry (multi-slot, per-account) · `ensureChannelProviderAccess` · placeholder plumbing through `syncChannelConfig`/`createChannelAccount` · raw-token gates · reconcile channel mode · vault-aware probe fetch.
- **Phase C (UI):** channel add/edit vault states (reuse the models card pattern + `PendingProposal`) · migrate banners · placeholder-aware token readback.
- **Phase D (doctrine):** the single AGENTS.md update covering model keys + channel tokens together.

Release sequencing: Phases B+C ride the same beta line as the model-keys work so one release closes the whole token class; Phase A needs no release (config + observation on the test instance).
