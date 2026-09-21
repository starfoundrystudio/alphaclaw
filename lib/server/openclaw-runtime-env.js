const fs = require("fs");
const path = require("path");
const { kRootDir } = require("./constants");

const kDefaultOpenclawCompileCacheDir = path.join(
  kRootDir,
  "cache",
  "openclaw-compile-cache",
);

const normalizeEnvValue = (value) => String(value || "").trim();

const resolveManagedCodexHome = ({
  rootDir = kRootDir,
  env = process.env,
  fsModule = fs,
} = {}) => {
  const configured = normalizeEnvValue(env.CODEX_HOME);
  if (configured) return configured;
  const legacyManagedHome = path.join(rootDir, ".codex");
  if (fsModule.existsSync(legacyManagedHome)) return legacyManagedHome;
  return path.join(normalizeEnvValue(env.HOME) || rootDir, ".codex");
};

const resolveOpenclawCompileCacheDir = (env = process.env) =>
  normalizeEnvValue(env.NODE_COMPILE_CACHE) || kDefaultOpenclawCompileCacheDir;

const resolveOpenclawNoRespawn = (env = process.env) =>
  normalizeEnvValue(env.OPENCLAW_NO_RESPAWN) || "1";

const kManagedOpenclawEnv = Object.freeze({
  OPENCLAW_NO_RESPAWN: "1",
  OPENCLAW_SUPERVISOR_MODE: "external",
  OPENCLAW_SERVICE_REPAIR_POLICY: "external",
  OPENCLAW_DISABLE_UPDATE_CHECK: "1",
  OPENCLAW_NO_AUTO_UPDATE: "1",
});

const withOpenclawStartupEnv = (env = process.env) => ({
  ...env,
  NODE_COMPILE_CACHE: resolveOpenclawCompileCacheDir(env),
  OPENCLAW_NO_RESPAWN: resolveOpenclawNoRespawn(env),
});

// OPENCLAW_CONFIG_READONLY is deliberately not set (removed 2026-09-21,
// beta.5). On OpenClaw 2026.9 it blocked every plugin install while the
// Gateway runs, including Clawbridge's own channel/provider installs and
// user-installed plugins, and it never kept credentials off the instance:
// model API keys and the team secret store accept raw values with it on
// (docs/openclaw-2026.9.5-secret-write-paths.md). Strip an inherited value
// so no stray setting brings the guard back.
const withManagedOpenclawEnv = (env = process.env) => {
  const nextEnv = {
    ...withOpenclawStartupEnv(env),
    ...kManagedOpenclawEnv,
  };
  delete nextEnv.OPENCLAW_CONFIG_READONLY;
  return nextEnv;
};

// Clawbridge-owned maintenance keeps external lifecycle and update refusal.
// It is identical to the managed env now that the config write guard is
// gone; callers keep using it to mark Clawbridge-owned mutations.
const withOpenclawMaintenanceEnv = (env = process.env) =>
  withManagedOpenclawEnv(env);

const ensureOpenclawStartupEnv = ({
  fsModule = fs,
  env = process.env,
  logger = console,
} = {}) => {
  const nextEnv = withOpenclawStartupEnv(env);
  try {
    fsModule.mkdirSync(nextEnv.NODE_COMPILE_CACHE, { recursive: true });
  } catch (err) {
    logger?.warn?.(
      `[alphaclaw] OpenClaw compile cache directory unavailable: ${err.message}`,
    );
  }

  if (!normalizeEnvValue(env.NODE_COMPILE_CACHE)) {
    env.NODE_COMPILE_CACHE = nextEnv.NODE_COMPILE_CACHE;
  }
  if (!normalizeEnvValue(env.OPENCLAW_NO_RESPAWN)) {
    env.OPENCLAW_NO_RESPAWN = nextEnv.OPENCLAW_NO_RESPAWN;
  }

  return nextEnv;
};

module.exports = {
  kDefaultOpenclawCompileCacheDir,
  kManagedOpenclawEnv,
  ensureOpenclawStartupEnv,
  resolveManagedCodexHome,
  resolveOpenclawCompileCacheDir,
  resolveOpenclawNoRespawn,
  withManagedOpenclawEnv,
  withOpenclawMaintenanceEnv,
  withOpenclawStartupEnv,
};
