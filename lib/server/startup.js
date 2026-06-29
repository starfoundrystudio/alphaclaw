const { isOpenclawConfigReadError } = require("./openclaw-config");

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
  resolveSetupUrl,
  startGateway,
  watchdog,
  gmailWatchService,
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
  try {
    await startGateway();
  } catch (error) {
    console.error(`[alphaclaw] Failed to start gateway on boot: ${error.message}`);
  }
  watchdog.start();
  gmailWatchService.start();
};

module.exports = {
  runOnboardedBootSequence,
};
