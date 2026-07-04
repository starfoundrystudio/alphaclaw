const { buildSecretReplacements } = require("../helpers");
const {
  ensurePluginsShell,
  ensurePluginAllowed,
  ensureUsageTrackerPluginEntry,
} = require("../usage-tracker-config");
const { isOpenAiCompatApiEnabled } = require("../alphaclaw-config");

const kDefaultToolsProfile = "full";
const kDefaultMemoryEmbeddingProvider = "openai";
const kDefaultMemoryEmbeddingModel = "text-embedding-3-small";
const kDefaultMemoryEmbeddingBaseUrl = "https://ai-gateway.vercel.sh/v1";
const kDefaultActiveMemoryAgents = ["main"];
const kDefaultActiveMemoryAllowedChatTypes = ["direct", "channel"];
const kDefaultActiveMemoryQueryMode = "recent";
const kDefaultActiveMemoryPromptStyle = "balanced";
const kDefaultActiveMemoryTimeoutMs = 15000;
const kDefaultActiveMemoryMaxSummaryChars = 220;
const kManagedActiveMemoryPluginId = "active-memory";
const kManagedTeamyouMemoryPluginId = "openclaw-teamyou-memory";
const kDisabledMemorySlot = "none";
const kAllowedDiscoveryMdnsModes = new Set(["off", "minimal", "full"]);
const kBootstrapExtraFiles = [
  "hooks/bootstrap/AGENTS.md",
  "hooks/bootstrap/TOOLS.md",
];
const kProviderApiKeyOnboardAuth = {
  anthropic: {
    envKey: "ANTHROPIC_API_KEY",
    authChoice: "apiKey",
    flagName: "--anthropic-api-key",
  },
  openai: {
    envKey: "OPENAI_API_KEY",
    authChoice: "openai-api-key",
    flagName: "--openai-api-key",
  },
  google: {
    envKey: "GEMINI_API_KEY",
    authChoice: "gemini-api-key",
    flagName: "--gemini-api-key",
  },
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    authChoice: "openrouter-api-key",
    flagName: "--openrouter-api-key",
  },
  "vercel-ai-gateway": {
    envKey: "AI_GATEWAY_API_KEY",
    authChoice: "ai-gateway-api-key",
    flagName: "--ai-gateway-api-key",
  },
  "cloudflare-ai-gateway": {
    envKey: "CLOUDFLARE_AI_GATEWAY_API_KEY",
    authChoice: "cloudflare-ai-gateway-api-key",
    flagName: "--cloudflare-ai-gateway-api-key",
  },
  kilocode: {
    envKey: "KILOCODE_API_KEY",
    authChoice: "kilocode-api-key",
    flagName: "--kilocode-api-key",
  },
  cohere: {
    envKey: "COHERE_API_KEY",
    authChoice: "cohere-api-key",
    flagName: "--cohere-api-key",
  },
  cerebras: {
    envKey: "CEREBRAS_API_KEY",
    authChoice: "cerebras-api-key",
    flagName: "--cerebras-api-key",
  },
  groq: {
    envKey: "GROQ_API_KEY",
    authChoice: "groq-api-key",
    flagName: "--groq-api-key",
  },
};

const normalizeActiveMemoryConfig = (rawConfig) => {
  const source =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? rawConfig
      : {};
  const { modelFallbackPolicy: _modelFallbackPolicy, ...config } = source;
  return config;
};

const buildProviderApiKeyArgs = ({ provider, varMap }) => {
  const authMeta = kProviderApiKeyOnboardAuth[String(provider || "").trim()];
  if (!authMeta) return null;
  const value = String(varMap?.[authMeta.envKey] || "").trim();
  if (!value) return null;
  return ["--auth-choice", authMeta.authChoice, authMeta.flagName, value];
};

