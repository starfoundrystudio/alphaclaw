# OpenClaw 2026.9.5 — G3 fresh-provision runbook

Status: started 2026-09-20 (Bill's go). Gate G3 of project `TAoHXFTAly7M`:
the first managed Clawbridge instance provisioned **fresh** on the 2026.9.x
line. Scope per Bill (2026-09-20): this project is about provisioning new
instances on the latest OpenClaw; upgrading the existing fleet is a separate
project (`rs8GE45wtye2`) and is not exercised here.

## What G3 proves that G2 did not

Every 2026.9.x instance so far started life on 2026.7.1 and was upgraded in
place. G3 provisions on the `beta` channel, so the host runs the 2026.9.5
AlphaClaw from first boot and the onboarding wizard writes 9.x config from
scratch. The impact-matrix rows that were "implemented, not live-verified"
because of that (H1 `--secret-input-mode ref` auth branch, H4 injected
Birth Sequence step, bundled-plugin discovery on a fresh state dir, SearXNG
as the default web-search provider, plugin reconciliation "already
installed" detection on 2026.9.5) close here.

## Release

- AlphaClaw `0.9.18-starfoundry.23-beta.1` — `npm publish --tag beta` from
  branch `codex/openclaw-2026.9.4-upgrade` (pinned `openclaw@2026.9.5`).
  See §"Release log" below for the outcome.
- clawctl host-asset bundle `f62fa09f` on the TeamYou **Preview beta** pin
  (Node 26 provisioning, gated 2026.9 host-script fixes, backup lock-file
  fix, `KillMode=mixed` units). Preview redeployed at `232b7343` so the pin
  is live for admin provisions that pick channel `beta`.
- Stable pins untouched: `latest` stays `0.9.18-starfoundry.22`
  (2026.7.1) and the stable bundle stays `4c6e717d`. Production provisions
  are unaffected until Checkpoint G3 promotes both.

## Provision (admin panel on the G2 preview)

`https://teamyou-git-preview-openclaw-202694-g2-star-foundry-studio.vercel.app/admin/openclaw-provisioning`

| Field | Value |
| --- | --- |
| Owner Clerk user id | `user_2upQQHI8N2knceXnPNmLFf1LMdi` (production id; the preview's session claim) |
| Instance name | `test-g3-oc95-01` |
| Customer label | `G3 fresh 2026.9.5 provision` |
| Setup password | Bill types it (same as the G2 instances so the agent can log in) |
| Restore from | empty |
| Preferred provider | DigitalOcean, no cross-provider fallback |
| Topology | Gateway + workload |
| AlphaClaw channel | **beta** |

Hazard (unchanged from G2): the preview database is a production fork, so
the panel lists real instances. Never touch their Destroy buttons.

## Checks on the fresh instance

Order matters: the first four run before onboarding, the rest after Bill
completes the wizard (vault, one channel, a model).

1. **Host bootstrap:** run reaches `awaiting_user_setup`; workload has
   AlphaClaw `0.9.18-starfoundry.23-beta.1` and `openclaw` `2026.9.5`; Node
   26; `alphaclaw.service` carries `KillMode=mixed` and `TimeoutStopSec=90`;
   `/usr/local/lib/alphaclaw/teamyou-install.sh` is the gated version
   (bundle `f62fa09f`); first restic state snapshot recorded by
   `configure_backups` with the fixed export (no `*.lock.sqlite`).
2. **Pre-onboarding server:** Express up, "No config yet" path, setup URL
   serves the wizard on the public bootstrap hostname.
3. **Wizard (Bill):** Agent Vault enrolment on the tailnet, one channel,
   one model. Note which model route: to close H1 the route must be an
   API-key or gateway provider (Vercel AI Gateway is fine).
4. **Onboarding writes 9.x config:** `openclaw.json` has no retired keys
   (`agents.defaults.memorySearch`, `plugins.bundledDiscovery`), `memory.search`
   present where expected, `tools.web.search.provider = searxng`, canonical
   `openai/*` if OpenAI was chosen; `openclaw doctor --lint --all --json`
   clean of retired-key findings; the injected Birth Sequence step ran (H4).
5. **Plugin discovery and reconciliation:** bundled plugins discovered from
   the fresh state dir; managed plugins installed once at 2026.9.5 and
   reported "already installed" on the next restart; SearXNG service up and
   answering on 127.0.0.1:8888.
6. **Gateway:** ready under external supervision, `OPENCLAW_CONFIG_READONLY=1`
   honoured (Control UI write refused), handoff restart from Clawbridge,
   `systemctl stop alphaclaw` completes within the deadline with no orphan
   `openclaw-gateway` (finding #3 re-test on 2026.9.5's restart rules).
7. **Clawbridge:** login, `/api/models` (bootstrap → cache → openclaw
   refresh lifecycle, `source: openclaw` after refresh), Add Model dialog
   populated, no GPT-5.5 anywhere, advanced Control UI gate (interstitial,
   audit, amber label, bootstrap hand-off with no pairing screen).
8. **Channel round trip** (Bill sends a message) and a three-turn recall.
9. **Backups:** a manual state-tier run from the gateway succeeds on the
   fresh 2026.9.5 state dir (2 sqlite snapshots); host and gateway tiers on
   their timers.
10. **Plugin SDK deprecation warnings** in the Gateway log from our plugins
    (usage-tracker, agent-vault, TeamYou memory) — record, do not fix here.

## Exit criteria for Checkpoint G3

All ten checks pass or have an accepted limit; then promote the AlphaClaw
`latest` tag and the clawctl stable bundle so every new provision gets
2026.9.5. Fleet-upgrade items stay with `rs8GE45wtye2`.

## Release log

- 2026-09-20: `0.9.18-starfoundry.23-beta.1` published to GitHub Packages
  on the `beta` tag from commit `26cc6f3` (branch
  `codex/openclaw-2026.9.4-upgrade`): bump → compatibility manifest (97
  plugins) → bundled catalog (165 bundled-catalog rows, 24 providers) →
  `build:ui` → full vitest exit 0 → commit → `npm publish --tag beta` → push.
  Registry confirms `dependencies.openclaw = 2026.9.5`. `latest` unchanged
  (`0.9.18-starfoundry.22`).
- TeamYou preview redeployed at `232b7343` for the `f62fa09f` beta bundle pin.

## Provision log

- 2026-09-21 05:14 UTC (Bill's submit): instance `test-g3-oc95-01`
  (`inst_b4a158c2fc824c40a23dfbd4bf99147b`), run
  `wrun_01M31672DJBPG3VJD2TK8N2HAF`, channel `beta`, gateway topology,
  DigitalOcean. Setup password held in the session scratchpad only. Form
  values verified against React state before submit (channel `beta`).
  05:2x: phase `private_network_ready`.
- 05:2x–05:32: run `awaiting_user_setup`; bootstrap URL
  `https://xaz2fsbdrug9.openclaw.teamyou.ai`; `/api/status` reports
  AlphaClaw `0.9.18-starfoundry.23-beta.1` / OpenClaw `2026.9.5 (ec9c1a1)`,
  config absent (check 1 partially, check 2 PASS). Bill: the wizard's
  default model list is the hand-pinned "recommended" set (Opus 4.8, Sonnet
  4.6, GPT-5.6 Sol); Fable 5.1 and Opus 5 are present under "See all model
  options" (verified against the instance's catalog: 251 Vercel rows). Bill
  approved new recommendations: Opus 5, then Fable 5.1, then Sonnet 4.6 on
  Anthropic-capable routes; GPT-5.6 Sol stays on OpenAI routes.
- **05:32:53 — G3 finding #11 (S0 for fresh provisions): onboarding fails
  on every fresh 2026.9.5 host.** Wizard step 3: "Onboarding command
  failed. Please verify credentials and try again." Instance log
  (`/api/watchdog/logs`): `openclaw onboard … --gateway-auth token
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN …` → `Environment variable
  "OPENCLAW_GATEWAY_TOKEN" is missing or empty. Export it first, then rerun
  openclaw onboard` (phase `options`). Cause: the W1 rewrite (`ef2aedf`)
  replaced 2026.7.1's `--gateway-token <value>` with the 2026.9 SecretRef
  flag, but nothing ever mints the token — 2026.7.1 generated a literal one
  itself when the value was empty, so no fresh host has ever had
  `OPENCLAW_GATEWAY_TOKEN` in its env file, and every G2 instance inherited
  its token from a 7.1 onboarding. This is exactly the H1 row G3 exists to
  close. **Fix:** `ensureGatewayTokenEnvVar` in
  `lib/server/onboarding/index.js` mints a 32-byte hex token into the env
  file before the env write and reload, so the onboard child and every
  later Gateway launch resolve the reference; unit + route tests. The
  running instance cannot be patched (no tailnet until onboarding
  finalises) and managed hosts do not self-update, so G3 continues on a
  beta.2 and a re-provision.
- Fix commits on the branch: `829f54a` (finding #11, token minted before
  onboard) and `d3bfc0b` (recommendations: Opus 5 → Fable 5.1 → Sonnet, in
  spec order via `recommendationRank`; Anthropic direct uses Sonnet 5
  because 2026.9.5's Anthropic catalog has no Sonnet 4.6). Both need a
  `beta.2` and a re-provision; `test-g3-oc95-01` stays stuck at wizard
  step 3 and is to be destroyed.
