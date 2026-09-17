# OpenClaw Control UI at `v2026.9.4` — audit for the Clawbridge keep/kill decision

Source of truth: `/Users/billk/Development/openclaw` at tag `v2026.9.4` (read via `git show v2026.9.4:<path>`).
Cross-referenced against `scratchpad/clawbridge-feature-inventory.md` (Clawbridge = `@starfoundrystudio/alphaclaw`, pins `openclaw@2026.7.1`).

Stack: Vite + **Lit** SPA in `ui/`, served by the Gateway on the same port as the Gateway WebSocket (`docs/web/control-ui.md`). Routing is a code-split page registry (`ui/src/app-routes.ts`, per-page `route.ts` with `definePage`). Everything talks **directly to the Gateway WS**; there is no intermediate REST server.

---

## 1. Page-by-page inventory

### 1.1 Scope model used throughout

`ui/src/app/operator-access.ts` defines the five client-side gates, mapped onto Gateway scopes
(`operator.read`, `operator.write`, `operator.admin`, `operator.pairing`, `operator.approvals`;
`docs/gateway/operator-scopes.md` adds `operator.questions`, `operator.talk`, `operator.talk.secrets`):

```
hasOperatorWriteAccess     -> operator.write   (default-allow when hello.auth absent)
hasOperatorReadAccess      -> operator.read    (default-allow)
hasOperatorAdminAccess     -> operator.admin   (default-allow)
hasOperatorPairingAccess   -> operator.pairing (default-DENY)
hasOperatorApprovalsAccess -> operator.approvals (default-DENY)
```

Pages mostly gate through `canCallGatewayMethod(snapshot, method, scope)` (`ui/src/lib/gateway-methods.ts`), which checks **both** that the Gateway advertised the method in `hello-ok.features.methods` **and** that the connection holds the scope. That is why the UI degrades gracefully against older/limited Gateways.

Navigation visibility is in `ui/src/app-navigation.ts`: `SETTINGS_NAVIGATION_GROUPS` (admin) vs `NON_ADMIN_SETTINGS_NAVIGATION_GROUPS` (read/write). A non-admin loses Custodian, Communications, Labs, MCP, Memory (settings), Automation, Security, Secrets, Infrastructure, Cloud Workers, Devices-as-settings, Advanced-with-raw-editor, Logs-write, About stays.

### 1.2 Workspace pages (`ui/src/pages/`)

