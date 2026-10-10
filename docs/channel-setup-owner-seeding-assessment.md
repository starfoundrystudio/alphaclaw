# Channel setup without DM pairing: assessment

_Exploration, 2026-10-06. Status: **proposal, no decisions taken.** Verified against the pinned `openclaw@2026.9.5` dist; platform facts from official Slack/Discord/Telegram docs as of this date._

## 1. Problem

Every channel added through Clawbridge (Telegram, Discord, Slack) is written with `dmPolicy: "pairing"` and no `allowFrom` (`lib/server/agents/channels.js:419-504`). The user then has to DM the bot, wait for a code, come back to Clawbridge and approve it under Pending Pairings (`lib/server/routes/pairings.js:446-500`). The bot's pairing reply is upstream text that tells the user to run a CLI command (parked, `docs/egress-program-status.md:60`). It is the last high-friction step in channel setup, and it adds nothing on a single-owner instance where we can already establish who the owner is.

## 2. What a completed pairing actually produces (OpenClaw 2026.9.5)

If we seed the same state at creation time, pairing becomes unnecessary.

| State | Written by pairing today | Seed instead |
|---|---|---|
| DM access | row in `state/openclaw.sqlite` → `channel_pairing_allow_entries`, plus our mirror into `channels.<p>[.accounts.<id>].allowFrom` (Slack) or `execApprovals.approvers` (Discord/Telegram) | `channels.<p>.accounts.<id>.allowFrom: ["<ownerId>"]` |
| DM policy | stays `pairing` | `dmPolicy: "allowlist"` (see decision D1) |
| Command owner | `bootstrapCommandOwnerFromPairing` writes `commands.ownerAllowFrom: ["<p>:<id>"]` only when empty (`dist/command-owner-*.mjs`, called from `pairing-cli` and `channel-pairing`) | `commands.ownerAllowFrom` += `"<p>:<id>"` |
| Exec approvers | our mirror (`routes/pairings.js:190-325`, `exec-defaults-config.js`) | same mirror, called from the seed path |
| Heartbeat route | unset `heartbeat.target` → `"owner"` → first `commands.ownerAllowFrom` entry, else first channel `allowFrom` (`dist/targets-*.mjs:85-126`) | unchanged; we set the managed default `"none"` when unset |
| Main-DM owner pin | exactly one non-wildcard **config** `allowFrom` entry pins the main session's owner (`dm-policy-shared`) | satisfied by seeding exactly one ID |

Contract notes:
- Under `allowlist` / `open` OpenClaw never reads the pairing store, so config is the whole truth. Do **not** write the SQLite store directly (internal, whole-channel rewrites).
- `allowlist` requires ≥1 entry (schema). Account-level `allowFrom` replaces the channel-root list (no merge).
- ID formats: Slack `U…`/`W…`; Discord snowflake **as a string**; Telegram numeric user id only (`@username` is rejected); room maps must be keyed by ID (Slack `C…`, Discord guild/channel snowflakes). Name keys silently fail under `allowlist`.
- Reload: `channels.*` restarts only that channel; `commands.*` restarts the gateway (hybrid mode does it automatically). Account creation already restarts, so seeding in the same write costs nothing extra.

**Implementation shape:** one server helper `seedChannelOwner({provider, accountId, ownerId})` that writes `allowFrom` + `dmPolicy` + `commands.ownerAllowFrom` + the exec-approver mirror in a single config write, and is reused by the pairing-approve route so "seeded" and "paired" are byte-identical outcomes.

## 3. Getting the owner ID per platform

### Discord: free, zero extra steps
`GET /oauth2/applications/@me` with the bot token returns `owner` (user) or, for team-owned apps, `team.owner_user_id` + `team.members[]` (owner is then a `TEAM_PSEUDO_USER`). `lib/server/discord-bot.js:56` **already calls this during token verification** and discards the field. Show "Owner: @handle — from your Discord app" with a "Not you?" member picker for team apps. Discord IDs are global.

### Slack: needs one new piece
A bot token cannot reveal the installer (`auth.test` returns the bot). Options, best first:

| Option | Friction | Notes |
|---|---|---|
| **A. `users.lookupByEmail` with the TeamYou owner email** | zero clicks when emails match; "Is this you?" confirm | needs `users:read.email` added to the manifest (`lib/public/js/lib/slack-manifest.js`); existing apps must reinstall to gain it. Email match is a heuristic, so always confirm; fall back to B or a member picker (`users.list`). |
| **B. Central "Sign in with Slack" (OIDC) on teamyou.com** | one OAuth click | one TeamYou-owned identity-only app (no bot scopes, so no Socket Mode / event-routing problem); returns `https://slack.com/user_id` + `team_id`; verify `team_id` == bot's `auth.test` team; hand the ID to the instance as a signed claim (reuse the Clawbridge SSO JWS pattern, new `purpose`). Fixed teamyou.com redirect avoids per-instance callback allow-listing. Needs client secret server-side and public distribution enabled; admin-approval workspaces may block it (unverified). |
| C. OAuth-install the customer's own app (`oauth.v2.access` → `authed_user.id`) | worse than today | requires `redirect_urls` in the manifest and pasting the app's client secret. Not recommended. |

The Socket Mode `xapp-` token stays a manual paste in every option. No API creates one.

### Telegram: one tap, no code
The Bot API has no owner field. Options:

