import { isTrustedPopupMessage } from "./oauth-popup-message.js";

const kCodexAuthStartPath = "/auth/codex/start";
const kCodexAuthWindowName = "codex-auth";
const kCodexAuthPopupFeatures = "popup=yes,width=640,height=780";
const kCodexAuthCallbackMessageType = "callback-input";

// Reopening the named window returns the same window, so one handle covers
// every Codex auth attempt from this page.
let codexAuthPopup = null;

// When the popup is blocked, return null instead of navigating the current
// page away — callers keep their state and show a manual sign-in link.
export const openCodexAuthWindow = () => {
  const popup = window.open(
    kCodexAuthStartPath,
    kCodexAuthWindowName,
    kCodexAuthPopupFeatures,
  );
  if (!popup || popup.closed) return null;
  codexAuthPopup = popup;
  return popup;
};

export { kCodexAuthStartPath };

// The Codex result page is served from the dashboard origin and posts to
// window.location.origin, so only same-origin messages from the popup count.
export const isCodexAuthPopupMessage = (event) =>
  isTrustedPopupMessage(event, {
    popups: [codexAuthPopup],
    allowedOrigins: [window.location.origin],
  });

export const isCodexAuthCallbackMessage = (value) =>
  value?.codex === kCodexAuthCallbackMessageType &&
  typeof value.input === "string" &&
  value.input.trim().length > 0;
