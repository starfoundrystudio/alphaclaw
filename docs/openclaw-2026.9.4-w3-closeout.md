# OpenClaw 2026.9.4 upgrade — W3 closeout

Date: 2026-09-18

## Outcome

AlphaClaw now owns the OpenClaw Gateway lifecycle as an external supervisor and keeps normal OpenClaw runtime/CLI execution read-only. Explicit AlphaClaw maintenance paths temporarily remove the read-only guard while retaining external-supervisor and update-refusal policy.

This work is limited to the AlphaClaw application and upgrade path. It does not perform or coordinate a fleet rollout.

## OpenClaw contracts verified

The implementation was checked against the pinned OpenClaw 2026.9.4 package and the corresponding local source checkout, including:

- `src/infra/restart-handoff-contract.ts` and `src/cli/gateway-cli/register-restart-handoff.ts` for the `openclaw.gateway.restart-handoff` version 1 machine contract.
- `src/cli/gateway-cli/run-loop.ts` and `src/infra/restart-handoff.ts` for external-supervisor restart behavior and handoff persistence/consumption.
- Gateway startup/readiness handlers for `/startupz` and `/readyz`.
- OpenClaw configuration write guards for `OPENCLAW_CONFIG_READONLY=1`.
- Supervisor/update controls for `OPENCLAW_SUPERVISOR_MODE`, `OPENCLAW_SERVICE_REPAIR_POLICY`, `OPENCLAW_NO_AUTO_UPDATE`, and `OPENCLAW_DISABLE_UPDATE_CHECK`.
- OpenClaw's configuration-refusal exit code `78` (`EX_CONFIG`).

## Managed runtime policy

All normal Gateway and OpenClaw CLI environments now receive:

- `OPENCLAW_NO_RESPAWN=1`
- `OPENCLAW_SUPERVISOR_MODE=external`
- `OPENCLAW_SERVICE_REPAIR_POLICY=external`
- `OPENCLAW_CONFIG_READONLY=1`
- `OPENCLAW_DISABLE_UPDATE_CHECK=1`
- `OPENCLAW_NO_AUTO_UPDATE=1`

AlphaClaw's explicitly owned mutation flows—guarded Doctor repair, onboarding, provider/model selection, channel configuration, node configuration, and managed plugin reconciliation—use a maintenance environment that removes only `OPENCLAW_CONFIG_READONLY`. The supervisor and update-refusal controls remain active.

Fresh onboarding writes `commands.restart=false` and `update.checkOnStart=false`. The new `2026-09-enforce-managed-gateway-ownership-defaults` AlphaClaw migration applies those same defaults to existing AlphaClaw-managed installations. It is gated by the AlphaClaw onboarding marker, so it does not revive the discontinued standalone-OpenClaw import path.

## Lifecycle behavior

- AlphaClaw consumes a successful Gateway restart handoff with `openclaw gateway restart-handoff consume --expected-pid <pid> --json`, validates the protocol/version/status, classifies the exit as controller-owned, and relaunches without invoking Doctor.
- Readiness checks `/startupz` before `/readyz`. A process-correlated ready log remains a bounded fallback when the HTTP probe is unavailable or unsupported.
- Managed stops send `SIGTERM`, allow up to 30 seconds for drain, and then send `SIGKILL` if the child has not exited.
- Exit code 78 is classified as a terminal startup-configuration refusal rather than a crash loop, so the watchdog does not repeatedly run Doctor or restart an invalid configuration.
- AlphaClaw no longer delegates managed restarts/stops to OpenClaw's service lifecycle commands; it acts only on the child process it owns.

## Model catalog bootstrap

The bootstrap generator now runs OpenClaw discovery under the managed runtime policy and removes the read-only guard only for its temporary plugin-install maintenance step. Regeneration completed successfully and refreshed `lib/server/model-catalog-bootstrap.json` to 1,384 models across three access modes. This remains a packaged fallback; runtime catalog refresh remains the primary path established in W2.

## Verification

- `npm run generate:model-catalog-bootstrap` — passed; 1,384 models across three access modes.
- `npm test -- --reporter=dot` — 158 test files passed, 1,443 tests passed.
- JavaScript syntax checks for the CLI, Gateway, watchdog, migration, and generator entry points — passed.
- `git diff --check` — passed.

Coverage added or updated for managed versus maintenance environments, channel/node mutation callers, restart-handoff consumption and relaunch, startup/readiness ordering, drain timeout escalation, exit-78 watchdog behavior, onboarding defaults, and existing-instance migration.

## Follow-up

W4 should proceed with the next compatibility slice in the approved upgrade project. Live host/fleet deployment and validation remain out of scope until the later rollout checkpoints.
