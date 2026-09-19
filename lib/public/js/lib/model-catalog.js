import { fetchModels } from "./api.js";
import { cachedFetch } from "./api-cache.js";
import {
  getDefaultModelAccessMode,
  getFeaturedModels,
  getInitialModelKeyForAccessMode,
  getOnboardingModelCatalog,
} from "./model-config.js";

export const kModelCatalogCacheKey = "/api/models";
export const kModelCatalogPollIntervalMs = 3000;

const normalizeAccessModeList = (value) =>
  Array.isArray(value)
    ? value.map((mode) => String(mode || "").trim()).filter(Boolean)
    : [];

// OpenClaw 2026.9 publishes the Gateway inventory of the *configured*
// providers as `models`, and every other provider's catalog per access mode
// under `accessModes[mode].providers[].models`. Consumers (Add Model, the
// Models tab, the welcome wizard) need one flat catalog, so merge both:
// inventory entries win on key, per-mode entries contribute their mode.
export const getModelCatalogModels = (payload) => {
  const inventory = Array.isArray(payload?.models) ? payload.models : [];
  const accessModes =
    payload?.accessModes && typeof payload.accessModes === "object"
      ? payload.accessModes
      : null;
  if (!accessModes) return inventory;

  const byKey = new Map();
  const merged = [];
  for (const model of inventory) {
    const key = String(model?.key || "").trim();
    if (!key || byKey.has(key)) continue;
    const entry = { ...model };
    byKey.set(key, entry);
    merged.push(entry);
  }
  for (const [mode, group] of Object.entries(accessModes)) {
    const normalizedMode = String(mode || "").trim();
    const providers = Array.isArray(group?.providers) ? group.providers : [];
    for (const provider of providers) {
      const models = Array.isArray(provider?.models) ? provider.models : [];
      for (const model of models) {
        const key = String(model?.key || "").trim();
        if (!key) continue;
        const existing = byKey.get(key);
        if (existing) {
          const modes = normalizeAccessModeList(existing.accessModes);
          if (normalizedMode && !modes.includes(normalizedMode)) {
            existing.accessModes = [...modes, normalizedMode];
          }
          continue;
        }
        const modes = normalizeAccessModeList(model.accessModes);
        const entry = {
          ...model,
          provider: model.provider || provider.id || key.split("/")[0],
          accessModes:
            normalizedMode && !modes.includes(normalizedMode)
              ? [...modes, normalizedMode]
              : modes,
        };
        byKey.set(key, entry);
        merged.push(entry);
      }
    }
  }
  return merged;
};

export const getModelCatalogAccessModes = (payload) =>
  payload?.accessModes && typeof payload.accessModes === "object"
    ? payload.accessModes
    : null;

export const isModelCatalogRefreshing = (payload) =>
  Boolean(payload?.refreshing);

export const preloadModelCatalog = ({
  force = true,
  maxAgeMs = 30000,
} = {}) =>
  cachedFetch(kModelCatalogCacheKey, fetchModels, {
    force,
    maxAgeMs,
  });

export const getInitialOnboardingModelKey = ({
  catalog = [],
  currentModelKey = "",
} = {}) => {
  const normalizedCurrent = String(currentModelKey || "").trim();
  if (normalizedCurrent) return normalizedCurrent;
  const onboardingCatalog = getOnboardingModelCatalog(catalog);
  const defaultAccessMode = getDefaultModelAccessMode();
  const defaultAccessModeModel = getInitialModelKeyForAccessMode({
    models: onboardingCatalog,
    accessMode: defaultAccessMode,
  });
  if (defaultAccessModeModel) return defaultAccessModeModel;
  const featuredModels = getFeaturedModels(catalog);
  return String(featuredModels[0]?.key || catalog[0]?.key || "");
};
