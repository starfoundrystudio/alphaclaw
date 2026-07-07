import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  adoptClaudeCli,
  fetchClaudeCliStatus,
  runOnboard,
  fetchOnboardStatus,
  fetchModels,
  startClaudeCliLogin,
  subscribeClaudeCliLoginEvents,
  submitClaudeCliLoginInput,
} from "../../lib/api.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { usePolling } from "../../hooks/usePolling.js";
import {
  getModelProvider,
  getAuthProviderFromModelProvider,
  getAnthropicModelKeyForClaudeCliRuntimeModel,
  getOpenAiModelKeyForCodexRuntimeModel,
  getAccountLoginProviderForModelKey,
  getAccountLoginProviderOptions,
  getDefaultAccountLoginProvider,
  getDefaultModelAccessMode,
  getDefaultProviderForAccessMode,
  getInitialModelKeyForAccountLoginProvider,
  getInitialModelKeyForAccessMode,
  getInitialModelKeyForAccessModeProvider,
  getModelAccessModeForModelKey,
  getOnboardingModelCatalog,
  getOnboardingModelsForAccountLoginProvider,
  getOnboardingModelsForAccessMode,
  getOnboardingModelsForAccessModeProvider,
  getProviderOptionsForAccessMode,
  getRecommendedModelsForAccountLoginProvider,
  getRecommendedModelsForAccessMode,
  getRecommendedModelsForAccessModeProvider,
  isSetupReadyAccountLoginProvider,
  kAccountLoginProviderStorageKey,
  kModelAccessModeStorageKey,
  getVisibleAiFieldKeys,
  normalizeAccountLoginProvider,
  normalizeModelAccessMode,
  normalizeProviderForAccessMode,
  kProviderAuthFields,
} from "../../lib/model-config.js";
import {
  getInitialOnboardingModelKey,
  getModelCatalogModels,
  isModelCatalogRefreshing,
  kModelCatalogCacheKey,
  kModelCatalogPollIntervalMs,
  preloadModelCatalog,
} from "../../lib/model-catalog.js";
import {
  kWelcomeGroups,
  getWelcomeGroupError,
  findFirstInvalidWelcomeGroup,
  kTailscaleGroupId,
} from "../onboarding/welcome-config.js";
import { getPreferredPairingChannel } from "../onboarding/pairing-utils.js";
import {
  kOnboardingStorageKey,
  kPairingChannelKey,
  useWelcomeStorage,
} from "../onboarding/use-welcome-storage.js";
import { useWelcomeCodex } from "../onboarding/use-welcome-codex.js";
import { useWelcomePairing } from "../onboarding/use-welcome-pairing.js";
import {
  closeClaudeCliAuthPlaceholderWindow,
  extractClaudeCliAuthUrl,
  navigateClaudeCliAuthWindow,
  openClaudeCliAuthPlaceholderWindow,
  shouldAutoAdoptClaudeCliLogin,
} from "../../lib/claude-cli-login-window.js";

const kMaxOnboardingVars = 64;
const kMaxEnvKeyLength = 128;
const kMaxEnvValueLength = 4096;
export const kImportStepId = "import";
export const kSecretReviewStepId = "secret-review";
export const kPlaceholderReviewStepId = "placeholder-review";
const kImportSubstepKey = "_IMPORT_SUBSTEP";
const kImportPlaceholderReviewKey = "_IMPORT_PLACEHOLDER_REVIEW";
const kImportPlaceholderSkipConfirmedKey = "_IMPORT_PLACEHOLDER_SKIP_CONFIRMED";
const kOnboardCompletionPollAttempts = 18;
const kOnboardCompletionPollIntervalMs = 2000;

const normalizeOnboardingVals = (currentVals = {}) => {
  let didChange = false;
  const normalizedEntries = Object.entries(currentVals).map(([key, value]) => {
    const normalizedValue = typeof value === "string" ? value.trim() : value;
    if (normalizedValue !== value) didChange = true;
    return [key, normalizedValue];
  });
  return {
    normalizedVals: didChange ? Object.fromEntries(normalizedEntries) : currentVals,
    didChange,
  };
};

const normalizePlaceholderReview = (review) => {
  if (!review || !Array.isArray(review.vars) || review.vars.length === 0) {
    return { found: false, count: 0, vars: [] };
  }
  return {
    found: true,
    count:
      typeof review.count === "number" ? review.count : review.vars.length,
    vars: review.vars
      .map((item) => ({
        key: String(item?.key || "").trim(),
        status: String(item?.status || "missing").trim() || "missing",
      }))
      .filter((item) => item.key),
  };
};

export const buildSetupRedirectUrl = (setupUrl) => {
  try {
    const url = new URL(String(setupUrl || ""));
    return `${url.origin}/#/general`;
  } catch {
    return "";
  }
};

export const shouldRedirectToSetupUrl = (
  setupUrl,
  currentOrigin = globalThis.window?.location?.origin || "",
) => {
  const redirectUrl = buildSetupRedirectUrl(setupUrl);
  if (!redirectUrl) return false;
  try {
    return new URL(redirectUrl).origin !== String(currentOrigin || "");
  } catch {
    return false;
  }
};

