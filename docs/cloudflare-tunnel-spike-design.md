# Cloudflare Tunnel spike design (Phase 1)

**Date:** 2026-09-29
**Project:** Remove customer-facing Tailscale step from Clawbridge setup (TeamYou project `JiXqE7mB6nWT`)
**Status:** all open questions answered 2026-09-30; awaiting Bill's approval to start Phase 2. Nothing here is implemented.
**Inputs:** handoff brief and Tailscale dependency assessment (Agent Drive, same project); code surveys of TeamYou `origin/development` @ `26f6bca`, alphaclaw `main` @ `8fd0d1ee`, clawctl `main` @ `741382d`; Cloudflare documentation checked 2026-09-29 (sources in §11).

Citation convention: `ty:` = teamyou repo, `ac:` = alphaclaw, `cc:` = clawctl.

## 1. Summary

TeamYou Pro instances stop using Tailscale. At provision time TeamYou creates one remotely managed Cloudflare Tunnel per instance with three public hostnames under `teamyou.io`. `cloudflared` runs on the gateway VM and points each hostname at the **same loopback Caddy listeners Tailscale uses today**, so the workload, the mTLS bridge, and the surface headers Clawbridge relies on do not change.

The largest simplification is that every URL is known before the servers exist. There is no bootstrap hostname, no URL swap after onboarding, no readiness probe, no handoff, and no owner-supplied credential. The owner opens `https://<slug>.teamyou.io` from the TeamYou console on day one and it stays their address.

The largest new obligation is security: the dashboard hostname becomes reachable from the internet, and until `teamyou.io` is on the Public Suffix List every instance is the **same site** as every other instance. Section 5 lists the hardening that must land before any customer instance runs on a tunnel.

## 2. Target topology

| Hostname | Tunnel ingress target (gateway) | Role | Replaces |
|---|---|---|---|
| `<slug>.teamyou.io` | `http://127.0.0.1:9080` | Clawbridge dashboard, Control UI, agent pages (surface `private`) | Tailscale Serve `:443` |
| `<slug>-hooks.teamyou.io` | `http://127.0.0.1:9081` | Public callbacks: Google OAuth callback, Gmail push, `/hooks`, `/webhook`, `/oauth` (surface `public`) | Tailscale Funnel `:8443` |
| `<slug>-vault.teamyou.io` | `http://127.0.0.1:9090` | Agent Vault operator page (owner key entry) | Tailscale Service `svc:agent-vault-*` |
| anything else | `http_status:404` catch-all | | |

- **Slug:** reuse the existing 12-character random bootstrap slug (alphabet `23456789abcdefghjkmnpqrstuvwxyz`, `ty:lib/workflows/openclaw-provisioning/steps/plan-instance.ts:10-20`). It carries no customer data and is already persisted and reused across retries (`:54-82`). All three names are first-level subdomains, so Universal SSL covers them.
- **Not routed:** the vault runtime listener `:9091` stays private-network only (workload tunnel), and the SSH bridge `:9022` is not exposed (see §8).
- **Unchanged downstream:** gateway Caddy already stamps `X-AlphaClaw-Ingress-Surface` per listener, sets `X-Forwarded-Host {http.request.host}` and `X-Forwarded-Proto https`, and proxies over mTLS to the workload (`ty:lib/services/openclaw-provisioning/connectivity-caddy.ts:86-102,136-140`). cloudflared preserves the client's `Host`, so Clawbridge sees the tunnel hostname exactly as it saw the `.ts.net` name.
- **Gateway inbound after provisioning:** none. cloudflared is outbound-only (TCP and UDP 7844 to `region1/region2.v2.argotunnel.com`). Gateway outbound is unrestricted on both providers today (no `out` rules; DigitalOcean translation adds allow-all outbound, `ty:lib/services/openclaw-provisioning/digitalocean-client.ts:45-49,395-405`), so no firewall change is needed for cloudflared.

## 3. TeamYou control plane

### 3.1 Mode selection and configuration

