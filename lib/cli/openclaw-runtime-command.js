const { spawnSync } = require("child_process");
const {
  withManagedOpenclawEnv,
  withOpenclawMaintenanceEnv,
} = require("../server/openclaw-runtime-env");

// OpenClaw subcommands that must write openclaw.json to do their job. They
// run as Clawbridge-owned maintenance. (Until beta.5 this also lifted
// OPENCLAW_CONFIG_READONLY=1, which 2026.9 enforces on these commands; the
// guard is no longer set anywhere, so the distinction is now bookkeeping.)
const kConfigMutatingOpenclawSubcommands = Object.freeze({
  plugins: new Set(["install", "uninstall", "remove", "update", "enable", "disable"]),
  config: new Set(["set", "unset"]),
});

const isOpenclawBinary = (arg) =>
  /(^|[\\/])openclaw(\.m?js)?$/.test(String(arg ?? ""));

const isConfigMutatingOpenclawCommand = (commandArgs = []) => {
  const args = Array.isArray(commandArgs) ? commandArgs.map(String) : [];
  const binIndex = args.findIndex(isOpenclawBinary);
  if (binIndex < 0) return false;
  const positional = args
    .slice(binIndex + 1)
    .filter((arg) => !arg.startsWith("-"));
  const group = kConfigMutatingOpenclawSubcommands[positional[0]];
  return Boolean(group && group.has(positional[1]));
};

const buildOpenclawRuntimeEnv = ({
  env = process.env,
  allowConfigMutation = false,
  buildAgentVaultRuntimeEnvImpl,
} = {}) => {
  const buildAgentVaultRuntimeEnv =
    buildAgentVaultRuntimeEnvImpl ||
    require("../server/agent-vault/runtime-store").buildAgentVaultRuntimeEnv;
  const runtimeEnv = {
    ...env,
    ...buildAgentVaultRuntimeEnv(),
  };
  return allowConfigMutation
    ? withOpenclawMaintenanceEnv(runtimeEnv)
    : withManagedOpenclawEnv(runtimeEnv);
};

const runOpenclawRuntimeCommand = ({
  commandArgs,
  env = process.env,
  cwd = process.cwd(),
  stdio = "inherit",
  spawnSyncImpl = spawnSync,
  buildAgentVaultRuntimeEnvImpl,
  allowConfigMutation = false,
  logger = console,
} = {}) => {
  if (!Array.isArray(commandArgs) || commandArgs.length === 0) {
    throw new Error("commandArgs are required");
  }
  const commandEnv = buildOpenclawRuntimeEnv({
    env,
    allowConfigMutation,
    buildAgentVaultRuntimeEnvImpl,
  });
  const result = spawnSyncImpl(commandArgs[0], commandArgs.slice(1), {
    cwd,
    env: commandEnv,
    stdio,
  });
  if (result.error) {
    logger.error?.(
      `[alphaclaw] OpenClaw runtime command failed: ${result.error.message}`,
    );
    return 1;
  }
  return result.status ?? (result.signal ? 1 : 0);
};

module.exports = {
  buildOpenclawRuntimeEnv,
  isConfigMutatingOpenclawCommand,
  runOpenclawRuntimeCommand,
};
