# Docs index — security/egress program

**Start here: [`egress-program-status.md`](egress-program-status.md).** It is THE
tracker for the whole program — every thread, its current state, owner, and
next action, updated on every state change. Read it first; everything below is
referenced from it.

## Specs (design + decisions; owner decisions are recorded inline as D*/Q*)

| Doc | Covers |
| --- | --- |
| [`egress-enforcement-spec.md`](egress-enforcement-spec.md) | The foundation: gateway-NAT topology, mediated/enforced egress modes, phase plan (Phases 0–4) |
| [`vault-brokered-model-keys-spec.md`](vault-brokered-model-keys-spec.md) | Agent Vault brokering for model/gateway API keys (placeholder substitution; shipped) |
| [`vault-brokered-channels-spec.md`](vault-brokered-channels-spec.md) | Channel credential taxonomy (Tiers S/S-te/D/C/L), classification governance, deny-list enforcement, Phase E sealed custody (all shipped; WhatsApp shelved — see §4 note) |
| [`oauth-refresh-broker-spec.md`](oauth-refresh-broker-spec.md) | Gateway-brokered OAuth refresh tokens for Codex, Claude CLI, and gog — beta acceptance completed; official gog Gmail-watch fix and stable promotion pending |
| [`oauth-broker-v2-consumer-framework.md`](oauth-broker-v2-consumer-framework.md) | Approved object model for owner-created Custom OAuth/OIDC connectors, multi-account grants, separated management/use capabilities, and user-defined short-lived-token bindings for unknown CLIs; implementation remains gated |
| [`oauth-broker-v2-management-plane.md`](oauth-broker-v2-management-plane.md) | Proposed TeamYou-signed, browser-to-gateway owner management path for connector secrets and consent, including callback ownership, SSRF/DNS-rebinding controls, audit, recovery, and the decisions required before schema-v2 code |
| [`egress-flow-log-inventory.md`](egress-flow-log-inventory.md) | Empirical NAT flow-log inventory from the enforced test instance — the Phase 3 planning input |

## Cross-repo

- **clawctl** `docs/host-asset-release-channels.md` — host-asset bundle
  provenance stamping, beta/stable pin model, promotion guards, and the
  hotfix-from-pinned-baseline flow.
- **teamyou** — provisioning-side changes land as PRs mirroring clawctl
  (channel picker, bundle pins, Phase E port); the specs above name the PRs.

## Background / historical

`security-gateway-rollout-notes.md`, `fork-deviations.md`,
`openclaw-to-alphaclaw-migration.md`, `teamyou-memory-integration-analysis.md`,
`security-architecture.html` — context that predates or sits beside the
current program; not required reading to work a current thread.

## Conventions a new agent should know

- The status board is updated (and its artifact republished) on **every**
  state change — if you change program state, update the board.
- User-facing copy says **Clawbridge**; identifiers/package/env stay
  `alphaclaw`.
- Releases: bump → regenerate manifests → build UI → vitest (gate on exit
  code) → `npm publish --tag beta` → push → **manual** install on instances
  (managed instances have no self-update).
- Gateway hosts are reached via a temporary own-IP Hetzner firewall,
  removed and verified closed after every session.
