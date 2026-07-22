const { isOpenclawConfigReadError } = require("./openclaw-config");

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
  try {
    await startGateway();
  } catch (error) {
    console.error(`[alphaclaw] Failed to start gateway on boot: ${error.message}`);
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
  runOnboardedBootSequence,
};
