const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildOnboardArgs,
  writeManagedImportOpenclawConfig,
  writeSanitizedOpenclawConfig,
} = require("../../lib/server/onboarding/openclaw");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-onboarding-openclaw-test-"));

describe("server/onboarding/openclaw", () => {
  it("builds onboarding args from submitted vars instead of stale process env auth", () => {
    process.env.ANTHROPIC_TOKEN = "sk-ant-oat01-stale-token";

    const args = buildOnboardArgs({
      varMap: {
        ANTHROPIC_API_KEY: "sk-ant-api-fresh-key",
        OPENCLAW_GATEWAY_TOKEN: "gw-token",
      },
      selectedProvider: "anthropic",
      hasCodexOauth: false,
      workspaceDir: "/tmp/workspace",
    });

    expect(args).toContain("--anthropic-api-key");
    expect(args).toContain("sk-ant-api-fresh-key");
    expect(args).not.toContain("--token");
    expect(args).not.toContain("sk-ant-oat01-stale-token");

    delete process.env.ANTHROPIC_TOKEN;
  });

  it("builds OpenRouter onboarding args for openrouter models", () => {
    const args = buildOnboardArgs({
      varMap: {
        OPENROUTER_API_KEY: "sk-or-fresh-key",
        OPENCLAW_GATEWAY_TOKEN: "gw-token",
      },
      selectedProvider: "openrouter",
      hasCodexOauth: false,
      workspaceDir: "/tmp/workspace",
    });

    expect(args).toContain("--auth-choice");
    expect(args).toContain("openrouter-api-key");
    expect(args).toContain("--openrouter-api-key");
    expect(args).toContain("sk-or-fresh-key");
  });

  it("builds Vercel AI Gateway onboarding args for gateway-backed models", () => {
    const args = buildOnboardArgs({
      varMap: {
        AI_GATEWAY_API_KEY: "aigw_live_test",
        OPENCLAW_GATEWAY_TOKEN: "gw-token",
      },
      selectedProvider: "vercel-ai-gateway",
      hasCodexOauth: false,
      workspaceDir: "/tmp/workspace",
    });

    expect(args).toContain("--auth-choice");
    expect(args).toContain("ai-gateway-api-key");
    expect(args).toContain("--ai-gateway-api-key");
    expect(args).toContain("aigw_live_test");
  });

  it("only scrubs exact secret string values in JSON", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    const pluginPath = "/app/node_modules/@starfoundrystudio/alphaclaw/lib/plugin/usage-tracker";
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: {
            allow: ["memory-core"],
            load: { paths: [pluginPath] },
            entries: {},
          },
          channels: {},
          notes: "alphaclaw",
        },
        null,
        2,
      ),
      "utf8",
    );

    writeSanitizedOpenclawConfig({
      fs,
      openclawDir,
      varMap: { GOG_KEYRING_PASSWORD: "alphaclaw" },
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.notes).toBe("${GOG_KEYRING_PASSWORD}");
    expect(next.plugins.allow).toEqual(["memory-core", "usage-tracker"]);
    expect(next.plugins.load.paths).toContain(pluginPath);
    expect(next.plugins.load.paths).not.toContain(
      "/app/node_modules/@chrysb/${GOG_KEYRING_PASSWORD}/lib/plugin/usage-tracker",
    );
  });

  it("creates plugins.allow when missing before adding usage-tracker", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: { load: { paths: [] }, entries: {} },
          channels: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    writeSanitizedOpenclawConfig({
      fs,
      openclawDir,
      varMap: {},
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.plugins.allow).toEqual(["usage-tracker"]);
    expect(next.plugins.entries["usage-tracker"]).toEqual({
      enabled: true,
      hooks: { allowConversationAccess: true },
    });
    expect(next.plugins.entries["active-memory"]).toEqual({
      enabled: true,
      config: {
        agents: ["main"],
        allowedChatTypes: ["direct", "channel"],
        modelFallbackPolicy: "default-remote",
        queryMode: "recent",
        promptStyle: "balanced",
        timeoutMs: 15000,
        maxSummaryChars: 220,
        persistTranscripts: false,
        logging: true,
      },
    });
    expect(next.agents.defaults.heartbeat.model).toBe(
      "vercel-ai-gateway/google/gemini-2.5-flash-lite",
    );
    expect(next.agents.defaults.memorySearch).toBeUndefined();
    expect(next.update.checkOnStart).toBe(false);
  });

  it("configures Codex as the managed default agent runtime when requested", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: { allow: [], load: { paths: [] }, entries: {} },
          channels: {},
          agents: {
            defaults: {
              agentRuntime: {
                fallback: "none",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    writeSanitizedOpenclawConfig({
      fs,
      openclawDir,
      varMap: {},
      agentRuntimeId: "codex",
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.agents.defaults.agentRuntime).toEqual({
      fallback: "none",
      id: "codex",
    });
    expect(next.plugins.allow).toContain("codex");
    expect(next.plugins.entries.codex).toEqual({ enabled: true });
  });

  it("configures Codex runtime for imported OpenClaw configs when requested", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: { allow: [], load: { paths: [] }, entries: {} },
          channels: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    writeManagedImportOpenclawConfig({
      fs,
      openclawDir,
      varMap: {},
      agentRuntimeId: "codex",
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.agents.defaults.agentRuntime).toEqual({ id: "codex" });
    expect(next.plugins.allow).toContain("codex");
    expect(next.plugins.entries.codex).toEqual({ enabled: true });
  });

  it("resets imported allowlist dmPolicy to pairing when re-enabling discord", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: { allow: [], load: { paths: [] }, entries: {} },
          channels: {
            discord: {
              enabled: false,
              dmPolicy: "allowlist",
              allowFrom: [],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    writeManagedImportOpenclawConfig({
      fs,
      openclawDir,
      varMap: { DISCORD_BOT_TOKEN: "discord-live-secret" },
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.channels.discord.enabled).toBe(true);
    expect(next.channels.discord.dmPolicy).toBe("pairing");
    expect(next.channels.discord.token).toBe("${DISCORD_BOT_TOKEN}");
    expect(next.plugins.entries["active-memory"]).toEqual({
      enabled: true,
      config: {
        agents: ["main"],
        allowedChatTypes: ["direct", "channel"],
        modelFallbackPolicy: "default-remote",
        queryMode: "recent",
        promptStyle: "balanced",
        timeoutMs: 15000,
        maxSummaryChars: 220,
        persistTranscripts: false,
        logging: true,
      },
    });
    expect(next.agents.defaults.heartbeat.model).toBe(
      "vercel-ai-gateway/google/gemini-2.5-flash-lite",
    );
    expect(next.agents.defaults.memorySearch).toBeUndefined();
    expect(next.update.checkOnStart).toBe(false);
  });

  it("preserves unrelated update settings while disabling startup update checks", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: { allow: [], load: { paths: [] }, entries: {} },
          channels: {},
          update: {
            channel: "beta",
            auto: { enabled: true },
            checkOnStart: true,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    writeSanitizedOpenclawConfig({
      fs,
      openclawDir,
      varMap: {},
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.update).toEqual({
      channel: "beta",
      auto: { enabled: true },
      checkOnStart: false,
    });
  });

  it("preserves unrelated heartbeat settings while forcing the managed heartbeat model", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: { allow: [], load: { paths: [] }, entries: {} },
          channels: {},
          agents: {
            defaults: {
              heartbeat: {
                every: "45m",
                directPolicy: "summary",
                model: "anthropic/claude-opus-4.6",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    writeSanitizedOpenclawConfig({
      fs,
      openclawDir,
      varMap: {},
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.agents.defaults.heartbeat).toEqual({
      every: "45m",
      directPolicy: "summary",
      model: "vercel-ai-gateway/google/gemini-2.5-flash-lite",
    });
  });

  it("preserves unrelated active memory settings while forcing managed eligibility defaults", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: {
            allow: [],
            load: { paths: [] },
            entries: {
              "active-memory": {
                enabled: false,
                config: {
                  agents: ["ops"],
                  allowedChatTypes: ["direct"],
                  promptStyle: "strict",
                  queryMode: "full",
                  timeoutMs: 22000,
                  maxSummaryChars: 400,
                  persistTranscripts: true,
                  logging: false,
                  model: "anthropic/claude-sonnet-4.6",
                },
              },
            },
          },
          channels: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    writeSanitizedOpenclawConfig({
      fs,
      openclawDir,
      varMap: {},
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.plugins.entries["active-memory"]).toEqual({
      enabled: true,
      config: {
        agents: ["main"],
        allowedChatTypes: ["direct", "channel"],
        modelFallbackPolicy: "default-remote",
        promptStyle: "strict",
        queryMode: "full",
        timeoutMs: 22000,
        maxSummaryChars: 400,
        persistTranscripts: true,
        logging: false,
        model: "anthropic/claude-sonnet-4.6",
      },
    });
  });

  it("configures memory embeddings through AI Gateway when the gateway key is provided", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: { allow: [], load: { paths: [] }, entries: {} },
          channels: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    writeSanitizedOpenclawConfig({
      fs,
      openclawDir,
      varMap: { AI_GATEWAY_API_KEY: "aigw_live_test" },
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.agents.defaults.memorySearch).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://ai-gateway.vercel.sh/v1",
        apiKey: "${AI_GATEWAY_API_KEY}",
      },
    });
  });

  it("preserves unrelated memory search settings while forcing AI Gateway embedding defaults", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: { allow: [], load: { paths: [] }, entries: {} },
          channels: {},
          agents: {
            defaults: {
              memorySearch: {
                enabled: true,
                query: { maxResults: 12 },
                provider: "gemini",
                model: "gemini-embedding-001",
                remote: {
                  baseUrl: "https://example.com/v1",
                  apiKey: "${GEMINI_API_KEY}",
                  headers: { "x-test": "1" },
                },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    writeManagedImportOpenclawConfig({
      fs,
      openclawDir,
      varMap: { AI_GATEWAY_API_KEY: "aigw_live_test" },
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.agents.defaults.memorySearch).toEqual({
      enabled: true,
      query: { maxResults: 12 },
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://ai-gateway.vercel.sh/v1",
        apiKey: "${AI_GATEWAY_API_KEY}",
        headers: { "x-test": "1" },
      },
    });
  });

  it('stamps discovery.mdns.mode during fresh onboarding when OPENCLAW_DISCOVERY_MDNS_MODE="off"', () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    const previousMode = process.env.OPENCLAW_DISCOVERY_MDNS_MODE;
    process.env.OPENCLAW_DISCOVERY_MDNS_MODE = "off";
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: { allow: [], load: { paths: [] }, entries: {} },
          channels: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      writeSanitizedOpenclawConfig({
        fs,
        openclawDir,
        varMap: {},
      });
    } finally {
      if (previousMode === undefined) {
        delete process.env.OPENCLAW_DISCOVERY_MDNS_MODE;
      } else {
        process.env.OPENCLAW_DISCOVERY_MDNS_MODE = previousMode;
      }
    }

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.discovery).toEqual({
      mdns: {
        mode: "off",
      },
    });
  });

  it('stamps discovery.mdns.mode during import onboarding when OPENCLAW_DISCOVERY_MDNS_MODE="off"', () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    const previousMode = process.env.OPENCLAW_DISCOVERY_MDNS_MODE;
    process.env.OPENCLAW_DISCOVERY_MDNS_MODE = "off";
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: { allow: [], load: { paths: [] }, entries: {} },
          channels: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      writeManagedImportOpenclawConfig({
        fs,
        openclawDir,
        varMap: {},
      });
    } finally {
      if (previousMode === undefined) {
        delete process.env.OPENCLAW_DISCOVERY_MDNS_MODE;
      } else {
        process.env.OPENCLAW_DISCOVERY_MDNS_MODE = previousMode;
      }
    }

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.discovery).toEqual({
      mdns: {
        mode: "off",
      },
    });
  });
});
