const { cloneJson, hasLegacyDefaultChannelAccount } = require("./shared");

const kDmPolicies = new Set(["pairing", "allowlist", "open", "disabled"]);
const kGroupPolicies = new Set(["open", "allowlist", "disabled"]);
const kAllowBotsPolicies = new Set(["mentions", "false", "true"]);

const normalizeStringList = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    ),
  );

const getAccountConfig = ({ providerConfig, accountId }) => {
  const hasAccounts =
    providerConfig?.accounts && typeof providerConfig.accounts === "object";
  if (hasAccounts) return providerConfig.accounts?.[accountId] || null;
  if (
    accountId === "default" &&
    hasLegacyDefaultChannelAccount({ config: providerConfig })
  ) {
    return providerConfig;
  }
  return null;
};

const toRoomPolicies = ({ provider, accountConfig }) => {
  if (provider === "discord") {
    return Object.entries(accountConfig?.guilds || {}).flatMap(
      ([guildId, guildConfig]) => {
        const guild =
          guildConfig && typeof guildConfig === "object" ? guildConfig : {};
        const guildEntry = {
          id: guildId,
          guildId,
          kind: "guild",
          requireMention: guild.requireMention !== false,
          users: normalizeStringList(guild.users),
          roles: normalizeStringList(guild.roles),
        };
        const channelEntries = Object.entries(guild.channels || {}).map(
          ([id, channelConfig]) => ({
            id,
            guildId,
            kind: "channel",
            enabled: channelConfig?.enabled !== false,
            requireMention: channelConfig?.requireMention !== false,
            users: normalizeStringList(channelConfig?.users),
            roles: normalizeStringList(channelConfig?.roles),
            skills: normalizeStringList(channelConfig?.skills),
          }),
        );
        return [guildEntry, ...channelEntries];
      },
    );
  }
  const collectionKey = provider === "telegram" ? "groups" : "channels";
  return Object.entries(accountConfig?.[collectionKey] || {}).map(
    ([id, roomConfig]) => ({
      id,
      kind: provider === "telegram" ? "group" : "channel",
      enabled: roomConfig?.enabled !== false,
      requireMention: roomConfig?.requireMention !== false,
      users: normalizeStringList(roomConfig?.allowFrom || roomConfig?.users),
      skills: normalizeStringList(roomConfig?.skills),
      ...(roomConfig?.groupPolicy
        ? { groupPolicy: roomConfig.groupPolicy }
        : {}),
    }),
  );
};

const toPublicChannelPolicy = ({ provider, accountConfig }) => ({
  dmPolicy: String(accountConfig?.dmPolicy || "pairing"),
  allowFrom: normalizeStringList(accountConfig?.allowFrom),
  groupPolicy: String(accountConfig?.groupPolicy || "allowlist"),
  groupAllowFrom: normalizeStringList(accountConfig?.groupAllowFrom),
  requireMention:
    provider === "slack"
      ? accountConfig?.requireMention !== false
      : provider === "telegram"
        ? accountConfig?.groups?.["*"]?.requireMention !== false
        : accountConfig?.guilds?.["*"]?.requireMention !== false,
  ...(provider === "discord" || provider === "slack"
    ? { allowBots: String(accountConfig?.allowBots ?? "mentions") }
    : {}),
  rooms: toRoomPolicies({ provider, accountConfig }),
});

const attachRoomBindings = ({ policy, cfg, provider, accountId }) => ({
  ...policy,
  rooms: (policy.rooms || []).map((room) => {
    const binding = (Array.isArray(cfg?.bindings) ? cfg.bindings : []).find(
      (entry) => {
        const match = entry?.match || {};
        const matchAccountId = String(match.accountId || "").trim() || "default";
        return (
          String(match.channel || "").trim() === provider &&
          matchAccountId === accountId &&
          String(match.peer?.id || "").trim() === String(room.id || "").trim() &&
          (!room.guildId ||
            !match.guildId ||
            String(match.guildId).trim() === String(room.guildId).trim())
        );
      },
    );
    return {
      ...room,
      routeAgentId: String(binding?.agentId || "").trim(),
    };
  }),
});

