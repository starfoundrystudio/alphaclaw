## Composio CLI Basics

Composio manages OAuth and token refresh for connected apps — never ask the user for Google Cloud credentials or OAuth client IDs, and do not use the `gog` CLI.

```bash
composio execute <SLUG> -d '{ ... }'   # run a tool (validates inputs + connection)
composio execute <SLUG> --get-schema   # inspect a tool's input schema
composio execute <SLUG> --dry-run -d '{ ... }'  # preview without executing
composio search "<what you want to do>"         # find a tool slug
composio link <toolkit>                # connect an account (interactive)
composio connections list              # toolkit connection statuses (JSON)
composio whoami                        # current Composio session
```

Rules:

- Lead with `execute` when you know the slug — it validates inputs and connections and tells you what to fix. Use `search` only when the slug is unknown.
- Run `composio execute <SLUG> --get-schema` before the first execution of an unfamiliar tool — argument names vary between versions; trust the schema over any example here.
- Tool slugs follow `TOOLKIT_ACTION` uppercase convention (e.g. `GMAIL_SEND_EMAIL`).
- `-d` accepts JSON or JS-style object literals, `@file`, or `-` for stdin.
- If `execute` reports the toolkit is not connected, the user can link it from the AlphaClaw dashboard (General tab) or you can run `composio link <toolkit>` and give them the printed URL.
- Multiple accounts on one toolkit: select with `--account <alias-or-id>`.
- For multi-step logic, loops, or chaining, use `composio run '<inline JS with execute()/search()>'`.
