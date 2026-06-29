export const getModelProvider = (modelKey) => String(modelKey || "").split("/")[0] || "";

export const getAuthProviderFromModelProvider = (provider) => {
  const normalized = String(provider || "").trim();
  if (normalized === "openai-codex") return "openai";
  if (normalized === "volcengine-plan") return "volcengine";
  if (normalized === "byteplus-plan") return "byteplus";
  return normalized;
};

const kWrapperProviders = new Set([
  "openrouter",
  "vercel-ai-gateway",
  "kilocode",
]);

export const kModelAccessModeStorageKey = "_MODEL_ACCESS_MODE";
export const kAccountLoginProviderStorageKey = "_ACCOUNT_LOGIN_PROVIDER";

export const kModelAccessModes = [
  {
    id: "subscription",
    label: "Subscription",
    shortLabel: "Subscription",
    description: "Use an existing provider subscription plan.",
  },
  {
    id: "provider-api",
    label: "Provider API Key",
    shortLabel: "Provider API Key",
    description: "Usage-based billing from the model provider directly.",
  },
  {
    id: "gateway",
    label: "AI gateway",
    shortLabel: "Gateway",
    description: "Usage-based billing across providers using a gateway.",
  },
];

const kDefaultModelAccessMode = "provider-api";

const kGatewayProviders = new Set([
  "openrouter",
  "vercel-ai-gateway",
  "kilocode",
]);

const kSubscriptionProviders = new Set([
  "github-copilot",
  "minimax-portal",
  "qwen-oauth",
  "claude-cli",
  "google-gemini-cli",
]);

const kHiddenOnboardingProviders = new Set(["openai-codex"]);
const kSetupReadyAccountLoginProviders = new Set(["openai", "claude-cli"]);
const kAccountLoginProviderOrder = [
  "openai",
  "claude-cli",
  "github-copilot",
  "minimax-portal",
  "google-gemini-cli",
  "qwen-oauth",
];

const kKnownOnboardingModels = [
  {
    key: "anthropic/claude-opus-4-8",
    provider: "anthropic",
    label: "Opus 4.8",
    accessModes: ["provider-api"],
  },
  {
    key: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    label: "Sonnet 4.6",
    accessModes: ["provider-api"],
  },
  {
    key: "openai/gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    accessModes: ["subscription", "provider-api"],
  },
  {
    key: "openrouter/openai/gpt-5.5",
    provider: "openrouter",
    label: "GPT-5.5",
    accessModes: ["gateway"],
    accessLabel: "via OpenRouter",
  },
  {
    key: "vercel-ai-gateway/openai/gpt-5.5",
    provider: "vercel-ai-gateway",
    label: "GPT-5.5",
    accessModes: ["gateway"],
    accessLabel: "via Vercel AI Gateway",
  },
  {
    key: "kilocode/openai/gpt-5.5",
    provider: "kilocode",
    label: "GPT-5.5",
    accessModes: ["gateway"],
    accessLabel: "via Kilo Gateway",
  },
];

const normalizeModelFamilyKey = (value) =>
  String(value || "")
    .trim()
    .replace(/\./g, "-")
    .toLowerCase();

export const getModelFamilyKey = (modelKey) => {
  const parts = String(modelKey || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  const provider = parts[0];
  const familyParts =
    kWrapperProviders.has(provider) && parts.length > 1 ? parts.slice(1) : parts;
  return normalizeModelFamilyKey(familyParts.join("/"));
};

export const kProviderLabels = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "azure-openai-responses": "Azure OpenAI",
  "openai-codex": "OpenAI Codex",
  google: "Gemini",
  opencode: "OpenCode Zen",
  openrouter: "OpenRouter",
  zai: "Z.AI",
  "vercel-ai-gateway": "Vercel AI Gateway",
  kilocode: "Kilo Gateway",
  xai: "xAI",
  mistral: "Mistral",
  cerebras: "Cerebras",
  moonshot: "Moonshot",
  "kimi-coding": "Kimi Coding",
  volcengine: "Volcano Engine",
  byteplus: "BytePlus",
  synthetic: "Synthetic",
  minimax: "MiniMax",
  voyage: "Voyage",
  groq: "Groq",
  deepgram: "Deepgram",
  vllm: "vLLM",
  "github-copilot": "GitHub Copilot",
  "minimax-portal": "MiniMax Coding Plan",
  "qwen-oauth": "Qwen Portal",
  "claude-cli": "Claude CLI",
  "google-gemini-cli": "Gemini CLI",
};

