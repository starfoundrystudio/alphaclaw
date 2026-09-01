# Enhanced Workload Privileges Spec

**Status:** Approved for implementation, 2026-09-01.

## Goal

Give the OpenClaw agent genuine administration power on newly provisioned
workload VPSes: package installation, systemd management, system cron changes,
and arbitrary root commands through passwordless `sudo`.

This deliberately treats the entire workload VPS, including `root`, as one
trust domain. Durable credentials and load-bearing network enforcement remain
on the security gateway and in the Hetzner control plane.

## Prerequisite and scope

Enhanced privileges are available only when all of these are true:

1. The workload uses the dual-VPS `security_gateway` topology.
2. Its provisioning-time egress mode is `enforced`.
3. Provisioning has applied the Hetzner outbound-deny firewall and passed the
   mediated-path/direct-bypass verification gate.
4. The owner has completed setup and the host is transitioning from
   `alphaclaw-setup.service` to `alphaclaw.service`.

The initial rollout applies to new provisions only. Direct, mediated, legacy
single-VPS, and existing unupgraded instances remain unprivileged. Existing
instance migration belongs to the separate dual-VPS upgrade program.

Phase 3 egress policy tiers, gateway DNS enforcement, and transparent payload
inspection are explicitly follow-up security enhancements, not prerequisites
for this phase. The honest Phase 2 guarantee is mediation at an off-workload
control point, not prevention of all exfiltration through allowed internet
access.

## Runtime design

- `alphaclaw.service` continues to run as the `alphaclaw` Unix user. Routine
  application work therefore remains unprivileged by default.
- On eligible hosts its systemd unit uses `NoNewPrivileges=false`, permitting
  the service and OpenClaw children to invoke `sudo`.
- Setup finalization installs a root-owned, mode-0440 managed sudoers rule:

  ```text
  alphaclaw ALL=(ALL:ALL) NOPASSWD: ALL
  ```

- The general sudo rule does not exist during setup. Until finalization, the
  existing narrow wrapper-only sudo policy remains the only elevation path.
- The eligibility inputs used by finalization are copied at bootstrap into a
  dedicated root-owned, mode-0600 host-privilege record. The user-writable
  AlphaClaw runtime environment is not consulted for the grant decision.
- Finalization validates the candidate sudoers rule with `visudo` before it
  removes setup-only sudo permissions or swaps services. A validation failure
  leaves the setup privileges and service intact rather than stranding the
  instance.
- On every ineligible path finalization removes the reserved managed power-mode
  sudoers file, keeps `NoNewPrivileges=true`, and proceeds with the ordinary
  unprivileged runtime transition.

## Trust and operational consequences

Workload root can change or destroy workload-local applications, configuration,
logs, route helpers, Caddy, and local trust files. None of those may be treated
as security boundaries. Root can also read short-lived OAuth access tokens in
use, but durable refresh grants remain on the gateway.

The following stay outside workload authority:

- Hetzner API credentials and the workload outbound-deny firewall;
- gateway nftables, NAT, credential broker policy, durable OAuth grants, Agent
  Vault values, and custody KEKs;
- TeamYou's hourly cloud-firewall attestation and repair loop.

Availability against a malicious root workload is not a goal: the customer owns
the VPS and an administrator can break their own instance. Recovery continues
through the gateway/operator access path and the future upgrade program.

## Acceptance criteria

On a fresh default TeamYou beta provision:

1. Provisioning metadata says `egress_mode: enforced`; observed IPv4 egress is
   the gateway public IP; the shared deny firewall is attached; the direct
   bypass probe fails closed; attestation reports healthy.
2. Before setup finalization, `sudo -n true` as `alphaclaw` fails and the general
   sudoers file is absent.
3. After finalization, `alphaclaw.service` still runs as `User=alphaclaw`, has
   `NoNewPrivileges=false`, and `sudo -n id -u` returns `0`.
4. The agent can install and remove a harmless test package, create/start/stop/
   remove a temporary systemd service, and create/run/remove a temporary system
   cron entry.
5. A fresh explicit `direct` clawctl provision, a `mediated` provision, and a
   no-gateway provision retain `NoNewPrivileges=true` and never receive the
   general sudoers rule.
6. A rendered-asset test proves the grant is based only on the root-owned
   provisioning record and occurs before setup-only privileges are revoked.
7. Gateway durable-secret scans and the enforced direct-bypass test still pass
   after privilege activation.

## Release sequence

1. Land the clawctl host-asset implementation and tests on `main`.
2. Publish one clean content-addressed bundle and pin it to TeamYou beta only.
3. Run the fresh-provision acceptance above.
4. Promote the identical bundle SHA to the stable pin after owner sign-off.

