import { useEffect, useMemo, useState } from "preact/hooks";
import { fetchThinkingOptions } from "../../../lib/api.js";
import {
  formatInheritedThinkingLabel,
  formatThinkingLevelLabel,
  shouldShowThinkingLevelSelect,
} from "../../../lib/thinking-levels.js";
import { useModels } from "../../models-tab/use-models.js";
import {
  buildProviderHasAuth,
  buildSyntheticModelEntry,
  getModelCatalogProvider,
  getModelsTabAuthProvider,
  getProviderSortIndex,
} from "../../models-tab/model-picker.js";

const resolveModelDisplay = (model) => {
  if (!model) return null;
  if (typeof model === "string") return model;
  return model.primary || null;
};

const resolveCatalogModel = (catalog = [], modelKey = "") =>
  catalog.find(
    (model) =>
      String(model?.key || "").trim() === String(modelKey || "").trim(),
  ) || null;

export const useModelCard = ({
  agent = {},
  onUpdateAgent = async () => {},
}) => {
  const [updatingModel, setUpdatingModel] = useState(false);
  const [updatingThinking, setUpdatingThinking] = useState(false);
  const [updatingFastMode, setUpdatingFastMode] = useState(false);
  const [updatingFallbacks, setUpdatingFallbacks] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [thinkingOptions, setThinkingOptions] = useState({
    levels: [],
    inheritedDefault: "off",
    modelDefault: "off",
  });
  const [thinkingOptionsLoading, setThinkingOptionsLoading] = useState(false);
  const {
    catalog,
    primary: defaultPrimaryModel,
    configuredModels,
    authProfiles,
    codexStatus,
    loading: loadingModels,
    ready: modelsReady,
  } = useModels();

  const explicitModel = resolveModelDisplay(agent.model);
  const explicitFallbacks = Array.isArray(agent?.model?.fallbacks)
    ? agent.model.fallbacks.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const effectiveModel = explicitModel || defaultPrimaryModel || "";
  const hasDistinctModelOverride =
    !!explicitModel &&
    String(explicitModel).trim() !== String(defaultPrimaryModel || "").trim();
  const explicitThinkingDefault = String(agent.thinkingDefault || "").trim();
  const inheritedThinkingDefault = String(
    thinkingOptions.inheritedDefault || thinkingOptions.modelDefault || "off",
  ).trim();
  const hasDistinctThinkingOverride =
    !!explicitThinkingDefault &&
    explicitThinkingDefault !== inheritedThinkingDefault;
  const showThinkingSelect = shouldShowThinkingLevelSelect(
    thinkingOptions.levels,
  );

  useEffect(() => {
    const modelKey = String(effectiveModel || "").trim();
    if (!modelKey.includes("/")) {
      setThinkingOptions({
        levels: [],
        inheritedDefault: "off",
        modelDefault: "off",
      });
      return undefined;
    }
    let cancelled = false;
    setThinkingOptionsLoading(true);
    fetchThinkingOptions(modelKey)
      .then((payload) => {
        if (cancelled || !payload?.ok) return;
        setThinkingOptions({
          levels: Array.isArray(payload.levels) ? payload.levels : [],
          inheritedDefault: String(payload.inheritedDefault || "off").trim(),
          modelDefault: String(payload.modelDefault || "off").trim(),
        });
      })
      .finally(() => {
        if (!cancelled) setThinkingOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveModel]);

  const providerHasAuth = useMemo(
    () => buildProviderHasAuth({ authProfiles, codexStatus }),
    [authProfiles, codexStatus],
  );

  const authorizedModelOptions = useMemo(
    () =>
      Object.keys(configuredModels || {})
        .map(
          (modelKey) =>
            resolveCatalogModel(catalog, modelKey) ||
            buildSyntheticModelEntry(modelKey),
        )
        .filter((model) => {
          const provider = getModelsTabAuthProvider(model.key);
          return !!providerHasAuth[provider];
        })
        .sort((left, right) => {
          const providerCompare =
            getProviderSortIndex(getModelCatalogProvider(left)) -
            getProviderSortIndex(getModelCatalogProvider(right));
          if (providerCompare !== 0) return providerCompare;
          return String(left?.label || left?.key).localeCompare(
            String(right?.label || right?.key),
          );
        }),
    [catalog, configuredModels, providerHasAuth],
  );

  const effectiveModelEntry = useMemo(
    () =>
      resolveCatalogModel(catalog, effectiveModel) ||
      (effectiveModel ? buildSyntheticModelEntry(effectiveModel) : null),
    [catalog, effectiveModel],
  );

  const popularModels = useMemo(
    () =>
      authorizedModelOptions.filter((model) => {
        const normalizedProvider = getModelCatalogProvider(model);
        return (
          normalizedProvider === "anthropic" || normalizedProvider === "openai"
        );
      }),
    [authorizedModelOptions],
  );

  const modelEntries = useMemo(() => {
    if (!effectiveModelEntry) return [];
    const currentKey = String(effectiveModelEntry?.key || "").trim();
    const rest = authorizedModelOptions.filter(
      (model) => String(model?.key || "").trim() !== currentKey,
    );
    return [effectiveModelEntry, ...rest];
  }, [authorizedModelOptions, effectiveModelEntry]);

  const modelEntryKeySet = useMemo(
    () =>
      new Set(
        modelEntries
          .map((entry) => String(entry?.key || "").trim())
          .filter(Boolean),
      ),
    [modelEntries],
  );

  const remainingModelOptions = useMemo(
    () =>
      authorizedModelOptions.filter(
        (model) => !modelEntryKeySet.has(String(model?.key || "").trim()),
      ),
    [authorizedModelOptions, modelEntryKeySet],
  );

  const handleSelectModel = async (modelKey) => {
    const normalizedModelKey = String(modelKey || "").trim();
    if (!normalizedModelKey || normalizedModelKey === effectiveModel) return;
    setUpdatingModel(true);
    try {
      await onUpdateAgent(
        String(agent.id || "").trim(),
        {
          model: { primary: normalizedModelKey, fallbacks: explicitFallbacks },
        },
        "Agent model updated",
      );
    } finally {
      setUpdatingModel(false);
    }
  };

  const handleAddFallback = async (modelKey) => {
    const normalizedModelKey = String(modelKey || "").trim();
    if (
      !normalizedModelKey ||
      normalizedModelKey === effectiveModel ||
      explicitFallbacks.includes(normalizedModelKey)
    ) return;
    setUpdatingFallbacks(true);
    try {
      await onUpdateAgent(
        String(agent.id || "").trim(),
        {
          model: {
            ...(explicitModel ? { primary: explicitModel } : {}),
            fallbacks: [...explicitFallbacks, normalizedModelKey],
          },
        },
        "Fallback model added",
      );
    } finally {
      setUpdatingFallbacks(false);
    }
  };

  const handleRemoveFallback = async (modelKey) => {
    const nextFallbacks = explicitFallbacks.filter((entry) => entry !== modelKey);
    setUpdatingFallbacks(true);
    try {
      await onUpdateAgent(
        String(agent.id || "").trim(),
        {
          model:
            !explicitModel && nextFallbacks.length === 0
              ? null
              : {
                  ...(explicitModel ? { primary: explicitModel } : {}),
                  fallbacks: nextFallbacks,
                },
        },
        "Fallback model removed",
      );
    } finally {
      setUpdatingFallbacks(false);
    }
  };

  const handleSelectFastMode = async (nextValue) => {
    const value = String(nextValue || "").trim();
    const normalized = value === "" ? null : value === "true" ? true : value === "false" ? false : "auto";
    setUpdatingFastMode(true);
    try {
      await onUpdateAgent(
        String(agent.id || "").trim(),
        { fastModeDefault: normalized },
        "Agent speed preference updated",
      );
    } finally {
      setUpdatingFastMode(false);
    }
  };

  const handleClearModelOverride = async () => {
    if (!hasDistinctModelOverride) return;
    setUpdatingModel(true);
    try {
      await onUpdateAgent(
        String(agent.id || "").trim(),
        {
          model: null,
        },
        "Agent model reset to default",
      );
    } finally {
      setUpdatingModel(false);
    }
  };

  const handleSelectThinkingDefault = async (nextValue) => {
    const normalizedValue = String(nextValue || "").trim();
    const isInherit = !normalizedValue;
    if (isInherit) {
      if (!hasDistinctThinkingOverride) return;
      setUpdatingThinking(true);
      try {
        await onUpdateAgent(
          String(agent.id || "").trim(),
          { thinkingDefault: null },
          "Agent thinking level reset to default",
        );
      } finally {
        setUpdatingThinking(false);
      }
      return;
    }
    if (normalizedValue === explicitThinkingDefault) return;
    setUpdatingThinking(true);
    try {
      await onUpdateAgent(
        String(agent.id || "").trim(),
        { thinkingDefault: normalizedValue },
        "Agent thinking level updated",
      );
    } finally {
      setUpdatingThinking(false);
    }
  };

  const thinkingSelectValue = hasDistinctThinkingOverride
    ? explicitThinkingDefault
    : "";
  const thinkingSelectOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    const addOption = (value, label) => {
      const normalizedValue = String(value || "").trim();
      if (!normalizedValue || seen.has(normalizedValue)) return;
      seen.add(normalizedValue);
      options.push({
        value: normalizedValue,
        label: String(label || formatThinkingLevelLabel(normalizedValue)).trim(),
      });
    };
    for (const entry of thinkingOptions.levels) {
      addOption(
        entry?.id,
        formatThinkingLevelLabel(entry?.label || entry?.id),
      );
    }
    if (
      explicitThinkingDefault &&
      !seen.has(explicitThinkingDefault)
    ) {
      addOption(
        explicitThinkingDefault,
        `${formatThinkingLevelLabel(explicitThinkingDefault)} (custom)`,
      );
    }
    return options;
  }, [explicitThinkingDefault, thinkingOptions.levels]);

  const fallbackEntries = explicitFallbacks.map(
    (modelKey) =>
      resolveCatalogModel(catalog, modelKey) || buildSyntheticModelEntry(modelKey),
  );
  const fallbackOptions = authorizedModelOptions.filter(
    (entry) =>
      entry.key !== effectiveModel && !explicitFallbacks.includes(entry.key),
  );

  return {
    authorizedModelOptions,
    canEditModel: modelsReady && !loadingModels,
    effectiveModel,
    effectiveModelEntry,
    fallbackEntries,
    fallbackOptions,
    handleClearModelOverride,
    handleAddFallback,
    handleRemoveFallback,
    handleSelectModel,
    handleSelectFastMode,
    handleSelectThinkingDefault,
    hasDistinctModelOverride,
    hasDistinctThinkingOverride,
    inheritedThinkingDefault,
    loading: !modelsReady || loadingModels,
    menuOpen,
    modelEntries,
    popularModels,
    remainingModelOptions,
    setMenuOpen,
    showThinkingSelect,
    thinkingOptionsLoading,
    thinkingSelectOptions,
    thinkingSelectValue,
    fastModeValue:
      agent.fastModeDefault === true
        ? "true"
        : agent.fastModeDefault === false
          ? "false"
          : agent.fastModeDefault === "auto"
            ? "auto"
            : "",
    formatInheritedThinkingLabel,
    updatingModel,
    updatingThinking,
    updatingFastMode,
    updatingFallbacks,
  };
};
