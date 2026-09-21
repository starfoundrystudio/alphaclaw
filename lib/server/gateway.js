const path = require("path");
const { spawn, execFileSync, execSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const { createGatewayLifecycleOwnership } = require("./gateway-lifecycle-ownership");
const lifecycleOwnership = createGatewayLifecycleOwnership();
const {
  ALPHACLAW_DIR,
  OPENCLAW_DIR,
  GATEWAY_HOST,
  kDefaultGatewayPort,
  kChannelDefs,
  kOnboardingMarkerPath,
  kRootDir,
} = require("./constants");
const {
  resolveManagedCodexHome,
  withManagedOpenclawEnv,
  withOpenclawMaintenanceEnv,
} = require("./openclaw-runtime-env");
const {
  readOpenclawConfig,
  writeOpenclawConfig,
} = require("./openclaw-config");
const { isOpenAiCompatApiEnabled } = require("./alphaclaw-config");
const {
  kManagedCapabilityContract,
} = require("./managed-capability-contract");
const {
  buildAgentVaultRuntimeEnv,
  hasAgentVaultRuntime,
  kAgentVaultProxyPort,
  kAgentVaultShimPort,
} = require("./agent-vault/runtime-store");
const { createVaultProxyShim } = require("./agent-vault/proxy-shim");

// Loopback-aware shim between the gateway child and the vault tunnel; see
// lib/server/agent-vault/proxy-shim.js. Started lazily before any gateway
// process is spawned with the shim proxy URL in its env.
let vaultProxyShim = null;
const ensureVaultProxyShimStarted = () => {
  if (!hasAgentVaultRuntime()) return;
  if (vaultProxyShim?.isStarted()) return;
  vaultProxyShim ??= createVaultProxyShim({
    listenPort: kAgentVaultShimPort,
    upstreamPort: kAgentVaultProxyPort,
    logger: console,
  });
  vaultProxyShim.start().catch((error) => {
    console.error(
      `[alphaclaw] Agent Vault proxy shim failed to start: ${error.message}`,
    );
  });
};

let gatewayChild = null;
let gatewayExitHandler = null;
let gatewayLaunchHandler = null;
let gatewayMigrationRetryTimer = null;
let gatewayHandoffRetryTimer = null;
let gatewayRestartPromise = null;
let requestedRestartRevision = 0;
let appliedRestartRevision = 0;
const gatewayStartupState = new WeakMap();
const kGatewayStderrTailLines = 50;
const kPluginRuntimeDepsPreflightTimeoutMs = 120 * 1000;
const kGatewayShortCmdTimeoutMs = 15 * 1000;
const kGatewayRestartReadyTimeoutMs = 120 * 1000;
const kGatewayRestartReadyPollMs = 500;
const kGatewayProbeTimeoutMs = 1000;
const kGatewayDrainTimeoutMs = 30 * 1000;
const kGatewayRestartHandoffProtocol = "openclaw.gateway.restart-handoff";
let gatewayStderrTail = [];
const expectedExitPids = new Set();

const appendStderrTail = (chunk) => {
  const text = Buffer.isBuffer(chunk)
    ? chunk.toString("utf8")
    : String(chunk ?? "");
  for (const line of text.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    gatewayStderrTail.push(trimmed);
  }
  if (gatewayStderrTail.length > kGatewayStderrTailLines) {
    gatewayStderrTail = gatewayStderrTail.slice(-kGatewayStderrTailLines);
  }
};

const setGatewayExitHandler = (handler) => {
  gatewayExitHandler = typeof handler === "function" ? handler : null;
};

const setGatewayLaunchHandler = (handler) => {
  gatewayLaunchHandler = typeof handler === "function" ? handler : null;
};

const gatewayEnv = () =>
  withManagedOpenclawEnv({
    ...process.env,
    ...buildAgentVaultRuntimeEnv(undefined, { viaShim: true }),
    // Keep HOME as the service user's Unix home so external CLIs such as
    // Claude Code can find their own auth stores. OpenClaw state is routed
    // explicitly through OPENCLAW_HOME/OPENCLAW_STATE_DIR below.
    HOME: process.env.HOME || kRootDir,
    OPENCLAW_HOME: kRootDir,
    CODEX_HOME: resolveManagedCodexHome({ rootDir: kRootDir }),
    OPENCLAW_CONFIG_PATH: `${OPENCLAW_DIR}/openclaw.json`,
    OPENCLAW_STATE_DIR: OPENCLAW_DIR,
    XDG_CONFIG_HOME: OPENCLAW_DIR,
  });

const gatewayMaintenanceEnv = () =>
  withOpenclawMaintenanceEnv(gatewayEnv());

// Startup evidence is part of managed process supervision. Keep it visible
// even when an imported config suppresses info logs; preserve debug/trace.
const managedGatewayEnv = () => ({
  ...gatewayEnv(),
  OPENCLAW_LOG_LEVEL: ["debug", "trace"].includes(process.env.OPENCLAW_LOG_LEVEL)
    ? process.env.OPENCLAW_LOG_LEVEL : "info",
});

const resolveOpenclawExtensionsDir = () => {
  try {
    const entryPath = require.resolve("openclaw");
    const entryDir = path.dirname(entryPath);
    const distDir =
      path.basename(entryDir) === "dist" ? entryDir : path.join(entryDir, "dist");
    return path.join(distDir, "extensions");
  } catch {
    return "";
  }
};

const isOpenclawInstallStageDir = (name) =>
  name === ".openclaw-install-stage" ||
  String(name || "").startsWith(".openclaw-install-stage-");

const cleanupOpenclawPluginInstallStages = ({
  extensionsDir = resolveOpenclawExtensionsDir(),
} = {}) => {
  if (!extensionsDir) return 0;
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!entry?.isDirectory?.()) continue;
      const pluginDir = path.join(extensionsDir, entry.name);
      for (const child of fs.readdirSync(pluginDir, { withFileTypes: true })) {
        if (!child?.isDirectory?.() || !isOpenclawInstallStageDir(child.name)) {
          continue;
        }
        const stageDir = path.join(pluginDir, child.name);
        fs.rmSync(stageDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
        removed += 1;
        console.log(`[alphaclaw] Removed stale OpenClaw plugin install stage: ${stageDir}`);
      }
    }
  } catch (err) {
    console.warn(
      `[alphaclaw] Could not clean OpenClaw plugin install stages: ${err.message}`,
    );
  }
  return removed;
};