| Dir | What the user does | Key Gateway RPCs / events | Scope |
|---|---|---|---|
| `about` | Static About/product page: version, Control UI build id + commit (copyable), Gateway version, links to openclaw.ai / docs / GitHub / Discord / X, and the Lobsterdex easter egg. No RPCs beyond the shared hello snapshot. `ui/src/pages/about/view.ts` | — | read (any connected) |
| `activity` | Live activity feed across sessions: current work, per-session tool activity, and a **Run inspector** with evidence view (`run-inspector-model.ts`, `run-inspector-evidence-view.ts`). Also person-activity at `/activity/<name>-<profileId>`. | `sessions.list`, `audit.run.inspect`; events `session.message`, `session.tool`, `sessions.changed` | read; run inspector needs audit read |
| `agents` | The agent workspace: per-agent tabs Overview / Files / Tools / Skills / Channels / Automations / Memory. Edits identity (name, emoji, avatar — downscaled in-browser), primary model + ordered fallback chain, tool policy, skill allowlist, channel bindings, per-agent cron, and the Memory/Dreaming panel + Dream Diary. Also "Agent defaults" template row. | `agents.update`, `agents.files.get`/`set`, `config.patch`, `config.set`, `config.openFile`, `cron.run`, `doctor.memory.status`/`dreamDiary`/`resetDreamDiary`/`backfillDreamDiary`/`dedupeDreamDiary`/`repairDreamingArtifacts`/`resetGroundedShortTerm`, `wiki.overview`/`get`/`importInsights` | read to view; **admin** for config/tool/identity writes |
| `approval` | Standalone `/approve/<approvalId>` document (outside the shell) for approving one exec/plugin/system-agent request from a notification deep link. Has its own brand header and ephemeral sign-in. `ui/src/pages/approval/approval-page.ts` | `approval.get`, `approval.resolve` | `operator.approvals` |
| `approvals` | Settings → Approvals: 30-day newest-first history of resolved exec/plugin/system-agent requests, filter by kind, plus **exec approval grants** list/revoke. | `approval.history`, `exec.approval.grants.list`, `exec.approval.grants.revoke` | `operator.approvals`; grants revoke = admin |
| `apps` | Pure marketing/install page: iOS, Android, Watch/Wear, macOS, Windows, Linux, Chrome extension, ClawHub, Discord, docs. One live action — **Pair device** (opens the pairing dialog) and a macOS gateway-launch deep link (`gateway-launch.ts`). | — (pair dialog uses `device.pair.*`) | read; pair CTA needs `operator.pairing` |
| `channels` | Channel hub: connected/configured channel cards for built-in + bundled + external plugin channels, guided setup wizard (`wizard-controller.ts`, `wizard-view.ts`), WhatsApp QR login + logout, Nostr profile editor (publish/import NIP-05, avatar, banner, LN address), per-channel schema-driven config, and the **pairing approvals** queue (approve/dismiss channel pairing requests, optional "make command owner"). | `channels.status`, `web.login.*`, `config.patch`/`config.get`, `plugins.list`, channel pairing approve/dismiss | read to view; **admin** to save config; pairing actions need `operator.pairing` (+ admin for command-owner) |
| `chat` | By far the biggest page (~400 modules). Composer with mentions/slash commands/queue/steering/undo-redo, attachments (images, video with poster, audio waveform player, files), model + thinking-effort picker, goals, background-tasks rail, subagent runs, tool-activity cards with inline diffs, GitHub link chips + hover cards, Mermaid, markdown tables, hosted embeds, split panes, session rail, read markers, typing presence, viewer presence, board/dashboard face, message cut/fork, publish-PR flow, session menu (rename/archive/fork/delete), and a unified side panel hosting **Terminal / Browser / Files / Review / Tasks / Side chat / Desktop / Discussion**. | `chat.history`, `chat.send`, `chat.abort`, `chat.inject`, `sessions.*`, `artifacts.list`/`download`, `talk.client.*`/`talk.session.*`, `workspace.exec`, `sessions.files.get`/`set`, `browser.request`, `terminal.*` | read to view; `operator.write` to send; Terminal = **`operator.admin`** + `gateway.terminal.enabled`; Browser panel = `operator.admin` + `browser.request` advertised; Files edit = admin |
| `cloud-workers` | Settings → Cloud Workers: list/prepare/destroy remote worker **environments**, manage repositories and snapshot policy, Crabbox image list/recover. | `environments.list`, `environments.prepare`, `environments.destroy`, `crabbox.images.list`, `crabbox.images.recover`, `projects.list`, `worktrees.list`, `config.patch` | **admin** (`canCallGatewayMethod(..., "operator.admin")` throughout) |
| `config` | The Settings shell — see §1.3. | `config.get`, `config.set`, `config.apply`, `config.patch`, `config.schema`, `config.schema.lookup` | read to view; **admin** to write |
| `connection` | Settings → Gateway: this browser's own link — Gateway URL, one **Gateway secret** field (token *or* password), default session key, live handshake snapshot (status, uptime, tick, last channels refresh), auth mode readout (`none`/`token`/`password`/`trustedProxy`), plus the **Gateway Host** card (machine, LAN address, OS, runtime, uptime, CPU load, memory, per-mount disk) refreshing every 10 s. | `system.info` | `operator.read` for the host card; the connection fields are browser-local |
| `cron` | Automations: stat cards (count, failing, scheduler state, next wake), filterable job table (All/Active/Paused, search, schedule/last-run filters), per-row menu (run now, run-if-due, clone, pause/resume, remove), full-page job detail with inline editor (prompt, schedule incl. cron expressions + stagger, agent/model/thinking overrides, delivery mode none/announce/webhook, failure alerts, delete-after-run, light context, timeout), run-history tab with delivery-suppression reasons, and starter-automation suggestions. | `cron.list`, `cron.get`, `cron.status`, `cron.runs`, `cron.run`, `cron.scratch.get`, `models.list`, `config.changed` event | read to view; **admin** to mutate (`cron.adminRequired` string) |
| `custodian` | **Ask OpenClaw** — the system setup/repair agent, both as a full page and as a dock panel. Hosted wizards for channel setup, workspace skills, web-search provider, local Gateway setup, and memory import; event chips for degraded channels/reloader; `update.run` from inside the conversation. Onboarding mode (`?onboarding=1`). | `openclaw.chat`, `openclaw.changes.list`, `openclaw.setup.*` (`detect`, `auth.start`, `prepare.start`, `activate`, `verify`), `update.run` | admin-ish (it writes config through the approval gate); hidden from non-admin nav |
| `dashboards` | Gallery of agent-authored dashboard sessions with live previews, filter by query/owner, sort by updated/title. | `sessions.list` (dashboard face query) + `board.*` for previews | read |
| `debug` | Status/health/models snapshots, lane tables, event log (Control UI refresh/RPC timings, slow renders, long-task PerformanceObserver entries), **manual RPC call console**, and the System busyness overlay (CPU, memory, event-loop delay, per-disk free space). | `status`, `health`, `models.list`, `system.info`, `sessions.list`, plus arbitrary operator-entered methods | read for snapshots; the manual RPC caller is bounded by the connection's own scopes |
| `device` / `device-permissions` | "This device" settings — only rendered when a **native** host injects `NativeDeviceSettingsCapability` (iOS/macOS/Android embed). Cookie sync, Chrome extension setup, permissions. Invisible in a plain browser. | native bridge, not Gateway RPC | native embed only |
| `devices` | One inventory joining paired device records + node catalog + live presence. Pin the Gateway host first; approve/reject pending device and node pairings; edit alias; copy device id; rotate/revoke tokens; remove pairing; "Clean up N stale"; generate mobile **setup code / QR**; resource meters from `system.info` and `node.hostStats`; **Desktop** launch for nodes advertising `desktop.stream`; plus the **exec approvals** editor (gateway/node allowlist, ask policy, security mode, per-node binding). | `device.pair.list`/`approve`/`reject`/`remove`, `node.list`, `node.pair.approve`/`reject`/`remove`, `system.info`, `system.execApprovals.get`/`set`, `system.run`; events `device.pair.requested/resolved`, `node.pair.requested/resolved`, `node.hostStats`, `node.runnerInventory.changed`, `system-presence` | pairing actions = **`operator.pairing`**; exec approvals + setup code = **`operator.admin`**; list = read |
| `labs` | Shipped experimental switches, each writing one config leaf (`ui/src/pages/labs/labs-registry.ts`): Code Mode (`tools.codeMode.enabled`), Swarm (`tools.swarm.enabled`), Tool Search (`tools.toolSearch.enabled`), Loop Detection (`tools.loopDetection.enabled`), Local Model Lean (`agents.defaults.experimental.localModelLean`), CLI agents (`gateway.cliAgents.enabled`), **Custom plugin UI** (`gateway.controlUi.experimental.customPlugins`), Audit messages (`logging.audit.messages`), Host desktop (`desktop.host.enabled`), Worker desktop (`cloudWorkers.desktop`). | `config.patch` / `config.set` | **admin** |
| `lobsterdex` | Cosmetic collectible index of lobster-pet palettes seen in this browser. Pure browser state. | — | any |
| `logs` | Live tail of Gateway file logs with filter + export. | `logs.tail` | read (nav hidden from non-admin groups? no — `logs` is in the non-admin System group, so read-scoped users see it) |
| `meetings` | Meeting transcript library: list/read/search transcripts, per-source and per-agent filters, date range, pagination, summary + notes, export/download. Backed by the transcripts plugin surface. | `transcripts.list`, `transcripts.get`, `transcripts.status`, export | read; forbidden state rendered explicitly (`transcripts.forbidden`) |
| `memory-import` | Preview + copy local Claude Code auto-memory, Codex consolidated memory, or Hermes memory into the selected agent workspace; also session backfill preview/apply/rollback. | `migrations.memory.plan`, `migrations.memory.apply`, `memory.sessionBackfill.preview`/`apply`/`rollback` | **admin** |
| `model-providers` | Settings → Models: every configured provider with brand icon, auth state, model availability, live plan/quota/billing where the provider reports it, and local 30-day session spend. Refresh credential state, probe a model, log out of an auth profile, reorder auth profiles. Header launches **Model Setup**. | `models.authStatus`, `models.list`, `models.probe`, `models.authLogout`, `models.authOrderSet`, `usage.status`, `sessions.usage`, `config.get` | read to view; **admin** for auth mutations |
| `model-setup` | First-run/again model setup wizard: detect available providers, authenticate, activate the verified config, then verify with a live inference probe. Handles "restart required" and "Try again". | `openclaw.setup.detect`/`auth.start`/`prepare.start`/`activate`/`verify`, `config.set` | **admin** |
| `new-session` | New-session composer: pick agent, pick model (incl. the Labs CLI-agents group), pick/create a **worktree** and base branch, dispatch to a cloud worker, start from a catalog target (Codex / Claude Code / OpenCode / Pi) including terminal start, set session group, prepare a title. | `sessions.create`, `sessions.dispatch`, `sessions.catalog.list`, `sessions.catalog.startTerminal`, `sessions.title.prepare`, `worktrees.list`/`branches`/`create`, `models.list`, `system.info` | `operator.write` to create; worktree create = **admin** |
| `plugin` | Generic **plugin tab host** — renders a plugin-declared Control UI tab, either a bundled native route, a native page, or a sandboxed iframe for a plugin HTTP route. Address is `/<slug>` when the plugin declared one, else `/plugin?plugin=<id>&id=<tab>`; `?p.<key>=<value>` are tab parameters. Also a logbook view. | reads `hello-ok.controlUiTabs`; the tab's own plugin RPCs | per-tab `requiredScopes` declared by the plugin descriptor |
| `plugins` | Plugins workspace (hub with Installed / Discover / Skills / Workshop tabs): browse installed inventory by category, enable/disable, remove external plugins, browse the curated store, search **ClawHub** inline, install, inspect, manage MCP servers inline, **Customize UI** (select/restore per-surface replacements, **Reload plugin UI**), and request a Gateway restart. | `plugins.list`, `plugins.inspect`, `plugins.install`, `plugins.uninstall`, `plugins.setEnabled`, `plugins.search`, `plugins.catalog.browse`/`categories`/`get`, `config.get`/`set`, **`gateway.restart.request`** | browse/search = `operator.read`; install/enable/disable/remove/MCP + restart = **`operator.admin`** |
| `portals` | Lists node-exposed **portals** (forwarded local services), probes reachability, renders each in a sandboxed iframe (`allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts`), and can close one. | `portal.list`, `portal.close` | read to list; close = write |
| `profile` | The authenticated person's profile: display name, avatar upload (client-side downscale), verified sign-in identity + GitHub account row, Git co-author consent, **My GitHub / System GitHub** connections (device-authorization flow), per-person **model accounts** (connect provider accounts), user prefs, and a link into Usage. | `users.self`, `users.list`, `users.setDisplayName`, `users.setAvatar`, `users.prefs.get`/`set`, `users.github.status`, `users.authConnect.catalog`/`start`/`answer`/`cancel`/`status`, `users.linkAuthProfile`/`unlinkAuthProfile`, `users.listModelAccounts`, `users.selectModelAccount` | `operator.read` + *exact own profile* for personal GitHub/model accounts; System GitHub + per-agent = **admin** |
| `question` | Standalone interactive-question document (mirror of `approval`): answer or skip a structured question the agent asked. | `question.get`, `question.resolve`; events `question.requested`/`resolved` | `operator.questions` |
| `secrets` | Settings → Secrets: team-scoped secret + environment store. List, add (single or **Bulk Add** dotenv paste with quoted multiline), edit, delete; env values stay visible, secret values are never returned after save; `allowedHosts` per entry. Mutation controls hidden when the Gateway does not advertise them. | `secrets.store.list`, `secrets.store.set`, `secrets.store.delete` | **`operator.admin`** for mutations |
| `sessions` | Threads hub with a **Worktrees** tab: list/search sessions, Active/Archived/All filter, pin, rename, archive/restore/delete, fork, unread markers, group-by (custom group, channel, kind, agent, date) with drag-to-group, per-session model/thinking/fast/verbose/trace overrides, overview tiles, context-window meter, compaction branch/restore, reclaim. | `sessions.list`, `sessions.search`, `sessions.create`, `sessions.patch`, `sessions.delete`, `sessions.groups.put`, `sessions.reclaim`, `sessions.compaction.branch`/`restore` | read to view; `operator.write` to mutate own; foreign sessions bounded by `gateway.roles.*.sessions.others` |
| `skill-workshop` | Review pending skill proposals from the Skill Workshop: list, inspect, evaluate, apply, reject, request revision; read workshop state; "Learn from past conversations" starts a normal session. | `skills.proposals.list`/`inspect`/`evaluate`/`apply`/`reject`/`requestRevision`, `skills.workshop.read`, `sessions.create`, `config.patch` | **admin** to apply |
| `skills` | Per-agent skill manager: status report, enable/disable, install (incl. inline ClawHub search), API-key entry, library import/upload/save/read/mutate, create a proposal. | `skills.install`, `skills.update`, `skills.library.list`/`read`/`save`/`mutate`/`import`/`upload`, `skills.proposals.create`/`apply` | read to view; install/enable = **admin** |
| `tasks` | Background-task ledger: active + recent tasks with linked sessions, cancel, retry, dismiss, and a detail inspector. | `tasks.list`, `tasks.get`, `tasks.cancel`, `tasks.retry`, `tasks.dismiss` | read to view; `operator.write` to cancel/retry |
| `usage` | Session-derived token/cost analytics: overview metrics (sessions, tokens, cost, cache hit rate, error rate, throughput, tool calls), top providers/models/agents/channels/tools, daily token+cost charts, hour-of-week mosaic/heatmap, `key:value` query filters, day/hour selection, per-session drill-down with a draggable usage timeline and a **system-prompt breakdown**, Local/UTC toggle, JSON + CSV export, and provider cards with live plan/quota/balance/budget. | `sessions.usage`, `usage.status`, `usage.cost`, `sessions.list` | read; Gateway-wide `usage.cost` denied when the role sets `sessions.others: "none"` |
| `workboard` | Kanban board — **plugin-owned** (bundled `workboard` plugin). The core UI only owns the route + route-location helpers; the board itself is a plugin Control UI contribution and enters the sidebar through its `controlUiTabs` descriptor. | `board.*` | plugin descriptor `requiredScopes` |
| `worktrees` | Tab of the Sessions hub: list managed git worktrees with owner (session / workboard / manual), repo, base branch; create, remove (with force), restore a restorable worktree, and **GC / Clean now**. | `worktrees.list`, `worktrees.branches`, `worktrees.create`, remove/restore/gc | **`operator.admin`** (`worktrees.adminRequired`) |

