// OAuth popup result pages report back with window.opener.postMessage, but
// any window holding a reference to the dashboard (for example a page that
// window.open()ed it) can post the same payloads. Listeners accept a result
// only when it comes from a popup the dashboard opened and was sent from an
// origin that serves the popup's result page.

export const getUrlOrigin = (value = "") => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const { origin } = new URL(raw);
    return origin && origin !== "null" ? origin : "";
  } catch {
    return "";
  }
};

export const isTrustedPopupMessage = (
  event,
  { popups = [], allowedOrigins = [] } = {},
) => {
  const source = event?.source;
  if (!source || !popups.some((popup) => popup && popup === source)) {
    return false;
  }
  const origin = String(event.origin || "");
  if (!origin || origin === "null") return false;
  return allowedOrigins.some((allowed) => allowed && allowed === origin);
};
