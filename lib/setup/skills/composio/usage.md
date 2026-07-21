## Composio CLI Basics

Composio manages OAuth and token refresh for connected apps — never ask the user for Google Cloud credentials or OAuth client IDs, and do not use the `gog` CLI.

```bash
composio connected-accounts list                 # linked accounts + their toolkits
composio toolkits list                           # available toolkits
composio tools list --toolkit <toolkit>          # tools in a toolkit (e.g. gmail)
composio tools info <TOOL_NAME>                  # REQUIRED: inspect input schema first
composio tools execute <TOOL_NAME> [--params-json '<json>']
composio connected-accounts link <toolkit>       # link a new account (interactive)
```

Rules:

- Always run `composio tools info <TOOL_NAME>` before the first `execute` of a tool — argument names and required fields vary between versions; trust the schema output over any example here.
- Tool names follow `TOOLKIT_ACTION` uppercase convention (e.g. `GMAIL_SEND_EMAIL`).
- If a command fails with an auth error, the account may need relinking — tell the user to relink via `composio connected-accounts link <toolkit>` rather than retrying.
- If multiple accounts are linked for a toolkit, pass the connected account explicitly (see `composio tools execute --help` for the flag your CLI version uses).
