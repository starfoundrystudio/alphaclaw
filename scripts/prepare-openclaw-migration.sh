#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  prepare-openclaw-migration.sh [options]

Build a clean OpenClaw snapshot that AlphaClaw can import.

Options:
  --source-openclaw-dir PATH   Source OpenClaw root (default: $HOME/.openclaw)
  --main-workspace PATH        External main workspace to copy into workspace/
  --output-dir PATH            Output snapshot dir (default: $HOME/alphaclaw-migration)
  --target-home PATH           Home dir on the future AlphaClaw host (required)
  --keep-credentials           Keep credentials/ in the snapshot
  --force                      Replace an existing output directory
  --help                       Show this help
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

SOURCE_OPENCLAW_DIR="${HOME}/.openclaw"
MAIN_WORKSPACE=""
OUTPUT_DIR="${HOME}/alphaclaw-migration"
TARGET_HOME=""
TARGET_HOME_EXPLICIT=0
KEEP_CREDENTIALS=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-openclaw-dir)
      SOURCE_OPENCLAW_DIR="$2"
      shift 2
      ;;
    --main-workspace)
      MAIN_WORKSPACE="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --target-home)
      TARGET_HOME="$2"
      TARGET_HOME_EXPLICIT=1
      shift 2
      ;;
    --keep-credentials)
      KEEP_CREDENTIALS=1
      shift
      ;;
    --force)
      FORCE=1
      shift
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

require_cmd rsync
require_cmd node
require_cmd find

SOURCE_OPENCLAW_DIR="$(cd "$(dirname "$SOURCE_OPENCLAW_DIR")" && pwd)/$(basename "$SOURCE_OPENCLAW_DIR")"
OUTPUT_DIR="$(cd "$(dirname "$OUTPUT_DIR")" && pwd)/$(basename "$OUTPUT_DIR")"

if [[ ! -d "$SOURCE_OPENCLAW_DIR" ]]; then
  echo "Source OpenClaw dir does not exist: $SOURCE_OPENCLAW_DIR" >&2
  exit 1
fi

if [[ ! -f "$SOURCE_OPENCLAW_DIR/openclaw.json" ]]; then
  echo "Source dir does not contain openclaw.json: $SOURCE_OPENCLAW_DIR" >&2
  exit 1
fi

if [[ -n "$MAIN_WORKSPACE" ]]; then
  MAIN_WORKSPACE="$(cd "$(dirname "$MAIN_WORKSPACE")" && pwd)/$(basename "$MAIN_WORKSPACE")"
  if [[ ! -d "$MAIN_WORKSPACE" ]]; then
    echo "Main workspace does not exist: $MAIN_WORKSPACE" >&2
    exit 1
  fi
fi

if [[ "$TARGET_HOME_EXPLICIT" -ne 1 ]]; then
  echo "Missing required option: --target-home PATH" >&2
  echo "Pass the home directory for the destination AlphaClaw service user," >&2
  echo 'for example: --target-home /home/alphaclaw' >&2
  exit 1
fi

TARGET_HOME="$(cd "$(dirname "$TARGET_HOME")" && pwd)/$(basename "$TARGET_HOME")"
SOURCE_HOME="$(dirname "$SOURCE_OPENCLAW_DIR")"

if [[ -e "$OUTPUT_DIR" ]]; then
  if [[ "$FORCE" -ne 1 ]]; then
    echo "Output dir already exists: $OUTPUT_DIR" >&2
    echo "Re-run with --force to replace it." >&2
    exit 1
  fi
  rm -rf "$OUTPUT_DIR"
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/alphaclaw-migration.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

