import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import {
  disableComposioGmailWatch,
  enableComposioGmailWatch,
  fetchComposioStatus,
  linkComposioToolkit,
  refreshComposioStatus,
  startComposioLogin,
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

  // If the CLI is missing (e.g. the provider was just switched to Composio),
  // trigger a refresh once — the server starts a background install — then
  // poll while it runs.
  const installKickRef = useRef(false);
  useEffect(() => {
    if (!status) return;
    if (status.cliInstalled || status.cliInstalling) return;
    if (installKickRef.current) return;
    installKickRef.current = true;
    refreshComposioStatus()
      .then((data) => {
        if (data?.ok) setStatus(data);
      })
      .catch(() => {});
  }, [status]);

  useEffect(() => {
    if (!status?.cliInstalling) return undefined;
    const timer = setTimeout(loadStatus, 3000);
    return () => clearTimeout(timer);
  }, [status, loadStatus]);

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

  const [watchBusy, setWatchBusy] = useState(false);

  const handleToggleGmailWatch = async () => {
    const enabled = Boolean(status?.gmailWatch?.enabled);
    setWatchBusy(true);
    try {
      const data = enabled
        ? await disableComposioGmailWatch()
        : await enableComposioGmailWatch();
      if (!data?.ok) throw new Error(data?.error || "Request failed");
      setStatus((prev) => ({ ...prev, gmailWatch: data.gmailWatch }));
      showToast(
        enabled ? "Email notifications disabled" : "Email notifications enabled",
        "success",
      );
    } catch (err) {
      showToast(err.message || "Could not update email notifications", "error");
    } finally {
      setWatchBusy(false);
    }
  };

  const [signIn, setSignIn] = useState({ busy: false, waiting: false, loginUrl: "" });

  const handleSignIn = async () => {
    setSignIn({ busy: true, waiting: false, loginUrl: "" });
    try {
      const data = await startComposioLogin();
      if (!data?.ok || !data.loginUrl) {
        throw new Error(data?.error || "Could not start Composio sign-in");
      }
      const popup = window.open(
        data.loginUrl,
        "composio-login",
        "width=520,height=720",
      );
      if (!popup) {
        showToast("Popup blocked — use the sign-in link below", "info");
      }
      setSignIn({ busy: false, waiting: true, loginUrl: data.loginUrl });
    } catch (err) {
      setSignIn({ busy: false, waiting: false, loginUrl: "" });
      showToast(err.message || "Could not start Composio sign-in", "error");
    }
  };

  // While a sign-in is pending server-side, keep the status fresh; when the
  // session lands, clear the waiting state and confirm.
  useEffect(() => {
    if (!signIn.waiting) return undefined;
    if (status?.loggedIn) {
      setSignIn({ busy: false, waiting: false, loginUrl: "" });
      showToast(
        `Signed in to Composio${status?.account?.email ? ` as ${status.account.email}` : ""}`,
        "success",
      );
      return undefined;
    }
    const timer = setTimeout(loadStatus, 3000);
    return () => clearTimeout(timer);
  }, [signIn.waiting, status, loadStatus]);

  const handleLink = async () => {
    const toolkit = linkToolkit;
    stopLinkPolling();
    setLinkState({ busy: true, waiting: false, redirectUrl: "" });
    try {
      // The CLI requires an alias when a toolkit already has a linked
      // account; auto-generate a recognizable one for additional links.
      const existingCount = countLinkedForToolkit(status, toolkit);
      const alias = existingCount
        ? `${toolkit}-${Math.random().toString(16).slice(2, 6)}`
        : "";
      const data = await linkComposioToolkit(toolkit, { alias });
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
              label=${status?.cliInstalled
                ? "CLI installed"
                : status?.cliInstalling
                  ? "Installing CLI…"
                  : "CLI not installed"}
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
              ${status?.cliInstalling
                ? "Installing the Composio CLI — this usually takes under a minute. This panel updates automatically."
                : status?.installError
                  ? html`Automatic install failed:
                      <span class="text-status-error">${status.installError}</span>
                      — hit Refresh to retry.`
                  : "The Composio CLI will be installed automatically — hit Refresh if this doesn't start on its own."}
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

      ${googleAccounts.some((account) =>
        String(account.toolkit || "").replace(/[_-]/g, "") === "gmail",
      )
        ? html`
            <div class="rounded-lg border border-border bg-field px-3 py-3 space-y-2">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-medium">Email notifications</span>
                  <${StatusDot}
                    ok=${Boolean(status?.gmailWatch?.running)}
                    label=${status?.gmailWatch?.running
                      ? "Listening"
                      : status?.gmailWatch?.enabled
                        ? "Enabled (not running)"
                        : "Off"}
                  />
                </div>
                <${ActionButton}
                  onClick=${handleToggleGmailWatch}
                  tone=${status?.gmailWatch?.enabled ? "secondary" : "primary"}
                  size="sm"
                  idleLabel=${watchBusy
                    ? "Working…"
                    : status?.gmailWatch?.enabled
                      ? "Disable"
                      : "Enable"}
                  disabled=${watchBusy}
                />
              </div>
              <p class="text-xs text-fg-muted">
                Wakes your agent when new email arrives (checked every ~2
                minutes via Composio). No Google Cloud setup required.
              </p>
              ${status?.gmailWatch?.lastError
                ? html`<p class="text-xs text-status-error">
                    ${status.gmailWatch.lastError}
                  </p>`
                : null}
            </div>
          `
        : null}

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
                    idleLabel=${linkState.busy
                      ? "Starting…"
                      : countLinkedForToolkit(status, linkToolkit)
                        ? "Link another"
                        : "Link"}
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
              <div class="rounded-lg border border-border bg-field px-3 py-3 space-y-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs font-medium">Composio account</span>
                  <${ActionButton}
                    onClick=${handleSignIn}
                    tone="primary"
                    size="sm"
                    idleLabel=${signIn.busy
                      ? "Starting…"
                      : signIn.waiting
                        ? "Waiting…"
                        : "Sign in to Composio"}
                    disabled=${signIn.busy || signIn.waiting}
                  />
                </div>
                ${signIn.waiting
                  ? html`
                      <p class="text-xs text-fg-muted">
                        Finish signing in to Composio in the popup${signIn.loginUrl
                          ? html`<span> or </span><a
                                href=${signIn.loginUrl}
                                target="_blank"
                                rel="noreferrer"
                                class="underline"
                                >open the sign-in link</a
                              >`
                          : null}.
                        This panel updates automatically once you're signed in.
                      </p>
                    `
                  : html`
                      <p class="text-xs text-fg-muted">
                        Sign in with your Composio account to link Google
                        Workspace — no API keys to copy.
                      </p>
                    `}
                ${status?.loginError && !signIn.waiting
                  ? html`<p class="text-xs text-status-error">${status.loginError}</p>`
                  : null}
              </div>
            `
          : null}
    </div>
  `;
};
