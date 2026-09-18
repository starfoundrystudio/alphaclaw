const { createOnboardingService } = require("../onboarding");
const {
  reconcileOpenclawPlugins: defaultReconcileOpenclawPlugins,
} = require("../../cli/openclaw-plugin-compat");
const { redactSecretText } = require("../secret-redaction");
const {
  createTailscaleFinalizer,
} = require("../onboarding/tailscale-finalizer");
const {
  isWorkspaceBootstrapComplete,
} = require("../teamyou-memory-activation");

const readOnboardingMarker = ({ fs, markerPath }) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const kRuntimeReadySvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><rect width="1" height="1" fill="transparent"/></svg>';

const isSuccessorRuntimeReady = ({ marker, processStartedAtMs }) => {
  if (!marker || marker.onboarded !== true) return false;
  if (marker.hostFinalizationScheduled !== true) return true;

  const markedAtMs = Date.parse(String(marker.markedAt || ""));
  const startedAtMs = Number(processStartedAtMs);
  if (!Number.isFinite(markedAtMs) || !Number.isFinite(startedAtMs)) {
    return false;
  }
  return startedAtMs >= markedAtMs;
};

const sanitizeOnboardingError = (error) => {
  const raw = [error?.stderr, error?.stdout, error?.message]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
  const redacted = redactSecretText(raw || "Onboarding failed");
  const lower = redacted.toLowerCase();
  if (
    lower.includes("heap out of memory") ||
    lower.includes("allocation failed") ||
    lower.includes("fatal error: ineffective mark-compacts")
  ) {
    return "Onboarding ran out of memory. Please retry, and if it persists increase instance memory.";
  }
  if (
    lower.includes("openclaw plugin reconciliation failed") ||
    lower.includes("plugins install") ||
    lower.includes("plugin install") ||
    lower.includes("@openclaw/")
  ) {
    return "OpenClaw plugin installation failed. Please retry setup; if it persists, check package registry/network access for OpenClaw plugins.";
  }
  if (
    lower.includes("teamyou writeback failed")
  ) {
    return "TeamYou writeback failed. Please retry setup.";
  }
  if (
    lower.includes("tailscale")
  ) {
    return redacted.slice(0, 300);
  }
  if (
    lower.includes("host finalization")
  ) {
    return redacted.slice(0, 300);
  }
  if (
    lower.includes("invalid api key") ||
    lower.includes("invalid_api_key") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication failed") ||
    lower.includes("invalid token")
  ) {
    return "Model provider authentication failed. Check your API key/token and try again.";
  }
  if (
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("network") ||
    lower.includes("timed out")
  ) {
    return "Network error during onboarding. Please retry in a minute.";
  }
  if (lower.includes("command failed: openclaw onboard")) {
    return "Onboarding command failed. Please verify credentials and try again.";
  }
  return redacted.slice(0, 300);
};

const kAfterResponseFallbackDelayMs = 10000;

// Run the post-response task exactly once, however the response ends. Waiting
// only for "finish" stranded a live instance half-finalized: an upstream proxy
// cut the connection mid-onboard, so the socket was already dead when the
// listener attached, "finish" never fired, and host finalization silently
// never ran. "close" covers connections that die later; the fallback timer
// covers sockets that were already destroyed before the handler completed,
// where neither event fires again. The finalize task tolerates running while
// a healthy response is still in flight: it schedules the actual service
// transition several seconds out, which is ample for the small JSON body to
// flush.
const scheduleAfterResponseTask = (
  res,
  task,
  { fallbackDelayMs = kAfterResponseFallbackDelayMs } = {},
) => {
  let ran = false;
  const runOnce = () => {
    if (ran) return;
    ran = true;
    task();
  };
  res.once("finish", runOnce);
  res.once("close", runOnce);
  const timer = setTimeout(runOnce, fallbackDelayMs);
  if (typeof timer?.unref === "function") timer.unref();
};

