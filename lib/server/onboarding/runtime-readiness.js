// A listening port can precede authenticated chat readiness. Probe the same
// bridge used by the dashboard, without sending a message or exposing history.
const createOnboardingRuntimeReadiness = ({
  requestGateway,
  isAgentVaultReady,
  getRestartSnapshot,
  getWatchdogStatus,
}) => {
  let inFlight = null;
  const settled = (state) =>
    state.gatewayRunning && !state.restartRequired && !state.restartInProgress;

  const probe = async () => {
    try {
      const before = await getRestartSnapshot();
      const watchdogBefore = getWatchdogStatus();
      if (watchdogBefore.operationInProgress) return false;
      if (!settled(before) || !(await isAgentVaultReady())) return false;
      // The main alias lets OpenClaw resolve imported default agents and global sessions.
      await requestGateway(
        "chat.history",
        { sessionKey: "main", limit: 1 },
        3000,
      );
      const after = await getRestartSnapshot();
      const watchdogAfter = getWatchdogStatus();
      return (
        settled(after) &&
        after.updatedAt === before.updatedAt &&
        !watchdogAfter.operationInProgress &&
        watchdogAfter.gatewayPid === watchdogBefore.gatewayPid &&
        watchdogAfter.uptimeStartedAt === watchdogBefore.uptimeStartedAt
      );
    } catch {
      return false;
    }
  };

  return () => {
    if (!inFlight) {
      inFlight = probe().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
};

module.exports = { createOnboardingRuntimeReadiness };
