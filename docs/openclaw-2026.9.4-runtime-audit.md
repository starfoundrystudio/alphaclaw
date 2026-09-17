# OpenClaw 2026.9.4 managed-runtime audit

Audit started: 2026-09-16  
Execution branch: `codex/openclaw-2026.9.4-upgrade`

## Required runtime

- Node.js: `>=24.16.0 <25 || >=26.1.0`
- SQLite loaded by `node:sqlite`: `>=3.51.3`
- New provisions: Node.js 26

The audit reads the Node binary resolved by the `alphaclaw.service` PATH and
queries that binary's built-in SQLite. It does not change the host.

## First fleet pass

The local clawctl registry contained ten managed workload records. Direct,
read-only SSH from the operator machine reached three:

| Instance | Node | SQLite | Result |
| --- | --- | --- | --- |
| `alphaclaw-mat-starfoundry-1` | 22.22.3 | 3.51.3 | Node upgrade required before OpenClaw |
| `alphaclaw-sandor-chronosinssights-1` | 24.18.0 | 3.53.1 | Compliant |
| `alphaclaw-tom-1` | 24.18.0 | 3.53.1 | Compliant |

The remaining seven public SSH connections timed out. This is expected for
hosts whose bootstrap SSH firewall has been removed, but this operator machine
did not have a usable Tailscale CLI path at audit time. Their runtime versions
remain unverified.

## Sequencing decision

On 2026-09-16, Bill decided that a fleet-wide runtime sweep should not block
the start of upgrade implementation. G0 runtime-policy work is complete once
the repository guards and Node 26 provisioning behavior are merged into the
execution branches.

These first-pass results are a baseline, not an immediate remediation queue.
Each internal or production target must pass the Node and SQLite pre-check
immediately before its G3 or G4 install. Any noncompliant host is upgraded
before AlphaClaw/OpenClaw is installed on that host.

No host was changed during this pass.
