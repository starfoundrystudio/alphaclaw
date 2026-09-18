# OpenClaw 2026.9.4 upgrade — W5a closeout

## Outcome

AlphaClaw now has a versioned managed-capability contract for the OpenClaw 2026.9.4 integration. Clawbridge is the supported TeamYou-managed interface. The upstream OpenClaw Control UI is optional advanced access, is not required for managed workflows, and is presented as `Advanced — unmanaged changes`.

Contract reference: `teamyou.managed-capabilities/v1@2026-09-18.1`

## Canonical contract and consumers

`lib/managed-capability-contract.json` is the canonical machine-readable definition. It records:

- the supported managed surface (`clawbridge`);
- the optional advanced surface (`openclaw-control-ui`);
- the managed configuration mode and customer-workflow boundary;
- the runtime-agent policy for tools, CLI, manual actions, and unsupported workflows; and
- the managed OpenClaw defaults introduced during W4.

The contract now drives or is consumed by:

- managed default reconciliation for fresh and upgraded hosts;
- the deployed runtime `AGENTS.md` and `TOOLS.md` bootstrap prompts;
- Clawbridge advanced-access labels and explanatory copy; and
- server and browser tests that keep those representations aligned.

## Agent and user-experience boundary

The deployed agent is instructed to use its tools and CLI first, direct genuinely manual steps to Clawbridge, and never require or recommend the OpenClaw Control UI. If a managed workflow is unavailable, it must explain the limitation and ask how the user wants to proceed instead of bypassing the boundary through raw configuration or Control UI instructions.

Clawbridge no longer presents the Control UI as a daily dashboard or primary launcher. Every Clawbridge launch now opens an advanced-access review modal, including for already-paired browsers, and the General page identifies Clawbridge as TeamYou's supported managed interface.

## Delivery to existing managed hosts

- Managed defaults continue to be applied through the W4 migration and normal managed reconciliation paths, but now originate from the canonical contract.
- Bootstrap prompt files are rendered and synchronized during normal AlphaClaw server startup as well as onboarding, so upgraded managed hosts receive the new agent guidance without a standalone-import migration.
- The Clawbridge copy and launcher behavior ship in the normal AlphaClaw package/UI upgrade.

This preserves `OPENCLAW_CONFIG_READONLY=1`; the optional advanced interface does not become a supported configuration surface.

## Deliberate W5b boundary

The W5a modal establishes expectations but is not the security boundary. W5b still owns the signed per-session acknowledgement, complete HTTP/WebSocket/deep-link gate, bypass prevention, persistent in-Control-UI advanced label, and audit coverage. Until W5b lands, a user who knows a direct `/openclaw` URL can bypass the Clawbridge review modal.

## Verification

- `npm run build:ui`
- Contract/default/prompt/frontend focused tests: 23 passed
- Full suite: 161 files and 1,452 tests passed.
- Browser verification in the built-in in-app browser against the UI sandbox confirmed the General page, sidebar action, warning copy, and advanced-access modal.
- `git diff --check`
