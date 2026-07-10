import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { SecretInput } from "../secret-input.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { getChannelMeta } from "../channels.js";
import { DownloadLineIcon } from "../icons.js";
import {
  getOptionalToolCredentialVisibility,
} from "./welcome-config.js";
import { ModelSelect } from "./model-select.js";
import { ProviderSelect } from "./provider-select.js";
import {
  getOnboardingModelDescription,
  kModelAccessModes,
} from "../../lib/model-config.js";

const html = htm.bind(h);
const kTailscaleDownloadUrls = {
  android: "https://tailscale.com/download/android",
  ios: "https://tailscale.com/download/ios",
  linux: "https://tailscale.com/download/linux",
  mac: "https://tailscale.com/download/mac",
  windows: "https://tailscale.com/download/windows",
  fallback: "https://tailscale.com/download",
};
const kTailscaleKeysUrl = "https://login.tailscale.com/admin/settings/keys";
const kTailscaleDownloadWindowName = "tailscale-download";
const kTailscaleKeysWindowName = "tailscale-keys";
const kChannelAccordionDefs = [
  { id: "telegram", title: "Telegram", fieldKeys: ["TELEGRAM_BOT_TOKEN"] },
  { id: "discord", title: "Discord", fieldKeys: ["DISCORD_BOT_TOKEN"] },
  {
    id: "slack",
    title: "Slack",
    fieldKeys: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
  },
];

const getTailscaleDownloadUrl = () => {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return kTailscaleDownloadUrls.fallback;
  }
  const userAgent = String(navigator.userAgent || "");
  const platform = String(
    navigator.userAgentData?.platform || navigator.platform || "",
  );
  const isTouchMac = /Mac/i.test(platform) && Number(navigator.maxTouchPoints) > 1;

  if (/Android/i.test(userAgent)) return kTailscaleDownloadUrls.android;
  if (/iPhone|iPad|iPod/i.test(userAgent) || isTouchMac) {
    return kTailscaleDownloadUrls.ios;
  }
  if (/Win/i.test(platform)) return kTailscaleDownloadUrls.windows;
  if (/Mac/i.test(platform)) return kTailscaleDownloadUrls.mac;
  if (/Linux/i.test(platform)) return kTailscaleDownloadUrls.linux;

  return kTailscaleDownloadUrls.fallback;
};

const getTailscaleSideWindowFeatures = () => {
  if (typeof window === "undefined") {
    return "popup=yes,width=760,height=820";
  }
  const width = 760;
  const height = Math.min(860, Math.max(640, window.screen?.availHeight || 820));
  const screenLeft = Number(window.screenX ?? window.screenLeft ?? 0);
  const screenTop = Number(window.screenY ?? window.screenTop ?? 0);
  const outerWidth = Number(window.outerWidth || 1280);
  const left = Math.max(0, Math.round(screenLeft + outerWidth - width - 24));
  const top = Math.max(0, Math.round(screenTop + 24));
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
};