export const kFeaturedModelDefs = [
  {
    label: "Opus 4.8",
    preferredKeys: ["anthropic/claude-opus-4-8"],
  },
  {
    label: "Sonnet 4.6",
    preferredKeys: ["anthropic/claude-sonnet-4-6"],
  },
  {
    label: "GPT-5.5",
    preferredKeys: ["openai/gpt-5.5"],
  },
];

export const getFeaturedModels = (allModels) => {
  const picked = [];
  const used = new Set();
  kFeaturedModelDefs.forEach((def) => {
    const preferred = (def.preferredKeys || [])
      .map((key) => allModels.find((model) => model.key === key))
      .find(Boolean);
    if (preferred && !used.has(preferred.key)) {
      picked.push({ ...preferred, featuredLabel: def.label });
      used.add(preferred.key);
      return;
    }
    const familyKeys = new Set(
      (def.familyKeys || []).map((familyKey) => normalizeModelFamilyKey(familyKey)),
    );
    allModels.forEach((model) => {
      if (!model?.key || used.has(model.key)) return;
      if (!familyKeys.has(getModelFamilyKey(model.key))) return;
      picked.push({ ...model, featuredLabel: def.label });
      used.add(model.key);
    });
  });
  return picked;
};

const mergeKnownOnboardingModels = (models = []) => {
  const merged = [];
  const used = new Set();
  [...models, ...kKnownOnboardingModels].forEach((model) => {
    const key = String(model?.key || "").trim();
    if (!key || used.has(key)) return;
    merged.push(model);
    used.add(key);
  });
  return merged;
};

export const getOnboardingModelCatalog = (models = []) =>
  mergeKnownOnboardingModels(models).filter(isVisibleOnboardingModel);

const kLowerCostModelTokens = new Set([
  "flash",
  "haiku",
  "instant",
  "lite",
  "mini",
  "nano",
  "small",
]);

export const isLowerCostOnboardingModel = (model) => {
  const searchable = `${model?.key || ""} ${model?.label || ""}`.toLowerCase();
  const tokens = searchable.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => kLowerCostModelTokens.has(token));
};

export const isVisibleOnboardingModel = (model) =>
  !kHiddenOnboardingProviders.has(getModelProvider(model?.key));

export const normalizeModelAccessMode = (mode) => {
  const normalized = String(mode || "").trim();
  return kModelAccessModes.some((entry) => entry.id === normalized)
    ? normalized
    : "";
};

export const getModelAccessModeForModel = (model) => {
  const explicitModes = Array.isArray(model?.accessModes)
    ? model.accessModes.map(normalizeModelAccessMode).filter(Boolean)
    : [];
  if (explicitModes.length > 0) return explicitModes[0];
  const provider = getModelProvider(model?.key);
  if (kGatewayProviders.has(provider)) return "gateway";
  if (kSubscriptionProviders.has(provider)) return "subscription";
  return kDefaultModelAccessMode;
};

export const isSetupReadyAccountLoginProvider = (provider) =>
  kSetupReadyAccountLoginProviders.has(String(provider || "").trim());

export const isSetupReadyAccountLoginModel = (model) =>
  isSetupReadyAccountLoginProvider(getModelProvider(model?.key));

const getAccountLoginProviderDescription = (provider) => {
  switch (String(provider || "").trim()) {
    case "openai":
      return "Use Codex OAuth with an OpenAI account.";
    case "claude-cli":
      return "Reuse a local Claude CLI login.";
    case "github-copilot":
      return "Use models available through GitHub Copilot.";
    case "minimax-portal":
      return "Use a MiniMax Coding Plan account.";
    case "google-gemini-cli":
      return "Reuse a local Gemini CLI OAuth login.";
    case "qwen-oauth":
      return "Use a Qwen Portal account token.";
    default:
      return "Use this OpenClaw account login route.";
  }
};

