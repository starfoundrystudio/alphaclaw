const {
  createGatewayTailscaleClient,
} = require("./gateway-tailscale-client");
const {
  getEnvValue,
  normalizeDnsName,
  upsertEnvVar,
} = require("./tailscale-env");

const kConnectivityModeLocal = "local";
const kConnectivityModeSecurityGateway = "security_gateway";
const kGatewayHostRole = "security_gateway";

const getConnectivityMode = ({ env = process.env, envVars = [] } = {}) => {
  const mode =
    getEnvValue(env, envVars, ["ALPHACLAW_CONNECTIVITY_MODE"]) ||
    kConnectivityModeLocal;
  if (
    mode !== kConnectivityModeLocal &&
    mode !== kConnectivityModeSecurityGateway
  ) {
    throw new Error(`Unsupported AlphaClaw connectivity mode: ${mode}`);
  }
  return mode;
};

const parseGatewayStoredResult = ({
  env = process.env,
  envVars = [],
  funnelPort,
}) => {
  const setupUrl =
    getEnvValue(env, envVars, ["ALPHACLAW_GATEWAY_PENDING_SETUP_URL"]) ||
    getEnvValue(env, envVars, ["ALPHACLAW_SETUP_URL"]);
  const publicBaseUrl =
    getEnvValue(env, envVars, [
      "ALPHACLAW_GATEWAY_PENDING_PUBLIC_BASE_URL",
    ]) ||
    getEnvValue(env, envVars, ["ALPHACLAW_PUBLIC_BASE_URL"]);
  const dnsName = normalizeDnsName(
    getEnvValue(env, envVars, ["ALPHACLAW_TAILSCALE_DNS"]),
  ).toLowerCase();
  const deviceId = getEnvValue(env, envVars, [
    "ALPHACLAW_TAILSCALE_DEVICE_ID",
  ]);
  if (
    !setupUrl ||
    !publicBaseUrl ||
    !dnsName ||
    !deviceId ||
    deviceId.length > 512 ||
    /[\r\n\0]/.test(deviceId)
  ) {
    return null;
  }

  try {
    const setup = new URL(setupUrl);
    const publicUrl = new URL(publicBaseUrl);
    if (
      setup.protocol !== "https:" ||
      setup.port ||
      setup.pathname !== "/" ||
      setup.search ||
      setup.hash ||
      publicUrl.protocol !== "https:" ||
      publicUrl.port !== String(funnelPort) ||
      publicUrl.pathname !== "/" ||
      publicUrl.search ||
      publicUrl.hash ||
      setup.hostname.toLowerCase() !== dnsName ||
      publicUrl.hostname.toLowerCase() !== dnsName ||
      !dnsName.endsWith(".ts.net")
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    setupUrl,
    publicBaseUrl,
    dnsName,
    deviceId,
    sealed:
      getEnvValue(env, envVars, ["ALPHACLAW_GATEWAY_SETUP_SEALED"]) ===
      "true",
  };
};

const createConfiguredGatewayClient = ({
  env,
  envVars,
  gatewayTailscaleClient,
  gatewayTailscaleClientFactory,
}) => {
  if (gatewayTailscaleClient) return gatewayTailscaleClient;
  return gatewayTailscaleClientFactory({
    host: getEnvValue(env, envVars, ["ALPHACLAW_GATEWAY_SETUP_HOST"]),
    port: getEnvValue(env, envVars, ["ALPHACLAW_GATEWAY_SETUP_PORT"]) || 22,
    user:
      getEnvValue(env, envVars, ["ALPHACLAW_GATEWAY_SETUP_USER"]) || "root",
    identityFile: getEnvValue(env, envVars, [
      "ALPHACLAW_GATEWAY_SETUP_IDENTITY_FILE",
    ]),
    knownHostsFile: getEnvValue(env, envVars, [
      "ALPHACLAW_GATEWAY_SETUP_KNOWN_HOSTS_FILE",
    ]),
  });
};

const persistPendingGatewayResult = ({
  envVars,
  result,
  writeEnvFile,
  reloadEnv,
}) => {
  upsertEnvVar(
    envVars,
    "ALPHACLAW_GATEWAY_PENDING_SETUP_URL",
    result.setupUrl,
  );
  upsertEnvVar(
    envVars,
    "ALPHACLAW_GATEWAY_PENDING_PUBLIC_BASE_URL",
    result.publicBaseUrl,
  );
  upsertEnvVar(envVars, "ALPHACLAW_TAILSCALE_DNS", result.dnsName);
  upsertEnvVar(
    envVars,
    "ALPHACLAW_TAILSCALE_DEVICE_ID",
    result.deviceId,
  );
  upsertEnvVar(
    envVars,
    "ALPHACLAW_TAILSCALE_HOST_ROLE",
    kGatewayHostRole,
  );
  upsertEnvVar(
    envVars,
    "ALPHACLAW_GATEWAY_SETUP_SEALED",
    result.sealed ? "true" : "false",
  );
  writeEnvFile(envVars);
  reloadEnv();
};

const activateGatewayResult = ({
  envVars,
  result,
  writeEnvFile,
  reloadEnv,
}) => {
  upsertEnvVar(envVars, "ALPHACLAW_SETUP_URL", result.setupUrl);
  upsertEnvVar(
    envVars,
    "ALPHACLAW_PUBLIC_BASE_URL",
    result.publicBaseUrl,
  );
  // Empty values make reloadEnv remove any pending process environment while
  // preserving one atomic env-file write for the active URL transition.
  upsertEnvVar(envVars, "ALPHACLAW_GATEWAY_PENDING_SETUP_URL", "");
  upsertEnvVar(
    envVars,
    "ALPHACLAW_GATEWAY_PENDING_PUBLIC_BASE_URL",
    "",
  );
  upsertEnvVar(envVars, "ALPHACLAW_GATEWAY_SETUP_SEALED", "true");
  writeEnvFile(envVars);
  reloadEnv();
};

const createGatewayTailscaleFinalizer = ({
  env = process.env,
  fetchImpl = global.fetch,
  writeEnvFile,
  reloadEnv,
  gatewayTailscaleClient,
  gatewayTailscaleClientFactory = createGatewayTailscaleClient,
  fetchAndApplyPolicy,
  ensureTailnetHttpsEnabled,
  createAuthKey,
  resolveDeviceId,
  callTeamYouWriteback,
  cloudOpsEmail,
}) =>
  async ({
    api,
    tailnet,
    hostname,
    servePort,
    funnelPort,
    envVars,
    writebackConfig,
  }) => {
    if (writebackConfig?.skipped) {
      throw new Error(
        "TeamYou writeback is required for security gateway onboarding",
      );
    }
    await fetchAndApplyPolicy({ api, tailnet, tailscaleSsh: false });
    await ensureTailnetHttpsEnabled({ api, tailnet });

    const resolveGatewayDeviceId = ({ dnsName, deviceId }) =>
      resolveDeviceId({
        status: { Self: { ID: deviceId } },
        api,
        tailnet,
        dnsName,
        requireTailnetMembership: true,
      });

    let client;
    const getGatewayClient = () => {
      if (!client) {
        client = createConfiguredGatewayClient({
          env,
          envVars,
          gatewayTailscaleClient,
          gatewayTailscaleClientFactory,
        });
      }
      return client;
    };

    let result = parseGatewayStoredResult({ env, envVars, funnelPort });
    if (result) {
      const verifiedDeviceId = await resolveGatewayDeviceId(result);
      if (!verifiedDeviceId) {
        throw new Error(
          "Stored security gateway does not belong to the requested Tailscale tailnet",
        );
      }
      result.deviceId = verifiedDeviceId;
    }
    if (!result) {
      const status = await getGatewayClient().status();
      let gatewayStatus = status;
      if (!status.configured) {
        const authKey = await createAuthKey({ api, tailnet });
        gatewayStatus = await getGatewayClient().configure({
          authKey,
          hostname,
          servePort,
          funnelPort,
          enableSshBridge: true,
        });
      }
      if (!gatewayStatus.configured) {
        throw new Error("Security gateway did not join the Tailscale tailnet");
      }

      const dnsName = normalizeDnsName(gatewayStatus.dnsName).toLowerCase();
      const deviceId = await resolveGatewayDeviceId({
        dnsName,
        deviceId: String(gatewayStatus.deviceId || "").trim(),
      });
      if (!dnsName || !deviceId) {
        throw new Error(
          "Security gateway does not belong to the requested Tailscale tailnet",
        );
      }
      result = {
        setupUrl: `https://${dnsName}`,
        publicBaseUrl: `https://${dnsName}:${funnelPort}`,
        dnsName,
        deviceId,
        sealed: gatewayStatus.sealed === true,
      };
      persistPendingGatewayResult({
        envVars,
        result,
        writeEnvFile,
        reloadEnv,
      });
    }

    await api.request(
      `/device/${encodeURIComponent(result.deviceId)}/device-invites`,
      {
        method: "POST",
        body: [{ email: cloudOpsEmail, multiUse: false, allowExitNode: false }],
      },
    );

    await callTeamYouWriteback({
      fetchImpl,
      setupUrl: result.setupUrl,
      publicBaseUrl: result.publicBaseUrl,
      dnsName: result.dnsName,
      deviceId: result.deviceId,
      tailscaleHostRole: kGatewayHostRole,
      writebackConfig,
    });

    if (!result.sealed) {
      await getGatewayClient().seal();
      result.sealed = true;
    }

    activateGatewayResult({
      envVars,
      result,
      writeEnvFile,
      reloadEnv,
    });

    const identityFile = getEnvValue(env, envVars, [
      "ALPHACLAW_GATEWAY_SETUP_IDENTITY_FILE",
    ]);
    if (identityFile) {
      getGatewayClient().cleanupIdentity();
    }

    return {
      setupUrl: result.setupUrl,
      publicBaseUrl: result.publicBaseUrl,
      dnsName: result.dnsName,
      deviceId: result.deviceId,
      tailnet,
    };
  };

module.exports = {
  kConnectivityModeLocal,
  kConnectivityModeSecurityGateway,
  createGatewayTailscaleFinalizer,
  getConnectivityMode,
  parseGatewayStoredResult,
};
