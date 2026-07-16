const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

describe("bin/alphaclaw port check", () => {
  let tmpDir;
  let tmpHome;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-test-"));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-home-"));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
    try {
      if (fs.existsSync(tmpHome)) {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    } catch {}
  });

  const binPath = path.resolve(__dirname, "../../bin/alphaclaw.js");
  const writeStartupPreload = ({ targetPath, capturePath = "" }) => {
    fs.writeFileSync(
      targetPath,
      `
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const childProcess = require("child_process");

const realLoad = Module._load;
const realCopyFileSync = fs.copyFileSync;
const realWriteFileSync = fs.writeFileSync;
const realUnlinkSync = fs.unlinkSync;
const realChmodSync = fs.chmodSync;

const capturePath = ${JSON.stringify(capturePath)};
const testHome = process.env.ALPHACLAW_TEST_HOME;
if (testHome) {
  os.homedir = () => testHome;
}

childProcess.execSync = (command, options = {}) => {
  const cmd = String(command || "");
  if (
    cmd.startsWith("command -v ") ||
    cmd === "pgrep -x cron" ||
    cmd === "cron"
  ) {
    return "";
  }
  if (cmd.startsWith("git ")) {
    return "";
  }
  return "";
};

fs.copyFileSync = (src, dest, ...rest) => {
  const target = String(dest || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realCopyFileSync(src, dest, ...rest);
};

fs.writeFileSync = (targetPath, data, ...rest) => {
  const target = String(targetPath || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realWriteFileSync(targetPath, data, ...rest);
};

fs.unlinkSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/etc/cron.d/")) return;
  return realUnlinkSync(targetPath, ...rest);
};

fs.chmodSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/usr/local/bin/")) return;
  return realChmodSync(targetPath, ...rest);
};

Module._load = function patchedLoad(request, parent, isMain) {
  const parentFile = String(parent && parent.filename ? parent.filename : "");
  if (
    (request === "../lib/server.js" || String(request || "").endsWith("/lib/server.js")) &&
    parentFile.endsWith(path.join("bin", "alphaclaw.js"))
  ) {
    if (capturePath) {
      fs.writeFileSync(
        capturePath,
        JSON.stringify({
          HOME: process.env.HOME,
          OPENCLAW_HOME: process.env.OPENCLAW_HOME,
          OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
          OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        }),
      );
    }
    return {};
  }
  return realLoad.apply(this, arguments);
};
      `.trim(),
    );
  };

  it("exits with error if PORT env var is 18789", () => {
    let output = "";
    let status = 0;
    try {
      execSync(`ALPHACLAW_ROOT_DIR="${tmpDir}" node "${binPath}" start`, {
        stdio: "pipe",
        encoding: "utf8",
        env: { ...process.env, PORT: "18789", ALPHACLAW_ROOT_DIR: tmpDir }
      });
    } catch (e) {
      status = e.status;
      output = e.stdout + e.stderr;
    }

    expect(status).toBe(1);
    expect(output).toContain("AlphaClaw cannot be started on port 18789");
    expect(output).toContain("reserved for the OpenClaw gateway");
  });

  it("exits with error if --port flag is 18789", () => {
    let output = "";
    let status = 0;
    try {
      execSync(`ALPHACLAW_ROOT_DIR="${tmpDir}" node "${binPath}" start --port 18789`, {
        stdio: "pipe",
        encoding: "utf8",
        env: { ...process.env, PORT: "3000", ALPHACLAW_ROOT_DIR: tmpDir }
      });
    } catch (e) {
      status = e.status;
      output = e.stdout + e.stderr;
    }

    expect(status).toBe(1);
    expect(output).toContain("AlphaClaw cannot be started on port 18789");
    expect(output).toContain("reserved for the OpenClaw gateway");
  });

  it("does not exit if PORT is not 18789 (fails on SETUP_PASSWORD)", () => {
    let output = "";
    let status = 0;
    try {
      // We expect it to fail on SETUP_PASSWORD missing, which is AFTER the port check
      execSync(`ALPHACLAW_ROOT_DIR="${tmpDir}" node "${binPath}" start`, {
        stdio: "pipe",
        encoding: "utf8",
        env: { ...process.env, PORT: "3001", ALPHACLAW_ROOT_DIR: tmpDir, SETUP_PASSWORD: "" }
      });
    } catch (e) {
      status = e.status;
      output = e.stdout + e.stderr;
    }

    expect(status).toBe(1);
    expect(output).not.toContain("AlphaClaw cannot be started on port 18789");
    expect(output).toContain("SETUP_PASSWORD is missing or empty");
  });

  it("exports OPENCLAW_STATE_DIR during managed startup", () => {
    const preloadPath = path.join(tmpDir, "capture-openclaw-env.js");
    const capturePath = path.join(tmpDir, "captured-openclaw-env.json");
    writeStartupPreload({ targetPath: preloadPath, capturePath });

    execSync(`node "${binPath}" start`, {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        SETUP_PASSWORD: "test-password",
        ALPHACLAW_ROOT_DIR: tmpDir,
        ALPHACLAW_TEST_HOME: tmpHome,
        NODE_OPTIONS: `--require=${preloadPath}`,
      },
    });

    const reportedEnv = JSON.parse(fs.readFileSync(capturePath, "utf8"));
    expect(reportedEnv).toEqual({
      HOME: tmpDir,
      OPENCLAW_HOME: tmpDir,
      OPENCLAW_CONFIG_PATH: path.join(tmpDir, ".openclaw", "openclaw.json"),
      OPENCLAW_STATE_DIR: path.join(tmpDir, ".openclaw"),
      XDG_CONFIG_HOME: path.join(tmpDir, ".openclaw"),
    });

  });

  it("skips managed hourly git sync cron when GitHub sync env vars are absent", () => {
    const preloadPath = path.join(tmpDir, "startup-preload.js");
    const syncScriptPath = path.join(
      tmpDir,
      ".openclaw",
      ".alphaclaw",
      "hourly-git-sync.sh",
    );
    fs.mkdirSync(path.dirname(syncScriptPath), { recursive: true });
    fs.writeFileSync(syncScriptPath, "echo sync\n", "utf8");
    writeStartupPreload({ targetPath: preloadPath });

    const output = execSync(`node "${binPath}" start`, {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_TOKEN: "",
        GITHUB_WORKSPACE_REPO: "",
        SETUP_PASSWORD: "test-password",
        ALPHACLAW_ROOT_DIR: tmpDir,
        ALPHACLAW_TEST_HOME: tmpHome,
        NODE_OPTIONS: `--require=${preloadPath}`,
      },
    });

    expect(output).toContain(
      "System cron entry skipped; GitHub sync is not configured",
    );
    expect(output).not.toContain("System cron entry installed");
  });

  it("installs managed hourly git sync cron when GitHub sync env vars are present", () => {
    const preloadPath = path.join(tmpDir, "startup-preload.js");
    const syncScriptPath = path.join(
      tmpDir,
      ".openclaw",
      ".alphaclaw",
      "hourly-git-sync.sh",
    );
    fs.mkdirSync(path.dirname(syncScriptPath), { recursive: true });
    fs.writeFileSync(syncScriptPath, "echo sync\n", "utf8");
    writeStartupPreload({ targetPath: preloadPath });

    const output = execSync(`node "${binPath}" start`, {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_TOKEN: "ghp_test",
        GITHUB_WORKSPACE_REPO: "owner/repo",
        SETUP_PASSWORD: "test-password",
        ALPHACLAW_ROOT_DIR: tmpDir,
        ALPHACLAW_TEST_HOME: tmpHome,
        NODE_OPTIONS: `--require=${preloadPath}`,
      },
    });

    expect(output).toContain("System cron entry installed");
  });

  it("hourly git sync script exits cleanly when GitHub sync is not configured", () => {
    const scriptPath = path.resolve(__dirname, "../../lib/setup/hourly-git-sync.sh");
    const output = execSync(`bash "${scriptPath}"`, {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
      },
    });

    expect(output).toContain("GitHub sync is not configured; skipping");
  });

  it("runs plugin reconciliation before startup-only setup checks", () => {
    const preloadPath = path.join(tmpDir, "reconcile-preload.js");
    const commandLogPath = path.join(tmpDir, "openclaw-commands.json");
    fs.writeFileSync(
      preloadPath,
      `
const fs = require("fs");
const os = require("os");
const childProcess = require("child_process");

const commandLogPath = ${JSON.stringify(commandLogPath)};
const commands = [];
const pluginVersions = { discord: "2026.5.6", acpx: "2026.5.6" };
const testHome = process.env.ALPHACLAW_TEST_HOME;
if (testHome) {
  os.homedir = () => testHome;
}

childProcess.execSync = (command, options = {}) => {
  const cmd = String(command || "");
  commands.push(cmd);
  fs.writeFileSync(commandLogPath, JSON.stringify(commands, null, 2));
  if (cmd.includes("'--version'")) {
    return "OpenClaw 2026.5.6\\n";
  }
  if (cmd.includes("'plugins' 'list' '--json'")) {
    return JSON.stringify({
      plugins: [
        { id: "discord", name: "@openclaw/discord", version: pluginVersions.discord },
        { id: "acpx", name: "@openclaw/acpx", version: pluginVersions.acpx }
      ]
    });
  }
  if (cmd.includes("'plugins' 'update'")) {
    if (cmd.includes("@openclaw/discord@2026.7.1")) pluginVersions.discord = "2026.7.1";
    if (cmd.includes("@openclaw/acpx@2026.7.1")) pluginVersions.acpx = "2026.7.1";
  }
  return "";
};
      `.trim(),
    );

    const output = execSync(
      `node "${binPath}" --root-dir "${tmpDir}" reconcile-openclaw-plugins`,
      {
        stdio: "pipe",
        encoding: "utf8",
        env: {
          ...process.env,
          SETUP_PASSWORD: "",
          ALPHACLAW_TEST_HOME: tmpHome,
          NODE_OPTIONS: `--require=${preloadPath}`,
        },
      },
    );

    const commands = JSON.parse(fs.readFileSync(commandLogPath, "utf8"));
    expect(output).toContain("OpenClaw plugin reconciliation complete");
    expect(commands.some((cmd) => cmd.includes("'--version'"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("'plugins' 'list' '--json'"))).toBe(
      true,
    );
    expect(output).not.toContain("SETUP_PASSWORD is missing or empty");
  });

  it("creates a gogcli compatibility symlink under the managed home", () => {
    const preloadPath = path.join(tmpDir, "capture-openclaw-env.js");
    fs.writeFileSync(
      preloadPath,
      `
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const childProcess = require("child_process");

const realLoad = Module._load;
const realCopyFileSync = fs.copyFileSync;
const realWriteFileSync = fs.writeFileSync;
const realUnlinkSync = fs.unlinkSync;
const realChmodSync = fs.chmodSync;

const testHome = process.env.ALPHACLAW_TEST_HOME;
if (testHome) {
  os.homedir = () => testHome;
}

childProcess.execSync = (command, options = {}) => {
  const cmd = String(command || "");
  if (
    cmd.startsWith("command -v ") ||
    cmd === "pgrep -x cron" ||
    cmd === "cron"
  ) {
    return "";
  }
  if (cmd.startsWith("git ")) {
    return "";
  }
  return "";
};

fs.copyFileSync = (src, dest, ...rest) => {
  const target = String(dest || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realCopyFileSync(src, dest, ...rest);
};

fs.writeFileSync = (targetPath, data, ...rest) => {
  const target = String(targetPath || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realWriteFileSync(targetPath, data, ...rest);
};

fs.unlinkSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/etc/cron.d/")) return;
  return realUnlinkSync(targetPath, ...rest);
};

fs.chmodSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/usr/local/bin/")) return;
  return realChmodSync(targetPath, ...rest);
};

Module._load = function patchedLoad(request, parent, isMain) {
  const parentFile = String(parent && parent.filename ? parent.filename : "");
  if (
    (request === "../lib/server.js" || String(request || "").endsWith("/lib/server.js")) &&
    parentFile.endsWith(path.join("bin", "alphaclaw.js"))
  ) {
    return {};
  }
  return realLoad.apply(this, arguments);
};
      `.trim(),
    );

    execSync(`node "${binPath}" start`, {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        SETUP_PASSWORD: "test-password",
        ALPHACLAW_ROOT_DIR: tmpDir,
        ALPHACLAW_TEST_HOME: tmpHome,
        NODE_OPTIONS: `--require=${preloadPath}`,
      },
    });

    const compatPath = path.join(tmpDir, ".config", "gogcli");
    const managedPath = path.join(tmpDir, ".openclaw", "gogcli");
    expect(fs.lstatSync(compatPath).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(compatPath), fs.readlinkSync(compatPath))).toBe(
      managedPath,
    );
  });

  it("does not replace an existing gogcli config directory", () => {
    const preloadPath = path.join(tmpDir, "capture-openclaw-env.js");
    fs.writeFileSync(
      preloadPath,
      `
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const childProcess = require("child_process");

const realLoad = Module._load;
const realCopyFileSync = fs.copyFileSync;
const realWriteFileSync = fs.writeFileSync;
const realUnlinkSync = fs.unlinkSync;
const realChmodSync = fs.chmodSync;

const testHome = process.env.ALPHACLAW_TEST_HOME;
if (testHome) {
  os.homedir = () => testHome;
}

childProcess.execSync = (command, options = {}) => {
  const cmd = String(command || "");
  if (
    cmd.startsWith("command -v ") ||
    cmd === "pgrep -x cron" ||
    cmd === "cron"
  ) {
    return "";
  }
  if (cmd.startsWith("git ")) {
    return "";
  }
  return "";
};

fs.copyFileSync = (src, dest, ...rest) => {
  const target = String(dest || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realCopyFileSync(src, dest, ...rest);
};

fs.writeFileSync = (targetPath, data, ...rest) => {
  const target = String(targetPath || "");
  if (
    target.startsWith("/usr/local/bin/") ||
    target.startsWith("/etc/cron.d/")
  ) {
    return;
  }
  return realWriteFileSync(targetPath, data, ...rest);
};

fs.unlinkSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/etc/cron.d/")) return;
  return realUnlinkSync(targetPath, ...rest);
};

fs.chmodSync = (targetPath, ...rest) => {
  const target = String(targetPath || "");
  if (target.startsWith("/usr/local/bin/")) return;
  return realChmodSync(targetPath, ...rest);
};

Module._load = function patchedLoad(request, parent, isMain) {
  const parentFile = String(parent && parent.filename ? parent.filename : "");
  if (
    (request === "../lib/server.js" || String(request || "").endsWith("/lib/server.js")) &&
    parentFile.endsWith(path.join("bin", "alphaclaw.js"))
  ) {
    return {};
  }
  return realLoad.apply(this, arguments);
};
      `.trim(),
    );

    const compatPath = path.join(tmpDir, ".config", "gogcli");
    fs.mkdirSync(compatPath, { recursive: true });
    fs.writeFileSync(path.join(compatPath, "config.json"), "{}");

    execSync(`node "${binPath}" start`, {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        SETUP_PASSWORD: "test-password",
        ALPHACLAW_ROOT_DIR: tmpDir,
        ALPHACLAW_TEST_HOME: tmpHome,
        NODE_OPTIONS: `--require=${preloadPath}`,
      },
    });

    expect(fs.lstatSync(compatPath).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(compatPath, "config.json"))).toBe(true);
  });

  it("does not pre-create the managed openclaw runtime before onboarding", () => {
    const preloadPath = path.join(tmpDir, "skip-server-load.js");
    writeStartupPreload({ targetPath: preloadPath });

    execSync(`node "${binPath}" start`, {
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        SETUP_PASSWORD: "test-password",
        ALPHACLAW_ROOT_DIR: tmpDir,
        ALPHACLAW_TEST_HOME: tmpHome,
        NODE_OPTIONS: `--require=${preloadPath}`,
      },
    });

    expect(fs.existsSync(path.join(tmpDir, ".openclaw"))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, ".openclaw"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".env"))).toBe(true);
  });
});
