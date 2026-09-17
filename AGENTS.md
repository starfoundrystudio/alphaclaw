## Project Overview

### AlphaClaw Project Context

AlphaClaw is the ops and setup layer around OpenClaw. It provides a browser-based setup UI, gateway lifecycle management, watchdog recovery flows, and integrations (for example Telegram, Discord, Google Workspace, and webhooks) so users can operate OpenClaw without manual server intervention.

### Understanding OpenClaw

If you need to understand the internals of OpenClaw, look for a local `openclaw` checkout in nearby development directories and inspect its `src` directory when present. On this machine, the checkout is usually at `/Users/billk/Development/openclaw/src`.

### Architecture At A Glance

- `bin/alphaclaw.js`: CLI entrypoint and lifecycle command surface.
- `lib/server`: Express server, authenticated setup APIs, watchdog APIs, channel integrations, and proxying to the OpenClaw gateway.
- `lib/public`: Setup UI frontend (component-driven tabs and flows for providers, envars, watchdog, webhooks, and onboarding).
- `lib/setup`: Prompt hardening templates and setup-related assets injected into agent/system behavior.

Runtime model:

1. AlphaClaw server starts and manages OpenClaw as a child process.
2. Setup UI calls AlphaClaw APIs for configuration and operations.
3. AlphaClaw proxies gateway traffic and handles watchdog monitoring/repair.

### Key Technologies

- Node.js 24.15+ is the recommended runtime. The supported engine range is `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`.
- Express-based HTTP API server.
- `http-proxy` for gateway proxy behavior.
- OpenClaw CLI/gateway process orchestration.
- Preact + `htm` frontend patterns for Setup UI components.
- Vitest + Supertest for server and route testing.

## Coding Conventions

### Change Patterns

- Keep edits targeted and production-safe; favor small, reviewable changes.
- Preserve existing behavior unless the task explicitly requires behavior changes.
- Follow existing UI conventions and shared components for consistency.
- Reuse existing server route and state patterns before introducing new abstractions.
- Update tests when behavior changes in routes, watchdog flows, or setup state.
- Before running tests in a fresh checkout, run `npm install` so `vitest` (devDependency) is available for `npm test`.

### Code Structure

- Avoid monolithic implementation files for new features. For new UI areas and new API areas, start with a decomposed structure (focused components/hooks/utilities for UI; focused route modules/services/helpers for server) rather than building one large file first and splitting later.
- When adding a new feature area, follow the existing project patterns from day one (for example feature folders with `index.js` plus `use-*` hooks in UI, and route + service separation on server) so code stays maintainable as the feature grows.
- When continuing to build on a file that is growing large or accumulating unrelated concerns, stop and decompose it before adding more code rather than letting it drift into a monolith.

### Networking and Fetching

- Prefer the shared cache primitives in `lib/public/js/lib/api-cache.js` for backend reads:
  - `cachedFetch(...)` for imperative fetch paths.
  - `getCached(...)` / `setCached(...)` / `invalidateCache(...)` for cache lifecycle.
- For component-level read requests, prefer `useCachedFetch` from `lib/public/js/hooks/use-cached-fetch.js` over ad-hoc `useEffect(() => fetchX())` mount loads.
- Treat the API URL (including query params) as the canonical cache key for GET-style payloads.
- Keep cache in-memory for fast tab switches; do not add persistent storage caching unless explicitly required by product behavior.
- Do not keep route panes mounted via `display:none` just to preserve data. Prefer conditional rendering + cache-backed remounts.
- Use `usePolling` for recurring refreshes and always pass a stable `cacheKey` when poll results should hydrate remounts.
- Keep `pauseWhenHidden` behavior enabled for polling unless a specific flow requires background polling while the browser tab is hidden.
- Tune polling intervals conservatively; avoid 1-2s polling unless there is a clear real-time requirement.
- For app-shell status streams, prefer SSE (`/api/events/status`) where available and keep polling as fallback behavior.
- After write/mutation APIs (POST/PUT/DELETE), refresh or invalidate relevant cached keys so the UI does not show stale data.

