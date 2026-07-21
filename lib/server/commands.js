const { exec } = require("child_process");
const { OPENCLAW_DIR, GOG_KEYRING_PASSWORD } = require("./constants");
const { redactSecretText } = require("./secret-redaction");

const sanitizeOnboardCommandForLog = (cmd) =>
  redactSecretText(cmd);

const createCommands = ({ gatewayEnv }) => {
  const shellCmd = (cmd, opts = {}) =>
    new Promise((resolve, reject) => {
      const {
        logStdout,
        timeoutMs = 60000,
        ...execOpts
      } = opts;
      const shouldLogStdout =
        typeof logStdout === "boolean" ? logStdout : !cmd.includes("--json");
      console.log(
        `[onboard] Running: ${sanitizeOnboardCommandForLog(cmd).slice(0, 200)}`,
      );
      exec(cmd, { timeout: timeoutMs, ...execOpts }, (err, stdout, stderr) => {
        if (err) {
          err.stdout = String(stdout || "").trim();
          err.stderr = String(stderr || "").trim();
          err.cmd = cmd;
          console.error(
            `[onboard] Error: ${redactSecretText(stderr || err.message || "").slice(0, 300)}`,
          );
          return reject(err);
        }
        if (shouldLogStdout && stdout.trim()) {
          console.log(`[onboard] ${stdout.trim().slice(0, 300)}`);
        }
        resolve(stdout.trim());
      });
    });

  const clawCmd = (
    cmd,
    { quiet = false, timeoutMs = 15000, killSignal = "SIGTERM" } = {},
  ) =>
    new Promise((resolve) => {
      if (!quiet) console.log(`[alphaclaw] Running: openclaw ${cmd}`);
      exec(
        `openclaw ${cmd}`,
        {
          env: gatewayEnv(),
          timeout: timeoutMs,
          killSignal,
        },
        (err, stdout, stderr) => {
          const result = {
            ok: !err,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            code: err?.code,
            signal: err?.signal,
            killed: err?.killed,
            message: err?.message,
          };
          if (err) {
            result.killed = Boolean(err.killed);
            result.signal = err.signal || null;
            result.timedOut = Boolean(err.killed && err.signal === killSignal);
          }
          if (!quiet && !result.ok) {
            console.log(`[alphaclaw] Error: ${result.stderr.slice(0, 200)}`);
          }
          resolve(result);
        },
      );
    });

  const gogCmd = (cmd, { quiet = false } = {}) =>
    new Promise((resolve) => {
      if (!quiet) console.log(`[alphaclaw] Running: gog ${cmd}`);
      exec(
        `gog ${cmd}`,
        {
          timeout: 15000,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: OPENCLAW_DIR,
            GOG_KEYRING_PASSWORD,
          },
        },
        (err, stdout, stderr) => {
          const result = {
            ok: !err,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          };
          if (!quiet && !result.ok) {
            console.log(`[alphaclaw] gog error: ${result.stderr.slice(0, 200)}`);
          }
          resolve(result);
        },
      );
    });

  const composioCmd = (cmd, { quiet = false, timeoutMs = 30000 } = {}) =>
    new Promise((resolve) => {
      if (!quiet) console.log(`[alphaclaw] Running: composio ${cmd}`);
      exec(
        `composio ${cmd}`,
        {
          timeout: timeoutMs,
          env: process.env,
        },
        (err, stdout, stderr) => {
          const result = {
            ok: !err,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          };
          if (!quiet && !result.ok) {
            console.log(
              `[alphaclaw] composio error: ${redactSecretText(result.stderr).slice(0, 200)}`,
            );
          }
          resolve(result);
        },
      );
    });

  return { shellCmd, clawCmd, gogCmd, composioCmd };
};

module.exports = { createCommands, sanitizeOnboardCommandForLog };