Canonical URL table for all of the above: `docs/web/urls.md` ("Route table").

### 1.3 Settings sections (`ui/src/pages/config/config-sections.ts`)

`CONFIG_SECTION_KEYS_BY_PAGE` maps curated Settings pages to schema sections. Every section without a curated home falls through to **Advanced**.

| Settings page | Schema sections | What it does |
|---|---|---|
| `communications` | `messages`, `tts`, `transcripts` | Message formatting/delivery defaults, TTS, transcript sources. |
| `appearance` | `__appearance__` (curated), `ui` | Theme (11 built-ins + one imported slot), light/dark/system, accent presets + custom hex, **Typography** (separate Interface and Chat-prose faces), text scale (90–140 %), language (21 locales), chat display prefs (thinking, tool cards, commentary, send shortcut, follow-up mode), sidebar preferences, Lobster visits/sounds + Lobsterdex. `ui/src/pages/config/view-appearance.ts`, `view-appearance-preferences.ts`. |
| `notifications` | `__notifications__` (curated) | Browser Web Push status, subscribe/unsubscribe, test send (`push.web.vapidPublicKey`/`subscribe`/`unsubscribe`/`test`). In the macOS app it shows native permission instead. |
| `security` | `security`, `approvals` | Curated rows for gateway auth, exec policy, browser enablement, tool profile, device auth, mobile pairing, above the schema-backed `security`/`approvals` sections. |
| `automation` | `commands`, `hooks`, `bindings`, `cron` | Slash-command policy, **HTTP hook mappings**, agent bindings, cron defaults. This is the only "webhooks" surface: raw `hooks.mappings` config, no transform authoring or request history. |
| `mcp` | `mcp` | Dedicated MCP page: server rows (transport, enablement, OAuth/filter/parallel summaries), add/enable/disable/remove, operator command hints, scoped `mcp` config editor. |
| `memory` | `memory` | Engine/backend/add-on rows plus the Dreaming tab and the global dreaming cron. |
| `talk` | `talk` | Catalog-driven realtime provider / model / voice pickers (`talk.catalog`) above the `talk` schema section. |
| `infrastructure` | `gateway`, `browser`, `nodeHost`, `discovery`, `acp` | Gateway runtime (port/bind/TLS/reload/publicOrigin/`controlUi.*`), browser tool config incl. "Open links in Control UI browser", node-host, mDNS/DNS-SD discovery, ACP. |
| `updates` | `update` | See §6. |
| `ai-agents` | `agents`, `skills`, `tools`, `session` | Agent defaults, skills policy, tool policy, session policy. Reached as a subpage of Agents. |
| `advanced` | *everything uncurated* | Every remaining schema section, the collapsed **Setup** block, the Channel-settings one-at-a-time selector, and the **raw JSON5 editor** (only when the snapshot round-trips safely; otherwise the UI forces Form mode). |

Config write path: `ui/src/lib/config/config-gateway-operations.ts` — `config.schema` / `config.schema.lookup` to render, `config.get` to read, `config.set` (save) vs `config.apply` (save + validated restart, then wake the last active session), `config.patch` for scoped edits. Writes carry a **base-hash guard** and preflight SecretRef resolution. All config mutation is `operator.admin`.

---

## 2. Customization and branding — what a deployer can change without forking

### 2.1 Themes and typography (per-browser / per-profile, not deployable branding)

- 11 built-in themes: `claw` (default), `knot`, `dash`, `absolutely`, `tide`, `beacon`, `phosphor`, `crt`, `manuscript`, `rose`, `miami` (`ui/src/pages/config/view-appearance.ts`, boot-time list duplicated in `ui/index.html`).
- **One** custom-theme slot, imported from **tweakcn** only: `ui/src/pages/config/custom-theme-import.ts` hard-codes `TWEAKCN_HOSTS = {tweakcn.com, www.tweakcn.com}`, a 200 KB cap, a 10 s timeout, and strict CSS-value validation (`requireSafeCssValue`, `requireSafeFontFamilyValue`, hex/rgb/hsl/oklch allowlists). Imported palettes are **browser-local only** — never written to `openclaw.json`, never synced. The Gateway CSP explicitly allows `connect-src https://tweakcn.com` (`src/gateway/control-ui-csp.ts`).
- Fonts: `THEME_TYPEFACES` / `TYPEFACES` in `ui/src/app/typography.ts`; the operator picks an Interface face and a separate Chat-prose face from a fixed self-hosted list, or "System". No arbitrary font upload; `font-src 'self' https://fonts.gstatic.com`.
- Accent: 10 presets + custom hex. Precedence = profile `ui.accent` → `ui.prefs.accent` → `ui.seamColor` → theme default.

Gateway-wide defaults a deployer *can* set in `openclaw.json` (`src/config/types.openclaw.ts` lines ~148–190):
`ui.seamColor`, `ui.prefs.theme`, `ui.prefs.themeMode`, `ui.prefs.accent`, `ui.prefs.locale`, `ui.prefs.chatShowThinking`, `chatShowToolCalls`, `chatPersistCommentary`, `chatSendShortcut`, `chatFollowUpMode`, `ui.prefs.sidebarEntries`.
Note: when a connection is bound to an authenticated profile, theme/mode/accent are stored **per profile** in `user_preferences` and override `ui.prefs` (`docs/concepts/user-model.md`).

### 2.2 Sidebar customization

`ui/src/app-navigation.ts`:
- `SIDEBAR_NAV_ROUTES` = the customizable zone candidates: `dashboards, usage, cron, tasks, sessions, activity, meetings, plugins, apps, portals`.
- `DEFAULT_SIDEBAR_ENTRIES = ["route:dashboards", "route:cron", "route:plugins"]`.
- Entries serialize as `route:<id>`, `session:<key>`, `plugin:<pluginId>/<key>` (plus a legacy `workboard:<boardId>` migration). So **pinned sessions and plugin destinations** can sit in the sidebar next to routes.
- Everything not in the zone goes to a collapsed "More" section. Persisted per browser and mirrored to `ui.prefs.sidebarEntries` so a deployer can ship a default ordering.
- `gateway.controlUi.communityInvite: false` removes the Discord invitation card for every browser on that deployment.

### 2.3 `gateway.controlUi.*` config surface

From `src/config/types.gateway.ts` (`GatewayControlUiConfig`, lines 127–175) and `docs/gateway/config-gateway.md`:

| Key | Effect |
|---|---|
| `enabled` | Serve the Control UI at all (hot-applies). |
| `basePath` | Mount prefix, e.g. `/openclaw` (restart required to change). |
| `root` | Filesystem root for Control UI assets (default `dist/control-ui`). **This is the only real white-label escape hatch — and it means shipping your own built bundle.** |
| `environment` | `{ label: 1–24 chars, color: teal\|amber\|purple\|coral\|pink\|blue\|green\|red\|gray }` → 2 px top stripe, agent-avatar ring, sidebar/topbar pills, browser-title suffix, tinted favicon. Visible **before** sign-in. (`src/gateway/control-ui-bootstrap-contract.ts`, `ui/src/app/control-ui-environment-presentation.runtime.ts`.) |
| `communityInvite` | Hide the Discord card. |
| `experimental.customPlugins` | Labs gate for user-installed native plugin UI (§3). |
| `github.token` | Service credential for link previews / profile verification / discovery. |
| `sessionObserver` | Utility-model session status digests. |
| `embedSandbox` | `strict` \| `scripts` (default) \| `trusted` for hosted assistant embeds. |
| `allowExternalEmbedUrls` | Dangerous: allow absolute external embed URLs. |
| `automaticallyFetchFavicons` | Gateway-proxied, SSRF-guarded link favicons (default on). |
| `allowedOrigins` | Browser-origin allowlist for the WS connect (required for non-loopback). |
| `dangerouslyAllowHostHeaderOriginFallback` | Dangerous Host-header origin policy. |
| *(deprecated)* `chatMessageMaxWidth`, `dangerouslyDisableDeviceAuth`, retired `toolTitles` | Doctor-only legacy inputs. |

