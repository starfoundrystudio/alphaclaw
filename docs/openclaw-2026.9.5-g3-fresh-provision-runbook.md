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
