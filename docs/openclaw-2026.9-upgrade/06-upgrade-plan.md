# OpenClaw 2026.7.1 → 2026.9.4 upgrade plan (Phase 6)

Status: **APPROVED by Bill at Checkpoint 3, 2026-09-16** (all five §9 items),
then amended with Bill's approval on 2026-09-16 to resolve the execution gaps
recorded in §10, and amended again on 2026-09-17 by the managed-experience
decision in §11. Execution is tracked in the TeamYou project named in §8.
This is the plan that project follows. It assumes every decision recorded in
[`03-impact-matrix.md`](03-impact-matrix.md) (§M, §K, §I2) and
[`05-clawbridge-vs-control-ui.md`](05-clawbridge-vs-control-ui.md) (§8),
and the spike result in [`S1-hosting-spike.md`](S1-hosting-spike.md).

## 1. Goals and non-goals

Goals: pin AlphaClaw to `openclaw@2026.9.4` (or the then-current stable on
the same line), keep every managed instance's data and custody guarantees
intact through the migration, adopt the decided operating model (external
supervision, read-only config, vault-exclusive secrets, managed defaults), and
make Clawbridge the supported managed interface. Native Control UI access is
an optional advanced interface behind an authenticated TeamYou-branded gate;
no supported workflow may require it.

Non-goals for this upgrade: white-labelling or embedding Clawbridge sections
inside the Control UI, native feature plugins, per-person identities and
operator roles, a complete Clawbridge reimplementation of every Control UI
feature, adopting OpenClaw's secret store, multi-tenant hardening, and any
backup surface (backups are provider snapshots, Backblaze, and the workspace
export; restore from teamyou.com).

## 2. Sequencing and gates

```
G0  Prerequisites            runtime policy; Node 26 for new provisions; git-sync removal
G1  Branch complete          AlphaClaw 9.4 branch with W1–W6 merged, vitest green
G2  Disposable instance      first install on a throwaway dual-VPS instance; test plan T1–T10 pass
G3  Beta                     beta tag published; install on the internal instance(s); soak
G4  Production runbook       manual, one instance at a time, with the pre-upgrade backup verified
```

Rules: nothing reaches a customer before G2 passes in full; no downgrade after
a database migration (rollback = restore the verified pre-upgrade backup with
the 7.1 package); "ASK BILL before any release or install" applies to every
publish and every fleet install.
The explicit G3 production-go checkpoint occurs after the beta soak and before
the first G4 production install. Fleet-wide Node/SQLite verification is not a
G0 blocker: each target is checked and, if necessary, remediated immediately
before its G3 or G4 install.

## 3. Workstreams (what the branch contains)

Matrix row ids in brackets. Order inside a workstream is the recommended
implementation order; workstreams W1–W3 are the boot-critical core.

### W0. Prerequisites (before the branch is installable anywhere)

- clawctl: raise `node-runtime.sh` ranges to
  `>=24.16.0 <25 || >=26.1.0`; use Node 26 for new provisions while accepting
  already-managed hosts on a compliant Node 24 runtime. Do not block branch
  work on a fleet-wide sweep; the per-instance G3/G4 pre-check verifies the
  installed Node and SQLite before that host's OpenClaw upgrade [A1].
- Remove GitHub sync from Clawbridge (git-sync CLI, hourly cron, sidebar git
  panel, GitHub config routes, `.gitignore` whitelist machinery) — decided
  2026-09-14; ideally lands before the pin bump so the 9.4 branch does not
  carry dead code [E1].

### W1. Boot-critical compatibility (S0)

1. Roster accessor: read `agents.entries` and legacy `agents.list`, write
   `agents.entries` only; migrate all ten callers and the migration script
   [B1].
2. Shared auth store resolution: locate the store through the
   `config_machine_state["auth.sharedStore"]` marker; support both
   `auth_profile_store` (per-agent DB) and `auth_profile_stores`
   (state DB); stop creating agent databases and stop `VACUUM`/checkpoint
   on Gateway-owned files; re-express the OAuth guard's expiry shield against
   the new refresh locks [C1, A2, I3].
3. Onboarding: replace provider-specific API-key flags with env delivery
   plus `--secret-input-mode ref`; preinstall `codex` with
   `--accept-capabilities` when the Codex runtime is selected; use `--json`
   and inspect reported health [H1, H2, H3, F2].