const buildOnboardArgs = ({
  varMap,
  selectedProvider,
  hasCodexOauth,
  hasClaudeCli,
  agentRuntimeId,
  workspaceDir,
}) => {
  const openclawGatewayToken =
    varMap.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || "";
  const anthropicToken = varMap.ANTHROPIC_TOKEN || "";
  const openaiApiKey = varMap.OPENAI_API_KEY || "";
  const onboardArgs = [
    "--non-interactive",
    "--accept-risk",
    "--flow",
    "quickstart",
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    "18789",
    "--gateway-auth",
    "token",
    "--gateway-token",
    openclawGatewayToken,
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    workspaceDir,
  ];
  const selectedProviderApiKeyArgs = buildProviderApiKeyArgs({
    provider: selectedProvider,
    varMap,
  });

  const shouldSkipAuthForCodexOauth =
    hasCodexOauth &&
    (selectedProvider === "openai-codex" ||
      (selectedProvider === "openai" && agentRuntimeId === "codex"));
  const shouldSkipAuthForClaudeCli =
    hasClaudeCli && selectedProvider === "anthropic" && agentRuntimeId === "claude-cli";

  if (shouldSkipAuthForCodexOauth) {
    onboardArgs.push("--auth-choice", "skip");
  } else if (shouldSkipAuthForClaudeCli) {
    onboardArgs.push("--auth-choice", "skip");
  } else if (selectedProvider === "openai-codex" && openaiApiKey) {
    onboardArgs.push(
      "--auth-choice",
      "openai-api-key",
      "--openai-api-key",
      openaiApiKey,
    );
  } else if ((selectedProvider === "anthropic" || !selectedProvider) && anthropicToken) {
    onboardArgs.push(
      "--auth-choice",
      "token",
      "--token-provider",
      "anthropic",
      "--token",
      anthropicToken,
    );
  } else if (selectedProviderApiKeyArgs) {
    onboardArgs.push(...selectedProviderApiKeyArgs);
  } else if (anthropicToken) {
    onboardArgs.push(
      "--auth-choice",
      "token",
      "--token-provider",
      "anthropic",
      "--token",
      anthropicToken,
    );
  } else {
    const fallbackProviderOrder = [
      "anthropic",
      "openai",
      "google",
      "openrouter",
      "vercel-ai-gateway",
      "cloudflare-ai-gateway",
      "kilocode",
      "cohere",
      "cerebras",
      "groq",
    ];
    const fallbackApiKeyArgs = fallbackProviderOrder
      .map((provider) => buildProviderApiKeyArgs({ provider, varMap }))
      .find(Boolean);
    if (fallbackApiKeyArgs) {
      onboardArgs.push(...fallbackApiKeyArgs);
    } else if (hasCodexOauth) {
      onboardArgs.push("--auth-choice", "skip");
    }
  }

  return onboardArgs;
};

