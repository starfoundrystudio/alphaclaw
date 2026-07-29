const { spawnSync } = require("child_process");

const buildOpenclawRuntimeEnv = ({
  env = process.env,
  buildAgentVaultRuntimeEnvImpl,
} = {}) => {
  const buildAgentVaultRuntimeEnv =
    buildAgentVaultRuntimeEnvImpl ||
    require("../server/agent-vault/runtime-store").buildAgentVaultRuntimeEnv;
  return {
    ...env,
    ...buildAgentVaultRuntimeEnv(),
  };
};

const runOpenclawRuntimeCommand = ({
  commandArgs,
  env = process.env,
  cwd = process.cwd(),
  stdio = "inherit",
  spawnSyncImpl = spawnSync,
  buildAgentVaultRuntimeEnvImpl,
  logger = console,
} = {}) => {
  if (!Array.isArray(commandArgs) || commandArgs.length === 0) {
    throw new Error("commandArgs are required");
  }
  const commandEnv = buildOpenclawRuntimeEnv({
    env,
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
  runOpenclawRuntimeCommand,
};
