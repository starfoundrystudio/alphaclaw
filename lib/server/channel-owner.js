// Owner seeding for new channel accounts. A completed DM pairing leaves
// OpenClaw (2026.9.5) with the sender in the account's allowFrom and, as the
// first owner, in commands.ownerAllowFrom. Writing that state when the
// account is created lets the owner skip pairing entirely: under
// dmPolicy "allowlist" the pairing store is never consulted.

const kOwnerSeedProviders = new Set(["telegram", "discord", "slack"]);

const isObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const normalizeSlackUserId = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const prefixed = trimmed.match(/^(?:slack|user):([A-Z0-9]+)$/i);
  const candidate = prefixed?.[1] || trimmed.match(/^<@([A-Z0-9]+)>$/i)?.[1] || trimmed;
  const upper = String(candidate || "").trim().toUpperCase();
  return /^[UW][A-Z0-9]+$/.test(upper) ? upper : "";
};

const normalizeDiscordUserId = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const prefixed = trimmed.match(/^(?:discord|user):(\d+)$/i);
  const mention = trimmed.match(/^<@!?(\d+)>$/);
  const candidate = prefixed?.[1] || mention?.[1] || trimmed;
  return /^\d+$/.test(candidate) ? candidate : "";
};

const normalizeTelegramUserId = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const prefixed = trimmed.match(/^(?:telegram|user):(-?\d+)$/i);
  const candidate = prefixed?.[1] || trimmed;
  return /^\d+$/.test(candidate) && !candidate.startsWith("-") ? candidate : "";
};

const kOwnerIdNormalizers = {
  slack: normalizeSlackUserId,
  discord: normalizeDiscordUserId,
  telegram: normalizeTelegramUserId,
};

const normalizeChannelOwnerId = (provider, value) => {
  const normalize = kOwnerIdNormalizers[String(provider || "").trim()];
  return normalize ? normalize(value) : "";
};

const isOwnerSeedProvider = (provider) =>
  kOwnerSeedProviders.has(String(provider || "").trim());

// commands.ownerAllowFrom entries are `<channel>:<id>`. OpenClaw's own
// pairing bootstrap only writes the first owner; the owner of a single-owner
// instance is the same person on every channel, so each confirmed channel
// identity is added rather than skipped.
const appendCommandOwner = ({ cfg, provider, ownerId }) => {
  if (!isObject(cfg.commands)) cfg.commands = {};
  const current = Array.isArray(cfg.commands.ownerAllowFrom)
    ? cfg.commands.ownerAllowFrom
    : [];
  const alreadyOwner = current.some((entry) => {
    const trimmed = String(entry || "").trim();
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) return false;
    if (trimmed.slice(0, separatorIndex).toLowerCase() !== provider) return false;
    return (
      normalizeChannelOwnerId(provider, trimmed.slice(separatorIndex + 1)) ===
      ownerId
    );
  });
  if (alreadyOwner) return;
  cfg.commands.ownerAllowFrom = [...current, `${provider}:${ownerId}`];
};

// Mutates `cfg` and the account entry inside it. The caller writes config
// once; exec approvers are derived from allowFrom/ownerAllowFrom by
// ensureManagedChannelApprovalDefaults in the same write.
const applyChannelOwnerSeed = ({ cfg, provider, account, ownerId }) => {
  const normalizedProvider = String(provider || "").trim();
  const normalizedOwnerId = normalizeChannelOwnerId(normalizedProvider, ownerId);
  if (!normalizedOwnerId || !isObject(account)) return false;
  account.dmPolicy = "allowlist";
  account.allowFrom = [normalizedOwnerId];
  appendCommandOwner({
    cfg,
    provider: normalizedProvider,
    ownerId: normalizedOwnerId,
  });
  return true;
};

module.exports = {
  applyChannelOwnerSeed,
  isOwnerSeedProvider,
  normalizeChannelOwnerId,
  normalizeDiscordUserId,
  normalizeSlackUserId,
  normalizeTelegramUserId,
};