const ensureManagedConfigShell = (cfg, { openAiCompatApiEnabled = false } = {}) => {
  if (!cfg.channels) cfg.channels = {};
  ensurePluginsShell(cfg);
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.defaults) cfg.agents.defaults = {};
  if (!cfg.commands) cfg.commands = {};
  if (!cfg.tools) cfg.tools = {};
  if (!cfg.update) cfg.update = {};
  if (!cfg.gateway) cfg.gateway = {};
  if (!cfg.approvals || typeof cfg.approvals !== "object" || Array.isArray(cfg.approvals)) {
    cfg.approvals = {};
  }
  if (
    !cfg.approvals.plugin ||
    typeof cfg.approvals.plugin !== "object" ||
    Array.isArray(cfg.approvals.plugin)
  ) {
    cfg.approvals.plugin = {};
  }
  if (cfg.approvals.plugin.enabled === undefined) {
    cfg.approvals.plugin.enabled = true;
  }
  if (!String(cfg.approvals.plugin.mode || "").trim()) {
    cfg.approvals.plugin.mode = "session";
  }
  if (!cfg.hooks) cfg.hooks = {};
  if (!cfg.hooks.internal) cfg.hooks.internal = {};
  if (!cfg.hooks.internal.entries) cfg.hooks.internal.entries = {};
  cfg.commands.restart = true;
  cfg.tools.profile = kDefaultToolsProfile;
  cfg.update.checkOnStart = false;
  if (openAiCompatApiEnabled) {
    if (!cfg.gateway.http) cfg.gateway.http = {};
    if (!cfg.gateway.http.endpoints) cfg.gateway.http.endpoints = {};
    cfg.gateway.http.endpoints.chatCompletions = {
      ...(cfg.gateway.http.endpoints.chatCompletions || {}),
      enabled: true,
    };
    cfg.gateway.http.endpoints.responses = {
      ...(cfg.gateway.http.endpoints.responses || {}),
      enabled: true,
    };
  }
  cfg.hooks.internal.enabled = true;
  cfg.hooks.internal.entries["bootstrap-extra-files"] = {
    ...(cfg.hooks.internal.entries["bootstrap-extra-files"] || {}),
    enabled: true,
    paths: kBootstrapExtraFiles,
  };
  if (!cfg.plugins.slots || typeof cfg.plugins.slots !== "object") {
    cfg.plugins.slots = {};
  }
  if (!String(cfg.plugins.slots.memory || "").trim()) {
    cfg.plugins.slots.memory = kDisabledMemorySlot;
  }
  const activeMemoryEntry = cfg.plugins.entries[kManagedActiveMemoryPluginId] || {};
  const activeMemoryConfig = normalizeActiveMemoryConfig(activeMemoryEntry.config);
  cfg.plugins.entries[kManagedActiveMemoryPluginId] = {
    ...activeMemoryEntry,
    enabled: true,
    config: {
      ...activeMemoryConfig,
      agents: kDefaultActiveMemoryAgents,
      allowedChatTypes: kDefaultActiveMemoryAllowedChatTypes,
      queryMode:
        activeMemoryConfig.queryMode ||
        kDefaultActiveMemoryQueryMode,
      promptStyle:
        activeMemoryConfig.promptStyle ||
        kDefaultActiveMemoryPromptStyle,
      timeoutMs:
        activeMemoryConfig.timeoutMs ||
        kDefaultActiveMemoryTimeoutMs,
      maxSummaryChars:
        activeMemoryConfig.maxSummaryChars ||
        kDefaultActiveMemoryMaxSummaryChars,
      persistTranscripts:
        activeMemoryConfig.persistTranscripts ?? false,
      logging: activeMemoryConfig.logging ?? true,
    },
  };
};

const applyManagedMemorySearchDefaults = ({ cfg, varMap }) => {
  if (!String(varMap?.AI_GATEWAY_API_KEY || "").trim()) return;
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.defaults) cfg.agents.defaults = {};
  if (!cfg.agents.defaults.memorySearch) cfg.agents.defaults.memorySearch = {};
  if (!cfg.agents.defaults.memorySearch.remote) cfg.agents.defaults.memorySearch.remote = {};
  cfg.agents.defaults.memorySearch.provider = kDefaultMemoryEmbeddingProvider;
  cfg.agents.defaults.memorySearch.model = kDefaultMemoryEmbeddingModel;
  cfg.agents.defaults.memorySearch.remote.baseUrl = kDefaultMemoryEmbeddingBaseUrl;
  cfg.agents.defaults.memorySearch.remote.apiKey = "${AI_GATEWAY_API_KEY}";
};

const ensureModelProviderShell = (cfg, providerId) => {
  if (!cfg.models || typeof cfg.models !== "object") cfg.models = {};
  if (!cfg.models.providers || typeof cfg.models.providers !== "object") {
    cfg.models.providers = {};
  }
  if (
    !cfg.models.providers[providerId] ||
    typeof cfg.models.providers[providerId] !== "object" ||
    Array.isArray(cfg.models.providers[providerId])
  ) {
    cfg.models.providers[providerId] = {};
  }
  return cfg.models.providers[providerId];
};

