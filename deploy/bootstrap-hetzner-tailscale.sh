#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[alphaclaw-bootstrap] %s\n' "$*"
}

die() {
  printf '[alphaclaw-bootstrap] Error: %s\n' "$*" >&2
  exit 1
}

require_env() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    die "set ${key} before running this script"
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

source_env_file() {
  local file="$1"
  local default_file="$2"

  if [[ -f "$file" ]]; then
    log "Loading bootstrap environment from ${file}"
    set -a
    # shellcheck disable=SC1090
    . "$file"
    set +a
    return
  fi

  if [[ "$file" != "$default_file" ]]; then
    die "bootstrap env file not found: ${file}"
  fi
}

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="${3:-}"
  local tmp

  mkdir -p "$(dirname "$file")"
  touch "$file"
  tmp="$(mktemp)"

  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    index($0, key "=") == 1 {
      print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) print key "=" value
    }
  ' "$file" > "$tmp"

  mv "$tmp" "$file"
}

DEFAULT_BOOTSTRAP_ENV_FILE="/root/.alphaclaw-bootstrap.env"
BOOTSTRAP_ENV_FILE="${BOOTSTRAP_ENV_FILE:-${DEFAULT_BOOTSTRAP_ENV_FILE}}"
source_env_file "${BOOTSTRAP_ENV_FILE}" "${DEFAULT_BOOTSTRAP_ENV_FILE}"

require_env "TAILSCALE_AUTHKEY"
require_env "SETUP_PASSWORD"
require_env "ALPHACLAW_IMAGE"

APP_ROOT="${APP_ROOT:-/opt/alphaclaw}"
DATA_DIR="${DATA_DIR:-${APP_ROOT}/data}"
ENV_FILE="${ENV_FILE:-${APP_ROOT}/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-${APP_ROOT}/docker-compose.yml}"
TAILSCALE_HOSTNAME="${TAILSCALE_HOSTNAME:-alphaclaw}"
TAILSCALE_SERVE_PORT="${TAILSCALE_SERVE_PORT:-443}"
TAILSCALE_FUNNEL_PORT="${TAILSCALE_FUNNEL_PORT:-8443}"
TRUST_PROXY_HOPS="${TRUST_PROXY_HOPS:-1}"
WATCHDOG_AUTO_REPAIR="${WATCHDOG_AUTO_REPAIR:-true}"
WATCHDOG_NOTIFICATIONS_DISABLED="${WATCHDOG_NOTIFICATIONS_DISABLED:-false}"
ALPHACLAW_PUBLIC_EXTRA_PATH_PREFIXES="${ALPHACLAW_PUBLIC_EXTRA_PATH_PREFIXES:-}"
ALPHACLAW_GHCR_USERNAME="${ALPHACLAW_GHCR_USERNAME:-}"
ALPHACLAW_GHCR_TOKEN="${ALPHACLAW_GHCR_TOKEN:-}"
TAILSCALE_ADVERTISE_TAGS="${TAILSCALE_ADVERTISE_TAGS:-}"

if [[ "${EUID}" -ne 0 ]]; then
  die "run this script as root"
fi

log "Installing system dependencies"
apt-get update
apt-get install -y ca-certificates curl jq

if ! command_exists docker; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

systemctl enable --now docker

if ! docker compose version >/dev/null 2>&1; then
  die "docker compose plugin is not available after Docker install"
fi

if ! command_exists tailscale; then
  log "Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi

systemctl enable --now tailscaled

tailscale_up_args=(
  --auth-key="${TAILSCALE_AUTHKEY}"
  --hostname="${TAILSCALE_HOSTNAME}"
  --ssh
)

if [[ -n "${TAILSCALE_ADVERTISE_TAGS}" ]]; then
  tailscale_up_args+=(--advertise-tags="${TAILSCALE_ADVERTISE_TAGS}")
fi

log "Joining the Tailscale tailnet"
tailscale up "${tailscale_up_args[@]}"

TS_DNS="$(tailscale status --json | jq -r '.Self.DNSName | sub("\\.$"; "")')"
if [[ -z "${TS_DNS}" || "${TS_DNS}" == "null" ]]; then
  die "could not determine Tailscale DNS name; confirm MagicDNS is enabled"
