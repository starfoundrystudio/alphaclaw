# Clawbridge (AlphaClaw) — User-Facing Feature Inventory

Repo: `/Users/billk/Development/starfoundrystudio/alphaclaw`
Package: `@starfoundrystudio/alphaclaw` v`0.9.18-starfoundry.20-beta.5`, pins `openclaw@2026.7.1`
UI: Preact + `htm` + `wouter-preact` hash router, bundled by esbuild (`scripts/build-ui.mjs` → `lib/public/dist/app.bundle.js`)
Server: Express (`lib/server.js` + `lib/server/routes/*`), single process that also spawns/proxies the OpenClaw gateway child on `127.0.0.1:18789`.

Legend for classification used throughout:
- **(a) thin wrapper** — UI/HTTP surface over an OpenClaw CLI command, OpenClaw gateway RPC, or OpenClaw config file.
- **(b) AlphaClaw-only** — logic, storage, or integration with no OpenClaw equivalent.
- **(c) ops/lifecycle** — host/systemd/process/watchdog/deploy concerns outside OpenClaw.

---

## 1. Navigation map

### Shell
- Entry HTML: `lib/public/setup.html` (served at `/` and `/setup` by `lib/server/routes/pages.js`), login page `lib/public/login.html`.
- Root component: `lib/public/js/app.js` (`App`), router hook `lib/public/js/hooks/use-hash-location.js` (hash routes, e.g. `#/chat`).
- Route components barrel: `lib/public/js/components/routes/index.js`.
- Nav model / sidebar sections: `lib/public/js/lib/app-navigation.js` (`kNavSections`, `getSelectedNavId`, default tab `general`).
- Sidebar: `lib/public/js/components/sidebar.js` — three sidebar tabs (**Menu**, **Browse**, **Chat**), brand mark, theme toggle, logout overflow menu, agent list + "Add agent", update button, OpenClaw dashboard launcher.
- Shared controller/polling: `lib/public/js/hooks/use-app-shell-controller.js` (polls `/api/status`, `/api/watchdog/status`, `/api/doctor/status`, `/api/onboard/status`, `/api/auth/status`, `/api/alphaclaw/version`, `/api/restart-status`), layout state `lib/public/js/hooks/use-app-shell-ui.js`, browse nav `lib/public/js/hooks/use-browse-navigation.js`.
- Global chrome: `components/global-restart-banner.js`, `components/toast.js`, `components/theme-toggle.js`, `components/dashboard-launcher-modal.js`, status bar showing `OpenClaw <ver> / Clawbridge <ver>` and a "Sandbox: <scenario>" pill when the UI sandbox is on.

### Pre-shell states (in `app.js`)
| State | Condition | Component |
|---|---|---|
| Loading | `onboarded === null` | `components/loading-spinner.js` |
| "Your instance is starting…" | `initialRuntimePending` | inline in `app.js` (waits for chat + Agent Vault) |
| Onboarding wizard | `!onboarded` | `components/welcome/index.js` |
| App shell | onboarded | sidebar + routes |

Also: first-run redirect to `#/chat` when `workspaceBootstrap.complete === false` and no explicit hash.

### Top-level routes

