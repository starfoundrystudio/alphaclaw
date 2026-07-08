"use strict";

const kSearxngBaseUrlEnvKey = "SEARXNG_BASE_URL";

const isPlainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

const normalizeString = (value) => String(value || "").trim();

const hasSearxngBaseUrlEnv = (env = process.env) =>
  !!normalizeString(env?.[kSearxngBaseUrlEnvKey]);

const ensureObjectPath = (target, pathParts) => {
  let cursor = target;
  for (const part of pathParts) {
    if (!isPlainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  return cursor;
};

const applyManagedSearxngWebSearchFallback = ({
  cfg,
  env = process.env,
  preserveExplicitGlobalDisable = false,
} = {}) => {
  if (!cfg || !hasSearxngBaseUrlEnv(env)) return false;
  if (preserveExplicitGlobalDisable && cfg.tools?.web?.search?.enabled === false) {
    return false;
  }

  const existingProvider = normalizeString(cfg.tools?.web?.search?.provider);
  if (existingProvider) return false;

  const before = JSON.stringify({
    tools: cfg.tools,
    plugins: cfg.plugins,
  });

  const search = ensureObjectPath(cfg, ["tools", "web", "search"]);
  search.enabled = true;

  const plugins = ensureObjectPath(cfg, ["plugins"]);
  if (!normalizeString(plugins.bundledDiscovery)) {
    plugins.bundledDiscovery = "compat";
  }

  return (
    before !==
    JSON.stringify({
      tools: cfg.tools,
      plugins: cfg.plugins,
    })
  );
};

module.exports = {
  kSearxngBaseUrlEnvKey,
  applyManagedSearxngWebSearchFallback,
  hasSearxngBaseUrlEnv,
};
