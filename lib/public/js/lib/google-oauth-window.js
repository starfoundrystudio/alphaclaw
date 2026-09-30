import { getUrlOrigin, isTrustedPopupMessage } from "./oauth-popup-message.js";

const kGoogleAuthPopupFeatures = "popup=yes,width=500,height=700";

// Each account signs in through its own named popup, and several can be open
// at once, so every live handle is kept until its window closes.
const kGoogleAuthPopups = new Set();

const pruneClosedPopups = () => {
  for (const popup of kGoogleAuthPopups) {
    if (!popup || popup.closed) kGoogleAuthPopups.delete(popup);
  }
};

// Returns null when the browser blocks the popup; the caller decides whether
// to fall back to a full-page redirect.
export const openGoogleAuthWindow = (authUrl, accountId = "") => {
  const popup = window.open(
    authUrl,
    `google-auth-${accountId}`,
    kGoogleAuthPopupFeatures,
  );
  if (!popup || popup.closed) return null;
  pruneClosedPopups();
  kGoogleAuthPopups.add(popup);
  return popup;
};

// /auth/google/callback is served from the public callback host, which can
// differ from the dashboard origin, so both origins are accepted.
export const isGoogleAuthPopupMessage = (
  event,
  { publicCallbackBaseUrl = "" } = {},
) =>
  isTrustedPopupMessage(event, {
    popups: [...kGoogleAuthPopups],
    allowedOrigins: [
      window.location.origin,
      getUrlOrigin(publicCallbackBaseUrl),
    ],
  });