### OpenClaw Config Access

- When reading `openclaw.json` in server code, use the shared helper in `lib/server/openclaw-config.js` (`readOpenclawConfig`) instead of ad-hoc `JSON.parse(fs.readFileSync(...))` blocks.

### Where To Put Agent Guidance

- **This file (`AGENTS.md`):** Project-level guidance for coding agents working on the AlphaClaw codebase — architecture, conventions, release flow, UI patterns, etc.
- **`lib/setup/core-prompts/AGENTS.md`:** Runtime prompt injected into the OpenClaw agent's system prompt. Only write there when the guidance is meant for the deployed agent's behavior, not for coding on this project.

## Operations

### OpenClaw Upgrade Reviews

When upgrading the pinned `openclaw` dependency, do not rely on release notes alone. AlphaClaw supervises the Gateway, writes and reconciles OpenClaw-owned state directly, brokers credentials through Agent Vault on a separate security-gateway VPS, and backs up only part of what OpenClaw persists. Every upgrade review must compare those touchpoints against the target release's code before recommending or implementing changes. The 2026.7.1 → 2026.9.4 assessment in `docs/openclaw-2026.9-upgrade/` is the worked example of this checklist; reuse its structure (change inventory → code deep-dives → severity-tiered impact matrix → decisions → plan).

Ground rules:

- Verify claims against the local `openclaw` checkout at both tags (`/Users/billk/Development/openclaw` on this machine; `git fetch --tags upstream` first). Release notes tell you where to look; the tree tells you what is true.
- Managed instances never self-update and Doctor may run lazily from the watchdog, so any upgrade step that upstream performs inside `openclaw update` must be made explicit in our runbook.
- Once databases migrate there is no downgrade; rollback means restoring a verified pre-upgrade backup with the matching package.
- Run gated, multi-phase assessments as a TeamYou project with human checkpoints; record decisions in the impact matrix so later sessions do not re-litigate them.

Required review checklist:

1. **Scope and sources.** Read the curated notes (Highlights/Changes/Fixes, not the PR lists) for every stable tag between the pins, including correction releases (`YYYY.M.N-k`) and the Fixes sections. Check whether the current pin has an `extended-stable` line. Pull the upstream docs the notes link to (rollback and recovery, database schemas, Node requirements, plugin SDK migration, restart and supervision).
2. **Host prerequisites.** Diff `package.json` engines at both tags. Update every place the old range is encoded: AlphaClaw `package.json` engines, `lib/runtime/node-sqlite-safety.js`, and clawctl `assets/host/lib/node-runtime.sh` (also its `NODE_MAJOR` default). Verify the exact Node and SQLite versions on the fleet before the OpenClaw bump; Node upgrades first.
3. **Persistence contract.** Diff `CREATE TABLE` statements under `src/` and the `OPENCLAW_AGENT_SCHEMA_VERSION` / `OPENCLAW_STATE_SCHEMA_VERSION` constants. Read the legacy-state migration layout in `src/infra/state-migrations.doctor.ts` and record which steps run automatically at Gateway start and which are Doctor-only. Find ownership markers in `config_machine_state` (for example `auth.sharedStore`) that relocate stores. Then audit every AlphaClaw direct SQLite read or write (`lib/server/auth-profiles.js`, `lib/cli/openclaw-doctor-oauth-guard.js`, `lib/cli/openclaw-startup-state-repair/*`, `scripts/prepare-openclaw-migration.sh`) and every legacy JSON file AlphaClaw still touches (`sessions/sessions.json`, `*.jsonl`, `devices/*.json`, `identity/*.json`, `credentials/*-pairing.json`, `exec-approvals.json`, `plugins/installs.json`, `cron/jobs.json`). Rule: AlphaClaw must not create OpenClaw databases or write OpenClaw-owned tables without resolving the store location the way OpenClaw does; prefer the CLI, Gateway RPC, or a `openclaw/plugin-sdk/*` store function.
4. **Config contract.** Extract the retired-key rules from `src/commands/doctor/shared/legacy-config-migrations*.ts` and check every key AlphaClaw writes against `src/config/schema.labels.ts` at the new tag. Writers to audit: `lib/server/onboarding/openclaw.js`, `lib/server/gateway.js`, `lib/server/auth-profiles.js`, `lib/server/agents/*`, `lib/server/webhooks.js`, `lib/server/gmail-watch.js`, `lib/server/telegram-workspace.js`, `lib/server/exec-defaults-config.js`, `lib/server/usage-tracker-config.js`, `lib/server/agent-vault/service.js`, `lib/cli/alphaclaw-migrations.js`. Note raw writers that bypass `lib/server/openclaw-config.js` (they register as manual edits in the config audit). Confirm the roster shape (`agents.entries` vs `agents.list`), `gateway.mode`, and `hooks.internal.entries` survive. Run `openclaw doctor --lint --all` against a copied production config on the new version and treat warnings as findings.
5. **Auth, credentials, and Agent Vault.** Confirm the shared auth store location and table names, profile ids (`openai:codex-cli`, `anthropic:claude-cli`), auth order, and how Doctor treats the OAuth broker placeholders and the expiry-shield in the doctor guard against the new refresh locks and generation checks. For the vault: the env keys in `lib/server/agent-vault/runtime-store.js` must still be honoured (`OPENCLAW_PROXY_URL`, `proxy.enabled`, `proxy.loopbackMode` default), the provider host map in `model-provider-services.js` must match the new provider registry and any split-out provider plugins, placeholder-shaped values must not be rejected by credential validation, `secrets.egressProxy.enabled` stays `false` and the agent `secrets` tool stays denied (mutually exclusive with the vault), and the placeholder sweep must not delete Doctor's retained originals.
6. **Supervision and the dual-VPS topology.** Re-read `docs/cli/gateway/restart-and-supervision.md` for `OPENCLAW_SUPERVISOR_MODE=external` semantics, the restart-handoff contract, and readiness endpoints (`/startupz`, `/readyz`, `/healthz`). Confirm the env var and `OPENCLAW_SERVICE_REPAIR_POLICY=external` reach all three spawn families (Gateway child in `lib/server/gateway.js`, server-side `clawCmd`/`gatewayEnv()`, and the CLI passthrough in `bin/alphaclaw.js`, plus the bespoke envs in `auth-profiles.js` and `scripts/generate-model-catalog-bootstrap.mjs`). Re-verify the log strings and exit codes the supervisor parses (readiness line, startup-migration lock message, exit 78). On the network side, confirm the Gateway's own outbound path still goes through the vault proxy under enforced egress and that any new upstream proxy or direct-dial path is accounted for.
7. **Backup, restore, and migration snapshots.** Compare upstream's recovery-point definition (package + `openclaw.json` + `state/openclaw.sqlite` + every agent DB + workspaces/credentials, WAL-consistent) with what the git backup, `lib/cli/openclaw-config-restore.js`, and `scripts/prepare-openclaw-migration.sh` actually cover. Decide whether `openclaw backup create --verify` / `openclaw backup sqlite` become the managed primitive, and keep the TeamYou offboarding-archive project aligned.
8. **Models and catalogs.** Diff `scripts/lib/official-external-{channel,plugin,provider}-catalog.json` (membership and `kind` changes) and regenerate `lib/openclaw-compatibility.manifest.json`; fix consumers that key on provider ids. Check plugin capability-consent flags (`--accept-capabilities`) for managed installs. Verify `openclaw models list --json` behaviour with and without a running Gateway (the bootstrap generator runs without one), the row shape, thinking-level exports scanned by `lib/server/openclaw-thinking.js`, the pricing source scraped by `lib/server/cost-utils.js`, hardcoded model keys in `lib/public/js/lib/model-config.js` and `lib/server/constants.js`, and where `agentRuntime` and model allowlists now live.
9. **Onboarding and the bootstrap ritual.** Diff `src/cli/program/register.onboard.ts` options against the args built in `lib/server/onboarding/openclaw.js` (flow, auth-choice ids, how API keys are delivered, gateway flags, `--json`). Diff `docs/reference/templates/BOOTSTRAP.md` and the workspace seed set against `patchSeededBootstrapConnectStep`, `bootstrap-kickoff.js`, and the ritual-completion heuristics in `teamyou-memory-activation.js`. Confirm `main` remains the agent id and session key convention.
10. **Gateway protocol, CLI shapes, and Control UI.** Check `packages/gateway-protocol` version constants against `kGatewayProtocolVersion` in `lib/server/chat-ws.js`, plus additive `hello-ok` fields. Re-validate every CLI command and flag AlphaClaw shells out to (list in `docs/openclaw-2026.9-upgrade/A1-alphaclaw-openclaw-touchpoints.md` §0.4) and every JSON shape it parses (`plugins list`, `models list`, `update status`, `sessions --json --all-agents`, `pairing list`, `nodes status`, `gateway call agent`). Re-check exact strings matched in chat and watchdog code (restart-recovery note, benign stderr lines). Inventory `ui/src/pages/` at both tags to refresh the Clawbridge vs Control UI audit.
11. **Plugins and the SDK.** Verify every `openclaw/plugin-sdk/*` and `openclaw/cli-entry` subpath AlphaClaw or `@teamyou/openclaw-memory` imports still appears in the openclaw `package.json` exports, and that the hook names and `registerTool` contract used by `lib/plugin/usage-tracker` and `lib/plugin/agent-vault` are unchanged. Read the SDK deprecation gates in the notes.
12. **Managed defaults.** List every upstream default that changed (search the notes for "by default") and compare with the pinned managed defaults recorded in the current impact matrix (§K). Any new default-on feature that spends model tokens, spawns agents, or exposes a new surface gets an explicit pin decision.
13. **Tests and version strings.** Run `tests/server/openclaw-thinking.test.js` and `tests/server/model-catalog-bootstrap.test.js` first after installing the new package (they are the canaries). Update tests that pin old output shapes and every hardcoded version string (`lib/openclaw-compatibility.manifest.json`, `lib/server/model-catalog-bootstrap.json`, `lib/setup/gitignore`, version-specific comments).
14. **Empirical migration test (mandatory before any release).** On a disposable host: copy a production-shaped state dir, install the target version, boot the Gateway under our supervisor and record which migrations ran at startup, stop it, run `openclaw doctor --non-interactive --fix`, diff `migration_runs`/`migration_sources`, then exercise chat, a model call through the vault, a channel login, a cron run, a pairing approval, a backup, and a restart. Only then write the plan.
15. **Deliverables.** Before code changes: the change inventory, code deep-dives, the severity-tiered impact matrix (S0 blocks boot/upgrade, S1 breaks a feature or corrupts state, S2 degraded, S3 hygiene), the decisions log, and the sequenced plan with its test plan and deliberately deferred follow-ups.

