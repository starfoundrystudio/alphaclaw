const fs = require("fs");
const { createAgentsDomain } = require("./agents");
const { createBindingsDomain } = require("./bindings");
const { createChannelsDomain } = require("./channels");
const {
  inspectTelegramBotToken: defaultInspectTelegramBotToken,
} = require("../telegram-bot");
const {
  inspectDiscordBotToken: defaultInspectDiscordBotToken,
} = require("../discord-bot");
const {
  inspectSlackCredentials: defaultInspectSlackCredentials,
} = require("../slack-bot");
const { createTelegramApi } = require("../telegram-api");
const { createDiscordApi } = require("../discord-api");
const { createSlackApi } = require("../slack-api");
const {
  isVaultPlaceholderValue,
} = require("../agent-vault/channel-provider-services");
const {
  createVaultAwareFetch: defaultCreateVaultAwareFetch,
} = require("../agent-vault/vault-fetch");

const createAgentsService = ({
  fs: fsImpl = fs,
  OPENCLAW_DIR,
  rootDir,
  readEnvFile = () => [],
  writeEnvFile = () => {},
  reloadEnv = () => false,
  restartGateway = async () => {},
  reconcileOpenclawPlugins,
  inspectTelegramBotToken = defaultInspectTelegramBotToken,
  inspectDiscordBotToken = defaultInspectDiscordBotToken,
  inspectSlackCredentials = defaultInspectSlackCredentials,
  hasVaultRuntime,
  createVaultProbeFetch,
  probeChannelToken: probeChannelTokenOverride,
  clawCmd = async () => ({
    ok: false,
    stdout: "",
    stderr: "openclaw command unavailable",
  }),
}) => {
  const agentsDomain = createAgentsDomain({
    fsImpl,
    OPENCLAW_DIR,
  });
  const bindingsDomain = createBindingsDomain({
    fsImpl,
    OPENCLAW_DIR,
  });
  // Post-approval verification for vault-brokered channel adds: the same
  // inspections the wizard runs on raw tokens, executed with the placeholder
  // through the Agent Vault proxy so substitution applies (D5).
  const probeChannelToken = async ({ provider, token, appToken, fetchImpl }) => {
    if (provider === "telegram") {
      return inspectTelegramBotToken(token, {
        createApi: (value) => createTelegramApi(value, { fetchImpl }),
      });
    }
    if (provider === "discord") {
      return inspectDiscordBotToken(token, {
        createApi: (value) => createDiscordApi(value, { fetchImpl }),
      });
    }
    if (provider === "slack") {
      return inspectSlackCredentials(
        { botToken: token, appToken },
        { createApi: (value) => createSlackApi(value, { fetchImpl }) },
      );
    }
    return null;
  };

  const channelsDomain = createChannelsDomain({
    fsImpl,
    OPENCLAW_DIR,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    restartGateway,
    reconcileOpenclawPlugins,
    rootDir,
    clawCmd,
    ...(hasVaultRuntime ? { hasVaultRuntime } : {}),
    ...(createVaultProbeFetch ? { createVaultProbeFetch } : {}),
    probeChannelToken: probeChannelTokenOverride || probeChannelToken,
  });

  // Inspect endpoints stay usable with Agent Vault placeholders: the shape
  // checks already exempt them, and here the API call itself is routed
  // through the vault proxy so substitution supplies the real token. This is
  // what lets the wizard show bot identity + deep links in vault mode.
  const resolveVaultInspectFetch = (values) => {
    if (
      !values.some((value) =>
        isVaultPlaceholderValue(String(value || "").trim()),
      )
    ) {
      return null;
    }
    return (createVaultProbeFetch || defaultCreateVaultAwareFetch)();
  };

  const vaultAwareInspectTelegramBotToken = async (token) => {
    const fetchImpl = resolveVaultInspectFetch([token]);
    return fetchImpl
      ? inspectTelegramBotToken(token, {
          createApi: (value) => createTelegramApi(value, { fetchImpl }),
        })
      : inspectTelegramBotToken(token);
  };

  const vaultAwareInspectDiscordBotToken = async (token) => {
    const fetchImpl = resolveVaultInspectFetch([token]);
    return fetchImpl
      ? inspectDiscordBotToken(token, {
          createApi: (value) => createDiscordApi(value, { fetchImpl }),
        })
      : inspectDiscordBotToken(token);
  };

  const vaultAwareInspectSlackCredentials = async (credentials = {}) => {
    const fetchImpl = resolveVaultInspectFetch([
      credentials.botToken,
      credentials.appToken,
    ]);
    return fetchImpl
      ? inspectSlackCredentials(credentials, {
          createApi: (value) => createSlackApi(value, { fetchImpl }),
        })
      : inspectSlackCredentials(credentials);
  };

  return {
    ...agentsDomain,
    ...bindingsDomain,
    getChannelAccountToken: channelsDomain.getChannelAccountToken,
    inspectTelegramBotToken: vaultAwareInspectTelegramBotToken,
    inspectDiscordBotToken: vaultAwareInspectDiscordBotToken,
    inspectSlackCredentials: vaultAwareInspectSlackCredentials,
    createChannelAccount: channelsDomain.createChannelAccount,
    updateChannelAccount: channelsDomain.updateChannelAccount,
    deleteChannelAccount: channelsDomain.deleteChannelAccount,
    runChannelAccountLogin: channelsDomain.runChannelAccountLogin,
    getChannelAccountLoginStatus: channelsDomain.getChannelAccountLoginStatus,
    listConfiguredChannelAccounts:
      channelsDomain.listConfiguredChannelAccountsWithMaskedTokens,
  };
};

module.exports = { createAgentsService };
