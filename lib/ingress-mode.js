// How this instance is reached from the internet. "tailscale" (the default)
// is today's tailnet Serve/Funnel ingress; "cloudflare_tunnel" puts the same
// gateway listeners behind fixed public hostnames that TeamYou writes into the
// instance env at first boot. Lives at lib/ root because the Agent Vault
// plugin (lib/plugin) validates approval links with it inside the Gateway.
const kIngressModeTailscale = "tailscale";
const kIngressModeCloudflareTunnel = "cloudflare_tunnel";
const kIngressModes = new Set([
  kIngressModeTailscale,
  kIngressModeCloudflareTunnel,
]);

const readEnvValue = (env = {}, envVars = [], key = "") => {
  const fromEnv = String(env?.[key] || "").trim();
  if (fromEnv) return fromEnv;
  const entry = (Array.isArray(envVars) ? envVars : []).find(
    (item) => item?.key === key,
  );
  return String(entry?.value || "").trim();
};

// Same resolution style as getOpsAccessMode: process env first, then the
// instance .env entries, lowercase, and an unknown value is a hard error.
const getIngressMode = ({ env = process.env, envVars = [] } = {}) => {
  const mode = (
    readEnvValue(env, envVars, "ALPHACLAW_INGRESS_MODE") ||
    kIngressModeTailscale
  ).toLowerCase();
  if (!kIngressModes.has(mode)) {
    throw new Error(`Unsupported Clawbridge ingress mode: ${mode}`);
  }
  return mode;
};

const isCloudflareTunnelMode = (options = {}) =>
  getIngressMode(options) === kIngressModeCloudflareTunnel;

// A tunnel-mode instance URL is a bare https origin: no port, no userinfo,
// root path, no query or fragment. Returns the normalized origin or "".
const normalizeTunnelOrigin = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  ) {
    return "";
  }
  return parsed.origin;
};

// Exact equality against the configured value; never suffix matching.
const isConfiguredTunnelOrigin = (value, configuredValue) => {
  const candidate = normalizeTunnelOrigin(value);
  const configured = normalizeTunnelOrigin(configuredValue);
  return !!candidate && !!configured && candidate === configured;
};

const kTunnelUrlEnvKeys = {
  setupUrl: "ALPHACLAW_SETUP_URL",
  publicBaseUrl: "ALPHACLAW_PUBLIC_BASE_URL",
  agentVaultOperatorUrl: "AGENT_VAULT_OPERATOR_URL",
};

const readConfiguredTunnelUrls = ({ env = process.env, envVars = [] } = {}) => ({
  setupUrl: readEnvValue(env, envVars, kTunnelUrlEnvKeys.setupUrl),
  publicBaseUrl: readEnvValue(env, envVars, kTunnelUrlEnvKeys.publicBaseUrl),
  agentVaultOperatorUrl: readEnvValue(
    env,
    envVars,
    kTunnelUrlEnvKeys.agentVaultOperatorUrl,
  ),
});

module.exports = {
  kIngressModeCloudflareTunnel,
  kIngressModeTailscale,
  kTunnelUrlEnvKeys,
  getIngressMode,
  isCloudflareTunnelMode,
  isConfiguredTunnelOrigin,
  normalizeTunnelOrigin,
  readConfiguredTunnelUrls,
};
