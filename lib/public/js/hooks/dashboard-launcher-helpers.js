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
export const kOpenClawDeviceIdentityStorageKey = "openclaw-device-identity-v1";
export const kOpenClawDeviceAuthStorageKey = "openclaw.device.auth.v1";
export const kReadableOpenClawOperatorScopes = [
  "operator.read",
  "operator.write",
  "operator.admin",
];

const parseStorageJson = (storage, key) => {
  try {
    const raw = storage?.getItem?.(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const hasReadableOperatorScope = (scopes = []) =>
  Array.isArray(scopes) &&
  scopes.some((scope) => kReadableOpenClawOperatorScopes.includes(scope));

export const readOpenClawBrowserAuthState = (storage) => {
  const resolvedStorage =
    storage ||
    (typeof window !== "undefined" ? window.localStorage : undefined);
  const identity = parseStorageJson(
    resolvedStorage,
    kOpenClawDeviceIdentityStorageKey,
  );
  const auth = parseStorageJson(resolvedStorage, kOpenClawDeviceAuthStorageKey);
  const deviceId = typeof identity?.deviceId === "string" ? identity.deviceId : "";
  const publicKey = typeof identity?.publicKey === "string" ? identity.publicKey : "";
  const privateKey = typeof identity?.privateKey === "string" ? identity.privateKey : "";
  const authDeviceId = typeof auth?.deviceId === "string" ? auth.deviceId : "";
  const operatorToken = auth?.tokens?.operator;
  const token = typeof operatorToken?.token === "string" ? operatorToken.token : "";
  const scopes = Array.isArray(operatorToken?.scopes) ? operatorToken.scopes : [];
  const hasMatchingIdentity =
    identity?.version === 1 &&
    auth?.version === 1 &&
    Boolean(deviceId) &&
    deviceId === authDeviceId &&
    Boolean(publicKey) &&
    Boolean(privateKey);
  const hasOperatorToken =
    hasMatchingIdentity && Boolean(token) && hasReadableOperatorScope(scopes);

  return {
    deviceId,
    hasOperatorToken,
    scopes,
  };
};

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

export const shouldAutoCloseLauncherForOperatorToken = ({
  hasOperatorToken = false,
  ignorePreexistingOperatorToken = false,
} = {}) => hasOperatorToken === true && ignorePreexistingOperatorToken !== true;