export const getSetupRedirectUrlForOnboardResult = (
  result,
  currentOrigin = globalThis.window?.location?.origin || "",
) => {
  const setupUrl = String(result?.setupUrl || "");
  if (!shouldRedirectToSetupUrl(setupUrl, currentOrigin)) return "";
  return buildSetupRedirectUrl(setupUrl);
};

export const getMissingSetupUrlError = () =>
  new Error(
    "Setup completed, but AlphaClaw did not receive the final Tailscale URL. Check Tailscale finalization and retry setup.",
  );

export const requireFinalSetupUrl = (result) => {
  if (String(result?.setupUrl || "").trim()) return;
  throw getMissingSetupUrlError();
};

export const probeSetupRedirectTarget = async (
  redirectUrl,
  { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {},
) => {
  if (typeof fetchImpl !== "function") return true;
  const target = buildSetupRedirectUrl(redirectUrl) || String(redirectUrl || "");
  if (!target) return false;
  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  const timer =
    controller && Number(timeoutMs) > 0
      ? setTimeout(() => controller.abort(), Number(timeoutMs))
      : null;
  try {
    await fetchImpl(target, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      ...(controller ? { signal: controller.signal } : {}),
    });
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const isRecoverableOnboardCompletionError = (error) => {
  const code = String(error?.code || "");
  if (
    code === "ONBOARD_RESPONSE_EMPTY" ||
    code === "ONBOARD_RESPONSE_INVALID_JSON"
  ) {
    return true;
  }
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("load failed") ||
    message.includes("networkerror") ||
    message.includes("unexpected end of json input")
  );
};

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const waitForOnboardingCompletion = async ({
  fetchStatus = fetchOnboardStatus,
  attempts = kOnboardCompletionPollAttempts,
  intervalMs = kOnboardCompletionPollIntervalMs,
} = {}) => {
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const status = await fetchStatus();
      if (status?.onboarded === true) return status;
    } catch {}
    if (attempt < maxAttempts - 1) {
      await wait(Math.max(0, Number(intervalMs) || 0));
    }
  }
  return null;
};

