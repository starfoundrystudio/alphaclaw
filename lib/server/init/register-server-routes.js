const { runOnboardedBootSequence } = require("../startup");
const { registerAuthRoutes } = require("../routes/auth");
const { registerPageRoutes } = require("../routes/pages");
const { registerModelRoutes } = require("../routes/models");
const { registerOnboardingRoutes } = require("../routes/onboarding");
const { registerSystemRoutes } = require("../routes/system");
const { registerPairingRoutes } = require("../routes/pairings");
const { registerCodexRoutes } = require("../routes/codex");
const { registerAccountLoginRoutes } = require("../routes/account-logins");
const { registerGoogleRoutes } = require("../routes/google");
const { registerComposioRoutes } = require("../routes/composio");
const { registerBrowseRoutes } = require("../routes/browse");
const { registerProxyRoutes } = require("../routes/proxy");
const { registerTelegramRoutes } = require("../routes/telegram");
const { registerWebhookRoutes } = require("../routes/webhooks");
const { registerWatchdogRoutes } = require("../routes/watchdog");
const { registerUsageRoutes } = require("../routes/usage");
const { registerGmailRoutes } = require("../routes/gmail");
const { registerDoctorRoutes } = require("../routes/doctor");
const { registerAgentRoutes } = require("../routes/agents");
const { registerCronRoutes } = require("../routes/cron");
const { registerNodeRoutes } = require("../routes/nodes");
const { registerAgentVaultRoutes } = require("../routes/agent-vault");
const {
  registerAdvancedControlRoutes,
} = require("../routes/advanced-control");
const {
  createAdvancedControlAccessService,
} = require("../advanced-control-access");
const {
  createOauthCallbackMiddleware,
} = require("../oauth-callback-middleware");