### Release Flow (Beta -> Production)

Use this release flow when promoting tested beta builds to production:

1. Ensure `main` is clean and synced, and tests pass.
2. Regenerate the AlphaClaw-managed OpenClaw compatibility manifest whenever the AlphaClaw version or pinned `openclaw` dependency changes:
   - `npm run generate:openclaw-compatibility-manifest`
   - Confirm `lib/openclaw-compatibility.manifest.json` includes every entry from OpenClaw's official external channel, plugin, and provider catalogs, and that reconciler behavior stays config-aware rather than installing every catalog entry unconditionally.
   - The GitHub package publish job also runs this through `prepack`, but release commits should keep the generated manifest in sync before tagging.
3. Publish beta iterations as needed:
   - Bump the explicit Starfoundry prerelease version (for example `0.9.15-starfoundry.0-beta.1`). Do not use `npm version prerelease --preid=beta` if it would drop the `starfoundry` prerelease segment.
   - Regenerate the compatibility manifest so `alphaclawVersion` matches the release version.
   - Commit the version/manifest update, tag it as `v<version>`, then push `main` and the tag.
   - GitHub Actions publishes the GitHub Package on `v*` tag pushes; beta tags containing `-beta.` publish with the `beta` dist-tag.
4. When ready for production, publish a stable release version (for example `0.3.2`):
   - Bump the stable version, regenerate the compatibility manifest, run tests, commit, tag `v<version>`, and push `main` plus the tag.
   - GitHub Actions publishes stable tags without `-beta.` using the default package dist-tag.
