# Meta Muse vs. Clawbridge dual-VPS: security architecture comparison

**Date:** 2026-09-16
**Source:** Meta, "How We Built Safety Into Muse" (research.meta.ai, 2026-09-08, Tarek Sheasha)
**Our side:** alphaclaw, clawctl, teamyou at HEAD on 2026-09-16 (alphaclaw 0.9.18-starfoundry.20-beta.5, OpenClaw 2026.7.1 pinned)
**Question asked:** Does Muse use one VM with layered isolation while we use two VMs on a private network? Is our second server still justified given its cost and complexity?

---

## 1. Verdict in five sentences

1. **Confirmed:** Muse is one VM per user. The article says so directly: "two isolated security domains on one box, not an LLM powered agent with root." The agent runs in a `systemd-nspawn` cell; Sentinel, the credential daemon, the safety classifiers, and the connector workers are ordinary systemd units on the same kernel.
2. **Our isolation boundary is stronger than Muse's; our policy layer is far weaker.** We separate trust domains with a hypervisor and a cloud firewall the agent cannot reach. Muse separates them with kernel namespaces and seccomp on a shared kernel. But Muse authorizes every connector action and every network request per-request with a human in the loop where it matters. We authorize nothing per-request: OpenClaw runs in YOLO exec mode, there is no approval flow for actions or destinations, and no prompt-injection detection.
3. **The second server is justified, and it is the only non-cooperative control we have.** The moment we granted the agent passwordless root (Phase 4, approved 2026-09-01), every on-workload control became cosmetic. Credential custody, egress mediation, and attestation all hold *only* because the gateway is a different machine. Collapsing to one VM would require taking root back and rebuilding the OpenClaw harness into a Muse-style cell, which is more engineering than the gateway cost us.
4. **The value is under-realized today.** We built the wall but not the gate: the gateway NATs to any destination, logs only 5-tuples, has no DNS logging, no L7 policy, no payload scanning, and no ask-the-user path. Our own spec calls this the "honest guarantee": mediation, not exfiltration prevention. Muse's Sentinel is what our Phase 3 was always going to be.
5. **Cost is modest in money and real in complexity.** The gateway adds roughly 28 to 38 percent to per-instance compute (table in §6). The complexity cost (dual-host provisioning, forced-command protocols, upgrade choreography, gateway-down means offline, MITM incompatibilities) is the price we actually pay, and it is documented and largely already sunk.

---

## 2. What Muse actually is (from the article)

Muse gives each user a dedicated cloud VM. Inside that one VM:

**Runtime cell (untrusted domain).** A `systemd-nspawn` container holding the Hatch harness, the user's workspace and files, and every binary the agent runs. Cell root maps to an unprivileged host user. It has its own Debian rootfs, a veth network interface, a syscall filter (no `io_uring`), and dropped capabilities (no `CAP_SYS_PTRACE`, no `CAP_NET_ADMIN`).

**Host-side services (trusted domain), each a separate systemd unit on the same kernel:**

| Unit | Role |
| --- | --- |
| `hatch-safety` | Independent models and classifiers inspecting inference requests and responses (frontier risk, prompt injection) |
| privsep workers | Execute built-in connector business logic outside the cell with per-worker credential allowlists keyed by cgroup |
| `hatch-authd` | Credential store (OAuth tokens live in the VM, not central Meta infra) and credential surrogation |
| Sentinel | Sole permission authority for connector actions and all network egress |
| postgres | Durable app state, outside the cell and outside the credential store |
| inference and telemetry proxies | Constrained paths to Meta infrastructure |

Cell-to-host communication is Unix domain sockets with `SO_PEERCRED` and peer ACLs: kernel-authenticated IPC with no secrets to steal.

**Sentinel mechanics.**
- Connector calls: the cell submits {connector, method, action class, scope, user context}; Sentinel generates a user-visible purpose and evaluates the user-set connector policy to allow, deny, or ask.
- Network egress: all cell traffic reaches Sentinel via a forward proxy pinned by userns, veth boundaries, and eBPF filtering. Sentinel evaluates L4 and L7: hostname, resolved and final IP, port, protocol, HTTP method, path, decoded request. SSRF checks catch public hostnames that resolve to private ranges.
- Just-in-time credential insertion: cell code only ever sees a "surrogate" token minted by authd. After authorization, Sentinel swaps the surrogate for the real credential at the network boundary.
- Tainted egress: each tool process starts clean and becomes tainted when it reads user data (eBPF cgroup programs plus LSM hooks Meta added). Clean requests to a narrowly bounded auto-allow list pass silently; tainted or unverifiable processes lose auto-allow and fall back to approval.
- Human in the loop: approvals go to the client UI directly, not through the conversation, and come back to Sentinel directly. Grants are capabilities bound to connector, destination, and use case, with one-time, session, task, time-bounded, or perpetual scope.

