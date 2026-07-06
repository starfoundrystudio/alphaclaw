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

export const getModelCatalogModels = (payload) =>
  Array.isArray(payload?.models) ? payload.models : [];

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
