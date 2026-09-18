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

const ensureCodexPluginInstalled = async ({ shellCmd, gatewayEnv }) => {
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
    env: gatewayEnv(),
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
  prepareAgentVaultRuntime,
  runOnboardedBootSequence,
}) => {
  const { OPENCLAW_DIR, WORKSPACE_DIR, kOnboardingMarkerPath } = constants;

  const completeOnboarding = async ({
    req,
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
      return {
        status: validation.status,
        body: { ok: false, error: validation.error },
      };
    }
    const tailscaleValidation = getTailscaleApiTokenValidation(tailscaleApiToken);
    if (!tailscaleValidation.ok) {
      return {
        status: 400,
        body: { ok: false, error: tailscaleValidation.error },
      };
    }
    await runHostFinalizeSetup(shellCmd, "check");

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
      await ensureCodexPluginInstalled({ shellCmd, gatewayEnv });
    }
    await shellCmd(
      `openclaw onboard ${onboardArgs.map((a) => `"${a}"`).join(" ")}`,
      {
        env: gatewayEnv(),
        timeout: 120000,
      },
    );
    console.log("[onboard] Onboard complete");

    await shellCmd(`openclaw models set "${validatedModelKey}"`, {
      env: gatewayEnv(),
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

    const tailscaleResult = await tailscaleFinalizer.finalizeTailscaleOnboarding({
      tailscaleApiToken: tailscaleValidation.token,
    });
    const setupUrl = String(tailscaleResult?.setupUrl || "").trim();
    if (!setupUrl) {
      throw new Error(
        "Tailscale finalization completed without a final setup URL",
      );
    }
    const finalSetupUrl = setupUrl;
    const publicBaseUrl = String(tailscaleResult?.publicBaseUrl || "").trim();
    const tailscaleDns = String(
      tailscaleResult?.dnsName || getHostnameFromUrl(setupUrl),
    ).trim();
    const handoffViaBootstrapOrigin =
      tailscaleResult?.handoffViaBootstrapOrigin === true;
    if (tailscaleResult?.agentVaultOperatorUrl) {
      if (typeof prepareAgentVaultRuntime !== "function") {
        throw new Error(
          "Automatic Agent Vault initialization is unavailable",
        );
      }
      const agentVaultRuntime = await prepareAgentVaultRuntime();
      if (agentVaultRuntime?.ready !== true) {
        throw new Error(
          "Automatic Agent Vault initialization did not complete",
        );
      }
    }
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
          tailscaleDns,
          ...(handoffViaBootstrapOrigin
            ? { handoffViaBootstrapOrigin: true }
            : {}),
          markedAt: new Date().toISOString(),
          // The finalize-setup "check" at onboarding start would have thrown
          // if the wrapper were missing, so reaching this point means the
          // host finalization restart will be scheduled after the response.
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
      status: 200,
      body: {
        ok: true,
        setupUrl,
        publicBaseUrl,
        tailscaleDns,
        ...(handoffViaBootstrapOrigin
          ? { handoffViaBootstrapOrigin: true }
          : {}),
      },
      afterResponse: createHostFinalizeSetupCompleteTask({
        shellCmd,
        fs,
        markerPath: kOnboardingMarkerPath,
      }),
    };
  };

  return { completeOnboarding };
};

module.exports = {
  createOnboardingService,
};
