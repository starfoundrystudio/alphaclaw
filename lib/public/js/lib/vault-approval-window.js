// Agent Vault approval pages are only known after an async proposal request,
// and browsers block window.open() once the click's user gesture has been
// spent on that await. Open a blank tab synchronously inside the click, then
// route it to the approval URL when the proposal comes back — one click, no
// intermediate "Open approval page" button.

// Must be called synchronously from a click handler. Returns null when the
// browser blocks the tab; callers fall back to a manual open button.
export const openVaultApprovalWindow = () => {
  if (typeof window === "undefined" || typeof window.open !== "function") {
    return null;
  }
  const popup = window.open("about:blank", "_blank");
  if (!popup || popup.closed) return null;
  try {
    // Same effect as "noopener" (which would make window.open return null):
    // the approval page gets no handle back to this app.
    popup.opener = null;
    popup.document.title = "Agent Vault";
    popup.document.body.style.margin = "0";
    popup.document.body.style.background = "#0b111b";
    popup.document.body.style.color = "#d7dde8";
    popup.document.body.style.fontFamily =
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    popup.document.body.innerHTML =
      '<div style="box-sizing:border-box;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px;text-align:center;"><p style="font-size:14px;margin:0;">Opening the Agent Vault approval page...</p></div>';
  } catch {}
  return popup;
};

export const closeVaultApprovalWindow = (popup) => {
  if (!popup || popup.closed) return;
  try {
    popup.close();
  } catch {}
};

// Sends the pre-opened tab to the approval page. Returns false (and closes
// the blank tab) when there is no tab or no URL, so the caller can keep a
// manual open button visible.
export const routeVaultApprovalWindow = (popup, url) => {
  const approvalUrl = String(url || "").trim();
  if (!popup || popup.closed || !approvalUrl) {
    closeVaultApprovalWindow(popup);
    return false;
  }
  try {
    popup.location.replace(approvalUrl);
    popup.focus?.();
    return true;
  } catch {
    closeVaultApprovalWindow(popup);
    return false;
  }
};
