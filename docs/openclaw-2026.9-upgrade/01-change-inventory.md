# OpenClaw 2026.7.1 → 2026.9.4 — change inventory (Phase 1)

Status: **draft for Bill's review** (project "OpenClaw 2026.7.1 → 2026.9.4
upgrade assessment", Phase 1). This document inventories what changed
upstream; it does not yet decide what AlphaClaw must do. Phase 2 (code
deep-dives) and Phase 3 (AlphaClaw touchpoint impact matrix) build on it.

Sources reviewed: GitHub release notes for every stable tag between the two
pins (curated Highlights/Changes/Fixes sections, not the PR lists), the
upstream `CHANGELOG.md` at `v2026.9.4`, the upstream docs pages the notes link
to, and targeted diffs of the local `openclaw` checkout between `v2026.7.1`
and `v2026.9.4` (package engines, official catalogs, `OPENCLAW_*` env vars,
SQLite `CREATE TABLE` statements, gateway-protocol package).

## 1. Release timeline

| Tag | Published | Nature |
| --- | --- | --- |
| 2026.7.1 | 2026-07-13 | **Our pin.** npm dependency is exact `2026.7.1`. |
| 2026.7.1-1, 2026.7.1-2 | 2026-08-04 | Correction releases for 7.1 (Codex progress-reply stall, Memory Core startup restart loop, WSL chmod, legacy migration residue nonfatal, managed-plugin npm lock metadata, singleton-array npm metadata). **Not on our fleet** because the pin is exact. |
| 2026.7.2-beta.1 … beta.7 | 2026-07-15 → 08-02 | Betas that fed 2026.8.1. No stable 2026.7.2 was ever cut. |
| 2026.8.1-beta.1 … beta.4 | 2026-08-15 → 08-28 | beta.4 was mis-published as `2026.9.1-beta.1`; it is older than stable 2026.8.1. |
| **2026.8.1** | 2026-08-31 | "OpenClaw 2.0". ~1,500 PRs. Two explicit breaking migrations, large default-behaviour changes, SQLite becomes the primary store for sessions/transcripts, shared credential store, external-supervisor mode, Control UI overhaul. |
| 2026.8.2 | 2026-09-01 | Stabilisation: safer upgrades, `update cleanup`, session-visibility default, plugin-SDK deprecation reminders. |
| 2026.9.1 | 2026-09-03 | Quick-start onboarding, update rollback/triage, cron quarantine at boot, `cron.skipMissedJobs`, `channels.<id>.enabled:false` stops loading the plugin, Anthropic Fable 5.1 metadata. |
| 2026.9.2 | 2026-09-05 | Swarm on by default, cross-agent session visibility default, hot-reload of more settings, experimental plugin UI, GPT-6 Astra. |
| 2026.9.3 | 2026-09-08 | **Breaking Node floor (24.16+/26.1+)**, plugin-SDK breaking renames, update rehearsal in candidate state, agent-owned Workshop skills, CLI agents in picker by default, single Gateway-secret field. |
| **2026.9.4** | 2026-09-11 | Automatic schema-neutral rollback, unified Plugins workspace in Control UI, `OPENCLAW_CONFIG_READONLY=1`, Node-runtime recovery. Latest as of 2026-09-11. |
| 2026.6.33 / 6.34 / 6.35 | 2026-08-08 → 09-10 | `extended-stable` (LTS) line for June. 6.35 is "the final June 2026 Extended Stable release". **There is no extended-stable line for 2026.7.x.** Whether an 8.x/9.x LTS line will exist is not stated in the notes. |

Implication for planning: staying on 2026.7.1 means no maintenance
releases at all; the only supported direction is forward.

## 2. Hard breaking changes and mandatory operator actions

These are the items upstream itself labels breaking, or that will refuse to
start/upgrade if ignored.

### 2.1 Node runtime floor (2026.9.3)

- Required: `>=24.16.0 <25 || >=26.1.0` (`package.json` engines at 9.4).
  Node 22, 23, 25, and earlier 24.x/26.x are unsupported. Reason: SQLite
  TEXT truncation / WAL-reset safety in the linked SQLite. Upstream says
  "upgrade Node before OpenClaw". Node 26 is recommended (faster startup, less
  memory).
- 2026.9.4 adds "re-execute the CLI under an available supported Node runtime
  before refusing to start" and offers a Node update from the CLI.
- Where we currently encode the 7.1 ranges (`>=22.22.3 <23 || >=24.15.0 <25
  || >=25.9.0`): AlphaClaw `package.json` engines, `lib/runtime/node-sqlite-safety.js`
  (`isSupportedOpenclawNodeVersion`), and clawctl
  `assets/host/lib/node-runtime.sh` (`openclaw_node_version_supported`, log
  text literally says "OpenClaw 2026.7.1 engine ranges"). clawctl provisions
  `NODE_MAJOR=24` from NodeSource; the exact patch installed on the fleet must
  be verified ≥ 24.16.0.

