import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../../action-button.js";
import { FileCopyLineIcon } from "../../icons.js";
import { SecretInput } from "../../secret-input.js";
import { copyTextToClipboard } from "../../../lib/clipboard.js";
import {
  buildSlackManifest,
  buildSlackManifestUrl,
} from "../../../lib/slack-manifest.js";
import { showToast } from "../../toast.js";

const html = htm.bind(h);

export const isSlackBotTokenShape = (value) =>
  /^xoxb-[A-Za-z0-9-]{10,}$/.test(String(value || "").trim());

export const isSlackAppTokenShape = (value) =>
  /^xapp-[A-Za-z0-9-]{10,}$/.test(String(value || "").trim());

const copyManifest = async (appName) => {
  const copied = await copyTextToClipboard(buildSlackManifest(appName));
  showToast(
    copied ? "Slack manifest copied" : "Could not copy Slack manifest",
    copied ? "success" : "error",
  );
};

const CredentialStatus = ({ label, detail, state = "error" }) => html`
  <div class="flex items-center justify-between gap-3 py-1">
    <div class="min-w-0">
      <p class="text-xs font-medium text-body">${label}</p>
      <p class="text-[11px] leading-4 text-fg-dim">${detail}</p>
    </div>
    <span
      class=${`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        state === "verified"
          ? "border-status-success-border bg-status-success-bg text-status-success"
          : state === "warning"
            ? "border-status-warning-border bg-status-warning-bg text-status-warning-muted"
            : "border-status-error-border bg-status-error-bg text-status-error-muted"
      }`}
    >
      ${state === "verified"
        ? "Verified"
        : state === "warning"
          ? "Not checked"
          : "Needs attention"}
    </span>
  </div>
`;

