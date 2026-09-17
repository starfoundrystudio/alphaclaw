const {
  shouldInitializeManagedOpenclawRuntime,
} = require("../openclaw-runtime-state");

const initializeServerRuntime = ({
  fs,
  constants,
  ensureOpenclawStartupEnv,
  startEnvWatcher,
  attachGatewaySignalHandlers,
  cleanupLegacyImportTempDirs,
  migrateManagedInternalFiles,
}) => {
  ensureOpenclawStartupEnv?.({ fsModule: fs });
  startEnvWatcher();
  attachGatewaySignalHandlers();
  cleanupLegacyImportTempDirs();
  if (
    shouldInitializeManagedOpenclawRuntime({
      fs,
      onboardingMarkerPath: constants.kOnboardingMarkerPath,
      openclawDir: constants.OPENCLAW_DIR,
    })
  ) {
    migrateManagedInternalFiles({
      fs,
      openclawDir: constants.OPENCLAW_DIR,
    });
  }
};

const initializeServerDatabases = ({
  constants,
  initAuthDb,
  initWebhooksDb,
  initWatchdogDb,
  initUsageDb,
  initDoctorDb,
}) => {
  initAuthDb({
    rootDir: constants.kRootDir,
  });
  initWebhooksDb({
    rootDir: constants.kRootDir,
    pruneDays: constants.kWebhookPruneDays,
  });
  initWatchdogDb({
    rootDir: constants.kRootDir,
    pruneDays: constants.kWatchdogLogRetentionDays,
  });
  initUsageDb({
    rootDir: constants.kRootDir,
  });
  initDoctorDb({
    rootDir: constants.kRootDir,
  });
};

module.exports = {
  initializeServerRuntime,
  initializeServerDatabases,
};
