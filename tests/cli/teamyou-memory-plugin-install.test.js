const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  getMarkerPath,
  parseShellAssignments,
  readMarker,
  reconcileTeamyouMemoryPlugin,
} = require("../../lib/cli/teamyou-memory-plugin-install");
const {
  reconcileOpenclawPlugins,
} = require("../../lib/cli/openclaw-plugin-compat");

const kUrl = "https://blob.example/openclaw-teamyou-memory-0.3.0.tgz?sig=a&b=c";

describe("cli/teamyou-memory-plugin-install", () => {
  let tmpDir;
  let openclawDir;
  let archivePath;
  const logger = { log: () => {} };

  const installExtension = (id = "openclaw-teamyou-memory") => {
    const dir = path.join(openclawDir, "extensions", "openclaw-teamyou-memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify({ id }));
  };
  const handoffEnv = (overrides = {}) => ({
    ALPHACLAW_TEAMYOU_MEMORY_PLUGIN_ARCHIVE: archivePath,
    ALPHACLAW_TEAMYOU_MEMORY_PLUGIN_VERSION: "0.3.0",
    ALPHACLAW_TEAMYOU_MEMORY_PLUGIN_URL: kUrl,
    ...overrides,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "teamyou-plugin-install-"));
    openclawDir = path.join(tmpDir, "root", ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    archivePath = path.join(tmpDir, "openclaw-teamyou-memory-0.3.0.tgz");
    fs.writeFileSync(archivePath, "tgz");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips when clawctl has not handed over an archive", () => {
    const runOpenclaw = vi.fn();
    const result = reconcileTeamyouMemoryPlugin({
      openclawDir, env: {}, fsModule: fs, runOpenclaw, logger,
    });
    expect(result).toEqual(expect.objectContaining({ action: "skipped", reason: "not_configured" }));
    expect(runOpenclaw).not.toHaveBeenCalled();
  });

  it("installs from the staged archive with --force and --accept-capabilities and no --pin", () => {
    const runOpenclaw = vi.fn(() => installExtension());
    const result = reconcileTeamyouMemoryPlugin({
      openclawDir, env: handoffEnv(), fsModule: fs, runOpenclaw, logger,
    });
    expect(runOpenclaw).toHaveBeenCalledWith([
      "plugins", "install", archivePath, "--force", "--accept-capabilities",
    ]);
    expect(result).toEqual(expect.objectContaining({ action: "installed", version: "0.3.0" }));
    expect(readMarker({ fsModule: fs, openclawDir })).toEqual({
      INSTALLED_TEAMYOU_MEMORY_PLUGIN_VERSION: "0.3.0",
      INSTALLED_TEAMYOU_MEMORY_PLUGIN_URL: kUrl,
    });
  });

  it("treats a clawctl-written marker (printf %q) for the same version as installed", () => {
    installExtension();
    fs.mkdirSync(path.dirname(getMarkerPath({ openclawDir })), { recursive: true });
    fs.writeFileSync(
      getMarkerPath({ openclawDir }),
      "INSTALLED_TEAMYOU_MEMORY_PLUGIN_VERSION=0.3.0\n" +
        "INSTALLED_TEAMYOU_MEMORY_PLUGIN_URL=https://blob.example/openclaw-teamyou-memory-0.3.0.tgz\\?sig=a\\&b=c\n",
    );
    const runOpenclaw = vi.fn();
    const result = reconcileTeamyouMemoryPlugin({
      openclawDir, env: handoffEnv(), fsModule: fs, runOpenclaw, logger,
    });
    expect(result).toEqual(expect.objectContaining({ action: "skipped", reason: "already_installed" }));
    expect(runOpenclaw).not.toHaveBeenCalled();
  });

  it("updates when the handed-over version changes", () => {
    installExtension();
    fs.mkdirSync(path.dirname(getMarkerPath({ openclawDir })), { recursive: true });
    fs.writeFileSync(
      getMarkerPath({ openclawDir }),
      "INSTALLED_TEAMYOU_MEMORY_PLUGIN_VERSION='0.2.9'\nINSTALLED_TEAMYOU_MEMORY_PLUGIN_URL='old'\n",
    );
    const runOpenclaw = vi.fn();
    const result = reconcileTeamyouMemoryPlugin({
      openclawDir, env: handoffEnv(), fsModule: fs, runOpenclaw, logger,
    });
    expect(runOpenclaw).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("updated");
  });

  it("fails loudly when the staged archive is missing or the install left nothing behind", () => {
    fs.rmSync(archivePath);
    expect(() =>
      reconcileTeamyouMemoryPlugin({
        openclawDir, env: handoffEnv(), fsModule: fs, runOpenclaw: vi.fn(), logger,
      }),
    ).toThrow(/archive is missing/);

    fs.writeFileSync(archivePath, "tgz");
    expect(() =>
      reconcileTeamyouMemoryPlugin({
        openclawDir, env: handoffEnv(), fsModule: fs, runOpenclaw: vi.fn(), logger,
      }),
    ).toThrow(/did not install/);
    expect(fs.existsSync(getMarkerPath({ openclawDir }))).toBe(false);
  });

  it("parses both marker quoting styles", () => {
    expect(
      parseShellAssignments("A='it'\\''s'\nB=a\\ b\\&c\n# comment\n"),
    ).toEqual({ A: "it's", B: "a b&c" });
  });

  it("runs from the managed plugin reconcile only when the caller opts in", () => {
    const rootDir = path.join(tmpDir, "root");
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, alphaclawVersion: "0", openclawVersion: "2026.9.5", managedPlugins: {} }),
    );
    const commands = [];
    const execSyncImpl = (command) => {
      commands.push(String(command));
      if (String(command).includes("'--version'")) return "2026.9.5\n";
      if (String(command).includes("'plugins' 'list' '--json'")) return JSON.stringify({ plugins: [] });
      if (String(command).includes("'plugins' 'install'")) installExtension();
      return "";
    };
    const run = (installTeamyouMemoryPlugin) =>
      reconcileOpenclawPlugins({
        rootDir,
        openclawDir,
        manifestPath,
        openclawCliPath: "/tmp/openclaw.mjs",
        execSyncImpl,
        logger,
        env: handoffEnv(),
        installTeamyouMemoryPlugin,
      });

    expect(run(false).plugins).toEqual([]);
    expect(commands.some((c) => c.includes("'plugins' 'install'"))).toBe(false);

    const result = run(true);
    expect(commands.find((c) => c.includes("'plugins' 'install'"))).toContain(
      `'plugins' 'install' '${archivePath}' '--force' '--accept-capabilities'`,
    );
    expect(result.plugins).toEqual([
      expect.objectContaining({ id: "openclaw-teamyou-memory", action: "installed", version: "0.3.0" }),
    ]);
  });
});
