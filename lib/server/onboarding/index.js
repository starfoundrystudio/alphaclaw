const crypto = require("crypto");
const path = require("path");
const { validateOnboardingInput } = require("./validation");
const {
  buildOnboardArgs,
  writeSanitizedOpenclawConfig,
} = require("./openclaw");
const {
  ensureOpenclawRuntimeArtifacts,
  syncBootstrapPromptFiles,
} = require("./workspace");
const { migrateManagedInternalFiles } = require("../internal-files-migration");
const { installGogCliSkill } = require("../gog-skill");
const { installComposioSkill } = require("../composio-skill");
const { ensureManagedExecDefaults } = require("../exec-defaults-config");
const {
  getTailscaleApiTokenValidation,
} = require("./tailscale-finalizer");
const { parseJsonObjectFromNoisyOutput } = require("../utils/json");
const { isCloudflareTunnelMode } = require("../../ingress-mode");

const kPlaceholderEnvValue = "placeholder";
const kTransientOnboardingVarKeys = new Set([
  "TAILSCALE_API_TOKEN",
  "TAILSCALE_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_WORKSPACE_REPO",
]);
const kHostFinalizeSetupWrapper = "/usr/local/sbin/alphaclaw-host-finalize-setup";

const getHostFinalizeSetupError = (operation, error) => {
  const raw = [error?.stderr, error?.stdout, error?.message]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
  const lower = raw.toLowerCase();
  if (
    lower.includes("no such file") ||
    lower.includes("not found") ||
    lower.includes("permission denied") ||
    lower.includes("a password is required") ||
    lower.includes("sudo")
  ) {
    return `Host finalization ${operation} failed. This host was likely provisioned with an older clawctl; reprovision or upgrade the host bootstrap so ${kHostFinalizeSetupWrapper} is installed and sudo NOPASSWD is configured.`;
  }
  return `Host finalization ${operation} failed: ${error?.message || String(error)}`;
};

const runHostFinalizeSetup = async (shellCmd, operation) => {
  if (typeof shellCmd !== "function") {
    throw new Error("Host finalization cannot run because shell execution is unavailable.");
  }
  try {
    await shellCmd(`sudo -n ${kHostFinalizeSetupWrapper} ${operation}`, {
      timeout: 30000,
    });
  } catch (error) {
    throw new Error(getHostFinalizeSetupError(operation, error));
  }
};

const clearHostFinalizationScheduledFlag = ({ fs, markerPath, logger }) => {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (!marker || typeof marker !== "object") return;
    fs.writeFileSync(
      markerPath,
      JSON.stringify(
        { ...marker, hostFinalizationScheduled: false },
        null,
        2,
      ),
    );
  } catch (error) {
    logger.error?.(
      "[onboard] Could not clear hostFinalizationScheduled flag:",
      error.message,
    );
  }
};

const createHostFinalizeSetupCompleteTask = ({
  shellCmd,
  fs,
  markerPath,
  logger = console,
}) =>
  () => {
    runHostFinalizeSetup(shellCmd, "complete")
      .then(() => {
        logger.log?.("[onboard] Host finalization complete");
      })
      .catch((error) => {
        logger.error?.("[onboard] Host finalization complete error:", error.message);
        // No restart is coming; un-defer the bootstrap kickoff so the
        // greeting still fires in this process.
        if (fs && markerPath) {
          clearHostFinalizationScheduledFlag({ fs, markerPath, logger });
        }
      });
  };

const getHostnameFromUrl = (url) => {
  try {
    return new URL(String(url || "")).hostname;
  } catch {
    return "";
  }
};

const upsertEnvVar = (items, key, value) => {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return items;
  const normalizedValue = String(value || "");
  const existing = items.find((entry) => entry.key === normalizedKey);
  if (existing) {
    existing.value = normalizedValue;
    return items;
  }
  items.push({ key: normalizedKey, value: normalizedValue });
  return items;
};

