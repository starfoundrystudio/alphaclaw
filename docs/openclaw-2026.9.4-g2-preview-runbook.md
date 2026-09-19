# OpenClaw 2026.9.4 — G2 preview control plane and branch-artifact install path

Status: prepared 2026-09-18 (Claude, taking over from Codex). Provisioning and
the 7.1→9.4 install are gated on Bill's go (see §6). Execution project
`TAoHXFTAly7M`, todo "G2".

## 1. What G2 needs and why a preview

G2 installs the `codex/openclaw-2026.9.4-upgrade` branch on a disposable,
production-shaped dual-VPS instance and runs T1–T11, including the real
7.1→9.4 crossing. Two constraints shape the setup:

- The instance must be provisioned by TeamYou (vault enrolment, gateway
  topology, enforced egress, TeamYou API key, callbacks) or T2/T5/T8 are not
  meaningful — but its database rows, API keys and Agent Vault bindings must
  not land in production.
- TeamYou provisioning installs only the `latest` or `beta` npm channel, and
  G3 deliberately withholds `beta` until G2 passes. So the 9.4 branch has to
  be delivered as a separate, immutable artifact after the 7.1 provision.

A Vercel preview deployment of TeamYou satisfies the first constraint: every
preview branch gets its own Neon database branch (forked from prod), the
provisioning workflow derives every instance-facing URL from the preview's
own origin (`VERCEL_BRANCH_URL`), and the preview is publicly reachable
(no Vercel Authentication or password protection on the project).

## 2. The dedicated preview

| Item | Value |
| --- | --- |
| Git branch | `preview/openclaw-2026.9.4-g2` (teamyou), created from `origin/main` @ `ff58eee3` (production code, 2026-09-17); head `9477051e` is an empty commit that only triggers the deployment (Vercel did not deploy the bare branch-create push) |
| Branch URL | `https://teamyou-git-preview-openclaw-202694-g2-star-foundry-studio.vercel.app` (stable across redeploys of the branch) |
| Database | Neon preview branch auto-created for this git branch; auto-migrated on deploy |
| Admin access | Clerk session `metadata.role === 'admin'` (same Clerk instance as other previews) |
| Admin panel | `<branch URL>/admin/openclaw-provisioning` |

Instance-facing origins derived from the branch URL by
`buildGatewayBootstrapPayload`: claim endpoint, `OPENCLAW_WEBHOOK_URL`,
`TEAMYOU_API_URL` (`/api/external/v1`), and the Agent Vault entry URL.

Preview environment pins that apply (preview-wide, not branch-scoped):

- Stable host-asset bundle `4c6e717d` (clawctl commit `11de923`, Node 24 from
  NodeSource, currently 24.21.0 ≥ the 9.4 engine floor of 24.16.0).
- `GITHUB_PACKAGES_TOKEN`, Hetzner token, `OPENCLAW_PROVISIONING_SSH_PRIVATE_KEY`,
  `TEAMYOU_AGENT_VAULT_ENROLLMENT_PRIVATE_KEY`, B2 backup and export keys,
  memory plugin 0.3.0, skill v3.2.1.
- `OPENCLAW_ENABLED_PROVIDERS=hetzner,digitalocean`,
  `OPENCLAW_DEFAULT_PROVIDER=digitalocean`, placement prefers DigitalOcean
  `sfo3` then Hetzner `hil`. Pick the provider explicitly in the admin panel.

What is *shared* with production even from a preview (not isolated):

- Hetzner/DigitalOcean cloud projects and billing.
- The Tailscale tailnet (`tail2cd802.ts.net`).
- Doppler: `DOPPLER_CONFIG` is empty on preview, so the setup password lands
  in `clawctl/prd` as `SETUP_PASSWORD__INST_<ID>` (deleted after delivery).
- The GitHub Packages registry (read-only token) and the public Blob store.

