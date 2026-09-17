# AlphaClaw → OpenClaw Touchpoint Inventory (upgrade review: 2026.7.1 → 2026.9.4)

Repo root: `/Users/billk/Development/starfoundrystudio/alphaclaw`
Pinned dependency: `package.json:43` → `"openclaw": "2026.7.1"` (exact pin, no range).
Compatibility manifest pin: `lib/openclaw-compatibility.manifest.json:4` → `"openclawVersion": "2026.7.1"`, `:7` → `"openclawGitRef": "v2026.7.1"`.

Legend: **R** = reads OpenClaw-owned state/contract, **W** = writes it, **R/W** = both.

---

## 0. Cross-cutting: how the OpenClaw runtime is located and spawned

### 0.1 Module resolution into the openclaw npm package (breaks if dist layout changes)
| File:line | Artifact | R/W |
|---|---|---|
| `lib/server/gateway.js:110-120` `resolveOpenclawExtensionsDir()` | `require.resolve("openclaw")` → `<dist>/extensions` dir; walks for `.openclaw-install-stage*` dirs | R (and `fs.rmSync` on stage dirs = W) |
| `lib/server/openclaw-thinking.js:12` `resolveOpenclawDistDir()` | `path.dirname(require.resolve("openclaw"))` | R |
| `lib/server/openclaw-thinking.js:14-23` | Scans dist for `thinking-*.js` containing sentinel `listThinkingLevelOptions`, skipping names with `api`/`policy` | R |
| `lib/server/openclaw-thinking.js:25-33` | Scans dist for `thinking.shared-*.js` containing `function normalizeThinkLevel` | R |
| `lib/server/openclaw-thinking.js:80-84` | Imports `listThinkingLevelOptions`/`mod.i`, `resolveThinkingDefaultForModel`/`mod.s`, `normalizeThinkLevel`/`sharedMod.s` — **minified-export fallbacks**, extremely fragile across builds | R |
| `lib/server/cost-utils.js:183-228` `loadOpenclawNodeModulesPricingMap()` | Scrapes model pricing out of OpenClaw dist `.js` files matched by `kOpenclawPricingDistFilePatterns` (`cost-utils.js:170-181`) | R |
| `lib/server/agent-vault/channel-provider-services.js:197-207` `resolveCatalogChannelIds()` | Reads `<dist>/channel-catalog.json`, `entries[].openclaw.channel.id`; falls back to hardcoded `kFallbackCatalogChannelIds` (`:91-97`) | R |
| `lib/cli/openclaw-plugin-compat.js:92-109` `resolveOpenclawCliPath()` | Walks up from `require.resolve("openclaw")` for `package.json` `name === "openclaw"`, then `pkg.bin.openclaw` (default `openclaw.mjs`) | R |
| `lib/server/auth-profiles.js:177` | `require.resolve("openclaw/cli-entry")` — subpath export | R |
| `scripts/generate-model-catalog-bootstrap.mjs:60-77` | Same CLI-path walk as above | R |
| `scripts/openclaw-install-utils.js:24-57, 74-81` | Resolves openclaw package dir; runs `<openclawDir>/scripts/postinstall-bundled-plugins.mjs` | R + executes |
| `scripts/restore-openclaw-bundled-plugin-deps.js:1-14` | Wrapper for the postinstall above | executes |

### 0.2 Direct `openclaw/plugin-sdk/*` ESM subpath imports (hard API contracts)
| File:line | Subpath | Symbols used | R/W |
|---|---|---|---|
| `lib/server/managed-gateway-device.js:28` | `openclaw/plugin-sdk/device-bootstrap` | `approveDevicePairing`, `listDevicePairing` (`:124-137`) | R/W |
| `lib/server/routes/pairings.js:34` | `openclaw/plugin-sdk/device-bootstrap` | same module | R/W |
| `lib/server/onboarding/import/portable-cron-import.js:11` | `openclaw/plugin-sdk/cron-store-runtime` | `saveCronStore(storePath, {version:1, jobs})` | W |
| `lib/server/routes/system.js:197-198` | `openclaw/plugin-sdk/secret-input` + `openclaw/plugin-sdk/runtime-secret-resolution` | `coerceSecretRef`, `resolveSecretRefValues` (`:199-217`) | R |

