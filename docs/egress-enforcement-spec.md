# Workload Egress Enforcement Spec

**Status:** Draft for review — 2026-08-21
**Scope:** clawctl, alphaclaw, teamyou, agent-vault
**Goal:** Verifiable network isolation of the OpenClaw workload (CPX31) that a fully privileged (root) agent on the workload cannot defeat. This is the prerequisite for granting the OpenClaw agent escalated privileges (sudo, system crons, package installs).

---

## 1. Why this exists

The dual-VPS architecture moved the *identity and credential* trust anchors off the
workload: the CPX11 gateway exclusively holds the tailnet identity, Serve/Funnel
exposure, the mTLS client key, and the Agent Vault. Credential brokering is
**implemented and shipped**:

- TeamYou provisioning installs the Agent Vault binary on CPX11 and seeds the real
  TeamYou credential there (`teamyou/lib/workflows/openclaw-provisioning/steps/install-gateway.ts`);
  the raw secret never rests on the workload.
- clawctl installs a persistent SSH tunnel (`alphaclaw-agent-vault-tunnel.service`)
  forwarding workload loopback `14321` → vault API (`9091`) and `14322` → vault MITM proxy.
- AlphaClaw injects the proxy environment into the OpenClaw runtime child at spawn
  (`alphaclaw/lib/server/gateway.js:61` via
  `alphaclaw/lib/server/agent-vault/runtime-store.js`): `HTTP(S)_PROXY` →
  `127.0.0.1:14322` with the vault token as proxy auth, the MITM CA in
  `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE` /
  `GIT_SSL_CAINFO` / `DENO_CERT`, and `TEAMYOU_API_KEY` set to a placeholder the proxy
  swaps in flight.

What is **not** implemented is the enforcement half recorded as *planned* in
`alphaclaw/docs/security-architecture.html` ("CPX31 egress allowlist to CPX11",
"PipeLock scans outbound payloads", "Direct upstream internet denied"):

- Every Hetzner firewall rule builder in both provisioning implementations emits
  only `direction: 'in'` rules (clawctl `create-instance-service.ts`; teamyou
  `security-gateway.ts`, `ensure-gateway-firewalls.ts`). Under Hetzner semantics,
  zero outbound rules = all outbound allowed.
- No host-level firewall exists in any host asset or cloud-init template.
- Provisioning affirmatively asserts the workload keeps its own public default
  route (`buildPrivateVerificationCommand()` in clawctl).
- The vault runtime schema accepts mode `"brokered" | "enforced"`
  (`runtime-store.js:12`) but nothing consumes `"enforced"`.

Consequence: the proxy is **cooperative**. Any process on the workload can unset
`HTTPS_PROXY` (or open a raw socket) and reach the internet directly, today, as the
unprivileged user. Brokering protects secrets; it does not constrain egress.

### Threat model

Assume arbitrary code execution on the workload — the agent ingests untrusted
input (email, web content, webhooks), so prompt injection makes this a standing
assumption, and the planned privilege escalation upgrades it to arbitrary *root*
execution. The design requirement follows directly:

> No control that lives on the workload can be load-bearing. Enforcement and
> verification must both live where the agent has no privileges: the Hetzner
> control plane and the CPX11 gateway.

---

## 2. Design invariants

1. **Enforcement outside the VM.** The only egress permitted by the Hetzner cloud
   firewall is the path to CPX11. Host firewall rules on the workload are never
   load-bearing (root flushes them). nftables on the *gateway* is load-bearing and
   required.
2. **No Hetzner API credential ever on the workload.** Holds today (clawctl and
   TeamYou drive the API). This is the keystone: with it, a root agent cannot
   modify its own firewall. Add an explicit provisioning test for it.
3. **Every bypass fails closed.** A root agent can rewrite routes, resolv.conf, CA
   trust, proxy env — each bypass must terminate in dropped packets or TLS
   failure, never in unmediated egress.
4. **Verification from outside, continuously.** Ruleset attestation via the
   Hetzner API is authoritative; behavioral canaries are defense in depth.
