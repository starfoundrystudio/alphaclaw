import { h } from "preact";
import htm from "htm";
import { ActionButton } from "./action-button.js";
import { DevicePairingRequestRow } from "./device-pairings.js";
import { LoadingSpinner } from "./loading-spinner.js";
import { ModalShell } from "./modal-shell.js";
import { kDashboardLauncherStatuses } from "../hooks/dashboard-launcher-helpers.js";
import { kAdvancedControlUiLabel } from "../lib/managed-capabilities.js";

const html = htm.bind(h);

const GatewayStatusNote = ({ gatewayStatus = "" }) => {
  if (gatewayStatus === "running") return null;
  return html`
    <div class="rounded-lg border border-status-warning-border bg-status-warning-bg p-3 text-xs text-status-warning-muted">
      The OpenClaw gateway does not look fully running right now. You can still open the advanced interface, but it may not load until the gateway is healthy.
    </div>
  `;
};

const LauncherBody = ({ state, actions }) => {
  const status = state.status;
  if (status === kDashboardLauncherStatuses.LOADING) {
    return html`
      <div class="flex items-center gap-2 rounded-lg border border-border bg-field p-3 text-sm text-fg-muted">
        <${LoadingSpinner} className="h-4 w-4" />
        Preparing advanced OpenClaw access...
      </div>
    `;
  }

  if (status === kDashboardLauncherStatuses.TOKEN_MISSING) {
    return html`
      <div class="space-y-3">
        <div class="rounded-lg border border-status-warning-border bg-status-warning-bg p-3">
          <div class="text-sm font-medium text-status-warning">Gateway token missing</div>
          <p class="mt-1 text-xs text-status-warning-muted">
            Clawbridge could not resolve the OpenClaw gateway token, so the advanced interface may ask for manual authentication.
          </p>
        </div>
      </div>
    `;
  }

  if (status === kDashboardLauncherStatuses.ERROR) {
    return html`
      <div class="rounded-lg border border-status-error-border bg-status-error-bg p-3">
        <div class="text-sm font-medium text-status-error">Could not prepare advanced access</div>
        <p class="mt-1 text-xs text-status-error-muted">${state.error}</p>
      </div>
    `;
  }

  if (status === kDashboardLauncherStatuses.WAITING) {
    return html`
      <div class="rounded-lg border border-status-info-border bg-status-info-bg p-3">
        <div class="flex items-center gap-2 text-sm font-medium text-status-info">
          <${LoadingSpinner} className="h-4 w-4" />
          Waiting for browser approval request
        </div>
        <p class="mt-2 text-xs text-fg-muted">
          OpenClaw should create a browser request after the new tab loads. Keep this modal open and return here if the advanced interface says pairing is required.
        </p>
      </div>
    `;
  }

  if (
    status === kDashboardLauncherStatuses.REQUEST &&
    state.primaryBrowserPairing
  ) {
    return html`
      <div class="space-y-2">
        <div class="rounded-lg border border-status-success-border bg-status-success-bg p-3">
          <div class="text-sm font-medium text-status-success">Browser approval request found</div>
          <p class="mt-1 text-xs text-fg-muted">
            Approve this browser to let the advanced OpenClaw interface continue.
          </p>
        </div>
        <${DevicePairingRequestRow}
          d=${state.primaryBrowserPairing}
          onApprove=${actions.approveBrowserPairing}
          onReject=${actions.rejectBrowserPairing}
          approveLabel="Approve browser"
          rejectLabel="Reject"
          approvedLabel="Approved"
          rejectedLabel="Rejected"
        />
      </div>
    `;
  }

  if (status === kDashboardLauncherStatuses.APPROVED) {
    return html`
      <div class="rounded-lg border border-status-success-border bg-status-success-bg p-3">
        <div class="text-sm font-medium text-status-success">Browser approved</div>
        <p class="mt-1 text-xs text-fg-muted">
          The OpenClaw tab should continue automatically. Open it again if that tab was closed.
        </p>
      </div>
    `;
  }

  if (status === kDashboardLauncherStatuses.TIMEOUT) {
    return html`
      <div class="space-y-3">
        <div class="rounded-lg border border-status-warning-border bg-status-warning-bg p-3">
          <div class="text-sm font-medium text-status-warning">No browser request appeared</div>
          <p class="mt-1 text-xs text-status-warning-muted">
            If the OpenClaw tab is open on the pairing screen, try watching again. If the tab was blocked or closed, open it again from here.
          </p>
        </div>
      </div>
    `;
  }

  return html`
    <div class="space-y-3">
      <${GatewayStatusNote} gatewayStatus=${state.gatewayStatus} />
      <p class="text-sm text-fg-muted">
        Continuing opens the upstream OpenClaw interface in a new tab. The first time this browser reaches it, OpenClaw may ask Clawbridge to approve the browser here.
      </p>
    </div>
  `;
};

