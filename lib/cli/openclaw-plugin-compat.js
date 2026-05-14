"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { readOpenclawConfig } = require("../server/openclaw-config");

const kDefaultManifestPath = path.join(
  __dirname,
  "..",
  "openclaw-compatibility.manifest.json",
);
const kVersionPattern = /\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?/;

const quoteArg = (value) => `'${String(value || "").replace(/'/g, "'\"'\"'")}'`;

const normalizeVersionParts = (version) =>
  String(version || "")
    .trim()
    .replace(/^[^\d]*/, "")
    .split(/[+-]/)[0]
    .split(".")
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^\d+/);
      return match ? Number(match[0]) : 0;
    });

const compareVersions = (left, right) => {
  const leftParts = normalizeVersionParts(left);
  const rightParts = normalizeVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
};

const satisfiesVersionRange = (version, range) => {
  const normalizedRange = String(range || "").trim();
  if (!normalizedRange) return false;
  const clauses = normalizedRange
    .split(/\s*\|\|\s*/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return clauses.some((clause) => {
    const match = clause.match(/^(<=|>=|<|>|=)?\s*(.+)$/);
    if (!match) return false;
    const operator = match[1] || "=";
    const target = match[2].trim();
    const comparison = compareVersions(version, target);
    if (operator === "<") return comparison < 0;
    if (operator === "<=") return comparison <= 0;
    if (operator === ">") return comparison > 0;
    if (operator === ">=") return comparison >= 0;
    return comparison === 0;
  });
};

const loadOpenclawCompatibilityManifest = ({
  fsModule = fs,
  manifestPath = kDefaultManifestPath,
} = {}) => {
  const manifest = JSON.parse(fsModule.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) {
    throw new Error(
      `Unsupported OpenClaw compatibility manifest schema: ${manifest.schemaVersion}`,
    );
  }
  if (!manifest.openclawVersion) {
    throw new Error("OpenClaw compatibility manifest is missing openclawVersion");
  }
  if (!manifest.managedPlugins || typeof manifest.managedPlugins !== "object") {
    throw new Error("OpenClaw compatibility manifest is missing managedPlugins");
  }
  return manifest;
};

const resolveOpenclawCliPath = () => {
  let packageDir = path.dirname(require.resolve("openclaw"));
  while (packageDir && packageDir !== path.dirname(packageDir)) {
    const candidatePath = path.join(packageDir, "package.json");
    try {
      const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
      if (candidate.name === "openclaw") break;
    } catch {}
    packageDir = path.dirname(packageDir);
  }
  const packagePath = path.join(packageDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const binPath =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.openclaw || "openclaw.mjs";
  return path.join(packageDir, binPath);
};

const buildOpenclawEnv = ({ rootDir, openclawDir, env = process.env }) => ({
  ...env,
  HOME: rootDir,
  OPENCLAW_HOME: rootDir,
  OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
  OPENCLAW_STATE_DIR: openclawDir,
  XDG_CONFIG_HOME: openclawDir,
});

const runOpenclawCommand = ({
  args,
  cwd,
  env,
  execSyncImpl = execSync,
  openclawCliPath = resolveOpenclawCliPath(),
}) => {
  const command = [quoteArg(process.execPath), quoteArg(openclawCliPath)]
    .concat(args.map(quoteArg))
    .join(" ");
  return execSyncImpl(command, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180000,
  });
};

const parseOpenclawVersion = (output) => {
  const match = String(output || "").match(kVersionPattern);
  return match ? match[0] : "";
};

const detectOpenclawVersion = (options = {}) => {
  const output = runOpenclawCommand({
    ...options,
    args: ["--version"],
  });
  const version = parseOpenclawVersion(output);
  if (!version) {
    throw new Error(`Could not parse OpenClaw version from: ${String(output)}`);
  }
  return version;
};

const buildLockPath = ({ openclawDir }) =>
  path.join(openclawDir, ".alphaclaw", "openclaw-plugins.lock.json");

const readManagedPluginLock = ({ fsModule = fs, lockPath }) => {
  try {
    return JSON.parse(fsModule.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
};

const writeManagedPluginLock = ({ fsModule = fs, lockPath, lock }) => {
  fsModule.mkdirSync(path.dirname(lockPath), { recursive: true });
  fsModule.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
};

const parsePluginList = (output) => {
  try {
    const payload = JSON.parse(String(output || "{}"));
    return Array.isArray(payload.plugins) ? payload.plugins : [];
  } catch {
    return [];
  }
};

const listInstalledPlugins = (options = {}) => {
  try {
    const output = runOpenclawCommand({
      ...options,
      args: ["plugins", "list", "--json"],
    });
    return parsePluginList(output);
  } catch {
    return [];
  }
};

const findInstalledPlugin = (plugins, key, definition) => {
  const packageName = definition.package;
  const pluginId = definition.pluginId || key;
  return plugins.find((plugin) => {
    const values = [
      plugin.id,
      plugin.name,
      plugin.package,
      plugin.packageName,
      plugin.source,
      plugin.install?.package,
      plugin.install?.npmSpec,
      plugin.metadata?.package,
    ]
      .filter(Boolean)
      .map(String);
    return values.some(
      (value) =>
        value === pluginId ||
        value === packageName ||
        value.includes(`/node_modules/${packageName}`) ||
        value.endsWith(packageName),
    );
  });
};

const hasOwn = (value, key) =>
  !!value && Object.prototype.hasOwnProperty.call(value, key);

const isPlainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const walkConfig = (value, visit, pathParts = []) => {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkConfig(item, visit, pathParts.concat(String(index))),
    );
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const nextPath = pathParts.concat(key);
      visit({ key, value: item, pathParts: nextPath });
      walkConfig(item, visit, nextPath);
    }
  }
};

