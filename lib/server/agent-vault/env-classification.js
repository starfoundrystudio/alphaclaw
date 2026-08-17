const kBootstrapCredentialKeys = new Set([
  "DOPPLER_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_WEBHOOK_TOKEN",
  "SETUP_PASSWORD",
  "TAILSCALE_API_TOKEN",
  "TEAMYOU_FINALIZE_CALLBACK_TOKEN",
  "WEBHOOK_TOKEN",
]);

const kManagedChannelCredentialPattern =
  /^(?:TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|WHATSAPP_OWNER_NUMBER)(?:_[A-Z0-9_]+)?$/;

const kCredentialNamePattern =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|AUTH_TOKEN|CLIENT_SECRET|CREDENTIALS?|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)$/;

// Removing a legacy env credential is only safe after the runtime has an
// explicit replacement for every non-HTTP consumer of that value. Add keys to
// this list only alongside that runtime integration.
const kAgentVaultRuntimeReplacements = new Map([
  [
    "TEAMYOU_API_KEY",
    {
      serviceName: "teamyou-external-api",
      serviceHost: "www.teamyou.com/api/external/v1/*",
    },
  ],
]);

const isAgentVaultCredentialKey = (value, { knownGroup = "" } = {}) => {
  const key = String(value || "").trim().toUpperCase();
  if (!key || kBootstrapCredentialKeys.has(key)) return false;
  if (kManagedChannelCredentialPattern.test(key)) return false;
  if (knownGroup === "ai") return true;
  return kCredentialNamePattern.test(key);
};

const isAgentVaultRuntimeReplacementKey = (value) =>
  kAgentVaultRuntimeReplacements.has(String(value || "").trim().toUpperCase());

const getAgentVaultRuntimeReplacement = (value) =>
  kAgentVaultRuntimeReplacements.get(
    String(value || "").trim().toUpperCase(),
  ) || null;

module.exports = {
  getAgentVaultRuntimeReplacement,
  isAgentVaultCredentialKey,
  isAgentVaultRuntimeReplacementKey,
  kAgentVaultRuntimeReplacements,
  kBootstrapCredentialKeys,
  kManagedChannelCredentialPattern,
};
