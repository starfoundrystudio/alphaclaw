const { createHash } = require("crypto");
const {
  buildTeamYouAgentVaultApprovalUrl,
  normalizeTeamYouAgentVaultEntryUrl,
} = require("../../agent-vault-links");
const {
  assertOpenclawConfigSafeForMutation,
  readOpenclawConfig,
  writeOpenclawConfig,
} = require("../openclaw-config");
const {
  createGatewayTailscaleClient,
} = require("../onboarding/gateway-tailscale-client");
const { getEnvValue } = require("../onboarding/tailscale-env");
const {
  isAgentVaultCredentialKey,
} = require("./env-classification");
const {
  createAgentVaultClient,
  fetchAgentVaultCa,
} = require("./client");
const {
  kAgentVaultApiAddress,
  markAgentVaultHandoffComplete,
  markAgentVaultTokenAcknowledged,
  readAgentVaultRuntime,
  writeAgentVaultCa,
  writeAgentVaultRuntime,
} = require("./runtime-store");

const kCredentialKeyPattern = /^[A-Z][A-Z0-9_]{1,127}$/;
const kDescriptionMaxLength = 500;
const kReasonMaxLength = 1000;

const normalizeText = (value, maxLength, label) => {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength || /[\0]/.test(normalized)) {
    throw new Error(`${label} is missing or invalid`);
  }
  return normalized;
};

const validateCredentialKey = (value) => {
  const key = String(value || "").trim().toUpperCase();
  if (!kCredentialKeyPattern.test(key)) {
    throw new Error(
      "Credential key must use uppercase letters, numbers, and underscores",
    );
  }
  return key;
};

const sanitizeProposal = (proposal, { operatorUrl, entryUrl }) => ({
  id: Number(proposal?.id),
  status: String(proposal?.status || ""),
  vault: String(proposal?.vault || ""),
  approvalUrl: buildTeamYouAgentVaultApprovalUrl({
    approvalUrl: proposal?.approval_url || proposal?.approvalUrl,
    operatorUrl,
    entryUrl,
  }),
  message: String(proposal?.message || ""),
});

