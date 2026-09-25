# Rolling back a bad production release

A production release is three pins. New instances read them when they are
provisioned; nothing on an existing instance reads them afterwards.

| Pin | Where it lives | Read when |
| --- | --- | --- |
| Clawbridge (alphaclaw) release | GitHub Packages dist-tag `latest` on `@starfoundrystudio/alphaclaw` | The host bootstrap runs `npm install @starfoundrystudio/alphaclaw@latest` on every provision, even on a baked image |
| Host bundle (clawctl) | TeamYou Vercel **Production** env `OPENCLAW_HOST_ASSET_BUNDLE_URL` / `_SHA256` (beta channel: `…_URL_BETA` / `…_SHA256_BETA`) | TeamYou's bootstrap claim hands the URL and sha to the new host |
| TeamYou control plane | The live Vercel production deployment | Every provisioning step |

Rolling back means pointing the bad pin(s) back at the previous values.
Old alphaclaw versions stay installable and bundles are sha-addressed and
never deleted, so the previous release is always available.

## Steps

Work out which pin is bad first; usually only one needs to move.

1. **Clawbridge release** (takes effect immediately, no redeploy):

   ```bash
   npm dist-tag add @starfoundrystudio/alphaclaw@<previous-version> latest
   npm view @starfoundrystudio/alphaclaw dist-tags
   ```

2. **Host bundle.** The previous URL and sha are in clawctl's
   `assets/host-bundle-manifest.json` history (`git log -p` on that file).
   Replace both values, then redeploy the live production deployment so the
   new values load:

   ```bash
   cd teamyou
   vercel env rm OPENCLAW_HOST_ASSET_BUNDLE_URL production --yes
   vercel env rm OPENCLAW_HOST_ASSET_BUNDLE_SHA256 production --yes
   printf '%s' "<previous-url>" | vercel env add OPENCLAW_HOST_ASSET_BUNDLE_URL production --sensitive
   printf '%s' "<previous-sha>" | vercel env add OPENCLAW_HOST_ASSET_BUNDLE_SHA256 production --sensitive
   vercel ls --prod                      # the top Ready row is live
   vercel redeploy <live-production-url> --target production
   ```

   Redeploying the live deployment rebuilds the same TeamYou code with the
   new environment values; it does not pick up newer `main` commits.

3. **TeamYou control plane** (only if a TeamYou deploy is at fault):
   `vercel rollback <previous-production-deployment-url>`, or Instant
   Rollback in the Vercel dashboard.

**Order when both alphaclaw and the bundle move:** newer bundles are written
to support older Clawbridge releases (host scripts check the version), but
an older bundle may lack host fixes a newer release needs. So on promotion
pin the bundle first and move `latest` second; on rollback move `latest`
back first and the bundle second.

## What a rollback does not do

- **Instances already provisioned keep the bad release.** Fixing them is
  per-instance operator work (fleet project `rs8GE45wtye2`). Do not
  downgrade an instance across an OpenClaw state migration (for example
  2026.9 → 2026.7); fix it forward instead.
- A provision whose bootstrap has already installed Clawbridge keeps what it
  installed.
- Restores follow `latest` until the restore policy (TeamYou project
  `noKAlXtKZtJ4`) says otherwise.

## Current and previous values (2026-09-25)

| Pin | Current | Previous (rollback target) |
| --- | --- | --- |
| alphaclaw `latest` | `0.9.18-starfoundry.23` (OpenClaw 2026.9.5) | `0.9.18-starfoundry.22` (OpenClaw 2026.7.1) |
| Stable bundle | `7d902eb0…0c34` (clawctl `9e3c6d9`) | `4c6e717d…b8e0` (clawctl `942969f` record) |
| Beta bundle | `7d902eb0…0c34` | `42536ffa…797b` |

Full previous stable bundle:
`https://k9uoabobegtoma9k.public.blob.vercel-storage.com/clawctl/host-assets/sha256/4c6e717dc41b14bdcf9a7a5f4f43c81f01510e4c9eae897366149d6e4e1db8e0.tar.gz`
(sha256 `4c6e717dc41b14bdcf9a7a5f4f43c81f01510e4c9eae897366149d6e4e1db8e0`).