5. Optionally keep beta branch/tag flows active for next release cycle.

### Release Execution Efficiency

Keep release work single-pass and use the repository's existing scripts instead of rebuilding the workflow interactively:

- After bumping the version, prefer one `npm run prepack` invocation as the canonical release-artifact build. It already regenerates the OpenClaw compatibility manifest, regenerates the model catalog bootstrap, and builds the UI. Do not run those commands individually first unless diagnosing a failure or intentionally updating only one artifact.
- Do not invoke `prepack` a second time through `npm pack` merely to verify packaging. When a package-shape check is useful after a successful `prepack`, use `npm pack --dry-run --ignore-scripts`.
- Do not rerun a successful install, generator, build, test, or package check unless the working tree changed in a way that can affect its result.
- Run browser verification only when the release contains non-trivial UI changes. In Codex desktop, use the built-in in-app browser directly; do not try the standalone `agent-browser` CLI first. Skip browser verification for server-only or metadata-only releases.
- For release status and workflow checks, address `starfoundrystudio/alphaclaw` explicitly (for example, `gh run ... -R starfoundrystudio/alphaclaw`) so GitHub CLI does not select the wrong repository if the checkout carries extra remotes.
- After pushing the tag, monitor the single package-publish workflow through completion and verify the intended package dist-tag. Avoid repeated repository discovery or redundant workflow queries.
- Keep successful validation output concise; inspect and report detailed logs only when a check fails or emits an actionable warning.

### Runtime Dependency Guardrails

AlphaClaw provisioning uses native clawctl-managed Linux hosts and systemd. Dockerfiles, Compose deployments, and container lifecycle shims are unsupported and must not be introduced.

AlphaClaw expects Express 4 semantics in its setup API layer. Keep the installed dependency tree consistent with the host application's `package.json`; copy-over or partial installs can hoist an incompatible Express major to the app root.

Verify runtime resolution after dependency or provisioning changes:

- `node -p "require('express/package.json').version"` should be `4.x`.
- `npm ls express` should show `@starfoundrystudio/alphaclaw` on `express@4.x` (OpenClaw can still carry its own `express@5` subtree).

### Telegram Notice Format (AlphaClaw)

Use this format for any Telegram notices sent from AlphaClaw services (watchdog, system alerts, repair notices):

1. Header line (Markdown): `🐺 *AlphaClaw Watchdog*`
2. Headline line (simple, no `Status:` prefix):
   - `🔴 Crash loop detected`
   - `🔴 Crash loop detected, auto-repairing...`
   - `🟡 Auto-repair started, awaiting health check`
   - `🟢 Auto-repair complete, gateway healthy`
   - `🟢 Gateway healthy again`
   - `🔴 Auto-repair failed`
3. Append a markdown link to the headline when URL is available:
   - `... - [View logs](<full-url>/#/watchdog)`
4. Optional context lines like `Trigger: ...`, `Attempt count: ...`
5. For values with underscores or special characters (for example `crash_loop`), wrap the value in backticks:
   - `Trigger: \`crash_loop\``
6. Do not use HTML tags (`<b>`, `<a href>`) for Telegram watchdog notices.