The browser bootstrap payload (`/control-ui-config.json`, `ControlUiBootstrapConfig`) carries `basePath`, **`assistantName`**, **`assistantAvatar`**, `serverVersion`/`serverBuildId`, `devGitBranch`, `embedSandbox`, `seamColor`, `environment`, `communityInvite`, `terminalEnabled`, `cliAgentsEnabled`, `pluginAssetsRequireAuth`, `pluginFrameGrants`.

### 2.4 Plugin-declared Control UI tabs

`hello-ok.controlUiTabs` (built in `src/gateway/server/ws-connection/connect-hello.ts:127` via `listControlUiPluginTabs(scopes, …)` from `src/gateway/control-ui-plugin-tabs.ts`) advertises tabs from active plugins to the connected browser. Each descriptor carries `icon`, `group` (`control` | `agent`), `order`, `requiredScopes`, an optional one-segment `slug` (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤64 chars, with a reserved-name blocklist), and optionally `placement: "route:<pluginId>"` for bundled plugins that own a native route. The sidebar renders them (`ui/src/components/app-sidebar.ts:623`), and `ui/src/app-routes.ts` registers their slugs.

### 2.5 Verdict on white-label

**A white-label rename/relogo is NOT possible via config alone at 9.4.**

- `ui/index.html` hard-codes `<title>OpenClaw Control</title>` and `/favicon.svg`, `/favicon-32.png`, `/apple-touch-icon.png` from `src/gateway/control-ui-root-assets.ts`.
- `formatDocumentTitle()` in `ui/src/app-navigation.ts` unconditionally appends `" — OpenClaw"`.
- Product name and brand marks come from i18n strings (`aboutPage.productName`, `approvalPage.brandName`, `nav.askOpenClaw`) and bundled SVGs, not from config. A grep for `brandName|productName|whiteLabel|customLogo|logoUrl` in `src/config/` returns nothing.
- The About page hard-codes openclaw.ai / docs.openclaw.ai / github.com/openclaw / Discord / x.com/openclaw links.

What you *can* do without touching code: set `gateway.controlUi.environment` (a coloured label + tinted favicon + title suffix), set the **assistant/agent** display name, emoji, and avatar (that is what appears in chat and the sidebar agent switcher), pick a theme/accent/typeface default, hide the Discord invite, and reorder the sidebar. That is "tenant identity", not a brand swap.
The only genuine white-label route is `gateway.controlUi.root` pointed at your own build of `ui/` — i.e. a fork, with all the upgrade cost that implies. Clawbridge's own branding is likewise hard-coded (inventory §3: "There is no theme/logo/product-name configuration surface"), so neither side wins here; the difference is that Clawbridge is *your* fork already.

---

## 3. Plugin-contributed UI (the 9.2 "Custom plugin UI" Labs feature)

Primary sources: `docs/plugins/feature-plugins.md`, `docs/plugins/manifest/surfaces.md` (§ "controlUi reference", § "dashboard reference"), `docs/plugins/sdk-overview/host-hooks.md`, and the SDK contract `src/plugin-sdk/control-ui.ts` + `src/plugin-sdk/control-ui-components.ts`.

### 3.1 What a plugin can contribute

A feature plugin exports `defineControlUiPlugin({ id, activate(host) })` from a browser entry and registers through `host.ui` (each returns a disposer):

| Registration | Placement |
|---|---|
| `registerPage` + `registerNavigation` | Plugin-owned **routes** and **sidebar destinations** (`ControlUiNavigationItem` has `label`, `icon`, `order`, `defaultVisible`). |
| `registerPanel` | A **tab in the session side panel**. |
| `registerAccessory` | Content in the **session header**. |
| `registerAction` | Buttons with `placement: "composer" \| "header" \| "session"`, with a `resolve()` for live label/hidden/disabled state. |
| `registerWidget` | Native **dashboard widget** views (must pair with a backend `registerControlUiDescriptor({ surface: "widget", id, requiredScopes })`). |
| `registerReplacement` | **Replace** a built-in surface: `workspace`, `session-list`, `composer`, `transcript`, `tool-result`. `selectReplacement(surface, id \| null)` switches to it or restores Built-in. |