export const useWelcome = ({ onComplete }) => {
  const kSetupStepIndex = kWelcomeGroups.length;
  const kPairingStepIndex = kSetupStepIndex + 1;
  const {
    vals,
    setVals,
    setValue: setStoredValue,
    step,
    setStep,
    setupError,
    setSetupError,
  } = useWelcomeStorage({
    kSetupStepIndex,
    kPairingStepIndex,
  });
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState(null);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tailscaleApiToken, setTailscaleApiToken] = useState("");
  const [tailscaleClientReady, setTailscaleClientReady] = useState(false);
  const [setupHandoff, setSetupHandoff] = useState(null);
  const [formError, setFormError] = useState(null);
  const {
    codexStatus,
    codexLoading,
    codexManualInput,
    setCodexManualInput,
    codexExchanging,
    codexAuthStarted,
    codexAuthWaiting,
    startCodexAuth,
    completeCodexAuth,
    handleCodexDisconnect,
  } = useWelcomeCodex({ setFormError });
  const claudeCliLoginUnsubscribeRef = useRef(null);
  const claudeCliLoginPopupRef = useRef(null);
  const claudeCliLoginFinalizingRef = useRef(false);
  const [claudeCliStatus, setClaudeCliStatus] = useState({
    installed: false,
    loggedIn: false,
    configured: false,
  });
  const [claudeCliLoading, setClaudeCliLoading] = useState(false);
  const [claudeCliActionLoading, setClaudeCliActionLoading] = useState(false);
  const [claudeCliLoginId, setClaudeCliLoginId] = useState("");
  const [claudeCliLoginInput, setClaudeCliLoginInput] = useState("");
  const [claudeCliLoginSubmitting, setClaudeCliLoginSubmitting] = useState(false);
  const [claudeCliLoginOutput, setClaudeCliLoginOutput] = useState("");
  const [claudeCliLoginState, setClaudeCliLoginState] = useState("idle");
  const [claudeCliLoginUrl, setClaudeCliLoginUrl] = useState("");
  const [claudeCliLoginWindowOpened, setClaudeCliLoginWindowOpened] =
    useState(false);
  const [claudeCliError, setClaudeCliError] = useState("");
  const [importStep, setImportStepState] = useState(() => {
    const storedStep = String(vals[kImportSubstepKey] || "").trim();
    return storedStep === kPlaceholderReviewStepId
      ? storedStep
      : null;
  });
  const [importScanResult, setImportScanResult] = useState(null);
  const importScanning = false;
  const [importError, setImportError] = useState(null);
  const modelsFetchState = useCachedFetch(kModelCatalogCacheKey, fetchModels, {
    maxAgeMs: 30000,
  });
  const modelsPoll = usePolling(fetchModels, kModelCatalogPollIntervalMs, {
    enabled: modelsRefreshing,
    pauseWhenHidden: true,
    cacheKey: kModelCatalogCacheKey,
  });

  useEffect(() => {
    // Warm the real catalog immediately so the AI step usually opens ready.
    preloadModelCatalog().catch(() => {});
  }, []);

  const setValue = (key, value) => {
    if (formError) setFormError(null);
    setStoredValue(key, value);
  };

  const refreshClaudeCliStatus = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setClaudeCliLoading(true);
    setClaudeCliError("");
    try {
      const status = await fetchClaudeCliStatus();
      if (!status?.ok) throw new Error(status?.error || "Failed to check Claude CLI");
      setClaudeCliStatus(status);
      return status;
    } catch (err) {
      setClaudeCliError(err.message || "Failed to check Claude CLI");
      return null;
    } finally {
      if (!silent) setClaudeCliLoading(false);
    }
  }, []);

  const configureClaudeCliProfile = useCallback(
    async ({ statusFallback = null } = {}) => {
      const result = await adoptClaudeCli();
      if (!result?.ok) {
        throw new Error(result?.error || "Failed to use Claude CLI");
      }
      const fallbackStatus = statusFallback
        ? { ...statusFallback, configured: true }
        : {
            ...claudeCliStatus,
            configured: true,
          };
      setClaudeCliStatus(
        result.status || fallbackStatus,
      );
      setClaudeCliLoginState("configured");
      setFormError(null);
      return result;
    },
    [claudeCliStatus, setFormError],
  );

  const startClaudeCliAuth = useCallback(async () => {
    if (claudeCliActionLoading) return;
    const popup = openClaudeCliAuthPlaceholderWindow();
    claudeCliLoginPopupRef.current = popup;
    claudeCliLoginFinalizingRef.current = false;
    setClaudeCliLoginWindowOpened(!!popup);
    setClaudeCliActionLoading(true);
    setClaudeCliLoginState("running");
    setClaudeCliLoginId("");
    setClaudeCliLoginInput("");
    setClaudeCliLoginOutput("");
    setClaudeCliLoginUrl("");
    setClaudeCliError("");
    try {
      const result = await startClaudeCliLogin();
      if (!result?.ok || !result?.id) {
        throw new Error(result?.error || "Failed to start Claude login");
      }
      setClaudeCliLoginId(result.id);
      claudeCliLoginUnsubscribeRef.current?.();
      claudeCliLoginUnsubscribeRef.current = subscribeClaudeCliLoginEvents({
        id: result.id,
        onMessage: ({ event, data }) => {
          const payload = data || {};
          const output = String(payload.output || "");
          setClaudeCliLoginOutput(output);
          const authUrl = extractClaudeCliAuthUrl(output);
          if (authUrl) {
            setClaudeCliLoginUrl((current) => current || authUrl);
            if (claudeCliLoginPopupRef.current) {
              const opened = navigateClaudeCliAuthWindow(
                claudeCliLoginPopupRef.current,
                authUrl,
              );
              setClaudeCliLoginWindowOpened(opened);
              if (opened) claudeCliLoginPopupRef.current = null;
            }
          }
          const nextStatus = String(payload.status || "").trim();
          if (nextStatus) setClaudeCliLoginState(nextStatus);
          if (event === "done" || event === "error" || nextStatus !== "running") {
            const shouldAutoAdopt = shouldAutoAdoptClaudeCliLogin({
              event,
              status: nextStatus,
              exitCode: payload.exitCode,
            });
            claudeCliLoginUnsubscribeRef.current?.();
            claudeCliLoginUnsubscribeRef.current = null;
            closeClaudeCliAuthPlaceholderWindow(claudeCliLoginPopupRef.current);
            claudeCliLoginPopupRef.current = null;
            setClaudeCliLoginId("");
            setClaudeCliLoginInput("");
            if (shouldAutoAdopt && !claudeCliLoginFinalizingRef.current) {
              claudeCliLoginFinalizingRef.current = true;
              (async () => {
                try {
                  const status = await refreshClaudeCliStatus({ silent: true });
                  await configureClaudeCliProfile({ statusFallback: status });
                } catch (err) {
                  setClaudeCliError(err.message || "Failed to use Claude CLI");
                  await refreshClaudeCliStatus({ silent: true });
                } finally {
                  claudeCliLoginFinalizingRef.current = false;
                  setClaudeCliActionLoading(false);
                }
              })();
            } else {
              setClaudeCliActionLoading(false);
              refreshClaudeCliStatus({ silent: true });
            }
          }
        },
        onError: () => {
          closeClaudeCliAuthPlaceholderWindow(claudeCliLoginPopupRef.current);
          claudeCliLoginPopupRef.current = null;
          setClaudeCliLoginId("");
          setClaudeCliActionLoading(false);
          refreshClaudeCliStatus({ silent: true });
        },
      });
    } catch (err) {
      setClaudeCliError(err.message || "Failed to start Claude login");
      setClaudeCliLoginState("error");
      setClaudeCliLoginId("");
      closeClaudeCliAuthPlaceholderWindow(claudeCliLoginPopupRef.current);
      claudeCliLoginPopupRef.current = null;
      setClaudeCliActionLoading(false);
    }
  }, [claudeCliActionLoading, configureClaudeCliProfile, refreshClaudeCliStatus]);

  const openClaudeCliLoginUrl = useCallback(() => {
    const authUrl = String(claudeCliLoginUrl || "").trim();
    if (!authUrl) return;
    const popup = openClaudeCliAuthPlaceholderWindow();
    if (popup) {
      setClaudeCliLoginWindowOpened(
        navigateClaudeCliAuthWindow(popup, authUrl),
      );
      return;
    }
    window.location.href = authUrl;
  }, [claudeCliLoginUrl]);

  const submitClaudeCliLoginCode = useCallback(async () => {
    const id = String(claudeCliLoginId || "").trim();
    const input = String(claudeCliLoginInput || "").trim();
    if (!id || !input || claudeCliLoginSubmitting) return;
    setClaudeCliLoginSubmitting(true);
    setClaudeCliError("");
    try {
      const result = await submitClaudeCliLoginInput({ id, input });
      if (!result?.ok) {
        throw new Error(result?.error || "Failed to send Claude login code");
      }
      setClaudeCliLoginInput("");
    } catch (err) {
      setClaudeCliError(err.message || "Failed to send Claude login code");
    } finally {
      setClaudeCliLoginSubmitting(false);
    }
  }, [claudeCliLoginId, claudeCliLoginInput, claudeCliLoginSubmitting]);

  const adoptClaudeCliAuth = useCallback(async () => {
    if (claudeCliActionLoading) return;
    setClaudeCliActionLoading(true);
    setClaudeCliError("");
    try {
      await configureClaudeCliProfile({ statusFallback: claudeCliStatus });
    } catch (err) {
      setClaudeCliError(err.message || "Failed to use Claude CLI");
    } finally {
      setClaudeCliActionLoading(false);
    }
  }, [claudeCliActionLoading, claudeCliStatus, configureClaudeCliProfile]);

  useEffect(
    () => () => {
      claudeCliLoginUnsubscribeRef.current?.();
      claudeCliLoginUnsubscribeRef.current = null;
      closeClaudeCliAuthPlaceholderWindow(claudeCliLoginPopupRef.current);
      claudeCliLoginPopupRef.current = null;
      claudeCliLoginFinalizingRef.current = false;
    },
    [],
  );

  const setModelAccessMode = (nextMode) => {
    const normalizedMode = normalizeModelAccessMode(nextMode) || getDefaultModelAccessMode();
    const onboardingCatalog = getOnboardingModelCatalog(models);
    const nextProvider = getDefaultProviderForAccessMode({
      models: onboardingCatalog,
      accessMode: normalizedMode,
    });
    const nextModelKey = getInitialModelKeyForAccessModeProvider({
      models: onboardingCatalog,
      accessMode: normalizedMode,
      provider: nextProvider,
    });
    if (formError) setFormError(null);
    setShowAllModels(false);
    setVals((prev) => ({
      ...prev,
      [kModelAccessModeStorageKey]: normalizedMode,
      [kAccountLoginProviderStorageKey]: nextProvider,
      MODEL_KEY: nextModelKey,
    }));
  };

  const setAccountLoginProvider = (nextProvider) => {
    const onboardingCatalog = getOnboardingModelCatalog(models);
    const normalizedMode =
      normalizeModelAccessMode(vals[kModelAccessModeStorageKey]) ||
      getModelAccessModeForModelKey(vals.MODEL_KEY, onboardingCatalog) ||
      getDefaultModelAccessMode();
    const normalizedProvider =
      normalizeProviderForAccessMode({
        provider: nextProvider,
        models: onboardingCatalog,
        accessMode: normalizedMode,
      }) ||
      getDefaultProviderForAccessMode({
        models: onboardingCatalog,
        accessMode: normalizedMode,
      });
    if (formError) setFormError(null);
    setShowAllModels(false);
    setVals((prev) => ({
      ...prev,
      [kModelAccessModeStorageKey]: normalizedMode,
      [kAccountLoginProviderStorageKey]: normalizedProvider,
      MODEL_KEY: getInitialModelKeyForAccessModeProvider({
        models: onboardingCatalog,
        accessMode: normalizedMode,
        provider: normalizedProvider,
      }),
    }));
  };

  const setImportStep = (nextStep) => {
    setImportStepState(nextStep);
    setVals((prev) => ({
      ...prev,
      [kImportSubstepKey]:
        nextStep === kPlaceholderReviewStepId ? nextStep : "",
    }));
  };

  const clearPlaceholderReview = () => {
    setVals((prev) => ({
      ...prev,
      [kImportPlaceholderReviewKey]: null,
      [kImportPlaceholderSkipConfirmedKey]: false,
    }));
  };

  const applyModelCatalog = useCallback((payload) => {
    const list = getModelCatalogModels(payload);
    if (!payload) return;
    const isRefreshing = isModelCatalogRefreshing(payload);
    const isFallbackRefresh =
      String(payload?.source || "") === "fallback" && isRefreshing;
    setModels(list);
    setModelsRefreshing(isRefreshing);
    setModelsError(
      list.length > 0
        ? isFallbackRefresh
          ? "Loading full model catalog..."
          : null
        : "No models found",
    );
    const defaultModelKey = getInitialOnboardingModelKey({
      catalog: list,
      currentModelKey: vals.MODEL_KEY,
    });
    if (!vals.MODEL_KEY && defaultModelKey) {
      setVals((prev) => ({ ...prev, MODEL_KEY: defaultModelKey }));
    }
  }, [setVals, vals.MODEL_KEY]);

  useEffect(() => {
    applyModelCatalog(modelsFetchState.data);
  }, [applyModelCatalog, modelsFetchState.data]);

  useEffect(() => {
    applyModelCatalog(modelsPoll.data);
  }, [applyModelCatalog, modelsPoll.data]);

  useEffect(() => {
    const hasModels = getModelCatalogModels(modelsFetchState.data).length > 0;
    setModelsLoading(
      (modelsFetchState.loading || modelsPoll.isPolling) && !hasModels,
    );
  }, [modelsFetchState.data, modelsFetchState.loading, modelsPoll.isPolling]);

  useEffect(() => {
    if (!modelsFetchState.error) return;
    setModelsError("Failed to load models");
    setModelsLoading(false);
  }, [modelsFetchState.error]);

  const getValidationContext = (currentVals = {}) => {
    const currentSelectedProvider = getModelProvider(
      String(currentVals.MODEL_KEY || "").trim(),
    );
    const currentOnboardingModels = getOnboardingModelCatalog(models);
    const currentAccessMode =
      normalizeModelAccessMode(currentVals[kModelAccessModeStorageKey]) ||
      getModelAccessModeForModelKey(currentVals.MODEL_KEY, currentOnboardingModels) ||
      getDefaultModelAccessMode();
    const currentSelectedAuthProvider =
      getAuthProviderFromModelProvider(currentSelectedProvider);
    const currentProviderAuthFields =
      kProviderAuthFields[currentSelectedAuthProvider] || [];
    const hasOpenAiApiKey = !!String(currentVals.OPENAI_API_KEY || "").trim();
    const accountLoginNeedsSetup =
      currentAccessMode === "subscription" &&
      !isSetupReadyAccountLoginProvider(currentSelectedProvider);
    const currentHasAi = (() => {
      if (accountLoginNeedsSetup) return false;
      if (currentSelectedProvider === "openai-codex") {
        return !!codexStatus.connected;
      }
      if (currentSelectedProvider === "openai") {
        return currentAccessMode === "subscription"
          ? !!codexStatus.connected
          : hasOpenAiApiKey;
      }
      if (
        currentAccessMode === "subscription" &&
        currentSelectedProvider === "claude-cli"
      ) {
        return !!claudeCliStatus.configured;
      }
      return currentProviderAuthFields.some((field) =>
        !!String(currentVals[field.key] || "").trim(),
      );
    })();

    return {
      hasAi: currentHasAi,
      selectedProvider: currentSelectedProvider,
      modelAccessMode: currentAccessMode,
      accountLoginNeedsSetup,
      codexLoading,
      tailscaleApiToken,
      tailscaleClientReady,
    };
  };

  const validationContext = getValidationContext(vals);
  const { selectedProvider, hasAi } = validationContext;
  const placeholderReview = normalizePlaceholderReview(
    vals[kImportPlaceholderReviewKey],
  );
  const onboardingModels = getOnboardingModelCatalog(models);
  const modelAccessMode =
    normalizeModelAccessMode(vals[kModelAccessModeStorageKey]) ||
    getModelAccessModeForModelKey(vals.MODEL_KEY, onboardingModels) ||
    getDefaultModelAccessMode();
  const accountLoginOptions = getProviderOptionsForAccessMode({
    models: onboardingModels,
    accessMode: modelAccessMode,
  });
  const selectedAccountLoginProvider =
    normalizeProviderForAccessMode({
      provider: vals[kAccountLoginProviderStorageKey],
      models: onboardingModels,
      accessMode: modelAccessMode,
    }) ||
    normalizeProviderForAccessMode({
      provider: getModelProvider(vals.MODEL_KEY),
      models: onboardingModels,
      accessMode: modelAccessMode,
    }) ||
    getDefaultProviderForAccessMode({
      models: onboardingModels,
      accessMode: modelAccessMode,
    });
  const accessModeModels = getOnboardingModelsForAccessModeProvider({
    models: onboardingModels,
    accessMode: modelAccessMode,
    provider: selectedAccountLoginProvider,
  });
  const recommendedModels = getRecommendedModelsForAccessModeProvider({
    models: onboardingModels,
    accessMode: modelAccessMode,
    provider: selectedAccountLoginProvider,
  });
  const recommendedModelKeys = new Set(
    recommendedModels.map((model) => model?.key).filter(Boolean),
  );
  const baseModelOptions = showAllModels
    ? accessModeModels
    : recommendedModels.length > 0
      ? recommendedModels
      : accessModeModels;
  const selectedModelOption = onboardingModels.find(
    (model) => model.key === vals.MODEL_KEY,
  );
  const modelOptions =
    selectedModelOption &&
    accessModeModels.some((model) => model?.key === selectedModelOption.key) &&
    !baseModelOptions.some((model) => model.key === selectedModelOption.key)
      ? [...baseModelOptions, selectedModelOption]
      : baseModelOptions;
  const canToggleFullCatalog =
    recommendedModels.length > 0 && accessModeModels.length > recommendedModels.length;
  const selectedModelIsRecommended =
    recommendedModels.length === 0 ||
    !vals.MODEL_KEY ||
    !selectedModelOption ||
    recommendedModelKeys.has(vals.MODEL_KEY);
  const visibleAiFieldKeys =
    modelAccessMode === "subscription" && selectedProvider === "openai"
      ? new Set()
      : getVisibleAiFieldKeys(selectedProvider);
  const accountLoginNeedsSetup =
    modelAccessMode === "subscription" &&
    !isSetupReadyAccountLoginProvider(selectedProvider);
  const isPreStep = step === -1;
  const isSetupStep = step === kSetupStepIndex;
  const isPairingStep = step === kPairingStepIndex;
  const activeGroup = step >= 0 && step < kSetupStepIndex ? kWelcomeGroups[step] : null;
  const selectedPairingChannel = String(
    vals[kPairingChannelKey] || getPreferredPairingChannel(vals),
  );

  useEffect(() => {
    if (
      modelAccessMode !== "subscription" ||
      selectedAccountLoginProvider !== "claude-cli"
    ) {
      return;
    }
    refreshClaudeCliStatus({ silent: false });
  }, [modelAccessMode, refreshClaudeCliStatus, selectedAccountLoginProvider]);

  const {
    pairingStatusPoll,
    pairingRequestsPoll,
    pairingChannels,
    canFinishPairing,
    pairingError,
    pairingComplete,
    handlePairingApprove,
    handlePairingReject,
    resetPairingState,
  } = useWelcomePairing({
    isPairingStep,
    selectedPairingChannel,
  });

  useEffect(() => {
    if (!modelAccessMode || accessModeModels.length === 0) return;
    const selectedInMode = accessModeModels.some(
      (model) => model?.key === vals.MODEL_KEY,
    );
    if (selectedInMode) return;
    const nextModelKey = getInitialModelKeyForAccessModeProvider({
      models: onboardingModels,
      accessMode: modelAccessMode,
      provider: selectedAccountLoginProvider,
    });
    if (!nextModelKey || nextModelKey === vals.MODEL_KEY) return;
    setVals((prev) => ({
      ...prev,
      [kModelAccessModeStorageKey]: modelAccessMode,
      [kAccountLoginProviderStorageKey]: selectedAccountLoginProvider,
      MODEL_KEY: nextModelKey,
    }));
  }, [
    accessModeModels,
    modelAccessMode,
    onboardingModels,
    selectedAccountLoginProvider,
    setVals,
    vals.MODEL_KEY,
  ]);

  const redirectToFinalSetupUrl = useCallback((redirectUrl) => {
    localStorage.removeItem(kOnboardingStorageKey);
    window.location.href = redirectUrl;
  }, []);

  const beginSetupHandoff = useCallback(
    async (result) => {
      const redirectUrl = getSetupRedirectUrlForOnboardResult(result);
      if (!redirectUrl) return false;
      const nextHandoff = {
        setupUrl: String(result.setupUrl || ""),
        publicBaseUrl: String(result.publicBaseUrl || ""),
        tailscaleDns: String(result.tailscaleDns || ""),
        redirectUrl,
        status: "checking",
      };
      setLoading(false);
      setSetupError(null);
      setSetupHandoff(nextHandoff);
      const reachable = await probeSetupRedirectTarget(redirectUrl);
      if (reachable) {
        setSetupHandoff({ ...nextHandoff, status: "redirecting" });
        redirectToFinalSetupUrl(redirectUrl);
      } else {
        setSetupHandoff({ ...nextHandoff, status: "waiting" });
      }
      return true;
    },
    [redirectToFinalSetupUrl, setSetupError],
  );

  const handleRetrySetupHandoff = useCallback(async () => {
    const current = setupHandoff;
    if (!current?.redirectUrl) return;
    const nextHandoff = { ...current, status: "checking" };
    setSetupHandoff(nextHandoff);
    const reachable = await probeSetupRedirectTarget(current.redirectUrl);
    if (reachable) {
      setSetupHandoff({ ...nextHandoff, status: "redirecting" });
      redirectToFinalSetupUrl(current.redirectUrl);
      return;
    }
    setSetupHandoff({ ...nextHandoff, status: "waiting" });
  }, [redirectToFinalSetupUrl, setupHandoff]);

  const handleOpenSetupHandoff = useCallback(() => {
    if (!setupHandoff?.redirectUrl) return;
    redirectToFinalSetupUrl(setupHandoff.redirectUrl);
  }, [redirectToFinalSetupUrl, setupHandoff]);

  const handleSubmit = async () => {
    const { normalizedVals, didChange } = normalizeOnboardingVals(vals);
    if (didChange) setVals(normalizedVals);
    const submitValidationContext = getValidationContext(normalizedVals);
    const invalidGroup = findFirstInvalidWelcomeGroup(
      normalizedVals,
      submitValidationContext,
    );
    if (invalidGroup) {
      setFormError(
        getWelcomeGroupError(
          invalidGroup.id,
          normalizedVals,
          submitValidationContext,
        ),
      );
      setSetupError(null);
      setStep(kWelcomeGroups.findIndex((group) => group.id === invalidGroup.id));
      return;
    }
    if (loading) return;
    const vars = Object.entries(normalizedVals)
      .filter(
        ([key]) => key !== "MODEL_KEY" && !String(key || "").startsWith("_"),
      )
      .filter(
        ([key]) => key !== "GITHUB_TOKEN" && key !== "GITHUB_WORKSPACE_REPO",
      )
      .filter(([, value]) => value)
      .map(([key, value]) => ({ key, value }));
    const preflightError = (() => {
      if (!normalizedVals.MODEL_KEY || !String(normalizedVals.MODEL_KEY).includes("/")) {
        return "A model selection is required";
      }
      if (vars.length > kMaxOnboardingVars) {
        return `Too many environment variables (max ${kMaxOnboardingVars})`;
      }
      for (const entry of vars) {
        const key = String(entry?.key || "");
        const value = String(entry?.value || "");
        if (!key) return "Each variable must include a key";
        if (key.length > kMaxEnvKeyLength) {
          return `Variable key is too long: ${key.slice(0, 32)}...`;
        }
        if (value.length > kMaxEnvValueLength) {
          return `Value too long for ${key} (max ${kMaxEnvValueLength} chars)`;
        }
      }
      const tailscaleError = getWelcomeGroupError(
        kTailscaleGroupId,
        normalizedVals,
        submitValidationContext,
      );
      if (tailscaleError) return tailscaleError;
      return "";
    })();
    if (preflightError) {
      setFormError(preflightError);
      setSetupError(null);
      setStep(Math.max(0, kWelcomeGroups.findIndex((group) => group.id === kTailscaleGroupId)));
      return;
    }
    setStep(kSetupStepIndex);
    setLoading(true);
    setFormError(null);
    setSetupError(null);
    setSetupHandoff(null);
    resetPairingState();

    const wasImport = false;
    const submitAccessMode =
      normalizeModelAccessMode(normalizedVals[kModelAccessModeStorageKey]) ||
      submitValidationContext.modelAccessMode ||
      getDefaultModelAccessMode();
    const isOpenAiCodexSetupProvider =
      submitAccessMode === "subscription" &&
      (submitValidationContext.selectedProvider === "openai" ||
        submitValidationContext.selectedProvider === "openai-codex");
    const isClaudeCliSetupProvider =
      submitAccessMode === "subscription" &&
      submitValidationContext.selectedProvider === "claude-cli";
    const agentRuntimeId =
      isOpenAiCodexSetupProvider &&
      codexStatus.connected
        ? "codex"
        : isClaudeCliSetupProvider && claudeCliStatus.configured
          ? "claude-cli"
        : null;
    const onboardingModelKey = (() => {
      if (isOpenAiCodexSetupProvider && codexStatus.connected) {
        return getOpenAiModelKeyForCodexRuntimeModel(
          normalizedVals.MODEL_KEY,
          models,
        );
      }
      if (isClaudeCliSetupProvider && claudeCliStatus.configured) {
        return getAnthropicModelKeyForClaudeCliRuntimeModel(
          normalizedVals.MODEL_KEY,
        );
      }
      return normalizedVals.MODEL_KEY;
    })();
    try {
      const result = await runOnboard(vars, onboardingModelKey, {
        agentRuntimeId,
        importMode: wasImport,
        tailscaleApiToken,
      });
      if (!result.ok) throw new Error(result.error || "Onboarding failed");
      requireFinalSetupUrl(result);
      if (await beginSetupHandoff(result)) {
        return;
      }
      const pairingChannel = getPreferredPairingChannel(normalizedVals);
      if (!pairingChannel) {
        setLoading(false);
        setSetupError(null);
        finishOnboarding();
        return;
      }
      setVals((prev) => ({
        ...prev,
        [kPairingChannelKey]: pairingChannel,
      }));
      setLoading(false);
      setStep(kPairingStepIndex);
      resetPairingState();
      setSetupError(null);
    } catch (err) {
      console.error("Onboard error:", err);
      if (isRecoverableOnboardCompletionError(err)) {
        setSetupError(null);
        setSetupHandoff({
          status: "recovering",
          setupUrl: "",
          redirectUrl: "",
        });
        const completedStatus = await waitForOnboardingCompletion();
        if (completedStatus?.onboarded === true) {
          requireFinalSetupUrl(completedStatus);
          if (await beginSetupHandoff(completedStatus)) {
            return;
          }
          setLoading(false);
          setSetupHandoff({
            status: "complete",
            setupUrl: "",
            redirectUrl: "",
          });
          finishOnboarding();
          return;
        }
      }
      setSetupError(err.message || "Onboarding failed");
      setSetupHandoff(null);
      setLoading(false);
    }
  };

  const finishOnboarding = () => {
    localStorage.removeItem(kOnboardingStorageKey);
    onComplete();
  };

  const goBack = () => {
    if (isSetupStep) return;
    setFormError(null);
    setStep((prev) => Math.max(0, prev - 1));
  };

  const goBackFromSetupError = () => {
    setLoading(false);
    setSetupError(null);
    setSetupHandoff(null);
    setStep(kWelcomeGroups.length - 1);
  };

  const goNext = async () => {
    const { normalizedVals, didChange } = normalizeOnboardingVals(vals);
    if (didChange) setVals(normalizedVals);
    if (!activeGroup) return;
    const stepValidationContext = getValidationContext(normalizedVals);
    const stepValidationError = getWelcomeGroupError(
      activeGroup.id,
      normalizedVals,
      stepValidationContext,
    );
    if (stepValidationError) {
      setFormError(stepValidationError);
      return;
    }
    setFormError(null);
    setStep((prev) => Math.min(kWelcomeGroups.length - 1, prev + 1));
  };

  const handleImportApprove = async (approvedSecrets = []) => {
    setImportError("GitHub import is no longer available during setup.");
  };

  const handleShowSecretReview = () => {
    setImportStep(kSecretReviewStepId);
  };

  const handleSecretReviewBack = () => {
    setImportStep(kImportStepId);
  };

  const handleImportBack = () => {
    setImportStep(null);
    setImportScanResult(null);
    setImportError(null);
    clearPlaceholderReview();
  };

  const handlePlaceholderReviewContinue = () => {
    clearPlaceholderReview();
    setImportStep(null);
    setStep((prev) => Math.min(kWelcomeGroups.length - 1, prev + 1));
  };

  const handleSelectFlow = (flow) => {
    setStep(0);
  };

  const isImportStep = importStep === kImportStepId;
  const isSecretReviewStep = importStep === kSecretReviewStepId;
  const isPlaceholderReviewStep = importStep === kPlaceholderReviewStepId;
  const activeStepLabel = isPreStep
    ? "Getting Started"
    : isImportStep
    ? "Import"
    : isSecretReviewStep
      ? "Review Secrets"
      : isPlaceholderReviewStep
        ? "Review Env Vars"
        : isSetupStep
          ? "Initializing"
          : isPairingStep
            ? "Pairing"
            : activeGroup?.title || "Setup";
  const stepNumber =
    isPreStep
      ? 0
      : isImportStep || isSecretReviewStep || isPlaceholderReviewStep
      ? step + 1
      : isSetupStep
        ? kWelcomeGroups.length + 1
        : isPairingStep
          ? kWelcomeGroups.length + 2
          : step + 1;

  return {
    state: {
      vals,
      step,
      setupError,
      setupHandoff,
      modelsLoading,
      modelsError,
      showAllModels,
      loading,
      formError,
      importScanResult,
      importScanning,
      importError,
      selectedProvider,
      modelAccessMode,
      accountLoginOptions,
      selectedAccountLoginProvider,
      accountLoginNeedsSetup,
      modelOptions,
      recommendedModels,
      selectedModelIsRecommended,
      canToggleFullCatalog,
      visibleAiFieldKeys,
      hasAi,
      tailscaleApiToken,
      tailscaleClientReady,
      isPreStep,
      isSetupStep,
      isPairingStep,
      activeGroup,
      selectedPairingChannel,
      placeholderReview,
      isImportStep,
      isSecretReviewStep,
      isPlaceholderReviewStep,
      activeStepLabel,
      stepNumber,
      codexStatus,
      codexLoading,
      codexManualInput,
      codexExchanging,
      codexAuthStarted,
      codexAuthWaiting,
      claudeCliStatus,
      claudeCliLoading,
      claudeCliActionLoading,
      claudeCliLoginCanSubmitCode:
        claudeCliLoginState === "running" && !!String(claudeCliLoginId || "").trim(),
      claudeCliLoginInput,
      claudeCliLoginSubmitting,
      claudeCliLoginOutput,
      claudeCliLoginState,
      claudeCliLoginUrl,
      claudeCliLoginWindowOpened,
      claudeCliError,
      pairingStatusPoll,
      pairingRequestsPoll,
      pairingChannels,
      canFinishPairing,
      pairingError,
      pairingComplete,
    },
    actions: {
      setVals,
      setValue,
      setModelAccessMode,
      setAccountLoginProvider,
      setShowAllModels,
      setCodexManualInput,
      setTailscaleApiToken,
      setTailscaleClientReady,
      startCodexAuth,
      completeCodexAuth,
      handleCodexDisconnect,
      refreshClaudeCliStatus,
      startClaudeCliAuth,
      openClaudeCliLoginUrl,
      setClaudeCliLoginInput,
      submitClaudeCliLoginCode,
      adoptClaudeCliAuth,
      handleSubmit,
      handleOpenSetupHandoff,
      handleRetrySetupHandoff,
      finishOnboarding,
      goBack,
      goBackFromSetupError,
      goNext,
      handleSelectFlow,
      handleImportApprove,
      handleShowSecretReview,
      handleSecretReviewBack,
      handleImportBack,
      handlePlaceholderReviewContinue,
      handlePairingApprove,
      handlePairingReject,
    },
  };
};