## UI Conventions

Use these conventions for all UI work under `lib/public/js` and `lib/public/css`.

### Setup UI bundle (esbuild)

- The browser loads the compiled bundle under `lib/public/dist/` (for example `app.bundle.js` and chunk files), produced by `scripts/build-ui.mjs` (esbuild).
- **After any UI source change** that should ship in production (`lib/public/js`, `lib/public/css`, or other inputs to the build), run **`npm run build:ui`** so `lib/public/dist/` stays in sync. Verify the app in the browser against the rebuilt bundle when the change is non-trivial.
- **`npm publish`** runs **`prepack`** → **`npm run generate:openclaw-compatibility-manifest && npm run generate:model-catalog-bootstrap && npm run build:ui`**, so published packages always include fresh generated release artifacts and the UI bundle. Local installs or commits that include `dist/` still require **`npm run build:ui`** when you change UI sources and expect the built assets to match.

### Component structure

- Use arrow-function components and helpers.
- Prefer shared components over one-off markup when a pattern already exists.
- Keep constants in `kName` format (e.g. `kUiTabs`, `kGroupOrder`, `kNamePattern`).
- Keep component-level helpers near the top of the file, before the main export.
- Treat `index.js` as a presentational shell whenever possible: keep business logic in hooks and pass derived state/actions down as props.
- Add reusable SVG icons to `lib/public/js/components/icons.js` and import them from there; avoid introducing one-off inline SVGs in feature files when a shared icon component can be used.

### Rendering and composition

- Use the `htm` + `preact` pattern:
  - `const html = htm.bind(h);`
  - return `html\`...\``
- In `htm` templates, be explicit with inline spacing around styled inline tags (`<span>`, `<code>`, `<a>`): use ` ${" "}` where needed, and verify rendered copy so words never collapse (`eventsand`) or gain double spaces.
- Prefer early return for hidden states (e.g. `if (!visible) return null;`).
- Use `<PageHeader />` for tab/page headers that need a title and right-side actions.
- Use card shells consistently: `bg-surface border border-border rounded-xl`.
- For nested "surface on surface" blocks (content inside a `bg-surface` card), use `ac-surface-inset` for the inner container treatment so inset sections match shared history/sessions styling.
- For internal section dividers, use `border-t border-border` (avoid opacity variants) with comfortable vertical spacing around the divider.

### Color and theme tokens

- Prefer semantic Tailwind color utilities backed by theme tokens (`text-body`, `text-fg-muted`, `text-fg-dim`, `bg-field`, `bg-status-error-bg`, `border-status-warning-border`) instead of raw palette classes like `text-gray-300` or `bg-red-900/30`.
- When a new reusable UI color role is needed, add the CSS variable in `lib/public/css/theme.css` and expose it through `tailwind.config.cjs` rather than introducing one-off hardcoded color classes in components.
- Keep component refactors token-based so future theme changes stay centralized in the token layer instead of requiring per-component color rewrites.

### Buttons

- Primary actions: `ac-btn-cyan`
- Secondary actions: `ac-btn-secondary`
- Positive/success actions: `ac-btn-green`
- Ghost/text actions: `ac-btn-ghost` (use for low-emphasis actions like "Disconnect" or "Add provider")
- Destructive inline actions: `ac-btn-danger`
- Use consistent disabled treatment: `opacity-50 cursor-not-allowed`.
- Keep action sizing consistent (`text-xs px-3 py-1.5 rounded-lg` for compact controls unless there is a clear reason otherwise).
- For `<PageHeader />` actions, use `ac-btn-cyan` (primary) or `ac-btn-secondary` (secondary) by default; avoid ghost/text-only styling for main header actions.
- Prefer shared action components when available (`ActionButton`, `UpdateActionButton`, `ConfirmDialog`) before custom button logic.
- In setup/onboarding auth flows (e.g. Codex OAuth), prefer `<ActionButton />` over raw `<button>` for consistency in tone, sizing, and loading behavior.
- In setup wizard/multi-step modal footers, use `<ActionButton />` for Back/Next/Finish/Done actions (not raw `<button>`), so loading and tone behavior stays consistent.
- In multi-step auth flows, keep the active "finish" action visually primary and demote the "start/restart" action to secondary once the flow has started.

