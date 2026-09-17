# OpenClaw 2026.9.4 — code deep-dives (Phase 2)

Status: **draft for Bill's review.** Companion to
[`01-change-inventory.md`](01-change-inventory.md). Each section answers one
of the Phase 1 open questions by reading the `v2026.9.4` tree in the local
`openclaw` checkout. Line references are to that tag.

## D1. What migrates automatically at Gateway startup vs only under `doctor --fix`

`src/infra/state-migrations.doctor.ts` declares the legacy-state migration
layout as `[id, phase, scope]` tuples (around line 930). Scope semantics
(line ~1037): `all` runs in both modes; `automatic` runs only at startup;
`doctor` only under an explicit Doctor run; `doctor-agent` only under Doctor
and only when agent-scoped migrations are not skipped; `agent` in both modes
unless agent-scoped migrations are skipped.

| Step id | Phase | Scope | Notes |
| --- | --- | --- | --- |
| device-auth, device-identity, meeting-transcripts, managed-worktrees, **shared-auth-store**, plugin-state-sidecar, debug-proxy-capture, task-state-sidecars, delivery-queues, voice-wake, update-check, config-health, plugin-binding-approvals, current-conversation-bindings | shared | all | Registered for both modes. For `shared-auth-store`, the module comment in `state-migrations.shared-auth-store.ts` says relocation is "detected only in the explicit Doctor repair path" and is "Doctor-owned staged relocation" — so registration is `all` but detection is Doctor-gated. Must be confirmed empirically (see test plan). |
| tui-last-session, commitments, audit-logs, acp-replay-ledger, managed-outgoing-images, apns-registrations, **exec-approvals**, **mcp-oauth**, web-push, node-host, subagent-registry, rescue-pending, plugin-doctor-post-session-state | final | doctor | Doctor only. |
| restart-sentinel, workspace-state, skill-workshop, channel-pairing, plugin-doctor-state | final | all | |
| **sessions** (JSONL → SQLite transcripts) | final | doctor-agent | **Doctor only.** A 9.4 Gateway booted on a 7.1 state dir does not convert session JSONL by itself; `openclaw update` does it because it runs Doctor. |
| legacy-main-session-keys | final | automatic | Startup only. Arms only when the legacy agent id (`main`) is absent from the roster (`legacy-main-session-migration.ts` `resolveArmingDecision`). Our fleet keeps `main`, so it stays un-armed and `agent:main:main` remains canonical. |
| acp-session-metadata | final | doctor-agent | |
| agent-dir | final | agent | |

Additional automatic work at startup: `doctor-config-preflight.ts` runs
`autoMigrateLegacyStateDir` (state-dir relocation) and `autoMigrateLegacyState`
in `automatic` mode, plus state-schema (`user_version`) upgrades inside the
schema transaction — e.g. `cron_run_logs` → task ledger import runs "inside
the state schema transaction and removes the retired table"
(`state-migrations.cron-run-logs.ts`). Startup migrations are refused when a
live Gateway already owns the state dir
(`doctor-startup-migration-refusal.ts`, exit code 78).

**Consequence for AlphaClaw:** a bare `npm install openclaw@2026.9.4` +
restart (our manual install path) leaves sessions, exec-approvals, MCP OAuth
and the other `doctor` scoped steps un-migrated until something runs
`openclaw doctor --fix`. Today that "something" is the watchdog's guarded
`openclaw doctor --non-interactive --fix` on repair, i.e. it would happen
lazily and possibly under a failure condition. The upgrade plan must make it
an explicit, Gateway-stopped step.

## D2. Shared auth store relocation

- Resolution (`src/agents/auth-profiles/path-resolve.ts:116-121`): if the
  ownership marker `config_machine_state[state_key="auth.sharedStore"]` is
  `{location:"state-db"}`, the shared store is `state/openclaw.sqlite`
  (`auth_profile_stores`, `store_key='shared'`); otherwise (`legacy-main` or
  absent) it is `agents/<sharedMainDir>/agent/openclaw-agent.sqlite`
  (`auth_profile_store` + `auth_profile_state`, `store_key='primary'`).
- Writers of `state-db`: `shared-store-bootstrap.ts:201` (bootstrap of a
  fresh store), `state-migrations.shared-auth-store.ts:407/428` (Doctor
  relocation, migration kind `shared-auth-store-state-db`), and
  `auth-profiles/sqlite.ts:75`.
