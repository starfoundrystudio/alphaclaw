const fs = require("fs");
const path = require("path");
const {
  ALPHACLAW_DIR,
  kFallbackOnboardingModels,
} = require("./constants");
const { getCommandOutputCandidates } = require("./utils/command-output");

const kModelCatalogCacheVersion = 2;
const kModelCatalogRefreshBackoffMs = 30 * 1000;
const kModelCatalogLoadTimeoutMs = 120 * 1000;
const kModelCatalogMaxAgeMs = 5 * 60 * 1000;
const kModelCatalogBootstrapSource = "bootstrap";
const kDefaultCachePath = path.join(ALPHACLAW_DIR, "cache", "model-catalog.json");

const createResponse = ({
  source = "fallback",
  fetchedAt = null,
  stale = false,
  refreshing = false,
  models = [],
  accessModes = null,
  agentId = null,
  providerOutcomes = [],
  refreshFailed = false,
  warning = null,
} = {}) => ({
  ok: true,
  source,
  fetchedAt,
  stale,
  refreshing,
  models,
  ...(agentId ? { agentId } : {}),
  ...(providerOutcomes.length > 0 ? { providerOutcomes } : {}),
  ...(refreshFailed ? { refreshFailed: true } : {}),
  ...(warning ? { warning } : {}),
  ...(accessModes ? { accessModes } : {}),
});

const normalizeOpenclawVersion = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

const normalizeCachedModels = ({
  models,
  normalizeOnboardingModels = (items) => items,
} = {}) =>
  normalizeOnboardingModels(
    (Array.isArray(models) ? models : []).map((model) => ({
      key: model?.key,
      name: model?.label || model?.name || model?.key,
    })),
  );

const normalizeProviderOutcomes = (value) =>
  (Array.isArray(value) ? value : []).filter(
    (outcome) => outcome && typeof outcome === "object" && !Array.isArray(outcome),
  );

const normalizeWarning = (value) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
};

const getCatalogWarning = ({ warning, refreshFailed, providerOutcomes }) => {
  const explicitWarning = normalizeWarning(warning);
  if (explicitWarning) return explicitWarning;
  const failedCount = normalizeProviderOutcomes(providerOutcomes).filter(
    (outcome) => String(outcome?.status || "").trim().toLowerCase() !== "ready",
  ).length;
  if (failedCount > 0) {
    return `${failedCount} provider catalog refresh${failedCount === 1 ? "" : "es"} did not complete successfully.`;
  }
  if (refreshFailed) {
    return "OpenClaw kept the last published model inventory after a catalog refresh failure.";
  }
  return null;
};

const normalizeCacheEntry = ({
  raw,
  normalizeOnboardingModels = (items) => items,
} = {}) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.version !== kModelCatalogCacheVersion) return null;
  const fetchedAt = Number(raw.fetchedAt || 0);
  const models = normalizeCachedModels({
    models: raw.models,
    normalizeOnboardingModels,
  });
  if (
    !Number.isFinite(fetchedAt) ||
    fetchedAt <= 0 ||
    !Array.isArray(raw.models)
  ) {
    return null;
  }
  return {
    version: kModelCatalogCacheVersion,
    fetchedAt,
    openclawVersion: normalizeOpenclawVersion(raw.openclawVersion),
    models,
    agentId: normalizeOpenclawVersion(raw.agentId),
    providerOutcomes: normalizeProviderOutcomes(raw.providerOutcomes),
    refreshFailed: raw.refreshFailed === true,
    warning: getCatalogWarning(raw),
  };
};

const parseCatalogPayloadFromOutput = ({
  rawOutput,
  parseJsonFromNoisyOutput = () => ({}),
  normalizeOnboardingModels = (items) => items,
} = {}) => {
  const parsed = parseJsonFromNoisyOutput(rawOutput);
  if (!parsed || !Array.isArray(parsed.models)) return null;
  const providerOutcomes = normalizeProviderOutcomes(parsed.providerOutcomes);
  const refreshFailed = parsed.refreshFailed === true;
  return {
    models: normalizeOnboardingModels(parsed.models),
    agentId: normalizeOpenclawVersion(parsed.agentId),
    providerOutcomes,
    refreshFailed,
    warning: getCatalogWarning({
      warning: parsed.warning,
      refreshFailed,
      providerOutcomes,
    }),
  };
};

