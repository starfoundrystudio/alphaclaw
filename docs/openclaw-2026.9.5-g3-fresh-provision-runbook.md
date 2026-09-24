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
6. **Gateway:** ready under external supervision, handoff restart from Clawbridge,
   config writable (read-only guard removed in beta.5, decision 2026-09-21:
   a plugin install from the Control UI Plugins page and a channel/provider
   add from Clawbridge after onboarding both succeed),
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
- 2026-09-21: `0.9.18-starfoundry.23-beta.2` published on the `beta` tag
  from `5c8d1ab` (finding #11 fix + recommendations), same gated chain,
  full vitest exit 0. `latest` unchanged.
- 2026-09-21: `0.9.18-starfoundry.23-beta.3` published on the `beta` tag
  from `0d9314d`: SearXNG enabled and named as the fallback web-search
  provider (`4412ae0`), skipped whenever another web-search provider
  plugin is enabled or credentialed (`4b7b429`, Bill's design intent:
  SearXNG must never displace a better option; Codex-native search is a
  separate switch and unaffected). Full vitest 167 files / 1,495 tests.
  clawctl bundle `f7f510f1` (memory.search local default) already pinned
  on Preview beta. Third provision `test-g3-oc95-03` prepared to prove
  findings #12/#13 fixed from first boot.
- 2026-09-21: `0.9.18-starfoundry.23-beta.4` published on the `beta` tag
  from `8efa0a1` (double-greeting fix `6f68fd2`), same gated chain, full
  vitest 167 files / 1,496 tests. This is the build the third provision
  installs.

- **beta.5 (2026-09-21):** `0.9.18-starfoundry.23-beta.5` published to the
  `beta` tag (release commit `ae6e702`; `latest` stays `…22`). Contents:
  read-only config guard removed (Bill's decision, see
  `docs/openclaw-2026.9.5-secret-write-paths.md`), chat `replace` events
  (#16), TeamYou memory plugin installed from the startup reconcile (#17),
  reconcile retry with the Gateway stopped, model catalog refresh (13
  added, 8 retired; no GPT-5.5; recommendations unchanged). Full vitest
  168 files / 1509 tests green before publish. Needs the clawctl bundle
  from `31cbcad` (archive staging, `memory.search` provider `none`) for a
  fresh provision to exercise #17 and FTS-only memory; the preview's beta
  bundle pin still points at `f7f510f1`.

- **Bundle `37c70d18` (2026-09-21):** clawctl host-asset bundle published
  from `31cbcad` (provenance clean; sha256 verified after download; install
  helper byte-identical to the commit), recorded in clawctl `5c59c97`, and
  pinned on TeamYou **Preview beta** only (`OPENCLAW_HOST_ASSET_BUNDLE_URL_BETA`
  / `_SHA256_BETA`; stable unchanged). Preview redeployed at `83e103bc`.
  Contents vs `f7f510f1`: TeamYou memory plugin archive staged at bootstrap
  and handed to Clawbridge (#17), `memory.search` provider `none` on 2026.9,
  no `llama-cpp` allow/install or model pre-fetch on 2026.9, no `--pin`,
  always `--force` for the archive. Fresh provision on channel `beta` now
  gets beta.5 plus this bundle.

- **beta.6 (2026-09-21):** `0.9.18-starfoundry.23-beta.6` published to the
  `beta` tag (release commit `6985632`; `latest` stays `…22`): the
  OpenClaw 2026.9.5 compatibility batch (`8f9046d`, see
  `docs/openclaw-2026.9.5-plugin-cli-compat-audit.md`). Full vitest 170 files
  / 1,523 tests before publish; model catalog unchanged from beta.5.
  Installed on `test-g3-oc95-04` with `npm install
  @starfoundrystudio/alphaclaw@0.9.18-starfoundry.23-beta.6 --omit=dev` as the
  app user and `systemctl restart alphaclaw`: startup reconcile all
  "already installed", Gateway listening in 21.6 s, `plugins.deny` now `[]`
  (was 26 ids), `openclaw config validate` stderr 0 B. The legacy
  `agents.entries.main.default` marker stays until OpenClaw's next config
  write strips it; Clawbridge no longer re-adds it.

- **beta.7 (2026-09-22):** `0.9.18-starfoundry.23-beta.7` published to the
  `beta` tag (release commit `3de437e`; `latest` stays `…22`): the Slack
  Socket Mode proxy hotfix for `@openclaw/slack` 2026.9.5 (#22; `4b4c442`,
  corrected in `9363d28`), applied by the plugin reconcile to that exact
  version only. Full vitest 171 files / 1,526 tests before publish. Bill
  confirmed a Control UI plugin install on `test-g3-oc95-04` before the
  release. Not yet installed on any host; host 04 still runs beta.6 with the
  hand-patched Slack provider.

- **Bundle `8dcfb758` + beta.8 (2026-09-22):** the G3 finding #23 pair.
  clawctl bundle published from `299867a` (provenance clean, sha verified
  after download, install helper byte-identical to the commit), recorded in
  clawctl `b5aa81e`, pinned on TeamYou **Preview beta** only
  (`OPENCLAW_HOST_ASSET_BUNDLE_URL_BETA` / `_SHA256_BETA`; stable unchanged),
  Preview redeployed at `c36c762e` (Vercel success). alphaclaw
  `0.9.18-starfoundry.23-beta.8` published to the `beta` tag (release commit
  `f5485e7`; `latest` stays `…22`), full vitest 171 files / 1,530 tests
  before publish. A fresh provision on channel `beta` now gets beta.8 plus
  this bundle; no host has been upgraded.

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
- **2026-09-21 (beta.2): `test-g3-oc95-02` provisioned by Bill on channel
  `beta`; onboarding completed (Vercel AI Gateway, Opus 5 preselected and
  chosen, no channel yet); tailnet up ~06:33 UTC.** Checks:
  1. Host: PASS — AlphaClaw `0.9.18-starfoundry.23-beta.2`, OpenClaw
     2026.9.5, Node 26.9.0, `KillMode=mixed` + `TimeoutStopSec=90`
     (the Gateway logs "shutdown budget … source=systemd … 90000ms"),
     gated `teamyou-install.sh`, fixed backup export, first state snapshot.
  2. Pre-onboarding server: PASS. 3. Wizard: done by Bill.
  4. Config: PASS with two findings — no retired keys; `gateway.auth.token`
     is the env SecretRef and `.env` carries the minted
     `OPENCLAW_GATEWAY_TOKEN` (**finding #11 fix verified live**);
     `tools.web.search` had `enabled` but no provider and the SearXNG
     plugin was installed but **disabled** (finding #12); `memory.search`
     absent so Doctor assumed provider `openai` with no key (finding #13).
     H4 (Birth Sequence) not yet exercised: `BOOTSTRAP.md` present, 0
     sessions — waits for Bill's first chat.
  5. Plugins: PASS — reconciled at 2026.9.5, "already installed" on the
     next start, SearXNG service answering JSON on 127.0.0.1:8888.
  6. Gateway: PASS — external supervision env present; `systemctl stop`
     took 1 s with active-work drain and **no orphan** (finding #3 does not
     reproduce on 2026.9.5's shutdown path); Clawbridge handoff restart
     34 s to `ready`, one Gateway process after. Also observed live: a
     config-validation failure (my `memory.search.local.contextSize` shape
     test) → launcher exit 78 → Doctor-first relaunch, during which the
     finding #10 reconciliation retry ran ("retry 1/5 failed … retry 2/5
     succeeded").
  7. Clawbridge API: PASS — login; `/api/models` bootstrap (1,447 models,
     refreshing) → explicit refresh `source: openclaw` (250 models,
     `restartRequired: false`); zero GPT-5.5; primary Opus 5. Control UI
     gate and Add Model dialog not re-checked in the pane (verified on
     9.4 at G2; API surfaces identical).
  8. Channel round trip: pending Bill (no channel configured yet).
  9. Backups: PASS — manual state run from `test-g3-oc95-02-gateway`
     → snapshot `e4153435…`, 2 sqlite snapshots.
  10. Plugin SDK deprecation warnings: none.
- **G3 finding #12 (S1 for fresh provisions): web search has no provider.**
  2026.9 retired the bundledDiscovery mode that surfaced the SearXNG
  plugin, and OpenClaw's `web_search` auto-detection only considers
  providers with a credential (SearXNG has none), so a fresh host ends up
  with the plugin disabled and `tools.web.search.provider` unset. Fixed in
  alphaclaw `4412ae0`: the managed fallback enables `plugins.entries.searxng`,
  adds it to an existing allow-list and sets the provider; verified live
  by patching the instance (plugin `enabled`, provider `searxng`, config
  validates).
- **G3 finding #13 (S2): `memory.search` missing on fresh 2026.9 hosts.**
  clawctl's gated writer dropped `agents.defaults.memorySearch` on 2026.9
  without writing its replacement. Fixed in clawctl `4d030f5` (writes
  `memory.search = { provider: "local" }`; `local.contextSize` is not a
  2026.9 key and fails validation, learned live), bundle `f7f510f1`
  pinned on Preview beta, preview redeployed. Doctor now reports "local
  embeddings are not confirmed ready" until first use (the documented
  degrade-to-keyword path).
- **Observations, not blocking:** `plugins.deny` carries 2026.7.1-era
  channel plugin ids that 2026.9.5 no longer knows (`buzz`, `clickclack`,
  … `zalouser`); `openclaw config validate` prints one "stale config entry
  ignored" warning per id — clean the deny writer up post-release.
  OpenClaw's onboard added `vercel-ai-gateway/anthropic/claude-opus-4.6`
  to `agents.defaults.models` as its own default before `models set`
  pinned Opus 5; harmless allowed extra.
- Pending on this instance: Bill's first chat (Birth Sequence, H4), a
  channel + round trip (check 8). Pending decision: `beta.3` with
  `4412ae0` and one more fresh provision on bundle `f7f510f1` to prove
  findings #12/#13 fixed from first boot.
- **G3 finding #14 (S2, fresh first chat): the Birth Sequence greeting was
  sent twice** on `test-g3-oc95-02` (Bill's screenshot: "the setup ping
  came through twice"). Journal: "Bootstrap kickoff sent … 06:34:13" then
  "re-sent … (unanswered; retry 1/3)" at 06:34:14 — `startup.js` chained
  `retryUnansweredKickoff` straight after `maybeRunBootstrapKickoff`, so
  the reply check ran one second after the send. Fixed in alphaclaw
  `6f68fd2`: the boot chain skips the retry when the kickoff it just ran
  reports `kickoff_sent`, and the retry treats a marker younger than a
  five-minute reply grace as not yet unanswered; earlier-boot and
  Claude-login retries unchanged. Needs a beta.4 before the next
  provision; H4 itself (Birth Sequence ran, agent asked for a name) is
  confirmed by the screenshot.
- 2026-09-21 07:48 UTC (Bill's submit): third provision `test-g3-oc95-03`
  (`inst_366ae02d33724ffbada03243c0f45bb6`), run
  `wrun_01M31F0CNBHRQGSVCQXPP3PEBS`, channel `beta` → AlphaClaw beta.4,
  host bundle `f7f510f1`. Purpose: prove findings #11–#14 fixed from first
  boot with no hand-patching.
- **2026-09-21 08:0x UTC: `test-g3-oc95-03` on beta.4 — fresh 2026.9.5
  provision correct from first boot, no hand-patching.** Onboarded by
  Bill (Vercel AI Gateway, Opus 5 preselected); tailnet up ~08:05.
  1. Host: PASS (beta.4 / 2026.9.5 / Node 26.9.0, stop hardening, bundle
     `f7f510f1` scripts). 2. Pre-onboarding server: PASS. 3. Wizard: PASS.
  4. Config as written by onboarding: PASS — `tools.web.search =
     {enabled, provider: "searxng"}`, `plugins.entries.searxng.enabled`,
     `searxng` in `plugins.allow` (**#12 fixed from first boot**);
     `memory.search = {provider: "local"}` (**#13 fixed from first boot**);
     `OPENCLAW_GATEWAY_TOKEN` minted and referenced (**#11**); no retired
     keys; H4 Birth Sequence ran with **one** kickoff ("Bootstrap kickoff
     sent", no re-send; transcript: one greeting, Bill named the agent
     "Ava", one reply — **#14 fixed**).
  5. Plugins: PASS — llama-cpp, searxng, vercel-ai-gateway, active-memory,
     memory-core enabled; reconciliation complete (llama-cpp install
     retried once with `--force` after a partial managed install).
  6. Gateway: PASS — external supervision env, handoff restart via
     Clawbridge 34 s to running.
  7. Clawbridge API: PASS — login, bootstrap catalog 1,447 → refresh
     `source: openclaw` 250 models, zero GPT-5.5.
  8. Channel round trip: pending Bill.
  9. Backups: PASS — state run from `test-g3-oc95-03-gateway` → snapshot
     `2dd8bcea…`, 2 sqlite snapshots; four backup timers active.
  10. Deprecation warnings: none. SearXNG JSON 200. Doctor: 65 checks,
     only the two memory-search warnings below plus the known
     skills/permissions noise.
- **G3 finding #15 (S2, decision): local memory embeddings need the
  managed llama-server on 2026.9.** Gateway log: "semantic memory recall
  is degraded (provider=local). Local embeddings need the managed llama.cpp
  server config (llama-server). The in-process node-llama-cpp runtime was
  removed; semantic memory recall is degraded until setup." 2026.7.1
  embedded node-llama-cpp in-process; 2026.9 wants a configured
  llama-server via the llama-cpp plugin. Until configured, memory search
  degrades to keyword (FTS) search, which is the documented fallback and
  what Doctor's "local embeddings are not confirmed ready" means. Options:
  (a) accept keyword-only local memory for the beta and configure
  llama-server post-release; (b) add the llama-cpp server config to the
  managed defaults now (model download + CPU cost on the s-4vcpu-8gb
  class to be measured). Not blocking for G3.
- Doctor's other memory warning ("Active Memory plugin is disabled") is
  the pre-activation state by design (TeamYou memory activation gate;
  `active-memory.config.enabled` flips on activation).
- **G3 finding #16 (S1, chat UI on 2026.9.5): a streamed reply rendered
  twice, the second copy with its text doubled** (Bill's screenshot on
  `test-g3-oc95-03` after naming the agent). Server transcript and
  `chat.history` hold the reply once. Cause, from the 2026.9.5 runtime
  (`embedded-agent.runtime`): when the streamed text no longer extends the
  previous text — item boundaries such as thinking → text, truncation, a
  cleared stream — OpenClaw sends the FULL visible text as `delta` with
  `replace: true` (and elsewhere a text-only event with an empty delta).
  Clawbridge's relay forwarded it as an append, so the bubble doubled, and
  the history merge then kept the mismatched bubble beside the canonical
  row (its browser timestamp was newer). Scripted single-item replies did
  not reproduce it (every event had `delta === text`); the ritual reply
  with thinking items did. Fixed: relay forwards `replace: true` chunks
  (and treats empty-delta text events as replace); the client overwrites
  on replace; the merge treats streamed assistant bubbles as provisional
  once the snapshot's newest row is the assistant reply. Tests on relay
  and merge. Needs a beta.5.
- **G3 finding #17 (S1, first boot on 2026.9.5): the TeamYou memory plugin
  never installs, and `alphaclaw-post-onboard-reconcile.service` fails every
  five minutes for the life of the host.** On `test-g3-oc95-03` the journal
  shows "Downloading TeamYou memory plugin 0.3.0" on every run and never
  "Installed"; `plugins.entries.openclaw-teamyou-memory` stays a stale entry
  ("plugin not found"), and everything after that step in clawctl's
  `install_teamyou_memory_plugin` (the llama-cpp provider install and the
  embedding-model pre-fetch) never runs. `openclaw plugins install <tgz>`
  through `run_openclaw_as_alphaclaw` trips four 2026.9 gates in sequence:
  (1) `--pin` is rejected for anything but npm registry installs; (2) a
  local archive is cancelled without `--force` (ClawHub trust warning);
  (3) capability consent is mandatory (`--accept-capabilities`); and (4)
  while a Gateway is running the CLI delegates the install to it
  (`plugins.install` RPC, owner taken from the gateway lock) and our Gateway
  runs with `OPENCLAW_CONFIG_READONLY=1`, so it refuses with "Config is
  externally managed … | OPENCLAW_CONFIG_READONLY". No CLI flag forces the
  local path. That is also why alphaclaw's own startup reconcile installs
  managed plugins fine: it runs before the Gateway starts. Verified on 03:
  with `alphaclaw.service` stopped, `openclaw plugins install <tgz> --force
  --accept-capabilities` through the wrapper installs the plugin and the
  next Gateway start discovers it ("plugin disabled (disabled in config)",
  the pre-activation state by design). Fixed so far: alphaclaw's
  `openclaw-runtime` lifts the write guard for config-mutating openclaw
  subcommands (`plugins install|uninstall|enable|disable`, `config
  set|unset`) and accepts `--allow-config-mutation`; clawctl's helper drops
  `--pin` and always passes `--force` (uncommitted). Necessary, not
  sufficient. **Decision (Bill, 2026-09-21): option A.** Implemented:
  on 2026.9 hosts clawctl stages the archive at host bootstrap (before
  `alphaclaw-setup` starts) under `/var/lib/alphaclaw-managed-plugins/` and
  hands its path, version, and URL to Clawbridge through `.env`
  (`ALPHACLAW_TEAMYOU_MEMORY_PLUGIN_ARCHIVE|VERSION|URL`, hidden from the
  Env Vars page). Clawbridge's startup plugin reconcile, which runs after
  the finalize restart and before the Gateway starts, installs it with
  `--force --accept-capabilities` and writes clawctl's marker, so the
  post-onboard reconcile then reports "already installed". clawctl never
  runs the install on 2026.9; it re-stages the archive and config and says
  Clawbridge installs it at its next start. The finding #10 in-process
  retry now stops the Gateway around the reconcile and starts it again,
  because on 2026.9 it too would otherwise be refused. 2026.7 hosts keep
  the old clawctl install path. Fleet note for `rs8GE45wtye2`: a 7.1 host
  upgraded to 9.x gets the staged archive from `reconcile_teamyou_install`
  and Clawbridge installs it on the upgrade's final restart.
  Host 03 state: wrapper and helper patched in place (backups
  `*.orig-beta4`, `teamyou-install.sh.orig-f62fa09f`), plugin installed by
  hand; treat 03 as patched, not as a clean beta.4 host.
- Finding #15 correction: the managed model download Bill remembers is
  clawctl's `prefetch_local_embedding_model` (`npx node-llama-cpp pull`
  into `~/.node-llama-cpp/models`, for the 7.1 in-process runtime). It sits
  after the memory plugin install, so finding #17 kept it from running on
  03, and on 2026.9.5 it is inert anyway: the in-process runtime is retired
  and the llama-cpp plugin serves embeddings from a managed `llama-server`
  (pinned build `b10809` plus EmbeddingGemma, about 0.3 GB, installed under
  OpenClaw's localService supervisor only after explicit consent through
  `openclaw configure` or the plugin's embedding-only setup;
  `memory.search.local.modelPath` accepts a GGUF path or `hf:` URI). No
  non-interactive setup entry point found in the 2026.9.5 dist yet. On 9.x
  hosts the node-llama-cpp pre-fetch is skipped. **Decision (Bill,
  2026-09-21): local embeddings are not offered on 2026.9.** Reason, from
  upstream openclaw/openclaw#123105: the in-process wrapper pinned an old
  llama.cpp build that could not load new model architectures; the
  replacement managed `llama-server` needs interactive consent, and
  openclaw/openclaw#125792 (open) reports it reserving about 5.3 GB for
  embeddings, too much for 8 GB hosts. clawctl now writes
  `memory.search = { provider: "none" }` (OpenClaw's documented FTS-only
  mode) on 2026.9, replaces the exact `{ provider: "local" }` earlier betas
  wrote, keeps any other user value, and no longer allow-lists or installs
  `llama-cpp` there. To verify on the next fresh host: `openclaw memory
  status` reports FTS available (03 reported "FTS: unavailable" under
  `provider: "local"`).
- **G3 finding #19 (S1, security, found 2026-09-21): the model key entered
  during onboarding is stored raw on the instance.** `openclaw secrets
  audit --json` on `test-g3-oc95-03` reports `PLAINTEXT_FOUND` for auth
  profile `vercel-ai-gateway:default` in `state/openclaw.sqlite` (table
  `config_machine_state`). Checked without printing it: the stored value is
  a real Vercel key (60 characters, `vck` prefix), not an
  `__agent_vault_*__` placeholder, although Vercel AI Gateway is a
  vault-brokered provider in `model-provider-services.js`
  (`ai-gateway.vercel.sh`). The wizard ran after Agent Vault enrolment, so
  the key should have been brokered. Not yet diagnosed: whether onboarding
  on 2026.9.5 writes the raw key, or writes a placeholder that something
  later replaces. Bill's real key is on 03; rotate it when 03 is retired.
  Second audit finding, `.env` `TEAMYOU_API_URL`, is a name-heuristic false
  positive (a URL).
  Update: `.env` on 03 also holds the raw key (`AI_GATEWAY_API_KEY`, same
  shape). In this branch, onboarding writes the wizard's model key to
  `.env` and syncs it into the auth store (`lib/server/onboarding/index.js`,
  `syncApiKeyAuthProfilesFromEnvVars`) with no Agent Vault step. The
  enrolment gate (ac8fecc, "Gate onboarding on usable chat and settled
  Vault enrollment") is already in beta.4. Bill recalls unreleased changes
  that set up Agent Vault before the key is entered; not found in
  alphaclaw, teamyou, or clawctl on any branch or worktree on this machine
  (2026-09-21). Waiting on where they live.
  **Resolved as expected behaviour, not a regression (2026-09-21):**
  `docs/vault-brokered-model-keys-spec.md` §5B ("bootstrap lane") keeps
  the raw onboarding key on purpose, because the vault runtime token is
  only claimed after onboarding (it needs the tailnet and owner
  enrolment). Moving vault setup earlier was discussed and set aside for
  that ordering reason. The documented closure is §5C: after onboarding
  the Models page shows a migrate banner, which creates the proposal and
  link; on approval, reconcile swaps in the placeholder and scrubs `.env`
  and the auth store. End state is Phase D, provision-time key seeding,
  still parked. G3 check to add: on a fresh 2026.9.5 host, confirm the
  migrate banner appears and that migration scrubs the raw key from both
  `.env` and the auth store. The spec names the per-agent store
  `openclaw-agent.sqlite`; on 2026.9.5 the audit found the profile in
  `state/openclaw.sqlite` (`config_machine_state`), so the scrub may miss
  it.
- **2026-09-21 ~22:00 UTC: `test-g3-oc95-04` on beta.5 + bundle `37c70d18`
  (provisioned and onboarded by Bill, birth ritual done).**
  - Host: beta.5 / OpenClaw 2026.9.5 / Node 26.9.0; enforced egress,
    security-gateway connectivity; new helper in place.
  - **#17 PASS from first boot:** archive staged at
    `/var/lib/alphaclaw-managed-plugins/`, hand-off keys in `.env`,
    Clawbridge's startup reconcile installed `openclaw-teamyou-memory` 0.3.0
    and wrote the marker; post-onboard reconcile succeeded on its first run
    ("already installed"), no 5-minute failure loop. Plugin activated after
    the ritual (entry and active-memory enabled, activation marker present).
  - **FTS-only memory PASS:** `memory.search = {provider: "none"}`, no
    `llama-cpp` allow/entry, no model pre-fetch. `memory status` first said
    "FTS: unavailable" with 0/3 files indexed; `memory status --index`
    built it (3 files, 15 chunks, "FTS: ready") and `memory search Ava`
    returned the ritual notes. Open: whether the Gateway builds the keyword
    index on its own; I built it by hand.
  - **Read-only removed PASS:** no `OPENCLAW_CONFIG_READONLY` in the Gateway
    environment. **#18 PASS:** with the Gateway running, `plugins install
    npm:@openclaw/groq-provider@2026.9.5 --pin --accept-capabilities`
    through the Clawbridge wrapper "Applied in Gateway generation 3"
    (loaded, enabled); removed again with `plugins uninstall groq --force`.
    Control UI Plugins page install not exercised yet.
  - **#16 PASS:** Gateway chat history shows one kickoff, one greeting, one
    reply per turn.
  - **#19 as expected (bootstrap lane):** `secrets audit` flags the raw
    `vercel-ai-gateway:default` key and the `TEAMYOU_API_URL` false
    positive. Migration banner and scrub not yet exercised.
  - **G3 finding #20 (S2, user-facing noise):** the agent's first post-ritual
    reply surfaced "~26 `plugins.deny: plugin not found` warnings" and the
    TeamYou plugin "disabled-but-configured" warning. Source: Clawbridge's
    Agent Vault channel policy (D6, `ensureChannelPluginDenyList` in
    `lib/server/agent-vault/service.js`) denies every catalog channel
    plugin without a vault classification, 26 ids. On 2026.9.5 almost none
    of them are installed, and OpenClaw's config validation warns once per
    `plugins.deny` entry naming an unknown plugin, with no config switch to
    silence it. Every config-writing CLI call prints them (`config
    validate`: 26), so the agent saw them in its own tool output
    (`agents set-identity`). The TeamYou warning is the pre-activation
    state and is gone after activation. Also: the agent wrote a raw HTML
    `<details>` block, which the chat shows as text.
- **2026-09-21 22:3x UTC, host 04 follow-ups.**
  - **#19 migration PASS:** Bill moved the Vercel AI Gateway key to Agent
    Vault from the Models page. `.env` `AI_GATEWAY_API_KEY` and the auth
    profile in `state/openclaw.sqlite` (`config_machine_state`) both hold
    the placeholder, so the scrub does reach 2026.9.5's storage location.
    No live row in any database holds the raw key (exact-substring search;
    a first `LIKE '%vck_%'` pass gave false hits because `_` is a
    wildcard). Raw bytes remain in freed pages of `state/openclaw.sqlite`
    and its WAL, the residue the spec already calls best-effort.
  - **G3 finding #21 (S1): adding Slack from Clawbridge after onboarding
    hung on "Verifying vault credential..." and silently rolled back.**
    Sequence: placeholders written to `.env`, `slack` allowed, then
    `reconcileOpenclawPlugins` ran `openclaw plugins install
    npm:@openclaw/slack@2026.9.5`. With the Gateway running (read-only now
    removed) the CLI handed the install to the Gateway; the Gateway's
    `npm view` hung and `plugins.install` failed after 120 s ("npm view
    failed", only npm's `always-auth` warning captured). The channel flow
    then rolled back (Slack env removed, config restored). The same minute
    a 5 s fetch to `ai-gateway.vercel.sh` timed out and the Gateway logged
    a delayed liveness heartbeat. A minute later `npm view` through the
    same runtime env answered instantly, and an earlier Gateway install
    (groq) worked, so the hang looks transient; cause not confirmed.
    Why the page stuck: the reconcile runs `execSync` inside the Clawbridge
    server, blocking its event loop for the whole install (the Gateway's
    log lines from 22:31 were only written at 22:34). The "Installing
    channel plugin..." phase and the failure event on the operation stream
    never reached the browser, so it kept the last label it had. Slack
    plugin files were left in `npm/projects/openclaw-slack-*`, not enabled.
    Fix to decide: run plugin installs off the event loop (async spawn) so
    progress and errors reach the page, and retry a failed install once.
  - **#21 addendum, the error Bill finally saw:** "OpenClaw config
    validation failed while installing slack, and no safe managed-plugin
    references could be suppressed". Misleading. The real failure was the
    Gateway's `npm view` timeout. `isOpenclawConfigReferenceError`
    (`lib/cli/openclaw-plugin-compat.js`) matches `not found … plugin`
    anywhere in the command output, and every config-writing OpenClaw call
    on 2026.9.5 prints the 26 `plugins.deny: plugin not found: …` warnings
    (#20). So any install failure is misread as a config-reference error,
    routed to the suppression fallback, which finds nothing to suppress
    and throws this message. Reproduced offline: the classifier returns
    true with the warning line in stderr, false without it. Never seen
    before because on 2026.7.1 installs did not fail this way and the deny
    warnings did not exist. Fixes: classifier ignores OpenClaw's
    `warnings:` lines; #20 removes the warnings; #21 makes installs
    non-blocking with one retry and shows the real error.
  - **#21 second attempt (22:39 UTC) failed "while installing groq".**
    Cause: my #18 test on this host (install then `plugins uninstall groq`)
    left `plugins.entries.groq = {enabled: false}`, and
    `getPluginRelevanceReasons` treats any `plugins.entries.<id>` as a
    reason to install, even a disabled one. The retry skipped Slack
    (installed on the first attempt), tried Groq, and that failure was
    again misread as a config-reference error. Removed the leftover entry
    with `openclaw config unset plugins.entries.groq`. Add to the fix set:
    a disabled entry must not make a plugin relevant, and one unrelated
    plugin's install failure should not abort a channel add.
- **G3 finding #22 (S1, upstream OpenClaw bug): Slack Socket Mode never
  connects on Agent Vault-managed 2026.9.5 instances.** After beta.6 the
  Slack channel added cleanly on `test-g3-oc95-04`, but DMs got no reply:
  the Gateway logged an empty `socket-mode:socket-mode WebSocket error
  occurred:` / `SMWebsocketError` about every 15 s. Isolated step by step
  on the host (Slack tokens via Agent Vault placeholders, nothing printed):
  `apps.connections.open` through the vault proxy works; the WebSocket
  (`wss-primary.slack.com`) opens, says `hello` and answers pings both
  through the proxy and direct, with `ws`, with undici, with Slack's own
  `SocketModeClient`, and with OpenClaw's managed `proxyline` installed.
  It fails only when the `SocketModeClient` is given the dispatcher the
  Slack plugin builds: `@openclaw/slack` 2026.9.5 passes
  `dispatcher: resolveSlackProxyDispatcher()` into `createSlackBoltApp`,
  an `EnvHttpProxyAgent` from OpenClaw's undici **8.10.2** (via
  `openclaw/plugin-sdk/fetch-runtime` `createHttp1EnvHttpProxyAgent`), and
  `@slack/socket-mode` 3.0.1 creates its WebSocket with its bundled undici
  **7.29.1**. The cross-version dispatcher makes the handshake fail at once
  (reproduced: `WebSocket error occurred:` then close 1006 at 0.6 s). The
  plugin only builds that dispatcher when `HTTP(S)_PROXY` is set in the
  Gateway env, which Clawbridge does on every Agent Vault-managed instance,
  so every managed 2026.9.5 instance is affected; without a proxy env
  Socket Mode uses its own default dispatcher and works. Not the Slack app's
  Agent View vs assistant view setup (events reach test connections; 9.5
  still supports `assistant_view` apps). No upstream issue found
  (2026-09-21). Related upstream: openclaw/openclaw#128809 (reconnects leak
  sockets; ping-timeout warnings suppressed). Side effects seen: Slack
  reported up to 6 open connections for the app; my test connections could
  receive a DM meant for the Gateway while open (all stopped).
  - **#22 origin (upstream history, 2026-09-21):** the shared proxy
    dispatcher came from openclaw/openclaw#112963 (merged 2026-07-24), the
    Bolt 5 / Web API 8 / `@slack/socket-mode` 3 migration: socket-mode 3
    opens its WebSocket with undici, so to keep Slack proxy support the PR
    shared "one structural Undici dispatcher across Web API fetch and Socket
    Mode", built with Slack's own undici (loaded via
    `@slack/socket-mode/package.json`), and proved a Socket Mode handshake
    through a real CONNECT proxy. The regression is openclaw/openclaw#147421
    "fix: restore plugin networking under Bun" (merged 2026-09-14, first in
    2026.9.5; 2026.9.4 shipped 2026-09-11): to avoid Bun's placeholder bare-`undici` exports it replaced
    that with OpenClaw's shared `createHttp1EnvHttpProxyAgent` (OpenClaw's
    undici 8), while its own notes say Slack keeps undici 7 because Socket
    Mode requires that peer version. The mismatch is only hit when a proxy
    env is set, and #147421's validation did not include a Socket Mode
    handshake through a proxy. #147846 (same day) kept the helper for health
    probes. Upstream fix candidate: build the Socket Mode dispatcher with
    Slack's undici again (Node), or stop passing the OpenClaw dispatcher to
    `SocketModeReceiver` and let Socket Mode build its env-proxy default.
  - **#22 workaround (2026-09-22):** verified by hand on host 04 (original
    kept as `provider-w36VTgZ3.mjs.orig-2026.9.5`): removing
    `dispatcher: slackDispatcher,` from the `createSlackBoltApp` call and
    restarting gave `socket mode connected` with zero WebSocket errors;
    `channels status --probe`: running, connected, lifecycle ready. Built
    into Clawbridge as a version-pinned hotfix applied after every plugin
    reconcile (`lib/cli/openclaw-plugin-hotfixes.js`, commit `4b4c442`;
    exact text once, marker comment, `@openclaw/slack@2026.9.5` only);
    checked against the real 2026.9.5 file. Not released yet. Upstream issue
    drafted for Bill's review:
    `docs/upstream-drafts/openclaw-slack-socket-mode-proxy-dispatcher.md`
    (not filed). No inbound DM seen since the fix (`lastInboundAt` null, no
    pairing request): Slack still counted 6 connections at connect time, so
    earlier DMs went to dead sockets; Bill to DM again.
  - **Slack round trip PASS on host 04 (2026-09-22, check 8):** with the
    hand-applied #22 fix, Bill DM'd the bot, received a pairing code,
    approved it in Clawbridge (`openclaw pairing approve --channel slack
    --account default`, 01:08 UTC; `allowFrom` and
    `channel_pairing_allow_entries` both updated), and the bot answered.
    The Channels card kept "Awaiting pairing" and the security gateway row
    showed "Unknown" until a page reload; Clawbridge's API already reported
    `paired` and a healthy, fresh hop probe. Likely cause: the page's status
    stream did not recover after the two Clawbridge restarts that night
    (23:36, 00:49 UTC), so it aged its last hop reading past the 6-minute
    stale limit and never refetched channel accounts. Minor follow-up:
    reconnect/refetch after a server restart.
  - **#22 scope check (2026-09-22):** other channel plugins in 2026.9.5 do
    not have this mismatch. Discord pairs `createHttp1EnvHttpProxyAgent` with
    OpenClaw's `fetchWithRuntimeDispatcher` (same undici) for REST, and its
    gateway WebSocket uses `ws` (proxy via `channels.discord.proxy`, which
    Clawbridge writes). Telegram is bundled in core and uses OpenClaw's fetch
    and dispatcher over HTTP long polling. Mattermost and Nextcloud Talk have
    no undici/ws dependency of their own; Microsoft Teams does not use the
    shared proxy helper. Only Slack Socket Mode hands the helper to a library
    with its own undici. Not live-tested on 2026.9.5: Telegram and Discord.
    Correction: #147421 first shipped in 2026.9.5, not 2026.9.4.
  - **#22 hotfix corrected (2026-09-22):** the first version (removing the
    dispatcher) made Socket Mode connect **directly**, bypassing Agent Vault:
    `@slack/socket-mode`'s `buildDefaultDispatcher` is a plain `undici.Agent`
    that ignores `HTTPS_PROXY` (host 04 showed a direct TCP connection to
    `52.11.79.54:443`). The hotfix now replaces the argument with an
    `EnvHttpProxyAgent` built from Slack's own undici 7.29.1 (resolved next to
    the provider file, the same copy Socket Mode uses) whenever a proxy env is
    set. Proven: through the Agent Vault proxy it connects; with only that
    dispatcher pointed at a dead proxy it fails (close 1006). Installed on
    host 04 and restarted: `socket mode connected`, zero WebSocket errors,
    and the Gateway's only established TCP connection is to the proxy
    (`127.0.0.1:14323`). Upstream draft revised: dropping the dispatcher is
    not a fix (loses proxy support; under Bun falls back to the partial
    undici #147421 avoided); Bun path left to maintainers.

### Host 05 (`test-g3-oc95-05`, beta.7 + bundle `37c70d18`, 2026-09-22)

- Fresh provision and birth ritual completed. Startup reconcile installed
  `codex`; the other managed plugins were already present. TeamYou memory
  activated after the ritual.
- **G3 finding #23 (S1, ours): Gateway stranded after the post-ritual
  restart.** Timeline (UTC):
  - 16:31:49 TeamYou memory activation writes `openclaw.json` (plugin entry,
    active-memory and skill enabled) and restarts the Gateway.
  - 16:31:59 `alphaclaw-post-onboard-reconcile.timer` (every 5 min) runs
    clawctl's `teamyou-install.sh`, which rewrote `.env` (three upserts) and
    `openclaw.json` unconditionally, with no setting changed.
  - 16:32:03 OpenClaw 2026.9.5 refuses: "Refusing to run automatic gateway
    startup migrations because the selected config changed during startup.
    Retry startup". Its guard compares the raw config hash; Clawbridge wrote
    the file without a trailing newline and clawctl with one, so identical
    settings were different bytes (reproduced locally).
  - Clawbridge's restart supervisor only retried a stale migrations lock, so
    it gave up; the watchdog's relaunch was refused because the restart still
    owned startup. Down until the watchdog's auto-repair at 16:34 (doctor, then
    relaunch; ready 16:36:16 with `openclaw-teamyou-memory` loaded).
  - Relation to G2 finding #1: same timer. G2 fixed what it wrote (retired
    keys, clawctl `455ed6e`), not that it rewrites on every pass. Harmless on
    2026.7.1; 2026.9's startup guard made it an outage whenever a timer pass
    overlaps a Gateway start (about one start in seven).
  - **Fix:** clawctl `299867a` writes `openclaw.json` only when a setting
    changed (compared on the parsed config, so formatting alone never writes)
    and skips `.env` upserts whose value is already set. alphaclaw `9c41b18`
    retries the config-changed refusals on both launch paths, relaunches once
    if a managed restart still fails, logs early exits accurately, and ends
    `openclaw.json` with a newline. Needs a new clawctl bundle, beta.8, and a
    fresh provision.
- Also seen: `.env` still holds `ALPHACLAW_GATEWAY_PENDING_SETUP_URL` and
  `ALPHACLAW_GATEWAY_PENDING_PUBLIC_BASE_URL` after setup sealed, although
  Clawbridge logged clearing them. Not investigated.

### Host 06 (`test-g3-oc95-06`, beta.8 + bundle `8dcfb758`, 2026-09-22)

- **Finding #23 fix verified.** The post-onboard timer ran at 19:51:03, inside
  the post-ritual Gateway startup (spawned 19:50:06, ready 19:51:10), and
  wrote nothing: `.env` untouched since 19:07:29, `openclaw.json` last written
  by the activation at 19:50:05, zero "changed externally" reloads, no
  startup refusal, no watchdog repair.
- **G3 finding #24 (S2, ours): the TeamYou memory restart interrupts the
  agent's last ritual turn.** The agent deletes `BOOTSTRAP.md` and keeps
  working (memory note, config sync, onboarding recommendations). Activation
  triggers on the file being gone (`bootstrap_file_absent`) and SIGTERMs the
  Gateway at 19:50:05 while that turn is still running. OpenClaw 2026.9.5's
  main-session restart recovery resumed the turn at 19:51:13 and it completed
  at 19:51:56, but the resume prompt ("Your previous turn was interrupted by
  a gateway restart ...") shows in the chat as a user message, and the open
  chat view did not show the resumed turn until Bill navigated away and back.
  - OpenClaw offers a deferred restart: the `gateway.restart.request` RPC
    (behind `openclaw gateway restart --safe`) waits for tracked active work
    to drain, then restarts through the restart hand-off Clawbridge already
    consumes. Clawbridge's managed restarts use SIGTERM plus
    `openclaw gateway --force` and never ask for it.
  - **Better option found while implementing:** OpenClaw 2026.9.5's reload
    plan hot-reloads everything under `plugins` (action `reloadPlugins`) and
    needs no action for `skills`, which is all activation writes. Verified on
    host 06: setting the TeamYou plugin entry to disabled unloaded it, and
    back to enabled loaded and configured it, with the same Gateway process
    IDs throughout (config bytes restored afterwards).
  - **Fix (alphaclaw `68232a7`):** on OpenClaw 2026.9+ activation writes the
    config and lets the running Gateway apply it, with no restart (older lines
    still restart). The chat bridge now tells each browser when the Gateway
    connection drops mid-run, and the chat view leaves streaming mode and
    reads history until the session is idle, so a turn OpenClaw resumes after
    any restart appears without a reload. The deferred restart
    (`gateway.restart.request`) is not needed for activation and was not
    adopted. Not yet released.

#### Host 06 G3 checks (2026-09-22, beta.8 + bundle `8dcfb758`)

| # | Check | Result |
| --- | --- | --- |
| 1 | Host bootstrap | PASS. alphaclaw `0.9.18-starfoundry.23-beta.8`, openclaw `2026.9.5`, Node 26.10.0, `KillMode=mixed`, `TimeoutStopSec=90`, install library from bundle `8dcfb758` (commit `299867a`). First state snapshot at 19:18 before onboarding. |
| 2 | Pre-onboarding server | PASS by Bill (wizard served; provision completed). |
| 3 | Wizard | PASS by Bill: Agent Vault, Vercel AI Gateway model. Channel still to add (check 8). |
| 4 | 9.x config | PASS. No retired keys, `memory.search.provider: none`, web search `searxng`, memory slot `memory-core`, no deny list, `BOOTSTRAP.md` gone. Doctor lint: 34 warnings, none retired-key: 29 bundled skills lacking binaries or env, 3 expected under Clawbridge supervision (no service manager, loopback bind, device-pair off), 2 permissions (finding #25). |
| 5 | Plugins | PASS. Managed plugins at 2026.9.5 and "already installed" on restart; TeamYou memory 0.3.0 installed once from the staged archive; SearXNG answers on 127.0.0.1:8888. |
| 6 | Gateway | PASS. Managed restart ready in 50 s after the ritual; timer pass during that startup wrote nothing (#23 fix); `systemctl stop alphaclaw` took 0.9 s with no leftover Gateway process; clean start with 8 plugins. Control UI plugin install verified earlier on host 04. |
| 7 | Clawbridge | PENDING (needs a logged-in session): `/api/models` lifecycle, Add Model dialog, no GPT-5.5, advanced Control UI gate. |
| 8 | Channel round trip + three-turn recall | PENDING (Bill): add Slack, DM round trip; the #22 hotfix should apply on its own. |
| 9 | Backups | PASS. Manual state run from the gateway after the ritual: snapshot `4bae0937`, 2 SQLite snapshots, 55 MB added; state, gateway, host, and check timers scheduled. |
| 10 | Plugin SDK warnings | Recorded: only `cli registration missing explicit commands metadata` for `openclaw-teamyou-memory`. None for usage-tracker or agent-vault. |

- Egress spot check: the only established non-loopback connections on the
  workload go to its security gateway's private address (10.173.183.3).
  Repeat with Slack connected.
- **G3 finding #25 (S3, ours): Clawbridge leaves `openclaw.json` mode
  644.** OpenClaw writes its copies 600 (`.bak*`, `.last-good`); Clawbridge's
  `writeOpenclawConfig` writes a temp file with the default umask and renames
  it over the config. No secrets are stored in the file (only env
  references), and the state dir is 755. Fix: write with the existing mode or
  0600 and create the state dir 0700. Batch with #24 for beta.9.

- **G3 finding #26 (S1, ours): the advanced Control UI shows OpenClaw's
  "Approve this browser" screen again.** The silent pairing from `cf6be72`
  (G2) is intact, but it is timing out. `GET /api/gateway/dashboard` runs
  `openclaw dashboard --no-open --json` through `clawCmd`, whose default
  timeout is 15 s. On host 06 that command takes 17.5 s cold and 13.2–14.3 s
  warm (4 vCPU; the one-time link it mints lives 599 s). When it is killed,
  the route quietly falls back to the shared-token URL, and on 2026.9 a
  token-only browser always lands on the approval screen. The link is minted
  inside the CLI process (`issueDeviceBootstrapToken`), not through a
  Gateway call, so the CLI start-up cost cannot be bypassed.
  - Proposed fix: its own longer timeout (60 s) with a "preparing" state in
    the launcher; start minting when the advanced-access interstitial opens so
    the wait overlaps the acknowledgement; on 2026.9 never fall back to the
    token URL (it cannot pair) and show a retryable error instead; log when
    the bootstrap path fails.

#### beta.9 batch (released 2026-09-22)

- `0.9.18-starfoundry.23-beta.9` published to the `beta` tag (release commit
  `22b6a24`; `latest` stays `…22`; host bundle stays `8dcfb758`). Full vitest
  172 files / 1,546 tests before publish. Not installed on any host.

- #24 (`68232a7`): no Gateway restart for TeamYou memory activation on
  2026.9; chat view recovers after any Gateway restart.
- #25 (`2514e29`): Clawbridge writes `openclaw.json` 0600.
- #26 (`fa6c89a`): dashboard link mint gets a 60 s timeout and one shared
  in-flight mint; no token-URL fallback on 2026.9 (retryable 503, "Try
  again" in the launcher); failures logged. Stale read-only wording removed
  from the launcher, the interstitial, and the agent's `AGENTS.md`/`TOOLS.md`;
  capability contract revision `2026-09-22.1`, mode `managed-config-warned`,
  warning `v2` (existing acknowledgements must be renewed).
- Page-specific Control UI warnings (`b9ee9f9`): prominent amber panel on
  Channels, Model providers/Model setup, and Secrets, each linking to the
  matching Clawbridge page; follows in-page navigation; hideable per visit.
- Full vitest 172 files / 1,546 tests; UI build OK. To verify after release:
  fresh provision (ritual with no mid-turn restart, silent Control UI
  pairing, warnings on the three pages, config mode 600).

### Host 07 (`test-g3-oc95-07`, beta.9 + bundle `8dcfb758`, 2026-09-22)

Verified:
- **#24 fixed.** Activation at 22:09:48 applied by hot reload at 22:10:02
  (`plugins.entries.active-memory.config.enabled`,
  `plugins.entries.openclaw-teamyou-memory.enabled`); no Gateway restart
  after the ritual.
- **#25 fixed.** `openclaw.json` is 0600 after Clawbridge writes.
- **#23 holds.** Four timer passes since activation, no config or `.env`
  rewrites.
- **Slack (check 8, round trip).** Connected at 22:22:21 through the proxy;
  Bill paired and chatted. The #22 hotfix was applied by the reconcile.
- **Egress.** The Gateway's only connection is the local Agent Vault proxy;
  the host's only outside connections go to its security gateway
  (10.55.202.3).
- **Pending (Bill):** open the advanced Control UI (silent pairing, #26) and
  visit Channels, Models, Secrets (page warnings); three-turn recall.

Findings:
- **#27 (S2, ours): the Slack hotfix lands after the Gateway loads the
  plugin.** The Gateway hot-loaded the new Slack plugin at 22:19:09; the
  reconcile patched the file at 22:19:15. The first Slack start (22:20:25)
  ran unpatched code and failed the handshake (`SMWebsocketError`); the
  channel-add restart at 22:20:40 loaded the patched file. Works only
  because channel add restarts the Gateway (for the new token env). A Slack
  plugin installed any other way (Control UI Plugins page) stays unpatched
  until the next reconcile and restart.
- **#28 (S2, ours + upstream cost): adding Slack took about 8 minutes**
  (22:14:27 → 22:22:21):

  | Step | Time |
  | --- | --- |
  | Config write + plugin hot reload (event loop blocked) | 15 s |
  | Reconcile child: OpenClaw CLI start-ups before the install call | ~75 s |
  | First `plugins.install` fails: "plugin already exists … (delete it first)" for an unsuffixed project dir created moments earlier | 2 s |
  | Retry (5 s delay) + CLI start-ups again | ~85 s |
  | Second `plugins.install` (npm through Agent Vault, then hot reload) | 101 s |
  | Channel config write + hot reload | 26 s |
  | Gateway restart to pick up the Slack token env | 67 s |

  Each OpenClaw CLI start costs ~13–17 s on this host class (same root as
  #26). The first-attempt collision needs the reconcile child's output,
  which the runner only keeps on failure; log it.
- **#29 (S3): extra agent message after the ritual.** `openclaw agents
  set-identity` ran longer than exec's foreground window, was backgrounded,
  and OpenClaw's `[OpenClaw exec completion]` event (tools.exec.notifyOnExit,
  default true) started a second turn that re-reported the result.
- **#30 (S3, ours): pre-activation config warning reaches the agent.**
  Every OpenClaw CLI call before activation prints "plugins.entries.
  openclaw-teamyou-memory: plugin disabled (disabled in config) but config
  is present" (clawctl stages the entry disabled with its config). The agent
  saw it in its first tool result and repeated it to Bill.
- Tool calls before the greeting: the agent runs `openclaw onboard
  recommendations --json` and `ls` as the ritual instructs; the kickoff
  message that started the turn is hidden, so the tool rows appear first.
  Cosmetic.
- Also seen: the Gateway launcher ended with SIGKILL 2 s after Clawbridge's
  SIGTERM during the channel-add restart (not Clawbridge's drain timer,
  which logs); restart succeeded. Not investigated.
- **#31 (S1, ours + upstream default change): active memory no longer runs
  for ordinary questions on 2026.9.5.** Bill's Slack DM "What size shoes do
  I wear?" (22:39:23, session `42ae87fd`) passed the session and destination
  checks, then OpenClaw's new escalation step skipped recall at debug level
  (nothing in the info log). Active memory's `mode` defaults to `escalate`:
  deep recall runs only when `hasRecallIntent` matches phrases like "do you
  remember", "last time", "what did we decide", or "yesterday". A knowledge
  question never matches. The main agent then ran `memory_search` over local
  files only (no hits; it has no TeamYou tool, since `teamyou_retrieve_context`
  is allowed only for active memory) and answered that it had no
  information. The option is `plugins.entries.active-memory.config.mode`
  with values `escalate` (default), `always` ("preserves blocking recall on
  every eligible turn"), and `off`; our managed config sets none.
  - Proposed fix: clawctl's managed active-memory config writes
    `mode: "always"` on 2026.9+ hosts (gated by installed version like the
    retired-key handling, since 2026.7.1's schema has no `mode`). Cost: one
    blocking recall pass per eligible turn, which is the pre-2026.9
    behaviour.
  - Related: in the Clawbridge chat (main session, webchat) active memory
    logs `destination-not-allowed` on every turn, so it never recalls there
    either; `allowedChatTypes` is `direct` and `channel` only. Needs a
    decision on whether the Clawbridge chat should get TeamYou recall.
- **#32 (S1 for non-production control planes, ours): the TeamYou memory
  plugin calls production TeamYou from a preview-provisioned instance.**
  With `mode` unchanged, Bill's "Do you remember what size shoes I wear?"
  in the Control UI chat started active memory (22:55:56), and the plugin
  got HTTP 401 at 22:56:01. Agent Vault's `request_logs` show those calls
  went to `www.teamyou.com` (`POST /api/external/v1/search/topics` and
  `/search/details`, no matched service, 401), while the vault's
  `teamyou-external-api` service is scoped to the preview host
  (`teamyou-git-preview-openclaw-202694-g2-…vercel.app/api/external/v1/*`,
  from clawctl `85a738b`). Through the vault, the preview host answers 200
  with the same key (tested `GET /todos`, with and without the placeholder).
  - Cause: plugin 0.3.0 reads `apiKey` from its config entry
    (`${TEAMYOU_API_KEY}`, resolved from the Gateway env: works) but reads
    the base URL from `process.env.TEAMYOU_API_URL`, falling back to
    `https://www.teamyou.com/api/external/v1`. The Gateway process has
    `TEAMYOU_API_URL` set to the preview URL, yet the plugin fell back, so
    the plugin did not see it (most likely OpenClaw 2026.9 exposing only
    config-referenced env to plugins; not traced in OpenClaw's code).
  - Production instances are unaffected in practice (the fallback is the
    production URL), which is why this only shows on preview provisions.
  - Proposed fix: clawctl writes `baseUrl: "${TEAMYOU_API_URL}"` into the
    plugin's config entry, like `apiKey`. Can be tried live on host 07 first
    (plugins.* hot-reloads).
- **#31/#32 live trial on host 07 (2026-09-22 23:05 UTC):** set
  `plugins.entries.active-memory.config.mode = "always"` and
  `plugins.entries.openclaw-teamyou-memory.config.baseUrl =
  "${TEAMYOU_API_URL}"` by hand (backup `/root/openclaw.json.pre-31-32-live`;
  mode stays 0600). Hot reload applied at 23:05:29, no restart; the plugin
  reloaded and reconfigured. clawctl's timer spreads existing config, so both
  keys survive its passes. Awaiting Bill's recall test (plain question in
  Slack and in the Control UI chat), then Agent Vault `request_logs` check.
- **#31/#32 live trial passed (23:09–23:10 UTC).** Bill asked a plain
  question in Slack and in the Clawbridge chat and got the expected answer.
  Active memory ran in both (Slack thread session and `agent:main:main`,
  status ok). Agent Vault logged every lookup (search/topics, search/details,
  topic reads) against the preview host, matched `teamyou-external-api`,
  HTTP 200. Correction: the Clawbridge chat's earlier
  `destination-not-allowed` lines all predate activation (active memory's
  `enabled` flag was still false), so there is no Clawbridge chat gap.
  Fix committed in clawctl `af4b8c2` (on
  `codex/openclaw-2026.9.4-upgrade`); needs a new host bundle.

#### beta.10 batch (released 2026-09-23)

- `0.9.18-starfoundry.23-beta.10` published to the `beta` tag (release commit
  `992b39e`; `latest` stays `…22`) after one `prepack` and full vitest 173
  files / 1,552 tests; published with `--ignore-scripts` so the package
  matches the committed artifacts (UI bundle and watcher confirmed in the
  pack listing). No `v*` tag pushed: the tag-triggered workflow runs Node 22,
  outside the package's engine range, and this line's betas have all been
  published locally.
- Host bundle `42536ffa` published from clawctl `af4b8c2` (#31/#32),
  provenance clean, sha verified after download, install helper
  byte-identical; recorded in clawctl `9e356eb`; pinned on TeamYou Preview
  beta only; Preview redeployed at `6601c11e` (Vercel success). A fresh
  provision on channel `beta` now gets beta.10 plus this bundle.

- #27 (`131057a`): a minute-by-minute watcher applies pending plugin
  hotfixes and restarts the Gateway when a patched file is newer than the
  running Gateway (2-minute grace, skipped while another lifecycle operation
  owns the Gateway). Covers Slack installed from the Control UI Plugins page.
- #28 logging (`36b5f0d`): the reconcile logs each OpenClaw command with its
  duration and first error line; the runtime runner relays every attempt's
  outcome, duration, and child output. The "plugin already exists" first
  install was the reconcile's own `--force` recovery inside one attempt, not
  the runner retry; the next Slack add will show what created the folder.
- Deferred by Bill (2026-09-22): #29 (exec completion follow-up message,
  accepted as OpenClaw behaviour) and #30 (pre-activation config warning).
- Pairs with clawctl `af4b8c2` (#31/#32) in a new host bundle.
- Full vitest 173 files / 1,552 tests.

### Host 08 (`test-g3-oc95-08`, beta.10 + bundle `42536ffa`, 2026-09-23)

Slack add failed ("OpenClaw did not finish in time"), Clawbridge rolled the
channel back, and the Gateway was down 20:01:53–20:08:41 until the watchdog
repaired it. Timeline (UTC):

| Time | Event |
| --- | --- |
| 19:57:26 | Clawbridge writes the Slack tokens and `plugins.entries.slack` + `plugins.allow` |
| 19:57:48 | OpenClaw: Slack "state migration is pending: the configured plugin package is missing"; it starts installing the package itself |
| 19:58:50 | Hotfix watcher patches the half-prepared package (OpenClaw then logs "Plugin source changed while preparing it") |
| 19:59:03 | OpenClaw: "Deferred state migration completed for plugin slack" (its own install done) |
| 19:59:07 | Clawbridge's reconcile `plugins install` → "plugin already exists"; its `--force` recovery re-downloads and the CLI blocks on the pending migration until the 180 s command timeout (20:00:35) |
| 20:00:48 | Reconcile attempt 2: "already installed", succeeds |
| 20:01:40 | Slack provider starts (patched file) |
| 20:01:50 | Hotfix watcher restarts the Gateway: patched file (19:58:50) newer than the Gateway process → judged stale, although the Gateway loaded Slack after the patch |
| 20:03:58 | Restart not ready in 120 s; channel-add CLI commands fail; Slack tokens removed 20:04:22 |
| 20:08:41 | Gateway ready again after the watchdog's repair |

- **#33 (S1, regression from beta.10 `131057a`, ours): the #27 watcher's
  staleness test is wrong.** "Patched file newer than the Gateway process"
  does not mean the Gateway loaded the old code: on 2026.9 the Gateway
  hot-loads plugins after start. It restarted a healthy Gateway in the
  middle of a channel add (the flow holds no lifecycle ownership during its
  CLI steps), and its periodic patch touched a package OpenClaw was still
  preparing.
- **#34 (S1, root cause of the #28 collision): OpenClaw 2026.9.5 installs an
  enabled official plugin by itself.** Writing `plugins.entries.slack`
  makes it a pending state migration that OpenClaw converges (install)
  within ~90 s. Clawbridge's reconcile then runs its own install, collides
  ("plugin already exists"), and the `--force` recovery hangs on the pending
  migration. Host 07's slow add had the same shape.
- Retry on host 08 should now succeed: Slack 2026.9.5 is installed and
  patched, and the Gateway (started 20:07:54) loaded the patched file.
- **Host 08 Slack retry succeeded, still ~4.2 minutes** (tokens 20:11:36 →
  `socket mode connected` 20:15:49; pairing approved 20:16:27). The
  reconcile was fast this time (6.0 s, "already installed"), so none of the
  time was the plugin install:

  | Step | Time |
  | --- | --- |
  | Reconcile (plugins list 5.2 s, skip) | 6 s |
  | `plugins.entries.slack` hot reload (all plugins reload; Gateway event loop stalls) | 34 s |
  | Clawbridge channel-add CLI steps before the channel config lands | 34 s |
  | `channels.slack` hot reload (+ a superseded second reload) | 37 s |
  | Bind to the agent (`bindings` reload) | 20 s |
  | Gateway restart to load the Slack token env | 74 s to supervisor ready, 115 s to Gateway ready |
  | Socket Mode connect | 4 s |

  The pre-restart Socket Mode error at 20:13:31 is the token env not yet
  loaded (same as host 07), not the hotfix. Load average was 3.4 on 4 vCPU.
- **#35 (S2, ours + OpenClaw 2026.9 cost): channel add is minutes long even
  without an install.** Three separate config writes each trigger a full
  plugin hot reload (~30 s each on this host), each Clawbridge CLI step
  costs 5–20 s of OpenClaw start-up, and the final Gateway restart takes
  75–115 s. Not measured on 2026.7.1 for comparison (no 7.1 test host).
  Candidate fixes, not implemented: write the plugin entry, channel config
  and binding in one config write (one reload instead of three); load the
  new token env without a restart if OpenClaw's secrets reload covers `.env`
  (its log suggests `openclaw secrets reload`; unverified); replace CLI steps
  with direct config writes where Clawbridge already owns the config.
  - **Control UI vs Clawbridge (checked in OpenClaw v2026.9.5 source):** the
    Control UI's channel setup runs OpenClaw's server-side wizard
    (`wizard.start`/`wizard.next`, `runChannelsSetupWizard`). It installs a
    missing plugin in-flow without touching the config, then makes one write,
    `commitConfigWithPendingPluginInstalls`, carrying the install record,
    plugin entry, channel config, and routing bindings together. That is one
    hot reload and no restart (tokens go into the config itself).
    Clawbridge's `lib/server/agents/channels.js` makes four writes: plugin
    allow/entry (`saveConfig`, which also starts OpenClaw's own install,
    #34), `openclaw channels add`, an accounts/defaultAccount normalization
    (`saveConfig`), and `openclaw agents bind`, then restarts the Gateway so
    the new token env vars load. Redesign to match the wizard's shape: install
    first without enabling the entry, then one config write with entry,
    channel (token env references), and binding, then one env load.

#### beta.11 batch (released 2026-09-23)

- `0.9.18-starfoundry.23-beta.11` published to the `beta` tag (release commit
  `d185373`; `latest` stays `…22`; host bundle stays `42536ffa`) after one
  `prepack` and full vitest 173 files / 1,554 tests; published with
  `--ignore-scripts`, watcher absent and UI bundle present in the pack
  listing. No `v*` tag (see beta.10). Not installed on any host.

- **Secrets-reload question, answered from OpenClaw v2026.9.5 source:**
  `openclaw secrets reload` (`secrets.reload` → `createGatewaySecretsReloader`)
  re-resolves secret references against the Gateway's in-process
  environment. `.env` files are loaded only at startup
  (`loadGlobalRuntimeDotEnvFiles` is called from the CLI and the Gateway's
  pre-bootstrap only), so a token Clawbridge adds to `.env` never reaches a
  running Gateway without a restart. Hosts 07 and 08 showed the same:
  "secret reference was not found" until the restart. Instead, on Agent
  Vault instances the channel config now holds the vault placeholders
  themselves; Clawbridge's managed credential policy already treats them as
  safe (`isUnsafeManagedChannelCredential`).
- **#35 + #34 (`393d135`):** channel add for Slack, Discord, Telegram and
  WhatsApp installs the plugin first (a targeted reconcile counts an explicit
  request as relevance; OpenClaw's install enables the entry and
  allowlist), then makes one config write (plugin entry, channel account,
  binding) with no `channels add` / `agents bind`. Vault instances write the
  placeholders into the channel config and skip the restart; other
  instances keep env references and one restart; WhatsApp keeps its restart.
  The channel normalizer keeps placeholders. Removal is one config write for
  every channel but WhatsApp (Discord keeps its restart). "plugin already
  exists" with the target version already installed counts as done (no
  `--force`). A failure after the install keeps the install record.
- **Restart guard (`578bdff`):** the Slack provider module is outside the
  static import closure of the plugin's load path (checked on host 08; the
  channel imports it with `import()` when it starts), so a hotfix written
  right after install should be picked up without a restart. As a guard, a
  channel add that applied a hotfix restarts once.
- **#33 (`5cf5b13`):** the beta.10 hotfix watcher is reverted.
- Full vitest 173 files / 1,554 tests. Needs a live add on 2026.9.5 for each
  channel (Slack, Discord, Telegram) and a removal before Checkpoint G3;
  only Slack has been verified end to end so far.

### Host 09 (`test-g3-oc95-09`, beta.11 + bundle `42536ffa`, 2026-09-23)

| Channel | Tokens saved → working | Notes |
| --- | --- | --- |
| Slack | 21:36:58 → 21:39:12 (2 min 14 s) | Reconcile 69 s: `plugins install` returned "plugin already exists" after 61.5 s, the new check saw 2026.9.5 installed and did not force (#34 fix working); hotfix applied → one restart (44 s to supervisor ready, Gateway ready at +60 s) |
| Telegram | 21:41:33 → 21:41:52 (19 s) | Reconcile 2.9 s (bundled); ONE reload covering plugin entry, allowlist, channel and bindings; no restart; polling via vault |
| Discord | 21:43:08 → 21:44:56 (1 min 48 s) | Install 74.8 s (`ok`), one channel reload, no restart; REST and gateway proxy enabled |
| Discord removal | 21:47:01 | One config write, restart kept by design (48 s) |

- Vault placeholders are in the channel config (`__agent_vault_slack_bot_token__`,
  `…app_token__`, `…telegram_bot_token__`); Telegram's placeholder in the
  URL path is substituted by the vault (`channel-telegram`, HTTP 200).
- Bindings: slack, telegram (Discord's removed). Config 0600; timer passes
  wrote nothing; active memory `mode: always`, plugin `baseUrl:
  ${TEAMYOU_API_URL}`, both from bundle `42536ffa`.
- Recall evidence not found on this host: the only active-memory run after
  setup was on "Cool" (21:46, `no_relevant_memory`), and the vault logged no
  TeamYou recall requests (only the 21:27 agent registration).
- **#36 (S2, ours): later channels show "Awaiting pairing" after approval.**
  OpenClaw 2026.9.5 stores pairing approvals in `state/openclaw.sqlite`
  (`channel_pairing_allow_entries`; entries present for slack, telegram and
  discord). Only the first owner is also bootstrapped into the config
  (`commands.ownerAllowFrom` + that channel's `allowFrom`), which is why
  Slack shows paired. Clawbridge's `getChannelStatus` (gateway.js) counts
  only inline `allowFrom`. Neither `openclaw pairing list` nor
  `channels.pairing.list` returns approved senders. Fix: read the allow
  entries from the state database, read-only.
- **#37 (S3, ours): channel removal keeps pairing approvals.** The Discord
  allow entry is still in the state database after removal, because removal
  no longer runs `openclaw channels remove --delete`. Re-adding the same bot
  would come back already approved.
- **#36 fixed (`34b2341`, not yet released):** Clawbridge reads approved
  senders from `state/openclaw.sqlite` read-only; both the account list and
  the Gateway channel status count config `allowFrom` plus stored approvals.
  #37 accepted by Bill (approvals may outlive a removed channel). Bill
  confirmed the TeamYou recall check ran on host 08.
- **#38 (S2, ours): a second Slack workspace cannot be added on an Agent
  Vault instance.** Two defects:
  1. The "Store token in Agent Vault" step renders above the Name field and
     requests vault access with the account id derived from the name; before
     a name is typed the id is empty, and `POST /api/channels/vault-token`
     falls back to `"default"`. With the first workspace's credentials
     already in the vault the request is "available" and the modal fills in
     the first workspace's placeholders (what Bill saw).
  2. Even with a name, the vault matches services by host only
     (`serviceMatchesAccess`), so the second account's request finds the
     existing `channel-slack` (`slack.com`) service and proposes only the
     new credentials (`SLACK_BOT_TOKEN_<ACCOUNT>`, …). The service's
     substitution list keeps only the first account's placeholders (host 09:
     `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`), so the new placeholders would
     reach Slack unsubstituted.
  - Proposed fix, not implemented: require an explicit account name before
    the vault step on multi-account providers (Slack, Telegram) and refuse
    an empty/default account id when the provider already has accounts;
    build the channel service request with substitutions for every
    configured account plus the new one and include the service in the
    proposal whenever a new account is added. Needs a check of how Agent
    Vault applies a proposal for an existing host (merge vs replace of
    substitutions) before implementing. Telegram multi-account has the same
    shape.
- **#38 Agent Vault behaviour (checked in Infisical Agent Vault v0.32.0,
  the version our gateways run; `internal/proposal/merge.go`,
  `internal/server/handle_services.go`, `internal/brokercore/credential.go`):**
  - An approved proposal upserts services by name, and a proposed service for
    a host the vault already has adopts the existing service's name
    (`adoptByHost`). So there is exactly one `slack.com` service
    (`channel-slack`) per vault, shared by every Slack account.
  - For an existing service, a proposal's `substitutions` list REPLACES the
    stored list (an empty list keeps it). A proposal carrying only the new
    account's placeholders would drop the first account's and break it.
  - The proxy applies every substitution on the matched service, so one
    service can carry several accounts' placeholders.
  - Every substitution's credential must exist: if any one is missing, every
    request to that host fails (`ErrCredentialMissing`). Deleting one
    account's credential from the vault would break all Slack accounts.
  - `/discover` does not expose substitutions, so Clawbridge cannot see the
    current list.
- **#38 plan:**
  1. Account name before the vault step for multi-account providers (Slack,
     Telegram); `POST /api/channels/vault-token` rejects an empty or
     already-configured account id once the provider has accounts.
  2. Adding an account always proposes the provider's service with the
     UNION of substitutions: every configured account whose credentials the
     vault reports available, plus the new account (whose credentials are in
     the same proposal, applied atomically). Only the missing credentials are
     requested.
  3. Removal leaves the account's substitution and credentials in the vault
     (consistent with #37); the removal note warns that deleting that
     credential in the vault would break the provider's other accounts.
  4. The existing-instance migration path (`migrationProposals` from the
     channel credential quarantine) builds one proposal per provider with
     all its accounts; today it plans each account separately, so a second
     account's placeholders would never be substituted. This belongs to the
     fleet-upgrade project (`rs8GE45wtye2`).
  5. Verify with a second Slack app on a test instance: both workspaces
     connect, and the vault's `channel-slack` service lists both accounts'
     substitutions.
  - Scope note: several Slack conversations in one workspace use one bot
    and need none of this; only several Slack apps/workspaces do.
- **#38 implemented (fcbd698, unreleased), with two additions Bill asked for
  on 2026-09-24:**
  - Items 1–3 as planned. Item 1 is enforced as "the id must not already be
    configured" (re-adding a removed account is allowed). The wizard shows
    Name before the vault step, disables "Store token in Agent Vault" until
    the name is unique, and locks the name once the request is filed. In
    vault mode the Telegram account id comes from the name only, so the bot
    identity arriving after approval no longer re-derives and resets it.
  - Every add re-proposes the service (`includeService: "always"`), because
    `/discover` hides substitutions. A re-add whose credentials survived
    therefore gets a one-click, service-only proposal. After approval the
    wizard confirms with `approvedProposalId`, and the server skips the
    re-proposal once that proposal is `applied`, so there is no loop.
  - The migration path now also re-proposes the service with the union
    whenever an account's credentials are missing
    (`includeService: "missing"`). That fixes the per-account planning gap
    in item 4 for Clawbridge's own code; fleet validation stays with
    `rs8GE45wtye2`.
  - Limit: Clawbridge caps substitutions at 10 per service, which is five
    Slack accounts or ten Telegram/Discord accounts per provider.
  - **Shorter placeholders.** New credentials use `__av_<key>__`.
    `__agent_vault_<key>__` is still recognized everywhere: the server, the
    UI, the core prompt and the channel placeholder check. Any key whose
    legacy placeholder is still referenced keeps it, whether in `.env`,
    `openclaw.json` or model auth profiles, because the vault substitutes
    the exact string. The TeamYou runtime placeholder is unchanged.
    - Known gaps, for the fleet project:
      - A legacy migration proposal filed before the upgrade and approved
        after it flips the raw value to `__av_`, which will not match the
        vault's legacy substitution.
      - clawctl `alphaclaw-backup-import.sh` synthesizes missing channel
        env vars as `__agent_vault_<var>__`.
  - **Shorter proposals.**
    - The approval page's message is now one line naming what to paste
      ("Paste your Slack app token and bot token for “work”.").
    - Field labels are short ("Slack app token for work (xapp-…)",
      "OpenAI API key").
    - `message` is now "Connect the Slack “work” account." or "Connect
      OpenAI models."; a service-only proposal shows only that line.
  - Tests: full suite 174 files / 1563 tests pass. Sandbox UI checked:
    name-first order, disabled until named, name locked while pending.
  - Still to do: release with #36 (beta, after Bill approves), then a live
    test with a second Slack app on a fresh provision.

#### beta.12 batch (released 2026-09-24)

- `0.9.18-starfoundry.23-beta.12` published to the `beta` tag (release commit
  `61a3257`; `latest` stays `…22`) after one `prepack` and full vitest
  174 files / 1,563 tests (exit code 0); published with `--ignore-scripts`,
  UI bundle present and watcher absent in the pack listing. No `v*` tag.
  Not installed on any host.
- Contents: #36 (channel shows paired once its pairing is approved, from
  the pairing store) and #38 with the short `__av_` placeholders and the
  one-line proposal copy.
- Host bundle: not rebuilt. clawctl has no asset changes since `af4b8c2`
  (only the `9e356eb` record commit), so a new build would match
  `42536ffa`, which stays pinned on Preview beta. A fresh provision on
  channel `beta` gets beta.12 plus `42536ffa`.
- Live checks for the next fresh provision: add a first Slack app, then a
  second one (name first; both keep working; the vault's `channel-slack`
  service lists all four substitutions); the approval page shows the
  one-line message and the short labels; the channel shows "paired" once
  the pairing is approved (#36).

### Host 10 (`test-g3-oc95-10`, 2026-09-24): failed provision, not ours

- The workload bootstrap's `apt-get update` hit Ubuntu's security mirror
  mid-sync ("File has unexpected size … Mirror sync in progress?"), exited
  100 and failed "Installing base system packages"; automatic cleanup
  destroyed the instance. `Acquire::Retries=5` cannot help because the
  mismatched file comes back on every attempt. A retry loop around
  `apt-get update` in clawctl was proposed (not made; the edit was declined).

### Host 11 (`test-g3-oc95-11`, beta.12 + bundle `42536ffa`, 2026-09-24)

- **#38 verified live.** Two Slack apps (`default`, `slack-2`) were added
  through the vault flow, both paired, and both delivered replies
  (19:31:11 and 19:31:17). Config and `.env` hold only `__av_` placeholders
  for both accounts, so the union service substitution works end to end.
- **#39 (infrastructure, not ours): degraded workload VM.** From about 19:21
  every connection through the Agent Vault proxy failed
  (`ProxyConnectionError`, Slack `fetch failed`, model calls failing, active
  memory timing out at 45 s). Clawbridge's own vault API calls timed out
  too, which gave the "Security gateway: unreachable" and "Agent Vault:
  unavailable" status. Measured at about 19:40:
  - Workload CPU steal was 20–31%.
  - Workload to gateway: 41% loss and 1.4 s average round trip over the
    private network. Workload to DigitalOcean's VPC router: 0.66 s average.
  - Gateway to workload: 42% loss and 4.3–6.9 s round trips. Gateway to the
    VPC router: 0.66 ms, with zero steal on the gateway.
  - The tunnel's TCP connection showed an 889 ms round trip, a 4.5 s
    retransmit timeout, a congestion window of 2–5 and 100 SYN retransmits.
    There were no drops on the gateway (queues, conntrack at 62/65536,
    firewall accepts only), no Agent Vault restarts, and the tunnel process
    stayed up. Agent Vault only logged client-side TLS handshake timeouts.
  - The droplet sits on an oversubscribed hypervisor. The slow first Slack
    add (a 186 s reconcile attempt, then an 88 s Gateway boot after the
    hotfix restart) is the same cause.
- **#40 (ours, fixed `35bd667`):** "A Slack account with this id already
  exists." flashed after a successful add, because the channel list
  reloads before the modal moves on. The modal now ignores the account it
  is creating.
- **#41 (ours, fixed `35bd667`):** pairing approve ran under a 15 s CLI
  timeout. On the starved VM both approvals were killed after landing,
  logging a bare `[alphaclaw] Error:`. Approve now gets 60 s, and timeouts
  log as such.

#### beta.13 batch (released 2026-09-24)

- `0.9.18-starfoundry.23-beta.13` published to the `beta` tag (release
  commit `736121f`; `latest` stays `…22`) after one `prepack` and full
  vitest 174 files / 1,563 tests (exit code 0); `--ignore-scripts`, UI
  bundle present in the pack listing. No `v*` tag. Not installed on any
  host. Contents: #40 and #41 (`35bd667`).
- **Known gap in beta.13:** the prepack's Novita probe came back thin, so
  the model catalog bootstrap carries only OpenClaw's 8 bundled Novita
  models instead of the 122 live ones (other providers unchanged). A re-run
  restored them (`886e216`, not yet released). Novita has a
  bundled catalog and no `minimumProbeModelCount`, so the generator accepts
  a thin probe silently; a guard for that is a follow-up.
- **clawctl apt retry (`9e3c6d9`, not yet in a bundle):** `apt_get_update`
  retries `apt-get update` up to 6 times, 30 s apart, clearing partial lists
  between attempts. Used by the host bootstrap and bake, and by the SearXNG
  and TeamYou installers when sourced by them. clawctl `src` tests 45 files
  / 287 pass; the behavioural check with a stub `apt-get` was blocked by
  the sandbox and not run. Needs a new host bundle pinned on Preview beta
  to take effect.

#### Bundle `7d902eb0` + beta.14 (released 2026-09-24)

- Host bundle `7d902eb0` published from clawctl `9e3c6d9` (apt-get update
  retry). Provenance is clean (not dirty), the sha256 was verified after
  download, and the bundled `alphaclaw-host-bootstrap.sh` is byte-identical
  to the commit; the bootstrap, SearXNG and TeamYou installers all carry
  `apt_get_update`. Recorded in clawctl `f23cba2`. Pinned on TeamYou
  **Preview beta** only (`OPENCLAW_HOST_ASSET_BUNDLE_URL_BETA` /
  `_SHA256_BETA`; stable unchanged); Preview redeployed at `19810f69`
  (Vercel success).
- `0.9.18-starfoundry.23-beta.14` published to the `beta` tag (release
  commit `8eb2012`; `latest` stays `…22`) after one `prepack` and full
  vitest 174 files / 1,563 tests (exit code 0); `--ignore-scripts`, UI
  bundle present in the pack listing. The model catalog bootstrap has all
  244 Novita entries (2,987 total), restoring what beta.13 lost.
- A fresh provision on channel `beta` now gets beta.14 plus bundle
  `7d902eb0`.

