const { createSlackApi } = require("./slack-api");
const {
  isVaultPlaceholderValue,
} = require("./agent-vault/model-provider-services");

const kSlackRequiredBotScopes = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "channels:read",
  "chat:write",
  "commands",
  "emoji:read",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "pins:read",
  "pins:write",
  "reactions:read",
  "reactions:write",
  "usergroups:read",
  "users:read",
];

const normalizeSlackToken = (value) => String(value || "").trim();

const collectScopeValues = (value, target) => {
  if (Array.isArray(value)) {
    for (const entry of value) collectScopeValues(entry, target);
    return;
  }
  if (typeof value === "string") {
    for (const entry of value.split(/[,\s]+/)) {
      const scope = entry.trim();
      if (scope) target.add(scope);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const entry of Object.values(value)) {
    if (typeof entry === "string" || Array.isArray(entry)) {
      collectScopeValues(entry, target);
    }
  }
};

const extractSlackScopes = (payload) => {
  const scopes = new Set();
  collectScopeValues(payload?.scopes, scopes);
  collectScopeValues(payload?.scope, scopes);
  collectScopeValues(payload?.response_metadata?.scopes, scopes);
  collectScopeValues(payload?.info?.scopes, scopes);
  collectScopeValues(payload?.info?.scope, scopes);
  collectScopeValues(payload?.info?.bot_scopes, scopes);
  return [...scopes].sort();
};

const parseSlackAppIdFromAppToken = (token) => {
  const match = /^xapp-\d-([a-z0-9]+)-/i.exec(normalizeSlackToken(token));
  return String(match?.[1] || "").toUpperCase();
};

const fetchSlackBotScopes = async (api, auth) => {
  let scopes = extractSlackScopes(auth);
  if (scopes.length > 0) return scopes;
  for (const method of ["authScopes", "appsPermissionsInfo"]) {
    try {
      scopes = extractSlackScopes(await api[method]());
      if (scopes.length > 0) return scopes;
    } catch {}
  }
  return [];
};

const createSlackInspectionError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const inspectSlackCredentials = async (
  { botToken, appToken } = {},
  { createApi = createSlackApi } = {},
) => {
  const normalizedBotToken = normalizeSlackToken(botToken);
  const normalizedAppToken = normalizeSlackToken(appToken);
  // Agent Vault placeholders skip prefix validation; the API calls below are
  // the validity check, with the proxy substituting the real tokens.
  if (
    !normalizedBotToken.startsWith("xoxb-") &&
    !isVaultPlaceholderValue(normalizedBotToken)
  ) {
    throw createSlackInspectionError(
      "Enter the Bot User OAuth Token from Slack. It should start with xoxb-.",
    );
  }
  if (
    !normalizedAppToken.startsWith("xapp-") &&
    !isVaultPlaceholderValue(normalizedAppToken)
  ) {
    throw createSlackInspectionError(
      "Enter the App-Level Token from Slack. It should start with xapp-.",
    );
  }

  let auth;
  let scopes = [];
  try {
    const botApi = createApi(normalizedBotToken);
    auth = await botApi.authTest();
    if (!String(auth?.bot_id || "").trim()) {
      // Raw entries are prefix-validated above, so reaching here with a
      // non-bot token means vault placeholders: check whether the two vault
      // slots hold swapped values (the app slot answering auth.test with a
      // bot_id is definitive). Both live testers hit exactly this by
      // pasting the tokens into the wrong approval-page fields.
      let swapped = false;
      if (normalizedAppToken) {
        try {
          const appSlotAuth = await createApi(normalizedAppToken).authTest();
          swapped = !!String(appSlotAuth?.bot_id || "").trim();
        } catch {}
      }
      throw createSlackInspectionError(
        swapped
          ? "Oops! You entered your Slack tokens in the wrong order. Please edit the SLACK_APP_TOKEN and SLACK_BOT_TOKEN credentials in Agent Vault to contain the correct values."
          : "Slack accepted this token, but it is not a Bot User OAuth Token. Copy the xoxb- token from Install App.",
      );
    }
    scopes = await fetchSlackBotScopes(botApi, auth);
  } catch (error) {
    if (error?.statusCode) throw error;
    const rejected = ["invalid_auth", "token_revoked", "account_inactive"].includes(
      String(error?.slackError || ""),
    );
    const botInVault = isVaultPlaceholderValue(normalizedBotToken);
    throw createSlackInspectionError(
      rejected
        ? botInVault
          ? "Slack rejected the bot token. Reinstall the app in Slack, then update the SLACK_BOT_TOKEN credential in Agent Vault with the new xoxb- token."
          : "Slack rejected the bot token. Reinstall the app and copy the Bot User OAuth Token again."
        : botInVault
          ? "Could not verify the bot token with Slack. Check the SLACK_BOT_TOKEN credential in Agent Vault and try again."
          : "Could not verify the bot token with Slack. Check the token and try again.",
      rejected ? 400 : 502,
    );
  }

  try {
    await createApi(normalizedAppToken).openSocketConnection();
  } catch (error) {
    const missingScope = String(error?.slackError || "") === "missing_scope";
    const rejected = ["invalid_auth", "token_revoked", "account_inactive"].includes(
      String(error?.slackError || ""),
    );
    const appInVault = isVaultPlaceholderValue(normalizedAppToken);
    throw createSlackInspectionError(
      missingScope
        ? appInVault
          ? "The Slack app token is missing connections:write. Generate a new App-Level Token with that scope and update the SLACK_APP_TOKEN credential in Agent Vault."
          : "The Slack app token is missing connections:write. Generate a new App-Level Token with that scope."
        : rejected
          ? appInVault
            ? "Slack rejected the app token. Generate a new App-Level Token, then update the SLACK_APP_TOKEN credential in Agent Vault."
            : "Slack rejected the app token. Generate a new App-Level Token and try again."
          : appInVault
            ? "Could not verify the app token with Slack. Check the SLACK_APP_TOKEN credential in Agent Vault and try again."
            : "Could not verify the app token with Slack. Check the token and try again.",
      missingScope || rejected ? 400 : 502,
    );
  }

  const botAppId = String(auth?.app_id || "").trim().toUpperCase();
  let appTokenAppId = parseSlackAppIdFromAppToken(normalizedAppToken);
  if (!appTokenAppId) {
    // Agent Vault placeholder tokens carry no parseable app id; auth.test
    // with the app-level token (substituted at the proxy) returns app_id,
    // which the Slack conversation deep link needs.
    try {
      const appAuth = await createApi(normalizedAppToken).authTest();
      appTokenAppId = String(appAuth?.app_id || "").trim().toUpperCase();
    } catch {}
  }
  if (botAppId && appTokenAppId && botAppId !== appTokenAppId) {
    throw createSlackInspectionError(
      "The bot token and app token belong to different Slack apps. Copy both tokens from the same app.",
    );
  }

  const grantedScopes = [...new Set(scopes)].sort();
  const missingScopes =
    grantedScopes.length > 0
      ? kSlackRequiredBotScopes.filter(
          (scope) => !grantedScopes.includes(scope),
        )
      : [];
  const appId = botAppId || appTokenAppId;
  return {
    appId,
    appSettingsUrl: appId ? `https://api.slack.com/apps/${appId}` : "",
    workspace: {
      id: String(auth?.team_id || "").trim(),
      name: String(auth?.team || "Slack Workspace").trim(),
      url: String(auth?.url || "").trim(),
    },
    bot: {
      id: String(auth?.bot_id || "").trim(),
      userId: String(auth?.user_id || "").trim(),
      name: String(auth?.user || "Slack Bot").trim(),
    },
    scopes: {
      checked: grantedScopes.length > 0,
      granted: grantedScopes,
      missing: missingScopes,
    },
  };
};

module.exports = {
  extractSlackScopes,
  inspectSlackCredentials,
  kSlackRequiredBotScopes,
  parseSlackAppIdFromAppToken,
};
