#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const {
  assertSafeNodeSqliteRuntime,
} = require("../lib/runtime/node-sqlite-safety");

assertSafeNodeSqliteRuntime();

const {
  resolveRealGitPath,
} = require("../lib/cli/git-runtime");
const {
  reconcileOpenclawPlugins,
} = require("../lib/cli/openclaw-plugin-compat");
const {
  runAlphaclawMigrations,
} = require("../lib/cli/alphaclaw-migrations");
const {
  runOpenclawDoctorWithOauthGuard,
} = require("../lib/cli/openclaw-doctor-oauth-guard");
const {
  buildOpenclawRuntimeEnv,
  runOpenclawRuntimeCommand,
} = require("../lib/cli/openclaw-runtime-command");
const {
  inspectOpenclawStartupState,
} = require("../lib/cli/openclaw-startup-state-repair");
const {
  migrateManagedInternalFiles,
} = require("../lib/server/internal-files-migration");
const {
  shouldInitializeManagedOpenclawRuntime,
} = require("../lib/server/openclaw-runtime-state");
const {
  resolveManagedCodexHome,
} = require("../lib/server/openclaw-runtime-env");
const {
  runOpenclawDoctorRepairSync,
} = require("../lib/server/openclaw-doctor-repair");

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const flagValue = (argv, ...flags) => {
  for (const flag of flags) {
    const idx = argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < argv.length) {
      return argv[idx + 1];
    }
  }
  return undefined;
};

const kGlobalValueFlags = new Set(["--root-dir", "--port"]);
const splitGlobalAndCommandArgs = (argv) => {
  const globalArgs = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (!token.startsWith("-")) break;
    globalArgs.push(token);
    if (kGlobalValueFlags.has(token) && index + 1 < argv.length) {
      globalArgs.push(argv[index + 1]);
      index += 2;
      continue;
    }
    index += 1;
  }
  return {
    globalArgs,
    commandArgs: argv.slice(index),
  };
};

const { globalArgs, commandArgs } = splitGlobalAndCommandArgs(args);
const command = commandArgs[0];
const commandScope = commandArgs[1];
const commandAction = commandArgs[2];

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);

if (
  args.includes("--version") ||
  args.includes("-v") ||
  command === "version"
) {
  console.log(pkg.version);
  process.exit(0);
}

const isOpenclawPassthroughCommand =
  command === "openclaw-runtime" || command === "openclaw-doctor-guard";
