"use strict";

// Runs the managed-plugin reconcile in a child process for flows that happen
// while the Clawbridge server is serving requests (channel add, model save,
// watchdog repair). The reconcile itself shells out synchronously for up to
// several minutes; run in-process it froze the whole server, so progress and
// failure events never reached the browser (G3 finding #21, audit item 1).
//
// On OpenClaw 2026.9 the install is handed to the running Gateway, which
// applies it live, so the Gateway keeps running. A failed run is retried
// once (the Gateway's own npm lookup can time out transiently).

const path = require("path");
const { spawn } = require("child_process");
const { stripOpenclawNoise } = require("./openclaw-cli-output");

const kDefaultTimeoutMs = 6 * 60 * 1000;
const kDefaultRetryDelayMs = 5000;
const kBinPath = path.resolve(__dirname, "..", "..", "bin", "alphaclaw.js");

const kFailurePrefix = /OpenClaw plugin reconciliation failed:\s*/i;

const describeReconcileFailure = ({ stdout = "", stderr = "", timedOut = false } = {}) => {
  if (timedOut) {
    return "Installing the OpenClaw plugin took too long. Try again in a moment.";
  }
  const combined = `${stderr}\n${stdout}`;
  const match = combined.split(kFailurePrefix);
  const detail = stripOpenclawNoise(match.length > 1 ? match[match.length - 1] : combined);
  if (/npm (view|install) failed|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|timed out/i.test(combined)) {
    return "Downloading the OpenClaw plugin from npm failed or timed out. Try again in a moment.";
  }
  const firstLine = detail.split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine
    ? `OpenClaw plugin installation failed: ${firstLine.slice(0, 300)}`
    : "OpenClaw plugin installation failed.";
};

const kRelayNoisePatterns = [
  /^\s*\[config\]\s*warnings:/i,
  /^\s*config warnings:/i,
  /^\s*config \([^)]*\):/i,
  /^\s*npm warn\b/i,
  /^\s*\[proxy\]\s/i,
];
const kMaxRelayedLines = 80;
const kMaxRelayedChars = 8000;

// The child's output used to be dropped on success, so a slow Slack add
// (~8 minutes, G3 finding #28) left no record of which OpenClaw command took
// the time or why the first install collided. Relay it on every attempt,
// minus OpenClaw's config-warning noise, bounded.
const relayReconcileOutput = ({ logger, attempt, result, elapsedMs, onlyPluginKeys }) => {
  const scope =
    Array.isArray(onlyPluginKeys) && onlyPluginKeys.length
      ? ` (${onlyPluginKeys.map(String).join(", ")})`
      : "";
  const outcome = result.ok
    ? "succeeded"
    : result.timedOut
      ? "timed out"
      : `failed (exit ${result.code ?? "unknown"})`;
  logger.log?.(
    `[alphaclaw] Plugin reconcile attempt ${attempt}/2${scope} ${outcome} in ${(elapsedMs / 1000).toFixed(1)}s`,
  );
  // Keep Clawbridge's own "[alphaclaw]" progress lines (the shared noise
  // filter drops them because it prepares user-facing errors).
  const lines = `${result.stdout || ""}\n${result.stderr || ""}`
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !kRelayNoisePatterns.some((pattern) => pattern.test(line)));
  let chars = 0;
  let relayed = 0;
  for (const line of lines) {
    if (relayed >= kMaxRelayedLines || chars + line.length > kMaxRelayedChars) {
      logger.log?.(`[plugin-reconcile] … ${lines.length - relayed} more line(s) omitted`);
      break;
    }
    logger.log?.(`[plugin-reconcile] ${line}`);
    chars += line.length;
    relayed += 1;
  }
};

const runOnce = ({ args, env, cwd, timeoutMs, spawnImpl }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawnImpl(process.execPath, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, stdout, stderr: String(error?.message || error), timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error?.message || error}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
  });

const createPluginReconcileRunner = ({
  rootDir,
  env = process.env,
  binPath = kBinPath,
  timeoutMs = kDefaultTimeoutMs,
  retryDelayMs = kDefaultRetryDelayMs,
  spawnImpl = spawn,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
} = {}) =>
  // Same call shape as reconcileOpenclawPlugins so callers can switch over;
  // only `onlyPluginKeys` is honoured, everything else comes from the child's
  // own environment and root dir.
  async ({ onlyPluginKeys = null } = {}) => {
    const args = [binPath, "--root-dir", rootDir, "reconcile-openclaw-plugins"];
    if (Array.isArray(onlyPluginKeys) && onlyPluginKeys.length > 0) {
      args.push("--only", onlyPluginKeys.map(String).join(","));
    }
    let last = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const startedAt = Date.now();
      last = await runOnce({ args, env, cwd: rootDir, timeoutMs, spawnImpl });
      relayReconcileOutput({
        logger,
        attempt,
        result: last,
        elapsedMs: Date.now() - startedAt,
        onlyPluginKeys,
      });
      if (last.ok) {
        return { ok: true, attempt };
      }
      logger.warn?.(
        `[alphaclaw] Plugin reconcile attempt ${attempt}/2 failed: ${describeReconcileFailure(last)}`,
      );
      if (attempt === 1) await wait(retryDelayMs);
    }
    const error = new Error(describeReconcileFailure(last));
    error.stdout = last?.stdout;
    error.stderr = last?.stderr;
    throw error;
  };

module.exports = {
  createPluginReconcileRunner,
  describeReconcileFailure,
};
