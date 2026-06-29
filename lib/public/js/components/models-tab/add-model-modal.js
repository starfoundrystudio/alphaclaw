import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import {
  getAnthropicModelKeyForClaudeCliRuntimeModel,
  getInitialModelKeyForAccessModeProvider,
  getOnboardingModelLabel,
  getOnboardingModelsForAccessModeProvider,
  getOpenAiModelKeyForCodexRuntimeModel,
  getProviderOptionsForAccessMode,
  kModelAccessModes,
  normalizeModelAccessMode,
  normalizeProviderForAccessMode,
} from "../../lib/model-config.js";

const html = htm.bind(h);

const getDefaultProvider = ({ models = [], accessMode = "" } = {}) => {
  const options = getProviderOptionsForAccessMode({ models, accessMode });
  if (accessMode === "subscription") {
    return options.find((option) => option.id === "openai")?.id || options[0]?.id || "";
  }
  if (accessMode === "gateway") {
    return (
      options.find((option) => option.id === "vercel-ai-gateway")?.id ||
      options.find((option) => option.id === "openrouter")?.id ||
      options[0]?.id ||
      ""
    );
  }
  return (
    options.find((option) => option.id === "anthropic")?.id ||
    options.find((option) => option.id === "openai")?.id ||
    options[0]?.id ||
    ""
  );
};

const getConfiguredModelKey = ({ modelKey = "", accessMode = "", provider = "", catalog = [] } = {}) => {
  if (accessMode === "subscription" && provider === "openai") {
    return getOpenAiModelKeyForCodexRuntimeModel(modelKey, catalog);
  }
  if (accessMode === "subscription" && provider === "claude-cli") {
    return getAnthropicModelKeyForClaudeCliRuntimeModel(modelKey);
  }
  return String(modelKey || "").trim();
};

const getConfiguredModelValue = ({ accessMode = "", provider = "" } = {}) => {
  if (accessMode === "subscription" && provider === "openai") {
    return { agentRuntime: { id: "codex" } };
  }
  if (accessMode === "subscription" && provider === "claude-cli") {
    return { agentRuntime: { id: "claude-cli" } };
  }
  return {};
};

export const buildAddModelSelection = ({
  modelKey = "",
  accessMode = "",
  provider = "",
  catalog = [],
} = {}) => {
  const normalizedMode = normalizeModelAccessMode(accessMode);
  const normalizedProvider = String(provider || "").trim();
  const configuredModelKey = getConfiguredModelKey({
    modelKey,
    accessMode: normalizedMode,
    provider: normalizedProvider,
    catalog,
  });
  return {
    modelKey: configuredModelKey,
    modelConfig: getConfiguredModelValue({
      accessMode: normalizedMode,
      provider: normalizedProvider,
    }),
  };
};