| Route | Nav group | Purpose | Main components | Backend APIs |
|---|---|---|---|---|
| `/general` (default) | Setup → "General" | Home/status hub: gateway + watchdog + Agent Vault health, doctor warning, channels & pairings, feature (embeddings/image/TTS/STT) health, Google Workspace/Composio, OpenAI-compat API toggle, GitHub repo auto-sync schedule, OpenClaw dashboard access card | `routes/general-route.js` → `components/general/index.js`, `use-general-tab.js`, `components/gateway.js`, `components/channels.js`, `components/channel-operations-panel.js`, `components/pairings.js`, `components/features.js`, `components/google/index.js`, `components/api-feature-panel.js`, `components/doctor/general-warning.js` | `/api/status`, `/api/events/status` (SSE), `/api/watchdog/status`, `/api/watchdog/repair`, `/api/doctor/status`, `/api/agent-vault/status`, `/api/pairings*`, `/api/channels/*`, `/api/env`, `/api/google/*`, `/api/composio/*`, `/api/gmail/*`, `/api/sync-cron`, `/api/github-sync/config`, `/api/alphaclaw/config/features/openai-compat-api`, `/api/gateway/restart`, `/api/gateway/dashboard` |
| `/chat` | sidebar "Chat" tab (no nav id) | Talk to the agent in-browser; per-session threads, drafts, abort, background-run polling, channel-setup callout | `routes/chat-route.js` (1.4k lines), `hooks/useAgentSessions.js`, `lib/chat-history-merge.js`, `lib/chat-history-polling.js`, `components/channel-setup-callout.js`, `components/session-select-field.js` | `/api/chat/history`, WebSocket `/api/ws/chat` (`lib/server/chat-ws.js`), `/api/agent/sessions` |
| `/agents`, `/agents/:id`, `/agents/:id/tools` | sidebar "Agents" list | Multi-agent CRUD, identity (name/emoji), model per agent, workspace size, tool profile/tool toggles, channel bindings, pairing | `routes/agents-route.js` → `components/agents-tab/index.js`, `agent-detail-panel.js`, `agent-overview/*`, `agent-tools/*` (+ `tool-catalog.js`), `agent-bindings-section/*`, `agent-pairing-section.js`, `create-agent-modal.js`, `edit-agent-modal.js`, `delete-agent-dialog.js`, `create-channel-modal/*` | `/api/agents*`, `/api/agents/:id/bindings`, `/api/agents/:id/workspace-size`, `/api/agents/:id/default`, `/api/channels/*`, `/api/models/config`, `/api/operations/:id/events` (SSE) |
| `/browse`, `/browse/<path>` | sidebar "Browse" tab | File explorer + editor for the OpenClaw root: tree, edit/save, create/move/delete, download, markdown split view, media preview, SQLite table viewer, git diff, restore, git sync panel | `routes/browse-route.js` → `components/file-viewer/*` (18 files), `components/file-tree.js`, `components/sidebar-git-panel.js`, `lib/browse-route.js`, `lib/browse-draft-state.js`, `lib/browse-file-policies.js`, `shared/browse-file-policies.json` | `/api/browse/*` (tree, read, write, download, create-file, create-folder, move, delete, restore, git-summary, git-diff, git-sync, sqlite-table) |
| `/models` (and `/providers` → redirect) | Config → "Models" | Model catalog/routing config, primary model, per-route models, thinking levels, provider auth cards (API keys, Codex OAuth, Claude CLI login), vault-brokered keys | `routes/models-route.js` → `components/models-tab/index.js`, `use-models.js`, `model-picker.js`, `add-model-modal.js`, `provider-auth-card.js`, `components/models.js`, `components/codex-device-auth-panel.js`, `lib/model-catalog.js`, `lib/model-config.js`, `lib/thinking-levels.js` | `/api/models`, `/api/models/status`, `/api/models/set`, `/api/models/config`, `/api/models/thinking-options`, `/api/models/auth*`, `/api/models/vault-key`, `/api/codex/*`, `/api/account-logins/claude-cli/*`, `/auth/codex/*` |
| `/credentials` | Config → "Agent Vault" | Agent Vault status, credential list, service allowlist table, create service-access proposals, link out to the TeamYou vault console | `routes/credentials-route.js` → `components/credentials/index.js`, `credential-table.js`, `service-table.js`, `pending-proposal.js`, `components/credentials-modal.js` | `/api/agent-vault/status`, `/api/agent-vault/credentials`, `/api/agent-vault/proposals*`, `/api/agent-vault/runtime/claim` |
| `/envars` | Config → "Runtime Configuration" | View/edit/add env vars, grouped (AI / GitHub / Networking / Channels / Tools / Custom), secret masking, restart prompts | `routes/envars-route.js` → `components/envars.js`, `components/secret-input.js` | `/api/env` (GET/PUT) |
| `/webhooks`, `/webhooks/:hookName` | Config → "Webhooks" | Named inbound webhook endpoints, transform modules, delivery destination, request history + payload inspection, OAuth-callback shims | `routes/webhooks-route.js` → `components/webhooks/index.js`, `webhook-list/`, `webhook-detail/`, `create-webhook-modal/`, `request-history/`, `helpers.js` | `/api/webhooks*` incl. `/:name/destination`, `/:name/oauth-callback(+/rotate)`, `/:name/requests(/:id)` |
| `/nodes` | Config → "Nodes" | Connected OpenClaw nodes/devices, approve/remove, route `tools.exec` to a node, exec security config + allowlist, browser-attach probe, guided node setup wizard | `routes/nodes-route.js` → `components/nodes-tab/index.js`, `connected-nodes/`, `browser-attach/`, `exec-config/`, `exec-allowlist/`, `setup-wizard/`, `use-nodes-tab.js` | `/api/nodes*` (status, approve, route, delete, connect-info, browser-status, exec-config, exec-approvals[/allowlist]) |
| `/cron`, `/cron/:jobId` | Monitoring → "Cron" | Cron job list/detail, enable/disable, run-now, edit prompt, edit routing, rolling calendar, run history, trends, per-job usage/cost | `routes/cron-route.js` → `components/cron-tab/*` (16 files incl. `cron-calendar.js`, `cron-job-detail.js`, `cron-prompt-editor.js`, `cron-insights-panel.js`, `cron-job-trends-panel.js`, `cron-run-history-panel.js`) | `/api/cron/jobs*`, `/api/cron/status`, `/api/cron/jobs/:id/{runs,run,enable,disable,prompt,routing,usage,trends}`, `/api/cron/usage/bulk`, `/api/cron/runs/bulk` |
| `/usage`, `/usage/:sessionId` | Monitoring → "Usage" | Token/cost summary, per-session and per-agent breakdown, time series charts | `routes/usage-route.js` → `components/usage-tab/index.js`, `overview-section.js`, `sessions-section.js`, `use-usage-tab.js`, `formatters.js` | `/api/usage/summary`, `/api/usage/sessions`, `/api/usage/sessions/:id`, `/api/usage/sessions/:id/timeseries` |
| `/doctor` | Monitoring → "Doctor" | "Drift Doctor": agent-run workspace drift scan, finding cards, accept/dismiss, send a fix to the agent, open offending file in Browse, import a raw doctor result | `routes/doctor-route.js` → `components/doctor/index.js`, `summary-cards.js`, `findings-list.js`, `fix-card-modal.js`, `general-warning.js`, `helpers.js` | `/api/doctor/{status,run,import,runs,runs/:id,runs/:id/cards,cards,cards/:id/status,findings/:id/fix}` |
| `/watchdog` | Monitoring → "Watchdog" | Gateway health, crash-loop state, auto-repair, settings, notification test, host resource bars, event/incident log, live log tail console, interactive xterm terminal | `routes/watchdog-route.js` → `components/watchdog-tab/index.js`, `resources/`, `settings/`, `console/`, `incidents/`, `terminal/`, `resource-bar.js`, `helpers.js` | `/api/watchdog/{status,events,logs,repair,settings,resources,test-notification,terminal/session,terminal/output,terminal/input,terminal/close}` + WS `/api/watchdog/terminal/ws` |
| `/telegram`, `/telegram/:accountId` | sub-screen (reached from General → Channels) | Telegram "workspace" wizard: verify bot, create group, add bot, define topics, bulk topic creation, configure group, reset | `routes/telegram-route.js` → `components/telegram-workspace/index.js`, `onboarding.js`, `manage.js`, `lib/telegram-api.js` | `/api/telegram/{bot,groups/verify,groups/:id/topics(+bulk,:topicId),groups/:id/configure,topic-registry,workspace,workspace/reset}` |
| `*` | — | redirect to `/general` (`routes/route-redirect.js`) | | |

Non-route overlays: `DashboardLauncherModal` (OpenClaw Control-UI launcher), `UpdateModal` (self/OpenClaw update), `GlobalRestartBanner`, `ConfirmDialog`, `AgentSendModal`, `ChannelLoginModal`, `CredentialsModal`, `WhatsApp QR` (event `alphaclaw:open-whatsapp-qr`).

---

## 2. Feature catalog

### 2.1 Onboarding wizard — **(b) AlphaClaw-only** (wraps `openclaw onboard` at the end)
Files: `components/welcome/index.js`, `use-welcome.js`, `components/onboarding/*` (`welcome-config.js`, `welcome-header.js`, `welcome-form-step.js`, `welcome-setup-step.js`, `welcome-import-step.js`, `welcome-placeholder-review-step.js`, `welcome-secret-review-step.js`, `welcome-secret-review-utils.js`, `provider-select.js`, `model-select.js`, `use-welcome-codex.js`, `use-welcome-storage.js`). Server: `lib/server/routes/onboarding.js`, `lib/server/onboarding/*` (`index.js`, `openclaw.js`, `workspace.js`, `github.js`, `cron.js`, `validation.js`, `runtime-readiness.js`, `tailscale-*.js`, `import/*`).
User can: pick a model + provider and authenticate it (API key, Codex OAuth PKCE/device, Claude CLI login); optionally configure GitHub backup repo (create new / use existing empty / import from a source repo, with `/api/onboard/github/verify`); scan and selectively import an existing OpenClaw install (gateway config, .env files, workspace prompt files, skills, cron jobs, hooks, memory) with a secret-review and placeholder-review step; supply a Tailscale API token and confirm the client is signed in; then watch the "setup" step which runs OpenClaw onboarding, starts the gateway, waits on chat + Agent Vault readiness (`/api/onboard/runtime-ready.svg` handoff beacon), and hands off to the final Tailscale URL. Wizard groups are declared in `welcome-config.js` (`kWelcomeGroups` = `ai`, `tailscale`).

### 2.2 Chat — **(a) thin wrapper** over gateway `chat.send` / `chat.history` / `chat.abort`, with AlphaClaw session UX
Files: `routes/chat-route.js`, `hooks/useAgentSessions.js`, `lib/session-keys.js`, `lib/chat-history-merge.js`, `lib/chat-history-polling.js`. Server: `lib/server/chat-ws.js` (WebSocket server at `/api/ws/chat`, `requestGateway()` RPC client), `GET /api/chat/history` in `lib/server.js:590`, `/api/agent/sessions` + `/api/agent/message` in `routes/system.js`.
User can: pick a session from the sidebar (grouped by agent, channel icons), send/stream messages, abort a run, keep per-session drafts in localStorage, see background-run status, and get a callout to configure a chat channel. `/api/agent/message` additionally shells `claw ... --deliver --reply-channel/--reply-to` to push a message into a channel session.