### 0.3 Environment passed to every OpenClaw child process
| File:line | Env builder | Keys |
|---|---|---|
| `lib/server/gateway.js:88-100` `gatewayEnv()` | base for all server-side CLI | `HOME`, `OPENCLAW_HOME=kRootDir`, `OPENCLAW_CONFIG_PATH=<OPENCLAW_DIR>/openclaw.json`, `OPENCLAW_STATE_DIR=OPENCLAW_DIR`, `XDG_CONFIG_HOME=OPENCLAW_DIR`, plus `buildAgentVaultRuntimeEnv(undefined,{viaShim:true})` |
| `lib/server/gateway.js:104-108` `managedGatewayEnv()` | gateway child only | adds `OPENCLAW_LOG_LEVEL` (forced `info` unless debug/trace) |
| `lib/server/openclaw-runtime-env.js:19-47` | wraps all of the above | `NODE_COMPILE_CACHE=<root>/cache/openclaw-compile-cache`, `OPENCLAW_NO_RESPAWN=1` |
| `lib/server/watchdog.js:136-143` | watchdog doctor/probe env | same OPENCLAW_* quartet |
| `lib/cli/openclaw-plugin-compat.js:111-124` `buildOpenclawEnv()` | plugin reconciler | OPENCLAW_* quartet + Agent Vault env (comment `:113-115` notes `OPENCLAW_PROXY_URL` + MITM CA needed once `proxy.enabled` is set) |
| `bin/alphaclaw.js:211-221` | CLI passthrough | `buildCliOpenclawBaseEnv()` = OPENCLAW_* quartet; `buildCliOpenclawRuntimeEnv()` adds vault env |
| `lib/server/auth-profiles.js:178-186` | `openclaw config get agents --json` | OPENCLAW_* quartet, `OPENCLAW_HOME = dirname(OPENCLAW_DIR)` (note: **different** from gateway.js which uses `kRootDir`) |
| `scripts/generate-model-catalog-bootstrap.mjs:85-93` | probe sandbox | `HOME`, `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `XDG_CONFIG_HOME`, `NO_COLOR` into a temp root |
| `lib/server/commands.js:49-83` `clawCmd()` | `exec("openclaw " + cmd, {env: gatewayEnv()})` — the generic CLI shim | |
| `lib/server/openclaw-doctor-repair.js:18-26` | adds `OPENCLAW_SERVICE_REPAIR_POLICY: "external"` | |
| `bin/alphaclaw-gog.js:63-66` | reads `OPENCLAW_STATE_DIR` to find `gogcli/state.json` | R |

### 0.4 Every spawn/exec of the `openclaw` binary
| File:line | Command |
|---|---|
| `lib/server/gateway.js:182` | `openclaw plugins list --json` (plugin runtime-deps preflight) |
| `lib/server/gateway.js:315` | `openclaw gateway <cmd>` (short cmds, e.g. `stop`) |
| `lib/server/gateway.js:329` | `openclaw gateway restart` |
| `lib/server/gateway.js:414` | `spawn("openclaw", ["gateway", "--force"])` |
| `lib/server/gateway.js:551` | `spawn("openclaw", ["gateway", "run"])` — the managed supervisor child |
| `lib/server/gateway.js:981-982` | `openclaw channels add --channel slack --bot-token … --app-token …` |
| `lib/server/gateway.js:994` | `openclaw channels add --channel <ch> --token …` |
| `lib/server/gateway.js:1020` | `openclaw channels remove --channel <ch> --delete` |
| `lib/server/openclaw-version.js:42` | `openclaw --version` |
| `lib/server/openclaw-version.js:68` | `openclaw update status --json` |
| `lib/server/model-catalog-cache.js:232` | `openclaw models list --all --json` |
| `lib/server/routes/models.js:405` | `openclaw models status --json` |
| `lib/server/routes/models.js:452`, `lib/server/onboarding/index.js:649` | `openclaw models set "<modelKey>"` |
| `lib/server/onboarding/index.js:636` | `openclaw onboard <args>` (args built in `lib/server/onboarding/openclaw.js:98-195`) |
| `lib/server/codex-broker-service.js:52` | `openclaw secrets reload --json` |
| `lib/server/routes/system.js:407` | `openclaw sessions --json --all-agents` |
| `lib/server/routes/system.js:1001` | `openclaw status` |
| `lib/server/routes/system.js:1026,1049` | `openclaw agent --agent main --message … [--deliver --reply-channel --reply-to \| --session-id]` |
| `lib/server/routes/system.js:1071` | `openclaw dashboard --no-open` (token scraped from stdout, `:250-258`) |
| `lib/server/routes/pairings.js:570` | `openclaw pairing list --channel <ch> --json` |
| `lib/server/routes/pairings.js:630-632` | `openclaw pairing approve --channel … --account … <id>` (legacy positional fallback also present) |
| `lib/server/routes/pairings.js:698, :812` | device list / device commands |
| `lib/server/routes/nodes.js:165,181,206,228,252,288` | `openclaw nodes status --json`, `nodes pending --json`, `nodes approve <id>`, `devices remove <id>`, node browser probe |
| `lib/server/routes/nodes.js:309` | `openclaw config get tools.exec --json` |
| `lib/server/routes/nodes.js:347-357` | `openclaw config set tools.exec.{host,security,ask,node} <v>` |
| `lib/server/doctor/service.js:243-251` | `openclaw gateway call agent --expect-final --json --timeout <ms> --params <json>` with params `{agentId,idempotencyKey,message,sessionKey,thinking,timeout}` |
| `lib/server/doctor/service.js:263-274` | `openclaw agent --agent main --message … [--deliver …]` |
| `lib/server/agents/channels.js:421-440, 549-551, 948-953, 1103-1115, 1166-1168, 1208-1214` | `openclaw channels add / channels remove / channels login` |
| `lib/server/watchdog-notify.js:278-282` | `openclaw message send --channel whatsapp --target … --message …` |
| `lib/server/auth-profiles.js:188-198` | `node <openclaw/cli-entry> config get agents --json` |
| `lib/cli/openclaw-plugin-compat.js:126-143` | `node <openclaw cli> <args>` — `plugins list --json`, `plugins install npm:<spec> --pin`, `plugins update …`, `--version` |
| `scripts/generate-model-catalog-bootstrap.mjs:95-102, 223-227, 359-363, 440-442` | `openclaw --version`, `models list --provider <p> --all --json`, `plugins install npm:<exactSpec> --pin` |
| `lib/server/watchdog.js:23` / `lib/server/openclaw-doctor-repair.js:4-5` / `lib/server/openclaw-config.js:75` | `alphaclaw openclaw-doctor-guard -- openclaw doctor --non-interactive --fix` |

---

## 1. `openclaw.json` config: readers, writers, guardrails

### 1.1 The single sanctioned accessor — `lib/server/openclaw-config.js`
- `:4-5` `resolveOpenclawConfigPath({openclawDir}) = <dir>/openclaw.json`
- `:43-65` `readOpenclawConfig()` — **R**. Throws `OpenclawConfigReadError` (code `OPENCLAW_CONFIG_READ_FAILED`) unless an explicit `fallback` is supplied *and* the error looks like ENOENT (`:33-41` `isMissingConfigError`). Deliberate: a corrupt config is never silently treated as `{}`.
- `:67-81` **`assertOpenclawConfigSafeForMutation()` — the "safe config mutation guardrail."** Refuses mutation when `config.gateway.mode` is missing/blank, throwing `OpenclawConfigUnsafeMutationError` (code `OPENCLAW_CONFIG_UNSAFE_FOR_MUTATION`) with the remediation string `alphaclaw openclaw-doctor-guard -- openclaw doctor --non-interactive --fix`. **Upgrade risk: if 2026.9.4 renames/removes `gateway.mode` or makes it optional, every guarded writer hard-fails.**
- `:83-111` `writeOpenclawConfig()` — **W**. Atomic temp-file + `renameSync` when the real `fs` is used; plain `writeFileSync` when injected.

### 1.2 Callers of the guardrail (guarded writers)
| File:line | Operation label | R/W |
|---|---|---|
| `lib/server/usage-tracker-config.js:186-191` | `"usage-tracker plugin config sync"` (only when `requireGatewayMode`) | R/W |
| `lib/server/watchdog.js:555-571` | `"Clawbridge watchdog plugin reconciliation"` | R/W |
| `lib/server/exec-defaults-config.js:318-350` | `"managed exec defaults sync"` | R/W |
| `lib/server/agent-vault/service.js:207-216` | `"Agent Vault proxy enablement"` → sets `proxy.enabled = true` | R/W |
| `lib/server/agent-vault/service.js:474-506` | `"Agent Vault channel policy enforcement"` → writes `plugins.deny[]` | R/W |
| `lib/server/agent-vault/service.js:524-535` | `"Agent Vault discord proxy enablement"` → `channels.discord.proxy` | R/W |
| Error classification consumer: `lib/server/startup.js:3,58` `isOpenclawConfigReadError` → `runRepairableConfigStep` retries once after doctor | R |

### 1.3 `gateway.mode` / `gateway.*` checks outside the guardrail
- `lib/server/gateway.js:748-761` `ensureGatewayProxyConfig()` does its **own** `gateway.mode` check (warn + return false) instead of calling the assert.
- `lib/server/gateway.js:241-251` `getGatewayPort()` reads `cfg.gateway.port` (fallback `kDefaultGatewayPort`).
- `lib/server/gateway.js:764-787` writes `gateway.http.endpoints.chatCompletions.enabled` and `gateway.http.endpoints.responses.enabled` (gated on `alphaclaw.json` feature flag).
- `lib/server/gateway.js:789-796` writes `gateway.trustedProxies` (ensures `127.0.0.1`).
- `lib/server/gateway.js:798-808` writes `gateway.controlUi.allowedOrigins` (adds dashboard origin).
- `lib/server/chat-ws.js:504-512` reads `gateway.auth.token` (resolves `${ENV}` refs, `:411-419`); `OPENCLAW_GATEWAY_TOKEN` wins.
- `lib/server/routes/system.js:226-247` reads `gateway.auth.token`, resolving OpenClaw **secret refs** via the plugin-sdk (§0.2).
- `lib/server/onboarding/index.js:338-348` rewrites `gateway.auth.token` to the `${OPENCLAW_GATEWAY_TOKEN}` env reference on import.
- `lib/server/onboarding/import/secret-detector.js:89` drops `gateway.auth.token` on import; `:256-258` detects presence.
- `lib/server/oauth-broker-client.js:292` reads a broker `config.gateway_host` (broker config, not openclaw.json).

### 1.4 Remote/managed MCP entries (`mcp.servers.*`) — `lib/server/gateway.js:810-938`
- Env-driven: `REMOTE_MCP_URL`, `REMOTE_MCP_API_TOKEN`, `REMOTE_MCP_NAME`, `REMOTE_MCP_PROXY_URL`.
- Name validated with `/^[A-Za-z0-9_-]{1,64}$/` + reserved-key blocklist (`:842-860`).
- Writes `mcp.servers.<name> = {url, transport:"streamable-http", headers.Authorization, _alphaclawManaged:true}` (`:907-916`).
- Cleans stale managed entries by marker (`:871-886`), deletes on unset (`:922-931`), prunes empty `mcp`/`mcp.servers` (`:932-937`).
- Scrubs the plaintext bearer back to `Bearer ${REMOTE_MCP_API_TOKEN}` before write (`:941-947`). **Contract: `transport: "streamable-http"` string.**

### 1.5 Managed config shell written during onboarding — `lib/server/onboarding/openclaw.js`
`ensureManagedConfigShell()` (`:197-282`) — **W** — creates/forces:
- `channels`, `plugins.{allow,load.paths,entries}`, `skills.entries`, `agents.defaults`, `commands`, `tools`, `update`, `gateway`
- `approvals.plugin.enabled = true`, `approvals.plugin.mode = "session"` (`:216-231`)
- `hooks.internal.enabled = true`, `hooks.internal.entries["bootstrap-extra-files"] = {enabled:true, paths:["hooks/bootstrap/AGENTS.md","hooks/bootstrap/TOOLS.md"]}` (`:24-27, 232-255`)
- `commands.restart = true`, `tools.profile = "full"`, `update.checkOnStart = false` (`:235-237`)
- `gateway.http.endpoints.{chatCompletions,responses}.enabled = true` when the OpenAI-compat feature is on (`:238-249`)
- `plugins.entries["active-memory"]` full config block: `agents:["main"]`, `allowedChatTypes:["direct","channel"]`, `queryMode`, `promptStyle`, `timeoutMs`, `maxSummaryChars`, `persistTranscripts`, `logging` (`:256-281`); `modelFallbackPolicy` is stripped (`:81-88`).

Other writers in the same file:
- `ensureModelProviderShell()` `:284-297` → `models.providers.<id>`
- `applyManagedAgentRuntimeDefault()` `:299-354` → for `claude-cli`: `agents.defaults.models[<key>].agentRuntime.id = "claude-cli"`, deletes `agents.defaults.agentRuntime`, enables plugin `anthropic`. For `codex`: `models.providers.openai.agentRuntime.id = "codex"`, enables plugin `codex`.
- `applyRequiredManagedPluginEntries()` `:356-367` → `plugins.allow` + `plugins.entries[x].enabled = true`
- `disableManagedTeamyouMemoryUntilBootstrap()` `:374-409` → gates `plugins.entries["openclaw-teamyou-memory"].enabled=false`, `plugins.entries["active-memory"].config.enabled=false`, `skills.entries.teamyou.enabled=false`
- `applyManagedCodexNativeWebSearchDefault()` `:411-430` → `tools.web.search.enabled`, `tools.web.search.openaiCodex.{enabled,mode:"cached"}`
- `applyManagedDiscoveryMdnsMode()` `:432-444` → `discovery.mdns.mode` from `OPENCLAW_DISCOVERY_MDNS_MODE` ∈ {off,minimal,full}
- `applyFreshOnboardingChannels()` `:457-510` → `channels.{telegram,discord,slack,whatsapp}` with `dmPolicy`/`groupPolicy`/tokens; `plugins.entries.<ch>.enabled=true`
- `writeSanitizedOpenclawConfig()` `:512-553` — **raw `fs.readFileSync`/`writeFileSync`, bypasses `openclaw-config.js`**; does string-level secret→`${ENV}` substitution on the serialized JSON.
- `writeManagedImportOpenclawConfig()` `:555-661` — same raw read/write; import variant preserving `dmPolicy` via `getSafeImportedDmPolicy()` (`:446-455`).

### 1.6 Every other `openclaw.json` reader/writer
| File:line | Keys touched | R/W |
|---|---|---|
| `lib/server/openclaw-runtime-state.js:3-17` | existence of `openclaw.json` gates managed-runtime init | R |
| `lib/server/gateway.js:158-168` | `channels.<ch>.enabled` (has-enabled-channel preflight) | R |
| `lib/server/gateway.js:962-1036` `syncChannelConfig` | raw read/write; `channels.<ch>.enabled`; rewrites tokens to `${ENV}` | R/W (raw) |
| `lib/server/gateway.js:1038-1170` `getChannelStatus` | `channels.<ch>.{enabled,accounts,allowFrom,botToken,token,dmPolicy,selfChatMode}` + `credentials/<ch>-*-allowFrom.json`, `credentials/whatsapp/<id>/creds.json` | R |
| `lib/server/usage-tracker-config.js:30-172` | `plugins.allow`, `plugins.load.paths`, `plugins.entries["usage-tracker"\|"agent-vault"].{enabled,hooks.allowConversationAccess,hooks.allowPromptInjection}`, `channels.discord.groupPolicy` | R/W |
| `lib/server/web-search-config.js:22-55` | `tools.web.search.{enabled,provider}`, `plugins.bundledDiscovery = "compat"` | W |
| `lib/server/exec-defaults-config.js:189-230, 306-352` | `tools.exec` defaults, `approvals.plugin.{enabled,mode}`, channel approvers; also `<openclawDir>/exec-approvals.json` (`:26-27`) | R/W |
| `lib/server/watchdog.js:555-571` | full-config read for plugin reconcile | R |
| `lib/server/chat-ws.js:504-512` | `gateway.auth.token` | R |
| `lib/server/bootstrap-kickoff.js:287-299` | agent id / workspace / bootstrap-disabled flags | R |
| `lib/server/gmail-watch.js:110-118` | `hooks.mappings[].match.path == "gmail"` | R |
| `lib/server/gmail-watch.js:275-…` `ensureHooksPreset` | raw read/write: `hooks.{enabled,token,presets,mappings}` + transform module `gmail/gmail-transform.mjs` | R/W (raw) |
| `lib/server/webhooks.js:15-76, 19-24, 410-478` | raw read/write: `hooks.{enabled,path,token,defaultSessionKey,allowRequestSessionKey,allowedSessionKeyPrefixes,mappings,presets}`, `agents.list` | R/W (raw) |
| `lib/server/telegram-workspace.js:44-143` | deletes legacy `sessions`/`groups`/`groupAllowFrom`; writes `channels.telegram.{accounts,groups,topics}`, `session.resetByType.thread = {mode:"idle", idleMinutes:525600}`, `agents.defaults.maxConcurrent`, `agents.defaults.subagents.maxConcurrent` | R/W |
| `lib/server/routes/telegram.js:436-567` | `channels.telegram.*` group/topic config | R/W |
| `lib/server/routes/pairings.js:290-383` | `channels.<ch>.allowFrom` / account allowlists; `credentials/<ch>-pairing.json` (`:135-136`) | R/W |
| `lib/server/routes/pairings.js:555-567` | `channels.<ch>.enabled` gate before `pairing list` | R |
| `lib/server/routes/models.js:378-382` | `agents.defaults.thinkingDefault` | R |
| `lib/server/routes/system.js:226-247, 415, 797` | `gateway.auth.token`, config existence | R |
| `lib/server/agents/shared.js:100-114` | generic `loadConfig`/`saveConfig` via openclaw-config | R/W |
| `lib/server/agents/shared.js:116-131` | `plugins.allow` + `plugins.entries[x].enabled` | W |
| `lib/server/agents/agents.js:54-58, 107-227` | `agents.list[]` (`id`, `workspace`, `thinkingDefault`), `agents.defaults.thinkingDefault` | R/W |
| `lib/server/agents/channels.js:507, 525-533, 720-722, 876-898, 984-1006, 1148-1150` | `channels.*` account trees around CLI `channels add/remove` | R/W |
| `lib/server/onboarding/index.js:327-380` `normalizeImportedConfig` | `gateway.auth.token` → `${OPENCLAW_GATEWAY_TOKEN}`, `hooks.token` → `${WEBHOOK_TOKEN}`, deletes `hooks.transformsDir`; `:212-…` clears imported `credentials/*-pairing`/allowFrom | R/W |
| `lib/server/onboarding/workspace.js:18-36` | `channels.telegram.{groups,accounts.*.groups}` | R |
| `lib/server/onboarding/workspace.js:99-118` | `agents.list[].{id,workspace}` for multi-workspace prompt sync | R |
| `lib/server/onboarding/import/import-config.js:36` | enumerates config + `$include` chain | R |
| `lib/server/onboarding/import/import-scanner.js:20,30,174-210,259,306,323` | `openclaw.json`, `.openclaw/openclaw.json` (unsupported-nested), `hooks.mappings`, `hooks.internal.entries`, `hooks.token` | R |
| `lib/server/onboarding/import/import-applier.js:139-181, 200-230` | rewrites `hooks.mappings[].match.path` + `transform.module`, moves `hooks/transforms/**` | R/W |
| `lib/server/auth-profiles.js:212-237` | `agents.list[]` — direct parse, falls back to `openclaw config get agents --json` when `$include` / `${}` present (`:145-153, 176-210`) | R |
| `lib/server/auth-profiles.js:1071-1078, 1139-1140` | `loadOpenclawConfig` / `saveOpenclawConfig` via `writeJsonFileAtomically` — **bypasses `writeOpenclawConfig` and the guardrail** | R/W (raw) |
| `lib/server/auth-profiles.js:1322-1341` `getModelConfig` | `agents.defaults.model.primary`, `agents.defaults.models`, `models.providers.*.agentRuntime` | R |
| `lib/server/auth-profiles.js:1343-1355` `setModelConfig` | writes `agents.defaults.model.primary`, `agents.defaults.models` + enables runtime plugins | W |
| `lib/server/auth-profiles.js:1089-1128` | `agents.defaults.agentRuntime`, `agents.defaults.models[].agentRuntime`, `models.providers[].agentRuntime` → plugin ids `{codex:"codex","claude-cli":"anthropic"}` | R/W |
| `lib/server/auth-profiles.js` `syncConfigAuthReference*` (`:1160-1197, 1266-1297`) | `auth.profiles.<id>`, `auth.order.<provider>` | R/W |
| `lib/cli/openclaw-plugin-compat.js:305-313, 660-663` | `plugins.slots.*` walk | R |
| `lib/cli/openclaw-plugin-compat.js:315-422` | `backends`, `agentRuntime`, provider-reference paths for relevance detection | R |
| `lib/cli/openclaw-plugin-compat.js:775-799, 801-864` | writes suppressed config, `openclaw.pre-plugin-reconcile.<stamp>.bak` under `.openclaw/.alphaclaw/` | R/W |
| `lib/cli/openclaw-config-restore.js:58-134` | restores a missing `openclaw.json` from `origin/<branch>:openclaw.json` | W |
| `lib/cli/alphaclaw-migrations.js` (see §5.2) | many `openclaw.json` migrations | R/W |
| `bin/alphaclaw.js:666-700` | `channels.telegram.groups` for `telegram topic add` | R/W |
| `lib/server/ui-sandbox/workspace.js:48` / `fixtures.js:223` | fake `openclaw.json` for the UI sandbox | W (sandbox only) |
| `lib/public/js/components/nodes-tab/browser-attach/index.js:26` | UI copy referencing `~/.openclaw/openclaw.json` | — |

### 1.7 Cron in config
- `lib/server/routes/system.js:80-85`: `/etc/cron.d/openclaw-hourly-sync`, `<OPENCLAW_DIR>/cron/system-sync.json`, script path from `internal-files-migration.buildManagedPaths` → `.openclaw/.alphaclaw/hourly-git-sync.sh`, default schedule `"0 * * * *"`, log `/var/log/openclaw-hourly-sync.log` (`:133`). **W** (system cron).
- OpenClaw's own cron is now gateway-RPC/SQLite — see §4 and §6.

---

## 2. models.json / model catalog

### 2.1 Generated artifacts
| File | Content | Notes |
|---|---|---|
| `lib/server/model-catalog-bootstrap.json` | `schemaVersion:2`, `openclawVersion:"2026.7.1 (2d2ddc4)"` (`:6`), `compatibilityManifest.openclawVersion:"2026.7.1"` (`:12`), `accessModes{}`, `models[]` | **Must be regenerated for 2026.9.4** |
| `lib/server/model-catalog-support.json` | AlphaClaw-owned policy: `accessModes`, `providerProbes`, `providers{envKeys,requiredPlugins,authRoutes,runtimeIds,allowedModelKeys*,recommendedModelKeys*,minimumProbeModelCount,publicModelCatalog}`, `explicitModels` | schemaVersion 1 |
| `lib/openclaw-compatibility.manifest.json` | `managedPlugins{<id>:{kind,package,version,pluginId,channelId,providerIds,providerAliases,webSearchProviderIds,webSearchProviderEnvVars,contracts,source,install{npmSpec,exactNpmSpec,defaultChoice,minHostVersion}}}` | pinned to `v2026.7.1` catalogs |

### 2.2 Generator — `scripts/generate-model-catalog-bootstrap.mjs`
- `:60-77` resolves openclaw CLI; `:79-83` `parseOpenclawVersion()` regex.
- `:85-93` builds a throwaway OPENCLAW_HOME/state sandbox for probes.
- `:309-341` `validateSupportSpec()` — throws `Provider <id> requires unknown managed OpenClaw plugin: <pluginId>` if the support spec references a plugin missing from the compat manifest.
- `:343-365` `installProbePlugins()` — `openclaw plugins install npm:<exactNpmSpec> --pin`.
- `:211-257` `listProviderModels()` — `openclaw models list --provider <p> --all --json`; expects `{models:[{key|id,label|name|title,provider,…}]}`; tolerates `No models found`; enforces `minimumProbeModelCount`.
- `:428-467` `generateCatalog()` — runs `openclaw --version`, installs probe plugins, probes each `providerProbes` entry, then merges public provider catalogs and `explicitModels`.
- `:375-426` `buildSegmentedAccessModes()` — emits per-access-mode provider blocks with `authRoute`, `runtimeId`, `envKeys`, `requiredPlugins`, `recommendedModelKeys`, sorted `models`.
- Run via `npm run generate:model-catalog-bootstrap` and `prepack` (`package.json:35,37`).

### 2.3 Compatibility-manifest generator — `scripts/generate-openclaw-compatibility-manifest.mjs`
- `:10-24` fetches three upstream catalogs from `https://raw.githubusercontent.com/openclaw/openclaw/<gitRef>/scripts/lib/official-external-{channel,plugin,provider}-catalog.json`.
- `:128-140` `resolvePinnedOpenclawVersion()` — requires an **exact** `openclaw` version in package.json (regex `^\d+\.\d+\.\d+([-+]…)?$`), `gitRef = v<version>`.
- `:72-126` `buildManagedPluginEntry()` — reads `entry.openclaw.{plugin.id,channel.id,providers[],webSearchProviders[],contracts,install{npmSpec,defaultChoice,minHostVersion}}`. **Upstream catalog schema is a hard contract.**

### 2.4 Runtime catalog cache — `lib/server/model-catalog-cache.js`
- `:13` default cache at `<ALPHACLAW_DIR>/cache/model-catalog.json`.
- `:65, 163` cache entry carries `openclawVersion`; cache is invalid when it does not equal the current `openclaw --version` (normalized).
- `:228-264` refresh: `readCurrentOpenclawVersion({refresh:true})` + `openclaw models list --all --json`; stores `{models, openclawVersion, …}`.
- `:90-93` merges `model-catalog-support.json` fallback models into dynamic results.
- `:352, 363` source labels `"openclaw"` / `"cache"` / `"bootstrap"` (`:12`).
- `lib/server/constants.js:4, 240-243` — `kBootstrapModelCatalog` from the bootstrap JSON; `kFallbackOnboardingModels` falls back to `kMinimalFallbackOnboardingModels` (hardcoded model keys around `constants.js:230-239`).
- `lib/server/model-catalog.js:3` consumes `kBootstrapModelCatalog`.

### 2.5 Thinking levels — `lib/server/openclaw-thinking.js`
See §0.1. Public surface: `resolveThinkingOptionsForModel({modelKey, catalog})` → `{levels:[{id,label}], modelDefault}`; `normalizeThinkingDefaultValue(raw)`.
Consumers: `lib/server/routes/models.js:13, 368-398` (`GET /api/models/thinking-options`, blends `agents.defaults.thinkingDefault`), `lib/server/agents/agents.js:2, 203-215` (validates per-agent `thinkingDefault`).
Frontend: `lib/public/js/lib/thinking-levels.js` (label overrides `off/on/minimal/low/medium/high/adaptive/xhigh/max`, `shouldShowThinkingLevelSelect`).

### 2.6 User-facing model/provider selection → persisted config
- `lib/public/js/lib/model-config.js` — access modes (`subscription`, `provider-api`, `gateway`), `kGatewayProviders`, `kSubscriptionProviders`, `kWrapperProviders`, `kHiddenOnboardingProviders = {openai-codex}`, `kSetupReadyAccountLoginProviders = {openai, claude-cli}`, `kKnownOnboardingModels` (hardcoded model keys `:64-120`), `kProviderLabels`, `kFeaturedModelDefs`.
- `lib/public/js/lib/model-catalog.js` — fetches `/api/models`, reads `payload.{models,accessModes,refreshing}`.
- `lib/public/js/components/models-tab/*`, `onboarding/{model-select,provider-select}.js`, `welcome/use-welcome.js` drive the choice.
- Server persistence path: `PUT /api/models/config` (`lib/server/routes/models.js:497-618`) → `authProfiles.setModelConfig` → `agents.defaults.model.primary` + `agents.defaults.models` + runtime-plugin enablement; then `runModelsGitSync` (`:27-35`) runs `alphaclaw git-sync -m "models: update config" -f "openclaw.json"`.
- `POST /api/models/set` (`:452`) → `openclaw models set "<key>"`.
- Onboarding validation: `lib/server/onboarding/validation.js:15-26` maps `openai-codex/*` → `openai/*` and `claude-cli/*` → `anthropic/*`; `:118-160` enforces runtime ids `codex` | `claude-cli` only; `:174-184` uses `getEnvKeysForCatalogEntry` / `getRequiredPluginsForCatalogEntry` from the bootstrap catalog.

---

## 3. Auth / credential stores

### 3.1 `lib/server/auth-profiles.js` (1614 lines) — primary store owner
| Line | Artifact | R/W |
|---|---|---|
| `:16` | `openclaw-agent.sqlite` filename constant | |
| `:258-262` | `<agentDir>/auth-profiles.json` (legacy JSON) and `<agentDir>/openclaw-agent.sqlite` | R/W |
| `:267-268` | legacy `<agentDir>/auth.json` | R/W |
| `:270-274` | `OPENCLAW_OAUTH_DIR` or `<OPENCLAW_DIR>/credentials`, shared `oauth.json` | R/W |
| `:239-256` | agent dir resolution: config `agents.list[].agentDir` → `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` → `<OPENCLAW_DIR>/agents/<id>/agent` | R |
| `:276-326` | enumerates all agent targets (config + filesystem) for credential sweeps | R |
| `:490-525` | `SELECT store_json FROM auth_profile_store WHERE store_key='primary'`; `SELECT state_json FROM auth_profile_state WHERE state_key='primary'` | R |
| `:527-608` | schema assertion + creation: tables `schema_meta(meta_key,role,schema_version,agent_id,app_version,created_at,updated_at)`, `auth_profile_store(store_key,store_json,updated_at)`, `auth_profile_state(state_key,state_json,updated_at)`; `PRAGMA user_version = 1`; validates `schema_meta.role === "agent"` and `agent_id` match | R/W |
| `:610-656` | upserts store/state rows; state payload keys `order`, `lastGood`, `usageStats` | W |
| `:658-674` | `PRAGMA secure_delete=ON`, `wal_checkpoint(TRUNCATE)`, `VACUUM` — physical OAuth sanitization | W |
| `:676-700` | sanitization-pending marker `<db>.alphaclaw-oauth-sanitize-pending` | W |
| `:702-798` | `writeAuthStoreDatabase` / `mutateAuthStoreDatabase` | W |
| `:24-28` | legacy backup patterns: `auth-profiles.json.<reason>.<ts>.bak`, `auth.json.…`, `oauth.json.…` where reason ∈ `sqlite-import\|openai-provider-unification\|api-key-alias\|legacy-flat\|aws-sdk-profile\|oauth-ref`; `:28` legacy OAuth sidecars `/^[a-f0-9]{32}\.json$/` | R + delete |
| `:911-1069` | scrubs legacy `auth.json` / shared `oauth.json`, purges legacy Codex artifacts and orphaned oauth sidecars | W |
| `:29-64` | `kApiKeyEnvVarByProvider` — 36 provider→env mappings (must match OpenClaw's provider registry) | |
| `:95-102` | Codex entry detection: `CODEX_PROFILE_ID`, legacy provider `openai-codex`, `openai`+oauth | R |
| `:126-131` | pending store `<ALPHACLAW_DIR>/pending-auth-profiles/<agentId>.json` | R/W |
| `:1160-1197, 1266-1297` | writes `auth.profiles.<id>` / `auth.order.<provider>` into `openclaw.json` | W |

`lib/server/constants.js:35` `CODEX_PROFILE_ID = "openai:codex-cli"`; `auth-profiles.js:19-20` `kClaudeCliProfileId = "anthropic:claude-cli"`, `kClaudeCliProviderId = "claude-cli"`.

### 3.2 Doctor OAuth guard — `lib/cli/openclaw-doctor-oauth-guard.js`
- `:6-9` `auth-profiles.json`, `openclaw-agent.sqlite`, store key `primary`, shield window 7 days.
- `:62-92` reads/writes `auth_profile_store` directly (creates the table if missing).
- `:94-128` scans `<openclawDir>`, `<openclawDir>/agent`, `<openclawDir>/agents/*/agent`.
- `:130-154` `shieldOAuthExpiries` — bumps `credential.expires` so OpenClaw's doctor does not trigger a refresh; `:198-233` restores original credential material afterwards; `:373` spawns the guarded command.
- Invoked by `bin/alphaclaw.js:560-591` (`alphaclaw openclaw-doctor-guard -- …`).

### 3.3 Codex OAuth / device code
- `lib/server/constants.js:35-50`: `CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`, authorize/token URLs at `auth.openai.com`, redirect `http://localhost:1455/auth/callback`, scope `openid profile email offline_access`, JWT claim path `https://api.openai.com/auth`, device usercode/token/verify URLs, device redirect `https://auth.openai.com/deviceauth/callback`.
- `lib/server/routes/codex.js` — PKCE web flow (`:170-260`), device-code flow (`:281-460`), writes profiles via `authProfiles.upsertCodexProfile` (`:122`).
- `lib/server/codex-broker-service.js` — brokered refresh; `:37-62` `createOpenclawCredentialPublisher` → `openclaw secrets reload --json`; errors `runtime_starting` / `runtime_reload_failed`; `:515, 595, 632` journal/live-snapshot + fail-closed removal notes.
- `lib/oauth-broker-constants.js:1-4` — `CODEX_BROKER_REFRESH_PLACEHOLDER = "alphaclaw-oauth-broker:v1:openclaw-codex:openai"` stored in the OpenClaw auth store in place of a real refresh token.
- Frontend: `lib/public/js/lib/codex-oauth-window.js`, `use-codex-device-auth.js`, `components/codex-device-auth-panel.js`.