if (
  !command ||
  command === "help" ||
  (!isOpenclawPassthroughCommand && commandArgs.includes("--help")) ||
  (isOpenclawPassthroughCommand &&
    commandArgs.length === 2 &&
    commandArgs[1] === "--help")
) {
  console.log(`
alphaclaw v${pkg.version}

Usage: alphaclaw <command> [options]

Commands:
  start     Start the AlphaClaw server (Setup UI + gateway manager)
  migrate   Inspect or apply AlphaClaw-owned upgrade migrations
  verify-openclaw-startup-state  Fail if doctor left known startup blockers
  openclaw-runtime  Run a command with the managed OpenClaw runtime environment
  openclaw-doctor-guard  Run an OpenClaw command with OAuth-refresh shielding
  reconcile-openclaw-plugins  Install/update AlphaClaw-managed OpenClaw plugins
  telegram topic add  Add/update Telegram topic mapping by thread ID
  version   Print version

Global options:
--version, -v       Print version
--help              Show this help message

start options:
--root-dir <path>   Persistent data directory (default: ~/.alphaclaw)
--port <number>     Server port (default: 3000)

migrate options:
  --fix                    Apply pending AlphaClaw migrations
  --status                 Show migration status (default without --fix)
  --json                   Print machine-readable JSON
  --force-retry <id|all>   Retry a migration after repeated failures

openclaw-runtime options:
  -- <command...>           Command to run with Agent Vault and OpenClaw runtime environment

openclaw-doctor-guard options:
  -- <command...>           Command to run while OAuth auth profiles are shielded

telegram topic add options:
  --thread <id>       Telegram thread ID
  --name <text>       Topic name
  --system <text>     Optional system instructions
  --agent <id>        Optional agent ID for per-topic routing
  --group <id>        Optional group ID override (auto-resolves when one group exists)

Examples:
  alphaclaw migrate
  alphaclaw migrate --fix
  alphaclaw verify-openclaw-startup-state
  alphaclaw openclaw-runtime -- openclaw plugins list
  alphaclaw openclaw-doctor-guard -- openclaw doctor --non-interactive --fix
  alphaclaw reconcile-openclaw-plugins
  alphaclaw telegram topic add --thread 12 --name "Testing"
  alphaclaw telegram topic add --thread 12 --name "Testing" --system "Handle QA requests"
  alphaclaw telegram topic add --thread 12 --name "Ops" --agent ops
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Resolve root directory (before requiring any lib/ modules)
// ---------------------------------------------------------------------------

const rootDir =
  flagValue(args, "--root-dir") ||
  process.env.ALPHACLAW_ROOT_DIR ||
  path.join(os.homedir(), ".alphaclaw");

process.env.ALPHACLAW_ROOT_DIR = rootDir;

const portFlag = flagValue(args, "--port");
if (portFlag) {
  process.env.PORT = portFlag;
}

// ---------------------------------------------------------------------------
// 2. Create directory structure
// ---------------------------------------------------------------------------

const openclawDir = path.join(rootDir, ".openclaw");
const buildCliOpenclawBaseEnv = () => ({
  ...process.env,
  OPENCLAW_HOME: rootDir,
  OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
  OPENCLAW_STATE_DIR: openclawDir,
  XDG_CONFIG_HOME: openclawDir,
});
const buildCliOpenclawRuntimeEnv = () =>
  buildOpenclawRuntimeEnv({
    env: buildCliOpenclawBaseEnv(),
  });
const buildCliOpenclawMaintenanceEnv = () =>
  buildOpenclawRuntimeEnv({
    env: buildCliOpenclawBaseEnv(),
    allowConfigMutation: true,
  });
const onboardingMarkerPath = path.join(rootDir, "onboarded.json");
const shouldInitializeManagedRuntime = shouldInitializeManagedOpenclawRuntime({
  fs,
  onboardingMarkerPath,
  openclawDir,
});
if (shouldInitializeManagedRuntime) {
  fs.mkdirSync(openclawDir, { recursive: true });
  migrateManagedInternalFiles({
    fs,
    openclawDir,
  });
}
console.log(`[alphaclaw] Root directory: ${rootDir}`);

// ---------------------------------------------------------------------------
// 3. Symlink ~/.openclaw -> <root>/.openclaw
// ---------------------------------------------------------------------------

const homeOpenclawLink = path.join(os.homedir(), ".openclaw");
try {
  if (shouldInitializeManagedRuntime && !fs.existsSync(homeOpenclawLink)) {
    fs.symlinkSync(openclawDir, homeOpenclawLink);
    console.log(`[alphaclaw] Symlinked ${homeOpenclawLink} -> ${openclawDir}`);
  }
} catch (e) {
  console.log(`[alphaclaw] Symlink skipped: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 4. Ensure <rootDir>/.env exists (seed from template if missing)
// ---------------------------------------------------------------------------

const envFilePath = path.join(rootDir, ".env");
const setupDir = path.join(__dirname, "..", "lib", "setup");
const templatePath = path.join(setupDir, "env.template");

try {
  if (!fs.existsSync(envFilePath) && fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, envFilePath);
    console.log(`[alphaclaw] Created env at ${envFilePath}`);
  }
} catch (e) {
  console.log(`[alphaclaw] .env setup skipped: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 5. Load .env into process.env
// ---------------------------------------------------------------------------

if (fs.existsSync(envFilePath)) {
  const content = fs.readFileSync(envFilePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (value) process.env[key] = value;
  }
  console.log("[alphaclaw] Loaded .env");
}

const hasFlag = (argv, ...flags) => flags.some((flag) => argv.includes(flag));

const formatMigrationStatus = (result) => {
  const summary = result.summary || {};
  const pieces = [
    `${summary.total || 0} checked`,
    `${summary.pending || 0} pending`,
    `${summary.fixed || 0} fixed`,
    `${summary.blocked || 0} blocked`,
    `${summary.failed || 0} failed`,
  ];
  const lines = [
    `[alphaclaw] AlphaClaw migrations: ${pieces.join(", ")}`,
    `[alphaclaw] Ledger: ${result.ledgerPath}`,
  ];
  for (const item of result.results || []) {
    const prefix = item.status === "fixed"
      ? "fixed"
      : item.status === "pending"
        ? "pending"
        : item.status === "blocked"
          ? "blocked"
          : item.status === "failed"
            ? "failed"
            : "ok";
    lines.push(
      `[alphaclaw] ${prefix}: ${item.id} - ${
        item.message || item.error || item.title
      }`,
    );
    for (const change of item.changes || []) {
      lines.push(`[alphaclaw]   - ${change}`);
    }
  }
  return lines.join("\n");
};

const runMigrate = () => {
  try {
    const result = runAlphaclawMigrations({
      rootDir,
      openclawDir,
      fsModule: fs,
      fix: hasFlag(commandArgs, "--fix"),
      forceRetry: flagValue(commandArgs, "--force-retry") || "",
    });
    if (hasFlag(commandArgs, "--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatMigrationStatus(result));
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    const details = String(e.stderr || e.stdout || e.message || "").trim();
    console.error(
      `[alphaclaw] AlphaClaw migration failed: ${details.slice(0, 800)}`,
    );
    return 1;
  }
};

if (command === "migrate") {
  process.exit(runMigrate());
}

const runVerifyOpenclawStartupState = () => {
  const result = inspectOpenclawStartupState({ fsModule: fs, openclawDir });
  if (hasFlag(commandArgs, "--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log("[alphaclaw] OpenClaw startup state has no known legacy blockers");
  } else {
    console.error("[alphaclaw] OpenClaw startup state verification failed:");
    for (const blocker of result.blockers) {
      console.error(`- ${blocker.message} ${blocker.path}`);
    }
  }
  return result.ok ? 0 : 1;
};

if (command === "verify-openclaw-startup-state") {
  process.exit(runVerifyOpenclawStartupState());
}

const runOpenclawDoctorGuard = () => {
  const separatorIndex = commandArgs.indexOf("--");
  const guardedCommandArgs =
    separatorIndex >= 0 ? commandArgs.slice(separatorIndex + 1) : commandArgs.slice(1);
  if (guardedCommandArgs.length === 0) {
    console.error(
      "[alphaclaw] Missing command for openclaw-doctor-guard. Use: alphaclaw openclaw-doctor-guard -- openclaw doctor --non-interactive --fix",
    );
    return 1;
  }
  try {
    return runOpenclawDoctorWithOauthGuard({
      rootDir,
      openclawDir,
      commandArgs: guardedCommandArgs,
      env: buildCliOpenclawMaintenanceEnv(),
      cwd: process.cwd(),
      stdio: "inherit",
      logger: console,
    });
  } catch (e) {
    const details = String(e.stderr || e.stdout || e.message || "").trim();
    console.error(
      `[alphaclaw] Guarded OpenClaw doctor failed: ${details.slice(0, 800)}`,
    );
    return 1;
  }
};

if (command === "openclaw-doctor-guard") {
  process.exit(runOpenclawDoctorGuard());
}

const runManagedOpenclawRuntimeCommand = () => {
  const separatorIndex = commandArgs.indexOf("--");
  const runtimeCommandArgs =
    separatorIndex >= 0 ? commandArgs.slice(separatorIndex + 1) : commandArgs.slice(1);
  if (runtimeCommandArgs.length === 0) {
    console.error(
      "[alphaclaw] Missing command for openclaw-runtime. Use: alphaclaw openclaw-runtime -- openclaw plugins list",
    );
    return 1;
  }
  try {
    return runOpenclawRuntimeCommand({
      commandArgs: runtimeCommandArgs,
      env: buildCliOpenclawBaseEnv(),
      cwd: process.cwd(),
      stdio: "inherit",
      logger: console,
    });
  } catch (e) {
    console.error(
      `[alphaclaw] Managed OpenClaw runtime command failed: ${e.message || e}`,
    );
    return 1;
  }
};

if (command === "openclaw-runtime") {
  process.exit(runManagedOpenclawRuntimeCommand());
}

const runReconcileOpenclawPlugins = () => {
  try {
    reconcileOpenclawPlugins({
      rootDir,
      openclawDir,
      fsModule: fs,
      execSyncImpl: execSync,
      logger: console,
      env: buildCliOpenclawMaintenanceEnv(),
    });
    return 0;
  } catch (e) {
    const details = String(e.stderr || e.stdout || e.message || "").trim();
    console.error(
      `[alphaclaw] OpenClaw plugin reconciliation failed: ${details.slice(0, 800)}`,
    );
    return 1;
  }
};

if (command === "reconcile-openclaw-plugins") {
  process.exit(runReconcileOpenclawPlugins());
}

const runTelegramTopicAdd = () => {
  const topicName = String(flagValue(commandArgs, "--name") || "").trim();
  const threadId = String(flagValue(commandArgs, "--thread") || "").trim();
  const systemInstructions = String(
    flagValue(commandArgs, "--system") || "",
  ).trim();
  const agentId = String(flagValue(commandArgs, "--agent") || "").trim();
  const requestedGroupId = String(
    flagValue(commandArgs, "--group") || "",
  ).trim();
  if (!threadId) {
    console.error("[alphaclaw] Missing --thread for telegram topic add");
    return 1;
  }
  if (!topicName) {
    console.error("[alphaclaw] Missing --name for telegram topic add");
    return 1;
  }

  const configPath = path.join(openclawDir, "openclaw.json");
  if (!fs.existsSync(configPath)) {
    console.error("[alphaclaw] Missing openclaw.json. Run setup first.");
    return 1;
  }

  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const configuredGroups = Object.keys(cfg.channels?.telegram?.groups || {});
    let groupId = requestedGroupId;
    if (!groupId) {
      if (configuredGroups.length === 1) {
        [groupId] = configuredGroups;
      } else if (configuredGroups.length === 0) {
        console.error(
          "[alphaclaw] No Telegram group configured. Configure Telegram workspace first.",
        );
        return 1;
      } else {
        console.error(
          "[alphaclaw] Multiple Telegram groups detected. Provide --group <groupId>.",
        );
        return 1;
      }
    }

    const topicRegistry = require("../lib/server/topic-registry");
    const {
      syncConfigForTelegram,
    } = require("../lib/server/telegram-workspace");
    const {
      syncBootstrapPromptFiles,
    } = require("../lib/server/onboarding/workspace");
    topicRegistry.updateTopic(groupId, threadId, {
      name: topicName,
      ...(systemInstructions ? { systemInstructions } : {}),
      ...(agentId ? { agentId } : {}),
    });

    const requireMention =
      !!cfg.channels?.telegram?.groups?.[groupId]?.requireMention;
    const syncResult = syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId,
      requireMention,
      resolvedUserId: "",
    });
    syncBootstrapPromptFiles({
      fs,
      workspaceDir: path.join(openclawDir, "workspace"),
    });

    const agentSuffix = agentId ? ` agent=${agentId}` : "";
    console.log(
      `[alphaclaw] Topic mapped: group=${groupId} thread=${threadId} name=${topicName}${agentSuffix}`,
    );
    console.log(
      `[alphaclaw] Concurrency updated: agent=${syncResult.maxConcurrent} subagents=${syncResult.subagentMaxConcurrent} topics=${syncResult.totalTopics}`,
    );
    return 0;
  } catch (e) {
    console.error(`[alphaclaw] telegram topic add failed: ${e.message}`);
    return 1;
  }
};

if (
  command === "telegram" &&
  commandScope === "topic" &&
  commandAction === "add"
) {
  process.exit(runTelegramTopicAdd());
}

const kPort = String(process.env.PORT || "3000").trim();
if (kPort === "18789") {
  console.error(
    [
      "[alphaclaw] Fatal config error: AlphaClaw cannot be started on port 18789.",
      "[alphaclaw] Port 18789 is reserved for the OpenClaw gateway.",
    ].join("\n"),
  );
  process.exit(1);
}

const kSetupPassword = String(process.env.SETUP_PASSWORD || "").trim();
if (!kSetupPassword) {
  console.error(
    [
      "[alphaclaw] Fatal config error: SETUP_PASSWORD is missing or empty.",
      "[alphaclaw] Set SETUP_PASSWORD in your deployment environment variables and restart.",
      "[alphaclaw] Examples:",
      "[alphaclaw] - Render: Dashboard -> Environment -> Add SETUP_PASSWORD",
      "[alphaclaw] - Railway: Project -> Variables -> Add SETUP_PASSWORD",
    ].join("\n"),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 7. Set OpenClaw state paths without replacing the service user's HOME.
// ---------------------------------------------------------------------------

process.env.OPENCLAW_HOME = rootDir;
process.env.CODEX_HOME = resolveManagedCodexHome({ rootDir, env: process.env });
process.env.OPENCLAW_CONFIG_PATH = path.join(openclawDir, "openclaw.json");
process.env.OPENCLAW_STATE_DIR = openclawDir;
process.env.GOG_KEYRING_PASSWORD =
  process.env.GOG_KEYRING_PASSWORD || "alphaclaw";

// ---------------------------------------------------------------------------
// 8. Install gog (Google Workspace CLI) if not present
// ---------------------------------------------------------------------------

process.env.XDG_CONFIG_HOME = openclawDir;

// Resolve the active Google Workspace provider (env override > saved state >
// default "gog"). When gog is not the provider, skip all gog-specific setup so
// deployments using e.g. the Composio CLI never get gog installed or linked.
const resolvedGoogleProvider = (() => {
  try {
    const {
      readGoogleState,
      resolveGoogleProvider,
    } = require("../lib/server/google-state");
    const state = readGoogleState({
      fs,
      statePath: path.join(openclawDir, "gogcli", "state.json"),
    });
    return resolveGoogleProvider({ state }).provider;
  } catch {
    return "gog";
  }
})();

const ensureGogCliCompatConfigPath = () => {
  const configDir = path.join(rootDir, ".config");
  const compatPath = path.join(configDir, "gogcli");
  const managedPath = path.join(openclawDir, "gogcli");

  try {
    fs.mkdirSync(configDir, { recursive: true });
    if (!fs.existsSync(compatPath)) {
      fs.symlinkSync(managedPath, compatPath, "dir");
      console.log(
        `[alphaclaw] Linked gogcli config path ${compatPath} -> ${managedPath}`,
      );
      return;
    }

    const stat = fs.lstatSync(compatPath);
    if (!stat.isSymbolicLink()) return;
    const linkTarget = fs.readlinkSync(compatPath);
    const resolvedTarget = path.resolve(configDir, linkTarget);
    if (resolvedTarget !== managedPath) {
      console.log(
        `[alphaclaw] gogcli config path already exists at ${compatPath}; leaving existing symlink in place`,
      );
    }
  } catch (error) {
    console.log(
      `[alphaclaw] gogcli config path compatibility setup skipped: ${error.message}`,
    );
  }
};

if (resolvedGoogleProvider === "gog") {
  ensureGogCliCompatConfigPath();

  const gogInstalled = (() => {
    try {
      execSync("command -v gog", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!gogInstalled) {
    console.log("[alphaclaw] Installing gog CLI...");
    try {
      const gogVersion = process.env.GOG_VERSION || "0.11.0";
      const platform = os.platform() === "darwin" ? "darwin" : "linux";
      const arch = os.arch() === "arm64" ? "arm64" : "amd64";
      const tarball = `gogcli_${gogVersion}_${platform}_${arch}.tar.gz`;
      const url = `https://github.com/steipete/gogcli/releases/download/v${gogVersion}/${tarball}`;
      execSync(
        `curl -fsSL "${url}" -o /tmp/gog.tar.gz && tar -xzf /tmp/gog.tar.gz -C /tmp/ && mv /tmp/gog /usr/local/bin/gog && chmod +x /usr/local/bin/gog && rm -f /tmp/gog.tar.gz`,
        { stdio: "inherit" },
      );
      console.log("[alphaclaw] gog CLI installed");
    } catch (e) {
      console.log(`[alphaclaw] gog install skipped: ${e.message}`);
    }
  }
} else {
  console.log(
    `[alphaclaw] gog CLI setup skipped (google provider: ${resolvedGoogleProvider})`,
  );
}

