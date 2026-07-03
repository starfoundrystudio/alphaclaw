const fs = require("fs");
const path = require("path");
const {
  assertOpenclawConfigSafeForMutation,
  readOpenclawConfig,
  resolveOpenclawConfigPath,
  writeOpenclawConfig,
} = require("./openclaw-config");

const kManagedExecApprovalsDefaults = Object.freeze({
  security: "full",
  ask: "off",
  askFallback: "full",
});

const kManagedOpenclawExecDefaults = Object.freeze({
  security: "full",
  strictInlineEval: false,
});

const kManagedPluginApprovalDefaults = Object.freeze({
  enabled: true,
  mode: "session",
});

const resolveExecApprovalsConfigPath = ({ openclawDir }) =>
  path.join(openclawDir, "exec-approvals.json");

const readExecApprovalsConfig = ({
  fsModule = fs,
  openclawDir,
  fallback = { version: 1 },
} = {}) => {
  const filePath = resolveExecApprovalsConfigPath({ openclawDir });
  try {
    const parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
};

const writeExecApprovalsConfig = ({
  fsModule = fs,
  openclawDir,
  file = {},
  spacing = 2,
} = {}) => {
  const filePath = resolveExecApprovalsConfigPath({ openclawDir });
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  fsModule.writeFileSync(filePath, JSON.stringify(file, null, spacing) + "\n", "utf8");
  return filePath;
};

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

const ensureManagedExecApprovalsDefaults = (rawFile = {}) => {
  const file =
    rawFile && typeof rawFile === "object" && !Array.isArray(rawFile) ? rawFile : {};
  const before = JSON.stringify(file);
  const defaults =
    file.defaults && typeof file.defaults === "object" && !Array.isArray(file.defaults)
      ? file.defaults
      : null;
  const hasNonEmptyDefaults = !!defaults && Object.keys(defaults).length > 0;
  if (!hasNonEmptyDefaults) {
    if (!Number.isInteger(file.version)) file.version = 1;
    file.defaults = {
      security: kManagedExecApprovalsDefaults.security,
      ask: kManagedExecApprovalsDefaults.ask,
      askFallback: kManagedExecApprovalsDefaults.askFallback,
    };
    if (!file.agents || typeof file.agents !== "object" || Array.isArray(file.agents)) {
      file.agents = {};
    }
  }
  return {
    file,
    changed: JSON.stringify(file) !== before,
  };
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
  let approvalsChanged = false;

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

  const approvalsPath = resolveExecApprovalsConfigPath({ openclawDir });
  const approvalsExists =
    typeof fsModule.existsSync === "function" ? fsModule.existsSync(approvalsPath) : null;
  const approvals = readExecApprovalsConfig({
    fsModule,
    openclawDir,
    fallback: approvalsExists === true ? null : { version: 1 },
  });
  if (approvals && typeof approvals === "object" && !Array.isArray(approvals)) {
    const ensuredApprovals = ensureManagedExecApprovalsDefaults(approvals);
    if (ensuredApprovals.changed || approvalsExists === false) {
      writeExecApprovalsConfig({
        fsModule,
        openclawDir,
        file: ensuredApprovals.file,
        spacing: 2,
      });
      approvalsChanged = true;
    }
  }

  return {
    changed: openclawChanged || approvalsChanged,
    openclawChanged,
    approvalsChanged,
  };
};

module.exports = {
  kManagedExecApprovalsDefaults,
  kManagedOpenclawExecDefaults,
  kManagedPluginApprovalDefaults,
  resolveExecApprovalsConfigPath,
  readExecApprovalsConfig,
  writeExecApprovalsConfig,
  ensureManagedExecApprovalsDefaults,
  ensureManagedOpenclawExecDefaults,
  ensureManagedPluginApprovalDefaults,
  ensureManagedChannelApprovalDefaults,
  ensureManagedExecDefaults,
};