export const SlackChannelSetup = ({
  appName = "AlphaClaw",
  botToken = "",
  appToken = "",
  slack = null,
  verifying = false,
  verificationError = "",
  onAppNameInput = () => {},
  onBotTokenInput = () => {},
  onAppTokenInput = () => {},
  onVerify = () => {},
}) => {
  const normalizedAppName = String(appName || "").trim() || "AlphaClaw";
  const normalizedBotToken = String(botToken || "").trim();
  const normalizedAppToken = String(appToken || "").trim();
  const botTokenValid = isSlackBotTokenShape(normalizedBotToken);
  const appTokenValid = isSlackAppTokenShape(normalizedAppToken);
  const canVerify = botTokenValid && appTokenValid && !verifying;
  const missingScopes = Array.isArray(slack?.scopes?.missing)
    ? slack.scopes.missing
    : [];
  const scopesValid = !slack?.scopes?.checked || missingScopes.length === 0;

  return html`
    <div class="space-y-4">
      <div class="ac-surface-inset rounded-xl p-4 space-y-3">
        <div class="flex items-start gap-3">
          <img
            src="/assets/icons/slack.svg"
            alt=""
            class="mt-0.5 h-8 w-8 rounded-lg"
            aria-hidden="true"
          />
          <div class="min-w-0 space-y-1">
            <p class="text-sm font-medium text-body">Create a Slack app</p>
            <p class="text-xs leading-5 text-fg-muted">
              AlphaClaw can preconfigure Socket Mode, events, bot scopes, and
              OpenClaw's supported Slack assistant experience. You only choose
              the workspace and approve the app.
            </p>
          </div>
        </div>
        <label class="block space-y-1">
          <span class="text-xs font-medium text-fg-muted">Slack app name</span>
          <input
            type="text"
            value=${normalizedAppName}
            maxlength="35"
            onInput=${(event) => onAppNameInput(event.target.value)}
            class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted"
          />
        </label>
        <div class="flex flex-wrap gap-2">
          <a
            href=${buildSlackManifestUrl(normalizedAppName)}
            target="_blank"
            rel="noreferrer"
            class="ac-btn-cyan inline-flex h-9 items-center justify-center whitespace-nowrap rounded-xl px-4 text-sm font-medium leading-none transition-colors"
          >
            Create Slack app
          </a>
          <${ActionButton}
            onClick=${() => copyManifest(normalizedAppName)}
            tone="secondary"
            size="md"
            idleLabel="Copy manifest"
            idleIcon=${FileCopyLineIcon}
          />
        </div>
        <p class="text-[11px] leading-4 text-fg-dim">
          If the one-click link is blocked by your Slack organization, copy the
          manifest and choose${" "}<strong>Create New App → From a manifest</strong>
          in Slack's app dashboard.
        </p>
      </div>

      <div class="rounded-xl border border-border bg-field p-3 space-y-3">
        <div>
          <p class="text-xs font-medium text-body">Install and copy tokens</p>
          <p class="text-[11px] leading-4 text-fg-dim">
            Complete these two steps in the app settings opened by Slack.
          </p>
        </div>
        <ol class="list-decimal space-y-2 pl-5 text-xs leading-5 text-fg-muted">
          <li>
            Open${" "}<strong>Basic Information → App-Level Tokens</strong>,
            generate a token with${" "}<code>connections:write</code>, and copy
            the${" "}<code>xapp-...</code> value.
          </li>
          <li>
            Open${" "}<strong>Install App</strong>, install it to your workspace,
            and copy the${" "}<strong>Bot User OAuth Token</strong> beginning
            with${" "}<code>xoxb-</code>.
          </li>
        </ol>
      </div>

      <div class="space-y-3">
        <label class="block space-y-1">
          <span class="text-xs font-medium text-fg-muted">
            Bot User OAuth Token
          </span>
          <${SecretInput}
            value=${botToken}
            onInput=${(event) => onBotTokenInput(event.target.value)}
            placeholder="xoxb-..."
            isSecret=${true}
            inputClass="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body outline-none focus:border-fg-muted"
          />
        </label>
        <label class="block space-y-1">
          <span class="text-xs font-medium text-fg-muted">
            App-Level Token (Socket Mode)
          </span>
          <${SecretInput}
            value=${appToken}
            onInput=${(event) => onAppTokenInput(event.target.value)}
            placeholder="xapp-..."
            isSecret=${true}
            inputClass="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body outline-none focus:border-fg-muted"
          />
        </label>
        <p class="text-xs leading-5 text-fg-dim">
          AlphaClaw verifies both tokens directly with Slack and confirms they
          belong to the same app before saving them.
        </p>
        <${ActionButton}
          onClick=${onVerify}
          disabled=${!canVerify}
          loading=${verifying}
          tone=${slack ? "secondary" : "primary"}
          size="sm"
          idleLabel=${slack ? "Verify again" : "Verify Slack"}
          loadingLabel="Checking with Slack..."
        />
        ${normalizedBotToken && !botTokenValid
          ? html`<p class="text-xs text-status-warning-muted">
              The Bot User OAuth Token should begin with${" "}<code>xoxb-</code>.
            </p>`
          : null}
        ${normalizedAppToken && !appTokenValid
          ? html`<p class="text-xs text-status-warning-muted">
              The App-Level Token should begin with${" "}<code>xapp-</code>.
            </p>`
          : null}
        ${verificationError
          ? html`<p class="text-xs text-status-error-muted">
              ${verificationError}
            </p>`
          : null}
      </div>

      ${slack
        ? html`
            <div
              class="rounded-xl border border-status-success-border bg-status-success-bg p-3"
            >
              <div class="flex items-center gap-3">
                <img
                  src="/assets/icons/slack.svg"
                  alt=""
                  class="h-7 w-7 rounded-lg"
                  aria-hidden="true"
                />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-body">
                    ${slack.workspace?.name || "Slack Workspace"}
                  </p>
                  <p class="truncate text-xs text-fg-muted">
                    ${slack.bot?.name || "Slack Bot"}
                  </p>
                </div>
                <span class="text-xs font-medium text-status-success">
                  Credentials verified
                </span>
              </div>
            </div>

            <div class="rounded-xl border border-border bg-field p-3 space-y-2">
              <div class="divide-y divide-border">
                <${CredentialStatus}
                  label="Bot token"
                  detail="Slack accepted this Bot User OAuth Token."
                  state="verified"
                />
                <${CredentialStatus}
                  label="App token"
                  detail="Socket Mode connections:write is enabled."
                  state="verified"
                />
                <${CredentialStatus}
                  label="Required bot scopes"
                  detail=${slack.scopes?.checked
                    ? scopesValid
                      ? "All required scopes are installed."
                      : `${missingScopes.length} required scope${missingScopes.length === 1 ? " is" : "s are"} missing.`
                    : "Slack did not expose the installed scope list; the manifest includes the required scopes."}
                  state=${slack.scopes?.checked
                    ? scopesValid
                      ? "verified"
                      : "error"
                    : "warning"}
                />
              </div>
              ${missingScopes.length > 0
                ? html`
                    <div
                      class="rounded-lg border border-status-error-border bg-status-error-bg px-3 py-2 space-y-1"
                    >
                      <p class="text-xs font-medium text-status-error-muted">
                        Add these bot scopes, then reinstall the app:
                      </p>
                      <p class="break-words font-mono text-[11px] leading-5 text-fg-muted">
                        ${missingScopes.join(", ")}
                      </p>
                    </div>
                  `
                : null}
              ${slack.appSettingsUrl
                ? html`<a
                    href=${slack.appSettingsUrl}
                    target="_blank"
                    rel="noreferrer"
                    class="ac-btn-secondary inline-flex h-9 items-center justify-center rounded-xl px-4 text-sm font-medium"
                  >
                    Open app settings
                  </a>`
                : null}
            </div>
          `
        : null}

      <div class="rounded-xl border border-border bg-field p-3">
        <p class="text-xs leading-5 text-fg-muted">
          AlphaClaw starts Slack DMs in private pairing mode. After connecting,
          message the app and approve your pairing request here. For channel
          conversations, invite the app only to channels you want it to use.
        </p>
      </div>
    </div>
  `;
};

