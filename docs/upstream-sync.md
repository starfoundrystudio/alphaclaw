# Upstream Sync Workflow

This document describes the branching and merge workflow AlphaClaw uses to
pull new upstream releases from `chrysb/alphaclaw` into the Starfoundry fork
while keeping fork-specific changes reviewable.

Companion document:

- [`docs/fork-deviations.md`](/Users/billk/Development/starfoundrystudio/alphaclaw/docs/fork-deviations.md)
  tracks the intentional fork-only behaviors that still differ from upstream.

## Goals

- Keep the fork as close to upstream as practical.
- Sync to tagged upstream releases, not moving upstream branch heads.
- Resolve risky conflicts on a dedicated integration branch before touching
  `main`.
- Preserve Starfoundry-specific behavior only where upstream does not yet
  cover it.

## Branch Roles

- `main`
  - Starfoundry's release branch.
  - Always represents the code we are willing to ship from.

- `upstream-vX.Y.Z`
  - Local and remote marker branch pointing at an exact upstream release tag.
  - Example: `upstream-v0.9.2`, `upstream-v0.9.9`.
  - This gives us a stable branch name to merge from and makes history easier
    to inspect later.

- `codex/merge-upstream-vX.Y.Z`
  - Temporary integration branch created from the current Starfoundry `main`.
  - Used to merge the upstream marker branch, resolve conflicts, run tests,
    and prepare the final merge back into `main`.

- `upstream-main`
  - Historical helper branch.
  - Do not rely on this as the source of truth for new syncs.
  - Prefer exact upstream tag branches such as `upstream-v0.9.9`.

## Standard Sync Procedure

Use this flow for each new upstream release.

### 1. Fetch upstream and create the release marker branch

```bash
git fetch upstream --tags
git checkout -B upstream-v0.9.9 v0.9.9
git push -u origin upstream-v0.9.9
```

Notes:

- Replace `0.9.9` with the upstream version being synced.
- Creating the branch from the tag keeps our workflow consistent even if
  upstream later moves `main`.

### 2. Create the integration branch from current fork `main`

```bash
git checkout main
git pull --ff-only origin main
git checkout -b codex/merge-upstream-v0.9.9
```

Notes:

- If local `main` contains unreleased but intentional fixes, keep them.
- If local `main` contains experimental work that should not be part of the
  sync, separate it before creating the integration branch.

### 3. Merge the upstream release branch

```bash
git merge upstream-v0.9.9
```

Resolve conflicts on the integration branch, not on `main`.

### 4. Apply conflict policy

Default policy:

- Prefer upstream when the fork change was only a temporary workaround and
  upstream now has a real fix.
- Keep Starfoundry-specific behavior when it is still required for our deploy,
  packaging, onboarding, or compatibility needs.

For import/onboarding conflicts, use the issue-specific policy for the release
you are syncing. As of the `v0.9.9` sync discussion:

- Prefer upstream in `lib/server/onboarding/import/import-applier.js`
  because upstream now handles non-empty import targets.
- Re-evaluate before keeping any fork-only import workaround that exists only
  to compensate for the old upstream "target already exists" failure.
- Keep the managed runtime token preservation fix unless upstream has clearly
  added equivalent handling for `OPENCLAW_GATEWAY_TOKEN` and `WEBHOOK_TOKEN`.
- Keep pre-onboarding initialization protections unless upstream has clearly
  stopped creating conflicting `.openclaw` runtime state before onboarding is
  complete.

### 5. Run verification

At minimum:

```bash
npm test
```

Before cutting a release tag for a newly synced upstream version, also verify
that `patches/` only contains patch files that still match the current
`openclaw` version in `package.json`.

Recommended check:

```bash
find patches -maxdepth 1 -type f | sort
npm ci
```

Notes:

- AlphaClaw's postinstall applies every `.patch` file in `patches/`.
- If an old file such as `patches/openclaw+2026.4.10.patch` is left behind
  after we move to a newer OpenClaw version such as `2026.4.15`, clean
  installs can fail even if local incremental installs appear fine.
- If `npm ci` fails during `patch-package` with an older patch filename,
  delete the stale patch, regenerate `package-lock.json` from a clean install
  if needed, and rerun `npm ci` before tagging a release.

For risky onboarding/import changes, also do a manual smoke test:

1. Perform a fresh onboarding.
2. Perform a GitHub import from a representative migration repo.
3. Confirm onboarding completes.
4. Confirm the gateway starts without a watchdog crash loop.

### 6. Push the integration branch for review

```bash
git push -u origin codex/merge-upstream-v0.9.9
```

Use this branch for code review and discussion of any deliberate deviations
from upstream.

Before merging the integration branch back into `main`, update
[`docs/fork-deviations.md`](/Users/billk/Development/starfoundrystudio/alphaclaw/docs/fork-deviations.md)
to:

- add any new intentional divergence introduced during the sync
- mark old divergences as retired when upstream now covers them
- note whether each remaining deviation is shipped, pending, or only local
  evaluation

### 7. Merge back into `main`

After verification:

```bash
git checkout main
git merge --no-ff codex/merge-upstream-v0.9.9
git push origin main
```

Then continue with the normal Starfoundry release process.

## Historical Example

The prior sync to upstream `v0.9.2` followed this pattern:

- `upstream-v0.9.2`
- `codex/merge-upstream-v0.9.2`
- merge back into `main`

That history is preserved in the repository and is the model this document is
formalizing.

## Notes On Remote Branch Hygiene

- It is fine to keep old `upstream-v*` and `codex/merge-upstream-v*` branches
  for historical reference.
- Do not assume `origin/upstream-main` is current.
- The only branch that should be treated as release-ready is `main`.

## Recommended Commit Discipline

When resolving a sync:

- Keep merge-resolution commits small and specific where possible.
- If upstream now covers one of our old workarounds, remove the workaround in
  the sync branch rather than carrying duplicate logic forward.
- Document any intentional post-merge divergence in
  [`docs/fork-deviations.md`](/Users/billk/Development/starfoundrystudio/alphaclaw/docs/fork-deviations.md)
  and reference it in the PR description when relevant.