fi

ALPHACLAW_SETUP_URL="${ALPHACLAW_SETUP_URL:-https://${TS_DNS}}"
ALPHACLAW_PUBLIC_BASE_URL="${ALPHACLAW_PUBLIC_BASE_URL:-https://${TS_DNS}:${TAILSCALE_FUNNEL_PORT}}"

if [[ "${ALPHACLAW_SETUP_URL}" == "${ALPHACLAW_PUBLIC_BASE_URL}" ]]; then
  die "ALPHACLAW_SETUP_URL and ALPHACLAW_PUBLIC_BASE_URL must be different origins"
fi

mkdir -p "${APP_ROOT}" "${DATA_DIR}"

if [[ -n "${ALPHACLAW_GHCR_USERNAME}" || -n "${ALPHACLAW_GHCR_TOKEN}" ]]; then
  if [[ -z "${ALPHACLAW_GHCR_USERNAME}" || -z "${ALPHACLAW_GHCR_TOKEN}" ]]; then
    die "set both ALPHACLAW_GHCR_USERNAME and ALPHACLAW_GHCR_TOKEN for private GHCR images"
  fi
  log "Logging in to GHCR"
  printf '%s' "${ALPHACLAW_GHCR_TOKEN}" | docker login ghcr.io -u "${ALPHACLAW_GHCR_USERNAME}" --password-stdin
fi

log "Writing managed docker-compose file"
cat > "${COMPOSE_FILE}" <<EOF
services:
  alphaclaw:
    image: ${ALPHACLAW_IMAGE}
    container_name: alphaclaw
    restart: unless-stopped
    env_file:
      - ${ENV_FILE}
    environment:
      ALPHACLAW_ROOT_DIR: /data
      PORT: "3000"
    volumes:
      - ${DATA_DIR}:/data
    ports:
      - "127.0.0.1:3000:3000"
EOF

log "Updating environment file"
upsert_env_var "${ENV_FILE}" "SETUP_PASSWORD" "${SETUP_PASSWORD}"
upsert_env_var "${ENV_FILE}" "TRUST_PROXY_HOPS" "${TRUST_PROXY_HOPS}"
upsert_env_var "${ENV_FILE}" "WATCHDOG_AUTO_REPAIR" "${WATCHDOG_AUTO_REPAIR}"
upsert_env_var "${ENV_FILE}" "WATCHDOG_NOTIFICATIONS_DISABLED" "${WATCHDOG_NOTIFICATIONS_DISABLED}"
upsert_env_var "${ENV_FILE}" "ALPHACLAW_SETUP_URL" "${ALPHACLAW_SETUP_URL}"
upsert_env_var "${ENV_FILE}" "ALPHACLAW_PUBLIC_BASE_URL" "${ALPHACLAW_PUBLIC_BASE_URL}"
upsert_env_var "${ENV_FILE}" "ALPHACLAW_PUBLIC_EXTRA_PATH_PREFIXES" "${ALPHACLAW_PUBLIC_EXTRA_PATH_PREFIXES}"
chmod 600 "${ENV_FILE}"

log "Pulling and starting AlphaClaw"
(
  cd "${APP_ROOT}"
  docker compose pull
  docker compose up -d
)

log "Configuring Tailscale Serve for the private UI"
tailscale serve --bg --https="${TAILSCALE_SERVE_PORT}" 127.0.0.1:3000

log "Configuring Tailscale Funnel for public callbacks"
tailscale funnel --bg --https="${TAILSCALE_FUNNEL_PORT}" 127.0.0.1:3000

log "Deployment complete"
printf '\n'
printf 'Private Setup UI: %s\n' "${ALPHACLAW_SETUP_URL}"
printf 'Public callbacks: %s\n' "${ALPHACLAW_PUBLIC_BASE_URL}"
printf '\n'
printf 'Useful checks:\n'
printf '  tailscale serve status\n'
printf '  tailscale funnel status\n'
printf '  docker compose -f %s logs -f\n' "${COMPOSE_FILE}"
