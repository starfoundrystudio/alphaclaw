# OpenClaw 2026.9.4 W2 closeout

Date: 2026-09-17  
Branch: `codex/openclaw-2026.9.4-upgrade`

## Outcome

W2 makes AlphaClaw use OpenClaw 2026.9.4's public Gateway, CLI, plugin-SDK,
and guarded config contracts. OpenClaw owns its SQLite migrations; AlphaClaw
no longer reads or repairs the retired device, pairing, session, or exec
approval JSON stores.

## Implemented contracts

- The Gateway-published model catalog is authoritative after a successful
  read, including an empty inventory. The bundled catalog is used only while
  the Gateway catalog is unavailable and contributes policy annotations only
  to matching live rows.
- Passive model reads use the published catalog. An explicit Clawbridge
  refresh requests provider discovery with `models list --all --refresh
  --json`; hosted metadata refresh remains a separate operation and reports
  when a managed Gateway restart is required.
- Catalog cache schema v2 records source, age, agent id, provider outcomes,
  refresh warnings, and the last compatible inventory. A prior cache is
  invalidated automatically during normal managed boot/reconcile, so no
  standalone migration command is required.
- Thinking options use OpenClaw's 9.4 helpers with the effective agent
  runtime, including `ultra` for supported OpenClaw-runtime models. Pricing is
  read from the 9.4 extension manifests instead of stale bundle scraping.
- Canonical OpenAI model references remain `openai/*`; legacy
  `openai-codex/*` input is accepted only as an upgrade compatibility alias
  and is normalized before persistence. `agents.defaults.models` remains
  model-scoped runtime configuration and is not treated as catalog policy;
  AlphaClaw does not create a `modelPolicy.allow` restriction.
- Managed plugin installs and updates consent per operation with
  `--accept-capabilities`. Boot now verifies every OpenClaw plugin-SDK subpath
  AlphaClaw imports, including `secret-ref-runtime`, `device-bootstrap`,
  `secret-input`, and `cron-store-runtime`.
- Exec approval reads and mutations use `openclaw approvals ... --json`, not
  `exec-approvals.json`. Device and channel pairing operations use the 9.4
  device SDK and pairing CLI. AlphaClaw's managed-device fabrication and
  7.1-era Codex/session sidecar repair were removed.
- OpenClaw config mutations touched by W2 use the shared guarded writer.
  Managed channel credential positions are swept every reconcile tick:
  plaintext and `store` refs are quarantined, matching root-level
  `openclaw.json.bak*` copies are removed, and a TeamYou Agent Vault migration
  proposal plus warning is retained until the required slots are ready.
  Doctor-owned migration originals outside that root backup pattern are not
  touched.
- The managed bootstrap ritual injects a stable TeamYou channel-setup step
  into the 9.4 Birth Sequence without depending on the removed
  `Connect (Optional)` heading.
- Cron bulk analytics use the 9.4 all-runs RPC rather than one control-plane
  request per job. Clawbridge displays `cron.skipMissedJobs` as either
  `Skip` or `Catch up`. Active device polling is three seconds, below the
  30-per-minute per-method ceiling.
- The bundled usage-tracker and Agent Vault hook payloads are covered against
  the 9.4 hook shapes. Parsed plugin, update-status, model, channel, pairing,
  and approval JSON contracts have focused tests.

## Existing-instance delivery

- Doctor owns the one-time 7.1-to-9.4 state migrations. The guarded upgrade
  fixture runs the pinned 9.4 `doctor --lint --all --severity-min error
  --json` over a production-shaped 7.1 roster/shared-auth configuration.
- AlphaClaw's existing periodic startup/reconcile path delivers cache-schema
  invalidation, plugin reconciliation, guarded config rewrites, channel-token
  quarantine, and policy repair to upgraded instances as well as fresh ones.
- The discontinued standalone-to-managed import path is not used or restored.

## Verification

- `npm run build:ui`
- `npm test`: 158 files and 1,432 tests passed.
- Rendered dashboard verification in the UI sandbox: Models displayed the
  explicit refresh control and treated a successful empty refresh as empty;
  Cron displayed the missed-recurring-run policy; no error overlay or blank
  view was observed.
- The guarded 7.1 upgrade fixture passed the pinned 9.4 Doctor lint check.

## G2 live-instance checks retained

Code-contract completion does not replace the disposable-instance gates in
the approved plan. T1 verifies the actual SQLite migration ledger; T2 verifies
vault host routing and live channel traffic; T5 verifies the token sweep
against Control UI writes; T7 verifies bootstrap, skill availability, and CLI
runtime continuity; T10 proves backup/restore crossing; and T11 exercises both
model-catalog refresh lifecycles against a running Gateway. These checks are
required before production promotion, not prerequisites for starting W3.