5. **Honest guarantee.** This buys "all egress is mediated, logged, and
   policy-controlled at a point the agent cannot reach" — not "exfiltration is
   impossible." An agent allowed to browse the web through the mediated path can
   still move data out through it. Scanning and policy tiers attack that; the
   firewall does not.

---

## 3. Architecture: routing, not proxy-teaching

Proxy environment variables only cover software that honors them. The general,
config-free mechanism is L3: **CPX11 becomes the workload's default route and NATs
its traffic.** Arbitrary user-installed binaries need zero configuration; their
packets simply transit the gateway.

| Layer | Lives where | Root agent can defeat? | Job |
| --- | --- | --- | --- |
| Hetzner FW outbound deny (workload public iface) | Hetzner control plane | No — no API token on box | Isolation guarantee |
| NAT + nftables + resolver + flow logs | CPX11 | No — no access to gateway | Capture, policy, visibility |
| Transparent bump proxy + PipeLock (Phase 3) | CPX11 | No | Payload scanning, fail-closed |
| Vault proxy env on OpenClaw/AlphaClaw processes | Workload | Yes — but bypass degrades to the layers above | Credential injection only |

Each layer degrades to the one above it, never to "open."

### 3.1 Workload (CPX31)

- Default route → gateway private IP (private network, MTU 1450).
- Public interface goes **dark** in the enforced phase:
  - Inbound: none. Post-finalize, all ingress arrives via CPX11 over the private
    net; the public bootstrap route is retired (see §6 Phase 3 — this also kills
    the stale bootstrap-cert/DNS impersonation risk).
  - Outbound: deny-all. Hetzner requires ≥1 outbound rule to trigger default-deny;
    use a sentinel rule (e.g. ICMP to the gateway public IP). Must hold for IPv4
    **and** IPv6.
- Keep the public IP attached (rescue console access, no re-plumbing), but dark.
- No public DNS: CONNECT-style and NAT'd flows resolve via the gateway resolver;
  hosts-file entry for the gateway itself. Removing direct port-53 egress closes
  the DNS-tunneling channel.
- NTP via chrony on the gateway private IP.

### 3.2 Gateway (CPX11)

- `ip_forward=1`, masquerade on the public interface.
- nftables (load-bearing here):
  - Forward chain default-deny; accept only from the workload's private IP,
    destined to the public internet. **Never** forward into the tailscale
    interface, never between private-net peers.
  - MSS clamp on forwarded TCP (private net MTU 1450 — without clamping, NAT
    produces mysterious hangs on large responses).
  - Redirect forwarded port 53 to the gateway's own logging resolver (unbound),
    so even a workload pointed at 8.8.8.8 gets the logged resolver.
  - Optional/Phase 3: block forwarded UDP 443 to force QUIC down to TCP where
    payload scanning can see it; block outbound SMTP (25/465/587) from day one —
    nothing legitimate uses raw SMTP (email goes through Google APIs via gog).
  - Rate limits on the vault/proxy ports; private-IP listeners bound only to the
    workload's private address.
- Services: existing Agent Vault (unchanged) + unbound (logging resolver) +
  chrony. Phase 3 adds the transparent bump proxy.
- Gateway public egress stays open (it is the trusted box); its inbound rules are
  unchanged (UDP 41641 only).
- Capacity: NAT for one host is trivial; CPX11's 20 TB/month allowance dwarfs
  agent traffic. This is a monitoring problem, not a capacity one.

### 3.3 What stays cooperative (and why that's now fine)

The vault proxy env on the OpenClaw/AlphaClaw processes remains exactly as today,
for credential injection only. Credentialed flows go *explicitly* to the vault
over the loopback SSH tunnel — they never touch the gateway's forward path, so
later transparent scanning never double-MITMs them. A process that strips the
proxy env loses brokered credentials and its traffic still transits the gateway
NAT. Clean separation by construction.

### 3.4 Design decisions this reverses or amends

