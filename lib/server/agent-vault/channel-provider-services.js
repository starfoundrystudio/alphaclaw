const fs = require("fs");
const path = require("path");
const {
  buildPlaceholderForCredentialKey,
  isPlaceholderForCredentialKey,
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
// only in Agent Vault, the instance stores the `__av_*__`
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
    label: "Telegram",
    slotLabels: {
      TELEGRAM_BOT_TOKEN: { name: "Telegram bot token" },
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
    // the managed config must stay secret-free). Empty env expansion
    // leaves the literal `${...}` string (Phase A item 4), so the key is
    // only ever written while the vault runtime exists.
    proxyConfigValue: "${OPENCLAW_PROXY_URL}",
    label: "Discord",
    slotLabels: {
      DISCORD_BOT_TOKEN: { name: "Discord bot token" },
    },
  },
  slack: {
    tier: "S",
    hosts: ["slack.com"],
    // "body" is load-bearing: @slack/web-api sends a token passed as a
    // method argument (Bolt's per-event authorize does exactly this) in
    // BOTH the Authorization header and the form body's `token` field,
    // and Slack gives the body field precedence. Header-only substitution
    // left the placeholder in the body, so every incoming event failed
    // authorize with invalid_auth (live-diagnosed 2026-08-27).
    surfaces: ["header", "body"],
    obtain: "https://api.slack.com/apps",
    // Proposal display order: app token first, matching the wizard's setup
    // steps (Slack's own journey surfaces the app-level token before the
    // install step). Both live testers swapped the values when the approval
    // page's field order inverted their copy order. App-first is also the
    // alphabetical order, so it holds whether the vault UI preserves our
    // order or sorts the keys.
    credentialOrder: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    label: "Slack",
    slotLabels: {
      SLACK_BOT_TOKEN: { name: "Slack bot token", format: "xoxb-…" },
      SLACK_APP_TOKEN: { name: "Slack app token", format: "xapp-…" },
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

// Owner-facing field label, e.g. "Slack bot token for work (xoxb-…)". The
// approval page renders it as the field label and as "Paste your <label>".
const describeChannelSlot = ({ entry, providerId, baseKey, envKey, accountId }) => {
  const slotLabel = entry.slotLabels?.[baseKey];
  if (!slotLabel) return `${entry.label || providerId} credential ${envKey}`;
  const accountSuffix = accountId === "default" ? "" : ` for ${accountId}`;
  const formatSuffix = slotLabel.format ? ` (${slotLabel.format})` : "";
  return `${slotLabel.name}${accountSuffix}${formatSuffix}`;
};

const getChannelVaultConfig = (
  provider,
  accountId = "default",
  { placeholdersInUse = null } = {},
) => {
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
  // Optional per-provider display order for the proposal/approval page
  // (keys are matched by name everywhere else, so order is presentation
  // only). Keep the envKey/baseKey pairs together while reordering.
  if (Array.isArray(entry.credentialOrder) && entry.credentialOrder.length > 0) {
    const rank = (baseKey) => {
      const index = entry.credentialOrder.indexOf(baseKey);
      return index === -1 ? entry.credentialOrder.length : index;
    };
    const paired = envKeys.map((envKey, index) => ({
      envKey,
      baseKey: baseKeys[index],
    }));
    paired.sort((a, b) => rank(a.baseKey) - rank(b.baseKey));
    envKeys.length = 0;
    baseKeys.length = 0;
    for (const pair of paired) {
      envKeys.push(pair.envKey);
      baseKeys.push(pair.baseKey);
    }
  }
  return {
    provider: providerId,
    label: entry.label || providerId,
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
      placeholder: buildPlaceholderForCredentialKey(envKey, {
        placeholdersInUse,
      }),
      name: entry.slotLabels?.[baseKeys[index]]?.name || envKey,
      description: describeChannelSlot({
        entry,
        providerId,
        baseKey: baseKeys[index],
        envKey,
        accountId: normalizedAccountId,
      }),
    })),
  };
};

const joinWithAnd = (items) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

// One access request per service host; every slot substitutes on every
// service. The caller merges proposal_required plans into one proposal so
// the owner approves a provider (per account) exactly once.
//
// One service per host serves every account of a provider (Agent Vault
// adopts proposed services by host), and a proposed substitution list
// REPLACES the stored one. `retainedSlots` therefore carries the other
// configured accounts' slots so adding an account never drops theirs (G3
// finding #38); `includeService` is passed through to the access planner.
const buildChannelProviderAccessRequests = (
  provider,
  accountId = "default",
  { placeholdersInUse = null, retainedSlots = [], includeService } = {},
) => {
  const config = getChannelVaultConfig(provider, accountId, {
    placeholdersInUse,
  });
  if (!config) return null;
  const ownKeys = new Set(config.slots.map((slot) => slot.envKey));
  const substitutionSlots = [
    ...config.slots,
    ...retainedSlots.filter((slot) => !ownKeys.has(slot.envKey)),
  ];
  // "Paste your Slack app token and bot token for “work”."
  const tokenNames = config.slots.map((slot) =>
    slot.name.startsWith(`${config.label} `)
      ? slot.name.slice(config.label.length + 1)
      : slot.name,
  );
  const accountLabel =
    config.accountId === "default" ? "" : ` “${config.accountId}”`;
  return config.services.map((service) => ({
    ...(includeService ? { includeService } : {}),
    service: {
      name: service.name,
      host: service.host,
      auth: { type: "passthrough" },
      substitutions: substitutionSlots.map((slot) => ({
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
    reason: accountLabel
      ? `Connect the ${config.label}${accountLabel} account.`
      : `Connect ${config.label}.`,
    userMessage: `Paste your ${config.label} ${joinWithAnd(tokenNames)}${
      accountLabel ? ` for${accountLabel}` : ""
    }.`,
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
  isPlaceholderForCredentialKey,
  isVaultPlaceholderValue,
  kChannelProviderVaultServices,
  listDeniedChannelPluginIds,
  listVaultBrokeredChannelProviders,
  resolveCatalogChannelIds,
};