export const getAccountLoginProviderOptions = (models = []) => {
  const providers = new Map();
  (models || []).forEach((model) => {
    if (getModelAccessModeForModel(model) !== "subscription") return;
    const provider = getModelProvider(model?.key);
    if (!provider) return;
    const existing = providers.get(provider);
    providers.set(provider, {
      id: provider,
      label: kProviderLabels[provider] || provider,
      description: getAccountLoginProviderDescription(provider),
      setupReady: isSetupReadyAccountLoginProvider(provider),
      modelCount: (existing?.modelCount || 0) + 1,
    });
  });
  return [...providers.values()].sort((a, b) => {
    const aOrder = kAccountLoginProviderOrder.indexOf(a.id);
    const bOrder = kAccountLoginProviderOrder.indexOf(b.id);
    const normalizedAOrder = aOrder >= 0 ? aOrder : Number.MAX_SAFE_INTEGER;
    const normalizedBOrder = bOrder >= 0 ? bOrder : Number.MAX_SAFE_INTEGER;
    if (normalizedAOrder !== normalizedBOrder) {
      return normalizedAOrder - normalizedBOrder;
    }
    return String(a.label).localeCompare(String(b.label));
  });
};

export const normalizeAccountLoginProvider = (provider, models = []) => {
  const normalized = String(provider || "").trim();
  if (!normalized) return "";
  return getAccountLoginProviderOptions(models).some((option) => option.id === normalized)
    ? normalized
    : "";
};

export const getDefaultAccountLoginProvider = (models = []) => {
  const options = getAccountLoginProviderOptions(models);
  return options.find((option) => option.id === "openai")?.id || options[0]?.id || "";
};

export const getAccountLoginProviderForModelKey = (modelKey, models = []) => {
  const key = String(modelKey || "").trim();
  const model = (models || []).find((entry) => entry?.key === key);
  return model && getModelAccessModeForModel(model) === "subscription"
    ? getModelProvider(model.key)
    : "";
};

export const getModelAccessModeForModelKey = (modelKey, catalog = []) => {
  const key = String(modelKey || "").trim();
  const model = (catalog || []).find((entry) => entry?.key === key);
  return model ? getModelAccessModeForModel(model) : "";
};

export const getDefaultModelAccessMode = () => kDefaultModelAccessMode;

export const getOnboardingModelsForAccessMode = ({
  models = [],
  accessMode = kDefaultModelAccessMode,
} = {}) => {
  const normalizedMode = normalizeModelAccessMode(accessMode) || kDefaultModelAccessMode;
  return (models || []).filter((model) => {
    const explicitModes = Array.isArray(model?.accessModes)
      ? model.accessModes.map(normalizeModelAccessMode).filter(Boolean)
      : [];
    if (explicitModes.length > 0) return explicitModes.includes(normalizedMode);
    return getModelAccessModeForModel(model) === normalizedMode;
  });
};

export const getOnboardingModelsForAccountLoginProvider = ({
  models = [],
  provider = "",
} = {}) => {
  const normalizedProvider = String(provider || "").trim();
  return getOnboardingModelsForAccessMode({
    models,
    accessMode: "subscription",
  }).filter((model) => getModelProvider(model?.key) === normalizedProvider);
};

export const getRecommendedModelsForAccountLoginProvider = ({
  models = [],
  provider = "",
} = {}) => {
  const normalizedProvider = String(provider || "").trim();
  const available = getOnboardingModelsForAccountLoginProvider({
    models,
    provider: normalizedProvider,
  });
  const preferredKeys =
    normalizedProvider === "openai"
      ? ["openai/gpt-5.5"]
      : normalizedProvider === "claude-cli"
        ? ["claude-cli/claude-opus-4-8", "claude-cli/claude-sonnet-4-6"]
        : [];
  return preferredKeys
    .map((key) => available.find((model) => model?.key === key))
    .filter(Boolean)
    .map((model) => ({ ...model, featuredLabel: model.label || model.key }));
};

