import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../../action-button.js";
import { ModalShell } from "../../modal-shell.js";
import { SecretInput } from "../../secret-input.js";

const html = htm.bind(h);

const kTailscaleKeysUrl = "https://login.tailscale.com/admin/settings/keys";
const kTailscaleMachinesUrl = "https://login.tailscale.com/admin/machines";

const SummaryRow = ({ label, value }) => html`
  <div class="ac-surface-inset border border-border rounded-lg px-3 py-2">
    <p class="text-[11px] uppercase tracking-[0.16em] text-fg-muted">${label}</p>
    <p class="mt-1 text-sm text-body font-mono break-all">${value || "Unknown"}</p>
  </div>
`;

const TokenStep = ({ state, actions }) => html`
  <div class="space-y-4">
    <div class="space-y-2 text-sm text-fg-muted">
      <p>Keep this dashboard open and stay connected to the current tailnet until the final step.</p>
      <ol class="list-decimal pl-5 space-y-1.5">
        <li>Create the replacement Tailscale account in your browser.</li>
        <li>
          Open the
          ${" "}<a class="ac-tip-link" href=${kTailscaleKeysUrl} target="_blank" rel="noreferrer">Keys page</a>
          for the new account and generate an API access token.
        </li>
      </ol>
    </div>

    <label class="block space-y-1.5">
      <span class="text-xs font-medium text-body">New Tailscale API token</span>
      <${SecretInput}
        value=${state.token}
        onInput=${(event) => actions.setToken(event.target.value)}
        disabled=${state.validating}
        placeholder="tskey-api-..."
        inputClass="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm font-mono text-body focus:border-fg-muted"
      />
      <span class="block text-xs text-fg-dim">The token is used for this operation only and is never written to AlphaClaw's durable state.</span>
    </label>
  </div>
`;

const ReviewStep = ({ state, actions }) => html`
  <div class="space-y-4">
    <div class="grid gap-2 sm:grid-cols-2">
      <${SummaryRow} label="Current address" value=${state.validation?.currentSetupUrl || state.validation?.currentDns} />
      <div class="ac-surface-inset border border-border rounded-lg px-3 py-2">
        <p class="text-[11px] uppercase tracking-[0.16em] text-fg-muted">Replacement tailnet</p>
        <p class="mt-1 text-sm text-status-success">API token validated</p>
      </div>
    </div>
    <div class="rounded-lg border border-status-warning-border bg-status-warning-bg p-3 space-y-2">
      <p class="text-sm font-medium text-status-warning">The current dashboard address will stop working.</p>
      <ul class="list-disc pl-5 space-y-1 text-xs text-status-warning-muted">
        ${(state.validation?.warnings || []).map(
          (warning) => html`<li key=${warning}>${warning}</li>`,
        )}
      </ul>
    </div>
    <label class="flex items-start gap-2 text-sm text-body cursor-pointer">
      <input
        type="checkbox"
        checked=${state.acknowledged}
        onchange=${(event) => actions.setAcknowledged(event.target.checked)}
        disabled=${state.submitting}
        class="mt-0.5"
      />
      <span>I understand that this browser connection will be interrupted and I will reconnect through the new Tailscale account.</span>
    </label>
  </div>
`;

const ReconnectStep = () => html`
  <div class="space-y-4">
    <div class="rounded-lg border border-status-success-border bg-status-success-bg p-3">
      <p class="text-sm font-medium text-status-success">The host is switching tailnets.</p>
      <p class="mt-1 text-xs text-status-success-muted">This page may disconnect while Tailscale changes networks. The host helper will roll back if it cannot verify the new connection.</p>
    </div>
    <div class="ac-surface-inset border border-border rounded-lg p-3 space-y-2">
      <p class="text-xs text-fg-muted">Find the new address</p>
      <a
        href=${kTailscaleMachinesUrl}
        class="inline-block text-sm ac-tip-link"
        target="_blank"
        rel="noreferrer"
      >Open Tailscale Machines</a>
    </div>
    <ol class="list-decimal pl-5 space-y-1.5 text-sm text-fg-muted">
      <li>Switch your Tailscale client to the new account and tailnet.</li>
      <li>Wait about one minute for the host to finish joining and configuring HTTPS.</li>
      <li>Open the <span class="font-mono text-body">alphaclaw</span> machine in Tailscale, then use its full DNS name to open AlphaClaw and sign in again.</li>
    </ol>
  </div>
`;

export const ChangeTailnetModal = ({ state, actions }) => {
  const title =
    state.step === "review"
      ? "Review tailnet change"
      : state.step === "reconnect"
        ? "Reconnect to AlphaClaw"
        : "Change Tailnet";
  const canValidate = Boolean(state.token.trim());

  return html`
    <${ModalShell}
      visible=${state.visible}
      onClose=${actions.close}
      closeOnOverlayClick=${!state.validating && !state.submitting}
      closeOnEscape=${!state.validating && !state.submitting}
      panelClassName="bg-modal border border-border rounded-xl p-5 max-w-xl w-full space-y-4"
    >
      <div class="space-y-1">
        <h3 class="text-base font-semibold">${title}</h3>
        <p class="text-xs text-fg-muted">Move this AlphaClaw host from its current Tailscale account to a replacement account.</p>
      </div>

      ${state.step === "token"
        ? html`<${TokenStep} state=${state} actions=${actions} />`
        : state.step === "review"
          ? html`<${ReviewStep} state=${state} actions=${actions} />`
          : html`<${ReconnectStep} />`}

      ${state.error
        ? html`<p class="text-sm text-status-error">${state.error}</p>`
        : null}

      <div class="border-t border-border pt-4 flex items-center justify-end gap-2">
        ${state.step === "token"
          ? html`
              <${ActionButton}
                onClick=${actions.close}
                tone="secondary"
                size="md"
                idleLabel="Cancel"
                disabled=${state.validating}
              />
              <${ActionButton}
                onClick=${actions.validate}
                tone="primary"
                size="md"
                idleLabel="Validate"
                loadingLabel="Validating..."
                loading=${state.validating}
                disabled=${!canValidate}
              />
            `
          : state.step === "review"
            ? html`
                <${ActionButton}
                  onClick=${actions.back}
                  tone="secondary"
                  size="md"
                  idleLabel="Back"
                  disabled=${state.submitting}
                />
                <${ActionButton}
                  onClick=${actions.start}
                  tone="primary"
                  size="md"
                  idleLabel="Change Tailnet"
                  loadingLabel="Scheduling..."
                  loading=${state.submitting}
                  disabled=${!state.acknowledged}
                />
              `
            : html`
                <${ActionButton}
                  onClick=${actions.close}
                  tone="primary"
                  size="md"
                  idleLabel="Done"
                />
              `}
      </div>
    </${ModalShell}>
  `;
};
