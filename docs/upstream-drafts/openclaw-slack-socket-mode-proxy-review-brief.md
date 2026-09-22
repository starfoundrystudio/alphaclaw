# Adversarial review brief: OpenClaw Slack Socket Mode proxy issue + PR

You are reviewing an upstream bug report and a proposed fix before they are filed
on `openclaw/openclaw`. Your job is to break them. Assume the author is wrong
until the evidence says otherwise. A confirmed "this holds" is only worth
something if you tried to disprove it.

## Hard rules

- Read-only on anything public. Do NOT push any branch, open or comment on any
  issue or PR, or post anywhere on GitHub. `gh` is fine for reading PRs, issues,
  and commits.
- Do not commit to the review worktree. Scratch work goes in a new directory
  under `/private/tmp/` or in the gitignored-by-convention `.tmp-bun-check/`.
- Do not touch any live host. Everything here is reproducible locally.
- macOS host: there is no `timeout` command. Kill hung processes yourself.

## What you are reviewing

| Item | Location |
| --- | --- |
| Issue draft | `/Users/billk/Development/starfoundrystudio/alphaclaw/docs/upstream-drafts/openclaw-slack-socket-mode-proxy-dispatcher.md` |
| PR description draft | `/Users/billk/Development/starfoundrystudio/alphaclaw/docs/upstream-drafts/openclaw-slack-socket-mode-proxy-dispatcher-pr.md` |
| Fix (local commit, not pushed) | worktree `/Users/billk/Development/openclaw-slack-socket-proxy`, branch `fix/slack-socket-mode-proxy-dispatcher`, commit `88758c90b1e`, base `upstream/main` `21cbb3cd724` |
| Changed files | `extensions/slack/src/client-options.ts`, `extensions/slack/src/monitor/provider.ts`, new `extensions/slack/src/socket-mode-dispatcher.test.ts` |
| Author's scratch checks (uncommitted) | `.tmp-bun-check/check.mts` (real module, Node), `.tmp-bun-check/loader.mts` (loader chain, Node and Bun) |
| Related downstream hotfix (optional scope) | `/Users/billk/Development/starfoundrystudio/alphaclaw/lib/cli/openclaw-plugin-hotfixes.js` |

Start with `git -C /Users/billk/Development/openclaw-slack-socket-proxy show 88758c90b1e`.

## Tooling

- Dependencies are installed. If needed: `npx -y pnpm@12.4.0 install --frozen-lockfile`.
- Slack extension tests: `node --import ./scripts/tsx.mjs scripts/test-extension.mts slack`
- Focused tests: `node scripts/run-vitest.mjs run extensions/slack/src/socket-mode-dispatcher.test.ts`
- Typecheck: `npm run -s tsgo:extensions` and `npm run -s tsgo:extensions:test`
- Lint and format: `./node_modules/.bin/oxlint -c .oxlintrc.json <files>` and `./node_modules/.bin/oxfmt --check extensions/slack/src`
- Bun: `/Users/billk/.bun/bin/bun` (1.3.12, public build).

## Claims to attack

For each claim, give a verdict of HOLDS, WRONG, or UNPROVEN, with the command and
output or file and line that decides it.

### Root cause and history (issue draft)

1. Passing the dispatcher from `createHttp1EnvHttpProxyAgent` (OpenClaw's undici
   8.10.x) to `@slack/socket-mode` 3.0.1, which calls
   `new undici.WebSocket(url, { dispatcher })` with its own undici 7.29.1, makes
   the handshake fail at once with close 1006 and an empty error. Find the
   actual internal reason for the failure. The author showed that it fails, not
   why. If the real reason is something other than a cross-version mismatch,
   the issue's explanation is wrong.
2. The regression came from #147421, merged 2026-09-14, and first shipped in
   2026.9.5. 2026.9.4 is not affected. #112963 previously built the Socket Mode
   dispatcher from Slack's own undici. Check the actual diffs and release tags.
3. With no `dispatcher`, Socket Mode connects directly and ignores
   `HTTPS_PROXY`, because its default is a plain `undici.Agent` from
   `buildDefaultDispatcher`. So "just drop the dispatcher" is not a fix.
4. Only Slack is affected among channels in 2026.9.5. The draft says Discord,
   Telegram, Mattermost, Nextcloud Talk, and Microsoft Teams are not. Look for
   any other plugin that hands a runtime dispatcher to a library with its own
   undici or WebSocket.
5. The reproduction script in the issue actually reproduces the bug as written.

### Bun (the reason this PR exists in its current form)

