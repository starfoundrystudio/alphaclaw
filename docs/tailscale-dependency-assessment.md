# Tailscale dependency assessment: removing the customer-facing Tailscale step

**Date:** 2026-09-18
**Status:** assessment, no decision taken
**Supersedes:** the 2026-07-26 "Cloudflare tunnels vs Tailscale provisioning" chat analysis (never written to the repo; conclusions carried forward and re-checked here)

## 1. The problem

Every Clawbridge setup ends with the same complaint: create a Tailscale account, install the client, mint a `tskey-api-` token with the right scopes, find the setup tab again, paste, tick the checkbox. Retries need a fresh token. The token is a tailnet-wide admin credential that we use to rewrite the customer's ACL policy file. After setup the customer has to rediscover their dashboard at a new `.ts.net` URL from a device that is on the tailnet, and cloud-ops has to accept a device invite before support can reach the box.

There is also a licensing wrinkle we have been ignoring: Tailscale's Personal plan is "only suitable for non-commercial use" (tailscale.com/pricing). Customers running a business agent on a free personal tailnet are in a grey zone that is theirs, but that we designed them into.

## 2. What Tailscale actually does for us today (September 2026)

Verified against `lib/server/onboarding/tailscale-finalizer.js`, `gateway-tailscale-finalizer.js`, clawctl `alphaclaw-tailscale-expose.sh`, `alphaclaw-gateway-tailscale-setup.py`, and TeamYou's provisioning workflow.

| Job | Mechanism | Who depends on it |
|---|---|---|
| Private ingress to the dashboard | `tailscale serve --https=443` on the CPX11 gateway, forwarding to loopback Caddy and on to the workload | Customer browser; `ALPHACLAW_SETUP_URL`; TeamYou console link |
| Public ingress for callbacks | `tailscale funnel --https=8443` for `/hooks`, `/webhook`, `/oauth`, `/auth/google/callback` | Google OAuth redirect URIs, Gmail Pub/Sub, channel webhooks; `ALPHACLAW_PUBLIC_BASE_URL` |
| TLS and stable hostname | `.ts.net` MagicDNS name plus Tailscale-issued cert | `.env`, TeamYou instance registry, ingress-origin guard in `deployment-surface.js`, restore flow (`ALPHACLAW_TAILSCALE_DNS`, `_DEVICE_ID`) |
| Operator access | Tailscale SSH; ACL `ssh` rule with `src: [autogroup:admin, cloud-ops@teamyou.ai]`, `users: [root, alphaclaw]`; device invite to `cloud-ops@teamyou.ai` | clawctl TUI, `clawctl upgrade`, support diagnostics, offboarding; post-provision Hetzner firewall admits only UDP 41641 |
| Agent Vault admin surface | Tailscale VIP service `svc:agent-vault-<slug>-<digest>` with `autoApprovers` and a `tcp:443` grant to admins and cloud-ops | Vault operator access (why the token needs the `vip-services` scope) |
| User identity | `tailscale-user-login` header | Only as an audit label on advanced-control acknowledgements; not used for authorization |

Two things worth stating plainly:

- Tailscale gives us **reachability, not identity**. Dashboard authorization is the setup-password session plus "are you on the tailnet". The July finding still holds.
- The egress enforcement spec's invariant is "the gateway must never bridge into the customer's tailnet". That intent survives any transport change; the mechanism (drop on the tailscale interface) is a detail.

## 3. Options

### 3a. Tailcat — reject

Tailcat (open-sourced 2026-08-30, v0.6.0 on 2026-09-04) is a CLI and Go package that moves bytes between machines over Tailscale's data plane with **no control plane**: no accounts, no ACLs, no persistent membership, no MagicDNS, no Serve or Funnel equivalent. The server prints a bearer "tailcat address"; anyone holding it connects. Tailscale-hosted DERP relays are rate limited, log metadata, and "may be revoked at any time"; there are no API stability or uptime promises. Production use means self-hosting DERP.

