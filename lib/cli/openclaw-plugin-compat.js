"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const {
  readOpenclawConfig,
  resolveOpenclawConfigPath,
  writeOpenclawConfig,
} = require("../server/openclaw-config");

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

const configContainsAgentRuntime = (config, ids) => {
  let found = false;
  walkConfig(config, ({ key, value }) => {
    if (found || key !== "agentRuntime") return;
    if (typeof value === "string" && ids.includes(value)) {
      found = true;
      return;
    }
    if (
      isPlainObject(value) &&
      typeof value.id === "string" &&
      ids.includes(value.id)
    ) {
      found = true;
    }
  });
  return found;
};

const isPathPrefix = (pathParts, prefix) =>
  prefix.every((part, index) => pathParts[index] === part);

const isProtectedPluginConfigPath = (pathParts) =>
  pathParts[0] === "plugins" &&
  pathParts[1] === "entries" &&
  pathParts.length >= 4 &&
  pathParts[3] === "config";

const isProtectedProviderConfigPath = (pathParts, providerIds) =>
  pathParts[0] === "models" &&
  pathParts[1] === "providers" &&
  providerIds.includes(pathParts[2]);

const hasPath = (target, pathParts) => {
  let cursor = target;
  for (const part of pathParts) {
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) return false;
    if (!hasOwn(cursor, part)) return false;
    cursor = cursor[part];
  }
  return true;
};

const getPath = (target, pathParts) => {
  let cursor = target;
  for (const part of pathParts) {
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
};

const setPath = (target, pathParts, value) => {
  if (pathParts.length === 0) return;
  let cursor = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const part = pathParts[index];
    const nextPart = pathParts[index + 1];
    if (!isPlainObject(cursor[part]) && !Array.isArray(cursor[part])) {
      cursor[part] = /^\d+$/.test(nextPart) ? [] : {};
    }
    cursor = cursor[part];
  }
  cursor[pathParts[pathParts.length - 1]] = value;
};

const unsetPath = (target, pathParts) => {
  if (pathParts.length === 0) return;
  const parentPath = pathParts.slice(0, -1);
  const key = pathParts[pathParts.length - 1];
  const parent = parentPath.length > 0 ? getPath(target, parentPath) : target;
  if (Array.isArray(parent) && /^\d+$/.test(key)) {
    parent.splice(Number(key), 1);
    return;
  }
  if (isPlainObject(parent) || Array.isArray(parent)) {
    delete parent[key];
  }
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

const uniqueStrings = (values = []) =>
  [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];

const getContractIds = (definition, keys) =>
  uniqueStrings(
    keys.flatMap((key) =>
      Array.isArray(definition.contracts?.[key])
        ? definition.contracts[key]
        : [],
    ),
  );

const getProviderReferenceIds = (definition) =>
  uniqueStrings([
    ...(definition.providerIds || []),
    ...(definition.providerAliases || []),
  ]);

const getWebSearchProviderIds = (definition) =>
  uniqueStrings([
    ...(definition.webSearchProviderIds || []),
    ...getContractIds(definition, ["webSearchProviders"]),
  ]);

const getWebFetchProviderIds = (definition) =>
  getContractIds(definition, ["webFetchProviders"]);

const getMemoryProviderIds = (definition) =>
  getContractIds(definition, [
    "embeddingProviders",
    "memoryEmbeddingProviders",
  ]);

const getSpeechProviderIds = (definition) =>
  getContractIds(definition, ["speechProviders"]);

const getMediaProviderIds = (definition) =>
  getContractIds(definition, [
    "mediaUnderstandingProviders",
    "imageGenerationProviders",
    "videoGenerationProviders",
  ]);

const getAllProviderSelectorIds = (definition) =>
  uniqueStrings([
    ...getProviderReferenceIds(definition),
    ...getWebSearchProviderIds(definition),
    ...getWebFetchProviderIds(definition),
    ...getMemoryProviderIds(definition),
    ...getSpeechProviderIds(definition),
    ...getMediaProviderIds(definition),
  ]);

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
  const providerIds = getProviderReferenceIds(definition);
  if (providerIds.length > 0) {
    for (const providerId of providerIds) {
      if (hasOwn(config.models?.providers, providerId)) {
        reasons.push(`models.providers.${providerId}`);
      }
    }
    if (configContainsProviderRef(config, providerIds)) {
      reasons.push("provider-reference");
    }
  }
  const webSearchProviderIds = getWebSearchProviderIds(definition);
  if (webSearchProviderIds.length > 0) {
    if (configContainsProviderRef(config, webSearchProviderIds)) {
      reasons.push("web-search-provider-reference");
    }
  }
  const contractProviderGroups = [
    {
      ids: getWebFetchProviderIds(definition),
      reason: "web-fetch-provider-reference",
    },
    {
      ids: getMemoryProviderIds(definition),
      reason: "memory-provider-reference",
    },
    {
      ids: getSpeechProviderIds(definition),
      reason: "speech-provider-reference",
    },
    {
      ids: getMediaProviderIds(definition),
      reason: "media-provider-reference",
    },
  ];
  for (const group of contractProviderGroups) {
    if (
      group.ids.length > 0 &&
      configContainsProviderRef(config, group.ids)
    ) {
      reasons.push(group.reason);
    }
  }
  if (configContainsBackend(config, pluginIds)) {
    reasons.push("backend-reference");
  }
  if (configContainsAgentRuntime(config, pluginIds)) {
    reasons.push("agent-runtime-reference");
  }
  return [...new Set(reasons)];
};

