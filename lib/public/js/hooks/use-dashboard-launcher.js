import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  approveDevice,
  fetchDashboardUrl,
  fetchDevicePairings,
  rejectDevice,
} from "../lib/api.js";
import { usePolling } from "./usePolling.js";
import { showToast } from "../components/toast.js";
import {
  getDashboardBrowserPairings,
  getDashboardUrlState,
  getPrimaryDashboardPairing,
  hasDashboardPairingTimedOut,
  kDashboardLauncherStatuses,
  kDashboardPairingTimeoutMs,
  kOpenClawDeviceAuthStorageKey,
  kOpenClawDeviceIdentityStorageKey,
  readOpenClawBrowserAuthState,
  shouldAutoCloseLauncherForOperatorToken,
} from "./dashboard-launcher-helpers.js";

const kBackgroundDevicePollMs = 15000;
const kActiveDevicePollMs = 2000;
const kPairedDashboardUrl = "/openclaw";
const kOperatorTokenCloseStatuses = [
  kDashboardLauncherStatuses.OPENING,
  kDashboardLauncherStatuses.WAITING,
  kDashboardLauncherStatuses.REQUEST,
  kDashboardLauncherStatuses.APPROVED,
  kDashboardLauncherStatuses.TIMEOUT,
];

const openDashboardWindow = (url) => {
  if (typeof window === "undefined" || typeof window.open !== "function") {
    return null;
  }
  return window.open(url, "_blank");
};