const configContainsPluginSlot = (config, ids) => {
  const slots = config.plugins?.slots;
  if (!slots) return false;
  let found = false;
  walkConfig(slots, ({ value }) => {
    if (typeof value === "string" && ids.includes(value)) found = true;
  });
  return found;
};

const configContainsBackend = (config, ids) => {
  let found = false;
  walkConfig(config, ({ key, value }) => {
    if (key === "backend" && typeof value === "string" && ids.includes(value)) {
      found = true;
    }
  });
  return found;
};

const configContainsProviderRef = (config, providerIds) => {
  if (providerIds.length === 0) return false;
  let found = false;
  walkConfig(config, ({ key, value }) => {
    if (typeof value !== "string") return;
    if (providerIds.some((id) => value.startsWith(`${id}/`))) {
      found = true;
      return;
    }
    if (
      /provider/i.test(key) &&
      providerIds.some((id) => value === id || value.startsWith(`${id}:`))
    ) {
      found = true;
    }
  });
  return found;
};

const getPluginRelevanceReasons = ({
  config,
  key,
  definition,
  installed,
  previousLock,
}) => {
  const reasons = [];
  const pluginIds = [
    key,
    definition.pluginId,
    definition.package,
    definition.install?.npmSpec,
  ].filter(Boolean);
  if (installed) reasons.push("already-installed");
  if (previousLock?.plugins?.[key]) reasons.push("previously-managed");
  if (hasOwn(config.plugins?.entries, key)) reasons.push(`plugins.entries.${key}`);
  if (
    definition.pluginId &&
    definition.pluginId !== key &&
    hasOwn(config.plugins?.entries, definition.pluginId)
  ) {
    reasons.push(`plugins.entries.${definition.pluginId}`);
  }
  if (configContainsPluginSlot(config, pluginIds)) {
    reasons.push("plugins.slots");
  }
  if (definition.channelId && hasOwn(config.channels, definition.channelId)) {
    reasons.push(`channels.${definition.channelId}`);
  }
  if (definition.providerIds?.length > 0) {
    for (const providerId of definition.providerIds) {
      if (hasOwn(config.models?.providers, providerId)) {
        reasons.push(`models.providers.${providerId}`);
      }
    }
    if (configContainsProviderRef(config, definition.providerIds)) {
      reasons.push("provider-reference");
    }
  }
  if (definition.webSearchProviderIds?.length > 0) {
    if (configContainsProviderRef(config, definition.webSearchProviderIds)) {
      reasons.push("web-search-provider-reference");
    }
  }
  if (configContainsBackend(config, pluginIds)) {
    reasons.push("backend-reference");
  }
  return [...new Set(reasons)];
};

const buildInstallSpec = (definition) =>
  `npm:${definition.install?.exactNpmSpec || `${definition.package}@${definition.version}`}`;

const buildLockPluginEntry = ({
  definition,
  installedAt,
  action,
  previousVersion,
}) => ({
  package: definition.package,
  pluginId: definition.pluginId,
  version: definition.version,
  installedAt,
  lastAction: action,
  ...(previousVersion ? { previousVersion } : {}),
});

