import { h } from "preact";
import htm from "htm";
import { formatLocaleDateTime } from "../../lib/format.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";

const html = htm.bind(h);

export const PendingProposal = ({
  proposal = null,
  onOpen = () => {},
}) => {
  if (!proposal) return null;
  const serviceName = String(proposal.service?.name || "").trim();
  const serviceHost = String(proposal.service?.host || "").trim();
  const credentialKeys = Array.isArray(proposal.credentialKeys)
    ? proposal.credentialKeys
    : proposal.key
      ? [proposal.key]
      : [];
  const reason = String(proposal.reason || "").trim();
  const requestInstructions = Array.isArray(proposal.requestInstructions)
    ? proposal.requestInstructions
    : [];

  return html`
    <div class="ac-surface-inset rounded-lg p-4 space-y-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-[11px] font-medium uppercase tracking-wide text-fg-dim">
            Service access request
          </p>
          <h3 class="mt-1 break-all text-sm font-semibold text-body">
            ${serviceName || serviceHost || `Proposal #${proposal.id}`}
          </h3>
          ${serviceHost
            ? html`<code class="mt-1 block break-all text-xs text-fg-muted">
                ${serviceHost}
              </code>`
            : null}
        </div>
        <${Badge} tone="warning">Pending approval</${Badge}>
      </div>

      ${reason
        ? html`
            <div>
              <p class="text-[11px] text-fg-dim">Why it is needed</p>
              <p class="mt-1 break-words text-xs text-body">${reason}</p>
            </div>
          `
        : null}

      ${credentialKeys.length
        ? html`
            <div>
              <p class="text-[11px] text-fg-dim">Credential slots</p>
              <div class="mt-1 flex flex-wrap gap-1.5">
                ${credentialKeys.map(
                  (key) => html`
                    <code
                      key=${key}
                      class="rounded-md border border-border bg-field px-2 py-1 text-[11px] text-body"
                    >
                      ${key}
                    </code>
                  `,
                )}
              </div>
            </div>
          `
        : null}

      ${requestInstructions.length
        ? html`
            <div>
              <p class="text-[11px] text-fg-dim">Request instructions</p>
              <ul class="mt-1 space-y-1 text-xs text-body">
                ${requestInstructions.map(
                  (instruction) => html`
                    <li key=${instruction} class="break-words">
                      ${instruction}
                    </li>
                  `,
                )}
              </ul>
            </div>
          `
        : null}

      <div
        class="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <p class="text-[11px] text-fg-dim">
          Proposal #${proposal.id}
          ${proposal.vault ? ` · ${proposal.vault} vault` : ""}
          ${proposal.createdAt
            ? ` · ${formatLocaleDateTime(proposal.createdAt)}`
            : ""}
        </p>
        ${proposal.approvalUrl
          ? html`
              <${ActionButton}
                tone="primary"
                size="sm"
                idleLabel="Review proposal"
                onClick=${onOpen}
              />
            `
          : null}
      </div>
    </div>
  `;
};