### 3.4 Claude CLI OAuth
- `lib/server/routes/account-logins.js:211-320` — spawns `claude auth login --claudeai`, parses `claude auth status --json`; timeout 10 min.
- `lib/server/claude-broker-service.js` + `lib/oauth-broker-constants.js:6-9` (`CLAUDE_BROKER_CLIENT_ID`, required scope `user:inference`).
- Profile `anthropic:claude-cli` written into the OpenClaw auth store (`auth-profiles.js:295-320`).
- `lib/server/gateway.js:92-95` deliberately keeps `HOME` as the service user's home so the Claude CLI finds its own store.

### 3.5 gog (Google)
- `lib/server/constants.js:506-511` — `GOG_CONFIG_DIR = <OPENCLAW_DIR>/gogcli`, `credentials.json`, `state.json`, `GOG_KEYRING_PASSWORD`.
- `lib/server/commands.js:85-101` `gogCmd` passes `XDG_CONFIG_HOME = OPENCLAW_DIR`.
- `lib/server/onboarding/workspace.js:243-263` runs `gog auth keyring file` when `gogcli/config.json` is absent.
- `lib/server/gog-broker-service.js:360-378` — temp export file `alphaclaw-gog-export.<pid>.<hex>.json`, `gog auth tokens export`.
- `bin/alphaclaw-gog.js` — shim around `/usr/local/libexec/gog-real`; resolves state from `OPENCLAW_STATE_DIR` (`:63-66`); blocks direct `--access-token` (`:177-180`); leases tokens via the broker.
- `bin/alphaclaw-oauth-lease.js` — CLI lease fetch for the Claude/gog consumers.