const openTailscaleSideWindow = (url, windowName) => {
  const targetUrl = String(url || "").trim();
  if (!targetUrl || typeof window === "undefined") return;
  const popup = window.open(
    targetUrl,
    windowName,
    getTailscaleSideWindowFeatures(),
  );
  if (popup && !popup.closed) {
    try {
      popup.opener = null;
      popup.focus?.();
    } catch {}
    return;
  }
  const fallback = window.open(targetUrl, "_blank", "noopener,noreferrer");
  if (!fallback || fallback.closed) {
    window.location.href = targetUrl;
  }
};

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
  claudeCliLoginCanSubmitCode,
  claudeCliLoginInput,
  claudeCliLoginSubmitting,
  claudeCliLoginOutput,
  claudeCliLoginState,
  claudeCliLoginUrl,
  claudeCliLoginWindowOpened,
  claudeCliError,
  refreshClaudeCliStatus,
  startClaudeCliAuth,
  openClaudeCliLoginUrl,
  setClaudeCliLoginInput,
  submitClaudeCliLoginCode,
  adoptClaudeCliAuth,
  tailscaleApiToken,
  setTailscaleApiToken,
  tailscaleClientReady,
  setTailscaleClientReady,
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
  const tailscaleDownloadUrl = getTailscaleDownloadUrl();
  const activeGroupReady = activeGroup.validate(vals, {
    hasAi,
    tailscaleApiToken,
    tailscaleClientReady,
  });

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
  const renderSubscriptionCards = () =>
    modelAccessMode === "subscription" && (accountLoginOptions || []).length > 0
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
                    <span class="text-xs font-semibold leading-4">
                      ${option.label}
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
  const renderProviderSelect = () =>
    modelAccessMode !== "subscription" && (accountLoginOptions || []).length > 0
      ? html`
          <div class="space-y-1">
            <label class="text-xs font-medium text-fg-muted">
              ${modelAccessMode === "gateway" ? "Gateway" : "Provider"}
            </label>
            <${ProviderSelect}
              value=${selectedAccountLoginProvider || ""}
              options=${accountLoginOptions || []}
              onChange=${setAccountLoginProvider}
              placeholder=${modelAccessMode === "gateway"
                ? "Select a gateway"
                : "Select a provider"}
            />
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
            <div class="space-y-2 text-xs">
              <div class="min-w-0">
                <p class="text-fg-dim">CLI</p>
                <p class="text-body break-words">
                  ${claudeCliStatus?.installed ? "Installed" : "Not found"}
                </p>
              </div>
              <div class="min-w-0">
                <p class="text-fg-dim">Account</p>
                <p class="text-body break-words">
                  ${claudeCliStatus?.loggedIn
                    ? claudeCliStatus?.email || "Logged in"
                    : "Login needed"}
                </p>
              </div>
              <div class="min-w-0">
                <p class="text-fg-dim">OpenClaw</p>
                <p class="text-body break-words">
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
                      loadingLabel=${claudeCliLoginState === "running"
                        ? "Waiting..."
                        : "Starting..."}
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
            ${claudeCliLoginUrl
              ? html`
                  <div class="flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                    <p class="text-xs text-fg-muted">
                      ${claudeCliLoginWindowOpened
                        ? "Claude login opened in a separate window. Return here after copying the code."
                        : "Open Claude login in a separate window."}
                    </p>
                    ${!claudeCliLoginWindowOpened
                      ? html`
                          <${ActionButton}
                            onClick=${openClaudeCliLoginUrl}
                            tone="neutral"
                            size="sm"
                            idleLabel="Open Claude login"
                            className="font-medium"
                          />
                        `
                      : null}
                  </div>
                `
              : null}
            ${claudeCliLoginState === "running"
              ? html`
                  <p class="text-xs text-fg-muted">
                    Waiting for Claude login to complete.
                  </p>
                `
              : claudeCliLoginState && claudeCliLoginState !== "idle"
                ? html`
                    <p class="text-xs text-fg-muted">
                      Claude login status: ${claudeCliLoginState}
                    </p>
                  `
                : null}
            ${claudeCliLoginOutput
              ? html`
                  <details class="rounded-lg border border-border bg-surface px-3 py-2">
                    <summary class="cursor-pointer text-[11px] text-fg-dim">
                      Show Claude CLI details
                    </summary>
                    <pre
                      class="mt-2 max-h-32 overflow-auto text-[11px] leading-4 text-fg-muted whitespace-pre-wrap"
                    >${claudeCliLoginOutput}</pre>
                  </details>
                `
              : null}
            ${claudeCliLoginState === "running"
              ? html`
                  <div class="space-y-2">
                    <label class="text-xs font-medium text-fg-muted">
                      Claude login code
                    </label>
                    <div class="flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        value=${claudeCliLoginInput || ""}
                        onInput=${(e) => setClaudeCliLoginInput(e.target.value)}
                        placeholder="Paste code from browser"
                        class="min-w-0 flex-1 bg-field border border-border rounded-lg px-3 py-2 text-xs text-body outline-none focus:border-fg-muted font-mono"
                      />
                      <${ActionButton}
                        onClick=${submitClaudeCliLoginCode}
                        disabled=${!claudeCliLoginCanSubmitCode ||
                        !String(claudeCliLoginInput || "").trim() ||
                        claudeCliLoginSubmitting}
                        loading=${claudeCliLoginSubmitting}
                        tone="primary"
                        size="sm"
                        idleLabel="Submit code"
                        loadingLabel="Submitting..."
                        className="font-medium"
                      />
                    </div>
                  </div>
                `
              : null}
          </div>
        `
      : null;

  return html`
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-sm font-medium text-body">${activeGroup.title}</h2>
        ${activeGroup.description
          ? html`<p class="text-xs text-fg-muted">${activeGroup.description}</p>`
          : null}
      </div>
      ${activeGroupReady
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
      ${renderSubscriptionCards()}
      ${renderProviderSelect()}
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
                  ? "We recommend Opus, Sonnet, or GPT-5.5 through a gateway."
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
      <div class="bg-field border border-border rounded-lg p-3 space-y-3">
        <p class="text-xs leading-5 text-fg-dim">
          AlphaClaw uses Tailscale to put this OpenClaw server on a personal
          private network, allowing you to access the dashboard with a stable
          HTTPS URL without exposing it to the public internet.
        </p>
        <div class="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onclick=${() =>
              openTailscaleSideWindow(
                tailscaleDownloadUrl,
                kTailscaleDownloadWindowName,
              )}
            class="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-medium transition-colors ac-btn-secondary"
          >
            <${DownloadLineIcon} className="h-3.5 w-3.5" />
            Download Tailscale
          </button>
          <button
            type="button"
            onclick=${() =>
              openTailscaleSideWindow(kTailscaleKeysUrl, kTailscaleKeysWindowName)}
            class="inline-flex h-9 items-center justify-center rounded-xl px-3 text-sm font-medium transition-colors ac-btn-cyan"
          >
            Open Tailscale Keys
          </button>
        </div>
      </div>
      <div class="bg-field border border-border rounded-lg p-3 space-y-2">
        <p class="text-xs font-medium text-body">What you need to do</p>
        <ul class="list-disc pl-4 space-y-1 text-xs leading-5 text-fg-dim">
          <li>
            Install Tailscale on this device, then sign in or create your
            free account from the app.
          </li>
          <li>
            Create a 1-day API access token in Tailscale and paste it below.
          </li>
        </ul>
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
          The token should start with${" "}<code>tskey-api-</code>. AlphaClaw
          submits it only during final setup and does not save it in browser
          setup storage.
        </p>
      </div>
      <label
        class="flex items-start gap-2 rounded-lg border border-border bg-field p-3 text-xs text-fg-muted"
      >
        <input
          type="checkbox"
          checked=${!!tailscaleClientReady}
          onChange=${(e) => setTailscaleClientReady(!!e.target.checked)}
          class="mt-0.5 rounded"
        />
        <span class="leading-5">
          I have installed Tailscale on this device and signed in to the same
          account I want AlphaClaw to use.
        </span>
      </label>
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
                  Used for voice transcription and text-to-speech -${" "}
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
                  Used for Nano Banana image generation -${" "}
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
              disabled=${activeGroup.id === "tailscale" && !activeGroupReady}
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
