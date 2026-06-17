import { h } from "preact";
import htm from "htm";
import { ActionButton } from "./action-button.js";
import { DevicePairingRequestRow } from "./device-pairings.js";
import { LoadingSpinner } from "./loading-spinner.js";
import { ModalShell } from "./modal-shell.js";
import { kDashboardLauncherStatuses } from "../hooks/dashboard-launcher-helpers.js";

const html = htm.bind(h);

const GatewayStatusNote = ({ gatewayStatus = "" }) => {
  if (gatewayStatus === "running") return null;
  return html`
    <div class="rounded-lg border border-status-warning-border bg-status-warning-bg p-3 text-xs text-status-warning-muted">
      The OpenClaw gateway does not look fully running right now. You can still open the dashboard, but it may not load until the gateway is healthy.
    </div>
  `;
};

const DashboardLinkBlock = ({ dashboardUrl = "", onCopy = () => {} }) => {
  if (!dashboardUrl) return null;
  return html`
    <div class="rounded-lg border border-border bg-field p-3">
      <div class="mb-1 text-[11px] font-semibold uppercase text-fg-dim">Dashboard link</div>
      <div class="flex items-center gap-2">
        <code class="min-w-0 flex-1 truncate text-xs text-fg-muted">${dashboardUrl}</code>
        <${ActionButton}
          tone="secondary"
          size="sm"
          idleLabel="Copy"
          onClick=${onCopy}
        />
      </div>
    </div>
  `;
};

const LauncherBody = ({ state, actions }) => {
  const status = state.status;
  if (status === kDashboardLauncherStatuses.LOADING) {
    return html`
      <div class="flex items-center gap-2 rounded-lg border border-border bg-field p-3 text-sm text-fg-muted">
        <${LoadingSpinner} className="h-4 w-4" />
        Preparing the OpenClaw dashboard link...
      </div>
    `;
  }

  if (status === kDashboardLauncherStatuses.TOKEN_MISSING) {
    return html`
      <div class="space-y-3">
        <div class="rounded-lg border border-status-warning-border bg-status-warning-bg p-3">
          <div class="text-sm font-medium text-status-warning">Gateway token missing</div>
          <p class="mt-1 text-xs text-status-warning-muted">
            AlphaClaw could not resolve the OpenClaw gateway token, so the dashboard may ask for manual authentication instead of opening cleanly.
          </p>
        </div>
        <${DashboardLinkBlock}
          dashboardUrl=${state.dashboardUrl || "/openclaw"}
          onCopy=${actions.copyDashboardLink}
        />
      </div>
    `;
  }

  if (status === kDashboardLauncherStatuses.ERROR) {
    return html`
      <div class="rounded-lg border border-status-error-border bg-status-error-bg p-3">
        <div class="text-sm font-medium text-status-error">Could not prepare OpenClaw</div>
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
          OpenClaw should create a browser request after the new tab loads. Keep this modal open and return here if the OpenClaw tab says pairing is required.
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
            Approve this browser to let the OpenClaw dashboard continue.
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
        <${DashboardLinkBlock}
          dashboardUrl=${state.dashboardUrl || "/openclaw"}
          onCopy=${actions.copyDashboardLink}
        />
      </div>
    `;
  }

  return html`
    <div class="space-y-3">
      <${GatewayStatusNote} gatewayStatus=${state.gatewayStatus} />
      <p class="text-sm text-fg-muted">
        AlphaClaw will open OpenClaw in a new tab. The first time this browser reaches OpenClaw, OpenClaw may ask AlphaClaw to approve it here.
      </p>
      <${DashboardLinkBlock}
        dashboardUrl=${state.dashboardUrl || "/openclaw"}
        onCopy=${actions.copyDashboardLink}
      />
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
  const canClose = !state.approving && !state.rejecting;

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
              idleLabel=${status === kDashboardLauncherStatuses.APPROVED ? "Open again" : "Open OpenClaw tab"}
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
    closeOnOverlayClick=${!state.approving && !state.rejecting}
    panelClassName="bg-modal border border-border rounded-xl p-5 max-w-lg w-full space-y-4"
  >
    <div>
      <h2 class="text-lg font-semibold text-body">Open OpenClaw</h2>
      <p class="mt-1 text-xs text-fg-muted">
        AlphaClaw will stay ready to approve this browser if OpenClaw asks for pairing.
      </p>
    </div>
    <${LauncherBody} state=${state} actions=${actions} />
    <${FooterActions} state=${state} actions=${actions} />
  </${ModalShell}>
`;