**Defense in depth against prompt injection.** Model trained to resist injection (Muse Spark 1.3); external data labeled untrusted in the harness; an ensemble of injection classifiers over all files and tool results entering context; human approval for data-moving actions; and deterministic boundaries beneath all of that (cell, privsep, authd ACLs, Sentinel).

**Browser.** Chromium "behind a virtualization layer" (the article does not say whether that is a nested VM or something like gVisor; either way it is inside the user's VM). CDP access sits in a broker outside the cell. The browser sub-agent sees an accessibility tree, not the DOM, cannot run JavaScript, and is paused while the user drives or while the credential store fills a form. Separate classifiers watch for personal-data egress, injection in DOM, images, or downloads, and high-risk form submits. Meta's malicious-site lists are matched inside the VM.

**Connector hygiene.** The email connector strips one-time passcodes, password-reset links, and magic links with deterministic filters plus a classifier. Read and write access are separated below OAuth scope granularity. Purchases use single-use cards bound to merchant, amount, and time, with approval every time.

**Not yet:** "Muse Confidential VM" (cryptographic attestation that Meta cannot read the VM) is planned for later this year. Today Meta can access the VM under operational policy.

---

## 3. What we actually run (as built, 2026-09-16)

Two VMs per instance on a provider private network, provisioned by clawctl or the TeamYou workflow:

**Workload (CPX31 on Hetzner; `s-4vcpu-8gb` on DigitalOcean, which is now TeamYou's default placement).** Runs alphaclaw and the OpenClaw runtime as the `alphaclaw` user under a systemd unit with only `NoNewPrivileges` and `PrivateTmp` (`clawctl/assets/host/alphaclaw.service`). On the enforced tier, finalization installs `alphaclaw ALL=(ALL:ALL) NOPASSWD: ALL` and flips `NoNewPrivileges=false` (`clawctl/assets/host/alphaclaw-host-finalize-setup.sh:53-74`). The workload holds no Tailscale identity, no Hetzner or DigitalOcean credential, no TeamYou API key, no model API keys, and no OAuth refresh tokens. It does hold: the Agent Vault runtime token (in `HTTPS_PROXY` as proxy auth, `alphaclaw/lib/server/agent-vault/runtime-store.js:190`), short-lived OAuth access tokens, bootstrap secrets (`env-classification.js:1-9`), and the entire agent workspace and memory in plaintext.

**Gateway (CPX11 / `s-2vcpu-2gb`).** Holds the Tailscale node identity (Serve on 443, Funnel on 8443), the mTLS client key, the Agent Vault (Infisical `agent-vault` v0.32.0) with all brokered secrets, the OAuth refresh broker, and the Tier C keystore KEK. Every listener binds to loopback; public exposure is UDP 41641 plus 80/443 for the bootstrap hostname. The workload reaches the vault through a persistent SSH tunnel to a `restrict,port-forwarding` key; the OAuth broker and keystore custody are separate forced-command keys.

**Egress.** Workload default route points at the gateway. Gateway nftables (`clawctl/src/services/security-gateway-assets-service.ts:699-713`): forward chain `policy drop`, accept established, accept `ip saddr <workload> oifname eth0 ct state new log prefix "alphaclaw-natgw-new"`, masquerade. That is the whole ruleset: any destination, any port, one journald line per new flow. On Hetzner, a sentinel outbound rule on a shared cloud firewall flips the workload's public interface to default-deny. On DigitalOcean, the workload is a Private Droplet with no public interface at all (`egressPosture: 'structural'`, `teamyou/lib/services/openclaw-provisioning/provider/types.ts`). TeamYou attests the Hetzner firewall hourly via the API and repairs drift.

**Credential brokering.** Model API keys, the TeamYou key, and Tier S channel tokens exist on the workload only as `__agent_vault_*__` placeholders; the vault MITM proxy on the gateway substitutes the real value in flight. OAuth refresh tokens (Codex, Claude CLI, gog) are deposited to the gateway broker and scrubbed locally; the workload leases access tokens. Tier C material (WhatsApp, Signal keystores) can only be sealed at rest under the gateway KEK; WhatsApp is shelved because the vault MITM breaks its Noise handshake.

**What does not exist.** Per-action approval (`exec-defaults-config.js:10` ships `security: "full", ask: "off"`, re-asserted on every boot; only plugin installs and new vault service grants ask a human). Prompt-injection detection or untrusted-content labeling. OTP or magic-link filtering on the Gmail path. Per-destination egress policy, DNS logging, L7 inspection, or payload scanning (PipeLock is planned, not built). A browser tool (OpenClaw bundles one; alphaclaw neither enables nor denies it, and no Chromium is installed). Container or nspawn confinement for tool execution (OpenClaw's docker sandbox is off and alphaclaw never configures it).

---

## 4. Side-by-side

| Dimension | Muse (one VM) | Clawbridge (two VMs) | Edge |
| --- | --- | --- | --- |
| Trust boundary | Kernel namespaces, seccomp, capability drops, eBPF; one kernel | Hypervisor plus provider network fabric plus cloud control plane; workload kernel fully untrusted | **Ours** (stronger boundary) |
| Agent privilege | Unprivileged; cell root is not host root; no `CAP_NET_ADMIN`, no ptrace | Passwordless root on the enforced tier | Muse (least privilege); ours by design accepts root |
| Credential custody | authd surrogate tokens swapped at egress; connector code runs in privsep workers outside the cell | Vault placeholders substituted at the gateway MITM proxy; connector code (gog, channel plugins) runs on the workload | Roughly equal for static keys; Muse better for connector logic and OAuth access tokens |
| Per-use authorization of a credential | Sentinel policy plus taint plus HITL on every request | None: the runtime token authorizes every approved service unconditionally | **Muse** |
| Egress enforcement | Forward proxy pinned by userns/veth/eBPF; policy at L4 and L7 including resolved IP and decoded request | NAT default-deny-to-gateway; cloud firewall or no public NIC; any destination allowed; 5-tuple logs only | Ours for *can't bypass*; **Muse** for *what is allowed* |
| Action approval / HITL | Sentinel ask-the-user with scoped grant types, delivered outside the chat | None (YOLO exec). Vault service grants are the only human gate, and they are perpetual | **Muse** |
| Prompt-injection defense | Model training, untrusted labeling, classifier ensemble, browser classifiers, email OTP filtering | None | **Muse** |
| Data exfiltration through allowed paths | Taint tracking forces approval on user-data-carrying requests | Unmitigated (spec's own "honest guarantee") | **Muse** |
| Browser | CDP broker outside cell, a11y tree only, no JS, paused during credential fill, malicious-site matching | Not shipped; not policy-disabled; a root agent could install one unisolated | Muse |
| Connector hygiene | Read/write split below OAuth scopes; OTP and reset-link stripping | Provider-side scopes only | Muse |
| Purchases | Single-use cards, per-purchase approval | n/a | n/a |
| Verification | Continuous agentic red-teaming; public bug bounty up to $300k | Hourly cloud-firewall attestation via provider API; flip-proof at provision; canary | Different aims; ours verifies the boundary, Muse verifies behavior |
| Blast radius of a boundary failure | Cell escape yields the whole VM: authd, Sentinel, postgres, credentials | Hypervisor escape is the equivalent; gateway private listeners are the realistic surface | **Ours** |
| Availability coupling | One VM, no split-brain | Gateway down means workload offline (accepted cost; "gateway unreachable" state still parked) | Muse |
| Compatibility | Meta controls the harness and connectors | Upstream OpenClaw plus user binaries; MITM breaks Noise (WhatsApp), cert pinning, HTTP/2 | Muse |
| Who can read your data | Meta, under operational policy (Confidential VM planned) | Customer-owned VPS; TeamYou control plane holds provider tokens; operator SSH via tailnet | Ours today, Muse later |
| Compute cost | One VM | Two VMs, +28 to 38% | Muse |

---

## 5. Where each approach is better or worse

### 5.1 The boundary: hypervisor beats shared kernel

Muse's cell is a container. Its guarantees rest on the Linux kernel correctly enforcing user namespaces, seccomp, and capability bounds against code that is, by assumption, adversarial. Meta shrinks the surface (no `io_uring`, no ptrace) and keeps `CAP_NET_ADMIN` away from the cell so eBPF egress hooks cannot be unloaded, but a kernel privilege escalation from the cell lands on the same kernel that runs authd, Sentinel, and postgres. This is the standard reason Firecracker and gVisor exist. Meta can afford this trade: they patch fast, run classifiers as a second line, and control the entire harness.

Our workload is a whole VM the agent already owns as root. A kernel exploit there gains nothing. To reach the trusted domain an attacker must break the hypervisor or attack the gateway's private-network listeners: OpenSSH with three `restrict` forced-command keys, a Caddy mTLS bridge, and the vault API and MITM ports reached only through the tunnel. That is a much smaller surface than a shared kernel, and the cloud firewall and DigitalOcean's missing public NIC are enforced by a control plane whose credentials exist on neither machine. The attestation code states the model precisely: a root agent cannot cause firewall drift because no provider credential exists on the workload or gateway.

**Assessment:** the premise behind the dual-VPS decision (a separate server is the safest way to get a true sandbox around a fully hostile workload) is correct, and it is *more* correct for us than for Meta because we chose to give the agent root. Muse could not give its agent root without losing everything; we can, because nothing on the workload is load-bearing.

### 5.2 Credential custody: same idea, we stop earlier

Muse's "surrogate token" is our `__agent_vault_*__` placeholder. Both designs let cell or workload code carry a worthless string that the trusted domain swaps for the real value at the network edge. That is a strong validation of the Agent Vault model.

Muse goes further in two ways. Built-in connector *logic* runs in privsep workers outside the cell with cgroup-keyed credential allowlists, so a prompt-injected agent cannot rewrite the Gmail CLI to misuse the Gmail credential. Ours runs gog and the channel plugins on the workload, where root can modify them, and OAuth access tokens are leased onto the workload for their lifetime. And Muse gates every *use* of a surrogate through Sentinel policy, whereas our runtime token unconditionally authorizes every approved service: any process on the workload can reuse it. Both are the accepted consequence of "agent owns the box"; the difference is that Muse compensates per-request and we do not.

Where we are ahead: refresh tokens never rotate through the workload (the gateway broker does the exchange), and the sealed-keystore KEK is on another machine. Muse stores credentials "in a separate isolated container in your VM", which is at-rest hygiene on the same kernel.

### 5.3 Egress: we guarantee the path, Muse guarantees the policy

Our enforcement is the stronger primitive: it lives in the provider fabric, it fails closed under a root bypass (spike A7), and it is attested from outside. Muse's enforcement is eBPF and veth on the same kernel as the agent.

But the gateway's forward chain accepts any destination on any port, logs only new-flow 5-tuples, has no resolver (DNS and Tailscale traffic bypassed the NAT via the public interface in the flow-log inventory), and performs no L7 inspection. Sentinel evaluates hostname, resolved IP, port, method, path, and decoded body, blocks SSRF to private ranges after resolution, and refuses to let tainted processes reach non-allowlisted destinations without a human. The "lethal trifecta" the article quotes (private data, untrusted content, ability to communicate) is fully present in our stack; our design removes *credentials* from the exfil set but not *data*. The flow-log inventory's "steady-state allowlist of about 6 destination classes" is exactly the input Phase 3 needs to close this.

### 5.4 Action authorization: the largest gap

Muse's central claim is that "Muse proposes actions, but only Sentinel can grant permission," with approval dialogs delivered outside the conversation so an injected agent cannot spoof consent, and grants scoped as one-time, session, task, time-bounded, or perpetual capabilities.

We ship OpenClaw in YOLO mode and re-assert it on boot. The only human gates are plugin install and vault service proposals, and a service grant is perpetual. If we turned on OpenClaw exec approvals, they would ride Discord, Telegram, or Slack chat, which is the channel Muse deliberately avoids. Nothing gates message sends, connector writes, or network destinations. Our AGENTS.md says "NEVER make risky system changes without approval," which is advice to the model, not a control.

### 5.5 Prompt injection: Meta invests heavily, we invest nothing

Model training, harness labeling, a classifier ensemble on every file and tool result, browser-specific classifiers, and email OTP stripping. We have none, and the Gmail push path forwards content untouched. Some of this is out of reach for a small team (training a model, a classifier ensemble). Some is cheap (deterministic OTP and reset-link filtering, untrusted-content framing in the harness, an LLM judge on inbound mail and web content).

### 5.6 Operational posture

Muse's single VM has no split-brain, no tunnel to keep alive, no dual-host upgrade choreography. Our documented costs are real: about 32 SSH round trips at provision, three keypairs of PKI, a 90 KB upgrade-and-migration plan, the milo incident caused by a bridge timeout on the gateway hop, gateway-down means the instance is offline, and MITM incompatibilities that shelved WhatsApp. Muse pays none of that. Muse instead pays for kernel-level engineering (custom LSM hooks, eBPF taint propagation) that we could not staff.

---

## 6. Is the second server justified?

### 6.1 Money

Per-instance monthly compute, list prices, excluding VAT and traffic overage:

| Placement | Workload | Gateway | Pair | Gateway share |
| --- | --- | --- | --- | --- |
| Hetzner US, legacy pricing (before 2026-06-15) | CPX31 $24.99 | CPX11 $6.99 | $31.98 | +28% |
| Hetzner US, current pricing | CPX31 $73.49 | CPX11 $20.49 | $93.98 | +28% |
| DigitalOcean (TeamYou default) | s-4vcpu-8gb $48.00 | s-2vcpu-2gb $18.00 | $66.00 | +38% |

Hetzner figures are from Hetzner's 2026-06-15 price adjustment notice; DigitalOcean from its droplet pricing page (per-second billing since 2026-01-01). Neither repo computes infrastructure cost anywhere; the only cost code is model-token spend.

Two levers exist if the number matters. The gateway runs Caddy, tailscaled, a Go vault, an SSH daemon, and (soon) a resolver; a `s-1vcpu-2gb` ($12) or `s-1vcpu-1gb` ($6) droplet may suffice and would cut the gateway share to +25% or +13% on DigitalOcean. Measure gateway RSS on the enforced instance before deciding. Sharing one gateway across instances is the other lever, and it is not recommended: it turns a gateway compromise into a multi-tenant incident and breaks the per-instance vault, KEK, and Tailscale identity model.

### 6.2 What a single-VM version would have to look like

To keep today's guarantees on one box you would need to rebuild along Muse's lines:

1. Take root back. Every current guarantee assumes the workload can be hostile at root; on one VM the trusted services would share that kernel.
2. Put OpenClaw and all tool execution in an nspawn or microVM cell with a user namespace, seccomp, dropped capabilities, and a veth-only network. This is the OpenClaw docker sandbox problem plus harness changes we do not control upstream.
3. Move enforcement from the cloud firewall to host nftables and eBPF in the host namespace, and verify the cell cannot reach them. The cloud firewall cannot distinguish cell traffic from host traffic, so the provider-side attestation we rely on stops meaning anything.
4. Re-plumb the vault, broker, and Tailscale identity as host units talking to the cell over Unix sockets with peer credentials.

That is a larger program than the gateway was, it forfeits the "no load-bearing control on the workload" invariant, and it puts the hardest part (kernel-boundary hardening) on a two-person team instead of Meta's. The gateway is the cheaper way to get a stronger boundary.

### 6.3 Verdict

Keep it. The second server is the only control in the stack the agent cannot cooperate its way around, it is the thing that makes "no secrets on the workload" and "root for the agent" simultaneously honest, and it is the natural host for the policy layer we are missing. The incremental compute cost is under $20 per instance per month on either provider. The real cost is complexity, and most of that has been paid.

The caveat is that a strong boundary with no policy on it is under-delivering. Muse's Sentinel would run *on our gateway* almost unchanged in concept: it is a forward proxy with L7 policy, a resolver, per-destination tiers, taint-aware auto-allow, and an ask-the-user path. That is Phase 3 plus a HITL channel. Until it exists, the honest statement of our guarantee remains: credentials cannot leave; data can.

---

## 7. Takeaways to adopt, in priority order

1. **Build the Sentinel-equivalent on the gateway (Phase 3, reordered).** Add the resolver first (DNS is currently unlogged and bypasses the NAT), then per-destination tiers derived from the flow-log inventory (system allowlist auto-allowed; credentialed services; agent browsing logged or asked), then the transparent bump proxy for L7 on HTTP. Add Muse's SSRF rule now: drop forwarded traffic from the workload to RFC 1918, link-local, and the metadata range at the gateway forward chain. This is a one-line nftables change.
2. **Add an approval channel that is not the chat.** Muse's point that consent must not travel through the conversation applies to us: an injected agent can fabricate a Discord "approved" reply. The Clawbridge dashboard already delivers vault approvals through the TeamYou entry hop; extend that surface to destination approvals from the gateway and, if exec approvals are ever turned on, route them there rather than to a channel. Scoped grants (session, task, time-bounded) are the model to copy; today a vault service grant is perpetual.
3. **Turn off YOLO for the classes that matter.** OpenClaw supports `ask: "on-miss"` with an allowlist; alphaclaw already has an allowlist editor. Shipping `ask: "off"` on every boot is a product decision worth revisiting now that root is granted. Note the nested Claude CLI inherits `bypassPermissions` under YOLO.
4. **Email hygiene is cheap and high-value.** Strip one-time passcodes, password-reset links, and magic links before mail reaches the agent. A deterministic filter in the gog path covers most of it; a classifier can come later. The article's argument is that connecting email must not let the agent (or its attacker) reset your other passwords.
5. **Label untrusted content in the harness.** Wrap tool results, inbound messages, and fetched web content with explicit untrusted framing in the prompts we control (AGENTS.md, TOOLS.md, channel ingest), and add an inbound LLM-judge pass on email and web content for injection patterns. This will not match Meta's ensemble, but today we have zero layers here.
6. **Treat browser enablement as a security project, not a feature flag.** If OpenClaw's browser tool is ever enabled on managed instances, require its sandboxed-browser mode, accessibility-tree-only access, no JS evaluation, and credential fill from outside the agent's view. Until then, deny the plugin explicitly so a root agent installing Chromium is a visible policy violation rather than a silent capability.
7. **Reinstate the "gateway unreachable" state.** Muse has no gateway-down failure mode; we do, and the doctor/watchdog signal for it was parked. It is the one operational cost of the split that customers will feel directly.
8. **Right-size the gateway.** Measure memory on the enforced instance and test a 1 vCPU droplet. Do not share gateways across instances.
9. **Adopt a standing adversarial test.** We cannot fund a $300k bounty, but a repeatable prompt-injection suite against a throwaway enforced instance (injected email, injected web page, injected file) would tell us whether items 4 and 5 work and would catch regressions in the exec policy.
10. **Keep root, stop hardening the workload.** Muse's least-privilege cell is the right model for a team that owns its harness. We chose the opposite, deliberately, and the split makes it safe. Given that, further systemd hardening of `alphaclaw.service` or an OpenClaw docker sandbox would be cooperative controls under root and are not worth the effort. Spend that effort on the gateway.

---

## 8. Sources

- Meta AI Research, "How We Built Safety Into Muse", 2026-09-08: https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
- Hetzner price adjustment, effective 2026-06-15: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- DigitalOcean droplet pricing: https://www.digitalocean.com/pricing/droplets
- alphaclaw: `docs/egress-enforcement-spec.md`, `docs/egress-program-status.md`, `docs/enhanced-workload-privileges-spec.md`, `docs/security-architecture.html`, `docs/vault-brokered-model-keys-spec.md`, `docs/vault-brokered-channels-spec.md`, `docs/oauth-refresh-broker-spec.md`, `docs/egress-flow-log-inventory.md`, `lib/server/exec-defaults-config.js`, `lib/server/agent-vault/runtime-store.js`, `lib/server/agent-vault/env-classification.js`
- clawctl: `docs/provisioning-setup-lifecycle.md`, `docs/dual-vps-migration-and-upgrades.md`, `assets/host/alphaclaw.service`, `assets/host/alphaclaw-host-finalize-setup.sh`, `src/services/security-gateway-assets-service.ts`, `src/provisioning/connectivity-caddy.ts`
- teamyou: `docs/openclaw-cloud-provisioning-plan-v2-addendum.md`, `lib/services/openclaw-provisioning/provisioning-config.ts`, `lib/services/openclaw-provisioning/provider/types.ts`, `lib/workflows/openclaw-provisioning/steps/enforce-egress.ts`, `lib/services/openclaw-provisioning/egress-attestation.ts`