const parseCatalogModelsFromOutput = (options = {}) =>
  parseCatalogPayloadFromOutput(options)?.models || [];

const getModelKey = (model) => String(model?.key || "").trim();

const hasExplicitAccessModes = (model) =>
  Array.isArray(model?.accessModes) && model.accessModes.length > 0;

const mergeModelCatalogModels = ({
  models = [],
  fallbackModels = [],
  enabled = false,
} = {}) => {
  const dynamicModels = Array.isArray(models) ? models : [];
  const supportModels = Array.isArray(fallbackModels) ? fallbackModels : [];
  if (!enabled || supportModels.length === 0) return dynamicModels;
  const supportByKey = new Map();
  for (const model of supportModels) {
    const key = getModelKey(model);
    if (!key) continue;
    supportByKey.set(key, model);
  }
  const mergedByKey = new Map();
  for (const model of dynamicModels) {
    const key = getModelKey(model);
    if (!key) continue;
    const existing = supportByKey.get(key) || {};
    mergedByKey.set(key, {
      ...existing,
      ...model,
      provider: model.provider || existing.provider,
      label: model.label || model.name || existing.label || existing.name || key,
      name: model.name || model.label || existing.name || existing.label || key,
      accessModes: hasExplicitAccessModes(model)
        ? model.accessModes
        : existing.accessModes,
      accessLabel: model.accessLabel || existing.accessLabel,
      recommendation: model.recommendation || existing.recommendation,
      recommendedAccessModes:
        model.recommendedAccessModes || existing.recommendedAccessModes,
    });
  }
  return [...mergedByKey.values()];
};

