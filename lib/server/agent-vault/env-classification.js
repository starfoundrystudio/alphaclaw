const kBootstrapCredentialKeys = new Set([
  "ALPHACLAW_MANAGED_UPDATE_TOKEN",
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

const isAgentVaultCredentialKey = (value, { knownGroup = "" } = {}) => {
  const key = String(value || "").trim().toUpperCase();
  if (!key || kBootstrapCredentialKeys.has(key)) return false;
  if (kManagedChannelCredentialPattern.test(key)) return false;
  if (knownGroup === "ai") return true;
  return kCredentialNamePattern.test(key);
};

module.exports = {
  isAgentVaultCredentialKey,
  kBootstrapCredentialKeys,
  kManagedChannelCredentialPattern,
};