const hasEnabledChannelConfig = () => {
  try {
    const cfg = readOpenclawConfig({ openclawDir: OPENCLAW_DIR, fallback: {} });
    const channels = cfg?.channels && typeof cfg.channels === "object" ? cfg.channels : {};
    return Object.keys(kChannelDefs).some((channel) => channels?.[channel]?.enabled === true);
  } catch {
    return false;
  }
};

const isInstallStageFailure = (err) =>
  /ENOTEMPTY|openclaw-install-stage/i.test(
    [
      err?.message,
      err?.stdout?.toString?.(),
      err?.stderr?.toString?.(),
    ]
      .filter(Boolean)
      .join("\n"),
  );

const runPluginRuntimeDepsPreflight = () =>
  execSync("openclaw plugins list --json", {
    env: gatewayEnv(),
    timeout: kPluginRuntimeDepsPreflightTimeoutMs,
    encoding: "utf8",
  });

const prepareOpenclawChannelPlugins = () => {
  if (!hasEnabledChannelConfig()) return;
  cleanupOpenclawPluginInstallStages();
  try {
    runPluginRuntimeDepsPreflight();
  } catch (err) {
    if (!isInstallStageFailure(err)) {
      console.warn(
        `[alphaclaw] OpenClaw plugin preflight failed: ${(err.stderr || err.message || "").toString().trim().slice(0, 300)}`,
      );
      return;
    }
    cleanupOpenclawPluginInstallStages();
    try {
      runPluginRuntimeDepsPreflight();
      console.log("[alphaclaw] OpenClaw plugin preflight recovered after cleaning install stage");
    } catch (retryErr) {
      console.warn(
        `[alphaclaw] OpenClaw plugin preflight retry failed: ${(retryErr.stderr || retryErr.message || "").toString().trim().slice(0, 300)}`,
      );
    }
  }
};