### 2.3 Providers / models — **(a) thin wrapper** (`openclaw models list/status/set`, `openclaw.json` model routes) + **(b)** vault-brokered keys
Files: `components/models-tab/*`, `components/models.js`, `components/providers.js`, `lib/model-catalog.js`, `lib/model-catalog-cache`, `lib/model-config.js`. Server: `lib/server/routes/models.js`, `lib/server/model-catalog.js`, `model-catalog-cache.js`, `model-catalog-bootstrap.json`, `model-catalog-support.json`, `lib/server/auth-profiles.js`, `lib/server/provider-credential-validation.js`, `lib/server/openclaw-thinking.js`.
User can: browse a model catalog (bootstrapped offline from `model-catalog-bootstrap.json`, refreshed via `openclaw models list --all --json`), set the primary model, configure per-route models and thinking levels, add auth profiles per provider, delete profiles, and (AlphaClaw-only) store a provider key **in Agent Vault** instead of `.env` via `POST /api/models/vault-key`.

### 2.4 Env vars / secrets — **(b) AlphaClaw-only** (`.env` managed by AlphaClaw, not OpenClaw)
Files: `components/envars.js`, `components/secret-input.js`. Server: `routes/system.js` (`GET/PUT /api/env`), `lib/server/env.js`, `lib/server/constants.js` (`kKnownVars`, `kKnownKeys`, `kSystemVars`), `lib/server/secret-redaction.js`, `lib/server/agent-vault/env-classification.js`.
User can: view/edit/add env vars grouped by purpose, with masked secret inputs, doc links, feature icons (Image/TTS/STT), and an automatic "restart required" prompt. Channel tokens matching `kManagedChannelTokenPattern` are marked managed (edit them via the Channels flow instead).

### 2.5 Channels (Telegram / Discord / Slack / WhatsApp) — **(b) AlphaClaw-only orchestration** over OpenClaw channel config
Files: `components/channels.js`, `add-channel-menu.js`, `channel-login-modal.js`, `channel-account-status-badge.js`, `channel-operations-panel.js`, `channel-setup-callout.js`, `agents-tab/create-channel-modal/*` (`telegram-setup.js`, `discord-setup.js`, `slack-setup.js`), `lib/channel-accounts.js`, `lib/channel-create-operation.js`, `lib/channel-provider-availability.js`, `lib/slack-manifest.js`. Server: `lib/server/routes/agents.js` (`/api/channels/*`), `lib/server/agents/channels.js`, `telegram-api.js` / `telegram-bot.js`, `discord-api.js` / `discord-bot.js`, `slack-api.js` / `slack-bot.js`, `lib/server/agent-vault/channel-provider-services.js`.
User can: add a channel account through a guided wizard (token inspection/validation against the provider API before saving, Slack app-manifest generation named "Clawbridge"), list/rename/delete accounts, run a channel login with streamed terminal output, watch progress via an SSE operation stream (`/api/operations/:id/events`), and bind accounts to agents. WhatsApp is deliberately excluded from the add wizard (Agent Vault MITM breaks its Noise handshake — comment in `channels.js`); a QR pairing card still appears on General when WhatsApp is configured.

### 2.6 Google Workspace / Composio — **(b) AlphaClaw-only**
Files: `components/google/*` (`index.js`, `account-row.js`, `add-account-modal.js`, `composio-panel.js`, `gmail-setup-wizard.js`, `gmail-watch-toggle.js`, `use-gmail-watch.js`, `use-google-accounts.js`, `disconnect-outcome.js`). Server: `lib/server/routes/google.js`, `routes/gmail.js`, `routes/composio.js`, `lib/server/google-state.js`, `gmail-watch.js`, `gmail-push.js`, `gmail-serve.js`, `gog-broker-service.js`, `gog-skill.js`, `composio-state.js`, `composio-login.js`, `composio-install.js`, `composio-listen.js`, `composio-skill.js`; skills shipped in `lib/setup/skills/gog-cli/*` and `lib/setup/skills/composio/*`.
User can: choose a Google provider (`gog` CLI vs Composio), store Google OAuth client credentials, run the OAuth start/callback flow (`/auth/google/start`, `/auth/google/callback`), add/disconnect accounts, check API enablement (`/api/google/check` + "enable API" deep links), run a guided Gmail watch wizard (Pub/Sub topic + subscription + push endpoint at `/gmail-pubsub`), start/stop/renew the watch, and for Composio: sign in via device-code login, link toolkits (`composio link <toolkit> --no-browser --no-wait`), enable/disable a Gmail listener, refresh connection state.

### 2.7 Webhooks — **(b) AlphaClaw-only** (persisted in `openclaw.json` `hooks.mappings` + AlphaClaw SQLite request log)
Files: `components/webhooks/*`. Server: `lib/server/routes/webhooks.js`, `lib/server/webhooks.js`, `lib/server/webhook-middleware.js`, `lib/server/oauth-callback-middleware.js`, `lib/server/db/webhooks/*`.
User can: create a named hook (validated slug), get its public URL + token, write/edit a transform module at `hooks/transforms/<name>/<name>-transform.mjs`, set the delivery destination, browse request history with full payload inspection and per-hook health (green/yellow/red), create/rotate/delete a one-shot OAuth callback URL (`/oauth/:id`) for providers that cannot send auth headers, and delete the hook. Inbound traffic hits `/hooks/*` and `/webhook/*` and is logged then forwarded to the gateway.

### 2.8 Cron — **(a) thin wrapper** over gateway `cron.*` RPC, **(b)** for analytics
Files: `components/cron-tab/*`. Server: `lib/server/routes/cron.js`, `lib/server/cron-service.js` (calls `requestGateway("cron.list"|"cron.status"|"cron.get"|"cron.run"|"cron.update"|"cron.runs")`), joined with AlphaClaw usage DB via `getSessionUsageByKeyPattern`.
User can: list jobs, see status, run now, enable/disable, edit the prompt, edit routing (delivery channel/target), browse run history with status/delivery filters, view a rolling calendar, trends over 24h/7d/30d, and per-run token/cost breakdown (the cost join is AlphaClaw-only).

### 2.9 Nodes / devices — **(a) thin wrapper** over `openclaw nodes|devices` CLI
Files: `components/nodes-tab/*`. Server: `lib/server/routes/nodes.js` (shells `nodes status --json`, `nodes pending --json`, `nodes approve`, `devices remove`, `nodes invoke --command browser.proxy`, `config get/set tools.exec.*`), plus exec allowlist storage.
User can: see connected/pending nodes, approve or remove them, route shell execution to a node (sets `tools.exec.host=node`, `security=allowlist`, `ask=on-miss`, `node=<id>`), edit exec security config, manage an exec command allowlist, probe a node's browser attach status per profile, and follow a guided setup wizard using `/api/nodes/connect-info` (base URL, gateway host/port, gateway token).

### 2.10 Pairing (channel + browser/device) — **(a) thin wrapper** + **(b)** auto-approval logic
Files: `components/pairings.js`, `components/device-pairings.js`, `agents-tab/agent-pairing-section.js`, `hooks/use-dashboard-launcher.js`, `hooks/dashboard-launcher-helpers.js`. Server: `lib/server/routes/pairings.js`, `lib/server/managed-gateway-device.js`.
User can: see pending channel pairing requests per channel (from `openclaw pairing list --channel <ch> --json` merged with the on-disk pending store) and approve/reject; see pending **device** pairings (`openclaw devices list --json`) and approve/reject them — this is what unblocks opening the OpenClaw Control UI in a new browser. `managed-gateway-device.js` pre-approves the managed gateway's own device.

