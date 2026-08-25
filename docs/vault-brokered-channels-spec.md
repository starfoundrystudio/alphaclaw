# Vault-Brokered Channel Credentials — Spec

**Status:** v2 **approved with decisions recorded 2026-08-25** (§9): gateway-held KEK for Tier C · hard block for unclassified channels · per-account slots · inbound webhooks stay supported via Tailscale funnel (msteams unblocked) · probe failure blocks the flow · deny-list default-closed. Next: Phase A verification on the enforced instance (needs owner-provided test channel credentials — see §8). v1 excluded WhatsApp/Signal; owner rejected exclusion-by-fiat; v2 classifies **every** channel in the OpenClaw catalog (26 plugins + the 4 core channels) into protection tiers — including the classes substitution cannot serve.
**Companion:** `docs/vault-brokered-model-keys-spec.md` (Phases A+B shipped); the placeholder machinery, proposal flow, reconcile mode, and UI states from that work are reused here for Tier S.

## 1. Problem

Channel credentials are env/config-based, agent-readable, and vault-invisible; AGENTS.md doctrine says the opposite, and the contradiction produced the milo incident. The models work closed the gap for model keys. Channels span a much wider credential space than "a token": bot tokens, OAuth client secrets, webhook-signing HMAC secrets, private signing keys, and device-pairing keystores. A plan that only handles the token-shaped ones and waves the rest away leaves both a security gap and a doctrine ambiguity for every channel we add later (Microsoft Teams included). This spec therefore defines: (a) a taxonomy that covers every credential shape a channel can have, (b) the protection mechanism and honest threat-model statement for each tier, and (c) a governance rule so **no channel ships on a managed instance unclassified**.

## 2. Transport ground truth (unchanged from v1, condensed)

With `proxy.enabled` (set at vault claim), the pinned `openclaw@2026.7.1` installs `@openclaw/proxyline` in managed mode: process-global routing over `node:http`/`https`, the undici/fetch dispatcher, and caller-supplied agents, re-installed in children via `OPENCLAW_PROXY_ACTIVE=1`. Consequences: most channel REST/long-poll traffic already transits the vault proxy; the audited exception is the Discord plugin's private transport stack (fixed via its own `channels.discord.proxy` hook — set to the literal `"${OPENCLAW_PROXY_URL}"` env reference so the git-synced config stays secret-free); loopback destinations intentionally bypass via the shim. Per-plugin transit is an empirical checklist item (§8), not an assumption.

## 3. Credential taxonomy

Classify each credential by **where the secret must appear for the integration to work**. That single question determines what protection is achievable — this is physics, not preference.

**Tier S — Substitutable request secrets.** The secret appears verbatim in a request surface the vault proxy can rewrite (`header`, `path`, `query`, `body`, `websocket`). Mechanism: the shipped model-keys machinery — vault service per host, `__agent_vault_*__` placeholder on-box, substitution at the proxy. Protection achieved: the secret **never exists on the instance**; agent exfiltration is impossible, rotation is vault-console-only. This is full brokering.

**Tier S/te — OAuth client secrets (token-endpoint variant of Tier S).** App credentials (client_id + client_secret, e.g. Microsoft Bot Framework, Feishu, WeCom, Twitch) appear only in the token-endpoint request (form body or query). Mechanism: `body`/`query` substitution on the identity host (`login.microsoftonline.com`, `open.feishu.cn`, …). The resulting access token is Tier D. Same guarantee as Tier S for the durable secret.

**Tier D — Derived ephemeral secrets.** Short-lived artifacts obtained *using* a Tier S/C parent: OAuth access tokens, Slack Socket-Mode ticket URLs, session cookies. Policy: permitted in process memory and short-lived caches; never written durably (disk cache must be tmpfs or encrypted under Tier C custody); expiry ≤ provider default. The durable parent stays brokered, so a leaked derivative self-heals on expiry and revocation happens at the parent.

**Tier C — Cryptographic custody material.** The process must *compute* with the secret: webhook-signature HMAC keys (LINE channel secret), event-signing private keys (Nostr, Matrix E2EE device keys, Urbit), and pairing/session keystores (WhatsApp Noise keys, Signal linked-device keys, WeChat/Zalo QR sessions). Substitution is architecturally impossible — no proxy rewrite can perform the crypto for a process that never has the key.

Honest threat-model statement, since this is the class v1 hand-waved: **runtime confidentiality from the agent is not achievable for Tier C** — the gateway process the agent operates in must hold the plaintext in memory to function; a sufficiently capable agent can read its own process. What *is* achievable, and what Tier C requires:

1. **Sealed at-rest custody (C1, target — mechanism decided 2026-08-25: gateway-held KEK).** Keystores envelope-encrypted on disk; the KEK lives on the security gateway and the plaintext exists only in gateway-process memory/tmpfs after an unwrap over the existing gateway private path at service start. clawctl work; **no new TeamYou/vault feature**. (A future vault unwrap primitive may supersede the KEK holder without changing the on-instance contract.) A stolen disk/backup/snapshot yields ciphertext; revocation = KEK denial + provider-side unlink.
2. **Custody hygiene (C0, interim — shippable now).** Keystore paths enumerated per channel in the registry; enforced: 0600/0700 modes, excluded from git-sync and any backup/export path, excluded from the agent-browsable workspace, never mirrored into env or `openclaw.json`.
3. **Flow visibility.** Tier C transports still transit proxyline/NAT and are Phase-3 scannable; exfil of the keystore to an unexpected destination is a detectable flow, which is the compensating control for the runtime-confidentiality gap.
4. **Revocation runbook per channel.** Every Tier C registry entry documents the provider-side revocation act (WhatsApp: unlink device; Signal: remove linked device; Nostr: key rotation + relay note), so incident response never depends on remembering provider mechanics.

**Tier L — Locally-terminated services.** The credential authenticates to a host the vault proxy cannot front: loopback/LAN endpoints (self-hosted Mattermost, Synology NAS, Nextcloud, private IRC). The shim direct-dials loopback by design, so substitution never sees the traffic. Classification is per *instance configuration*, not per channel: the same Mattermost token is Tier S when the URL is public and Tier L when it's LAN. Tier L secrets get C0 custody hygiene + the documented residual ("secret readable on-box; compensate with provider-side scoping"), and the UI says so instead of pretending.

## 4. Full catalog classification

The four alphaclaw-managed channels, mapped and ready for implementation:

| Channel | Credential(s) | Tier | Mechanism |
| --- | --- | --- | --- |
| telegram | `TELEGRAM_BOT_TOKEN` (+ per-account) | S | `path` substitution on `api.telegram.org` (grammY transits via proxyline) |
| discord | `DISCORD_BOT_TOKEN` (+ per-account) | S | `header`+`websocket` substitution on `discord.com` + `gateway.discord.gg`; requires `channels.discord.proxy = "${OPENCLAW_PROXY_URL}"` |
| slack | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | S | `header` substitution on `slack.com`, one service/two slots; WSS is a Tier D ticketed URL |
| whatsapp | Noise-protocol pairing keystore (`WHATSAPP_OWNER_NUMBER` is not a secret) | **C** | C0 now (keystore path hygiene); C1 sealed custody when the KEK mechanism lands; revocation = unlink device |

Catalog plugins, classified provisionally (each entry is **verified against the plugin's actual config at classification time** — the plugins install at runtime and are not vendored here; provisional rows are from the providers' published auth models):