const applyManagedAgentRuntimeDefault = ({ cfg, agentRuntimeId, modelKey }) => {
  const normalizedRuntimeId = String(agentRuntimeId || "").trim();
  if (normalizedRuntimeId === "claude-cli") {
    const normalizedModelKey = String(modelKey || "").trim();
    if (!normalizedModelKey) return;
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (!cfg.agents.defaults.models || typeof cfg.agents.defaults.models !== "object") {
      cfg.agents.defaults.models = {};
    }
    const existingModelEntry =
      cfg.agents.defaults.models[normalizedModelKey] &&
      typeof cfg.agents.defaults.models[normalizedModelKey] === "object" &&
      !Array.isArray(cfg.agents.defaults.models[normalizedModelKey])
        ? cfg.agents.defaults.models[normalizedModelKey]
        : {};
    cfg.agents.defaults.models[normalizedModelKey] = {
      ...existingModelEntry,
      agentRuntime: {
        ...(existingModelEntry.agentRuntime &&
        typeof existingModelEntry.agentRuntime === "object" &&
        !Array.isArray(existingModelEntry.agentRuntime)
          ? existingModelEntry.agentRuntime
          : {}),
        id: "claude-cli",
      },
    };
    if (cfg.agents.defaults.agentRuntime) {
      delete cfg.agents.defaults.agentRuntime;
    }
    ensurePluginAllowed({ cfg, pluginKey: "anthropic" });
    cfg.plugins.entries.anthropic = {
      ...(cfg.plugins.entries.anthropic || {}),
      enabled: true,
    };
    return;
  }
  if (normalizedRuntimeId !== "codex") return;
  const openAiProvider = ensureModelProviderShell(cfg, "openai");
  openAiProvider.agentRuntime = {
    ...(openAiProvider.agentRuntime &&
    typeof openAiProvider.agentRuntime === "object" &&
    !Array.isArray(openAiProvider.agentRuntime)
      ? openAiProvider.agentRuntime
      : {}),
    id: "codex",
  };
  if (cfg.agents?.defaults?.agentRuntime) {
    delete cfg.agents.defaults.agentRuntime;
  }
  ensurePluginAllowed({ cfg, pluginKey: "codex" });
  cfg.plugins.entries.codex = {
    ...(cfg.plugins.entries.codex || {}),
    enabled: true,
  };
};

const applyRequiredManagedPluginEntries = ({ cfg, requiredPlugins = [] } = {}) => {
  const pluginIds = Array.isArray(requiredPlugins)
    ? requiredPlugins.map((pluginId) => String(pluginId || "").trim()).filter(Boolean)
    : [];
  for (const pluginKey of [...new Set(pluginIds)]) {
    ensurePluginAllowed({ cfg, pluginKey });
    cfg.plugins.entries[pluginKey] = {
      ...(cfg.plugins.entries[pluginKey] || {}),
      enabled: true,
    };
  }
};

const shouldGateManagedTeamyouMemory = ({ cfg, requiredPlugins = [] } = {}) => {
  const requiredPluginIds = Array.isArray(requiredPlugins)
    ? requiredPlugins.map((pluginId) => String(pluginId || "").trim()).filter(Boolean)
    : [];
  return (
    requiredPluginIds.includes(kManagedTeamyouMemoryPluginId) ||
    !!cfg.plugins?.entries?.[kManagedTeamyouMemoryPluginId]
  );
};

const disableManagedTeamyouMemoryUntilBootstrap = ({ cfg, requiredPlugins = [] } = {}) => {
  if (!shouldGateManagedTeamyouMemory({ cfg, requiredPlugins })) return;
  if (!cfg.plugins.slots || typeof cfg.plugins.slots !== "object") {
    cfg.plugins.slots = {};
  }
  cfg.plugins.slots.memory = kDisabledMemorySlot;
};

const applyManagedCodexNativeWebSearchDefault = ({
  cfg,
  agentRuntimeId,
  preserveExplicitGlobalDisable = false,
}) => {
  const normalizedRuntimeId = String(agentRuntimeId || "").trim();
  if (normalizedRuntimeId !== "codex") return;
  if (preserveExplicitGlobalDisable && cfg.tools?.web?.search?.enabled === false) {
    return;
  }
  if (!cfg.tools) cfg.tools = {};
  if (!cfg.tools.web) cfg.tools.web = {};
  if (!cfg.tools.web.search) cfg.tools.web.search = {};
  cfg.tools.web.search.enabled = true;
  cfg.tools.web.search.openaiCodex = {
    ...(cfg.tools.web.search.openaiCodex || {}),
    enabled: true,
    mode: cfg.tools.web.search.openaiCodex?.mode || "cached",
  };
};

const normalizeManagedDiscoveryMdnsMode = (rawValue = process.env.OPENCLAW_DISCOVERY_MDNS_MODE) => {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (!kAllowedDiscoveryMdnsModes.has(normalized)) return null;
  return normalized;
};