### 2.11 Watchdog / doctor(OpenClaw) / logs / terminal — **(c) ops/lifecycle**, AlphaClaw-only
Files: `components/watchdog-tab/*`, `components/gateway.js`. Server: `lib/server/routes/watchdog.js`, `lib/server/watchdog.js`, `watchdog-notify.js`, `watchdog-terminal.js`, `watchdog-terminal-ws.js`, `lib/server/system-resources.js`, `lib/server/log-writer.js`, `lib/server/db/watchdog/*`, `lib/server/openclaw-doctor-repair.js`, `lib/cli/openclaw-doctor-oauth-guard.js`.
User can: see gateway health/uptime/lifecycle (incl. crash-loop), trigger auto-repair (runs `openclaw doctor --fix` behind a guard), toggle watchdog settings, send a test notification (Telegram/Discord/Slack), view an incident/event log, tail gateway logs in a console card, watch host CPU/memory/disk bars (incl. per-process "Clawbridge" RSS), export a watchdog report, and open a **live interactive xterm terminal** into the OpenClaw root over `/api/watchdog/terminal/ws`.

### 2.12 Drift Doctor — **(b) AlphaClaw-only** (distinct from `openclaw doctor`)
Files: `components/doctor/*`. Server: `lib/server/routes/doctor.js`, `lib/server/doctor/*` (`service.js`, `prompt.js`, `normalize.js`, `bootstrap-context.js`, `workspace-fingerprint.js`, `workspace-snapshot-manager.js`, `workspace-snapshot-worker.js`, `constants.js`), `lib/server/db/doctor/*`.
User can: run an agent-driven scan of the workspace for prompt/config drift, see summary + finding cards with file/line markers, mark cards accepted/dismissed, click through to the file in Browse, and send a "fix this" instruction back to the agent (`POST /api/doctor/findings/:id/fix`). A General-tab warning banner surfaces open findings (dismissible for a week, stored in UI settings).

### 2.13 Sessions — **(a) thin wrapper** (`openclaw sessions --json --all-agents`, gateway `sessions.list`)
Files: `hooks/useAgentSessions.js`, `lib/session-keys.js`, sidebar Chat tab, `components/session-select-field.js`, `hooks/use-destination-session-selection.js`. Server: `/api/agent/sessions` in `routes/system.js`; also used by `bootstrap-kickoff.js` and usage/cron joins.

### 2.14 Memory — **(c)/(b), server-side only, no dedicated UI**
`lib/server/teamyou-memory-activation.js` activates the `openclaw-teamyou-memory` plugin + `teamyou` skill once the workspace bootstrap ritual completes, and enforces a pre-bootstrap gate. The only "Memory" strings in the UI are the watchdog RAM gauge and the agent tool-catalog section. Onboarding import can carry memory directories.

### 2.15 Skills — **(b) AlphaClaw-only**, no management UI
Packaged skills are installed into the OpenClaw dir at boot: `installGogCliSkill`, `installComposioSkill` (`lib/server/gog-skill.js`, `composio-skill.js`; sources under `lib/setup/skills/`). Onboarding import can bring in user skills. Users can edit skill files through Browse.

### 2.16 Backup / restore / git sync — **(b) AlphaClaw-only**
Files: `components/sidebar-git-panel.js`, `components/file-viewer/use-file-diff.js`, `diff-viewer.js`. Server: `lib/server/routes/browse/index.js` (`git-summary`, `git-diff`, `git-sync`, `restore`), `lib/server/routes/browse/git.js`, `lib/server/github-backup.js`, `lib/cli/git-sync.js`, `lib/cli/git-runtime.js`, `bin/alphaclaw.js` `git-sync` command, `lib/setup/hourly-git-sync.sh`, `routes/system.js` (`/api/sync-cron`, `/api/github-sync/config`).
User can: see changed files and ahead/behind vs origin, commit+push with an auto-generated message, restore a single file from git (`git restore --staged --worktree` with `git checkout --` fallback), set up GitHub sync (token + `owner/repo`, repo created/validated via the GitHub API) from the sidebar, and choose an auto-sync schedule (Disabled / 30 min / Hourly / Daily) on General, backed by a system cron entry.

### 2.17 Gateway restart / lifecycle — **(c) ops/lifecycle**
Files: `components/gateway.js`, `components/global-restart-banner.js`. Server: `routes/system.js` (`/api/gateway/restart`, `/api/restart-status`, `/api/restart-status/dismiss`, `/api/gateway-status`), `lib/server/gateway.js`, `gateway-lifecycle-ownership.js`, `gateway-boot-preparation.js`, `restart-required-state.js`, `lib/server/startup.js`, `lib/server/init/server-lifecycle.js`, `lib/server/openclaw-runtime-state.js`, `lib/cli/openclaw-startup-state-repair/`.
User can: restart the gateway from a global banner or the Gateway card, see restart-required state raised by env/model/vault/channel changes, and dismiss it. Systemd-owned gateways are detected (`watchdog.js` handles "gateway already running under systemd").

### 2.18 Self-update (Clawbridge + OpenClaw) — **(c) ops/lifecycle**
Files: `components/update-modal.js`, `update-action-button.js`, sidebar footer. Server: `routes/system.js` (`/api/alphaclaw/version`, `/api/alphaclaw/release-notes`, `/api/alphaclaw/update`), `lib/server/alphaclaw-version.js`, `lib/server/openclaw-version.js`.
User can: see current vs latest Clawbridge and OpenClaw versions, read release notes/changelog in-app, and apply an in-place update **only when the deployment is self-hosted**. When `ALPHACLAW_DEPLOYMENT_PROVIDER=clawctl` the strategy flips to `action: "instructions"` labeled **TeamYou** — "Contact TeamYou support to request an upgrade" — with no self-update button.

### 2.19 TeamYou integration — **(b) AlphaClaw-only**
- Update channel: `clawctl` deployments are branded as TeamYou-managed (`lib/server/alphaclaw-version.js:149-157`).
- Agent Vault entry point: `TEAMYOU_AGENT_VAULT_ENTRY_URL` env (`lib/server/constants.js:323`), link builders in `lib/agent-vault-links.js` (`buildTeamYouAgentVaultApprovalUrl`, `normalizeTeamYouAgentVaultEntryUrl`) used by the vault plugin `lib/plugin/agent-vault/index.js` and the Gateway/Credentials cards ("Open vault console" → `status.entryUrl`).
- Memory plugin/skill activation: `lib/server/teamyou-memory-activation.js`.
- Visual identity: the whole theme is an explicit TeamYou brand mapping (see §3).
- Docs: `docs/teamyou-memory-integration-analysis.md`.

### 2.20 Agent Vault / credential status — **(b) AlphaClaw-only**
Files: `components/credentials/*`, `components/credentials-modal.js`, Gateway card vault row. Server: `lib/server/routes/agent-vault.js`, `lib/server/agent-vault/*` (`service.js`, `client.js`, `vault-fetch.js`, `runtime-store.js`, `proxy-shim.js`, `env-classification.js`, `model-provider-services.js`, `channel-provider-services.js`), `lib/agent-vault-access.js`, OpenClaw plugin `lib/plugin/agent-vault/` (tool `ensure_service_access`).
User can: see vault status (initialized / managed / mode / owner-enrollment pending / restart required), list brokered credential keys and their metadata, list allowlisted services (host, auth mode, header/prefix, substitution mode), create a *proposal* for new service access (values are never typed into Clawbridge — the route rejects any payload containing a `value` field) and follow the proposal to the TeamYou vault console for approval, and claim the runtime token. Docs: `docs/vault-brokered-channels-spec.md`, `docs/vault-brokered-model-keys-spec.md`.