| Channel | Expected credential(s) | Tier |
| --- | --- | --- |
| msteams | Bot Framework `appId` + `appPassword` (client secret), tenant | **S/te** (body substitution on `login.microsoftonline.com`; Bot Connector/Graph bearer is Tier D). Inbound messaging endpoint served via the standard Tailscale-funnel webhook path (§9 D4) |
| feishu / wecom / qqbot / zalo / line / twitch / googlechat | app/client secrets, bot tokens; LINE adds a webhook-HMAC channel secret | S or S/te for tokens/secrets; LINE's HMAC secret is **C** (in-process signature verification) |
| sms (Twilio) | `TWILIO_AUTH_TOKEN` etc. | S (`header` basic-auth uses base64 — **verify**: if the plugin base64-encodes SID:token, verbatim substitution fails and Twilio needs the vault's `basic` auth-injection mode instead of substitution) |
| clickclack / mattermost / synology-chat / nextcloud-talk / irc | bot tokens / passwords to arbitrary or self-hosted hosts | S when the configured host is public; **L** when loopback/LAN |
| matrix | access token (S) · E2EE device keys (**C**) | split |
| nostr / tlon | private signing keys | **C** |
| openclaw-weixin / zalouser | QR-login session keystores | **C** |
| signal | signal-cli linked-device keystore (loopback REST bridge) | **C** (+ the bridge itself is loopback, Tier L transport) |
| raft / yuanbao | to classify at enablement | — |

## 5. Governance: no unclassified channel on managed instances

The channel registry (`lib/server/agent-vault/channel-provider-services.js`) becomes the gate, not just a lookup: on managed instances, the add-channel UI and `POST /api/channels/accounts` **refuse to enable a channel that has no registry classification**, with a message naming the missing step (owner-overridable per §9 Q2). Classifying a new channel is a five-question checklist, answered against the plugin's real config and transport:

1. Which config/env fields hold secrets, and where does each appear on the wire (surface, host)?
2. Does any secret feed in-process crypto (signing, HMAC, pairing)? → Tier C entry + keystore paths + revocation runbook.
3. Which hosts terminate the traffic, and do they transit proxyline (empirical check)? Public → S/S-te service defs; local → L.
4. What derived secrets exist and where are they cached? → Tier D policy check (no durable plaintext).
5. What is the inbound-ingress posture (webhook needs)? Inbound webhooks are a **supported** pattern — served through the standard Tailscale-funnel path (the same mechanism as Composio triggers today), never a raw public port. The classification records which funnel routes the channel needs and which Tier C/D secrets verify inbound payloads (HMAC secrets, JWT validation). Known caveat to design around: the funnel path has an open strict-ingress issue (the Gmail webhook loopback-hop 404 class) — new webhook channels must be verified against strict routing, not assumed.

Worked example — the checklist applied to msteams — ships in the registry as the template entry. This is also the answer to "what about channels we want to support later": adding Teams support *is* running this checklist and landing the registry entry; the mechanics (S/te body substitution) already exist from the model-keys machinery.

### 5a. Enforcement outside Clawbridge (Control UI, agent tools, CLI)

Clawbridge's route gates only bind flows that pass through Clawbridge — but managed users also hold the OpenClaw Control UI (the "Launch OpenClaw" surface), and the agent itself and the CLI can all write `openclaw.json`. Restricting the *writers* is a losing game; the pinned gateway lets us enforce at the *consumer* instead. Verified in `openclaw@2026.7.1` (`resolvePluginActivationDecisionShared`):

- **`plugins.deny` is a hard activation gate, checked first.** It beats `entries.<id>.enabled: true`, slot selection, and — critically — the bundled-channel bypass (`channels.<id>` config normally skips the allowlist via `bundled-channel-enabled-in-config`; deny still wins). A denied channel plugin does not activate no matter which surface configured it.
- **`plugins.allow`**, when non-empty, default-closes everything not listed (`not-in-allowlist`) *except* bundled channels — which is why deny, not allow, is the load-bearing control for channels.
- **Doctor already explains it.** The `core/doctor/channel-plugin-blockers` check surfaces "configured channel whose backing plugin cannot activate" with the cause, so a user who adds a blocked channel via the Control UI gets a truthful diagnostic, not silent breakage.

The managed-instance enforcement stack is therefore three layers:

1. **Install layer** (non-bundled channel plugins): plugin installation on managed hosts follows the established TeamYou-gating pattern — installs host-controlled, alphaclaw is the single enablement writer. An unclassified catalog plugin never reaches disk.
2. **Activation layer** (everything, including bundled channels): alphaclaw derives `plugins.deny` from the classification registry — every channel plugin **not** classified (or classified but pending owner enablement) is denied — and re-asserts it on the post-onboard reconcile timer, the same single-writer doctrine already used for the TeamYou plugin gate. Because the gateway enforces at activation, this binds the Control UI, the agent, and the CLI identically, with zero upstream changes.
3. **Credential layer** (backstop for *classified* channels configured out-of-band): a reconcile **raw-secret sweep** over `openclaw.json` and `.env` — secret-shaped values in channel config positions that are neither `${ENV}` references nor `__agent_vault_*__` placeholders get quarantined into the migration flow (moved to env, config rewritten to the reference, migrate banner raised). A token pasted into the Control UI becomes a detected migration case, not a permanent bypass.

Honest limits, stated rather than papered over: the customer owns the instance, and the Control UI (or the agent, at the user's direction) can edit `plugins.deny` back. The reconcile loop re-asserts policy and surfaces a visible "managed policy re-applied" notice in Clawbridge — this is guardrails and self-healing defaults, not tamper-proofing. True config lockdown would require host-level config ownership (gateway process unable to write its own policy keys), which belongs to the parked Phase 4 privilege-hardening track; nothing in this spec depends on it.

## 6. alphaclaw flow changes (Tier S/S-te; unchanged from v1 in substance)

- Add-channel UI vault states mirror the models card: request → proposal (service + this account's slots, Slack's two tokens in one approval) → owner enters values on the gateway vault operator page → alphaclaw writes placeholders, runs the existing `openclaw channels add` path (the token→`${ENV_KEY}` rewrite works verbatim on placeholders), restarts.
- Pre-validation (`inspect-token`) is replaced by post-approval verification through the proxy; alphaclaw's own probes (`telegram-api.js`, `discord-api.js`, `slack-api.js`, `watchdog-notify.js`) gain `createVaultAwareFetch()` (undici ProxyAgent from the runtime store) for placeholder values, since the alphaclaw process is not behind proxyline.
- Raw-token gate on channel routes once the runtime is claimed; `kManagedChannelCredentialPattern`'s carve-out becomes conditional so the envars gate covers channel tokens too.
- Migration: per-account "Move token to Agent Vault" banner → proposal → reconcile flips env to placeholder (channel entries in placeholder mode); `${ENV_KEY}` refs in `openclaw.json` never change.
- `GET /api/channels/accounts/token` returns the placeholder for brokered accounts — the token-readback exposure ends.
- Multi-account slots follow the existing `DISCORD_BOT_TOKEN_<ACCOUNT>` convention; the 10-substitutions-per-service cap bounds accounts per provider (10; Slack 5) and is logged, not silently truncated.

Tier C flows: no UI change in C0 beyond honest labeling — the channel card shows "Device-pairing credential: protected at rest, not vault-brokered (by design)" with the revocation link, instead of implying vault coverage that doesn't exist. C1 adds an "encrypt keystore" state when the KEK mechanism ships.

## 7. Failure modes

Tier S: as the models spec (fails closed to 401 off-proxy; vault-down = no new blast radius; WSS substitution failure surfaces via channel status). Tier C custody: KEK holder unreachable at boot → channel stays down with a specific doctor state (fail-closed, no plaintext fallback write); backup/export paths tested to confirm keystore exclusion. Tier L: UI residual-risk labeling is the control; no silent pretense.

## 8. Verification prerequisites (Phase A exit criteria, on `alphaclaw-egress-enforced-1`)

1. Discord: `channels.discord.proxy` → shim URL; WSS+REST transit confirmed in flow logs; `websocket` substitution completes IDENTIFY with a vaulted token; `header` carries REST.
2. Slack: plugin Web API + `apps.connections.open` transit confirmed; WSS ticket confirmed secret-free.
3. Telegram: long-poll transit + `path` substitution end-to-end (`getMe` with placeholder).
4. `${OPENCLAW_PROXY_URL}` expansion honored in the `channels.discord.proxy` position; empty expansion = direct (guard: alphaclaw only writes the key when the runtime exists).
5. `openclaw channels add` CLI probes transit via inherited proxyline so placeholder adds validate; otherwise sequence proxy config before add.
6. WhatsApp/Signal keystore inventory: enumerate on-disk paths, confirm current permissions, confirm git-sync/backup exclusion status (C0 baseline facts).

Owner dependency: items 1–3 need **throwaway test credentials** (a scratch Discord bot, Slack app, Telegram bot) — the enforced test instance deliberately has no external accounts. Item 4–6 need none.

## 9. Decisions (owner, 2026-08-25)

1. **D1 — Tier C mechanism: gateway-held KEK** over the existing gateway private path (clawctl work item; no TeamYou change). A vault unwrap primitive may later replace the KEK holder without changing the on-instance contract.
2. **D2 — Unclassified-channel gate: hard block** on managed instances.
3. **D3 — Per-account slots**, matching the `DISCORD_BOT_TOKEN_<ACCOUNT>` env convention.
4. **D4 — Inbound webhooks remain fully supported** — for msteams and beyond (Composio triggers are the existing precedent). The standard mechanism is the Tailscale-funnel webhook path; ingress posture is therefore *not* a reason to hold any channel. Classification duty: record the funnel routes and the payload-verification secrets (Tier C/D) per channel, and verify each new webhook channel against strict routing (the Gmail-webhook loopback-hop 404 class is a known open issue on that path).
5. **D5 — Post-approval probe failure blocks the flow** (no activate-with-warning).
6. **D6 — Deny-list default-closed**: every catalog channel plugin not in the classification registry is denied on managed instances.

## 10. Rollout

- **Phase A — verification + transport groundwork** (§8; `channels.discord.proxy` managed write; no credential behavior changes, no release needed).
- **Phase B — Tier S server**: channel registry with tier field + classification gate · `ensureChannelProviderAccess` · placeholder plumbing · raw-token gates · reconcile channel mode · vault-aware probe fetch · `plugins.deny` derivation + reconcile re-assert and the raw-secret sweep (§5a layers 2–3).
- **Phase C — UI**: vault states for S-tier channels · migrate banners · honest Tier C/L labeling · placeholder-aware readback.
- **Phase D — doctrine**: one AGENTS.md update covering model keys + channel tokens + the Tier C statement ("pairing credentials are custody-protected, not vault-brokered; never write them to Envars either").
- **Phase E — Tier C sealed custody (C1)**: gateway-held KEK per §9 D1 (clawctl work item); WhatsApp + Signal first, then LINE HMAC/Nostr keys as those channels are enabled. Independent track; C0 hygiene lands in Phase B.

Release sequencing: Phases B+C ride the same beta line as the model-keys work; Phase E (clawctl KEK) is decoupled and does not block the beta.