4. HOME-domain fix: preserve the original service-user HOME for every
   OpenClaw-owned process while keeping AlphaClaw and OpenClaw state on the
   explicit `ALPHACLAW_*` / `OPENCLAW_*` paths; stage Claude credentials under
   the service HOME, leave managed Codex on its explicit agent-owned
   `CODEX_HOME`, and add an entrypoint-level regression test [A4].
5. AlphaClaw engines and `node-sqlite-safety.js` ranges [A1].

### W2. Same-release correctness (S1)

- OpenAI route: canonical `openai/*` refs, runtime intent as per-model or
  provider `agentRuntime`, remove the `openai-codex` provider path from UI and
  validation, verify the `openai:codex-cli` profile survives Doctor [B2, B4].
- Retire the codex-sidecar and session-JSON repair paths; remove direct reads
  of `devices/*.json`, `identity/*.json`, and `credentials/*-pairing.json` in
  favour of the plugin-sdk device functions and the pairing CLI [C2, C4, J3].
- Regenerate the compatibility manifest at `v2026.9.4`; fix Codex keyed by
  plugin id; add `--accept-capabilities` to managed installs; switch the
  secret-resolution import to `secret-ref-runtime`; boot-time import smoke
  test for every subpath [F1, F2, F4].
- Catalog generator with `--refresh` (or bundled-snapshot fallback); validate
  the `models list` row shape; thinking-level exports and `ultra`; pricing
  source; hardcoded model keys [G1, G2, G3, G4, G6].
- Bootstrap ritual: re-derive completion heuristics from the 9.4 template,
  replace the "Connect (Optional)" patch with our own injected step, and
  confirm managed instances (no native identity) still complete the ritual
  [H4].
- Strict channel-token config sweep with vault proposal and migrate banner
  [I5].
- Exec approvals: stop writing `exec-approvals.json`; use the SQLite-backed
  store or CLI [B9].
- Retired config keys: audit every managed writer against D12; CI check
  running `openclaw doctor --lint --all` on a copied production config [B6].
- Close the remaining matrix compatibility rows rather than relying on broad
  regression coverage: migrate memory-search key handling; route raw config
  writers through the shared guarded writer; verify Gateway-token env refs,
  rate-limit-sensitive RPCs, Agent Vault provider hosts, channel and cron
  payloads, Skill Workshop ownership, and preservation of Doctor originals
  [B3, B8, D8, D9, E4, G7, H7, J1, J2].
- Re-test bundled plugin hook signatures and every parsed OpenClaw CLI JSON
  shape, not only the external TeamYou memory plugin [F5, F7].

### W3. Supervision and config ownership (decided)

- `OPENCLAW_SUPERVISOR_MODE=external` and
  `OPENCLAW_SERVICE_REPAIR_POLICY=external` in every OpenClaw process env
  (Gateway child, `gatewayEnv()`, CLI passthrough, `auth-profiles.js`,
  catalog generator) [D1].
- Exit handler: consume `openclaw gateway restart-handoff consume
  --expected-pid <pid> --json`, relaunch without Doctor when a handoff row
  exists, treat exit 78 (startup-migration refusal) distinctly; readiness via
  `/startupz` then `/readyz`, log-string parsing as fallback; stop timeout
  and forced stop after the drain window (the rig showed a Gateway still
  draining 30 s after SIGTERM) [D1, D2, D3].
- `commands.restart: false` for agents; supervisor restarts via the handoff
  path [D1].
- `OPENCLAW_CONFIG_READONLY=1` on managed Gateway/CLI processes; Clawbridge
  is the sole config writer; maintenance flows (Doctor `--fix`, plugin
  reconcile, onboarding, `config set`) run from Clawbridge/clawctl with the
  variable unset [I6]. Do not relax this global protection merely to enable
  the advanced Control UI. A future scoped write/admin mode requires its own
  design and approval because upstream config RPCs are globally refused under
  this setting.
- Update refusal: `OPENCLAW_DISABLE_UPDATE_CHECK=1`, `OPENCLAW_NO_AUTO_UPDATE=1`,
  `update.checkOnStart=false` [K].

### W4. Managed defaults (decided, §K)

`plugins.entries.memory-core.config.dreaming.enabled=false`,
`skills.workshop.autonomous.mode=propose`, `tools.swarm=false`,
`gateway.cliAgents.enabled=false`, `gateway.terminal.enabled=false`,
`telemetry.enabled=false`, `secrets.egressProxy.enabled=false`, the agent
`secrets` tool denied in the managed tools policy, explicit
`agents.defaults.maxConcurrent=3` on CPX-class hosts (future host classes must
choose an explicit size; verify the CPX value in T6), `subagents.maxSpawnDepth`
and session reset at upstream defaults,
`agents.defaults.memorySearch` no longer written.

