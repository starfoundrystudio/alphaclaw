import { h } from "preact";
import htm from "htm";
import { Badge } from "../badge.js";

const html = htm.bind(h);

export const ServiceTable = ({ services = [] }) => html`
  <section class="bg-surface border border-border rounded-xl p-5 space-y-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h2 class="text-sm font-semibold text-body">Brokered services</h2>
        <p class="mt-1 text-xs text-fg-muted">
          Service rules decide which upstream requests receive credentials.
        </p>
      </div>
      ${services.length
        ? html`<${Badge} tone="neutral">
            ${services.length} ${" "}
            ${services.length === 1 ? "service" : "services"}
          </${Badge}>`
        : null}
    </div>

    ${services.length
      ? html`
          <div class="overflow-x-auto">
            <table class="w-full min-w-[30rem] text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-fg-muted">
                  <th class="pb-2 pr-3 font-medium">Service</th>
                  <th class="pb-2 pr-3 font-medium">Host pattern</th>
                  <th class="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                ${services.map(
                  (service) => html`
                    <tr
                      key=${service.name || service.host}
                      class="border-b border-border last:border-b-0"
                    >
                      <td class="py-3 pr-3">
                        <code class="text-xs text-body">
                          ${service.name || "Unnamed"}
                        </code>
                      </td>
                      <td class="py-3 pr-3">
                        <code class="break-all text-xs text-fg-muted">
                          ${service.host}
                        </code>
                      </td>
                      <td class="py-3">
                        <${Badge} tone="success">Available</${Badge}>
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
            No service rules are configured. Stored credentials will not be
            attached to upstream requests until a service references them.
          </p>
        `}
  </section>
`;