- **"The gateway never installs … NAT, a subnet router, or an exit node"**
  (clawctl `docs/provisioning-setup-lifecycle.md`). Deliberately amended, with
  the history understood. Git archaeology: the sentence landed 2026-07-27
  (clawctl `6dd2d54`) and originally also listed *AgentVault* among the things
  the gateway never installs — a clause overtaken one week later when the
  vault-on-gateway bootstrap shipped (2026-08-03, then TeamYou's
  `install-gateway` step 2026-08-11), so the sentence was a design snapshot,
  not a maintained invariant. Its NAT/subnet-router/exit-node trio encoded a
  real intent — **the gateway must never become a routing bridge into the
  customer's tailnet** — and was consistent with the enforcement mechanism
  planned at the time (explicit vault proxy, which terminates connections and
  forwards no packets). Rejecting per-app proxy-teaching (fail-closed but an
  unbounded compatibility tax on user-installed binaries) is what moves
  enforcement from L7 to L3 and requires forwarding. The amendment preserves
  the original intent completely: CPX11 forwards *only* workload private IP →
  public internet, drops anything touching the tailscale interface in either
  direction, default-denies the rest. The gateway remains unreachable from the
  internet and holds the same secrets as today. The lifecycle doc has been
  reworded (2026-08-21) to state the intent rather than the mechanism, and the
  attestation job should assert it directly: no advertised routes, no
  exit-node flag, expected forward-chain policy.
- **Provisioning topology assertions become phase-conditional.**
  `buildPrivateVerificationCommand()` currently asserts forwarding disabled on
  both hosts and default route not via peer. In the enforced phase these invert
  for gateway/workload respectively.
- **Single-proxy consolidation rejected (for now).** Verified against the
  agent-vault source: the vault proxy MITMs every CONNECT unconditionally
  (`internal/mitm/connect.go` — `ca.MintLeaf` on every tunnel; no
  splice/passthrough path) and is HTTP/1.1-only by design
  (`internal/mitm/proxy.go`). Routing all system traffic through it would require
  CA trust in every client, break cert-pinning software, and cap traffic at
  HTTP/1.1. With NAT, system traffic needs no forward proxy at all, so no vault
  changes are required. (Role separation for a future management token exists
  today: `roleRank = {proxy, member, admin}` + owner, `internal/server/server.go:640`.)
- **Vault cannot be a transparent proxy as-built:** it authenticates via
  `Proxy-Authorization` on the CONNECT, which transparent interception doesn't
  have. Scanning therefore gets its own component (§4), beside the vault, not
  inside it.

---

## 4. Egress scanning

Scanning layers onto the NAT path in two tiers. The polarity difference from
proxy-teaching is the point: an untaught binary under proxy-env **leaks silently**
(fails open); an untaught binary under transparent interception **breaks loudly**
(fails closed). Coverage is enforced; compatibility is a checklist.

### Tier 1 — passive metadata (Phase 2, near-free once NAT exists)

Runs on the gateway forward path; zero workload cooperation; covers every binary
ever installed; nothing a root agent can dodge:

- conntrack/flow logs (destination, port, volume, duration);
- DNS query logs from the forced resolver;
- TLS SNI + JA3 fingerprints via passive tap (Suricata/Zeek);
- volumetric and beaconing anomaly alerts ("workload just sent 4 GB somewhere").

### Tier 2 — payload scanning via transparent MITM (Phase 3)

To see inside TLS you must terminate it — physics, not architecture.

- nftables on the **gateway** redirects forwarded :443 into a bump proxy
  (squid ssl_bump / mitmproxy / envoy) presenting certs from the MITM CA;
  decrypted streams go to the scanner (PipeLock's insertion point, via ICAP or
  equivalent).
- Programs need **no proxy configuration** (interception is invisible at the
  addressing level). They need to **trust the CA**:
  - system trust store (`update-ca-certificates`) covers curl, wget, Go, and most
    compiled software;
  - bundled-store runtimes need the env set AlphaClaw already exports
    (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`,
    `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `DENO_CERT` —
    `runtime-store.js:213`) promoted to `/etc/environment`;
  - Java keystore if ever needed.
- A binary that doesn't trust the CA gets a TLS error — visible in gateway logs,
  not a leak. A root agent stripping CA trust only breaks its own connectivity.
