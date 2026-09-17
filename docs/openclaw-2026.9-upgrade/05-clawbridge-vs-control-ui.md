# Clawbridge vs the OpenClaw 2.0 Control UI (Phase 5)

> **Decision-history note (2026-09-17):** the daily-Control-UI-shell and
> hosted-Clawbridge-section direction in §§4–6 has been superseded by §8.
> It remains here to preserve the evidence and reasoning that led to the
> revised managed-experience decision.

Status: **historical analysis; Checkpoint 2 closed 2026-09-16 and the original
direction was superseded 2026-09-17 by §8.** Inputs:
[`A2-clawbridge-feature-inventory.md`](A2-clawbridge-feature-inventory.md)
(what Clawbridge does today, file by file) and
[`A3-control-ui-9.4-audit.md`](A3-control-ui-9.4-audit.md) (what the
Control UI does at `v2026.9.4`, page by page, with RPCs and scopes). Every
claim below is backed by one of those two documents or by the upstream docs
cited inline.

## 1. The question

Clawbridge began as the only usable operator surface for OpenClaw. Between
2026.7.1 and 2026.9.4 the Control UI became a full product: ~3,400 files
changed, twenty new page directories, per-person identity and operator roles,
a plugin workspace, schema-driven config editing, memory and skills UIs, a
scoped terminal, and a plugin extension model. The question is no longer
"which UI is better" but "which of Clawbridge's surfaces still earn their
maintenance cost, and how should the two products hand off to each other".

## 2. What the audit found

### 2.1 Surfaces where the Control UI now clearly wins

Chat, sessions, agents, models and providers, cron authoring, usage
analytics, devices and nodes, channel breadth, logs and debug, config
editing, secrets store, terminal, updates, memory, plugins and skills,
identity and roles. For each of these Clawbridge is a thinner wrapper over the
same Gateway RPCs, and in several cases a *stale* one (the tool catalog is a
static mirror; the chat hides a restart-recovery note by exact text that
changed at 9.4; the cron tab pins 7.1 RPC shapes). Detail in A3 §6 and §8.

### 2.2 Surfaces where Clawbridge has no Control UI equivalent

| Clawbridge capability | Control UI 9.4 | Why it exists |
| --- | --- | --- |
| Onboarding and import wizard (provider auth, GitHub repo, secret/placeholder review, Tailscale finalization, runtime-readiness handoff) | Custodian guided setup covers model/channel setup; no install-import flow with secret review | Runs before the Gateway exists; managed-provisioning specific |
| Watchdog: crash-loop detection, auto-repair, incident log, notifications, host resource bars | Gateway-internal crash breaker and triage; no operator page | Supervisor-side by definition (D1) |
| Host and gateway-VPS operations (systemd, sudo finalize wrapper, security-gateway SSH channel, sealing) | None | Out of OpenClaw's scope |
| Agent Vault: status, brokered credentials, service allowlist, proposals, TeamYou console handoff | Local SecretRef store only; no brokering, no approval workflow | Strategic differentiator (I1/I2) |
| GitHub backup sync with schedule, commit/push, restore-from-git | None (CLI `openclaw backup` only) | **Being removed from Clawbridge** (decision 2026-09-14): backups move to provider snapshots, Backblaze, and a workspace export; restore is initiated from a logged-in teamyou.com account, never from the instance, because the OpenClaw VPS must not hold restore credentials. |
| Named webhooks with transforms, request history, OAuth-callback shims | Raw `hooks.mappings` config section | Clawbridge-only |
| Drift Doctor | None | Clawbridge-only |
| File browser with git diff/restore, SQLite viewer, tree management | Session-scoped Files + Review editor (overwrite only, 256 KiB) | Clawbridge-only |
| Google Workspace / gog / Gmail watch / Composio | None | Clawbridge-only |
| Telegram topic workspace | None | Clawbridge-only |
| Usage joined to cron runs; usage store that survives session deletion | Session-derived usage only | Clawbridge-only |
| OpenAI-compatible `/v1` toggle with copy-URL | Capability exists, disabled by default, no UI | UX only |
| Restart-required banner and state machine | `gateway.restart.request` exists; no restart-required tracking | UX only |

### 2.3 Branding and white-label

Neither product is white-labellable by configuration. The Control UI
hard-codes "OpenClaw Control", the favicon, the About page links, and the
title suffix; config offers only an environment label and colour stripe
(`gateway.controlUi.environment`), assistant name/avatar, theme/accent/font
defaults, sidebar order, and hiding the Discord invite. Clawbridge's branding
is likewise hard-coded in `theme.css`, `logo.svg`, and ~40 string literals,
but it is *our* fork, so it is brandable at will. A white-labelled Control UI
means maintaining a rebuilt `ui/` bundle behind `gateway.controlUi.root`,
which at upstream's change rate is not viable.

