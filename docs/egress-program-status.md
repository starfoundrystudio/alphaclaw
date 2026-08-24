# Egress Program Status

**Updated:** 2026-08-23 (evening) — maintained by Claude; ask for "the egress status board" in any session.

## Live infrastructure

| What | Where | State |
| --- | --- | --- |
| `alphaclaw-egress-enforced-1` (+ gateway) | Dedicated test Hetzner project | **Enforced**, onboarded, healthy. Current soak: gateway flow logs are accumulating the Phase 3 traffic inventory. **Action: use the agent normally — that IS the data gathering.** |
| `alphaclaw-egress-soak-1` (mediated) | — | Destroyed 2026-08-23; teardown test passed clean. Residue: dead node(s) in the tailnet admin console (manual cleanup, cosmetic). |

## Threads

| Thread | State | Owner | Next action |
| --- | --- | --- | --- |
| Egress Phases 0–2 (spec, spike, mediated, enforced flip) | **Done & live-validated** on branches | — | — |
| clawctl `claude/egress-phase1` (5 commits incl. spec-era docs) | Pushed, unmerged | **Bill** | Review, merge to `main` |
| teamyou PR #791 (Phase 1+2) | Open, mergeable into `development` | **Bill** | Review, merge |
| Attestation workflow (continuous firewall verification + Slack drift alerts) | Blueprint ready, not started | Claude | Build after the branches merge |
| Post-flip egress probe hardening (`alphaclaw-egress-route` alarms if dark) | Noted in spec follow-ups | Claude | Small; fold into next clawctl change |
| Setup-completion readiness gate | **Shipped by Bill** in `0.9.18-starfoundry.18-beta.1` (merged to alphaclaw main) | **Bill** | Live test: fresh TeamYou-admin provision with channel=beta |
| Flow-log inventory report (Phase 3 input) | Waiting on ~1 week of soak usage | Claude | Harvest `alphaclaw-natgw-new` logs, produce destination report |
| Host-asset bundle env bump in teamyou Vercel (`46a2406b`) | Safe any time (bundle defaults to direct) | Bill | Optional now; required before TeamYou-provisioned mediated/enforced instances |

## Explicitly parked (no one is working on these)

- Phase 3: retire public bootstrap ingress; transparent payload scanning (PipeLock); egress policy tiers — needs the flow-log inventory first.
- Phase 4: OpenClaw privilege escalation (sudo/power-mode) — gated on attestation running fleet-wide.
- alphaclaw `enforced`-mode observability (doctor/watchdog "gateway unreachable" state) — downgraded from prerequisite to nice-to-have by the Phase 2 NAT correction.
- Existing-instance migration — out of scope by owner decision (2026-08-21); new instances only.
- Tailnet dead-node cleanup on instance destroy — cosmetic, unscheduled.

## Chips / tickets

- No pending chips. (The readiness-gate chip was completed by Bill; its two predecessors were withdrawn as superseded.)
- Nothing filed in Linear for this program, deliberately.
