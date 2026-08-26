const kCodexAuthStartPath = "/auth/codex/start";
const kCodexAuthWindowName = "codex-auth";
const kCodexAuthPopupFeatures = "popup=yes,width=640,height=780";
const kCodexAuthCallbackMessageType = "callback-input";

// When the popup is blocked, return null instead of navigating the current
// page away — callers keep their state and show a manual sign-in link.
export const openCodexAuthWindow = () => {
  const popup = window.open(
    kCodexAuthStartPath,
    kCodexAuthWindowName,
    kCodexAuthPopupFeatures,
  );
  if (!popup || popup.closed) return null;
  return popup;
};

export { kCodexAuthStartPath };

export const isCodexAuthCallbackMessage = (value) =>
  value?.codex === kCodexAuthCallbackMessageType &&
  typeof value.input === "string" &&
  value.input.trim().length > 0;
