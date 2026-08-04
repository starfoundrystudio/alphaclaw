const { createHash } = require("crypto");
const {
  buildTeamYouAgentVaultApprovalUrl,
  normalizeTeamYouAgentVaultEntryUrl,
} = require("../../agent-vault-links");
const {
  getAvailableCredentialKey,
  normalizeAgentVaultAccessRequest,
  planAgentVaultAccess,
  validateCredentialKey,
} = require("../../agent-vault-access");
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
  getAgentVaultRuntimeReplacement,
  isAgentVaultCredentialKey,
  isAgentVaultRuntimeReplacementKey,
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

const normalizeTimestamp = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
};

const normalizeCredentialDetail = (credential, vault) => ({
  key: getAvailableCredentialKey(credential),
  vault,
  status: "available",
  type:
    credential && typeof credential === "object"
      ? String(credential.type || "").trim()
      : "",
  createdAt:
    credential && typeof credential === "object"
      ? normalizeTimestamp(credential.created_at || credential.createdAt)
      : "",
  updatedAt:
    credential && typeof credential === "object"
      ? normalizeTimestamp(credential.updated_at || credential.updatedAt)
      : "",
});

const sanitizeProposal = (
  proposal,
  { operatorUrl, entryUrl, requestedAccess = null },
) => {
  const proposedCredentials = Array.isArray(proposal?.credentials)
    ? proposal.credentials.filter(
        (credential) =>
          credential &&
          typeof credential === "object" &&
          getAvailableCredentialKey(credential),
      )
    : [];
  const credentials = requestedAccess?.credentials || proposedCredentials;
  const service =
    requestedAccess?.service ||
    (Array.isArray(proposal?.services) ? proposal.services[0] : null) ||
    {};
  const rawApprovalUrl = proposal?.approval_url || proposal?.approvalUrl;
  const credentialDetails = credentials.map((credential) => ({
    key: getAvailableCredentialKey(credential),
    description: String(credential?.description || "").trim(),
  }));
  return {
    id: Number(proposal?.id),
    status: String(proposal?.status || ""),
    vault: String(proposal?.vault || ""),
    approvalUrl: rawApprovalUrl
      ? buildTeamYouAgentVaultApprovalUrl({
          approvalUrl: rawApprovalUrl,
          operatorUrl,
          entryUrl,
        })
      : "",
    message: String(proposal?.message || ""),
    service: {
      name: String(service?.name || "").trim(),
      host: String(service?.host || "").trim(),
      authType: String(service?.auth?.type || "").trim(),
      substitutions: Array.isArray(service?.substitutions)
        ? service.substitutions.map((substitution) => ({
            key: getAvailableCredentialKey(substitution),
            placeholder: String(substitution?.placeholder || "").trim(),
            in: Array.isArray(substitution?.in)
              ? substitution.in.map(String)
              : [],
          }))
        : [],
    },
    credentials: credentialDetails,
    credentialKeys: credentialDetails.map(({ key }) => key),
    requestInstructions: requestedAccess?.requestInstructions || [],
    key: credentialDetails[0]?.key || "",
    description: credentialDetails[0]?.description || "",
    reason: String(
      requestedAccess?.reason ||
        proposal?.user_message ||
        proposal?.message ||
        "",
    ).trim(),
    createdAt: normalizeTimestamp(proposal?.created_at || proposal?.createdAt),
    reviewedAt: normalizeTimestamp(
      proposal?.reviewed_at || proposal?.reviewedAt,
    ),
    reviewNote: String(proposal?.review_note || proposal?.reviewNote || "").trim(),
  };
};

const createAgentVaultService = ({
  env = process.env,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  authProfiles,
  openclawDir,
  fetchImpl = global.fetch,
  gatewayTailscaleClientFactory = createGatewayTailscaleClient,
  onRuntimeRestartRequired = null,
}) => {
  let runtimeClaimPromise = null;
  let runtimeRestartPending = false;
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
      runtimeClaimPromise = (async () => {
        const result = await performRuntimeTokenClaim();
        runtimeRestartPending =
          runtimeRestartPending || result.restartRequired === true;
        if (
          runtimeRestartPending &&
          typeof onRuntimeRestartRequired === "function"
        ) {
          await onRuntimeRestartRequired();
          runtimeRestartPending = false;
          return {
            ...result,
            restartRequired: false,
            restarted: true,
          };
        }
        return {
          ...result,
          restartRequired: runtimeRestartPending,
        };
      })().finally(() => {
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
        ? discovered.available_credentials.map((credential) =>
            getAvailableCredentialKey(credential).toUpperCase(),
          )
        : [],
    );
    const services = Array.isArray(discovered?.services)
      ? discovered.services
      : [];
    const current = readEnvFile();
    const removedKeys = current
      .filter(
        (entry) =>
          isAgentVaultCredentialKey(entry?.key) &&
          isAgentVaultRuntimeReplacementKey(entry?.key) &&
          available.has(String(entry?.key || "").trim().toUpperCase()) &&
          (() => {
            const replacement = getAgentVaultRuntimeReplacement(entry?.key);
            return services.some(
              (service) =>
                String(service?.name || "").trim().toLowerCase() ===
                  replacement?.serviceName &&
                String(service?.host || "").trim().toLowerCase() ===
                  replacement?.serviceHost,
            );
          })(),
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
    const vault = String(discovered?.vault || runtimeClient.runtime.vault);
    const credentialDetails = Array.isArray(discovered?.available_credentials)
      ? discovered.available_credentials
          .map((credential) => normalizeCredentialDetail(credential, vault))
          .filter((credential) => credential.key)
          .sort((left, right) => left.key.localeCompare(right.key))
      : [];
    return {
      vault,
      credentials: credentialDetails.map((credential) => credential.key),
      credentialDetails,
      services: Array.isArray(discovered?.services)
        ? discovered.services.map((service) => ({
            name: String(service?.name || ""),
            host: String(service?.host || ""),
          }))
        : [],
    };
  };

  const ensureServiceAccess = async (input) => {
    const access = normalizeAgentVaultAccessRequest(input);
    const runtimeClient = getRuntimeClient();
    if (!runtimeClient) {
      throw Object.assign(new Error("Agent Vault owner enrollment is not complete"), {
        status: 409,
      });
    }
    const discovered = await runtimeClient.client.discover();
    const plan = planAgentVaultAccess(access, discovered);
    const service = plan.matchedService || {
      name: access.service.name,
      host: access.service.host,
    };
    if (plan.status === "available") {
      return {
        status: "available",
        service,
        credentialKeys: access.referencedKeys,
        requestInstructions: access.requestInstructions,
      };
    }
    const entryUrl = getTeamYouEntryUrl();
    if (!entryUrl) {
      throw new Error("TeamYou Agent Vault entry URL is unavailable");
    }
    const proposal = await runtimeClient.client.createProposal(plan.proposal);
    return {
      status: "proposal_created",
      service,
      credentialKeys: access.referencedKeys,
      requestInstructions: access.requestInstructions,
      proposedChanges: {
        service: !plan.serviceAvailable,
        credentials: plan.missingCredentialKeys,
      },
      proposal: sanitizeProposal(proposal, {
        operatorUrl: runtimeClient.runtime.operatorUrl,
        entryUrl,
        requestedAccess: access,
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
        if (migration.restartRequired) {
          await onRestartRequired();
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
    ensureServiceAccess,
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