// ---------------------------------------------------------------------------
// 8b. Install Composio CLI when it is the active Google provider
// ---------------------------------------------------------------------------

const commandExists = (name) => {
  try {
    execSync(`command -v ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// The Composio installer places the binary at $HOME/.composio/composio; make
// an existing install reachable for this process and all children. The server
// can also install the CLI at runtime (lib/server/composio-install.js) when
// the provider is switched to composio from the dashboard; this boot-time path
// covers fresh provisions where the provider is already composio.
const {
  ensureComposioOnPath: ensureComposioOnPathShared,
} = require("../lib/server/composio-install");
const ensureComposioOnPath = () =>
  ensureComposioOnPathShared({ fs, homedir: rootDir });

ensureComposioOnPath();

if (resolvedGoogleProvider === "composio" && !commandExists("composio")) {
  console.log("[alphaclaw] Installing Composio CLI...");
  try {
    execSync("curl -fsSL https://composio.dev/install | bash", {
      stdio: "inherit",
      timeout: 120000,
    });
    ensureComposioOnPath();
    if (commandExists("composio")) {
      console.log("[alphaclaw] Composio CLI installed");
    } else {
      console.log(
        "[alphaclaw] Composio CLI install finished but binary not found on PATH",
      );
    }
  } catch (e) {
    console.log(`[alphaclaw] Composio CLI install skipped: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 9. Start cron daemon if available
// ---------------------------------------------------------------------------

try {
  execSync("command -v cron", { stdio: "ignore" });
  try {
    execSync("pgrep -x cron", { stdio: "ignore" });
  } catch {
    execSync("cron", { stdio: "ignore" });
  }
  console.log("[alphaclaw] Cron daemon running");
} catch {}

// ---------------------------------------------------------------------------
// 10. Reconcile channels if already onboarded
// ---------------------------------------------------------------------------

const configPath = path.join(openclawDir, "openclaw.json");

if (fs.existsSync(configPath)) {
  console.log("[alphaclaw] Config exists; running startup plugin reconciliation");

  try {
    JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error(`[alphaclaw] openclaw.json is invalid on startup: ${e.message}`);
    const repairResult = runOpenclawDoctorRepairSync({
      env: process.env,
      execSyncImpl: execSync,
      reason: "startup_config_parse_failed",
    });
    if (repairResult.ok) {
      try {
        JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch (retryError) {
        console.error(
          `[alphaclaw] openclaw.json is still invalid after doctor repair: ${retryError.message}`,
        );
      }
    }
  }
  const reconcileExitCode = runReconcileOpenclawPlugins();
  if (reconcileExitCode !== 0) {
    console.error(
      "[alphaclaw] Startup OpenClaw plugin reconciliation failed; continuing so the setup UI can surface recovery options",
    );
    // The server retries this on a backoff once it is up (a restored host's
    // egress proxy may not be usable yet); see
    // lib/server/startup-plugin-reconcile-retry.js.
    process.env.ALPHACLAW_STARTUP_PLUGIN_RECONCILE_FAILED = "1";
  }
} else {
  console.log(
    "[alphaclaw] No config yet -- onboarding will run from the Setup UI",
  );
}

// ---------------------------------------------------------------------------
// 12. Install git auth shim
// ---------------------------------------------------------------------------

try {
  const gitAskPassSrc = path.join(__dirname, "..", "lib", "scripts", "git-askpass");
  const gitAskPassDest = "/tmp/alphaclaw-git-askpass.sh";
  const gitShimTemplatePath = path.join(__dirname, "..", "lib", "scripts", "git");
  const gitShimDest = "/usr/local/bin/git";

  if (fs.existsSync(gitAskPassSrc)) {
    fs.copyFileSync(gitAskPassSrc, gitAskPassDest);
    fs.chmodSync(gitAskPassDest, 0o755);
  }

  if (fs.existsSync(gitShimTemplatePath)) {
    const realGitPath =
      resolveRealGitPath({
        shimPath: gitShimDest,
      }) || "/usr/bin/git";

    const gitShimTemplate = fs.readFileSync(gitShimTemplatePath, "utf8");
    const gitShimContent = gitShimTemplate
      .replace("@@REAL_GIT@@", realGitPath)
      .replace("@@OPENCLAW_REPO_ROOT@@", openclawDir);
    fs.writeFileSync(gitShimDest, gitShimContent, { mode: 0o755 });
    console.log("[alphaclaw] git auth shim installed");
  }
} catch (e) {
  console.log(`[alphaclaw] git auth shim skipped: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 13. Start Express server
// ---------------------------------------------------------------------------

console.log("[alphaclaw] Setup complete -- starting server");
require("../lib/server.js");