- New per-provision field `ingress_mode: 'tailscale' | 'cloudflare_tunnel'`, persisted as `provider_metadata.provisioning.ingress_mode`. For the spike it is an **admin-only** option next to the existing AlphaClaw channel picker; self-serve stays `tailscale` until go/no-go. A later env default (`OPENCLAW_DEFAULT_INGRESS_MODE`) flips Pro.
- Env: `CLOUDFLARE_TUNNELS_TOKEN` (exists; Production and Preview), plus non-secret `CLOUDFLARE_ACCOUNT_ID=5b581e9151f03b52610673bda1544b74`, `CLOUDFLARE_INSTANCE_ZONE_ID=affdf030e289b58602fb31795df2ac23`, `OPENCLAW_INSTANCE_DOMAIN=teamyou.io`. Read through `provisioning-config.ts` like the Vercel values (`:130-155`). Never log the token.

### 3.2 Planning

In tunnel mode, `plan-instance` derives and stores the final URLs immediately:

- `access.setup_url = https://<slug>.teamyou.io`
- `access.public_base_url = https://<slug>-hooks.teamyou.io`
- `access.agent_vault_operator_url = https://<slug>-vault.teamyou.io`
- no `bootstrap_hostname` / `bootstrap_url`.

`operatorConsoleUrl` can be set to `setup_url` at plan time, so the console link works as soon as the instance answers.

### 3.3 New step `ensure-cloudflare-tunnel` (replaces `ensure-dns-records` in tunnel mode)

Runs where `ensure-dns-records` runs today (`ty:lib/workflows/openclaw-provisioning/index.ts:569-586`). Idempotent and retry-safe:

1. `GET /accounts/{acct}/cfd_tunnel?name=teamyou-<instanceId>&is_deleted=false`; reuse if found, else `POST /accounts/{acct}/cfd_tunnel` with `{"name":"teamyou-<instanceId>","config_src":"cloudflare"}`.
2. `PUT /accounts/{acct}/cfd_tunnel/{id}/configurations` with the three ingress rules from §2 plus the `http_status:404` catch-all. Per-rule `originRequest`: `connectTimeout: 10`, `keepAliveTimeout: 90` (integer seconds in the API). Always PUT the full desired config (declarative).
3. For each hostname, match-or-create `POST /zones/{zone}/dns_records` `{"type":"CNAME","name":"<host>","content":"<tunnelId>.cfargotunnel.com","proxied":true,"ttl":1}`. Same conflict rule as the Vercel client: an existing record with a different target is a hard error (`ty:lib/services/openclaw-provisioning/vercel-dns-client.ts:98-138`).
4. Persist `provisioning.cloudflare = { tunnel_id, tunnel_name, dns_record_ids[] }`. The **tunnel token is not persisted**; it is fetched when needed (§3.4, §3.8).

Budget: at most 6 API calls per provision against a limit of 1,200 per 5 minutes per user. Account ceiling: 1,000 tunnels, so plan a second account or an Enterprise conversation well before ~800 live Pro instances.

### 3.4 Gateway install

In `install-gateway` (`ty:lib/workflows/openclaw-provisioning/steps/install-gateway.ts`) and `gateway-installer.ts`:

- Fetch the token with `GET /accounts/{acct}/cfd_tunnel/{id}/token` immediately before upload; stage it as `$stage/cloudflared-token` (0600), delete in the existing `finally` (`install-gateway.ts:247-253`), mirroring `backup.env` handling (`gateway-installer.ts:273-276`).
- Installer, tunnel mode:
  - Skip the Tailscale install (`gateway-installer.ts:131-135`).
  - Add the signed Cloudflare apt repository (`pkg.cloudflare.com/cloudflare-main.gpg`, suite `any`) and `apt-get install cloudflared`; require version `>= 2025.4.0` for `--token-file`.
  - Create system user `cloudflared`; install the token at `/etc/cloudflared/token`, owner `cloudflared`, mode 0400.
  - Unit `alphaclaw-cloudflared.service`: `ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel --metrics 127.0.0.1:20241 run --token-file /etc/cloudflared/token`, `User=cloudflared`, `Restart=always`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`. Do not use `cloudflared service install <token>`: it writes the token onto the command line. Package installs never self-update; updates ride apt maintenance.
  - Write the known vault origin at install time: `operator_origin: https://<slug>-vault.teamyou.io` in `bootstrap.json` and `AGENT_VAULT_ADDR=` the same in `agent-vault.env` (today both start as `https://pending.invalid` and are filled by the Tailscale configure step, `gateway-installer.ts:85-88,281,288`; `ty:.../gateway-assets/alphaclaw-gateway-tailscale-setup.py:356-369,390`).
  - Write the gateway setup state as configured and sealed with tunnel fields (`ingress_mode`, `setup_url`, `public_base_url`, `agent_vault_operator_url`) instead of Tailscale identity. The setup protocol's remaining job in tunnel mode is the Agent Vault runtime-token claim and acknowledgement, which require `configured && sealed` (`alphaclaw-gateway-tailscale-setup.py` `claim_agent_vault_runtime_token`). `configure` is rejected in tunnel mode.
  - Do not render the public bootstrap site or create the `bootstrap-open` marker (`connectivity-caddy.ts:143-178`; `gateway-installer.ts:393-417`). The starting page on `:9080` for 502/503 stays (`connectivity-caddy.ts:116-135`) and becomes the "your agent is starting" page on the real hostname.
  - Keep the "gateway already joined a tailnet" guard only in Tailscale mode (`gateway-installer.ts:432-436`).

### 3.5 Firewalls

- During provisioning: unchanged temporary firewalls (gateway 22/80/443 + ICMP; workload 22 + ICMP) because TeamYou installs over SSH to the gateway's public IP. In tunnel mode 80/443 are not needed and should be omitted from the gateway's temporary rules.
- Hardened: the gateway gets **no ingress firewall rules at all**. Do not attach `clawctl-alphaclaw-gateway-ingress` (UDP 41641) or `teamyou-alphaclaw-gateway-bootstrap-ingress` (TCP 80/443) (`ty:lib/workflows/openclaw-provisioning/index.ts:1154-1201`; `security-gateway.ts:188-223`). Note: today nothing ever removes the 80/443 firewall from Tailscale-mode gateways; worth a separate look.
- Failure lockdown in tunnel mode rewrites the gateway temporary firewall to no rules rather than "UDP 41641 only" (`failure-firewall-lockdown.ts:38-46`).

### 3.6 Verification (`verify-connectivity`)

Replace the Tailscale assertions (`ty:.../steps/verify-connectivity.ts:72-73,104,159-161,180-182`) with:

- gateway: `tailscale` not installed; `alphaclaw-cloudflared.service` active; `curl -fsS http://127.0.0.1:20241/ready` returns 200 (active edge connection); listeners 9080/9081/9090/9091 present (unchanged, `:106-114`).
- end to end from the control plane, through Cloudflare: `GET https://<slug>.teamyou.io/health` returns a Clawbridge response (200 or 503 JSON, not a Cloudflare 52x); `GET https://<slug>-hooks.teamyou.io/` returns Clawbridge's 404 body; `GET https://<slug>-vault.teamyou.io/health` answers from Agent Vault.

### 3.7 Owner-setup completion and `instance.network_finalized`

The webhook stays the "owner finished setup" signal that resumes the `provision-finalized:<id>` hook (`ty:lib/services/openclaw-instance-webhook-service.ts:1673-1677`), with a tunnel-mode schema variant:

```json
{
  "type": "instance.network_finalized",
  "instance_id": "inst_…",
  "ingress_mode": "cloudflare_tunnel",
  "setup_url": "https://<slug>.teamyou.io",
  "public_base_url": "https://<slug>-hooks.teamyou.io",
  "agent_vault_operator_url": "https://<slug>-vault.teamyou.io",
  "clawbridge_sso": true
}
```

Validation in tunnel mode: every URL must **exactly equal** the value TeamYou planned (§3.2). This replaces the `.ts.net`, port 8443, and same-host rules (`:665-824`) and means an instance cannot redirect its own URLs. Tailscale fields are absent. The Hetzner webhook firewall transition (`:1085-1133`) is skipped; hardening already happened in the workflow.

### 3.8 Destroy, failure, restore

