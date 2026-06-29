import { h } from "preact";
import { useMemo, useState } from "preact/hooks";
import htm from "htm";
import { PageHeader } from "../page-header.js";
import { LoadingSpinner } from "../loading-spinner.js";
import { ActionButton } from "../action-button.js";
import { PopActions } from "../pop-actions.js";
import { PaneShell } from "../pane-shell.js";
import { Badge } from "../badge.js";
import { useModels } from "./use-models.js";
import {
  buildSyntheticModelEntry,
  getModelsTabAuthProvider,
  getProviderSortIndex,
} from "./model-picker.js";
import { AddModelModal } from "./add-model-modal.js";
import { ProviderAuthCard } from "./provider-auth-card.js";
import {
  getModelProvider,
  kProviderLabels,
} from "../../lib/model-config.js";

const html = htm.bind(h);
const kCodexAuthMode = "codex";
const kClaudeCliAuthMode = "claude-cli";
const kApiKeyAuthMode = "api_key";

export const getRuntimeIdForModel = ({
  modelKey,
  providerRuntimeIds = {},
  modelRuntimeIds = {},
}) => {
  const modelRuntimeId = String(modelRuntimeIds[modelKey] || "").trim();
  if (modelRuntimeId) return modelRuntimeId;
  const provider = getModelProvider(modelKey);
  return String(providerRuntimeIds[provider] || "").trim();
};

export const getModelRuntimeInfo = ({
  modelKey,
  providerRuntimeIds = {},
  modelRuntimeIds = {},
}) => {
  const modelRuntimeId = String(modelRuntimeIds[modelKey] || "").trim();
  if (modelRuntimeId) {
    return {
      runtimeId: modelRuntimeId,
      source: "model",
      sourceLabel: "Model-level override",
    };
  }
  const provider = getModelProvider(modelKey);
  const providerRuntimeId = String(providerRuntimeIds[provider] || "").trim();
  if (providerRuntimeId) {
    return {
      runtimeId: providerRuntimeId,
      source: "provider",
      sourceLabel: "Provider-level default",
    };
  }
  if (provider === "openai-codex") {
    return {
      runtimeId: kCodexAuthMode,
      source: "provider",
      sourceLabel: "Provider route",
    };
  }
  if (provider === "claude-cli") {
    return {
      runtimeId: kClaudeCliAuthMode,
      source: "provider",
      sourceLabel: "Provider route",
    };
  }
  return {
    runtimeId: "openclaw",
    source: "default",
    sourceLabel: "OpenClaw default",
  };
};

export const getOpenAiAuthMode = ({
  configuredModels = {},
  providerRuntimeIds = {},
  modelRuntimeIds = {},
}) => {
  const openAiModelKeys = Object.keys(configuredModels).filter(
    (modelKey) => getModelsTabAuthProvider(modelKey) === "openai",
  );
  const usesCodexRuntime = openAiModelKeys.some((modelKey) => {
    if (getModelProvider(modelKey) === "openai-codex") return true;
    return (
      getRuntimeIdForModel({ modelKey, providerRuntimeIds, modelRuntimeIds }) ===
      kCodexAuthMode
    );
  });
  return usesCodexRuntime ? kCodexAuthMode : kApiKeyAuthMode;
};

export const getAnthropicAuthMode = ({
  configuredModels = {},
  providerRuntimeIds = {},
  modelRuntimeIds = {},
}) => {
  const anthropicModelKeys = Object.keys(configuredModels).filter(
    (modelKey) => getModelsTabAuthProvider(modelKey) === "anthropic",
  );
  const usesClaudeCliRuntime = anthropicModelKeys.some((modelKey) => {
    if (getModelProvider(modelKey) === "claude-cli") return true;
    return (
      getRuntimeIdForModel({ modelKey, providerRuntimeIds, modelRuntimeIds }) ===
      kClaudeCliAuthMode
    );
  });
  return usesClaudeCliRuntime ? kClaudeCliAuthMode : kApiKeyAuthMode;
};

export const getModelAuthRoute = ({
  modelKey,
  providerRuntimeIds = {},
  modelRuntimeIds = {},
}) => {
  const provider = getModelProvider(modelKey);
  const authProvider = getModelsTabAuthProvider(modelKey);
  const runtimeInfo = getModelRuntimeInfo({
    modelKey,
    providerRuntimeIds,
    modelRuntimeIds,
  });
  if (
    authProvider === "openai" &&
    (provider === "openai-codex" || runtimeInfo.runtimeId === kCodexAuthMode)
  ) {
    return {
      id: "openai:codex",
      provider: "openai",
      kind: "codex",
      authMode: kCodexAuthMode,
      label: "OpenAI Codex OAuth",
      shortLabel: "Codex OAuth",
    };
  }
  if (
    authProvider === "anthropic" &&
    (provider === "claude-cli" || runtimeInfo.runtimeId === kClaudeCliAuthMode)
  ) {
    return {
      id: "anthropic:claude-cli",
      provider: "anthropic",
      kind: "claude-cli",
      authMode: kClaudeCliAuthMode,
      label: "Claude CLI Subscription",
      shortLabel: "Claude CLI",
    };
  }
  const providerLabel = kProviderLabels[authProvider] || authProvider;
  return {
    id: `${authProvider}:api_key`,
    provider: authProvider,
    kind: "provider-api",
    authMode: authProvider === "openai" ? kApiKeyAuthMode : undefined,
    label: `${providerLabel} API Key`,
    shortLabel: `${providerLabel} API Key`,
  };
};

