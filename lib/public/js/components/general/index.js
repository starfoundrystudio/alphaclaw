import { h } from "preact";
import htm from "htm";
import { Gateway } from "../gateway.js";
import { Channels } from "../channels.js";
import { ChannelOperationsPanel } from "../channel-operations-panel.js";
import { Pairings } from "../pairings.js";
import { ActionButton } from "../action-button.js";
import { Google } from "../google/index.js";
import { Features } from "../features.js";
import { ApiFeaturePanel } from "../api-feature-panel.js";
import { GeneralDoctorWarning } from "../doctor/general-warning.js";
import { useGeneralTab } from "./use-general-tab.js";
import { fetchAgentVaultStatus } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

const html = htm.bind(h);

const openExternal = (url) => {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
};

const openWhatsAppQrModal = () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("alphaclaw:open-whatsapp-qr"));
};

export const GeneralTab = ({
  statusData = null,
  watchdogData = null,
  doctorStatusData = null,
  agents = [],
  doctorWarningDismissedUntilMs = 0,
  onRefreshStatuses = () => {},
  onSwitchTab = () => {},
  onNavigate = () => {},
  onOpenGmailWebhook = () => {},
  isActive = false,
  restartingGateway = false,
  onRestartGateway = () => {},
  restartSignal = 0,
  onRestartRequired = () => {},
  onDismissDoctorWarning = () => {},
  onOpenDashboardLauncher = () => {},
}) => {
  const { state, actions } = useGeneralTab({
    statusData,
    watchdogData,
    doctorStatusData,
    onRefreshStatuses,
    isActive,
    restartSignal,
  });
  // Recover from startup failures without requiring a tab switch or reload.
  // Share the vault page's cache so remounts retain the last known status.
  const { data: vaultStatusPayload, error: vaultStatusError } = usePolling(
    fetchAgentVaultStatus,
    30000,
    {
      enabled: isActive,
      cacheKey: "/api/agent-vault/status",
      dedupeInFlight: true,
    },
  );
  const vaultStatus = vaultStatusPayload?.status || null;
  const whatsappStatus = state.channels?.whatsapp || null;
  const whatsappAccounts =
    whatsappStatus?.accounts && typeof whatsappStatus.accounts === "object"
      ? whatsappStatus.accounts
      : {};
  const hasWhatsAppAwaitingPairing =
    Object.keys(whatsappAccounts).length > 0
      ? Object.values(whatsappAccounts).some(
          (account) => account && account.status !== "paired",
        )
      : String(whatsappStatus?.status || "").trim() === "configured";
  const showWhatsAppPairingCard =
    state.hasUnpaired &&
    !state.pairingStatusRefreshing &&
    Array.isArray(state.pending) &&
    state.pending.length === 0 &&
    hasWhatsAppAwaitingPairing;
  const showPairings =
    state.hasUnpaired ||
    (Array.isArray(state.pending) && state.pending.length > 0) ||
    state.pairingStatusRefreshing;

  return html`
    <div class="space-y-4">
      <${Gateway}
        status=${state.gatewayStatus}
        restarting=${restartingGateway}
        onRestart=${onRestartGateway}
        watchdogStatus=${state.watchdogStatus}
        onOpenWatchdog=${() => onSwitchTab("watchdog")}
        onRepair=${actions.handleWatchdogRepair}
        repairing=${state.repairingWatchdog}
        vaultStatus=${vaultStatus}
        vaultStatusError=${vaultStatusError}
        onOpenVault=${() => onSwitchTab("credentials")}
        onOpenVaultConsole=${() => openExternal(vaultStatus?.entryUrl)}
      />
      <${GeneralDoctorWarning}
        doctorStatus=${state.doctorStatus}
        dismissedUntilMs=${doctorWarningDismissedUntilMs}
        onOpenDoctor=${() => onSwitchTab("doctor")}
        onDismiss=${onDismissDoctorWarning}
      />
      <${ChannelOperationsPanel}
        channelsSection=${html`
          <${Channels}
            channels=${state.channels}
            agents=${agents}
            onNavigate=${onNavigate}
            onRefreshStatuses=${onRefreshStatuses}
            onRestartGateway=${onRestartGateway}
          />
        `}
        pairingsSection=${html`
          ${showWhatsAppPairingCard
            ? html`
                <div class="bg-surface border border-border rounded-xl p-4">
                  <h2 class="card-label mb-3">Pending Pairings</h2>
                  <div class="text-center py-4 space-y-3">
                    <img
                      src="/assets/icons/whatsapp.svg"
                      alt=""
                      class="w-10 h-10 mx-auto"
                      aria-hidden="true"
                    />
                    <p class="text-body text-sm font-medium">WhatsApp needs to be linked</p>
                    <p class="text-fg-dim text-xs">Scan the QR code to finish pairing this channel.</p>
                    <${ActionButton}
                      onClick=${openWhatsAppQrModal}
                      tone="primary"
                      size="sm"
                      idleLabel="Open QR Code"
                    />
                  </div>
                </div>
              `
            : html`
                <${Pairings}
                  pending=${state.pending}
                  channels=${state.channels}
                  visible=${showPairings}
                  pollingInFlight=${state.pairingsPolling}
                  statusRefreshing=${state.pairingStatusRefreshing}
                  onApprove=${actions.handleApprove}
                  onReject=${actions.handleReject}
                />
              `}
        `}
      />
      <${Features} onSwitchTab=${onSwitchTab} />
      <${Google}
        gatewayStatus=${state.gatewayStatus}
        onRestartRequired=${onRestartRequired}
        onOpenGmailWebhook=${onOpenGmailWebhook}
      />
      <${ApiFeaturePanel}
        openAiCompatApi=${state.openAiCompatApi}
        savingOpenAiCompatApi=${state.savingOpenAiCompatApi}
        onToggleOpenAiCompatApi=${actions.handleOpenAiCompatApiToggle}
      />

      <div class="bg-surface border border-border rounded-xl p-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="font-semibold text-sm">Advanced OpenClaw controls</h2>
            <p class="mt-1 text-xs text-fg-muted">
              Clawbridge is TeamYou's supported managed interface. The upstream Control UI is optional advanced access and is not required for managed workflows.
            </p>
          </div>
          <${ActionButton}
            onClick=${onOpenDashboardLauncher}
            tone="secondary"
            size="sm"
            idleLabel="Review access"
          />
        </div>
      </div>
    </div>
  `;
};