- An invalid marker throws `INVALID_SHARED_AUTH_STORE_OWNERSHIP` with action
  `openclaw doctor --fix`. Ownership is cached per state root for the process
  lifetime; "later row changes require an owner-controlled restart".
- Legacy `auth-profiles.json` remains an import source
  (`legacy-source-files.ts`), migration kind `auth-profile-json-to-sqlite-v2`,
  and `doctor-auth-flat-profiles.ts` still knows `auth_profile_store`.
- Related Doctor repairs in `doctor-auth.ts`: `maybeMigrateAuthProfileJsonStoresToSqlite`,
  `maybeRepairOpenAICodexAuthConfig` (canonicalises retired provider/profile
  ids; `LEGACY_OPENAI_CODEX_PROVIDER_ID = "openai-codex"`),
  `maybeRepairLegacyAuthProfileStores`, `collectOpenAICodexAuthProfileStoreIdMap`.

**Open (needs empirical test):** does a *fresh* 9.4 onboard write
`state-db` immediately? If yes, fresh provisions and upgraded instances will
have different auth-store locations until Doctor relocates the latter. Any
AlphaClaw writer must resolve the location through the marker rather than
assuming the per-agent DB.

## D3. OpenAI / Codex route migration

`src/commands/doctor/shared/legacy-config-migrations.runtime.models.codex.ts`
and `doctor/shared/codex-route-warnings.ts`:

- Moves `models.providers.codex` / `models.providers.openai-codex` into
  `models.providers.openai` (merging model lists; refuses when model
  definitions collide or provider-level defaults cannot be represented, and
  emits an exact-repair warning instead).
- Rewrites `models.providers.<id>.api` and per-model `api` from
  `openai-codex-responses` to the canonical OpenAI ChatGPT Responses api id.
- Preserves runtime intent: a legacy `agentRuntime` on the codex provider is
  moved onto the merged models as `agentRuntime: { id: "codex" }`
  (`resolveMovedCodexModelRuntime`), so "Codex runtime" survives as a
  per-model runtime policy rather than a provider.
- `MODEL_REF_CANONICALIZATION_RULES` scan the `agents`, `plugins`, `messages`,
  `tools`, `hooks`, `channels`, `models` sections for known legacy refs and
  rewrite `codex/*` and `openai-codex/*` to `openai/*`.
- Warnings: legacy refs, runtime pins, compaction overrides, priority
  service-tier params that Doctor cannot migrate without changing behaviour
  ("set the affected route's `agentRuntime.id` to `"openclaw"`").
- Stored sessions and automation routes are migrated by the corresponding
  Doctor state steps (see release note); 9.4 tolerates "implicit Codex
  preferences when the plugin is absent".

**Consequence for AlphaClaw:** the "flexible Pi route" that writes
`openai-codex/*` model keys and the Codex runtime selection that writes
`models.providers.openai.agentRuntime.id: "codex"` (see
`docs/fork-deviations.md`) must be re-expressed: canonical `openai/*` keys
everywhere, runtime choice as a per-model `agentRuntime`, and the
`model-catalog-support.json` / `model-config.js` / `openclaw-thinking.js`
tables updated. Anything AlphaClaw writes after Doctor has run must already be
in the canonical form or Doctor will keep re-flagging it.

### D3a. The Codex plugin is no longer a provider

`scripts/lib/official-external-plugin-catalog.json` at 9.4 lists
`@openclaw/codex` with `kind: "plugin"`, plugin id `codex`, and **no
`providers` array**; at 7.1 the same package sat in the provider catalog with
provider id `codex` and an `app-server` auth choice. Our generated
`lib/openclaw-compatibility.manifest.json` still records `codex` as
`kind: "provider"` with `providerIds: ["codex"]`. After regeneration the entry
flips to `kind: "plugin"` with no provider ids, and any reconciler or UI logic
that keys Codex on a provider id (rather than the plugin id) must change.

## D4. External supervisor mode

`src/infra/gateway-supervision.ts`: `isGatewayExternallySupervised()` is a
pure env check (`OPENCLAW_SUPERVISOR_MODE=external`). Callers (non-test):