const createAgentVaultService = ({
  env = process.env,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  authProfiles,
  openclawDir,
  fetchImpl = global.fetch,
  gatewayTailscaleClientFactory = createGatewayTailscaleClient,
}) => {
  let runtimeClaimPromise = null;
  const getEnvVars = () =>
    typeof readEnvFile === "function" ? readEnvFile() : [];
  const getOperatorUrl = () => {
    const value = getEnvValue(env, getEnvVars(), [
      "AGENT_VAULT_OPERATOR_URL",
    ]);
    if (!value) return "";
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol !== "https:" ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash ||
        !parsed.hostname.endsWith(".ts.net")
      ) {
        return "";
      }
      return parsed.origin;
    } catch {
      return "";
    }
  };
  const getConnectivityMode = () =>
    getEnvValue(env, getEnvVars(), ["ALPHACLAW_CONNECTIVITY_MODE"]) || "local";
  const getTeamYouEntryUrl = () =>
    normalizeTeamYouAgentVaultEntryUrl(
      getEnvValue(env, getEnvVars(), ["TEAMYOU_AGENT_VAULT_ENTRY_URL"]),
    );
  const createGatewayClient = () => {
    const envVars = getEnvVars();
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

  const enableOpenclawProxy = () => {
    const config = readOpenclawConfig({ openclawDir, fallback: {} });
    assertOpenclawConfigSafeForMutation({
      config,
      openclawDir,
      operation: "Agent Vault proxy enablement",
    });
    if (!config.proxy || typeof config.proxy !== "object") config.proxy = {};
    if (config.proxy.enabled === true) return false;
    config.proxy.enabled = true;
    writeOpenclawConfig({ openclawDir, config, spacing: 2 });
    return true;
  };

  const finishGatewayTokenHandoff = async ({ client, token }) => {
    const runtime = readAgentVaultRuntime();
    if (!runtime?.tokenAcknowledged) {
      const tokenSha256 = createHash("sha256").update(token).digest("hex");
      await client.acknowledgeAgentVaultRuntimeToken({ tokenSha256 });
      markAgentVaultTokenAcknowledged(runtime);
    }
    client.cleanupIdentity();
    markAgentVaultHandoffComplete();
  };

  const performRuntimeTokenClaim = async () => {
    const existing = readAgentVaultRuntime();
    if (existing) {
      const restartRequired = enableOpenclawProxy();
      if (!existing.handoffComplete) {
        await finishGatewayTokenHandoff({
          client: createGatewayClient(),
          token: existing.token,
        });
      }
      return { ready: true, claimed: false, restartRequired };
    }
    if (getConnectivityMode() !== "security_gateway") {
      return { ready: false, claimed: false, reason: "not_managed" };
    }
    const operatorUrl = getOperatorUrl();
    if (!operatorUrl) {
      return { ready: false, claimed: false, reason: "network_pending" };
    }
    const caPem = await fetchAgentVaultCa({
      address: kAgentVaultApiAddress,
      fetchImpl,
    });
    const gatewayClient = createGatewayClient();
    const claim = await gatewayClient.claimAgentVaultRuntimeToken();
    if (!claim.ready) {
      return { ready: false, claimed: false, reason: "owner_pending" };
    }
    writeAgentVaultCa(caPem);
    writeAgentVaultRuntime({
      token: claim.token,
      vault: "default",
      mode: "brokered",
      operatorUrl,
    });
    const restartRequired = enableOpenclawProxy();
    await finishGatewayTokenHandoff({
      client: gatewayClient,
      token: claim.token,
    });
    return { ready: true, claimed: true, restartRequired };
  };
  const claimRuntimeToken = () => {
    if (!runtimeClaimPromise) {
      runtimeClaimPromise = performRuntimeTokenClaim().finally(() => {
        runtimeClaimPromise = null;
      });
    }
    return runtimeClaimPromise;
  };

  const getRuntimeClient = () => {
    const runtime = readAgentVaultRuntime();
    if (!runtime) return null;
    return {
      runtime,
      client: createAgentVaultClient({
        address: kAgentVaultApiAddress,
        token: runtime.token,
        vault: runtime.vault,
        fetchImpl,
      }),
    };
  };

  const reconcileLegacyCredentials = async () => {
    if (
      typeof readEnvFile !== "function" ||
      typeof writeEnvFile !== "function" ||
      typeof reloadEnv !== "function"
    ) {
      return { removedKeys: [], restartRequired: false };
    }
    const runtimeClient = getRuntimeClient();
    if (!runtimeClient) {
      return { removedKeys: [], restartRequired: false };
    }
    const discovered = await runtimeClient.client.discover();
    const available = new Set(
      Array.isArray(discovered?.available_credentials)
        ? discovered.available_credentials.map((key) =>
            String(key || "").trim().toUpperCase(),
          )
        : [],
    );
    const current = readEnvFile();
    const removedKeys = current
      .filter(
        (entry) =>
          isAgentVaultCredentialKey(entry?.key) &&
          available.has(String(entry?.key || "").trim().toUpperCase()),
      )
      .map((entry) => String(entry.key));
    if (!removedKeys.length) {
      return { removedKeys: [], restartRequired: false };
    }
    const removed = new Set(removedKeys);
    writeEnvFile(current.filter((entry) => !removed.has(String(entry?.key))));
    reloadEnv();
    for (const provider of authProfiles?.listApiKeyProviders?.() || []) {
      const envKey = authProfiles.getEnvVarForApiKeyProvider?.(provider);
      if (removed.has(String(envKey || ""))) {
        authProfiles.removeApiKeyProfileForEnvVar?.(provider);
      }
    }
    return { removedKeys, restartRequired: true };
  };

  const getStatus = async ({ attemptClaim = true } = {}) => {
    let claim = null;
    let migration = null;
    let claimError = "";
    if (attemptClaim) {
      try {
        claim = await claimRuntimeToken();
      } catch (error) {
        claimError = String(error?.message || "Agent Vault is unavailable");
      }
    }
    const runtime = readAgentVaultRuntime();
    const operatorUrl = runtime?.operatorUrl || getOperatorUrl();
    let connected = false;
    if (runtime) {
      try {
        migration = await reconcileLegacyCredentials();
        await getRuntimeClient().client.discover();
        connected = true;
      } catch {}
    }
    return {
      managed: getConnectivityMode() === "security_gateway",
      mode: runtime?.mode || (operatorUrl ? "available" : "disabled"),
      initialized: !!runtime,
      connected,
      operatorUrl: operatorUrl || "",
      entryUrl: getTeamYouEntryUrl(),
      ownerEnrollmentPending: !!operatorUrl && !runtime,
      restartRequired:
        claim?.restartRequired === true ||
        migration?.restartRequired === true,
      migratedCredentialKeys: migration?.removedKeys || [],
      ...(claimError ? { warning: claimError } : {}),
    };
  };

  const listCredentials = async () => {
    const runtimeClient = getRuntimeClient();
    if (!runtimeClient) {
      throw Object.assign(new Error("Agent Vault owner enrollment is not complete"), {
        status: 409,
      });
    }
    const discovered = await runtimeClient.client.discover();
    return {
      vault: String(discovered?.vault || runtimeClient.runtime.vault),
      credentials: Array.isArray(discovered?.available_credentials)
        ? discovered.available_credentials
            .map((key) => String(key || "").trim())
            .filter(Boolean)
            .sort()
        : [],
      services: Array.isArray(discovered?.services)
        ? discovered.services.map((service) => ({
            name: String(service?.name || ""),
            host: String(service?.host || ""),
          }))
        : [],
    };
  };

  const ensureCredential = async ({ key, description, reason }) => {
    const normalizedKey = validateCredentialKey(key);
    const normalizedDescription = normalizeText(
      description,
      kDescriptionMaxLength,
      "Credential description",
    );
    const normalizedReason = normalizeText(
      reason,
      kReasonMaxLength,
      "Credential reason",
    );
    const runtimeClient = getRuntimeClient();
    if (!runtimeClient) {
      throw Object.assign(new Error("Agent Vault owner enrollment is not complete"), {
        status: 409,
      });
    }
    const discovered = await runtimeClient.client.discover();
    if (
      Array.isArray(discovered?.available_credentials) &&
      discovered.available_credentials.includes(normalizedKey)
    ) {
      return { status: "available", key: normalizedKey };
    }
    const entryUrl = getTeamYouEntryUrl();
    if (!entryUrl) {
      throw new Error("TeamYou Agent Vault entry URL is unavailable");
    }
    const proposal = await runtimeClient.client.createProposal({
      key: normalizedKey,
      description: normalizedDescription,
      reason: normalizedReason,
    });
    return {
      status: "proposal_created",
      key: normalizedKey,
      proposal: sanitizeProposal(proposal, {
        operatorUrl: runtimeClient.runtime.operatorUrl,
        entryUrl,
      }),
    };
  };

  const getProposal = async (id) => {
    const proposalId = Number.parseInt(String(id || ""), 10);
    if (!Number.isInteger(proposalId) || proposalId < 1) {
      throw new Error("Proposal ID is invalid");
    }
    const runtimeClient = getRuntimeClient();
    if (!runtimeClient) {
      throw Object.assign(new Error("Agent Vault owner enrollment is not complete"), {
        status: 409,
      });
    }
    return sanitizeProposal(await runtimeClient.client.getProposal(proposalId), {
      operatorUrl: runtimeClient.runtime.operatorUrl,
      entryUrl: getTeamYouEntryUrl(),
    });
  };

  const startRuntimeClaimPolling = ({
    onRestartRequired = () => {},
    intervalMs = 15000,
  } = {}) => {
    if (getConnectivityMode() !== "security_gateway") {
      return () => {};
    }
    let stopped = false;
    let running = false;
    let timer = null;
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(tick, intervalMs);
      timer.unref?.();
    };
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try {
        const result = await claimRuntimeToken();
        const migration = result.ready
          ? await reconcileLegacyCredentials()
          : { restartRequired: false };
        if (result.restartRequired || migration.restartRequired) {
          onRestartRequired();
        }
      } catch (error) {
        const message = String(error?.message || "");
        if (!message.includes("unavailable") && !message.includes("missing")) {
          console.warn(
            `[alphaclaw] Agent Vault runtime enrollment is pending: ${message}`,
          );
        }
      } finally {
        running = false;
      }
      schedule();
    };
    timer = setTimeout(tick, 5000);
    timer.unref?.();
    return stop;
  };

  return {
    claimRuntimeToken,
    ensureCredential,
    getProposal,
    getStatus,
    listCredentials,
    reconcileLegacyCredentials,
    startRuntimeClaimPolling,
  };
};

module.exports = {
  createAgentVaultService,
  validateCredentialKey,
};
