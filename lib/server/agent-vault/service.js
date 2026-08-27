const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");
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
  buildModelProviderAccessRequests,
  buildPlaceholderForCredentialKey,
  getModelProviderVaultConfig,
  isVaultPlaceholderValue,
  listVaultBrokeredModelProviders,
} = require("./model-provider-services");
const {
  buildChannelProviderAccessRequests,
  getChannelVaultConfig,
  getDiscordManagedProxyConfigValue,
  listDeniedChannelPluginIds,
  listVaultBrokeredChannelProviders,
} = require("./channel-provider-services");
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

  // Model providers whose vault service(s) and credential slot are all
  // available: any raw on-box value (env or auth-store profile) is replaced
  // with the non-secret placeholder. Profiles are rewritten, never removed —
  // an unconfigured provider breaks model routing. Idempotent via
  // isVaultPlaceholderValue.
  const reconcileModelProviderPlaceholders = ({ available, serviceHosts }) => {
    const flippedKeys = [];
    let envChanged = false;
    const flippedCredentialKeys = new Set();
    for (const provider of listVaultBrokeredModelProviders()) {
      const config = getModelProviderVaultConfig(provider);
      if (flippedCredentialKeys.has(config.credentialKey)) continue;
      if (!available.has(config.credentialKey)) continue;
      if (
        !config.services.every((service) =>
          serviceHosts.has(service.host.toLowerCase()),
        )
      ) {
        continue;
      }
      let flipped = false;
      const current = readEnvFile();
      const envEntry = current.find(
        (entry) => String(entry?.key || "").trim() === config.credentialKey,
      );
      const envValue = String(envEntry?.value || "").trim();
      if (envValue && !isVaultPlaceholderValue(envValue)) {
        writeEnvFile(
          current.map((entry) =>
            String(entry?.key || "").trim() === config.credentialKey
              ? { ...entry, value: config.placeholder }
              : entry,
          ),
        );
        reloadEnv();
        envChanged = true;
        flipped = true;
      }
      for (const profile of authProfiles?.listProfilesByProvider?.(provider) ||
        []) {
        if (profile?.type !== "api_key") continue;
        const value = String(profile?.key || "").trim();
        if (!value || isVaultPlaceholderValue(value)) continue;
        const { id, ...credential } = profile;
        authProfiles.upsertProfile?.(
          id,
          { ...credential, key: config.placeholder },
        );
        flipped = true;
      }
      if (flipped) {
        flippedCredentialKeys.add(config.credentialKey);
        flippedKeys.push(config.credentialKey);
      }
    }
    return { flippedKeys, restartRequired: envChanged };
  };

  // Channel tokens (spec §4/§6): once the vault holds a provider's service
  // hosts and an account-scoped slot, the raw env value flips to the
  // placeholder — and the raw secret is swept out of openclaw.json (rewritten
  // to the `${ENV_KEY}` reference) and out of openclaw's rotated config
  // backups (`openclaw.json.bak*`), which retain scrubbed secrets otherwise
  // (verified live in Phase A).
  const reconcileChannelPlaceholders = ({ available, serviceHosts }) => {
    const flippedKeys = [];
    const flips = [];
    const current = readEnvFile();
    for (const provider of listVaultBrokeredChannelProviders()) {
      const config = getChannelVaultConfig(provider, "default");
      if (
        !config.services.every((service) =>
          serviceHosts.has(service.host.toLowerCase()),
        )
      ) {
        continue;
      }
      const baseKeys = config.slots.map((slot) => slot.envKey);
      for (const entry of current) {
        const key = String(entry?.key || "").trim();
        if (
          !baseKeys.some((base) => key === base || key.startsWith(`${base}_`))
        ) {
          continue;
        }
        const value = String(entry?.value || "").trim();
        if (!value || isVaultPlaceholderValue(value)) continue;
        if (!available.has(key)) continue;
        flips.push({
          key,
          rawValue: value,
          placeholder: buildPlaceholderForCredentialKey(key),
        });
      }
    }
    if (!flips.length) return { flippedKeys, restartRequired: false };
    const placeholderByKey = new Map(
      flips.map((flip) => [flip.key, flip.placeholder]),
    );
    writeEnvFile(
      current.map((entry) =>
        placeholderByKey.has(String(entry?.key || "").trim())
          ? { ...entry, value: placeholderByKey.get(String(entry.key).trim()) }
          : entry,
      ),
    );
    reloadEnv();
    const sweepConfig = hasManagedOpenclawConfig();
    const configPath = sweepConfig
      ? path.join(openclawDir, "openclaw.json")
      : "";
    for (const flip of flips) {
      flippedKeys.push(flip.key);
      if (!sweepConfig) continue;
      try {
        const rawConfig = fs.readFileSync(configPath, "utf8");
        if (rawConfig.includes(flip.rawValue)) {
          fs.writeFileSync(
            configPath,
            rawConfig.split(flip.rawValue).join(`\${${flip.key}}`),
          );
        }
      } catch {}
      try {
        for (const name of fs.readdirSync(openclawDir || "")) {
          if (!/^openclaw\.json\.bak/.test(name)) continue;
          const backupPath = path.join(openclawDir, name);
          try {
            if (fs.readFileSync(backupPath, "utf8").includes(flip.rawValue)) {
              fs.rmSync(backupPath, { force: true });
            }
          } catch {}
        }
      } catch {}
    }
    return { flippedKeys, restartRequired: true };
  };

  // D6 (default-closed): catalog channel plugins without a classification
  // entry are denied at the gateway, where enforcement beats entries.enabled
  // and the bundled-channel allowlist bypass — binding the Control UI, the
  // agent, and the CLI alike. Clawbridge is the single writer for
  // catalog-channel deny entries: it adds unclassified ids and removes ids
  // that have since been classified.
  const hasManagedOpenclawConfig = () => {
    try {
      return (
        !!openclawDir &&
        fs.existsSync(path.join(openclawDir, "openclaw.json"))
      );
    } catch {
      return false;
    }
  };

  const ensureChannelPluginDenyList = () => {
    if (!hasManagedOpenclawConfig()) return false;
    try {
      const config = readOpenclawConfig({ openclawDir, fallback: {} });
      assertOpenclawConfigSafeForMutation({
        config,
        openclawDir,
        operation: "Agent Vault channel policy enforcement",
      });
      if (!config.plugins || typeof config.plugins !== "object") {
        config.plugins = {};
      }
      const deniedIds = listDeniedChannelPluginIds();
      const deniedSet = new Set(deniedIds);
      const previous = Array.isArray(config.plugins.deny)
        ? config.plugins.deny.map((id) => String(id))
        : [];
      const managedCandidates = new Set([
        ...deniedIds,
        ...listVaultBrokeredChannelProviders(),
        "whatsapp",
      ]);
      const next = [
        ...previous.filter(
          (id) => !managedCandidates.has(id) || deniedSet.has(id),
        ),
        ...deniedIds.filter((id) => !previous.includes(id)),
      ];
      if (
        next.length === previous.length &&
        next.every((id, index) => id === previous[index])
      ) {
        return false;
      }
      config.plugins.deny = next;
      writeOpenclawConfig({ openclawDir, config, spacing: 2 });
      return true;
    } catch (error) {
      console.warn(
        `[alphaclaw] Channel deny-list reconcile failed: ${error?.message || error}`,
      );
      return false;
    }
  };

  // Phase A item 4: empty env expansion leaves the literal `${...}` string,
  // so the discord proxy key is only ever written while the vault runtime
  // exists (reconcile runs under that guard) and only onto an already
  // configured discord channel (writing channels.discord otherwise would
  // flip channel-presence detection).
  const ensureDiscordChannelProxyConfig = () => {
    if (!hasManagedOpenclawConfig()) return false;
    try {
      const config = readOpenclawConfig({ openclawDir, fallback: {} });
      const discord = config.channels?.discord;
      if (!discord || typeof discord !== "object") return false;
      const desired = getDiscordManagedProxyConfigValue();
      if (discord.proxy === desired) return false;
      assertOpenclawConfigSafeForMutation({
        config,
        openclawDir,
        operation: "Agent Vault discord proxy enablement",
      });
      discord.proxy = desired;
      writeOpenclawConfig({ openclawDir, config, spacing: 2 });
      return true;
    } catch (error) {
      console.warn(
        `[alphaclaw] Discord proxy reconcile failed: ${error?.message || error}`,
      );
      return false;
    }
  };

  const reconcileLegacyCredentials = async () => {
    if (
      typeof readEnvFile !== "function" ||
      typeof writeEnvFile !== "function" ||
      typeof reloadEnv !== "function"
    ) {
      return { removedKeys: [], flippedKeys: [], restartRequired: false };
    }
    const runtimeClient = getRuntimeClient();
    if (!runtimeClient) {
      return { removedKeys: [], flippedKeys: [], restartRequired: false };
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
    const serviceHosts = new Set(
      services.map((service) =>
        String(service?.host || "").trim().toLowerCase(),
      ),
    );
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
    if (removedKeys.length) {
      const removed = new Set(removedKeys);
      writeEnvFile(current.filter((entry) => !removed.has(String(entry?.key))));
      reloadEnv();
      for (const provider of authProfiles?.listApiKeyProviders?.() || []) {
        const envKey = authProfiles.getEnvVarForApiKeyProvider?.(provider);
        if (removed.has(String(envKey || ""))) {
          authProfiles.removeApiKeyProfileForEnvVar?.(provider);
        }
      }
    }
    const placeholderResult = reconcileModelProviderPlaceholders({
      available,
      serviceHosts,
    });
    const channelResult = reconcileChannelPlaceholders({
      available,
      serviceHosts,
    });
    const denyChanged = ensureChannelPluginDenyList();
    const discordProxyChanged = ensureDiscordChannelProxyConfig();
    return {
      removedKeys,
      flippedKeys: [
        ...placeholderResult.flippedKeys,
        ...channelResult.flippedKeys,
      ],
      restartRequired:
        removedKeys.length > 0 ||
        placeholderResult.restartRequired ||
        channelResult.restartRequired ||
        denyChanged ||
        discordProxyChanged,
    };
  };

  // Shared brokering core: plan every per-host request against /discover;
  // when anything is missing, file ONE merged proposal so the owner
  // approves a provider exactly once.
  const ensureBrokeredAccess = async (requests) => {
    const runtimeClient = getRuntimeClient();
    if (!runtimeClient) {
      throw Object.assign(
        new Error("Agent Vault owner enrollment is not complete"),
        { status: 409 },
      );
    }
    const discovered = await runtimeClient.client.discover();
    const accesses = requests.map((request) =>
      normalizeAgentVaultAccessRequest(request),
    );
    const plans = accesses.map((access) =>
      planAgentVaultAccess(access, discovered),
    );
    const services = accesses.map((access) => ({
      name: access.service.name,
      host: access.service.host,
    }));
    if (plans.every((plan) => plan.status === "available")) {
      return { status: "available", services };
    }
    const entryUrl = getTeamYouEntryUrl();
    if (!entryUrl) {
      throw new Error("TeamYou Agent Vault entry URL is unavailable");
    }
    const mergedServices = [];
    const mergedCredentials = [];
    const seenCredentialKeys = new Set();
    for (const plan of plans) {
      mergedServices.push(...plan.proposal.services);
      for (const credential of plan.proposal.credentials) {
        if (seenCredentialKeys.has(credential.key)) continue;
        seenCredentialKeys.add(credential.key);
        mergedCredentials.push(credential);
      }
    }
    const proposal = await runtimeClient.client.createProposal({
      services: mergedServices,
      credentials: mergedCredentials,
      message: accesses[0].reason,
      user_message: accesses[0].userMessage,
    });
    return {
      status: "proposal_created",
      services,
      proposal: sanitizeProposal(proposal, {
        operatorUrl: runtimeClient.runtime.operatorUrl,
        entryUrl,
        requestedAccess: accesses[0],
      }),
    };
  };

  const ensureModelProviderAccess = async (provider) => {
    const requests = buildModelProviderAccessRequests(provider);
    if (!requests) {
      throw Object.assign(
        new Error(
          `Model provider ${provider} does not support Agent Vault brokering`,
        ),
        { status: 400 },
      );
    }
    const config = getModelProviderVaultConfig(provider);
    const result = await ensureBrokeredAccess(requests);
    return {
      ...result,
      provider: config.provider,
      credentialKey: config.credentialKey,
      placeholder: config.placeholder,
    };
  };

  const ensureChannelProviderAccess = async (provider, accountId = "default") => {
    const requests = buildChannelProviderAccessRequests(provider, accountId);
    if (!requests) {
      throw Object.assign(
        new Error(
          `Channel provider ${provider} does not support Agent Vault brokering`,
        ),
        { status: 400 },
      );
    }
    const config = getChannelVaultConfig(provider, accountId);
    const result = await ensureBrokeredAccess(requests);
    return {
      ...result,
      provider: config.provider,
      accountId: config.accountId,
      slots: config.slots.map(({ envKey, placeholder }) => ({
        envKey,
        placeholder,
      })),
    };
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
      migratedCredentialKeys: [
        ...(migration?.removedKeys || []),
        ...(migration?.flippedKeys || []),
      ],
      ...(claimError ? { warning: claimError } : {}),
    };
  };

  // Entry-hop wrapped deep link to the vault console's credentials page (the
  // only link shape that works for owners on managed instances — raw operator
  // URLs dead-end at a login form). Empty when the entry URL is unset.
  const buildVaultConsoleUrl = () => {
    const entryUrl = getTeamYouEntryUrl();
    if (!entryUrl) return "";
    const url = new URL(entryUrl);
    url.searchParams.set("return_to", "/vaults/default/credentials");
    return url.toString();
  };

  // Joins a vault credential key against the channel/model registries and the
  // instance's own placeholder references so the UI can answer "what is this
  // credential for, and is anything actually using it?" — a stale credential
  // (deleted app, removed channel) shows up as unused instead of surfacing
  // later as an auth failure.
  const describeCredentialUsage = ({ key, serviceNames }) => {
    const usage = [];
    const envEntries = getEnvVars();
    const envHoldsPlaceholder = (credentialKey) =>
      envEntries.some(
        (entry) =>
          String(entry?.key || "").trim() === credentialKey &&
          isVaultPlaceholderValue(String(entry?.value || "").trim()),
      );
    for (const provider of listVaultBrokeredChannelProviders()) {
      const config = getChannelVaultConfig(provider, "default");
      if (!config) continue;
      const slot = config.slots.find(
        (candidate) =>
          key === candidate.envKey || key.startsWith(`${candidate.envKey}_`),
      );
      if (!slot) continue;
      const accountSuffix =
        key === slot.envKey
          ? ""
          : key.slice(slot.envKey.length + 1).toLowerCase().replace(/_/g, "-");
      const providerLabel =
        provider.charAt(0).toUpperCase() + provider.slice(1);
      usage.push({
        kind: "channel",
        label: `${providerLabel} channel${accountSuffix ? ` (${accountSuffix})` : ""}`,
        host: config.services[0]?.host || "",
        configured: envHoldsPlaceholder(key),
        wired: config.services.some((service) =>
          serviceNames.has(service.name),
        ),
      });
    }
    const seenModelLabels = new Set();
    for (const provider of listVaultBrokeredModelProviders()) {
      const config = getModelProviderVaultConfig(provider);
      if (!config || config.credentialKey !== key) continue;
      const label = `${provider} (models)`;
      if (seenModelLabels.has(label)) continue;
      seenModelLabels.add(label);
      const profileConfigured = (
        authProfiles?.listProfilesByProvider?.(provider) || []
      ).some(
        (profile) =>
          profile?.type === "api_key" &&
          isVaultPlaceholderValue(String(profile?.key || "").trim()),
      );
      usage.push({
        kind: "model",
        label,
        host: config.services[0]?.host || "",
        configured: profileConfigured || envHoldsPlaceholder(key),
        wired: config.services.some((service) =>
          serviceNames.has(service.name),
        ),
      });
    }
    if (key === "TEAMYOU_API_KEY") {
      usage.push({
        kind: "system",
        label: "TeamYou integration",
        host: "www.teamyou.com",
        configured: true,
        wired: serviceNames.has("teamyou-external-api"),
      });
    }
    return usage;
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
    const services = Array.isArray(discovered?.services)
      ? discovered.services.map((service) => ({
          name: String(service?.name || ""),
          host: String(service?.host || ""),
        }))
      : [];
    const serviceNames = new Set(services.map((service) => service.name));
    const credentialDetails = Array.isArray(discovered?.available_credentials)
      ? discovered.available_credentials
          .map((credential) => normalizeCredentialDetail(credential, vault))
          .filter((credential) => credential.key)
          .sort((left, right) => left.key.localeCompare(right.key))
          .map((credential) => {
            const usedBy = describeCredentialUsage({
              key: credential.key,
              serviceNames,
            });
            return {
              ...credential,
              usedBy,
              inUse: usedBy.some((usage) => usage.configured),
            };
          })
      : [];
    return {
      vault,
      credentials: credentialDetails.map((credential) => credential.key),
      credentialDetails,
      services,
      consoleUrl: buildVaultConsoleUrl(),
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
    ensureChannelProviderAccess,
    ensureModelProviderAccess,
    ensureServiceAccess,
    getProposal,
    getStatus,
    getVaultConsoleUrl: buildVaultConsoleUrl,
    listCredentials,
    reconcileLegacyCredentials,
    startRuntimeClaimPolling,
  };
};

module.exports = {
  createAgentVaultService,
  validateCredentialKey,
};
