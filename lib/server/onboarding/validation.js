const { getEnvVarForApiKeyProvider } = require("../auth-profiles");
const { getGithubBackupConfig } = require("../github-backup");

const kAnthropicSetupTokenPrefix = "sk-ant-oat01-";
const kAnthropicApiKeyPrefix = "sk-ant-api";

const getCodexOauthModelKeyForOpenAiModel = (modelKey) => {
  const parts = String(modelKey || "").trim().split("/");
  if (parts[0] !== "openai" || parts.length < 2) return String(modelKey || "").trim();
  return ["openai-codex", ...parts.slice(1)].join("/");
};

const validateAnthropicCredentialShape = (varMap) => {
  const anthropicToken = String(varMap.ANTHROPIC_TOKEN || "").trim();
  const anthropicApiKey = String(varMap.ANTHROPIC_API_KEY || "").trim();
  if (
    anthropicToken &&
    !anthropicToken.startsWith(kAnthropicSetupTokenPrefix)
  ) {
    return {
      ok: false,
      status: 400,
      error: `ANTHROPIC_TOKEN must start with ${kAnthropicSetupTokenPrefix}`,
    };
  }
  if (anthropicApiKey && !anthropicApiKey.startsWith(kAnthropicApiKeyPrefix)) {
    return {
      ok: false,
      status: 400,
      error: `ANTHROPIC_API_KEY must start with ${kAnthropicApiKeyPrefix}`,
    };
  }
  return { ok: true };
};

const validateOnboardingInput = ({
  vars,
  modelKey,
  agentRuntimeId,
  resolveModelProvider,
  hasCodexOauthProfile,
  importMode = false,
}) => {
  const kMaxOnboardingVars = 64;
  const kMaxEnvKeyLength = 128;
  const kMaxEnvValueLength = 4096;
  if (!Array.isArray(vars)) {
    return { ok: false, status: 400, error: "Missing vars array" };
  }
  if (vars.length > kMaxOnboardingVars) {
    return {
      ok: false,
      status: 400,
      error: `Too many environment variables (max ${kMaxOnboardingVars})`,
    };
  }
  if (!modelKey || typeof modelKey !== "string" || !modelKey.includes("/")) {
    return { ok: false, status: 400, error: "A model selection is required" };
  }

  for (const entry of vars) {
    const key = String(entry?.key || "");
    const value = String(entry?.value || "");
    if (!key) {
      return { ok: false, status: 400, error: "Each variable must include a key" };
    }
    if (key.length > kMaxEnvKeyLength) {
      return {
        ok: false,
        status: 400,
        error: `Variable key is too long: ${key.slice(0, 32)}...`,
      };
    }
    if (value.length > kMaxEnvValueLength) {
      return {
        ok: false,
        status: 400,
        error: `Value too long for ${key} (max ${kMaxEnvValueLength} chars)`,
      };
    }
  }

  const varMap = Object.fromEntries(vars.map((v) => [v.key, v.value]));
  const anthropicValidation = validateAnthropicCredentialShape(varMap);
  if (!anthropicValidation.ok) return anthropicValidation;
  const {
    githubToken,
    githubRepoInput,
    hasGithubBackup,
    hasAnyGithubBackupInput,
    hasGithubToken,
    hasGithubRepo,
  } = getGithubBackupConfig(varMap);
  const requestedProvider = resolveModelProvider(modelKey);
  const hasCodexOauth = hasCodexOauthProfile();
  const requestedAgentRuntimeId = String(agentRuntimeId || "").trim();
  if (requestedAgentRuntimeId && requestedAgentRuntimeId !== "codex") {
    return {
      ok: false,
      status: 400,
      error: `Unsupported agent runtime "${requestedAgentRuntimeId}"`,
    };
  }
  if (requestedAgentRuntimeId === "codex" && requestedProvider !== "openai") {
    return {
      ok: false,
      status: 400,
      error: "Codex runtime requires an OpenAI model",
    };
  }
  if (requestedAgentRuntimeId === "codex" && !hasCodexOauth) {
    return {
      ok: false,
      status: 400,
      error: "Connect OpenAI Codex OAuth before continuing",
    };
  }
  const shouldUseCodexOauthPiRoute =
    requestedProvider === "openai" &&
    !requestedAgentRuntimeId &&
    hasCodexOauth &&
    !String(varMap.OPENAI_API_KEY || "").trim();
  const effectiveModelKey = shouldUseCodexOauthPiRoute
    ? getCodexOauthModelKeyForOpenAiModel(modelKey)
    : modelKey;
  const selectedProvider = shouldUseCodexOauthPiRoute
    ? "openai-codex"
    : requestedProvider;
  const hasAnyAi = !!(
    varMap.ANTHROPIC_API_KEY ||
    varMap.ANTHROPIC_TOKEN ||
    varMap.OPENAI_API_KEY ||
    varMap.GEMINI_API_KEY ||
    hasCodexOauth
  );
  const hasAi = (() => {
    if (selectedProvider === "openai" && requestedAgentRuntimeId === "codex") {
      return hasCodexOauth;
    }
    if (selectedProvider === "openai-codex") {
      return hasCodexOauth;
    }
    if (selectedProvider === "anthropic") {
      return !!(varMap.ANTHROPIC_API_KEY || varMap.ANTHROPIC_TOKEN);
    }
    const envKey = getEnvVarForApiKeyProvider(selectedProvider);
    if (envKey) {
      return !!String(varMap[envKey] || "").trim();
    }
    return hasAnyAi;
  })();
  if (!hasAi) {
    if (selectedProvider === "openai-codex") {
      return {
        ok: false,
        status: 400,
        error: "Connect OpenAI Codex OAuth before continuing",
      };
    }
    return {
      ok: false,
      status: 400,
      error: `Missing credentials for selected provider "${selectedProvider}"`,
    };
  }
  if (importMode && !hasGithubBackup) {
    return {
      ok: false,
      status: 400,
      error: "GitHub token and workspace repo are required to import an existing setup",
    };
  }
  if (hasAnyGithubBackupInput && !hasGithubBackup) {
    return {
      ok: false,
      status: 400,
      error: hasGithubToken
        ? 'GITHUB_WORKSPACE_REPO must be set to enable GitHub backup'
        : hasGithubRepo
          ? "GITHUB_TOKEN must be set to enable GitHub backup"
          : "GitHub backup requires both GITHUB_TOKEN and GITHUB_WORKSPACE_REPO",
    };
  }

  return {
    ok: true,
    data: {
      varMap,
      githubToken,
      githubRepoInput,
      modelKey: effectiveModelKey,
      selectedProvider,
      hasCodexOauth,
      agentRuntimeId: requestedAgentRuntimeId || null,
      hasGithubBackup,
    },
  };
};

module.exports = { validateOnboardingInput };