Bill's instinct is correct. It is built for ad-hoc SSH, file transfer, and CI, not for hosting a customer's dashboard and webhook ingress. It would also replace "install the Tailscale app" with "install a CLI and run a SOCKS proxy", which is worse for the people who are complaining.

### 3b. Manage tailnets for customers — reject as the customer path, keep for ops

Tailscale repriced on 2026-04-08: Personal $0 (6 users), Standard $8/user/mo, Premium $18/user/mo, tagged resources 50 included then $1/mo each, tagged devices consume no seats. What that gives a vendor:

- **One vendor tailnet, customers invited as users.** Removes the API-token step but not the client install. Each customer is a seat ($8 to $18/mo) inside our org, sharing our IdP domain. Self-serve terms license the service for "internal business purposes" and forbid resale; giving paying customers access to our tailnet needs a contract, not a checkout.
- **Node sharing.** The recipient must be an admin of their own tailnet, and tagged machines cannot be shared at all. No gain.
- **Tailnets API (alpha, 2026-08-25).** Creates API-only tailnets: tagged devices only, **no human users**, 10 per org without a sales contract. Solves machine fleets, not "a person opens a dashboard".
- **Multiple tailnets (alpha).** Sales-gated, all share one domain and IdP. Not customer isolation.
- **Headscale.** We would run the control plane and could use TeamYou as the OIDC issuer, which does kill the account step. But Serve and Funnel are unsupported, the customer still installs the official client and points it at a custom login server, and Tailscale calls it "not part of the supported product". Too much for too little.

Conclusion: Tailscale has no plan that lets a vendor hand consumers zero-account access. Every human-user path still requires the client on the customer's device, which is half the friction.

The flip side is important: Tailscale is a **very good fit for our own fleet**. Tagged gateway nodes in the `teamyou.ai` tailnet, auth keys minted by an OAuth client at provision time, $1/mo per node beyond 50, no customer involvement, clean "internal business use" licensing. Tailscale SSH, the clawctl TUI, the vault VIP service, and the egress invariants all keep working unchanged.

### 3c. Cloudflare Tunnel for customer ingress — recommended, re-verified

The July analysis stands and the 2026 facts confirm it:

- Tunnels are free on every plan; 1,000 tunnels per account (limits page dated 2026-09-04); remotely managed tunnels are created and token-fetched over the API, so clawctl or the TeamYou workflow mints the token at provision time and the customer never sees it.
- Hostname routing went GA on 2026-08-11 and is free.
- Universal SSL covers first-level subdomains only, so the instance hostname must be `<slug>.<product-domain>`, not `<slug>.openclaw.teamyou.ai` (or pay for Advanced Certificate Manager).
- Outbound-only from the gateway: no inbound port at all for customer traffic. UDP 41641 stays open only for the ops tailnet.
- Edge limits: 100 MB request body on Free and Pro; WebSocket idle close after "a period of time" (community reports about 100 s, documented proxy read timeout 125 s). The chat UI and OpenClaw Control UI stream over WebSocket and need keepalives and reconnect. This is the one likely runtime annoyance.

The customer experience becomes: sign in to TeamYou, click the instance link, use it. No account, no client, no token, no tab hunting.

**Dashboard authentication becomes ours.** Two shapes:

- **App-level auth backed by TeamYou identity (recommended).** The customer already has the only account that matters. Extend the existing session model so the instance trusts a TeamYou-issued assertion (OIDC or a signed handoff from the console), with the setup password as the recovery path. $0 per customer at any scale. This is the T3 Connect pattern.
- **Cloudflare Access with one-time PIN.** Zero login code and a signed `Cf-Access-Jwt-Assertion` at the origin, but every authenticating customer consumes a Zero Trust seat. The free-tier seat count (widely reported as 50, then about $7/seat) could not be confirmed from Cloudflare's own pages. Fine for ops, not for the customer population.

## 4. Recommended architecture: split the two concerns

