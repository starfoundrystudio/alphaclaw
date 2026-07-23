const os = require("os");
const path = require("path");
const { exec } = require("child_process");

const kInstallCommand = "curl -fsSL https://composio.dev/install | bash";
const kInstallTimeoutMs = 300000;
const kCheckTimeoutMs = 10000;
const kUpgradeTimeoutMs = 300000;

const composioDir = (homedir = os.homedir()) => path.join(homedir, ".composio");

// Release assets are named composio-<platform>.zip with platform tokens
// matching the official install script: darwin-aarch64, linux-x64, etc.
const composioPlatformToken = ({
  platform = os.platform(),
  arch = os.arch(),
} = {}) => {
  const osToken = platform === "darwin" ? "darwin" : "linux";
  const archToken = arch === "arm64" ? "aarch64" : "x64";
  return `${osToken}-${archToken}`;
};

const composioReleaseAssetUrl = (version, platformToken) =>
  `https://github.com/ComposioHQ/composio/releases/download/` +
  `%40composio%2Fcli%40${encodeURIComponent(version)}/composio-${platformToken}.zip`;

const parseComposioVersion = (raw = "") => {
  const match = String(raw || "").match(
    /(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?/,
  );
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    beta: match[4] === undefined ? null : Number(match[4]),
    raw: match[0],
  };
};

// -1 | 0 | 1; a prerelease sorts below the plain release of the same triplet
const compareComposioVersions = (a, b) => {
  const left = parseComposioVersion(a);
  const right = parseComposioVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) {
      return left.numbers[index] < right.numbers[index] ? -1 : 1;
    }
  }
  if ((left.beta === null) !== (right.beta === null)) {
    return left.beta === null ? 1 : -1;
  }
  if (left.beta !== right.beta) return left.beta < right.beta ? -1 : 1;
  return 0;
};

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

// Module-level singleton: at most one binary mutation (install OR upgrade)
// runs at a time; callers that arrive while one is running share its promise.
let activeInstall = null;
let activeKind = "";
let lastInstallError = "";

const isComposioInstalling = () => activeKind === "install";
const isComposioUpgrading = () => activeKind === "upgrade";
const getComposioInstallError = () => lastInstallError;

const getInstalledComposioVersion = async ({ execFn = exec } = {}) => {
  const result = await runShell("composio version", {
    execFn,
    timeoutMs: kCheckTimeoutMs,
  });
  if (!result.ok) return "";
  return parseComposioVersion(result.stdout)?.raw || "";
};

const ensureComposioCliInstalled = ({
  fs,
  execFn = exec,
  homedir = os.homedir(),
  onComplete = null,
} = {}) => {
  if (activeInstall) return activeInstall;
  activeKind = "install";
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
      activeKind = "";
    }
  })();
  return activeInstall;
};