### Dialogs and modals

- Use `<ConfirmDialog />` for destructive/confirmation flows.
- Use `<ModalShell />` for non-confirm custom modals that need shared overlay and Escape handling.
- Modal overlay convention:
  - `fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50`
- Modal panel convention:
  - `bg-modal border border-border rounded-xl p-5 ...`
- Support close-on-overlay click and Escape key for dialogs.

### Inputs and forms

- Reuse `<SecretInput />` for sensitive values and token/key inputs.
- Reuse `<ToggleSwitch />` for boolean on/off controls instead of ad-hoc checkbox/switch markup.
- Base input look should remain consistent:
  - `bg-field border border-border rounded-lg ... focus:border-fg-muted`
- Preserve monospace for technical values (`font-mono`) and codes/paths.
- Prefer inline helper text under fields (`text-xs text-fg-muted` / `text-fg-dim`) for setup guidance.
- For tip/help links in helper text, use the shared `ac-tip-link` class (token-backed via `--accent-link`) instead of per-file ad-hoc cyan classes.

### Feedback and state

- Use `showToast(...)` for user-visible operation outcomes.
- Prefer semantic toast levels (`success`, `error`, `warning`, `info`) at callsites. Legacy color aliases are only for backwards compatibility.
- Keep toast positioning relative to the active page container (not the viewport) when layout banners can shift content.
- For hover help and icon labels, use the shared portal-backed tooltip components (`Tooltip`, `InfoTooltip`) instead of inline absolutely positioned popovers, so tooltips are not clipped by cards, rows, or scroll containers.
- Keep loading/saving flags explicit in state (`saving`, `creating`, `restartingGateway`, etc.).
- Reuse `<LoadingSpinner />` for loading indicators instead of inline spinner SVG markup.
- Use `<Badge />` for compact status chips (e.g. connected/not connected) instead of one-off status span styling.
- Use polling via `usePolling` for frequently refreshed backend-backed data.
- For restart-required flows, render the standardized yellow restart banner style used in `providers`, `envars`, and `webhooks`.

### Shared formatting utilities

- Prefer shared formatter helpers in `lib/public/js/lib/format.js` for reusable value formatting (`formatX` style helpers such as date/time, currency, integers, and common duration formats).
- Before adding a new formatter in a component, check `lib/public/js/lib/format.js` and reuse an existing helper when possible.
- Add new formatter helpers to `lib/public/js/lib/format.js` when the behavior is cross-feature and likely to be reused; keep feature-specific transforms local to the feature folder.
- Avoid wrapper pass-through helpers that only rename a global formatter without adding feature-specific behavior.

### Session key utilities

- Keep shared session-key parsing/filtering helpers in `lib/public/js/lib/session-keys.js` (for example extracting `agentId`, destination-session matching checks, and destination payload derivation).
- Before adding session-key logic in a hook/component, check `lib/public/js/lib/session-keys.js` first and reuse existing helpers.
- When session-key behavior is reused across features, add/extend helpers in `lib/public/js/lib/session-keys.js` instead of duplicating regex/string parsing in feature files.

### localStorage keys

- All standalone `localStorage` keys are defined in `lib/public/js/lib/storage-keys.js`. Import keys from this file — never define raw localStorage key strings inline in components.
- Use the naming convention `alphaclaw.<area>.<purpose>` for new keys (e.g. `alphaclaw.doctor.lastSessionKey`).
- Keys that live inside the `alphaclaw.ui.settings` JSON blob (e.g. `browseLastPath`, `doctorWarningDismissedUntilMs`) are sub-keys, not standalone localStorage entries — those stay in their consuming file.