const reconcileOpenclawPlugins = ({
  rootDir,
  openclawDir,
  fsModule = fs,
  execSyncImpl = execSync,
  logger = console,
  manifestPath = kDefaultManifestPath,
  openclawCliPath = resolveOpenclawCliPath(),
  env = process.env,
  now = () => new Date().toISOString(),
} = {}) => {
  if (!rootDir) throw new Error("rootDir is required");
  if (!openclawDir) throw new Error("openclawDir is required");
  fsModule.mkdirSync(openclawDir, { recursive: true });

  const manifest = loadOpenclawCompatibilityManifest({
    fsModule,
    manifestPath,
  });
  const lockPath = buildLockPath({ openclawDir });
  const previousLock = readManagedPluginLock({ fsModule, lockPath });
  const openclawEnv = buildOpenclawEnv({ rootDir, openclawDir, env });
  const commandOptions = {
    cwd: openclawDir,
    env: openclawEnv,
    execSyncImpl,
    openclawCliPath,
  };
  const detectedOpenclawVersion = detectOpenclawVersion(commandOptions);
  const upgradeFromOpenclawVersion =
    previousLock?.openclawVersion || detectedOpenclawVersion;
  const targetOpenclawVersion = manifest.openclawVersion;
  const appliedMigrations = (manifest.migrations || []).filter((migration) =>
    satisfiesVersionRange(
      upgradeFromOpenclawVersion,
      migration.whenUpgradingFromOpenclaw,
    ),
  );
  const installedPlugins = listInstalledPlugins(commandOptions);
  const config = readOpenclawConfig({
    fsModule,
    openclawDir,
    fallback: {},
  });
  const pluginRelevance = {};
  const pluginKeys = Object.entries(manifest.managedPlugins)
    .filter(([key, definition]) => {
      const installed = findInstalledPlugin(installedPlugins, key, definition);
      const reasons = getPluginRelevanceReasons({
        config,
        key,
        definition,
        installed,
        previousLock,
      });
      pluginRelevance[key] = reasons;
      return reasons.length > 0;
    })
    .map(([key]) => key);
  const reconciledAt = now();
  const pluginResults = [];
  const nextLockPlugins = {};

  logger.log(`[alphaclaw] Current OpenClaw: ${detectedOpenclawVersion}`);
  logger.log(`[alphaclaw] Target OpenClaw: ${targetOpenclawVersion}`);
  if (upgradeFromOpenclawVersion !== detectedOpenclawVersion) {
    logger.log(
      `[alphaclaw] Previous managed OpenClaw: ${upgradeFromOpenclawVersion}`,
    );
  }
  if (pluginKeys.length === 0) {
    logger.log("[alphaclaw] No relevant managed OpenClaw plugins detected");
  } else {
    logger.log(
      `[alphaclaw] Relevant managed OpenClaw plugins: ${pluginKeys.join(", ")}`,
    );
  }

  for (const key of pluginKeys) {
    const definition = manifest.managedPlugins[key];
    if (!definition) {
      throw new Error(`Migration references unknown managed plugin: ${key}`);
    }
    const installed = findInstalledPlugin(installedPlugins, key, definition);
    const installedVersion = installed?.version || "";
    const previousVersion =
      installedVersion || previousLock?.plugins?.[key]?.version || "";
    const installSpec = buildInstallSpec(definition);
    const needsInstall = installedVersion !== definition.version;
    const action = !installed
      ? "installed"
      : needsInstall
        ? "updated"
        : "skipped";

    if (needsInstall) {
      logger.log(
        `[alphaclaw] ${action === "updated" ? "Updating" : "Installing"} ${key}: ${definition.package}@${definition.version}`,
      );
      runOpenclawCommand({
        ...commandOptions,
        args: [
          "plugins",
          "install",
          installSpec,
          "--pin",
          ...(installed ? ["--force"] : []),
        ],
      });
    } else {
      logger.log(
        `[alphaclaw] Skipping ${key}: ${definition.package}@${definition.version} already installed`,
      );
    }

    pluginResults.push({
      id: key,
      package: definition.package,
      version: definition.version,
      previousVersion,
      action,
      reasons: pluginRelevance[key] || [],
    });
    nextLockPlugins[key] = buildLockPluginEntry({
      definition,
      installedAt: previousLock?.plugins?.[key]?.installedAt || reconciledAt,
      action,
      previousVersion,
    });
  }

  const lock = {
    schemaVersion: 1,
    managedBy: "alphaclaw",
    alphaclawVersion: manifest.alphaclawVersion,
    openclawVersion: targetOpenclawVersion,
    reconciledAt,
    plugins: nextLockPlugins,
  };
  writeManagedPluginLock({ fsModule, lockPath, lock });

  logger.log("[alphaclaw] OpenClaw plugin reconciliation complete");
  return {
    manifest,
    lock,
    lockPath,
    currentOpenclawVersion: detectedOpenclawVersion,
    upgradeFromOpenclawVersion,
    targetOpenclawVersion,
    appliedMigrations,
    plugins: pluginResults,
  };
};

module.exports = {
  buildInstallSpec,
  buildLockPath,
  compareVersions,
  detectOpenclawVersion,
  loadOpenclawCompatibilityManifest,
  parsePluginList,
  reconcileOpenclawPlugins,
  satisfiesVersionRange,
};
