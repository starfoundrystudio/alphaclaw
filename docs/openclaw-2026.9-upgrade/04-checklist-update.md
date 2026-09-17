# Checklist update (Phase 4)

Status: **done 2026-09-11.** The "OpenClaw Upgrade Reviews" section of
[`AGENTS.md`](../../AGENTS.md) was rewritten (uncommitted). This note records
what changed and why, so the diff can be reviewed without re-reading the whole
assessment.

## What the old checklist missed

The previous six-step list assumed a single-host install where AlphaClaw's
main risk was writing a stale config format. The 2026.7.1 → 2026.9.4 review
found blockers in areas it never named:

| Gap | Evidence from this review |
| --- | --- |
| Host prerequisites | Node floor moved to 24.16+/26.1+; the old range is hard-coded in three repos. |
| Automatic vs Doctor-only migrations | Session JSONL → SQLite is Doctor-only; our manual npm-install path never runs it. |
| Store ownership markers | The shared auth store relocates based on `config_machine_state["auth.sharedStore"]`; our writers assume the per-agent DB. |
| Roster and retired config keys | `agents.list` → `agents.entries` breaks ten AlphaClaw files; 60+ retired keys with a Doctor deadline. |
| Supervision contract | External supervisor mode, restart handoff rows, `/startupz`; systemd env sniffing changes Gateway behaviour on our hosts. |
| Agent Vault interplay | Upstream's secret egress proxy overwrites the exec env and cannot chain through the vault. |
| Backup coverage | Git backup no longer covers real state once transcripts, pairings, approvals and secrets live in SQLite. |
| Catalog kind changes and consent | Codex moved provider → plugin; non-interactive installs need `--accept-capabilities`. |
| Onboarding flag surface | Provider-specific API-key flags were removed from `openclaw onboard`. |
| Bootstrap ritual template | `BOOTSTRAP.md` was rewritten; the heading we patch no longer exists. |
| Default-on features with cost | Dreaming, self-learning, Swarm, recursive delegation, CPU-scaled concurrency all default on. |
| Empirical test | No step required booting the new version on a copied state dir before writing the plan. |

## What the new checklist adds

- Four ground rules (verify against the checkout at both tags; make every
  `openclaw update` step explicit for managed hosts; no downgrade after
  migration; run gated assessments as a TeamYou project with recorded
  decisions).
- Fifteen numbered steps, each naming the upstream files to diff and the
  AlphaClaw files to audit, grouped as: sources → host prerequisites →
  persistence → config → auth/vault → supervision and dual-VPS → backup →
  models/catalogs → onboarding/bootstrap → protocol/CLI/Control UI → plugin
  SDK → managed defaults → tests/version strings → mandatory empirical
  migration test → deliverables with the S0–S3 severity scale.
- A pointer to this directory as the worked example, and to appendix A1 for
  the exhaustive touchpoint list, so the checklist itself stays readable.

## What was deliberately left out of AGENTS.md

- The per-release facts (table lists, key names, protocol versions). Those
  belong in the assessment docs for the release in question, not in standing
  guidance.
- The Clawbridge vs Control UI question. Step 10 only asks for the page
  inventory; the product decision is its own phase.