export const AddModelModal = ({
  visible = false,
  catalog = [],
  configuredKeys = new Set(),
  onClose = () => {},
  onAdd = () => {},
}) => {
  const [accessMode, setAccessMode] = useState("subscription");
  const [provider, setProvider] = useState("");
  const [modelKey, setModelKey] = useState("");

  const providerOptions = useMemo(
    () => getProviderOptionsForAccessMode({ models: catalog, accessMode }),
    [catalog, accessMode],
  );
  const modelOptions = useMemo(
    () =>
      getOnboardingModelsForAccessModeProvider({
        models: catalog,
        accessMode,
        provider,
      }),
    [accessMode, catalog, provider],
  );
  const selected = useMemo(
    () =>
      buildAddModelSelection({
        modelKey,
        accessMode,
        provider,
        catalog,
      }),
    [accessMode, catalog, modelKey, provider],
  );
  const selectedAlreadyConfigured = configuredKeys.has(selected.modelKey);

  useEffect(() => {
    if (!visible) return;
    const nextMode = normalizeModelAccessMode(accessMode) || "subscription";
    const normalizedProvider =
      normalizeProviderForAccessMode({
        provider,
        models: catalog,
        accessMode: nextMode,
      }) ||
      getDefaultProvider({ models: catalog, accessMode: nextMode });
    const nextModelKey = getInitialModelKeyForAccessModeProvider({
      models: catalog,
      accessMode: nextMode,
      provider: normalizedProvider,
    });
    setAccessMode(nextMode);
    setProvider(normalizedProvider);
    setModelKey((current) =>
      modelOptions.some((model) => model.key === current) ? current : nextModelKey,
    );
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, visible]);

  useEffect(() => {
    if (!visible) return;
    const normalizedProvider =
      normalizeProviderForAccessMode({
        provider,
        models: catalog,
        accessMode,
      }) || getDefaultProvider({ models: catalog, accessMode });
    if (normalizedProvider !== provider) {
      setProvider(normalizedProvider);
      return;
    }
    if (!modelOptions.some((model) => model.key === modelKey)) {
      setModelKey(
        getInitialModelKeyForAccessModeProvider({
          models: catalog,
          accessMode,
          provider: normalizedProvider,
        }),
      );
    }
  }, [accessMode, catalog, modelKey, modelOptions, provider, visible]);

  if (!visible) return null;

  const handleAccessModeSelect = (nextMode) => {
    const normalizedMode = normalizeModelAccessMode(nextMode) || "subscription";
    const nextProvider = getDefaultProvider({
      models: catalog,
      accessMode: normalizedMode,
    });
    setAccessMode(normalizedMode);
    setProvider(nextProvider);
    setModelKey(
      getInitialModelKeyForAccessModeProvider({
        models: catalog,
        accessMode: normalizedMode,
        provider: nextProvider,
      }),
    );
  };

  const handleProviderChange = (event) => {
    const nextProvider = String(event.target.value || "").trim();
    setProvider(nextProvider);
    setModelKey(
      getInitialModelKeyForAccessModeProvider({
        models: catalog,
        accessMode,
        provider: nextProvider,
      }),
    );
  };

  const handleAdd = () => {
    if (!selected.modelKey || selectedAlreadyConfigured) return;
    onAdd(selected);
    onClose();
  };

  return html`
    <div
      class="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
      onClick=${onClose}
    >
      <div
        class="bg-modal border border-border rounded-xl p-5 w-full max-w-2xl max-h-[86vh] overflow-auto space-y-4"
        onClick=${(event) => event.stopPropagation()}
      >
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="text-base font-semibold text-body">Add Model</h2>
            <p class="text-xs text-fg-muted">
              Choose how this model will be accessed.
            </p>
          </div>
          <button
            type="button"
            onClick=${onClose}
            class="text-sm text-fg-muted hover:text-body"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div class="space-y-2">
          <p class="text-xs font-medium text-fg-muted">Access Method</p>
          <div class="grid gap-2 md:grid-cols-3">
            ${kModelAccessModes.map((mode) => {
              const selectedMode = mode.id === accessMode;
              return html`
                <button
                  key=${mode.id}
                  type="button"
                  aria-pressed=${selectedMode ? "true" : "false"}
                  onClick=${() => handleAccessModeSelect(mode.id)}
                  class=${`min-h-[86px] rounded-lg border px-3 py-2 text-left transition-colors ${
                    selectedMode
                      ? "border-status-info-border bg-status-info-bg text-body"
                      : "border-border bg-field text-body hover:border-fg-muted hover:bg-surface"
                  }`}
                >
                  <span class="block text-xs font-semibold leading-4">
                    ${mode.shortLabel || mode.label}
                  </span>
                  <span class="mt-1 block text-[11px] leading-4 text-fg-muted">
                    ${mode.description}
                  </span>
                </button>
              `;
            })}
          </div>
        </div>

        ${accessMode === "subscription"
          ? html`
              <div class="space-y-2">
                <p class="text-xs font-medium text-fg-muted">
                  Which subscription will you use?
                </p>
                <div class="grid gap-2 md:grid-cols-2">
                  ${providerOptions.map((option) => {
                    const selectedProvider = option.id === provider;
                    return html`
                      <button
                        key=${option.id}
                        type="button"
                        aria-pressed=${selectedProvider ? "true" : "false"}
                        onClick=${() =>
                          handleProviderChange({
                            target: { value: option.id },
                          })}
                        class=${`min-h-[78px] rounded-lg border px-3 py-2 text-left transition-colors ${
                          selectedProvider
                            ? "border-status-info-border bg-status-info-bg text-body"
                            : "border-border bg-field text-body hover:border-fg-muted hover:bg-surface"
                        }`}
                      >
                        <span class="block text-xs font-semibold leading-4">
                          ${option.label}
                        </span>
                        <span class="mt-1 block text-[11px] leading-4 text-fg-muted">
                          ${option.description}
                        </span>
                      </button>
                    `;
                  })}
                </div>
              </div>
            `
          : html`
              <div class="space-y-1">
                <label class="text-xs font-medium text-fg-muted">
                  ${accessMode === "gateway" ? "Gateway" : "Provider"}
                </label>
                <select
                  value=${provider}
                  onChange=${handleProviderChange}
                  class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted"
                >
                  ${providerOptions.map(
                    (option) => html`
                      <option key=${option.id} value=${option.id}>
                        ${option.label}
                      </option>
                    `,
                  )}
                </select>
              </div>
            `}

        <div class="space-y-1">
            <label class="text-xs font-medium text-fg-muted">Model</label>
            <select
              value=${modelKey}
              onChange=${(event) => setModelKey(event.target.value)}
              class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted"
            >
              ${modelOptions.map(
                (model) => html`
                  <option key=${model.key} value=${model.key}>
                    ${getOnboardingModelLabel(model, modelOptions)}
                  </option>
                `,
              )}
            </select>
        </div>

        ${selectedAlreadyConfigured
          ? html`
              <p class="text-xs text-status-warning-muted">
                This model is already configured.
              </p>
            `
          : null}

        <div class="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <${ActionButton}
            onClick=${onClose}
            tone="secondary"
            size="sm"
            idleLabel="Cancel"
            className="text-xs"
          />
          <${ActionButton}
            onClick=${handleAdd}
            disabled=${!selected.modelKey || selectedAlreadyConfigured}
            tone="primary"
            size="sm"
            idleLabel="Add model"
            className="text-xs"
          />
        </div>
      </div>
    </div>
  `;
};
