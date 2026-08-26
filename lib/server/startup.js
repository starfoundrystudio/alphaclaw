const fs = require("fs");

const { isOpenclawConfigReadError } = require("./openclaw-config");
const constants = require("./constants");

// Managed hosts schedule a full service restart (host finalization) right
// after onboarding completes. Starting the gateway in the doomed pre-restart
// process kills it seconds later — on a fresh instance that lands mid
// first-boot startup migrations, leaving openclaw's migration lock held for
// its full 5-minute TTL and locking the post-restart gateway out (observed
// on the first beta-channel provision, 2026-08-26). Same event-based gate as
// the bootstrap kickoff's deferral: only the process that predates the
// scheduled restart defers; the successor starts the gateway normally.
const isAwaitingHostFinalizationRestart = ({
  fsModule = fs,
  markerPath = constants.kOnboardingMarkerPath,
  processStartedAtMs = Date.now() - process.uptime() * 1000,
} = {}) => {
  let marker;
  try {
    marker = JSON.parse(fsModule.readFileSync(markerPath, "utf8"));
  } catch {
    return false;
  }
  if (!marker || typeof marker !== "object") return false;
  if (marker.hostFinalizationScheduled !== true) return false;
  const markedAtMs = Date.parse(String(marker.markedAt || ""));
  if (!Number.isFinite(markedAtMs)) return false;
  return processStartedAtMs < markedAtMs;
};

const formatManagedGatewayDeviceReadyMessage = (result) => {
  const parts = ["[alphaclaw] Managed gateway device approval ready"];
  const reason = String(result?.reason || "").trim();
  if (reason) parts.push(`reason=${reason}`);
  const deviceId = String(result?.deviceId || "").trim();
  if (deviceId) parts.push(`device=${deviceId.slice(0, 12)}`);
  const scopes = Array.isArray(result?.scopes)
    ? result.scopes.map((scope) => String(scope || "").trim()).filter(Boolean)
    : [];
  if (scopes.length > 0) parts.push(`scopes=${scopes.join(",")}`);
  return parts.join(" ");
};

// Long enough that a scheduled finalization restart has clearly failed to
// happen (the swap normally lands within seconds of scheduling).
const kFinalizationFallbackGatewayStartDelayMs = 60 * 1000;

const runRepairableConfigStep = ({
  label,
  step,
  runOpenclawDoctorRepair,
  repairState,
}) => {
  try {
    return step();
  } catch (error) {
    if (!isOpenclawConfigReadError(error)) {
      console.error(`[alphaclaw] ${label}: ${error.message}`);
      return undefined;
    }
    console.error(`[alphaclaw] ${label}: ${error.message}`);
    if (repairState.attempted || typeof runOpenclawDoctorRepair !== "function") {
      return undefined;
    }
    repairState.attempted = true;
    const repairResult = runOpenclawDoctorRepair({
      reason: `${label.replace(/\s+/g, "_").toLowerCase()}`,
    });
    if (!repairResult?.ok) return undefined;
    try {
      return step();
    } catch (retryError) {
      console.error(`[alphaclaw] ${label} after doctor repair: ${retryError.message}`);
      return undefined;
    }
  }
};

const runOnboardedBootSequence = async ({
  ensureManagedExecDefaults,
  ensureUsageTrackerPluginConfig,
  doSyncPromptFiles,
  reloadEnv,
  ensureGatewayProxyConfig,
  ensureManagedGatewayDevice,
  resolveSetupUrl,
  startGateway,
  teamyouMemoryActivation,
  bootstrapKickoff,
  watchdog,
  gmailWatchService,
  composioListenService,
  runOpenclawDoctorRepair,
}) => {
  const repairState = { attempted: false };
  runRepairableConfigStep({
    label: "Failed to ensure managed exec defaults on boot",
    step: ensureManagedExecDefaults,
    runOpenclawDoctorRepair,
    repairState,
  });
  runRepairableConfigStep({
    label: "Failed to ensure usage-tracker plugin config on boot",
    step: ensureUsageTrackerPluginConfig,
    runOpenclawDoctorRepair,
    repairState,
  });
  doSyncPromptFiles();
  reloadEnv({ clearMissing: false });
  ensureGatewayProxyConfig(resolveSetupUrl());
  if (typeof ensureManagedGatewayDevice === "function") {
    try {
      const result = await ensureManagedGatewayDevice();
      if (result && result.ok === false) {
        console.error(
          `[alphaclaw] Managed gateway device approval check failed: ${result.error || result.reason || "unknown error"}`,
        );
      } else if (result && result.ok === true) {
        console.log(formatManagedGatewayDeviceReadyMessage(result));
      }
    } catch (error) {
      console.error(
        `[alphaclaw] Managed gateway device approval check failed: ${error.message}`,
      );
    }
  }
  if (isAwaitingHostFinalizationRestart()) {
    console.log(
      "[alphaclaw] Gateway start deferred: host finalization restart pending; the post-restart boot starts the gateway",
    );
    // If scheduling the restart fails, onboarding flips the marker flag back
    // and this process must still bring the gateway up — re-check once after
    // the restart window has clearly passed. When the restart happens as
    // planned this process is gone before the timer fires.
    const recheckTimer = setTimeout(async () => {
      if (isAwaitingHostFinalizationRestart()) return;
      console.log(
        "[alphaclaw] Host finalization restart did not happen; starting gateway now",
      );
      try {
        await startGateway();
      } catch (error) {
        console.error(
          `[alphaclaw] Failed to start gateway after finalization fallback: ${error.message}`,
        );
      }
    }, kFinalizationFallbackGatewayStartDelayMs);
    recheckTimer.unref?.();
  } else {
    try {
      await startGateway();
    } catch (error) {
      console.error(
        `[alphaclaw] Failed to start gateway on boot: ${error.message}`,
      );
    }
  }
  // Fire-and-forget: the kickoff waits for the gateway internally and must
  // not delay the rest of the boot sequence.
  try {
    bootstrapKickoff?.maybeRunBootstrapKickoff?.();
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to start bootstrap kickoff: ${error.message}`,
    );
  }
  try {
    teamyouMemoryActivation?.start?.();
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to start TeamYou memory activation watcher: ${error.message}`,
    );
  }
  watchdog.start();
  gmailWatchService.start();
  composioListenService?.start?.();
};

module.exports = {
  isAwaitingHostFinalizationRestart,
  runOnboardedBootSequence,
};
