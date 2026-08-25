import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import {
  fetchModels,
  fetchModelsConfig,
  saveModelsConfig,
  fetchCodexStatus,
  fetchClaudeCliStatus,
  disconnectCodex,
  fetchAgentVaultCredentials,
  fetchAgentVaultProposal,
  requestModelVaultKey,
} from "../../lib/api.js";
import { showToast } from "../toast.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { usePolling } from "../../hooks/usePolling.js";
import { invalidateCache } from "../../lib/api-cache.js";
import {
  getModelCatalogModels,
  isModelCatalogRefreshing,
  kModelCatalogCacheKey,
  kModelCatalogPollIntervalMs,
} from "../../lib/model-catalog.js";
import {
  getAiCredentialFieldError,
  kProviderAuthFields,
} from "../../lib/model-config.js";

let kModelsTabCache = null;
const getCredentialValue = (value) =>
  String(value?.key || value?.token || value?.access || "").trim();
const getAgentRuntimeId = (value) => {
  const runtime = value?.agentRuntime;
  if (typeof runtime === "string") return runtime.trim();
  if (runtime && typeof runtime === "object" && !Array.isArray(runtime)) {
    return String(runtime.id || "").trim();
  }
  return "";
};
const buildModelRuntimeIds = (configuredModels = {}) =>
  Object.fromEntries(
    Object.entries(configuredModels || {})
      .map(([modelKey, value]) => [modelKey, getAgentRuntimeId(value)])
      .filter(([, runtimeId]) => runtimeId),
  );
const kNoModelsFoundError = "No models found";
const kModelSettingsLoadError = "Failed to load model settings";
const kDefaultVaultBrokering = { enforced: false, providers: [] };
const kVaultKeyPollIntervalMs = 7000;
const kDefaultClaudeCliStatus = {
  ok: false,
  installed: false,
  loggedIn: false,
  configured: false,
};

const fetchClaudeCliStatusSafe = async () => {
  try {
    return await fetchClaudeCliStatus();
  } catch {
    return kDefaultClaudeCliStatus;
  }
};

