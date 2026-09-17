# OpenClaw To AlphaClaw Migration

This guide walks an operator through preparing an existing OpenClaw setup for
an assisted import into a fresh AlphaClaw installation.

AlphaClaw no longer exposes GitHub import or workspace-sync controls to users.
The migration snapshot must be transferred to the destination host by an
operator and applied through the internal import workflow. Publishing the
snapshot to GitHub remains available as an optional operator transport, not as
an AlphaClaw runtime dependency or ongoing backup.

It is aimed at older standalone OpenClaw layouts where the real state lives in
something like `~/.openclaw/`, and the main workspace may live somewhere else
such as `~/clawd/`.

## What AlphaClaw Expects

For a full import, AlphaClaw expects the source snapshot root to look like an
OpenClaw root:

- `openclaw.json` at the repository root
- optional `.env`
- optional portable `cron/jobs.json` export (generated from SQLite by the helper)
- optional `memory/`
- optional workspaces such as `workspace/` and `workspace-personal/`
- optional custom `skills/`, `hooks/`, and related workspace assets

AlphaClaw does not accept a source where the config is still nested under
`.openclaw/openclaw.json`. If your old machine looks like this:

```text
/home/you
  .openclaw/
    openclaw.json
```

do not point AlphaClaw at `/home/you`. Build a migration snapshot whose root is
the contents of `~/.openclaw` instead.

## What Carries Over Well

- `openclaw.json`
- `.env`
- portable `agents/<id>/agent/auth-profiles.json` exports
- portable cron definitions in `cron/jobs.json`
- custom workspaces
- custom skills and repo-backed helper scripts
- hook transform files and other code kept in the repo

## What Does Not Carry Over Cleanly

AlphaClaw intentionally normalizes some imported state for safety:

- imported `allowFrom` and `groupAllowFrom` trust lists are cleared
- imported `credentials/*-allowFrom.json` files are reset
- imported Telegram account pairing state is cleared
- imported gateway and webhook tokens are rewritten to AlphaClaw-managed env
  refs; import always generates a fresh `OPENCLAW_GATEWAY_TOKEN`, while
  `WEBHOOK_TOKEN` is preserved if the source already had one and otherwise
  generated fresh
- managed bootstrap files are regenerated
- imported git history is not preserved
- live OpenClaw SQLite, WAL, and SHM files are rejected rather than copied;
  SQLite memory indexes and run history are not migrated

Because of that, expect to re-pair users, channels, and devices after import.
Keep the old `credentials/` files in a separate backup if you may want to
inspect or manually re-apply trusted IDs later, but do not rely on them to
survive the standard import flow.

## Recommended Workflow

1. Prepare a clean migration snapshot from the old OpenClaw machine.
2. Transfer the snapshot to a temporary directory on the destination host using
   an operator-controlled secure channel.
3. Start a new AlphaClaw installation.
4. Have an operator scan, review, and apply that local snapshot through the
   internal import workflow.
5. Finish onboarding and re-establish pairings and machine-specific services.

Do not leave the migration snapshot on the destination after import. AlphaClaw
does not create or maintain a live workspace repository.

## Helper Scripts

This repo includes two scripts for the workflow:

- [scripts/prepare-openclaw-migration.sh](../scripts/prepare-openclaw-migration.sh)
  builds a curated import snapshot
- [scripts/publish-openclaw-migration.sh](../scripts/publish-openclaw-migration.sh)
  optionally initializes Git and pushes the snapshot to a private GitHub repo
  for operator-controlled transport

### Prepare The Snapshot

Basic usage:

```bash
./scripts/prepare-openclaw-migration.sh \
  --source-openclaw-dir ~/.openclaw \
  --target-home /home/alphaclaw \
  --output-dir ~/alphaclaw-migration \
  --force
```

If the main workspace lives outside `~/.openclaw`, include it explicitly:

```bash
./scripts/prepare-openclaw-migration.sh \
  --source-openclaw-dir ~/.openclaw \
  --main-workspace ~/clawd \
  --output-dir ~/alphaclaw-migration \
  --target-home /home/alphaclaw \
  --force
```

`--target-home` should be the home directory of the destination AlphaClaw
service user on the new host, not the home directory of the old OpenClaw
machine. In most deployments that will be `/home/alphaclaw`.

What the preparation script does:

- copies `~/.openclaw` into a clean output directory
- reads the source databases in a consistent read-only transaction and exports
  cron definitions and agent auth profiles to OpenClaw's legacy portable JSON
  formats
