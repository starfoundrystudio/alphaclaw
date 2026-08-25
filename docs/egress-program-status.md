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
| Customer incident (milo-b0171223) | **Root cause confirmed on-box 2026-08-25** (temporary IP-scoped SSH firewall, since removed; host keys verified against DB). Single trigger: onboard POST took ~80s with zero response bytes, and the gateway bridge's Caddy `response_header_timeout 60s` cut it → customer saw "interrupted" (symptom 1) → and because host finalization hangs on the response `finish` event, **finalization never ran**: journal shows kickoff "deferred… restart pending" at 23:46:35 then "gave up" at 00:01:25 (symptom 2), and `alphaclaw-setup.service` is STILL the running unit. **The instance is half-finalized**: running with `NoNewPrivileges=false`, finalize sudoers still present, runtime service disabled, post-onboard reconcile timer never enabled. Symptom 3 is the independent vault-env bug (fixed in beta.2). Fleet check: milo is the only affected instance (other two gateway-topology instances are our test boxes; pre-July instances predate the bridge) | **Bill** | **Remediated 2026-08-25 06:06 UTC** (owner-approved): ran `alphaclaw-host-finalize-setup complete` — runtime unit active with `NoNewPrivileges=yes`, setup unit disabled, reconcile timer enabled, finalize sudoers removed; ~5s actual downtime; kickoff correctly decided `bootstrap_already_complete` (no spurious greeting); both customer surfaces verified 302/200 with real Host headers; temp SSH firewall removed again. Remaining for milo: promote beta→latest so self-update delivers the .17 bug fixes |
| Finalize-hangs-on-response-delivery bug (alphaclaw) | **Found 2026-08-25, unfixed**: `res.once("finish", afterResponse)` means one dropped onboard response permanently strands an instance in setup mode (weaker hardening, no reconcile timer, kickoff dead) with `hostFinalizationScheduled` stuck `true` and zero alerting. Fix: schedule finalization when the handler completes regardless of response delivery (e.g. also on `close`), + a reconcile that notices marker=scheduled + setup unit still active | Claude (on approval) | Fix in alphaclaw, ride next beta |
| Bridge `response_header_timeout 60s` too short for onboarding (clawctl + teamyou) | **Found 2026-08-25, unfixed**: both `connectivity-caddy.ts` files ship 60s; onboard legitimately runs 60–120s+ with no header bytes. Raise substantially (e.g. 300s) on both surfaces; becomes non-critical once the finalize decoupling lands, but still worth fixing to stop interruptions | Claude (on approval) | Patch both repos + republish gateway assets path as applicable |
| Setup-completion readiness gate | **Shipped by Bill** in `0.9.18-starfoundry.18-beta.1`; carried forward in beta.2 | **Bill** | Live test: fresh TeamYou-admin provision with channel=beta |
| Flow-log inventory report (Phase 3 input) | Ready to run — a focused exercise session beats passive soak time | Claude | Drive scoped agent usage via the gateway private path, then harvest `alphaclaw-natgw-new` logs into the destination report |
| Host-asset bundle env bump in teamyou Vercel (`ed1ac144`) | **Deliberately deferred** (owner call 2026-08-24): a customer is mid-onboarding; bump waits until the coast is clear. (Note: the bundle URL/SHA is read once at stage-zero claim, so in-flight instances keep their bundle — the bump only affects future claims. Recorded so the timing decision has full context.) | Bill | Bump when comfortable; required before TeamYou-provisioned mediated/enforced instances |
| Loopback-through-proxy class (web_search et al.) | **Released to beta 2026-08-25** in `0.9.18-starfoundry.18-beta.2` (shim fadc521, live-validated earlier on the enforced instance). Vault plaintext-sniff rejected; no upstream change needed | Bill | Promote to `latest` after beta validation — that's what reaches milo |
| Mediated route lost on DHCP renewal | **Fixed 2026-08-24** (clawctl 2a27d05): bootstrap writes a netplan drop-in so networkd owns the route + policy rule; the old oneshot became a probe/repair alarm on a 5-min timer ("alphaclaw-egress-alarm" journal token). Live-applied to the enforced instance and proven: route survives forced networkctl reconfigure; strip-and-repair drill passes | Bill | Rides the branch merge; bundle republished as ed1ac144 |
| Vault-env plugin-install bug | **Released to beta 2026-08-25** in `0.9.18-starfoundry.18-beta.2` (6b769a2). Live test instance was manually unblocked earlier | Bill | Promote to `latest` after beta validation |
| Onboarding recovery-poll window | **Fixed + released to beta 2026-08-25** (3ac11e8, in `0.9.18-starfoundry.18-beta.2`): recovery poll extended 36s→120s to outlast the ~55s service-swap dark window; a retried submit answering "Already onboarded" now resolves through the status poll into the normal readiness handoff. Guard test pins poll ≥ 2× the observed window. 1248/1248 tests | Bill | Promote to `latest` after beta validation |

## Explicitly parked (no one is working on these)

- Onboarding speed + async redesign (owner concern 2026-08-25): milo's ~80s breakdown — 5s git/onboard, 22s `models set`, 37s skills/git-sync installs, 15s tailnet+vault. Two-part plan when picked up: (a) defer non-blocking housekeeping to the post-onboard reconcile timer (~20–30s critical path), (b) convert POST /api/onboard to a background job + progress polling so no long-lived response exists for any hop to cut (makes the bridge-timeout bump unnecessary and finalize-decoupling trivial).

- Phase 3: retire public bootstrap ingress; transparent payload scanning (PipeLock); egress policy tiers — needs the flow-log inventory first.
- Phase 4: OpenClaw privilege escalation (sudo/power-mode) — gated on attestation running fleet-wide.
- alphaclaw `enforced`-mode observability (doctor/watchdog "gateway unreachable" state) — downgraded from prerequisite to nice-to-have by the Phase 2 NAT correction.
- Existing-instance migration — out of scope by owner decision (2026-08-21); new instances only.
- Tailnet dead-node cleanup on instance destroy — cosmetic, unscheduled.

## Chips / tickets

- No pending chips. (The readiness-gate chip was completed by Bill; its two predecessors were withdrawn as superseded.)
- Nothing filed in Linear for this program, deliberately.