### 2.2 OpenAI route migration (2026.8.1, breaking)

- `codex/*` and `openai-codex/*` model refs, provider config, stored sessions,
  and automation routes migrate to `openai/*` via `openclaw doctor --fix`,
  "retaining Codex runtime intent and flagging conflicts for operator repair".
- Follow-ups in later releases: "stale OpenAI doctor route pins are repaired"
  (9.1), "Doctor update finalization: allow implicit Codex preferences when the
  plugin is absent" (9.4), exact `openai/gpt-5.6-sol` for fresh setup (8.1).
- AlphaClaw's documented "flexible OpenClaw Pi route" uses the effective
  `openai-codex/*` model key (see `docs/fork-deviations.md`); `lib/public/js/lib/model-config.js`,
  `lib/server/model-catalog-support.json`, `lib/server/openclaw-thinking.js`
  and the Codex runtime selection (`models.providers.openai.agentRuntime.id`)
  are the suspects for Phase 3.

### 2.3 OpenProse removal (2026.8.1, breaking)

- Bundled OpenProse plugin and `/prose` removed; `doctor --fix` cleans stale
  config. Only relevant if any managed config or prompt references it.

### 2.4 Plugin SDK surface (2026.8.1 → 2026.9.4)

- Root `openclaw/plugin-sdk` and `openclaw/plugin-sdk/compat` imports are
  **removed** ("plugins importing the removed root, compat, or extension
  surfaces no longer load"). `openclaw/extension-api` removed.
- Deprecated subpaths with a 2026-09-01 removal gate (still present in 8.2,
  gates enforced from 9.x): `config-runtime`, `channel-reply-pipeline`,
  `channel-lifecycle`, `channel-message`, `infra-runtime` → focused imports
  (`config-mutation`, `runtime-config-snapshot`, `config-contracts`,
  `channel-outbound`, `channel-inbound`, `delivery-queue-runtime`,
  `diagnostic-runtime`, `error-runtime`, `exec-approvals-runtime`,
  `fetch-runtime`, `ssrf-runtime`).
- 2026.9.3 breaking renames: exec-policy helpers move to `execPolicy` on
  `agent-harness-runtime`; approval helpers to `approval-native-runtime`;
  `buildChannelTurnMediaPayload` → `buildChannelInboundMediaPayload`;
  Find/Grep/Ls tool-result `details` shapes changed.
- 2026.9.4: `buildCredentialSafetyPrompt` string argument deprecated (through
  2026-11-30); untrusted-context aliases still exported but `removal-pending`.
- Plugin capability consent: updates require consent when prior acceptance is
  stale; `plugins enable --accept-capabilities`; provenance warnings require
  `--force` for arbitrary executable sources (official catalog and bundled
  sources are trusted). Plugin icons now packaged at `assets/icon.png` (9.2).
- **Our external plugin** `@teamyou/openclaw-memory` (v0.3.0, last commit
  2026-07-10): the compiled `dist/*.js` imports only
  `openclaw/plugin-sdk/plugin-entry` (`definePluginEntry`), which is still
  exported at 9.4 (`./plugin-sdk/plugin-entry` in `package.json` exports; the
  root `./plugin-sdk` and `./plugin-sdk/compat` exports are gone). The root
  import in `state.ts`/`commands/cli.ts` is `import type` only and is erased
  at build time. So the plugin is **not** blocked by the removed root export,
  but it must be re-verified against 9.4 for: `definePluginEntry` shape,
  `openclaw.plugin.json` manifest fields, capability consent on
  install/enable, `compat.minGatewayVersion`, and the new
  `assets/icon.png` convention. Treat as "verify", not "blocker".
- Related upstream note (`docs/cli/approvals.md`): generated exec-approval
  grants became directory-bound in 2026.8.1; "after upgrading from 2026.7.1
  or earlier, run `openclaw doctor --fix` if the update did not already do
  so" — doctor removes only inactive generated grants.

### 2.5 Official catalog membership changes (manifest regeneration will change)

Diff of `scripts/lib/official-external-*-catalog.json` between the tags:

- Provider catalog 28 → 39: added `@openclaw/baseten-provider`,
  `byteplus`, `comfy`, `mistral`, `novita`, `opencode-go`, `opencode`,
  `synthetic`, `volcengine`, `voyage`, `vydra`, `xiaomi` providers. **Removed
  `@openclaw/codex` from the provider catalog.**
- Plugin catalog 23 → 29: **`@openclaw/codex` now lives here** (kind changes
  from `provider` to `plugin` in our generated manifest), plus
  `duckduckgo-plugin`, `fish-audio-speech`, `mxc-sandbox`, `team-reports`,
  `teams-meetings`, `zoom-meetings`. Removed `@openclaw/pixverse-provider`.
- Channel catalog 26 → 28: added `@openclaw/buzz`, `@openclaw/imessage`,
  `@tencent-connect/openclaw-qqbot`; removed `@openclaw/qqbot` (renamed
  package; upstream migrates "renamed official plugins by their legacy npm
  package name").
- Providers formerly bundled and now separate official packages (8.1): Mistral,
  Cohere, Meta, Voyage embeddings, DuckDuckGo search, iMessage, and the list
  above. "Recover missing configured packages with `openclaw update repair` or
  `openclaw doctor --fix`". Version-bound official plugins are aligned with the
  selected core release during update (9.3).

### 2.6 Retired config keys deadline

- Upstream: run `openclaw doctor --fix` **before 2026-09-18** if config contains
  retired keys; doctor keeps canonical values on conflict and removes no-op
  settings; retired tuning values revert to defaults. Telegram account names
  matching retired tuning-setting names are preserved (9.2).

## 3. Persistence and state: JSON/JSONL → SQLite

Our 7.1 pin already had SQLite for auth profiles and cron jobs. 2026.8.1
finished the move.

### 3.1 Table inventory

`CREATE TABLE IF NOT EXISTS` statements under `src/` went from **80 tables at
7.1 to 211 at 9.4**. Notable additions grouped by concern:

- Sessions/transcripts: `transcript_events`, `transcript_event_identities`,
  `transcript_rewrite_watermarks`, `session_transcript_active_events`,
  `session_transcript_archives`, `session_transcript_index_state`,
  `session_state_events`, `session_state_heads`, `session_conversations`,
  `session_members`, `session_participants`, `session_groups`, `session_windows`,
  `session_progress_cards`, `session_pending_inputs`, `session_watch_cursors`,
  `conversations`, `conversation_deliveries`. Legacy JSONL transcripts are
  migrated and left as `*.jsonl.migrated` / `.pre-doctor-*-repair-*.bak`
  archives; `openclaw update cleanup` removes them.
- Credentials/secrets: `auth_profile_stores` (shared store in the **state**
  DB, `store_key='shared'`), `secret_store_entries` (team/identity-scoped
  shared credential store, write-only values), `mcp_oauth_stores`,
  `mcp_oauth_pending_authorizations`, `worker_environment_credentials`,
  `device_auth_tokens`, `gateway_origin_device_tokens`.
- Gateway lifecycle: `gateway_boot_lifecycle`, `gateway_restart_handoff`,
  `gateway_restart_intent`, `gateway_restart_sentinel`, `managed_update_handoffs`
  (separate `managed-update-handoffs.sqlite`), `update_runs`, `backup_runs`,
  `agent_database_leases`, `agent_databases`, `agent_deletion_journal`,
  `quarantined_databases`, `lock_probe`.
- Config: `config_machine_state`, `config_revision_keys`, `config_health_entries`
  (config change history with writer labels and redaction; manual-edit detection).
- Cron: `cron_run_receipts`, `cron_job_scratch`, `cron_job_runtime_authorities`,
  `cron_store_epochs`, `heartbeat_outcomes`. **Removed `cron_run_logs`.**
- Pairing: `device_pairing_pending`, `device_pairing_paired`,
  `device_pairing_join_codes`, `device_pair_setup_completions`,
  `channel_pairing_requests`, `channel_pairing_allow_entries`. **Removed
  `node_pairing_pending` / `node_pairing_paired`.**
- Approvals/policy: `operator_approvals`, `operator_approval_standing_grants`,
  `operator_approval_execution_identities`, `execution_decision_facts`,
  `exec_approvals_config`, `audit_events`, `audit_identity_keys`.
- Users/profiles: `user_profiles`, `user_profile_emails`,
  `user_profile_identities`, `user_preferences`.
- Memory: `memory_entry_origins`, `memory_index_chunk_provenance`,
  `memory_index_chunk_recall_metadata`, `memory_session_tombstones`.
- Skills: `skill_library_*`, `skill_workshop_*`, `skill_upload_chunks`.
- Cloud/workers: `worker_*`, `node_worker_*`, `projects`, `worktree_*`,
  `workspace_leases`, `workspace_path_aliases`.

### 3.2 Shared auth store relocation (directly hits AlphaClaw writers)

At 9.4, `src/agents/auth-profiles/path-resolve.ts` resolves the shared auth
store by an ownership marker in `config_machine_state` (`state_key =
"auth.sharedStore"`) whose value is `{location: "legacy-main"}` or
`{location: "state-db"}`:

- `legacy-main` → `agents/<sharedMainDir>/agent/openclaw-agent.sqlite`,
  tables `auth_profile_store` / `auth_profile_state` (what our 7.1 code writes).
- `state-db` → `state/openclaw.sqlite`, table `auth_profile_stores`
  (`store_key='shared'`) + `auth_profile_state`.
- Doctor performs the relocation (`shared-auth-store-state-db` migration kind,
  recorded in `migration_sources`); an invalid marker fails with
  `INVALID_SHARED_AUTH_STORE_OWNERSHIP` → `openclaw doctor --fix`.
- Release-note items in this area: "shared credential migration: interrupted
  migrations recover, stranded credentials restored, relocation conflicts
  diagnosed, durable auth order published on a running Gateway" (9.1);
  "prevent stale shared OAuth refresh generations from overwriting newer
  credentials" (9.4); "warn when shared auth profiles still contain plaintext
  that `secrets configure` cannot migrate" (9.3); "CLI and Gateway
  state-directory split-brain is detected before credential writes" (9.1);
  agent auth storage locks via `proper-lockfile` (8.1).
- Legacy `auth-profiles.json` is still recognised as an import source
  (`legacy-source-files.ts`), so our portable export format remains importable.

### 3.3 Schema enforcement and ownership

- Older builds refuse databases written by a newer schema; a Gateway that
  meets a newer schema stops instead of restart-looping (8.1); `gateway stop`
  works even with a newer schema (8.2).
- `openclaw database preflight <copied-state.sqlite> --json` validates a
  consolidated snapshot against a target release before activation; numeric
  `user_version` alone does not prove additive-shape compatibility.
- `openclaw database ownership claim --manager <id>` lets an external
  supervisor claim shared-state writes; after a claim, unmarked writable opens
  fail (see §5).
- SQLite safety: WAL split-brain cleanup fix, rollback journaling on
  virtiofs/9p, snapshot verification in a separate process, quarantine of
  proven-corrupt DBs in a separate store, additive-migration layout validation
  before compaction, `OPENCLAW_SQLITE_LIBRARY` selection for Bun.

### 3.4 Backups upstream

- `openclaw backup create --output <dir> --verify` — portable archive (version,
  source paths, credentials, auth profiles; omits JSONL transcripts and logs).
- `openclaw backup sqlite` — compact global + per-agent snapshots with
  create/list/verify/restore into fresh targets (8.1).
- Scheduled database backups to an operator-owned Git repository with
  versioned snapshots and full-archive restore into a staging dir (8.1);
  NUL-safe, Nix-aware, corrupt-header rejection (9.2); "include required
  external configuration files in full backups", "exclude shared-workspace
  files from state-only backups", tolerate disappearing WAL sidecar after
  snapshot (9.3/9.4).
- Recovery contract: a full recovery point = package version + `openclaw.json`
  (incl. `meta.lastTouchedVersion`) + `state/openclaw.sqlite` + every
  `agents/<id>/agent/openclaw-agent.sqlite` + workspaces/credentials + retained
  originals. Never copy a live `.sqlite` without its `-wal`.

## 4. Update, doctor, and recovery machinery

- `openclaw update` now: validates target, runs Doctor migrations, rehearses
  core+plugin changes in isolated candidate state (9.3), verifies the activated
  Gateway (service ownership, health, version/build identity, plugin
  activation, channel readiness, HTTP readiness — no model call), rolls back the
  npm candidate when post-update Doctor fails (9.1), and from 9.4 restores the
  previous package/shim/service/config automatically when schema-neutral.
  Blockers: config changed after Doctor pass, any schema version change,
  unknown new DBs, pending checkpoint-recovery record.
- `openclaw update cleanup [--dry-run]` removes retained migration originals
  (gives up rollback). `openclaw update repair` recovers missing configured
  official plugins. `openclaw triage [--run|--non-interactive]` hands a failed
  update to a coding agent (Claude Code, Codex, OpenCode, Pi). Bounded
  unattended repair uses the system-agent owner's model (3 turns / 10 min).
- Doctor: "apply safe doctor configuration migrations at Gateway startup"
  (8.1); Doctor acquires ownership before DB inspection and applies
  noninteractive repairs (9.3); refuses store rewrites another process
  committed after its snapshot (9.1); preserves authored config, env and
  secret references, omitted defaults, and routes edits to the owning include
  (9.3); releases its DB handles before restart (8.2); the updater controls
  restarts through Doctor (8.2); `doctor --lint --all`; state isolation across
  `OPENCLAW_STATE_DIR` (8.1).
- Auto-update controls: `OPENCLAW_NO_AUTO_UPDATE=1`,
  `OPENCLAW_DISABLE_UPDATE_CHECK` (new env), `openclaw telemetry show`,
  opt-in feature statistics (default off), saved update channel authoritative
  after a one-off tag; unattended installation requires a managed Gateway
  service.
- Node compatibility is checked during CLI updates; unsafe candidates stop
  while leaving the previous CLI runnable.

## 5. Gateway lifecycle and external supervision (directly hits AlphaClaw)

- `OPENCLAW_SUPERVISOR_MODE=external` (8.1; docs
  `docs/cli/gateway/restart-and-supervision.md`): another process manager owns
  the Gateway lifecycle. In this mode native service install/start/stop/
  uninstall are refused, self-update is refused, `openclaw gateway restart`
  targets the verified running Gateway, and a fresh-process restart writes a
  bounded SQLite handoff (`gateway_restart_handoff`) before clean exit, falling
  back to in-process restart if persistence fails.
- Handoff contract for supervisors: `openclaw gateway restart-handoff
  capabilities --json` and `... consume --expected-pid <pid> --json`
  (protocol v1; exit 0 for valid machine requests, 2 invalid pid, 1 store
  unavailable). Report success only after the new Gateway owns its listener
  and `/startupz` returns `status: "started"`; `/readyz` for channel health;
  `/healthz` is liveness only.
- `OPENCLAW_SERVICE_REPAIR_POLICY=external` is a separate Doctor repair policy.
- Ownership claim: `OPENCLAW_SUPERVISOR_MODE=external openclaw database
  ownership claim --manager gateway-supervisor --json` — only after every
  writer (CLI, Doctor, updater) is ≥ 2026.8.1 and carries the env var.
- In-process restarts: stale SIGUSR1 restart state cleared (8.1); restart
  drains admitted process trees; "Gateway restarting…" surfaced to chat;
  restart recovery of admitted turns is SQLite-owned and replay-safe (8.1
  beta.4 → 8.1); replies survive restarts (9.2).
- Startup: "require actual Gateway protocol readiness before declaring setup
  complete" (8.2); malformed legacy cron rows quarantined at boot; migration
  warnings degrade instead of refusing to start (9.1); stop restart loops when
  migration blocks startup (9.3); `OPENCLAW_CONFIG_READONLY=1` (9.4) makes
  `openclaw.json` immutable for Gateway and CLI (blocks setup, onboarding,
  doctor repairs, plugin changes, mutating update flows; runtime state still
  writable).
- Service: supported service repairs preserve state dir, config path, port,
  managed env and file-backed credentials; intentional changes need
  `openclaw gateway install --force`; systemd unit backups no longer leak the
  Gateway token (9.1); Linux user-scope systemd publication refused when the
  unit is system-owned (8.1); Tailscale claims released only after the owning
  process group exits (9.3); "tailscale-managed ingress recovers after
  upgrades" (9.1).
- Gateway protocol: **still v4** (`MIN_CLIENT_PROTOCOL_VERSION = 4`,
  nodes/probes accepted at v3). `hello-ok` gained additive `pluginSurfaceUrls`,
  `controlUiTabs`, multi `deviceTokens`. Control-plane rate limit: per-method
  buckets, 30/min (8.1). Device proofs use Gateway challenge timestamps (clock
  skew fix, 8.1).

## 6. Onboarding, agents, and Gateway auth

- Guided onboarding through Custodian (structured option cards); quick-start
  lane for fresh installs incl. `npx openclaw@latest` that detects existing
  Claude Code / Codex logins and API keys, verifies them live, and opens the
  web dashboard from a foreground Gateway (9.1); full wizard remains "Custom
  setup".
- `openclaw onboard` flags: `--agent-name`, `--skip-ui` (stays on guided
  path), `--skip-bootstrap` (still writes identity files), `--json` (one
  consolidated result on failure), `--import-from` (Claude/Codex/Hermes),
  `--gateway-bind` with `customBindHost`. Invalid provider/auth/gateway/
  workspace combinations are rejected before any write; concurrent setup is
  detected and fails fast naming the holder; automation must inspect reported
  health rather than exit status.
- Named agents: first agent can be named; legacy main-session history migrates
  to its owner; `main` is reusable as an ordinary agent id after doctor repair;
  named agents retain credential ownership through configuration-only resets;
  "retain original default agent when automatically migrating a legacy
  multi-agent roster" (9.2); "recover markerless multi-agent configurations"
  (9.4).
- Gateway secret: one secret field in Control UI/remote onboarding; a local
  Gateway token is generated by default (9.3); new env
  `OPENCLAW_GATEWAY_AUTH_TOKEN` / `OPENCLAW_GATEWAY_AUTH_PASSWORD` /
  `OPENCLAW_REMOTE_GATEWAY_PASSWORD`; placeholder Gateway tokens are rejected
  or repaired (9.3); safe Gateway token recovery for onboarding.
- Model setup: verifies the exact model+credential can answer before keeping
  it; provider plugins install alongside first-agent creation; Model Setup
  shows account vs API-key access with runtime-reported email for Codex and
  Claude candidates (9.1); provider detection is passive until the user picks
  a route (9.3).
- Memory imports from Claude Code, Codex, Hermes during onboarding.

## 7. Credentials and secrets (overlaps Agent Vault brokering)

- Shared credential store: team-scoped secret and environment entries in
  SQLite (`secret_store_entries`) managed via CLI and Settings; secret values
  are write-only; "bind protected egress to declared hosts"; readable
  environment values distinguished from secrets (8.1).
- Private credential requests: the agent can request a credential through a
  masked prompt without the value entering chat or model context; **opt-in
  proxy limits protected-secret substitution to approved destinations**
  (8.1, #132122). Protected credential egress: proxy connections, upstream
  requests and bypass tunnels are closed when the run ends; protected
  subprocess values stay sealed.
- SecretRefs: provider SecretRefs kept distinct from resolved bytes through
  model preparation and catalog discovery, incl. file- or exec-backed auth
  profiles (8.1); channel tokens typed `SecretInput = string | SecretRef`
  (Telegram `botToken`, 8.2); Gateway command SecretRefs; custom provider
  SecretRefs survive Doctor; "ignore missing optional secret-backed command
  environment values" (8.2); `secrets configure` migration warning for
  plaintext (9.3).
- Optional 1Password broker with per-secret approval and value-free audit.
- Personal connected accounts (per-user provider accounts), agent-specific
  provider accounts in Control UI, provider account priority (9.2/9.3),
  "My GitHub" personal account (9.1).
- OAuth: cross-agent per-profile OAuth refresh coordination lock; stale shared
  OAuth refresh generations cannot overwrite newer credentials (9.4); OAuth MCP
  token refresh for CLI agents (9.2); Chutes/xAI OAuth handling.
- Redaction: `config.get` never returns unredacted pre-migration snapshots;
  service-control subprocesses no longer receive application credentials
  (9.3); Codex tool text redaction of credential-shaped strings (9.3).

## 8. Models and model configuration

- Model refs: OpenAI route migration (§2.2); `openai/gpt-5.6-sol` default for
  fresh OpenAI setup; GPT-5.6 Sol/Terra/Luna/Ultra reasoning; GPT-6 Astra
  (`openai/gpt-6-astra`, 9.2) with `/think ultra`; Anthropic Fable 5.1 from
  shared model metadata (9.1); GPT Image 2.5 (9.4); Qwen 3.8, DeepSeek V4,
  Nemotron 3.5, GLM-5.3, Grok 4.3/4.5 aliases; DeepSeek compatibility names
  retired 2026-07-24.
- Policy: explicit `modelPolicy.allow` allowlists separate from aliases and
  per-model settings, per-agent policies, provider wildcards; doctor migrates
  valid legacy restrictions without silently opening access (8.1).
- Selection scopes: model change can target this session, its agent, or the
  shared default; remembered selection; Telegram callback picks stay
  session-only (8.1/8.1-beta.4).
- Live model discovery from providers instead of relying solely on built-in
  catalog snapshots (8.1); catalogs refresh after auth/config changes without
  restart (9.1); "retain discovered inventories after failed refreshes",
  "defer downloaded catalog changes until restart" (9.3); `openclaw models`
  shows SuperGrok usage; `models status --check`.
- Per-model: Code Mode per model (8.1), OpenAI long-context opt-in (explicit
  model configuration choice), Anthropic server-side compaction opt-in, xAI
  native compaction, utility-model defaults (provider-declared small model),
  `model.fallbacks` picker (9.3), thinking levels aligned with prepared
  model/provider policy incl. native Ultra.
- Runtimes: managed Codex runtime bumped repeatedly (0.149.1 → 0.150.1 →
  0.151.0 → 0.152.1); Codex approvals durable for MCP tools (9.1); Claude CLI
  context budgets passed to Claude Code's compactor; CLI-backend model choices
  preserved; "Model Setup no longer leaves a stale claude-cli key after Claude
  CLI activation" (9.1); CLI agents shown in the picker by default, disable with
  `gateway.cliAgents.enabled: false` (9.3).

## 9. Default-behaviour changes with cost or safety impact on managed hosts

Each of these changes what an untouched config does after upgrade.

| Change | Version | Default |
| --- | --- | --- |
| Grounded dreaming (model-backed background memory consolidation, Dream Diary) | 8.1 | **On** (explicit disable control) |
| Automatic self-learning: capture lessons, auto-apply scanner-approved skills | 8.1 | **On** (user-authored changes stay pending) |
| Personal conversation recall with Active Memory on personal installs | 8.1 | On unless DM isolation configured |
| Session reset policy when none configured | 8.1 | Never reset (was daily/idle) |
| Foreground agent concurrency | 8.1 | CPU-scaled, 8–16 simultaneous runs |
| Ambient heartbeat delivery | 8.1 | To resolvable owner DM; unroutable polls skipped |
| Session visibility for unsandboxed sessions | 8.2 | Same-agent sessions (`tools.sessions.visibility` `tree`/`self` to narrow) |
| Cross-agent session tools | 9.2 | All-session visibility, agent-to-agent enabled (`agent`/`self` to narrow) |
| Experimental Swarm | 9.2 | **Enabled** |
| Recursive delegation (bounded) | 9.3 | Enabled |
| CLI agents in new-session picker | 9.3 | Shown |
| Skill Workshop approvals for agent-initiated apply/reject/quarantine | 8.1 | No extra prompt (`skills.workshop.approvalPolicy: "pending"` to gate) |
| Skill Workshop ownership | 9.3 | One writable collection per agent; `skills.workshop.allowSymlinkTargetWrites` retired |
| Active-session cap | 9.3 | 5,000 |
| Feature statistics | 8.1 | Off (opt-in) |
| Gateway token generation | 9.3 | Local token generated by default |
| Automations created with session context | 8.1 | Bound to originating conversation |
| Plugin install from arbitrary executable sources | 8.1 | Requires `--force` |

Each row is a candidate for an explicit managed-config default in AlphaClaw's
onboarding (Phase 3 decides which).

Config keys located so far in the 9.4 configuration reference for these rows:
`dreaming.model` / `dreaming.frequency` (dreaming), `tools.swarm.enabled`
(Swarm), `tools.sessions.visibility` (session visibility),
`agents.defaults.maxConcurrent` and `subagents.maxConcurrent` (concurrency),
`session.reset.*` / `sessions.reset` (reset policy), `agents.defaults.heartbeat`
and `agents.entries.*.heartbeat` (heartbeat), `gateway.cliAgents.enabled`,
`telemetry.enabled`, `agents.defaults.modelPolicy.allow`. The self-learning,
personal-recall, and recursive-delegation keys were not found in that file and
must be located in Phase 2 (likely under `skills.workshop.*`, active-memory,
and `subagents.*`).

## 10. Configuration surface changes

- New/changed keys seen in notes: `agents.defaults.cwd` and per-agent `cwd`,
  global `worktreeRoot`, `cron.skipMissedJobs`, SSRF `blockedHostnames`,
  `channels.<id>.enabled: false` now prevents loading the plugin (9.1),
  `tools.sessions.visibility`, `gateway.cliAgents.enabled`,
  `skills.workshop.approvalPolicy`, `cloudWorkers.profiles.<id>.readyWorkers`,
  `cloudWorkers.preparedPool.maxTotal`, `mcp.sessionIdleTtlMs`,
  `modelPolicy.allow`, `permissionMode` replacing `execSecurity`/`execAsk`
  in session patches, `meta.lastTouchedVersion`.
- Config CLI: `config set --dry-run`, `--expect-current-json`,
  `--expect-current-absent`, `--strict-json`; `config patch --file`; config
  change history with writer labels and manual-edit detection; strict
  validation now fails closed on malformed top-level scalars and unparseable
  files (preserved, doctor stops with actionable error).
- Config writes: committed writes stay pending through watcher handoff so
  same-write reloads settle (8.1-beta.4); "keep newer configuration: migrate a
  readable active configuration before considering last-known-good recovery"
  (8.2); concurrent first saves preserved; more settings hot-reload through
  their running owners (9.2); "route supported edits to their owning include"
  (9.3).
- Web request customization: operator request headers for `web_fetch` and
  Gemini web search (for controlled gateways) — relevant to egress mediation.

## 11. Cron and automations

- Store: `cron_jobs` remains; run history moved from `cron_run_logs` to
  `cron_run_receipts` (terminal retention 64/job); `cron_job_scratch`,
  `cron_job_runtime_authorities`, `cron_store_epochs`, `heartbeat_outcomes`.
- Behaviour: conversation-bound automations; owner-only `/loop`; approve
  recurring work once via standing grants (inspect/revoke; fresh approval when
  job changes); `cron.skipMissedJobs`; malformed legacy rows quarantined at
  boot (9.1); legacy rows keep enabled state and delivery intent (9.1); jobs
  created with configured Codex app-server auth; Doctor refuses store rewrites
  another process committed after its snapshot; "avoid needless
  schedule-repair writes"; `cron` JSON output complete when piped (8.2);
  heartbeat jobs report actual outcome; `NO_REPLY` preserved; one-shot retries
  survive startup recovery.

## 12. Channels and pairing

- Pairing tables renamed (`node_pairing_*` → `device_pairing_*`); channel
  pairing requests/allow entries now in SQLite; pairing requests bound to the
  correct channel/account (9.3); Control UI/WebChat trusted-proxy device
  enrolment with scope caps.
- `channels add/login/logout/remove/resolve --agent`; renamed official plugins
  migrate by legacy npm name; explicitly disabled manifest accounts omitted;
  channel account SecretRefs; shared durable ingress monitors for channel
  plugins; Telegram Bot API 10.2 rich mode (opt-in), Telegram Mini App
  `/dashboard`, photo albums; Discord/Slack native `/login`; Slack Enterprise
  Grid; iMessage now an official separate plugin; WhatsApp stays external (our
  fleet has it shelved and denied).

## 13. Memory

- Memory Core startup repair no longer traps the Gateway in a restart loop
  (7.1-1, i.e. fixed after our pin); keyword search stays available when
  embeddings cannot start; batched scan when SQLite extensions unavailable
  (9.3); `openclaw memory reset` rebuilds derived indexes; `openclaw memory
  forget` removes derived memory while keeping transcripts; memory ownership
  and provenance; dreaming (see §9); LanceDB fixes; managed local embeddings
  via llama.cpp; "per-agent memory search survives Doctor" (9.1).

## 14. Control UI (input to Phase 5)

The Control UI (`ui/src`, ~3,400 files changed) is now a full product surface:
guided first-run setup (Custodian) that continues into model setup and channel
setup; Model Setup with provider accounts/priority/fallback picker; unified
Plugins workspace with ClawHub discovery and install (9.4); Settings covering
agents, models, tools, channels, browser, nodes, access, terminal with
hot-reload; config Form/Raw editor with drafts; Devices page with aliases and
resource meters; Sessions with search, branches/rewind, sharing/visibility,
groups by project, public read-only publish (9.3); dashboards/widgets/MCP apps;
Workboard, Goals, Inbox mentions; Skills, Skill Workshop, personal skill
libraries; Memory pages; Meetings library; Usage panel; Activity; Team
operator roles and shared profiles; appearance themes and fonts; PWA
notifications; Mermaid rendering; browser panel with live tabs; terminal
sharing/uploads; "A new version is available" reload flow; update recovery
actions; incognito threads; Telegram Mini App; experimental plugin-contributed
UI pages (9.2, Labs). Operator scopes gate write actions; read-only browsing
remains for limited credentials.

## 15. Things that did not change (verified)

- Gateway wire protocol version (v4) and `minProtocol`/`maxProtocol`
  negotiation (AlphaClaw `lib/server/chat-ws.js` pins `kGatewayProtocolVersion`).
- `openclaw.json` remains the config file; `state/openclaw.sqlite` and
  `agents/<id>/agent/openclaw-agent.sqlite` remain the DB paths.
- Legacy `auth-profiles.json` and `cron/jobs.json` remain importable by doctor.
- `openclaw doctor --non-interactive --fix` remains the unattended repair entry
  point (our watchdog contract), now with more startup-time auto-migration.

## 16. Open questions for Phase 2 (code deep-dives)

1. Exact doctor migration path 7.1 → 9.4 for: OpenAI routes, shared auth store
   relocation, session JSONL → SQLite, cron run logs, pairing tables, plugin
   registry, multi-agent roster. Is a direct jump supported, or must we step
   through 8.1 (the 9.x notes mention "support eligible 2026.9.2 migrations"
   and "npm upgrades from 2026.9.1" specifically)?
2. Whether `openclaw/plugin-sdk` root import truly fails to load at 9.4 (docs
   say removed) and what `plugin-entry` became — for `@teamyou/openclaw-memory`.
3. Which of §9's defaults AlphaClaw's managed onboarding must pin, and the
   exact config keys for each.
4. How `OPENCLAW_SUPERVISOR_MODE=external` interacts with our systemd unit,
   `alphaclaw openclaw-doctor-guard`, the in-process SIGUSR1 restart path, and
   `openclaw gateway restart`.
5. The `auth.sharedStore` marker lifecycle: does a fresh 9.4 onboard write
   `state-db` immediately, and what happens if AlphaClaw writes
   `auth_profile_store` in the main agent DB after relocation?
6. How the protected-secret proxy (#132122) and the shared credential store
   relate to the Agent Vault placeholder substitution and loopback proxy shim —
   overlap, conflict, or replacement.
7. `hello-ok` additive fields and the Control UI asset serving path
   (encoded/symlinked assets, 304 handling) for the AlphaClaw gateway proxy.
8. Model catalog: whether `model-catalog-bootstrap.json` generation still
   matches the 9.4 catalog shape given live discovery and provider split-out.