// Upgrade the installed CLI to the pinned target version. The CLI's own
// `composio upgrade` fails with ETXTBSY on Linux (a running binary cannot
// overwrite itself), so we replace the binary directly from the GitHub
// release asset with an atomic rename, stopping any listener child first —
// it executes the same binary and would also hold it busy.
const ensureComposioCliAtVersion = ({
  fs,
  execFn = exec,
  homedir = os.homedir(),
  targetVersion,
  stopListener = null,
  startListener = null,
  onComplete = null,
  platform = os.platform(),
  arch = os.arch(),
  tmpdir = os.tmpdir(),
} = {}) => {
  if (activeInstall) return activeInstall;
  const target = parseComposioVersion(targetVersion)?.raw;
  if (!target) return Promise.resolve({ upgraded: false, error: "invalid target version" });
  activeKind = "upgrade";
  activeInstall = (async () => {
    let listenerStopped = false;
    try {
      ensureComposioOnPath({ fs, homedir });
      if (!(await checkCliAvailable({ execFn }))) {
        // Nothing installed — the install path owns this case.
        return { upgraded: false, notInstalled: true };
      }
      const installed = await getInstalledComposioVersion({ execFn });
      if (installed && compareComposioVersions(installed, target) >= 0) {
        return { upgraded: false, upToDate: true, installed };
      }

      console.log(
        `[alphaclaw] Upgrading Composio CLI ${installed || "unknown"} -> ${target}...`,
      );
      try {
        await stopListener?.();
        listenerStopped = true;
      } catch {}

      const token = composioPlatformToken({ platform, arch });
      const assetUrl = composioReleaseAssetUrl(target, token);
      const workDir = path.join(tmpdir, "composio-cli-upgrade");
      const binDir = composioDir(homedir);
      const command = [
        `rm -rf ${JSON.stringify(workDir)}`,
        `mkdir -p ${JSON.stringify(workDir)}`,
        `curl -fsSL ${JSON.stringify(assetUrl)} -o ${JSON.stringify(`${workDir}/cli.zip`)}`,
        `unzip -o -q ${JSON.stringify(`${workDir}/cli.zip`)} -d ${JSON.stringify(`${workDir}/extract`)}`,
        `install -m 755 ${JSON.stringify(`${workDir}/extract/composio-${token}/composio`)} ${JSON.stringify(`${binDir}/composio.new`)}`,
        `mv -f ${JSON.stringify(`${binDir}/composio.new`)} ${JSON.stringify(`${binDir}/composio`)}`,
        `printf '@composio/cli@%s' ${JSON.stringify(target)} > ${JSON.stringify(`${binDir}/release-tag.txt`)}`,
        `rm -rf ${JSON.stringify(workDir)}`,
      ].join(" && ");
      const result = await runShell(command, { execFn, timeoutMs: kUpgradeTimeoutMs });
      if (!result.ok) {
        lastInstallError = String(result.stderr || "Composio CLI upgrade failed")
          .trim()
          .slice(0, 300);
        console.log(`[alphaclaw] Composio CLI upgrade failed: ${lastInstallError}`);
        return { upgraded: false, error: lastInstallError };
      }
      const after = await getInstalledComposioVersion({ execFn });
      if (compareComposioVersions(after, target) < 0) {
        lastInstallError = `Upgrade completed but version is ${after || "unknown"}`;
        return { upgraded: false, error: lastInstallError };
      }
      lastInstallError = "";
      console.log(`[alphaclaw] Composio CLI upgraded to ${after}`);
      return { upgraded: true, installed: after };
    } finally {
      try {
        await onComplete?.();
      } catch (err) {
        console.error(
          "[alphaclaw] Composio post-upgrade refresh failed:",
          err.message,
        );
      }
      if (listenerStopped) {
        try {
          startListener?.();
        } catch {}
      }
      activeInstall = null;
      activeKind = "";
    }
  })();
  return activeInstall;
};

// Option-2 stable-channel gating: `listen` ships behind an experimental flag
// until it graduates; write it as managed config so upgraded CLIs expose the
// command. Preserves all other config fields.
const ensureComposioListenFlag = ({ fs, homedir = os.homedir() } = {}) => {
  try {
    const configPath = path.join(composioDir(homedir), "config.json");
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8")) || {};
    } catch {}
    if (config?.experimental_features?.listen === true) return false;
    const next = {
      ...config,
      experimental_features: {
        ...(config.experimental_features && typeof config.experimental_features === "object"
          ? config.experimental_features
          : {}),
        listen: true,
      },
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch (err) {
    console.error("[alphaclaw] Could not write Composio listen flag:", err.message);
    return false;
  }
};

module.exports = {
  kInstallCommand,
  composioDir,
  composioPlatformToken,
  composioReleaseAssetUrl,
  parseComposioVersion,
  compareComposioVersions,
  ensureComposioOnPath,
  checkCliAvailable,
  getInstalledComposioVersion,
  ensureComposioCliInstalled,
  ensureComposioCliAtVersion,
  ensureComposioListenFlag,
  isComposioInstalling,
  isComposioUpgrading,
  getComposioInstallError,
};
