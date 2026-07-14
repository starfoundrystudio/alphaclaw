#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Load persisted env vars when running under cron's minimal environment.
if [[ -f "$REPO/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO/.env"
  set +a
fi

if [[ -z "${GITHUB_TOKEN:-}" || -z "${GITHUB_WORKSPACE_REPO:-}" ]]; then
  echo "hourly-git-sync: GitHub sync is not configured; skipping"
  exit 0
fi

resolve_alphaclaw_cmd() {
  if command -v alphaclaw >/dev/null 2>&1; then
    command -v alphaclaw
    return 0
  fi

  local candidate_paths=(
    "$REPO/node_modules/.bin/alphaclaw"
    "$REPO/../node_modules/.bin/alphaclaw"
  )
  local candidate
  for candidate in "${candidate_paths[@]}"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

msg="Auto-commit hourly sync $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
alphaclaw_cmd="$(resolve_alphaclaw_cmd || true)"
if [[ -z "${alphaclaw_cmd:-}" ]]; then
  echo "hourly-git-sync: alphaclaw CLI not found in PATH or known install paths" >&2
  exit 127
fi
"$alphaclaw_cmd" git-sync -m "$msg"
