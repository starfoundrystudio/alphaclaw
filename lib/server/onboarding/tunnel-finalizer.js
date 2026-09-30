const {
  kIngressModeCloudflareTunnel,
  normalizeTunnelOrigin,
  readConfiguredTunnelUrls,
} = require("../../ingress-mode");
const {
  getConnectivityMode,
  kConnectivityModeSecurityGateway,
} = require("./gateway-tailscale-finalizer");
const {
  callTeamYouTunnelWriteback,
  getTeamYouWritebackConfig,
} = require("./tailscale-finalizer");

// Cloudflare Tunnel ingress: TeamYou fixed all three URLs at plan time and
// wrote them into the instance env at first boot (contract C1/C2). The
// gateway is already configured and sealed by its installer, so there is no
// Tailscale step, no gateway configure/seal, and no URL change: onboarding
// only reports the final facts back to TeamYou (contract C5).
const kTunnelUrlLabels = {
  setupUrl: "ALPHACLAW_SETUP_URL",
  publicBaseUrl: "ALPHACLAW_PUBLIC_BASE_URL",
  agentVaultOperatorUrl: "AGENT_VAULT_OPERATOR_URL",
};

const readTunnelOnboardingUrls = ({ env = process.env, envVars = [] } = {}) => {
  const configured = readConfiguredTunnelUrls({ env, envVars });
  const urls = {};
  for (const [key, envKey] of Object.entries(kTunnelUrlLabels)) {
    const origin = normalizeTunnelOrigin(configured[key]);
    if (!origin) {
      throw new Error(
        `Cloudflare Tunnel setup is incomplete: ${envKey} must be an https origin`,
      );
    }
    urls[key] = origin;
  }
  return urls;
};

const createTunnelFinalizer = ({
  env = process.env,
  readEnvFile,
  fetchImpl = global.fetch,
} = {}) => {
  const getEnvVars = () =>
    typeof readEnvFile === "function" ? [...readEnvFile()] : [];

  // Everything that can be checked before any setup work runs.
  const readTunnelSetup = () => {
    const envVars = getEnvVars();
    if (
      getConnectivityMode({ env, envVars }) !== kConnectivityModeSecurityGateway
    ) {
      throw new Error(
        "Cloudflare Tunnel setup requires the security gateway connectivity mode",
      );
    }
    const urls = readTunnelOnboardingUrls({ env, envVars });
    const writebackConfig = getTeamYouWritebackConfig({ env, envVars });
    if (writebackConfig.skipped) {
      throw new Error(
        "TeamYou writeback is required for Cloudflare Tunnel onboarding",
      );
    }
    return { urls, writebackConfig };
  };

  const reportNetworkFinalized = async () => {
    const { urls, writebackConfig } = readTunnelSetup();
    await callTeamYouTunnelWriteback({
      fetchImpl,
      writebackConfig,
      ...urls,
    });
    return { ...urls, ingressMode: kIngressModeCloudflareTunnel };
  };

  return { readTunnelSetup, reportNetworkFinalized };
};

module.exports = {
  createTunnelFinalizer,
  readTunnelOnboardingUrls,
};