- excludes the shared state database, agent databases, and their WAL/SHM files
- removes common runtime-only folders like logs, media, delivery queue, device
  identity, plugin skill symlinks, Codex temp/auth artifacts, and cron run
  history
- removes nested `.git` and `.openclaw` state from copied workspaces
- optionally replaces the imported `workspace/` with an external main workspace
- rewrites migrated JSON path references such as agent workspaces, agent dirs,
  and cron/job working directories to AlphaClaw conventions
- removes legacy `agents.defaults.workspace`
- fails if source-machine path references still remain after rewrite

Important defaults:

- `credentials/` is excluded by default because standard AlphaClaw import does
  not preserve trusted pairings anyway
- raw SQLite files are always excluded; do not add them back to the snapshot
- `--target-home` is required so the snapshot is always prepared for the
  destination machine explicitly
- pass `--keep-credentials` only if you intentionally want those files in the
  snapshot for archival reasons

### Review The Snapshot

Before transferring the snapshot, inspect the prepared tree:

```bash
cd ~/alphaclaw-migration
find . -maxdepth 2 | sort
```

Also do one path sanity check:

```bash
cd ~/alphaclaw-migration
rg -n '/home/exedev|/home/.+/.openclaw|/home/.+/.alphaclaw/.openclaw' . || true
```

If the snapshot was prepared correctly, you should not see lingering references
to the old machine's home directory or old OpenClaw root.

The root should usually include things like:

```text
./openclaw.json
./.env
./agents/main/agent/auth-profiles.json
./cron/jobs.json
./workspace/
./workspace-personal/
```

### Optional: Publish To GitHub For Operator Transport

Skip this section when transferring the snapshot directly with another secure
channel. AlphaClaw does not read this repository itself and will not sync the
imported workspace back to it.

If the GitHub repo already exists:

```bash
./scripts/publish-openclaw-migration.sh \
  --source-dir ~/alphaclaw-migration \
  --repo YOUR_USER/openclaw-migration
```

If you want the helper to create a new private repo through GitHub CLI:

```bash
./scripts/publish-openclaw-migration.sh \
  --source-dir ~/alphaclaw-migration \
  --repo YOUR_USER/openclaw-migration \
  --create \
  --private
```

The publishing helper expects:

- `git` installed
- `gh` installed and logged in only when using `--create`
- a configured git commit identity via `git config user.name` and
  `git config user.email`

## Import On The New AlphaClaw Instance

The current flow is operator-assisted:

1. Transfer or clone the prepared snapshot into a temporary directory on the
   destination host.
2. Start the new AlphaClaw instance and keep it in onboarding mode.
3. Use the authenticated internal import scan endpoint with that temporary
   directory and review the detected secrets and environment values.
4. Apply the approved snapshot through the authenticated internal import apply
   endpoint.
5. Finish onboarding in the setup UI.
6. Re-establish pairings and any machine-specific host integrations after the
   new instance is live.
7. Remove the temporary snapshot from the destination host.

This workflow is intentionally not presented as a customer-facing GitHub form.
Coordinate the transfer and review with the TeamYou operator responsible for
the managed installation.

## Manual Equivalent

If you prefer not to use the helper script, the manual version is:

1. Copy the old `~/.openclaw` tree to a new directory while excluding all
   SQLite, WAL, and SHM files.
2. Export `cron_jobs` and agent auth profile stores to portable JSON, or use the
   preparation helper to do this safely.
3. Remove runtime-only folders and nested workspace git metadata.
4. If the main workspace lives elsewhere, copy it into `workspace/` in the
   snapshot.
5. Rewrite migrated JSON path references so agent workspaces, agent dirs, and
   job working directories point to AlphaClaw defaults under
   `~/.alphaclaw/.openclaw/`.
6. Fail the prep step if stale source-machine path references remain.
7. Transfer the snapshot to the destination host through a secure operator
   channel.
8. Scan and apply it through AlphaClaw's internal import workflow.

## Security Notes

- If GitHub is used for transport, use a private repo and delete it when its
  retention is no longer required.
- If `.env` is included in a GitHub transport, secrets will be committed into
  Git history.
- The same caution applies to exported `auth-profiles.json` files and any
  custom workspace files that contain sensitive material.
- Never commit a live `openclaw.sqlite`, `openclaw-agent.sqlite`, `-wal`, or
  `-shm` file. Besides containing mixed sensitive state, copying a live SQLite
  file without its matching WAL can silently lose recent data.
- If you do not want secrets in GitHub at all, use a different secure transport
  or remove `.env` before publishing and re-enter secrets during import.