const applyManagedDiscoveryMdnsMode = ({ cfg, envValue }) => {
  const mode = normalizeManagedDiscoveryMdnsMode(envValue);
  if (!mode) return;
  cfg.discovery ||= {};
  cfg.discovery.mdns ||= {};
  cfg.discovery.mdns.mode = mode;
};

const getSafeImportedDmPolicy = (channelConfig = {}) => {
  if (
    channelConfig?.dmPolicy === "allowlist" &&
    (!Array.isArray(channelConfig?.allowFrom) ||
      channelConfig.allowFrom.length === 0)
  ) {
    return "pairing";
  }
  return channelConfig?.dmPolicy || "pairing";
};

const applyFreshOnboardingChannels = ({
  cfg,
  varMap,
}) => {
  if (varMap.TELEGRAM_BOT_TOKEN) {
    cfg.channels.telegram = {
      enabled: true,
      botToken: varMap.TELEGRAM_BOT_TOKEN,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    };
    cfg.plugins.entries.telegram = { enabled: true };
    ensurePluginAllowed({ cfg, pluginKey: "telegram" });
    console.log("[onboard] Telegram configured");
  }
  if (varMap.DISCORD_BOT_TOKEN) {
    cfg.channels.discord = {
      enabled: true,
      token: varMap.DISCORD_BOT_TOKEN,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    };
    cfg.plugins.entries.discord = { enabled: true };
    ensurePluginAllowed({ cfg, pluginKey: "discord" });
    console.log("[onboard] Discord configured");
  }
  if (varMap.SLACK_BOT_TOKEN && varMap.SLACK_APP_TOKEN) {
    cfg.channels.slack = {
      enabled: true,
      botToken: varMap.SLACK_BOT_TOKEN,
      appToken: varMap.SLACK_APP_TOKEN,
      mode: "socket",
      dmPolicy: "pairing",
      groupPolicy: "open",
    };
    cfg.plugins.entries.slack = { enabled: true };
    ensurePluginAllowed({ cfg, pluginKey: "slack" });
    console.log("[onboard] Slack configured");
  }
  if (varMap.WHATSAPP_OWNER_NUMBER) {
    cfg.channels.whatsapp = {
      enabled: true,
      allowFrom: [varMap.WHATSAPP_OWNER_NUMBER],
      groupAllowFrom: [varMap.WHATSAPP_OWNER_NUMBER],
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      selfChatMode: true,
    };
    cfg.plugins.entries.whatsapp = { enabled: true };
    ensurePluginAllowed({ cfg, pluginKey: "whatsapp" });
    console.log("[onboard] WhatsApp configured");
  }
  ensureUsageTrackerPluginEntry(cfg);
};

const writeSanitizedOpenclawConfig = ({
  fs,
  openclawDir,
  varMap,
  agentRuntimeId,
  modelKey,
  requiredPlugins,
}) => {
  const configPath = `${openclawDir}/openclaw.json`;
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  ensureManagedConfigShell(cfg, {
    openAiCompatApiEnabled: isOpenAiCompatApiEnabled({
      fsModule: fs,
      openclawDir,
    }),
  });
  applyManagedMemorySearchDefaults({ cfg, varMap });
  applyManagedAgentRuntimeDefault({ cfg, agentRuntimeId, modelKey });
  applyRequiredManagedPluginEntries({ cfg, requiredPlugins });
  disableManagedTeamyouMemoryUntilBootstrap({ cfg, requiredPlugins });
  applyManagedCodexNativeWebSearchDefault({ cfg, agentRuntimeId });
  applyManagedDiscoveryMdnsMode({ cfg });
  applyFreshOnboardingChannels({ cfg, varMap });

  let content = JSON.stringify(cfg, null, 2);
  const replacements = buildSecretReplacements(varMap, process.env);
  for (const [secret, envRef] of replacements) {
    if (secret) {
      // Only replace exact JSON string values so path substrings are never mutated.
      const secretJson = JSON.stringify(secret);
      content = content.replace(
        new RegExp(
          secretJson.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"),
          "g",
        ),
        JSON.stringify(envRef),
      );
    }
  }
  fs.writeFileSync(configPath, content);
  console.log("[onboard] Config sanitized");
};