const writeOnboardingMarker = (reason) => {
  fs.mkdirSync(ALPHACLAW_DIR, { recursive: true });
  fs.writeFileSync(
    kOnboardingMarkerPath,
    JSON.stringify(
      {
        onboarded: true,
        reason,
        markedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
};

// Legacy backfill: older deployments may only have the control-ui skill as
// proof of onboarding (before the dedicated marker file existed).
const kLegacyControlUiSkillPath = path.join(OPENCLAW_DIR, "skills", "control-ui", "SKILL.md");

const isOnboarded = () => {
  if (fs.existsSync(kOnboardingMarkerPath)) return true;
  if (fs.existsSync(kLegacyControlUiSkillPath)) {
    writeOnboardingMarker("legacy_artifact_backfill");
    return true;
  }
  return false;
};

const getGatewayPort = () => {
  try {
    const cfg = readOpenclawConfig({ openclawDir: OPENCLAW_DIR, fallback: {} });
    const parsedPort = Number.parseInt(String(cfg?.gateway?.port || ""), 10);
    return parsedPort > 0 ? parsedPort : kDefaultGatewayPort;
  } catch {
    return kDefaultGatewayPort;
  }
};

const getGatewayUrl = () => `http://${GATEWAY_HOST}:${getGatewayPort()}`;

const normalizeChannelAccountId = (value) => String(value || "").trim() || "default";

const isGatewayRunning = () =>
  new Promise((resolve) => {
    const sock = net.createConnection(getGatewayPort(), GATEWAY_HOST);
    sock.setTimeout(1000);
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const probeGatewayEndpoint = (pathname, { timeoutMs = kGatewayProbeTimeoutMs } = {}) =>
  new Promise((resolve) => {
    const request = http.request(
      {
        host: GATEWAY_HOST,
        port: getGatewayPort(),
        path: pathname,
        method: "GET",
        headers: { Accept: "application/json" },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw = (raw + chunk).slice(-8192);
        });
        response.on("end", () => {
          let body = null;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {}
          resolve({
            ok: response.statusCode === 200,
            statusCode: response.statusCode || 0,
            body,
          });
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy());
    request.on("error", () => resolve({ ok: false, statusCode: 0, body: null }));
    request.end();
  });

const probeGatewayStartupAndReadiness = async ({
  probeEndpoint = probeGatewayEndpoint,
} = {}) => {
  const startup = await probeEndpoint("/startupz");
  if (!startup.ok || startup.body?.status !== "started") {
    return {
      ready: false,
      probeSupported: startup.statusCode !== 0 && startup.statusCode !== 404,
    };
  }
  const readiness = await probeEndpoint("/readyz");
  return {
    ready: readiness.ok && readiness.body?.ready !== false,
    probeSupported: readiness.statusCode !== 0 && readiness.statusCode !== 404,
  };
};

const defaultGatewayReadinessProbe = process.env.VITEST
  ? async () => ({ ready: false, probeSupported: false })
  : probeGatewayStartupAndReadiness;

const waitForGatewayReady = async ({
  timeoutMs = kGatewayRestartReadyTimeoutMs,
  isAlive = () => true,
  hasReadyEvidence = () => true,
  probeReadiness = defaultGatewayReadinessProbe,
} = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const listening = await isGatewayRunning();
    if (listening && isAlive()) {
      const probe = await probeReadiness();
      if (probe?.ready) return true;
      // A process-correlated ready log remains the bounded fallback for older
      // OpenClaw releases and for probes blocked by local HTTP policy.
      if (probe?.probeSupported === false && hasReadyEvidence()) return true;
    }
    if (!isAlive()) return false;
    await sleep(kGatewayRestartReadyPollMs);
  }
  return false;
};

const logGatewayCmdOutput = (cmd, e) => {
  if (e?.stdout?.trim()) {
    console.log(`[alphaclaw] gateway ${cmd} stdout: ${e.stdout.trim()}`);
  }
  if (e?.stderr?.trim()) {
    console.log(`[alphaclaw] gateway ${cmd} stderr: ${e.stderr.trim()}`);
  }
  if (!e?.stdout?.trim() && !e?.stderr?.trim()) {
    console.log(`[alphaclaw] gateway ${cmd} error: ${e.message}`);
  }
  if (e?.status !== undefined && e?.status !== null) {
    console.log(`[alphaclaw] gateway ${cmd} exit code: ${e.status}`);
  }
};

const runGatewayShortCmd = (cmd) => {
  try {
    const out = execSync(`openclaw gateway ${cmd}`, {
      env: gatewayEnv(),
      timeout: kGatewayShortCmdTimeoutMs,
      encoding: "utf8",
    });
    if (out.trim()) console.log(`[alphaclaw] ${out.trim()}`);
  } catch (e) {
    logGatewayCmdOutput(cmd, e);
  }
};

const hasActiveManagedGatewayChild = () =>
  !!(
    gatewayChild &&
    gatewayChild.exitCode === null &&
    !gatewayChild.killed
  );

// OpenClaw (2026.7.1 through the pinned 2026.9.x) reports readiness from the
// replacement process itself.
// A shared listening port may still belong to the outgoing gateway.
const hasGatewayReadyLog = (text) =>
  String(text).includes("http server listening (") ||
  /(?:^|\])\s*listening on wss?:\/\//m.test(String(text));

const isGatewayLifecycleBusy = () => {
  if (gatewayRestartPromise || gatewayMigrationRetryTimer || lifecycleOwnership.isBusy()) return true;
  const startup = gatewayChild && gatewayStartupState.get(gatewayChild);
  return !!(hasActiveManagedGatewayChild() && startup && !startup.ready &&
    Date.now() < startup.startedAtMs + kGatewayRestartReadyTimeoutMs);
};

const tryAcquireGatewayRepair = () =>
  isGatewayLifecycleBusy() ? null : lifecycleOwnership.tryAcquire("doctor");

// A gateway process killed mid-startup-migrations (e.g. the host
// finalization restart on a fresh instance) leaves openclaw's migration lock
// held for its full TTL; retries during that window all print this message
// and exit. Parse the lock's own retry-after timestamp so the supervisor can
// outwait it instead of giving up at the fixed readiness timeout — observed
// stranding the first beta-channel provision on 2026-08-26.
const parseMigrationLockRetryAfterMs = (text) => {
  const match = String(text || "").match(
    /startup migrations are already running[\s\S]*?after (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/,
  );
  if (!match) return null;
  const ts = Date.parse(match[1]);
  return Number.isFinite(ts) ? ts : null;
};

const kMigrationLockMaxWaitMs = 6 * 60 * 1000;
const kMigrationLockRetryGraceMs = 3000;

const getMigrationLockRetryDelayMs = (
  text,
  {
    nowMs = Date.now(),
    maxWaitMs = kMigrationLockMaxWaitMs,
    graceMs = kMigrationLockRetryGraceMs,
  } = {},
) => {
  const retryAfterMs = parseMigrationLockRetryAfterMs(text);
  if (retryAfterMs === null) return null;
  const waitMs = retryAfterMs - Number(nowMs);
  if (!Number.isFinite(waitMs) || waitMs >= Number(maxWaitMs)) return null;
  return Math.max(waitMs, 0) + Math.max(0, Number(graceMs) || 0);
};

const clearGatewayMigrationRetry = () => {
  if (!gatewayMigrationRetryTimer) return;
  clearTimeout(gatewayMigrationRetryTimer);
  gatewayMigrationRetryTimer = null;
};

const scheduleGatewayHandoffRelaunch = () => {
  if (gatewayHandoffRetryTimer) return;
  const attempt = () => {
    gatewayHandoffRetryTimer = null;
    if (hasActiveManagedGatewayChild()) return;
    if (gatewayRestartPromise || lifecycleOwnership.isBusy()) {
      gatewayHandoffRetryTimer = setTimeout(attempt, 100);
      gatewayHandoffRetryTimer.unref?.();
      return;
    }
    launchGatewayProcess();
  };
  gatewayHandoffRetryTimer = setTimeout(attempt, 0);
  gatewayHandoffRetryTimer.unref?.();
};

const parseMachineJson = (raw) => {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
};

const consumeGatewayRestartHandoff = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const raw = execFileSync(
      "openclaw",
      [
        "gateway",
        "restart-handoff",
        "consume",
        "--expected-pid",
        String(pid),
        "--json",
      ],
      {
        env: gatewayEnv(),
        timeout: kGatewayShortCmdTimeoutMs,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const payload = parseMachineJson(raw);
    if (
      payload?.ok === true &&
      payload.protocol === kGatewayRestartHandoffProtocol &&
      payload.protocolVersion === 1 &&
      payload.status === "accepted"
    ) {
      return payload.handoff || {};
    }
    return null;
  } catch (error) {
    console.warn(
      `[alphaclaw] Could not consume OpenClaw restart handoff for pid ${pid}: ${String(error?.stderr || error?.message || error).trim().slice(0, 300)}`,
    );
    return null;
  }
};

const runGatewayRestartCmd = async (cmd, { retriedForMigrationLock = false } = {}) => {
  ensureVaultProxyShimStarted();
  prepareOpenclawChannelPlugins();
  const startedAt = Date.now();
  let combinedOutputTail = "";
  let announcedReady = false;
  const appendCombinedTail = (chunk) => {
    combinedOutputTail = (combinedOutputTail + chunk).slice(-8192);
    if (hasGatewayReadyLog(combinedOutputTail)) announcedReady = true;
  };
  const child = spawn("openclaw", ["gateway", cmd], {
    env: managedGatewayEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  gatewayChild = child;
  gatewayStartupState.set(child, { startedAtMs: Date.now(), ready: false });
  appliedRestartRevision = requestedRestartRevision;
  let exited = false;
  child.stdout.on("data", (d) => {
    appendCombinedTail(d);
    process.stdout.write(`[gateway] ${d}`);
  });
  child.stderr.on("data", (d) => {
    appendStderrTail(d);
    appendCombinedTail(d);
    process.stderr.write(`[gateway] ${d}`);
  });
  child.on("exit", (code, signal) => {
    exited = true;
    const isCurrentChild = gatewayChild === child;
    if (isCurrentChild) gatewayChild = null;
    const expectedExit = expectedExitPids.delete(child.pid);
    const restartHandoff =
      !expectedExit && isCurrentChild && code === 0
        ? consumeGatewayRestartHandoff(child.pid)
        : null;
    const retryDelay = !retriedForMigrationLock
      ? getMigrationLockRetryDelayMs(combinedOutputTail) : null;
    console.log(
      `[alphaclaw] gateway ${cmd} supervisor exited: code=${code ?? "null"}${signal ? ` signal=${signal}` : ""}`,
    );
    gatewayExitHandler?.({
      code, signal,
      expectedExit: expectedExit || retryDelay !== null || !!restartHandoff,
      startupConfigRefusal: code === 78 && retryDelay === null,
      ...(expectedExit || retryDelay !== null || restartHandoff ? {
        expectedExitReason: restartHandoff
          ? "restart_handoff"
          : retryDelay !== null
            ? "migration_retry"
            : "managed_restart",
        recoveryWindowMs: (retryDelay || 0) + kGatewayRestartReadyTimeoutMs,
      } : {}),
      stderrTail: gatewayStderrTail.slice(-kGatewayStderrTailLines),
    });
    if (restartHandoff) scheduleGatewayHandoffRelaunch();
  });

  const ready = await waitForGatewayReady({ isAlive: () => !exited, hasReadyEvidence: () => announcedReady });
  if (ready) {
    console.log(
      `[alphaclaw] Gateway ${cmd} ready (${Date.now() - startedAt}ms); leaving supervisor running`,
    );
    gatewayStartupState.get(child).ready = true;
    clearGatewayMigrationRetry();
    await notifyGatewayLaunch();
    return;
  }

  console.warn(
    `[alphaclaw] Gateway ${cmd} did not become ready within ${kGatewayRestartReadyTimeoutMs}ms; stopping`,
  );
  try {
    if (!exited) {
      expectedExitPids.add(child.pid);
      child.kill("SIGTERM");
    }
  } catch {
    // ignore
  }

  if (!retriedForMigrationLock) {
    const delayMs = getMigrationLockRetryDelayMs(combinedOutputTail);
    if (delayMs !== null) {
      console.warn(
        `[alphaclaw] Gateway start blocked by a stale startup-migrations lock; retrying in ${Math.round(delayMs / 1000)}s`,
      );
      await sleep(delayMs);
      return runGatewayRestartCmd(cmd, { retriedForMigrationLock: true });
    }
  }
  throw new Error("OpenClaw gateway did not become ready after restart");
};

// All cold restarts share one owner through startup and migration backoff.
// Vault enrollment, UI actions and watchdog recovery cannot spawn competitors.
const runGatewayColdStart = () => {
  requestedRestartRevision += 1;
  if (!gatewayRestartPromise) {
    gatewayRestartPromise = (async () => {
      const ownership = await lifecycleOwnership.acquire("restart");
      try {
      do {
        const startup = gatewayChild && gatewayStartupState.get(gatewayChild);
        if (hasActiveManagedGatewayChild() && startup && !startup.ready && !(await isGatewayRunning())) {
          const remainingMs = Math.max(0, startup.startedAtMs + kGatewayRestartReadyTimeoutMs - Date.now());
          if (remainingMs > 0) {
            console.log("[alphaclaw] Waiting for the current gateway startup before restart");
            await waitForGatewayReady({ timeoutMs: remainingMs, isAlive: hasActiveManagedGatewayChild });
          }
        }
        // Protection is bounded by the original spawn time. A previously
        // ready or genuinely hung child must remain replaceable.
        if (hasActiveManagedGatewayChild()) {
          await stopManagedGatewayChild();
        }
        await runGatewayRestartCmd("--force");
        // A newer request is satisfied by a backoff retry only if that retry
        // spawned after the change. Otherwise apply it with a serial restart.
      } while (appliedRestartRevision !== requestedRestartRevision);
      } finally { ownership.release(); }
    })().finally(() => { gatewayRestartPromise = null; });
  }
  return gatewayRestartPromise;
};

const runGatewayCmd = async (cmd) => {
  console.log(`[alphaclaw] Running: openclaw gateway ${cmd}`);
  if (cmd === "--force") {
    await runGatewayColdStart();
    return;
  }
  runGatewayShortCmd(cmd);
};

const launchGatewayProcess = ({ retriedForMigrationLock = false, lifecycleOwner = null } = {}) => {
  if ((gatewayRestartPromise || lifecycleOwnership.isBusy()) && !lifecycleOwnership.isOwner(lifecycleOwner)) {
    console.log("[alphaclaw] Gateway restart already owns startup — skipping launch");
    return null;
  }
  if (gatewayChild && gatewayChild.exitCode === null && !gatewayChild.killed) {
    console.log(
      "[alphaclaw] Managed gateway process already running — skipping launch",
    );
    return gatewayChild;
  }
  if (gatewayMigrationRetryTimer) {
    console.log(
      "[alphaclaw] Gateway migration-lock retry already scheduled — skipping launch",
    );
    return null;
  }
  ensureVaultProxyShimStarted();
  prepareOpenclawChannelPlugins();
  gatewayStderrTail = [];
  let combinedOutputTail = "";
  const appendCombinedTail = (chunk) => {
    combinedOutputTail = (combinedOutputTail + chunk).slice(-8192);
  };
  const child = spawn("openclaw", ["gateway", "run"], {
    env: managedGatewayEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  gatewayChild = child;
  gatewayStartupState.set(child, { startedAtMs: Date.now(), ready: false });
  let didSignalGatewayReady = false;
  child.stdout.on("data", (d) => {
    const text = Buffer.isBuffer(d) ? d.toString("utf8") : String(d ?? "");
    appendCombinedTail(text);
    if (
      !didSignalGatewayReady &&
      hasGatewayReadyLog(combinedOutputTail)
    ) {
      didSignalGatewayReady = true;
      gatewayStartupState.get(child).ready = true;
      try {
        gatewayLaunchHandler?.({
          pid: child.pid,
          startedAt: Date.now(),
        });
      } catch (err) {
        console.error(`[alphaclaw] Gateway launch handler error: ${err.message}`);
      }
    }
    process.stdout.write(`[gateway] ${d}`);
  });
  child.stderr.on("data", (d) => {
    appendStderrTail(d);
    appendCombinedTail(d);
    if (!didSignalGatewayReady && hasGatewayReadyLog(combinedOutputTail)) {
      didSignalGatewayReady = true;
      gatewayStartupState.get(child).ready = true;
      try { gatewayLaunchHandler?.({ pid: child.pid, startedAt: Date.now() }); }
      catch (error) { console.error(`[alphaclaw] Gateway launch handler error: ${error.message}`); }
    }
    process.stderr.write(`[gateway] ${d}`);
  });
  child.on("exit", (code, signal) => {
    const expectedExit = expectedExitPids.has(child.pid);
    expectedExitPids.delete(child.pid);
    const isCurrentChild = gatewayChild === child;
    if (isCurrentChild) gatewayChild = null;
    const restartHandoff =
      !expectedExit && isCurrentChild && code === 0
        ? consumeGatewayRestartHandoff(child.pid)
        : null;
    let migrationRetryScheduled = false;
    let migrationRetryDelayMs = 0;
    if (!expectedExit && isCurrentChild && !retriedForMigrationLock) {
      const delayMs = getMigrationLockRetryDelayMs(combinedOutputTail);
      if (delayMs !== null) {
        migrationRetryScheduled = true;
        migrationRetryDelayMs = delayMs;
        console.warn(
          `[alphaclaw] Initial gateway start blocked by a stale startup-migrations lock; retrying in ${Math.round(delayMs / 1000)}s`,
        );
        gatewayMigrationRetryTimer = setTimeout(async () => {
          gatewayMigrationRetryTimer = null;
          if (gatewayRestartPromise || hasActiveManagedGatewayChild() || await isGatewayRunning()) return;
          console.log(
            "[alphaclaw] Retrying initial gateway start after startup-migrations lock expiry",
          );
          launchGatewayProcess({ retriedForMigrationLock: true });
        }, delayMs);
        gatewayMigrationRetryTimer.unref?.();
      }
    }
    console.log(
      `[alphaclaw] Gateway launcher exited with code ${code}${signal ? ` signal ${signal}` : ""}`,
    );
    if (restartHandoff) {
      console.log(
        `[alphaclaw] Consumed OpenClaw restart handoff for pid ${child.pid}; relaunching managed Gateway`,
      );
    }
    if (gatewayExitHandler) {
      try {
        gatewayExitHandler({
          code,
          signal,
          expectedExit: expectedExit || migrationRetryScheduled || !!restartHandoff,
          startupConfigRefusal: code === 78 && !migrationRetryScheduled,
          // Tell the watchdog which controller owns recovery, including its
          // deadline. A migration lease exits nonzero but needs no doctor run.
          ...(expectedExit || migrationRetryScheduled || restartHandoff ? {
            expectedExitReason: restartHandoff
              ? "restart_handoff"
              : migrationRetryScheduled
                ? "migration_retry"
                : "managed_restart",
            recoveryWindowMs: migrationRetryDelayMs + kGatewayRestartReadyTimeoutMs,
          } : {}),
          stderrTail: gatewayStderrTail.slice(-kGatewayStderrTailLines),
        });
      } catch (err) {
        console.error(`[alphaclaw] Gateway exit handler error: ${err.message}`);
      }
    }
    if (restartHandoff) scheduleGatewayHandoffRelaunch();
  });
  return child;
};

const markManagedGatewayExitExpected = () => {
  if (
    !gatewayChild ||
    gatewayChild.exitCode !== null ||
    gatewayChild.killed ||
    !gatewayChild.pid
  ) {
    return false;
  }
  expectedExitPids.add(gatewayChild.pid);
  return true;
};

const notifyGatewayLaunch = async () => {
  if (!gatewayLaunchHandler) return;
  if (!(await isGatewayRunning())) return;
  const pid =
    gatewayChild &&
    gatewayChild.exitCode === null &&
    !gatewayChild.killed &&
    gatewayChild.pid
      ? gatewayChild.pid
      : null;
  try {
    gatewayLaunchHandler({ startedAt: Date.now(), pid });
  } catch (err) {
    console.error(`[alphaclaw] Gateway launch handler error: ${err.message}`);
  }
};

const startGateway = async () => {
  if (gatewayRestartPromise) return gatewayRestartPromise;
  if (!isOnboarded()) {
    console.log("[alphaclaw] Not onboarded yet — skipping gateway start");
    return;
  }
  if (await isGatewayRunning()) {
    console.log("[alphaclaw] Gateway already running — skipping start");
    await notifyGatewayLaunch();
    return;
  }
  console.log("[alphaclaw] Starting openclaw gateway...");
  launchGatewayProcess();
};

const stopManagedGatewayChild = async ({
  drainTimeoutMs = kGatewayDrainTimeoutMs,
} = {}) => {
  clearGatewayMigrationRetry();
  markManagedGatewayExitExpected();
  const child = gatewayChild;
  if (!child || child.exitCode !== null || child.killed) {
    return false;
  }
  // Minimal test doubles and older child-process wrappers may not expose
  // EventEmitter.once. They still receive SIGTERM, but cannot be awaited.
  if (typeof child.once !== "function") {
    try { child.kill("SIGTERM"); } catch {}
    if (gatewayChild === child) gatewayChild = null;
    return true;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    child.once("exit", finish);
    const forceTimer = setTimeout(() => {
      console.warn(
        `[alphaclaw] Gateway pid ${child.pid} exceeded the ${drainTimeoutMs}ms drain window; forcing stop`,
      );
      try { child.kill("SIGKILL"); } catch {}
      finish();
    }, drainTimeoutMs);
    forceTimer.unref?.();
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
    }
  });
  if (gatewayChild === child) gatewayChild = null;
  return true;
};

const restartGateway = async (reloadEnv) => {
  reloadEnv();
  await runGatewayColdStart();
};

const restartGatewayLight = async (reloadEnv) => {
  reloadEnv();
  await runGatewayColdStart();
};

// OpenClaw 2026.9 hands CLI plugin installs to a running Gateway, and our
// Gateway refuses them under OPENCLAW_CONFIG_READONLY=1. Plugin maintenance
// that has to run while the server is up therefore stops the managed Gateway,
// runs the work with lifecycle ownership held (so the watchdog does not
// restart it), and then starts it again through `restart`, which also loads
// any newly installed plugins. The Gateway restarts even when the work fails.
const runWithGatewayStopped = async (work, { restart } = {}) => {
  const ownership = await lifecycleOwnership.acquire("plugin-maintenance");
  let result;
  let failure = null;
  try {
    await stopManagedGatewayChild();
    result = await work();
  } catch (error) {
    failure = error;
  } finally {
    ownership.release();
  }
  if (typeof restart === "function") {
    try {
      await restart();
    } catch (error) {
      console.error(
        `[alphaclaw] Gateway restart after plugin maintenance failed: ${error.message}`,
      );
    }
  }
  if (failure) throw failure;
  return result;
};

const createGatewaySignalHandler = ({
  stopManagedChild = stopManagedGatewayChild,
  exitProcess = (code) => process.exit(code),
} = {}) => {
  let handled = false;
  return async () => {
    if (handled) return;
    handled = true;
    try {
      await stopManagedChild();
    } finally {
      exitProcess(0);
    }
  };
};

const attachGatewaySignalHandlers = ({
  processModule = process,
  exitProcess = (code) => process.exit(code),
} = {}) => {
  const handleSignal = createGatewaySignalHandler({ exitProcess });
  processModule.once("SIGTERM", handleSignal);
  processModule.once("SIGINT", handleSignal);
};

const ensureGatewayProxyConfig = (origin) => {
  if (!isOnboarded()) return false;
  try {
    const cfg = readOpenclawConfig({
      fsModule: fs,
      openclawDir: OPENCLAW_DIR,
    });
    if (!cfg.gateway || typeof cfg.gateway !== "object") cfg.gateway = {};
    if (!String(cfg.gateway.mode || "").trim()) {
      console.warn(
        "[alphaclaw] Skipping gateway proxy config update; gateway.mode is missing. Run alphaclaw openclaw-doctor-guard -- openclaw doctor --non-interactive --fix.",
      );
      return false;
    }
    let changed = false;

    const managedControlUi =
      kManagedCapabilityContract.surfaces.controlUi;
    if (cfg.gateway.bind !== "loopback") {
      cfg.gateway.bind = "loopback";
      console.log("[alphaclaw] Restricted direct Gateway exposure to loopback");
      changed = true;
    }
    if (!cfg.gateway.controlUi || typeof cfg.gateway.controlUi !== "object") {
      cfg.gateway.controlUi = {};
    }
    if (cfg.gateway.controlUi.basePath !== managedControlUi.basePath) {
      cfg.gateway.controlUi.basePath = managedControlUi.basePath;
      console.log(
        `[alphaclaw] Set managed Control UI base path: ${managedControlUi.basePath}`,
      );
      changed = true;
    }

    if (isOpenAiCompatApiEnabled({ fsModule: fs, openclawDir: OPENCLAW_DIR })) {
      if (!cfg.gateway.http) cfg.gateway.http = {};
      if (!cfg.gateway.http.endpoints) cfg.gateway.http.endpoints = {};

      const chatCompletions = cfg.gateway.http.endpoints.chatCompletions || {};
      if (chatCompletions.enabled !== true) {
        cfg.gateway.http.endpoints.chatCompletions = {
          ...chatCompletions,
          enabled: true,
        };
        console.log("[alphaclaw] Enabled gateway OpenAI chat completions endpoint");
        changed = true;
      }

      const responses = cfg.gateway.http.endpoints.responses || {};
      if (responses.enabled !== true) {
        cfg.gateway.http.endpoints.responses = {
          ...responses,
          enabled: true,
        };
        console.log("[alphaclaw] Enabled gateway OpenResponses endpoint");
        changed = true;
      }
    }

    if (!Array.isArray(cfg.gateway.trustedProxies)) {
      cfg.gateway.trustedProxies = [];
    }
    if (!cfg.gateway.trustedProxies.includes("127.0.0.1")) {
      cfg.gateway.trustedProxies.push("127.0.0.1");
      console.log("[alphaclaw] Added 127.0.0.1 to gateway.trustedProxies");
      changed = true;
    }

    if (origin) {
      if (!Array.isArray(cfg.gateway.controlUi.allowedOrigins)) {
        cfg.gateway.controlUi.allowedOrigins = [];
      }
      if (!cfg.gateway.controlUi.allowedOrigins.includes(origin)) {
        cfg.gateway.controlUi.allowedOrigins.push(origin);
        console.log(`[alphaclaw] Added dashboard origin: ${origin}`);
        changed = true;
      }
    }

    // Managed remote MCP server entry. Env-driven so any Clawbridge operator
    // (clawctl-managed host or plain VPS) can wire OpenClaw to a remote MCP
    // server without hand-editing /data/.openclaw/openclaw.json.
    //
    //   REMOTE_MCP_URL         upstream MCP endpoint (streamable-http).
    //   REMOTE_MCP_API_TOKEN   Bearer token the remote MCP expects. Persisted
    //                          as the ${REMOTE_MCP_API_TOKEN} reference, not
    //                          raw, so the openclaw.json that gets
    //                          git-committed never holds the plaintext.
    //   REMOTE_MCP_NAME        Key under mcp.servers.<name>. Default "remote".
    //   REMOTE_MCP_PROXY_URL   When set, OpenClaw connects here instead of
    //                          REMOTE_MCP_URL. Intended for a same-host
    //                          scanning proxy (e.g. `pipelock mcp proxy
    //                          --listen ... --upstream <REMOTE_MCP_URL>`),
    //                          but the implementation is proxy-agnostic.
    //                          The supervisor that starts that proxy is
    //                          responsible for unsetting this env var when
    //                          the proxy is not running, so Clawbridge never
    //                          points OpenClaw at a dead listener.
    const remoteMcpUrl = String(process.env.REMOTE_MCP_URL || "").trim();
    const remoteMcpToken = String(
      process.env.REMOTE_MCP_API_TOKEN || "",
    ).trim();
    const remoteMcpProxyUrl = String(
      process.env.REMOTE_MCP_PROXY_URL || "",
    ).trim();
    const remoteMcpNameRaw = String(process.env.REMOTE_MCP_NAME || "").trim();
    // Constrain the managed key. OpenClaw sanitizes names later for tool
    // prefixes, but the config-key itself must be safe to use as an object
    // key and to read back in `openclaw mcp` CLI commands. Reject names
    // with prototype-pollution shapes, spaces, or path-like names; fall
    // back to "remote" with a warning so a typo doesn't silently misroute.
    const kRemoteMcpNamePattern = /^[A-Za-z0-9_-]{1,64}$/;
    const kReservedRemoteMcpNames = new Set([
      "__proto__",
      "constructor",
      "prototype",
    ]);
    let remoteMcpName = "remote";
    if (remoteMcpNameRaw) {
      if (
        kRemoteMcpNamePattern.test(remoteMcpNameRaw) &&
        !kReservedRemoteMcpNames.has(remoteMcpNameRaw)
      ) {
        remoteMcpName = remoteMcpNameRaw;
      } else {
        console.warn(
          `[alphaclaw] REMOTE_MCP_NAME=${JSON.stringify(remoteMcpNameRaw)} is invalid (must match ${kRemoteMcpNamePattern} and not be a reserved key); falling back to "remote"`,
        );
      }
    }
    const placeholderAuth = "Bearer ${REMOTE_MCP_API_TOKEN}";
    const desiredAuth = `Bearer ${remoteMcpToken}`;
    const kManagedMarker = "_alphaclawManaged";
    let mcpChanged = false;

    // Clean up any managed entries left over from a prior REMOTE_MCP_NAME
    // value. Without this, renaming REMOTE_MCP_NAME from "sure" to "notion"
    // would leave the old "sure" entry behind, duplicating MCP tools or
    // routing callbacks to a stale target. The marker scopes the cleanup so
    // user-managed entries (no marker) are never touched.
    if (cfg.mcp?.servers) {
      for (const [key, entry] of Object.entries(cfg.mcp.servers)) {
        if (
          entry &&
          typeof entry === "object" &&
          entry[kManagedMarker] === true &&
          key !== remoteMcpName
        ) {
          delete cfg.mcp.servers[key];
          mcpChanged = true;
          console.log(
            `[alphaclaw] Removed stale managed MCP server "${key}" (REMOTE_MCP_NAME is now "${remoteMcpName}")`,
          );
        }
      }
    }

    if (remoteMcpUrl && remoteMcpToken) {
      if (!cfg.mcp) cfg.mcp = {};
      if (!cfg.mcp.servers) cfg.mcp.servers = {};
      const existing = cfg.mcp.servers[remoteMcpName] || {};
      const effectiveUrl = remoteMcpProxyUrl || remoteMcpUrl;
      const existingHeaders = existing.headers || {};
      const existingAuth = existingHeaders.Authorization;
      // Only the placeholder counts as "already sanitized". A plaintext
      // Bearer (even one that matches the current desiredAuth) must trigger a
      // rewrite so the substitution loop below scrubs it back to the
      // ${REMOTE_MCP_API_TOKEN} reference.
      const authIsPlaceholder = existingAuth === placeholderAuth;
      const hasManagedMarker = existing[kManagedMarker] === true;
      if (
        existing.url !== effectiveUrl ||
        existing.transport !== "streamable-http" ||
        !authIsPlaceholder ||
        !hasManagedMarker
      ) {
        cfg.mcp.servers[remoteMcpName] = {
          ...existing,
          url: effectiveUrl,
          transport: "streamable-http",
          headers: {
            ...existingHeaders,
            Authorization: desiredAuth,
          },
          [kManagedMarker]: true,
        };
        mcpChanged = true;
        console.log(
          `[alphaclaw] Configured remote MCP server "${remoteMcpName}" (url=${effectiveUrl}, via_proxy=${Boolean(remoteMcpProxyUrl)})`,
        );
      }
    } else if (
      cfg.mcp?.servers?.[remoteMcpName] &&
      cfg.mcp.servers[remoteMcpName][kManagedMarker] === true
    ) {
      delete cfg.mcp.servers[remoteMcpName];
      mcpChanged = true;
      console.log(
        `[alphaclaw] Removed remote MCP server "${remoteMcpName}" entry (REMOTE_MCP_URL / REMOTE_MCP_API_TOKEN unset)`,
      );
    }
    if (cfg.mcp?.servers && Object.keys(cfg.mcp.servers).length === 0) {
      delete cfg.mcp.servers;
    }
    if (cfg.mcp && Object.keys(cfg.mcp).length === 0) {
      delete cfg.mcp;
    }
    if (mcpChanged) changed = true;

    if (changed) {
      if (remoteMcpToken && cfg.mcp?.servers) {
        for (const server of Object.values(cfg.mcp.servers)) {
          if (server?.headers?.Authorization === desiredAuth) {
            server.headers.Authorization = placeholderAuth;
          }
        }
      }
      writeOpenclawConfig({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
        config: cfg,
        spacing: 2,
      });
    }
    return changed;
  } catch (e) {
    console.error(`[alphaclaw] ensureGatewayProxyConfig error: ${e.message}`);
    return false;
  }
};

const syncChannelConfig = (savedVars, mode = "all") => {
  try {
    const cfg = readOpenclawConfig({ openclawDir: OPENCLAW_DIR, fallback: {} });
    const savedMap = Object.fromEntries(
      savedVars.filter((v) => v.value).map((v) => [v.key, v.value]),
    );
    const env = gatewayMaintenanceEnv();

    for (const [ch, def] of Object.entries(kChannelDefs)) {
      const token = savedMap[def.envKey];
      const isConfigured = cfg.channels?.[ch]?.enabled;

      if (token && !isConfigured && (mode === "add" || mode === "all")) {
        console.log(`[alphaclaw] Adding channel: ${ch}`);
        try {
          if (ch === "slack") {
            const appToken = savedMap[def.extraEnvKeys?.[0]];
            if (!appToken) continue;
            execSync(
              `openclaw channels add --channel slack --bot-token "${token}" --app-token "${appToken}"`,
              { env, timeout: 15000, encoding: "utf8" },
            );
            const addedConfig = readOpenclawConfig({ openclawDir: OPENCLAW_DIR });
            let raw = JSON.stringify(addedConfig);
            if (raw.includes(token)) {
              raw = raw.split(token).join("${" + def.envKey + "}");
            }
            if (raw.includes(appToken)) {
              raw = raw.split(appToken).join("${" + def.extraEnvKeys[0] + "}");
            }
            writeOpenclawConfig({
              fsModule: fs,
              openclawDir: OPENCLAW_DIR,
              config: JSON.parse(raw),
            });
          } else {
            execSync(`openclaw channels add --channel ${ch} --token "${token}"`, {
              env,
              timeout: 15000,
              encoding: "utf8",
            });
            const addedConfig = readOpenclawConfig({ openclawDir: OPENCLAW_DIR });
            const raw = JSON.stringify(addedConfig);
            if (raw.includes(token)) {
              writeOpenclawConfig({
                fsModule: fs,
                openclawDir: OPENCLAW_DIR,
                config: JSON.parse(
                  raw.split(token).join("${" + def.envKey + "}"),
                ),
              });
            }
          }
          console.log(`[alphaclaw] Channel ${ch} added`);
        } catch (e) {
          console.error(
            `[alphaclaw] channels add ${ch}: ${(e.stderr || e.message || "").toString().trim().slice(0, 200)}`,
          );
        }
      } else if (
        !token &&
        isConfigured &&
        (mode === "remove" || mode === "all")
      ) {
        console.log(`[alphaclaw] Removing channel: ${ch}`);
        try {
          execSync(`openclaw channels remove --channel ${ch} --delete`, {
            env,
            timeout: 15000,
            encoding: "utf8",
          });
          console.log(`[alphaclaw] Channel ${ch} removed`);
        } catch (e) {
          console.error(
            `[alphaclaw] channels remove ${ch}: ${(e.stderr || e.message || "").toString().trim().slice(0, 200)}`,
          );
        }
      }
    }
  } catch (e) {
    console.error("[alphaclaw] syncChannelConfig error:", e.message);
  }
};

const getChannelStatus = () => {
  try {
    const config = readOpenclawConfig({ openclawDir: OPENCLAW_DIR, fallback: {} });
    const channels = {};

    for (const ch of Object.keys(kChannelDefs)) {
      const channelConfig =
        config.channels?.[ch] && typeof config.channels[ch] === "object"
          ? config.channels[ch]
          : null;
      if (!channelConfig?.enabled) continue;

      const rawAccounts =
        channelConfig.accounts && typeof channelConfig.accounts === "object"
          ? channelConfig.accounts
          : {};
      const accountEntries = Object.keys(rawAccounts).length > 0
        ? Object.entries(rawAccounts)
        : [["default", channelConfig]];
      const configuredAccountIds = new Set(
        accountEntries.map(([accountId]) => normalizeChannelAccountId(accountId)),
      );
      const hasConfiguredToken = accountEntries.some(([accountId, accountConfig]) => {
        const normalizedAccountId = normalizeChannelAccountId(accountId);
        const envKey = normalizedAccountId === "default"
          ? kChannelDefs[ch].envKey
          : `${kChannelDefs[ch].envKey}_${normalizedAccountId.replace(/-/g, "_").toUpperCase()}`;
        return !!process.env[envKey]
          || !!accountConfig?.botToken
          || !!accountConfig?.token;
      });
      if (!hasConfiguredToken) continue;

      const pairedByAccount = new Map(
        Array.from(configuredAccountIds).map((accountId) => [accountId, 0]),
      );
      for (const [accountId, accountConfig] of accountEntries) {
        if (ch === "whatsapp") continue;
        const inlineAllowFrom = accountConfig?.allowFrom;
        if (!Array.isArray(inlineAllowFrom)) continue;
        const normalizedAccountId = normalizeChannelAccountId(accountId);
        const nextCount =
          Number(pairedByAccount.get(normalizedAccountId) || 0) + inlineAllowFrom.length;
        pairedByAccount.set(normalizedAccountId, nextCount);
      }
      const accounts = Object.fromEntries(
        Array.from(pairedByAccount.entries()).map(([accountId, paired]) => [
          accountId,
          { status: paired > 0 ? "paired" : "configured", paired },
        ]),
      );
      const paired = Array.from(pairedByAccount.values()).reduce(
        (total, count) => total + Number(count || 0),
        0,
      );
      channels[ch] = {
        status: paired > 0 ? "paired" : "configured",
        paired,
        accounts,
      };
    }

    return channels;
  } catch {
    return {};
  }
};

module.exports = {
  gatewayEnv,
  gatewayMaintenanceEnv,
  probeGatewayEndpoint,
  probeGatewayStartupAndReadiness,
  waitForGatewayReady,
  consumeGatewayRestartHandoff,
  parseMigrationLockRetryAfterMs,
  getMigrationLockRetryDelayMs,
  getGatewayPort,
  getGatewayUrl,
  isOnboarded,
  isGatewayRunning,
  hasActiveManagedGatewayChild,
  isGatewayLifecycleBusy,
  tryAcquireGatewayRepair,
  launchGatewayProcess,
  cleanupOpenclawPluginInstallStages,
  prepareOpenclawChannelPlugins,
  setGatewayExitHandler,
  setGatewayLaunchHandler,
  runGatewayCmd,
  startGateway,
  restartGateway,
  restartGatewayLight,
  runWithGatewayStopped,
  createGatewaySignalHandler,
  attachGatewaySignalHandlers,
  ensureGatewayProxyConfig,
  syncChannelConfig,
  getChannelStatus,
};
