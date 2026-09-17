# OpenClaw 2026.7.1 → 2026.9.4 upgrade assessment

Working set for the TeamYou project "OpenClaw 2026.7.1 → 2026.9.4 upgrade
assessment" (id `JHbtOo23MmMB`). This assessment did not perform the upgrade;
it produced the change inventory, impact matrix, checklist update, Clawbridge
vs Control UI audit, hosting spike, and the approved upgrade plan. **Assessment
closed 2026-09-16; execution continues in the TeamYou project "OpenClaw
2026.9.4 upgrade — execution".**

| Doc | Phase | Status |
| --- | --- | --- |
| [`01-change-inventory.md`](01-change-inventory.md) | 1 — every stable release 2026.7.1 → 2026.9.4 digested | draft for review |
| [`02-code-deep-dives.md`](02-code-deep-dives.md) | 2 — what the 9.4 code actually does (migrations, auth store, OpenAI route, supervisor mode, models CLI, retired keys) | draft for review |
| [`03-impact-matrix.md`](03-impact-matrix.md) | 3 — every AlphaClaw touchpoint, severity-tiered, with decisions needed | Checkpoint 1 closed 2026-09-11; decisions recorded in §M and §K |
| [`A1-alphaclaw-openclaw-touchpoints.md`](A1-alphaclaw-openclaw-touchpoints.md) | appendix — exhaustive inventory of AlphaClaw code that reads/writes/spawns OpenClaw | reference |
| [`A2-clawbridge-feature-inventory.md`](A2-clawbridge-feature-inventory.md) | appendix — Clawbridge feature surface, routes, branding points, gateway-VPS features (input to Phase 5) | reference |
| [`04-checklist-update.md`](04-checklist-update.md) | 4 — AGENTS.md "OpenClaw Upgrade Reviews" checklist revision (rationale; the checklist itself lives in AGENTS.md) | done 2026-09-11 |
| [`05-clawbridge-vs-control-ui.md`](05-clawbridge-vs-control-ui.md) | 5 — audit and recommendation (Option C: split by responsibility, trusted-proxy handoff) | Checkpoint 2 closed 2026-09-16; direction decided, sections open pending spike |
| [`A3-control-ui-9.4-audit.md`](A3-control-ui-9.4-audit.md) | appendix — page-by-page Control UI audit at v2026.9.4 with RPCs, scopes, customization, plugin UI, auth, CSP | reference |
| [`S1-hosting-spike.md`](S1-hosting-spike.md) | spike — Clawbridge page hosted as a Control UI plugin tab on a local 9.4 rig (trusted-proxy SSO, basePath, cookies/WS in frame, scope hiding) | passed 2026-09-16 |
| [`06-upgrade-plan.md`](06-upgrade-plan.md) | 6 — gates G0–G4, workstreams W0–W6, managed runbook, test plan T1–T10, deferred follow-ups | approved 2026-09-16 (Checkpoint 3) |

Upstream facts were verified against tags `v2026.7.1` and `v2026.9.4` in the
local `openclaw` checkout (`/Users/billk/Development/openclaw`).
