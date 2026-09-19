# OpenClaw 2026.9.5 — retarget assessment

Status: 2026-09-19, Bill's directive. OpenClaw published 2026.9.5 on
2026-09-19 01:35 UTC (npm) while G2 ran against 2026.9.4. The execution
project (`TAoHXFTAly7M`) now targets `openclaw@2026.9.5`; this document
records what changed, what it means for our branch, and what G3 must
re-verify. Sources: the GitHub release (64 direct commits, 4,179 PRs) and the
plain-Markdown changelog at
`https://raw.githubusercontent.com/openclaw/openclaw/main/CHANGELOG/2026.9.5.md`
(321 feature sections; read in full for the Installation, Updates and
Maintenance, Memory, Models, Plugins and Security sections).

## 1. What we verified mechanically

| Surface | 2026.9.4 → 2026.9.5 |
| --- | --- |
| Node engines | unchanged: `>=24.16.0 <25 \|\| >=26.1.0` (clawctl's Node 26 policy stands) |
| Bundled extensions | +`apple-fm`, +`session-share`; nothing removed |
| Official plugin catalog (our compatibility manifest) | 96 → 97 managed plugins: +`radius` (provider `radius`); every plugin we install exists at `2026.9.5` |
| CLI flags we script (`models list`, `models set`, `dashboard`, `plugins install`, `doctor`, `backup create`, `devices list`, `pairing approve`) | identical `--help` flag sets |
| Markers we depend on in the dist (`OPENCLAW_CONFIG_READONLY`, `OPENCLAW_SUPERVISOR_MODE`, `config_machine_state`, bootstrap `browserUrl`/`bootstrapToken`, `ConfigReadOnlyError`, `--accept-capabilities`, `generation-writer` sidecar) | all present |
| Dependencies | routine bumps (`@anthropic-ai/sdk`, `@google/genai`, `@openclaw/ai`, `@openclaw/fs-safe`, clack, pi-tui, cua-driver) |

## 2. Changes that matter to us

**Agent database schema 21 (breaking for rollback).** "Older builds cannot
open" the upgraded agent databases; going back needs the pre-upgrade backup
restored with the matching older build, and reinstalling an older package
alone is insufficient. This also applies from 2026.9.4 to 2026.9.5, not only
from 7.1. Our position was already "after Doctor, roll back from backup";
the G4 per-instance runbook must take the state-tier backup immediately
before the install (our export uses the SQLite online-backup API, so WAL
content is included, which the release calls out).

**Legacy conversions now need an explicit `doctor --fix` with the Gateway
stopped.** "Older conversations, workspace metadata, pairing records, and
file-based message queues now wait for an explicit repair instead of being
converted during ordinary startup." Our upgrade script already stops
AlphaClaw and runs `openclaw doctor --non-interactive --fix` under the guard
twice (before and after plugin reconciliation), which is exactly the
prescribed path. A fresh 7.1 → 9.5 crossing must be re-run at G3 to confirm
the session-sqlite import still lands (it did on 9.4, T1/T10).

**Stale queued messages are withheld after upgrade.** Pending file-queue
messages older than 72 h (or with bad timestamps) are moved to `.migrated`
backups instead of replayed on reconnect. Good for us (no surprise sends
after a crossing); worth one line in the customer-facing upgrade note.

**Plugin updates decoupled from the core update.** A missing plugin update
no longer blocks the core update; pinned older plugins can return to catalog
updates. We pin managed plugins ourselves (`plugins install … --pin`) and
reconcile at startup, so behaviour is unchanged for us, but the reconciler's
"already installed" detection must be re-verified on 9.5 (G3).

**Model permissions now match the exact provider and model; manual choices
must be in the allowed list.** Clawbridge writes `agents.defaults.models`
from `configuredModels`, so the primary is always allowed. Keys or headers
stored only in an older `models.json` no longer fill a declared provider —
not our path (auth profiles live in the state DB / env). "Unsupported native
model IDs may also need an explicit definition" is the same class as the
"Unknown model" cron error seen on the restored 7.1 host (finding #10) and
is covered by reconciliation installing the provider plugin.

**Linux shutdown reserves cleanup time inside the systemd stop deadline and
the release says to retain `KillMode=mixed`.** Our `alphaclaw.service` sets
neither `KillMode` nor `TimeoutStopSec` (systemd defaults: control-group,
90 s). With the W3 handoff-aware restart this worked on 9.4 (T3); G3 should
confirm a `systemctl stop` of a busy 9.5 Gateway completes cleanly, and
setting `KillMode=mixed` + an explicit `TimeoutStopSec` in clawctl is a
cheap hardening to fold into the same bundle as the backup fix.

**Restart semantics.** "A failed in-process restart exits with code `1` and
starts no successor" and "restart preserves a recorded Gateway that is still
starting". Relevant to finding #3 (launcher-death orphan, exit 78): re-test
T3's crash case on 9.5 before deciding whether the W3 follow-up is still
needed.

**Setup/repair agent deadline is now the configured agent timeout (default
48 h).** Only affects `openclaw`'s embedded repair conversations, which we do
not use unattended; note for the Doctor guard's own timeout.

**Secrets.** File-based SecretRef credentials must be private regular files
with a single hard link; we use env-ref placeholders (`${TELEGRAM_BOT_TOKEN}`)
substituted by the vault proxy, not file refs, so no change. Built-in
secret masking now covers tool results and log views (positive for T9-class
checks). Device credential rotation now also invalidates retained Dashboard
read access (positive for T8's gate).

**Plugin storage goes asynchronous; synchronous SDK APIs are deprecated.**
Our plugins (usage-tracker, agent-vault, TeamYou memory) must be checked for
the deprecation warnings at G3; no functional change yet.

**Catalog probe behaviour changed for at least one core provider.** With the
placeholder key, `openclaw models list --provider xai --all --json` returns
6 rows on 9.4 and 0 on 9.5 without `--refresh`. The generator already
probes with and without `--refresh` and merges, so the regenerated bootstrap
(below) is the check.

## 3. Nothing found for

Device pairing / bootstrap hand-off (T8 path), trusted-proxy auth, the
read-only config contract, external supervision env, retired config keys
(`memory.search`, `config_machine_state`), the Gateway model inventory shape
(`/api/models` merge), Telegram/Slack plugin ids, Node runtime policy.

## 4. What the retarget changed in the repo

- `package.json` / `package-lock.json`: `openclaw@2026.9.5`.
- `lib/managed-capability-contract.json`: `targetOpenClawVersion` 2026.9.5.
- `lib/openclaw-compatibility.manifest.json`: regenerated (97 plugins).
- `lib/server/model-catalog-bootstrap.json`: regenerated against 2026.9.5
  (see §5 for the result).
- Project `TAoHXFTAly7M` renamed and goal updated to 2026.9.5.

## 5. Results

- **Bootstrap regenerated against 2026.9.5:** 1,446 models, 24 provider-api
  providers, zero GPT-5.5 rows, zero rows carried forward from a prior
  bootstrap. Sources: 1,358 from the CLI probe, 692 from the two public
  gateway endpoints, 165 from the new **bundled-catalog** reader, 6 pinned
  in the spec.
- **One generator change was required.** On 2026.9.5, `openclaw models list
  --provider <plugin provider>` returns nothing without a live key with or
  without `--refresh` (2026.9.4 listed the plugin's bundled catalog without
  `--refresh`), and core `xai` now lists only with `--refresh`. The generator
  therefore reads `modelCatalog.providers[*].models` straight from the
  manifests OpenClaw ships (`dist/extensions/*/openclaw.plugin.json` and the
  installed managed plugins' `openclaw.plugin.json`) as source
  `openclaw-bundled-catalog`, keeps the two-flag CLI probe for live
  key-free lists (Kilo, Novita, Venice), and never carries a prior bootstrap
  forward for a provider with bundled rows. Same per-release inventory, no
  external fetch, and the CLI's probe behaviour no longer matters.
- **Three test failures, all 2026.9.5 deltas, fixed:** the manifest now
  has 97 managed plugins (+`radius`); the thinking-options loader picked a
  minified `thinking-*` chunk whose single-letter export was no longer
  `listThinkingLevelOptions`, so every level id came back empty — the
  loader now prefers the chunk that exports the function by name and
  verifies it at load. Full vitest: 166 files / 1,488 tests, exit 0.
- **No live instance has run 2026.9.5 yet.** G2's crossings were on
  2026.9.4; the branch artifact for G3 is built from this commit.

## 6. What G3 must re-verify on 2026.9.5

1. Fresh `latest` (7.1) provision → 9.5 crossing on a disposable instance:
   T1 (session-sqlite import, schema 21), T3 (handoff and crash restart),
   T4, T8 (bootstrap hand-off), T11.
2. Fresh 9.5 provision (beta channel): bundled-plugin discovery, SearXNG
   default, plugin reconciliation "already installed" detection.
3. Restore drill with an npm-installed provider route (backup plan rev
   3.28), exercising the finding #10 retry.
4. `systemctl stop` under load; decide on `KillMode=mixed` /
   `TimeoutStopSec` in the unit.
5. Deprecation warnings from our plugins under the async storage SDK.
