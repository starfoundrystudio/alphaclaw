import { h } from "preact";
import htm from "htm";
import { formatLocaleDateTime } from "../../lib/format.js";
import { Badge } from "../badge.js";

const html = htm.bind(h);

export const CredentialTable = ({
  credentials = [],
  vault = "",
  loading = false,
  error = null,
}) => html`
  <section class="bg-surface border border-border rounded-xl p-5 space-y-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h2 class="text-sm font-semibold text-body">Available credentials</h2>
        <p class="mt-1 text-xs text-fg-muted">
          Values never leave Agent Vault and are never returned here.
        </p>
      </div>
      ${credentials.length
        ? html`<${Badge} tone="neutral">
            ${credentials.length} ${" "}
            ${credentials.length === 1 ? "credential" : "credentials"}
          </${Badge}>`
        : null}
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
                <table class="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr class="border-b border-border text-left text-xs text-fg-muted">
                      <th class="pb-2 pr-3 font-medium">Credential</th>
                      <th class="pb-2 pr-3 font-medium">Vault</th>
                      <th class="pb-2 pr-3 font-medium">Status</th>
                      <th class="pb-2 font-medium">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${credentials.map(
                      (credential) => html`
                        <tr
                          key=${credential.key}
                          class="border-b border-border last:border-b-0"
                        >
                          <td class="py-3 pr-3">
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
                          <td class="py-3 pr-3">
                            <code class="text-xs text-fg-muted">
                              ${credential.vault || vault || "default"}
                            </code>
                          </td>
                          <td class="py-3 pr-3">
                            <${Badge} tone="success">Available</${Badge}>
                          </td>
                          <td class="py-3 text-xs text-fg-muted">
                            ${credential.createdAt
                              ? formatLocaleDateTime(credential.createdAt)
                              : html`
                                  <span title="Not exposed to Clawbridge by Agent Vault">
                                    Not provided
                                  </span>
                                `}
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
              <p class="text-[11px] text-fg-dim">
                Creation dates appear when Agent Vault exposes them to its
                broker identity.
              </p>
            `
          : html`
              <p class="text-xs text-fg-muted">
                No credential values have been defined yet.
              </p>
            `}
  </section>
`;