export const buildRequiredAuthRoutes = ({
  configuredModels = {},
  providerRuntimeIds = {},
  modelRuntimeIds = {},
}) => {
  const routes = [];
  const seen = new Set();
  for (const modelKey of Object.keys(configuredModels)) {
    const route = getModelAuthRoute({
      modelKey,
      providerRuntimeIds,
      modelRuntimeIds,
    });
    if (!route.provider || seen.has(route.id)) continue;
    seen.add(route.id);
    routes.push(route);
  }
  return routes;
};

const hasCredentialValue = (profile) =>
  !!String(profile?.key || profile?.token || profile?.access || "").trim();

export const getAuthRouteConnected = ({
  route,
  authProfiles = [],
  codexStatus = { connected: false },
  claudeCliStatus = null,
} = {}) => {
  if (!route?.id) return false;
  if (route.kind === "codex") return !!codexStatus?.connected;
  if (route.kind === "claude-cli") {
    const hasClaudeCliProfile = authProfiles.some(
      (profile) =>
        String(profile?.id || "") === "anthropic:claude-cli" ||
        String(profile?.provider || "") === "claude-cli",
    );
    return (
      !!claudeCliStatus?.loggedIn &&
      (!!claudeCliStatus?.configured || hasClaudeCliProfile)
    );
  }
  return authProfiles.some(
    (profile) =>
      String(profile?.provider || "") === String(route.provider || "") &&
      hasCredentialValue(profile),
  );
};