RSYNC_ARGS=(
  -a
  --exclude=.git/
  --exclude=agents/*/sessions/
  --exclude=cron/runs/
  --exclude=delivery-queue/
  --exclude=logs/
  --exclude=media/
  --exclude=devices/
  --exclude=identity/
  --exclude=telegram/
  --exclude=subagents/
  --exclude=canvas/
  --exclude=completions/
  --exclude=update-check.json
  --exclude=clawdbot.json
  --exclude=clawdbot.json.bak*
  --exclude=openclaw.json.bak*
  --exclude=cron/jobs.json.bak
)

if [[ "$KEEP_CREDENTIALS" -ne 1 ]]; then
  RSYNC_ARGS+=(--exclude=credentials/)
fi

echo "Copying OpenClaw state from $SOURCE_OPENCLAW_DIR"
rsync "${RSYNC_ARGS[@]}" "$SOURCE_OPENCLAW_DIR"/ "$TMP_DIR"/

if [[ -n "$MAIN_WORKSPACE" ]]; then
  echo "Replacing workspace/ with external main workspace from $MAIN_WORKSPACE"
  rm -rf "$TMP_DIR/workspace"
  rsync -a \
    --exclude=.git/ \
    --exclude=.openclaw/ \
    --exclude=node_modules/ \
    --exclude=.venv/ \
    "$MAIN_WORKSPACE"/ "$TMP_DIR/workspace"/
fi

WORKSPACE_DIRS=()
while IFS= read -r -d '' dir; do
  WORKSPACE_DIRS+=("$dir")
done < <(find "$TMP_DIR" -maxdepth 1 -type d \( -name 'workspace' -o -name 'workspace-*' \) -print0)

if [[ "${#WORKSPACE_DIRS[@]}" -gt 0 ]]; then
  echo "Removing nested workspace runtime state"
  for dir in "${WORKSPACE_DIRS[@]}"; do
    find "$dir" \( -name .git -o -name .openclaw \) -prune -exec rm -rf {} +
  done
fi

echo "Rewriting agent workspace paths for AlphaClaw"
ALPHACLAW_MIGRATION_DIR="$TMP_DIR" \
TARGET_HOME="$TARGET_HOME" \
SOURCE_HOME="$SOURCE_HOME" \
SOURCE_OPENCLAW_DIR="$SOURCE_OPENCLAW_DIR" \
MAIN_WORKSPACE="$MAIN_WORKSPACE" \
node <<'NODE'
const fs = require("fs");
const path = require("path");

const root = process.env.ALPHACLAW_MIGRATION_DIR;
const targetHome = process.env.TARGET_HOME;
const sourceHome = process.env.SOURCE_HOME;
const sourceOpenclawDir = process.env.SOURCE_OPENCLAW_DIR;
const mainWorkspace = process.env.MAIN_WORKSPACE || "";
const targetOpenclawDir = path.join(targetHome, ".alphaclaw", ".openclaw");
const targetMainWorkspace = path.join(targetOpenclawDir, "workspace");
const kTextFileExtensions = new Set([
  ".json",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".yaml",
  ".yml",
]);
const kIgnoredDirs = new Set([".git", "node_modules", ".venv", "__pycache__"]);
const kSourcePathPrefixes = [
  sourceOpenclawDir,
  path.join(sourceHome, ".openclaw"),
  path.join(sourceHome, ".alphaclaw", ".openclaw"),
].filter(Boolean);

const sortedPrefixes = [...new Set(kSourcePathPrefixes)].sort(
  (left, right) => right.length - left.length,
);

const replacePathPrefix = (value, sourcePrefix, targetPrefix) => {
  if (value === sourcePrefix) return targetPrefix;
  if (value.startsWith(`${sourcePrefix}${path.sep}`)) {
    return path.join(targetPrefix, path.relative(sourcePrefix, value));
  }
  return value;
};

const rewriteAbsolutePath = (value) => {
  if (typeof value !== "string" || !path.isAbsolute(value)) return value;
  let nextValue = value;
  if (mainWorkspace) {
    nextValue = replacePathPrefix(nextValue, mainWorkspace, targetMainWorkspace);
  }
  for (const sourcePrefix of sortedPrefixes) {
    nextValue = replacePathPrefix(nextValue, sourcePrefix, targetOpenclawDir);
  }
  const posixValue = nextValue.split(path.sep).join(path.posix.sep);
  const segments = posixValue.split(path.posix.sep).filter(Boolean);
  if (segments.length >= 3 && segments[0] === "home") {
    const managedRoot =
      segments[2] === ".openclaw"
        ? path.posix.join("/home", segments[1], ".openclaw")
        : segments[2] === ".alphaclaw" && segments[3] === ".openclaw"
          ? path.posix.join("/home", segments[1], ".alphaclaw", ".openclaw")
          : "";
    if (managedRoot) {
      nextValue = replacePathPrefix(nextValue, managedRoot, targetOpenclawDir);
    }
  }
  return nextValue;
};

const rewriteJsonValue = (value) => {
  if (typeof value === "string") {
    return rewriteAbsolutePath(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteJsonValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const rewritten = {};
  for (const [key, entry] of Object.entries(value)) {
    rewritten[key] = rewriteJsonValue(entry);
  }
  return rewritten;
};

const walkFiles = (dirPath, found = []) => {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (kIgnoredDirs.has(entry.name)) continue;
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(absolutePath, found);
      continue;
    }
    found.push(absolutePath);
  }
  return found;
};

const jsonFiles = walkFiles(root).filter((filePath) => filePath.endsWith(".json"));
for (const filePath of jsonFiles) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    continue;
  }
  let nextValue = rewriteJsonValue(parsed);
  if (path.relative(root, filePath) === "openclaw.json") {
    if (
      nextValue.agents &&
      typeof nextValue.agents === "object" &&
      nextValue.agents.defaults &&
      typeof nextValue.agents.defaults === "object" &&
      Object.prototype.hasOwnProperty.call(nextValue.agents.defaults, "workspace")
    ) {
      delete nextValue.agents.defaults.workspace;
    }

    if (Array.isArray(nextValue?.agents?.list)) {
      for (const agent of nextValue.agents.list) {
        const id = String(agent?.id || "").trim();
        if (!id) continue;
        const workspaceName = id === "main" ? "workspace" : `workspace-${id}`;
        agent.workspace = path.join(targetOpenclawDir, workspaceName);
        agent.agentDir = path.join(targetOpenclawDir, "agents", id, "agent");
      }
    }
  }
  fs.writeFileSync(filePath, `${JSON.stringify(nextValue, null, 2)}\n`, "utf8");
}

const suspiciousMatches = [];
for (const filePath of walkFiles(root)) {
  const ext = path.extname(filePath);
  if (!kTextFileExtensions.has(ext)) continue;
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    continue;
  }
  const checks = [
    sourceHome,
    sourceOpenclawDir,
    mainWorkspace,
  ].filter(Boolean);
  for (const needle of checks) {
    if (!content.includes(needle)) continue;
    suspiciousMatches.push({
      file: path.relative(root, filePath),
      value: needle,
    });
  }
}

for (const filePath of jsonFiles) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    continue;
  }
  const queue = [parsed];
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current === "string") {
      if (
        path.isAbsolute(current) &&
        current.startsWith("/home/") &&
        !current.startsWith(targetHome) &&
        !(mainWorkspace && current.startsWith(targetMainWorkspace))
      ) {
        suspiciousMatches.push({
          file: path.relative(root, filePath),
          value: current,
        });
      }
      continue;
    }
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (current && typeof current === "object") {
      queue.push(...Object.values(current));
    }
  }
}

if (suspiciousMatches.length > 0) {
  const lines = suspiciousMatches
    .slice(0, 20)
    .map((entry) => `- ${entry.file}: contains ${entry.value}`);
  const extra =
    suspiciousMatches.length > 20
      ? `\n- ...and ${suspiciousMatches.length - 20} more`
      : "";
  throw new Error(
    `Migration snapshot still contains source-machine paths after rewrite:\n${lines.join("\n")}${extra}`,
  );
}
NODE

mkdir -p "$(dirname "$OUTPUT_DIR")"
mv "$TMP_DIR" "$OUTPUT_DIR"
trap - EXIT

echo
echo "Prepared AlphaClaw import snapshot:"
echo "  $OUTPUT_DIR"
echo
echo "Recommended review:"
echo "  cd \"$OUTPUT_DIR\" && find . -maxdepth 2 | sort"
echo "  cd \"$OUTPUT_DIR\" && rg -n '$(printf "%s" "$SOURCE_HOME" | sed "s/[.[\\*^$()+?{|]/\\\\&/g")' . || true"
echo
echo "Next step:"
echo "  Push the snapshot to a private GitHub repo, then use it as the"
echo "  Source Repo during AlphaClaw onboarding."
