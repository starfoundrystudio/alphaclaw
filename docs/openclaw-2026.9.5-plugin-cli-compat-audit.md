# Clawbridge ↔ OpenClaw 2026.9.5: plugin and CLI compatibility audit

Date: 2026-09-21. Project `TAoHXFTAly7M`. Asked for by Bill after a run of
one-at-a-time failures adding Slack on `test-g3-oc95-04` (findings #20, #21):
"figure out ahead of time what we need to change". This replaces fixing
symptoms as they appear.

## Method

1. Inventory every place Clawbridge runs the `openclaw` command line or
   writes `openclaw.json` (call-site table below).
2. Release notes for every OpenClaw release from 2026.7.1 to 2026.9.5
   (8.1, 8.2, 9.1–9.5), filtered for plugin, CLI, config and channel changes.
   They are high level and miss the behaviours that actually broke us, so:
3. Empirical checks: run each command Clawbridge uses, in the condition
   Clawbridge uses it (Gateway running or not), on a real 2026.9.5 host
   (`test-g3-oc95-04`, read-only commands) and in a local 2026.9.5 lab with
   host 04's config and Clawbridge's managed environment (write commands).
   Record exit code, stdout, stderr and duration.

## Behaviour changes that matter to Clawbridge (confirmed)

| # | 2026.9.5 behaviour | Evidence | Clawbridge impact |
| --- | --- | --- | --- |
| B1 | `openclaw plugins install/uninstall/enable/disable` hand the work to a running Gateway (`plugins.install` RPC, owner from the Gateway lock). No flag forces the local path. | dist `plugins-install-command`, `plugins-lifecycle-client`; live on 03/04 and lab | Any install Clawbridge runs after onboarding goes through the Gateway: slower (lab 37 s for Slack), subject to the Gateway's own 120 s npm timeout, and applied live with a hot reload. |
| B2 | Config validation warns once per `plugins.deny` id that is not a known plugin, on every config-writing command; no switch silences it. | dist `io.snapshot-preparation`; 26 warnings per call on 04 | Warning spam in the agent's tool output (#20); misclassification of errors (B5). |
| B3 | `agents.entries.*.default` is retired. OpenClaw converts it to per-surface roles and strips it on its next write ("Removed retired agents.entries.*.default markers"). | dist `legacy.roster` | Clawbridge's `withNormalizedAgentsConfig` re-adds `default: true` on every save it passes through, so each Clawbridge save causes a second config change and a second Gateway reload. |
| B4 | A config change applies by hot reload inside the running Gateway; on host 04 each reload took ~25 s and delayed Gateway liveness. | host 04 journal | Commands that need the Gateway during a reload (channels add, devices list) stall; several Clawbridge writes in one flow stack reloads. |
| B5 | CLI output on stderr now routinely carries warnings, even on success. | lab: install and `channels add` exit 0 with 2.8 KB / 5.9 KB stderr | Clawbridge surfaces raw stderr as the error text on any failure, and one classifier (`isOpenclawConfigReferenceError`) matches `not found … plugin` anywhere in the output, so any install failure is misread as a config-reference error. |
| B6 | Archive installs: `--pin` rejected for non-registry sources, `--force` required, capability consent mandatory. | live on 03 | Fixed in beta.5 (#17). |
| B7 | Plugin uninstall can leave `plugins.entries.<id> = {enabled: false}`. | host 04 after my test | Clawbridge treats any `plugins.entries.<id>` as a reason to install that plugin. |
| B8 | CLI cold start is 2–7 s per command on a 4 vCPU host (`agents list` 6.7 s, `channels list` 5.1 s, `models status` 4.0 s, `config validate` 3.3 s). | host 04 timings | Clawbridge's default 15 s command timeout and 30 s `channels add` timeout leave little margin; under a reload they are exceeded. |

## Findings so far (host 04)

- #20 deny-list warning noise (B2).
- #21 Slack add: first attempt, Gateway `npm view` timed out (transient) while
  Clawbridge's synchronous reconcile froze its own server, then rolled back and
  showed a misclassified error (B1, B5); second attempt tried to install a
  leftover disabled Groq entry (B7); third attempt, `channels add` hit the 30 s
  timeout during Gateway reloads (B4, B8) and showed the warning text as the
  error (B5).

## Call-site inventory (summary)

Full table: 60+ `openclaw` CLI call sites, 10 Gateway RPC methods over
`requestGateway`, ~30 `openclaw.json` writers (inventory pass, 2026-09-21).
What matters for 2026.9.5:

- **Every wrapper decides success by exit code**, not by stderr
  (`clawCmd`, `shellCmd`, `runOpenclawCommand`). Warnings alone do not fail
  a command. But ~15 routes return raw stderr (or the whole result object)
  to the browser on failure, so any failure shows the warning wall.
- **Plugin reconcile blocks the Clawbridge server while the Gateway runs**
  (`execSync`, 180 s per step, 3+ steps) from channel add
  (`agents/channels.js:428`), model save (`routes/models.js:697`) and
  watchdog repair (`watchdog.js:716`). Only the startup retry stops the
  Gateway first.
- **Short timeouts on write commands:** `channels add/remove`, `agents
  bind` 30 s; `models set` 30 s; `config set` 12–15 s; `pairing approve`,
  `devices reject`, `nodes approve` 15 s; `agent --message` 15 s;
  `channels login` 12 s (SIGKILL); `syncChannelConfig` runs `channels
  add/remove` with `execSync` at 15 s inside `PUT /api/env`.
- **Broad output matching:** `isOpenclawConfigReferenceError` routes to the
  config-suppression fallback on `not found … plugin` anywhere in the output
  (B5). Output parsers read JSON out of combined stdout+stderr (pairing
  list, approvals, channels status, skills, models).
- **Relevance:** any `plugins.entries.<id>` key, even `{enabled:false}`,
  makes a plugin "relevant" and triggers an install; a failure installing
  one plugin aborts the whole reconcile, and with it the channel add.
- **Retired marker writer:** `withNormalizedAgentsConfig`
  (`agents/shared.js:605`) re-adds `agents.entries.*.default` on every
  save through `saveConfig` (agents, bindings, channels).

## Lab timings with the Gateway running (2026.9.5, fast Mac; host is ~2× slower)

| Command | rc | Time | stderr |
| --- | --- | --- | --- |
| `plugins install npm:@openclaw/slack@2026.9.5 --pin --accept-capabilities` | 0 | 37 s | 26 deny warnings |
| `channels add --channel slack …` (idle / right after a Clawbridge write) | 0 | 17 s / 29 s | 52 |
| `agents bind` | 0 | 8.3 s | 26 |
| `models set` | 0 | 9.4 s | 52 |
| `config set` | 0 | 4.2 s | 26 |
| `pairing list --json`, `approvals get --json` | 0 | 7.9 s, 7.6 s | 26 each (read commands too) |
| `channels remove --delete` | 0 | 12.4 s | 52 |
| `plugins uninstall --force` | 0 | 39.7 s | 26 |
| `config get`, `channels status`, `plugins list`, `skills list`, `secrets reload` | 0 | 1.1–4.4 s | none or one line |

## Fix plan (one batch, beta.6)

Blocking user flows on 2026.9.5:

1. **Runtime plugin installs off the event loop.** Channel add, model save
   and watchdog run the reconcile as an async child process, publish
   progress, and keep the Gateway running (2026.9 applies installs live). A
   failed install is retried once; a Gateway `npm view` timeout is
   reported as "the plugin download timed out, try again".
2. **Install only what the flow needs.** Channel add and model save
   install the plugin(s) for that channel/provider, not every "relevant"
   plugin; a disabled `plugins.entries` key no longer makes a plugin
   relevant.
3. **Timeouts sized for 2026.9.5.** Write commands (`channels add/remove`,
   `agents bind`, `models set`, `config set`, `pairing approve`, `nodes
   approve`, `devices reject`) 120 s; `agent --message` 120 s; read
   commands 60 s; `channels login` keeps its short interactive limit.
   `syncChannelConfig` moves to async `clawCmd`.
4. **OpenClaw warnings stripped from anything classified or shown.** One
   helper removes `[config] warnings:` / `Config warnings:` blocks and
   `plugins.*: plugin not found … (stale config entry ignored …)` fragments
   before `isOpenclawConfigReferenceError` and before any stderr reaches the
   browser; full output still goes to the log. JSON parsers read stdout
   only.
5. **Deny list only for plugins OpenClaw knows** (#20): write
   `plugins.deny` for channel plugins that are installed or bundled, and
   re-apply it after any install Clawbridge performs. Trade-off for Bill: a
   channel plugin installed outside Clawbridge (Control UI) works until the
   next Agent Vault reconcile denies it; OpenClaw's own install already
   removes a denied id, so the gap exists either way.
6. **Stop writing the retired default marker.** `withNormalizedAgentsConfig`
   no longer adds `agents.entries.*.default`; Clawbridge resolves the
   default agent as OpenClaw 2026.9 does (sole agent, else `main`, else the
   first entry), and only reads the legacy marker.
7. **Fewer config writes per flow.** Channel add stops writing
   `plugins.allow`/`entries` itself before `channels add`/`plugins install`
   (OpenClaw does both), cutting one Gateway reload.

Lower priority, same batch if cheap:

8. Remaining routes that return raw stderr or whole result objects get the
   same cleaned message (models set, nodes, approvals, pairing, devices,
   gateway status, agent message).
9. `prepareOpenclawChannelPlugins` (`execSync plugins list`, 120 s) before
   runtime Gateway restarts moves off the event loop.

Not in this batch (noted): `models set "${key}"` and `channels add "${token}"`
build shell strings; `devices list/reject` put the Gateway token on the
command line; migrations write `openclaw.json` without the retired-key
strip; the Doctor lint's state-dir and config-file permission warnings.

Verification: unit tests per item; the lab (host 04's config, Gateway
running) for every flow; then beta.6 on a fresh host: Slack add, a model
provider needing a plugin, a Control UI plugin install, and no warning text
in the agent's first turns.
