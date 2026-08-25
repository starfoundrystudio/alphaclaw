# Egress Program Status

**Updated:** 2026-08-25 — maintained by Claude; ask for "the egress status board" in any session.

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
| teamyou PR #791 (Phase 1+2) | **Merged** 2026-08-24 (admin-merge per owner direction) | — | — |
| Attestation workflow | **Merged** to `development` 2026-08-24 (PR #798). Phase 2 code is fully landed | **Bill** | On next production deploy: run `{"mode":"once"}` via POST /api/internal/openclaw/egress-attestation (expect clean empty sweep), then start the chain — that closes Phase 2 |
| Customer drift audit (milo-b0171223) | **No drift found** 2026-08-24 (matched Aug-20 set; egress changes dormant in prod). **Symptoms triaged 2026-08-25 from code:** (3) Discord channel setup fails "proxy: enabled but no HTTP proxy URL" — definitively the vault-env spawn bug: channel save → `reconcileOpenclawPlugins` → the exact spawn family fixed by `6b769a2`; next release fixes it. (1) "Setup response was interrupted after initialization" + Retry loop — response cut around the setup→runtime swap, and `.17`'s recovery poller only polls 18×2s = **36s, shorter than the ~55s dark window**, so it can never see `onboarded:true`; the retry loop is unwinnable by design. The 36s window is STILL on main (the `.18-beta.1` readiness gate fixes only the success-path handoff). (2) No agent greeting / "agent starting" stuck — the `.17` bootstrap kickoff (never live-validated) didn't fire before the customer typed; their own "Hello" created an agent session, which permanently suppresses the kickoff (`existing_sessions`). Needs their journal (`Bootstrap kickoff` lines) to say why it hadn't fired yet | **Bill** | Fixes for (3) and (1)'s retry loop are in `0.9.18-starfoundry.18-beta.2` — milo is `channel=latest`, so they get them when the beta is promoted. Still open: (1)'s initial response cut and (2)'s slow kickoff — approve reading the customer instance's journals/Caddy logs |
| Setup-completion readiness gate | **Shipped by Bill** in `0.9.18-starfoundry.18-beta.1`; carried forward in beta.2 | **Bill** | Live test: fresh TeamYou-admin provision with channel=beta |
| Flow-log inventory report (Phase 3 input) | Ready to run — a focused exercise session beats passive soak time | Claude | Drive scoped agent usage via the gateway private path, then harvest `alphaclaw-natgw-new` logs into the destination report |
| Host-asset bundle env bump in teamyou Vercel (`ed1ac144`) | **Deliberately deferred** (owner call 2026-08-24): a customer is mid-onboarding; bump waits until the coast is clear. (Note: the bundle URL/SHA is read once at stage-zero claim, so in-flight instances keep their bundle — the bump only affects future claims. Recorded so the timing decision has full context.) | Bill | Bump when comfortable; required before TeamYou-provisioned mediated/enforced instances |
| Loopback-through-proxy class (web_search et al.) | **Released to beta 2026-08-25** in `0.9.18-starfoundry.18-beta.2` (shim fadc521, live-validated earlier on the enforced instance). Vault plaintext-sniff rejected; no upstream change needed | Bill | Promote to `latest` after beta validation — that's what reaches milo |
| Mediated route lost on DHCP renewal | **Fixed 2026-08-24** (clawctl 2a27d05): bootstrap writes a netplan drop-in so networkd owns the route + policy rule; the old oneshot became a probe/repair alarm on a 5-min timer ("alphaclaw-egress-alarm" journal token). Live-applied to the enforced instance and proven: route survives forced networkctl reconfigure; strip-and-repair drill passes | Bill | Rides the branch merge; bundle republished as ed1ac144 |
| Vault-env plugin-install bug | **Released to beta 2026-08-25** in `0.9.18-starfoundry.18-beta.2` (6b769a2). Live test instance was manually unblocked earlier | Bill | Promote to `latest` after beta validation |
| Onboarding recovery-poll window | **Fixed + released to beta 2026-08-25** (3ac11e8, in `0.9.18-starfoundry.18-beta.2`): recovery poll extended 36s→120s to outlast the ~55s service-swap dark window; a retried submit answering "Already onboarded" now resolves through the status poll into the normal readiness handoff. Guard test pins poll ≥ 2× the observed window. 1248/1248 tests | Bill | Promote to `latest` after beta validation |

## Explicitly parked (no one is working on these)

- Phase 3: retire public bootstrap ingress; transparent payload scanning (PipeLock); egress policy tiers — needs the flow-log inventory first.
- Phase 4: OpenClaw privilege escalation (sudo/power-mode) — gated on attestation running fleet-wide.
- alphaclaw `enforced`-mode observability (doctor/watchdog "gateway unreachable" state) — downgraded from prerequisite to nice-to-have by the Phase 2 NAT correction.
- Existing-instance migration — out of scope by owner decision (2026-08-21); new instances only.
- Tailnet dead-node cleanup on instance destroy — cosmetic, unscheduled.

## Chips / tickets

- No pending chips. (The readiness-gate chip was completed by Bill; its two predecessors were withdrawn as superseded.)
- Nothing filed in Linear for this program, deliberately.
