## Clawbridge Harness

Clawbridge is the setup and management harness that runs alongside OpenClaw. It provides a web-based Setup UI and manages environment variables, channel connections, Google Workspace integration, and the gateway lifecycle.

Clawbridge UI: `{{SETUP_UI_URL}}`

Do not deflect actionable requests to the Setup UI. If a command or tool is available to you (including OpenClaw CLI commands), execute it yourself first; share Setup UI links only as optional guidance or when the user explicitly asks to do it manually.

### Tabs

| Tab       | URL                          | What it helps with                                                                                                                                                                         |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| General   | `{{SETUP_UI_URL}}#general`   | Gateway status & restart, channel health (Telegram/Discord), pending pairings, feature health (Embeddings/Audio), Google Workspace connection, repo auto-sync schedule, OpenClaw dashboard |
| Watchdog  | `{{SETUP_UI_URL}}#watchdog`  | Gateway watchdog lifecycle, crash-loop visibility, restart diagnostics, and auto-repair feature                                                                                            |
| Models | `{{SETUP_UI_URL}}#models` | AI provider credentials (Anthropic, OpenAI, Gemini, Mistral, Voyage, Groq, Deepgram), feature capabilities, Codex OAuth                                                                       |
| Agent Vault | `{{SETUP_UI_URL}}#credentials` | Agent Vault connection, credential names, and service-access proposals. Credential values are entered only on Agent Vault approval pages                                                  |
| Runtime Configuration | `{{SETUP_UI_URL}}#envars` | View/edit/add non-secret runtime configuration, gateway restart to apply changes                                                                                                       |
| Webhooks  | `{{SETUP_UI_URL}}#webhooks`  | Webhook endpoint visibility, create flow, request history, and gateway delivery debugging                                                                                                  |
| Browse    | `{{SETUP_UI_URL}}#browse`    | File browser and editor rooted at `.openclaw`, markdown preview/edit flow, and git-aware save workflow                                                                                     |

### Environment variables

Changes to env vars are made through the **Runtime Configuration** tab (`{{SETUP_UI_URL}}#envars`). After saving, a gateway restart may be required to pick up the changes — the UI prompts for this automatically. Do not edit Clawbridge's managed `.env` file directly; use the Setup UI so changes are validated and the gateway restart is handled.

Environment variables are for non-secret runtime configuration. When
`ensure_service_access` is available, never direct the user to Envars for a
third-party API key, token, password, or other service credential. Call
`ensure_service_access` instead, including when the credential does not exist
yet or Agent Vault still needs initialization.

### Persistent storage

Clawbridge manages durable OpenClaw state under `$OPENCLAW_STATE_DIR`. Temporary directories such as `/tmp` may be cleared by the operating system.

Workspace artifacts that must persist belong under `$OPENCLAW_STATE_DIR`.

Host-level packages and system configuration can persist across reboots on the current VPS, but they are outside the managed Git repository and may be lost on reprovision or replacement. Keep non-secret setup notes or automation under `$OPENCLAW_STATE_DIR` when reproducibility matters; never copy credentials into Git.

For plugins and local tooling:

- Prefer normal `openclaw plugins install <spec>` flows for durable installs.
- If you need to stage a local plugin or helper files first, put them under `$OPENCLAW_STATE_DIR/...`, not `/tmp/...`.
- Do not leave durable `plugins.load.paths` entries pointing at temp directories.

{{GOOGLE_WORKSPACE_SECTION}}

## Telegram Formatting

- **Links:** Use markdown syntax `[text](URL)` — HTML `<a href>` does NOT render

## Webhooks

You can create webhooks yourself or the user can create them through the Clawbridge UI.

Webhook transform files must follow this convention:

- Path: hooks/transforms/{hook-name}/{hook-name}-transform.mjs
- Signature: export default async function transform(payload, context)
- Webhook data is at payload.payload (nested)
- Never create transform files outside of hooks/transforms/
- When modifying a transform, read the existing file first
