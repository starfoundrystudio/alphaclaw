import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";

const html = htm.bind(h);

const UsageCell = ({ usedBy = [] }) => {
  if (!usedBy.length) {
    return html`
      <span class="text-xs text-status-warning-muted">
        Not used by anything on this instance
      </span>
    `;
  }
  return html`
    <div class="space-y-1">
      ${usedBy.map(
        (usage) => html`
          <div key=${`${usage.kind}:${usage.label}`} class="text-xs text-body">
            ${usage.label}
            ${usage.host
              ? html`<span class="text-fg-dim"> · ${usage.host}</span>`
              : null}
            ${usage.configured
              ? null
              : html`<span class="text-status-warning-muted">
                  ${" "}— not configured
                </span>`}
          </div>
        `,
      )}
    </div>
  `;
};

export const CredentialTable = ({
  credentials = [],
  loading = false,
  error = null,
  consoleUrl = "",
  onOpenConsole = () => {},
}) => html`
  <section class="bg-surface border border-border rounded-xl p-5 space-y-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h2 class="text-sm font-semibold text-body">Credentials</h2>
        <p class="mt-1 text-xs text-fg-muted">
          Values stay in Agent Vault and are never shown here. To add, edit,
          or delete one, use Agent Vault.
        </p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        ${credentials.length
          ? html`<${Badge} tone="neutral">
              ${credentials.length} ${" "}
              ${credentials.length === 1 ? "credential" : "credentials"}
            </${Badge}>`
          : null}
        ${consoleUrl
          ? html`
              <${ActionButton}
                tone="secondary"
                size="sm"
                idleLabel="Edit in Agent Vault"
                onClick=${onOpenConsole}
              />
            `
          : null}
      </div>
    </div>

    ${loading
      ? html`<p class="text-xs text-fg-muted">Loading credentials...</p>`
      : error
        ? html`
            <p class="text-xs text-status-error-muted">
              ${error.message || "Could not load credentials."}
            </p>
          `
        : credentials.length
          ? html`
              <div class="overflow-x-auto">
                <table class="w-full min-w-[28rem] text-sm">
                  <thead>
                    <tr class="border-b border-border text-left text-xs text-fg-muted">
                      <th class="pb-2 pr-3 font-medium">Credential</th>
                      <th class="pb-2 font-medium">Used by</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${credentials.map(
                      (credential) => html`
                        <tr
                          key=${credential.key}
                          class="border-b border-border last:border-b-0"
                        >
                          <td class="py-3 pr-3 align-top">
                            <code class="text-xs text-body">
                              ${credential.key}
                            </code>
                            ${credential.type
                              ? html`
                                  <p class="mt-0.5 text-[11px] capitalize text-fg-dim">
                                    ${credential.type}
                                  </p>
                                `
                              : null}
                          </td>
                          <td class="py-3 align-top">
                            <${UsageCell} usedBy=${credential.usedBy || []} />
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            `
          : html`
              <p class="text-xs text-fg-muted">
                No credentials are stored yet. Channel and model setup flows
                add them for you.
              </p>
            `}
  </section>
`;
