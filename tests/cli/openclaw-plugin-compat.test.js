const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildInstallSpec,
  compareVersions,
  loadOpenclawCompatibilityManifest,
  reconcileOpenclawPlugins,
  satisfiesVersionRange,
} = require("../../lib/cli/openclaw-plugin-compat");

const kRepoRoot = path.resolve(__dirname, "../..");

const writeManifest = (dir, manifest) => {
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
};

const writeOpenclawConfig = (openclawDir, config) => {
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
};

const baseManifest = (overrides = {}) => ({
  schemaVersion: 1,
  alphaclawVersion: "0.0.0-test",
  openclawVersion: "2026.5.6",
  managedPlugins: {
    discord: {
      kind: "channel",
      package: "@openclaw/discord",
      version: "2026.5.6",
      pluginId: "discord",
      channelId: "discord",
      install: {
        npmSpec: "@openclaw/discord",
        exactNpmSpec: "@openclaw/discord@2026.5.6",
      },
    },
    acpx: {
      kind: "plugin",
      package: "@openclaw/acpx",
      version: "2026.5.6",
      pluginId: "acpx",
      install: {
        npmSpec: "@openclaw/acpx",
        exactNpmSpec: "@openclaw/acpx@2026.5.6",
      },
    },
    "memory-lancedb": {
      kind: "plugin",
      package: "@openclaw/memory-lancedb",
      version: "2026.5.6",
      pluginId: "memory-lancedb",
      install: {
        npmSpec: "@openclaw/memory-lancedb",
        exactNpmSpec: "@openclaw/memory-lancedb@2026.5.6",
      },
    },
    codex: {
      kind: "provider",
      package: "@openclaw/codex",
      version: "2026.5.6",
      pluginId: "codex",
      providerIds: ["codex"],
      install: {
        npmSpec: "@openclaw/codex",
        exactNpmSpec: "@openclaw/codex@2026.5.6",
      },
    },
  },
  ...overrides,
});

const createExecRecorder = ({ version = "2026.5.6", plugins = [] } = {}) => {
  const commands = [];
  const execSyncImpl = (command) => {
    commands.push(String(command));
    if (String(command).includes("'--version'")) {
      return `${version}\n`;
    }
    if (String(command).includes("'plugins' 'list' '--json'")) {
      return JSON.stringify({ plugins });
    }
    return "";
  };
  return { commands, execSyncImpl };
};

const reconcileFixture = ({
  tmpDir,
  manifest = baseManifest(),
  config = {},
  plugins = [],
  version,
} = {}) => {
  const rootDir = path.join(tmpDir, "root");
  const openclawDir = path.join(rootDir, ".openclaw");
  writeOpenclawConfig(openclawDir, config);
  const manifestPath = writeManifest(tmpDir, manifest);
  const { commands, execSyncImpl } = createExecRecorder({ version, plugins });
  const result = reconcileOpenclawPlugins({
    rootDir,
    openclawDir,
    manifestPath,
    openclawCliPath: "/tmp/openclaw.mjs",
    execSyncImpl,
    logger: { log: () => {} },
    now: () => "2026-05-14T00:00:00.000Z",
  });
  return { commands, result };
};

