const { getEnvVarForApiKeyProvider } = require("../auth-profiles");

// Vault-brokered model providers (docs/vault-brokered-model-keys-spec.md).
//
// Each entry maps an API-key model provider to the vault service(s) that
// front its API host(s). The credential slot reuses the provider's env var
// name, and the value stored on-box (.env + auth store) is a non-secret
// `__av_*__` placeholder; the vault proxy substitutes the real key in the
// header (or query) surface of requests to these hosts.
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
  groq: {
    hosts: ["api.groq.com"],
    obtain: "https://console.groq.com",
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
  // Gateway access routes. Fixed hosts (account/gateway ids live in the
  // path, never the host), keys ride verbatim in headers.
  "vercel-ai-gateway": {
    hosts: ["ai-gateway.vercel.sh"],
    obtain: "https://vercel.com/dashboard",
  },
  "cloudflare-ai-gateway": {
    hosts: ["gateway.ai.cloudflare.com"],
    obtain: "https://dash.cloudflare.com",
  },
  kilocode: {
    hosts: ["api.kilo.ai"],
    obtain: "https://app.kilo.ai",
  },
  fireworks: {
    hosts: ["api.fireworks.ai"],
    obtain: "https://app.fireworks.ai",
  },
  venice: {
    hosts: ["api.venice.ai"],
    obtain: "https://venice.ai/settings/api",
  },
  "tencent-tokenhub": {
    hosts: ["tokenhub.tencentmaas.com", "tokenhub-intl.tencentmaas.com"],
    obtain: "https://cloud.tencent.com/product/tokenhub",
  },
};

// Approval-page display names; unlisted providers fall back to their id.
const kModelProviderLabels = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  openrouter: "OpenRouter",
  moonshot: "Moonshot",
  mistral: "Mistral",
  xai: "xAI",
  together: "Together AI",
  novita: "Novita",
  nvidia: "NVIDIA",
  minimax: "MiniMax",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  groq: "Groq",
  deepgram: "Deepgram",
  voyage: "Voyage AI",
  zai: "Z.AI",
  synthetic: "Synthetic",
  opencode: "OpenCode",
  "ollama-cloud": "Ollama Cloud",
  xiaomi: "Xiaomi",
  volcengine: "Volcengine",
  "volcengine-plan": "Volcengine",
  byteplus: "BytePlus",
  "byteplus-plan": "BytePlus",
  "vercel-ai-gateway": "Vercel AI Gateway",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  kilocode: "Kilo Code",
  fireworks: "Fireworks",
  venice: "Venice",
  "tencent-tokenhub": "Tencent TokenHub",
};

const getModelProviderLabel = (provider) =>
  kModelProviderLabels[String(provider || "").trim()] ||
  String(provider || "").trim();

// Placeholders are `__av_<credential key>__`. Instances brokered before
// 2026-09-24 use the longer `__agent_vault_<key>__` form; both are
// recognized, and a key whose legacy placeholder is still referenced on the
// instance keeps it, because the vault service's substitutions name that
// exact string.
const kVaultPlaceholderPattern = /^__(?:agent_vault|av)_[a-z0-9_]+__$/;

const isVaultPlaceholderValue = (value) =>
  kVaultPlaceholderPattern.test(String(value || "").trim());

const buildPlaceholderForCredentialKey = (
  credentialKey,
  { placeholdersInUse = null } = {},
) => {
  const suffix = String(credentialKey || "").trim().toLowerCase();
  const legacy = `__agent_vault_${suffix}__`;
  if (placeholdersInUse?.has?.(legacy)) return legacy;
  return `__av_${suffix}__`;
};

// True when `value` is either placeholder form for `credentialKey`.
const isPlaceholderForCredentialKey = (value, credentialKey) => {
  const suffix = String(credentialKey || "").trim().toLowerCase();
  const normalized = String(value || "").trim();
  return (
    !!suffix &&
    (normalized === `__av_${suffix}__` ||
      normalized === `__agent_vault_${suffix}__`)
  );
};

const getModelProviderVaultConfig = (
  provider,
  { placeholdersInUse = null } = {},
) => {
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
    placeholder: buildPlaceholderForCredentialKey(credentialKey, {
      placeholdersInUse,
    }),
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
const buildModelProviderAccessRequests = (provider, options = {}) => {
  const config = getModelProviderVaultConfig(provider, options);
  if (!config) return null;
  // Owner-facing copy stays short: the approval page shows userMessage and
  // one labeled field per credential ("Paste your <description>").
  const label = getModelProviderLabel(config.provider);
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
        description: `${label} API key`,
        ...(config.obtainUrl ? { obtain: config.obtainUrl } : {}),
      },
    ],
    reason: `Connect ${label} models.`,
    userMessage: `Paste your ${label} API key.`,
  }));
};

module.exports = {
  buildModelProviderAccessRequests,
  buildPlaceholderForCredentialKey,
  getModelProviderLabel,
  getModelProviderVaultConfig,
  isPlaceholderForCredentialKey,
  isVaultPlaceholderValue,
  kModelProviderVaultServices,
  listVaultBrokeredModelProviders,
};