| Area | Files | Effect when external |
| --- | --- | --- |
| Native service lifecycle | `cli/daemon-cli/lifecycle.ts` (8 sites), `daemon/service.ts`, `cli/daemon-cli/register-service-commands.ts`, `start-repair.ts`, `status.gather.ts` | install/start/stop/uninstall refused with "use that supervisor"; status reports external ownership |
| Self-update | `cli/update-cli/update-command-run.ts`, `update-command-service-plan.ts`, `infra/update-startup.ts`, `gateway/server-methods/update.ts:341` | `openclaw update` and the **Control UI update button** return `skipped` / `external-supervisor-update-required` |
| Doctor service repair | `commands/doctor-service-repair-policy.ts` | service repair policy honours external (`OPENCLAW_SERVICE_REPAIR_POLICY=external` is the separate knob) |
| State ownership | `state/openclaw-state-ownership*.ts`, `state/openclaw-agent-db.ts` | ownership claim/enforcement messages; writable opens after a claim require the env var |
| Transcript reconcile worker | `config/sessions/session-transcript-reconcile*.ts` | passes the marker through to workers |
| Triage / setup finalize | `commands/triage-failure.ts`, `wizard/setup.finalize.ts` | guidance text |
| Diagnostics | `infra/supervisor-markers.ts` | `OPENCLAW_SUPERVISOR_MODE` counts as a "respawn supervisor" hint alongside `OPENCLAW_SYSTEMD_UNIT`, `INVOCATION_ID`, `JOURNAL_STREAM` |

Restart contract: the running Gateway writes a `gateway_restart_handoff` row
before a clean exit; a supervisor consumes it with
`openclaw gateway restart-handoff consume --expected-pid <pid> --json`
(protocol v1). Readiness must be judged by `/startupz` (`status: "started"`),
channel health by `/readyz`, liveness by `/healthz`.

**Consequence for AlphaClaw:** AlphaClaw already is the supervisor (systemd
unit + watchdog + in-process restart). Setting the env var would (a) make the
Control UI's own update button and `openclaw update` refuse — which is what we
want on managed instances, and (b) require the watchdog to honour the handoff
contract on restarts, and (c) let us claim state ownership so stray CLI
processes cannot write the shared DB. Not setting it leaves the Control UI
offering self-updates that managed instances must not run. Decision item for
Phase 6.

## D5. `openclaw models list` now prefers the Gateway

`src/commands/models/list.list-command.ts` (9.4): when an implicit local
Gateway target is running (lock identity readable) or `OPENCLAW_GATEWAY_PORT`
is set, the command calls Gateway method `models.list` (capability
`PUBLISHED_MODEL_CATALOG`) and never falls back. Otherwise it prints
"Gateway is not running. Showing the local cached model catalog. Use
--refresh to discover provider models." and serves the local prepared
catalog read-only; `--refresh` performs provider discovery.

**Consequence for AlphaClaw:** `scripts/generate-model-catalog-bootstrap.mjs`
runs `models list --provider <p> --all --json` in a temp `OPENCLAW_STATE_DIR`
with no Gateway. On 9.4 that returns the local cached catalog of an empty
state dir; live-discovery providers will be missing unless `--refresh` is
passed (which then needs credentials for discovery-only providers) or the
bootstrap relies on the bundled catalog snapshot. The generator, the
`model-catalog-bootstrap.json` schema (`accessModes`, `supportSpec`,
`compatibilityManifest`), and the runtime `model-catalog-cache.js` refresh
path all need re-validation against the new row shape (`result.models`,
`providerOutcomes`).

## D6. Node runtime

Verified at both tags: engines `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`
(7.1) → `>=24.16.0 <25 || >=26.1.0` (9.4). clawctl host assets
(`assets/host/lib/node-runtime.sh`) accept 22.22.3+/24.15+/25.9+ and install
NodeSource `NODE_MAJOR=24`; AlphaClaw `lib/runtime/node-sqlite-safety.js`
mirrors the 7.1 ranges. 9.4 adds a self re-exec under a supported runtime and
CLI-side Node update offers, but on our hosts Node is clawctl-owned.

## D7. Gateway protocol

`packages/gateway-protocol/CHANGELOG.md`: protocol v4 since 2026-05-07;
`MIN_CLIENT_PROTOCOL_VERSION = 4`, nodes/probes accepted at v3 (added
2026-07-06). Additive `hello-ok` fields since 7.1: `pluginSurfaceUrls`,
`controlUiTabs`, multi `deviceTokens`. Deferred (not shipped) breaking change:
removal of `execSecurity`/`execAsk` from `SessionsPatchMutation` in favour of
`permissionMode`. AlphaClaw `lib/server/chat-ws.js` negotiates
`minProtocol`/`maxProtocol` = `kGatewayProtocolVersion` — no change needed if
that constant is 4; confirm in Phase 3.