### W5. Managed surface and advanced Control UI access (decided 2026-09-17)

- Clawbridge is the primary and supported managed interface. Remove the
  previous daily-Control-UI-shell and hosted-Clawbridge-section direction;
  keep the products as separate trust and experience surfaces.
- Define a versioned managed-capability contract across runtime prompts,
  tools, config, Clawbridge affordances, and tests. The OpenClaw agent must
  not recommend or depend on a capability that requires the customer to open
  the Control UI. Unsupported surfaces are disabled where configuration
  permits and described as managed by TeamYou where they cannot be hidden.
- Keep `/openclaw` behind AlphaClaw authentication and add a TeamYou-branded
  interstitial before any Control UI HTML, deep link, service worker, or
  Gateway WebSocket can be reached. The acknowledgement is signed and
  session-scoped; audit user, instance, warning version, timestamp, and the
  managed-config revision. Do not permit a direct Gateway-origin bypass.
- After acknowledgement, show a persistent amber environment label such as
  **Advanced — unmanaged changes**. The warning is expectation-setting and
  operational evidence, not a security boundary or legal waiver; counsel
  reviews final legal language. User-facing copy says **TeamYou**, never the
  internal company name.
- Preserve `OPENCLAW_CONFIG_READONLY=1` for the initial release. Prefer
  scope-capped read-only Control UI authority if it can be delivered without
  blocking the upgrade; otherwise the global read-only config guard remains
  the minimum boundary. Time-limited write elevation, a managed-config diff,
  and restore-to-managed-baseline are follow-ups, not implicit launch scope.
- Expand Clawbridge selectively for the supported configuration workflows:
  channel DM/group policy, allowlists, groups/rooms, mention/activation
  behavior; and agent model/fallback, thinking level, speed/fast mode when
  available, tools, skills, and bindings.

### W6. Tests, docs, and release hygiene

- Update tests pinning 7.1 shapes; run the two canaries first after install
  (`openclaw-thinking`, `model-catalog-bootstrap`) [L1–L3].
- Replace hardcoded `2026.7.1` strings and comments [L4]; rewrite
  `docs/fork-deviations.md` (Codex route) and the migration doc's SQLite
  notes [L5]; retire `prepare-openclaw-migration.sh`'s auth/cron export or
  point it at the new store locations [E3].
- Memory/gating: verify the TeamYou memory plugin against 9.4
  (`plugin-entry` shape, manifest, consent, `assets/icon.png`) and rebuild
  if needed [F5, D10].
- CLI-runtime continuity: test Claude login/adoption, three-turn history, an
  MCP/tool turn, and a Gateway restart without relying on the temporary
  projects symlink; smoke-test managed Codex across the same HOME change and
  confirm its agent-owned `CODEX_HOME` is unchanged [A4].
- Before G1, close every S0–S2 row in `03-impact-matrix.md` as implemented,
  explicitly deferred, or covered by a named G2 test. Unmapped rows block G1.

## 4. Managed-instance runbook (replaces `openclaw update`)

Per instance, operator-driven, one at a time:

1. **Pre-checks**: Node satisfies `>=24.16.0 <25 || >=26.1.0` and SQLite is
   ≥ 3.51.3 on the host (new provisions use Node 26); confirm disk headroom;
   run `openclaw doctor --lint --all --json` on the running 7.1 instance for
   retired keys.
2. **Backup**: provider snapshot of both VPSes plus a WAL-consistent copy of
   `state/openclaw.sqlite`, every `agents/<id>/agent/openclaw-agent.sqlite`,
   `openclaw.json`, credentials, and workspaces (use `openclaw backup create
   --verify` once 9.4 is installed for future runs; for this first crossing,
   stop the Gateway and copy). Record the recovery point id.
3. **Stop**: Clawbridge stops the Gateway (supervisor path) and confirms the
   state-dir lock is released (no `openclaw-gateway` process).
4. **Install**: the AlphaClaw 9.4 release via the existing manual SSH
   install; plugins reconciled from the regenerated manifest with
   `--accept-capabilities`.