### 2.21 OAuth health / brokers — **(b) AlphaClaw-only**
Server: `lib/oauth-broker-constants.js`, `lib/server/oauth-broker-client.js`, `claude-broker-service.js`, `codex-broker-service.js`, `gog-broker-service.js`, `bin/alphaclaw-oauth-lease.js`, `bin/alphaclaw-gog.js`, `lib/cli/openclaw-doctor-oauth-guard.js`. UI surfaces: `components/models-tab/provider-auth-card.js`, `codex-device-auth-panel.js`, `lib/use-codex-device-auth.js`, `lib/codex-oauth-window.js`, `lib/claude-cli-login-window.js`.
User can: connect/disconnect Codex OAuth (browser PKCE via `/auth/codex/start` + `/auth/codex/callback`, manual paste via `/api/codex/exchange`, or device flow via `/api/codex/device/start|poll`), run a Claude CLI login with a live SSE terminal (`/api/account-logins/claude-cli/login/:id/events`) and submit the code, adopt an existing local Claude CLI session, and disconnect. Docs: `docs/oauth-refresh-broker-spec.md`, `docs/oauth-broker-v2-*.md`.

### 2.22 Usage / cost tracking — **(b) AlphaClaw-only**
Files: `components/usage-tab/*`, chart.js. Server: `lib/server/routes/usage.js`, `lib/server/db/usage/*` (`sessions.js`, `summary.js`, `timeseries.js`, `pricing.js`), `lib/server/cost-utils.js`, `lib/server/usage-tracker-config.js`, and the injected OpenClaw plugin `lib/plugin/usage-tracker/` that feeds the DB.
User can: see daily token/cost summaries, per-session drill-down with source/agent dimensions, and time-series charts; cron run costs reuse the same store.

### 2.23 Files / Browse — **(b) AlphaClaw-only**
Files: `components/file-viewer/*`, `components/file-tree.js`, `lib/file-tree-utils.js`, `lib/file-highlighting.js`, `lib/syntax-highlighters/*`, `lib/browse-*`. Server: `lib/server/routes/browse/*`.
User can: navigate the OpenClaw root tree, read/edit/save files (drafts persisted), view markdown split-view and frontmatter, preview media, browse SQLite tables, see git diffs, create/rename/move/delete files and folders, download files, and restore from git. Protected/locked paths are marked "Managed by Clawbridge" and blocked (`kProtectedBrowsePaths` / `kLockedBrowsePaths` in `lib/server/constants.js`, policy JSON in `lib/public/shared/browse-file-policies.json`).

### 2.24 OpenAI-compatible `/v1` API — **(b) AlphaClaw-only** proxy feature
Files: `components/api-feature-panel.js`. Server: `lib/server/routes/proxy.js` (`kOpenAiCompatProxyPathPattern` for `/v1/chat/completions|responses|embeddings|models`), `routes/system.js` (`/api/alphaclaw/config/features/openai-compat-api`), `lib/server/alphaclaw-config.js`, `login-throttle.js`.
User can: toggle the feature on/off and copy the public `<origin>/v1` URL; requests authenticate with the gateway bearer token, are throttled, and have cookies stripped in both directions.

### 2.25 Auth / login — **(b) AlphaClaw-only**
`lib/public/login.html`, `lib/server/routes/auth.js` (`/api/auth/login|status|logout`, then `requireAuth` mounted on `/setup`, `/api`, `/auth`), `lib/server/login-throttle.js`, `lib/server/db/auth/*`. Single shared `SETUP_PASSWORD`; logout clears local/session storage and returns to `/login.html`.

### 2.26 Agent pages hosting — **(b) AlphaClaw-only**
`lib/server/routes/pages.js` serves agent-authored static pages from `<OPENCLAW_DIR>/pages` at `/pages/*` under a hard sandbox CSP (`sandbox allow-scripts`, no same-origin), with surface classification so they are not exposed on the public ingress.

### 2.27 Dev/QA harness — internal
`lib/server/ui-sandbox/*` (`server.js`, `fixtures.js`, `workspace.js`), `scripts/start-ui-sandbox.mjs`, npm scripts `dev:ui`, `dev:ui:setup`, `dev:ui:persist`. Surfaces a "Sandbox: <scenario>" pill in the app status bar.

---

## 3. Branding / white-label points

| Point | Where |
|---|---|
| Theme tokens (CSS custom properties) | `lib/public/css/theme.css` — dark + `[data-theme="light"]` blocks. Header comment: *"TeamYou brand mapping (see DESIGN.md) — dark theme is the TeamYou cobalt environment: cobalt surfaces, teamyou-green accent."* Tokens: `--bg`, `--bg-sidebar`, `--bg-content`, `--bg-hover`, `--bg-active`, `--border`, `--border-strong`, `--text`, `--text-muted`, `--text-dim`, `--text-bright`, `--card-label-bright`, `--accent` (`#31ee88` teamyou-green-400 / `#06b357` light), `--accent-dim`, `--accent-link`, `--orange`, syntax tokens, `--panel-*`, `--field-*`, `--overlay`, and full `--status-{error,warning,success,info}[-muted|-bg|-border]` sets. |
| Tailwind bridge | `tailwind.config.cjs`, `lib/public/css/tailwind.input.css` → generated `tailwind.generated.css`, `lib/public/js/tailwind-config.js` |
| Other stylesheets | `lib/public/css/shell.css`, `explorer.css` (incl. `.sidebar-dashboard-*` launcher styles), `agents.css`, `chat.css`, `cron.css`, `vendor/` |
| Logo | `lib/public/img/logo.svg`, rendered as a CSS mask via `.ac-logo-mark` (`theme.css:119-131`) so it recolors per theme; used in `components/sidebar.js:264` and `components/onboarding/welcome-header.js:19`; favicon in `setup.html`/`login.html` |
| Product name copy | Page `<title>clawbridge` in `lib/public/setup.html:6` and `lib/public/login.html:6`; sidebar wordmark `<span style="color: var(--accent)">claw</span>bridge` (`sidebar.js`), same in the mobile topbar (`app.js`); footer `OpenClaw <v> / Clawbridge <v>` (`app.js:124-131`). ~40 more "Clawbridge" user-facing strings across `components/*` (see `update-modal.js:179` label, `dashboard-launcher-modal.js`, `credentials/index.js:271`, `file-tree.js` "Managed by Clawbridge", `welcome-setup-step.js` "Open Clawbridge"). |
| Identifiers still `alphaclaw` | package name, `bin/alphaclaw.js`, CSS prefix `ac-*`, window flags `__alphaclawPendingCreateAgent` / `__alphaclawSetupAppBootCount`, DOM events `alphaclaw:create-agent`, `alphaclaw:restart-required`, `alphaclaw:open-whatsapp-qr`, env prefix `ALPHACLAW_*`, header `x-alphaclaw-ingress-surface`, log prefix `[alphaclaw]` |
| Third-party app naming | Slack app manifest defaults to app name **"Clawbridge"** (`lib/public/js/lib/slack-manifest.js:60-69`, `agents-tab/create-channel-modal.js:121`) — user-editable in the wizard |
| Theme persistence | `components/theme-toggle.js` + `lib/ui-settings.js` (localStorage `data-theme`) |
| Per-tenant hooks (de facto) | `ALPHACLAW_DEPLOYMENT_PROVIDER` (`clawctl` → TeamYou-branded update path, `lib/server/alphaclaw-version.js:143-170`), `TEAMYOU_AGENT_VAULT_ENTRY_URL`, `ALPHACLAW_TAILSCALE_{DNS,DEVICE_ID,HOST_ROLE}`, `SETUP_PASSWORD`, `GITHUB_WORKSPACE_REPO`. **There is no theme/logo/product-name configuration surface** — branding is hard-coded in CSS/HTML/JS, so white-labeling today means editing `theme.css`, `img/logo.svg`, the two HTML titles, and the string literals. |
| Design docs | `DESIGN.md`, `docs/security-architecture.html` |