export const getRecommendedModelsForAccessMode = ({
  models = [],
  accessMode = kDefaultModelAccessMode,
} = {}) => {
  const normalizedMode = normalizeModelAccessMode(accessMode) || kDefaultModelAccessMode;
  const available = getOnboardingModelsForAccessMode({
    models,
    accessMode: normalizedMode,
  });
  if (normalizedMode === "provider-api") {
    return getFeaturedModels(available);
  }
  const preferredKeys =
    normalizedMode === "subscription"
      ? ["openai/gpt-5.5"]
      : [
          "vercel-ai-gateway/openai/gpt-5.5",
          "openrouter/openai/gpt-5.5",
          "kilocode/openai/gpt-5.5",
        ];
  const picked = [];
  const used = new Set();
  preferredKeys.forEach((key) => {
    const model = available.find((entry) => entry?.key === key);
    if (!model || used.has(model.key)) return;
    picked.push({ ...model, featuredLabel: model.label || model.key });
    used.add(model.key);
  });
  return picked;
};

export const getInitialModelKeyForAccessMode = ({
  models = [],
  accessMode = kDefaultModelAccessMode,
} = {}) => {
  const recommended = getRecommendedModelsForAccessMode({ models, accessMode });
  if (recommended[0]?.key) return recommended[0].key;
  return String(
    getOnboardingModelsForAccessMode({ models, accessMode })[0]?.key || "",
  );
};

export const getInitialModelKeyForAccountLoginProvider = ({
  models = [],
  provider = "",
} = {}) => {
  const recommended = getRecommendedModelsForAccountLoginProvider({
    models,
    provider,
  });
  if (recommended[0]?.key) return recommended[0].key;
  return String(
    getOnboardingModelsForAccountLoginProvider({ models, provider })[0]?.key || "",
  );
};

export const getOnboardingModelGroups = ({
  allModels = [],
  recommendedModels = [],
} = {}) => {
  const groups = [
    {
      id: "recommended",
      label: "Recommended",
      models: [],
    },
    {
      id: "lower-cost",
      label: "Lower cost",
      models: [],
    },
    {
      id: "advanced",
      label: "Advanced",
      models: [],
    },
  ];
  const used = new Set();

  recommendedModels.forEach((model) => {
    if (!model?.key || used.has(model.key)) return;
    groups[0].models.push(model);
    used.add(model.key);
  });

  allModels.forEach((model) => {
    if (!model?.key || used.has(model.key)) return;
    const groupIndex =
      getModelAccessModeForModel(model) === "subscription" &&
      !isSetupReadyAccountLoginModel(model)
        ? 2
        : isLowerCostOnboardingModel(model)
          ? 1
          : 2;
    groups[groupIndex].models.push(model);
    used.add(model.key);
  });

  return groups.filter((group) => group.models.length > 0);
};

export const getOnboardingModelLabel = (model, catalog = []) => {
  const provider = getModelProvider(model?.key);
  const providerLabel = kProviderLabels[provider] || provider || "Provider";
  const baseLabel = String(model?.featuredLabel || model?.label || model?.key || "").trim();
  if (!baseLabel) return "";
  const familyKey = getModelFamilyKey(model?.key);
  const hasProviderVariants =
    familyKey &&
    (catalog || []).some(
      (entry) =>
        entry?.key !== model?.key &&
        getModelFamilyKey(entry?.key) === familyKey,
    );
  const hasDuplicateLabel =
    baseLabel &&
    (catalog || []).some((entry) => {
      if (entry?.key === model?.key) return false;
      const entryLabel = String(
        entry?.featuredLabel || entry?.label || entry?.key || "",
      ).trim();
      return entryLabel === baseLabel;
    });
  return hasProviderVariants || hasDuplicateLabel
    ? `${baseLabel} (${providerLabel})`
    : baseLabel;
};

export const getOnboardingModelDescription = (model) => {
  const explicit = String(model?.accessLabel || "").trim();
  if (explicit) return explicit;
  const provider = getModelProvider(model?.key);
  const providerLabel = kProviderLabels[provider] || provider || "";
  if (!providerLabel) return "";
  if (kGatewayProviders.has(provider)) return `via ${providerLabel}`;
  if (
    getModelAccessModeForModel(model) === "subscription" &&
    !isSetupReadyAccountLoginModel(model)
  ) {
    return `${providerLabel} account login`;
  }
  if (provider === "openai") return "OpenAI";
  return providerLabel;
};

