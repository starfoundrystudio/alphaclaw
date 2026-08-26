const fs = require("fs");
const path = require("path");
const {
  buildPlaceholderForCredentialKey,
  isVaultPlaceholderValue,
} = require("./model-provider-services");
const {
  deriveChannelEnvKey,
  deriveChannelExtraEnvKeys,
} = require("../agents/shared");

// Channel credential classification registry
// (docs/vault-brokered-channels-spec.md §3–§5).
//
// Every channel that may be enabled on a managed instance needs an entry
// here; unclassified catalog channels are denied (owner decision D6,
// default-closed). Tier "S" channels are vault-brokered: the token lives
// only in Agent Vault, the instance stores the `__agent_vault_*__`
// placeholder, and the proxy substitutes it on the surfaces listed. Tier
// "C" channels use in-process crypto material that substitution cannot
// serve; they keep their existing flow under custody hygiene and honest
// labeling.
//
// Service hosts must cover every endpoint the channel's transport dials
// (bare host, no path scoping). Phase A live-verified the three S entries
// end-to-end on the enforced instance, including websocket substitution
// for Discord's IDENTIFY.
const kChannelProviderVaultServices = {
  telegram: {
    tier: "S",
    hosts: ["api.telegram.org"],
    surfaces: ["path"],
    obtain: "https://t.me/BotFather",
    slotDescriptions: {
      TELEGRAM_BOT_TOKEN: "Telegram bot token used by the telegram channel",
    },
  },
  discord: {
    tier: "S",
    hosts: ["discord.com", "gateway.discord.gg"],
    surfaces: ["header", "websocket"],
    obtain: "https://discord.com/developers/applications",
    // The Discord plugin's private transport bypasses proxyline's global
    // interception guarantees; its own per-channel proxy hook routes both
    // REST and the gateway websocket explicitly. Managed adds set
    // channels.discord.proxy to this env reference (never a literal URL —
    // the git-synced config must stay secret-free). Empty env expansion
    // leaves the literal `${...}` string (Phase A item 4), so the key is
    // only ever written while the vault runtime exists.
    proxyConfigValue: "${OPENCLAW_PROXY_URL}",
    slotDescriptions: {
      DISCORD_BOT_TOKEN:
        "Discord bot token used by the discord channel (REST + gateway websocket)",
    },
  },
  slack: {
    tier: "S",
    hosts: ["slack.com"],
    surfaces: ["header"],
    obtain: "https://api.slack.com/apps",
    slotDescriptions: {
      SLACK_BOT_TOKEN: "Slack bot token (xoxb) used by the slack channel",
      SLACK_APP_TOKEN:
        "Slack app-level token (xapp) used for the Socket Mode connection",
    },
  },
  whatsapp: {
    tier: "C",
    custody: {
      note: "WhatsApp pairing produces Noise-protocol keystore material used in-process; it cannot be vault-brokered by substitution.",
      revocation: "Unlink the device from the paired phone (WhatsApp > Linked devices).",
    },
  },
};

// Catalog snapshot fallback when the openclaw package's channel-catalog.json
// is unreadable; keeps the deny derivation working offline.
const kFallbackCatalogChannelIds = [
  "clickclack", "discord", "feishu", "googlechat", "irc", "line", "matrix",
  "mattermost", "msteams", "nextcloud-talk", "nostr", "openclaw-weixin",
  "openclaw-zaloclawbot", "qqbot", "raft", "signal", "slack", "sms",
  "synology-chat", "telegram", "tlon", "twitch", "wecom", "whatsapp",
  "yuanbao", "zalo", "zalouser",
];

const getChannelClassification = (provider) => {
  const entry = kChannelProviderVaultServices[String(provider || "").trim()];
  if (!entry) return null;
  return { tier: entry.tier };
};

const listVaultBrokeredChannelProviders = () =>
  Object.keys(kChannelProviderVaultServices).filter(
    (provider) => kChannelProviderVaultServices[provider].tier === "S",
  );

const getDiscordManagedProxyConfigValue = () =>
  kChannelProviderVaultServices.discord.proxyConfigValue;

