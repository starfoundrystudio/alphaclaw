export const kDashboardLauncherStatuses = {
  IDLE: "idle",
  LOADING: "loading",
  READY: "ready",
  OPENING: "opening",
  WAITING: "waiting",
  REQUEST: "request",
  APPROVED: "approved",
  TIMEOUT: "timeout",
  TOKEN_MISSING: "tokenMissing",
  ERROR: "error",
};

export const kDashboardPairingTimeoutMs = 90 * 1000;

export const isDashboardBrowserPairing = (device = {}) => {
  const clientId = String(device?.clientId || "").toLowerCase();
  const clientMode = String(device?.clientMode || "").toLowerCase();
  return clientId === "openclaw-control-ui" || clientMode === "webchat";
};

export const getDashboardBrowserPairings = (pending = []) =>
  (Array.isArray(pending) ? pending : []).filter(isDashboardBrowserPairing);

export const getPrimaryDashboardPairing = (pending = []) =>
  getDashboardBrowserPairings(pending)[0] || null;

export const getDashboardUrlState = (payload = {}) => {
  if (payload?.needsAuth) {
    return {
      status: kDashboardLauncherStatuses.TOKEN_MISSING,
      url: String(payload?.url || ""),
    };
  }
  return {
    status: kDashboardLauncherStatuses.READY,
    url: String(payload?.url || "/openclaw"),
  };
};

export const hasDashboardPairingTimedOut = ({
  status = "",
  startedAtMs = 0,
  nowMs = Date.now(),
  timeoutMs = kDashboardPairingTimeoutMs,
} = {}) =>
  status === kDashboardLauncherStatuses.WAITING &&
  Number(startedAtMs) > 0 &&
  Number(nowMs) - Number(startedAtMs) >= Number(timeoutMs);
