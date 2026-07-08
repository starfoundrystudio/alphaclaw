export const getModelProvider = (modelKey) => String(modelKey || "").split("/")[0] || "";

export const getAuthProviderFromModelProvider = (provider) => {
  const normalized = String(provider || "").trim();
  if (normalized === "openai-codex") return "openai";
  if (normalized === "volcengine-plan") return "volcengine";
  if (normalized === "byteplus-plan") return "byteplus";
  return normalized;
};

export const kVercelAiGatewayApiKeyPrefix = "vck_";

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

const kDefaultModelAccessMode = "subscription";
const kFallbackModelAccessMode = "provider-api";

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
const kAccountLoginProviderOrder = ["openai", "claude-cli"];

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

const tokenizeModelSortName = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .split(/(\d+)/)
    .filter(Boolean)
    .map((token) => {
      if (/^\d+$/.test(token)) return { type: "number", value: Number(token) };
      return { type: "text", value: token.replace(/[^a-z]+/g, " ") };
    });

const getModelSortName = (model) =>
  String(model?.featuredLabel || model?.label || model?.key || "").trim();

export const compareOnboardingModelsByVersionedName = (left, right) => {
  const leftTokens = tokenizeModelSortName(getModelSortName(left));
  const rightTokens = tokenizeModelSortName(getModelSortName(right));
  const length = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 0; index < length; index += 1) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    if (!leftToken || !rightToken) {
      return leftTokens.length - rightTokens.length;
    }
    if (leftToken.type === "number" && rightToken.type === "number") {
      if (leftToken.value !== rightToken.value) {
        return rightToken.value - leftToken.value;
      }
      continue;
    }
    const textCompare = String(leftToken.value).localeCompare(
      String(rightToken.value),
      undefined,
      { sensitivity: "base" },
    );
    if (textCompare !== 0) return textCompare;
  }
  return String(left?.key || "").localeCompare(String(right?.key || ""));
};

export const sortOnboardingModelsByVersionedName = (models = []) =>
  [...(models || [])].sort(compareOnboardingModelsByVersionedName);

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
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  kilocode: "Kilo Gateway",
  xai: "xAI",
  mistral: "Mistral",
  cerebras: "Cerebras",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  fireworks: "Fireworks",
  moonshot: "Moonshot",
  novita: "Novita",
  nvidia: "NVIDIA",
  "ollama-cloud": "Ollama Cloud",
  "kimi-coding": "Kimi Coding",
  volcengine: "Volcano Engine",
  "volcengine-plan": "Volcano Engine Plan",
  byteplus: "BytePlus",
  "byteplus-plan": "BytePlus Plan",
  synthetic: "Synthetic",
  minimax: "MiniMax",
  voyage: "Voyage",
  groq: "Groq",
  deepgram: "Deepgram",
  vllm: "vLLM",
  "tencent-tokenhub": "Tencent TokenHub",
  together: "Together",
  venice: "Venice",
  xiaomi: "Xiaomi",
  "github-copilot": "GitHub Copilot",
  "minimax-portal": "MiniMax Coding Plan",
  "qwen-oauth": "Qwen Portal",
  "claude-cli": "Claude",
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
  return kFallbackModelAccessMode;
};

export const isSetupReadyAccountLoginProvider = (provider) =>
  kSetupReadyAccountLoginProviders.has(String(provider || "").trim());

export const isSetupReadyAccountLoginModel = (model) =>
  isSetupReadyAccountLoginProvider(getModelProvider(model?.key));

