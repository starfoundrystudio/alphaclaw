import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import {
  fetchComposioStatus,
  linkComposioToolkit,
  refreshComposioStatus,
} from "../../lib/api.js";
import { ActionButton } from "../action-button.js";
import { RowAccessorySelect } from "../row-accessory-select.js";
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

const kLinkPollIntervalMs = 5000;
const kLinkPollMaxAttempts = 36; // ~3 minutes

export const ComposioPanel = () => {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [linkToolkit, setLinkToolkit] = useState("gmail");
  const [linkState, setLinkState] = useState({
    busy: false,
    waiting: false,
    redirectUrl: "",
  });
  const pollTimerRef = useRef(null);

  const stopLinkPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopLinkPolling, [stopLinkPolling]);

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

  const countLinkedForToolkit = (data, toolkit) =>
    (Array.isArray(data?.googleAccounts) ? data.googleAccounts : []).filter(
      (account) =>
        String(account.toolkit || "").replace(/[_-]/g, "") ===
        String(toolkit || "").replace(/[_-]/g, ""),
    ).length;

  const pollForLinkedAccount = useCallback(
    ({ toolkit, baselineCount, attempt = 0 }) => {
      if (attempt >= kLinkPollMaxAttempts) {
        setLinkState((prev) => ({ ...prev, waiting: false }));
        showToast(
          "Timed out waiting for the account link — finish authorizing, then hit Refresh",
          "error",
        );
        return;
      }
      pollTimerRef.current = setTimeout(async () => {
        try {
          const data = await refreshComposioStatus();
          if (data?.ok) {
            setStatus(data);
            if (countLinkedForToolkit(data, toolkit) > baselineCount) {
              setLinkState({ busy: false, waiting: false, redirectUrl: "" });
              showToast(`${toolkit} account linked`, "success");
              return;
            }
          }
        } catch {}
        pollForLinkedAccount({ toolkit, baselineCount, attempt: attempt + 1 });
      }, kLinkPollIntervalMs);
    },
    [],
  );

  const handleLink = async () => {
    const toolkit = linkToolkit;
    stopLinkPolling();
    setLinkState({ busy: true, waiting: false, redirectUrl: "" });
    try {
      const data = await linkComposioToolkit(toolkit);
      if (!data?.ok || !data.redirectUrl) {
        throw new Error(data?.error || "Could not start the link flow");
      }
      const popup = window.open(
        data.redirectUrl,
        "composio-link",
        "width=520,height=720",
      );
      if (!popup) {
        showToast("Popup blocked — use the authorization link below", "info");
      }
      setLinkState({ busy: false, waiting: true, redirectUrl: data.redirectUrl });
      pollForLinkedAccount({
        toolkit,
        baselineCount: countLinkedForToolkit(status, toolkit),
      });
    } catch (err) {
      setLinkState({ busy: false, waiting: false, redirectUrl: "" });
      showToast(err.message || "Could not start the link flow", "error");
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
              label=${status?.loggedIn
                ? `Authenticated${status?.account?.email ? ` as ${status.account.email}` : ""}`
                : "Not authenticated"}
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
                No Google Workspace accounts linked yet.
              </p>
            `}
      </div>

      ${status?.cliInstalled && status?.loggedIn
        ? html`
            <div class="rounded-lg border border-border bg-field px-3 py-3 space-y-2">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-medium">Link an account</span>
                <div class="flex items-center gap-2">
                  <${RowAccessorySelect}
                    ariaLabel="Toolkit to link"
                    value=${linkToolkit}
                    disabled=${linkState.busy || linkState.waiting}
                    onChange=${(value) => setLinkToolkit(value)}
                  >
                    ${(Array.isArray(status?.googleToolkits)
                      ? status.googleToolkits
                      : []
                    ).map(
                      (toolkit) => html`
                        <option value=${toolkit}>
                          ${kToolkitLabels[toolkit] || toolkit}
                        </option>
                      `,
                    )}
                  </${RowAccessorySelect}>
                  <${ActionButton}
                    onClick=${handleLink}
                    tone="primary"
                    size="sm"
                    idleLabel=${linkState.busy ? "Starting…" : "Link"}
                    disabled=${linkState.busy || linkState.waiting}
                  />
                </div>
              </div>
              ${linkState.waiting
                ? html`
                    <p class="text-xs text-fg-muted">
                      Waiting for authorization to complete… Finish the Google
                      sign-in in the popup${linkState.redirectUrl
                        ? html`<span> or </span><a
                              href=${linkState.redirectUrl}
                              target="_blank"
                              rel="noreferrer"
                              class="underline"
                              >open the authorization link</a
                            >`
                        : null}.
                      This panel updates automatically once the account is
                      linked.
                    </p>
                  `
                : null}
            </div>
          `
        : status?.cliInstalled
          ? html`
              <p class="text-xs text-fg-muted">
                The Composio CLI is not authenticated. Run
                <code>composio login</code> on this deployment (or set
                <code>COMPOSIO_API_KEY</code>), then refresh.
              </p>
            `
          : null}
    </div>
  `;
};
