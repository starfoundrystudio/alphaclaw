const fs = require("fs");
const {
  assertOpenclawConfigSafeForMutation,
  readOpenclawConfig,
  resolveOpenclawConfigPath,
  writeOpenclawConfig,
} = require("./openclaw-config");

const kManagedOpenclawExecDefaults = Object.freeze({
  security: "full",
  strictInlineEval: false,
});

const kManagedPluginApprovalDefaults = Object.freeze({
  enabled: true,
  mode: "session",
});

const hasOwn = (obj, key) =>
  !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);

const isObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const normalizeDiscordApprovalUserId = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const prefixed = trimmed.match(/^(?:discord|user):(\d+)$/i);
  const mention = trimmed.match(/^<@!?(\d+)>$/);
  const candidate = prefixed?.[1] || mention?.[1] || trimmed;
  return /^\d+$/.test(candidate) ? candidate : "";
};

const normalizeTelegramApprovalUserId = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const prefixed = trimmed.match(/^(?:telegram|user):(-?\d+)$/i);
  const candidate = prefixed?.[1] || trimmed;
  return /^\d+$/.test(candidate) && !candidate.startsWith("-") ? candidate : "";
};

const appendNormalizedApprovalUser = (entries, userId, normalizeUserId) => {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return null;
  const current = Array.isArray(entries) ? entries.slice() : [];
  const alreadyPresent = current.some((entry) => {
    const normalizedEntry = normalizeUserId(entry);
    return normalizedEntry === normalizedUserId || String(entry || "").trim() === "*";
  });
  return alreadyPresent ? null : [...current, normalizedUserId];
};

