# OpenClaw To AlphaClaw Migration

This guide walks through preparing an existing OpenClaw setup for import into a
fresh AlphaClaw installation.

It is aimed at older standalone OpenClaw layouts where the real state lives in
something like `~/.openclaw/`, and the main workspace may live somewhere else
such as `~/clawd/`.

## What AlphaClaw Expects

For a full import, AlphaClaw expects the source repository root to look like an
OpenClaw root:

- `openclaw.json` at the repository root
- optional `.env`
- optional `cron/jobs.json`
- optional `memory/`
- optional workspaces such as `workspace/` and `workspace-personal/`
- optional custom `skills/`, `hooks/`, and related repo-backed assets

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
- `auth-profiles.json`
- cron definitions such as `cron/jobs.json`
- memory databases in `memory/`
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

Because of that, expect to re-pair users, channels, and devices after import.
Keep the old `credentials/` files in a separate backup if you may want to
inspect or manually re-apply trusted IDs later, but do not rely on them to
survive the standard import flow.

## Recommended Workflow

1. Prepare a clean migration snapshot from the old OpenClaw machine.
2. Publish that snapshot to a private GitHub repository.
3. Start a new AlphaClaw installation.
4. In AlphaClaw onboarding, choose `Import existing setup`.
5. Use the snapshot repo as the `Source Repo`.
6. Use a different new or empty private repo as the `New Workspace Repo`.

Do not use the same GitHub repo for both the source snapshot and the new live
AlphaClaw-managed repo.

## Helper Scripts

This repo includes two scripts for the workflow:

- [scripts/prepare-openclaw-migration.sh](/Users/billk/Development/starfoundrystudio/alphaclaw/scripts/prepare-openclaw-migration.sh)
  builds a curated import snapshot
- [scripts/publish-openclaw-migration.sh](/Users/billk/Development/starfoundrystudio/alphaclaw/scripts/publish-openclaw-migration.sh)
  initializes git and pushes the snapshot to GitHub

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
- `--target-home` is required so the snapshot is always prepared for the
  destination machine explicitly
- pass `--keep-credentials` only if you intentionally want those files in the
  snapshot for archival reasons

### Review The Snapshot

Before pushing, inspect the prepared tree:

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
./auth-profiles.json
./cron/jobs.json
./memory/
./workspace/
./workspace-personal/
```

### Publish To GitHub

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

## Onboarding In The New AlphaClaw Instance

Once the snapshot repo is pushed:

1. Open the new AlphaClaw setup UI.
2. Choose `Import existing setup`.
3. Set `Source Repo` to the snapshot repo, for example
   `YOUR_USER/openclaw-migration`.
4. Set `New Workspace Repo` to a different repo that the new AlphaClaw install
   will own going forward, for example `YOUR_USER/my-new-agent`.
5. Provide a GitHub token that can read the source repo and create or access the
   new target repo.
6. Review detected secrets and env vars during import.
7. Finish onboarding.
8. Re-establish pairings and any machine-specific host integrations after the
   new instance is live.

## Manual Equivalent

If you prefer not to use the helper script, the manual version is:

1. Copy the old `~/.openclaw` tree to a new directory.
2. Remove runtime-only folders and nested workspace git metadata.
3. If the main workspace lives elsewhere, copy it into `workspace/` in the
   snapshot.
4. Rewrite migrated JSON path references so agent workspaces, agent dirs, and
   job working directories point to AlphaClaw defaults under
   `~/.alphaclaw/.openclaw/`.
5. Fail the prep step if stale source-machine path references remain.
6. Commit the snapshot to a private GitHub repo.
7. Import it through a new AlphaClaw installation.

## Security Notes

- Use a private repo for migration snapshots.
- If `.env` is included, secrets will be committed into git history.
- The same caution applies to `auth-profiles.json`, SQLite memory files, and any
  custom workspace files that contain sensitive material.
- If you do not want secrets in GitHub at all, remove `.env` before pushing and
  re-enter secrets during AlphaClaw import.