const applyChannelPolicy = ({ provider, accountConfig, policy }) => {
  const next = cloneJson(accountConfig || {});
  const dmPolicy = String(policy?.dmPolicy || "").trim();
  const groupPolicy = String(policy?.groupPolicy || "").trim();
  if (!kDmPolicies.has(dmPolicy)) {
    throw new Error("Invalid direct message policy");
  }
  if (!kGroupPolicies.has(groupPolicy)) throw new Error("Invalid group policy");
  const allowFrom = normalizeStringList(policy?.allowFrom);
  const groupAllowFrom = normalizeStringList(policy?.groupAllowFrom);
  if (dmPolicy === "open" && !allowFrom.includes("*")) {
    throw new Error('Direct message policy "open" requires * in the allowlist');
  }
  if (dmPolicy === "allowlist" && allowFrom.length === 0) {
    throw new Error("Direct message allowlist cannot be empty");
  }
  next.dmPolicy = dmPolicy;
  next.groupPolicy = groupPolicy;
  next.allowFrom = allowFrom;
  if (provider === "telegram" || provider === "whatsapp") {
    next.groupAllowFrom = groupAllowFrom;
  }
  if (provider === "discord" || provider === "slack") {
    const allowBots = String(policy?.allowBots ?? "mentions").trim();
    if (!kAllowBotsPolicies.has(allowBots)) {
      throw new Error("Invalid bot message policy");
    }
    next.allowBots =
      allowBots === "true" ? true : allowBots === "false" ? false : allowBots;
  }
  const requireMention = policy?.requireMention !== false;
  const rooms = Array.isArray(policy?.rooms) ? policy.rooms : [];
  if (provider === "discord") {
    const currentGuilds =
      next.guilds && typeof next.guilds === "object" ? next.guilds : {};
    const guilds = {};
    for (const room of rooms) {
      const guildId = String(room?.guildId || room?.id || "").trim();
      if (!guildId) continue;
      if (!guilds[guildId]) {
        guilds[guildId] = cloneJson(currentGuilds[guildId] || {});
        delete guilds[guildId].channels;
      }
      if (room?.kind === "channel") {
        const id = String(room?.id || "").trim();
        if (!id) continue;
        if (!guilds[guildId].channels) guilds[guildId].channels = {};
        guilds[guildId].channels[id] = {
          ...(currentGuilds[guildId]?.channels?.[id] || {}),
          enabled: room?.enabled !== false,
          requireMention: room?.requireMention !== false,
          users: normalizeStringList(room?.users),
          roles: normalizeStringList(room?.roles),
          skills: normalizeStringList(room?.skills),
        };
      } else {
        const pendingChannels = guilds[guildId].channels;
        guilds[guildId] = {
          ...guilds[guildId],
          requireMention: room?.requireMention !== false,
          users: normalizeStringList(room?.users),
          roles: normalizeStringList(room?.roles),
          ...(pendingChannels ? { channels: pendingChannels } : {}),
        };
      }
    }
    guilds["*"] = { ...(guilds["*"] || {}), requireMention };
    next.guilds = guilds;
  } else if (provider === "telegram" || provider === "slack") {
    const collectionKey = provider === "telegram" ? "groups" : "channels";
    const currentCollection =
      next[collectionKey] && typeof next[collectionKey] === "object"
        ? next[collectionKey]
        : {};
    const collection = {};
    for (const room of rooms) {
      const id = String(room?.id || "").trim();
      if (!id) continue;
      collection[id] = {
        ...(currentCollection[id] || {}),
        enabled: room?.enabled !== false,
        requireMention: room?.requireMention !== false,
        ...(provider === "telegram"
          ? { allowFrom: normalizeStringList(room?.users) }
          : { users: normalizeStringList(room?.users) }),
        skills: normalizeStringList(room?.skills),
        ...(provider === "telegram" && room?.groupPolicy
          ? { groupPolicy: String(room.groupPolicy) }
          : {}),
      };
    }
    collection["*"] = { ...(collection["*"] || {}), requireMention };
    next[collectionKey] = collection;
    if (provider === "slack") next.requireMention = requireMention;
  }
  return next;
};

module.exports = {
  getAccountConfig,
  toPublicChannelPolicy,
  attachRoomBindings,
  applyChannelPolicy,
};
