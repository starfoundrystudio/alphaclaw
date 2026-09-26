// OpenClaw 2026.9 can keep using a plugin instance it has already revoked
// after a hot plugin reload: when the reload aborts the provider catalog
// refresh, the session catalog keeps the old provider instance and every
// chat.history / sessions.list fails with PluginInstanceUnavailableError
// until the Gateway restarts. Nothing in OpenClaw retries the refresh (G3
// finding #42, host 13). Clawbridge checks after the reloads it triggers,
// reacts when a Gateway request hits the error, and restarts the Gateway
// once, after browser chat runs finish, at most once per interval.

const kStalePluginInstancePattern =
  /PluginInstanceUnavailableError|was reloaded or disabled; use its current tools/i;

const isStalePluginInstanceError = (error) =>
  kStalePluginInstancePattern.test(
    error instanceof Error ? error.message : String(error || ""),
  );

const createGatewayStalePluginGuard = ({
  probe,
  restartGateway,
  isBusy = () => false,
  logger = console,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  reloadSettleMs = 20000,
  quietRetryMs = 15000,
  maxQuietWaitMs = 120000,
  minRestartIntervalMs = 10 * 60 * 1000,
} = {}) => {
  if (typeof probe !== "function") throw new Error("probe is required");
  if (typeof restartGateway !== "function") {
    throw new Error("restartGateway is required");
  }
  let timer = null;
  let checking = false;
  let lastRestartAtMs = 0;
  let waitingSinceMs = 0;

  const schedule = (delayMs) => {
    if (timer) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void check();
    }, delayMs);
    timer?.unref?.();
  };

  const check = async () => {
    if (checking) return { status: "in_progress" };
    checking = true;
    try {
      try {
        await probe();
        waitingSinceMs = 0;
        return { status: "healthy" };
      } catch (error) {
        if (!isStalePluginInstanceError(error)) {
          waitingSinceMs = 0;
          return { status: "other_error" };
        }
      }
      const currentMs = now();
      if (lastRestartAtMs && currentMs - lastRestartAtMs < minRestartIntervalMs) {
        waitingSinceMs = 0;
        logger.warn?.(
          `[alphaclaw] Gateway still reports a revoked plugin instance; last recovery restart was ${Math.round((currentMs - lastRestartAtMs) / 1000)}s ago, not restarting again yet`,
        );
        return { status: "rate_limited" };
      }
      if (isBusy()) {
        if (!waitingSinceMs) waitingSinceMs = currentMs;
        if (currentMs - waitingSinceMs < maxQuietWaitMs) {
          schedule(quietRetryMs);
          return { status: "waiting_for_quiet" };
        }
      }
      waitingSinceMs = 0;
      lastRestartAtMs = currentMs;
      logger.log?.(
        "[alphaclaw] Gateway is using a plugin instance it already revoked (PluginInstanceUnavailableError after a plugin reload); restarting it to recover",
      );
      try {
        await restartGateway();
        return { status: "restarted" };
      } catch (error) {
        logger.error?.(
          `[alphaclaw] Gateway recovery restart failed: ${String(error?.message || error).slice(0, 200)}`,
        );
        return { status: "restart_failed" };
      }
    } finally {
      checking = false;
    }
  };

  return {
    // After a config change OpenClaw applies by hot reload.
    afterPluginReload: () => schedule(reloadSettleMs),
    // Any Gateway request error; only the revoked-instance error triggers a
    // check. The probe's own failure and errors inside the restart interval
    // are ignored so the guard cannot loop on itself.
    reportGatewayError: (error) => {
      if (checking || !isStalePluginInstanceError(error)) return;
      if (lastRestartAtMs && now() - lastRestartAtMs < minRestartIntervalMs) {
        return;
      }
      schedule(0);
    },
    check,
  };
};

module.exports = {
  createGatewayStalePluginGuard,
  isStalePluginInstanceError,
};