### 2.4 Two hard architectural facts

1. **The Control UI cannot be embedded.** Its CSP sets `frame-ancestors
   'none'` unconditionally. Clawbridge-inside-Control-UI is possible (plugin
   tabs, native feature plugins); Control-UI-inside-Clawbridge is not. The
   only handoffs are same-origin navigation or a new tab, which is what the
   launcher does today.
2. **A shared setup password cannot produce per-person identity.** Everything
   behind `/openclaw` today is one credential and one profile. Operator roles
   (`gateway.roles`) require a verified identity and, once configured,
   reject the device-token path the launcher relies on. Upstream's design for
   a fronting proxy is `gateway.auth.mode: "trusted-proxy"` with
   `allowLoopback`, `userHeader`, `identityScopes`, and `deviceAutoApprove`,
   which would remove the pairing dance and give per-person scopes, but only
   if Clawbridge itself authenticates people individually.

### 2.5 The extension path

Feature plugins (Labs `gateway.controlUi.experimental.customPlugins`, off by
default, Gateway restart to toggle) can register pages, sidebar entries,
session panels, header accessories, composer/header/session actions,
dashboard widgets, and replacements for the workspace, session list,
composer, transcript, and tool-result views. Backend operations are declared
once and run inside the Gateway process over the plugin session-action
transport (`operator.read` queries, `operator.write` actions), can double as
agent tools and slash commands, and must be served from the Gateway origin
over HTTPS or loopback under an 8 MiB per-plugin cap. Native plugin code runs
with the operator's full authority; it is not sandboxed. Gateway-authenticated
iframe tabs are the isolated alternative for existing HTTP UIs.

## 3. Options

**A. Keep investing in Clawbridge as the primary surface.** Continue
maintaining the wrapper screens and add the features the Control UI now has.
Cost: perpetual catch-up against a UI that changed ~3,400 files in one
release cycle, with our wrappers already drifting at 7.1. Benefit: full
branding control and one login. Not recommended.

**B. Steer customers to the Control UI for everything and shrink Clawbridge to
a setup tool.** Cost: loses the ops surfaces (watchdog, vault, backup,
webhooks, Google, Drift Doctor) until they are rebuilt as feature plugins,
which requires the Labs flag, a Gateway restart, and re-expressing every
Express route as a Gateway plugin operation. It also means the Gateway hosts
the UI that restarts the Gateway. Premature.

**C. Split by responsibility (recommended).** Clawbridge becomes the
*Clawbridge-branded operator shell*: onboarding, host and Gateway supervision,
Agent Vault, webhooks, Google/Composio, Telegram workspace, Drift Doctor,
file browser, and a first-class, dance-free handoff
into the Control UI for everything agent-facing. Clawbridge stops maintaining
its own chat, sessions, agents, models, cron, nodes, and terminal screens
once the handoff is seamless, redirecting those tabs to the corresponding
Control UI routes. Feature plugins are evaluated *after* the upgrade as the
vehicle to bring vault, webhooks, and Drift Doctor inside the Control UI, not
as a precondition.

## 4. Direction (Option C, refined 2026-09-16 — DECIDED in principle)

Bill's decision (2026-09-16): use the Control UI as the daily shell and host
Clawbridge sections inside it; the exact set and naming of sections is
**open**. The mechanism must be proven first (see §4.4).

**Superseded 2026-09-17.** Hands-on evaluation showed that even a technically
successful hosted-section approach leaves customers navigating two competing
management models and exposes a powerful upstream surface whose concepts and
changes TeamYou does not fully control. See §8 for the replacement decision.

### 4.1 Principles

- **Split by trust boundary, not by feature.** Anything that touches the
  host, the gateway VPS, or credential custody lives in Clawbridge; anything
  that is a conversation with the agent or its runtime lives in the Control
  UI. Channels straddle the line: the wizard is upstream's, custody is ours,
  and the strict config-position sweep (matrix I5) reconciles the two.
- **One concept, one home.** Each noun appears in exactly one sidebar entry.
  Upstream pages that would compete with Clawbridge sections are disabled or
  made read-only by managed config (Secrets store, egress proxy, terminal,
  CLI agents, updates via supervisor mode, config writes via
  `OPENCLAW_CONFIG_READONLY=1`, matrix I6).
- **Clawbridge must work when the Gateway is down.** Standalone Clawbridge
  remains the first-run and recovery surface (onboarding, watchdog, restart,
  Doctor, re-onboarding). Daily use happens inside the Control UI.