### 3.6 Agent Vault brokering
- `lib/server/agent-vault/runtime-store.js`
  - `:5-18` state under `<ALPHACLAW_DIR>/agent-vault/{runtime.json,mitm-ca.pem}`; API `http://127.0.0.1:14321`; proxy port `14322`; **shim port `14323`**; TeamYou placeholder `__agent_vault_teamyou_api_key__`.
  - `:30-72` runtime validation (token `av_…`, operator URL must be `https://*.ts.net/`).
  - `:178-227` **`buildAgentVaultRuntimeEnv()`** → `AGENT_VAULT_{ADDR,TOKEN,VAULT,OPERATOR_URL}`, `TEAMYOU_API_KEY`, `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`, `NODE_USE_ENV_PROXY=1`, **`OPENCLAW_PROXY_URL`**, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `DENO_CERT`.
- `lib/server/agent-vault/proxy-shim.js` — loopback-aware CONNECT/HTTP shim (`:23` `kShimHost=127.0.0.1`, `:75-162`); started before any gateway spawn (`lib/server/gateway.js:34-47, 405, 544`).
- `lib/server/agent-vault/service.js`
  - `:206-216` sets `proxy.enabled = true` in `openclaw.json`.
  - `:376-…`/`:405-513` placeholder substitution: flips env values to `__agent_vault_*__`, sweeps the raw secret out of `openclaw.json` **and deletes matching `openclaw.json.bak*` rotated backups** (`:509-531` region; see `:121-131` of the excerpt — `/^openclaw\.json\.bak/`).
  - `:456-509` `ensureChannelPluginDenyList()` → writes `plugins.deny[]`.
  - `:523-536` `ensureDiscordChannelProxyConfig()` → `channels.discord.proxy`.
  - `:190-205` builds an SSH client to the gateway VPS from `ALPHACLAW_GATEWAY_SETUP_*` env.
- `lib/server/agent-vault/model-provider-services.js:19-…` — provider→vault host map; comment `:12-18` explicitly says hosts must match **what the pinned OpenClaw provider registry dials**.
- `lib/server/agent-vault/channel-provider-services.js` — channel tiers (S/C/shelved), `kFallbackCatalogChannelIds` snapshot, `resolveCatalogChannelIds()` from the openclaw dist.
- `lib/server/agent-vault/env-classification.js` — `kBootstrapCredentialKeys` (incl. `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_WEBHOOK_TOKEN`), managed channel-credential pattern, `TEAMYOU_API_KEY` runtime replacement.
- Bundled plugin `lib/plugin/agent-vault/{openclaw.plugin.json,index.js}` — declares `contracts.tools:["ensure_service_access"]`; `index.js:346-353` hooks `before_agent_finalize` and `reply_payload_sending` with `{priority:1000}`; `:353+` `api.registerTool({name,label,description,parameters,execute})`. **Plugin host API contract.**

---

## 4. SQLite / persistence

