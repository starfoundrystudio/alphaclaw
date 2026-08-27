import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

// Embeddable service-rule listing for the Advanced disclosure — plain block,
// no section chrome, no per-row status (every rule the vault returns exists
// and is active; there is no other state to badge).
export const ServiceTable = ({ services = [] }) => html`
  <div class="space-y-2">
    <div>
      <h3 class="text-xs font-semibold text-body">Brokered services</h3>
      <p class="mt-0.5 text-[11px] text-fg-dim">
        Service rules decide which upstream requests receive credentials.
      </p>
    </div>
    ${services.length
      ? html`
          <div class="overflow-x-auto">
            <table class="w-full min-w-[24rem] text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-fg-muted">
                  <th class="pb-2 pr-3 font-medium">Service</th>
                  <th class="pb-2 font-medium">Host pattern</th>
                </tr>
              </thead>
              <tbody>
                ${services.map(
                  (service) => html`
                    <tr
                      key=${service.name || service.host}
                      class="border-b border-border last:border-b-0"
                    >
                      <td class="py-2 pr-3">
                        <code class="text-xs text-body">
                          ${service.name || "Unnamed"}
                        </code>
                      </td>
                      <td class="py-2">
                        <code class="break-all text-xs text-fg-muted">
                          ${service.host}
                        </code>
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
  </div>
`;