5. **Doctor**: with the Gateway stopped and `OPENCLAW_CONFIG_READONLY` unset,
   run `openclaw doctor --non-interactive --fix` under the vault env; capture
   the report; diff `migration_runs` / `migration_sources`; confirm
   `auth.sharedStore` ownership, `agents.entries`, canonical `openai/*`
   refs, and that no retired keys remain.
6. **Start**: Clawbridge starts the Gateway under external supervision;
   readiness by `/startupz` (`status: "started"`) then `/readyz`.
7. **Verify** (T-list subset): vault-brokered model call, channel login and
   message round trip, cron run, pairing approval, restart handoff, Clawbridge
   managed workflows, the TeamYou advanced-access interstitial and audit,
   Control UI bypass prevention, persistent advanced label, Doctor lint clean.
8. **Rollback** (only before step 5 completes): restore the recovery point
   with the 7.1 package. After Doctor has migrated, rollback means restore
   from backup, never a package downgrade.
9. **Cleanup** after a soak: `openclaw update cleanup --dry-run`, then
   cleanup, to drop migration originals.

## 5. Test plan (G2 on the disposable instance, repeated at G3)

| # | Test | Pass criterion |
| --- | --- | --- |
| T1 | Migration from a copied production-shaped 7.1 state dir: boot 9.4 under Clawbridge, record startup migrations, stop, Doctor, diff `migration_runs` | Every expected step present (sessions, exec-approvals, mcp-oauth, shared-auth-store, cron run logs); no refusal; roster and auth store where W1 expects them |
| T2 | Vault routing on 9.4: model call, channel send, `web_fetch` | Traffic exits via the vault proxy with placeholder substitution; nothing dials direct |
| T3 | Supervisor restart: `openclaw gateway restart`, in-process restart, crash | Handoff consumed, relaunch without Doctor, `/startupz` gate honoured, no crash classification; forced stop after drain window works |
| T4 | Managed config ownership: Control UI Settings save, Model Setup, plugin enable, Labs toggle; Clawbridge model config; watchdog Doctor | Control UI config writes are refused with a clear managed-by-TeamYou message; Clawbridge writes succeed; Doctor from Clawbridge with the var unset succeeds |
| T5 | Token sweep: paste a Telegram token in the Control UI wizard (with read-only off, to simulate a bypass) and via the Secrets page | Value quarantined within one tick, proposal opened, banner shown, config and `.bak*` clean |
| T6 | Managed defaults: dreaming, swarm, cliAgents, terminal, telemetry, egress proxy, `maxConcurrent` | Each observed off/limited in `openclaw config get` and Control UI |
| T7 | Bootstrap ritual and CLI-runtime continuity on a managed instance with no native identity | Ritual completes; `BOOTSTRAP.md` handling and TeamYou memory activation gate work; Claude login/adoption preserves a three-turn conversation across an MCP/tool turn and Gateway restart without the temporary projects symlink; managed Codex still uses its agent-owned `CODEX_HOME` |
| T8 | Advanced Control UI gate: direct `/openclaw`, deep links, service-worker requests, and Gateway WebSocket before and after acknowledgement; expiry/new session; persistent amber label | Every entry path is blocked until a signed session-scoped TeamYou acknowledgement; acknowledgement is audited with the required fields; no direct Gateway-origin bypass exists; the advanced label persists afterward |
| T9 | Authority and agent-behavior review: scope-capped read-only access where feasible, forged/proxy headers, Control-UI-only prompts and tools, managed channel/agent configuration | Unauthorized and bypass paths are refused; global config read-only remains enforced; the agent does not direct customers to the Control UI; supported workflows are available in Clawbridge or explicitly deferred |
| T10 | Backup crossing: restore the pre-upgrade recovery point onto a fresh instance with 7.1, then upgrade it again | Round trip succeeds |

## 6. Risks specific to execution

- Doctor relocation of the shared auth store racing the watchdog's lazy
  Doctor (W1.2 and runbook step 5 must land together).
- The disposable instance must be production-shaped (vault enrolled, enforced
  egress, a channel bound) or T2/T5/T8 are not meaningful.
- Advanced-access gate or trusted-proxy misconfiguration; mitigated by T8/T9,
  gating both HTTP and WebSocket paths, loopback bind, and the host firewall.
- AlphaClaw's HOME override can leave Claude native transcripts and credentials
  in a different domain from the Gateway; W1 and T7 make the product fix part
  of this release rather than assuming OpenClaw 9.4 fixes it [A4].