- Destroy and failed-provision cleanup (`ty:.../steps/destroy-steps.ts:262-309`, `destroy-cleanup.ts:91-109`): after the servers are gone, delete the three DNS records, `DELETE /accounts/{acct}/cfd_tunnel/{id}/connections`, then `DELETE /accounts/{acct}/cfd_tunnel/{id}`. Treat 404 as success; record results the way `vercel_dns_records` are recorded.
- Restore (`ty:.../steps/restore-instance.ts:574-611,677-690`): fetch the token again by `tunnel_id` and re-courier it; the network-facts script writes the tunnel-mode setup state instead of re-advertising a Tailscale Service. Gateway backups exclude `/etc/cloudflared/token` (and there is no `/var/lib/tailscale`, `alphaclaw-gateway-backup.sh:461-465`). Because URLs never change, **Google OAuth redirect URIs and webhook registrations survive a restore**, which they do not today.
- Cloudflare API change on 2026-10-05: list/get stop returning `connections`; use `GET …/cfd_tunnel/{id}/connections` if connection state is needed.

### 3.9 Agent Vault owner session

`agent-vault-enrollment-service.ts` requires `agent_vault_operator_url` to end in `.ts.net` (`:82-107,269-270`). In tunnel mode, accept it when it exactly equals the planned vault URL. The gateway-side `aud` check against `operator_origin` (`alphaclaw-agent-vault-bootstrap.py:248-252`) works unchanged once §3.4 writes the right origin.

## 4. Clawbridge (alphaclaw) and host bootstrap

### 4.1 Configuration

- New system var `ALPHACLAW_INGRESS_MODE` (`tailscale` default, `cloudflare_tunnel`), added to `kSystemVars` (`ac:lib/server/constants.js`).
- TeamYou's bootstrap env (`ty:lib/services/openclaw-provisioning/bootstrap-claim-service.ts:313-361`) sets, in tunnel mode: `ALPHACLAW_INGRESS_MODE=cloudflare_tunnel`, `ALPHACLAW_SETUP_URL`, `ALPHACLAW_PUBLIC_BASE_URL`, `AGENT_VAULT_OPERATOR_URL` to the final values, and drops `ALPHACLAW_BOOTSTRAP_URL` and the `TAILSCALE_*` keys.
- Host bootstrap script (`cc:assets/host/alphaclaw-host-bootstrap.sh`, shipped in the host asset bundle): default, validate, and write `ALPHACLAW_INGRESS_MODE` and `AGENT_VAULT_OPERATOR_URL` into the instance `.env`, same pattern as `ALPHACLAW_OPS_ACCESS`. Skip the local Tailscale branches when the mode is `cloudflare_tunnel`. This needs a new bundle on the TeamYou beta pin for the spike.

Effect: with both setup and public URLs set at first boot, the ingress guard runs in strict mode from the start (`ac:lib/server/deployment-surface.js:79-91,231-262`): only the callback allowlist is served on `-hooks`, and everything on the dashboard hostname requires the private surface. The SSO audience is the setup origin from the first sign-in (`ac:lib/server/auth/teamyou-sso.js:131-136,227-235`), and OpenClaw's `controlUi.allowedOrigins` picks it up automatically (`ac:lib/server/gateway.js:1063-1072`, derived from `ALPHACLAW_SETUP_URL`).

### 4.2 Onboarding

- The wizard hides the "Private Access With Tailscale" group in tunnel mode (`ac:lib/public/js/components/onboarding/welcome-config.js:39-47,70-76`).
- `POST /api/onboard` does model and auth setup, then sends the tunnel-mode `network_finalized` webhook (§3.7). No Tailscale finalizer, no gateway `configure`/`seal` (already sealed at install), no pending-URL dance.
- Remove from the tunnel path: the readiness probe and `handoffViaBootstrapOrigin` (`ac:lib/public/js/components/welcome/use-welcome.js:155-287`), since the URL never changes. The wizard lands on `/openclaw/chat?session=main` directly.

### 4.3 `.ts.net` validators to relax (tunnel mode: exact match to configured values)

