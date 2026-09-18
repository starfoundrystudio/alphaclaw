# W5c — Managed channel and agent configuration

W5c expands Clawbridge so operators do not need the OpenClaw Control UI for the release-critical configuration in the 2026.9.4 upgrade.

## Managed surface

- Channel accounts: direct-message policy, direct-message allowlists, group/room policy, group sender allowlists, default mention activation, bot-message handling, and per-room overrides.
- Room routing: a Telegram group, Discord channel, or Slack channel can route to a different managed agent without changing the channel account's default agent.
- Agents: primary and ordered fallback models, thinking level, automatic/fast/standard speed preference, tools, installed-skill allowlists, and channel/room bindings.
- Catalogs: models continue to use the live Gateway-backed model catalog; skills use `openclaw skills list --agent <id> --json`, which resolves the current OpenClaw skill catalog and eligibility for that agent.

## OpenClaw 2026.9.4 contracts

AlphaClaw writes the canonical OpenClaw fields rather than maintaining a parallel representation:

- `agents.entries.<id>.model.primary` and `.fallbacks`
- `agents.entries.<id>.thinkingDefault`
- `agents.entries.<id>.fastModeDefault`
- `agents.entries.<id>.tools`
- `agents.entries.<id>.skills`
- `channels.<provider>.accounts.<id>.dmPolicy`, `allowFrom`, `groupPolicy`, provider-specific room maps, and activation fields
- `bindings[].match` with account and peer scope for room-specific routing

Channel policy writes validate OpenClaw's accepted policy values. In particular, open direct messages require `allowFrom: ["*"]`, and allowlist mode cannot be saved with an empty direct-message allowlist.

## Existing-instance delivery

No one-time state migration is required. These are optional OpenClaw configuration fields, and AlphaClaw reads the existing canonical account and agent configuration before rendering or writing it. Existing managed hosts receive the new UI and API behavior when the AlphaClaw package is upgraded:

- Existing policy values and provider-specific room settings are loaded in place.
- Missing values are shown using OpenClaw 2026.9.4 runtime defaults and are only made explicit when an operator saves the policy.
- Unknown provider-specific room fields are preserved when Clawbridge updates the managed fields.
- Model and skill catalogs are resolved dynamically, so upgrading an existing host does not generate or migrate a per-host static catalog.

Because there is no new required baseline state to seed or repair, `alphaclaw migrate` and OpenClaw Doctor do not need a W5c migration step. The durable delivery path is the normal AlphaClaw package upgrade; subsequent edits are idempotent canonical config writes.