const createModelCatalogCache = ({
  fsModule = fs,
  pathModule = path,
  shellCmd,
  gatewayEnv = () => ({}),
  parseJsonFromNoisyOutput = () => ({}),
  normalizeOnboardingModels = (items) => items,
  readOpenclawVersion = () => null,
  shouldStartDynamicRefresh = () => true,
  fallbackModels = kFallbackOnboardingModels,
  fallbackAccessModes = null,
  cachePath = kDefaultCachePath,
  refreshBackoffMs = kModelCatalogRefreshBackoffMs,
  maxAgeMs = kModelCatalogMaxAgeMs,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) => {
  let cacheLoaded = false;
  let memoryCache = null;
  let cacheIsStale = false;
  let refreshPromise = null;
  let retryTimer = null;
  let backoffUntilMs = 0;

  const readCurrentOpenclawVersion = ({ refresh = false } = {}) => {
    try {
      return normalizeOpenclawVersion(readOpenclawVersion({ refresh }));
    } catch {
      return null;
    }
  };

  const isCompatibleWithCurrentOpenclaw = ({
    entry,
    currentOpenclawVersion,
  } = {}) => {
    if (!entry) return false;
    if (!currentOpenclawVersion) return true;
    return entry.openclawVersion === currentOpenclawVersion;
  };

  const clearRetryTimer = () => {
    if (!retryTimer) return;
    clearTimeoutFn(retryTimer);
    retryTimer = null;
  };

  const isRefreshPending = () => !!refreshPromise || !!retryTimer;

  const canStartDynamicRefresh = () => {
    try {
      return shouldStartDynamicRefresh() !== false;
    } catch {
      return false;
    }
  };

  const getResponseModels = (models = []) =>
    mergeModelCatalogModels({
      models,
      fallbackModels,
      enabled: !!fallbackAccessModes,
    });

  const setCacheEntry = (entry, { fresh = false } = {}) => {
    memoryCache = entry;
    cacheLoaded = true;
    cacheIsStale = !fresh;
    backoffUntilMs = 0;
    clearRetryTimer();
    return memoryCache;
  };

  const isExpired = (entry) =>
    !!entry &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= 0 &&
    now() - Number(entry.fetchedAt || 0) >= maxAgeMs;

  const readDiskCache = () => {
    if (cacheLoaded) return memoryCache;
    cacheLoaded = true;
    try {
      const raw = JSON.parse(fsModule.readFileSync(cachePath, "utf8"));
      const entry = normalizeCacheEntry({
        raw,
        normalizeOnboardingModels,
      });
      if (!entry) return null;
      memoryCache = entry;
      cacheIsStale = true;
      return memoryCache;
    } catch {
      memoryCache = null;
      cacheIsStale = false;
      return null;
    }
  };

  const writeDiskCache = (entry) => {
    fsModule.mkdirSync(pathModule.dirname(cachePath), { recursive: true });
    fsModule.writeFileSync(
      cachePath,
      `${JSON.stringify(entry, null, 2)}\n`,
      "utf8",
    );
  };

  const loadFreshCatalog = async ({ discoverProviders = false } = {}) => {
    const openclawVersion = readCurrentOpenclawVersion({ refresh: true });
    let payload = null;
    let recoveredFromCommandError = false;
    const command = `openclaw models list --all${discoverProviders ? " --refresh" : ""} --json`;
    try {
      const output = await shellCmd(command, {
        env: gatewayEnv(),
        timeout: kModelCatalogLoadTimeoutMs,
      });
      payload = parseCatalogPayloadFromOutput({
        rawOutput: output,
        parseJsonFromNoisyOutput,
        normalizeOnboardingModels,
      });
    } catch (err) {
      for (const rawOutput of getCommandOutputCandidates(err)) {
        payload = parseCatalogPayloadFromOutput({
          rawOutput,
          parseJsonFromNoisyOutput,
          normalizeOnboardingModels,
        });
        if (payload) {
          recoveredFromCommandError = true;
          logger.warn?.(
            `[models] Recovered model catalog from failed command output: ${err.message || String(err)}`,
          );
          break;
        }
      }
      if (!payload) throw err;
    }
    if (!payload) throw new Error("OpenClaw returned an invalid model catalog payload");
    const entry = {
      version: kModelCatalogCacheVersion,
      fetchedAt: now(),
      openclawVersion,
      models: payload.models,
      agentId: payload.agentId,
      providerOutcomes: payload.providerOutcomes,
      refreshFailed: payload.refreshFailed,
      warning: payload.warning,
    };
    writeDiskCache(entry);
    setCacheEntry(entry, { fresh: true });
    if (recoveredFromCommandError) {
      backoffUntilMs = 0;
      clearRetryTimer();
    }
    return entry;
  };

  const scheduleRetry = () => {
    if (!canStartDynamicRefresh()) {
      clearRetryTimer();
      return;
    }
    if (retryTimer) return;
    const delayMs = Math.max(backoffUntilMs - now(), 0);
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      if (!canStartDynamicRefresh()) return;
      if (refreshPromise) return;
      if (memoryCache && !cacheIsStale) return;
      void startBackgroundRefresh();
    }, delayMs);
    if (typeof retryTimer?.unref === "function") retryTimer.unref();
  };

  const handleRefreshFailure = (err) => {
    backoffUntilMs = now() + refreshBackoffMs;
    scheduleRetry();
    if (memoryCache) {
      cacheIsStale = true;
      logger.error?.(
        `[models] Failed to refresh cached models: ${err.message || String(err)}`,
      );
      return;
    }
    logger.error?.(
      `[models] Failed to load dynamic models: ${err.message || String(err)}`,
    );
  };

  const startBackgroundRefresh = () => {
    if (!canStartDynamicRefresh()) {
      clearRetryTimer();
      return null;
    }
    readDiskCache();
    if (refreshPromise) return refreshPromise;
    if (retryTimer) return null;
    if (backoffUntilMs > now()) {
      scheduleRetry();
      return null;
    }
    refreshPromise = Promise.resolve()
      .then(() => loadFreshCatalog())
      .catch((err) => {
        handleRefreshFailure(err);
        return null;
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  };

  return {
    async getCatalogResponse() {
      readDiskCache();
      if (memoryCache && !cacheIsStale) {
        const currentOpenclawVersion = readCurrentOpenclawVersion({
          refresh: true,
        });
        if (
          !isCompatibleWithCurrentOpenclaw({
            entry: memoryCache,
            currentOpenclawVersion,
          })
        ) {
          cacheIsStale = true;
          backoffUntilMs = 0;
          clearRetryTimer();
        }
      }
      if (memoryCache && !cacheIsStale && isExpired(memoryCache)) {
        cacheIsStale = true;
      }
      if (memoryCache && !cacheIsStale) {
        return createResponse({
          source: "openclaw",
          fetchedAt: memoryCache.fetchedAt,
          stale: false,
          refreshing: false,
          models: getResponseModels(memoryCache.models),
          accessModes: fallbackAccessModes,
          agentId: memoryCache.agentId,
          providerOutcomes: memoryCache.providerOutcomes,
          refreshFailed: memoryCache.refreshFailed,
          warning: memoryCache.warning,
        });
      }
      if (memoryCache) {
        const didStartRefresh = !!startBackgroundRefresh();
        return createResponse({
          source: "cache",
          fetchedAt: memoryCache.fetchedAt,
          stale: true,
          refreshing:
            canStartDynamicRefresh() && (didStartRefresh || isRefreshPending()),
          models: getResponseModels(memoryCache.models),
          accessModes: fallbackAccessModes,
          agentId: memoryCache.agentId,
          providerOutcomes: memoryCache.providerOutcomes,
          refreshFailed: memoryCache.refreshFailed,
          warning: memoryCache.warning,
        });
      }
      const didStartRefresh = !!startBackgroundRefresh();
      return createResponse({
        source: kModelCatalogBootstrapSource,
        fetchedAt: null,
        stale: true,
        refreshing:
          canStartDynamicRefresh() && (didStartRefresh || isRefreshPending()),
        models: fallbackModels,
        accessModes: fallbackAccessModes,
      });
    },

    async refreshProviderInventory() {
      if (!canStartDynamicRefresh()) {
        throw new Error("Model discovery is unavailable before onboarding completes");
      }
      clearRetryTimer();
      backoffUntilMs = 0;
      if (refreshPromise) await refreshPromise;
      refreshPromise = Promise.resolve().then(() =>
        loadFreshCatalog({ discoverProviders: true }),
      );
      try {
        const entry = await refreshPromise;
        return createResponse({
          source: "openclaw",
          fetchedAt: entry.fetchedAt,
          stale: false,
          refreshing: false,
          models: getResponseModels(entry.models),
          accessModes: fallbackAccessModes,
          agentId: entry.agentId,
          providerOutcomes: entry.providerOutcomes,
          refreshFailed: entry.refreshFailed,
          warning: entry.warning,
        });
      } catch (err) {
        handleRefreshFailure(err);
        throw err;
      } finally {
        refreshPromise = null;
      }
    },

    markStale() {
      readDiskCache();
      if (!memoryCache) return;
      cacheIsStale = true;
      backoffUntilMs = 0;
      clearRetryTimer();
    },
  };
};

module.exports = {
  createModelCatalogCache,
  createResponse,
  mergeModelCatalogModels,
  normalizeCachedModels,
  normalizeCacheEntry,
  parseCatalogPayloadFromOutput,
  kModelCatalogCacheVersion,
  kModelCatalogRefreshBackoffMs,
  kModelCatalogLoadTimeoutMs,
  kModelCatalogMaxAgeMs,
  kModelCatalogBootstrapSource,
  kDefaultCachePath,
};