- Upstream releases keep moving; re-run the checklist's catalog and
  retired-key diffs against the final target tag before G1.

## 7. Deferred follow-ups (tracked in the project, not in this release)

Child-env scrubbing for any future Control UI terminal access; Agent Vault
native feature plugin; time-limited Control UI write/admin elevation;
managed-config diff and restore-to-managed-baseline; richer Clawbridge channel
and agent controls beyond the release-critical subset; TeamYou-hosted and
shared artifacts as the long-term successor to instance-local Pages;
`openclaw backup` as the provisioning-side export primitive; operator roles
once per-person logins exist; retiring redundant wrapper screens only after
their managed replacements are proven.

## 8. Execution project

TeamYou project `TAoHXFTAly7M`, "OpenClaw 2026.9.4 upgrade — execution",
tracks one todo per gate (G0–G4) and one per workstream (W0–W6). Human
checkpoints are G1 (branch review), G2 (test results), G3 (production go after
the beta soak and before G4), and an explicit go for each G4 production
install. The assessment project closed when Checkpoint 3 approved this plan.

## 9. Checkpoint 3 — approved 2026-09-16

1. Approve the gate sequence and the rule that no customer instance moves
   before G2 passes.
2. Approve landing git-sync removal and the Node policy change before the
   branch (W0) rather than inside it.
3. Confirm the disposable dual-VPS instance for G2 can be provisioned
   (production-shaped, vault-enrolled).
4. Approve the runbook's Doctor step running with the Gateway stopped and
   `OPENCLAW_CONFIG_READONLY` unset from Clawbridge.
5. Approve creating the execution project on the shape in §8 and closing
   this assessment.

## 10. Approved execution defaults and change policy (2026-09-16 amendment)

Bill approved these defaults after the plan review:

1. Node 26 for new provisions; compliant existing Node 24 fleet hosts may
   remain on Node 24 for this upgrade.
2. `agents.defaults.maxConcurrent=3` on CPX-class hosts.
3. G2 means all tests T1–T10 pass.
4. **Superseded by §11.** The release no longer ships hosted Clawbridge
   sections or treats the Control UI as the daily shell.
5. The AlphaClaw service-HOME / OpenClaw-state separation and Claude
   continuity acceptance test are same-release work.
6. The production-go checkpoint precedes G4.
7. Fleet-wide Node/SQLite verification is deferred from G0. Runtime policy and
   Node 26 provisioning land now; each host is verified and remediated, if
   necessary, immediately before its beta or production install.

This plan is a starting contract, not a prohibition on learning during
execution. When implementation or test evidence requires a different choice,
record the material decision in the execution project, update this document
when it changes release scope or a safety invariant, and continue through the
existing human gates rather than stopping for speculative pre-decisions.

## 11. Approved managed-experience amendment (2026-09-17)

Bill approved the following rollout after evaluating the 9.4 Control UI in
practice:

1. Clawbridge is the supported managed interface and the intended daily
   experience. The Control UI is not the product shell, and Clawbridge is not
   embedded inside it.
2. Control UI access may remain available for launch speed, but only as an
   explicitly advanced, separately gated surface. The first release uses a
   TeamYou-branded interstitial, signed session acknowledgement, audit trail,
   complete HTTP/WebSocket/deep-link coverage, no direct Gateway bypass, and
   a persistent **Advanced — unmanaged changes** label.
3. The initial release retains `OPENCLAW_CONFIG_READONLY=1`. Read-only
   operator scopes are preferred when practical without delaying the core
   upgrade. Timed write elevation, diff, and restore are later design work.
4. AlphaClaw maintains a versioned capability contract so the agent, prompts,
   tools, config, and supported UI agree. No managed workflow may require the
   customer to use the Control UI.
5. Clawbridge gains the channel-policy and agent-configuration controls needed
   for managed operation; breadth is driven by supported workflows, not by
   one-for-one parity with every upstream screen.
6. TeamYou is the only brand named in customer-facing copy. The internal
   company name must not appear in the interstitial, labels, helper text, or
   other user-visible product copy.
7. Instance-local Pages remain supported for now, but TeamYou is the likely
   long-term home for shareable team artifacts. That product migration is not
   a blocker for the 9.4 upgrade.

This amendment supersedes the Phase 5 choice to use the Control UI as the
daily shell with hosted Clawbridge sections. The earlier comparison remains
in the project as decision history; §8 of that document records the
superseding rationale.