| Option | Friction | Notes |
|---|---|---|
| **A. Deep-link capture** | tap link/QR → Telegram → Start | Clawbridge shows `t.me/<bot>?start=<nonce>` (≤64 chars, `[A-Za-z0-9_-]`), short-polls `getUpdates` **before** the channel is enabled in OpenClaw (so there is no polling conflict with the gateway), matches `/start <nonce>`, and takes `message.from.id`. Works self-hosted, no TeamYou dependency. The nonce is single-use and short-lived. |
| B. Managed bots (Bot API 9.6, Apr 2026) | removes BotFather entirely | A TeamYou manager bot sends `t.me/newbot/<manager>/<name>`; the manager receives the new bot's token **and** creator id; Bot API 10.0 adds native access restriction. **Custody conflict:** the manager bot can fetch and rotate every customer's token, which cuts against the vault-brokered channel doctrine. Whether Bot Management Mode needs Telegram approval is unverified. Strategic option, needs a decision. |
| C. Telegram OIDC login on teamyou.com | one OAuth click | ID is in the `id` claim (needs `profile` scope), not `sub`. Only worth it if TeamYou builds a general "connected identities" feature. |

## 4. Channel and server pickers

With the owner known, the second step is "where can the agent talk?" Today rooms are written as `{"*": {requireMention:true}}` with `groupPolicy: "open"` (every room the bot is in, mention-gated). A picker lets us move to `groupPolicy: "allowlist"` with explicit IDs:

- **Slack:** `conversations.list` (`channels:read`, `groups:read`; private channels only appear once the bot is a member) plus `conversations.join` (`channels:join`) so the bot can join selected public channels itself. Private channels: instruct `/invite @bot`, then refresh. Write `channels.slack.accounts.<id>.channels.<C…>: {requireMention}`.
- **Discord:** `GET /users/@me/guilds` → `GET /guilds/{id}/channels` (bot token, no intents). Add `guild_id` to the install URL to preselect a server. **From 2026-11-16 the channel list omits channels without `VIEW_CHANNEL`**; treat missing channels as "bot can't see it" and explain. Write `guilds.<gid>.channels.<cid>`.
- **Telegram:** bots cannot list chats. Keep "add the bot to a group" and capture via the `my_chat_member` update (the existing `telegram-workspace.js` path).

## 5. Proposed user journey (shared create-channel modal)

1. **Connect bot**: unchanged token/manifest step (Slack keeps the xapp paste).
2. **Confirm owner**: prefilled per §3 (Discord automatic, Slack email match or sign-in, Telegram one tap). "Skip, I'll pair by DM" stays as a fallback that keeps today's behavior.
3. **Choose where it talks**: DMs with you (on), plus a channel/server picker (Slack/Discord).
4. **Connected**: "Say hi" opens the DM (`slack.com/app_redirect`, `discord.com/users/<botId>`, `t.me/<bot>`), and the first message just works. No Pending Pairings step.

## 6. Suggested phasing

| Phase | Scope | Repos |
|---|---|---|
| 1 | `seedChannelOwner` helper; Discord owner autofill; Telegram deep-link capture; Slack email lookup + member-picker fallback; new connected-screen copy; tests that simulate a fresh provision on 2026.9.5 and assert exact keys | alphaclaw |
| 2 | Slack/Discord channel pickers, `groupPolicy: "allowlist"` for new accounts | alphaclaw |
| 3 | Central Sign in with Slack on teamyou.com + signed identity claim; decide Telegram managed bots | teamyou, alphaclaw |

**Phase 1 status (2026-10-10): committed to main, not released.** Bill chose the modal-only version. Shipped shape:
- `lib/server/channel-owner.js` writes `dmPolicy: "allowlist"`, `allowFrom: [id]`, appends `commands.ownerAllowFrom`, and the create path runs `ensureManagedChannelApprovalDefaults` in the same config write. The pairing route now shares its ID normalizers.
- Discord: owner autofilled from `/oauth2/applications/@me`, with team members offered under "Not you?".
- Telegram: `POST /api/channels/telegram/owner-link` + `owner-poll` (`lib/server/telegram-owner-capture.js`), using a single-use nonce with a 10-minute TTL.
- Slack: **member picker** (`POST /api/channels/slack/members`, `users.list` via the existing `users:read` scope) instead of the email lookup. It needs no manifest change and doesn't give the agent's bot access to workspace emails. The email prefill (D2-A) stays open.
- D1 was applied as recommended: a confirmed owner gets `allowlist`. "Skip and use DM pairing" keeps today's behavior.
- In 2026.9.5, `commands.*` sits in the shared channel reload prefixes, so seeding restarts channels, not the gateway.
- Not yet live-tested against real Slack/Discord/Telegram.

Existing instances: nothing breaks; already-paired accounts keep working. Optionally offer "lock DMs to you" (pairing → allowlist with the paired ID).

## 7. Decisions needed

- **D1. DM posture once the owner is seeded.** Recommend `allowlist`: strangers are silently ignored and never see the CLI-flavored pairing reply. Alternative: keep `pairing` with the seeded `allowFrom`, so the owner skips pairing and others can still request access. Could be a toggle ("Let others request access").
- **D2. Slack identity source.** Recommend A now (manifest scope change) and B in phase 3.
- **D3. Telegram managed bots.** Recommend deferring until the custody question is answered; ship deep-link capture first.
- **D4. Group posture for new accounts.** Recommend picker + `allowlist` over today's `open` + mention.

## 8. Risks and open items

- Slack's May 2025 API terms describe "templated custom app" instructions for a commercial product as Marketplace-only distribution. This applies to the current manifest flow already, not just this proposal. Rate-limit treatment of customer-created apps is unverified. Worth a policy read.
- Email-match identity is a heuristic; never seed without explicit confirmation.
- `commands.ownerAllowFrom` is instance-wide. Adding a second channel appends a prefixed entry and must not replace the first.
- Separately found: General-tab channel policy edits are silently dropped (`channels.js:366` → `updateChannelAccount` ignores `policy`); tracked as its own task.
