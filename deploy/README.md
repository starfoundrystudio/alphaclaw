# Hetzner + Tailscale Bootstrap

This deployment path assumes:

- you have already published a pinned AlphaClaw image to GHCR
- the target VPS is a Hetzner Ubuntu/Debian machine
- the target tailnet has `MagicDNS`, `HTTPS`, and the `funnel` node attribute enabled
- you have a Tailscale auth key for the customer's tailnet

## Inputs

Export these before running the bootstrap script on the VPS:

```bash
export ALPHACLAW_IMAGE="ghcr.io/your-org/alphaclaw:0.8.7-starfoundry.1"
export TAILSCALE_AUTHKEY="tskey-auth-..."
export SETUP_PASSWORD="choose-a-strong-password"
```

Optional inputs:

```bash
export APP_ROOT="/opt/alphaclaw"
export TAILSCALE_HOSTNAME="alphaclaw-prod"
export ALPHACLAW_PUBLIC_EXTRA_PATH_PREFIXES="/googlechat,/api/messages"
export ALPHACLAW_GHCR_USERNAME="your-gh-user"
export ALPHACLAW_GHCR_TOKEN="ghp_or_pat_for_private_images"
export TAILSCALE_ADVERTISE_TAGS="tag:openclaw-server"
```

The script derives these automatically unless you override them:

- `ALPHACLAW_SETUP_URL=https://<node>.<tailnet>.ts.net`
- `ALPHACLAW_PUBLIC_BASE_URL=https://<node>.<tailnet>.ts.net:8443`

## Run

Run the script on the VPS as root from the repo checkout:

```bash
bash deploy/bootstrap-hetzner-tailscale.sh
```

It will:

1. install Docker and Tailscale if needed
2. join the VPS to the target tailnet
3. write a managed `docker-compose.yml` and `.env`
4. pull the pinned GHCR image
5. start AlphaClaw
6. configure `tailscale serve` on `443` for the private UI
7. configure `tailscale funnel` on `8443` for public callback paths

## Result

After a successful run:

- private UI:
  `https://<node>.<tailnet>.ts.net`
- public callbacks:
  `https://<node>.<tailnet>.ts.net:8443`

AlphaClaw should then use:

- `ALPHACLAW_SETUP_URL` for the private UI
- `ALPHACLAW_PUBLIC_BASE_URL` for webhook/OAuth callback generation

## Upgrade

To upgrade later, either rerun the bootstrap script with a new `ALPHACLAW_IMAGE`
value, or update the managed compose file and run:

```bash
cd /opt/alphaclaw
docker compose pull
docker compose up -d
```

If you want fully repeatable production upgrades, pin by digest instead of tag.