const getChannelVaultConfig = (provider, accountId = "default") => {
  const providerId = String(provider || "").trim();
  const entry = kChannelProviderVaultServices[providerId];
  if (!entry || entry.tier !== "S") return null;
  const normalizedAccountId = String(accountId || "").trim() || "default";
  const envKeys = [
    deriveChannelEnvKey({ provider: providerId, accountId: normalizedAccountId }),
    ...deriveChannelExtraEnvKeys({
      provider: providerId,
      accountId: normalizedAccountId,
    }),
  ].filter(Boolean);
  const baseKeys = [
    deriveChannelEnvKey({ provider: providerId, accountId: "default" }),
    ...deriveChannelExtraEnvKeys({ provider: providerId, accountId: "default" }),
  ].filter(Boolean);
  return {
    provider: providerId,
    tier: "S",
    accountId: normalizedAccountId,
    surfaces: entry.surfaces,
    obtainUrl: entry.obtain || "",
    services: entry.hosts.map((host, index) => ({
      name:
        index === 0 ? `channel-${providerId}` : `channel-${providerId}-${index + 1}`,
      host,
    })),
    slots: envKeys.map((envKey, index) => ({
      envKey,
      placeholder: buildPlaceholderForCredentialKey(envKey),
      description:
        entry.slotDescriptions?.[baseKeys[index]] ||
        `${providerId} channel credential ${envKey}`,
    })),
  };
};

// One access request per service host; every slot substitutes on every
// service. The caller merges proposal_required plans into one proposal so
// the owner approves a provider (per account) exactly once.
const buildChannelProviderAccessRequests = (provider, accountId = "default") => {
  const config = getChannelVaultConfig(provider, accountId);
  if (!config) return null;
  return config.services.map((service) => ({
    service: {
      name: service.name,
      host: service.host,
      auth: { type: "passthrough" },
      substitutions: config.slots.map((slot) => ({
        key: slot.envKey,
        placeholder: slot.placeholder,
        in: config.surfaces,
      })),
    },
    credentials: config.slots.map((slot) => ({
      key: slot.envKey,
      description: slot.description,
      ...(config.obtainUrl ? { obtain: config.obtainUrl } : {}),
    })),
    reason: `Broker the ${config.provider} channel credential(s) for account "${config.accountId}" so traffic to ${service.host} authenticates at the Agent Vault proxy. Clawbridge stores only non-secret placeholders on the instance.`,
    userMessage: `Clawbridge wants Agent Vault to hold the ${config.provider} channel credential(s) for account "${config.accountId}" and inject them into ${config.provider} traffic. The values are entered on the Agent Vault approval page and never stored on the instance.`,
  }));
};

const resolveCatalogChannelIds = () => {
  try {
    const entryPath = require.resolve("openclaw");
    const entryDir = path.dirname(entryPath);
    const distDir =
      path.basename(entryDir) === "dist" ? entryDir : path.join(entryDir, "dist");
    const catalog = JSON.parse(
      fs.readFileSync(path.join(distDir, "channel-catalog.json"), "utf8"),
    );
    const ids = (Array.isArray(catalog?.entries) ? catalog.entries : [])
      .map((entry) => String(entry?.openclaw?.channel?.id || "").trim())
      .filter(Boolean);
    if (ids.length > 0) return ids;
  } catch {}
  return kFallbackCatalogChannelIds;
};

// D6: on managed instances every catalog channel plugin without a
// classification entry is denied at the gateway (plugins.deny is enforced
// before entries.enabled and the bundled-channel allowlist bypass, so this
// binds the Control UI, the agent, and the CLI alike).
// Channels that are classified (so they carry a real tier + custody notes)
// but are deliberately NOT offered on managed instances because they cannot
// function behind the Agent Vault proxy. WhatsApp's multi-device link runs a
// Noise-protocol handshake inside its WebSocket that authenticates the peer
// independently of TLS, so the vault MITM breaks pairing before a QR is ever
// produced (verified 2026-08-26, docs/vault-brokered-channels-spec.md §4).
// Shelved channels are denied at the consumer (plugins.deny) and hidden from
// the wizard; lift the entry once the per-host MITM passthrough exists.
const kShelvedChannelPluginIds = new Set(["whatsapp"]);

const isChannelProviderShelved = (provider) =>
  kShelvedChannelPluginIds.has(String(provider || "").trim());

const listDeniedChannelPluginIds = () =>
  [...new Set([...resolveCatalogChannelIds(), ...kShelvedChannelPluginIds])]
    .filter(
      (id) => !kChannelProviderVaultServices[id] || kShelvedChannelPluginIds.has(id),
    )
    .sort();

module.exports = {
  buildChannelProviderAccessRequests,
  getChannelClassification,
  getChannelVaultConfig,
  getDiscordManagedProxyConfigValue,
  isChannelProviderShelved,
  isVaultPlaceholderValue,
  kChannelProviderVaultServices,
  listDeniedChannelPluginIds,
  listVaultBrokeredChannelProviders,
  resolveCatalogChannelIds,
};