Provisioned 2026-09-18 19:45 UTC (Bill's go, DigitalOcean, `latest`):
instance `test-g2-oc94-01`, id `inst_6d8991266b5c4e36a357a2c3663e9557`, run
`wrun_01M2V0TH66ASFDTEP0RV6YPJ9R`, owner Clerk user
`user_2taVIm5bDGwqost9gEJDjjvTqk1` (bill@teamyou.ai on the development Clerk
instance, which is what previews use). The setup password lives only in the
session scratchpad.

Run reached `awaiting_user_setup` at 19:56 UTC (11 minutes end to end):
placement DigitalOcean `sfo3`, workload `s-4vcpu-8gb` (droplet 601798782),
gateway `s-2vcpu-2gb`, `egress_mode: enforced`, connectivity
`security_gateway` with the tailscale TCP bridge for SSH. The host reported
bootstrap completion to the preview webhook, and the first restic state
snapshot landed in `teamyou-openclaw-backups-preview` (snapshot
`f6b6b3fa…`), so callbacks and the backup pipeline both work from the preview.
Clawbridge setup: `https://cety8b2hubwj.openclaw.teamyou.ai`.

**Trap (hit 2026-09-18 20:55 UTC):** on previews TeamYou identifies users by
the custom `userId` session claim, which the development Clerk instance
fills from the account's `external_id` = the **production** Clerk id
(`user_2upQQHI8N2knceXnPNmLFf1LMdi` for Bill). `window.Clerk.user.id`
(`user_2taVIm5b…`) is therefore the wrong value for the admin panel's
"Owner Clerk user id": every owner-scoped surface (Your Team, the vault entry
page, `/api/external` data) missed the instance, and the vault entry showed
"OpenClaw instance was not found". Fixed in place by re-owning
`user_openclaw_instances`, `api_keys` (`zLSY8qy7ZYmO`), `connected_agents`
(`agt_otBjXOaBLkns`) and `agent_activity` rows to `user_2upQQ…` in the
preview DB. Rule: on a preview, use the production Clerk id as owner.
The vault on the security gateway had also recorded the old owner at
enrollment (`/var/lib/alphaclaw-agent-vault-bootstrap/owner-credential.json`
and `state.json`, plain JSON, compared by
`alphaclaw-agent-vault-bootstrap.py` → "The TeamYou owner does not match this
Agent Vault"); corrected in place with `.pre-reown.*` backups, no service
restart needed (the bootstrap service re-reads the files per request).

Gateway access: the workload's `gateway-setup` identity is sealed after
finalization, but the operator SSH key is authorized on both hosts, so
`ssh -A -J root@test-g2-oc94-01.tail2cd802.ts.net root@10.21.143.3` reaches
the gateway (`test-g2-oc94-01-gateway`, public `164.92.74.27`).

**Hazard:** the preview database is a fork of production, so the admin panel
also lists real production instances (`jasper-9496b6d0`, `milo-ef08cb89`)
with live **Destroy** buttons that act through the shared cloud tokens.
Never touch any row other than `test-g2-oc94-01` on this preview.

Operating rules:

- Do not delete the git branch while the instance exists — the preview DB
  goes with it and the run/instance rows are the only link to the servers
  (orphan recipe in memory `teamyou-admin-beta-channel`).
- Redeploys of the same branch keep the branch URL and the Neon branch.
- Destroy the instance from the preview's admin panel when results are
  captured, then delete the branch.

## 3. The immutable branch artifact

Built from `codex/openclaw-2026.9.4-upgrade` @ `c0171be` in a detached
worktree (`scratchpad/build-g2-artifact.sh`): version set locally to
`0.9.18-starfoundry.23-g2.c0171be` (never committed), `npm ci`, `npm pack`
(prepack regenerates the compatibility manifest and model-catalog bootstrap
with that version and builds the UI).

| Item | Value |
| --- | --- |
| Tarball | `starfoundrystudio-alphaclaw-0.9.18-starfoundry.23-g2.c0171be.tgz` |
| SHA-256 | `3f944f9f404ad3b5f5b093685b10119ceca603410c19b09b06be87a4020fe4dd` |
| URL | `https://k9uoabobegtoma9k.public.blob.vercel-storage.com/alphaclaw/branch-artifacts/sha256/3f944f9f404ad3b5f5b093685b10119ceca603410c19b09b06be87a4020fe4dd/starfoundrystudio-alphaclaw-0.9.18-starfoundry.23-g2.c0171be.tgz` |

**Artifact 2 (after G2 finding #1 fix, commit `251c321`):**

| Item | Value |
| --- | --- |
| Tarball | `starfoundrystudio-alphaclaw-0.9.18-starfoundry.23-g2.251c321.tgz` |
| SHA-256 | `23010076afa660d58b076b03fe7f0e50ef56595f28fc60b4c12175de70fec8ff` |
| URL | `https://k9uoabobegtoma9k.public.blob.vercel-storage.com/alphaclaw/branch-artifacts/sha256/23010076afa660d58b076b03fe7f0e50ef56595f28fc60b4c12175de70fec8ff/starfoundrystudio-alphaclaw-0.9.18-starfoundry.23-g2.251c321.tgz` |

Build note: the first rebuild failed in `generate-model-catalog-bootstrap`
("Failed to probe OpenClaw models for zai: count 0"); an immediate retry
passed, so the probe is flaky against upstream and the generator should
treat an errored probe like a thin one (prior-bootstrap fallback) — small
follow-up.

**Artifact 4 (bootstrap hand-off, commit `cf6be72`):** sha256
`e967fd93569918e20f4c4f0c720a47ec66ed2b5301b863b5ba149dbd6a35348f`, at
`https://k9uoabobegtoma9k.public.blob.vercel-storage.com/alphaclaw/branch-artifacts/sha256/e967fd93569918e20f4c4f0c720a47ec66ed2b5301b863b5ba149dbd6a35348f/starfoundrystudio-alphaclaw-0.9.18-starfoundry.23-g2.cf6be72.tgz`
(download-verified; full vitest 164 files / 1472 tests, exit 0). Installed
by run 5 (00:15 UTC, patched script and library already on the host).

**Artifact 5 (Add Model catalog merge, commit `e527110`):** sha256
`792729cce07342a902addf9cf56ca23b1f1cb19c6536987ce6f24c9d8fbc031b`, at
`https://k9uoabobegtoma9k.public.blob.vercel-storage.com/alphaclaw/branch-artifacts/sha256/792729cce07342a902addf9cf56ca23b1f1cb19c6536987ce6f24c9d8fbc031b/starfoundrystudio-alphaclaw-0.9.18-starfoundry.23-g2.e527110.tgz`
(download-verified; full vitest 164 files / 1473 tests, exit 0). Installed
by run 6 (02:00 UTC).

**Artifact 6 (GPT-5.5 denylist, commit `7e39d5b`):** sha256
`b750ee15c14aa9b619ceb830fa4e0604e5d65a33b1b5f1caa5b30a8118ea1414`, at
`https://k9uoabobegtoma9k.public.blob.vercel-storage.com/alphaclaw/branch-artifacts/sha256/b750ee15c14aa9b619ceb830fa4e0604e5d65a33b1b5f1caa5b30a8118ea1414/starfoundrystudio-alphaclaw-0.9.18-starfoundry.23-g2.7e39d5b.tgz`
(full vitest 165 files / 1478 tests, exit 0). Installed by run 7
(2026-09-19 03:42–03:44 UTC). Superseded the same hour: the live 9.4
inventory still carried Venice's `openai-gpt-55` / `-55-pro` rows.

**Artifact 7 (denylist aliases + generator retry, commit `63c2f50`):**
sha256 `1b5edd4808a0010d67950eb924391c4271e6369e3560be173e25791951fb0617`,
at
`https://k9uoabobegtoma9k.public.blob.vercel-storage.com/alphaclaw/branch-artifacts/sha256/1b5edd4808a0010d67950eb924391c4271e6369e3560be173e25791951fb0617/starfoundrystudio-alphaclaw-0.9.18-starfoundry.23-g2.63c2f50.tgz`
(full vitest 165 files / 1478 tests, exit 0). Installed by run 8
(03:57–03:59 UTC). **Current on the instance.** Two pack builds of the
intermediate commit `dfc8726` died on `spawnSync ETIMEDOUT` from single
provider probes (moonshot, then deepseek), which is what `63c2f50` fixes
in the generator (retry once, then carry the prior bootstrap forward).

**Artifact 8 (provider coverage + models.dev, commit `5e13372`):** sha256
`09bb94908933db3beadbbed69b6b2f1cdef48ef89e8f3adf750ca17b36ea2c9e`, at
`https://k9uoabobegtoma9k.public.blob.vercel-storage.com/alphaclaw/branch-artifacts/sha256/09bb94908933db3beadbbed69b6b2f1cdef48ef89e8f3adf750ca17b36ea2c9e/starfoundrystudio-alphaclaw-0.9.18-starfoundry.23-g2.5e13372.tgz`
(full vitest 165 files / 1481 tests, exit 0). Installed by run 9
(04:48–04:49 UTC). **Withdrawn** the same hour (external models.dev
dependency, see finding #7).

**Artifact 9 (pinned-catalog rework, commit `f7d3cc3`):** sha256
`2134cc7d2e4827a1a4a93cc7b733ce6e8e67af7232fd8e498f413d92c38edfb3`, at
`https://k9uoabobegtoma9k.public.blob.vercel-storage.com/alphaclaw/branch-artifacts/sha256/2134cc7d2e4827a1a4a93cc7b733ce6e8e67af7232fd8e498f413d92c38edfb3/starfoundrystudio-alphaclaw-0.9.18-starfoundry.23-g2.f7d3cc3.tgz`
(full vitest 165 files / 1482 tests, exit 0). Installed by run 10
(05:27–05:29 UTC). **Current on the instance.**

The path is sha256-addressed and written with `allowOverwrite: false`, so the
URL is immutable. It is not published to GitHub Packages and no dist-tag
moves; `latest` stays `0.9.18-starfoundry.22` (openclaw 2026.7.1) and `beta`
stays `0.9.18-starfoundry.20-beta.5`.

## 4. On-instance install path (7.1 → 9.4 branch)

The host scripts already accept any npm spec: `alphaclaw-host-upgrade.sh`
reads `ALPHACLAW_NPM_SPEC` from `/root/.alphaclaw-bootstrap.env` and runs
`npm install '<spec>'` in `/home/alphaclaw/app`. A tarball URL is a valid
spec and needs no registry auth. This mirrors clawctl's TUI upgrade
(`upgrade-instance-service.ts`), which edits the same file and runs the same
script.

**Finding (2026-09-18, verified on `test-g2-oc94-01`):** the published
host-asset bundle (`4c6e717d`, provenance commit `11de923`) does **not**
contain `alphaclaw-host-upgrade.sh`. TeamYou-provisioned hosts, which is
every production Pro instance, therefore have no upgrade script at all; only
clawctl-bootstrapped hosts do. The helper libraries the script sources are
present (`/usr/local/lib/alphaclaw/{teamyou-install,searxng-install,node-runtime}.sh`),
so the fix is to ship the script with the operator: copy
`assets/host/alphaclaw-host-upgrade.sh` from clawctl at the bundle's
provenance commit (`11de923`; byte-identical on
`codex/openclaw-2026.9.4-upgrade`, sha256
`c06c529e3ac3ab968b131cbbfa873eb0b5a40d9dc80af6af826b844300d5f63c`) to
`/root/` with mode 700, then run it. This applies to G4 as well and should be
written into the per-instance runbook; adding the script to the bundle is a
clawctl follow-up.

What the script does after `npm install` (matches plan §4 steps 3–7): stop
`alphaclaw.service`; `alphaclaw migrate --fix`; `openclaw doctor
--non-interactive --fix` via `alphaclaw openclaw-doctor-guard` with the
Gateway stopped and without `OPENCLAW_CONFIG_READONLY`; migrate again; plugin
registry refresh; `alphaclaw reconcile-openclaw-plugins`; doctor again;
migrate again; `finalize-openclaw-startup-state`;
`verify-openclaw-startup-state`; TeamYou artifact reconcile; restart. All
`alphaclaw` subcommands come from the newly installed package.

Host facts recorded on the 7.1 baseline: Node 24.21.0 (NodeSource), SQLite
3.53.4, `ALPHACLAW_ROOT_DIR=/home/alphaclaw/.alphaclaw`, config at
`/home/alphaclaw/.alphaclaw/.openclaw/openclaw.json`, state at
`/home/alphaclaw/.alphaclaw/.openclaw/state/openclaw.sqlite` plus a second
`/home/alphaclaw/.openclaw/state/openclaw.sqlite` in the service HOME domain
(the A4 split that W1.4 fixes; T7 must check which one survives). Config
after the wizard: primary model `vercel-ai-gateway/anthropic/claude-opus-4.8`,
no channel bound yet (`channels: {}`), plugins vercel-ai-gateway,
active-memory, usage-tracker, searxng, agent-vault, openclaw-teamyou-memory,
llama-cpp; memory slot `memory-core`; `tools.profile: full`.

The branch reads no new host-delivered env keys versus `main` (only
`CODEX_HOME`, set by AlphaClaw itself), so the stable bundle already on the
host is sufficient; no clawctl bundle republish is needed for G2.

```bash
# on the workload VPS as root (via the security gateway / tailnet)
cp -a /root/.alphaclaw-bootstrap.env /root/.alphaclaw-bootstrap.env.pre-9.4.$(date -u +%Y%m%dT%H%M%SZ)
sed -i "s#^ALPHACLAW_NPM_SPEC=.*#ALPHACLAW_NPM_SPEC='https://k9uoabobegtoma9k.public.blob.vercel-storage.com/alphaclaw/branch-artifacts/sha256/3f944f9f404ad3b5f5b093685b10119ceca603410c19b09b06be87a4020fe4dd/starfoundrystudio-alphaclaw-0.9.18-starfoundry.23-g2.c0171be.tgz'#" /root/.alphaclaw-bootstrap.env
grep ^ALPHACLAW_NPM_SPEC= /root/.alphaclaw-bootstrap.env
bash /root/alphaclaw-host-upgrade.sh 2>&1 | tee -a /var/log/alphaclaw-host-upgrade.log
```

Verify afterwards:

```bash
cd /home/alphaclaw/app && sudo -u alphaclaw npm ls @starfoundrystudio/alphaclaw openclaw --depth=0
sudo -u alphaclaw node -p "require('/home/alphaclaw/app/node_modules/@starfoundrystudio/alphaclaw/package.json').version"
systemctl status alphaclaw --no-pager | head -5
```

Expected: AlphaClaw `0.9.18-starfoundry.23-g2.c0171be`, openclaw `2026.9.4`,
resolved from the Blob URL. The runbook in `06-upgrade-plan.md` §4 (backup,
stop, install, Doctor with the Gateway stopped and `OPENCLAW_CONFIG_READONLY`
unset, start, verify) applies verbatim around this install step.

Rollback before Doctor migrates: restore the `.pre-9.4.*` env backup and
re-run the upgrade script (reinstalls `@latest`). After Doctor: restore from
the pre-upgrade snapshot, never a package downgrade.

### 4.1 7.1 state seeded for T1/T7 (2026-09-18 20:06–20:16 UTC)

- Bootstrap kickoff sent to `agent:main:main` at 20:06; model calls exit
  through the vault-brokered Vercel AI Gateway (HTTP 200, ~1.2–1.8 s).
- Ritual completed via Clawbridge chat: identity Claw/🐾, user Bill,
  `America/Denver`, channel choice Telegram (token to be entered in the
  Channels card). `BOOTSTRAP.md` deleted; `IDENTITY.md`, `USER.md`,
  `SOUL.md` written. The agent reports "Changes committed (383f4d2 / f64ffcb)"
  but the workspace is **not** a git repository (no `.git`); the commit
  claims are fabricated. Worth a T9 agent-behaviour note.
- Three-turn history in the main session (identity, Colorado/timezone
  answer, codeword `TANGERINE-42` saved to `workspace/memory/2026-09-18.md`).
  T7 recall question after the 9.4 restart: "what was the codeword?".
- 7.1 sessions are file-based: `agents/main/sessions/<id>.jsonl` +
  `sessions.json` + trajectory files (T1 expects the sessions migration step).
  `state/openclaw.sqlite` has 74 tables incl. `cron_jobs`, `cron_run_logs`,
  `migration_runs` (0 rows on 7.1), `exec_approvals_config`, device/pairing
  tables; the agent DB holds `auth_profile_store` (per-agent, pre-shared-store).
- Cron job `g2-t1-seed` (`48f27c76-…`, `*/20 * * * *`, agent main,
  best-effort delivery) added with `openclaw cron add` under the service env
  (no vault env needed for config writes; the CLI warns about the missing
  `TEAMYOU_API_KEY` env ref, which is expected outside the gateway env).
- TeamYou-backed memory activated after the ritual with a Gateway restart at
  20:15:23 (the activation restart from `alphaclaw-update-delivery` notes);
  the chat turn in flight at that moment was lost and had to be resent.
- Clawbridge 7.1 chat renders streamed assistant text with repeated
  fragments ("Locked in…" ×N) after a turn completes; cosmetic, pre-existing.

### 4.2 Pre-install state (2026-09-18 21:27–21:50 UTC)

- **Channel bound (Bill):** `channels.telegram` enabled, account `default`
  (`@phase_a_test_bot`), `botToken` is the env ref `${TELEGRAM_BOT_TOKEN}`
  whose `.env` value is an Agent Vault placeholder (`__agent_va…`); pairing
  `H838CDZG` approved via `openclaw pairing approve`; Gateway reloaded with
  the telegram plugin (7 plugins). T2/T5 prerequisites met.
- **Recovery point (plan §4 step 2):** fresh restic snapshots from the
  gateway before the install — state `82897d92…`, host `8078a2d8…`,
  gateway `f0a22cd2…` in `teamyou-openclaw-backups-preview`
  (`inst_6d89…/` prefix). Provider droplet snapshots were not taken: no
  DigitalOcean token is available locally (preview env is sensitive-typed);
  T10 restores from restic, which is the product's actual recovery path.
- **Upgrade script staged:** `/root/alphaclaw-host-upgrade.sh` (mode 700,
  sha256 `c06c529e…`, `bash -n` clean). Not run yet.
- **Doctor lint on 7.1 (plan §4 step 1):** `openclaw` on a managed 7.1
  host refuses to start outside the vault env ("proxy: enabled but no HTTP
  proxy URL"); the right wrapper is `alphaclaw openclaw-runtime -- openclaw
  doctor --lint --all --json` (routes through the local egress proxy on
  127.0.0.1:14322). Result: 51 checks, 39 findings, all warnings: 30
  skills-readiness (missing optional binaries), gateway-daemon/health (CLI
  outside the Gateway's device token, expected), security (flags
  `gateway.auth.token` and the telegram `botToken` env ref as "plaintext"; the
  latter is vault-brokered so this is a 7.1 lint quirk, telegram
  `groupPolicy=open` note), state-integrity (state dir and config perms).
  **No retired-key findings**, so no D12 cleanup is needed before Doctor
  `--fix`. Saved as `g2-doctor-lint-7.1.json` in the session scratchpad.

### 4.3 Install run 1 (2026-09-18 21:56–22:00 UTC) — failed at plugin reconcile

Steps that passed: Node/SQLite accepted; SearXNG reinstall; Gateway stopped;
`npm install` of the tarball (AlphaClaw `0.9.18-starfoundry.23-g2.c0171be`,
openclaw `2026.9.4`, resolved from the Blob URL); `alphaclaw migrate --fix`
(8 checked, 3 fixed: managed Gateway ownership defaults, managed runtime
defaults — `maxConcurrent=3`, `commands.restart=false` — and one more);
Doctor pass 1 with the Gateway stopped (migrated `plugins.bundledDiscovery`
→ shared SQLite state, retired shared-state tables, imported device auth /
identity / exec approvals / workspace state into SQLite, removed the
retired JSON; warnings only: device-pair plugin disabled, loopback bind,
unused skills); migrate re-run clean (0 pending, 0 failed); registry
refresh (37/65 enabled plugins indexed).

**G2 finding #1 — retired keys resurrected after Doctor, aborting the
upgrade.** Doctor removed `agents.defaults.memorySearch` and
`plugins.bundledDiscovery` at 21:58:19 (matrix row B3 expects exactly this).
During `alphaclaw reconcile-openclaw-plugins`, the llama-cpp and searxng
updates and the cohere install wrote clean configs, but the write that
landed at 21:59:27 right after `openclaw plugins install meta` (21:59:25,
which enabled `plugins.entries.meta` and touched `plugins.allow`) put both
keys back with their 7.1 values (`memorySearch.provider=local,
local.contextSize=2048`; `bundledDiscovery="compat"`). The next OpenClaw
CLI invocation (the opencode-go install) refused the config ("Unrecognized
key"), the reconcile failed, and the script exited leaving the service
stopped by design. Writer not conclusively identified: OpenClaw 9.4 has no
writer for either key (it only reads them as legacy), AlphaClaw's only
writer is `applyManagedSearxngWebSearchFallback` (sets
`bundledDiscovery="compat"`) and nothing in `lib/` writes `memorySearch`, so
the write came from an in-memory config object that predated Doctor's
cleanup. Backup chain kept as evidence (`openclaw.json.bak*`,
`openclaw.json.g2-failed-reconcile`).

**Recovery (worked):** with the Gateway still stopped, delete the two keys
from `openclaw.json` and re-run `alphaclaw reconcile-openclaw-plugins`; it
was idempotent (all plugins "already installed", vercel-ai-gateway updated)
and the keys did not return. Then re-run the upgrade script from the top.

**Branch follow-ups (block G3):** (a) make the retired-key strip part of
`alphaclaw migrate` and run it defensively after every OpenClaw CLI config
write in the reconcile, and stop `applyManagedSearxngWebSearchFallback`
from emitting `plugins.bundledDiscovery` on 9.4; (b) make the upgrade
script's reconcile step retry once after stripping known retired keys
instead of aborting; (c) find the stale-object writer (candidates:
`installManagedPluginWithConfigSuppression` / `runOpenclawCommandWithPluginRecovery`
paths in `lib/cli/openclaw-plugin-compat.js`, the usage-tracker managed
plugin config sync, `enforcePendingTeamyouBootstrapGate`).

### 4.4 Install run 2 (22:06–22:12 UTC) — failed at verify; writer identified

With the keys stripped, run 2 passed package install (no-op), migrations,
Doctor pass 1, registry refresh, **reconcile (clean)**, Doctor pass 2,
migrations, and `finalize-openclaw-startup-state`. It then failed inside
`verify-openclaw-startup-state`: that step runs AlphaClaw's *startup plugin
reconciliation* ("Config exists; running startup plugin reconciliation"),
which wrote `plugins.bundledDiscovery: "compat"` back (only that key this
time), and the next OpenClaw CLI call refused the config again. The finalize
step had also spawned an `openclaw gateway run` child that kept looping on
the invalid config (repeated `devices list failed`, watchdog Telegram
notification attempts); the script's own cleanup did not reap it, so the
script and its children were killed by hand and the service left stopped.

**Root cause (confirmed):** `applyManagedSearxngWebSearchFallback` in
`lib/server/web-search-config.js` writes `plugins.bundledDiscovery="compat"`
whenever SearXNG is configured and `tools.web.search.provider` is unset. It
runs from `ensureUsageTrackerPluginConfig` (every reconcile and every boot)
and from onboarding. On 9.4 the mode lives in `config_machine_state`
(`readBundledDiscoveryMode` → `readConfigMachineState("plugins.bundledDiscovery")`);
Doctor migrated the 7.1 value there, and the file key is now a validation
error. This would have broken every Gateway boot on 9.4, not only the
upgrade script. W2's retired-key audit (matrix B6/D12) missed this writer.

**Fix on the branch (this session):** stop writing the key in
`web-search-config.js`; strip both retired keys
(`agents.defaults.memorySearch`, `plugins.bundledDiscovery`) in
`ensureManagedOpenclawDefaults` (`managed-defaults-config.js`) so every
managed reconcile self-heals; tests updated (`usage-tracker-config`,
`onboarding-openclaw`) and a new case in `managed-defaults-config.test.js`.
The `memorySearch` re-add in run 1 is still unexplained (no writer in
`lib/`), hence the defensive strip. Committed as `251c321` on
`codex/openclaw-2026.9.4-upgrade` (full vitest: 163 files, 1467 tests,
exit 0); second artifact built from it as
`0.9.18-starfoundry.23-g2.251c321` (see §3 for coordinates).

**Open item for fresh 9.4 provisions:** existing instances keep
`bundledDiscovery=compat` via Doctor's machine-state migration; a fresh 9.4
provision gets no mode at all. Verify bundled-plugin discovery and SearXNG
web search on a fresh provision at G3 (the searxng plugin is installed as an
npm plugin by the reconcile, so this is probably moot, but it is untested).

### 4.5 Install run 3 (22:19–22:30 UTC, artifact 2) — two more findings

Run 3 passed every step through Doctor pass 2 and migrations, then hung.

**G2 finding #2 — the host upgrade script calls a CLI command the 9.4
branch removed.** W2 (commit `15ce9a8`) retired
`alphaclaw finalize-openclaw-startup-state` (residual Codex-sidecar
archival). `alphaclaw-host-upgrade.sh` still calls it, and `bin/alphaclaw.js`
has no unknown-command guard, so the call **started the full AlphaClaw
server in the foreground** (Express on :3000, Gateway child, startup plugin
reconciliation) under the script and never returned. Runs 2 and 3 both hung
there and had to be killed by hand; the stray Gateway kept looping on the
invalid config. Fixes: (a) clawctl: drop the step for 2026.9.4 hosts (the
staged copy on this host is patched to log "Skipping residual legacy Codex
binding archival", original kept as `.orig-c06c529e`); (b) AlphaClaw:
reject unknown subcommands instead of falling through to server start
(follow-up on the branch). `verify-openclaw-startup-state` still exists and
stays.

**G2 finding #1, continued — the writer is in the server runtime.** With
artifact 2 (no SearXNG writer) the keys still came back: the Gateway spawned
by the mis-dispatched step loaded a *valid* config at 22:22:08, and by
22:24:51 the file carried both retired keys again with their 7.1 values
(config reload refused). The file was byte-identical to `openclaw.json.bak`,
i.e. the write was a no-op rewrite of content that had already reappeared
by 22:21:18. Doctor is exonerated: a direct `openclaw doctor --fix` on a
stripped file changed nothing and left `memory.search`. No AlphaClaw code
copies `.bak` back and OpenClaw 9.4 has no writer for either key, so a
server-side writer persisted a stale in-memory copy ~2.5 min after boot.
Not pinned to a call site (24 `writeOpenclawConfig` callers, plus two raw
`fs.writeFileSync` writers in `gmail-watch.js` and `composio-install.js`).

**Fix (commit `8b8ca91`, amends the earlier strip):** `writeOpenclawConfig`
in `lib/server/openclaw-config.js` now strips `agents.defaults.memorySearch`
and `plugins.bundledDiscovery` from a copy before serializing, so no caller
can persist them whatever object it holds. Tests:
`tests/server/openclaw-config.test.js`. The two raw writers bypass the guard
(both do fresh read-modify-write, low risk) — fold them into the shared
writer as a follow-up. Also learned: the branding guard test forbids the
internal brand token anywhere in `lib/`, including comments.

Artifact 3: `0.9.18-starfoundry.23-g2.8b8ca91`, sha256
`6610a9c4cf45c65796e3a6fb5d9de59afd04fecf3d77d2ecaadf85c0ea6ef66b`, at
`https://k9uoabobegtoma9k.public.blob.vercel-storage.com/alphaclaw/branch-artifacts/sha256/6610a9c4cf45c65796e3a6fb5d9de59afd04fecf3d77d2ecaadf85c0ea6ef66b/starfoundrystudio-alphaclaw-0.9.18-starfoundry.23-g2.8b8ca91.tgz`
(download-verified; full vitest 164 files / 1470 tests, exit 0).

### 4.6 Finding #1 root cause — clawctl's on-host TeamYou install library

The stale writer is **not** in AlphaClaw. With the service stopped and no
stray processes, the keys reappeared at exactly 22:30:18, the second
`alphaclaw-post-onboard-reconcile.service` ran. That host timer (every 5
min) calls `reconcile_teamyou_install` from
`/usr/local/lib/alphaclaw/teamyou-install.sh` (clawctl
`assets/host/lib/teamyou-install.sh`, shipped in bundle `4c6e717d`), whose
memory-plugin reconcile node snippet unconditionally writes
`config.plugins.bundledDiscovery = "compat"` (when TeamYou memory is
activated) and a default `config.agents.defaults.memorySearch = {provider:
"local", local: {contextSize: 2048}}`, then `fs.writeFileSync` on
`openclaw.json`. The same library is sourced by the upgrade script's own
`reconcile_teamyou_install` step, which is why run 1 saw the keys return
mid-reconcile and why every Doctor cleanup was undone within minutes.

On this host the library is patched in place (`.orig-bundle-4c6e717d`
kept): both writes removed and both keys deleted defensively; the AlphaClaw
side keeps the writer-level strip (`8b8ca91`) as defence in depth.

**G3/G4 blocker:** every TeamYou-provisioned host runs this timer. A 9.4
install on a host that still carries the 7.1 library will be re-poisoned
every five minutes (Gateway keeps its in-memory config after "config reload
skipped", but every CLI call and therefore every Clawbridge action that
spawns `openclaw` fails). Before any 9.4 install: publish a clawctl bundle
with the fixed library (and the finalize-step removal from finding #2), pin
it on Preview beta for G2/G3 fresh provisions, and update
`/usr/local/lib/alphaclaw/teamyou-install.sh` on each existing host as part
of the per-instance runbook (the bundle has no host-assets reinstall script;
copy the file explicitly).

Both fixes are committed on clawctl `codex/openclaw-2026.9.4-upgrade` as
`455ed6e` (`assets/host/lib/teamyou-install.sh`, `alphaclaw-host-upgrade.sh`;
host-assets and node-runtime tests pass), not yet pushed and not yet
published as a bundle. Both are **gated by the installed version** so one
bundle serves 7.1 and 9.4 hosts: the library receives
`OPENCLAW_INSTALLED_VERSION` and only stops writing / starts deleting the
retired keys on 2026.9+, and the upgrade script runs the finalize step
only when `alphaclaw help` advertises it. A bundle built from this commit
therefore cannot trap a 7.1 provision, and pins stay independent: publish
is content-addressed and changes no pin; pin it on **Preview beta** only,
leaving stable (production and preview `latest`) on `4c6e717d`.

Verification: with the library patched and the file stripped at 22:35:29,
the reconcile timer ran at 22:40:25 and rewrote `openclaw.json`; both keys
stayed absent and the TeamYou memory plugin stayed enabled.

Install run 4 (started 22:41:09 UTC) uses the patched script and library
with artifact 3.

### 4.7 Install run 4 (22:41:09–22:43:56 UTC) — 7.1 → 9.4 crossing complete

Artifact 3 + patched script + patched host library: every step passed and
the service restarted cleanly. Post-install state:

- AlphaClaw `0.9.18-starfoundry.23-g2.8b8ca91`, openclaw `2026.9.4`;
  `alphaclaw.service` active; Gateway `http server listening (8 plugins:
  active-memory, agent-vault, llama-cpp, memory-core,
  openclaw-teamyou-memory, telegram, usage-tracker, vercel-ai-gateway)`,
  `ready` at 22:43:56; `/startupz` 200, `/readyz` 200 (T3 readiness gate
  path works). Telegram polling ingress started.
- Config valid: no retired keys; `memory.search={provider: local}`;
  `agents.entries.main` (no `agents.list`, W1.1); managed defaults present
  (`maxConcurrent=3`, `commands.restart=false`, `tools.deny=["secrets"]`,
  `tools.swarm=false`, `gateway.cliAgents/terminal.enabled=false`,
  `telemetry.enabled=false`, `secrets.egressProxy.enabled=false`,
  memory-core `dreaming.enabled=false`, workshop `autonomous.mode=propose`)
  — T6 config-side evidence.
- **T1 migration evidence** (`migration_runs`, all `completed`):
  `state:cron-run-logs-to-task-runs:v1`, `device-identity-json:…`,
  `shared-auth-store:…`, `exec-approvals-json:…`,
  `workspace-attestation:…`, `workspace-setup:…`. `config_machine_state`:
  `auth.sharedStore={"location":"state-db"}`, `authProfiles.store` and
  `authProfiles.state` in the state DB (W1.2), `plugins.bundledDiscovery=
  "compat"` (migrated), `plugins.installedIndex`, `modelCatalog.remote`.
  Retired JSON handled: `devices/paired.json.migrated`,
  `pending.json.migrated`, `exec-approvals.json` removed. Cron: seed job
  `g2-t1-seed` survived and **ran on 9.4** (session
  `agent:main:cron:48f27c76…`, `cron_run_receipts=2`) alongside the new
  `heartbeat-main` and `skill-collection-review-main` jobs. Main session
  `agent:main:main` keeps its 7.1 id `693626ac…`; the 7.1 JSONL transcript
  and `sessions.json` are gone from `agents/main/sessions/` (only
  `*.trajectory-path.json` remain), i.e. transcripts moved into the store —
  history visibility to be confirmed in Clawbridge chat (T7).
  `workspace/memory/2026-09-18.md` (codeword) intact.
- The reconcile timer keeps running under the live service; the patched
  library no longer touches the retired keys.

Note: a "sessions" migration step is not listed by name in
`migration_runs`; the plan's T1 criterion should be re-expressed against
the 9.4 step ids above.

### 4.8 Test results so far (22:48–22:57 UTC)

- **T3 supervisor restart — in-process variant: PASS.** `openclaw gateway
  restart` → "restart request sent to externally supervised process";
  Gateway fenced admission, drained, `restart mode: in-process restart
  (OPENCLAW_NO_RESPAWN)`, `ready` after 2.7 s, no Doctor, `/startupz` and
  `/readyz` 200. Supervisor kept its child (`alphaclaw start` → `openclaw
  gateway run` → `openclaw-gateway`).
- **T3 crash variant — PASS with a caveat.** SIGKILL on `openclaw-gateway`
  (22:54:24): the supervisor ran Doctor through `openclaw-doctor-guard`
  (Gateway unreachable, lazy-Doctor path) and relaunched; `ready` at
  22:56:26, i.e. ~2 min of downtime, then `/startupz`/`/readyz` 200 with a
  properly parented launcher → gateway pair. No crash loop. Caveat: a hard
  crash has no handoff row, so the "relaunch without Doctor" path was not
  exercised by this variant; the plan's criterion needs splitting into
  handoff-restart (pass) and crash (Doctor-first, slow but correct).
- **G2 finding #3 (T3, launcher death orphans the Gateway).** SIGKILL on
  the `openclaw gateway run` launcher (22:50:17) left `openclaw-gateway`
  running reparented to PID 1 and still serving; the supervisor relaunched
  a launcher, which refused with **exit 78** ("Another gateway (pid …)
  already owns this state directory"), and then stopped. Result: a healthy
  but *unsupervised* Gateway until the next full restart. W3 should either
  adopt the orphan (readiness probe succeeds) or force-stop it after the
  drain window and relaunch. Not a customer-facing outage, but the
  supervisor's crash classification is wrong for this case.
- **T6 managed defaults: PASS.** `openclaw config get` on 9.4:
  `agents.defaults.maxConcurrent=3`, `commands.restart=false`,
  `tools.swarm=false`, `tools.deny` includes `secrets`,
  `gateway.cliAgents.enabled=false`, `gateway.terminal.enabled=false`,
  `telemetry.enabled=false`, `secrets.egressProxy.enabled=false`,
  memory-core `dreaming.enabled=false`, workshop `autonomous.mode=propose`,
  `update.checkOnStart=false`, `memory.search.provider=local`.
- **T2 vault routing: partial.** Gateway and CLI processes log `routing
  process HTTP traffic through external proxy http://127.0.0.1:14323`
  (shim) / `:14322` (vault proxy); model calls to the AI Gateway succeed
  through it. Channel send and `web_fetch` through the proxy still to be
  exercised (Telegram round trip needs Bill's chat).
- **T1 history visibility: PASS.** Clawbridge chat on 9.4 renders the full
  pre-upgrade main-thread conversation (identity ritual, check-ins,
  codeword); the cron session `agent:main:cron:48f27c76…` also appears.
  Footer: `OpenClaw 2026.9.4 (3a9d69d) / Clawbridge 0.9.18-starfoundry.23-g2.8b8ca91`.
- **T7 recall across the upgrade and two restarts: PASS.** "Post-restart
  check: what was the codeword?" → "TANGERINE-42. Survived the restart. 🐾"
  (23:28 local). Ritual completion, TeamYou memory activation gate and
  three-turn continuity all held; the Claude-login/MCP-turn and managed
  Codex `CODEX_HOME` parts of T7 remain.
- **T8 advanced Control UI gate: PASS** (23:3x UTC, curl with a real
  Clawbridge login cookie plus the pane):
  - Before acknowledgement, an authenticated session gets **403
    "Advanced OpenClaw access acknowledgement required"** on `/openclaw`,
    `/openclaw/`, `/openclaw/index.html`, `/openclaw/sw.js`,
    `/openclaw/assets/index.js`, `/openclaw/manifest.webmanifest`,
    `/openclaw/api/health`; WebSocket upgrades on `/openclaw` and
    `/openclaw/ws` → 403; legacy `/ws` → 404. Direct HTML navigation shows the
    TeamYou-branded interstitial (`teamyou.advanced-control-warning/v1`,
    managed configuration `2026-09-18.1`, TeamYou-only copy, checkbox +
    "Acknowledge and continue" / "Return to Clawbridge").
  - `POST /api/advanced-control/acknowledge` → `{acknowledged: true,
    auditId: 1, warningVersion, managedConfigRevision}`; afterwards
    `/openclaw/index.html` 200 (Control UI HTML with
    `data-openclaw-control-ui-base-path="/openclaw"`), `/openclaw/sw.js` 200,
    `/openclaw` 302 → app. The audit row carries `userIdentity`
    (william.krueger@gmail.com), `sessionId`, `instanceId`, `warningVersion`,
    `managedConfigRevision`, `clientIp` (10.21.143.3 = the security gateway,
    one trusted hop), `acknowledgedAt`.
  - A **fresh login** (new cookie jar) is blocked again (403): the
    acknowledgement is session-scoped.
  - In the pane, the Control UI renders at `/openclaw/chat` with the
    persistent amber **"Advanced — unmanaged changes"** label. On first reach
    it shows OpenClaw's own "This Gateway expects its token" screen; the
    Clawbridge launch modal documents this as the designed path ("OpenClaw may
    ask Clawbridge to approve the browser here", device pairing approved from
    Clawbridge, opens in a new tab). The new-tab flow cannot be driven from
    the pane; complete the pairing hand-off in a normal browser (T8/T9
    residual). Clawbridge General now carries an "Advanced OpenClaw controls
    / Review access" card instead of the old launcher.
- **Telegram after the upgrade (T2 leg, observation):**
  `channel_pairing_allow_entries` holds the migrated approval
  (`telegram/default`, 1 row) and `openclaw pairing list` shows no pending
  requests, yet Clawbridge's Channels card reads "Awaiting pairing / Pending
  Pairings". Either the card derives state from a source 9.4 no longer feeds
  (Clawbridge display bug, T9 candidate) or the allow entry lacks the paired
  user. Decide by sending the bot a message: a reply without a new pairing
  code means display-only.
- **T2 channel leg: PASS** (Bill, 23:5x): a Telegram message to
  `@phase_a_test_bot` got a normal reply with no new pairing code, so the
  migrated allow entry is live and the Clawbridge "Awaiting pairing" card is
  **display-only** (T9 item: Clawbridge derives the card from a 7.1 source
  9.4 no longer feeds).
- **T8 hand-off / T9 observation (23:5x):** in Bill's browser the Control UI
  showed OpenClaw 9.4's "Approve this browser" screen (request
  `ae7cc9c4…`, client `openclaw-control-ui`, scopes `operator.admin/read/
  write/approvals/questions/pairing`, remote IP = security gateway). The
  Gateway's pairing request reached Clawbridge (`GET /api/devices` listed it)
  and approval through Clawbridge's own route (`POST
  /api/devices/<id>/approve`) succeeded, after which the pending list was
  empty — the managed approval path works. Two T9 notes: (a) Clawbridge only
  surfaces browser-pairing requests inside the launcher modal
  (`use-dashboard-launcher.js`), not on General's "Pending Pairings" card or
  Nodes, so a user who closed the modal sees only OpenClaw's upstream copy
  telling them to run `openclaw devices approve` on the Gateway host — a
  Control-UI-only instruction the capability contract wants avoided;
  (b) the CLI probe device from the upgrade (`clientId: cli`) was
  auto-approved via the `cliAutoApproveComplete` marker as designed.
- **Decision (Bill, 2026-09-18): no host-command instructions may reach
  the customer; remove the browser-pairing screen via OpenClaw 9.4's native
  bootstrap hand-off (option 1).** `openclaw dashboard --no-open --json`
  mints a one-time, ~10-minute `browserUrl` whose fragment carries
  `bootstrapToken` + `bootstrapProfile=owner` + `gatewayUrl`; a browser that
  connects with it is paired inline (`isControlUiOperatorBootstrapProfile`),
  so no device request is created. Implemented on the branch:
  `GET /api/gateway/dashboard` now tries the bootstrap URL first, rewrites
  it onto `/openclaw/#…` with `gatewayUrl=wss://<request origin host>/openclaw`
  (origin from `getRequestOrigin`, i.e. the caller's own host through the
  trusted proxy), returns `source: "bootstrap"` + `expiresAtMs`, and falls
  back to the existing shared-token hand-off when the CLI has no `--json`
  or returns no `browserUrl` (7.1). The launcher already fetches this URL on
  every modal open, so the one-time token is minted at launch time after the
  acknowledgement; the `/openclaw` WebSocket relay is `http-proxy`'s
  byte-level `proxy.ws`, so the connect frame reaches the Gateway untouched.
  `gateway.auth.mode` stays `token`; internal clients are unaffected. The
  trusted-proxy auth mode (`gateway.auth.trustedProxy.deviceAutoApprove`)
  remains the long-term per-person design once Clawbridge authenticates
  people individually (assessment 05 §2). Tests: `routes-system.test.js`
  (bootstrap rewrite, no shared token in the URL, JSON-without-browserUrl
  fallback, 7.1 CLI fallback).
- **Bootstrap hand-off proven (artifact 4, run 5, 00:15–00:24 UTC).**
  Run 5 passed every step (migrations 0/0/0, reconcile clean, finalize
  skipped, verify, restart; `readyz` 200 on the first poll). Before:
  `GET /api/gateway/dashboard` → `source: "config"`, `/openclaw/#token=…`.
  After: `source: "bootstrap"`, `expiresAtMs`, and
  `/openclaw/#bootstrapToken=…&bootstrapProfile=owner&gatewayUrl=wss%3A%2F%2Ftest-g2-oc94-01.tail2cd802.ts.net%2Fopenclaw`.
  With the pane's storage cleared (fresh device identity), navigating to that
  URL landed directly on `/openclaw/chat/main` ("Main Agent — OpenClaw") with
  the amber label and **no pairing or token screen**. Gateway log:
  `device pairing auto-approved device=44b4a47e… role=operator`; `openclaw
  devices list` shows the new browser `approvedVia=bootstrap` (7 scopes)
  next to Bill's earlier one (`approvedVia=owner`) and the CLI probe;
  `/api/devices` pending = 0 before and after. The customer path now never
  shows a host-command instruction.
- **T2 vault routing: PASS** (00:47 UTC). `web_fetch` of
  `https://example.com/` through the agent returned "Example Domain" / 200
  (tool call visible in Clawbridge chat). Egress evidence on the DigitalOcean
  workload (`ALPHACLAW_EGRESS_MODE=enforced`, host-route mode): `0.0.0.0/1`
  and `128.0.0.0/1` route via the security gateway `10.21.143.3`, so a
  "direct" curl from the workload exits with the **gateway's public IP
  164.92.74.27** (api.ipify.org), i.e. every byte transits the gateway; the
  Gateway and CLI additionally route HTTP through the vault proxy shim
  (`127.0.0.1:14323` → `14322`) for placeholder substitution, which the
  model calls (vault-held AI Gateway key) and the Telegram round trip
  (vault-held bot token) already exercised. Nothing dials direct.
- **T4 (managed config ownership) — Clawbridge side: PASS.**
  `POST /api/models/set` (Clawbridge write path, read-only var unset) →
  `{ok: true}`; `POST /api/doctor/run` from Clawbridge → run started
  (`runId: 1`, in progress; result below once it finishes). Control UI side
  (writes refused with the managed-by-TeamYou message) recorded under T4A.
- **T11 dynamic model catalog: PASS (lifecycle part).** `POST
  /api/models/refresh` → `source: "openclaw"` (Gateway-published inventory
  is authoritative), 249 models, `restartRequired: false`,
  `hostedCatalog.restartRequired: false` surfaced in the payload; `GET
  /api/models/status` → `vercel-ai-gateway/anthropic/claude-opus-4.8`, no
  fallbacks. The static bootstrap catalog was regenerated by prepack for
  each artifact (generator probe flake noted in §3).
- **T4A Control UI writes refused: PASS.** Agents → edit name → Save in
  the Control UI (paired, acknowledged session) → toast
  `ConfigReadOnlyError: Config is externally managed
  (OPENCLAW_CONFIG_READONLY=1), so OpenClaw treats openclaw.json as
  immutable…`. Labs renders its experimental toggles without any control
  elements under read-only. The refusal is upstream's wording ("edit the
  config in your external deployment source"), not the clear
  managed-by-TeamYou message the plan asked for — T9 item; the interstitial
  and amber label carry the expectation-setting today.
- **T4C Doctor with the variable unset: PASS (by the guard path).**
  Clawbridge's `POST /api/doctor/run` is the *workspace* doctor
  (`engine: gateway_agent`, run 1 completed 00:52). The OpenClaw
  `doctor --fix` path from Clawbridge/watchdog is `alphaclaw
  openclaw-doctor-guard`, which ran with `OPENCLAW_CONFIG_READONLY` unset
  in every upgrade run and in the T3 crash relaunch (Gateway stopped, config
  migrated, no refusal).
- **T5 strict channel-token sweep: PASS with a design note.** With the
  Gateway running, a well-formed fake Telegram token was written as a
  literal into `channels.telegram.accounts.default.botToken` (bypassing the
  writer, i.e. the "read-only off" simulation) and the service restarted.
  Within one reconcile tick (~9 s after restart) the literal was replaced by
  the vault env ref `${TELEGRAM_BOT_TOKEN}`; no `openclaw.json.bak*`, the
  `.env`, or anything under the state dir retained the literal. No proposal
  was opened and no banner shown (`migrationProposals: []`,
  `quarantinedConfigPaths: []`) because the slot is already vault-managed:
  the placeholder reconcile discards the pasted value rather than migrating
  it. Reasonable for this slot; decide whether a pasted *new* token for an
  already-managed slot should raise a rotation proposal instead of being
  silently dropped (Bill).
- **T9 agent-behaviour probe: PASS.** Asked in chat how to change the model
  and raise thinking: the agent pointed to the Clawbridge dashboard → Models
  screen, explained that keys go to Agent Vault with only a placeholder on
  the instance, offered `/reasoning` for the per-session thinking toggle,
  and said it cannot change managed model config itself. No Control UI
  reference, no host commands.
- **T9 review items collected so far:** (1) Telegram card shows "Awaiting
  pairing" for a working channel; (2) browser-pairing requests only surface
  in the launcher modal (moot with the bootstrap hand-off, keep as fallback
  UX); (3) Control UI write refusals use upstream wording; (4) T5 silent
  discard vs rotation proposal; (5) launcher-death orphan (finding #3).
- **T11: PASS (lifecycle part)** as recorded above; the "hosted catalog
  restart requirement" surfaced as `restartRequired: false` fields, not
  exercised in the true state.
- **G2 finding #4 (Bill, T11/W5c): Clawbridge "Add Model" dialog shows no
  providers for Subscription and Provider API Key, and only the configured
  Vercel AI Gateway under Gateway.** Root cause: on 9.4 `GET /api/models`
  changed shape. Top-level `models` is the Gateway-published inventory of
  the *configured* providers only (372 entries, all
  `vercel-ai-gateway/…`, 249 tagged `accessModes:["gateway"]`, 123
  untagged), while every other provider's catalog now lives under
  `accessModes[mode].providers[].models` (1,137 model keys: claude-cli,
  openai, anthropic, deepseek, novita, openrouter, kilocode, …). The client
  helper `getModelCatalogModels()` returns only top-level `models`, and
  `getModelCatalogAccessModes()` has no consumers, so the Add Model dialog
  (`add-model-modal.js` → `getProviderOptionsForAccessMode`), the Models
  tab, and the welcome wizard's "See all model options" only ever see the
  configured provider. Reproduced in the pane: Subscription 0 providers,
  Provider API Key 0, Gateway → "Vercel AI Gateway" with all 372 models.
  Fix: merge `accessModes.*.providers[].models` into the client catalog
  (dedupe by key, keep explicit `accessModes`), one helper change with a
  test; all consumers benefit. Release-critical for W5c ("agent
  model/fallback" controls) and T11. **Fixed:** `e527110` (pushed),
  artifact 5 installed by run 6 (02:02 UTC). Verified in the pane after a
  forced reload: Provider API Key → 12 providers (Anthropic first, 7
  models), Gateway → OpenRouter, Kilo Gateway, Vercel AI Gateway,
  Cloudflare AI Gateway (373 Vercel models), Subscription → models
  populated (GPT-5.6 Luna/Sol/Terra, GPT-5.5).
- **G2 finding #5 (Bill): the AI Gateway key shows "stored on this server —
  copy it, then enter it on the approval page" with a "Move key to Agent
  Vault" button.** Not a 9.4 regression; it is the designed "bootstrap
  lane" in `docs/vault-brokered-model-keys-spec.md` §B: the vault runtime
  token is claimed *after* onboarding (needs tailnet + owner enrolment,
  here `runtime.json` at 20:03 vs the wizard's model step minutes earlier),
  so the wizard collects a raw key into `.env` (`AI_GATEWAY_API_KEY=vck_…`,
  still there today) and the auth profile in the state DB. The runtime
  token is **proposal-only**: the instance cannot copy an on-box secret into
  the vault, so migration needs one owner action (`POST
  /api/models/vault-key` → `ensureModelProviderAccess` → `pending` proposal
  → owner pastes the key on the vault approval page; once the vault reports
  the credential `available`, the reconcile flips `.env` to the
  placeholder). Automatic post-setup migration is therefore impossible under
  the current custody model. Options: (a) onboarding redesign (spec Phase D
  / "provision-time seeding"): enrol the vault *before* the model step and
  have the wizard hand the key from the browser to the vault approval page
  so it never touches the instance; (b) cheaper interim: after setup,
  auto-open the migration proposal and deep-link the approval page with a
  prominent Clawbridge banner, still one paste. **Decision (Bill,
  2026-09-19):** neither now; handled by the spec's Phase D
  (provision-time key seeding by TeamYou, so onboarding never sees a raw
  key and nothing is gated on the tailnet). Enrolling the vault before
  the model step was rejected because owner enrolment is a manual,
  tailnet-only step that would gate the wizard. Not a 9.4 item.
- **G2 finding #6 (Bill): GPT-5.5 must not be selectable.** ChatGPT
  subscription access to GPT-5.5 was terminated and it hurt users. On 9.4
  it is still pinned in four places: `model-catalog-support.json`
  `explicitModels` (`openai/gpt-5.5` subscription+provider-api,
  `openrouter/openai/gpt-5.5`), the client `kKnownOnboardingModels`
  (`openai/gpt-5.5`, `kilocode/openai/gpt-5.5`) and the gateway preferred
  list (`kilocode/openai/gpt-5.5` as third choice), the server
  `kFeaturedOnboardingModels`, and welcome copy ("Opus, Sonnet, or
  GPT-5.5"). Live inventories add more variants (Vercel `gpt-5.5`,
  `-pro`, `-fast`; OpenRouter `:batch`; Kilo `-pro`). Observed defaults in
  the Add Model dialog: Kilo Gateway → GPT-5.5, Cloudflare AI Gateway →
  GPT-5.5, Subscription list includes GPT-5.5. Fix: a catalog-wide deny rule
  (every `…/openai/gpt-5.5*` key) applied both at pack time and at runtime
  to the Gateway-published inventory, plus removal from the pinned lists and
  copy; existing configs that reference it get flagged, not rewritten.
  **Fixed:** `7e39d5b` + `dfc8726` + `63c2f50` (pushed). New
  `lib/server/model-denylist.js` is the single rule: key pattern
  `(^|/)openai[/-]gpt-?5.?5(?![0-9.])` (covers every gateway prefix, `-pro`
  / `-fast` / `:batch` variants and Venice's `openai-gpt-55` spelling) plus
  a label rule (`GPT-5.5…`) for reseller aliases not yet seen. Applied to
  GET `/api/models` and POST `/api/models/refresh` (top-level `models`,
  every `accessModes.*.providers[].models` and `recommendedModelKeys`), to
  POST `/api/models/set` and PUT `/api/models/config` (400 "… is not
  available on this instance; choose another model" for primary or any
  configured key), and by the bootstrap generator at pack time. Support
  spec drops the 5 GPT-5.5 `explicitModels` and the OpenAI allowlist
  entries (OpenAI probe minimum 5 → 4); client `kKnownOnboardingModels`,
  gateway preferred keys, server `kFeaturedOnboardingModels` and the
  welcome copy ("Opus, Sonnet, or GPT-5.6") no longer mention it. Existing
  configs are not rewritten (the test instance's primary is Opus 4.8, so
  nothing to flag here). Verified on the instance after run 8: GET
  `/api/models` (source `cache`, 246 models) and a forced refresh (source
  `openclaw`) contain zero GPT-5.5 aliases in any access mode; `set` and
  `config` with a GPT-5.5 key return 400; the served `app.bundle.js` has
  zero GPT-5.5 references. Not re-checked in the browser pane (each pane
  visit costs Bill an approval prompt; the API and bundle are what the
  dialog renders from).
- **G2 finding #7 (Bill): Provider API Key coverage and freshness.**
  (a) xAI/Grok, Google, Groq, MiniMax, Mistral-class providers are absent
  because the support spec declares only 25 providers and xAI, Google,
  Groq and MiniMax are not among them (the vault-brokering list does know
  xai/google/minimax), so they are never probed. (b) Declared providers
  whose plugin isn't installed at pack time (moonshot, mistral, cohere,
  byteplus, volcengine, xiaomi, github-copilot) fail the 9.4 probe with
  "Unknown model catalog provider" or return 0 models with a placeholder
  key; the generator then keeps the **prior bootstrap's list**
  (`source: prior-bootstrap-fallback`), which is why Moonshot shows only
  the 7.1-era Kimi K2.x entries. Only OpenRouter and Vercel have a
  `publicModelCatalog` fallback. Live on the instance, `openclaw models
  list --provider moonshot` is refused until the plugin is installed and
  xai/google enumerate nothing without a real key; once a provider is
  configured the Gateway inventory takes over (T11), so the static list is
  only ever the pre-configuration preview. Fix direction: declare the
  missing providers; give every provider-api provider a public catalog
  source (e.g. OpenRouter's public list filtered by upstream provider, or
  models.dev) so pack-time lists are current without keys; make the
  generator install the probe plugins it needs; and stop carrying forward
  prior lists silently (warn instead).
  **Fixed:** `5e13372` (pushed), Bill's go 2026-09-19. Findings while
  implementing: the generator *already* installs every declared probe
  plugin in its temp home; the real gap is that plugin providers
  (moonshot, deepseek, zai, fireworks, mistral, cohere …) and the core
  google/minimax providers return **zero** models with a placeholder key
  (only anthropic, openai, xai, together, venice, novita, nvidia,
  ollama-cloud, tencent and the gateways have static catalogs), so the
  prior-bootstrap carry-forward was the only thing populating them. Fix:
  (1) declare `xai`, `google` (Gemini), `groq` (managed plugin) and
  `minimax` as provider-api providers, and register Groq with the vault
  broker (`api.groq.com`) because the vault test requires every
  env-keyed provider to be brokerable; (2) new `models.dev` public catalog
  source in the generator, one fetch of `https://models.dev/api.json`,
  text-in/text-out rows only, ids used verbatim (OpenClaw's registry is
  built from models.dev, verified by key overlap: zai 14/14, ollama-cloud
  20/20, tencent 3/3, venice 103/115, and the dist's own
  `google/gemini-3.1-pro-preview`, `minimax/MiniMax-M3`, `xai/grok-…`
  strings); declared on 15 providers incl. Cloudflare AI Gateway, whose
  only row (GPT-5.5) the denylist had removed, leaving it listed with an
  empty model list; (3) a provider with a public catalog never carries
  prior-bootstrap rows forward, so Moonshot now lists Kimi K2.6 / K2.7
  Code / K2.7 Code HighSpeed / K3 instead of the K2.x set; (4) the
  generator warns on every carry-forward and on every declared provider
  with no models, and applies the denylist *before* access-mode
  segmentation so an emptied provider is dropped. Bootstrap regenerated:
  1700 models; provider-api 12 → 20 providers (added cohere 14, google 31,
  groq 12, minimax 7, mistral 33, volcengine 16, xai 7, xiaomi 6;
  fireworks 2 → 33, nvidia 4 → 92, together 4 → 39). Still empty by
  design, excluded in the test with a reason: byteplus, byteplus-plan,
  volcengine-plan (no public catalog, probe needs a real key). Verified
  on the instance after run 9: GET `/api/models` `accessModes.provider-api`
  lists all 20 providers with those counts, xAI/Google Gemini/Groq/MiniMax
  carry the right env key and plugin (`groq` → `["groq"]`), Moonshot's
  first rows are the K2.6/K2.7 ones, zero GPT-5.5 aliases, service active
  and gateway up. **Open (product call for Bill):** the new providers have
  no `recommendedModelKeys`, so the first row is alphabetical (xAI → "Grok
  4.20 (Non-Reasoning)", Google → "Deep Research Max Preview", Groq →
  "ALLaM-2-7b"); a recommended model per provider (e.g. `xai/grok-4.3`,
  `google/gemini-3.1-pro-preview`, `groq/openai/gpt-oss-120b`,
  `minimax/MiniMax-M3`, `moonshot/kimi-k3`) is a one-line spec change each.
  **Reworked (Bill, 2026-09-19 05:0x UTC): no models.dev.** Bill objected
  to the external catalog dependency, rightly. Investigation: OpenClaw's
  own provider plugin manifests (`openclaw.plugin.json` →
  `modelCatalog.providers[*].models`, with a `modelsDev` id map) carry a
  per-release model list snapshotted at OpenClaw publication time, both in
  the core extensions (google 10, xai 6, openai 10, nvidia 12, together 4,
  ollama-cloud 24, anthropic 7) and in the pinned managed provider plugins
  (moonshot 3, deepseek 3, zai 6, groq 8, mistral 7, cohere 5, fireworks 3,
  volcengine 9+5, xiaomi 2, venice 19, byteplus 6+2, tencent 3, novita 8).
  The generator was hiding them by always probing with `--refresh`, which
  hits the provider API with the placeholder key and returns nothing. The
  flag that surfaces the bundled catalog differs per provider (moonshot
  and xai without `--refresh`, google and openai with it), and key-free
  enumerators (kilocode 368, novita 120, venice 115) only list with it, so
  `f7d3cc3` probes each provider both ways and merges by key. models.dev
  entries removed from the spec (only the OpenRouter and Vercel public
  endpoints remain); `openai/gpt-5.6` and one Cloudflare AI Gateway row
  (`cloudflare-ai-gateway/anthropic/claude-sonnet-4.6`, replacing the
  denied GPT-5.5 row; id format unverified against the plugin, which ships
  no catalog) pinned in `explicitModels`; MiniMax enumerates M2.7 /
  M2.7-highspeed / M3 key-free, M3 recommended. Bootstrap regenerated:
  1443 models, provider-api 24 providers, **zero** prior-bootstrap rows,
  and a test now fails on any such row. Verified on the instance after run
  10: `accessModes.provider-api` lists the 24 providers with those counts,
  first rows xAI → Grok 4.20 0309 (Non-Reasoning), Google → Gemini 2.5
  Flash, Groq → Compound, MiniMax → MiniMax M3, Moonshot → Kimi K2.7 Code;
  zero GPT-5.5 aliases; service active, gateway ready at 05:29:31 UTC.
  Recommended-model picks for xAI/Google/Groq/Moonshot still Bill's call.
- **G2 finding #8 (2026-09-19 16:1x UTC, found while preparing T10): the
  state-tier backup fails on 9.4.** Every `alphaclaw-backup@state` run
  after the upgrade (04:15, 10:20 UTC) died with `alphaclaw-backup-export`
  → "SQLite snapshot failed", node:sqlite `ERR_SQLITE_ERROR` errcode 0
  "not an error". Cause: OpenClaw 2026.9 keeps zero-byte advisory locks
  named `*.sqlite` inside the state dir
  (`tmp/openclaw-1000/gateway.state.lock.sqlite`,
  `agents/main/agent/openclaw-agent.sqlite.generation-lock.sqlite`), the
  export snapshots every `*.sqlite` except `*.reindex-lock.sqlite`, and
  the online backup API fails on the held tmp lock. Host and gateway tiers
  were unaffected. **Fixed:** clawctl `40696a4` (skip `*-lock.sqlite` /
  `*.lock.sqlite` and zero-byte files, prune the state `tmp/` from the
  snapshot list and the archive; export stream test fixtures fail on the
  old script), bundle `03fdefc3…` published and pinned on Preview beta
  (`ad1c8cd` manifest record; preview redeployed `65b63cd9`). The
  instance's `/usr/local/sbin/alphaclaw-backup-export` was patched by hand
  (`.orig-bundle-4c6e717d` kept); a manual state run then succeeded
  (snapshot `24c8bc5f`, 3 sqlite snapshots, 59 MB). **G3/G4 blocker
  until the stable pin carries it:** every upgraded instance loses state
  backups from the first post-upgrade run.
- **T10 preparation (16:2x UTC):** the admin panel restores `latest` per
  tier with no snapshot picker (the service accepts `stateSnapshot` /
  `hostSnapshot`, the action and form do not). To keep the crossing
  7.1-state → fresh 7.1 → 9.4, the source gateway's state and host timers
  were stopped and the two post-upgrade workload snapshots (`24c8bc5f`
  state, `c27b32e7` host) were forgotten (no prune), so latest = `82897d92`
  state / `8078a2d8` host (both 7.1, 21:36 UTC 9/18). Gateway tier latest
  `b314cf57` is version-agnostic (vault, grants). Form filled: owner
  `user_2upQQ…`, `test-g2-oc94-02`, label "G2 T10 restore crossing",
  restore from `inst_6d89…`, host tier included, tailnet identity **not**
  reused (source still alive), DigitalOcean, gateway topology, `latest`.
  Setup password and submit left to Bill (never typed by the agent).
- **T10 result (2026-09-19 16:26–16:52 UTC): PASS for the crossing, with
  three findings.** Run `wrun_01M2X7TFTNHYBHPF4RZWW53RPS`, instance
  `test-g2-oc94-02` / `inst_25b9d0f8a37b4e5d804e37b915c06af9`, DigitalOcean
  `sfo3`, bootstrap URL `https://2rxdk5dwhdrt.openclaw.teamyou.ai`, run
  `completed`/`active` at 16:39. Restore steps: gateway tier `b314cf57`
  (kek, oauth-grants:1, agent-vault, agent-vault-bootstrap, ssh-bridge,
  **tailscale**), workload state `82897d92` (28.7 s) + host `8078a2d8`
  (132 s), both the 7.1 snapshots as intended; TeamYou key re-seeded
  (`JkUo72OTdNzI`); own backups configured with a first state snapshot.
  The restored 7.1 workload (`0.9.18-starfoundry.22`) came up with 01's
  state: 17 session files, `channels.telegram` enabled, primary
  `vercel-ai-gateway/anthropic/claude-opus-4.8`, 37-line `.env`.
  **Crossing:** artifact 9 installed via the staged upgrade script at
  16:46:33–16:49:34 (3 min; SearXNG install, Doctor migrations, plugin
  reconcile to 2026.9.4, gateway ready 16:49:54, 7 plugins). Verified after:
  telegram still enabled, primary unchanged, no retired config keys,
  session transcripts migrated by OpenClaw's session-sqlite import
  (`session-sqlite-migration-runs/…854d5b6c.json`, 12 files archived as
  `.imported-*`, `transcript_events` 25 rows, `session_nodes` 2), state
  backup from the new gateway with the fixed export → snapshot `56038e31`
  (2 sqlite snapshots), Clawbridge login and `/api/models` (bootstrap,
  1443 models, zero GPT-5.5) OK.
- **G2 finding #9 (severity high, product): a restore reused the live
  source's tailnet identity.** `restore_gateway.restored` includes
  `tailscale`, so the new gateway joined the tailnet as `test-g2-oc94-01`;
  its SSH host key changed under that name, the source gateway lost its
  node (its public SSH is firewalled), and the source instance is now
  unreachable over the tailnet while its public bootstrap URL is closed
  post-setup. Two causes: (a) the agent set the "Reuse the source's tailnet
  identity" checkbox to unchecked with the pane's `form_input`, which
  flips the DOM but not React state, so the request carried
  `restore_tailscale: true` (agent tooling error, recorded in memory);
  (b) **the product has no guard**: the checkbox defaults to on, its label
  says "source gateway must be gone", and neither the action, the service
  (`restore_tailscale: restore.restoreTailscale !== false`) nor the
  workflow checks that the source instance is destroyed before
  `restore_network_prepare`. Fix for teamyou: refuse (or force off)
  tailnet reuse while the source instance row is active, and default the
  checkbox to off. **Fix opened (Bill's go, 2026-09-19 17:0x UTC):** teamyou
  PR #1038 `claude/restore-tailnet-reuse-guard` off `development`:
  `restore_tailscale` defaults to false, the panel checkbox defaults to
  off, and `validateRestoreRequest` refuses reuse unless the source row has
  `destroyedAt` (payment recovery destroys the source gateway first, so it
  still passes); pure check `tailnetReuseRefusal` with unit tests, tsc and
  lint clean. Consequence here: the source's state/host backup timers
  (stopped at 16:1x for the snapshot pin) cannot be restarted and its
  remaining checks cannot run; both instances are still to be destroyed.
- **G2 finding #10 (product, not 9.4-specific): startup plugin
  reconciliation races the egress proxy on a restored host.** The restored
  workload's AlphaClaw started 7 times between 16:34 and 16:37, each run's
  reconciliation failing with `npm error E407 Proxy Authentication
  Required` (then once `integrity unknown`) before the vault proxy tunnel
  was up; it then gave up ("continuing so the setup UI can surface
  recovery options") and the Gateway ran without the `vercel-ai-gateway`
  plugin, so cron turns failed with "Unknown model
  vercel-ai-gateway/anthropic/claude-opus-4.8". Once egress worked, `npm
  pack` succeeded with both the restored and a fresh cache, and one
  `systemctl restart alphaclaw` (16:45) reconciled everything. Fix
  direction for alphaclaw: retry reconciliation once the proxy shim is
  up, or re-run it on the first successful egress, instead of only at
  process start. **Why no drill saw it (checked 2026-09-19 against the
  backup plan §4 and the drill-day worklogs):** every drill source ran
  Claude through the brokered `claude-cli` grant with bundled
  Slack/Telegram/active-memory plugins, so reconciliation never had to
  download anything at first boot; the G2 source's Vercel AI Gateway
  route is an npm-installed provider plugin. **Fixed:** alphaclaw
  `2136ef9` (pushed): `bin/alphaclaw.js` flags a failed startup pass and
  `lib/server/startup-plugin-reconcile-retry.js` retries in-process on a
  30 s / 1 / 2 / 4 / 8 min backoff, reloading the Gateway when a retry
  installs or updates a plugin; unit-tested, full vitest 166 files / 1488
  tests. Not yet exercised on a live restore (both test instances are
  destroyed); the next restore drill covers it. Backup plan revised to
  3.28: the acceptance fixtures now require an npm-installed provider
  route and the after-check requires reconciliation to complete before
  first contact.
- Remaining on the instances: nothing required for G2. Both are to be
  destroyed from the preview admin panel (01 first, so 02 keeps the
  tailnet node it holds), then the preview branch deleted.

### 4.9 clawctl bundle with the gated fixes (23:2x UTC, Bill's go)

- clawctl branch pushed: `455ed6e` (gated host-script fixes) and
  `6c4e989` (manifest record).
- Bundle published, content-addressed and immutable: sha256
  `28d50d60b482455f2c34faf9e663391b96ca866f695b8f1a9c36709132a66644`
  (54,296 bytes, 16 files, download-verified, carries the gated
  `alphaclaw-teamyou-install.sh`). Provenance commit `455ed6e`; the publish
  script marks it stable-promotable because it descends from `11de923`, but
  **stable was not promoted**.
- Pinned on **TeamYou Preview beta only**
  (`OPENCLAW_HOST_ASSET_BUNDLE_URL_BETA` / `_SHA256_BETA`, sensitive);
  production and every `latest` provision stay on `4c6e717d`. The G2 preview
  was redeployed (`teamyou-6cnjht6wf…`) so the pin is live for admin
  provisions that pick channel `beta` there. Rollback = clear the two beta
  vars.

## 5. Sequence

1. Provision on the preview admin panel: gateway topology, provider chosen
   explicitly, channel `latest` (7.1), `test-` instance name prefix.
2. Complete onboarding on the 7.1 instance (vault, one channel, a model),
   generate a few sessions and a cron so T1 has a real state dir.
3. Pre-upgrade backup: provider snapshots of both VPSes + stopped-Gateway
   copies of `state/openclaw.sqlite`, agent DBs, `openclaw.json`,
   credentials, workspaces. Record ids.
4. Install the branch artifact (§4). Doctor. Start. Run T1–T11.
5. Capture results in the G2 closeout doc; destroy the instance; delete the
   branch. Checkpoint G2 with Bill.

## 6. Human gate

Per the 2026-08-26 directive, no provisioning and no install happens without
Bill's go.

- **2026-09-18, Bill:** provision on **DigitalOcean** with the **`latest`**
  channel (7.1). The 7.1→9.4 tarball install remains a separate go.
- Still open: whether the preview should also carry a beta host-bundle pin
  built from clawctl `codex/openclaw-2026.9.4-upgrade` (Node 26 for fresh
  provisions). Not needed for the 7.1→9.4 path; relevant later for G3
  fresh-provision coverage.
