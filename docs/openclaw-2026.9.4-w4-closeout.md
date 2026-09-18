# OpenClaw 2026.9.4 upgrade — W4 closeout

Date: 2026-09-18  
Branch: `codex/openclaw-2026.9.4-upgrade`

## Outcome

AlphaClaw now writes the approved managed OpenClaw 2026.9.4 posture during
fresh onboarding and delivers it once to existing AlphaClaw-managed instances
through `alphaclaw migrate`. The change is scoped to application and upgrade
behavior; it does not perform or coordinate a fleet rollout.

## Managed defaults

Fresh and migrated managed instances receive:

- `agents.defaults.maxConcurrent=3` for the current CPX instance class.
- `plugins.entries.memory-core.config.dreaming.enabled=false`.
- `skills.workshop.autonomous.mode=propose`.
- `tools.swarm=false` and `secrets` appended to `tools.deny`.
- `gateway.cliAgents.enabled=false`.
- `gateway.terminal.enabled=false`.
- `telemetry.enabled=false`.
- `secrets.egressProxy.enabled=false`.

AlphaClaw does not write `agents.defaults.memorySearch`,
`agents.defaults.subagents.maxSpawnDepth`, or session-reset defaults. Existing
adjacent configuration is preserved, including tool deny entries, nested
feature limits, model selection, plugin settings, and provider settings.

The settings were validated directly with the pinned OpenClaw 2026.9.4
configuration schema and CLI validator.

## Existing-instance delivery

The `2026-09-apply-managed-runtime-defaults` migration is gated by
AlphaClaw's `onboarded.json` marker. It therefore applies only to existing
managed installations and does not restore the discontinued
standalone-OpenClaw import path.

The migration records successful delivery in AlphaClaw's migration ledger.
Later migration runs treat it as complete and preserve deliberate user changes
made after delivery. Fresh onboarding writes the defaults directly.

These feature switches are not continuously rewritten during ordinary boot.
The CPX concurrency ceiling is additionally protected whenever Telegram
workspace configuration is synchronized, because that path previously raised
agent and subagent concurrency based on topic count.

## Telegram workspace correction

Telegram workspace synchronization now caps main-agent concurrency at three,
preserves a lower explicit value, and leaves subagent concurrency and spawn
depth unchanged. The UI no longer describes concurrency as auto-scaled by
topic count; it shows the managed main-agent value and either the configured
subagent value or the OpenClaw default.

## Verification

- Focused W4 tests: 4 files and 47 tests passed.
- Full suite: 159 files and 1,448 tests passed.
- The generated W4 configuration passed the pinned OpenClaw 2026.9.4
  `config validate --json` command.
- `npm run build:ui` passed.
- `git diff --check` passed.

Coverage includes fresh onboarding, adjacent-setting preservation,
idempotence, one-time migration delivery, preservation of later user choices,
Telegram concurrency behavior, and pinned-schema acceptance.

## Follow-up

W5a is the next approved implementation slice. Live-host and fleet rollout
remain out of scope until the later rollout checkpoints.
