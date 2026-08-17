# Origin and Divergence

AlphaClaw began as a fork of `chrysb/alphaclaw`. The project is now
independently maintained by Starfoundry: upstream tracking was abandoned after
the sync to `v0.9.18`, there is no ongoing sync workflow, and differences from
the original codebase are no longer audited or reconciled against it.

This file preserves the design rationale behind behaviors that intentionally
diverged from the original project and still describe how AlphaClaw works
today. Read these as plain documentation of current behavior and the reasoning
behind it — not as deviations pending re-evaluation.

(References to "the original project" below mean `chrysb/alphaclaw` as of the
last sync. The `openclaw` dependency is a separate, still-active upstream and
is not covered by this note.)

## GitHub sync only when explicitly configured

Area: runtime prompt / managed sync cron

Behavior:

- AlphaClaw retains the GitHub sync setup, `alphaclaw git-sync` command, sync
  schedule UI, and import behavior.
- The managed hourly GitHub sync cron is only installed/run when both
  `GITHUB_TOKEN` and `GITHUB_WORKSPACE_REPO` are configured.
- The runtime OpenClaw agent is told to commit locally, and only push when a
  GitHub sync remote is configured or the user explicitly asks for a push.

Why:

- GitHub sync setup can be skipped during onboarding.
- Without this guard, the packaged agent prompt and legacy/stale cron state can
  make OpenClaw try to push even when the user never configured a sync repo.

## Import-managed runtime token handling

Area: onboarding / import
Introduced in: `102685e` (`Fix import-managed runtime token handling`)

Behavior:

- During import, always generate a fresh `OPENCLAW_GATEWAY_TOKEN`.
- Preserve imported `WEBHOOK_TOKEN` if present; otherwise generate a new one.

Why:

- Imported setups skip parts of fresh `openclaw onboard` behavior, which left
  imported configs referencing `${OPENCLAW_GATEWAY_TOKEN}` without actually
  persisting a value into AlphaClaw's managed `.env`.
- That caused first-start gateway failures after import.
- We chose to rotate the internal gateway token on every import for safety,
  while preserving webhook tokens when available to avoid breaking existing
  external callers unnecessarily.

## Managed OpenClaw config hardening defaults

Area: onboarding / generated OpenClaw config

Behavior:

- Starfoundry's managed config defaults apply during fresh onboarding and
  managed import, including active-memory defaults, update checks disabled by
  default, and managed mDNS discovery mode handling.
- Never write `plugins.slots.memory`. clawctl's reconcile owns the slot
  (`memory-core` since teamyou-openclaw-memory v0.3.0 dropped `kind: "memory"`),
  so memory-core file search is active from first boot. The pre-bootstrap
  TeamYou gate covers the plugin entry's `enabled` flag, the active-memory
  eligibility flag, and the teamyou skill — not the slot.
- Do not write managed `agents.defaults.memorySearch` embedding defaults. The
  fleet no longer provisions `AI_GATEWAY_API_KEY` for embeddings; local
  embeddings are handled clawctl-side, and user-provided memorySearch settings
  are preserved as-is.
- The managed gateway API endpoint and remote MCP config additions are routed
  through AlphaClaw's safe config mutation guardrails.
- Do not force an AlphaClaw-managed heartbeat model. Leave
  `agents.defaults.heartbeat.model` unset for fresh managed configs, and
  preserve imported/existing heartbeat model settings as-is.
- The `usage-tracker` hook policy additions (from the original project's
  `v0.9.15`) are retained.

Why:

- Starfoundry deployments expect these defaults to keep managed hosts quiet,
  consistent, and pre-wired for the runtime profile AlphaClaw ships.
- AlphaClaw previously forced `vercel-ai-gateway/google/gemini-2.5-flash-lite`
  for heartbeats when provisioning also supplied `AI_GATEWAY_API_KEY`. That key
  is no longer part of default provisioning, so forcing the Gateway heartbeat
  model can create unauthenticated heartbeat runs.

## Explicit Codex OAuth runtime route during onboarding

Area: onboarding / setup UI / generated OpenClaw config

Behavior:

- Codex OAuth is kept separate from the native Codex runtime choice.
- When a user selects an `openai/*` or `openai-codex/*` model and connects
  Codex OAuth, default to the native Codex runtime by setting
  `models.providers.openai.agentRuntime.id: "codex"` and using the canonical
  `openai/*` model key.
- The user can explicitly switch to the flexible OpenClaw Pi route, which uses
  the effective `openai-codex/*` model key.
- Only install/enable the managed `codex` plugin, set
  `models.providers.openai.agentRuntime.id: "codex"`, and enable
  `tools.web.search.openaiCodex` when the Codex runtime route is selected.

Why:

- Codex OAuth can authenticate the default Pi route without requiring an
  `OPENAI_API_KEY`.
