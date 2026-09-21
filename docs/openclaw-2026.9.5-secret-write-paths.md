# OpenClaw 2026.9.5 secret write paths vs Agent Vault

Date: 2026-09-21. Project `TAoHXFTAly7M`. Asked by Bill before deciding
whether Clawbridge keeps `OPENCLAW_CONFIG_READONLY=1` on the Gateway.

## Question

Clawbridge's contract is that third-party credentials live only in Agent
Vault. The instance holds `__agent_vault_*__` placeholders and the vault
proxy substitutes the real value at egress. Read-only config was partly
adopted so users could not type channel or model tokens into the Control
UI, where they would bypass the vault. This inventory lists every way a
raw credential can land on a 2026.9.5 instance, and whether read-only
config stops it.

## Method

- Static: the Gateway method table in the pinned dist (465 methods; 226
  credential- or config-related), the handlers behind the likely secret
  writers, the agent `gateway` tool, and Clawbridge's own Env Vars route.
- Live on `test-g3-oc95-03` (2026.9.5, read-only on, Gateway running),
  calling Gateway methods with an admin connection, which is what a
  Control UI session holds. Dummy values only; every probe was removed
  afterwards and no live row retains them.

## Results

| Path | Who can reach it | Stored where | Read-only blocks it? | Evidence |
| --- | --- | --- | --- | --- |
| Config writes (`config.patch`/`apply`/`set`): channel tokens, provider settings, MCP env, skill keys, `env.vars` | Admin (Control UI) | `openclaw.json` | **Yes** | Live: dummy Telegram bot token refused with `ConfigReadOnlyError`; G2 T4 for the Control UI |
| Model API key (`models.authSetApiKey`) | Admin (Control UI model setup) | OpenClaw auth store, `state/openclaw.sqlite` | **No.** Key saved, only the config half refused ("API key saved, but provider settings could not be applied") | Live: dummy Groq key persisted; removing it through the Gateway was then refused, removal needed Clawbridge's maintenance path |
| Team secret store (`secrets.store.set`, kinds `secret` and `env`) | Admin | `state/openclaw.sqlite`, value readable in the database file | **No.** Returned `ok: true` | Live: dummy entry saved, listed, deleted |
| Model OAuth login (`models.authLogin`), setup wizard (`wizard.*`), setup helper (`openclaw.setup.*`, `/openclaw` owner DM) | Admin, or owner in chat | Auth store, likely the same as the API-key row | Not tested | Needs an interactive login; same store as the row above, so assume **No** until tested |
| Per-user model accounts (`users.authConnect.*`) | Ordinary **write** scope, not admin | Per-user auth profiles | Not tested | Needs a durable user profile; our instances have none, so not reachable today |
| GitHub tool identity (`tools.github.authorize.*`, `configure`) | Admin | OAuth token in a managed profile directory plus a config write | Config part yes; token part not tested | Static read of the handler |
| Plugin-owned credentials (`plugins.credentials.inspect` lists them) | Depends on each plugin | Plugin state | Unknown per plugin | Any third-party plugin can keep its own secrets |
| Agent shell (exec) | The agent, whenever the user asks | Anywhere the app user can write: `.env`, `openclaw.json`, the sqlite stores, files | **No** | Host 03: `tools.exec.security: "full"`, no sandbox, no exec approvals; `.env` (mode 600, app user) holds `OPENCLAW_GATEWAY_TOKEN`, so the shell can also make admin Gateway calls |
| Chat paste | Anyone chatting | Transcript, memory, workspace files | No | Always possible; not a store we control |
| Clawbridge Env Vars page | Clawbridge user | `.env` | n/a (Clawbridge) | Refuses credential-named keys and points to Agent Vault. It matches by name (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, …), so a key named e.g. `FOO_KEY` gets through |

Already closed:

- The agent's `gateway` tool only offers `config.get`, `config.schema.lookup`,
  and owner-only `update.run` in 2026.9.5. It cannot write config, secrets,
  or model keys.
- Clawbridge denies the agent `secrets` tool (`tools.deny: ["secrets"]`).
- Chat `/config`, `/plugins`, and `/mcp` are off (`commands.config`,
  `commands.plugins`, `commands.mcp` default to false).

## Conclusions

1. Read-only config blocks only the config-file half. The two stores where
   2026.9 keeps model keys and general secrets (auth store, team secret
   store) accept raw values from any admin connection with read-only on.
   Read-only is not the control that keeps credentials in Agent Vault.
2. The real boundary is **who holds an admin connection**. Today that is
   whoever passes Clawbridge's Control UI hand-off, which is the instance
   owner.
3. The agent shell bypasses every Gateway-level control, including
   read-only. It can read the Gateway token from `.env` and it owns the
   state files. Closing that needs exec policy or sandboxing, not config
   flags.
4. Lead worth evaluating: OpenClaw 2026.9 has its own sentinel-and-egress
   design (`secrets.egressProxy`, host-scoped `allowedHosts` on
   secret-store entries). It is off on our instances (`enabled: false`). It
   is conceptually what Agent Vault does, and may be how user-installed
   plugins get credentials without leaving raw values on disk.

## Not verified

- Behaviour of the untested rows above (OAuth login, wizard, setup helper,
  per-user accounts, GitHub token half).
- Whether a raw key stored on the instance actually works through the
  Agent Vault egress proxy, or is blocked there.
- Whether an admin Control UI session can be scoped down (for example,
  admin for plugins but not for auth or secrets).