## D8. Config keys behind the changed defaults (§9 of the inventory)

| Behaviour | Key | Default at 9.4 | Source |
| --- | --- | --- | --- |
| Dreaming | `plugins.entries.memory-core.config.dreaming.enabled` | `true` | `docs/concepts/dreaming.md:14` |
| Self-learning | `skills.workshop.autonomous.mode` (`off`/`propose`/`auto`) | `"auto"` | `docs/tools/self-learning.md:282` |
| Workshop approvals | `skills.workshop.approvalPolicy` | not `pending` (no prompt) | release note 8.1 |
| Swarm | `tools.swarm.enabled` | `true` (9.2) | docs grep |
| Session visibility | `tools.sessions.visibility` (`all`/`agent`/`tree`/`self`) | `all` (9.2) | release note |
| Recursive delegation | `subagents.maxSpawnDepth` (+ `maxChildrenPerAgent`) | depth `5` | `docs/tools/subagents/nesting.md:12` |
| Concurrency | `agents.defaults.maxConcurrent`, `subagents.maxConcurrent` | CPU-scaled 8–16 | release note 8.1 |
| Session reset | `session.reset.*` / `sessions.reset` | none configured → never reset | release note 8.1 |
| Personal recall | `agents.entries.<id>.memory.search.rememberAcrossConversations` (explicit `true`/`false` wins); defaults on only when `session.dmScope` is unset or `"main"` and no binding overrides it; deep-recall mode in the active-memory plugin `config.mode` (`escalate`/`always`/`off`) | on for personal installs | `docs/concepts/active-memory/enabling.md:10-28`, `configuration.md` |
| Heartbeat routing | `agents.defaults.heartbeat`, `agents.entries.*.heartbeat` | owner DM | release note 8.1 |
| CLI agents in picker | `gateway.cliAgents.enabled` | `true` (9.3) | release note |
| Telemetry | `telemetry.enabled` | off | release note 8.1 |
| Model allowlist | `agents.defaults.modelPolicy.allow`, `agents.entries.*.modelPolicy.allow` | none | release note 8.1 |
| Update checks | env `OPENCLAW_DISABLE_UPDATE_CHECK`, `OPENCLAW_NO_AUTO_UPDATE` | — | docs |
| Config immutability | env `OPENCLAW_CONFIG_READONLY=1` | off | `docs/cli/config.md` |

## D9. Control UI page inventory (input to Phase 5)

`ui/src/pages/` directories:

- 7.1: activity, agents, channels, chat, config, cron, debug, dreams,
  instances, logs, nodes, overview, plugin, sessions, skill-workshop, skills,
  tasks, usage, workboard, worktrees.
- 9.4 adds: about, approval(s), apps, cloud-workers, connection, custodian,
  dashboards, device(s), labs, lobsterdex, meetings, memory-import,
  model-providers, model-setup, new-session, plugins (hub), portals, profile,
  question, secrets. Removed as top-level: dreams (now under Settings →
  Memory), instances, nodes (→ devices), overview.
- Settings (`pages/config/`) sections at 9.4 include: MCP, meeting capture,
  memory (overview/defaults/dreaming/memories), notifications, security,
  session observer, setup, talk, updates, appearance (incl. custom theme
  import), language.
- Sidebar model (`ui/src/app-navigation.ts`): a user-customisable zone
  defaulting to `dashboards`, `cron`, `plugins`; everything else under
  "More"; Settings/Docs in the footer; Skills and Skill Workshop live inside
  the Plugins hub; Worktrees inside the Sessions hub.

## D10. Plugin SDK for `@teamyou/openclaw-memory`

Verified: `dist/index.js` imports only `openclaw/plugin-sdk/plugin-entry`
(`definePluginEntry`), still exported at 9.4 (338 `plugin-sdk/*` subpaths;
root and `compat` removed). `state.ts` and `commands/cli.ts` use
`import type` from the root, erased at build. Remaining verification: the
`OpenClawPluginApi` surface used (`api.on("gateway_start")`, `api.logger`,
tool registration, CLI registration), manifest fields in
`openclaw.plugin.json`, capability consent on enable, and the
`compat.minGatewayVersion` floor. `plugin-entry` exports at 9.4 should be
diffed against the 7.1 signature before any release.

## D11. Items still open after Phase 2

