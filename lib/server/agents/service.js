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
  });

  return {
    ...agentsDomain,
    ...bindingsDomain,
    getChannelAccountToken: channelsDomain.getChannelAccountToken,
    inspectTelegramBotToken,
    inspectDiscordBotToken,
    inspectSlackCredentials,
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