The host object gives a plugin: `connection` (`canRead/canWrite/canGrant/canAdmin`), `request(method, params)` (arbitrary Gateway RPC, bounded only by the operator's own scopes), `onEvent`, `subscribe`, `sessions` (rows, `observe(query)`, `open`, `create`, `patch`, `refresh`), `agents` (rows, select, setScope), `navigation.openPage`/`pageHref`, `redact()`, `locale`, `basePath`, and `components` (host-owned dialogs, agent pickers, session dashboards).

Replacements can compose the built-in view via `context.mountDefault(container)`. A composer replacement gets canonical `setDraft`/`send`/`abort` operations rather than raw chat RPCs.

### 3.2 Iframe / hosted surfaces

Two separate mechanisms, often confused:

1. **Plugin tab with `path`** (`surface: "tab"` descriptor, `docs/plugins/sdk-overview/host-hooks.md`). The Control UI mounts a plugin HTTP route in a **sandboxed frame**. For `auth: "gateway"` routes the authenticated parent obtains a short-lived **HttpOnly cookie grant** scoped to that plugin + route root (`src/gateway/control-ui-plugin-auth-cookie.ts`, CSP `frame-ancestors 'self'`), renewed while the tab is active and probed from the opaque sandbox first so privacy modes fail closed. The grant accepts only `GET`/`HEAD` and always carries `operator.read`; `requiredScopes` controls visibility, never widens the cookie. External tabs require **HTTPS or browser-trusted loopback**; plain-HTTP LAN shows a secure-context error. Full third-party-cookie blocking makes them unavailable.
2. **`pluginSurfaceUrls`** (`src/gateway/plugin-node-capability.ts`, `docs/gateway/protocol/handshake.md:128`). This is the **node/canvas** capability path, not a Control UI iframe feature: the Gateway advertises scoped, expiring hosted URLs (e.g. `pluginSurfaceUrls.canvas`) to *node* clients (macOS WebViews) that can't send auth headers; nodes refresh via `node.pluginSurface.refresh`. `src/gateway/server-methods/board.ts:166` uses them to resolve a registered board-widget content kind's renderer surface. Relevant to canvas/board widgets and native apps; not a general "embed my app in the dashboard" story.

Sandboxed **dashboard widgets** are the isolated alternative: manifest `dashboard.dataBindings` (must name a plugin-registered `operator.read` method) and `dashboard.actionVerbs` (`operator.write`, with optional JSON-Schema `paramShape`); grants are `<plugin-id>.<id>`. Board widget content kinds render in `/mcp-app-sandbox` with a ticket-bound action bridge.

### 3.3 What a plugin *cannot* do

- It cannot replace the **application shell** — `workspace` replacement is the widest surface and the SDK explicitly does not expose a headless chat service for a fully independent workspace.
- It cannot change **authentication, pairing, or scopes**. `host.request` runs with the signed-in operator's authority; there is no per-plugin RPC allowlist and no per-plugin privilege escalation. The docs are blunt: *"OpenClaw does not treat installed plugins as mutually isolated browser security principals."*
- It cannot alter the login gate, the device-pairing flow, product branding, favicon, or document title.
- Native UI cannot load arbitrary chunks: one self-contained ESM entry + optional CSS, esbuild-analyzable imports only, 4 MiB per asset, 8 MiB per plugin, ≤256 revisions / 64 MiB shared cache.

### 3.4 Gating and security

- **Labs flag required for user-installed plugins**: `gateway.controlUi.experimental.customPlugins` (default `false`), toggled at **Settings → Labs → Custom plugin UI**. Requires a **Gateway restart** plus a browser reload. Bundled plugins (origin-determined, not manifest-claimed) keep their native UI with the flag off.
- **Reload plugin UI** in **Plugins → Customize UI** requires `operator.admin`.
- Native plugin assets follow Gateway auth (`pluginAssetsRequireAuth` in bootstrap) and must be served by the **same Gateway origin** the browser loaded; a separately hosted UI pointed at another Gateway cannot load them. Authenticated native UI additionally requires HTTPS or a browser-trusted loopback URL.
- Native UI runs **trusted, in the Control UI origin**, with the operator's full Gateway authority. It is not a sandbox.

### 3.5 Implication for Clawbridge

Everything Clawbridge renders as a *page* — Agent Vault, Google/Composio, webhooks, Drift Doctor, watchdog, browse/file editor, host ops — is technically re-hostable inside the Control UI as a feature plugin with `registerPage` + `registerNavigation`, or as a gateway-authenticated iframe tab, without forking `ui/`. Costs: the Labs flag must be on (restart + reload), the code must be rebuilt as an esbuild-bundled browser entry under the 8 MiB cap, all backend endpoints must move from Express routes to plugin Gateway RPCs (or plugin HTTP routes behind `auth: "gateway"`), and everything must be served from the Gateway origin over HTTPS/loopback. What cannot move: the shared **setup password** login, the Clawbridge shell/branding, and anything that must run before the Gateway is up (onboarding, watchdog, crash recovery).

---

## 4. Auth, identity, and the multi-user model

### 4.1 How the browser authenticates

`docs/web/control-ui.md`, `docs/web/control-ui/connect-and-pair.md`:

1. **Gateway auth first** (`gateway.auth.mode`): `none` | `token` | `password` | `trusted-proxy`, plus `allowTailscale` for Tailscale Serve identity headers. One **Gateway secret** field in the UI covers token or password; the Gateway's mode picks which configured value is compared. After a successful *token*-mode connect the secret is kept in **sessionStorage** for that tab + Gateway origin only; passwords stay in memory and are never persisted.
2. **Device pairing second**. Each browser profile generates an Ed25519 identity (pure JS, works over plain HTTP) stored at `localStorage["openclaw-device-identity-v1"]`; the issued device token is stored per Gateway at `localStorage["openclaw.device.auth.v1:<gatewayScope>"]` (`ui/src/lib/nodes/index.ts:45–50`). Pairing is approved with `openclaw devices approve <requestId>`, from another admin browser's Devices page, or auto-approved for direct loopback with no forwarded headers. Scope upgrades (read → write/admin) are an **explicit re-approval**, not a silent reconnect.
3. **Trusted proxy** (`gateway.auth.mode: "trusted-proxy"` + `gateway.trustedProxies`, `gateway.auth.trustedProxy.{userHeader,requiredHeaders,allowUsers,allowLoopback,deviceAutoApprove}`) — note this lives under `gateway.auth`, **not** under `gateway.controlUi`. Identity headers are accepted only from listed proxy IPs; loopback sources are rejected unless `allowLoopback: true`; requests matching the Gateway's own interface addresses are rejected as a spoofing guard. `gateway.auth.identityScopes` maps a verified email to connection-only operator scopes.
4. Other browser-local keys: `openclaw.control.settings.v1`, `openclaw.control.token.v1`, `openclaw.control.user.v1`, `openclaw.control.serverPrefs.v1`, `openclaw.terminal.panel.v1`.

### 4.2 Identity and roles

- Every authenticated person gets a durable **Gateway profile** (`user_profiles`) with display name, avatar, linked emails, optional verified GitHub identity (Cloudflare Access or Tailscale Serve, resolved to the immutable numeric GitHub account id), Git co-author consent, and per-profile appearance prefs in `user_preferences`.
- A single-user Gateway gives unidentified operator connections one shared **owner profile** ("Shared owner" in the People sidebar). It has no email, no role, grants no extra permissions, and cannot be merged with a person.
- **Named operator roles** (`gateway.roles`, `GatewayOperatorRolesConfig` in `src/config/types.gateway.ts:562`) bind profiles to closed capability bundles:
  - `sessions.others`: `none` | `view` | `suggest` | `write` (and `none` also denies Gateway-wide `usage.cost`)
  - `agents`: `"*"` or an explicit agent-ID allowlist, enforced for session creation *and* runs
  - `scopes`: a **ceiling** on the profile's operator scopes
  - `sandbox`: `inherit` | `required` (per-creator isolated sandbox + workspace, `rw` downgraded to `ro`, immutable creation provenance, no `/elevated` escape)
  - `default` is required. Assign with the admin-scoped `users.setRole`; assignment immediately closes that profile's connections.
  - **Critical constraint**: when `gateway.roles` is configured, identity-authenticated operator connections get **no reusable device/bootstrap tokens**, and device-token or bootstrap-token operator auth **without a verified user identity is rejected**. You must come through a trusted proxy or another verified identity. Shared-secret/password access and node connections are unaffected.

### 4.3 What admin- vs read-scoped users see

- **Read-scoped**: sidebar zone, Chat (view only — composer disabled without `operator.write`), Sessions (own sessions; foreign sessions bounded by the role), Activity, Tasks, Usage, Dashboards, Portals (list), Meetings, Apps, About, Debug snapshots, Logs, Profile (incl. their **own** GitHub connection and model accounts — the narrowly self-scoped `users.github.*` exception), Appearance/Notifications, Model Providers (read), Plugins/Skills (browse + ClawHub search). Settings nav collapses to `NON_ADMIN_SETTINGS_NAVIGATION_GROUPS`.
- **Admin-scoped**: everything above plus config Form/Raw editors, Labs, Secrets, MCP, Memory settings, Automation (hooks/commands/bindings/cron), Infrastructure, Cloud Workers, Worktrees, Skill Workshop apply, plugin install/enable/remove, `gateway.restart.request`, `update.run`, exec approvals, device setup codes, and the **operator terminal**.
- Pairing actions need `operator.pairing` separately; approvals need `operator.approvals`; questions need `operator.questions`. These are default-**deny** on the client when `hello.auth.scopes` is present.

### 4.4 Implication for the `/openclaw` proxy behind a shared setup password

Clawbridge mounts `ALL /openclaw`, `ALL /openclaw/*`, `ALL /assets/*` behind `requireAuth` (single shared `SETUP_PASSWORD`) and proxies to the Gateway (`lib/server/routes/proxy.js:211-221`), and its `use-dashboard-launcher.js` waits on the browser's OpenClaw **device pairing** to be approved.

Consequences at 9.4:

- Every Clawbridge user shares one password, therefore **one Gateway credential and one identity**. Downstream, the Gateway sees either the shared owner profile or a single shared-secret connection. `gateway.roles` is unusable in this topology — roles need a *verified per-person* identity, and enabling roles would disable exactly the device/bootstrap tokens the launcher depends on.
- You inherit two auth layers with two failure modes: a Clawbridge login *and* an OpenClaw device-pairing approval, which is precisely why the launcher modal has TOKEN_MISSING / WAITING / REQUEST / TIMEOUT states.
- The Control UI's own answer for this shape is `gateway.auth.mode: "trusted-proxy"` with `userHeader` + `identityScopes` — it gives you per-person identity, per-person scopes, and per-person session isolation with **no** shared password. If Clawbridge already authenticates users (it does not today — one password), converting `/openclaw` into a trusted-proxy front-end would be a far better fit than the current pass-through.
- Proxy correctness also matters: non-loopback Control UI needs `gateway.controlUi.allowedOrigins` set to the Clawbridge origin, and `gateway.trustedProxies` must list the proxy source or Gateway-authenticated routes reject with `proxy_attribution_required`.

---

## 5. Remote and embedded use

### 5.1 Path prefix

`gateway.controlUi.basePath` (e.g. `/openclaw`) prefixes **every** route and asset. Implementation: `CONTROL_UI_BASE_PATH_ATTRIBUTE = "data-openclaw-control-ui-base-path"` on the served document (`src/gateway/control-ui-bootstrap-contract.ts`), rewritten `<link rel="icon">` / `manifest` hrefs in the served HTML (`src/gateway/control-ui.http.test.ts:1493` asserts `href="/openclaw/favicon.svg"`), and `context.basePath` threaded through every route (`pathForRoute(route, context.basePath)`). The runtime config endpoint resolves relative to it (`<basePath>/control-ui-config.json`). Changing the base path (or `root`) requires a **Gateway restart**; `enabled` hot-applies. So Clawbridge's current URL-rewriting proxy is doing by hand what `basePath: "/openclaw"` does natively — set the config key and drop the rewrite.

### 5.2 CSP — the Control UI **cannot** be iframed

`src/gateway/control-ui-csp.ts` sets, always and non-configurably:

```
default-src 'self'; base-uri 'none'; object-src 'none';
frame-ancestors 'none';                       <-- no embedding, anywhere
frame-src 'self' http: https:;
script-src 'self' <sha256 inline hashes> ['wasm-unsafe-eval' when terminal enabled];
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
img-src 'self' data: blob: https://gravatar.com https://avatars.githubusercontent.com;
media-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; worker-src 'self';
connect-src 'self' ws: wss: data: https://api.openai.com https://tweakcn.com [+ portalHost:*]
```

`frame-ancestors 'none'` means **you can never embed the Control UI in a Clawbridge page**. The only supported handoff is a same-origin navigation or a new tab — which is exactly what Clawbridge does today (inventory §5: "no iframe embed of the Control UI"). The share (`/share/session`) and public-transcript renderers use their own stricter policies (`frame-ancestors 'none'` too); only the plugin-frame cookie endpoint uses `frame-ancestors 'self'`.

Note the inverse also holds: the Control UI *can* host other things in frames (`frame-src 'self' http: https:`) — plugin tabs, board widgets, MCP app sandbox, and the Portals page's sandboxed iframes. So Clawbridge-inside-Control-UI is architecturally possible; Control-UI-inside-Clawbridge is not.

### 5.3 Origins and Gateway discovery

- `gateway.controlUi.allowedOrigins` is the browser-origin allowlist for WS connects. **Required** for public non-loopback origins; private same-origin loads (loopback, RFC1918/link-local, `.local`, `.ts.net`, Tailscale CGNAT) are accepted without it. `["*"]` is flagged `critical` by `openclaw audit` (`docs/gateway/security/audit-checks.md:54-55`). `dangerouslyAllowHostHeaderOriginFallback` is the escape hatch.
- The UI discovers its Gateway as **same-origin by default** (`ws(s)://<same host>:<same port>`), overridable at **Settings → Gateway** or, for the dev server only, via `?gatewayUrl=<encoded ws url>` plus `#token=` (fragment preferred; `?token=` is a stripped bootstrap fallback). `hello-ok.controlUiUrl` advertises the configured public Control UI origin + base path for shareable links (present only when `gateway.publicOrigin` is set); `snapshot.controlUiIdentityUrl` advertises the HTTPS dashboard URL when trusted-proxy or Tailscale Serve identity is in use, so an operator can sign in personally instead of forwarding shared device credentials.
- Tailscale Serve/Funnel is the recommended remote path: `openclaw gateway --tailscale serve`, loopback bind, HTTPS certificate, and `gateway.auth.allowTailscale` can even skip the pairing round trip for device-identified browsers.

### 5.4 Telegram Mini App `/dashboard`

`docs/channels/telegram/mini-app.md`: `/dashboard` in a DM with the bot opens the **full Control UI** as a Telegram WebApp. Requires `gateway.tailscale.mode: "serve"` or `"funnel"` for the published HTTPS URL, and the numeric Telegram user id must be in the account's effective `allowFrom` or `commands.ownerAllowFrom`. Telegram's signed `initData` is verified with the bot token (signature, expiry, replay), the numeric user id is extracted, owner access is rechecked, then it hands off to the Control UI. `gateway.controlUi.basePath` is honoured automatically. Tailscale-only v1; **no Telegram Web iframe support** (consistent with `frame-ancestors 'none'`).

### 5.5 PWA and Web Push

`ui/public/manifest.webmanifest` + `ui/public/sw.js` make the Control UI installable as a standalone PWA. Web Push uses an auto-generated VAPID keypair in `config_machine_state.webPush.vapidKeys` (overridable via `OPENCLAW_VAPID_PUBLIC_KEY`/`_PRIVATE_KEY`/`_SUBJECT`), subscriptions in `web_push_subscriptions` bound to device + profile, and methods `push.web.vapidPublicKey`/`subscribe`/`unsubscribe`/`test`. Pending exec/plugin approvals also push, with generic text and an authenticated `/approve/<approvalId>` link. One service-worker scope = one subscription, so a PWA switching between Gateways needs the same VAPID pair everywhere.

There is also a **focus presentation** mode (`/focus/terminal`, `/focus/desktop/...`) that strips all application chrome — the iOS/Android apps embed these pages directly. And a **native embed mode**: `window.__OPENCLAW_NATIVE_EMBED__ = { platform, formFactor }` injected at document start renders Settings without dashboard navigation chrome.

---

## 6. Operational features that overlap Clawbridge

| Area | Control UI 9.4 | vs Clawbridge |
|---|---|---|
| **Plugins workspace** | `/settings/plugins` hub: Installed (grouped inventory, detail views, enable/disable, remove externals), Discover (curated store, official externals, one-click MCP connectors), inline **ClawHub** search with download counts + source-verification badges, install/uninstall/inspect, inline MCP server add/disable/remove, **Customize UI** (replacement selection + Reload plugin UI), and a **Restart Gateway** request. Read = `operator.read`; all mutations + restart = `operator.admin`. | Clawbridge has **no plugin manager at all** (inventory §2.15: "no skills manager"; plugins are injected by the server: `usage-tracker`, `agent-vault`, `openclaw-teamyou-memory`). Control UI wins outright. |
| **Model Setup / Model Providers** | `/settings/model-providers`: per-provider auth state (`models.authStatus`), catalog (`models.list`), probe (`models.probe`), auth logout and auth-profile ordering, live plan/quota/balance/budget (`usage.status`), 30-day local spend (`sessions.usage`). `/settings/model-setup`: detect → authenticate → activate → verify with a live inference probe, handling restart-required. Personal per-profile model accounts live on Profile via `users.authConnect.*` (device/browser sign-in flows incl. Codex and Claude). | Clawbridge does per-route model config, thinking levels, Codex OAuth (PKCE + device + manual paste), Claude CLI login with a live SSE terminal, and **vault-brokered API keys** (`POST /api/models/vault-key`). Control UI has richer catalog/quota/spend and multi-account-per-person; Clawbridge has the vault brokerage and the CLI-login terminal. |
| **Channels** | Channel hub with guided wizard, token/QR login, per-channel schema config, Nostr profile publishing, WhatsApp logout, partial-snapshot labelling, and **pairing approvals** with a "make command owner" option. | Clawbridge validates tokens against the provider API *before* saving, generates a Slack app manifest, streams login via SSE operations, and binds accounts to agents in the same wizard. Control UI covers more channels (all plugin channels) with schema-driven config; Clawbridge's pre-save validation + Slack manifest are nicer UX on the three channels it supports. |
| **Devices** | Unified device+node+presence inventory, approve/reject/remove/rotate/revoke, aliases, stale-duplicate cleanup, capability chips, host/node resource meters, Desktop launch, mobile setup code + QR, and a full exec-approvals editor. | Clawbridge's `/nodes` covers approve/remove, `tools.exec` routing to a node, exec security + allowlist, browser-attach probe, and a setup wizard with `connect-info`. Roughly equivalent; Control UI adds token rotation/revocation, aliases, presence, and resource meters. |
| **Cron** | Full automations page (see §1.2) with filters, detail view, inline editor, run history with delivery-suppression reasons, starter suggestions, conditional triggers, stagger windows, failure alerts, webhook delivery mode. Admin required to mutate. | Clawbridge adds a **rolling calendar**, **trends** (24 h/7 d/30 d), and **per-run token/cost** joined from its own usage SQLite. Control UI's editor is much deeper; Clawbridge's cost join and calendar have no Control UI equivalent. |
| **Usage** | Deep analytics (see §1.2), including system-prompt breakdown, hour-of-week mosaic, `key:value` query language, CSV/JSON export, and provider plan/quota cards. Session-derived, explicitly separate from provider billing. | Clawbridge has its own SQLite usage store fed by an injected `usage-tracker` plugin, with per-session drill-down and charts — and, uniquely, it joins usage to **cron runs**. Control UI is far ahead on analysis depth; Clawbridge keeps durable history independent of the session store and the cron join. |
| **Logs** | `/logs` live tail with filter + export (`logs.tail`). | Clawbridge tails gateway logs in a watchdog console card. Comparable. |
| **Debug** | `/debug`: status/health/models snapshots, lane tables, event log with Control UI timing instrumentation, **manual RPC console**, System busyness overlay (CPU/mem/event-loop delay/per-disk). | Clawbridge has `/api/status`, `/api/gateway-status`, SSE status, and the watchdog resource bars. Control UI's manual RPC console and event-loop instrumentation have no Clawbridge equivalent. |
| **Secrets** | `/settings/secrets` — team-scoped secret + env store via `secrets.store.list/set/delete`, Bulk Add dotenv paste, per-entry `allowedHosts`, values never returned after save, admin-gated. | Clawbridge's `/envars` edits the **`.env` file** it owns, grouped by purpose with masked inputs and restart prompts. Different models: OpenClaw's is a SecretRef-backed store usable from config (`{source:"store", ...}`); Clawbridge's is flat env-var editing. OpenClaw's is stronger; Clawbridge's is more familiar. |
| **Updates** | `/settings/updates` (`ui/src/pages/config/updates.ts`): installed version, Control UI commit + build time, channel (`stable`/`extended-stable`/`beta`/`dev`), `update.checkOnStart`, automatic updates toggle, **Update now** with a confirmation showing target + restart impact, a phased run view (service/version/plugins/channels/inference verification) that survives the restart, `update.hold`, per-run reports retained for every run, Check status / Retry / Triage on failure, failure reporting, and native device updates when embedded. RPCs: `update.run`, `update.status`, `update.hold`, `update.channel`. | Clawbridge shows Clawbridge + OpenClaw versions, release notes, and an in-place update — but **only when self-hosted**; under `ALPHACLAW_DEPLOYMENT_PROVIDER=clawctl` it degrades to "Contact TeamYou support". Control UI's update flow is substantially more capable; Clawbridge's value is the managed-deployment gate. |
| **Backups** | **No backup UI.** `openclaw backup` is CLI-only (`docs/cli/backup.md`, `docs/install/backups.md`); plugins declare `backupResources` in their manifest so the planner includes/excludes their data. A grep for "backup" across `ui/src/pages`, `ui/src/components`, `ui/src/app` returns only memory-import's `backupPath` field. | Clawbridge has GitHub backup sync (token + `owner/repo`, repo created/validated via the GitHub API) with a **schedule picker** (Disabled/30 min/Hourly/Daily) backed by a system cron entry, plus commit+push from the sidebar git panel. **Clear Clawbridge win.** |
| **Gateway restart** | `gateway.restart.request` (+ `gateway.restart.preflight`), exposed from the Plugins page after install/enable and implicitly by `config.apply`; Ask OpenClaw can also drive `restart gateway`. Admin only. `GATEWAY_RESTART_TARGET_SAFE` is advertised as a hello capability. | Clawbridge has a dedicated Gateway card + **global restart banner** with a restart-required state machine driven by env/model/vault/channel changes, plus systemd interop. Clawbridge's restart *ergonomics* are better; the underlying capability exists in both. |
| **Config Form / Raw editor** | Schema-driven form from `config.schema` / `config.schema.lookup` (titles, descriptions, UI hints, child summaries, docs metadata, plugin + channel schemas), plus a **raw JSON5 editor** that preserves formatting, comments, and `$include` layout on "Reset to saved" — offered only when the snapshot round-trips safely, otherwise Form mode is forced. Base-hash conflict guard, SecretRef preflight, masked secrets, read-only structured SecretRef objects. | Clawbridge edits config indirectly (env vars, models config, specific routes) and exposes raw files through **Browse**. Control UI wins decisively on config editing. |
| **Memory** | Agents → Memory tab (dreaming status, enable/disable, Dream Diary reader, diary repair/reset/dedupe/backfill, Memory Wiki sub-tabs when `memory-wiki` is enabled), Settings → Memory (engine/backend/add-ons), and `/memory-import` (plan/apply from Claude Code, Codex, Hermes + session backfill/rollback). | Clawbridge has **no memory UI at all** (inventory §2.14: server-side TeamYou memory activation only). **Clear Control UI win.** |
| **Terminal** | In-browser PTY: `gateway.terminal.enabled` (default **true**), **`operator.admin`** required, opens in the active agent workspace, multiple tabs in the unified side panel, drag-and-drop file staging with shell-quoted path insertion (16 MiB/file, 256 MiB & 64 files per staging dir), detached-session reattach (`detachedSessionTimeoutSeconds`, default 300), conversation-owned vs connection-owned sessions, agent `terminal` tool with per-input approval, native Codex/Claude/OpenCode/Pi resume, node-relayed PTYs, and a chrome-free `/focus/terminal`. CSP relaxes to `'wasm-unsafe-eval'` only when enabled. | Clawbridge has an xterm terminal into the OpenClaw root over `/api/watchdog/terminal/ws`, behind the shared setup password only. Control UI's is far more capable **and** properly scoped. |

---

## 7. Gaps relative to Clawbridge — confirmed absent from the Control UI at 9.4

Each verified by searching `ui/src` (excluding i18n translation-memory files and tests) and the Gateway/docs tree.

| Clawbridge capability | Control UI 9.4 status | Evidence |
|---|---|---|
| **Host / VPS operations** (systemd interop, sudo host-finalize wrapper, Tailscale/security-gateway finalization over SSH forced command, provisioning) | **No equivalent.** The Control UI manages the Gateway's *config and process restart*, never its host. Tailscale appears only as `gateway.tailscale.mode` config. | no host-ops surfaces under `ui/src/pages/`; `gateway.tailscale` is a schema section on Infrastructure |
| **Watchdog, crash-loop recovery, auto-repair, notification test, host resource bars, incident log** | **Partially, and not as a UI.** The Gateway has a crash-loop breaker and restart recovery (`docs/gateway/restart-recovery.md`) and automatic **triage** (`docs/cli/triage.md`) that can launch a recovery agent when the breaker trips; `channels.<provider>.healthMonitor.enabled` exists. Host CPU/memory/disk meters exist on **Settings → Gateway** and **Devices** via `system.info`, and Debug has a busyness overlay. But there is **no watchdog page**, no settings for it, no incident/event history, no auto-repair button, no test notification. | `git grep -i watchdog -- ui/src` → nothing outside i18n |
| **Agent Vault credential brokering + proposals + runtime claim** | **No equivalent.** OpenClaw's nearest analogue is the `secrets.store.*` SecretRef store (§6), which stores values *locally* rather than brokering them off-host, and has no proposal/approval workflow. | `git grep -i vault -- ui/src` → only unrelated matches |
| **TeamYou console links / TeamYou-managed update path** | **No equivalent**, and no hook to add one via config. | `git grep -i teamyou` → nothing |
| **Google Workspace / `gog` / Gmail Pub-Sub watch / Composio** | **No equivalent in the Control UI.** OpenClaw has a `google-meet` plugin and Gmail *cron* integration (`docs/automation/cron-jobs/gmail.md`), but no Google account console, no OAuth client management, no watch wizard, and no Composio surface. | `git grep -i composio -- ui/src` → nothing |
| **Named webhooks with transform modules, request history, OAuth-callback shims** | **Partial and much weaker.** `hooks.mappings` is editable as a schema section under **Settings → Automation**, and cron jobs can deliver to a webhook URL (`delivery.mode: "webhook"`, `cron.webhookToken`). There is **no** named-endpoint manager, no transform authoring, no request log/payload inspector, no per-hook health, and no one-shot OAuth callback URL. | `git grep -i webhook -- ui/src` returns only cron delivery + markdown/presenter matches |
| **Drift Doctor** (agent-driven workspace drift scan, finding cards, accept/dismiss, send-fix-to-agent) | **No equivalent.** `openclaw doctor` is a CLI health/repair tool with no Control UI page; the UI only calls `doctor.memory.*` for dreaming artifacts. | no `/doctor` route in `docs/web/urls.md` route table |
| **File browser with git diff / restore / SQLite viewer / create/move/delete** | **Partial.** The Chat side panel's **Files** tab lists thread/project files and artifacts with search and filter chips, and **Review** is a CodeMirror viewer/editor with syntax highlighting, jump-to-line, in-file search, and (with `sessions.files.set` + `operator.admin`) compare-and-swap editing under fs-safe guards. It **only overwrites existing files** — never creates or deletes — is capped at 256 KiB UTF-8, is scoped to a session's workspace, and has **no git diff, no git restore, no SQLite table viewer, and no tree-wide file management**. | `docs/web/control-ui/chat.md:101-103` |
| **GitHub backup sync + scheduling** | **No equivalent** (see Backups above). Control UI's GitHub integration is publication (Publish PR), identity verification, and link previews — not repo backup. | `git grep -i "git-sync\|gitSync" -- ui/src` → nothing |
| **OpenAI-compatible `/v1` proxy with a UI toggle** | **Capability exists, no UI.** The Gateway ships `/v1/chat/completions` and the Responses API (`src/gateway/openai-http.ts`, `openresponses-http.ts`), **both disabled by default** behind `gateway.http.endpoints.chatCompletions.enabled` and `gateway.http.endpoints.responses.enabled`. Those are editable as raw config under Advanced/Infrastructure, but there is no dedicated toggle card and no "copy your `/v1` URL" affordance. | `docs/gateway/config-gateway.md` § "OpenAI-compatible endpoints" |
| **Sandboxed agent-page hosting (`/pages/*`)** | **Different mechanism, similar outcome.** OpenClaw hosts agent-produced content through `/__openclaw__/canvas`, `/__openclaw__/a2ui`, board widgets, and the MCP app sandbox, governed by `gateway.controlUi.embedSandbox` (`strict`/`scripts`/`trusted`) and `allowExternalEmbedUrls`. There is no "serve a directory of agent-authored static pages at a public path" feature. | `src/config/types.gateway.ts:153-164` |
| **Telegram topic workspace** (verify bot, create group, define/bulk-create topics, configure, reset) | **No equivalent.** The Telegram plugin covers messaging, pairing, and the `/dashboard` Mini App; there is no topic-workspace builder. | `docs/channels/telegram/*` |
| **Usage/cost joined with cron runs** | **No equivalent.** Usage is session-scoped; cron run history shows status and delivery, not tokens or cost. | `ui/src/pages/cron/` has no usage RPC beyond a `usage.metrics.tokens` label |
| **Onboarding import wizard with secret review / placeholder review** | **Partial.** Ask OpenClaw hosts guided setup wizards and `/memory-import` handles memory; `openclaw onboard` is CLI. There is no scan-and-selectively-import-an-existing-install flow with a secret-review step. | `ui/src/pages/custodian/`, `ui/src/pages/memory-import/` |

---

## 8. Summary table

| Feature area | Clawbridge | Control UI 9.4 | Who does it better | Notes |
|---|---|---|---|---|
| Chat / sessions | Preact chat over `/api/ws/chat`, per-session drafts, abort, background-run polling | Full multi-pane chat: tool cards with diffs, attachments, Talk realtime, worktrees, publish-PR, background tasks, side panel (Terminal/Browser/Files/Review), fork/archive/group | **Control UI, decisively** | ~400 modules under `ui/src/pages/chat/` vs one 1.4k-line route |
| Agents | Multi-agent CRUD, identity, tool profiles, bindings, pairing | Agents settings page with Overview/Files/Tools/Skills/Channels/Automations/Memory, model fallback chains, `IDENTITY.md` mirroring | **Control UI** | Clawbridge's tool catalog is a *static mirror* of OpenClaw's, so it drifts |
| Models / providers | Catalog + routes + thinking levels, Codex OAuth, Claude CLI login, **vault-brokered keys** | Provider cards with auth state, catalog, probe, plan/quota/spend; Model Setup wizard; per-person model accounts | **Control UI**, except vault keys | `models.authStatus`/`list`/`probe`, `usage.status` |
| Cron / automations | List, run, enable/disable, prompt/routing edit, **calendar**, **trends**, **per-run cost** | Full editor (schedule, delivery, failure alerts, overrides), filters, run history with suppression reasons, starters | **Control UI** for authoring; **Clawbridge** for cost/calendar | Cost join is Clawbridge-only |
| Usage / cost | Own SQLite + injected `usage-tracker` plugin, per-session drill-down, charts | Session-derived analytics: mosaic, heatmap, system-prompt breakdown, query language, CSV/JSON export, provider quota cards | **Control UI** | Clawbridge's store survives session deletion; Control UI's does not |
| Plugins / skills | **None** (plugins injected server-side, no skills UI) | Plugins hub (Installed/Discover/Skills/Workshop), ClawHub search, install/enable/remove, MCP inline, Customize UI | **Control UI** | `plugins.*`, `skills.*`, `skills.proposals.*` |
| Memory | **None** (server-side TeamYou activation only) | Dreaming + Dream Diary + Memory Wiki + Import Memory + session backfill | **Control UI** | `doctor.memory.*`, `migrations.memory.*`, `wiki.*` |
| Config editing | Env vars + targeted routes; raw files via Browse | Schema-driven forms for every section + JSON5 raw editor with comment/`$include` preservation, base-hash guard, SecretRef preflight | **Control UI** | `config.schema`, `config.set`, `config.apply` |
| Secrets | `.env` editor, grouped, masked | `secrets.store.*` SecretRef store, bulk dotenv, `allowedHosts`, write-only values | **Control UI** | Different models; OpenClaw's is referenceable from config |
| Devices / nodes | Approve/remove, exec routing, exec allowlist, setup wizard | Unified device+node+presence inventory, aliases, token rotate/revoke, stale cleanup, resource meters, setup code/QR, exec approvals | **Control UI** | `operator.pairing` + `operator.admin` split |
| Channels | Pre-save token validation, Slack manifest, SSE login stream, agent binding | All plugin channels, schema-driven config, guided wizard, QR/pairing approvals, Nostr profile publishing | **Control UI** for breadth; **Clawbridge** for setup polish | |
| Terminal | xterm into OpenClaw root, behind shared password | Admin-scoped PTY in the agent workspace, multi-tab, file staging, detach/reattach, node relay, native CLI resume, `/focus/terminal` | **Control UI** | Clawbridge's is unscoped — a shared password grants a host shell |
| Logs / debug | Watchdog console log tail, status SSE | `logs.tail`, status/health/models snapshots, event log with timing instrumentation, manual RPC console, busyness overlay | **Control UI** | |
| Updates | Version + release notes + in-place update (self-hosted only) | Channel policy, phased run view surviving restart, verification, retained reports, retry/triage, hold | **Control UI** | Clawbridge's clawctl gate is a deployment policy, not a feature |
| Gateway restart | Global restart banner + restart-required state machine, systemd interop | `gateway.restart.request` + `config.apply`; Ask OpenClaw `restart gateway` | **Clawbridge** on ergonomics; parity on capability | |
| Backups / git sync | GitHub repo sync with schedule, commit+push, restore-from-git | **None** (CLI `openclaw backup` only) | **Clawbridge** | Genuine gap |
| File browser | Full tree, edit, create/move/delete, download, markdown split, media, **SQLite viewer**, **git diff/restore** | Session-scoped Files list + Review editor (overwrite-only, 256 KiB, no git, no SQLite) | **Clawbridge** | Genuine gap |
| Webhooks | Named endpoints, transform modules, request history, OAuth-callback shims, health | `hooks.mappings` as a raw config section; cron webhook delivery | **Clawbridge** | Genuine gap |
| Drift Doctor | Agent-driven drift scan with finding cards and send-fix | **None** | **Clawbridge** | Genuine gap |
| Watchdog / crash recovery | Full page: crash-loop, auto-repair, settings, incidents, notifications, resource bars, terminal | Gateway-internal crash-loop breaker + auto-triage; resource meters on Gateway/Devices; no watchdog UI | **Clawbridge** for the operator surface; **OpenClaw** for the underlying recovery | |
| Agent Vault / credential brokering | Status, credentials, service allowlist, proposals, TeamYou console | **None** (local SecretRef store only) | **Clawbridge** | Strategic differentiator |
| Google / Composio / Gmail watch | Full OAuth + watch wizard + Composio device login | **None** | **Clawbridge** | |
| Telegram topic workspace | Bot verify, group create, topic registry, bulk topics | **None** | **Clawbridge** | |
| OpenAI-compatible `/v1` | Toggle + copy-URL panel, throttled, cookie-stripped | Capability exists (`gateway.http.endpoints.*`), disabled by default, **no UI** | **Clawbridge** on UX; parity on capability | |
| Host / VPS ops, Tailscale finalization | SSH forced-command channel, sudo wrapper, security-gateway sealing | **None** | **Clawbridge** | Out of OpenClaw's scope by design |
| Auth / multi-user | One shared `SETUP_PASSWORD`, no per-person identity, no roles | Token/password/trusted-proxy/Tailscale + Ed25519 device pairing; durable profiles; **named operator roles** with scope ceilings, agent allowlists, foreign-session policy, forced per-creator sandboxes | **Control UI, decisively** | `gateway.roles`, `users.setRole`, `docs/gateway/operator-scopes.md` |
| Branding / white-label | Hard-coded (theme.css, logo.svg, ~40 string literals) | Hard-coded product name/favicon/title; config offers only `environment` label+color, assistant name/avatar, theme/accent/font defaults, sidebar order, community-invite toggle | **Neither** — both require a fork | `gateway.controlUi.root` is the only config-level escape, and it means shipping your own bundle |
| Extensibility for our features | N/A (it *is* the fork) | Feature plugins: pages, sidebar entries, session panels/actions/accessories, dashboard widgets, and replacements for workspace/session-list/composer/transcript/tool-result; gateway-authenticated iframe tabs | **Control UI** | Needs Labs `customPlugins` + restart; runs with the operator's full authority (not a sandbox) |
| Embedding | Proxies `/openclaw`, new-tab handoff only | `frame-ancestors 'none'` — **cannot be iframed**; `basePath` makes the proxy rewrite unnecessary | n/a | `src/gateway/control-ui-csp.ts:87` |

### Bottom line

The Control UI at 9.4 has absorbed and surpassed the overwhelming majority of what Clawbridge does as a *thin wrapper* (chat, sessions, agents, models, cron, nodes/devices, channels, restart), and it has whole categories Clawbridge never had (plugins, skills, memory, worktrees, cloud workers, secrets store, schema config editing, per-person identity and operator roles, terminal, Web Push/PWA, Telegram Mini App). Continuing to maintain those wrapper surfaces in Clawbridge is pure duplicated cost.

What is genuinely Clawbridge-only and would be lost: **Agent Vault brokering**, **host/VPS + watchdog/crash-recovery ops**, **GitHub backup sync with scheduling**, **named webhooks with transforms and request history**, **Drift Doctor**, the **file browser with git diff/restore and SQLite**, **Google/Composio**, the **Telegram topic workspace**, the **usage↔cron cost join**, and the **onboarding/import wizard**.

Two of those (host ops, watchdog, onboarding) must stay outside the Control UI by definition — they run before or above the Gateway. The rest are re-hostable as **feature plugins** inside the Control UI (§3), which would let Clawbridge shrink to: an onboarding/provisioning tool, a watchdog/host-ops service, and a set of OpenClaw plugins — with the Control UI as the single operator surface. The two blockers to that plan are (a) the Labs `customPlugins` flag plus admin-gated plugin reload, and (b) the fact that a shared `SETUP_PASSWORD` in front of `/openclaw` cannot produce the per-person identity that `gateway.roles` needs; that would have to become a trusted-proxy integration.
