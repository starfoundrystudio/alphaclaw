const fs = require("fs");
const path = require("path");

const resolveOpenclawConfigPath = ({ openclawDir }) =>
  path.join(openclawDir, "openclaw.json");

class OpenclawConfigReadError extends Error {
  constructor(message, { configPath, cause } = {}) {
    super(message);
    this.name = "OpenclawConfigReadError";
    this.configPath = configPath;
    this.cause = cause;
    this.code = cause?.code || "OPENCLAW_CONFIG_READ_FAILED";
  }
}

class OpenclawConfigUnsafeMutationError extends Error {
  constructor(message, { configPath, operation } = {}) {
    super(message);
    this.name = "OpenclawConfigUnsafeMutationError";
    this.configPath = configPath;
    this.operation = operation;
    this.code = "OPENCLAW_CONFIG_UNSAFE_FOR_MUTATION";
  }
}

const isOpenclawConfigReadError = (error) =>
  error instanceof OpenclawConfigReadError ||
  error instanceof OpenclawConfigUnsafeMutationError ||
  error?.name === "OpenclawConfigUnsafeMutationError" ||
  error?.name === "OpenclawConfigReadError";

const isMissingConfigError = (error) => {
  if (error?.code === "ENOENT") return true;
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("no such file") ||
    message.includes("file not found") ||
    message.includes("no config")
  );
};

const readOpenclawConfig = (options = {}) => {
  const {
    fsModule = fs,
    openclawDir = options.dir,
    fallback = {},
  } = options;
  const configPath = resolveOpenclawConfigPath({ openclawDir });
  const hasFallback = Object.prototype.hasOwnProperty.call(
    options,
    "fallback",
  );
  try {
    return JSON.parse(fsModule.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (hasFallback && isMissingConfigError(error)) {
      return fallback;
    }
    throw new OpenclawConfigReadError(
      `Could not read valid openclaw.json: ${error.message}`,
      { configPath, cause: error },
    );
  }
};

const assertOpenclawConfigSafeForMutation = ({
  config,
  openclawDir,
  operation = "Clawbridge config mutation",
} = {}) => {
  const gatewayMode = String(config?.gateway?.mode || "").trim();
  if (gatewayMode) return;
  throw new OpenclawConfigUnsafeMutationError(
    `${operation} refused to mutate openclaw.json because gateway.mode is missing; run alphaclaw openclaw-doctor-guard -- openclaw doctor --non-interactive --fix`,
    {
      configPath: resolveOpenclawConfigPath({ openclawDir }),
      operation,
    },
  );
};

// Config keys retired by the pinned OpenClaw line (2026.9): Doctor migrates
// them once (`agents.defaults.memorySearch` → `memory.search`,
// `plugins.bundledDiscovery` → config_machine_state) and afterwards any config
// that still carries them fails validation on every CLI call and on Gateway
// config reload. G2 (2026-09-18) showed a runtime writer persisting them from
// a stale in-memory copy minutes after boot, so every config write made by
// this server goes through this strip regardless of which caller holds the
// object.
const stripRetiredOpenclawConfigKeys = (config) => {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return config;
  }
  const next = { ...config };
  if (
    next.agents &&
    typeof next.agents === "object" &&
    next.agents.defaults &&
    typeof next.agents.defaults === "object" &&
    "memorySearch" in next.agents.defaults
  ) {
    const { memorySearch: _memorySearch, ...defaults } = next.agents.defaults;
    next.agents = { ...next.agents, defaults };
  }
  if (
    next.plugins &&
    typeof next.plugins === "object" &&
    "bundledDiscovery" in next.plugins
  ) {
    const { bundledDiscovery: _bundledDiscovery, ...plugins } = next.plugins;
    next.plugins = plugins;
  }
  return next;
};

const writeOpenclawConfig = ({
  fsModule = fs,
  openclawDir,
  config = {},
  spacing = 2,
} = {}) => {
  const configPath = resolveOpenclawConfigPath({ openclawDir });
  fsModule.mkdirSync(path.dirname(configPath), { recursive: true });
  const content = JSON.stringify(
    stripRetiredOpenclawConfigKeys(config),
    null,
    spacing,
  );
  if (
    fsModule !== fs ||
    typeof fsModule.renameSync !== "function" ||
    typeof fsModule.rmSync !== "function"
  ) {
    fsModule.writeFileSync(configPath, content);
    return configPath;
  }
  const tempPath = `${configPath}.alphaclaw-${process.pid}-${Date.now()}.tmp`;
  try {
    fsModule.writeFileSync(tempPath, content, "utf8");
    fsModule.renameSync(tempPath, configPath);
  } catch (error) {
    try {
      fsModule.rmSync(tempPath, { force: true });
    } catch {}
    throw error;
  }
  return configPath;
};

module.exports = {
  OpenclawConfigReadError,
  OpenclawConfigUnsafeMutationError,
  assertOpenclawConfigSafeForMutation,
  isOpenclawConfigReadError,
  resolveOpenclawConfigPath,
  readOpenclawConfig,
  stripRetiredOpenclawConfigKeys,
  writeOpenclawConfig,
};
