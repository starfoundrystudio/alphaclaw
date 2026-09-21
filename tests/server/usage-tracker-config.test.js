const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ensureUsageTrackerPluginConfig,
  ensureUsageTrackerPluginEntry,
  kAgentVaultPluginPath,
  kUsageTrackerPluginPath,
  reconcileManagedPluginConfig,
} = require("../../lib/server/usage-tracker-config");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-usage-tracker-test-"));

describe("server/usage-tracker-config", () => {
  it("enables Agent Vault only for managed security-gateway installs", () => {
    const localConfig = {};

    reconcileManagedPluginConfig(localConfig, { env: {} });
    expect(localConfig.plugins.allow).not.toContain("agent-vault");

    const managedConfig = {};
    reconcileManagedPluginConfig(managedConfig, {
      env: { ALPHACLAW_CONNECTIVITY_MODE: "security_gateway" },
    });
    expect(managedConfig.plugins.allow).toContain("agent-vault");
    expect(managedConfig.plugins.load.paths).toContain(kAgentVaultPluginPath);
    expect(managedConfig.plugins.entries["agent-vault"]).toEqual({
      enabled: true,
      hooks: {
        allowConversationAccess: true,
      },
    });
  });

  it("adds conversation access while preserving supported hook policy", () => {
    const cfg = {
      plugins: {
        allow: ["memory-core"],
        load: { paths: [] },
        entries: {
          "usage-tracker": {
            enabled: false,
            hooks: {
              allowPromptInjection: false,
            },
          },
        },
      },
    };

    const changed = ensureUsageTrackerPluginEntry(cfg);

    expect(changed).toBe(true);
    expect(cfg.plugins.allow).toEqual(["memory-core", "usage-tracker"]);
    expect(cfg.plugins.load.paths).toContain(kUsageTrackerPluginPath);
    expect(cfg.plugins.entries["usage-tracker"]).toEqual({
      enabled: true,
      hooks: {
        allowPromptInjection: false,
        allowConversationAccess: true,
      },
    });
  });

  it("forces conversation access policy when an older alphaclaw config has it missing or false", () => {
    const cfg = {
      plugins: {
        allow: ["usage-tracker"],
        load: { paths: [kUsageTrackerPluginPath] },
        entries: {
          "usage-tracker": {
            enabled: true,
            hooks: {
              allowPromptInjection: false,
              allowConversationAccess: false,
            },
          },
        },
      },
    };

    const changed = ensureUsageTrackerPluginEntry(cfg);

    expect(changed).toBe(true);
    expect(cfg.plugins.entries["usage-tracker"].hooks).toEqual({
      allowPromptInjection: false,
      allowConversationAccess: true,
    });
  });

  it("repairs existing openclaw configs on boot for older alphaclaw installs", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: {
            allow: ["usage-tracker"],
            load: { paths: [kUsageTrackerPluginPath] },
            entries: {
              "usage-tracker": { enabled: true },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const changed = ensureUsageTrackerPluginConfig({ fsModule: fs, openclawDir });

    expect(changed).toBe(true);
    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.plugins.entries["usage-tracker"].hooks).toEqual({
      allowConversationAccess: true,
    });
  });

  it("enables web search fallback on boot when the host provides SEARXNG_BASE_URL", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: {
            allow: ["usage-tracker"],
            load: { paths: [kUsageTrackerPluginPath] },
            entries: {
              "usage-tracker": {
                enabled: true,
                hooks: { allowConversationAccess: true },
              },
            },
          },
          tools: {
            profile: "full",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const changed = ensureUsageTrackerPluginConfig({
      fsModule: fs,
      openclawDir,
      env: {
        SEARXNG_BASE_URL: "http://127.0.0.1:8888",
      },
    });

    expect(changed).toBe(true);
    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    // G3 (2026-09-21): on a fresh 2026.9 host nothing else enables the
    // SearXNG plugin and web_search auto-detection skips credential-less
    // providers, so the fallback must enable it and name it explicitly.
    expect(next.tools.web.search).toEqual({
      enabled: true,
      provider: "searxng",
    });
    expect(next.plugins.bundledDiscovery).toBeUndefined();
    expect(next.plugins.entries.searxng).toEqual({ enabled: true });
    if (Array.isArray(next.plugins.allow)) {
      expect(next.plugins.allow).toContain("searxng");
    }
  });

  it("leaves the web-search provider unset when another provider plugin is enabled or credentialed", () => {
    const {
      hasOtherWebSearchProviderAvailable,
      applyManagedSearxngWebSearchFallback,
    } = require("../../lib/server/web-search-config");
    // Enabled plugin entry wins even without a key in the environment.
    const withPlugin = { plugins: { entries: { tavily: { enabled: true } }, allow: ["usage-tracker"] } };
    expect(hasOtherWebSearchProviderAvailable({ cfg: withPlugin, env: {} })).toBe(true);
    expect(
      applyManagedSearxngWebSearchFallback({
        cfg: withPlugin,
        env: { SEARXNG_BASE_URL: "http://127.0.0.1:8888" },
      }),
    ).toBe(true);
    // Web search stays on; only the SearXNG selection is skipped.
    expect(withPlugin.tools.web.search).toEqual({ enabled: true });
    expect(withPlugin.plugins.entries.searxng).toBeUndefined();
    expect(withPlugin.plugins.allow).not.toContain("searxng");
    // A credential in the environment for another provider also wins.
    const withKey = { plugins: { entries: {} } };
    expect(
      hasOtherWebSearchProviderAvailable({
        cfg: withKey,
        env: { TAVILY_API_KEY: "tvly-test" },
      }),
    ).toBe(true);
    // Codex-native search is a separate switch and does not count.
    const codexOnly = { tools: { web: { search: { openaiCodex: { enabled: true } } } }, plugins: { entries: {} } };
    expect(hasOtherWebSearchProviderAvailable({ cfg: codexOnly, env: {} })).toBe(false);
    expect(
      applyManagedSearxngWebSearchFallback({
        cfg: codexOnly,
        env: { SEARXNG_BASE_URL: "http://127.0.0.1:8888" },
      }),
    ).toBe(true);
    expect(codexOnly.tools.web.search.provider).toBe("searxng");
    expect(codexOnly.tools.web.search.openaiCodex).toEqual({ enabled: true });
  });

  it("preserves an explicit web search opt-out when SearXNG is available on boot", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: {
            allow: ["usage-tracker"],
            load: { paths: [kUsageTrackerPluginPath] },
            entries: {
              "usage-tracker": {
                enabled: true,
                hooks: { allowConversationAccess: true },
              },
            },
          },
          tools: {
            web: {
              search: {
                enabled: false,
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const changed = ensureUsageTrackerPluginConfig({
      fsModule: fs,
      openclawDir,
      env: {
        SEARXNG_BASE_URL: "http://127.0.0.1:8888",
      },
    });

    expect(changed).toBe(false);
    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.tools.web.search).toEqual({
      enabled: false,
    });
  });

  it("does not treat an invalid openclaw.json as an empty config", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    const invalidConfig = '{ "gateway": { "mode": "local" },';
    fs.writeFileSync(configPath, invalidConfig, "utf8");

    expect(() =>
      ensureUsageTrackerPluginConfig({ fsModule: fs, openclawDir }),
    ).toThrow(/Could not read valid openclaw\.json/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(invalidConfig);
  });

  it("refuses boot-time mutation when gateway.mode is missing", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    const clobberedStub = JSON.stringify(
      {
        plugins: {
          allow: [],
          load: { paths: [] },
          entries: {},
        },
        gateway: {},
      },
      null,
      2,
    );
    fs.writeFileSync(configPath, clobberedStub, "utf8");

    expect(() =>
      ensureUsageTrackerPluginConfig({
        fsModule: fs,
        openclawDir,
        requireGatewayMode: true,
      }),
    ).toThrow(/gateway\.mode is missing/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(clobberedStub);
  });
});
