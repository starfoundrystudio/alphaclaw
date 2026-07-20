import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../../action-button.js";
import { Badge } from "../../badge.js";
import { LoadingSpinner } from "../../loading-spinner.js";
import { ChangeTailnetModal } from "./change-tailnet-modal.js";
import { useTailnetChange } from "./use-tailnet-change.js";

const html = htm.bind(h);

const kActiveStates = new Set([
  "queued",
  "switching",
  "verifying",
  "configuring_exposure",
  "attention_required",
]);

const getChangeBadge = (change) => {
  const state = String(change?.state || "idle");
  if (state === "attention_required") {
    return { tone: "warning", label: "Check status" };
  }
  if (kActiveStates.has(state)) return { tone: "warning", label: "Changing" };
  if (state === "completed") return { tone: "success", label: "Changed" };
  if (state === "completed_with_warnings") {
    return { tone: "warning", label: "Changed with warnings" };
  }
  if (["failed", "rolled_back", "rollback_failed"].includes(state)) {
    return { tone: "danger", label: "Needs attention" };
  }
  return { tone: "success", label: "Connected" };
};

export const TailnetCard = () => {
  const { statusQuery, state, actions } = useTailnetChange();
  const status = statusQuery.data;
  const capabilityAvailable = status?.capability?.ok === true;
  const active = kActiveStates.has(String(status?.change?.state || "idle"));
  const badge = getChangeBadge(status?.change);
  const unavailableMessage =
    status?.capability?.error ||
    "Change Tailnet requires the latest clawctl host support.";

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h2 class="font-semibold text-sm">Tailscale tailnet</h2>
            ${status ? html`<${Badge} tone=${badge.tone}>${badge.label}</${Badge}>` : null}
          </div>
          <p class="mt-1 text-xs text-fg-muted">Move this host to a replacement Tailscale account without server console access.</p>
        </div>
        <${ActionButton}
          onClick=${actions.open}
          tone="secondary"
          size="sm"
          idleLabel="Change Tailnet"
          disabled=${statusQuery.loading || !capabilityAvailable || active}
        />
      </div>

      ${statusQuery.loading && !status
        ? html`
            <div class="flex items-center gap-2 text-xs text-fg-muted">
              <${LoadingSpinner} className="h-3 w-3" />
              Checking host capability...
            </div>
          `
        : html`
            <div class="ac-surface-inset border border-border rounded-lg px-3 py-2">
              <p class="text-[11px] uppercase tracking-[0.16em] text-fg-muted">Current device</p>
              <p class="mt-1 text-sm font-mono text-body break-all">${status?.current?.currentDns || "Unavailable"}</p>
            </div>
          `}

      ${statusQuery.error
        ? html`<p class="text-xs text-status-error">${statusQuery.error.message || "Could not load Tailscale status"}</p>`
        : !statusQuery.loading && !capabilityAvailable
          ? html`<p class="text-xs text-status-warning-muted">${unavailableMessage}</p>`
          : status?.change?.error
            ? html`<p class="text-xs text-status-error">${status.change.error}</p>`
            : status?.change?.warnings?.length
              ? html`<p class="text-xs text-status-warning-muted">${status.change.warnings[0]}</p>`
            : null}

      <${ChangeTailnetModal} state=${state} actions=${actions} />
    </div>
  `;
};