- Residue, accepted and documented: cert-pinning clients need a maintained splice
  allowlist (payload-unscanned but still under Tier 1 metadata and destination
  policy); forwarded UDP 443 blocked to force QUIC → TCP.
- Vault-brokered flows are already plaintext inside the vault's own MITM; if
  scanning of those flows is wanted later, it's a feature inside the vault, not a
  topology change.

---

## 5. Verification (the "verifiable" in verifiable isolation)

1. **Ruleset attestation (authoritative).** A TeamYou reconcile job reads the
   workload firewall via the Hetzner API on a schedule, canonicalizes and hashes
   the rules, compares against the policy stored with instance metadata, alerts
   and auto-repairs drift. Drift is the only way isolation silently fails, and
   the agent has no lever over it.
2. **Enforcement-flip proof.** At flip time the control plane: (a) confirms the
   API-side ruleset; (b) port-scans the workload public IP from outside expecting
   silence (v4 and v6); (c) runs a before/after direct-egress probe through the
   normal agent channel demonstrating the flip took effect.
3. **Behavioral canary (defense in depth).** Periodically ask the workload to
   fetch a TeamYou-controlled public URL *without* the proxy/NAT path. Success =
   leak alarm. (A malicious root agent can fake failure — fine; the canary
   catches accidental regressions, attestation defeats deliberate ones.)
4. **Flow visibility.** Vault + gateway logs are the audit trail, tamper-proof
   from the workload's perspective.

### Residual channels (accepted, documented)

- Exfil through allowed destinations via the mediated path — mitigated by policy
  tiers/PipeLock/logging, not by the firewall.
- Attacks against CPX11's private listeners — mitigated by gateway nftables,
  listener binding, auth, rate limits, patching. (Hetzner cloud firewalls do not
  filter private-network traffic; the gateway protects itself.)
- Low-bandwidth side channels through the mediated path (timing, DNS labels via
  the logged resolver) — accepted.
- Hetzner metadata endpoint (169.254.169.254) — verify stage-zero cloud-init
  user-data contains no secrets; it is readable by any process on the workload.
- Gateway-down now means workload fully offline (today: only brokered credentials
  fail). Accepted cost of the guarantee; alphaclaw doctor/watchdog must report
  "gateway unreachable" as a distinct loud state.

---

## 6. Rollout phases

**Phase 0 — spike + doc fixes (days).**
- Throwaway Hetzner pair: confirm cloud firewalls don't filter private-net
  traffic and are stateful; confirm server-as-next-hop works (`ip route`,
  masquerade, MSS clamp, curl through NAT); confirm outbound default-deny
  semantics incl. IPv6.
- Update `security-architecture.html` status markers (vault items shipped;
  this spec supersedes the egress PLAN items). Done 2026-08-21: clawctl
  `docs/provisioning-setup-lifecycle.md` reworded to state the no-tailnet-bridge
  intent instead of the "no NAT" mechanism and to drop the stale AgentVault
  clause.

**Phase 0 results (executed 2026-08-21).** Run against a throwaway
`egress-spike-*` pair (cpx11 × 2, ubuntu-24.04, hil; created and destroyed the
same session; runbook: clawctl `scripts/egress-spike-runbook.md`):

| # | Result | Evidence |
| --- | --- | --- |
| A1 | **PASS** — inbound-only rules leave outbound default-allow | v4+v6 curl succeeded with in/tcp-22 firewall attached |
| A2 | **PASS** — one outbound rule flips to default-deny, v4 **and** v6 | sentinel (ICMP→gw/32) passed; curl v4/v6 timed out; ICMP to 1.1.1.1 blocked (deny is per-destination even within the allowed protocol) |
| A3 | **PASS** — private-net traffic unfiltered under outbound deny | ping + TCP/22 to peer private IP succeeded |
| A4 | **PASS** — stateful | fresh inbound SSH over public IP worked under outbound deny |
| A5 | **PASS** — documented NAT pattern works as-is | `hcloud network add-route 0.0.0.0/0 --gateway <gw-priv>` + workload `default via 10.99.0.1` (fabric router); egress showed gateway public IP; nft forward/masquerade counters confirmed. Peer traffic is L3 via `.1` (ttl 63) — not shared L2; the `onlink` fallback was never needed |
| A6 | **QUALIFIED** — MSS clamp not required in this topology | workload originates on `enp7s0` (MTU 1450) so it advertises MSS 1410 itself; 100 MB transferred at ~500 MB/s with and without the clamp. Keep the rule as free insurance against interface-MTU misconfiguration, but it is not load-bearing |
| A7 | **PASS** — bypass fails closed | with deny + NAT active: mediated curl OK; simulated root bypass (`default via 172.31.1.1` restored) timed out on v4, v6, and ICMP; restoring the mediated route recovered instantly |