const registerOnboardingRoutes = ({
  app,
  fs,
  constants,
  shellCmd,
  gatewayEnv,
  gatewayMaintenanceEnv = gatewayEnv,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  isOnboarded,
  isGatewayRunning = async () => false,
  isOnboardingRuntimeReady = async () => false,
  isInitialHandoffReady = isOnboardingRuntimeReady,
  resolveModelProvider,
  hasCodexOauthProfile,
  hasClaudeCliProfile,
  authProfiles,
  ensureGatewayProxyConfig,
  getBaseUrl,
  reconcileOpenclawPlugins = defaultReconcileOpenclawPlugins,
  tailscaleFinalizer,
  prepareAgentVaultRuntime,
  runOnboardedBootSequence,
  getProcessStartedAtMs = () => Date.now() - process.uptime() * 1000,
}) => {
  const hasExplicitOnboardingMarker = () =>
    fs.existsSync(constants.kOnboardingMarkerPath);

  const onboardingService = createOnboardingService({
    fs,
    constants,
    shellCmd,
    gatewayEnv,
    gatewayMaintenanceEnv,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    resolveModelProvider,
    hasCodexOauthProfile,
    hasClaudeCliProfile,
    authProfiles,
    ensureGatewayProxyConfig,
    getBaseUrl,
    reconcileOpenclawPlugins,
    tailscaleFinalizer:
      tailscaleFinalizer ||
      createTailscaleFinalizer({
        shellCmd,
        constants,
        readEnvFile,
        writeEnvFile,
        reloadEnv,
      }),
    prepareAgentVaultRuntime,
    runOnboardedBootSequence,
  });

  const recordInitialRuntimeReady = () => {
    const marker = readOnboardingMarker({ fs, markerPath: constants.kOnboardingMarkerPath });
    if (marker?.onboarded !== true) throw new Error("Onboarding marker is unavailable");
    const instanceId = String(process.env.OPENCLAW_INSTANCE_ID || "");
    if (marker.initialRuntimeReadyAt && marker.initialRuntimeReadyInstanceId === instanceId) return;
    const temporaryPath = `${constants.kOnboardingMarkerPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath,
        JSON.stringify({ ...marker, initialRuntimeReadyAt: new Date().toISOString(), initialRuntimeReadyInstanceId: instanceId }, null, 2), { mode: 0o600 });
      fs.renameSync(temporaryPath, constants.kOnboardingMarkerPath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  };

  app.get("/api/onboard/status", async (req, res) => {
    const onboarded = hasExplicitOnboardingMarker();
    const marker = onboarded
      ? readOnboardingMarker({
          fs,
          markerPath: constants.kOnboardingMarkerPath,
        })
      : {};
    let initialRuntimePending = onboarded && marker?.onboarded !== true;
    if (marker?.onboarded === true && marker.initialRuntimeCheckRequired === true &&
        !(marker.initialRuntimeReadyAt && marker.initialRuntimeReadyInstanceId === String(process.env.OPENCLAW_INSTANCE_ID || ""))) {
      initialRuntimePending = true;
      try {
        if (isSuccessorRuntimeReady({ marker, processStartedAtMs: getProcessStartedAtMs() }) &&
            await isInitialHandoffReady()) {
          recordInitialRuntimeReady();
          initialRuntimePending = false;
        }
      } catch {
        // A refresh/direct login must stay behind the same first-boot gate.
      }
    }
    const workspaceBootstrap = onboarded
      ? isWorkspaceBootstrapComplete({
          fsModule: fs,
          workspaceDir: constants.WORKSPACE_DIR,
        })
      : null;
    res.json({
      onboarded,
      initialRuntimePending,
      ...(workspaceBootstrap
        ? {
            workspaceBootstrap: {
              complete: workspaceBootstrap.complete === true,
              reason: workspaceBootstrap.reason,
            },
          }
        : {}),
      ...(marker?.setupUrl ? { setupUrl: marker.setupUrl } : {}),
      ...(marker?.publicBaseUrl ? { publicBaseUrl: marker.publicBaseUrl } : {}),
      ...(marker?.tailscaleDns ? { tailscaleDns: marker.tailscaleDns } : {}),
      ...(marker?.handoffViaBootstrapOrigin === true
        ? { handoffViaBootstrapOrigin: true }
        : {}),
    });
  });

  app.get("/api/onboard/runtime-ready.svg", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!hasExplicitOnboardingMarker()) {
      return res.status(503).type("text/plain").send("Runtime is not ready");
    }

    const marker = readOnboardingMarker({
      fs,
      markerPath: constants.kOnboardingMarkerPath,
    });
    // If the final POST response is lost during the service swap, the setup
    // page can recover the private destination from this authenticated,
    // same-origin handoff lane. Keep exposing it while readiness is still 503.
    if (marker?.handoffViaBootstrapOrigin === true && marker?.setupUrl) {
      res.set("X-Clawbridge-Setup-Url", String(marker.setupUrl));
    }
    if (
      !isSuccessorRuntimeReady({
        marker,
        processStartedAtMs: getProcessStartedAtMs(),
      })
    ) {
      return res.status(503).type("text/plain").send("Runtime is not ready");
    }

    try {
      // Observe restart state even while the port is down, so its recovery
      // tracker sees the down/up transition and can clear a pending restart.
      const runtimeReady = await isInitialHandoffReady();
      if (!runtimeReady || !(await isGatewayRunning())) {
        return res.status(503).type("text/plain").send("Runtime is not ready");
      }
    } catch {
      return res.status(503).type("text/plain").send("Runtime is not ready");
    }

    try {
      recordInitialRuntimeReady();
      return res.type("image/svg+xml").send(kRuntimeReadySvg);
    } catch {
      return res.status(503).type("text/plain").send("Runtime readiness could not be recorded");
    }
  });

  app.post("/api/onboard", async (req, res) => {
    if (hasExplicitOnboardingMarker())
      return res.json({ ok: false, error: "Already onboarded" });

    try {
      const {
        vars,
        modelKey,
        agentRuntimeId,
        tailscaleApiToken,
      } = req.body;
      const result = await onboardingService.completeOnboarding({
        req,
        vars,
        modelKey,
        agentRuntimeId,
        tailscaleApiToken,
      });
      if (typeof result.afterResponse === "function") {
        scheduleAfterResponseTask(res, result.afterResponse);
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      console.error(
        "[onboard] Error:",
        redactSecretText([err?.message, err?.stderr, err?.stdout].filter(Boolean).join("\n")),
      );
      res.status(500).json({
        ok: false,
        error: sanitizeOnboardingError(err),
      });
    }
  });
};

module.exports = {
  isSuccessorRuntimeReady,
  registerOnboardingRoutes,
  scheduleAfterResponseTask,
};