const getAccountLoginProviderDescription = (provider) => {
  switch (String(provider || "").trim()) {
    case "openai":
      return "Use your ChatGPT subscription through Codex OAuth.";
    case "claude-cli":
      return "Use your Claude subscription through the Claude CLI.";
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

const getAccountLoginProviderLabel = (provider) => {
  switch (String(provider || "").trim()) {
    case "openai":
      return "ChatGPT";
    case "claude-cli":
      return "Claude";
    default:
      return kProviderLabels[provider] || provider;
  }
};

export const getAccountLoginProviderOptions = (models = []) => {
  const providers = new Map();
  (models || []).forEach((model) => {
    if (getModelAccessModeForModel(model) !== "subscription") return;
    const provider = getModelProvider(model?.key);
    if (!provider) return;
    if (!isSetupReadyAccountLoginProvider(provider)) return;
    const existing = providers.get(provider);
    providers.set(provider, {
      id: provider,
      label: getAccountLoginProviderLabel(provider),
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

const getProviderDescriptionForAccessMode = ({ provider, accessMode }) => {
  if (accessMode === "subscription") {
    return getAccountLoginProviderDescription(provider);
  }
  const providerLabel = kProviderLabels[provider] || provider || "provider";
  if (accessMode === "gateway") {
    return `Use ${providerLabel} as the gateway for your primary model.`;
  }
  return `Use an API key from ${providerLabel}.`;
};

export const getProviderOptionsForAccessMode = ({
  models = [],
  accessMode = kDefaultModelAccessMode,
} = {}) => {
  const normalizedMode = normalizeModelAccessMode(accessMode) || kDefaultModelAccessMode;
  if (normalizedMode === "subscription") return getAccountLoginProviderOptions(models);
  const providers = new Map();
  getOnboardingModelsForAccessMode({
    models,
    accessMode: normalizedMode,
  }).forEach((model) => {
    const provider = getModelProvider(model?.key);
    if (!provider) return;
    const existing = providers.get(provider);
    providers.set(provider, {
      id: provider,
      label: kProviderLabels[provider] || provider,
      description: getProviderDescriptionForAccessMode({
        provider,
        accessMode: normalizedMode,
      }),
      setupReady: true,
      modelCount: (existing?.modelCount || 0) + 1,
    });
  });
  return [...providers.values()].sort((a, b) => {
    const aOrder = kProviderOrder.indexOf(a.id);
    const bOrder = kProviderOrder.indexOf(b.id);
    const normalizedAOrder = aOrder >= 0 ? aOrder : Number.MAX_SAFE_INTEGER;
    const normalizedBOrder = bOrder >= 0 ? bOrder : Number.MAX_SAFE_INTEGER;
    if (normalizedAOrder !== normalizedBOrder) {
      return normalizedAOrder - normalizedBOrder;
    }
    return String(a.label).localeCompare(String(b.label));
  });
};

export const normalizeProviderForAccessMode = ({
  provider = "",
  models = [],
  accessMode = kDefaultModelAccessMode,
} = {}) => {
  const normalized = String(provider || "").trim();
  if (!normalized) return "";
  return getProviderOptionsForAccessMode({ models, accessMode }).some(
    (option) => option.id === normalized,
  )
    ? normalized
    : "";
};

export const getDefaultProviderForAccessMode = ({
  models = [],
  accessMode = kDefaultModelAccessMode,
} = {}) => {
  const options = getProviderOptionsForAccessMode({ models, accessMode });
  if (accessMode === "subscription") {
    return options.find((option) => option.id === "openai")?.id || options[0]?.id || "";
  }
  if (accessMode === "gateway") {
    return (
      options.find((option) => option.id === "vercel-ai-gateway")?.id ||
      options.find((option) => option.id === "openrouter")?.id ||
      options[0]?.id ||
      ""
    );
  }
  return (
    options.find((option) => option.id === "anthropic")?.id ||
    options.find((option) => option.id === "openai")?.id ||
    options[0]?.id ||
    ""
  );
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
    const provider = getModelProvider(model?.key);
    if (
      normalizedMode === "subscription" &&
      !isSetupReadyAccountLoginProvider(provider)
    ) {
      return false;
    }
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
  return sortOnboardingModelsByVersionedName(
    getOnboardingModelsForAccessMode({
      models,
      accessMode: "subscription",
    }).filter((model) => getModelProvider(model?.key) === normalizedProvider),
  );
};

export const getOnboardingModelsForAccessModeProvider = ({
  models = [],
  accessMode = kDefaultModelAccessMode,
  provider = "",
} = {}) => {
  const normalizedProvider = String(provider || "").trim();
  return sortOnboardingModelsByVersionedName(
    getOnboardingModelsForAccessMode({ models, accessMode }).filter(
      (model) =>
        !normalizedProvider || getModelProvider(model?.key) === normalizedProvider,
    ),
  );
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
    .map((model) => ({ ...model, featuredLabel: model.label || model.key }))
    .sort(compareOnboardingModelsByVersionedName);
};

export const getRecommendedModelsForAccessModeProvider = ({
  models = [],
  accessMode = kDefaultModelAccessMode,
  provider = "",
} = {}) => {
  const available = getOnboardingModelsForAccessModeProvider({
    models,
    accessMode,
    provider,
  });
  const catalogRecommended = available
    .filter((model) => model?.recommendation === "recommended")
    .map((model) => ({ ...model, featuredLabel: model.label || model.key }))
    .sort(compareOnboardingModelsByVersionedName);
  if (catalogRecommended.length > 0) return catalogRecommended;
  if (accessMode === "subscription") {
    return getRecommendedModelsForAccountLoginProvider({ models, provider });
  }
  if (accessMode === "provider-api") return getFeaturedModels(available);
  return getRecommendedModelsForAccessMode({ models: available, accessMode });
};

export const getInitialModelKeyForAccessModeProvider = ({
  models = [],
  accessMode = kDefaultModelAccessMode,
  provider = "",
} = {}) => {
  const recommended = getRecommendedModelsForAccessModeProvider({
    models,
    accessMode,
    provider,
  });
  if (recommended[0]?.key) return recommended[0].key;
  return String(
    getOnboardingModelsForAccessModeProvider({ models, accessMode, provider })[0]
      ?.key || "",
  );
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

  return groups
    .map((group) => ({
      ...group,
      models: sortOnboardingModelsByVersionedName(group.models),
    }))
    .filter((group) => group.models.length > 0);
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
  "cloudflare-ai-gateway": [
    {
      key: "CLOUDFLARE_AI_GATEWAY_API_KEY",
      label: "Cloudflare AI Gateway API Key",
      placeholder: "cf-...",
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
      placeholder: "vck_...",
      requiredPrefix: kVercelAiGatewayApiKeyPrefix,
      hint: "Vercel AI Gateway keys start with vck_.",
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
  cohere: [
    {
      key: "COHERE_API_KEY",
      label: "Cohere API Key",
      placeholder: "co-...",
    },
  ],
  deepseek: [
    {
      key: "DEEPSEEK_API_KEY",
      label: "DeepSeek API Key",
      placeholder: "sk-...",
    },
  ],
  fireworks: [
    {
      key: "FIREWORKS_API_KEY",
      label: "Fireworks API Key",
      placeholder: "fw-...",
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
  novita: [
    {
      key: "NOVITA_API_KEY",
      label: "Novita API Key",
      placeholder: "novita-...",
    },
  ],
  nvidia: [
    {
      key: "NVIDIA_API_KEY",
      label: "NVIDIA API Key",
      placeholder: "nvapi-...",
    },
  ],
  "ollama-cloud": [
    {
      key: "OLLAMA_API_KEY",
      label: "Ollama API Key",
      placeholder: "ollama-...",
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
  "tencent-tokenhub": [
    {
      key: "TENCENT_TOKENHUB_API_KEY",
      label: "Tencent TokenHub API Key",
      placeholder: "tk-...",
    },
  ],
  together: [
    {
      key: "TOGETHER_API_KEY",
      label: "Together API Key",
      placeholder: "tg-...",
    },
  ],
  venice: [
    {
      key: "VENICE_API_KEY",
      label: "Venice API Key",
      placeholder: "venice-...",
    },
  ],
  xiaomi: [
    {
      key: "XIAOMI_API_KEY",
      label: "Xiaomi API Key",
      placeholder: "xiaomi-...",
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
  "cloudflare-ai-gateway",
  "minimax",
  "moonshot",
  "cohere",
  "deepseek",
  "fireworks",
  "kimi-coding",
  "volcengine",
  "byteplus",
  "novita",
  "nvidia",
  "ollama-cloud",
  "synthetic",
  "mistral",
  "cerebras",
  "voyage",
  "groq",
  "deepgram",
  "vllm",
  "tencent-tokenhub",
  "together",
  "venice",
  "xiaomi",
];

export const kCoreProviders = new Set(["anthropic", "openai", "google", "openrouter"]);

export const kProviderFeatures = {
  anthropic: ["Agent Model"],
  openai: ["Agent Model", "Embeddings", "Audio"],
  google: ["Agent Model", "Embeddings", "Audio"],
  opencode: ["Agent Model"],
  openrouter: ["Agent Model"],
  "cloudflare-ai-gateway": ["Agent Model"],
  zai: ["Agent Model"],
  "vercel-ai-gateway": ["Agent Model"],
  kilocode: ["Agent Model"],
  xai: ["Agent Model"],
  mistral: ["Agent Model", "Embeddings", "Audio"],
  cerebras: ["Agent Model"],
  cohere: ["Agent Model"],
  deepseek: ["Agent Model"],
  fireworks: ["Agent Model"],
  moonshot: ["Agent Model"],
  "kimi-coding": ["Agent Model"],
  volcengine: ["Agent Model"],
  byteplus: ["Agent Model"],
  novita: ["Agent Model"],
  nvidia: ["Agent Model"],
  "ollama-cloud": ["Agent Model"],
  synthetic: ["Agent Model"],
  minimax: ["Agent Model"],
  voyage: ["Embeddings"],
  groq: ["Agent Model", "Audio"],
  deepgram: ["Audio"],
  vllm: ["Agent Model"],
  "tencent-tokenhub": ["Agent Model"],
  together: ["Agent Model"],
  venice: ["Agent Model"],
  xiaomi: ["Agent Model"],
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

export const getAiCredentialFieldError = (field, value) => {
  const normalizedValue = String(value || "").trim();
  const requiredPrefix = String(field?.requiredPrefix || "").trim();
  if (!normalizedValue || !requiredPrefix) return "";
  if (normalizedValue.startsWith(requiredPrefix)) return "";
  return `${field?.label || field?.key || "Credential"} must start with ${requiredPrefix}`;
};

export const getAiCredentialErrorForFields = (vals = {}, fields = []) => {
  for (const field of fields || []) {
    const error = getAiCredentialFieldError(field, vals[field?.key]);
    if (error) return error;
  }
  return "";
};

export const getAiCredentialFieldsForSave = ({
  modelDirty = false,
  selectedModelProvider = "",
  selectedAuthProvider = "",
  dirtyCredentialKeys = [],
} = {}) => {
  const fieldsByKey = new Map();
  const addFields = (fields = []) => {
    fields.forEach((field) => {
      if (field?.key) fieldsByKey.set(field.key, field);
    });
  };

  if (modelDirty && selectedModelProvider !== "openai-codex") {
    addFields(kProviderAuthFields[selectedAuthProvider] || []);
  }

  const dirtyKeySet =
    dirtyCredentialKeys instanceof Set
      ? dirtyCredentialKeys
      : new Set(dirtyCredentialKeys || []);
  addFields(kAllAiAuthFields.filter((field) => dirtyKeySet.has(field.key)));

  return [...fieldsByKey.values()];
};
