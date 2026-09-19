# OpenClaw 2026.9.4 upgrade — G2 closeout

Status: complete 2026-09-19. Gate G2 of the execution project (`TAoHXFTAly7M`):
a production-shaped, vault-enrolled, disposable dual-VPS instance provisioned
by TeamYou on the current release (AlphaClaw `0.9.18-starfoundry.22` /
OpenClaw 2026.7.1), upgraded in place to the 2026.9.4 branch through an
immutable branch artifact, and exercised against the test plan T1–T11.
Full evidence, timestamps, commands and hazards are in
`docs/openclaw-2026.9.4-g2-preview-runbook.md` (Agent Drive
`doc_b0t2wE6B50VT`). This document is the checkpoint summary.

## What was built for G2

- **Dedicated TeamYou preview control plane:** branch
  `preview/openclaw-2026.9.4-g2` off `main`, its own Neon branch, callback
  origin and Blob store; beta host-bundle pin used only there.
- **Immutable branch artifacts:** `npm pack` from a detached worktree,
  sha256-addressed on Vercel Blob, installed on the host via
  `ALPHACLAW_NPM_SPEC` and the staged `alphaclaw-host-upgrade.sh`. Nine
  artifacts were built during G2; the final one is
  `0.9.18-starfoundry.23-g2.f7d3cc3` (branch head at closeout: `2136ef9`).
- **Two instances:** `test-g2-oc94-01` (7.1 → 9.4 crossing, T1–T9, T11) and
  `test-g2-oc94-02` (T10: restore of 01's 7.1 backups onto a fresh 7.1
  provision, then the same crossing). Both destroyed by Bill on 2026-09-19.

## Test results

| Test | Result | Note |
| --- | --- | --- |
| T1 state continuity | PASS | sessions, cron, workspace, channel and model config survive; 9.4 migrates transcripts into SQLite |
| T2 egress via gateway | PASS | web_fetch through the enforced proxy |
| T3 supervision / restart | PASS | handoff restart 2.7 s; crash → Doctor-first relaunch ~2 min; finding #3 (launcher-death orphan, exit 78) is a W3 follow-up |
| T4 managed config ownership | PASS | Control UI writes refused (`ConfigReadOnlyError`); Clawbridge writes and Doctor via guard OK |
| T5 vault token sweep | PASS with design note | literal token replaced within one tick; no proposal for a vault-managed slot |
| T6 channel traffic | PASS | Telegram round trip |
| T7 bootstrap / skills / CLI continuity | PASS | codeword recall |
| T8 advanced Control UI gate | PASS | interstitial, signed ack, audit, amber label; 9.4 bootstrap hand-off removes the browser-pairing screen |
| T9 agent behaviour probe | PASS | agent points users to Clawbridge |
| T10 backup/restore crossing | PASS | 7.1 snapshots → fresh 7.1 → 9.4 in 3 min; findings #9 and #10 |
| T11 dynamic model catalog | PASS | refresh source = openclaw |

## Findings and where they stand

| # | Finding | Status |
| --- | --- | --- |
| 1 | clawctl on-host TeamYou install timer re-wrote config keys 9.4 retired | fixed, clawctl `455ed6e`, bundle `28d50d60` on Preview beta |
| 2 | retired `finalize-openclaw-startup-state` CLI step started the server in the foreground | fixed, same bundle |
| 3 | launcher death leaves an orphan Gateway (exit 78) | open, W3 follow-up |
| 4 | Add Model dialog empty under the 9.4 catalog shape | fixed, `e527110` |
| 5 | AI Gateway key stored on the server after onboarding | decided: Phase D (provision-time seeding); not a 9.4 item |
| 6 | GPT-5.5 selectable | fixed, `7e39d5b`/`dfc8726`/`63c2f50` (server-side denylist) |
| 7 | Provider API Key coverage and stale lists | fixed, `5e13372` + `f7d3cc3` (pinned OpenClaw catalogs, no external source) |
| 8 | state-tier backups fail on 2026.9 lock files | fixed, clawctl `40696a4`/`78d0480`, bundle `fed9a46b` on Preview beta — **G3 blocker until the stable pin carries it** |
| 9 | restore reused a live source's tailnet identity | fixed, teamyou PR #1038 (opt-in + server guard), awaiting merge |
| 10 | startup plugin reconciliation races the egress proxy on restored hosts | fixed, alphaclaw `2136ef9`; to be exercised on the next restore drill |

## Residual limits accepted at G2

- Finding #10's retry and the 9.4 fresh-provision path (bundled-plugin
  discovery, SearXNG default) have not run on a live instance; G3's fresh
  beta provision covers both.
- The Cloudflare AI Gateway catalog row is pinned by hand
  (`anthropic/claude-sonnet-4.6`); its id format is unverified against the
  plugin, which ships no catalog.
- Recommended-model picks for xAI, Google, Groq and Moonshot are open; the
  first row is alphabetical until set.
- The upstream OpenClaw PR for the bootstrap gate and finding #3 remain
  follow-ups outside G2.

## Retarget note (2026-09-19)

OpenClaw 2026.9.5 was published during G2. The project now targets
`openclaw@2026.9.5`; see `docs/openclaw-2026.9.5-retarget-assessment.md`
for what changed and what G3 must re-verify on the new pin. G2's results
above were obtained on 2026.9.4 and stand as the crossing evidence; the
9.4 → 9.5 step itself (agent database schema 21) has not been exercised on
an instance.

## Carry into G3

1. Merge teamyou PR #1038; promote clawctl bundle `fed9a46b` to the stable
   pin only after a beta soak (it descends from the current baseline).
2. W6 (regression, advanced-access, agent-behaviour and dynamic-catalog
   lifecycle tests; S0–S2 closeout; docs; Codex smoke) before the beta tag.
3. G3: publish the beta tag (ask Bill first), install on internal instances,
   soak; run a restore drill with an npm-installed provider route per the
   backup plan rev 3.28.
