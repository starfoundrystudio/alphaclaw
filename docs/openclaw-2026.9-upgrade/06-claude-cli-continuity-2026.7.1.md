# Claude CLI continuity on OpenClaw 2026.7.1

Date: 2026-09-16

## Conclusion

The reported loss of prior-turn context is not evidence that Claude Code
2.1.236 changed its stream schema incompatibly. Process-level evidence from the
affected instance identifies a concrete AlphaClaw integration trigger: the
OpenClaw Gateway runs with `HOME=/home/alphaclaw/.alphaclaw`, while AlphaClaw's
managed Claude launcher resets the child to `HOME=/home/alphaclaw`.

Claude therefore writes native transcripts under
`/home/alphaclaw/.claude/projects`, while OpenClaw 2026.7.1 probes
`/home/alphaclaw/.alphaclaw/.claude/projects`. The session id is parsed, but the
probe misses and the binding is discarded. This produces the same failing gate
as the upstream warm-stdio bug, but here the native transcript exists under a
different HOME.

OpenClaw 2026.7.1 contains two interacting continuity problems:

1. A missing Claude-native transcript causes OpenClaw to clear the stored CLI
   binding and then discard the transient binding candidate that would have
   activated bounded reseeding from OpenClaw's own transcript. The next turn
   therefore has neither a native resume nor a history prompt. This is the exact
   failure in [issue #96564](https://github.com/openclaw/openclaw/issues/96564),
   fixed by [PR #96841](https://github.com/openclaw/openclaw/pull/96841).
2. A turn using captured MCP delivery closes the warm Claude process after the
   response. That removes warm-process and prompt-cache continuity on the next
   turn. [PR #125528](https://github.com/openclaw/openclaw/pull/125528) changes
   capture-key admission so compatible turns can retain the process.

PR #96841 first appears in `v2026.7.2-beta.1`. There was no stable 2026.7.2;
both fixes are in stable `v2026.8.1`.

## AlphaClaw HOME mismatch

The mismatch is visible in the current managed paths:

- `bin/alphaclaw.js` globally assigns `process.env.HOME = rootDir`, which is
  `/home/alphaclaw/.alphaclaw` on the managed host.
- `lib/server/gateway.js` intends to preserve the service user's Unix HOME for
  external CLIs, but receives the already-mutated value. Its unit test asserts
  that Gateway `HOME=/home/alphaclaw` and `OPENCLAW_HOME` are distinct, so the
  CLI entrypoint defeats the stated and tested contract.
- The clawctl-managed Claude launcher explicitly exports
  `HOME=/home/alphaclaw` before executing the pinned Claude binary.
- OpenClaw 2026.7.1 resolves the transcript directory from
  `process.env.HOME/.claude/projects` in the Gateway process.

The pure backend override suggested by the user agent is not effective on a
managed AlphaClaw host: `agents.defaults.cliBackends.claude-cli.env.HOME` is
overwritten by the managed launcher before the real Claude binary executes.

## Why the original diagnosis is partly wrong

The 2026.7.1 Anthropic backend already declares all of the intended continuity
mechanisms:

- `resumeArgs` includes `--resume {sessionId}`;
- `sessionArg` is `--session-id` and `sessionMode` is `always`;
- `reseedFromRawTranscriptWhenUncompacted` is `true`;
- session-id parsing accepts `session_id`, `sessionId`, `conversation_id`, and
  `conversationId`.

The warm-stdio launcher deliberately removes `--session-id` and other one-shot
session flags from the long-lived process. Its normal continuity mechanism is
the live process itself, followed by native resume or OpenClaw transcript reseed
when that process is gone. Consequently, observing a fresh process without
`--resume` is a symptom worth investigating, but the absence of that flag is not
itself the defect.

Unknown Claude-native transcript record types such as `queue-operation`,
`attachment`, `ai-title`, `atis-latch`, or `last-prompt` also do not establish a
stream parser mismatch. The upstream bug report reproduces this loss on Claude
CLI 2.1.x and traces it to binding invalidation plus a starved reseed path. The
managed AlphaClaw launcher intentionally pins Claude Code 2.1.236 and previously
passed real request and restart acceptance on that version.

## Active-memory interaction

Active-memory is not the transport for the main conversation history. It is a
`before_prompt_build` hook that:

1. reads recent turns to form a memory-search query;
2. runs a separate bounded recall;
3. prepends one compact memory note when relevant; and
4. returns no added context when recall fails.

Therefore the 2026.7.1 active-memory failure does not cause the CLI binding loss
and cannot explain why the actual previous user and assistant turns are absent.
It can make the experience look worse because its supplemental memory note is
also missing, but even a successful recall is not a replacement for the raw
thread history.

[PR #106840](https://github.com/openclaw/openclaw/pull/106840) fixes a separate
subscription-routing bug: active-memory's embedded recall fell through to the
direct Anthropic API instead of the Claude CLI runtime, causing a billing
rejection or consuming metered extra usage. That fix first appears in
`v2026.7.2-beta.2` and is in stable `v2026.8.1`.

## Release-note and upstream issue mapping

| Fix | Effect | First tagged build | Stable build |
| --- | --- | --- | --- |
| [#96841](https://github.com/openclaw/openclaw/pull/96841), fixes [#96564](https://github.com/openclaw/openclaw/issues/96564) | Preserves a warm binding after the post-turn probe and passes a missing-transcript candidate into raw-history reseed | `v2026.7.2-beta.1` | `v2026.8.1` |
| [#106840](https://github.com/openclaw/openclaw/pull/106840), fixes #106839 | Routes eligible active-memory recalls through subscription-backed CLI execution and increases the CLI recall budget | `v2026.7.2-beta.2` | `v2026.8.1` |
| [#125528](https://github.com/openclaw/openclaw/pull/125528) | Stops captured MCP-delivery turns from killing an otherwise compatible warm Claude child | `v2026.8.1` | `v2026.8.1` |
| [#128732](https://github.com/openclaw/openclaw/pull/128732), fixes #128698 | Preserves valid CLI bindings across format-class failover | `v2026.8.1` | `v2026.8.1` |
| [#132185](https://github.com/openclaw/openclaw/pull/132185) | Reads CLI history from the canonical store so SQLite-only sessions do not project as empty | `v2026.8.1` | `v2026.8.1` |

The curated 2026.8.1 changelog explicitly includes “Claude CLI warm sessions”
for #96841. It also lists the other PRs in the full change inventory even when
they are not separately promoted in the curated summary.

## What can be configured on 2026.7.1

There is no missing switch that repairs this bug. The bundled backend already
sets the correct `sessionMode`, session flags, and reseed option. Repeating those
values in `agents.defaults.cliBackends.claude-cli` does not change the failing
control flow.

Useful settings and mitigations are limited:

- Avoid explicit `/reset` and short `session.reset` policies. AlphaClaw's only
  managed reset override is the Telegram thread idle policy at 525,600 minutes,
  so it is not a credible cause for ordinary managed sessions.
- If an API-backed model is available for auxiliary recalls, set
  `plugins.entries.active-memory.config.model` to that route. This restores only
  supplemental recall, not conversation continuity.
- Otherwise disable active-memory temporarily (`/active-memory off` for the
  session, or disable the plugin globally) to avoid a failing sub-run on every
  turn. This reduces latency and noise but does not restore history.
- Do not build a replacement custom CLI backend merely to disable warm stdio.
  It would bypass the bundled plugin's authentication, environment scrubbing,
  launcher, MCP, and session safety contracts.
- Keeping the Gateway alive is not sufficient in a tool-enabled managed setup,
  because 2026.7.1 itself closes capture-enabled Claude children after a turn.

## Recommended 2026.7.1 response

1. Treat the supplied process and filesystem evidence as confirmation of the
   primary trigger. The expected log signature remains repeated
   `reason=transcript-missing`, `historyPrompt=none`, and absent
   `cliSessionBindings["claude-cli"]` despite native transcripts existing under
   `/home/alphaclaw/.claude/projects`.
2. For an emergency host workaround, expose only the Claude `projects`
   directory at the Gateway's expected path. Prefer a
   `/home/alphaclaw/.alphaclaw/.claude/projects` symlink to
   `/home/alphaclaw/.claude/projects` over symlinking the entire `.claude`
   directory. The narrower link fixes transcript probing without merging Claude
   credentials, settings, plugins, and other home-scoped state. Validate that
   neither destination path already contains state before creating it.
3. The product fix should preserve the service user's original HOME for the
   OpenClaw Gateway while continuing to route OpenClaw state explicitly through
   `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_CONFIG_PATH`. Do not
   broadly change the whole AlphaClaw process HOME without auditing gog,
   Composio, Claude login/adoption, backup, and restore behavior.
4. Backport #96841 as defense in depth. The HOME alignment lets 2026.7.1 find
   the real transcript; #96841 additionally restores bounded OpenClaw-history
   reseed whenever a native transcript genuinely is absent.
5. Treat #125528 as the companion warm-process/cache fix. Backport its capture
   grant lifecycle as a unit; deleting only the process-close call would weaken
   the capture-key isolation invariant.
6. Keep #106840's active-memory fix separate. Until the full 2026.8.1 upgrade,
   use an API-backed recall route or turn active-memory off rather than treating
   it as a conversation-history workaround.
7. Prefer the planned upgrade to 2026.8.1 or later after the migration and
   persistence checks are complete. Stable 2026.8.1 is the first stable release
   containing all three relevant upstream fixes.

## Validation after a patch or upgrade

Use a new disposable session and a random fact that cannot come from memory.
After the first turn, ask for the fact on turns two and three while using a tool
on at least one turn. Verify:

- recall succeeds without writing the fact to memory;
- the warm child generation remains stable for compatible capture-enabled
  turns after #125528;
- if the native Claude transcript is absent, the log shows
  `useResume=false`, `reuse=invalidated:missing-transcript`, and
  `historyPrompt=present` rather than `historyPrompt=none`;
- if the native transcript exists, the resumed path is used;
- Gateway restart followed by another turn preserves continuity; and
- active-memory succeeds independently, or is explicitly disabled.

## AlphaClaw product-fix design

AlphaClaw currently overloads one environment variable for three different
storage domains. The fix should make them explicit:

| Domain | Managed path | Owner |
| --- | --- | --- |
| Service-user HOME | `/home/alphaclaw` | External CLIs and ordinary Unix user state |
| AlphaClaw root | `/home/alphaclaw/.alphaclaw` | AlphaClaw application state |
| OpenClaw state | `/home/alphaclaw/.alphaclaw/.openclaw` | OpenClaw config, agents, sessions, and databases |

Recommended implementation:

1. Capture the original service-user HOME before `bin/alphaclaw.js` mutates
   process environment or loads local modules. Give it an explicit name such as
   `ALPHACLAW_SERVICE_HOME`; clawctl should also set that value directly in both
   systemd units.
2. Centralize the environment used for every OpenClaw-owned process. Gateway,
   Doctor/watchdog repair, plugin reconciliation, effective-config reads, CLI
   passthrough, and other OpenClaw subprocesses should receive:
   `HOME=ALPHACLAW_SERVICE_HOME`, plus the existing explicit
   `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and
   `XDG_CONFIG_HOME` values.
3. Keep the AlphaClaw server process's legacy HOME override temporarily. That
   avoids silently relocating AlphaClaw-side gog and Composio state while the
   fix is being shipped. Removing the override globally can be a later migration
   after those consumers are audited.
4. Point Claude broker credential staging at
   `$ALPHACLAW_SERVICE_HOME/.claude/.credentials.json` explicitly. The dashboard
   login subprocess already uses `gatewayEnv`; without this matching broker
   change, fixing only the Gateway would make login write under the service HOME
   while adoption still looked under the AlphaClaw root.
5. Add an entrypoint-level regression test. The existing `gatewayEnv` unit test
   already asserts that HOME and `OPENCLAW_HOME` differ, but it does not execute
   through `bin/alphaclaw.js`, where the contract is currently broken.
6. Acceptance-test Claude login, adoption, broker sanitation, disconnect,
   reconnect, a three-turn conversation, an MCP-using turn, and a Gateway
   restart. Also verify Doctor and plugin reconciliation see the same native
   Claude transcript tree.

The temporary projects-only symlink is unnecessary after a corrected Gateway
restart and can be removed after the first successful persisted binding and
restart-resume test.

## Sequencing recommendation

Do not ship the broad HOME-domain change independently immediately before the
planned OpenClaw upgrade. Keep its design in the upgrade workstream and
implement it against the target OpenClaw tree after re-validating that
release's state-path, CLI-runtime, auth-bridge, and subprocess contracts. This
avoids testing two successive process-environment changes and lets the mandatory
disposable-host migration exercise validate the combined result.

This does not mean waiting without mitigation on an affected 2026.7.1 host. Use
the narrow Claude `projects` symlink described above as the short-lived,
reversible production unblock after verifying both paths. Avoid changing the
Gateway or whole service HOME in place before the combined upgrade test.

The upgrade itself must not be treated as the AlphaClaw fix. Later OpenClaw
releases make a missing native transcript survivable by restoring raw-history
reseed, but AlphaClaw would still be presenting different HOME domains to the
Gateway and Claude CLI. Native resume, transcript discovery, and credential
handling therefore remain explicit upgrade acceptance criteria. Remove the
temporary symlink only after the upgraded Gateway persists a Claude binding and
continues the same session across a Gateway restart without relying on it.

## Codex runtime impact

The same generic HOME value reaches the Codex app-server process, but Codex's
managed continuity is not coupled to `$HOME/.codex` in the same way:

- OpenClaw 2026.7.1 defaults Codex `appServer.homeScope` to `agent`.
- Its auth bridge explicitly sets `CODEX_HOME` to the agent-owned
  `<agentDir>/codex-home` directory.
- Native session/rollout files are read from that explicit `CODEX_HOME`, and
  subscription credentials come from OpenClaw's auth-profile store before being
  bridged into the app-server.

Consequently, the AlphaClaw HOME mismatch should not cause the same Codex
cross-turn amnesia. Changing Gateway HOME back to `/home/alphaclaw` will still
change Codex's inherited generic HOME, which can affect shell `~` expansion,
user dotfiles, Git/SSH/npm config, personal skills, or an explicitly configured
`appServer.homeScope=user`. The managed default `homeScope=agent`, explicit
`CODEX_HOME`, and brokered auth path should remain stable. Run a Codex
multi-turn/restart acceptance test because this is an environment change, but
do not migrate the agent-owned Codex home.
