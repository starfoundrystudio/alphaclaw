"use strict";

const { kBootstrapModelCatalog } = require("./constants");

const normalizeString = (value) => String(value || "").trim();

const getProviderFromModelKey = (modelKey) =>
  normalizeString(modelKey).split("/")[0] || "";

const getCatalogLookupKey = ({ modelKey, agentRuntimeId } = {}) => {
  const normalizedModelKey = normalizeString(modelKey);
  const runtimeId = normalizeString(agentRuntimeId);
  const parts = normalizedModelKey.split("/");
  if (runtimeId === "claude-cli" && parts[0] === "anthropic" && parts.length > 1) {
    return ["claude-cli", ...parts.slice(1)].join("/");
  }
  if (runtimeId === "codex" && parts[0] === "openai-codex" && parts.length > 1) {
    return ["openai", ...parts.slice(1)].join("/");
  }
  return normalizedModelKey;
};

const getPreferredAccessMode = ({ agentRuntimeId } = {}) => {
  const runtimeId = normalizeString(agentRuntimeId);
  if (runtimeId === "codex" || runtimeId === "claude-cli") return "subscription";
  return "";
};

const flattenCatalogEntries = (catalog = kBootstrapModelCatalog) => {
  const entries = [];
  const accessModes = catalog?.accessModes || {};
  for (const [accessMode, accessModeMeta] of Object.entries(accessModes)) {
    for (const providerMeta of accessModeMeta?.providers || []) {
      for (const model of providerMeta?.models || []) {
        entries.push({
          accessMode,
          accessModeMeta,
          provider: providerMeta.id || model.provider || getProviderFromModelKey(model.key),
          providerMeta,
          model,
        });
      }
    }
  }
  return entries;
};

const resolveCatalogEntryForModel = ({
  modelKey,
  agentRuntimeId,
  catalog = kBootstrapModelCatalog,
} = {}) => {
  const lookupKey = getCatalogLookupKey({ modelKey, agentRuntimeId });
  const preferredAccessMode = getPreferredAccessMode({ agentRuntimeId });
  const matches = flattenCatalogEntries(catalog).filter(
    (entry) => normalizeString(entry.model?.key) === lookupKey,
  );
  if (matches.length === 0) return null;
  if (preferredAccessMode) {
    const preferred = matches.find((entry) => entry.accessMode === preferredAccessMode);
    if (preferred) return preferred;
  }
  return matches.find((entry) => entry.accessMode === "provider-api") || matches[0];
};

const getRequiredPluginsForCatalogEntry = (entry) =>
  Array.isArray(entry?.providerMeta?.requiredPlugins)
    ? entry.providerMeta.requiredPlugins.map(normalizeString).filter(Boolean)
    : [];

const getEnvKeysForCatalogEntry = (entry) =>
  Array.isArray(entry?.providerMeta?.envKeys)
    ? entry.providerMeta.envKeys.map(normalizeString).filter(Boolean)
    : [];

module.exports = {
  flattenCatalogEntries,
  getCatalogLookupKey,
  getEnvKeysForCatalogEntry,
  getProviderFromModelKey,
  getRequiredPluginsForCatalogEntry,
  resolveCatalogEntryForModel,
};
