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
const { registerTailscaleRoutes } = require("../routes/tailscale");
const {
  createTailnetHostManager,
} = require("../tailscale/host-manager");
const {
  createTailnetChangeStore,
} = require("../tailscale/change-store");
const {
  createTailnetChangeService,
} = require("../tailscale/change-service");
const {
  createOauthCallbackMiddleware,
} = require("../oauth-callback-middleware");
const {
  ensureManagedGatewayDevicePreapproval,
} = require("../managed-gateway-device");

const registerServerRoutes = ({
  app,
  fs,
  constants,
  loginThrottle,
  shellCmd,
  clawCmd,
  gogCmd,
  composioCmd,
  gatewayEnv,
  parseJsonFromNoisyOutput,
  normalizeOnboardingModels,
  authProfiles,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  isOnboarded,
  isGatewayRunning,
  resolveGithubRepoUrl,
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
}) => {
  const { requireAuth, isAuthorizedRequest } = registerAuthRoutes({
    app,
    loginThrottle,
  });

  registerPageRoutes({ app, requireAuth, isGatewayRunning });
  registerModelRoutes({
    app,
    shellCmd,
    gatewayEnv,
    parseJsonFromNoisyOutput,
    normalizeOnboardingModels,
    readOpenclawVersion: (options) =>
      openclawVersionService?.readOpenclawVersion(options),
    isOnboarded,
    authProfiles,
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
    resolveGithubRepoUrl,
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
    ensureManagedGatewayDevice: () =>
      ensureManagedGatewayDevicePreapproval({
        fsModule: fs,
        openclawDir: constants.OPENCLAW_DIR,
      }),
    gatewayToken: constants.GATEWAY_TOKEN,
    getGatewayPort,
  });
  registerCodexRoutes({
    app,
    createPkcePair,
    parseCodexAuthorizationInput,
    getCodexAccountId,
    authProfiles,
    readLogTail,
  });
  registerAccountLoginRoutes({
    app,
    authProfiles,
    shellCmd,
    gatewayEnv,
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
    constants,
  });
  registerComposioRoutes({
    app,
    fs,
    constants,
    composioCmd,
    getSetupBaseUrl: getSetupBaseUrl || getBaseUrl,
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
  const runOnboardedBoot = () =>
    runOnboardedBootSequence({
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      doSyncPromptFiles,
      reloadEnv,
      syncChannelConfig,
      readEnvFile,
      ensureGatewayProxyConfig,
      ensureManagedGatewayDevice: () =>
        ensureManagedGatewayDevicePreapproval({
          fsModule: fs,
          openclawDir: constants.OPENCLAW_DIR,
        }),
      resolveSetupUrl,
      startGateway,
      teamyouMemoryActivation,
      watchdog,
      gmailWatchService,
      runOpenclawDoctorRepair,
    });
  registerOnboardingRoutes({
    app,
    fs,
    constants,
    shellCmd,
    gatewayEnv,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    isOnboarded,
    resolveGithubRepoUrl,
    resolveModelProvider,
    hasCodexOauthProfile: authProfiles.hasCodexOauthProfile,
    hasClaudeCliProfile: authProfiles.hasClaudeCliProfile,
    authProfiles,
    ensureGatewayProxyConfig,
    getBaseUrl: getSetupBaseUrl || getBaseUrl,
    runOnboardedBootSequence: runOnboardedBoot,
  });
  registerTelegramRoutes({
    app,
    telegramApi,
    syncPromptFiles: doSyncPromptFiles,
    shellCmd,
  });
  registerWebhookRoutes({
    app,
    fs,
    constants,
    getBaseUrl: getPublicBaseUrl || getBaseUrl,
    shellCmd,
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
  const tailnetHostManager = createTailnetHostManager({ fs });
  const tailnetChangeStore = createTailnetChangeStore({
    fs,
    statePath: constants.kTailnetChangeStatePath,
  });
  const tailscaleChangeService = createTailnetChangeService({
    fs,
    constants,
    shellCmd,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    hostManager: tailnetHostManager,
    changeStore: tailnetChangeStore,
    ensureGatewayProxyConfig,
    restartGateway,
  });
  registerTailscaleRoutes({ app, tailscaleChangeService });
  if (tailnetChangeStore.isActive()) {
    setTimeout(() => {
      tailscaleChangeService.reconcileHostStatus().catch((error) => {
        console.error(
          `[tailscale] Startup reconciliation failed: ${error.message}`,
        );
      });
    }, 0);
  }
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
    oauthCallbackMiddleware,
    webhookMiddleware,
  });

  return {
    requireAuth,
    isAuthorizedRequest,
    gmailWatchService,
    runOnboardedBootSequence: runOnboardedBoot,
  };
};

module.exports = {
  registerServerRoutes,
};
