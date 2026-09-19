"use strict";

// Startup plugin reconciliation runs once in bin/alphaclaw.js before the
// server exists. On a restored host it can run before the egress proxy is
// usable (G2 T10, 2026-09-19: seven starts in a row failed with npm 407 /
// integrity errors and the Gateway then ran without the provider plugin the
// restored config depends on), and nothing retried until the next process
// start. When that first pass failed, retry in-process on a bounded backoff
// once the server is up, and reload the Gateway when a retry installs or
// updates anything so the plugins actually load.
const kDefaultDelaysMs = [30_000, 60_000, 120_000, 240_000, 480_000];

const kChangingActions = new Set(["installed", "updated"]);

const hasPluginChanges = (result) =>
  Array.isArray(result?.plugins) &&
  result.plugins.some((plugin) => kChangingActions.has(plugin?.action));

const createStartupPluginReconcileRetry = ({
  failedAtStartup,
  isOnboarded,
  reconcile,
  restartGateway,
  delaysMs = kDefaultDelaysMs,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
}) => {
  let promise = null;

  const run = async () => {
    if (!failedAtStartup)
      return { ok: true, skipped: true, reason: "startup_ok" };
    if (typeof isOnboarded === "function" && !isOnboarded()) {
      return { ok: true, skipped: true, reason: "not_onboarded" };
    }
    for (let attempt = 1; attempt <= delaysMs.length; attempt += 1) {
      await wait(delaysMs[attempt - 1]);
      try {
        const result = await reconcile();
        const changed = hasPluginChanges(result);
        logger.log(
          `[alphaclaw] Startup plugin reconciliation retry ${attempt}/${delaysMs.length} succeeded${
            changed ? "; reloading the Gateway so the plugins load" : ""
          }`,
        );
        if (changed && typeof restartGateway === "function") {
          try {
            await restartGateway();
          } catch (error) {
            logger.error(
              `[alphaclaw] Gateway reload after plugin reconciliation retry failed: ${error.message}`,
            );
            return { ok: true, attempt, changed, restarted: false };
          }
        }
        return { ok: true, attempt, changed, restarted: changed };
      } catch (error) {
        const details = String(
          error?.stderr || error?.stdout || error?.message || "",
        )
          .trim()
          .slice(0, 400);
        logger.error(
          `[alphaclaw] Startup plugin reconciliation retry ${attempt}/${delaysMs.length} failed: ${details}`,
        );
      }
    }
    logger.error(
      "[alphaclaw] Startup plugin reconciliation still failing after retries; the Gateway runs without unreconciled managed plugins until the next restart",
    );
    return { ok: false, attempts: delaysMs.length };
  };

  return {
    start: () => {
      promise ||= run();
      return promise;
    },
  };
};

module.exports = {
  createStartupPluginReconcileRetry,
  hasPluginChanges,
  kStartupPluginReconcileFailedEnv: "ALPHACLAW_STARTUP_PLUGIN_RECONCILE_FAILED",
};
