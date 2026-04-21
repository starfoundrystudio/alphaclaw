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

### Watchdog startup and repair timeouts

- Status: pending local change
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

- Status: pending local change
- Area: General tab / device pairing polling

Decision:

- Increase the General tab device-pairing polling interval from `5s` to `15s`
  so it matches the current `openclaw devices list --json` timeout budget.

Why:

- Our fork currently allows `openclaw devices list --json` to run for up to
  `15s`, so polling the same endpoint every `5s` can create overlapping work on
  slow or overloaded hosts.
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

- Status: pending local change
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