| File:line | DB / table | R/W |
|---|---|---|
| `lib/runtime/node-sqlite-safety.js:3-7, 26-34, 36-46, 48-77` | Guards Node ≥22.22.3 / 24.15.0 / 25.9.0 and SQLite ≥3.51.3 (or 3.50.7+/3.44.6+ backports) for WAL safety; error text names "OpenClaw-supported Node runtime". Called from `bin/alphaclaw.js:8-10`. Mirrors `package.json:57` engines. | R |
| `lib/cli/openclaw-startup-state-repair/plugin-index.js:10-11` | `<openclawDir>/state/openclaw.sqlite` | R/W |
| `…/plugin-index.js:97-118` | `SELECT * FROM installed_plugin_index WHERE index_key = 'installed-plugin-index'`; reads `install_records_json` | R |
| `…/plugin-index.js:250-266` | `BEGIN IMMEDIATE; DELETE FROM installed_plugin_index WHERE index_key = ?; COMMIT` | W |
| `…/plugin-index.js:7-8, 132-133, 238-248` | legacy `<openclawDir>/plugins/installs.json` — merges `installRecords`/`records`/`plugins[].installRecord` shapes | R/W |
| `lib/cli/openclaw-startup-state-repair/codex-sidecars.js:7-14` | `<openclawDir>/sessions/sessions.json`, `<openclawDir>/agents/*/sessions/sessions.json` — **still assumes a JSON session store** | R |
| `…/codex-sidecars.js:24-33` | transcript path from `entry.sessionFile` or `<sessionId>.jsonl` — **JSONL transcript assumption** | R |
| `…/codex-sidecars.js:5, 58-88, 108-153` | `*.codex-app-server.json` sidecars; archives to `.migrated[.N]`; matches `entry.agentHarnessId` | R/W |
| `lib/server/auth-profiles.js` | `agents/<id>/agent/openclaw-agent.sqlite` — see §3.1 | R/W |
| `lib/cli/openclaw-doctor-oauth-guard.js:62-92` | same auth DB | R/W |
| `lib/server/onboarding/import/import-scanner.js:115-137` | detects `state/openclaw.sqlite(-wal/-shm)` and `agents/*/agent/openclaw-agent.sqlite(-wal/-shm)`; `:326-333` **rejects** live-SQLite import sources with "Prepare a portable snapshot that exports cron/auth data to JSON and excludes SQLite, WAL, and SHM files" | R |
| `lib/server/onboarding/import/import-scanner.js:403-417` | legacy `cron/jobs.json` (+ `cron/jobs.json.bak`) — **JSON cron store assumption for imports** | R |
| `lib/server/onboarding/import/portable-cron-import.js:3-14` | reads `<openclawDir>/cron/jobs.json`, calls `saveCronStore()` from the plugin SDK, then deletes the JSON | R/W |
| `lib/server/onboarding/import/portable-auth-import.js:3-19` | `agents/*/agent/auth-profiles.json` → `syncConfigAuthReferencesForAgent` | R |
| `scripts/prepare-openclaw-migration.sh:187-227` | `SELECT DISTINCT store_key FROM cron_jobs`; `SELECT job_json, state_json FROM cron_jobs WHERE store_key=? ORDER BY sort_order, updated_at, job_id`; expects `store_key === <root>/cron/jobs.json` | R |
| `scripts/prepare-openclaw-migration.sh:229-268` | `SELECT store_json FROM auth_profile_store WHERE store_key='primary'` + `auth_profile_state` | R |
| `lib/server/routes/browse/sqlite.js:7-129` | generic read-only SQLite browser (`sqlite_master`, table dumps) — can open OpenClaw DBs | R |
| `lib/server/routes/browse/constants.js:35-40` | `.sqlite`, `.sqlite3`, `.db`, `.sqlitedb` treated as SQLite | |
| `lib/server/internal-files-migration.js:17-25` | appends to `<openclawDir>/.gitignore`: `state/`, `state/**`, `cron/`, `cron/**`, `agents/*/agent/*.sqlite`, `agents/*/agent/*.sqlite-*` — comment `:18` "OpenClaw runtime databases, WAL files, and legacy cron files stay local" | W |
| `lib/server/internal-files-migration.js:6-15, 33-51, 67-137` | whitelists `hooks/transforms/**` and `pages/**`; moves `hourly-git-sync.sh` and `.cli-device-auto-approved` into `<openclawDir>/.alphaclaw/` | W |
| `lib/setup/gitignore:21-28` | same rules with comment "OpenClaw 2026.6.10+ stores cron and other runtime state in SQLite" — **explicit version assumption** | |
| AlphaClaw-owned DBs (not OpenClaw's): `lib/server/db/{auth,usage,webhooks,watchdog,doctor}/index.js` → `<root>/db/{auth,usage,webhooks,watchdog,doctor}.db`; `lib/plugin/usage-tracker/index.js:111-118` → `<root>/db/usage.db` tables `usage_events`, `tool_events` | W |

**Remaining JSON/JSONL assumptions to re-verify against 2026.9.4:** `sessions/sessions.json` + `<id>.jsonl` transcripts (codex-sidecars), `cron/jobs.json` (import path only), `plugins/installs.json`, `devices/pending.json` + `devices/paired.json`, `credentials/<ch>-pairing.json`, `credentials/<ch>-<account>-allowFrom.json`, `credentials/whatsapp/<id>/creds.json`, `credentials/oauth.json`, `identity/device.json`, `identity/device-auth.json`, `exec-approvals.json`, `agents/*/agent/auth-profiles.json`.

---

## 5. Backup and restore

### 5.1 Git-based backup (the primary mechanism)
- `lib/setup/gitignore` — the whitelist that defines what is backed up out of `<OPENCLAW_DIR>`: allow `workspace/**` (minus `workspace/.openclaw/`), `gogcli/state.json`, `skills/**`, `hooks/transforms/**`, `pages/**`, `openclaw.json`, `.gitignore`. Exclude `db/`, `state/`, `cron/`, `agents/*/agent/*.sqlite*`.
- `lib/server/internal-files-migration.js:107-121` appends the newer exclusions to an existing `.gitignore` at boot.
- `bin/alphaclaw.js:287-430` `runGitSync()` — `git add -A [-- <file>]`, `commit`, `push origin <branch>`; uses `GITHUB_TOKEN` via a temp askpass script (`:344-360`); path validation in `lib/cli/git-sync.js:7-20` ("must stay within /data/.openclaw").
- `lib/setup/hourly-git-sync.sh` → `alphaclaw git-sync -m "Auto-commit hourly sync …"`; installed as `/etc/cron.d/openclaw-hourly-sync` (`lib/server/routes/system.js:80-133`).
- `lib/server/github-backup.js:1-21` — `getGithubBackupConfig` / `hasGithubBackupConfig` from `GITHUB_TOKEN` + `GITHUB_WORKSPACE_REPO`.
- `lib/cli/openclaw-config-restore.js:58-134` — **restore**: if `openclaw.json` is missing, `git show origin/<branch>:openclaw.json` and write it. `:136-157` `ensureMainUpstream`.
- Triggered git-syncs: `lib/server/routes/models.js:27-35` (`-f "openclaw.json"`), `lib/server/routes/webhooks.js:147`, `lib/server/routes/telegram.js:123`, `lib/server/onboarding/index.js:784`.

### 5.2 Snapshot / migration scripts
- `scripts/prepare-openclaw-migration.sh` — rsync snapshot of `~/.openclaw`. Excludes (`:129-151`): `.git/`, `agents/*/sessions/`, `agents/*/agent/codex-home/home/.teamyou_key`, `agents/*/agent/codex-home/tmp/`, `plugin-skills/`, `state/`, `*.sqlite`, `*.sqlite-*`, `cron/runs/`, `delivery-queue/`, `logs/`, `media/`, `devices/`, `identity/`, `telegram/`, `subagents/`, `canvas/`, `completions/`, `update-check.json`, **`clawdbot.json` / `clawdbot.json.bak*`** (pre-rename legacy name), `openclaw.json.bak*`, `cron/jobs.json.bak`. `--keep-credentials` optional (`:155`). Then exports cron + auth from SQLite to JSON (`:161-269`, see §4).
- `scripts/publish-openclaw-migration.sh` — git init + push of that snapshot.
- `docs/openclaw-to-alphaclaw-migration.md` — the narrative doc for the above.

### 5.3 Config backups written by AlphaClaw
- `lib/cli/openclaw-plugin-compat.js:775-799` — `<openclawDir>/.alphaclaw/openclaw.pre-plugin-reconcile.<stamp>[.N].bak` before suppression-based plugin install.
- `lib/cli/openclaw-startup-state-repair/plugin-index.js:215-236` — `<rootDir>/migrations/openclaw-plugin-index-conflict-<ts>.json` (includes the raw SQLite row).
- `lib/cli/openclaw-startup-state-repair/codex-sidecars.js:156-159` — `<rootDir>/migrations/openclaw-residual-codex-sidecars-<ts>` archive stem.
- `lib/server/agent-vault/service.js` — **deletes** `openclaw.json.bak*` files that still contain a swept secret.
- `lib/server/auth-profiles.js:24-28, 1003-1027` — recognizes and purges OpenClaw's own rotated auth backups.
- `lib/server/doctor/workspace-snapshot-manager.js` + `workspace-fingerprint.js` — workspace *fingerprint* snapshots (not a restore mechanism); `workspace-fingerprint.js:379-397` weights `agents.md`, `tools.md`, `bootstrap.md`, `memory.md`, `user.md`, `identity.md`, `hooks/bootstrap/**`, `skills/**`.

---

## 6. Gateway lifecycle & protocol

### 6.1 WS protocol — `lib/server/chat-ws.js`
- `:22` **`kGatewayProtocolVersion = 4`**; sent as `minProtocol`/`maxProtocol` (`:758-760`). Pinned in `tests/server/chat-ws.test.js:107-108`.
- `:756` connects to `ws://127.0.0.1:<gatewayPort>`.
- `:758-775` connect params: `client {id:"gateway-client", version:"0.1.0", platform, mode:"backend"}`, `role:"operator"`, `scopes` = `kGatewayChatBridgeScopes` (`:30-36`: `operator.admin|read|write|approvals|pairing`), `caps:["tool-events"]`, `auth:{token}`, `userAgent:"alphaclaw-chat-bridge/0.1.0"`.
- `:785-798` handshake: waits for `{type:"event", event:"connect.challenge"}` then sends `{type:"req", method:"connect"}`; success is `{type:"res", ok:true, payload:{type:"hello-ok"}}` (`:799-806`).
- Frame envelope: `{type:"req"|"res"|"event", id, method, params, ok, payload, error}` (`:847-873`).
- Methods used: `chat.send` (`:907`), `chat.abort` (`:963`), `chat.history` (`:1016-1017`); `sessions.list` + `chat.send` in `lib/server/bootstrap-kickoff.js:216, 240`; `cron.{list,status,run,update,get,runs}` in `lib/server/cron-service.js:85-193`.
- Error-string matching against gateway messages (`:380-408`): `"gateway is not connected"`, `"econnrefused"`, `"connect failed"`, `"timed out"`, `"protocol mismatch"`, `"method not found"/"unknown method"`, `"gateway request failed"`.
- `:12-17` hides OpenClaw's restart-recovery user turn by exact string match: `"[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response."` — **exact-text dependency on OpenClaw 2026.7.1**.
- `:38-90` transcript block parsing tolerates `text`, `thinking`, `toolCall`/`tool_call`, `toolResult`/`tool_result` part types.

### 6.2 Supervisor — `lib/server/gateway.js`
- `:349-353` `hasGatewayReadyLog()` — **readiness is detected by parsing stdout/stderr** for `"http server listening ("` or `/(?:^|\])\s*listening on wss?:\/\//`. Comment `:349` explicitly says "OpenClaw 2026.7.1 reports readiness from the replacement process itself."
- `:365-396` `parseMigrationLockRetryAfterMs()` — parses `startup migrations are already running … after <ISO8601>` out of gateway output; `kMigrationLockMaxWaitMs = 6min`, grace 3s.
- `:122-156` cleans `.openclaw-install-stage[-*]` dirs inside the openclaw dist `extensions/`; `:170-179` `isInstallStageFailure()` matches `/ENOTEMPTY|openclaw-install-stage/i`.
- `:181-210` plugin runtime-deps preflight (`openclaw plugins list --json`), with one cleanup+retry.
- `:267-296` TCP readiness probe on `GATEWAY_HOST:<port>`; timeouts `kGatewayRestartReadyTimeoutMs = 120s`, poll 500ms, short cmd 15s, lifecycle cmd 90s.
- `:489-516` `runGatewayColdStart()` — single-owner serialization via `lib/server/gateway-lifecycle-ownership.js`; revision counters to coalesce concurrent restart requests.
- `:527-638` `launchGatewayProcess()` — the long-lived `openclaw gateway run` child; `:589-636` exit handling with `expectedExitReason: "migration_retry" | "managed_restart"` and `recoveryWindowMs` handed to the watchdog.
- `:699-720` `restartGateway` / `restartGatewayLight` (light path uses `openclaw gateway restart`).
- `:722-746` SIGTERM/SIGINT handler; comment `:730-733`: never call `openclaw gateway stop` during a systemd swap because the CLI itself runs startup migrations.
- `:228-239` onboarding backfill via legacy `skills/control-ui/SKILL.md`.
- `lib/server/gateway-boot-preparation.js` — blocks gateway startup until Agent Vault enrollment reports ready (5 s polling).

### 6.3 HTTP/WS proxying
- `lib/server.js:3, 229-239` — `http-proxy@^1.18.1` `createProxyServer({target:getGatewayUrl(), ws:true, changeOrigin:true})`.
- `lib/server/routes/proxy.js:211-221` — `/openclaw` and `/openclaw/*` (prefix stripped) and `/assets/*` proxied to the gateway, behind `requireAuth`.
- `lib/server/routes/proxy.js:240-243` — `/api/*` not in `SETUP_API_PREFIXES` (`lib/server/constants.js:581-605`) is proxied to the gateway.
- `lib/server/routes/proxy.js:6-7, 89-191, 227-238` — OpenAI-compat proxy for `/v1/{chat/completions,responses,embeddings,models[/id]}` with bearer == gateway token (timing-safe), hop-by-hop + `set-cookie` stripping.
- `lib/server/watchdog-terminal-ws.js:102-137` — WS upgrades: `/openclaw*`, `/api/ws/chat`, watchdog terminal path; everything else `proxy.ws(...)` to the gateway.

### 6.4 Health / watchdog / doctor
- `lib/server/watchdog.js:447-500` `probeGatewayHealth()` — `fetch(resolveGatewayHealthUrl())`, timeout `kWatchdogHealthTimeoutMs` (default 10 s); failure types `missing_health_url`, `gateway_unhealthy`.
- `lib/server/watchdog.js:23, 151-160` — repair is `alphaclaw openclaw-doctor-guard -- openclaw doctor --non-interactive --fix`.
- `lib/server/watchdog.js:42-45` — treats these gateway stderr strings as benign: `"another gateway instance is already listening"`, `"gateway already running under systemd"`, `"existing gateway is healthy"`, `"gateway already running"`.
- `lib/server/watchdog.js:550-608` — post-doctor `reconcileOpenclawPlugins`, logging `currentOpenclawVersion`/`targetOpenclawVersion`.
- `lib/server/watchdog.js:610-700` — repair gating on `isGatewayLifecycleBusy()`, `awaiting_health_recovery`, crash-loop thresholds (`constants.js:287-300`).
- `lib/server/openclaw-doctor-repair.js:3-45` — 120 s timeout, `OPENCLAW_SERVICE_REPAIR_POLICY=external`.
- `lib/server/startup.js:49-78` `runRepairableConfigStep()` — one doctor-repair retry per boot on `OpenclawConfigReadError`.
- `lib/server/doctor/service.js:235-251` — `openclaw gateway call agent --expect-final --json` contract (params shape above).
- `lib/server/restart-required-state.js`, `lib/server/onboarding/runtime-readiness.js:20-24` (`chat.history` probe with `sessionKey:"main"`).
- SSE: `lib/server/operation-events.js:109` (`text/event-stream`), consumed by `lib/public/js/lib/sse.js` with `phase`/`done` events.
- In-process self-restart: `lib/server/alphaclaw-version.js:323` re-spawns `process.argv`; `lib/server/openclaw-version.js:128-204` installs `openclaw@latest` into a temp dir then `cp -af` into the real `node_modules` (timeout `kOpenclawUpdateCopyTimeoutMs = 5min`), then reconciles plugins and restarts the gateway (`:224-277`).

### 6.5 Devices / pairing
- `lib/server/managed-gateway-device.js` — Ed25519 identity at `<openclawDir>/identity/device.json`; cached operator token at `identity/device-auth.json`; pending requests at `devices/pending.json`; scopes `operator.{approvals,pairing,read,talk.secrets,write}` (`:8-23`); uses the plugin-SDK `approveDevicePairing`/`listDevicePairing`.
- `lib/server/routes/pairings.js` — `credentials/<ch>-pairing.json` store, plus `openclaw pairing list/approve` CLI.
- Frontend pairing/dashboard handoff: `lib/public/js/hooks/dashboard-launcher-helpers.js` (localStorage keys `openclaw-device-identity-v1`, `openclaw.device.auth.v1`; `clientId === "openclaw-control-ui"` / `clientMode === "webchat"`).

---

## 7. Plugins & catalogs

- **Manifest generator**: `scripts/generate-openclaw-compatibility-manifest.mjs` (see §2.3); npm scripts `generate:openclaw-compatibility-manifest` + `prepack` (`package.json:34,37`).
- **Manifest**: `lib/openclaw-compatibility.manifest.json` — 2026.7.1 pin, `managedPlugins` with `minHostVersion` constraints (e.g. `>=2026.6.9` for clickclack/irc/mattermost/signal/sms, `>=2026.5.12-beta.1` for slack, `>=2026.6.8` for raft), and some non-`2026.x` third-party versions (`wecom-openclaw-plugin@2026.5.7`, `openclaw-plugin-yuanbao@2.15.0`, `@tencent-weixin/openclaw-weixin@2.4.6`, `@zalo-platforms/openclaw-zaloclawbot@0.1.4`).
- **Reconciler**: `lib/cli/openclaw-plugin-compat.js`
  - `:73-90` manifest load + `openclawVersion` required.
  - `:201-216` `parseOpenclawVersion` / `detectOpenclawVersion` from `openclaw --version`.
  - `:218-232` lock at `<openclawDir>/.alphaclaw/openclaw-plugins.lock.json` (`schemaVersion:1`, `managedBy:"alphaclaw"`, `alphaclawVersion`, `openclawVersion`, `reconciledAt`, `plugins{}`).
  - `:234-255` `parsePluginList()` — requires `plugins` array in `openclaw plugins list --json`; error "OpenClaw plugin inventory is missing the plugins array".
  - `:480-568` `getPluginRelevanceReasons()` — relevance from `plugins.slots` (`:506`), backends, `agentRuntime`, provider/webSearch/webFetch/memory/speech/media provider refs, env vars.
  - `:600-737` config-suppression machinery (walks `plugins.slots`, protected plugin/provider config paths) for installs that fail on dangling references; `:757-773` `isOpenclawConfigReferenceError`.
  - `:145-199` retry helpers for OpenClaw config-mutation conflicts and "plugin already exists".
  - `:897-1087` `reconcileOpenclawPlugins()` — installs/updates to `definition.version`, re-reads inventory, throws if version mismatch after reconcile; applies `manifest.migrations[].whenUpgradingFromOpenclaw` via `satisfiesVersionRange` (`:52-71`; note the shipped manifest has **no** `migrations` key).
  - `:866-881` `enforcePendingTeamyouBootstrapGate()` after every install and at the end.
  - Callers: `bin/alphaclaw.js:623-645` (`alphaclaw reconcile-openclaw-plugins`), `lib/server.js:11`, `lib/server/watchdog.js:550-571`, `lib/server/openclaw-version.js:242-250`, `lib/server/onboarding/index.js:689`, `lib/server/routes/models.js:10`, `lib/server/routes/onboarding.js:9`.
- **TeamYou gating**: `lib/server/teamyou-memory-activation.js`
  - `:7-18` ids `active-memory`, `openclaw-teamyou-memory`, skill `teamyou`; workspace state file `openclaw-workspace-state.json`; `BOOTSTRAP.md`; activation marker `<openclawDir>/.alphaclaw/teamyou-memory-activated.json`; 30 s poll.
  - `:70-125` bootstrap-completion heuristics — `IDENTITY.md`/`AGENTS.md`/`USER.md` present without `BOOTSTRAP.md` means the ritual completed; reasons `setup_completed_marker`, `bootstrap_pending`, `bootstrap_file_absent`.
  - `:166-172` `plugins.slots.memory === "openclaw-teamyou-memory"` detection.
  - `:380-383` comment: `plugins.slots.memory` is **never written** here — memory-core owns the slot; `:444-446` resets a stale slot back to `"memory-core"`.
  - `:490-511` activation writes `plugins.entries[teamyou].enabled=true`, `active-memory.config.enabled=true`, `skills.entries.teamyou.enabled=true`, then restarts the gateway.
- **Memory slot handling** also referenced in `lib/cli/openclaw-plugin-compat.js:454-459, 611, 717-718` (`memoryEmbeddingProviders`, `memory-provider-reference`).
- **Bundled AlphaClaw plugins loaded into OpenClaw**: `lib/plugin/usage-tracker` (hooks `llm_output`, `tool_result_persist`) and `lib/plugin/agent-vault` (hooks `before_agent_finalize`, `reply_payload_sending`; tool `ensure_service_access`). Registered by path into `plugins.load.paths` (`lib/server/usage-tracker-config.js:11-22, 63-65, 94-96`).
- **Plugin postinstall**: `scripts/openclaw-install-utils.js:74-81` runs the openclaw package's `scripts/postinstall-bundled-plugins.mjs`; `scripts/restore-openclaw-bundled-plugin-deps.js` is the entry point.
- **official-external-*-catalog.json** usage is only in the manifest generator (§2.3) and the manifest's `source.upstreamCatalogs` URLs.

---

## 8. CLI / onboarding assumptions

- **`openclaw onboard` flags** — `lib/server/onboarding/openclaw.js:110-127`: `--non-interactive --accept-risk --flow quickstart --gateway-bind loopback --gateway-port 18789 --gateway-auth token --gateway-token <t> --no-install-daemon --skip-health --workspace <dir>`. Auth branches `:128-192` use `--auth-choice <choice>` with provider-specific flags from `kProviderApiKeyOnboardAuth` (`:28-79`): `apiKey/--anthropic-api-key`, `openai-api-key`, `gemini-api-key`, `openrouter-api-key`, `ai-gateway-api-key`, `cloudflare-ai-gateway-api-key`, `kilocode-api-key`, `cohere-api-key`, `cerebras-api-key`, `groq-api-key`, plus `--auth-choice token --token-provider anthropic --token …` and `--auth-choice skip`. Invoked at `lib/server/onboarding/index.js:627-642`.
- Gateway port `18789` is also special-cased in `bin/alphaclaw.js:743`.
- **Import scanner** — `lib/server/onboarding/import/import-scanner.js`: workspace files `AGENTS.md, SOUL.md, USER.md, TOOLS.md, MEMORY.md, IDENTITY.md, HEARTBEAT.md, BOOTSTRAP.md` (`:9-18`); credential dirs `credentials, identity, devices, gogcli, composio` (`:34`); managed files `hooks/bootstrap/AGENTS.md`, `hooks/bootstrap/TOOLS.md`, `cron/system-sync.json`, `.gitignore` (`:36-41`); nested-config rejection (`:29-32, 323`).
- **Portable auth/cron import** — §4.
- **Bootstrap ritual** — `lib/server/onboarding/workspace.js`:
  - `:120-156` `patchSeededBootstrapConnectStep()` rewrites OpenClaw's seeded `BOOTSTRAP.md` section heading **`"## Connect (Optional)"`** into `"## Connect (Required)"`. **Exact upstream heading dependency.**
  - `:158-226` `syncBootstrapPromptFiles()` copies `lib/setup/core-prompts/AGENTS.md` and renders `lib/setup/core-prompts/TOOLS.md` into `<workspace>/hooks/bootstrap/{AGENTS.md,TOOLS.md}` for the main workspace and every `agents.list[].workspace`.
  - `:228-264` `ensureOpenclawRuntimeArtifacts()` symlinks `<openclawDir>/.env` → the AlphaClaw `.env`; runs `gog auth keyring file`.
  - Injection is wired through `hooks.internal.entries["bootstrap-extra-files"].paths` (§1.5).
  - `lib/server/bootstrap-kickoff.js:236-256` re-patches `BOOTSTRAP.md` right before sending the first `chat.send`.
  - `lib/server/doctor/bootstrap-context.js:10-25` models OpenClaw's injection set and `injectMode` (`always` vs `first_run_only`) and `:7-8` encodes OpenClaw's truncation behavior ("first 70% / last 20% / cuts the middle 10%") with limits 20 000 / 150 000 chars.
- **Agent runtime selection** — runtime ids `codex` and `claude-cli` only (`lib/server/onboarding/validation.js:118-124`); plugin mapping `{codex:"codex","claude-cli":"anthropic"}` (`lib/server/auth-profiles.js:1089-1092`).
- **`tools.web.search`** — `lib/server/onboarding/openclaw.js:411-430` (Codex native search, `mode:"cached"`), `lib/server/web-search-config.js:22-55` (SearXNG fallback via `SEARXNG_BASE_URL`, sets `plugins.bundledDiscovery="compat"`), `lib/server/onboarding/import/secret-detector.js:85` (`tools.web.search.apiKey` → `BRAVE_API_KEY`).
- **Heartbeat** — `HEARTBEAT.md` in the import scanner and doctor context; cron `wakeMode: "next-heartbeat"` (`lib/server/cron-service.js:148-154`; UI `lib/public/js/components/cron-tab/cron-job-settings-card.js:22`); `HEARTBEAT_OK` string matched in `lib/public/js/components/cron-tab/cron-helpers.js:348,375`.
- **Skills installed into OpenClaw**: `lib/setup/skills/gog-cli/*`, `lib/setup/skills/composio/*` via `installGogCliSkill` / `installComposioSkill` (`lib/server/onboarding/index.js:702-703`).

---

## 9. Dual-VPS / gateway host

- `lib/server/onboarding/gateway-tailscale-client.js` — SSH to the security-gateway VPS; `:15-18` comment: the **clawctl-installed forced command** accepts exactly one JSON request; `:148` `spawn("ssh", …)`; `:347` `enable_ssh_bridge`.
- `lib/server/onboarding/gateway-tailscale-finalizer.js` — `:11-12` `kConnectivityModeSecurityGateway = "security_gateway"`, `kGatewayHostRole = "security_gateway"`; `:81` requires `.ts.net` DNS names; `:278-311` configure/verify gateway join, `agentVaultOperatorUrl`, `sealed`.
- `lib/server/onboarding/tailscale-finalizer.js` — `:17` tag `tag:openclaw`; `:58` requires `/usr/local/sbin/alphaclaw-tailscale-expose` + sudo NOPASSWD (older clawctl → reprovision); `:411` `tailscale status --json`; `:637-651` `ALPHACLAW_PUBLIC_BASE_URL = https://<dns>:<funnelPort>`; `:705-710` enforces exact Serve/Funnel ports.
- `lib/server/onboarding/tailscale-env.js`, `lib/server/agent-vault/service.js:190-205` (`ALPHACLAW_GATEWAY_SETUP_{HOST,PORT,USER,IDENTITY_FILE,KNOWN_HOSTS_FILE}`).
- `lib/server/constants.js:303-327` `kSystemVars` includes `ALPHACLAW_GATEWAY_SETUP_*`, `ALPHACLAW_GATEWAY_TRUSTED_PROXY_IP`, `ALPHACLAW_GATEWAY_SETUP_SEALED`, `ALPHACLAW_GATEWAY_PENDING_{SETUP_URL,PUBLIC_BASE_URL}`, `ALPHACLAW_TAILSCALE_{DNS,DEVICE_ID,HOST_ROLE}`, `AGENT_VAULT_OPERATOR_URL`, `TEAMYOU_AGENT_VAULT_ENTRY_URL`.
- Egress mediation / loopback proxy shim: `lib/server/agent-vault/proxy-shim.js` (§3.6), `lib/server/agent-vault/vault-fetch.js:27` (`CONNECT`), `lib/agent-vault-links.js:30` (`/openclaw/agent-vault/inst_<id>` URL shape).
- `lib/server/deployment-surface.js` — ingress-surface classification (`x-alphaclaw-ingress-surface`), public path prefixes `/hooks`, `/webhook`, `/oauth`, `/gmail-pubsub`, `/auth/google/callback`, bootstrap handoff `/api/onboard/runtime-ready.svg`.
- systemd: referenced in `lib/server/gateway.js:730-733` (service swap semantics) and `lib/server/watchdog.js:43` (`"gateway already running under systemd"`); no unit files in this repo.
- Specs: `docs/security-gateway-rollout-notes.md`, `docs/egress-enforcement-spec.md`, `docs/enhanced-workload-privileges-spec.md`, `docs/vault-brokered-{channels,model-keys}-spec.md`, `docs/oauth-refresh-broker-spec.md`, `docs/oauth-broker-v2-*.md`.

---

## 10. Control UI / dashboard, and version/update checks

- **Proxy mount**: `/openclaw` and `/openclaw/*` → gateway Control UI (`lib/server/routes/proxy.js:211-218`); `/assets/*` (`:219-221`); WS upgrade passthrough (`lib/server/watchdog-terminal-ws.js:103, 137`).
- **CORS allowlist write**: `gateway.controlUi.allowedOrigins` (`lib/server/gateway.js:798-808`).
- **Dashboard token**: `GET /api/gateway/dashboard` (`lib/server/routes/system.js:1061-1079`) — prefers `gateway.auth.token` from config (resolving OpenClaw secret refs), else `openclaw dashboard --no-open` and scrapes `[#?&]token=…` from stdout (`:250-258`); URL form `/openclaw/#token=<t>` (`:248-249`).
- **Frontend launcher**: `lib/public/js/hooks/dashboard-launcher-helpers.js` — reads OpenClaw's own browser storage keys `openclaw-device-identity-v1` and `openclaw.device.auth.v1` (`:15-16`), expects `{version:1, deviceId, publicKey, privateKey}` and `{version:1, deviceId, tokens.operator:{token,scopes}}` (`:36-67`); pairing rows matched by `clientId === "openclaw-control-ui"` or `clientMode === "webchat"` (`:69-73`); default URL `/openclaw` (`:90`, `use-dashboard-launcher.js:24,267`).
- **Legacy onboarding artifact**: `<openclawDir>/skills/control-ui/SKILL.md` (`lib/server/gateway.js:230-236`).
- **Agent-authored pages** (AlphaClaw-served, not Control UI): `lib/server/routes/pages.js:24-123` serves `<openclawDir>/pages/**` sandboxed.
- **OpenClaw version/update** — `lib/server/openclaw-version.js`: `openclaw --version` (60 s cache, `constants.js:245`), `openclaw update status --json` parsed for `availability.latestVersion` / `update.registry.latestVersion` / `availability.available` (`:73-86`); update installs `openclaw@latest` (not the pin) into a temp dir then `cp -af` over `node_modules` (`:128-204`). `lib/server/helpers.js` `normalizeOpenclawVersion`.
- **AlphaClaw version/update** — `lib/server/alphaclaw-version.js:104-260`: registry check against `kAlphaclawRegistryUrl` (`constants.js:250`), reads `data.versions[latest].dependencies.openclaw` (`:120`) to surface `latestOpenclawVersion`; `updateStrategy.action === "self-update"` (`:161`); temp-dir install + copy + `restartProcess()` (`:243-323`).
- `lib/server/constants.js:249` `kOpenclawRegistryUrl = "https://registry.npmjs.org/openclaw"`.
- UI: `lib/public/js/components/{update-modal.js,update-action-button.js}`, `general/use-general-tab.js`.

---

## 11. Tests that pin OpenClaw behavior

### 11.1 Explicit version pins in tests
| File:line | Pinned value |
|---|---|
| `tests/server/model-catalog-bootstrap.test.js:33-38` | asserts `catalog.compatibilityManifest.openclawVersion === package.json.dependencies.openclaw` and `catalog.openclawVersion` starts with it — **will fail the moment the pin is bumped without regenerating the catalog** |
| `tests/cli/openclaw-plugin-compat.test.js` | `2026.5.6` throughout (182 openclaw refs); `:294-299` `compareVersions`/`satisfiesVersionRange` cases (`2026.4.9 < 2026.4.10`, `>=2026.4.25`) |
| `tests/cli/openclaw-plugin-compat-vault-env.test.js:65,77` | `2026.7.1` |
| `tests/cli/openclaw-startup-state-repair.test.js:58-87` | `@openclaw/codex@2026.5.20`, `@openclaw/slack@2026.5.20`, `hostContractVersion: 2026.5.20`, `@openclaw/codex@2026.7.1` |
| `tests/bin/alphaclaw.test.js:298-321` | plugin versions `2026.5.6` → `2026.7.1`, `"OpenClaw 2026.5.6\n"` version output |
| `tests/server/cron-service.test.js:23,111` | test names assert "the 2026.7.1 SQLite-backed cron store through Gateway RPC" and "preserves 2026.7.1 routing values" |
| `tests/server/openclaw-version.test.js:201-241` | `openclaw 2026.6.8` → `2026.6.10`, `availability.latestVersion` shape |
| `tests/server/watchdog.test.js:443-449` | `currentOpenclawVersion`/`targetOpenclawVersion` `2026.5.20` |
| `tests/server/alphaclaw-version.test.js:36-145` | `2026.4.x` openclaw versions from the registry payload |
| `tests/server/routes-models.test.js:40` | `readOpenclawVersion: () => "2026.4.15"` |
| `tests/cli/alphaclaw-migrations.test.js:145` | "legacy OpenClaw 2026.5.6 Codex config" |

### 11.2 Tests pinning OpenClaw output formats / CLI JSON shapes / protocol
- `tests/server/chat-ws.test.js` — WS handshake: `connect.challenge` event, `minProtocol/maxProtocol: 4` (`:107-108`), `payload:{type:"hello-ok"}` (`:71,178,273`).
- `tests/server/cron-service.test.js` — `cron.list/get/update/run/runs/status` gateway-RPC payload shapes.
- `tests/cli/openclaw-plugin-compat.test.js` — `openclaw plugins list --json` shapes, `npm:<pkg>@<ver>` install specs, `--pin`, `--version` output parsing.
- `tests/cli/openclaw-startup-state-repair.test.js` — `installed_plugin_index` SQLite row + `plugins/installs.json` shapes, codex sidecar naming.
- `tests/cli/openclaw-doctor-oauth-guard.test.js` — `auth_profile_store` SQLite + `auth-profiles.json` shapes.
- `tests/server/auth-profiles.test.js` (67 refs) — auth store schema, legacy backup patterns, config `auth.profiles`/`auth.order` sync.
- `tests/server/openclaw-thinking.test.js` — loads the **real pinned openclaw dist** and asserts `normalizeThinkLevel` mappings (`high→high`, `auto→adaptive`, `extra high→xhigh`, `ultrathink→high`, `invalid→null`) and that `openai/gpt-5.5` offers a `high` level. **This test executes against node_modules and is the fastest canary for a dist-layout change.**
- `tests/server/model-catalog-cache.test.js` — cache invalidation on `openclawVersion` change; `openclaw models list --all --json` parsing.
- `tests/server/onboarding-openclaw.test.js` (93 refs) — managed config shell, onboard arg construction.
- `tests/server/routes-onboarding.test.js` (105 refs), `tests/server/agents-service.test.js` (94), `tests/server/teamyou-memory-activation.test.js` (82), `tests/server/exec-defaults-config.test.js` (72), `tests/server/routes-pairings.test.js` (60), `tests/server/gateway.test.js` (44), `tests/server/managed-gateway-device.test.js` (26), `tests/server/import-scanner.test.js` (26), `tests/server/secret-detector.test.js` (26), `tests/server/usage-tracker-config.test.js` (18), `tests/server/webhooks.test.js` (17), `tests/server/telegram-workspace.test.js` (17), `tests/scripts/openclaw-install-utils.test.js` (17), `tests/server/portable-cron-import.test.js` (7).
- `tests/frontend/dashboard-launcher-helpers.test.js` — OpenClaw browser storage keys / `openclaw-control-ui` clientId.
- `tests/frontend/browse-file-policies.test.js` + `tests/server/browse-path-utils.test.js` — `lib/public/shared/browse-file-policies.json` protected/anchored OpenClaw paths.

---

## 12. Hardcoded `2026.7.1` / `2026.6` / `v2026` outside package.json & lock files

**Non-test source (must be updated for the bump):**
- `lib/openclaw-compatibility.manifest.json:4` `"openclawVersion": "2026.7.1"`
- `lib/openclaw-compatibility.manifest.json:7` `"openclawGitRef": "v2026.7.1"`
- `lib/openclaw-compatibility.manifest.json:12,17,22` — three `https://github.com/openclaw/openclaw/blob/v2026.7.1/scripts/lib/official-external-*-catalog.json` URLs
- `lib/openclaw-compatibility.manifest.json` — ~40 `"version": "2026.7.1"` + `"exactNpmSpec": "@openclaw/<x>@2026.7.1"` managed-plugin entries, plus `minHostVersion` ranges `>=2026.4.10`, `>=2026.5.12`, `>=2026.5.12-beta.1`, `>=2026.5.29`, `>=2026.6.8`, `>=2026.6.9`, and pinned third-party versions `@wecom/wecom-openclaw-plugin@2026.5.7`
- `lib/server/model-catalog-bootstrap.json:6` `"openclawVersion": "2026.7.1 (2d2ddc4)"`, `:12` `"openclawVersion": "2026.7.1"`
- `lib/setup/gitignore:21` comment `# OpenClaw 2026.6.10+ stores cron and other runtime state in SQLite.`

**Version-coupled comments/strings in code (no literal version, but explicitly 2026.7.1-specific):**
- `lib/server/gateway.js:349` `// OpenClaw 2026.7.1 reports readiness from the replacement process itself.`
- `lib/server/chat-ws.js:12` `// OpenClaw 2026.7.1 persists this agent-facing recovery instruction as a user turn.`
- `lib/cli/alphaclaw-migrations.js:316,336` migration id/title `"Normalize Codex plugin config for OpenClaw 2026.7.1"` / message `"Codex plugin config is compatible with OpenClaw 2026.7.1"`

**Test files** (see §11.1 for the enumerated list): `tests/bin/alphaclaw.test.js`, `tests/cli/openclaw-plugin-compat.test.js`, `tests/cli/openclaw-plugin-compat-vault-env.test.js`, `tests/cli/openclaw-startup-state-repair.test.js`, `tests/cli/alphaclaw-migrations.test.js`, `tests/server/{cron-service,openclaw-version,watchdog,alphaclaw-version,routes-models,model-catalog-bootstrap}.test.js`.

**Not found anywhere:** no `v2026` references outside the compatibility manifest; no version strings in `.github/workflows/*`.

---

## 13. AlphaClaw-owned migrations that encode OpenClaw upgrade knowledge

`lib/cli/alphaclaw-migrations.js` (ledger `<root>/migrations/alphaclaw-migrations.jsonl`, `:14-16`; failure block threshold 3, `:16`):

| id | target | What it does |
|---|---|---|
| `2026-07-repair-openclaw-plugin-index-conflicts` (`:87-124`) | `state/openclaw.sqlite` + `plugins/installs.json` | merges legacy install records, deletes the `installed_plugin_index` row |
| `2026-07-archive-foreign-harness-codex-sidecars` (`:126-161`) | `agents/*/sessions/*.codex-app-server.json` | archives sidecars owned by another harness |
| `2026-06-remove-active-memory-model-fallback-policy` (`:163-…`) | `openclaw.json` | removes `plugins.entries.active-memory.config.modelFallbackPolicy` |
| `2026-07-normalize-codex-plugin-compatibility` (`:315-…`) | `openclaw.json` | normalizes retired Codex plugin settings for 2026.7.1 |
| `2026-06-prefer-codex-cli-openai-auth-profile` (`:409-…`) | `openclaw.json` | prefers the `openai:codex-cli` OAuth profile for the Codex runtime |
| `2026-07-enable-plugin-approval-forwarding` (`:514-…`) | `openclaw.json` | adds `approvals.plugin.enabled=true`, `approvals.plugin.mode="session"` |
| `2026-07-backfill-channel-plugin-approvers` (`:581-…`) | `openclaw.json` | backfills Discord/Telegram plugin approvers |

Startup-state repair CLI commands (`bin/alphaclaw.js:498-558`): `alphaclaw finalize-openclaw-startup-state`, `alphaclaw verify-openclaw-startup-state` — blockers are `legacy-plugin-index` (`plugins/installs.json` still present after doctor) and `codex-binding-sidecar` (`lib/cli/openclaw-startup-state-repair/index.js:16-32`).

---

## 14. Highest-risk items for the 2026.7.1 → 2026.9.4 bump

1. `lib/server/openclaw-thinking.js` — dist filename scanning + **minified export fallbacks** (`mod.i`, `mod.s`, `sharedMod.s`). Canary: `tests/server/openclaw-thinking.test.js`.
2. `lib/server/cost-utils.js:170-228` — regex scraping of pricing out of dist `.js` bundles.
3. `lib/server/gateway.js:349-353` — readiness detected by log-string parsing; `:371-378` migration-lock message parsing.
4. `lib/server/chat-ws.js:22` — WS `kGatewayProtocolVersion = 4`; `:12-17` exact restart-recovery note text; `:380-408` error-string matching.
5. `openclaw/plugin-sdk/{device-bootstrap,cron-store-runtime,secret-input,runtime-secret-resolution}` subpath exports and their function signatures.
6. `assertOpenclawConfigSafeForMutation`'s dependence on `gateway.mode` existing.
7. Plugin host API used by the two bundled plugins: `api.on("llm_output"|"tool_result_persist"|"before_agent_finalize"|"reply_payload_sending", handler, {priority})` and `api.registerTool({… execute(toolCallId, params)})`.
8. SQLite schemas AlphaClaw writes/deletes directly: `auth_profile_store` / `auth_profile_state` / `schema_meta` in `openclaw-agent.sqlite`, and `installed_plugin_index` / `cron_jobs` in `state/openclaw.sqlite`.
9. Manifest regeneration: upstream `official-external-*-catalog.json` schema at tag `v2026.9.4`, and every `minHostVersion` constraint.
10. `openclaw onboard` flag surface (`--flow quickstart`, `--auth-choice <…>`, `--gateway-*`, `--no-install-daemon`, `--skip-health`).
11. `BOOTSTRAP.md`'s `"## Connect (Optional)"` heading and the workspace-seed file set (`IDENTITY.md`/`AGENTS.md`/`USER.md`).
12. CLI JSON shapes: `plugins list --json` (`plugins[]`), `models list --json` (`models[]`), `update status --json` (`availability.*`), `config get tools.exec --json`, `pairing list --json`, `nodes status|pending --json`, `sessions --json --all-agents`, `gateway call agent --expect-final --json`.
13. Remaining JSON-file assumptions that may have moved to SQLite: `sessions/sessions.json` + `<id>.jsonl`, `plugins/installs.json`, `devices/pending.json`, `credentials/*-pairing.json`, `credentials/*-allowFrom.json`.
14. `lib/server/agent-vault/model-provider-services.js` host list must still match the 2026.9.4 provider registry, and `channel-catalog.json` must still live at `<dist>/channel-catalog.json` with `entries[].openclaw.channel.id`.