const buildInstallSpec = (definition) =>
  `npm:${definition.install?.exactNpmSpec || `${definition.package}@${definition.version}`}`;

const getManagedPluginReferenceIds = (key, definition) =>
  [
    key,
    definition.pluginId,
    definition.package,
    definition.install?.npmSpec,
    definition.install?.exactNpmSpec,
    buildInstallSpec(definition),
  ]
    .filter(Boolean)
    .map(String);

const cloneJsonValue = (value) =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const cloneConfig = (config) =>
  config === undefined ? {} : cloneJsonValue(config);

const collectConfigSuppressionsForManagedPlugin = ({
  config,
  key,
  definition,
} = {}) => {
  const suppressions = [];
  const seen = new Set();
  const pluginIds = getManagedPluginReferenceIds(key, definition);
  const providerIds = getProviderReferenceIds(definition);
  const webSearchProviderIds = getWebSearchProviderIds(definition);
  const webFetchProviderIds = getWebFetchProviderIds(definition);
  const memoryProviderIds = getMemoryProviderIds(definition);
  const speechProviderIds = getSpeechProviderIds(definition);
  const mediaProviderIds = getMediaProviderIds(definition);
  const allProviderSelectorIds = getAllProviderSelectorIds(definition);
  const addSuppression = (pathParts, reason) => {
    if (!hasPath(config, pathParts)) return;
    const pathKey = pathParts.join(".");
    if (seen.has(pathKey)) return;
    seen.add(pathKey);
    suppressions.push({
      pathParts,
      previousValue: cloneJsonValue(getPath(config, pathParts)),
      action: "unset",
      reason,
    });
  };
  const isProtectedPath = (pathParts) =>
    isProtectedPluginConfigPath(pathParts) ||
    isProtectedProviderConfigPath(pathParts, allProviderSelectorIds) ||
    isPathPrefix(pathParts, ["channels"]);

  if (webSearchProviderIds.includes(config.tools?.web?.search?.provider)) {
    addSuppression(
      ["tools", "web", "search", "provider"],
      "web-search-provider-reference",
    );
  }

  if (webFetchProviderIds.includes(config.tools?.web?.fetch?.provider)) {
    addSuppression(
      ["tools", "web", "fetch", "provider"],
      "web-fetch-provider-reference",
    );
  }

  const maybeSuppressProviderRef = ({ key: fieldKey, value, pathParts, ids, reason }) => {
    if (typeof value !== "string" || isProtectedPath(pathParts)) return;
    if (ids.some((id) => value.startsWith(`${id}/`))) {
      addSuppression(pathParts, reason);
      return;
    }
    if (
      /provider/i.test(fieldKey) &&
      ids.some((id) => value === id || value.startsWith(`${id}:`))
    ) {
      addSuppression(pathParts, reason);
    }
  };

  if (config.plugins?.slots) {
    walkConfig(config.plugins.slots, ({ value, pathParts }) => {
      if (typeof value === "string" && pluginIds.includes(value)) {
        addSuppression(["plugins", "slots"].concat(pathParts), "plugins.slots");
      }
    });
  }

  walkConfig(config, ({ key: fieldKey, value, pathParts }) => {
    if (isProtectedPath(pathParts)) return;
    if (
      fieldKey === "backend" &&
      typeof value === "string" &&
      pluginIds.includes(value)
    ) {
      addSuppression(pathParts, "backend-reference");
      return;
    }
    if (fieldKey === "agentRuntime") {
      if (typeof value === "string" && pluginIds.includes(value)) {
        addSuppression(pathParts, "agent-runtime-reference");
        return;
      }
      if (
        isPlainObject(value) &&
        typeof value.id === "string" &&
        pluginIds.includes(value.id)
      ) {
        addSuppression(pathParts.concat("id"), "agent-runtime-reference");
        return;
      }
    }
    maybeSuppressProviderRef({
      key: fieldKey,
      value,
      pathParts,
      ids: providerIds,
      reason: "provider-reference",
    });
    maybeSuppressProviderRef({
      key: fieldKey,
      value,
      pathParts,
      ids: webSearchProviderIds,
      reason: "web-search-provider-reference",
    });
    maybeSuppressProviderRef({
      key: fieldKey,
      value,
      pathParts,
      ids: webFetchProviderIds,
      reason: "web-fetch-provider-reference",
    });
    maybeSuppressProviderRef({
      key: fieldKey,
      value,
      pathParts,
      ids: memoryProviderIds,
      reason: "memory-provider-reference",
    });
    maybeSuppressProviderRef({
      key: fieldKey,
      value,
      pathParts,
      ids: speechProviderIds,
      reason: "speech-provider-reference",
    });
    maybeSuppressProviderRef({
      key: fieldKey,
      value,
      pathParts,
      ids: mediaProviderIds,
      reason: "media-provider-reference",
    });
  });

  return suppressions;
};