Additional findings for Phase 1 design:
- A forced DHCP renewal on the gateway did **not** deliver the `0.0.0.0/0`
  network route back to it — no routing-loop risk observed. Delivery of that
  route to the *workload* via DHCP was not tested (we set its default
  manually); Phase 1 should set the workload default route explicitly
  (netplan/cloud-init) rather than relying on DHCP push.
- Private interface is `enp7s0` (MTU 1450), public `eth0` (MTU 1500), matching
  assumptions.
- SSH via ProxyJump through the gateway remained stable across every route
  flip — confirming it as the operator-access pattern for enforced instances.

**Phase 1 — cooperative routing (no firewall change, fully reversible).**
- Gateway: enable NAT, forward chain, resolver, chrony, MSS clamp, flow logging.
- Workload: add default route via gateway alongside open egress; point
  timesyncd/resolv.conf at gateway.
- Soak: gateway flow logs now show the complete traffic inventory for free.
  Verify nothing important still goes direct.
- alphaclaw: consume the `enforced` runtime mode — apply vault env to the
  AlphaClaw server process itself (today only the OpenClaw child gets it at
  `gateway.js:61`; the server's own TeamYou/webhook calls must not break at
  flip). Doctor/watchdog surfaces enforcement + gateway-reachability state.

**Phase 1 soak results (first mediated provision, executed 2026-08-21).**
`alphaclaw-egress-soak-1` (clawctl `claude/egress-phase1`, dedicated Hetzner
project, SSH asset delivery): provision completed exit 0 with all mediated
verification gates passing. Independently verified: workload egress shows the
gateway's public IP; metric-0 fabric-router default beats the DHCP default;
source-policy rule keeps public-IP sessions working (bootstrap URL serves,
SSH stable through the flip); `ALPHACLAW_EGRESS_MODE=mediated` in ENV_FILE;
gateway `ip_forward=1` with IPv6 forwarding off; natgw counters live (15.5 MB
established in-bootstrap); `alphaclaw-natgw-new` flow logs show real
destinations; `egress_mode: mediated` in registry + status output; **both
hosts survive reboot** (route unit re-applies; nftables include reloads;
vault tunnel recovers). Timeline: the route flip landed immediately before
the npm installs, which rode the NAT with zero timeout/retry evidence — the
theoretical flip-before-gateway-ready race did not occur (earlier bootstrap
phases give the gateway a multi-minute head start), but a cheap hardening
remains open: have `alphaclaw-egress-route` probe egress through the gateway
post-flip and alarm if dark. Instance left running as the flow-log soak.
**Destroyed 2026-08-23** via `clawctl destroy` as the first teardown test of
the mediated topology: workload, gateway, private network (incl. the
`0.0.0.0/0` route), Doppler secret, both DNS records, and the TeamYou API key
all removed with zero orphaned resources; shared firewalls correctly
survived. The successor soak is the enforced instance.

**Phase 2 design decisions (2026-08-21, at implementation start).**
1. **Correction to §6 Phase 1's alphaclaw item:** under the NAT architecture,
   the flip breaks nothing on a mediated workload — the cloud-firewall deny
   only affects direct public-interface egress, and mediated instances route
   everything via the private net, which Hetzner firewalls do not filter. The
   AlphaClaw `enforced`-mode consumption (server vault env, doctor state) is
   therefore **observability work, not a flip prerequisite**.