const writeManagedImportOpenclawConfig = ({
  fs,
  openclawDir,
  varMap,
  agentRuntimeId,
  modelKey,
  requiredPlugins,
}) => {
  const configPath = `${openclawDir}/openclaw.json`;
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  ensureManagedConfigShell(cfg, {
    openAiCompatApiEnabled: isOpenAiCompatApiEnabled({
      fsModule: fs,
      openclawDir,
    }),
  });
  applyManagedMemorySearchDefaults({ cfg, varMap });
  applyManagedAgentRuntimeDefault({ cfg, agentRuntimeId, modelKey });
  applyRequiredManagedPluginEntries({ cfg, requiredPlugins });
  disableManagedTeamyouMemoryUntilBootstrap({ cfg, requiredPlugins });
  applyManagedCodexNativeWebSearchDefault({
    cfg,
    agentRuntimeId,
    preserveExplicitGlobalDisable: true,
  });
  applyManagedDiscoveryMdnsMode({ cfg });

  ensureUsageTrackerPluginEntry(cfg);

  if (varMap.TELEGRAM_BOT_TOKEN) {
    cfg.channels.telegram = {
      ...(cfg.channels.telegram || {}),
      enabled: true,
      botToken: "${TELEGRAM_BOT_TOKEN}",
      dmPolicy: getSafeImportedDmPolicy(cfg.channels.telegram),
      groupPolicy: cfg.channels.telegram?.groupPolicy || "allowlist",
    };
    cfg.plugins.entries.telegram = {
      ...(cfg.plugins.entries.telegram || {}),
      enabled: true,
    };
    ensurePluginAllowed({ cfg, pluginKey: "telegram" });
  }

  if (varMap.DISCORD_BOT_TOKEN) {
    cfg.channels.discord = {
      ...(cfg.channels.discord || {}),
      enabled: true,
      token: "${DISCORD_BOT_TOKEN}",
      dmPolicy: getSafeImportedDmPolicy(cfg.channels.discord),
      groupPolicy: cfg.channels.discord?.groupPolicy || "allowlist",
    };
    cfg.plugins.entries.discord = {
      ...(cfg.plugins.entries.discord || {}),
      enabled: true,
    };
    ensurePluginAllowed({ cfg, pluginKey: "discord" });
  }

  if (varMap.SLACK_BOT_TOKEN && varMap.SLACK_APP_TOKEN) {
    cfg.channels.slack = {
      ...(cfg.channels.slack || {}),
      enabled: true,
      botToken: "${SLACK_BOT_TOKEN}",
      appToken: "${SLACK_APP_TOKEN}",
      mode: cfg.channels.slack?.mode || "socket",
      dmPolicy: getSafeImportedDmPolicy(cfg.channels.slack),
      groupPolicy: cfg.channels.slack?.groupPolicy || "open",
    };
    cfg.plugins.entries.slack = {
      ...(cfg.plugins.entries.slack || {}),
      enabled: true,
    };
    ensurePluginAllowed({ cfg, pluginKey: "slack" });
  }

  if (varMap.WHATSAPP_OWNER_NUMBER) {
    const existingWhatsApp = cfg.channels.whatsapp || {};
    const existingAllowFrom = Array.isArray(existingWhatsApp.allowFrom)
      ? existingWhatsApp.allowFrom
      : [];
    const ownerRef = "${WHATSAPP_OWNER_NUMBER}";
    cfg.channels.whatsapp = {
      ...existingWhatsApp,
      enabled: true,
      allowFrom: existingAllowFrom.includes(ownerRef)
        ? existingAllowFrom
        : [...existingAllowFrom, ownerRef],
      groupAllowFrom: existingAllowFrom.includes(ownerRef)
        ? existingAllowFrom
        : [...existingAllowFrom, ownerRef],
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      selfChatMode: true,
    };
    cfg.plugins.entries.whatsapp = {
      ...(cfg.plugins.entries.whatsapp || {}),
      enabled: true,
    };
    ensurePluginAllowed({ cfg, pluginKey: "whatsapp" });
  }

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
};

module.exports = {
  buildOnboardArgs,
  applyRequiredManagedPluginEntries,
  writeManagedImportOpenclawConfig,
  writeSanitizedOpenclawConfig,
};