const applyConfigSuppressions = (config, suppressions = []) => {
  for (const suppression of suppressions) {
    if (suppression.action === "unset") {
      unsetPath(config, suppression.pathParts);
    }
  }
  return config;
};

const restoreConfigSuppressions = (latestConfig, suppressions = []) => {
  for (const suppression of suppressions) {
    if (suppression.action === "unset") {
      setPath(latestConfig, suppression.pathParts, suppression.previousValue);
    }
  }
  return latestConfig;
};

const isOpenclawConfigReferenceError = (error) => {
  const text = [
    error?.message,
    error?.stdout,
    error?.stderr,
    error?.output?.join?.("\n"),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return (
    /invalid[-\s]?config/.test(text) ||
    /(missing|unknown|unrecognized|not found).*(plugin|provider|backend|runtime|agent\s*runtime)/.test(
      text,
    )
  );
};

const writePreRecoveryConfigBackup = ({
  fsModule,
  openclawDir,
  now,
}) => {
  const configPath = resolveOpenclawConfigPath({ openclawDir });
  if (!fsModule.existsSync(configPath)) return null;
  const stamp = String(now()).replace(/[^0-9A-Za-z.-]/g, "-");
  const backupDir = path.join(openclawDir, ".alphaclaw");
  let backupPath = path.join(
    backupDir,
    `openclaw.pre-plugin-reconcile.${stamp}.bak`,
  );
  let index = 1;
  while (fsModule.existsSync(backupPath)) {
    backupPath = path.join(
      backupDir,
      `openclaw.pre-plugin-reconcile.${stamp}.${index}.bak`,
    );
    index += 1;
  }
  fsModule.mkdirSync(backupDir, { recursive: true });
  fsModule.copyFileSync(configPath, backupPath);
  return backupPath;
};

const installManagedPluginWithConfigSuppression = ({
  commandOptions,
  definition,
  fsModule,
  installed,
  key,
  logger,
  now,
  openclawDir,
}) => {
  const currentConfig = readOpenclawConfig({
    fsModule,
    openclawDir,
    fallback: {},
  });
  const suppressions = collectConfigSuppressionsForManagedPlugin({
    config: currentConfig,
    key,
    definition,
  });
  if (suppressions.length === 0) {
    throw new Error(
      `OpenClaw config validation failed while installing ${key}, and no safe managed-plugin references could be suppressed`,
    );
  }

  writePreRecoveryConfigBackup({ fsModule, openclawDir, now });
  const suppressedConfig = applyConfigSuppressions(
    cloneConfig(currentConfig),
    suppressions,
  );
  logger.log(
    `[alphaclaw] Retrying ${key} install with ${suppressions.length} temporary config reference suppression(s)`,
  );
  writeOpenclawConfig({ fsModule, openclawDir, config: suppressedConfig });
  try {
    const suppressedInstalled = findInstalledPlugin(
      listInstalledPlugins(commandOptions),
      key,
      definition,
    );
    runOpenclawCommand({
      ...commandOptions,
      args: [
        "plugins",
        "install",
        buildInstallSpec(definition),
        "--pin",
        ...(installed || suppressedInstalled ? ["--force"] : []),
      ],
    });
  } finally {
    const latestConfig = readOpenclawConfig({
      fsModule,
      openclawDir,
      fallback: suppressedConfig,
    });
    writeOpenclawConfig({
      fsModule,
      openclawDir,
      config: restoreConfigSuppressions(latestConfig, suppressions),
    });
  }
};

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
  let installedPlugins = listInstalledPlugins(commandOptions);
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
      try {
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
      } catch (error) {
        if (!isOpenclawConfigReferenceError(error)) {
          throw error;
        }
        installManagedPluginWithConfigSuppression({
          commandOptions,
          definition,
          fsModule,
          installed,
          key,
          logger,
          now,
          openclawDir,
        });
      }
      installedPlugins = listInstalledPlugins(commandOptions);
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
  collectConfigSuppressionsForManagedPlugin,
  applyConfigSuppressions,
  loadOpenclawCompatibilityManifest,
  parsePluginList,
  reconcileOpenclawPlugins,
  restoreConfigSuppressions,
  satisfiesVersionRange,
};