2. **Egress mode becomes three-valued:** `direct | mediated | enforced`, where
   `enforced` = mediated routing **plus** the cloud-firewall outbound deny.
   One field everywhere (CLI flag, env, metadata, ENV_FILE) instead of a
   separate boolean.
3. **Flip timing for new instances:** during provisioning, immediately after
   `verifyGatewayConnectivity` passes — everything after the bootstrap route
   flip already rides the NAT (proven by the soak), and early-bootstrap
   direct traffic (apt) happens before the swap. Rollback remains one API
   call (restore the standard ruleset).
4. **Enforced ruleset:** inbound unchanged for now (bootstrap 80/443 retire
   in Phase 3); outbound = single sentinel allow (ICMP to the gateway public
   IP) to trigger Hetzner default-deny for everything else, both families.
5. **IPv6 note:** the workload keeps a public IPv6 default; after the flip,
   v6-preferring clients rely on happy-eyeballs fallback to v4-via-NAT.
   Watch for latency artifacts in the soak; if visible, drop the v6 default
   route on enforced workloads.

**Phase 2 — the flip (per instance, rollback = one API call).**
- TeamYou workflow step `enforce-egress`: swap workload firewall to enforced
  ruleset via Hetzner API; set vault runtime mode `enforced`; bump connectivity
  metadata (state `egress_enforced`); enroll in attestation reconcile.
- Run flip-proof checks (§5.2). Enable Tier 1 scanning + canary.
- **Scope (decided 2026-08-21): new instances only.** Existing-instance
  migration is explicitly out of scope for Phases 1–3 — the fleet converges as
  instances are provisioned mediated. Revisit migration as its own
  larger-scale effort later; nothing in these phases may assume the reconcile
  or upgrade paths understand egress modes.
- clawctl: `egress enforce|status|verify` for CLI-managed instances; bootstrap
  templates write proxy/NTP/resolver config (dormant until flip); topology
  assertions become phase-conditional.

**Phase 2 live results (first enforced provision, executed 2026-08-21).**
`alphaclaw-egress-enforced-1` (clawctl `claude/egress-phase1`, test project):
provision exit 0 with the flip executed and proven **as a provisioning gate**
— after connectivity verification, the shared
`clawctl-egress-enforced-outbound-deny` firewall was created and applied, and
the SSH flip-proof asserted mediated egress via the gateway with a simulated
direct route timing out at the cloud firewall. Independently verified via the
Hetzner API: the shared firewall holds exactly the TEST-NET-1 sentinel rule
and is attached to exactly the enforced workload; the `0.0.0.0/0` network
route is present; the bootstrap URL still serves under the deny (302),
proving inbound + source-policy routing survive enforcement. Reboot
persistence needs no separate test: the deny is cloud-side by construction.

**Phase 3 — tighten.**
- Retire public inbound 80/443 + bootstrap Caddy cert renewal; delete bootstrap
  DNS record (kills the stale-cert impersonation risk).
- Transparent bump proxy + PipeLock payload scanning; CA distribution checklist;
  splice allowlist for pinned clients; block forwarded UDP 443.
- Per-destination policy tiers in gateway policy (system allowlist vs agent
  browsing vs credentialed services).

**Phase 4 — agent privilege escalation (separate spec).**
- Only after Phase 2 is attested fleet-wide. The escalation's two biggest
  root-payoffs (exfil at will, abuse-as-a-service) are amputated at the cloud
  layer by then. Remaining pre-escalation items tracked in §7.

---

## 7. Open questions / decisions for Bill

1. **Browsing policy:** agent web egress unrestricted-but-logged through the
   mediated path (recommended initially; deny-list hook exists from day one) vs
   an allowlist (support burden, arms race).
2. **Bump-proxy choice for Phase 3:** squid ssl_bump vs mitmproxy vs envoy —
   pick during Phase 3 design, driven by PipeLock's preferred integration (ICAP
   vs script hook).
3. **Scope of Tier 1 alerting:** what volume/destination anomalies page a human
   vs land in a digest.
4. **Existing-fleet migration order** and comms for the brief flip window.
5. **Management-role vault token** for AlphaClaw server traffic (supported by
   vault roles today) — Phase 1 or Phase 3.
