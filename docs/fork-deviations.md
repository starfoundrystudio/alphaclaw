# Fork Deviations Audit

This document tracks intentional ways the Starfoundry fork differs from
upstream `chrysb/alphaclaw`.

Goals:

- Make every fork-only behavior easy to find later.
- Record why the deviation exists and what problem it solves.
- Re-evaluate deviations during each upstream sync so we do not carry fork-only
  logic longer than necessary.

When adding or keeping a deviation from upstream, update this file in the same
change whenever practical.

## Active Deviations

### Import-managed runtime token handling

- Status: active
- Last reviewed: upstream sync to `v0.9.15`
- Introduced in: `102685e` (`Fix import-managed runtime token handling`)
- Area: onboarding / import

Decision:

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

Re-evaluate when:

- Upstream adds equivalent import-time handling for managed runtime tokens, or
- upstream introduces a clearer first-class token rotation/preservation policy
  during import.

### Managed OpenClaw config hardening defaults

- Status: active
- Last reviewed: upstream sync to `v0.9.15`
- Area: onboarding / generated OpenClaw config

Decision:

- Keep Starfoundry's managed config defaults during fresh onboarding and
  managed import, including active-memory defaults, heartbeat model defaults,
  update checks disabled by default, and managed mDNS discovery mode handling.
- Keep upstream `usage-tracker` hook policy additions from `v0.9.15`.

Why:

- Starfoundry deployments expect these defaults to keep managed hosts quiet,
  consistent, and pre-wired for the runtime profile AlphaClaw ships.
- Upstream `v0.9.15` does not yet include the same managed active-memory,
  heartbeat, update-check, or mDNS defaults.

Re-evaluate when:

- Upstream adopts equivalent managed config defaults, or
- Starfoundry changes the desired managed runtime profile.

### Watchdog startup and repair timeouts

- Status: active
- Last reviewed: upstream sync to `v0.9.15`
- Area: watchdog / gateway lifecycle

Decision:

- Increase watchdog startup grace and health probe timeout defaults and make
  them configurable.
- Keep watchdog repair commands on a longer timeout.

Why:

- Imported or overloaded hosts can take materially longer than the original
  watchdog defaults to bring the gateway fully healthy.
- Short startup grace and short probe timeouts make AlphaClaw too eager to mark
  the gateway degraded on slow starts.
- Repair commands can legitimately take longer than the generic 15s CLI
  timeout.

Current local behavior under evaluation:

- `WATCHDOG_STARTUP_GRACE_MS` default `60s`
- `WATCHDOG_HEALTH_TIMEOUT_MS` default `10s`
- `WATCHDOG_REPAIR_TIMEOUT_MS` default `10m`

Re-evaluate when:

- Upstream introduces equivalent watchdog tuning, or
- we confirm a better upstream-compatible approach for slow-start gateways.

### Device pairing polling cadence

- Status: active
- Last reviewed: upstream sync to `v0.9.15`
- Area: General tab / device pairing polling and device CLI calls

Decision:

- Increase the General tab device-pairing polling interval from `5s` to `15s`
  so it matches the current `openclaw devices list --json` timeout budget.
- When AlphaClaw has a managed gateway token, run device list/reject CLI calls
  against the local loopback gateway URL with that token.
- Use upstream's direct OpenClaw helper for device approval, including the
  admin caller scopes introduced in upstream `v0.9.15`.

Why:

- Our fork currently allows `openclaw devices list --json` to run for up to
  `15s`, so polling the same endpoint every `5s` can create overlapping work on
  slow or overloaded hosts.
- Managed deployments can require the local gateway URL/token to make device
  list/reject commands resolve the same gateway AlphaClaw is supervising.
- This change is intentionally narrow: keep upstream polling behavior, but make
  the interval consistent with the timeout we already ship.
- No `/api/devices` dedupe/backoff change and no global `clawCmd` divergence
  has been accepted.

Re-evaluate when:

- Upstream adjusts the General tab polling cadence or device pairing timeout in
  a compatible way, or
- we revert our longer `devices list` timeout and no longer need the matching
  interval change.

### Channel pairing polling gating

- Status: active
- Last reviewed: upstream sync to `v0.9.15`
- Area: General tab / channel pairing polling

Decision:

- Keep the General tab's initial `/api/pairings` fetches on tab load, restart,
  and pairing actions.
- Only keep the recurring `/api/pairings` polling interval running when there
  are actual pending pairing requests to watch.

Why:

- Imported or preconfigured hosts can leave channels in a long-lived
  `"configured"` state without any real pending pairing requests.
- Upstream General-tab logic treats that as a reason to poll `/api/pairings`
  every `3s`, and each poll shells out to `openclaw pairing list --channel ...`
  for enabled channels.
- On loaded VPS hosts, that creates sustained CPU pressure without helping the
  user when there is nothing to approve.

Re-evaluate when:

- Upstream narrows General-tab `/api/pairings` polling similarly, or
- channel status becomes a reliable signal for "there is an actionable pending
  pairing request right now."

## Retired Deviations

### Full-root import target cleanup workaround

- Status: retired after upstream sync to `v0.9.9`
- Prior area: onboarding / import target directory handling

Why it existed:

- Earlier upstream versions created managed runtime state before onboarding
  finished, which collided with full-root imports and caused "Import target
  directory already exists and is not empty".

Why retired:

- Upstream `v0.9.9` adopted a compatible fix path, so we intentionally dropped
  the older fork-only workaround during the sync.