6. Under Bun, socket-mode's bare `require("undici")` returns Bun's shim, and
   that shim's `WebSocket` is Bun's native one, which ignores `dispatcher`.
   Therefore Bun behavior is identical before and after the fix. Try to find a
   Bun version, a code path, or a bundling mode where this is false. Check what
   the "custom Bun" CI lane from #147421 actually runs, and whether the fix
   could behave differently there.
7. Loading `undici/index.js` by explicit subpath works under Bun and avoids the
   shim. Confirm this is the same technique the runtime uses, and find where.
8. Public Bun 1.3.12 cannot load OpenClaw's undici 8 at all, so the full
   provider can't run on it. Confirm, and say whether that makes the Bun
   evidence meaningless for the real deployment.

### The fix itself

9. **Resolution chain.** The fix resolves plugin, then `@slack/bolt`, then
   `@slack/socket-mode`, then `undici/index.js`. Attack this in every layout the
   plugin actually ships in: the pnpm workspace, the built `dist/.setup/*.mjs`
   chunk inside an installed `@openclaw/slack` npm package with hoisted or
   nested `node_modules`, and any mode where Slack is bundled into core. Does
   `import.meta.url` in the built chunk resolve correctly? Could it pick a
   different undici copy than the one socket-mode really loads?
10. **Same module instance.** Under Node, is the subpath-loaded
    `EnvHttpProxyAgent` the same class socket-mode's bare `require("undici")`
    uses? Check undici 7's `package.json` `exports` across the whole version
    range socket-mode 3 accepts. If some version does not export `./index.js`,
    the require throws.
11. **Silent proxy bypass.** Any error, including a failed undici load, is
    caught and returns `undefined`, which makes Socket Mode connect directly
    even though a proxy is configured. For a proxy-only deployment that is a
    security-relevant bypass. The author argues it matches the Web API
    dispatcher's existing fallback. Decide whether that is acceptable, whether
    it should fail closed or at least log, and whether the old code really had
    the same fallback for Socket Mode.
12. **Managed proxy CA.** `addActiveManagedProxyTlsOptions` builds options
    meant for undici 8 and they are passed to an undici 7 `EnvHttpProxyAgent`.
    The test only checks the object's class. Prove the CA is actually applied,
    for example with a TLS proxy using a private CA. If the option names differ
    between undici 7 and 8, managed-proxy deployments break silently.
13. **Real traffic shape.** The end-to-end test uses `ws://` through
    `HTTP_PROXY`. Slack uses `wss://` through `HTTPS_PROXY`. Test a `wss://`
    echo server with a self-signed cert through a CONNECT proxy. Also test
    `NO_PROXY` and lowercase env variants.
14. **Lifecycle.** Check that the dispatcher is created once per monitor run,
    reused across Socket Mode's own reconnects, closed on shutdown, and not
    closed while a reconnect still uses it. Check HTTP (webhook) mode: confirm
    `createSlackBoltApp` only uses `dispatcher` for the Socket Mode receiver, so
    passing `undefined` there changes nothing.
15. **Interactions.** Look at the debug-proxy global fetch patch, the
    read-authority and direct-adapter code in `client-options.ts`, and anything
    else that assumes one shared Slack dispatcher.
16. **Tests.** Would the new tests have caught the original regression? Revert
    the `provider.ts` change and confirm which test fails. If none fails, the
    wiring is untested; say so. The author removed a control test that showed
    the old dispatcher failing, because it would break if Slack moved to undici
    8. Judge that choice.
17. **Types.** `import type { EnvHttpProxyAgent } from "undici"` in the
    extension. Confirm it resolves to the extension's undici 7 types, not the
    root's undici 8.

### PR description

18. Every factual statement in the PR draft's Evidence section matches what you
    reproduce. Flag overclaims, especially anything that implies Bun on the
    proxy path was tested end to end.
19. The PR follows `CONTRIBUTING.md`, `AGENTS.md`, and
    `.github/pull_request_template.md` in the OpenClaw repo, including the
    title format and not editing `CHANGELOG.md`.

### Optional: downstream hotfix

20. The alphaclaw hotfix uses bare `require("undici")` from the provider file
    and no managed-CA TLS options. Say whether it can resolve a different
    undici than socket-mode uses on a real install, and whether it diverges
    from the upstream fix in a way that matters.

## What to return

1. A one-paragraph verdict: file as is, file after changes, or do not file.
2. A findings table, most severe first, with columns: severity (blocker, major,
   minor, nit), claim number, what is wrong, evidence, suggested change.
3. The verdict for every claim above.
4. Any exact code changes you recommend, as a diff. Do not apply them.
5. Anything you could not verify, and why.