- `ac:lib/server/agent-vault/service.js:217-235` (`getOperatorUrl`)
- `ac:lib/server/agent-vault/runtime-store.js:56-64`
- `ac:lib/server/onboarding/gateway-tailscale-client.js:247-264` (status parser; accept the tunnel-mode state from §3.4)
- `ac:lib/agent-vault-links.js:39-70` (approval links)
- `ac:lib/server/onboarding/gateway-tailscale-finalizer.js:68-83` (stored result; not used in tunnel mode)

Rule for all of them: in tunnel mode a URL is valid only if it is `https`, root path, and equal to the corresponding configured env value. No suffix matching.

## 5. Security hardening (must land before any customer instance uses a tunnel)

Today the dashboard hostname is only reachable from the owner's tailnet, and several behaviors lean on that. Under a tunnel it is on the public internet, and all `*.teamyou.io` instances are the same site to browsers until the Public Suffix List entry ships in browsers (months, §6.4). The attacker model that matters most is **another customer**. Every owner's agent is root on its own workload, so an owner (or an injected agent) controls everything served from their own `<slug>.teamyou.io`, and can lure another owner to it. Agent pages under `/pages` are not the vector: they are served in a browser sandbox (`ac:lib/setup/core-prompts/AGENTS.md:155-169`), which gives them an opaque origin. A modified dashboard on the attacker's own hostname is.

1. **Origin enforcement on WebSockets and state-changing requests.** There are no Origin or CSRF checks anywhere in Clawbridge today (verified: no reads of `req.headers.origin`, no `Sec-Fetch-Site` checks; the upgrade handler in `ac:lib/server/watchdog-terminal-ws.js:83-157` checks only the cookie). The session cookie is `SameSite=Lax` (`ac:lib/server/routes/auth.js:79-87`), which does not stop same-site requests, so a page on a sibling instance could open `/api/ws/chat` or `/api/watchdog/terminal/ws` (a shell) with the victim's cookie, or POST to `/api/*`.
   - Clawbridge: reject any WebSocket upgrade whose `Origin` is not exactly the setup origin; reject non-`GET/HEAD/OPTIONS` requests to `/api`, `/setup`, `/auth`, `/openclaw` whose `Origin` (or `Sec-Fetch-Site`, when Origin is absent) is not same-origin. Exempt the public callback allowlist, which is served only on `-hooks`.
   - Gateway Caddy, defense in depth for Clawbridge and for Agent Vault (third-party code): on `:9080` and `:9090`, return 403 for WebSocket upgrades and non-safe methods when an `Origin` header is present and not `https://{http.request.host}`.
