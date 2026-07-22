const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// `composio login --no-browser --no-wait` prints the dashboard login URL and
// caches a pending session key; `composio login --poll` then waits (up to ten
// minutes) for the browser sign-in to complete and stores the session. This
// service drives that device-code-style flow for the dashboard, mirroring the
// Codex/Claude subscription auth pattern.

const kStartCommand = "login --no-browser --no-wait -y --no-skill-install";
const kPollArgs = ["login", "--poll"];
const kPollLifetimeMs = 11 * 60 * 1000;

const stripAnsi = (text = "") =>
  String(text || "").replace(/\[[0-9;]*[A-Za-z]/g, "");

const extractLoginUrl = (text = "") => {
  const match = stripAnsi(text).match(/https:\/\/[^\s"'<>\])]+/);
  return match ? match[0] : "";
};

const createComposioLoginService = ({
  composioCmd,
  onLoginComplete = null,
  spawnFn = spawn,
  homedir = os.homedir(),
  now = Date.now,
}) => {
  let pollChild = null;
  let pollStartedAt = null;
  let lastError = "";

  const isPending = () => Boolean(pollChild);
  const getError = () => lastError;

  const stopPolling = () => {
    const current = pollChild;
    pollChild = null;
    pollStartedAt = null;
    if (current?.pid) {
      try {
        current.kill("SIGTERM");
      } catch {}
    }
  };

  const startPolling = () => {
    // A new login start invalidates the previously cached pending key, so any
    // older poll process is now polling a dead key — replace it.
    stopPolling();
    const spawned = spawnFn("composio", kPollArgs, {
      env: {
        ...process.env,
        PATH: `${path.join(homedir, ".composio")}:${process.env.PATH || ""}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    pollChild = spawned;
    pollStartedAt = now();

    let stderrTail = "";
    spawned.stderr?.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-300);
    });

    const lifetimeTimer = setTimeout(() => {
      if (pollChild === spawned) {
        lastError = "Sign-in timed out — start again";
        stopPolling();
      }
    }, kPollLifetimeMs);
    lifetimeTimer.unref?.();

    spawned.on("exit", async (code) => {
      clearTimeout(lifetimeTimer);
      if (pollChild !== spawned) return;
      pollChild = null;
      pollStartedAt = null;
      if (code === 0) {
        lastError = "";
        try {
          await onLoginComplete?.();
        } catch (err) {
          console.error(
            "[composio-login] Post-login refresh failed:",
            err.message,
          );
        }
        return;
      }
      lastError =
        stderrTail.trim().slice(0, 200) ||
        `Sign-in did not complete (exit ${code ?? "?"})`;
      console.error(`[composio-login] Poll failed: ${lastError}`);
    });
  };

  const start = async () => {
    lastError = "";
    const result = await composioCmd(kStartCommand, {
      quiet: true,
      timeoutMs: 30000,
    });
    const loginUrl = extractLoginUrl(`${result.stdout}\n${result.stderr}`);
    if (!loginUrl) {
      const detail = stripAnsi(`${result.stderr}\n${result.stdout}`)
        .trim()
        .slice(0, 300);
      throw new Error(
        detail || "Composio did not return a login URL — is the CLI installed?",
      );
    }
    startPolling();
    return { loginUrl, startedAt: pollStartedAt };
  };

  const stop = () => stopPolling();

  return { start, stop, isPending, getError };
};

module.exports = {
  kStartCommand,
  extractLoginUrl,
  createComposioLoginService,
};
