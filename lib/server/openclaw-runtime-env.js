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

const withOpenclawStartupEnv = (env = process.env) => ({
  ...env,
  NODE_COMPILE_CACHE: resolveOpenclawCompileCacheDir(env),
  OPENCLAW_NO_RESPAWN: resolveOpenclawNoRespawn(env),
});

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
  ensureOpenclawStartupEnv,
  resolveManagedCodexHome,
  resolveOpenclawCompileCacheDir,
  resolveOpenclawNoRespawn,
  withOpenclawStartupEnv,
};
