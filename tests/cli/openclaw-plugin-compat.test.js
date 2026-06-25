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

const readOpenclawConfig = (openclawDir) =>
  JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"));

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

const createConfigRecoveryExecRecorder = ({
  openclawDir,
  version = "2026.5.6",
  plugins = [],
  shouldFailInstall,
  mutateOnInstall,
} = {}) => {
  const commands = [];
  const installConfigs = [];
  let currentPlugins = plugins;
  const execSyncImpl = (command) => {
    commands.push(String(command));
    if (String(command).includes("'--version'")) {
      return `${version}\n`;
    }
    if (String(command).includes("'plugins' 'list' '--json'")) {
      return JSON.stringify({ plugins: currentPlugins });
    }
    if (String(command).includes("'plugins' 'install'")) {
      const config = readOpenclawConfig(openclawDir);
      installConfigs.push(config);
      if (shouldFailInstall?.(config)) {
        const error = new Error(
          "Invalid config: missing plugin provider referenced by config",
        );
        error.stderr =
          "invalid-config: missing plugin provider referenced by config";
        throw error;
      }
      const nextConfig = mutateOnInstall ? mutateOnInstall(config) : config;
      writeOpenclawConfig(openclawDir, nextConfig);
      currentPlugins = [
        {
          id: "installed-after-recovery",
          name: "@openclaw/installed-after-recovery",
          version,
        },
      ];
      return "";
    }
    return "";
  };
  return { commands, execSyncImpl, installConfigs };
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
    expect(Object.keys(manifest.managedPlugins).length).toBe(59);
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
    expect(manifest.managedPlugins.slack).toMatchObject({
      kind: "channel",
      package: "@openclaw/slack",
      version: packageJson.dependencies.openclaw,
      channelId: "slack",
    });
    expect(manifest.managedPlugins.matrix).toMatchObject({
      kind: "channel",
      package: "@openclaw/matrix",
      version: packageJson.dependencies.openclaw,
      channelId: "matrix",
      install: expect.objectContaining({
        defaultChoice: "clawhub",
      }),
    });
    expect(manifest.managedPlugins["amazon-bedrock"]).toMatchObject({
      kind: "provider",
      package: "@openclaw/amazon-bedrock-provider",
      version: packageJson.dependencies.openclaw,
      providerIds: ["amazon-bedrock"],
    });
    expect(manifest.managedPlugins["anthropic-vertex"]).toMatchObject({
      kind: "provider",
      package: "@openclaw/anthropic-vertex-provider",
      version: packageJson.dependencies.openclaw,
      providerIds: ["anthropic-vertex"],
    });
    expect(manifest.managedPlugins.kimi).toMatchObject({
      kind: "provider",
      package: "@openclaw/kimi-provider",
      version: packageJson.dependencies.openclaw,
      providerIds: ["kimi"],
      providerAliases: ["kimi-coding"],
    });
    expect(manifest.managedPlugins.firecrawl).toMatchObject({
      kind: "plugin",
      package: "@openclaw/firecrawl-plugin",
      version: packageJson.dependencies.openclaw,
      webSearchProviderIds: ["firecrawl"],
      contracts: {
        webFetchProviders: ["firecrawl"],
        webSearchProviders: ["firecrawl"],
        tools: ["firecrawl_search", "firecrawl_scrape"],
      },
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

  it("installs provider plugins when provider aliases reference them", () => {
    const manifest = baseManifest({
      managedPlugins: {
        kimi: {
          kind: "provider",
          package: "@openclaw/kimi-provider",
          version: "2026.5.6",
          pluginId: "kimi",
          providerIds: ["kimi"],
          providerAliases: ["kimi-coding"],
          install: {
            npmSpec: "@openclaw/kimi-provider",
            exactNpmSpec: "@openclaw/kimi-provider@2026.5.6",
          },
        },
      },
    });
    const { commands, result } = reconcileFixture({
      tmpDir,
      manifest,
      config: {
        models: {
          providers: {
            "kimi-coding": { apiKey: "env:MOONSHOT_API_KEY" },
          },
          default: "kimi-coding/k2-coder",
        },
      },
    });

    expect(result.plugins).toEqual([
      expect.objectContaining({
        id: "kimi",
        action: "installed",
        reasons: ["models.providers.kimi-coding", "provider-reference"],
      }),
    ]);
    expect(
      commands.some((cmd) =>
        cmd.includes("'npm:@openclaw/kimi-provider@2026.5.6'"),
      ),
    ).toBe(true);
  });

  it("installs plugins for contract-defined memory providers", () => {
    const manifest = baseManifest({
      managedPlugins: {
        "llama-cpp": {
          kind: "plugin",
          package: "@openclaw/llama-cpp-provider",
          version: "2026.5.6",
          pluginId: "llama-cpp",
          contracts: {
            embeddingProviders: ["local"],
          },
          install: {
            npmSpec: "@openclaw/llama-cpp-provider",
            exactNpmSpec: "@openclaw/llama-cpp-provider@2026.5.6",
          },
        },
      },
    });
    const { commands, result } = reconcileFixture({
      tmpDir,
      manifest,
      config: {
        agents: {
          defaults: {
            memorySearch: {
              provider: "local",
            },
          },
        },
      },
    });

    expect(result.plugins).toEqual([
      expect.objectContaining({
        id: "llama-cpp",
        action: "installed",
        reasons: ["memory-provider-reference"],
      }),
    ]);
    expect(
      commands.some((cmd) =>
        cmd.includes("'npm:@openclaw/llama-cpp-provider@2026.5.6'"),
      ),
    ).toBe(true);
  });

  it("installs provider plugins when agent runtime config references them", () => {
    const { commands, result } = reconcileFixture({
      tmpDir,
      config: {
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    });

    expect(result.plugins).toEqual([
      expect.objectContaining({
        id: "codex",
        action: "installed",
        reasons: ["agent-runtime-reference"],
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

  it("recovers missing Brave web search plugin installs by temporarily suppressing the selector", () => {
    const manifest = baseManifest({
      managedPlugins: {
        brave: {
          kind: "provider",
          package: "@openclaw/brave-plugin",
          version: "2026.5.6",
          pluginId: "brave",
          webSearchProviderIds: ["brave"],
          install: {
            npmSpec: "@openclaw/brave-plugin",
            exactNpmSpec: "@openclaw/brave-plugin@2026.5.6",
          },
        },
      },
    });
    const rootDir = path.join(tmpDir, "root");
    const openclawDir = path.join(rootDir, ".openclaw");
    writeOpenclawConfig(openclawDir, {
      tools: {
        web: {
          search: {
            provider: "brave",
            apiKey: "env:BRAVE_API_KEY",
          },
        },
      },
      plugins: {
        entries: {
          brave: {
            config: { apiKey: "env:BRAVE_API_KEY" },
          },
        },
      },
    });
    const { commands, execSyncImpl, installConfigs } =
      createConfigRecoveryExecRecorder({
        openclawDir,
        shouldFailInstall: (config) =>
          config.tools?.web?.search?.provider === "brave",
      });

    const manifestPath = writeManifest(tmpDir, manifest);
    reconcileOpenclawPlugins({
      rootDir,
      openclawDir,
      manifestPath,
      openclawCliPath: "/tmp/openclaw.mjs",
      execSyncImpl,
      logger: { log: () => {} },
      now: () => "2026-05-14T00:00:00.000Z",
    });

    expect(
      commands.some((cmd) =>
        cmd.includes("'npm:@openclaw/brave-plugin@2026.5.6'"),
      ),
    ).toBe(true);
    expect(installConfigs).toHaveLength(2);
    expect(installConfigs[1].tools.web.search.provider).toBeUndefined();
    expect(installConfigs[1].tools.web.search.apiKey).toBe(
      "env:BRAVE_API_KEY",
    );
    expect(installConfigs[1].plugins.entries.brave.config).toEqual({
      apiKey: "env:BRAVE_API_KEY",
    });
    expect(readOpenclawConfig(openclawDir).tools.web.search.provider).toBe(
      "brave",
    );
  });

  it("recovers generic provider selector installs without removing provider config", () => {
    const manifest = baseManifest({
      managedPlugins: {
        demo: {
          kind: "provider",
          package: "@openclaw/demo-provider",
          version: "2026.5.6",
          pluginId: "demo",
          providerIds: ["demo-provider"],
          install: {
            npmSpec: "@openclaw/demo-provider",
            exactNpmSpec: "@openclaw/demo-provider@2026.5.6",
          },
        },
      },
    });
    const rootDir = path.join(tmpDir, "root");
    const openclawDir = path.join(rootDir, ".openclaw");
    writeOpenclawConfig(openclawDir, {
      models: {
        default: "demo-provider/sensible",
        providers: {
          "demo-provider": {
            apiKey: "env:DEMO_PROVIDER_API_KEY",
          },
        },
      },
    });
    const { execSyncImpl, installConfigs } = createConfigRecoveryExecRecorder({
      openclawDir,
      shouldFailInstall: (config) =>
        config.models?.default === "demo-provider/sensible",
    });

    const manifestPath = writeManifest(tmpDir, manifest);
    reconcileOpenclawPlugins({
      rootDir,
      openclawDir,
      manifestPath,
      openclawCliPath: "/tmp/openclaw.mjs",
      execSyncImpl,
      logger: { log: () => {} },
      now: () => "2026-05-14T00:00:00.000Z",
    });

    expect(installConfigs[1].models.default).toBeUndefined();
    expect(installConfigs[1].models.providers["demo-provider"]).toEqual({
      apiKey: "env:DEMO_PROVIDER_API_KEY",
    });
    expect(readOpenclawConfig(openclawDir).models.default).toBe(
      "demo-provider/sensible",
    );
  });

  it("recovers alias provider selector installs without removing provider config", () => {
    const manifest = baseManifest({
      managedPlugins: {
        kimi: {
          kind: "provider",
          package: "@openclaw/kimi-provider",
          version: "2026.5.6",
          pluginId: "kimi",
          providerIds: ["kimi"],
          providerAliases: ["kimi-coding"],
          install: {
            npmSpec: "@openclaw/kimi-provider",
            exactNpmSpec: "@openclaw/kimi-provider@2026.5.6",
          },
        },
      },
    });
    const rootDir = path.join(tmpDir, "root");
    const openclawDir = path.join(rootDir, ".openclaw");
    writeOpenclawConfig(openclawDir, {
      models: {
        default: "kimi-coding/k2-coder",
        providers: {
          "kimi-coding": {
            apiKey: "env:MOONSHOT_API_KEY",
          },
        },
      },
    });
    const { execSyncImpl, installConfigs } = createConfigRecoveryExecRecorder({
      openclawDir,
      shouldFailInstall: (config) =>
        config.models?.default === "kimi-coding/k2-coder",
    });

    const manifestPath = writeManifest(tmpDir, manifest);
    reconcileOpenclawPlugins({
      rootDir,
      openclawDir,
      manifestPath,
      openclawCliPath: "/tmp/openclaw.mjs",
      execSyncImpl,
      logger: { log: () => {} },
      now: () => "2026-05-14T00:00:00.000Z",
    });

    expect(installConfigs[1].models.default).toBeUndefined();
    expect(installConfigs[1].models.providers["kimi-coding"]).toEqual({
      apiKey: "env:MOONSHOT_API_KEY",
    });
    expect(readOpenclawConfig(openclawDir).models.default).toBe(
      "kimi-coding/k2-coder",
    );
  });

  it("recovers contract web fetch provider installs by temporarily suppressing the selector", () => {
    const manifest = baseManifest({
      managedPlugins: {
        firecrawl: {
          kind: "plugin",
          package: "@openclaw/firecrawl-plugin",
          version: "2026.5.6",
          pluginId: "firecrawl",
          contracts: {
            webFetchProviders: ["firecrawl"],
          },
          install: {
            npmSpec: "@openclaw/firecrawl-plugin",
            exactNpmSpec: "@openclaw/firecrawl-plugin@2026.5.6",
          },
        },
      },
    });
    const rootDir = path.join(tmpDir, "root");
    const openclawDir = path.join(rootDir, ".openclaw");
    writeOpenclawConfig(openclawDir, {
      tools: {
        web: {
          fetch: {
            provider: "firecrawl",
            maxPages: 3,
          },
        },
      },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: "env:FIRECRAWL_API_KEY",
              },
            },
          },
        },
      },
    });
    const { execSyncImpl, installConfigs } = createConfigRecoveryExecRecorder({
      openclawDir,
      shouldFailInstall: (config) =>
        config.tools?.web?.fetch?.provider === "firecrawl",
    });

    const manifestPath = writeManifest(tmpDir, manifest);
    reconcileOpenclawPlugins({
      rootDir,
      openclawDir,
      manifestPath,
      openclawCliPath: "/tmp/openclaw.mjs",
      execSyncImpl,
      logger: { log: () => {} },
      now: () => "2026-05-14T00:00:00.000Z",
    });

    expect(installConfigs[1].tools.web.fetch.provider).toBeUndefined();
    expect(installConfigs[1].tools.web.fetch.maxPages).toBe(3);
    expect(installConfigs[1].plugins.entries.firecrawl.config).toEqual({
      webFetch: {
        apiKey: "env:FIRECRAWL_API_KEY",
      },
    });
    expect(readOpenclawConfig(openclawDir).tools.web.fetch.provider).toBe(
      "firecrawl",
    );
  });

  it("recovers backend and agent runtime selector installs", () => {
    const manifest = baseManifest({
      managedPlugins: {
        runtime: {
          kind: "plugin",
          package: "@openclaw/runtime-plugin",
          version: "2026.5.6",
          pluginId: "runtime-plugin",
          install: {
            npmSpec: "@openclaw/runtime-plugin",
            exactNpmSpec: "@openclaw/runtime-plugin@2026.5.6",
          },
        },
      },
    });
    const rootDir = path.join(tmpDir, "root");
    const openclawDir = path.join(rootDir, ".openclaw");
    writeOpenclawConfig(openclawDir, {
      bindings: [{ acp: { backend: "runtime-plugin" } }],
      agents: {
        defaults: {
          agentRuntime: {
            id: "runtime-plugin",
            mode: "managed",
          },
        },
      },
    });
    const { execSyncImpl, installConfigs } = createConfigRecoveryExecRecorder({
      openclawDir,
      shouldFailInstall: (config) =>
        config.bindings?.[0]?.acp?.backend === "runtime-plugin" ||
        config.agents?.defaults?.agentRuntime?.id === "runtime-plugin",
    });

    const manifestPath = writeManifest(tmpDir, manifest);
    reconcileOpenclawPlugins({
      rootDir,
      openclawDir,
      manifestPath,
      openclawCliPath: "/tmp/openclaw.mjs",
      execSyncImpl,
      logger: { log: () => {} },
      now: () => "2026-05-14T00:00:00.000Z",
    });

    expect(installConfigs[1].bindings[0].acp.backend).toBeUndefined();
    expect(installConfigs[1].agents.defaults.agentRuntime).toEqual({
      mode: "managed",
    });
    const finalConfig = readOpenclawConfig(openclawDir);
    expect(finalConfig.bindings[0].acp.backend).toBe("runtime-plugin");
    expect(finalConfig.agents.defaults.agentRuntime).toEqual({
      id: "runtime-plugin",
      mode: "managed",
    });
  });

  it("keeps OpenClaw install config mutations while restoring suppressed selectors", () => {
    const manifest = baseManifest({
      managedPlugins: {
        demo: {
          kind: "provider",
          package: "@openclaw/demo-provider",
          version: "2026.5.6",
          pluginId: "demo",
          providerIds: ["demo-provider"],
          install: {
            npmSpec: "@openclaw/demo-provider",
            exactNpmSpec: "@openclaw/demo-provider@2026.5.6",
          },
        },
      },
    });
    const rootDir = path.join(tmpDir, "root");
    const openclawDir = path.join(rootDir, ".openclaw");
    writeOpenclawConfig(openclawDir, {
      models: { default: "demo-provider/sensible" },
      plugins: {
        entries: {
          demo: {
            config: { apiKey: "env:DEMO_PROVIDER_API_KEY" },
          },
        },
      },
    });
    const { execSyncImpl, installConfigs } = createConfigRecoveryExecRecorder({
      openclawDir,
      shouldFailInstall: (config) =>
        config.models?.default === "demo-provider/sensible",
      mutateOnInstall: (config) => ({
        ...config,
        plugins: {
          ...(config.plugins || {}),
          entries: {
            ...(config.plugins?.entries || {}),
            demo: {
              ...(config.plugins?.entries?.demo || {}),
              enabled: true,
            },
          },
        },
      }),
    });

    const manifestPath = writeManifest(tmpDir, manifest);
    reconcileOpenclawPlugins({
      rootDir,
      openclawDir,
      manifestPath,
      openclawCliPath: "/tmp/openclaw.mjs",
      execSyncImpl,
      logger: { log: () => {} },
      now: () => "2026-05-14T00:00:00.000Z",
    });

    expect(installConfigs[1].plugins.entries.demo.config).toEqual({
      apiKey: "env:DEMO_PROVIDER_API_KEY",
    });
    const finalConfig = readOpenclawConfig(openclawDir);
    expect(finalConfig.models.default).toBe("demo-provider/sensible");
    expect(finalConfig.plugins.entries.demo).toEqual({
      config: { apiKey: "env:DEMO_PROVIDER_API_KEY" },
      enabled: true,
    });
  });
});
