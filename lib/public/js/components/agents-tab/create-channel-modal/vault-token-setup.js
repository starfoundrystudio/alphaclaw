import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../../action-button.js";
import { Badge } from "../../badge.js";

const html = htm.bind(h);

const openExternal = (url) => {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
};

const kProviderTokenHints = {
  telegram: "the bot token",
  discord: "the bot token",
  slack: "both tokens",
};

// Vault-brokered channel credential step: on managed instances the wizard
// never shows a token field. The token is entered once on the Agent Vault
// approval page and only non-secret placeholders reach this instance.
export const VaultChannelTokenSetup = ({
  provider = "",
  vaultState = { status: "idle" },
  onRequest = () => {},
}) => {
  const status = vaultState.status || "idle";
  const hint = kProviderTokenHints[provider] || "the channel token";

  return html`
    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-fg-muted">Channel token</span>
        ${status === "active"
          ? html`<${Badge} tone="success">Agent Vault</${Badge}>`
          : status === "pending"
            ? html`<${Badge} tone="warning">Approval pending</${Badge}>`
            : html`<${Badge} tone="neutral">Agent Vault managed</${Badge}>`}
      </div>
      ${status === "active"
        ? html`
            <div class="ac-surface-inset rounded-lg p-3">
              <p class="text-xs text-body">
                Token stored securely in Agent Vault — it is never saved on
                this server.
              </p>
            </div>
          `
        : status === "pending"
          ? html`
              <div
                class="flex flex-col gap-2 rounded-lg border border-border bg-field px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <p class="text-xs text-fg-muted">
                  Enter ${hint} on the approval page. This step completes
                  automatically once you approve.
                </p>
                ${vaultState.proposal?.approvalUrl
                  ? html`
                      <${ActionButton}
                        onClick=${() =>
                          openExternal(vaultState.proposal?.approvalUrl)}
                        tone="primary"
                        size="sm"
                        idleLabel="Open approval page"
                        className="text-xs font-medium shrink-0"
                      />
                    `
                  : null}
              </div>
            `
          : html`
              <div
                class="flex flex-col gap-2 rounded-lg border border-border bg-field px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <p class="text-xs text-fg-muted">
                  You'll enter ${hint} on the secure approval page.
                </p>
                <${ActionButton}
                  onClick=${onRequest}
                  loading=${status === "requesting"}
                  tone="primary"
                  size="sm"
                  idleLabel="Store token in Agent Vault"
                  loadingLabel="Requesting..."
                  className="text-xs font-medium shrink-0"
                />
              </div>
            `}
      ${vaultState.error
        ? html`<p class="text-xs text-status-error">${vaultState.error}</p>`
        : null}
    </div>
  `;
};
