import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { SecretInput } from "../secret-input.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { SegmentedControl } from "../segmented-control.js";
import { getChannelMeta } from "../channels.js";
import { getOnboardingModelLabel } from "../../lib/model-config.js";
import {
  getOptionalToolCredentialVisibility,
  kOpenAiCodexRouteKey,
  kOpenAiCodexRoutePi,
  kOpenAiCodexRouteRuntime,
  kOpenAiCodexRouteTouchedKey,
} from "./welcome-config.js";

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
  modelOptions,
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
    selectedProvider === "openai" || selectedProvider === "openai-codex";
  const openAiCodexRoute =
    vals[kOpenAiCodexRouteKey] === kOpenAiCodexRoutePi
      ? kOpenAiCodexRoutePi
      : kOpenAiCodexRouteRuntime;
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
  const fieldLookup = new Map((activeGroup.fields || []).map((field) => [field.key, field]));
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
      <div class="space-y-1">
        <label class="text-xs font-medium text-fg-muted">Model</label>
        <select
          value=${vals.MODEL_KEY || ""}
          onInput=${(e) => setValue("MODEL_KEY", e.target.value)}
          class="w-full bg-field border border-border rounded-lg pl-3 pr-8 py-2 text-sm text-body outline-none focus:border-fg-muted"
        >
          <option value="">Select a model</option>
          ${modelOptions.map(
            (model) => html`
              <option value=${model.key}
                >${getOnboardingModelLabel(model, modelOptions)}</option
              >
            `,
          )}
        </select>
        <p class="text-xs text-fg-dim">
          ${modelsLoading
            ? "Loading model catalog..."
            : modelsError
              ? modelsError
              : "Provider variants are listed separately when the same model is available through multiple gateways."}
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
              : "Show full model catalog"}
          </button>
        `}
      </div>
    `}
    ${activeGroup.id === "ai" &&
    (selectedProvider === "openai" || selectedProvider === "openai-codex") &&
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
            <div class="flex items-center justify-between gap-3">
              <span class="text-xs text-fg-muted">Use Codex OAuth with</span>
              <${SegmentedControl}
                options=${[
                  {
                    value: kOpenAiCodexRouteRuntime,
                    label: "Codex runtime",
                    title:
                      "Use the native Codex harness for OpenAI models. Other providers can still be selected later with their own credentials.",
                  },
                  {
                    value: kOpenAiCodexRoutePi,
                    label: "OpenClaw Pi",
                    title:
                      "Use Codex OAuth through OpenClaw's default runtime for this OpenAI route.",
                  },
                ]}
                value=${openAiCodexRoute}
                onChange=${(value) => {
                  setValue(kOpenAiCodexRouteKey, value);
                  setValue(kOpenAiCodexRouteTouchedKey, true);
                }}
              />
            </div>
            <p class="text-xs text-fg-dim">
              ${openAiCodexRoute === kOpenAiCodexRouteRuntime
                ? "OpenAI models will use the Codex runtime by default. You can still switch to Anthropic, Gemini, OpenRouter, and other providers later when their credentials are configured."
                : "OpenClaw Pi uses Codex OAuth for this OpenAI route. Other providers still remain available later when their credentials are configured."}
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