export const useModels = (agentId) => {
  const isScoped = !!agentId;
  const normalizedAgentId = String(agentId || "").trim();
  const useCache = !isScoped;
  const [catalog, setCatalog] = useState(() => (useCache && kModelsTabCache?.catalog) || []);
  const [catalogStatus, setCatalogStatus] = useState(
    () =>
      (useCache && kModelsTabCache?.catalogStatus) || {
        source: "",
        fetchedAt: null,
        stale: false,
        refreshing: false,
      },
  );
  const [primary, setPrimary] = useState(() => (useCache && kModelsTabCache?.primary) || "");
  const [configuredModels, setConfiguredModels] = useState(
    () => (useCache && kModelsTabCache?.configuredModels) || {},
  );
  const [providerRuntimeIds, setProviderRuntimeIds] = useState(
    () => (useCache && kModelsTabCache?.providerRuntimeIds) || {},
  );
  const [modelRuntimeIds, setModelRuntimeIds] = useState(
    () => (useCache && kModelsTabCache?.modelRuntimeIds) || {},
  );
  const [authProfiles, setAuthProfiles] = useState(
    () => (useCache && kModelsTabCache?.authProfiles) || [],
  );
  const [authOrder, setAuthOrder] = useState(
    () => (useCache && kModelsTabCache?.authOrder) || {},
  );
  const [codexStatus, setCodexStatus] = useState(
    () => (useCache && kModelsTabCache?.codexStatus) || { connected: false },
  );
  const [claudeCliStatus, setClaudeCliStatus] = useState(
    () => (useCache && kModelsTabCache?.claudeCliStatus) || kDefaultClaudeCliStatus,
  );
  const [vaultBrokering, setVaultBrokering] = useState(
    () => (useCache && kModelsTabCache?.vaultBrokering) || kDefaultVaultBrokering,
  );
  const [vaultKeyPending, setVaultKeyPending] = useState({});
  const [loading, setLoading] = useState(() => !(useCache && kModelsTabCache));
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(() => !!(useCache && kModelsTabCache));
  const [error, setError] = useState("");

  const [profileEdits, setProfileEdits] = useState({});
  const [orderEdits, setOrderEdits] = useState({});

  const savedPrimaryRef = useRef(kModelsTabCache?.primary || "");
  const savedConfiguredRef = useRef(kModelsTabCache?.configuredModels || {});

  const updateCache = useCallback((patch) => {
    if (!isScoped) kModelsTabCache = { ...(kModelsTabCache || {}), ...patch };
  }, [isScoped]);
  const modelsConfigCacheKey = normalizedAgentId
    ? `/api/models/config?agentId=${encodeURIComponent(normalizedAgentId)}`
    : "/api/models/config";
  const catalogFetchState = useCachedFetch(kModelCatalogCacheKey, fetchModels, {
    maxAgeMs: 30000,
  });
  const configFetchState = useCachedFetch(
    modelsConfigCacheKey,
    () => fetchModelsConfig(isScoped ? { agentId } : undefined),
    { maxAgeMs: 30000 },
  );
  const codexFetchState = useCachedFetch("/api/codex/status", fetchCodexStatus, {
    maxAgeMs: 15000,
  });
  const catalogPoll = usePolling(fetchModels, kModelCatalogPollIntervalMs, {
    enabled: ready && isModelCatalogRefreshing(catalogStatus),
    pauseWhenHidden: true,
    cacheKey: kModelCatalogCacheKey,
  });

  const syncCatalogError = useCallback((catalogModels) => {
    setError((current) => {
      if (catalogModels.length > 0) {
        return current === kNoModelsFoundError ? "" : current;
      }
      return current || kNoModelsFoundError;
    });
  }, []);

  const applyCatalogResult = useCallback(
    (catalogResult) => {
      const catalogModels = getModelCatalogModels(catalogResult);
      const nextCatalogStatus = {
        source: String(catalogResult?.source || ""),
        fetchedAt: Number(catalogResult?.fetchedAt || 0) || null,
        stale: Boolean(catalogResult?.stale),
        refreshing: Boolean(catalogResult?.refreshing),
      };
      setCatalog(catalogModels);
      setCatalogStatus(nextCatalogStatus);
      updateCache({
        catalog: catalogModels,
        catalogStatus: nextCatalogStatus,
      });
      syncCatalogError(catalogModels);
      return catalogModels;
    },
    [syncCatalogError, updateCache],
  );

  const refresh = useCallback(async () => {
    if (!ready) setLoading(true);
    setError("");
    try {
      const [catalogResult, configResult, codex, claudeCli] = await Promise.all([
        catalogFetchState.refresh({ force: true }),
        configFetchState.refresh({ force: true }),
        codexFetchState.refresh({ force: true }),
        fetchClaudeCliStatusSafe(),
      ]);
      const catalogModels = applyCatalogResult(catalogResult);
      const p = configResult.primary || "";
      const cm = configResult.configuredModels || {};
      const pri = configResult.providerRuntimeIds || {};
      const mri = configResult.modelRuntimeIds || {};
      const ap = configResult.authProfiles || [];
      const ao = configResult.authOrder || {};
      const vb = configResult.vaultBrokering || kDefaultVaultBrokering;
      setPrimary(p);
      setConfiguredModels(cm);
      setProviderRuntimeIds(pri);
      setModelRuntimeIds(mri);
      setAuthProfiles(ap);
      setAuthOrder(ao);
      setVaultBrokering(vb);
      setCodexStatus(codex || { connected: false });
      setClaudeCliStatus(claudeCli || kDefaultClaudeCliStatus);
      setProfileEdits({});
      setOrderEdits({});
      savedPrimaryRef.current = p;
      savedConfiguredRef.current = cm;
      updateCache({
        catalog: catalogModels,
        primary: p,
        configuredModels: cm,
        providerRuntimeIds: pri,
        modelRuntimeIds: mri,
        authProfiles: ap,
        authOrder: ao,
        vaultBrokering: vb,
        codexStatus: codex || { connected: false },
        claudeCliStatus: claudeCli || kDefaultClaudeCliStatus,
      });
    } catch (err) {
      setError(kModelSettingsLoadError);
      showToast(`${kModelSettingsLoadError}: ${err.message}`, "error");
    } finally {
      setReady(true);
      setLoading(false);
    }
  }, [
    applyCatalogResult,
    catalogFetchState,
    codexFetchState,
    configFetchState,
    ready,
    updateCache,
  ]);

  useEffect(() => {
    refresh();
  }, [agentId]);

  useEffect(() => {
    if (!catalogPoll.data) return;
    applyCatalogResult(catalogPoll.data);
  }, [applyCatalogResult, catalogPoll.data]);

  const stableStringify = (obj) =>
    JSON.stringify(Object.keys(obj).sort().reduce((acc, k) => { acc[k] = obj[k]; return acc; }, {}));

  const modelConfigDirty =
    primary !== savedPrimaryRef.current ||
    stableStringify(configuredModels) !==
      stableStringify(savedConfiguredRef.current);

  const authDirty = (() => {
    const hasProfileChanges = Object.entries(profileEdits).some(
      ([id, cred]) => {
        const existing = authProfiles.find((p) => p.id === id);
        return getCredentialValue(cred) !== getCredentialValue(existing);
      },
    );
    const hasOrderChanges = Object.entries(orderEdits).some(
      ([provider, order]) => {
        const existing = authOrder[provider];
        return JSON.stringify(order) !== JSON.stringify(existing);
      },
    );
    return hasProfileChanges || hasOrderChanges;
  })();

  const isDirty = modelConfigDirty || authDirty;

  const persistModelConfig = useCallback(
    async ({ nextPrimary, nextConfiguredModels, successMessage }) => {
      if (saving) return { ok: false, error: "Save already in progress" };
      setSaving(true);
      try {
        const result = await saveModelsConfig({
          primary: nextPrimary,
          configuredModels: nextConfiguredModels,
          ...(isScoped ? { agentId } : {}),
        });
        if (!result.ok) {
          throw new Error(result.error || "Failed to save model config");
        }
        if (successMessage) showToast(successMessage, "success");
        if (result.syncWarning) {
          showToast(`Saved, but git-sync failed: ${result.syncWarning}`, "warning");
        }
        invalidateCache(kModelCatalogCacheKey);
        await refresh();
        return { ok: true };
      } catch (err) {
        await refresh();
        const message = err.message || "Failed to save model config";
        showToast(message, "error");
        return { ok: false, error: message };
      } finally {
        setSaving(false);
      }
    },
    [agentId, isScoped, refresh, saving],
  );

  const addModel = useCallback(
    async (modelKey, modelConfig = {}) => {
      if (!modelKey) return { ok: false, error: "Missing model key" };
      const nextConfigured = {
        ...configuredModels,
        [modelKey]: modelConfig || {},
      };
      const nextPrimary = primary || modelKey;
      const nextModelRuntimeIds = buildModelRuntimeIds(nextConfigured);
      setConfiguredModels(nextConfigured);
      setModelRuntimeIds(nextModelRuntimeIds);
      setPrimary(nextPrimary);
      updateCache({
        configuredModels: nextConfigured,
        modelRuntimeIds: nextModelRuntimeIds,
        primary: nextPrimary,
      });
      return persistModelConfig({
        nextPrimary,
        nextConfiguredModels: nextConfigured,
        successMessage: "Model added",
      });
    },
    [configuredModels, persistModelConfig, primary, updateCache],
  );

  const removeModel = useCallback(
    async (modelKey) => {
      const nextConfigured = { ...configuredModels };
      delete nextConfigured[modelKey];
      const remaining = Object.keys(nextConfigured);
      const nextPrimary = primary === modelKey ? remaining[0] || "" : primary;
      const nextModelRuntimeIds = buildModelRuntimeIds(nextConfigured);
      setConfiguredModels(nextConfigured);
      setModelRuntimeIds(nextModelRuntimeIds);
      setPrimary(nextPrimary);
      updateCache({
        configuredModels: nextConfigured,
        modelRuntimeIds: nextModelRuntimeIds,
        primary: nextPrimary,
      });
      return persistModelConfig({
        nextPrimary,
        nextConfiguredModels: nextConfigured,
        successMessage: "Model removed",
      });
    },
    [configuredModels, persistModelConfig, primary, updateCache],
  );

  const setPrimaryModel = useCallback(
    async (modelKey) => {
      if (!modelKey || modelKey === primary) return { ok: true };
      setPrimary(modelKey);
      updateCache({ primary: modelKey });
      return persistModelConfig({
        nextPrimary: modelKey,
        nextConfiguredModels: configuredModels,
        successMessage: "Primary model updated",
      });
    },
    [configuredModels, persistModelConfig, primary, updateCache],
  );

  const editProfile = useCallback(
    (profileId, credential) => {
      const existing = authProfiles.find((p) => p.id === profileId);
      if (getCredentialValue(credential) === getCredentialValue(existing)) {
        setProfileEdits((prev) => {
          const next = { ...prev };
          delete next[profileId];
          return next;
        });
        return;
      }
      setProfileEdits((prev) => ({ ...prev, [profileId]: credential }));
    },
    [authProfiles],
  );

  const editAuthOrder = useCallback(
    (provider, orderedIds) => {
      const existing = authOrder[provider] || null;
      if (JSON.stringify(orderedIds) === JSON.stringify(existing)) {
        setOrderEdits((prev) => {
          const next = { ...prev };
          delete next[provider];
          return next;
        });
        return;
      }
      setOrderEdits((prev) => ({ ...prev, [provider]: orderedIds }));
    },
    [authOrder],
  );

  const getProfileValue = useCallback(
    (profileId) => {
      if (profileEdits[profileId] !== undefined) return profileEdits[profileId];
      const existing = authProfiles.find((p) => p.id === profileId);
      return existing || null;
    },
    [profileEdits, authProfiles],
  );

  const getEffectiveOrder = useCallback(
    (provider) => {
      if (orderEdits[provider] !== undefined) return orderEdits[provider];
      return authOrder[provider] || null;
    },
    [orderEdits, authOrder],
  );

  const cancelChanges = useCallback(() => {
    const savedPrimary = savedPrimaryRef.current || "";
    const savedConfigured = savedConfiguredRef.current || {};
    setPrimary(savedPrimary);
    setConfiguredModels(savedConfigured);
    const savedModelRuntimeIds = buildModelRuntimeIds(savedConfigured);
    setModelRuntimeIds(savedModelRuntimeIds);
    setProfileEdits({});
    setOrderEdits({});
    updateCache({
      primary: savedPrimary,
      configuredModels: savedConfigured,
      modelRuntimeIds: savedModelRuntimeIds,
    });
  }, [updateCache]);

  const saveAll = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const changedProfiles = Object.entries(profileEdits)
        .filter(([id, cred]) => {
          const existing = authProfiles.find((p) => p.id === id);
          return getCredentialValue(cred) !== getCredentialValue(existing);
        })
        .map(([id, cred]) => ({ id, ...cred }));
      const credentialError = changedProfiles
        .map((profile) => {
          const field = (kProviderAuthFields[profile.provider] || [])[0] || null;
          return getAiCredentialFieldError(field, getCredentialValue(profile));
        })
        .find(Boolean);
      if (credentialError) {
        showToast(credentialError, "error");
        return;
      }

      const result = await saveModelsConfig({
        primary,
        configuredModels,
        profiles: changedProfiles.length > 0 ? changedProfiles : undefined,
        authOrder:
          Object.keys(orderEdits).length > 0 ? orderEdits : undefined,
        ...(isScoped ? { agentId } : {}),
      });
      if (!result.ok)
        throw new Error(result.error || "Failed to save config");
      showToast("Changes saved", "success");
      if (result.syncWarning) {
        showToast(`Saved, but git-sync failed: ${result.syncWarning}`, "warning");
      }
      invalidateCache(kModelCatalogCacheKey);
      await refresh();
    } catch (err) {
      showToast(err.message || "Failed to save changes", "error");
    } finally {
      setSaving(false);
    }
  }, [
    saving,
    primary,
    configuredModels,
    profileEdits,
    orderEdits,
    authProfiles,
    isScoped,
    agentId,
    refresh,
  ]);

  const clearVaultKeyPending = useCallback((provider) => {
    setVaultKeyPending((prev) => {
      if (!(provider in prev)) return prev;
      const next = { ...prev };
      delete next[provider];
      return next;
    });
  }, []);

  const requestVaultKey = useCallback(
    async (provider) => {
      try {
        const result = await requestModelVaultKey(
          provider,
          isScoped ? { agentId } : undefined,
        );
        if (result.status === "active") {
          clearVaultKeyPending(provider);
          showToast("Model key is now brokered by Agent Vault", "success");
          invalidateCache(kModelCatalogCacheKey);
          await refresh();
        } else if (result.status === "pending") {
          setVaultKeyPending((prev) => ({
            ...prev,
            [provider]: {
              proposal: result.proposal,
              credentialKey: result.credentialKey,
            },
          }));
          showToast("Agent Vault approval requested", "success");
        }
        return result;
      } catch (err) {
        const message = err.message || "Agent Vault request failed";
        showToast(message, "error");
        return { ok: false, error: message };
      }
    },
    [agentId, clearVaultKeyPending, isScoped, refresh],
  );

  // While an approval is pending, watch the proposal. Once it leaves
  // "pending", confirm the credential actually exists before re-requesting —
  // re-requesting after a decline would file a fresh proposal. The effect
  // keys on the pending provider set only and reads live state through refs:
  // depending on the callbacks themselves would reset the interval on every
  // app re-render, which happens more often than the poll fires.
  const vaultKeyPendingRef = useRef(vaultKeyPending);
  vaultKeyPendingRef.current = vaultKeyPending;
  const requestVaultKeyRef = useRef(null);
  requestVaultKeyRef.current = requestVaultKey;
  const vaultKeyPendingProvidersKey = Object.keys(vaultKeyPending)
    .sort()
    .join(",");
  useEffect(() => {
    if (!vaultKeyPendingProvidersKey) return undefined;
    let cancelled = false;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        for (const provider of vaultKeyPendingProvidersKey.split(",")) {
          const pending = vaultKeyPendingRef.current[provider];
          const proposalId = pending?.proposal?.id;
          if (!proposalId) continue;
          let proposalStatus = "";
          try {
            const payload = await fetchAgentVaultProposal(proposalId);
            proposalStatus = String(payload?.proposal?.status || "")
              .trim()
              .toLowerCase();
          } catch {
            continue;
          }
          if (cancelled || !proposalStatus || proposalStatus === "pending") {
            continue;
          }
          const available = await fetchAgentVaultCredentials().catch(
            () => null,
          );
          if (cancelled) return;
          const availableKeys = new Set(
            (available?.credentials || []).map((key) => String(key)),
          );
          if (availableKeys.has(String(pending.credentialKey || ""))) {
            await requestVaultKeyRef.current?.(provider);
          } else {
            clearVaultKeyPending(provider);
            showToast(
              `Agent Vault request for ${provider} was ${proposalStatus}`,
              "error",
            );
          }
        }
      } finally {
        polling = false;
      }
    }, kVaultKeyPollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [clearVaultKeyPending, vaultKeyPendingProvidersKey]);

  const refreshCodexStatus = useCallback(async () => {
    try {
      const codex = await fetchCodexStatus();
      setCodexStatus(codex || { connected: false });
      updateCache({ codexStatus: codex || { connected: false } });
    } catch {
      setCodexStatus({ connected: false });
      updateCache({ codexStatus: { connected: false } });
    }
  }, [updateCache]);

  const refreshClaudeCliStatus = useCallback(async () => {
    const status = await fetchClaudeCliStatusSafe();
    setClaudeCliStatus(status || kDefaultClaudeCliStatus);
    updateCache({ claudeCliStatus: status || kDefaultClaudeCliStatus });
    return status;
  }, [updateCache]);

  return {
    catalog,
    primary,
    configuredModels,
    authProfiles,
    authOrder,
    providerRuntimeIds,
    modelRuntimeIds,
    vaultBrokering,
    vaultKeyPending,
    requestVaultKey,
    codexStatus,
    claudeCliStatus,
    loading,
    saving,
    ready,
    error,
    isDirty,
    refresh,
    addModel,
    removeModel,
    setPrimaryModel,
    editProfile,
    editAuthOrder,
    getProfileValue,
    getEffectiveOrder,
    cancelChanges,
    saveAll,
    refreshCodexStatus,
    refreshClaudeCliStatus,
  };
};