- The native Codex runtime improves OpenAI/Codex behavior, while provider-scoped
  runtime config lets non-OpenAI providers keep using their own runtime/auth
  path later.
- OpenClaw exposes OAuth auth and the Codex runtime as separate concepts;
  AlphaClaw's setup UI makes that tradeoff explicit rather than inferring
  runtime from OAuth connection state.

## Watchdog startup and repair timeouts

Area: watchdog / gateway lifecycle

Behavior:

- Watchdog startup grace and health probe timeout defaults are longer than the
  original project's and are configurable.
- Watchdog repair commands run on a longer timeout.

Current defaults:

- `WATCHDOG_STARTUP_GRACE_MS` default `60s`
- `WATCHDOG_HEALTH_TIMEOUT_MS` default `10s`
- `WATCHDOG_REPAIR_TIMEOUT_MS` default `10m`

Why:

- Imported or overloaded hosts can take materially longer than the original
  watchdog defaults to bring the gateway fully healthy.
- Short startup grace and short probe timeouts make AlphaClaw too eager to mark
  the gateway degraded on slow starts.
- Repair commands can legitimately take longer than the generic 15s CLI
  timeout.

## OpenClaw config repair delegation with pinned plugin reconciliation

Area: watchdog / startup / OpenClaw config mutation

Behavior:

- Broad OpenClaw config repair is delegated to OpenClaw doctor, using guarded
  `openclaw doctor --non-interactive --fix` for unattended AlphaClaw repair.
- A failed `openclaw.json` read is never treated as an empty config.
- `openclaw.json` is never parsed and rewritten from partial AlphaClaw
  knowledge during normal startup repair.
- Channels are not re-added during already-onboarded startup as a repair
  strategy.
- OpenClaw config is not mutated outside the shared config helper unless the
  config is valid and includes `gateway.mode`.
- AlphaClaw's managed plugin compatibility reconciliation runs only after the
  guarded OpenClaw doctor repair has succeeded and the repaired config is safe
  for mutation.

Concretely:

- Already-onboarded startup does not run channel re-add/reconciliation.
- Startup config-read failures invoke
  `alphaclaw openclaw-doctor-guard -- openclaw doctor --non-interactive --fix`
  and retry safe boot mutations.
- Watchdog auto-repair runs
  `alphaclaw openclaw-doctor-guard -- openclaw doctor --non-interactive --fix`,
  validates `gateway.mode`, then runs the AlphaClaw managed plugin reconciler
  before relaunching the gateway.
- If doctor leaves the config unreadable or missing `gateway.mode`, AlphaClaw
  refuses further config mutation and leaves repair failed for manual action.

Why:

- OpenClaw has strong typed/audited config repair through `doctor`, and older
  fallback-based repair paths can undermine that by clobbering a damaged config
  into a small partial stub.
- The watchdog still needs to enforce AlphaClaw's release manifest for managed
  plugin versions because AlphaClaw pins OpenClaw and tests plugins against
  that pinned version. `openclaw doctor --fix` can repair plugin presence, but
  it should not be assumed to install the exact Starfoundry-pinned plugin set.
- Running plugin reconciliation only after doctor keeps AlphaClaw out of
  low-level config reconstruction while preserving the AlphaClaw-specific
  compatibility contract.

## Device pairing polling cadence

Area: General tab / device pairing polling and device CLI calls

Behavior:

- The General tab device-pairing polling interval is `15s` (the original
  project used `5s`), matching the `openclaw devices list --json` timeout
  budget.
- When AlphaClaw has a managed gateway token, device list/reject CLI calls run
  against the local loopback gateway URL with that token.
- Device approval uses the direct OpenClaw helper, including the admin caller
  scopes introduced in the original project's `v0.9.15`.

Why:

- AlphaClaw allows `openclaw devices list --json` to run for up to `15s`, so
  polling the same endpoint every `5s` can create overlapping work on slow or
  overloaded hosts.
- Managed deployments can require the local gateway URL/token to make device
  list/reject commands resolve the same gateway AlphaClaw is supervising.
- The change is intentionally narrow: polling behavior is otherwise unchanged;
  only the interval was made consistent with the shipped timeout.
- No `/api/devices` dedupe/backoff change and no global `clawCmd` divergence
  was adopted.

## Channel pairing polling gating

Area: General tab / channel pairing polling

Behavior:

- The General tab keeps its initial `/api/pairings` fetches on tab load,
  restart, and pairing actions.
- The recurring `/api/pairings` polling interval only runs when there are
  actual pending pairing requests to watch.

Why:

- Imported or preconfigured hosts can leave channels in a long-lived
  `"configured"` state without any real pending pairing requests.
- The original General-tab logic treated that as a reason to poll
  `/api/pairings` every `3s`, and each poll shells out to
  `openclaw pairing list --channel ...` for enabled channels.
- On loaded VPS hosts, that creates sustained CPU pressure without helping the
  user when there is nothing to approve.
