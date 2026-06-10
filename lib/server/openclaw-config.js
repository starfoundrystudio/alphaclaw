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
  operation = "AlphaClaw config mutation",
} = {}) => {
  const gatewayMode = String(config?.gateway?.mode || "").trim();
  if (gatewayMode) return;
  throw new OpenclawConfigUnsafeMutationError(
    `${operation} refused to mutate openclaw.json because gateway.mode is missing; run openclaw doctor --fix --yes`,
    {
      configPath: resolveOpenclawConfigPath({ openclawDir }),
      operation,
    },
  );
};

const writeOpenclawConfig = ({
  fsModule = fs,
  openclawDir,
  config = {},
  spacing = 2,
} = {}) => {
  const configPath = resolveOpenclawConfigPath({ openclawDir });
  fsModule.mkdirSync(path.dirname(configPath), { recursive: true });
  const content = JSON.stringify(config, null, spacing);
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
  writeOpenclawConfig,
};
