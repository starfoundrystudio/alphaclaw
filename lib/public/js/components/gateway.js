import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import htm from "htm";
import { Tooltip } from "./tooltip.js";
import { UpdateActionButton } from "./update-action-button.js";
const html = htm.bind(h);

const kRowTooltips = {
  gateway:
    "The process that runs your agents and connects them to your channels.",
  watchdog:
    "Watches the gateway and repairs it automatically if it becomes unhealthy.",
  vault:
    "Secure storage for your tokens and API keys. Values stay in the vault and are never saved on this server.",
};

const formatDuration = (ms) => {
  const safeMs = Number(ms || 0);
  if (!Number.isFinite(safeMs) || safeMs <= 0) return "0s";
  const totalSeconds = Math.floor(safeMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours % 24}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

export const Gateway = ({
  status,
  restarting = false,
  onRestart,
  watchdogStatus = null,
  onOpenWatchdog,
  onRepair,
  repairing = false,
  vaultStatus = null,
  onOpenVault,
  onOpenVaultConsole,
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isRunning = status === "running" && !restarting;
  const dotClass = isRunning
    ? "ac-status-dot ac-status-dot--healthy"
    : "w-2 h-2 rounded-full bg-yellow-500 animate-pulse";
  const watchdogHealth =
    watchdogStatus?.lifecycle === "crash_loop"
      ? "crash_loop"
      : watchdogStatus?.health;
  const watchdogDotClass =
    watchdogHealth === "healthy"
      ? "ac-status-dot ac-status-dot--healthy ac-status-dot--healthy-offset"
      : watchdogHealth === "degraded"
        ? "bg-yellow-500"
        : watchdogHealth === "unhealthy" || watchdogHealth === "crash_loop"
          ? "bg-red-500"
          : "bg-gray-500";
  const watchdogLabel =
    watchdogHealth === "unknown" ? "initializing" : watchdogHealth || "unknown";
  const isRepairInProgress = repairing || !!watchdogStatus?.operationInProgress;
  const showInspectButton = watchdogHealth === "degraded" && !!onOpenWatchdog;
  const showRepairButton =
    isRepairInProgress ||
    (watchdogStatus?.health === "degraded" && !onOpenWatchdog) ||
    watchdogStatus?.lifecycle === "crash_loop" ||
    watchdogStatus?.health === "unhealthy" ||
    watchdogStatus?.health === "crashed";
  // Agent Vault only renders once the instance is vault-managed (mode is
  // "disabled" on self-hosted instances without a vault). "Unavailable" is
  // real signal: with the vault down, brokered channel and model traffic
  // fails closed.
  const showVaultRow =
    !!vaultStatus &&
    (vaultStatus.mode !== "disabled" || vaultStatus.ownerEnrollmentPending);
  const vaultHealth = vaultStatus?.connected
    ? "connected"
    : vaultStatus?.ownerEnrollmentPending
      ? "setup required"
      : "unavailable";
  const vaultDotClass =
    vaultHealth === "connected"
      ? "ac-status-dot ac-status-dot--healthy ac-status-dot--healthy-offset"
      : vaultHealth === "setup required"
        ? "bg-yellow-500"
        : "bg-red-500";
  const liveUptimeMs = useMemo(() => {
    const startedAtMs = watchdogStatus?.uptimeStartedAt
      ? Date.parse(watchdogStatus.uptimeStartedAt)
      : null;
    if (Number.isFinite(startedAtMs)) {
      return Math.max(0, nowMs - startedAtMs);
    }
    return watchdogStatus?.uptimeMs || 0;
  }, [watchdogStatus?.uptimeStartedAt, watchdogStatus?.uptimeMs, nowMs]);

  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return html` <div class="bg-surface border border-border rounded-xl p-4">
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-3">
        <${Tooltip} text=${kRowTooltips.gateway} delay=${300}>
          <div class="min-w-0 flex items-center gap-2 text-sm">
            <span class=${dotClass}></span>
            <span class="font-semibold">Gateway:</span>
            <span class="text-fg-muted"
              >${restarting ? "restarting..." : status || "checking..."}</span
            >
          </div>
        </${Tooltip}>
        <div class="flex items-center gap-3 shrink-0">
          ${!restarting && isRunning
            ? html`
                <span class="text-xs text-fg-muted whitespace-nowrap"
                  >Uptime: ${formatDuration(liveUptimeMs)}</span
                >
              `
            : null}
          <${UpdateActionButton}
            onClick=${onRestart}
            disabled=${!status}
            loading=${restarting}
            warning=${false}
            idleLabel="Restart"
            loadingLabel="On it..."
          />
        </div>
      </div>
      <div class="flex items-center justify-between gap-3">
        ${onOpenWatchdog
          ? html`
              <${Tooltip} text=${kRowTooltips.watchdog} delay=${300}>
                <button
                  class="inline-flex items-center gap-2 text-sm hover:opacity-90"
                  onclick=${onOpenWatchdog}
                >
                  <span
                    class=${watchdogDotClass.startsWith("ac-status-dot")
                      ? watchdogDotClass
                      : `w-2 h-2 rounded-full ${watchdogDotClass}`}
                  ></span>
                  <span class="font-semibold">Watchdog:</span>
                  <span class="text-fg-muted">${watchdogLabel}</span>
                </button>
              </${Tooltip}>
            `
          : html`
              <${Tooltip} text=${kRowTooltips.watchdog} delay=${300}>
                <div class="inline-flex items-center gap-2 text-sm">
                  <span
                    class=${watchdogDotClass.startsWith("ac-status-dot")
                      ? watchdogDotClass
                      : `w-2 h-2 rounded-full ${watchdogDotClass}`}
                  ></span>
                  <span class="font-semibold">Watchdog:</span>
                  <span class="text-fg-muted">${watchdogLabel}</span>
                </div>
              </${Tooltip}>
            `}
        ${onRepair
          ? html`
              <div class="shrink-0 w-32 flex justify-end">
                ${showInspectButton
                  ? html`
                      <${UpdateActionButton}
                        onClick=${onOpenWatchdog}
                        warning=${false}
                        idleLabel="Inspect"
                        loadingLabel="Inspect"
                        className="w-full justify-center"
                      />
                    `
                  : showRepairButton
                    ? html`
                        <${UpdateActionButton}
                          onClick=${onRepair}
                          loading=${isRepairInProgress}
                          warning=${true}
                          idleLabel="Repair"
                          loadingLabel="Repairing..."
                          className="w-full justify-center"
                        />
                      `
                    : html`<span
                        class="inline-flex h-7 w-full"
                        aria-hidden="true"
                      ></span>`}
              </div>
            `
          : null}
      </div>
      ${showVaultRow
        ? html`
            <div class="flex items-center justify-between gap-3">
              <${Tooltip} text=${kRowTooltips.vault} delay=${300}>
                <button
                  class="inline-flex items-center gap-2 text-sm hover:opacity-90"
                  onclick=${onOpenVault}
                >
                  <span
                    class=${vaultDotClass.startsWith("ac-status-dot")
                      ? vaultDotClass
                      : `w-2 h-2 rounded-full ${vaultDotClass}`}
                  ></span>
                  <span class="font-semibold">Agent Vault:</span>
                  <span class="text-fg-muted">${vaultHealth}</span>
                </button>
              </${Tooltip}>
              ${vaultStatus?.entryUrl && onOpenVaultConsole
                ? html`
                    <${UpdateActionButton}
                      onClick=${onOpenVaultConsole}
                      warning=${false}
                      idleLabel="Open"
                      loadingLabel="Open"
                    />
                  `
                : null}
            </div>
          `
        : null}
    </div>
  </div>`;
};