export const getCodexOauthModelKeyForOpenAiModel = (modelKey, catalog = []) => {
  const parts = String(modelKey || "").trim().split("/");
  if (parts[0] !== "openai" || parts.length < 2) return String(modelKey || "").trim();
  const codexKey = ["openai-codex", ...parts.slice(1)].join("/");
  const matchingCatalogEntry = (catalog || []).find((model) => model?.key === codexKey);
  return matchingCatalogEntry?.key || codexKey;
};

export const getOpenAiModelKeyForCodexRuntimeModel = (modelKey, catalog = []) => {
  const parts = String(modelKey || "").trim().split("/");
  if (parts[0] === "openai") return String(modelKey || "").trim();
  if (parts[0] !== "openai-codex" || parts.length < 2) return String(modelKey || "").trim();
  const openAiKey = ["openai", ...parts.slice(1)].join("/");
  const matchingCatalogEntry = (catalog || []).find((model) => model?.key === openAiKey);
  return matchingCatalogEntry?.key || openAiKey;
};

export const getAnthropicModelKeyForClaudeCliRuntimeModel = (modelKey) => {
  const parts = String(modelKey || "").trim().split("/");
  if (parts[0] === "anthropic") return String(modelKey || "").trim();
  if (parts[0] !== "claude-cli" || parts.length < 2) return String(modelKey || "").trim();
  return ["anthropic", ...parts.slice(1)].join("/");
};

export const kProviderAuthFields = {
  anthropic: [
    {
      key: "ANTHROPIC_API_KEY",
      label: "Anthropic API Key",
      url: "https://console.anthropic.com",
      linkText: "Get key",
      placeholder: "sk-ant-...",
    },
    // Temporarily hidden — setup-token flow is not supported in onboarding yet.
    // {
    //   key: "ANTHROPIC_TOKEN",
    //   label: "Anthropic Setup Token",
    //   hint: "From claude setup-token (uses your Claude subscription)",
    //   linkText: "Get token",
    //   placeholder: "Token...",
    // },
  ],
  openai: [
    {
      key: "OPENAI_API_KEY",
      label: "OpenAI API Key",
      url: "https://platform.openai.com",
      linkText: "Get key",
      placeholder: "sk-...",
    },
  ],
  google: [
    {
      key: "GEMINI_API_KEY",
      label: "Gemini API Key",
      url: "https://aistudio.google.com",
      linkText: "Get key",
      placeholder: "AI...",
    },
  ],
  opencode: [
    {
      key: "OPENCODE_API_KEY",
      label: "OpenCode API Key",
      placeholder: "oc-...",
    },
  ],
  openrouter: [
    {
      key: "OPENROUTER_API_KEY",
      label: "OpenRouter API Key",
      url: "https://openrouter.ai",
      linkText: "Get key",
      placeholder: "sk-or-...",
    },
  ],
  zai: [
    {
      key: "ZAI_API_KEY",
      label: "Z.AI API Key",
      placeholder: "zai-...",
    },
  ],
  "vercel-ai-gateway": [
    {
      key: "AI_GATEWAY_API_KEY",
      label: "AI Gateway API Key",
      placeholder: "aigw_...",
    },
  ],
  kilocode: [
    {
      key: "KILOCODE_API_KEY",
      label: "KiloCode API Key",
      placeholder: "kilo_...",
    },
  ],
  xai: [
    {
      key: "XAI_API_KEY",
      label: "xAI API Key",
      placeholder: "xai-...",
    },
  ],
  mistral: [
    {
      key: "MISTRAL_API_KEY",
      label: "Mistral API Key",
      url: "https://console.mistral.ai",
      linkText: "Get key",
      placeholder: "sk-...",
    },
  ],
  voyage: [
    {
      key: "VOYAGE_API_KEY",
      label: "Voyage API Key",
      url: "https://dash.voyageai.com",
      linkText: "Get key",
      placeholder: "pa-...",
    },
  ],
  groq: [
    {
      key: "GROQ_API_KEY",
      label: "Groq API Key",
      url: "https://console.groq.com",
      linkText: "Get key",
      placeholder: "gsk_...",
    },
  ],
  cerebras: [
    {
      key: "CEREBRAS_API_KEY",
      label: "Cerebras API Key",
      placeholder: "csk-...",
    },
  ],
  moonshot: [
    {
      key: "MOONSHOT_API_KEY",
      label: "Moonshot API Key",
      placeholder: "sk-...",
    },
  ],
  "kimi-coding": [
    {
      key: "KIMI_API_KEY",
      label: "Kimi API Key",
      placeholder: "sk-...",
    },
  ],
  volcengine: [
    {
      key: "VOLCANO_ENGINE_API_KEY",
      label: "Volcano Engine API Key",
      placeholder: "ve-...",
    },
  ],
  byteplus: [
    {
      key: "BYTEPLUS_API_KEY",
      label: "BytePlus API Key",
      placeholder: "bp-...",
    },
  ],
  synthetic: [
    {
      key: "SYNTHETIC_API_KEY",
      label: "Synthetic API Key",
      placeholder: "syn-...",
    },
  ],
  minimax: [
    {
      key: "MINIMAX_API_KEY",
      label: "MiniMax API Key",
      placeholder: "minimax-...",
    },
  ],
  deepgram: [
    {
      key: "DEEPGRAM_API_KEY",
      label: "Deepgram API Key",
      url: "https://console.deepgram.com",
      linkText: "Get key",
      placeholder: "dg-...",
    },
  ],
  vllm: [
    {
      key: "VLLM_API_KEY",
      label: "vLLM API Key",
      placeholder: "vllm-local",
    },
  ],
};

