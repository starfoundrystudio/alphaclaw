import { h } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import htm from "htm";
import { fetchComposioStatus, refreshComposioStatus } from "../../lib/api.js";
import { ActionButton } from "../action-button.js";
import { showToast } from "../toast.js";

const html = htm.bind(h);

const kToolkitLabels = {
  gmail: "Gmail",
  googlecalendar: "Calendar",
  googledrive: "Drive",
  googlesheets: "Sheets",
  googledocs: "Docs",
  googletasks: "Tasks",
  googlemeet: "Meet",
};

const StatusDot = ({ ok, label }) => html`
  <span class="inline-flex items-center gap-1.5 text-xs">
    <span
      class=${`h-2 w-2 rounded-full ${ok ? "bg-status-success" : "bg-fg-muted"}`}
    ></span>
    ${label}
  </span>
`;

export const ComposioPanel = () => {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchComposioStatus();
      if (data?.ok) setStatus(data);
    } catch {
      // Panel stays in loading/empty state; refresh button still works.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const data = await refreshComposioStatus();
      if (data?.ok) {
        setStatus(data);
        showToast("Composio status refreshed", "success");
      } else {
        showToast(data?.error || "Could not refresh Composio status", "error");
      }
    } catch (err) {
      showToast(err.message || "Could not refresh Composio status", "error");
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return html`<p class="text-xs text-fg-muted pt-3">Loading Composio status…</p>`;
  }

  const googleAccounts = Array.isArray(status?.googleAccounts)
    ? status.googleAccounts
    : [];

  return html`
    <div class="space-y-3 pt-3">
      <div class="rounded-lg border border-border bg-field px-3 py-3 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-3">
            <${StatusDot}
              ok=${Boolean(status?.cliInstalled)}
              label=${status?.cliInstalled ? "CLI installed" : "CLI not installed"}
            />
            <${StatusDot}
              ok=${Boolean(status?.apiKeyConfigured)}
              label=${status?.apiKeyConfigured
                ? "API key configured"
                : "No API key"}
            />
            <${StatusDot}
              ok=${Boolean(status?.loggedIn)}
              label=${status?.loggedIn ? "Authenticated" : "Not authenticated"}
            />
          </div>
          <${ActionButton}
            onClick=${handleRefresh}
            tone="subtle"
            size="sm"
            idleLabel=${refreshing ? "Refreshing…" : "Refresh"}
            disabled=${refreshing}
          />
        </div>
        ${status?.lastError
          ? html`<p class="text-xs text-status-error">${status.lastError}</p>`
          : null}
      </div>

      ${!status?.cliInstalled
        ? html`
            <p class="text-xs text-fg-muted">
              The Composio CLI is installed automatically at startup when
              Composio is the active provider. Restart AlphaClaw, or install it
              manually with
              <code>curl -fsSL https://composio.dev/install | bash</code>.
            </p>
          `
        : null}
      ${status?.cliInstalled && !status?.apiKeyConfigured
        ? html`
            <p class="text-xs text-fg-muted">
              Set <code>COMPOSIO_API_KEY</code> in the Envars tab so the agent
              and this dashboard can use Composio non-interactively.
            </p>
          `
        : null}

      <div>
        <h3 class="text-xs font-medium pb-1">Linked Google Workspace accounts</h3>
        ${googleAccounts.length
          ? html`
              <ul class="space-y-1">
                ${googleAccounts.map(
                  (account) => html`
                    <li
                      class="flex items-center justify-between rounded border border-border px-2 py-1.5 text-xs"
                    >
                      <span>
                        ${kToolkitLabels[account.toolkit] || account.toolkit}
                        ${account.label
                          ? html` <span class="text-fg-muted">${account.label}</span>`
                          : null}
                      </span>
                      <span class="text-fg-muted">${account.status || "ACTIVE"}</span>
                    </li>
                  `,
                )}
              </ul>
            `
          : html`
              <p class="text-xs text-fg-muted">
                No Google Workspace accounts linked yet. From a terminal on this
                deployment, run
                <code>composio connected-accounts link gmail</code> (or
                <code>googlecalendar</code>, <code>googledrive</code>, …), then
                refresh.
              </p>
            `}
      </div>
    </div>
  `;
};
