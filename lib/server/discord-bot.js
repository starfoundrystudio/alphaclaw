const { createDiscordApi } = require("./discord-api");

const kDiscordDeveloperPortalUrl = "https://discord.com/developers/applications";
const kDiscordPermissionFlags = {
  addReactions: 1n << 6n,
  viewChannels: 1n << 10n,
  sendMessages: 1n << 11n,
  embedLinks: 1n << 14n,
  attachFiles: 1n << 15n,
  readMessageHistory: 1n << 16n,
  sendMessagesInThreads: 1n << 38n,
};
const kDiscordInstallPermissions = Object.values(
  kDiscordPermissionFlags,
).reduce((total, permission) => total | permission, 0n);
const kDiscordApplicationFlags = {
  guildMembers: 1n << 14n,
  guildMembersLimited: 1n << 15n,
  messageContent: 1n << 18n,
  messageContentLimited: 1n << 19n,
};

const normalizeDiscordBotToken = (value) => String(value || "").trim();

const hasApplicationFlag = (flags, ...candidates) =>
  candidates.some((candidate) => (flags & candidate) === candidate);

const buildDiscordInstallUrl = (applicationId) => {
  const normalizedApplicationId = String(applicationId || "").trim();
  if (!/^\d+$/.test(normalizedApplicationId)) return "";
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", normalizedApplicationId);
  url.searchParams.set("permissions", kDiscordInstallPermissions.toString());
  url.searchParams.set("integration_type", "0");
  url.searchParams.set("scope", "bot applications.commands");
  return url.toString();
};

const inspectDiscordBotToken = async (
  token,
  { createApi = createDiscordApi } = {},
) => {
  const normalizedToken = normalizeDiscordBotToken(token);
  if (normalizedToken.length < 20) {
    const error = new Error(
      "Paste the complete bot token from the Discord Developer Portal.",
    );
    error.statusCode = 400;
    throw error;
  }

  try {
    const api = createApi(normalizedToken);
    const [user, application, guilds] = await Promise.all([
      api.getCurrentUser(),
      api.getCurrentApplication(),
      api.listCurrentUserGuilds(),
    ]);
    if (!user?.bot) {
      const error = new Error("That token does not belong to a Discord bot.");
      error.statusCode = 400;
      throw error;
    }

    const applicationId = String(application?.id || user.id || "").trim();
    if (!/^\d+$/.test(applicationId)) {
      const error = new Error("Discord did not return an application ID for this bot.");
      error.statusCode = 502;
      throw error;
    }
    const rawFlags = application?.flags_new ?? application?.flags ?? 0;
    const flags = BigInt(String(rawFlags || 0));
    const username = String(user.username || "").trim();
    const name = String(
      user.global_name || application?.name || username || "Discord Bot",
    ).trim();
    const avatar = String(user.avatar || "").trim();

    return {
      id: String(user.id || applicationId).trim(),
      applicationId,
      name,
      username,
      avatarUrl:
        avatar && user.id
          ? `https://cdn.discordapp.com/avatars/${user.id}/${avatar}.png?size=128`
          : "",
      developerPortalUrl: `${kDiscordDeveloperPortalUrl}/${applicationId}/bot`,
      installUrl: buildDiscordInstallUrl(applicationId),
      installPermissions: kDiscordInstallPermissions.toString(),
      intents: {
        messageContent: hasApplicationFlag(
          flags,
          kDiscordApplicationFlags.messageContent,
          kDiscordApplicationFlags.messageContentLimited,
        ),
        guildMembers: hasApplicationFlag(
          flags,
          kDiscordApplicationFlags.guildMembers,
          kDiscordApplicationFlags.guildMembersLimited,
        ),
      },
      guilds: (Array.isArray(guilds) ? guilds : []).map((guild) => ({
        id: String(guild?.id || "").trim(),
        name: String(guild?.name || "Discord Server").trim(),
      })),
    };
  } catch (error) {
    if (error?.statusCode) throw error;
    const rejected = Number(error?.discordStatusCode || 0) === 401;
    const nextError = new Error(
      rejected
        ? "Discord rejected this bot token. Reset the token in the Developer Portal and try again."
        : "Could not verify this bot with Discord. Check the token and try again.",
    );
    nextError.statusCode = rejected ? 400 : 502;
    throw nextError;
  }
};

module.exports = {
  buildDiscordInstallUrl,
  inspectDiscordBotToken,
  kDiscordInstallPermissions,
  kDiscordPermissionFlags,
};