- Empirical confirmation of D1/D2 on a disposable host: boot 9.4 on a copied
  7.1 state dir, observe which migrations run at startup, then run
  `openclaw doctor --non-interactive --fix` and diff `migration_runs`.
- Whether `openclaw update` (rather than npm install + doctor) is the right
  managed-install path now that it rehearses, verifies, and rolls back — and
  how that coexists with `OPENCLAW_SUPERVISOR_MODE=external`, which refuses
  self-update.
- The protected-secret proxy (#132122) internals vs the Agent Vault proxy
  shim: not yet read; needs a dedicated pass over `src/infra/secrets*` and
  `src/agents/credential-*` once the touchpoint matrix names our exact
  interception points.

## D12. Retired config keys that `doctor --fix` rewrites (deadline 2026-09-18)

Extracted from `src/commands/doctor/shared/legacy-config-migrations.*.ts` at
9.4 (rules with a stated message; section-wide normalization rules omitted):

| Legacy path | Doctor message |
| --- | --- |
| `agents.list` | moved to keyed `agents.entries` |
| `defaultModel` | moved to `agents.defaults.model` |
| `agents.defaults.memorySearch`, top-level `memorySearch`, `agents.entries.*.memorySearch` | moved to `memory.search` / `agents.entries.*.memory.search`; `provider="auto"` legacy; `store.path` retired (indexes live in each agent DB); flat `chunkSize`/`chunkOverlap`/`maxResults` legacy |
| `agents.defaults.agentRuntime`, `.agentRuntime.fallback`, `agents.entries.*.agentRuntime` | ignored; set `models.providers.<provider>.agentRuntime` or a model-scoped `agentRuntime` |
| `agents.defaults.embeddedHarness`, `agents.defaults.embeddedPi`, `agents.defaults.llm`, `agents.defaults.params`, `agents.defaults.silentReply*`, `agents.defaults.systemPromptOverride`, `agents.defaults.subagents.model` | legacy / removed |
| `agents.defaults.cliBackends` | CLI backend adapters now register through plugins |
| `agents.defaults.models` (as restriction) | migrate valid refs to `agents.defaults.modelPolicy.allow` |
| `agents.defaults.sandbox.perSession` | use `sandbox.scope`; `sandbox.browser.network="none"` cannot expose the browser control port |
| `models.providers.codex`, `models.providers.openai-codex` | move to `models.providers.openai`; `openai-codex-responses` → `openai-chatgpt-responses` |
| `models.pricing` | retired; pricing ships with the hosted catalog |
| `models.providers.vllm.models/params` | legacy shape |
| `plugins.entries.codex-supervisor`, `plugins.openai-codex` references | use `plugins.entries.codex.config.supervision` / the `openai` plugin id |
| `tools.web.x_search.apiKey/model` | moved to `plugins.entries.xai.config.webSearch.apiKey`; retired model repaired |
| `gateway.port` (out of range), `gateway.bind` host aliases, `gateway.webchat`, `gateway.tailscale.resetOnExit`, `gateway.tailscale.serviceName`, `gateway.controlUi.dangerouslyDisableDeviceAuth`, `gateway.controlUi.toolTitles` | retired / use bind modes (`lan/loopback/custom/tailnet/auto`) |
| `channels.webchat`, `channels.telegram.requireMention`, `channels.qqbot` (renamed package), `channels.feishu.accounts` shape, `routing.*` | retired / moved into channel config |
| `session.maintenance.rotateBytes`, `session.maintenance.pruneDays`→`pruneAfter`, zero-duration `pruneAfter`/`resetArchiveRetention`, `session.parentForkMaxTokens`, `session.resetByType.dm`→`direct`, `session.threadBindings`, `session.typingMode` | renamed / removed |
| `hooks.internal.handlers` | retired; move modules to a managed/workspace hook directory with `HOOK.md` |
| `mcp.servers` CLI-native type aliases | use OpenClaw transport names (`streamable-http` is a transport name and stays valid) |
| `messages.tts` → top-level `tts`; `tts.enabled` → `tts.auto`; `messages.queue.mode/byChannel` | moved |
| `audio.transcription` | use a capability-tagged `tools.media.models` entry |
| `skills.workshop.autonomous.enabled` → `.mode`; `skills.workshop.allowSymlinkTargetWrites` | retired |
| `cron.runLog`, `cron.webhook`, `diagnostics.otel.protocol`, `heartbeat` (top-level), `bindings`, `surfaces` | retired / invalid paths |