const registerServerRoutes = ({
  app,
  fs,
  constants,
  runManagedPluginReconcile,
  loginThrottle,
  shellCmd,
  clawCmd,
  gogCmd,
  composioCmd,
  gatewayEnv,
  gatewayMaintenanceEnv = gatewayEnv,
  parseJsonFromNoisyOutput,
  normalizeOnboardingModels,
  authProfiles,
  claudeBrokerService,
  codexBrokerService,
  gogBrokerService,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  isOnboarded,
  isGatewayRunning,
  resolveModelProvider,
  ensureGatewayProxyConfig,
  isOpenAiCompatApiEnabled,
  openAiCompatApiThrottle,
  getBaseUrl,
  getSetupBaseUrl,
  getPublicBaseUrl,
  startGateway,
  ensureManagedExecDefaults,
  ensureUsageTrackerPluginConfig,
  resolveSetupUrl,
  syncChannelConfig,
  getChannelStatus,
  openclawVersionService,
  alphaclawVersionService,
  restartGateway,
  restartRequiredState,
  topicRegistry,
  createPkcePair,
  parseCodexAuthorizationInput,
  getCodexAccountId,
  readGoogleCredentials,
  getApiEnableUrl,
  telegramApi,
  doSyncPromptFiles,
  getRequests,
  getRequestById,
  getHookSummaries,
  deleteRequestsByHook,
  createOauthCallback,
  getOauthCallbackByHook,
  getOauthCallbackById,
  rotateOauthCallback,
  deleteOauthCallback,
  markOauthCallbackUsed,
  watchdog,
  watchdogNotifier,
  getRecentEvents,
  readLogTail,
  watchdogTerminal,
  teamyouMemoryActivation,
  bootstrapKickoff,
  getDailySummary,
  getSessionsList,
  getSessionDetail,
  getSessionTimeSeries,
  cronService,
  doctorService,
  agentsService,
  operationEvents,
  proxy,
  getGatewayUrl,
  getGatewayPort,
  SETUP_API_PREFIXES,
  webhookMiddleware,
  runOpenclawDoctorRepair,
  agentVaultService,
  prepareAgentVaultRuntime,
  isOnboardingRuntimeReady,
  isInitialHandoffReady,
  insertAdvancedControlAcknowledgement,
  listAdvancedControlAcknowledgements,
}) => {
  const { requireAuth, isAuthorizedRequest, getAuthorizedSession } = registerAuthRoutes({
    app,
    loginThrottle,
  });
  const advancedControlAccess = createAdvancedControlAccessService({
    getAuthorizedSession,
    insertAcknowledgement: insertAdvancedControlAcknowledgement,
    listAcknowledgements: listAdvancedControlAcknowledgements,
  });
  const { requireAdvancedControlAccess } = registerAdvancedControlRoutes({
    app,
    requireAuth,
    service: advancedControlAccess,
  });

  registerPageRoutes({
    app,
    requireAuth,
    isGatewayRunning,
    fsModule: fs,
    openclawDir: constants.OPENCLAW_DIR,
  });
  registerModelRoutes({
    app,
    ...(runManagedPluginReconcile
      ? { reconcileOpenclawPlugins: runManagedPluginReconcile }
      : {}),
    shellCmd,
    gatewayEnv,
    gatewayMaintenanceEnv,
    parseJsonFromNoisyOutput,
    normalizeOnboardingModels,
    readOpenclawVersion: (options) =>
      openclawVersionService?.readOpenclawVersion(options),
    isOnboarded,
    authProfiles,
    agentVaultService,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
  });
  registerSystemRoutes({
    app,
    fs,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    kKnownVars: constants.kKnownVars,
    kKnownKeys: constants.kKnownKeys,
    kSystemVars: constants.kSystemVars,
    syncChannelConfig,
    isGatewayRunning,
    isOnboarded,
    getChannelStatus,
    openclawVersionService,
    alphaclawVersionService,
    kAlphaclawGithubReleasesBaseUrl: constants.kAlphaclawGithubReleasesBaseUrl,
    clawCmd,
    restartGateway,
    OPENCLAW_DIR: constants.OPENCLAW_DIR,
    restartRequiredState,
    topicRegistry,
    authProfiles,
    watchdog,
    doctorService,
    ensureGatewayProxyConfig,
    getBaseUrl,
  });
  registerBrowseRoutes({
    app,
    fs,
    kRootDir: constants.OPENCLAW_DIR,
  });
  registerPairingRoutes({
    app,
    clawCmd,
    isOnboarded,
    fsModule: fs,
    openclawDir: constants.OPENCLAW_DIR,
    gatewayToken: constants.GATEWAY_TOKEN,
    getGatewayPort,
  });
  registerCodexRoutes({
    app,
    createPkcePair,
    parseCodexAuthorizationInput,
    getCodexAccountId,
    authProfiles,
    codexBrokerService,
    readLogTail,
  });
  registerAccountLoginRoutes({
    app,
    authProfiles,
    claudeBrokerService,
    shellCmd,
    gatewayEnv,
    // A completed Claude login makes the model usable: re-send a greeting
    // the agent never answered (kickoff fired before the login).
    onClaudeLoginReady: () =>
      Promise.resolve(bootstrapKickoff?.retryUnansweredKickoff?.()).catch(
        () => {},
      ),
  });
  registerGoogleRoutes({
    app,
    fs,
    isGatewayRunning,
    gogCmd,
    getSetupBaseUrl: getSetupBaseUrl || getBaseUrl,
    getPublicBaseUrl: getPublicBaseUrl || getBaseUrl,
    readGoogleCredentials,
    getApiEnableUrl,
    gogBrokerService,
    constants,
  });
  const gmailWatchService = registerGmailRoutes({
    app,
    fs,
    constants,
    gogCmd,
    getBaseUrl: getPublicBaseUrl || getBaseUrl,
    readGoogleCredentials,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    restartRequiredState,
  });
  const composioListenService = registerComposioRoutes({
    app,
    fs,
    constants,
    composioCmd,
    getSetupBaseUrl: getSetupBaseUrl || getBaseUrl,
    ensureHookWiring: () => gmailWatchService.ensureHookWiring(),
  });
  const runOnboardedBoot = () =>
    runOnboardedBootSequence({
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      doSyncPromptFiles,
      reloadEnv,
      syncChannelConfig,
      readEnvFile,
      ensureGatewayProxyConfig,
      resolveSetupUrl,
      startGateway,
      teamyouMemoryActivation,
      bootstrapKickoff,
      watchdog,
      gmailWatchService,
      composioListenService,
      runOpenclawDoctorRepair,
      claudeBrokerService,
      codexBrokerService,
      gogBrokerService,
    });
  registerOnboardingRoutes({
    app,
    fs,
    constants,
    shellCmd,
    gatewayEnv,
    gatewayMaintenanceEnv,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    isOnboarded,
    isGatewayRunning,
    resolveModelProvider,
    hasCodexOauthProfile: authProfiles.hasCodexOauthProfile,
    hasClaudeCliProfile: authProfiles.hasClaudeCliProfile,
    authProfiles,
    ensureGatewayProxyConfig,
    getBaseUrl: getSetupBaseUrl || getBaseUrl,
    prepareAgentVaultRuntime,
    isOnboardingRuntimeReady,
    isInitialHandoffReady,
    runOnboardedBootSequence: runOnboardedBoot,
  });
  registerTelegramRoutes({
    app,
    telegramApi,
    syncPromptFiles: doSyncPromptFiles,
  });
  registerWebhookRoutes({
    app,
    fs,
    constants,
    getBaseUrl: getPublicBaseUrl || getBaseUrl,
    webhooksDb: {
      getRequests,
      getRequestById,
      getHookSummaries,
      deleteRequestsByHook,
      createOauthCallback,
      getOauthCallbackByHook,
      rotateOauthCallback,
      deleteOauthCallback,
    },
    restartRequiredState,
  });
  const oauthCallbackMiddleware = createOauthCallbackMiddleware({
    getOauthCallbackById,
    markOauthCallbackUsed,
    webhookMiddleware,
  });
  registerWatchdogRoutes({
    app,
    requireAuth,
    watchdog,
    watchdogNotifier,
    getRecentEvents,
    readLogTail,
    watchdogTerminal,
  });
  registerUsageRoutes({
    app,
    requireAuth,
    getDailySummary,
    getSessionsList,
    getSessionDetail,
    getSessionTimeSeries,
  });
  registerCronRoutes({
    app,
    requireAuth,
    cronService,
  });
  registerDoctorRoutes({
    app,
    requireAuth,
    doctorService,
  });
  registerAgentRoutes({
    app,
    agentsService,
    agentVaultService,
    restartRequiredState,
    operationEvents,
  });
  registerNodeRoutes({
    app,
    clawCmd,
    openclawDir: constants.OPENCLAW_DIR,
    gatewayToken: constants.GATEWAY_TOKEN,
    fsModule: fs,
  });
  registerAgentVaultRoutes({
    app,
    requireAuth,
    agentVaultService,
    restartRequiredState,
  });
  registerProxyRoutes({
    app,
    proxy,
    getGatewayUrl,
    getGatewayToken: () =>
      process.env.OPENCLAW_GATEWAY_TOKEN || constants.GATEWAY_TOKEN || "",
    isOpenAiCompatApiEnabled,
    openAiCompatApiThrottle,
    SETUP_API_PREFIXES,
    requireAuth,
    requireAdvancedControlAccess,
    oauthCallbackMiddleware,
    webhookMiddleware,
  });

  return {
    requireAuth,
    isAuthorizedRequest,
    isAdvancedControlAuthorized: advancedControlAccess.isAuthorized,
    gmailWatchService,
    composioListenService,
    runOnboardedBootSequence: runOnboardedBoot,
  };
};

module.exports = {
  registerServerRoutes,
};
