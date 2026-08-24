# Egress Program Status

**Updated:** 2026-08-24 (night) — maintained by Claude; ask for "the egress status board" in any session.

## Live infrastructure

| What | Where | State |
| --- | --- | --- |
| `alphaclaw-egress-enforced-1` (+ gateway) | Dedicated test Hetzner project | **Enforced**, onboarded, healthy. Dashboard: `https://alphaclaw-egress-enforced-1.tail2cd802.ts.net/` (tailnet-only; password in Doppler `SETUP_PASSWORD__INST_8ADB16F0…`). **No time required from Bill**: Claude drives a scoped agent-exercise session (web search, browsing, memory — no external accounts) via the gateway's private path to generate the Phase 3 flow-log inventory. |
| `alphaclaw-egress-soak-1` (mediated) | — | Destroyed 2026-08-23; teardown test passed clean. Residue: dead node(s) in the tailnet admin console (manual cleanup, cosmetic). |

## Threads

| Thread | State | Owner | Next action |
| --- | --- | --- | --- |
| Egress Phases 0–2 (spec, spike, mediated, enforced flip) | **Done & live-validated** on branches | — | — |
| clawctl egress branch | **Merged to `main`** 2026-08-24 (0fb72df, 431/431 tests + tsc clean on merged main) | — | — |
| teamyou PR #791 (Phase 1+2) | Open, mergeable into `development` | **Bill** | Review, merge |
| Attestation workflow (continuous firewall verification + Slack drift alerts) | Blueprint ready, not started | Claude | Build after the branches merge |
| Setup-completion readiness gate | **Shipped by Bill** in `0.9.18-starfoundry.18-beta.1` (merged to alphaclaw main) | **Bill** | Live test: fresh TeamYou-admin provision with channel=beta |
| Flow-log inventory report (Phase 3 input) | Ready to run — a focused exercise session beats passive soak time | Claude | Drive scoped agent usage via the gateway private path, then harvest `alphaclaw-natgw-new` logs into the destination report |
| Host-asset bundle env bump in teamyou Vercel (`ed1ac144`) | **Deliberately deferred** (owner call 2026-08-24): a customer is mid-onboarding; bump waits until the coast is clear. (Note: the bundle URL/SHA is read once at stage-zero claim, so in-flight instances keep their bundle — the bump only affects future claims. Recorded so the timing decision has full context.) | Bill | Bump when comfortable; required before TeamYou-provisioned mediated/enforced instances |
| Loopback-through-proxy class (web_search et al.) | **Fixed generically 2026-08-24** via the vault proxy shim on alphaclaw main (fadc521); live-validated on the enforced instance. Vault plaintext-sniff rejected; no upstream change needed | Bill | Ships in the next alphaclaw release — **deferred by owner until needed for testing** (enforced instance is hot-patched meanwhile) |
| Mediated route lost on DHCP renewal | **Fixed 2026-08-24** (clawctl 2a27d05): bootstrap writes a netplan drop-in so networkd owns the route + policy rule; the old oneshot became a probe/repair alarm on a 5-min timer ("alphaclaw-egress-alarm" journal token). Live-applied to the enforced instance and proven: route survives forced networkctl reconfigure; strip-and-repair drill passes | Bill | Rides the branch merge; bundle republished as ed1ac144 |
| Vault-env plugin-install bug | **Fixed on alphaclaw main** (6b769a2); rides the next release. Live instance manually unblocked (vercel-ai-gateway plugin installed by hand) | Bill | Include in next alphaclaw release |

## Explicitly parked (no one is working on these)

- Phase 3: retire public bootstrap ingress; transparent payload scanning (PipeLock); egress policy tiers — needs the flow-log inventory first.
- Phase 4: OpenClaw privilege escalation (sudo/power-mode) — gated on attestation running fleet-wide.
- alphaclaw `enforced`-mode observability (doctor/watchdog "gateway unreachable" state) — downgraded from prerequisite to nice-to-have by the Phase 2 NAT correction.
- Existing-instance migration — out of scope by owner decision (2026-08-21); new instances only.
- Tailnet dead-node cleanup on instance destroy — cosmetic, unscheduled.

## Chips / tickets

- No pending chips. (The readiness-gate chip was completed by Bill; its two predecessors were withdrawn as superseded.)
- Nothing filed in Linear for this program, deliberately.