const removeEnvVar = (items, key) => {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return items;
  const idx = items.findIndex((entry) => entry.key === normalizedKey);
  if (idx !== -1) items.splice(idx, 1);
  return items;
};

const ensureCodexPluginInstalled = async ({
  shellCmd,
  gatewayEnv,
  gatewayMaintenanceEnv = gatewayEnv,
}) => {
  const rawInventory = await shellCmd("openclaw plugins list --json", {
    env: gatewayEnv(),
    timeout: 30000,
  });
  const inventory = parseJsonObjectFromNoisyOutput(rawInventory);
  const installed = Array.isArray(inventory?.plugins)
    ? inventory.plugins.some((plugin) => plugin?.id === "codex")
    : false;
  if (installed) return;
  await shellCmd("openclaw plugins install codex --accept-capabilities", {
    env: gatewayMaintenanceEnv(),
    timeout: 120000,
  });
};

const applySubmittedEnvVars = (items, vars = []) => {
  for (const entry of vars || []) {
    const key = String(entry?.key || "").trim();
    if (
      !key || kTransientOnboardingVarKeys.has(key)
    ) {
      continue;
    }
    const value = String(entry?.value || "");
    if (value) {
      upsertEnvVar(items, key, value);
    } else {
      removeEnvVar(items, key);
    }
  }
  return items;
};

// OpenClaw 2026.9 onboarding is told the Gateway token by reference
// (`--gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN`) and refuses to run when
// that variable is missing or empty. 2026.7.1 generated a literal token
// itself when none was passed, so a fresh managed host never had one in
// its env file until now (G3, 2026-09-21: every fresh 2026.9.5 provision
// failed at "Environment variable OPENCLAW_GATEWAY_TOKEN is missing").
// Mint it here, ahead of the env write, so the same value reaches the
// onboard child and every later Gateway launch through the env file.
const ensureGatewayTokenEnvVar = (items, { processEnv = process.env } = {}) => {
  const key = "OPENCLAW_GATEWAY_TOKEN";
  const existing = items.find((item) => item?.key === key);
  if (existing && String(existing.value || "").trim()) {
    return { generated: false, value: String(existing.value).trim() };
  }
  const fromProcess = String(processEnv?.[key] || "").trim();
  const value = fromProcess || crypto.randomBytes(32).toString("hex");
  if (existing) existing.value = value;
  else items.push({ key, value });
  return { generated: !fromProcess, value };
};

const pruneConflictingProviderAuthVars = (items, { selectedProvider, varMap }) => {
  if (selectedProvider !== "anthropic") return items;
  const hasAnthropicToken = !!String(varMap.ANTHROPIC_TOKEN || "").trim();
  const hasAnthropicApiKey = !!String(varMap.ANTHROPIC_API_KEY || "").trim();
  if (hasAnthropicToken && !hasAnthropicApiKey) {
    removeEnvVar(items, "ANTHROPIC_API_KEY");
  } else if (hasAnthropicApiKey && !hasAnthropicToken) {
    removeEnvVar(items, "ANTHROPIC_TOKEN");
  }
  return items;
};

const syncApiKeyAuthProfilesFromEnvVars = (authProfiles, envVars = []) => {
  if (!authProfiles?.getEnvVarForApiKeyProvider) return;
  const providers = [
    "anthropic",
    "openai",
    "google",
    "opencode",
    "openrouter",
    "zai",
    "vercel-ai-gateway",
    "kilocode",
    "xai",
    "mistral",
    "cerebras",
    "moonshot",
    "kimi-coding",
    "volcengine",
    "byteplus",
    "synthetic",
    "minimax",
    "voyage",
    "groq",
    "deepgram",
    "vllm",
  ];
  const envMap = new Map(
    (envVars || []).map((entry) => [
      String(entry?.key || "").trim(),
      String(entry?.value || ""),
    ]),
  );
  for (const provider of providers) {
    const envKey = authProfiles.getEnvVarForApiKeyProvider(provider);
    if (!envKey) continue;
    const value = String(envMap.get(envKey) || "").trim();
    if (!value || value === kPlaceholderEnvValue) continue;
    authProfiles.upsertApiKeyProfileForEnvVar?.(provider, value);
  }
};

