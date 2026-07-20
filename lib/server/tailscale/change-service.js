const crypto = require("crypto");
const path = require("path");
const {
  kCloudOpsEmail,
  getTailscaleApiTokenValidation,
  ensureAlphaClawTailscalePolicy,
  createTailscaleApiClient,
  normalizeDnsName,
  resolveDeviceId,
  createAuthKey,
  readTailscaleStatus,
  fetchAndApplyPolicy,
  ensureTailnetHttpsEnabled,
  getTeamYouWritebackConfig,
  callTeamYouWriteback,
  upsertEnvVar,
} = require("../onboarding/tailscale-finalizer");
const { syncBootstrapPromptFiles } = require("../onboarding/workspace");
const { redactSecretText } = require("../secret-redaction");
const {
  kTailnetManagerRequestVersion,
} = require("./host-manager");

const kDefaultTailnet = "-";
const kDefaultHostname = "alphaclaw";
const kDefaultFunnelPort = 8443;
const kPollIntervalMs = 2000;
const kMaxPollAttempts = 90;
const kHostActiveStates = new Set([
  "queued",
  "switching",
  "verifying",
  "configuring_exposure",
]);
const kHostFailureStates = new Set([
  "failed",
  "rolled_back",
  "rollback_failed",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getDnsSuffixFromDevice = (device = {}) => {
  const dnsName = normalizeDnsName(device?.name).toLowerCase();
  const hostname = normalizeDnsName(device?.hostname).toLowerCase();
  if (!dnsName || !hostname || !dnsName.endsWith(".ts.net")) return "";
  const prefix = `${hostname}.`;
  return dnsName.startsWith(prefix) ? dnsName.slice(prefix.length) : "";
};

const resolveTailnetDnsSuffix = (devices = []) => {
  for (const device of Array.isArray(devices) ? devices : []) {
    const suffix = getDnsSuffixFromDevice(device);
    if (suffix) return suffix;
  }
  return "";
};

const hasHostnameCollision = (devices = [], hostname = "") => {
  const desired = String(hostname || "").trim().toLowerCase();
  if (!desired) return false;
  return (Array.isArray(devices) ? devices : []).some((device) => {
    const deviceHostname = String(device?.hostname || "").trim().toLowerCase();
    const dnsHostname = normalizeDnsName(device?.name)
      .toLowerCase()
      .split(".")[0];
    return deviceHostname === desired || dnsHostname === desired;
  });
};

const getEnvVar = (items, key) =>
  (items || []).find((entry) => entry?.key === key)?.value || "";

const readJsonFile = (fs, filePath) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const sanitizeError = (error, fallback = "Tailnet change failed") => {
  const directMessage = typeof error === "string" ? error : "";
  return redactSecretText(
    [directMessage, error?.stderr, error?.stdout, error?.message]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n") || fallback,
  ).slice(0, 500);
};

const createHttpError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const createTailnetChangeService = ({
  fs,
  constants,
  shellCmd,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  hostManager,
  changeStore,
  ensureGatewayProxyConfig,
  restartGateway,
  fetchImpl = global.fetch,
  env = process.env,
  pollIntervalMs = kPollIntervalMs,
  maxPollAttempts = kMaxPollAttempts,
  defer = (fn) => setTimeout(fn, 0),
  logger = console,
} = {}) => {
  if (!fs || !constants || !hostManager || !changeStore) {
    throw new Error("Tailnet change service dependencies are incomplete");
  }
  const tailnet = String(env.TAILSCALE_TAILNET || kDefaultTailnet).trim() || kDefaultTailnet;
  const hostname =
    String(env.TAILSCALE_HOSTNAME || kDefaultHostname).trim() || kDefaultHostname;
  const funnelPort =
    Number(env.TAILSCALE_FUNNEL_PORT || kDefaultFunnelPort) || kDefaultFunnelPort;
  let reconcilePromise = null;
  let startPromise = null;

  const prepareTarget = async ({ tailscaleApiToken }) => {
    const validation = getTailscaleApiTokenValidation(tailscaleApiToken);
    if (!validation.ok) throw createHttpError(validation.error, 400);
    const api = createTailscaleApiClient({
      token: validation.token,
      fetchImpl,
    });
    const [policyResult, settingsResult, dnsResult, devicesResult] =
      await Promise.all([
        api.request(`/tailnet/${encodeURIComponent(tailnet)}/acl`, {
          headers: { Accept: "application/json" },
        }),
        api.request(`/tailnet/${encodeURIComponent(tailnet)}/settings`),
        api.request(`/tailnet/${encodeURIComponent(tailnet)}/dns/preferences`),
        api.request(`/tailnet/${encodeURIComponent(tailnet)}/devices`),
      ]);
    const devices = Array.isArray(devicesResult.data?.devices)
      ? devicesResult.data.devices
      : [];
    const inferredDnsSuffix = resolveTailnetDnsSuffix(devices);
    if (dnsResult.data?.magicDNS !== true) {
      throw createHttpError(
        "MagicDNS must be enabled on the new tailnet before AlphaClaw can join it.",
        400,
      );
    }
    if (hasHostnameCollision(devices, hostname)) {
      throw createHttpError(
        `The new tailnet already has a device named ${hostname}. Rename or remove that device in Tailscale before continuing.`,
        409,
      );
    }
    const { policy, changed } = ensureAlphaClawTailscalePolicy(
      policyResult.data || {},
    );
    await api.request(`/tailnet/${encodeURIComponent(tailnet)}/acl/validate`, {
      method: "POST",
      body: policy,
    });
    const inferredDnsName = inferredDnsSuffix
      ? `${hostname}.${inferredDnsSuffix}`
      : "";
    const inferredSetupUrl = inferredDnsName
      ? `https://${inferredDnsName}`
      : "";
    const inferredPublicBaseUrl = inferredDnsName
      ? `https://${inferredDnsName}:${funnelPort}`
      : "";
    return {
      api,
      inferredDnsSuffix,
      inferredSetupUrl,
      inferredPublicBaseUrl,
      policyChanged: changed,
      httpsEnabled: settingsResult.data?.httpsEnabled === true,
    };
  };

  const getCurrentNetwork = async () => {
    const envVars = typeof readEnvFile === "function" ? readEnvFile() : [];
    const status = await readTailscaleStatus({ shellCmd, required: false });
    return {
      currentDns: normalizeDnsName(status?.Self?.DNSName),
      setupUrl: String(getEnvVar(envVars, "ALPHACLAW_SETUP_URL") || "").trim(),
      publicBaseUrl: String(
        getEnvVar(envVars, "ALPHACLAW_PUBLIC_BASE_URL") || "",
      ).trim(),
    };
  };

  const validateTarget = async ({ tailscaleApiToken }) => {
    const capability = await hostManager.check({ required: false });
    if (!capability.ok) {
      throw createHttpError(
        capability.error ||
          "Change Tailnet requires a clawctl host upgrade before it can run.",
        503,
      );
    }
    const [target, current] = await Promise.all([
      prepareTarget({ tailscaleApiToken }),
      getCurrentNetwork(),
    ]);
    if (!current.currentDns) {
      throw createHttpError(
        "AlphaClaw could not determine its current Tailscale DNS name.",
        409,
      );
    }
    const currentDnsSuffix = getDnsSuffixFromDevice({
      name: current.currentDns,
      hostname,
    });
    if (
      target.inferredDnsSuffix &&
      currentDnsSuffix === target.inferredDnsSuffix
    ) {
      throw createHttpError(
        "This AlphaClaw host is already connected to that tailnet.",
        409,
      );
    }
    return {
      ok: true,
      currentDns: current.currentDns,
      currentSetupUrl: current.setupUrl,
      currentPublicBaseUrl: current.publicBaseUrl,
      policyChanged: target.policyChanged,
      httpsAlreadyEnabled: target.httpsEnabled,
      warnings: [
        "Webhook and OAuth callback URLs that use the current public address must be updated after the change.",
        "You will need to sign in to AlphaClaw again at the new address.",
      ],
    };
  };

  const updateOnboardingMarker = ({ setupUrl, publicBaseUrl, dnsName }) => {
    const markerPath = constants.kOnboardingMarkerPath;
    const current = readJsonFile(fs, markerPath);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const next = {
      ...current,
      onboarded: true,
      setupUrl,
      publicBaseUrl,
      tailscaleDns: dnsName,
      networkChangedAt: new Date().toISOString(),
    };
    const tempPath = `${markerPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tempPath, markerPath);
  };

  const finalizeSuccessfulChange = async ({ hostStatus, api = null }) => {
    const state = changeStore.read();
    const dnsName = normalizeDnsName(hostStatus?.dnsName);
    const normalizedDnsName = dnsName.toLowerCase();
    const previousDnsName = normalizeDnsName(state.currentDns).toLowerCase();
    const expectedDnsSuffix = normalizeDnsName(
      state.expectedDnsSuffix,
    ).toLowerCase();
    if (
      !normalizedDnsName.endsWith(".ts.net") ||
      normalizedDnsName === previousDnsName ||
      (expectedDnsSuffix &&
        !normalizedDnsName.endsWith(`.${expectedDnsSuffix}`))
    ) {
      throw new Error(
        "Tailnet manager completed without a valid new Tailscale DNS name",
      );
    }
    const setupUrl = `https://${dnsName}`;
    const publicBaseUrl = `https://${dnsName}:${funnelPort}`;
    const warnings = [...state.warnings];
    const envVars = typeof readEnvFile === "function" ? [...readEnvFile()] : [];

    if (api) {
      try {
        const status = await readTailscaleStatus({ shellCmd });
        const deviceId = await resolveDeviceId({
          status,
          api,
          tailnet,
          dnsName,
        });
        if (!deviceId) throw new Error("Could not resolve joined Tailscale device ID");
        await api.request(`/device/${encodeURIComponent(deviceId)}/device-invites`, {
          method: "POST",
          body: [{ email: kCloudOpsEmail, multiUse: false, allowExitNode: false }],
        });
      } catch (error) {
        warnings.push(
          `The host joined the new tailnet, but the support device invite could not be created: ${sanitizeError(error)}`,
        );
      }
    } else {
      warnings.push(
        `The host completed the switch after AlphaClaw restarted, so the support device invite was not created. Invite ${kCloudOpsEmail} from the Tailscale admin console if support access is required.`,
      );
    }

    upsertEnvVar(envVars, "ALPHACLAW_SETUP_URL", setupUrl);
    upsertEnvVar(envVars, "ALPHACLAW_PUBLIC_BASE_URL", publicBaseUrl);
    writeEnvFile(envVars);
    reloadEnv();
    updateOnboardingMarker({ setupUrl, publicBaseUrl, dnsName });
    syncBootstrapPromptFiles({
      fs,
      workspaceDir: constants.WORKSPACE_DIR,
      baseUrl: setupUrl,
    });
    try {
      const gatewayConfigChanged = ensureGatewayProxyConfig?.(setupUrl);
      if (gatewayConfigChanged && typeof restartGateway === "function") {
        await restartGateway();
      }
    } catch (error) {
      warnings.push(
        `The host joined the new tailnet, but the OpenClaw dashboard origin could not be refreshed: ${sanitizeError(error)}`,
      );
    }

    try {
      const writebackConfig = getTeamYouWritebackConfig({ envVars, env });
      await callTeamYouWriteback({
        fetchImpl,
        setupUrl,
        publicBaseUrl,
        dnsName,
        writebackConfig,
      });
    } catch (error) {
      warnings.push(
        `The host joined the new tailnet, but the instance URL update could not be reported: ${sanitizeError(error)}`,
      );
    }

    return changeStore.update({
      state: warnings.length > 0 ? "completed_with_warnings" : "completed",
      dnsName,
      setupUrl,
      publicBaseUrl,
      warnings,
      error: "",
      completedAt: new Date().toISOString(),
    });
  };

  const reconcileHostStatus = async ({ api = null } = {}) => {
    if (reconcilePromise) return reconcilePromise;
    reconcilePromise = (async () => {
      const local = changeStore.read();
      if (!changeStore.isActive()) return local;
      const hostStatus = await hostManager.getStatus();
      if (
        local.operationId &&
        hostStatus?.operationId &&
        local.operationId !== hostStatus.operationId
      ) {
        return local;
      }
      const hostState = String(hostStatus?.state || "").trim();
      if (kHostActiveStates.has(hostState)) {
        return changeStore.update({ state: hostState });
      }
      if (hostState === "completed") {
        return finalizeSuccessfulChange({ hostStatus, api });
      }
      if (kHostFailureStates.has(hostState)) {
        return changeStore.update({
          state: hostState,
          error: sanitizeError(hostStatus?.error || "Tailnet change failed"),
          completedAt: new Date().toISOString(),
        });
      }
      return local;
    })().finally(() => {
      reconcilePromise = null;
    });
    return reconcilePromise;
  };

  const monitorChange = async (api) => {
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      try {
        const state = await reconcileHostStatus({ api });
        if (!changeStore.isActive()) return state;
      } catch (error) {
        logger.error?.("[tailscale] Change status check failed:", sanitizeError(error));
      }
      await sleep(pollIntervalMs);
    }
    changeStore.update({
      state: "attention_required",
      error:
        "The host did not report a final tailnet-change result in time. Check the Tailscale Machines page or use clawctl to inspect the host.",
    });
    return changeStore.read();
  };

  const runStartChange = async ({
    tailscaleApiToken,
    expectedCurrentDns = "",
  }) => {
    if (changeStore.isActive()) {
      throw createHttpError("A tailnet change is already in progress", 409);
    }
    const capability = await hostManager.check({ required: false });
    if (!capability.ok) {
      throw createHttpError(
        capability.error ||
          "Change Tailnet requires a clawctl host upgrade before it can run.",
        503,
      );
    }
    const [target, current] = await Promise.all([
      prepareTarget({ tailscaleApiToken }),
      getCurrentNetwork(),
    ]);
    const submittedCurrentDns = normalizeDnsName(expectedCurrentDns);
    if (
      !submittedCurrentDns ||
      submittedCurrentDns.toLowerCase() !== current.currentDns.toLowerCase()
    ) {
      throw createHttpError(
        "The current tailnet changed after validation. Validate the new tailnet again before continuing.",
        409,
      );
    }
    const currentDnsSuffix = getDnsSuffixFromDevice({
      name: current.currentDns,
      hostname,
    });
    if (
      target.inferredDnsSuffix &&
      currentDnsSuffix === target.inferredDnsSuffix
    ) {
      throw createHttpError(
        "This AlphaClaw host is already connected to that tailnet.",
        409,
      );
    }

    await fetchAndApplyPolicy({ api: target.api, tailnet });
    await ensureTailnetHttpsEnabled({ api: target.api, tailnet });
    const authKey = await createAuthKey({ api: target.api, tailnet });

    if (target.inferredSetupUrl) {
      const gatewayConfigChanged = ensureGatewayProxyConfig?.(
        target.inferredSetupUrl,
      );
      if (gatewayConfigChanged && typeof restartGateway === "function") {
        await restartGateway();
      }
    }

    const operationId = crypto.randomUUID();
    changeStore.write({
      operationId,
      state: "queued",
      currentDns: current.currentDns,
      previousSetupUrl: current.setupUrl,
      previousPublicBaseUrl: current.publicBaseUrl,
      expectedDnsSuffix: target.inferredDnsSuffix,
      expectedSetupUrl: target.inferredSetupUrl,
      expectedPublicBaseUrl: target.inferredPublicBaseUrl,
      startedAt: new Date().toISOString(),
    });
    try {
      const request = {
        version: kTailnetManagerRequestVersion,
        operationId,
        authKey,
        hostname,
        previousDnsName: current.currentDns,
        ...(target.inferredDnsSuffix
          ? { expectedDnsSuffix: target.inferredDnsSuffix }
          : {}),
      };
      const scheduled = await hostManager.stageAndSchedule(request);
      if (scheduled?.ok !== true) {
        throw new Error(scheduled?.error || "Tailnet manager did not schedule the change");
      }
    } catch (error) {
      changeStore.update({
        state: "failed",
        error: sanitizeError(error),
        completedAt: new Date().toISOString(),
      });
      throw error;
    }

    defer(() => {
      monitorChange(target.api).catch((error) => {
        logger.error?.("[tailscale] Change monitor failed:", sanitizeError(error));
      });
    });
    return {
      ok: true,
      operationId,
      state: "queued",
      reconnectAfterMs: 5000,
    };
  };

  const startChange = async (input) => {
    if (startPromise || changeStore.isActive()) {
      throw createHttpError("A tailnet change is already in progress", 409);
    }
    const pending = runStartChange(input);
    startPromise = pending;
    try {
      return await pending;
    } finally {
      if (startPromise === pending) startPromise = null;
    }
  };

  const getStatus = async () => {
    const capability = await hostManager.check({ required: false });
    let current = await getCurrentNetwork();
    if (capability.ok && changeStore.isActive()) {
      try {
        await reconcileHostStatus();
        current = await getCurrentNetwork();
      } catch (error) {
        logger.error?.("[tailscale] Status reconciliation failed:", sanitizeError(error));
      }
    }
    return {
      ok: true,
      capability,
      current,
      change: changeStore.read(),
    };
  };

  return {
    getStatus,
    validateTarget,
    startChange,
    reconcileHostStatus,
  };
};

module.exports = {
  getDnsSuffixFromDevice,
  resolveTailnetDnsSuffix,
  hasHostnameCollision,
  createTailnetChangeService,
};