2. **`/pages` must require a session in tunnel mode.** Today a private-surface request relayed by the gateway skips login (`ac:lib/server/routes/pages.js:104-125`). Remove that bypass when `ALPHACLAW_INGRESS_MODE=cloudflare_tunnel`.
3. **Cookie hardening:** in tunnel mode name the session and advanced-access cookies with the `__Host-` prefix and always set `Secure`. This stops a sibling instance from planting a `Domain=teamyou.io` cookie that shadows or fixes the victim's session.
4. **Fix the reflected script injection in `GET /auth/codex/callback`** (`ac:lib/server/routes/codex.js:200-206`): the unauthenticated `error` parameter is interpolated into an inline script with only single quotes escaped. Exploitable today with a link to a known `.ts.net` host; trivially reachable on a public hostname. Split out as its own task on 2026-09-29.
5. **Unauthenticated routes that become internet-facing** (reviewed, acceptable once 1-4 land): static assets, `/health` (gateway running/starting only), `/api/auth/status` (entry URL; confirm it returns no identity without a session), `/api/onboard/runtime-ready.svg`, `/auth/google/callback` (state-checked), `/v1/*` (OpenAI-compatible, bearer-gated, off by default; keep off for Pro). The spike's validation includes an unauthenticated sweep of every route in the inventory.
6. **Login throttle keying:** password login is disabled on SSO instances, so the shared-bucket concern (every request's `req.ip` may be the gateway) is low impact; confirm `TRUST_PROXY_HOPS` yields the client IP from `CF-Connecting-IP` / `X-Forwarded-For` for logging.

## 6. Cloudflare zone configuration

### 6.1 Already applied (2026-09-29)

SSL/TLS Full (strict); Always Use HTTPS; AI training crawlers blocked. The SSL mode does not affect tunnel origins, but must not be Off (WebSocket handshakes fail).

### 6.2 Protections versus server-to-server callbacks

- **Bot Fight Mode stays off permanently.** It is zone-wide on Free and cannot be skipped by any rule; it challenges API traffic such as Gmail push and chat-platform webhooks.
- Add one WAF custom rule (Free allows 5): `http.host` ends with `-hooks.teamyou.io` → **Skip** Browser Integrity Check and Security Level. Consider also skipping BIC for `-vault` if the vault's health warm-up fetch trips it.
- Add a Configuration Rule for all instance hostnames: `response_body_buffering: none` if SSE still buffers during validation (the tunnel streams `text/event-stream` responses by default).

### 6.3 Apex and HSTS

- Apex (decided): proxied placeholder `AAAA 100::` plus a Redirect Rule `teamyou.io/*` → `https://www.teamyou.com`. Needed for HSTS preload; harmless before. Configure in the dashboard, since the tunnel token lacks Rules permissions.
- HSTS: enable only after the spike passes. Start at 6 months with `include_subdomains` and `nosniff`; after stable operation move to 12 months with `preload` and submit at hstspreload.org. Once enabled, never unproxy a record, pause Cloudflare, or turn SSL off for the zone.

### 6.4 Public Suffix List

Submit a private-section entry for `teamyou.io` once Pro instances run on tunnels. Requirements: more than 2 years left on the registration (**teamyou.io was registered 2026-09-29 for one year; extend it first**), a `_psl.teamyou.io` TXT record pointing at the pull request (kept forever), and a rationale with user counts in the thousands. There is no SLA, browsers pick up changes on their own release cycles, and the maintainers say projects without thousands of users are likely to be declined, so an early submission may be rejected. §5 is the real control and is required regardless; PSL is defense in depth to pursue once Pro tunnel instances number in the thousands.

### 6.5 Certificate Transparency

Universal SSL covers the apex and first-level subdomains, most likely with a single wildcard, which would keep individual instance names out of CT logs (not stated explicitly in current docs). Do not enable Total TLS or per-host Advanced Certificates; they publish every hostname. Hostname secrecy is not relied on anywhere in this design.

## 7. Long-lived connections and timeouts

Two separate Cloudflare limits apply. WebSockets are closed when idle "for a period of time" (no documented number; community reports about 100 s). Ordinary HTTP requests get a 524 when the origin sends no response bytes for 125 s (the Free-plan Proxy Read Timeout, documented at 125 s since July 2026, historically 100 s). Today the tightest limit on this path is gateway Caddy's 300 s `response_header_timeout` (`ty:lib/services/openclaw-provisioning/connectivity-caddy.ts:98`); under a tunnel, Cloudflare's 125 s becomes the tightest.

| Connection | Today | Change |
|---|---|---|
| WS `/api/ws/chat` | no server ping; client reconnects with backoff (`ac:lib/server/chat-ws.js`; `lib/public/js/components/routes/chat-route.js:331-354`) | server ping every 30 s |
| WS watchdog terminal | no ping, no reconnect | server ping every 30 s |
| WS `/openclaw` (Control UI relay) | unknown OpenClaw keepalive | measure in spike; add relay-level ping if idle drops appear |
| SSE `/api/events/status` | 15 s comment heartbeat | none |
| SSE operation events | no heartbeat (`ac:lib/server/operation-events.js:103-125`) | 15 s comment heartbeat; add `Cache-Control: no-transform` on all SSE |
| `POST /api/onboard` (setup wizard's final request) | runs sequentially with no response bytes until done: host-finalize check (30 s cap), Codex plugin install when Codex is selected (120 s cap), `openclaw onboard` (120 s cap), `openclaw models set` (30 s cap), config writes and plugin reconciliation, Tailscale finalization, Agent Vault runtime preparation (`ac:lib/server/onboarding/index.js:291-475`). Measured about 80 s end to end on Milo (2026-08-24) including Tailscale finalization; worst-case caps sum well past 125 s | convert to an async operation in the spike (decided, §10 question 3); tunnel mode also drops the Tailscale finalization step |

Request bodies: Clawbridge caps JSON at 5 MB and `/v1` at 50 MB, well under Cloudflare's 100 MB. The only unbounded path is non-JSON `/api/*` bodies streamed to OpenClaw (`ac:lib/server/routes/proxy.js:350-354`); acceptable.

## 8. Operator access for Pro instances

No standing access (Phase 0, `ALPHACLAW_OPS_ACCESS` unset). Emergency access stays the existing provider-firewall SSH window on the gateway's public IP (`ty:lib/services/openclaw-offboarding/gateway-ssh-window.ts:116-194`), opened by an admin or the offboarding workflows and closed explicitly; from the gateway, the workload is reached over the private network. Recommend adding a server-side expiry so a forgotten window closes itself.

The Tailscale TCP bridge (`enable_ssh_bridge`, `ac:lib/server/onboarding/gateway-tailscale-finalizer.js:288`) forwards port 22 on the gateway's tailnet name to the workload's OpenSSH over the private network. Who can log in is decided by the workload's `authorized_keys`, which holds only the **operator keys the provider injects at server creation** (selected by name, e.g. the `clawctl` selector; Bill's default Starfoundry key is among them). That is why operator sessions such as `ssh root@test-…ts.net` work on test instances joined to Bill's own tailnet. Pro owners are on their own tailnet but hold no authorized key, and neither TeamYou nor Clawbridge offers a way to add one, so owners have no usable SSH today and tunnel mode removes nothing from them. Owners keep the dashboard's web terminal. (Legacy single-VPS clawctl instances gave owners keyless Tailscale SSH; they are high-touch and out of scope.)

Two consequences:

- Every Pro workload trusts the operator keys as root from creation. Today only network reachability separates us from Pro workloads (we are not on customers' tailnets). In tunnel mode port 22 is never exposed; the provider-firewall SSH window is the only path, which matches the no-standing-access model. Rotating or narrowing those keys is a separate question.
- Tunnel mode removes the convenient operator SSH to **test** instances. For the spike, use the SSH window per debugging session. If that proves tedious, admin-provisioned test instances could additionally join the `teamyou.ai` tailnet as a tagged node (operator-only, never for Pro), restoring today's workflow for test instances.

## 9. Spike plan (Phases 2 and 3)

**Where:** one admin-provisioned instance from a TeamYou preview deployment (the token is in the Preview env), DigitalOcean default placement, AlphaClaw `beta` channel, a new clawctl host bundle on the TeamYou beta pin. No customer instances, no stable promotion.

**Build order:**
1. alphaclaw: §4 and §5 items 1-3 behind `ALPHACLAW_INGRESS_MODE`; WebSocket pings and SSE heartbeats (§7); asynchronous setup wizard completion (§10 question 3). Beta release after Bill's go-ahead. (§5 item 4 ships separately and first.)
2. clawctl: host bootstrap handling for the new env keys; publish a beta bundle.
3. TeamYou: §3 behind the admin-only `ingress_mode`, plus the Caddy Origin rules for `:9080`/`:9090`; deploy to a preview branch.

**Acceptance (Phase 3):**
- Provision completes with no owner network step; console link opens `https://<slug>.teamyou.io` and TeamYou sign-in works; no setup password anywhere.
- `-hooks`: Google OAuth callback completes; Gmail push delivers; a channel webhook delivers; the dashboard is not served on `-hooks` (surface guard 404).
- `-vault`: owner key entry via a proposal link works; approval links resolve.
- Streaming: chat stays connected across 5+ minutes idle; Control UI stays connected; SSE status updates live; onboarding POST duration measured.
- Security: unauthenticated sweep of every route returns only the expected public responses; `/pages` requires login; a page on a second test instance cannot open the first instance's chat or terminal WebSocket or POST to its API (Origin rejected at Caddy and Clawbridge); `__Host-` cookies set.
- Resilience: `systemctl restart alphaclaw-cloudflared` recovers within seconds; `/ready` reflects state.
- Hardened gateway has no inbound firewall rules; emergency SSH window opens and closes.
- Destroy removes the DNS records and the tunnel; a failed provision cleans up the same way.

## 10. Open questions for Bill

(All six answered by Bill on 2026-09-30. The design awaits Bill's explicit approval to start Phase 2.)

1. **Agent pages:** decided 2026-09-30. Nobody shares page links today, so `/pages` requires the owner's TeamYou sign-in in tunnel mode. A per-page share link would be a later feature if ever wanted.
2. **Owner SSH:** decided 2026-09-30, out of scope. Pro owners have no usable SSH today (only operator keys are authorized, see §8) and will not get it in tunnel mode; the Clawbridge web terminal covers command access. If revisited later, the preferred design is an opt-in `<slug>-ssh.teamyou.io` tunnel hostname to the existing gateway SSH bridge, client-side `cloudflared` as the SSH ProxyCommand, and owner public keys managed in TeamYou (no Cloudflare Access seats). Operator SSH to test instances does change; the spike uses the SSH window.
3. **Setup wizard completion request:** decided 2026-09-30. `POST /api/onboard` (`ac:lib/server/routes/onboarding.js:291`) becomes asynchronous as part of the spike: it validates input, returns an operation id immediately, and runs the setup steps in the background, reporting progress over the existing operation-events stream (`ac:lib/server/operation-events.js`). This removes exposure to Cloudflare's 125 s limit (§7) and replaces the spinner with progress. The after-response host finalization moves to the end of the background operation.
4. **Registration length:** not blocking. Extending `teamyou.io` past 2 years is only needed when submitting to the Public Suffix List, which should wait until Pro tunnel instances number in the thousands (§6.4). Cheap to do any time before then.
5. **Apex redirect target:** decided 2026-09-30: `teamyou.io/*` redirects to `https://www.teamyou.com` (§6.3). Requires a Cloudflare Redirect Rule, which the current tunnel token cannot create (it holds only Tunnel and DNS permissions); set it in the dashboard or with a separate Rules-scoped token.
6. **Rollout default:** decided 2026-09-30: after a successful spike and go/no-go, new Pro provisions default to tunnel mode (`OPENCLAW_DEFAULT_INGRESS_MODE=cloudflare_tunnel`). Existing instances are unchanged until the Phase 4 migration plan.

## 11. Sources

- Remotely managed tunnels via API (create, token, configuration, DNS CNAME): developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/ ; API reference under developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/
- Connections cleanup and 2026-10-05 API change: developers.cloudflare.com/api/.../cloudflared/subresources/connections/methods/delete/ ; developers.cloudflare.com/changelog/post/2026-07-09-tunnel-routes-and-connections-api-changes/
- Hostname routes are private-network only: developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-private-hostname/
- cloudflared install, `--token-file` (2025.4.0+), auto-update, protocol fallback, metrics `/ready`: pkg.cloudflare.com ; developers.cloudflare.com/tunnel/reference/run-parameters/ ; developers.cloudflare.com/tunnel/downloads/update-cloudflared/ ; developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/
- Egress ports: developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/
- Limits (1,000 tunnels, 25 replicas): developers.cloudflare.com/cloudflare-one/account-limits/ ; API rate limits: developers.cloudflare.com/fundamentals/api/reference/limits/
- WebSockets and the 125 s proxy read timeout: developers.cloudflare.com/network/websockets/ ; developers.cloudflare.com/fundamentals/reference/connection-limits/
- SSE streaming through tunnels: developers.cloudflare.com/tunnel/troubleshooting/ ; response body buffering: developers.cloudflare.com/rules/configuration-rules/settings/
- 100 MB body limit: developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/
- Universal SSL and Total TLS: developers.cloudflare.com/ssl/edge-certificates/universal-ssl/ ; developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/
- HSTS: developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/ ; hstspreload.org
- Public Suffix List: github.com/publicsuffix/list/wiki/Guidelines ; publicsuffix.org/learn/
- Bot Fight Mode cannot be skipped; WAF Skip options: developers.cloudflare.com/bots/get-started/bot-fight-mode/ ; developers.cloudflare.com/waf/custom-rules/skip/options/
- SSL mode versus tunnel origins: developers.cloudflare.com/tunnel/troubleshooting/https-origins/