const FooterActions = ({ state, actions }) => {
  const status = state.status;
  const canOpen = [
    kDashboardLauncherStatuses.READY,
    kDashboardLauncherStatuses.APPROVED,
    kDashboardLauncherStatuses.TIMEOUT,
  ].includes(status);
  const canRetry = status === kDashboardLauncherStatuses.TIMEOUT;
  const canClose = !state.approving && !state.rejecting && !state.acknowledging;
  const hasAcceptedWarning =
    state.accessAcknowledged || state.warningAccepted;

  return html`
    <div class="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
      <${ActionButton}
        tone="secondary"
        size="sm"
        idleLabel="Close"
        onClick=${actions.closeLauncher}
        disabled=${!canClose}
      />
      ${canRetry
        ? html`
            <${ActionButton}
              tone="secondary"
              size="sm"
              idleLabel="Retry watching"
              onClick=${actions.retryWatching}
            />
          `
        : null}
      ${canOpen
        ? html`
            <${ActionButton}
              tone="primary"
              size="sm"
              idleLabel=${state.accessAcknowledged
                ? status === kDashboardLauncherStatuses.APPROVED
                  ? "Open advanced controls again"
                  : "Open advanced controls"
                : "Acknowledge and open"}
              loadingLabel="Recording acknowledgement..."
              loading=${state.acknowledging}
              disabled=${!hasAcceptedWarning}
              onClick=${actions.openDashboardTab}
            />
          `
        : null}
    </div>
  `;
};

export const DashboardLauncherModal = ({ state, actions }) => html`
  <${ModalShell}
    visible=${state.visible}
    onClose=${actions.closeLauncher}
    closeOnOverlayClick=${!state.approving && !state.rejecting && !state.acknowledging}
    panelClassName="bg-modal border border-border rounded-xl p-5 max-w-lg w-full space-y-4"
  >
    <div class="space-y-3">
      <div>
        <h2 class="text-lg font-semibold text-body">Advanced OpenClaw controls</h2>
        <p class="mt-1 text-xs text-fg-muted">
          Clawbridge remains TeamYou's supported managed interface.
        </p>
      </div>
      <div class="rounded-lg border border-status-warning-border bg-status-warning-bg p-3">
        <div class="text-sm font-medium text-status-warning">${kAdvancedControlUiLabel}</div>
        <p class="mt-1 text-xs text-status-warning-muted">
          This upstream interface exposes controls outside the managed experience. Configuration is read-only for this release, and TeamYou may not support workflows or settings found only here.
        </p>
      </div>
      ${state.accessAcknowledged
        ? html`
            <p class="text-xs text-status-success">
              Acknowledged for this Clawbridge session. This warning will still appear whenever you launch the advanced interface.
            </p>
          `
        : html`
            <label class="flex items-start gap-2 text-xs text-body">
              <input
                type="checkbox"
                class="mt-0.5 h-4 w-4 rounded border-border bg-field"
                checked=${state.warningAccepted}
                onchange=${(event) =>
                  actions.setWarningAccepted(event.currentTarget.checked)}
              />
              <span>
                I understand that workflows or changes available only here may be unsupported by TeamYou.
              </span>
            </label>
          `}
      <p class="mt-1 text-xs text-fg-muted">
        Clawbridge will stay ready to approve this browser if OpenClaw asks for pairing.
      </p>
    </div>
    <${LauncherBody} state=${state} actions=${actions} />
    <${FooterActions} state=${state} actions=${actions} />
  </${ModalShell}>
`;
