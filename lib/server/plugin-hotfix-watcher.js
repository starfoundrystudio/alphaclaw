"use strict";

// Keeps Clawbridge's version-pinned plugin hotfixes effective after the
// Gateway loads a plugin. On OpenClaw 2026.9 the running Gateway installs and
// hot-loads plugins itself (Clawbridge's reconcile, or the Control UI Plugins
// page), and Node never re-imports a loaded module. A patch written after the
// Gateway loaded the file only takes effect after a Gateway restart (G3
// finding #27: Slack's first Socket Mode start ran unpatched code).
//
// Every minute: apply any pending hotfix, then restart the Gateway if a
// patched file is newer than the running Gateway. The grace period leaves
// room for flows that restart the Gateway anyway (channel add restarts it to
// load the new token env), so they are not restarted twice.

const fs = require("fs");
const { applyOpenclawPluginHotfixes } = require("../cli/openclaw-plugin-hotfixes");

const kDefaultIntervalMs = 60 * 1000;
const kDefaultGraceMs = 2 * 60 * 1000;

const createPluginHotfixWatcher = ({
  openclawDir,
  getGatewayStartedAtMs,
  isGatewayLifecycleBusy = () => false,
  restartGateway,
  fsModule = fs,
  applyHotfixes = applyOpenclawPluginHotfixes,
  intervalMs = kDefaultIntervalMs,
  graceMs = kDefaultGraceMs,
  now = Date.now,
  logger = console,
} = {}) => {
  let timer = null;
  let running = false;

  const findStalePatches = (results, gatewayStartedAtMs) => {
    const stale = [];
    for (const result of Array.isArray(results) ? results : []) {
      for (const file of result?.patchedFiles || []) {
        let mtimeMs = 0;
        try {
          mtimeMs = fsModule.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs > gatewayStartedAtMs && now() - mtimeMs >= graceMs) {
          stale.push({ id: result.id, file });
        }
      }
    }
    return stale;
  };

  const check = async () => {
    if (running) return { skipped: "running" };
    running = true;
    try {
      const results = applyHotfixes({ openclawDir, fsModule, logger });
      const gatewayStartedAtMs = Number(getGatewayStartedAtMs?.()) || 0;
      if (!gatewayStartedAtMs) return { restarted: false };
      const stale = findStalePatches(results, gatewayStartedAtMs);
      if (stale.length === 0) return { restarted: false };
      if (isGatewayLifecycleBusy()) return { restarted: false, deferred: true };
      const ids = [...new Set(stale.map((entry) => entry.id))].join(", ");
      logger.log?.(
        `[alphaclaw] Restarting the Gateway so it loads patched plugin files (${ids})`,
      );
      await restartGateway();
      return { restarted: true, ids };
    } catch (error) {
      logger.warn?.(
        `[alphaclaw] Plugin hotfix check failed: ${String(error?.message || error).slice(0, 200)}`,
      );
      return { restarted: false, error: true };
    } finally {
      running = false;
    }
  };

  return {
    check,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void check();
      }, Math.max(1000, Number(intervalMs) || kDefaultIntervalMs));
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
};

module.exports = { createPluginHotfixWatcher };
