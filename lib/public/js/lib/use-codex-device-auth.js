import { useEffect, useRef, useState } from "preact/hooks";
import { pollCodexDeviceAuth, startCodexDeviceAuth } from "./api.js";

export const kChatgptSecuritySettingsUrl =
  "https://chatgpt.com/settings/security";

export const useCodexDeviceAuth = ({ onConnected } = {}) => {
  const [deviceAuth, setDeviceAuth] = useState(null);
  const [deviceStarting, setDeviceStarting] = useState(false);
  const [deviceNotEnabled, setDeviceNotEnabled] = useState(false);
  const [deviceError, setDeviceError] = useState(null);
  const pollTimerRef = useRef(null);
  const pollInFlightRef = useRef(false);
  const sessionRef = useRef(null);

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const cancelDeviceAuth = () => {
    stopPolling();
    sessionRef.current = null;
    setDeviceAuth(null);
    setDeviceError(null);
    setDeviceNotEnabled(false);
  };

  const failDeviceAuth = (message) => {
    stopPolling();
    sessionRef.current = null;
    setDeviceAuth(null);
    setDeviceError(message);
  };

  const startDeviceAuth = async () => {
    if (deviceStarting) return false;
    stopPolling();
    sessionRef.current = null;
    setDeviceAuth(null);
    setDeviceStarting(true);
    setDeviceError(null);
    setDeviceNotEnabled(false);
    try {
      const result = await startCodexDeviceAuth();
      if (!result.ok) {
        if (result.reason === "not_enabled") {
          setDeviceNotEnabled(true);
          return false;
        }
        throw new Error(result.error || "Could not start device sign-in");
      }
      sessionRef.current = result.sessionId;
      setDeviceAuth({
        sessionId: result.sessionId,
        userCode: result.userCode,
        verificationUrl: result.verificationUrl,
      });
      const intervalMs = Math.max(3000, Number(result.intervalMs) || 5000);
      pollTimerRef.current = setInterval(async () => {
        if (pollInFlightRef.current || !sessionRef.current) return;
        pollInFlightRef.current = true;
        try {
          const poll = await pollCodexDeviceAuth(sessionRef.current);
          if (!sessionRef.current) return;
          if (poll?.status === "complete") {
            stopPolling();
            sessionRef.current = null;
            setDeviceAuth(null);
            await onConnected?.();
          } else if (poll?.status === "expired") {
            failDeviceAuth("The sign-in code expired. Start again for a new code.");
          } else if (poll?.status === "error") {
            failDeviceAuth(poll.error || "Device sign-in failed");
          }
        } catch {
          // Transient network errors: keep polling until the code expires.
        } finally {
          pollInFlightRef.current = false;
        }
      }, intervalMs);
      return true;
    } catch (err) {
      failDeviceAuth(err.message || "Could not start device sign-in");
      return false;
    } finally {
      setDeviceStarting(false);
    }
  };

  useEffect(() => stopPolling, []);

  return {
    deviceAuth,
    deviceStarting,
    deviceNotEnabled,
    deviceError,
    startDeviceAuth,
    cancelDeviceAuth,
  };
};