describe("openclaw plugin compatibility manifest", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-plugin-compat-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("loads the generated packaged manifest for every official external catalog entry", () => {
    const manifest = loadOpenclawCompatibilityManifest();
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(kRepoRoot, "package.json"), "utf8"),
    );

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.alphaclawVersion).toBe(packageJson.version);
    expect(manifest.openclawVersion).toBe(packageJson.dependencies.openclaw);
    expect(manifest.source.upstreamCatalogs.map((entry) => entry.kind)).toEqual([
      "channel",
      "plugin",
      "provider",
    ]);
    expect(Object.keys(manifest.managedPlugins).length).toBe(27);
    expect(manifest.managedPlugins.discord).toMatchObject({
      kind: "channel",
      package: "@openclaw/discord",
      version: packageJson.dependencies.openclaw,
      channelId: "discord",
    });
    expect(manifest.managedPlugins.acpx).toMatchObject({
      kind: "plugin",
      package: "@openclaw/acpx",
      version: packageJson.dependencies.openclaw,
    });
    expect(manifest.managedPlugins["memory-lancedb"]).toMatchObject({
      kind: "plugin",
      package: "@openclaw/memory-lancedb",
      version: packageJson.dependencies.openclaw,
    });
    expect(manifest.managedPlugins.codex).toMatchObject({
      kind: "provider",
      package: "@openclaw/codex",
      version: packageJson.dependencies.openclaw,
      providerIds: ["codex"],
    });
  });

  it("matches OpenClaw migration version ranges", () => {
    expect(compareVersions("2026.4.9", "2026.4.10")).toBeLessThan(0);
    expect(compareVersions("2026.5.6", "2026.5.6")).toBe(0);
    expect(compareVersions("2026.5.12", "2026.5.6")).toBeGreaterThan(0);
    expect(satisfiesVersionRange("2026.4.9", "<2026.4.10")).toBe(true);
    expect(satisfiesVersionRange("2026.4.10", "<2026.4.10")).toBe(false);
    expect(satisfiesVersionRange("2026.5.6", ">=2026.4.25")).toBe(true);
  });

  it("does not install catalog plugins that are not relevant to the host config", () => {
    const { commands, result } = reconcileFixture({
      tmpDir,
      config: { channels: { telegram: {} } },
    });

    expect(result.plugins).toEqual([]);
    expect(commands.some((cmd) => cmd.includes("'plugins' 'install'"))).toBe(
      false,
    );
  });

  it("installs the Discord plugin only when Discord is configured", () => {
    const { commands, result } = reconcileFixture({
      tmpDir,
      config: { channels: { discord: { tokenRef: "env:DISCORD_BOT_TOKEN" } } },
    });

    expect(result.plugins).toEqual([
      expect.objectContaining({
        id: "discord",
        action: "installed",
        reasons: ["channels.discord"],
      }),
    ]);
    expect(commands.some((cmd) => cmd.includes("'npm:@openclaw/discord@2026.5.6'"))).toBe(
      true,
    );
  });

  it("installs ACPX when config references the ACPX backend", () => {
    const { commands, result } = reconcileFixture({
      tmpDir,
      config: {
        bindings: [
          {
            type: "acp",
            acp: { backend: "acpx", agent: "codex" },
          },
        ],
      },
    });

    expect(result.plugins).toEqual([
      expect.objectContaining({
        id: "acpx",
        action: "installed",
        reasons: ["backend-reference"],
      }),
    ]);
    expect(commands.some((cmd) => cmd.includes("'npm:@openclaw/acpx@2026.5.6'"))).toBe(
      true,
    );
  });

  it("installs generic plugins when selected in plugin entries or slots", () => {
    const { commands, result } = reconcileFixture({
      tmpDir,
      config: {
        plugins: {
          entries: {
            "memory-lancedb": { enabled: true },
          },
          slots: {
            memory: "memory-lancedb",
          },
        },
      },
    });

    expect(result.plugins).toEqual([
      expect.objectContaining({
        id: "memory-lancedb",
        action: "installed",
        reasons: ["plugins.entries.memory-lancedb", "plugins.slots"],
      }),
    ]);
    expect(commands.some((cmd) => cmd.includes("'npm:@openclaw/memory-lancedb@2026.5.6'"))).toBe(
      true,
    );
  });

  it("installs provider plugins when provider config references them", () => {
    const { commands, result } = reconcileFixture({
      tmpDir,
      config: {
        models: {
          providers: {
            codex: { auth: "app-server" },
          },
          default: "codex/gpt-5.5",
        },
      },
    });

    expect(result.plugins).toEqual([
      expect.objectContaining({
        id: "codex",
        action: "installed",
        reasons: ["models.providers.codex", "provider-reference"],
      }),
    ]);
    expect(commands.some((cmd) => cmd.includes("'npm:@openclaw/codex@2026.5.6'"))).toBe(
      true,
    );
  });

  it("pins exact plugin versions instead of resolving latest", () => {
    expect(
      buildInstallSpec({
        package: "@openclaw/discord",
        version: "2026.5.6",
        install: { exactNpmSpec: "@openclaw/discord@2026.5.6" },
      }),
    ).toBe("npm:@openclaw/discord@2026.5.6");
  });

  it("updates or downgrades relevant managed plugins to the exact manifest version", () => {
    const { commands, result } = reconcileFixture({
      tmpDir,
      config: { channels: { discord: {} } },
      plugins: [
        {
          id: "discord",
          name: "@openclaw/discord",
          version: "2026.5.12",
        },
      ],
    });

    expect(result.plugins[0]).toMatchObject({
      action: "updated",
      previousVersion: "2026.5.12",
      version: "2026.5.6",
    });
    expect(commands.some((cmd) => cmd.includes("'npm:@openclaw/discord@2026.5.6'"))).toBe(
      true,
    );
    expect(commands.some((cmd) => cmd.includes("'--pin'"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("--force"))).toBe(true);
    expect(commands.some((cmd) => cmd.includes("latest"))).toBe(false);
  });

  it("keeps already-installed official plugins updated even without current config", () => {
    const { commands, result } = reconcileFixture({
      tmpDir,
      config: {},
      plugins: [
        {
          id: "discord",
          name: "@openclaw/discord",
          version: "2026.5.6",
        },
      ],
    });

    expect(result.plugins[0]).toMatchObject({
      id: "discord",
      action: "skipped",
      reasons: ["already-installed"],
    });
    expect(commands.some((cmd) => cmd.includes("'plugins' 'install'"))).toBe(
      false,
    );
  });

  it("preserves unmanaged plugins while writing only relevant managed state", () => {
    const { commands, result } = reconcileFixture({
      tmpDir,
      config: { channels: { discord: {} } },
      plugins: [
        {
          id: "custom-tool",
          name: "@example/custom-tool",
          version: "1.2.3",
        },
      ],
    });

    expect(commands.some((cmd) => cmd.includes("@example/custom-tool"))).toBe(
      false,
    );
    expect(Object.keys(result.lock.plugins)).toEqual(["discord"]);
  });
});