---

## 4. Gateway-VPS communication features

Two distinct "gateway" notions exist in this repo; both are covered.

### 4.1 OpenClaw gateway (child process on the same host, `127.0.0.1:18789`)
- Status/uptime/version: `GET /api/status`, `GET /api/gateway-status`, SSE `GET /api/events/status` → Gateway card.
- Restart: `POST /api/gateway/restart`; restart-required state: `GET /api/restart-status`, `POST /api/restart-status/dismiss`.
- Full HTTP proxy: `ALL /openclaw`, `ALL /openclaw/*`, `ALL /assets/*`, and the `/api/*` catch-all for anything not in `SETUP_API_PREFIXES` (`lib/server/routes/proxy.js`).
- WebSocket bridges: `/api/ws/chat` (chat RPC) and `/api/watchdog/terminal/ws`; upgrades to `/openclaw*` are also proxied (`lib/server/watchdog-terminal-ws.js:103-127`).
- CLI shell-outs (`clawCmd`/`shellCmd` from `lib/server/commands.js`, `lib/server/utils/shell.js`): `status`, `dashboard --no-open`, `sessions --json --all-agents`, `secrets reload --json`, `pairing list --channel <ch> --json`, `devices list/remove`, `nodes status|pending|approve|invoke`, `config get/set tools.exec.*`, `openclaw models list|status|set`, `openclaw doctor --fix`.

### 4.2 Separate **security gateway** VPS (the "gateway VPS")
- Connectivity mode `security_gateway` is the managed topology (`lib/server/agent-vault/service.js:243,750,960,1009`, `lib/server/routes/system.js:26-30`, `lib/server/usage-tracker-config.js:28`, `lib/server/onboarding/gateway-tailscale-finalizer.js:11-12`).
- **SSH forced-command channel** to the gateway host: `lib/server/onboarding/gateway-tailscale-client.js` — a hardened one-shot JSON-over-stdin/stdout SSH client (`BatchMode`, `IdentitiesOnly`, `StrictHostKeyChecking=yes`, pinned known-hosts, no forwarding/TTY, 120 s timeout, output caps). Operations are `configure` / `status` / `seal`; secrets never enter argv, env, logs, or responses; the private identity is deleted after sealing is durably recorded.
- Driven by `lib/server/onboarding/gateway-tailscale-finalizer.js` (writes `ALPHACLAW_TAILSCALE_DNS`, `ALPHACLAW_TAILSCALE_DEVICE_ID`, `ALPHACLAW_TAILSCALE_HOST_ROLE=security_gateway`) and `lib/server/onboarding/tailscale-finalizer.js` + `tailscale-env.js`.
- **User-facing entry point:** the onboarding wizard's Tailscale step (`components/onboarding/welcome-form-step.js:640-725`) — paste a `tskey-api-…` token, confirm the Tailscale client is installed/signed in, then `POST /api/onboard` runs finalization and returns the final tailnet setup URL (header `x-clawbridge-setup-url`, `components/welcome/use-welcome.js:179`). After onboarding there is no ongoing gateway-VPS control panel.
- Host-level privileged operations run through a sudo wrapper: `shellCmd(\`sudo -n ${kHostFinalizeSetupWrapper} ${operation}\`)` in `lib/server/onboarding/index.js`; failures explicitly say the host "was likely provisioned with an older clawctl".
- **Agent Vault on the gateway:** `lib/server/agent-vault/service.js` builds a gateway Tailscale client, reports `managed: connectivityMode === "security_gateway"`, exposes `operatorUrl`/`entryUrl`, and the Credentials page tells the user "Credentials are brokered on the security gateway" (`components/credentials/index.js:271`). The only actions available are status/claim/list/propose plus an "open vault console" external link.
- **Egress:** enforced off-host by the provider firewall and routed through the security gateway — documented in `lib/setup/core-prompts/AGENTS.md:25-31`, `docs/egress-enforcement-spec.md`, `docs/egress-flow-log-inventory.md`, `docs/egress-program-status.md`, `docs/security-gateway-rollout-notes.md`. The vault plugin explicitly bypasses the egress proxy for control-plane calls (`lib/plugin/agent-vault/index.js:174`). **No UI surface exposes egress state or controls.**
- **clawctl actions:** none are invokable from the UI. clawctl presence only changes behavior (update strategy → "contact TeamYou support"; plugin/memory reconcile is clawctl-owned; `lib/server/teamyou-memory-activation.js:381,572`).
- `tailscale status --json` is shelled locally (for client-readiness checks) — `lib/server/onboarding/*`.

---

## 5. Links / handoffs to the OpenClaw Control UI

| Surface | Detail |
|---|---|
| Proxy mount | `lib/server/routes/proxy.js:211-221` — `ALL /openclaw` (rewrites to `/`), `ALL /openclaw/*` (strips the prefix), `ALL /assets/*`; all behind `requireAuth`, all proxied to `getGatewayUrl()` (default `http://127.0.0.1:18789`). WebSocket upgrades to `/openclaw*` are proxied too (`lib/server/watchdog-terminal-ws.js:103`). |
| Sidebar launcher | `components/sidebar-dashboard-action.js` + `.sidebar-dashboard-*` styles in `lib/public/css/explorer.css:97-170`; rendered at the top of the Menu tab with a pending-pairing dot. |
| Launcher logic | `hooks/use-dashboard-launcher.js` — `kPairedDashboardUrl = "/openclaw"`; if the browser already holds an OpenClaw operator token (localStorage keys in `hooks/dashboard-launcher-helpers.js`: `kOpenClawDeviceAuthStorageKey`, `kOpenClawDeviceIdentityStorageKey`) it opens `/openclaw` directly in a new tab; otherwise it opens a modal, polls `/api/devices` every 2 s, and waits for the browser's device pairing to be approved. |
| Launcher modal | `components/dashboard-launcher-modal.js` — states LOADING / READY / OPENING / WAITING / REQUEST / APPROVED / TIMEOUT / TOKEN_MISSING / ERROR, with "Launch OpenClaw" / "Launch OpenClaw again" buttons and approve/reject controls for the pending browser pairing. |
| URL resolution API | `GET /api/gateway/dashboard` (`lib/server/routes/system.js:1061-1079`) — reads a dashboard token from `openclaw.json` (`getDashboardTokenFromConfig`) and builds a tokenized URL; otherwise runs `claw dashboard --no-open` and extracts the token from stdout; falls back to `{ url: "/openclaw", needsAuth: true }`. Helpers at `system.js:225-260`. |
| General-tab card | "OpenClaw dashboard access" card at `components/general/index.js:217-232` — "The primary OpenClaw launcher is now always available in the left sidebar", with an **Open** button that reuses the launcher. |
| Agent prompt copy | `lib/setup/core-prompts/TOOLS.md:13` lists "OpenClaw dashboard" as something reachable from the General screen at `{{SETUP_UI_URL}}#general`. |
| Legacy reference | `lib/server/gateway.js:228-230` backfills a legacy `~/.openclaw/skills/control-ui/SKILL.md`; `lib/server/agent-vault/{channel-provider-services.js:217,service.js:456}` note that vault brokering "binds the Control UI, the agent, and the CLI alike". |
| Not found | No `:18789` link exposed to the browser, no `/__openclaw` path, no iframe embed of the Control UI. The only handoff is the new-tab launch of the same-origin `/openclaw` proxy. |