export const Models = ({ onRestartRequired = () => {}, agentId, embedded = false }) => {
  const [addModelOpen, setAddModelOpen] = useState(false);
  const {
    catalog,
    primary,
    configuredModels,
    providerRuntimeIds,
    modelRuntimeIds,
    authProfiles,
    authOrder,
    codexStatus,
    claudeCliStatus,
    loading,
    saving,
    ready,
    error,
    isDirty,
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
  } = useModels(agentId);
  const configuredKeys = useMemo(
    () => new Set(Object.keys(configuredModels)),
    [configuredModels],
  );

  const requiredAuthRoutes = useMemo(
    () =>
      buildRequiredAuthRoutes({
        configuredModels,
        providerRuntimeIds,
        modelRuntimeIds,
      }).sort((a, b) => {
        const providerCompare =
          getProviderSortIndex(a.provider) - getProviderSortIndex(b.provider);
        if (providerCompare !== 0) return providerCompare;
        return String(a.label || a.id).localeCompare(String(b.label || b.id));
      }),
    [configuredModels, providerRuntimeIds, modelRuntimeIds],
  );

  const authRouteConnected = useMemo(
    () =>
      Object.fromEntries(
        requiredAuthRoutes.map((route) => [
          route.id,
          getAuthRouteConnected({
            route,
            authProfiles,
            codexStatus,
            claudeCliStatus,
          }),
        ]),
      ),
    [authProfiles, codexStatus, claudeCliStatus, requiredAuthRoutes],
  );

  const configuredModelEntries = useMemo(
    () =>
      Object.keys(configuredModels).map((key) => {
        const catalogEntry =
          catalog.find((m) => m.key === key) || buildSyntheticModelEntry(key);
        const provider = getModelsTabAuthProvider(key);
        const runtimeInfo = getModelRuntimeInfo({
          modelKey: key,
          providerRuntimeIds,
          modelRuntimeIds,
        });
        const authRoute = getModelAuthRoute({
          modelKey: key,
          providerRuntimeIds,
          modelRuntimeIds,
        });
        const hasAuth = !!authRouteConnected[authRoute.id];
        return {
          key,
          label: catalogEntry?.label || key,
          provider: catalogEntry?.provider || provider,
          isPrimary: key === primary,
          runtimeInfo,
          authRoute,
          hasAuth,
        };
      }),
    [
      configuredModels,
      catalog,
      primary,
      providerRuntimeIds,
      modelRuntimeIds,
      authRouteConnected,
    ],
  );

  const headerActions = html`
    <${PopActions} visible=${isDirty}>
      <${ActionButton}
        onClick=${cancelChanges}
        disabled=${saving}
        tone="secondary"
        size="sm"
        idleLabel="Cancel"
        className="text-xs"
      />
      <${ActionButton}
        onClick=${saveAll}
        disabled=${saving}
        loading=${saving}
        loadingMode="inline"
        tone="primary"
        size="sm"
        idleLabel="Save changes"
        loadingLabel="Saving…"
        className="text-xs"
      />
    </${PopActions}>
  `;

  if (!ready) {
    const loadingBody = html`
      <div class="bg-surface border border-border rounded-xl p-4">
        <div class="flex items-center gap-2 text-sm text-fg-muted">
          <${LoadingSpinner} className="h-4 w-4" />
          Loading model settings...
        </div>
      </div>
    `;
    if (embedded) return loadingBody;
    return html`
      <${PaneShell}
        header=${html`<${PageHeader} title="Models" />`}
      >
        ${loadingBody}
      </${PaneShell}>
    `;
  }

  const bodyContent = html`
    <!-- Configured Models -->
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <h2 class="card-label">Configured Models</h2>

      ${configuredModelEntries.length === 0
        ? html`<p class="text-xs text-fg-muted">
            No models configured. Add a model below.
          </p>`
        : html`
            <div class="space-y-1">
              ${configuredModelEntries.map(
                (entry) => html`
                  <div
                    key=${entry.key}
                    class="flex items-start justify-between gap-3 py-2 px-2 rounded-lg hover:bg-surface"
                  >
                    <div class="min-w-0 space-y-1">
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="text-sm text-body truncate"
                          >${entry.label}</span
                        >
                        ${entry.isPrimary
                          ? html`<${Badge} tone="cyan">Primary</${Badge}>`
                          : null}
                        ${!entry.hasAuth
                          ? html`<${Badge} tone="warning">Needs auth</${Badge}>`
                          : null}
                      </div>
                      <p class="text-[11px] text-fg-dim truncate">
                        ${entry.authRoute.shortLabel} · Runtime:
                        ${entry.runtimeInfo.runtimeId}
                      </p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      ${!entry.isPrimary && entry.hasAuth
                        ? html`
                            <button
                              onclick=${(event) => {
                                event.stopPropagation();
                                setPrimaryModel(entry.key);
                              }}
                              class="text-xs px-2 py-0.5 rounded-full text-fg-muted hover:text-body hover:bg-surface"
                            >
                              Set primary
                            </button>
                          `
                        : null}
                      <button
                        onclick=${(event) => {
                          event.stopPropagation();
                          removeModel(entry.key);
                        }}
                        class="text-xs text-fg-dim hover:text-status-error-muted px-1"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                `,
              )}
            </div>
          `}

      <div class="space-y-2 border-t border-border pt-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-xs font-medium text-fg-muted">Add Model</p>
            <p class="text-[11px] text-fg-dim">
              Choose an access method before selecting a provider and model.
            </p>
          </div>
          <${ActionButton}
            onClick=${() => setAddModelOpen(true)}
            tone="secondary"
            size="sm"
            idleLabel="Add model"
            className="text-xs shrink-0"
          />
        </div>
      </div>

      ${loading
        ? html`<p class="text-xs text-fg-dim">
            Loading model catalog...
          </p>`
        : error
          ? html`<p class="text-xs text-fg-dim">${error}</p>`
          : null}
    </div>

    <!-- Authentication -->
    ${requiredAuthRoutes.length > 0
      ? html`
          <div class="space-y-3">
            <h2 class="font-semibold text-base">
              Authentication
            </h2>
            ${requiredAuthRoutes.map(
              (route) => html`
                <${ProviderAuthCard}
                  key=${route.id}
                  provider=${route.provider}
                  title=${route.label}
                  authProfiles=${authProfiles}
                  authOrder=${authOrder}
                  authMode=${route.authMode}
                  codexStatus=${codexStatus}
                  claudeCliStatus=${claudeCliStatus}
                  onEditProfile=${editProfile}
                  onEditAuthOrder=${editAuthOrder}
                  getProfileValue=${getProfileValue}
                  getEffectiveOrder=${getEffectiveOrder}
                  onRefreshCodex=${refreshCodexStatus}
                  onRefreshClaudeCli=${refreshClaudeCliStatus}
                />
              `,
            )}
          </div>
        `
      : null}
    <${AddModelModal}
      visible=${addModelOpen}
      catalog=${catalog}
      configuredKeys=${configuredKeys}
      onClose=${() => setAddModelOpen(false)}
      onAdd=${({ modelKey, modelConfig }) => {
        addModel(modelKey, modelConfig);
        if (!primary) setPrimaryModel(modelKey);
      }}
    />
  `;

  if (embedded) {
    return html`
      <div class="space-y-4">
        <div class="flex items-center justify-end gap-2">
          ${headerActions}
        </div>
        ${bodyContent}
      </div>
    `;
  }

  return html`
    <${PaneShell}
      header=${html`<${PageHeader} title="Models" actions=${headerActions} />`}
    >
      ${bodyContent}
    </${PaneShell}>
  `;
};
