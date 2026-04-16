#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  publish-openclaw-migration.sh [options]

Initialize git in a prepared migration snapshot and push it to GitHub.

Options:
  --source-dir PATH      Prepared snapshot dir (default: $HOME/alphaclaw-migration)
  --repo OWNER/NAME      GitHub repo to push to (required)
  --create               Create the repo through GitHub CLI before pushing
  --private              Create the repo as private (default with --create)
  --public               Create the repo as public
  --default-branch NAME  Branch to use (default: main)
  --help                 Show this help
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

SOURCE_DIR="${HOME}/alphaclaw-migration"
REPO=""
CREATE_REPO=0
VISIBILITY="private"
DEFAULT_BRANCH="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dir)
      SOURCE_DIR="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --create)
      CREATE_REPO=1
      shift
      ;;
    --private)
      VISIBILITY="private"
      shift
      ;;
    --public)
      VISIBILITY="public"
      shift
      ;;
    --default-branch)
      DEFAULT_BRANCH="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$REPO" ]]; then
  echo "--repo OWNER/NAME is required" >&2
  usage >&2
  exit 1
fi

require_cmd git

SOURCE_DIR="$(cd "$(dirname "$SOURCE_DIR")" && pwd)/$(basename "$SOURCE_DIR")"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Source dir does not exist: $SOURCE_DIR" >&2
  exit 1
fi

if [[ ! -f "$SOURCE_DIR/openclaw.json" ]]; then
  echo "Source dir does not look like a prepared migration snapshot: $SOURCE_DIR" >&2
  exit 1
fi

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  git -C "$SOURCE_DIR" init -b "$DEFAULT_BRANCH"
fi

GIT_USER_NAME="$(git -C "$SOURCE_DIR" config --get user.name || true)"
GIT_USER_EMAIL="$(git -C "$SOURCE_DIR" config --get user.email || true)"
if [[ -z "$GIT_USER_NAME" || -z "$GIT_USER_EMAIL" ]]; then
  echo "Git commit identity is not configured for $SOURCE_DIR." >&2
  echo "Set it first with either:" >&2
  echo "  git config --global user.name \"Your Name\"" >&2
  echo "  git config --global user.email \"you@example.com\"" >&2
  echo "or:" >&2
  echo "  git -C \"$SOURCE_DIR\" config user.name \"Your Name\"" >&2
  echo "  git -C \"$SOURCE_DIR\" config user.email \"you@example.com\"" >&2
  exit 1
fi

CURRENT_BRANCH="$(git -C "$SOURCE_DIR" branch --show-current || true)"
if [[ -z "$CURRENT_BRANCH" ]]; then
  git -C "$SOURCE_DIR" checkout -B "$DEFAULT_BRANCH"
elif [[ "$CURRENT_BRANCH" != "$DEFAULT_BRANCH" ]]; then
  git -C "$SOURCE_DIR" checkout -B "$DEFAULT_BRANCH"
fi

git -C "$SOURCE_DIR" add .

HAS_HEAD=1
if ! git -C "$SOURCE_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
  HAS_HEAD=0
fi

if [[ "$HAS_HEAD" -eq 0 ]] || ! git -C "$SOURCE_DIR" diff --cached --quiet; then
  git -C "$SOURCE_DIR" commit -m "Prepare OpenClaw migration backup"
fi

if [[ "$CREATE_REPO" -eq 1 ]]; then
  require_cmd gh
  gh auth status >/dev/null
  if [[ -n "$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)" ]]; then
    git -C "$SOURCE_DIR" remote remove origin
  fi
  (
    cd "$SOURCE_DIR"
    gh repo create "$REPO" "--${VISIBILITY}" --source=. --remote=origin --push
  )
else
  REMOTE_URL="https://github.com/${REPO}.git"
  if git -C "$SOURCE_DIR" remote get-url origin >/dev/null 2>&1; then
    git -C "$SOURCE_DIR" remote set-url origin "$REMOTE_URL"
  else
    git -C "$SOURCE_DIR" remote add origin "$REMOTE_URL"
  fi
  git -C "$SOURCE_DIR" push -u origin "$DEFAULT_BRANCH"
fi

echo
echo "Published migration snapshot:"
echo "  https://github.com/${REPO}"
echo
echo "Use that repo as the Source Repo during AlphaClaw import."