const collectNormalizedApprovalUsers = (values, normalizeUserId) => {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeUserId(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
};

const collectDiscordUsersFromChannelTarget = (target) => {
  const candidates = [];
  if (!isObject(target)) return candidates;
  candidates.push(...(Array.isArray(target.users) ? target.users : []));
  candidates.push(...(Array.isArray(target.allowFrom) ? target.allowFrom : []));
  if (isObject(target.guilds)) {
    for (const guild of Object.values(target.guilds)) {
      if (!isObject(guild)) continue;
      candidates.push(...(Array.isArray(guild.users) ? guild.users : []));
      candidates.push(...(Array.isArray(guild.allowFrom) ? guild.allowFrom : []));
    }
  }
  return collectNormalizedApprovalUsers(candidates, normalizeDiscordApprovalUserId);
};

const collectTelegramUsersFromChannelTarget = (target) => {
  const candidates = [];
  if (!isObject(target)) return candidates;
  candidates.push(...(Array.isArray(target.users) ? target.users : []));
  candidates.push(...(Array.isArray(target.allowFrom) ? target.allowFrom : []));
  candidates.push(...(Array.isArray(target.groupAllowFrom) ? target.groupAllowFrom : []));
  return collectNormalizedApprovalUsers(candidates, normalizeTelegramApprovalUserId);
};

const collectOwnerUsersForChannel = (config, channel, normalizeUserId) =>
  collectNormalizedApprovalUsers(
    (Array.isArray(config?.commands?.ownerAllowFrom)
      ? config.commands.ownerAllowFrom
      : []
    ).filter((entry) => String(entry || "").trim().toLowerCase().startsWith(`${channel}:`)),
    normalizeUserId,
  );

const applyExecApprovalApprovers = ({
  target,
  approvers,
  normalizeUserId,
  ensureEnabled = false,
}) => {
  if (!isObject(target) || approvers.length === 0) return false;
  if (!isObject(target.execApprovals)) target.execApprovals = {};
  let changed = false;
  for (const approver of approvers) {
    const nextApprovers = appendNormalizedApprovalUser(
      target.execApprovals.approvers,
      approver,
      normalizeUserId,
    );
    if (!nextApprovers) continue;
    target.execApprovals.approvers = nextApprovers;
    changed = true;
  }
  if (ensureEnabled && target.execApprovals.enabled === undefined) {
    target.execApprovals.enabled = "auto";
    changed = true;
  }
  return changed;
};

const ensureManagedOpenclawExecDefaults = (rawConfig = {}) => {
  const config =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
  const before = JSON.stringify(config);
  if (!config.tools || typeof config.tools !== "object" || Array.isArray(config.tools)) {
    config.tools = {};
  }
  if (!hasOwn(config.tools, "exec")) {
    config.tools.exec = {
      security: kManagedOpenclawExecDefaults.security,
      strictInlineEval: kManagedOpenclawExecDefaults.strictInlineEval,
    };
  }
  return {
    config,
    changed: JSON.stringify(config) !== before,
  };
};

const ensureManagedPluginApprovalDefaults = (rawConfig = {}) => {
  const config =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
  const before = JSON.stringify(config);
  if (!config.approvals || typeof config.approvals !== "object" || Array.isArray(config.approvals)) {
    config.approvals = {};
  }
  if (
    !config.approvals.plugin ||
    typeof config.approvals.plugin !== "object" ||
    Array.isArray(config.approvals.plugin)
  ) {
    config.approvals.plugin = {};
  }
  if (config.approvals.plugin.enabled === undefined) {
    config.approvals.plugin.enabled = kManagedPluginApprovalDefaults.enabled;
  }
  if (!String(config.approvals.plugin.mode || "").trim()) {
    config.approvals.plugin.mode = kManagedPluginApprovalDefaults.mode;
  }
  return {
    config,
    changed: JSON.stringify(config) !== before,
  };
};

const ensureManagedChannelApprovalDefaults = (rawConfig = {}) => {
  const config =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
  const before = JSON.stringify(config);
  const channels = isObject(config.channels) ? config.channels : {};

  const discordRoot = isObject(channels.discord) ? channels.discord : null;
  if (discordRoot) {
    const ownerDiscordUsers = collectOwnerUsersForChannel(
      config,
      "discord",
      normalizeDiscordApprovalUserId,
    );
    const rootDiscordUsers = [
      ...ownerDiscordUsers,
      ...collectDiscordUsersFromChannelTarget(discordRoot),
    ];
    applyExecApprovalApprovers({
      target: discordRoot,
      approvers: rootDiscordUsers,
      normalizeUserId: normalizeDiscordApprovalUserId,
      ensureEnabled: true,
    });
    if (isObject(discordRoot.accounts)) {
      for (const account of Object.values(discordRoot.accounts)) {
        if (!isObject(account)) continue;
        applyExecApprovalApprovers({
          target: account,
          approvers: [
            ...rootDiscordUsers,
            ...collectDiscordUsersFromChannelTarget(account),
          ],
          normalizeUserId: normalizeDiscordApprovalUserId,
          ensureEnabled: true,
        });
      }
    }
  }

  const telegramRoot = isObject(channels.telegram) ? channels.telegram : null;
  if (telegramRoot) {
    const ownerTelegramUsers = collectOwnerUsersForChannel(
      config,
      "telegram",
      normalizeTelegramApprovalUserId,
    );
    const rootTelegramUsers = [
      ...ownerTelegramUsers,
      ...collectTelegramUsersFromChannelTarget(telegramRoot),
    ];
    applyExecApprovalApprovers({
      target: telegramRoot,
      approvers: rootTelegramUsers,
      normalizeUserId: normalizeTelegramApprovalUserId,
    });
    if (isObject(telegramRoot.accounts)) {
      for (const account of Object.values(telegramRoot.accounts)) {
        if (!isObject(account)) continue;
        applyExecApprovalApprovers({
          target: account,
          approvers: [
            ...rootTelegramUsers,
            ...collectTelegramUsersFromChannelTarget(account),
          ],
          normalizeUserId: normalizeTelegramApprovalUserId,
        });
      }
    }
  }

  return {
    config,
    changed: JSON.stringify(config) !== before,
  };
};

const ensureManagedExecDefaults = ({
  fsModule = fs,
  openclawDir,
  requireGatewayMode = false,
} = {}) => {
  let openclawChanged = false;

  const openclawConfigPath = resolveOpenclawConfigPath({ openclawDir });
  const openclawExists =
    typeof fsModule.existsSync === "function" ? fsModule.existsSync(openclawConfigPath) : null;
  if (openclawExists !== false) {
    const cfg = readOpenclawConfig({
      fsModule,
      openclawDir,
      fallback: openclawExists === true ? null : {},
    });
    if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
      if (requireGatewayMode) {
        assertOpenclawConfigSafeForMutation({
          config: cfg,
          openclawDir,
          operation: "managed exec defaults sync",
        });
      }
      const ensuredConfig = ensureManagedOpenclawExecDefaults(cfg);
      const ensuredPluginApprovals = ensureManagedPluginApprovalDefaults(
        ensuredConfig.config,
      );
      const ensuredChannelApprovals = ensureManagedChannelApprovalDefaults(
        ensuredPluginApprovals.config,
      );
      if (
        ensuredConfig.changed ||
        ensuredPluginApprovals.changed ||
        ensuredChannelApprovals.changed
      ) {
        writeOpenclawConfig({
          fsModule,
          openclawDir,
          config: ensuredChannelApprovals.config,
          spacing: 2,
        });
        openclawChanged = true;
      }
    }
  }

  return {
    changed: openclawChanged,
    openclawChanged,
    approvalsChanged: false,
  };
};

module.exports = {
  kManagedOpenclawExecDefaults,
  kManagedPluginApprovalDefaults,
  ensureManagedOpenclawExecDefaults,
  ensureManagedPluginApprovalDefaults,
  ensureManagedChannelApprovalDefaults,
  ensureManagedExecDefaults,
};
