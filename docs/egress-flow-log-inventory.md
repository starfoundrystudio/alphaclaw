# Egress Flow-Log Inventory (Phase 3 input)

**Captured:** 2026-08-26 from `alphaclaw-egress-enforced-1-gateway` (`alphaclaw-natgw-new` nftables log, new-connection SYNs only). Retention window: **2026-08-23 21:04 → 2026-08-26 05:46 UTC** (~2.3 days), covering onboarding residue, the full channel/vault acceptance-testing period (betas .4–.16 installs), steady-state background, and a scoped agent exercise (3 web searches + 1 page fetch + memory write) run 05:44–05:46 UTC on 2026-08-26. Totals: **667 new outbound flows, ~1.73 GB forwarded** (established-counter, both directions). Gateway access via the documented temporary own-IP firewall (created 05:42, removed 05:52 UTC, verified closed).

## Headline findings

1. **Vault transit works.** The agent exercise produced **zero direct flows** — every web search, page fetch, and model call rode the vault proxy (which travels the gateway private path, not the NAT). The NAT-visible inventory is purely non-vault traffic, exactly what Phase 3 policy must govern.
2. **DNS and Tailscale bypass the NAT entirely.** Zero port-53 flows and no WireGuard UDP in the log: both ride the workload's own public interface via the source-policy rule (resolvers `185.12.64.x` + Hetzner IPv6). Phase 3's "retire public ingress" step must therefore add a gateway DNS forwarder (which also unlocks query logging — the resolver on the gateway that the spec assumed is **not present today**) and decide the Tailscale path before the public interface can be closed.
3. **Zero plaintext.** No port-80, no port-22; git-sync and package installs all ride 443.
4. **Native-binary browsing fails open, as the spec predicted.** An Aug 24 cluster (wikimedia, Google, CloudFront, Azure, misc CDN — 01:48 and 20:01–20:04 UTC) is browser-class page traffic direct-dialing through the NAT: the browser is a native binary proxyline cannot wrap. Visible to flow logs, invisible to the vault — this is the concrete case for Tier 2 transparent interception.
5. **Channel direct-dial residue during restart storms.** Telegram DC `149.154.166.110` (7 SYNs, Aug 25 21:45–23:41) and `discord.com` (2 SYNs, Aug 25 22:17) — all inside the acceptance-testing/beta-install window. Steady-state shows none, and Slack shows none at any time. Most likely the openclaw gateway's channel dialers racing proxy env application during rapid restarts. Follow-up: reproduce a restart and watch for the same SYNs before treating this as closed.
6. **Alphaclaw's own server-side probes dial direct** (it is not behind proxyline by design): `ai-gateway.vercel.sh` model-catalog probe (1), `teamyou.ai` (2), GitHub releases CDN. Low volume and first-party; candidates for `vault-fetch` routing if Phase 3 wants a NAT allowlist with no app exceptions.

## Destination inventory

| Destination | Attribution | Flows | Window (UTC) | Class |
| --- | --- | --- | --- | --- |
| `104.26.12/13.205`, `172.67.74.152` | `api.ipify.org` — egress route probe/repair alarm (5-min timer) | 358 | continuous since 08-24 20:19 | First-party infra (consider a gateway-local probe target instead) |
| `104.16.0–11.34` | `registry.npmjs.org` CDN — operator beta installs | 121 | bursts at install times | Operator action |
| `140.82.121.3/10/33/34` | `github.com` / `codeload` / `npm.pkg.github.com` — git-sync + package installs | 16 | onboarding + installs | First-party + operator |
| `185.199.108–111.154` | GitHub Pages CDN (release notes / raw content) | 14 | scattered | First-party |
| `213.239.239.164/165` | `ntp1/ntp2.hetzner.de` UDP 123 (chrony) | 79 | continuous | System |
| `185.12.64.3`, `185.125.190.x` | `mirror.hetzner.com`, Canonical esm/motd — apt | 8 | daily | System |
| `149.154.166.110` | Telegram DC | 7 | 08-25 21:45–23:41 only | **Follow-up** (finding 5) |
| `162.159.128.233/136.232` | `discord.com` | 2 | 08-25 22:17 only | **Follow-up** (finding 5) |
| `185.15.59.224`, `142.25x.x`, `3.169.x`, `143.204.x`, `40.114.177.156`, `104.20.45.190`, `67.63.60.x` | wikimedia / Google / CloudFront / Azure / misc — browser-class page fetches | ~15 | 08-24 01:48, 20:01–20:04 | **Follow-up** (finding 4) |
| `64.239.123.65` | `ai-gateway.vercel.sh` — alphaclaw model-catalog probe | 1 | 08-24 01:38 | First-party server probe |
| `216.150.1.65/16.129` | `teamyou.ai` (Vercel) | 2 | onboarding | First-party |
| `192.200.0.106/115` | `lb.fra.tailscale.com` — control plane | 2 | onboarding | System (later control traffic rides the public path — finding 2) |
| `13.36/13.37/15.236/35.181/3.64/34.244/3.254.x` (AWS eu-west), `172.64/66.x`, `34.160.111.145`, `216.150.16.65` | Onboarding-window one-offs (skill/CLI install CDNs, tailscale login, unattributed) | ~15 | 08-23 21:04–21:27 | Onboarding |

## Recommended Phase 3 policy shape (from this data)

- **Steady-state allowlist is small**: Hetzner NTP, Hetzner/Canonical apt, the route probe, GitHub (+npm CDN for operator installs), TeamYou. Everything else in a normal day is vault-transited and invisible to the NAT — so a default-deny forward chain with ~6 destination classes is realistic *once* findings 2, 4, and 5 are closed.
- **Order of work**: (1) gateway DNS forwarder + query logging, (2) browser traffic — either force it through the vault proxy (Chromium supports explicit proxy config) or accept Tier 2 interception as its control, (3) restart-window channel dial investigation, (4) optionally move alphaclaw server probes to vault-fetch to keep the allowlist app-clean.

Raw aggregation preserved in the session scratchpad (`flow-agg.tsv`, `ptrs.txt`); regenerate anytime with the same one-liner against the gateway journal.