export const useDashboardLauncher = ({ gatewayStatus = "" } = {}) => {
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState(kDashboardLauncherStatuses.IDLE);
  const [dashboardUrl, setDashboardUrl] = useState("");
  const [error, setError] = useState("");
  const [waitingStartedAtMs, setWaitingStartedAtMs] = useState(0);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [cliAutoApproveComplete, setCliAutoApproveComplete] = useState(false);
  const followupTimersRef = useRef([]);
  const ignorePreexistingOperatorTokenCloseRef = useRef(false);

  const isModalActive = visible && [
    kDashboardLauncherStatuses.LOADING,
    kDashboardLauncherStatuses.READY,
    kDashboardLauncherStatuses.OPENING,
    kDashboardLauncherStatuses.WAITING,
    kDashboardLauncherStatuses.REQUEST,
    kDashboardLauncherStatuses.TIMEOUT,
  ].includes(status);
  const shouldPollDevices = gatewayStatus === "running" || isModalActive;

  const devicePoll = usePolling(
    async () => {
      const data = await fetchDevicePairings();
      setCliAutoApproveComplete(data?.cliAutoApproveComplete === true);
      return data?.pending || [];
    },
    isModalActive ? kActiveDevicePollMs : kBackgroundDevicePollMs,
    {
      enabled: shouldPollDevices,
      cacheKey: "/api/devices",
      dedupeInFlight: true,
    },
  );

  const pendingDevices = devicePoll.data || [];
  const pendingBrowserPairings = useMemo(
    () => getDashboardBrowserPairings(pendingDevices),
    [pendingDevices],
  );
  const primaryBrowserPairing = useMemo(
    () => getPrimaryDashboardPairing(pendingDevices),
    [pendingDevices],
  );
  const hasBrowserPairingPending = pendingBrowserPairings.length > 0;

  const clearFollowupTimers = useCallback(() => {
    for (const timer of followupTimersRef.current) {
      clearTimeout(timer);
    }
    followupTimersRef.current = [];
  }, []);

  const scheduleDeviceRefreshes = useCallback(() => {
    clearFollowupTimers();
    followupTimersRef.current = [500, 2000].map((delay) =>
      setTimeout(() => {
        devicePoll.refresh({ force: true });
      }, delay),
    );
  }, [clearFollowupTimers, devicePoll.refresh]);

  useEffect(() => clearFollowupTimers, [clearFollowupTimers]);

  const startWaitingForPairing = useCallback(() => {
    const nextStartedAtMs = Date.now();
    setWaitingStartedAtMs(nextStartedAtMs);
    setStatus(
      primaryBrowserPairing
        ? kDashboardLauncherStatuses.REQUEST
        : kDashboardLauncherStatuses.WAITING,
    );
    devicePoll.refresh({ force: true });
  }, [devicePoll.refresh, primaryBrowserPairing]);

  useEffect(() => {
    if (!visible || !primaryBrowserPairing) return;
    if (
      [
        kDashboardLauncherStatuses.READY,
        kDashboardLauncherStatuses.WAITING,
        kDashboardLauncherStatuses.TIMEOUT,
      ].includes(status)
    ) {
      setStatus(kDashboardLauncherStatuses.REQUEST);
    }
  }, [primaryBrowserPairing, status, visible]);

  useEffect(() => {
    if (
      !visible ||
      status !== kDashboardLauncherStatuses.REQUEST ||
      primaryBrowserPairing ||
      approving ||
      rejecting
    ) {
      return;
    }
    setStatus(kDashboardLauncherStatuses.WAITING);
    setWaitingStartedAtMs(Date.now());
  }, [approving, primaryBrowserPairing, rejecting, status, visible]);

  useEffect(() => {
    if (!visible || status !== kDashboardLauncherStatuses.WAITING) return undefined;
    if (
      hasDashboardPairingTimedOut({
        status,
        startedAtMs: waitingStartedAtMs,
        timeoutMs: kDashboardPairingTimeoutMs,
      })
    ) {
      setStatus(kDashboardLauncherStatuses.TIMEOUT);
      return undefined;
    }
    const remainingMs = Math.max(
      0,
      kDashboardPairingTimeoutMs - (Date.now() - waitingStartedAtMs),
    );
    const timeoutId = setTimeout(() => {
      setStatus((currentStatus) =>
        hasDashboardPairingTimedOut({
          status: currentStatus,
          startedAtMs: waitingStartedAtMs,
          timeoutMs: kDashboardPairingTimeoutMs,
        })
          ? kDashboardLauncherStatuses.TIMEOUT
          : currentStatus,
      );
    }, remainingMs);
    return () => clearTimeout(timeoutId);
  }, [status, visible, waitingStartedAtMs]);

  const openLauncher = useCallback(async () => {
    const browserAuthState = readOpenClawBrowserAuthState();
    ignorePreexistingOperatorTokenCloseRef.current = false;
    if (!hasBrowserPairingPending && browserAuthState.hasOperatorToken) {
      ignorePreexistingOperatorTokenCloseRef.current = true;
      setVisible(true);
      setDashboardUrl(kPairedDashboardUrl);
      setError("");
      setStatus(kDashboardLauncherStatuses.OPENING);
      setWaitingStartedAtMs(0);
      try {
        // After browser approval, OpenClaw can reconnect with its stored device token.
        // Keep this synchronous with the click so browsers are less likely to block it.
        const opened = openDashboardWindow(kPairedDashboardUrl);
        if (!opened) {
          showToast(
            "Your browser blocked the OpenClaw tab. Allow popups for AlphaClaw and try again.",
            "warning",
          );
          setStatus(kDashboardLauncherStatuses.READY);
          return;
        }
        startWaitingForPairing();
        scheduleDeviceRefreshes();
        return;
      } catch (err) {
        showToast(err.message || "Could not open OpenClaw dashboard", "error");
        setStatus(kDashboardLauncherStatuses.READY);
        return;
      }
    }

    setVisible(true);
    setStatus(kDashboardLauncherStatuses.LOADING);
    setError("");
    setWaitingStartedAtMs(0);
    try {
      devicePoll.refresh({ force: true });
      const data = await fetchDashboardUrl();
      const nextState = getDashboardUrlState(data);
      setDashboardUrl(nextState.url);
      setStatus(nextState.status);
    } catch (err) {
      setError(err.message || "Could not load the OpenClaw dashboard URL");
      setStatus(kDashboardLauncherStatuses.ERROR);
    }
  }, [
    devicePoll.refresh,
    hasBrowserPairingPending,
    scheduleDeviceRefreshes,
    startWaitingForPairing,
  ]);

  const closeLauncher = useCallback(() => {
    ignorePreexistingOperatorTokenCloseRef.current = false;
    setVisible(false);
    setStatus(kDashboardLauncherStatuses.IDLE);
    setError("");
    setWaitingStartedAtMs(0);
  }, []);

  useEffect(() => {
    if (!visible || !kOperatorTokenCloseStatuses.includes(status)) {
      return undefined;
    }

    const closeIfOperatorTokenAvailable = () => {
      const authState = readOpenClawBrowserAuthState();
      if (
        shouldAutoCloseLauncherForOperatorToken({
          hasOperatorToken: authState.hasOperatorToken,
          ignorePreexistingOperatorToken:
            ignorePreexistingOperatorTokenCloseRef.current,
        })
      ) {
        closeLauncher();
        return true;
      }
      return false;
    };

    if (closeIfOperatorTokenAvailable()) {
      return undefined;
    }

    const intervalId = setInterval(closeIfOperatorTokenAvailable, 1000);
    const handleStorage = (event) => {
      if (
        !event?.key ||
        event.key === kOpenClawDeviceAuthStorageKey ||
        event.key === kOpenClawDeviceIdentityStorageKey
      ) {
        closeIfOperatorTokenAvailable();
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener?.("storage", handleStorage);
    }

    return () => {
      clearInterval(intervalId);
      if (typeof window !== "undefined") {
        window.removeEventListener?.("storage", handleStorage);
      }
    };
  }, [closeLauncher, status, visible]);

  const openDashboardTab = useCallback(() => {
    const url = dashboardUrl || "/openclaw";
    setStatus(kDashboardLauncherStatuses.OPENING);
    try {
      const opened = openDashboardWindow(url);
      if (!opened) {
        showToast(
          "Your browser blocked the OpenClaw tab. Allow popups for AlphaClaw and try again.",
          "warning",
        );
        setStatus(kDashboardLauncherStatuses.READY);
        return;
      }
    } catch (err) {
      showToast(err.message || "Could not open OpenClaw dashboard", "error");
      setStatus(kDashboardLauncherStatuses.READY);
      return;
    }
    startWaitingForPairing();
  }, [dashboardUrl, startWaitingForPairing]);

  const retryWatching = useCallback(() => {
    startWaitingForPairing();
    scheduleDeviceRefreshes();
  }, [scheduleDeviceRefreshes, startWaitingForPairing]);

  const approveBrowserPairing = useCallback(async () => {
    const requestId = primaryBrowserPairing?.id;
    if (!requestId || approving) return;
    setApproving(true);
    try {
      await approveDevice(requestId);
      ignorePreexistingOperatorTokenCloseRef.current = false;
      showToast("OpenClaw browser approved", "success");
      setStatus(kDashboardLauncherStatuses.APPROVED);
      setWaitingStartedAtMs(0);
      scheduleDeviceRefreshes();
    } catch (err) {
      showToast(err.message || "Could not approve browser pairing", "error");
      throw err;
    } finally {
      setApproving(false);
    }
  }, [approving, primaryBrowserPairing?.id, scheduleDeviceRefreshes]);

  const rejectBrowserPairing = useCallback(async () => {
    const requestId = primaryBrowserPairing?.id;
    if (!requestId || rejecting) return;
    setRejecting(true);
    try {
      await rejectDevice(requestId);
      showToast("OpenClaw browser request rejected", "info");
      setStatus(kDashboardLauncherStatuses.WAITING);
      setWaitingStartedAtMs(Date.now());
      scheduleDeviceRefreshes();
    } catch (err) {
      showToast(err.message || "Could not reject browser pairing", "error");
      throw err;
    } finally {
      setRejecting(false);
    }
  }, [primaryBrowserPairing?.id, rejecting, scheduleDeviceRefreshes]);

  return {
    state: {
      approving,
      cliAutoApproveComplete,
      dashboardUrl,
      devicePolling: devicePoll.isPolling,
      error,
      gatewayStatus,
      hasBrowserPairingPending,
      pendingBrowserPairings,
      primaryBrowserPairing,
      rejecting,
      status,
      visible,
    },
    actions: {
      approveBrowserPairing,
      closeLauncher,
      openDashboardTab,
      openLauncher,
      rejectBrowserPairing,
      retryWatching,
    },
  };
};
