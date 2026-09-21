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

  // OpenClaw 2026.9 retired `plugins.bundledDiscovery` from the config file:
  // the mode now lives in `config_machine_state` (Doctor migrates the 7.1
  // value there) and a config carrying the key fails validation, which broke
  // every post-Doctor reconcile on the G2 upgrade instance. Never write it.
  //
  // Without that discovery mode nothing enables the SearXNG plugin on a
  // fresh 2026.9 host, and OpenClaw's web_search auto-detection only picks
  // providers that carry a credential, which SearXNG does not. G3 (2026-09-21)
  // provisioned with the plugin installed but disabled and no provider
  // selected. Enable the plugin, allow it where an allow-list is in force,
  // and name it as the provider; the plugin reads SEARXNG_BASE_URL itself.
  const plugins = ensureObjectPath(cfg, ["plugins"]);
  const entries = ensureObjectPath(plugins, ["entries"]);
  entries.searxng = {
    ...(entries.searxng && typeof entries.searxng === "object"
      ? entries.searxng
      : {}),
    enabled: true,
  };
  if (Array.isArray(plugins.allow) && !plugins.allow.includes("searxng")) {
    plugins.allow.push("searxng");
  }
  search.provider = "searxng";

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
