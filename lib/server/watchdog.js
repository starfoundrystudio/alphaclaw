const { monitorEventLoopDelay } = require("perf_hooks");
const {
  kWatchdogCheckIntervalMs,
  kWatchdogDegradedCheckIntervalMs,
  kWatchdogStartupGraceMs,
  kWatchdogHealthTimeoutMs,
  kWatchdogEventLoopLagP95ThresholdMs,
  kWatchdogEventLoopLagMaxThresholdMs,
  kWatchdogEventLoopLagResolutionMs,
  kWatchdogStartupFailureThreshold,
  kWatchdogMaxRepairAttempts,
  kWatchdogRepairTimeoutMs,
  kWatchdogCrashLoopWindowMs,
  kWatchdogCrashLoopThreshold,
} = require("./constants");
const {
  assertOpenclawConfigSafeForMutation,
  readOpenclawConfig,
} = require("./openclaw-config");
const kBootstrapHealthCheckMs = 5 * 1000;
const kExpectedRestartWindowMs = 15 * 1000;
const kGuardedDoctorRepairCommand =
  "alphaclaw openclaw-doctor-guard -- openclaw doctor --non-interactive --fix";
const kDuplicateGatewayLaunchExitCodes = new Set([1, 78]);
const kLagSensitiveHealthFailureTypes = new Set(["timeout"]);

const isTruthy = (value) =>
  ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );

const isDuplicateGatewayLaunchExit = ({ code, stderrTail = [] } = {}) => {
  if (!kDuplicateGatewayLaunchExitCodes.has(code)) return false;
  const stderrText = (Array.isArray(stderrTail) ? stderrTail : [])
    .map((entry) => String(entry || ""))
    .join("\n")
    .toLowerCase();
  if (!stderrText) return false;
  return (
    stderrText.includes("another gateway instance is already listening") ||
    stderrText.includes("gateway already running under systemd") ||
    stderrText.includes("existing gateway is healthy") ||
    stderrText.includes("gateway already running") ||
    (stderrText.includes("port") && stderrText.includes("already in use"))
  );
};

const toFiniteMs = (value) => {
  const numberValue = Number(value || 0);
  if (!Number.isFinite(numberValue) || numberValue < 0) return 0;
  return Math.round(numberValue);
};

const createDefaultEventLoopLagMonitor = () => {
  try {
    const histogram = monitorEventLoopDelay({
      resolution: kWatchdogEventLoopLagResolutionMs,
    });
    histogram.enable();
    return {
      sample: () => {
        const p95Ms = toFiniteMs(histogram.percentile(95) / 1e6);
        const maxMs = toFiniteMs(histogram.max / 1e6);
        const meanMs = toFiniteMs(histogram.mean / 1e6);
        histogram.reset();
        return { p95Ms, maxMs, meanMs };
      },
      stop: () => histogram.disable(),
    };
  } catch {
    return {
      sample: () => ({ p95Ms: 0, maxMs: 0, meanMs: 0 }),
      stop: () => {},
    };
  }
};