| Concern | Transport | Customer involvement | Cost |
|---|---|---|---|
| Customer reaches dashboard | Cloudflare Tunnel from CPX11 to loopback Caddy, hostname `<slug>.<product-domain>`, TeamYou-backed session auth | none | $0 |
| Public callbacks (OAuth, Gmail, channels) | second hostname on the same tunnel, e.g. `<slug>-hooks.<product-domain>`, same path allowlist | none | $0 |
| Operator SSH, clawctl TUI, vault VIP service | Tailscale, tagged node in `teamyou.ai`, auth key from an OAuth client at provision time | none | $1/mo per node beyond 50 |

This deletes the wizard step outright rather than shortening it, removes the tailnet-wide admin token, removes the device-invite acceptance, removes the "retry needs a fresh token" failure, removes the customer from Tailscale's licensing entirely, and makes the recent browser-side `.ts.net` readiness probe unnecessary.

## 5. Blast radius (all known, none architectural)

- `.ts.net` suffix validators and the "same hostname, different port" assertion in the gateway finalizer.
- Ingress-origin guard in `deployment-surface.js` (public vs private origin) needs re-validation behind cloudflared's `X-Forwarded-*` headers.
- Google OAuth redirect URIs are built from the Funnel URL, so existing instances cannot be migrated in place without re-registering. Roll out new-instances-first.
- Tailscale-shaped fields in `instance.network_finalized` and the restore flow's `ALPHACLAW_TAILSCALE_*` env.
- Setup-link readiness probe and the "I have installed Tailscale" attestation in the wizard: delete.
- Hetzner hardened firewall profile: unchanged for ops; customer traffic needs no inbound rule.
- Egress spec wording: restate the invariant as "the gateway forwards workload to internet only; never into the ops tailnet or the tunnel".
- Ops path if we ever drop Tailscale entirely: `cloudflared access ssh` with ops seats is documented and current, but keeping Tailscale for ops is the smaller change.

## 6. Suggested next step

A spike, not a migration: provision one instance whose CPX11 runs `cloudflared` alongside `tailscaled` (ops-only, tagged node from the `teamyou.ai` OAuth client), serve the dashboard and hooks hostnames through the tunnel, gate the dashboard with a TeamYou-issued session, and validate: Google OAuth callback, Gmail webhook, streaming chat across the WebSocket idle window, clawctl TUI reach over the ops tailnet, offboarding.

Decisions Bill owns before the spike: the product domain for first-level subdomains, TeamYou-backed session versus Cloudflare Access for customer auth, and whether ops stays on Tailscale.

## 7. Sources

- Tailcat: tailscale.com/blog/tailcat, github.com/tailscale/tailcat (releases, README)
- Tailscale pricing v4: tailscale.com/blog/pricing-v4, tailscale.com/pricing, tailscale.com/changelog (2026-05-14 tagged-resource add-on)
- Tailscale sharing: tailscale.com/kb/1084/sharing
- Tailscale terms and MSA (2026-08-25): tailscale.com/terms, tailscale.com/msa
- Tailnets API: tailscale.com/docs/features/tailnets-api; multiple tailnets: tailscale.com/docs/features/multiple-tailnets
- Headscale: github.com/juanfont/headscale, headscale.net/stable/about/features, tailscale.com/opensource
- Cloudflare limits (2026-09-04): developers.cloudflare.com/cloudflare-one/account-limits
- Cloudflare remote tunnels via API: developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api
- Cloudflare tunnel changelog: developers.cloudflare.com/cloudflare-one/changelog/tunnel
- Cloudflare Universal SSL: developers.cloudflare.com/ssl/edge-certificates/universal-ssl
- Cloudflare 413 limits (2026-09-03): developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413
- Cloudflare WebSockets and connection limits: developers.cloudflare.com/network/websockets, developers.cloudflare.com/fundamentals/reference/connection-limits
- Cloudflare SSH: developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh

Unverified: Cloudflare Zero Trust free seat count and per-seat price; the exact WebSocket idle timeout on Free and Pro; whether Tailscale's self-serve terms permit vendor-hosted access for paying customers without a contract.