export const SlackChannelConnected = ({ slack = null, onDone = () => {} }) =>
  html`
    <div class="space-y-5 py-1">
      <div class="text-center space-y-3">
        <div
          class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-status-success-bg"
        >
          <img
            src="/assets/icons/slack.svg"
            alt=""
            class="h-8 w-8 rounded-lg"
            aria-hidden="true"
          />
        </div>
        <div class="space-y-1">
          <h3 class="text-base font-semibold text-body">Slack connected</h3>
          <p class="text-sm text-fg-muted">
            ${slack?.bot?.name || "Your app"} is connected to
            ${" "}${slack?.workspace?.name || "your Slack workspace"}.
          </p>
        </div>
      </div>

      <div class="ac-surface-inset rounded-xl p-4 space-y-2">
        <p class="text-xs font-medium text-body">Finish pairing</p>
        <ol class="list-decimal space-y-1.5 pl-5 text-xs leading-5 text-fg-muted">
          <li>Open Slack and find the app under${" "}<strong>Apps</strong>.</li>
          <li>Send it any message to receive a pairing code.</li>
          <li>Return here and approve the request under Pending Pairings.</li>
          <li>
            To use a channel, invite the app to that channel after configuring
            the channel access you want.
          </li>
        </ol>
      </div>

      <div class="grid gap-2 sm:grid-cols-2">
        ${slack?.workspace?.url
          ? html`<a
              href=${slack.workspace.url}
              target="_blank"
              rel="noreferrer"
              class="ac-btn-secondary inline-flex h-10 items-center justify-center rounded-xl px-4 text-sm font-medium"
            >
              Open Slack
            </a>`
          : html`<div></div>`}
        <${ActionButton}
          onClick=${onDone}
          tone="primary"
          size="md"
          idleLabel="Continue to pairing"
          className="w-full"
        />
      </div>
    </div>
  `;