const createOnboardingService = ({
  fs,
  constants,
  shellCmd,
  gatewayEnv,
  gatewayMaintenanceEnv = gatewayEnv,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  resolveModelProvider,
  hasCodexOauthProfile,
  hasClaudeCliProfile = () => false,
  authProfiles,
  ensureGatewayProxyConfig,
  getBaseUrl,
  reconcileOpenclawPlugins,
  tailscaleFinalizer,
  tunnelFinalizer,
  prepareAgentVaultRuntime,
  runOnboardedBootSequence,
  env = process.env,
}) => {
  const { OPENCLAW_DIR, WORKSPACE_DIR, kOnboardingMarkerPath } = constants;
  const readEnvVars = () =>
    typeof readEnvFile === "function" ? readEnvFile() : [];

  // Synchronous request validation: everything that can be rejected without
  // touching the host. The POST handler answers these with 400 before any
  // background work starts.
  const validateOnboardingRequest = ({
    vars,
    modelKey,
    agentRuntimeId,
    tailscaleApiToken,
  }) => {
    const validation = validateOnboardingInput({
      vars,
      modelKey,
      agentRuntimeId,
      resolveModelProvider,
      hasCodexOauthProfile,
      hasClaudeCliProfile,
    });
    if (!validation.ok) {
      return { ok: false, status: validation.status, error: validation.error };
    }
    if (isCloudflareTunnelMode({ env, envVars: readEnvVars() })) {
      // Tunnel ingress has no owner network step: a Tailscale token is
      // neither required nor accepted.
      if (String(tailscaleApiToken || "").trim()) {
        return {
          ok: false,
          status: 400,
          error: "This instance does not use Tailscale; remove the Tailscale token",
        };
      }
      try {
        tunnelFinalizer.readTunnelSetup();
      } catch (error) {
        return { ok: false, status: 500, error: error.message };
      }
      return { ok: true, prepared: { vars, validation, tunnel: true } };
    }
    const tailscaleValidation = getTailscaleApiTokenValidation(tailscaleApiToken);
    if (!tailscaleValidation.ok) {
      return { ok: false, status: 400, error: tailscaleValidation.error };
    }
    return {
      ok: true,
      prepared: {
        vars,
        validation,
        tailscaleApiToken: tailscaleValidation.token,
      },
    };
  };

  const requireAgentVaultRuntime = async ({ reportProgress }) => {
    if (typeof prepareAgentVaultRuntime !== "function") {
      throw new Error(
        "Automatic Agent Vault initialization is unavailable",
      );
    }
    reportProgress("vault", "Preparing Agent Vault");
    const agentVaultRuntime = await prepareAgentVaultRuntime();
    if (agentVaultRuntime?.ready !== true) {
      throw new Error(
        "Automatic Agent Vault initialization did not complete",
      );
    }
  };

  // Tailscale ingress: join or confirm the tailnet (the finalizer also
  // writes back to TeamYou), then claim the Agent Vault runtime.
  const finalizeTailscaleNetwork = async ({ prepared, reportProgress }) => {
    reportProgress("network", "Setting up private access");
    const tailscaleResult = await tailscaleFinalizer.finalizeTailscaleOnboarding({
      tailscaleApiToken: prepared.tailscaleApiToken,
    });
    const setupUrl = String(tailscaleResult?.setupUrl || "").trim();
    if (!setupUrl) {
      throw new Error(
        "Tailscale finalization completed without a final setup URL",
      );
    }
    const publicBaseUrl = String(tailscaleResult?.publicBaseUrl || "").trim();
    const tailscaleDns = String(
      tailscaleResult?.dnsName || getHostnameFromUrl(setupUrl),
    ).trim();
    const handoffViaBootstrapOrigin =
      tailscaleResult?.handoffViaBootstrapOrigin === true;
    if (tailscaleResult?.agentVaultOperatorUrl) {
      await requireAgentVaultRuntime({ reportProgress });
    }
    return {
      setupUrl,
      publicBaseUrl,
      resultFields: {
        tailscaleDns,
        ...(handoffViaBootstrapOrigin
          ? { handoffViaBootstrapOrigin: true }
          : {}),
      },
      bodyFields: {},
    };
  };

  // Cloudflare Tunnel ingress: the URLs are fixed and the gateway is sealed
  // at install, so claim the Agent Vault runtime and report the final facts
  // to TeamYou. No Tailscale finalizer, no gateway configure/seal.
  const finalizeTunnelNetwork = async ({ reportProgress }) => {
    tunnelFinalizer.readTunnelSetup();
    await requireAgentVaultRuntime({ reportProgress });
    reportProgress("network", "Connecting to TeamYou");
    const result = await tunnelFinalizer.reportNetworkFinalized();
    return {
      setupUrl: result.setupUrl,
      publicBaseUrl: result.publicBaseUrl,
      resultFields: {},
      bodyFields: { ingressMode: result.ingressMode },
    };
  };

  // The setup work itself. Runs in the background after the POST returns;
  // onProgress reports coarse steps at the natural boundaries.
  const runOnboarding = async ({ req, prepared, onProgress = () => {} }) => {
    const { vars, validation } = prepared;
    const reportProgress = (phase, label) => {
      try {
        onProgress({ phase, label });
      } catch {}
    };
    reportProgress("validating", "Checking this server");
    await runHostFinalizeSetup(shellCmd, "check");

    reportProgress("configuring", "Configuring OpenClaw");
    const {
      varMap,
      modelKey: validatedModelKey,
      selectedProvider,
      hasCodexOauth,
      hasClaudeCli,
      agentRuntimeId: validatedAgentRuntimeId,
      requiredPlugins,
    } = validation.data;
    const existingEnvVars =
      typeof readEnvFile === "function" ? readEnvFile() : [];
    const varsToSave = [...existingEnvVars];
    applySubmittedEnvVars(varsToSave, vars);
    removeEnvVar(varsToSave, "GITHUB_TOKEN");
    removeEnvVar(varsToSave, "GITHUB_WORKSPACE_REPO");
    pruneConflictingProviderAuthVars(varsToSave, {
      selectedProvider,
      varMap,
    });
    const gatewayToken = ensureGatewayTokenEnvVar(varsToSave);
    if (gatewayToken.generated) {
      console.log("[onboard] Generated OPENCLAW_GATEWAY_TOKEN for the Gateway");
    }
    writeEnvFile(varsToSave);
    reloadEnv();
    syncApiKeyAuthProfilesFromEnvVars(authProfiles, varsToSave);

    fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    migrateManagedInternalFiles({
      fs,
      openclawDir: OPENCLAW_DIR,
    });
    syncBootstrapPromptFiles({
      fs,
      workspaceDir: WORKSPACE_DIR,
      baseUrl: getBaseUrl(req),
    });
    ensureOpenclawRuntimeArtifacts({
      fs,
      openclawDir: OPENCLAW_DIR,
    });

    const onboardArgs = buildOnboardArgs({
      varMap,
      selectedProvider,
      hasCodexOauth,
      hasClaudeCli,
      agentRuntimeId: validatedAgentRuntimeId,
      workspaceDir: WORKSPACE_DIR,
    });
    if (
      validatedAgentRuntimeId === "codex" ||
      (Array.isArray(requiredPlugins) && requiredPlugins.includes("codex"))
    ) {
      reportProgress("plugins", "Installing plugins");
      await ensureCodexPluginInstalled({
        shellCmd,
        gatewayEnv,
        gatewayMaintenanceEnv,
      });
    }
    await shellCmd(
      `openclaw onboard ${onboardArgs.map((a) => `"${a}"`).join(" ")}`,
      {
        env: gatewayMaintenanceEnv(),
        timeout: 120000,
      },
    );
    console.log("[onboard] Onboard complete");

    await shellCmd(`openclaw models set "${validatedModelKey}"`, {
      env: gatewayMaintenanceEnv(),
      timeout: 30000,
    }).catch((e) => {
      console.error("[onboard] Failed to set model:", e.message);
      throw new Error(
        `Onboarding completed but failed to set model "${validatedModelKey}"`,
      );
    });

    try {
      fs.rmSync(`${WORKSPACE_DIR}/.git`, { recursive: true, force: true });
    } catch {}

    writeSanitizedOpenclawConfig({
      fs,
      openclawDir: OPENCLAW_DIR,
      varMap,
      agentRuntimeId: validatedAgentRuntimeId,
      modelKey: validatedModelKey,
      requiredPlugins,
    });
    authProfiles?.syncConfigAuthReferencesForAgent?.();
    ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir: OPENCLAW_DIR,
    });

    reportProgress("plugins", "Installing plugins");
    try {
      await reconcileOpenclawPlugins?.({
        rootDir: constants.kRootDir || path.dirname(OPENCLAW_DIR),
        openclawDir: OPENCLAW_DIR,
        fsModule: fs,
        logger: console,
        env: process.env,
      });
    } catch (e) {
      throw new Error(
        `OpenClaw plugin reconciliation failed: ${e.message || String(e)}`,
      );
    }

    installGogCliSkill({ fs, openclawDir: OPENCLAW_DIR });
    installComposioSkill({ fs, openclawDir: OPENCLAW_DIR });

    const network = prepared.tunnel
      ? await finalizeTunnelNetwork({ reportProgress })
      : await finalizeTailscaleNetwork({ prepared, reportProgress });
    const { setupUrl, publicBaseUrl } = network;
    const finalSetupUrl = setupUrl;
    reportProgress("finishing", "Finishing setup");
    if (finalSetupUrl) {
      syncBootstrapPromptFiles({
        fs,
        workspaceDir: WORKSPACE_DIR,
        baseUrl: finalSetupUrl,
      });
    }

    fs.mkdirSync(path.dirname(kOnboardingMarkerPath), { recursive: true });
    fs.writeFileSync(
      kOnboardingMarkerPath,
      JSON.stringify(
        {
          onboarded: true,
          reason: "onboarding_complete",
          setupUrl,
          publicBaseUrl,
          ...network.resultFields,
          markedAt: new Date().toISOString(),
          // The finalize-setup "check" at onboarding start would have thrown
          // if the wrapper were missing, so reaching this point means the
          // host finalization restart will be scheduled once the setup
          // operation has published its result.
          // The bootstrap kickoff defers to the post-restart process based
          // on this flag; the finalize task flips it to false if scheduling
          // fails so the kickoff is not deferred forever.
          hostFinalizationScheduled: true,
          initialRuntimeCheckRequired: true,
        },
        null,
        2,
      ),
    );

    ensureGatewayProxyConfig(finalSetupUrl || getBaseUrl(req));

    runOnboardedBootSequence?.();
    return {
      body: {
        ok: true,
        setupUrl,
        publicBaseUrl,
        ...network.resultFields,
        ...network.bodyFields,
      },
      afterComplete: createHostFinalizeSetupCompleteTask({
        shellCmd,
        fs,
        markerPath: kOnboardingMarkerPath,
      }),
    };
  };

  return { validateOnboardingRequest, runOnboarding };
};

module.exports = {
  ensureGatewayTokenEnvVar,
  createOnboardingService,
};
