const os = require("os");
const path = require("path");
const { exec } = require("child_process");

const kInstallCommand = "curl -fsSL https://composio.dev/install | bash";
const kInstallTimeoutMs = 300000;
const kCheckTimeoutMs = 10000;

const composioDir = (homedir = os.homedir()) => path.join(homedir, ".composio");

// The installer drops the binary at $HOME/.composio/composio, which is not on
// PATH for a non-interactive server process; make it reachable in-process.
const ensureComposioOnPath = ({ fs, homedir = os.homedir() } = {}) => {
  const dir = composioDir(homedir);
  if (!fs.existsSync(path.join(dir, "composio"))) return false;
  const currentPath = String(process.env.PATH || "");
  if (!currentPath.split(":").includes(dir)) {
    process.env.PATH = `${dir}:${currentPath}`;
  }
  return true;
};

const runShell = (command, { execFn = exec, timeoutMs }) =>
  new Promise((resolve) => {
    execFn(command, { timeout: timeoutMs, env: process.env }, (err, stdout, stderr) =>
      resolve({
        ok: !err,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      }),
    );
  });

const checkCliAvailable = async ({ execFn = exec } = {}) =>
  (await runShell("command -v composio", { execFn, timeoutMs: kCheckTimeoutMs })).ok;

// Module-level singleton: at most one install runs at a time, and callers that
// arrive while it is running share the same promise.
let activeInstall = null;
let lastInstallError = "";

const isComposioInstalling = () => Boolean(activeInstall);
const getComposioInstallError = () => lastInstallError;

const ensureComposioCliInstalled = ({
  fs,
  execFn = exec,
  homedir = os.homedir(),
  onComplete = null,
} = {}) => {
  if (activeInstall) return activeInstall;
  activeInstall = (async () => {
    try {
      ensureComposioOnPath({ fs, homedir });
      if (await checkCliAvailable({ execFn })) {
        lastInstallError = "";
        return { installed: true, alreadyInstalled: true };
      }
      console.log("[alphaclaw] Installing Composio CLI...");
      const result = await runShell(kInstallCommand, {
        execFn,
        timeoutMs: kInstallTimeoutMs,
      });
      ensureComposioOnPath({ fs, homedir });
      if (!(await checkCliAvailable({ execFn }))) {
        lastInstallError = String(
          result.stderr || result.stdout || "Composio CLI install failed",
        )
          .trim()
          .slice(0, 300);
        console.log(
          `[alphaclaw] Composio CLI install failed: ${lastInstallError}`,
        );
        return { installed: false, error: lastInstallError };
      }
      lastInstallError = "";
      console.log("[alphaclaw] Composio CLI installed");
      return { installed: true };
    } finally {
      // Run the post-install refresh BEFORE clearing the installing flag —
      // status polls must keep seeing "installing" until the refreshed state
      // (with cliInstalled=true) is cached, or the dashboard stops polling a
      // few seconds too early and strands the user on a stale status.
      try {
        await onComplete?.();
      } catch (err) {
        console.error(
          "[alphaclaw] Composio post-install refresh failed:",
          err.message,
        );
      }
      activeInstall = null;
    }
  })();
  return activeInstall;
};

module.exports = {
  kInstallCommand,
  composioDir,
  ensureComposioOnPath,
  checkCliAvailable,
  ensureComposioCliInstalled,
  isComposioInstalling,
  getComposioInstallError,
};
