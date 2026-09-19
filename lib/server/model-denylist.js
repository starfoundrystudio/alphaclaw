"use strict";

// Models the managed product must never offer, whichever provider or gateway
// publishes them. Subscription access to GPT-5.5 was terminated upstream
// (2026-09) and customers who had it selected lost service, so the key is
// denied everywhere: the bundled bootstrap catalog (pack time), the
// Gateway-published inventory (runtime), pinned recommendations, and model
// selection writes. Match the model id after any gateway prefix so
// `openai/gpt-5.5`, `vercel-ai-gateway/openai/gpt-5.5-pro`,
// `openrouter/openai/gpt-5.5:batch` and `kilocode/openai/gpt-5.5` all match.
// Resellers spell the id differently (Venice publishes `openai-gpt-55`), so
// the separator between vendor and model and the dot in the version are both
// optional. Catalog rows are additionally denied by label so a reseller alias
// we have not seen yet still cannot surface a "GPT-5.5" entry.
const kDeniedModelKeyPatterns = [/(^|\/)openai[/-]gpt-?5\.?5(?![0-9.])/i];
const kDeniedModelLabelPatterns = [/^gpt-?5\.5(?![0-9.])/i];

const normalizeModelKey = (value) => String(value || "").trim();

const isDeniedModelKey = (value) => {
  const key = normalizeModelKey(value);
  if (!key) return false;
  return kDeniedModelKeyPatterns.some((pattern) => pattern.test(key));
};

const isDeniedModelLabel = (value) => {
  const label = normalizeModelKey(value);
  if (!label) return false;
  return kDeniedModelLabelPatterns.some((pattern) => pattern.test(label));
};

const isDeniedModel = (model) => {
  if (model && typeof model === "object") {
    return (
      isDeniedModelKey(model.key ?? model.id) ||
      isDeniedModelLabel(model.label ?? model.name)
    );
  }
  return isDeniedModelKey(model);
};

const filterDeniedModels = (models) =>
  Array.isArray(models) ? models.filter((model) => !isDeniedModel(model)) : [];

const filterDeniedModelKeys = (keys) =>
  Array.isArray(keys) ? keys.filter((key) => !isDeniedModelKey(key)) : [];

// Strip denied models from a catalog payload shaped like the /api/models
// response or the bundled bootstrap: top-level `models`, and every
// `accessModes[mode].providers[].models` / `recommendedModelKeys`. Returns a
// new object; the input is not mutated.
const stripDeniedModelsFromCatalog = (payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const next = { ...payload };
  if (Array.isArray(next.models)) next.models = filterDeniedModels(next.models);
  if (next.accessModes && typeof next.accessModes === "object") {
    const accessModes = {};
    for (const [mode, group] of Object.entries(next.accessModes)) {
      if (!group || typeof group !== "object") {
        accessModes[mode] = group;
        continue;
      }
      const providers = Array.isArray(group.providers)
        ? group.providers.map((provider) => {
            if (!provider || typeof provider !== "object") return provider;
            const cleaned = { ...provider };
            if (Array.isArray(cleaned.models)) {
              cleaned.models = filterDeniedModels(cleaned.models);
            }
            if (Array.isArray(cleaned.recommendedModelKeys)) {
              cleaned.recommendedModelKeys = filterDeniedModelKeys(
                cleaned.recommendedModelKeys,
              );
            }
            return cleaned;
          })
        : group.providers;
      accessModes[mode] = { ...group, providers };
    }
    next.accessModes = accessModes;
  }
  return next;
};

module.exports = {
  kDeniedModelKeyPatterns,
  kDeniedModelLabelPatterns,
  isDeniedModelKey,
  isDeniedModelLabel,
  isDeniedModel,
  filterDeniedModels,
  filterDeniedModelKeys,
  stripDeniedModelsFromCatalog,
};