export const kProviderOrder = [
  "anthropic",
  "openai",
  "google",
  "zai",
  "xai",
  "openrouter",
  "opencode",
  "kilocode",
  "vercel-ai-gateway",
  "minimax",
  "moonshot",
  "kimi-coding",
  "volcengine",
  "byteplus",
  "synthetic",
  "mistral",
  "cerebras",
  "voyage",
  "groq",
  "deepgram",
  "vllm",
];

export const kCoreProviders = new Set(["anthropic", "openai", "google", "openrouter"]);

export const kProviderFeatures = {
  anthropic: ["Agent Model"],
  openai: ["Agent Model", "Embeddings", "Audio"],
  google: ["Agent Model", "Embeddings", "Audio"],
  opencode: ["Agent Model"],
  openrouter: ["Agent Model"],
  zai: ["Agent Model"],
  "vercel-ai-gateway": ["Agent Model"],
  kilocode: ["Agent Model"],
  xai: ["Agent Model"],
  mistral: ["Agent Model", "Embeddings", "Audio"],
  cerebras: ["Agent Model"],
  moonshot: ["Agent Model"],
  "kimi-coding": ["Agent Model"],
  volcengine: ["Agent Model"],
  byteplus: ["Agent Model"],
  synthetic: ["Agent Model"],
  minimax: ["Agent Model"],
  voyage: ["Embeddings"],
  groq: ["Agent Model", "Audio"],
  deepgram: ["Audio"],
  vllm: ["Agent Model"],
};

export const kFeatureDefs = [
  {
    id: "embeddings",
    label: "Memory Embeddings",
    tag: "Embeddings",
    providers: ["openai", "google", "voyage", "mistral"],
  },
  {
    id: "audio",
    label: "Audio Transcription",
    tag: "Audio",
    hasDefault: true,
    providers: ["openai", "groq", "deepgram", "google", "mistral"],
  },
];

export const getVisibleAiFieldKeys = (provider) => {
  if (provider === "openai-codex") return new Set();
  const authProvider = getAuthProviderFromModelProvider(provider);
  const fields = kProviderAuthFields[authProvider] || [];
  return new Set(fields.map((field) => field.key));
};

export const kAllAiAuthFields = Object.values(kProviderAuthFields)
  .flat()
  .filter((field, idx, arr) => arr.findIndex((item) => item.key === field.key) === idx);