---

## 6. Backend route list

Registration order: `lib/server.js` middleware → `registerServerRoutes` (`lib/server/init/register-server-routes.js`) in the order auth → pages → models → system → browse → pairings → codex → account-logins → google → gmail → composio → onboarding → telegram → webhooks → watchdog → usage → cron → doctor → agents → nodes → agent-vault → proxy → then `GET /api/chat/history` in `server.js`. The proxy catch-alls are registered last, so every specific route above wins.

### Global middleware (`lib/server.js`)
```
USE   (all)                 createPublicIngressGuard()                          server.js:212
USE   /webhook, /hooks      express.raw({type:"*/*", limit:"5mb"})              server.js:213
USE   /gmail-pubsub         express.raw({type:"*/*", limit:"5mb"})              server.js:214
USE   /v1                   raw-body capture for OpenAI-compat proxy            server.js:221
USE   (all)                 express.json({limit:"5mb"})                         server.js:227
USE   (all)                 express.static(lib/public)                          server.js:374
```

### Auth — `lib/server/routes/auth.js`
```
POST  /api/auth/login
GET   /api/auth/status
POST  /api/auth/logout
USE   /setup   requireAuth
USE   /api     requireAuth
USE   /auth    requireAuth
```

### Pages / health — `lib/server/routes/pages.js`
```
GET   /health
USE   /pages            (surface-gated static agent pages, sandboxed CSP)
GET   /                 requireAuth → setup.html
GET   /setup            → setup.html
```

### Onboarding — `lib/server/routes/onboarding.js`
```
GET   /api/onboard/status
GET   /api/onboard/runtime-ready.svg
POST  /api/onboard
POST  /api/onboard/github/verify
POST  /api/onboard/import/scan
POST  /api/onboard/import/apply
```

### System / env / status / version / gateway — `lib/server/routes/system.js`
```
GET   /api/env
PUT   /api/env
POST  /api/github-sync/config
GET   /api/status
GET   /api/events/status                      (SSE)
GET   /api/sync-cron
PUT   /api/sync-cron
GET   /api/alphaclaw/config
PUT   /api/alphaclaw/config/features/openai-compat-api
GET   /api/alphaclaw/version
GET   /api/alphaclaw/release-notes
POST  /api/alphaclaw/update
GET   /api/gateway-status
GET   /api/agent/sessions
POST  /api/agent/message
GET   /api/gateway/dashboard
GET   /api/restart-status
POST  /api/restart-status/dismiss
POST  /api/gateway/restart
```

### Models / auth profiles — `lib/server/routes/models.js`
```
GET    /api/models
GET    /api/models/thinking-options
GET    /api/models/status
POST   /api/models/set
GET    /api/models/config
PUT    /api/models/config
POST   /api/models/vault-key
GET    /api/models/auth
PUT    /api/models/auth/:profileId
DELETE /api/models/auth/:profileId
```

### Codex OAuth — `lib/server/routes/codex.js`
```
GET   /api/codex/status
GET   /auth/codex/start
GET   /auth/codex/callback
POST  /api/codex/exchange
POST  /api/codex/device/start
POST  /api/codex/device/poll
POST  /api/codex/disconnect
```

### Claude CLI account login — `lib/server/routes/account-logins.js`
```
GET   /api/account-logins/claude-cli/status
POST  /api/account-logins/claude-cli/login/start
POST  /api/account-logins/claude-cli/login/:id/cancel
POST  /api/account-logins/claude-cli/login/:id/input
GET   /api/account-logins/claude-cli/login/:id/events      (SSE)
POST  /api/account-logins/claude-cli/adopt
POST  /api/account-logins/claude-cli/disconnect
```

### Google Workspace — `lib/server/routes/google.js`
```
GET   /api/google/provider
POST  /api/google/provider
GET   /api/google/accounts
GET   /api/google/status
GET   /api/google/credentials
POST  /api/google/credentials
POST  /api/google/accounts
GET   /api/google/check
POST  /api/google/disconnect
GET   /auth/google/start
GET   /auth/google/callback
```

### Gmail watch / Pub-Sub — `lib/server/routes/gmail.js`
```
GET   /api/gmail/config
POST  /api/gmail/config
POST  /api/gmail/watch/start
POST  /api/gmail/watch/stop
POST  /api/gmail/watch/renew
GET   /api/gmail/watch/status
POST  /gmail-pubsub                    (public push endpoint)
```

### Composio — `lib/server/routes/composio.js`
```
GET   /api/composio/status
POST  /api/composio/link
POST  /api/composio/login/start
POST  /api/composio/gmail-watch/enable
POST  /api/composio/gmail-watch/disable
POST  /api/composio/refresh
```

### Agents + channel accounts — `lib/server/routes/agents.js`
```
POST   /api/channels/vault-token
GET    /api/channels/accounts
GET    /api/channels/accounts/token
POST   /api/channels/telegram/inspect-token
POST   /api/channels/discord/inspect-token
POST   /api/channels/slack/inspect-credentials
POST   /api/channels/accounts
POST   /api/channels/accounts/jobs
GET    /api/operations/:operationId/events        (SSE)
PUT    /api/channels/accounts
POST   /api/channels/accounts/login
GET    /api/channels/accounts/login-status
DELETE /api/channels/accounts
GET    /api/agents
GET    /api/agents/:id
GET    /api/agents/:id/workspace-size
GET    /api/agents/:id/bindings
POST   /api/agents
PUT    /api/agents/:id
POST   /api/agents/:id/bindings
DELETE /api/agents/:id/bindings
DELETE /api/agents/:id
POST   /api/agents/:id/default
```

### Telegram workspace / topics — `lib/server/routes/telegram.js`
```
GET    /api/telegram/bot
POST   /api/telegram/groups/verify
GET    /api/telegram/groups/:groupId/topics
POST   /api/telegram/groups/:groupId/topics
POST   /api/telegram/groups/:groupId/topics/bulk
DELETE /api/telegram/groups/:groupId/topics/:topicId
PUT    /api/telegram/groups/:groupId/topics/:topicId
POST   /api/telegram/groups/:groupId/configure
GET    /api/telegram/topic-registry
GET    /api/telegram/workspace
POST   /api/telegram/workspace/reset
```

### Pairings + devices — `lib/server/routes/pairings.js`
```
GET   /api/pairings
POST  /api/pairings/:id/approve
POST  /api/pairings/:id/reject
GET   /api/devices
POST  /api/devices/:id/approve
POST  /api/devices/:id/reject
```

