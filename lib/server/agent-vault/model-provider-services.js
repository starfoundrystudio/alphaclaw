const { getEnvVarForApiKeyProvider } = require("../auth-profiles");

// Vault-brokered model providers (docs/vault-brokered-model-keys-spec.md).
//
// Each entry maps an API-key model provider to the vault service(s) that
// front its API host(s). The credential slot reuses the provider's env var
// name, and the value stored on-box (.env + auth store) is a non-secret
// placeholder in the same `__agent_vault_*__` convention the TeamYou runtime
// env already uses; the vault proxy substitutes the real key in the header
// (or query) surface of requests to these hosts.
//
// Hosts must match what the OpenClaw provider registry actually dials —
// bare host, no path scoping, so same-host usage/quota endpoints keep
// working. Add a provider only after confirming its host in the pinned
// openclaw dist, and only if its client sends the key verbatim in a header
// or query surface (base64-encoded schemes cannot be substituted).
// Providers with self-hosted or user-overridable base URLs (vllm, local
// ollama) stay on the env path and must not be added.
const kModelProviderVaultServices = {
  anthropic: {
    hosts: ["api.anthropic.com"],
    obtain: "https://console.anthropic.com",
  },
  openai: {
    hosts: ["api.openai.com"],
    obtain: "https://platform.openai.com",
  },
  google: {
    hosts: ["generativelanguage.googleapis.com"],
    surfaces: ["header", "query"],
    obtain: "https://aistudio.google.com",
  },
  openrouter: {
    hosts: ["openrouter.ai"],
    obtain: "https://openrouter.ai/settings/keys",
  },
  moonshot: {
    hosts: ["api.moonshot.ai"],
    obtain: "https://platform.moonshot.ai",
  },
  mistral: {
    hosts: ["api.mistral.ai"],
    obtain: "https://console.mistral.ai",
  },
  xai: {
    hosts: ["api.x.ai"],
    obtain: "https://console.x.ai",
  },
  together: {
    hosts: ["api.together.xyz"],
    obtain: "https://api.together.ai/settings/api-keys",
  },
  novita: {
    hosts: ["api.novita.ai"],
    obtain: "https://novita.ai/settings/key-management",
  },
  nvidia: {
    hosts: ["integrate.api.nvidia.com"],
    obtain: "https://build.nvidia.com",
  },
  minimax: {
    hosts: ["api.minimax.io", "api.minimaxi.com"],
    obtain: "https://platform.minimax.io",
  },
  cohere: {
    hosts: ["api.cohere.ai"],
    obtain: "https://dashboard.cohere.com/api-keys",
  },
  deepseek: {
    hosts: ["api.deepseek.com"],
    obtain: "https://platform.deepseek.com",
  },
  deepgram: {
    hosts: ["api.deepgram.com"],
    obtain: "https://console.deepgram.com",
  },
  voyage: {
    hosts: ["api.voyageai.com"],
    obtain: "https://dashboard.voyageai.com",
  },
  zai: {
    hosts: ["api.z.ai"],
    obtain: "https://z.ai/manage-apikey/apikey-list",
  },
  synthetic: {
    hosts: ["api.synthetic.new"],
    obtain: "https://synthetic.new",
  },
  opencode: {
    hosts: ["opencode.ai"],
    obtain: "https://opencode.ai/auth",
  },
  "ollama-cloud": {
    hosts: ["ollama.com", "ai.ollama.com"],
    obtain: "https://ollama.com/settings/keys",
  },
  xiaomi: {
    hosts: ["api.xiaomimimo.com", "token-plan-sgp.xiaomimimo.com"],
    obtain: "https://platform.xiaomimimo.com",
  },
  volcengine: {
    hosts: ["ark.cn-beijing.volces.com"],
    obtain: "https://console.volcengine.com/ark",
  },
  "volcengine-plan": { alias: "volcengine" },
  byteplus: {
    hosts: ["ark.ap-southeast.bytepluses.com"],
    obtain: "https://console.byteplus.com/ark",
  },
  "byteplus-plan": { alias: "byteplus" },
};

const kVaultPlaceholderPattern = /^__agent_vault_[a-z0-9_]+__$/;

const isVaultPlaceholderValue = (value) =>
  kVaultPlaceholderPattern.test(String(value || "").trim());

const buildPlaceholderForCredentialKey = (credentialKey) =>
  `__agent_vault_${String(credentialKey || "").trim().toLowerCase()}__`;

const getModelProviderVaultConfig = (provider) => {
  const providerId = String(provider || "").trim();
  const entry = kModelProviderVaultServices[providerId];
  if (!entry) return null;
  const baseId = entry.alias || providerId;
  const base = kModelProviderVaultServices[baseId];
  if (!base || !Array.isArray(base.hosts) || base.hosts.length === 0) {
    return null;
  }
  const credentialKey = getEnvVarForApiKeyProvider(providerId);
  if (!credentialKey) return null;
  return {
    provider: providerId,
    credentialKey,
    placeholder: buildPlaceholderForCredentialKey(credentialKey),
    surfaces: base.surfaces || ["header"],
    obtainUrl: base.obtain || "",
    services: base.hosts.map((host, index) => ({
      name: index === 0 ? `model-${baseId}` : `model-${baseId}-${index + 1}`,
      host,
    })),
  };
};

const listVaultBrokeredModelProviders = () =>
  Object.keys(kModelProviderVaultServices).filter((provider) =>
    getModelProviderVaultConfig(provider),
  );

// One access request per service host; the caller merges proposal_required
// plans into a single proposal so the owner approves once per provider.
const buildModelProviderAccessRequests = (provider) => {
  const config = getModelProviderVaultConfig(provider);
  if (!config) return null;
  return config.services.map((service) => ({
    service: {
      name: service.name,
      host: service.host,
      auth: { type: "passthrough" },
      substitutions: [
        {
          key: config.credentialKey,
          placeholder: config.placeholder,
          in: config.surfaces,
        },
      ],
    },
    credentials: [
      {
        key: config.credentialKey,
        description: `${config.provider} model API key injected by Agent Vault into model API calls to ${service.host}`,
        ...(config.obtainUrl ? { obtain: config.obtainUrl } : {}),
      },
    ],
    reason: `Broker the ${config.provider} model API key so calls to ${service.host} authenticate at the Agent Vault proxy. Clawbridge stores only the non-secret placeholder ${config.placeholder} on the instance.`,
    userMessage: `Clawbridge wants Agent Vault to hold the ${config.provider} model API key and inject it into model API calls to ${service.host}. The key value is entered on the Agent Vault approval page and never stored on the instance.`,
  }));
};

module.exports = {
  buildModelProviderAccessRequests,
  buildPlaceholderForCredentialKey,
  getModelProviderVaultConfig,
  isVaultPlaceholderValue,
  kModelProviderVaultServices,
  listVaultBrokeredModelProviders,
};