- **One door, one session.** Customers sign in at Clawbridge and land in the
  Control UI already authenticated via trusted-proxy identity; hosted sections
  reuse the Clawbridge cookie session because they are same-origin.

### 4.2 Hosting mechanism — VERIFIED by spike 2026-09-16 (see [`S1-hosting-spike.md`](S1-hosting-spike.md))

The Control UI already renders plugin-declared sidebar tabs
(`surface: "tab"` descriptors advertised in `hello-ok.controlUiTabs`) in an
iframe whose `path` is a plugin HTTP route on the Gateway. Because the
Gateway is served under Clawbridge's origin at `/openclaw`, that frame is
same-origin with Clawbridge, so a small managed plugin can expose routes that
load Clawbridge screens in a chromeless embed mode with the existing cookie
session. Requirements: `gateway.controlUi.embedSandbox: "trusted"` (the
default `scripts` mode blocks cookies), a Clawbridge `embed` render mode that
hides shell chrome and login redirects, tab `slug`s for deep links, and
`requiredScopes` so read-only identities do not see them. Fallback if the
sandboxed path misbehaves: a feature-plugin native page (`registerPage` +
`registerNavigation`) under the Labs custom-plugin flag, which we control on
managed instances. Clawbridge does not forbid framing (only `/pages/*` sets
`frame-ancestors 'none'`).

### 4.3 Candidate sections (naming and grouping OPEN)

Working set, to be refined after the spike and a pass over what customers
actually use:

| Candidate | Contents |
| --- | --- |
| Models & keys (or "Credentials") | Model/provider configuration (primary and per-route models, thinking levels, provider auth incl. Codex OAuth and Claude CLI login), Agent Vault status, brokered credentials, allowed services, pending proposals, migrate banners, vault console link. **Why here:** with `OPENCLAW_CONFIG_READONLY=1` (I6) the Control UI's Model Setup and provider pages cannot persist config (refused with upstream's externally-managed message); per-session model picks still work. Bill (2026-09-16): the Control UI model-configuration experience is weaker than Clawbridge's and cannot be hidden. |
| Integrations | Channel setup wizards (Telegram/Discord/Slack with pre-save validation and Slack manifest — Bill 2026-09-16: still better than the Control UI's, which is clunky and whose config writes are refused under I6), Google Workspace / Gmail watch, Composio, named webhooks with transforms and request history, OpenAI-compatible endpoint toggle, Telegram topic workspace |
| Instance (or "Health", "System") | Gateway health and restart, watchdog state and incidents, host resources, Drift Doctor findings, version and managed-update status |
| Files (undecided) | Browse/edit with git diff and SQLite viewer — hold until the Control UI's Review editor is assessed against real usage |

Not hosted: chat, agents, cron, nodes/devices, sessions, terminal, env vars
as a standalone screen (folds into Models & keys / Integrations), and backups
(out of scope, restore originates from teamyou.com).

### 4.4 Sequencing

1. **Spike — DONE 2026-09-16, passed** (local rig, no AlphaClaw needed): set
   `embedSandbox: "trusted"`, register one tab pointing at a plugin route that
   loads the Clawbridge credentials screen in embed mode; confirm cookies and
   the WebSocket to Clawbridge work inside the frame, deep links via slug
   work, and the tab hides for a read-scoped identity. If it fails, repeat
   with a feature-plugin page under the Labs flag.
2. **With the upgrade release:** `basePath: "/openclaw"`, `allowedOrigins`,
   environment label, community invite off; trusted-proxy handoff replacing
   device pairing; `gateway.terminal.enabled: false`; freeze Clawbridge
   wrapper screens (agents, cron, nodes, sessions, terminal — **models removed
   from the freeze list 2026-09-16**, it stays active and becomes a hosted section) with
   "Open in OpenClaw" links; keep Clawbridge chat until the bootstrap ritual
   is re-evaluated on 9.4 (matrix H4); ship the hosted sections if the spike
   passed, otherwise ship the handoff alone.
3. **After the upgrade:** retire frozen screens one by one; decide the final
   section set; evaluate a native feature plugin for Agent Vault once the
   Labs API stabilises.

## 5. Risks

- **Trusted-proxy correctness.** Loopback bind, host firewall,
  `requiredHeaders`, and Clawbridge stripping client-supplied identity
  headers are the mitigations; dedicated security review in Phase 6.
- **Sandbox `trusted` mode** widens what any plugin tab can do in the Control
  UI origin; acceptable only because managed instances control the plugin
  set (deny-list, single enablement writer).
- **Upstream churn** in the plugin-tab contract and the Control UI page set;
  the hosted sections are thin iframes precisely to minimise coupling.
- **Branding ceiling.** Daily use is inside an OpenClaw-branded shell with a
  Clawbridge heading, environment label, and accent; accepted.
- **Roles later** require per-person Clawbridge logins; single owner profile
  is fine for the single-user product today.

## 6. Checkpoint 2 status

1. Control UI as daily shell with hosted Clawbridge sections — **decided in
   principle 2026-09-16**; section set and names open pending the spike.
2. Trusted-proxy handoff replacing device pairing — **decided 2026-09-16**.
3. `gateway.terminal.enabled: false` on managed instances — **decided 2026-09-16**. Rationale that still holds: the PTY inherits the Gateway env (vault runtime token, proxy credentials), duplicates Clawbridge's watchdog terminal, and can be driven by the agent's `terminal` tool. Follow-up (Phase 6 test plan): verify whether `OPENCLAW_CHILD_ENV_REMOVE` or a Gateway-side env scrub keeps vault credentials out of terminal children; if so, enable the Control UI terminal and retire Clawbridge's watchdog terminal so exactly one shell remains.
4. Freeze list for Clawbridge wrapper screens (agents, cron, nodes, sessions, terminal: bug fixes only, "Open in OpenClaw" links), Chat retained until the bootstrap ritual is re-evaluated on 9.4 — **decided 2026-09-16**; **models removed from the freeze list later the same day** after Bill's fresh-install walkthrough (Control UI model configuration is weaker, cannot be hidden, and its config writes are refused under I6).
5. Agent Vault feature-plugin prototype — **kept as an unscheduled post-upgrade follow-up (2026-09-16)**; its value depends on the hosting spike outcome.

**Checkpoint 2 closed 2026-09-16.**

## 7. Observations from Bill's fresh 9.4 install (2026-09-16)

- Bootstrap ritual is incremental and follows the rewritten `BOOTSTRAP.md` (asks what to call the agent first; name/timezone were inferred from the local Codex identity, which managed instances will not have). Confirms matrix H4.
- Channel setup wizards in the Control UI are clunky compared with Clawbridge's; Clawbridge keeps channel setup (never on the freeze list).
- Model configuration in the Control UI is reachable and cannot be hidden; the experience is weaker than Clawbridge's. Handled by I6 (config writes refused) plus keeping Clawbridge's models screen active as a hosted section.

## 8. Superseding managed-experience decision (2026-09-17 — APPROVED)

The architectural spike proved that Clawbridge sections *can* be hosted in
the Control UI. It did not prove that this is the right customer experience.
Trying to make the Control UI both the daily shell and an advanced upstream
console creates ambiguous ownership, two overlapping vocabularies, and a
larger support and security surface. The new direction is:

1. **Clawbridge is the supported managed interface.** It owns onboarding,
   host/Gateway supervision, Agent Vault, channel policy, agent configuration,
   and the workflows TeamYou promises to customers. It expands selectively
   for those workflows rather than chasing complete Control UI parity.
2. **The Control UI is optional advanced access, not the daily shell.** Do not
   host Clawbridge sections inside it. Keep access only behind an
   authenticated TeamYou-branded interstitial, signed session-scoped
   acknowledgement, audit trail, complete HTTP/WebSocket/deep-link gating, no
   direct Gateway bypass, and a persistent amber **Advanced — unmanaged
   changes** label.
3. **Read-only remains the launch boundary.** Preserve
   `OPENCLAW_CONFIG_READONLY=1`; prefer scope-capped read-only operator access
   when it can be added without delaying the upgrade. A warning alone is not
   a security control, and any future timed write/admin elevation needs an
   explicit design, config diff, and restore-to-managed-baseline path.
4. **The agent follows a managed-capability contract.** Runtime prompts,
   tools, config, Clawbridge UI, and tests are versioned together so the agent
   never directs a customer to a Control-UI-only operation. Unsupported
   functionality is disabled where possible and described as TeamYou-managed
   where it cannot be hidden.
5. **TeamYou is the customer-facing brand.** The internal company name does
   not appear in product copy. TeamYou is also the likely long-term home for
   shared artifacts that outgrow instance-local Pages, but that migration is
   not required for this upgrade.

The interstitial is a transitional launch measure and operational record, not
a waiver or substitute for access controls. Final legal phrasing should be
reviewed by counsel. This decision replaces the daily-shell, trusted-proxy
admin-owner, hosted-section, and freeze assumptions in §§4–6 wherever they
conflict; the upgrade plan's §11 is authoritative for execution.
