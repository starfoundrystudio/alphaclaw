import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { SecretInput } from "../secret-input.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { getChannelMeta } from "../channels.js";
import {
  getOptionalToolCredentialVisibility,
} from "./welcome-config.js";
import { ModelSelect } from "./model-select.js";
import { getOnboardingModelDescription, kModelAccessModes } from "../../lib/model-config.js";

const html = htm.bind(h);
const kChannelAccordionDefs = [
  { id: "telegram", title: "Telegram", fieldKeys: ["TELEGRAM_BOT_TOKEN"] },
  { id: "discord", title: "Discord", fieldKeys: ["DISCORD_BOT_TOKEN"] },
  {
    id: "slack",
    title: "Slack",
    fieldKeys: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
  },
];

export const WelcomeFormStep = ({
  activeGroup,
  vals,
  hasAi,
  setValue,
  modelAccessMode,
  setModelAccessMode,
  accountLoginOptions,
  selectedAccountLoginProvider,
  setAccountLoginProvider,
  accountLoginNeedsSetup,
  modelOptions,
  recommendedModels,
  selectedModelIsRecommended,
  modelsLoading,
  modelsError,
  canToggleFullCatalog,
  showAllModels,
  setShowAllModels,
  selectedProvider,
  codexLoading,
  codexStatus,
  startCodexAuth,
  handleCodexDisconnect,
  codexAuthStarted,
  codexAuthWaiting,
  codexManualInput,
  setCodexManualInput,
  claudeCliStatus,
  claudeCliLoading,
  claudeCliActionLoading,
  claudeCliLoginOutput,
  claudeCliLoginState,
  claudeCliError,
  refreshClaudeCliStatus,
  startClaudeCliAuth,
  adoptClaudeCliAuth,
  tailscaleApiToken,
  setTailscaleApiToken,
  completeCodexAuth,
  codexExchanging,
  visibleAiFieldKeys,
  error,
  step,
  totalGroups,
  goBack,
  goNext,
  loading,
  handleSubmit,
}) => {
  const [showOptionalOpenai, setShowOptionalOpenai] = useState(false);
  const [showOptionalGemini, setShowOptionalGemini] = useState(false);
  const [expandedChannels, setExpandedChannels] = useState(() => new Set(["telegram"]));
  const canChooseCodexRuntime =
    modelAccessMode === "subscription" &&
    (selectedProvider === "openai" || selectedProvider === "openai-codex");
  const canChooseClaudeCliRuntime =
    modelAccessMode === "subscription" && selectedProvider === "claude-cli";
  const isToolsGroup = activeGroup.id === "tools";

  useEffect(() => {
    if (!isToolsGroup) return;
    const visibility = getOptionalToolCredentialVisibility(activeGroup.id, vals);
    setShowOptionalOpenai(visibility.openai);
    setShowOptionalGemini(visibility.gemini);
  }, [isToolsGroup]);
  useEffect(() => {
    if (activeGroup.id !== "channels") return;
    setExpandedChannels((current) => {
      if (current.size > 0) return current;
      return new Set(["telegram"]);
    });
  }, [activeGroup.id]);

  const renderStandardField = (field) => html`
    <div class="space-y-1" key=${field.key}>
      <label class="text-xs font-medium text-fg-muted">${field.label}</label>
      <${SecretInput}
        key=${field.key}
        value=${vals[field.key] || ""}
        onInput=${(e) => setValue(field.key, e.target.value)}
        placeholder=${field.placeholder || ""}
        isSecret=${!field.isText}
        inputClass="flex-1 bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted font-mono"
      />
      <p class="text-xs text-fg-dim">
        ${field.hint}
      </p>
    </div>
  `;
  const renderAccessModeCards = () => html`
    <div class="space-y-2">
      <p class="text-xs font-medium text-fg-muted">
        How will you access your primary model?
      </p>
      <div class="grid gap-2 md:grid-cols-3">
        ${kModelAccessModes.map((mode) => {
          const selected = mode.id === modelAccessMode;
          return html`
            <button
              key=${mode.id}
              type="button"
              aria-pressed=${selected ? "true" : "false"}
              onclick=${() => setModelAccessMode(mode.id)}
              class=${`min-h-[92px] rounded-lg border px-3 py-2 text-left transition-colors ${
                selected
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
  `;
  const renderAccountLoginCards = () =>
    modelAccessMode === "subscription"
      ? html`
          <div class="space-y-2">
            <p class="text-xs font-medium text-fg-muted">
              Which subscription will you use?
            </p>
            <div class="grid gap-2 sm:grid-cols-2">
              ${(accountLoginOptions || []).map((option) => {
                const selected = option.id === selectedAccountLoginProvider;
                return html`
                  <button
                    key=${option.id}
                    type="button"
                    aria-pressed=${selected ? "true" : "false"}
                    onclick=${() => setAccountLoginProvider(option.id)}
                    class=${`min-h-[82px] flex flex-col items-stretch justify-start rounded-lg border px-3 py-2 text-left transition-colors ${
                      selected
                        ? "border-status-info-border bg-status-info-bg text-body"
                        : "border-border bg-field text-body hover:border-fg-muted hover:bg-surface"
                    }`}
                  >
                    <span class="flex items-center justify-between gap-2">
                      <span class="text-xs font-semibold leading-4">
                        ${option.label}
                      </span>
                      <span
                        class=${`shrink-0 text-[10px] font-medium rounded-full px-1.5 py-0.5 ${
                          option.setupReady
                            ? "bg-status-success-bg text-status-success"
                            : "bg-status-warning-bg text-status-warning-muted"
                        }`}
                      >
                        ${option.setupReady ? "Available now" : "Needs setup flow"}
                      </span>
                    </span>
                    <span class="mt-1 block text-[11px] leading-4 text-fg-muted">
                      ${option.description}
                    </span>
                    <span class="mt-1 block text-[10px] leading-3 text-fg-dim">
                      ${option.modelCount} ${option.modelCount === 1 ? "model" : "models"}
                    </span>
                  </button>
                `;
              })}
            </div>
          </div>
        `
      : null;
  const fieldLookup = new Map((activeGroup.fields || []).map((field) => [field.key, field]));
  const selectedModelOption = modelOptions.find(
    (model) => model?.key === vals.MODEL_KEY,
  );
  const selectedModelDescription = selectedModelOption
    ? getOnboardingModelDescription(selectedModelOption)
    : "This account login";
  const toggleChannelSection = (channelId) =>
    setExpandedChannels((current) => {
      const next = new Set(current);
      if (next.has(channelId)) {
        next.delete(channelId);
      } else {
        next.add(channelId);
      }
      return next;
    });
  const renderChannelAccordion = () =>
    html`<div class="space-y-2">
      ${kChannelAccordionDefs.map((section) => {
        const isExpanded = expandedChannels.has(section.id);
        const sectionFields = section.fieldKeys
          .map((fieldKey) => fieldLookup.get(fieldKey))
          .filter(Boolean);
        const channelMeta = getChannelMeta(section.id);
        const hasValue = section.fieldKeys.some((fieldKey) =>
          String(vals[fieldKey] || "").trim(),
        );
        return html`
          <div class="bg-field border border-border rounded-lg overflow-hidden">
            <button
              type="button"
              onclick=${() => toggleChannelSection(section.id)}
              class="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface"
            >
              <span class="inline-flex items-center gap-2 min-w-0">
                ${channelMeta.iconSrc
                  ? html`<img
                      src=${channelMeta.iconSrc}
                      alt=""
                      class="w-4 h-4 rounded-sm"
                      aria-hidden="true"
                    />`
                  : null}
                <span class="text-sm text-body">${section.title}</span>
                ${hasValue
                  ? html`<${Badge} tone="success">Configured</${Badge}>`
                  : null}
              </span>
              <span
                class=${`ac-history-toggle shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                aria-hidden="true"
                >▸</span
              >
            </button>
            ${isExpanded
              ? html`
                  <div class="px-3 pb-3 pt-2 space-y-2 border-t border-border">
                    ${sectionFields.map((field) => renderStandardField(field))}
                  </div>
                `
              : null}
          </div>
        `;
      })}
    </div>`;
  const renderClaudeCliPanel = () =>
    canChooseClaudeCliRuntime
      ? html`
          <div class="bg-field border border-border rounded-lg p-3 space-y-3">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs text-fg-muted">Claude CLI</span>
              ${claudeCliLoading
                ? html`<span class="text-xs text-fg-muted">Checking...</span>`
                : claudeCliStatus?.configured
                  ? html`<${Badge} tone="success">Connected</${Badge}>`
                  : claudeCliStatus?.loggedIn
                    ? html`<${Badge} tone="warning">Ready to use</${Badge}>`
                    : html`<${Badge} tone="warning">Not connected</${Badge}>`}
            </div>
            <div class="grid gap-2 text-xs sm:grid-cols-3">
              <div>
                <p class="text-fg-dim">CLI</p>
                <p class="text-body">
                  ${claudeCliStatus?.installed ? "Installed" : "Not found"}
                </p>
              </div>
              <div>
                <p class="text-fg-dim">Account</p>
                <p class="text-body">
                  ${claudeCliStatus?.loggedIn
                    ? claudeCliStatus?.email || "Logged in"
                    : "Login needed"}
                </p>
              </div>
              <div>
                <p class="text-fg-dim">OpenClaw</p>
                <p class="text-body">
                  ${claudeCliStatus?.configured ? "Configured" : "Not configured"}
                </p>
              </div>
            </div>
            ${claudeCliStatus?.version
              ? html`
                  <p class="text-[11px] text-fg-dim font-mono">
                    ${claudeCliStatus.version}
                  </p>
                `
              : null}
            <div class="flex flex-wrap gap-2">
              <${ActionButton}
                onClick=${() => refreshClaudeCliStatus()}
                loading=${claudeCliLoading}
                disabled=${claudeCliLoading || claudeCliActionLoading}
                tone="neutral"
                size="sm"
                idleLabel="Check status"
                loadingLabel="Checking..."
                className="font-medium"
              />
              ${!claudeCliStatus?.loggedIn
                ? html`
                    <${ActionButton}
                      onClick=${startClaudeCliAuth}
                      loading=${claudeCliActionLoading}
                      disabled=${claudeCliActionLoading || claudeCliLoading}
                      tone="primary"
                      size="sm"
                      idleLabel="Start Claude login"
                      loadingLabel="Starting..."
                      className="font-medium"
                    />
                  `
                : !claudeCliStatus?.configured
                  ? html`
                      <${ActionButton}
                        onClick=${adoptClaudeCliAuth}
                        loading=${claudeCliActionLoading}
                        disabled=${claudeCliActionLoading || claudeCliLoading}
                        tone="primary"
                        size="sm"
                        idleLabel="Use Claude CLI"
                        loadingLabel="Configuring..."
                        className="font-medium"
                      />
                    `
                  : null}
            </div>
            ${!claudeCliStatus?.installed
              ? html`
                  <p class="text-xs text-status-warning-muted">
                    Claude CLI was not found on PATH for this AlphaClaw process.
                  </p>
                `
              : null}
            ${claudeCliError
              ? html`
                  <p class="text-xs text-status-error">
                    ${claudeCliError}
                  </p>
                `
              : null}
            ${claudeCliLoginOutput
              ? html`
                  <pre
                    class="max-h-32 overflow-auto rounded-lg border border-border bg-surface px-3 py-2 text-[11px] leading-4 text-fg-muted whitespace-pre-wrap"
                  >${claudeCliLoginOutput}</pre>
                  <p class="text-[11px] text-fg-dim">
                    Login status: ${claudeCliLoginState || "running"}
                  </p>
                `
              : null}
          </div>
        `
      : null;

  return html`
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-sm font-medium text-body">${activeGroup.title}</h2>
        <p class="text-xs text-fg-muted">${activeGroup.description}</p>
      </div>
      ${activeGroup.validate(vals, { hasAi, tailscaleApiToken })
        ? html`<span
            class="text-xs font-medium px-2 py-0.5 rounded-full bg-status-success-bg text-status-success"
            >✓</span
          >`
        : activeGroup.id !== "tools"
          ? html`<span
              class="text-xs font-medium px-2 py-0.5 rounded-full bg-status-warning-bg text-status-warning-muted"
              >Required</span
            >`
          : null}
    </div>

    ${activeGroup.id === "ai" &&
    html`
      ${renderAccessModeCards()}
      ${renderAccountLoginCards()}
      <div class="space-y-1">
        <label class="text-xs font-medium text-fg-muted">Model</label>
        <${ModelSelect}
          value=${vals.MODEL_KEY || ""}
          models=${modelOptions}
          recommendedModels=${recommendedModels}
          showAllModels=${showAllModels}
          onChange=${(nextModelKey) => setValue("MODEL_KEY", nextModelKey)}
        />
        <p class="text-xs text-fg-dim">
          ${modelsLoading
            ? "Loading model catalog..."
            : modelsError
              ? modelsError
              : showAllModels
                ? modelAccessMode === "subscription"
                  ? "Search every model for the selected account login."
                  : "Search every model that fits the selected access method."
                : modelAccessMode === "gateway"
                  ? "We recommend GPT-5.5 through a gateway when you want routing flexibility."
                : modelAccessMode === "subscription"
                  ? accountLoginNeedsSetup
                    ? "Choose from the models available through this account login route."
                    : selectedProvider === "claude-cli"
                      ? "We recommend Opus or Sonnet when using Claude CLI."
                      : "We recommend OpenAI Codex OAuth for account-based setup."
                  : "We recommend Opus, Sonnet, or GPT-5.5 for the primary agent."}
        </p>
        ${canToggleFullCatalog &&
        html`
          <button
            type="button"
            onclick=${() => setShowAllModels((prev) => !prev)}
            class="text-xs text-fg-muted hover:text-body"
          >
            ${showAllModels
              ? "Show recommended models"
              : "See all model options"}
          </button>
        `}
        ${vals.MODEL_KEY &&
        selectedModelIsRecommended === false &&
        html`
          <p class="text-xs text-status-warning-muted">
            This model is available, but we recommend starting with one of the
            models shown in the recommended view.
          </p>
        `}
        ${accountLoginNeedsSetup &&
        html`
          <div class="bg-status-warning-bg border border-status-warning-border rounded-lg p-3 space-y-1">
            <p class="text-xs font-medium text-status-warning-muted">
              Additional setup support needed
            </p>
            <p class="text-xs text-fg-muted">
              ${selectedModelDescription} is supported by OpenClaw, but this
              setup screen does not yet include the provider-specific sign-in
              flow needed to finish onboarding with it.
            </p>
          </div>
        `}
      </div>
    `}
    ${activeGroup.id === "ai" && renderClaudeCliPanel()}
    ${activeGroup.id === "ai" &&
    canChooseCodexRuntime &&
    html`
      <div class="bg-field border border-border rounded-lg p-3 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs text-fg-muted">Codex OAuth</span>
          ${codexLoading
            ? html`<span class="text-xs text-fg-muted">Checking...</span>`
            : codexStatus.connected
              ? html`<${Badge} tone="success">Connected</${Badge}>`
              : html`<${Badge} tone="warning">Not connected</${Badge}>`}
        </div>
        <div class="flex gap-2">
          <${ActionButton}
            onClick=${startCodexAuth}
            tone=${codexStatus.connected || codexAuthStarted
              ? "neutral"
              : "primary"}
            size="sm"
            idleLabel=${codexStatus.connected
              ? "Reconnect Codex"
              : "Connect Codex OAuth"}
            className="font-medium"
          />
          ${codexStatus.connected &&
          html`
            <${ActionButton}
              onClick=${handleCodexDisconnect}
              tone="ghost"
              size="sm"
              idleLabel="Disconnect"
              className="font-medium"
            />
          `}
        </div>
        ${canChooseCodexRuntime &&
        codexStatus.connected &&
        html`
          <div class="space-y-2 pt-1">
            <p class="text-xs text-fg-dim">
              OpenAI models will use Codex OAuth through the Codex runtime. You
              can still switch to Anthropic, Gemini, OpenRouter, and other
              providers later when their credentials are configured.
            </p>
          </div>
        `}
        ${codexAuthStarted &&
        html`
          <div class="space-y-1 pt-1">
            <p class="text-xs text-fg-muted">
              ${codexAuthWaiting
                ? "Complete login in the popup. AlphaClaw should finish automatically, but if it doesn't, paste the full redirect URL from the address bar (starts with "
                : "Paste the full redirect URL from the address bar (starts with "}
              <code class="text-xs bg-field px-1 rounded"
                >http://localhost:1455/auth/callback</code
              >) ${codexAuthWaiting ? " to finish setup." : " to finish setup."}
            </p>
            <input
              type="text"
              value=${codexManualInput}
              onInput=${(e) => setCodexManualInput(e.target.value)}
              placeholder="http://localhost:1455/auth/callback?code=...&state=..."
              class="w-full bg-field border border-border rounded-lg px-3 py-2 text-xs text-body outline-none focus:border-fg-muted"
            />
            <${ActionButton}
              onClick=${completeCodexAuth}
              disabled=${!codexManualInput.trim() || codexExchanging}
              loading=${codexExchanging}
              tone="primary"
              size="sm"
              idleLabel="Complete Codex OAuth"
              loadingLabel="Completing..."
              className="font-medium"
            />
          </div>
        `}
      </div>
    `}
    ${activeGroup.id === "tailscale" &&
    html`
      <div class="bg-field border border-border rounded-lg p-3 space-y-1">
        <p class="text-xs font-medium text-body">Required</p>
        <p class="text-xs text-fg-dim">
          AlphaClaw uses this token once to configure tailnet policy, join this
          host, enable Serve/Funnel, and share the machine with TeamYou ops.
        </p>
      </div>
      <div class="space-y-1">
        <label class="text-xs font-medium text-fg-muted"
          >Tailscale API access token</label
        >
        <${SecretInput}
          value=${tailscaleApiToken || ""}
          onInput=${(e) => setTailscaleApiToken(e.target.value)}
          placeholder="tskey-api-..."
          isSecret=${true}
          inputClass="flex-1 bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted font-mono"
        />
        <p class="text-xs text-fg-dim">
          Generate a 1-day API token from the${" "}<a
            href="https://login.tailscale.com/admin/settings/keys"
            target="_blank"
            rel="noreferrer"
            class="ac-tip-link"
            >Tailscale Keys page</a
          >. The token is submitted only with final setup.
        </p>
      </div>
    `}
    ${activeGroup.id === "tailscale"
      ? null
      : activeGroup.id === "channels"
      ? html`
          <div class="bg-field border border-border rounded-lg p-3 space-y-1">
            <p class="text-xs font-medium text-body">Optional</p>
            <p class="text-xs text-fg-dim">
              Add Telegram, Discord, or Slack now if you want to finish pairing
              during setup. You can also leave this blank and connect channels
              later from the dashboard.
            </p>
          </div>
          ${renderChannelAccordion()}
        `
      : (activeGroup.id === "ai"
          ? activeGroup.fields.filter((field) =>
              visibleAiFieldKeys.has(field.key),
            )
          : activeGroup.fields
        ).map((field) => renderStandardField(field))}
    ${error
      ? html`<div
          class="bg-status-error-bg border border-status-error-border rounded-xl p-3 text-status-error text-sm"
        >
          ${error}
        </div>`
      : null}
    ${isToolsGroup && (showOptionalOpenai || showOptionalGemini)
      ? html`
          ${showOptionalOpenai
            ? html`<div class="space-y-1">
                <label class="text-xs font-medium text-fg-muted"
                  >OpenAI API Key</label
                >
                <${SecretInput}
                  value=${vals.OPENAI_API_KEY || ""}
                  onInput=${(e) => setValue("OPENAI_API_KEY", e.target.value)}
                  placeholder="sk-..."
                  isSecret=${true}
                  inputClass="flex-1 bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted font-mono"
                />
                <p class="text-xs text-fg-dim">
                  Used for memory embeddings -${" "}
                  <a
                    href="https://platform.openai.com"
                    target="_blank"
                    class="hover:underline"
                    style="color: var(--accent-link)"
                    >get key</a
                  >
                </p>
              </div>`
            : null}
          ${showOptionalGemini
            ? html`<div class="space-y-1">
                <label class="text-xs font-medium text-fg-muted"
                  >Gemini API Key</label
                >
                <${SecretInput}
                  value=${vals.GEMINI_API_KEY || ""}
                  onInput=${(e) => setValue("GEMINI_API_KEY", e.target.value)}
                  placeholder="AI..."
                  isSecret=${true}
                  inputClass="flex-1 bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted font-mono"
                />
                <p class="text-xs text-fg-dim">
                  Used for memory embeddings and Nano Banana -${" "}
                  <a
                    href="https://aistudio.google.com"
                    target="_blank"
                    class="hover:underline"
                    style="color: var(--accent-link)"
                    >get key</a
                  >
                </p>
              </div>`
            : null}
        `
      : null}

    <div class="grid grid-cols-2 gap-2 pt-3">
      ${step < totalGroups - 1
        ? html`
            ${step > 0
              ? html`<${ActionButton}
                  onClick=${goBack}
                  tone="secondary"
                  size="md"
                  idleLabel="Back"
                  className="w-full"
                />`
              : html`<div class="w-full"></div>`}
            <${ActionButton}
              onClick=${goNext}
              loading=${false}
              tone="primary"
              size="md"
              idleLabel="Next"
              loadingLabel="Checking..."
              className="w-full"
            />
          `
        : html`
            ${step > 0
              ? html`<${ActionButton}
                  onClick=${goBack}
                  tone="secondary"
                  size="md"
                  idleLabel="Back"
                  className="w-full"
                />`
              : html`<div class="w-full"></div>`}
            <${ActionButton}
              onClick=${handleSubmit}
              loading=${loading}
              tone="primary"
              size="md"
              idleLabel="Next"
              loadingLabel="Starting..."
              className="w-full"
            />
          `}
    </div>
  `;
};