### Nodes — `lib/server/routes/nodes.js`
```
GET    /api/nodes
POST   /api/nodes/:id/approve
POST   /api/nodes/:id/route
DELETE /api/nodes/:id
GET    /api/nodes/connect-info
GET    /api/nodes/:id/browser-status
GET    /api/nodes/exec-config
POST   /api/nodes/exec-config
GET    /api/nodes/exec-approvals
POST   /api/nodes/exec-approvals/allowlist
DELETE /api/nodes/exec-approvals/allowlist/:id
```

### Webhooks — `lib/server/routes/webhooks.js`
```
GET    /api/webhooks
GET    /api/webhooks/:name
POST   /api/webhooks
PUT    /api/webhooks/:name/destination
POST   /api/webhooks/:name/oauth-callback
POST   /api/webhooks/:name/oauth-callback/rotate
DELETE /api/webhooks/:name/oauth-callback
DELETE /api/webhooks/:name
GET    /api/webhooks/:name/requests
GET    /api/webhooks/:name/requests/:id
```

### Watchdog — `lib/server/routes/watchdog.js` (all `requireAuth`)
```
GET   /api/watchdog/status
GET   /api/watchdog/events
GET   /api/watchdog/logs
POST  /api/watchdog/repair
GET   /api/watchdog/settings
PUT   /api/watchdog/settings
GET   /api/watchdog/resources
POST  /api/watchdog/test-notification
POST  /api/watchdog/terminal/session
GET   /api/watchdog/terminal/output
POST  /api/watchdog/terminal/input
POST  /api/watchdog/terminal/close
WS    /api/watchdog/terminal/ws            (lib/server/watchdog-terminal-ws.js:3)
```

### Usage — `lib/server/routes/usage.js` (all `requireAuth`)
```
GET   /api/usage/summary
GET   /api/usage/sessions
GET   /api/usage/sessions/:id
GET   /api/usage/sessions/:id/timeseries
```

### Cron — `lib/server/routes/cron.js` (all `requireAuth`)
```
GET   /api/cron/jobs
GET   /api/cron/status
GET   /api/cron/jobs/:id/runs
POST  /api/cron/jobs/:id/run
POST  /api/cron/jobs/:id/enable
POST  /api/cron/jobs/:id/disable
PUT   /api/cron/jobs/:id/prompt
PUT   /api/cron/jobs/:id/routing
GET   /api/cron/jobs/:id/usage
GET   /api/cron/jobs/:id/trends
GET   /api/cron/usage/bulk
GET   /api/cron/runs/bulk
```

### Drift Doctor — `lib/server/routes/doctor.js` (all `requireAuth`)
```
GET   /api/doctor/status
POST  /api/doctor/run
POST  /api/doctor/import
GET   /api/doctor/runs
GET   /api/doctor/cards
GET   /api/doctor/runs/:id
GET   /api/doctor/runs/:id/cards
POST  /api/doctor/cards/:id/status
POST  /api/doctor/findings/:id/fix
```

### Agent Vault — `lib/server/routes/agent-vault.js` (all `requireAuth`)
```
GET   /api/agent-vault/status
POST  /api/agent-vault/runtime/claim
GET   /api/agent-vault/credentials
POST  /api/agent-vault/proposals
GET   /api/agent-vault/proposals/:id
```

### Browse / files / git — `lib/server/routes/browse/index.js`
```
GET    /api/browse/tree
GET    /api/browse/read
GET    /api/browse/download
GET    /api/browse/git-summary
GET    /api/browse/sqlite-table
GET    /api/browse/git-diff
POST   /api/browse/git-sync
PUT    /api/browse/write
POST   /api/browse/create-file
POST   /api/browse/create-folder
POST   /api/browse/move
DELETE /api/browse/delete
POST   /api/browse/restore
```

### Chat — `lib/server.js` + `lib/server/chat-ws.js`
```
GET   /api/chat/history                     server.js:590
WS    /api/ws/chat                          chat-ws.js / watchdog-terminal-ws.js:126
```

### Proxy / public ingress — `lib/server/routes/proxy.js` (registered last)
```
ALL   /openclaw                             → gateway (requireAuth)
ALL   /openclaw/*                           → gateway (requireAuth)
ALL   /assets/*                             → gateway (requireAuth)
ALL   /oauth/:id                            → oauthCallbackMiddleware
ALL   /hooks/*                              → webhookMiddleware
ALL   /webhook/*                            → webhookMiddleware
ALL   /v1/{chat/completions,responses,embeddings,models[/:id]}   → OpenAI-compat proxy (bearer = gateway token, throttled, feature-flagged)
ALL   /api/*                                → gateway, unless the path starts with a SETUP_API_PREFIXES entry
```
`SETUP_API_PREFIXES` (`lib/server/constants.js:579-606`): `/api/status`, `/api/pairings`, `/api/google`, `/api/codex`, `/api/models`, `/api/browse`, `/api/chat`, `/api/gateway`, `/api/restart-status`, `/api/onboard`, `/api/env`, `/api/agent-vault`, `/api/auth`, `/api/openclaw`, `/api/devices`, `/api/sync-cron`, `/api/telegram`, `/api/webhooks`, `/api/gmail`, `/api/watchdog`, `/api/usage`, `/api/cron`, `/api/agents`, `/api/channels`, `/api/operations`, `/api/nodes`.
(Note: `/api/composio`, `/api/doctor`, `/api/account-logins`, `/api/alphaclaw`, `/api/github-sync`, `/api/agent`, `/api/events` are *not* in that list; they still resolve because their concrete handlers are registered before the catch-all, but any unmatched sub-path under those prefixes falls through to the gateway.)

---

## 7. Audit summary — Clawbridge vs. OpenClaw's own Control UI

**Pure pass-through / near-duplicate of OpenClaw capability (a):** chat, sessions, cron, models/model routing, nodes & devices, channel pairing, gateway status/restart, tool profiles (catalog is a static mirror of OpenClaw's `tool-catalog.ts`), plus the literal `/openclaw` proxy of the Control UI itself.

**AlphaClaw-only value (b):** onboarding/import wizard with secret review; Agent Vault brokerage (credentials, model keys, channel tokens, proposals, TeamYou console handoff); OAuth broker services (Codex, Claude CLI, gog); Google Workspace + Gmail Pub/Sub watch + Composio; named webhooks with transforms, request log, and OAuth-callback shims; usage/cost tracking (own SQLite + injected `usage-tracker` plugin); Drift Doctor; Browse/file editor with git diff/restore/SQLite viewer; GitHub backup + git-sync scheduling; password auth; OpenAI-compatible `/v1` proxy; multi-agent identity/binding UX; Telegram topic workspace; sandboxed agent-page hosting.

**Ops/lifecycle (c):** watchdog (crash detection, crash-loop recovery, auto-repair, notifications, live terminal, host resource gauges), gateway process ownership/systemd interop, restart-required state machine, Clawbridge/OpenClaw self-update (self-hosted) vs. clawctl/TeamYou-managed update instructions, Tailscale/security-gateway finalization, sudo host-finalize wrapper.

**Gaps worth noting for the audit:** there is no UI for egress state/controls, no clawctl action surface, no skills manager, no memory manager, and no white-label configuration surface (branding is hard-coded).