const createWatchdog = ({
  clawCmd,
  shellCmd,
  launchGatewayProcess,
  insertWatchdogEvent,
  notifier,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  resolveSetupUrl,
  resolveGatewayHealthUrl = () => "",
  reconcileOpenclawPlugins,
  rootDir,
  openclawDir,
  fsModule,
  reconcileLogger = console,
  eventLoopLagMonitor = createDefaultEventLoopLagMonitor(),
}) => {
  const state = {
    lifecycle: "stopped",
    health: "unknown",
    uptimeStartedAt: null,
    lastHealthCheckAt: null,
    repairAttempts: 0,
    crashTimestamps: [],
    autoRepair: isTruthy(process.env.WATCHDOG_AUTO_REPAIR),
    notificationsDisabled: isTruthy(
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED,
    ),
    operationInProgress: false,
    gatewayStartedAt: null,
    gatewayPid: null,
    crashRecoveryActive: false,
    expectedRestartInProgress: false,
    expectedRestartUntilMs: 0,
    pendingRecoveryNoticeSource: "",
    awaitingAutoRepairRecovery: false,
    startupConsecutiveHealthFailures: 0,
    lastEventLoopLag: {
      p95Ms: 0,
      maxMs: 0,
      meanMs: 0,
      overloaded: false,
      p95ThresholdMs: kWatchdogEventLoopLagP95ThresholdMs,
      maxThresholdMs: kWatchdogEventLoopLagMaxThresholdMs,
      sampledAt: null,
    },
  };
  let healthTimer = null;
  let bootstrapHealthTimer = null;
  let degradedHealthTimer = null;
  let activeIncidentKey = "";
  let sentIncidentNotifications = new Set();

  const buildDoctorRepairEnv = () => ({
    ...process.env,
    ALPHACLAW_ROOT_DIR: rootDir,
    OPENCLAW_HOME: rootDir,
    OPENCLAW_CONFIG_PATH: `${openclawDir}/openclaw.json`,
    OPENCLAW_STATE_DIR: openclawDir,
    XDG_CONFIG_HOME: openclawDir,
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
  });

  const runGuardedDoctorRepair = async () => {
    if (typeof shellCmd !== "function") {
      return {
        ok: false,
        stdout: "",
        stderr: "Guarded OpenClaw doctor repair is unavailable",
        code: "missing-shell-command",
      };
    }
    try {
      const stdout = await shellCmd(kGuardedDoctorRepairCommand, {
        timeoutMs: kWatchdogRepairTimeoutMs,
        env: buildDoctorRepairEnv(),
      });
      return {
        ok: true,
        stdout: String(stdout || ""),
        stderr: "",
      };
    } catch (error) {
      return {
        ok: false,
        stdout: String(error?.stdout || ""),
        stderr: String(error?.stderr || error?.message || ""),
        code: error?.status ?? error?.code ?? null,
        signal: error?.signal ?? null,
        killed: Boolean(error?.killed),
      };
    }
  };

  const openIncident = (incidentKey = "gateway") => {
    const normalizedKey = String(incidentKey || "gateway");
    if (activeIncidentKey === normalizedKey) return;
    activeIncidentKey = normalizedKey;
    sentIncidentNotifications = new Set();
  };

  const closeIncident = () => {
    activeIncidentKey = "";
    sentIncidentNotifications = new Set();
  };

  const clearDegradedHealthCheckTimer = () => {
    if (!degradedHealthTimer) return;
    clearTimeout(degradedHealthTimer);
    degradedHealthTimer = null;
  };

  const scheduleDegradedHealthCheck = () => {
    if (degradedHealthTimer) return;
    if (state.health !== "degraded" || state.lifecycle !== "running") return;
    degradedHealthTimer = setTimeout(async () => {
      degradedHealthTimer = null;
      if (state.health !== "degraded" || state.lifecycle !== "running") return;
      await runHealthCheck({
        source: "degraded_retry",
        allowAutoRepair: false,
      });
      if (state.health === "degraded" && state.lifecycle === "running") {
        scheduleDegradedHealthCheck();
      }
    }, kWatchdogDegradedCheckIntervalMs);
    if (typeof degradedHealthTimer.unref === "function")
      degradedHealthTimer.unref();
  };

  const clearExpectedRestartWindow = () => {
    state.expectedRestartInProgress = false;
    state.expectedRestartUntilMs = 0;
  };

  const markExpectedRestartWindow = (durationMs = kExpectedRestartWindowMs) => {
    const safeDuration = Math.max(
      5000,
      Number(durationMs) || kExpectedRestartWindowMs,
    );
    state.expectedRestartInProgress = true;
    state.expectedRestartUntilMs = Date.now() + safeDuration;
  };

  const startRegularHealthChecks = () => {
    if (healthTimer) return;
    healthTimer = setInterval(() => {
      void runHealthCheck();
    }, kWatchdogCheckIntervalMs);
    if (typeof healthTimer.unref === "function") healthTimer.unref();
  };

  const startBootstrapHealthChecks = () => {
    if (bootstrapHealthTimer) return;
    const runBootstrapCheck = async () => {
      const healthy = await runHealthCheck();
      // Bootstrap checks are only for the "initializing" phase. As soon as we
      // either become healthy or transition into any non-unknown state
      // (degraded/unhealthy/etc.), stop 5s polling and fall back to normal
      // interval checks to avoid noisy health-check spam.
      if (healthy || state.health !== "unknown") {
        if (bootstrapHealthTimer) {
          clearTimeout(bootstrapHealthTimer);
          bootstrapHealthTimer = null;
        }
        startRegularHealthChecks();
        return;
      }
      bootstrapHealthTimer = setTimeout(() => {
        void runBootstrapCheck();
      }, kBootstrapHealthCheckMs);
      if (typeof bootstrapHealthTimer.unref === "function") {
        bootstrapHealthTimer.unref();
      }
    };
    void runBootstrapCheck();
  };

  const trimCrashWindow = () => {
    const threshold = Date.now() - kWatchdogCrashLoopWindowMs;
    state.crashTimestamps = state.crashTimestamps.filter(
      (ts) => ts >= threshold,
    );
  };

  const createCorrelationId = () =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const logEvent = (
    eventType,
    source,
    status,
    details = null,
    correlationId = "",
  ) => {
    try {
      insertWatchdogEvent({
        eventType,
        source,
        status,
        details,
        correlationId,
      });
    } catch (err) {
      console.error(`[watchdog] failed to log event: ${err.message}`);
    }
  };

  const sampleEventLoopLag = () => {
    let sample = {};
    try {
      sample =
        typeof eventLoopLagMonitor?.sample === "function"
          ? eventLoopLagMonitor.sample()
          : {};
    } catch (error) {
      sample = { error: error?.message || "event-loop lag sample failed" };
    }
    const p95Ms = toFiniteMs(sample.p95Ms);
    const maxMs = toFiniteMs(sample.maxMs);
    const meanMs = toFiniteMs(sample.meanMs);
    const overloaded =
      p95Ms >= kWatchdogEventLoopLagP95ThresholdMs ||
      maxMs >= kWatchdogEventLoopLagMaxThresholdMs;
    state.lastEventLoopLag = {
      p95Ms,
      maxMs,
      meanMs,
      overloaded,
      p95ThresholdMs: kWatchdogEventLoopLagP95ThresholdMs,
      maxThresholdMs: kWatchdogEventLoopLagMaxThresholdMs,
      sampledAt: new Date().toISOString(),
      ...(sample.error ? { error: sample.error } : {}),
    };
    return state.lastEventLoopLag;
  };

  const shouldTreatFailureAsSelfOverload = ({ parsed, eventLoopLag }) =>
    !!eventLoopLag?.overloaded &&
    kLagSensitiveHealthFailureTypes.has(String(parsed?.failureType || ""));

  const notify = async (message, correlationId = "", eventType = "info") => {
    if (state.notificationsDisabled) {
      return { ok: false, skipped: true, reason: "notifications_disabled" };
    }
    if (!notifier?.notify) return { ok: false, reason: "notifier_unavailable" };
    const result = await notifier.notify(message, { eventType });
    logEvent(
      "notification",
      "watchdog",
      result.ok ? "ok" : "failed",
      result,
      correlationId,
    );
    return result;
  };

  const notifyOncePerIncident = async (
    notificationKey,
    message,
    correlationId = "",
    eventType = "info",
  ) => {
    const key = String(notificationKey || "").trim();
    if (!key) return notify(message, correlationId, eventType);
    if (sentIncidentNotifications.has(key)) {
      return {
        ok: false,
        skipped: true,
        reason: "incident_notification_already_sent",
      };
    }
    const result = await notify(message, correlationId, eventType);
    if (result?.ok || result?.skipped) {
      sentIncidentNotifications.add(key);
    }
    return result;
  };

  const failRepair = async ({ result, source, correlationId }) => {
    state.repairAttempts += 1;
    state.health = "unhealthy";
    await notifyAutoRepairOutcome({
      source,
      correlationId,
      ok: false,
      attempts: state.repairAttempts,
    });
    if (state.repairAttempts >= kWatchdogMaxRepairAttempts) {
      await notify(
        [
          "🐺 *AlphaClaw Watchdog*",
          "🔴 Auto-repair failed repeatedly",
          `Attempts: ${state.repairAttempts}`,
          withViewLogsSuffix("Auto-repair paused until manual action."),
        ].join("\n"),
        correlationId,
        "crash",
      );
    }
    return { ok: false, result };
  };

  const getWatchdogSetupUrl = () => {
    try {
      const base =
        typeof resolveSetupUrl === "function"
          ? String(resolveSetupUrl() || "")
          : "";
      if (base) return `${base.replace(/\/+$/, "")}/#/watchdog`;
      const fallbackPort =
        Number.parseInt(String(process.env.PORT || "3000"), 10) || 3000;
      return `http://localhost:${fallbackPort}/#/watchdog`;
    } catch {
      return "";
    }
  };

  const withViewLogsSuffix = (line) => {
    const setupUrl = getWatchdogSetupUrl();
    if (!setupUrl) return line;
    return `${line} - [View logs](${setupUrl})`;
  };

  const asInlineCode = (value) =>
    `\`${String(value || "").replace(/`/g, "")}\``;

  const notifyAutoRepairOutcome = async ({
    source,
    correlationId,
    ok,
    verifiedHealthy = null,
    attempts = 0,
  }) => {
    if (source === "manual") return;
    openIncident("gateway_recovery");
    const title = ok
      ? verifiedHealthy
        ? "🟢 Auto-repair complete, gateway healthy"
        : "🟡 Auto-repair started, awaiting health check"
      : "🔴 Auto-repair failed";
    const notificationKey = ok
      ? verifiedHealthy
        ? "auto_repair_complete"
        : "auto_repair_awaiting_health"
      : "auto_repair_failed";
    await notifyOncePerIncident(
      notificationKey,
      [
        "🐺 *AlphaClaw Watchdog*",
        withViewLogsSuffix(title),
        `Trigger: ${asInlineCode(source)}`,
        ...(attempts > 0 ? [`Attempt count: ${attempts}`] : []),
      ].join("\n"),
      correlationId,
      ok && verifiedHealthy ? "recovery" : "crash",
    );
  };

  const getSettings = () => ({
    autoRepair: state.autoRepair,
    notificationsEnabled: !state.notificationsDisabled,
  });

  const probeGatewayHealth = async () => {
    const healthUrl = String(resolveGatewayHealthUrl() || "").trim();
    if (!healthUrl) {
      return {
        ok: false,
        failureType: "missing_health_url",
        reason: "gateway health URL unavailable",
      };
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      kWatchdogHealthTimeoutMs,
    );
    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const rawBody = await response.text();
      let parsedBody = null;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : null;
      } catch {}
      if (!response.ok) {
        return {
          ok: false,
          failureType: "http",
          reason:
            parsedBody?.error ||
            `gateway health returned HTTP ${response.status}`,
        };
      }
      if (parsedBody?.ok === false) {
        return {
          ok: false,
          failureType: "gateway_unhealthy",
          reason: parsedBody?.error || "gateway unhealthy",
        };
      }
      return {
        ok: true,
        details: parsedBody,
      };
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? `gateway health timed out after ${kWatchdogHealthTimeoutMs}ms`
          : error?.message || "gateway health request failed";
      return {
        ok: false,
        failureType: error?.name === "AbortError" ? "timeout" : "request_error",
        reason: message,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const updateSettings = ({ autoRepair, notificationsEnabled } = {}) => {
    const hasAutoRepair = typeof autoRepair === "boolean";
    const hasNotificationsEnabled = typeof notificationsEnabled === "boolean";
    if (!hasAutoRepair && !hasNotificationsEnabled) {
      throw new Error(
        "Expected autoRepair and/or notificationsEnabled boolean",
      );
    }
    const envVars = readEnvFile();
    if (hasAutoRepair) {
      const existingIdx = envVars.findIndex(
        (item) => item.key === "WATCHDOG_AUTO_REPAIR",
      );
      const nextValue = autoRepair ? "true" : "false";
      if (existingIdx >= 0) {
        envVars[existingIdx] = { ...envVars[existingIdx], value: nextValue };
      } else {
        envVars.push({ key: "WATCHDOG_AUTO_REPAIR", value: nextValue });
      }
    }
    if (hasNotificationsEnabled) {
      const existingIdx = envVars.findIndex(
        (item) => item.key === "WATCHDOG_NOTIFICATIONS_DISABLED",
      );
      const nextValue = notificationsEnabled ? "false" : "true";
      if (existingIdx >= 0) {
        envVars[existingIdx] = { ...envVars[existingIdx], value: nextValue };
      } else {
        envVars.push({
          key: "WATCHDOG_NOTIFICATIONS_DISABLED",
          value: nextValue,
        });
      }
    }
    writeEnvFile(envVars);
    reloadEnv();
    state.autoRepair = isTruthy(process.env.WATCHDOG_AUTO_REPAIR);
    state.notificationsDisabled = isTruthy(
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED,
    );
    return getSettings();
  };

  const reconcileManagedPlugins = async ({ correlationId }) => {
    if (typeof reconcileOpenclawPlugins !== "function") {
      return { ok: true, skipped: true, reason: "reconciler_unavailable" };
    }
    try {
      const config = readOpenclawConfig({
        fsModule,
        openclawDir,
        fallback: {},
      });
      assertOpenclawConfigSafeForMutation({
        config,
        openclawDir,
        operation: "AlphaClaw watchdog plugin reconciliation",
      });
      const result = await reconcileOpenclawPlugins({
        rootDir,
        openclawDir,
        fsModule,
        logger: reconcileLogger,
        env: process.env,
      });
      logEvent(
        "plugin_reconcile",
        "repair",
        "ok",
        {
          phase: "after_doctor",
          currentOpenclawVersion: result?.currentOpenclawVersion,
          targetOpenclawVersion: result?.targetOpenclawVersion,
          plugins: Array.isArray(result?.plugins)
            ? result.plugins.map((plugin) => ({
                id: plugin.id,
                package: plugin.package,
                version: plugin.version,
                action: plugin.action,
              }))
            : [],
        },
        correlationId,
      );
      return { ok: true, result };
    } catch (error) {
      const result = {
        ok: false,
        phase: "after_doctor",
        error: error?.message || String(error),
        code: error?.code || null,
      };
      logEvent(
        "plugin_reconcile",
        "repair",
        "failed",
        result,
        correlationId,
      );
      return result;
    }
  };

  const runRepair = async ({ source, correlationId, force = false }) => {
    if (!force && !state.autoRepair) {
      return { ok: false, skipped: true, reason: "auto_repair_disabled" };
    }
    if (!force && state.awaitingAutoRepairRecovery) {
      return { ok: false, skipped: true, reason: "awaiting_health_recovery" };
    }
    if (state.operationInProgress) {
      return { ok: false, skipped: true, reason: "operation_in_progress" };
    }

    state.operationInProgress = true;
    try {
      const result = await runGuardedDoctorRepair();
      const ok = !!result?.ok;
      logEvent("repair", source, ok ? "ok" : "failed", result, correlationId);
      if (ok) {
        const reconcileResult = await reconcileManagedPlugins({
          correlationId,
        });
        if (!reconcileResult.ok) {
          return failRepair({
            result: {
              ...result,
              pluginReconcile: reconcileResult,
            },
            source,
            correlationId,
          });
        }
        let launchedGateway = false;
        try {
          const child = launchGatewayProcess();
          launchedGateway = !!child;
          if (launchedGateway) {
            logEvent(
              "restart",
              "repair",
              "ok",
              { pid: child.pid },
              correlationId,
            );
          } else {
            logEvent(
              "restart",
              "repair",
              "failed",
              { reason: "launchGatewayProcess returned no child" },
              correlationId,
            );
          }
        } catch (err) {
          logEvent(
            "restart",
            "repair",
            "failed",
            { error: err.message },
            correlationId,
          );
        }
        state.health = "unknown";
        state.lifecycle = "running";
        state.repairAttempts = 0;
        state.crashTimestamps = [];
        state.awaitingAutoRepairRecovery = false;
        const verifiedHealthy = await runHealthCheck({
          allowDuringOperation: true,
          source: "repair_verify",
          allowAutoRepair: false,
        });
        await notifyAutoRepairOutcome({
          source,
          correlationId,
          ok: true,
          verifiedHealthy,
          attempts: state.repairAttempts,
        });
        if (!verifiedHealthy && source !== "manual") {
          state.pendingRecoveryNoticeSource = source;
          state.awaitingAutoRepairRecovery = true;
        } else {
          state.pendingRecoveryNoticeSource = "";
          state.awaitingAutoRepairRecovery = false;
        }
        return {
          ok: true,
          verifiedHealthy,
          launchedGateway,
          result,
        };
      }

      return failRepair({ result, source, correlationId });
    } finally {
      state.operationInProgress = false;
    }
  };

  const runHealthCheck = async ({
    allowDuringOperation = false,
    source = "health_timer",
    allowAutoRepair = true,
  } = {}) => {
    if (
      state.expectedRestartInProgress &&
      Date.now() >= state.expectedRestartUntilMs
    ) {
      clearExpectedRestartWindow();
    }
    if (state.operationInProgress && !allowDuringOperation) return false;
    const gatewayStartedAtAtStart = state.gatewayStartedAt;
    const correlationId = createCorrelationId();
    state.lastHealthCheckAt = new Date().toISOString();
    const parsed = await probeGatewayHealth();
    const eventLoopLag = sampleEventLoopLag();
    const staleAfterRestart =
      gatewayStartedAtAtStart != null &&
      state.gatewayStartedAt != null &&
      state.gatewayStartedAt !== gatewayStartedAtAtStart;
    const restartWindowActive =
      state.expectedRestartInProgress &&
      Date.now() < state.expectedRestartUntilMs;
    if (staleAfterRestart) {
      return false;
    }
    if (parsed.ok) {
      const wasUnhealthy = state.health !== "healthy";
      const recoveredFromCrashLoop = state.lifecycle === "crash_loop";
      const shouldNotifyRecovery =
        !!activeIncidentKey ||
        recoveredFromCrashLoop ||
        !!state.pendingRecoveryNoticeSource ||
        state.awaitingAutoRepairRecovery;
      state.startupConsecutiveHealthFailures = 0;
      clearDegradedHealthCheckTimer();
      clearExpectedRestartWindow();
      state.health = "healthy";
      state.lifecycle = "running";
      if (!state.uptimeStartedAt || wasUnhealthy)
        state.uptimeStartedAt = Date.now();
      state.repairAttempts = 0;
      state.crashRecoveryActive = false;
      state.awaitingAutoRepairRecovery = false;
      if (shouldNotifyRecovery) {
        logEvent(
          "recovery",
          source,
          "ok",
          [
            {
              previousLifecycle: recoveredFromCrashLoop
                ? "crash_loop"
                : null,
              previousRecoverySource: state.pendingRecoveryNoticeSource || null,
              health: "healthy",
            },
          ][0],
          correlationId,
        );
        await notifyOncePerIncident(
          "gateway_healthy_again",
          [
            "🐺 *AlphaClaw Watchdog*",
            withViewLogsSuffix("🟢 Gateway healthy again"),
          ].join("\n"),
          correlationId,
          "recovery",
        );
      }
      state.pendingRecoveryNoticeSource = "";
      closeIncident();
      logEvent(
        "health_check",
        source,
        "ok",
        parsed.details || { ok: true },
        correlationId,
      );
      return true;
    }
    if (restartWindowActive) {
      state.startupConsecutiveHealthFailures = 0;
      clearDegradedHealthCheckTimer();
      logEvent(
        "health_check",
        source,
        "ok",
        {
          reason: parsed.reason,
          details: parsed.details || null,
          skipped: true,
          expectedRestartActive: true,
          expectedRestartUntilMs: state.expectedRestartUntilMs,
        },
        correlationId,
      );
      return false;
    }

    const withinStartupGrace =
      !!state.gatewayStartedAt &&
      Date.now() - state.gatewayStartedAt < kWatchdogStartupGraceMs &&
      state.lifecycle === "running" &&
      !state.crashRecoveryActive;
    if (withinStartupGrace) {
      state.startupConsecutiveHealthFailures = 0;
      clearDegradedHealthCheckTimer();
      logEvent(
        "health_check",
        source,
        "ok",
        {
          reason: parsed.reason,
          details: parsed.details || null,
          skipped: true,
          startupGraceActive: true,
          startupGraceMs: kWatchdogStartupGraceMs,
        },
        correlationId,
      );
      return false;
    }

    if (shouldTreatFailureAsSelfOverload({ parsed, eventLoopLag })) {
      state.startupConsecutiveHealthFailures = 0;
      logEvent(
        "health_check",
        source,
        "ok",
        {
          reason: parsed.reason,
          failureType: parsed.failureType || null,
          details: parsed.details || null,
          skipped: true,
          selfOverloaded: true,
          eventLoopLag,
        },
        correlationId,
      );
      return false;
    }

    if (state.health === "unknown" && state.lifecycle === "running") {
      state.startupConsecutiveHealthFailures += 1;
      if (
        state.startupConsecutiveHealthFailures <
        kWatchdogStartupFailureThreshold
      ) {
        logEvent(
          "health_check",
          source,
          "ok",
          {
            reason: parsed.reason,
            details: parsed.details || null,
            skipped: true,
            startupFailureRetryActive: true,
            startupConsecutiveFailures: state.startupConsecutiveHealthFailures,
            startupFailureThreshold: kWatchdogStartupFailureThreshold,
          },
          correlationId,
        );
        return false;
      }
    } else {
      state.startupConsecutiveHealthFailures = 0;
    }

    state.health = "degraded";
    scheduleDegradedHealthCheck();
    logEvent(
      "health_check",
      source,
      "failed",
      { reason: parsed.reason, details: parsed.details || null },
      correlationId,
    );
    if (!state.autoRepair || !allowAutoRepair) return false;
    if (state.awaitingAutoRepairRecovery) return false;
    await runRepair({ source, correlationId });
    return false;
  };

  const restartAfterCrash = async (correlationId) => {
    if (state.operationInProgress) return;
    state.operationInProgress = true;
    try {
      const child = launchGatewayProcess();
      if (child) {
        logEvent(
          "restart",
          "exit_event",
          "ok",
          { pid: child.pid },
          correlationId,
        );
      } else {
        logEvent(
          "restart",
          "exit_event",
          "failed",
          { reason: "launchGatewayProcess returned no child" },
          correlationId,
        );
      }
    } catch (err) {
      logEvent(
        "restart",
        "exit_event",
        "failed",
        { error: err.message },
        correlationId,
      );
    } finally {
      state.operationInProgress = false;
    }
  };

  const onGatewayExit = ({
    code,
    signal,
    expectedExit = false,
    stderrTail = [],
  } = {}) => {
    const correlationId = createCorrelationId();
    clearDegradedHealthCheckTimer();
    if (expectedExit && (code == null || code === 0)) {
      state.lifecycle = "restarting";
      state.health = "unknown";
      state.uptimeStartedAt = null;
      state.crashRecoveryActive = false;
      markExpectedRestartWindow();
      startBootstrapHealthChecks();
      logEvent(
        "restart",
        "exit_event",
        "ok",
        { expectedExit: true, code: code ?? null, signal: signal ?? null },
        correlationId,
      );
      return;
    }
    if (isDuplicateGatewayLaunchExit({ code, stderrTail })) {
      state.lifecycle = "running";
      state.health = "unknown";
      state.crashRecoveryActive = false;
      state.startupConsecutiveHealthFailures = 0;
      if (!state.uptimeStartedAt) {
        state.uptimeStartedAt = Date.now();
      }
      startBootstrapHealthChecks();
      logEvent(
        "restart",
        "exit_event",
        "ok",
        {
          duplicateLaunch: true,
          code: code ?? null,
          signal: signal ?? null,
          stderrTail,
        },
        correlationId,
      );
      return;
    }

    state.lifecycle = "crashed";
    state.health = "unhealthy";
    state.uptimeStartedAt = null;
    state.crashRecoveryActive = true;
    state.crashTimestamps.push(Date.now());
    trimCrashWindow();
    logEvent(
      "crash",
      "exit_event",
      "failed",
      { code: code ?? null, signal: signal ?? null, stderrTail },
      correlationId,
    );

    if (state.crashTimestamps.length >= kWatchdogCrashLoopThreshold) {
      state.lifecycle = "crash_loop";
      openIncident("gateway_recovery");
      logEvent(
        "crash_loop",
        "exit_event",
        "failed",
        {
          crashesInWindow: state.crashTimestamps.length,
          windowMs: kWatchdogCrashLoopWindowMs,
        },
        correlationId,
      );
      void notifyOncePerIncident(
        "crash_loop_detected",
        [
          "🐺 *AlphaClaw Watchdog*",
          withViewLogsSuffix(
            state.autoRepair
              ? "🔴 Crash loop detected, auto-repairing..."
              : "🔴 Crash loop detected",
          ),
          `Crashes: ${state.crashTimestamps.length} in the last ${Math.floor(kWatchdogCrashLoopWindowMs / 1000)}s`,
          `Last exit code: ${code ?? "unknown"}`,
          ...(state.autoRepair
            ? []
            : ["Auto-restart paused; manual action required."]),
        ].join("\n"),
        correlationId,
        "crash",
      );
      if (state.autoRepair) {
        void runRepair({
          source: "crash_loop",
          correlationId,
        });
        return;
      }
      return;
    }

    void restartAfterCrash(correlationId);
  };

  const onGatewayLaunch = ({ startedAt = Date.now(), pid = null } = {}) => {
    clearDegradedHealthCheckTimer();
    state.lifecycle = "running";
    state.health = "unknown";
    state.startupConsecutiveHealthFailures = 0;
    state.crashRecoveryActive = false;
    clearExpectedRestartWindow();
    state.uptimeStartedAt = startedAt;
    state.gatewayStartedAt = startedAt;
    state.gatewayPid = pid;
    startBootstrapHealthChecks();
  };

  const onExpectedRestart = () => {
    clearDegradedHealthCheckTimer();
    state.lifecycle = "restarting";
    state.health = "unknown";
    state.uptimeStartedAt = null;
    state.startupConsecutiveHealthFailures = 0;
    state.crashRecoveryActive = false;
    markExpectedRestartWindow();
    startBootstrapHealthChecks();
  };

  const triggerRepair = async () => {
    const correlationId = createCorrelationId();
    return runRepair({
      source: "manual",
      correlationId,
      force: true,
    });
  };

  const start = () => {
    if (healthTimer || bootstrapHealthTimer) return;
    clearDegradedHealthCheckTimer();
    state.lifecycle = "running";
    state.health = "unknown";
    state.startupConsecutiveHealthFailures = 0;
    state.gatewayStartedAt = Date.now();
    startBootstrapHealthChecks();
  };

  const stop = () => {
    clearDegradedHealthCheckTimer();
    if (bootstrapHealthTimer) {
      clearTimeout(bootstrapHealthTimer);
      bootstrapHealthTimer = null;
    }
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    if (typeof eventLoopLagMonitor?.stop === "function") {
      eventLoopLagMonitor.stop();
    }
    state.lifecycle = "stopped";
    state.uptimeStartedAt = null;
    state.startupConsecutiveHealthFailures = 0;
    state.awaitingAutoRepairRecovery = false;
    state.pendingRecoveryNoticeSource = "";
    closeIncident();
  };

  const getStatus = () => {
    trimCrashWindow();
    return {
      lifecycle: state.lifecycle,
      health: state.health,
      uptimeMs: state.uptimeStartedAt ? Date.now() - state.uptimeStartedAt : 0,
      uptimeStartedAt: state.uptimeStartedAt
        ? new Date(state.uptimeStartedAt).toISOString()
        : null,
      lastHealthCheckAt: state.lastHealthCheckAt,
      repairAttempts: state.repairAttempts,
      autoRepair: state.autoRepair,
      crashCountInWindow: state.crashTimestamps.length,
      crashLoopThreshold: kWatchdogCrashLoopThreshold,
      crashLoopWindowMs: kWatchdogCrashLoopWindowMs,
      operationInProgress: state.operationInProgress,
      gatewayPid: state.gatewayPid,
      eventLoopLag: state.lastEventLoopLag,
    };
  };

  return {
    getStatus,
    getSettings,
    updateSettings,
    triggerRepair,
    onExpectedRestart,
    onGatewayExit,
    onGatewayLaunch,
    start,
    stop,
  };
};

module.exports = { createWatchdog };
