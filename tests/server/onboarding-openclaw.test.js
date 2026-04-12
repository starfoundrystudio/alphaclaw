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
    expect(next.plugins.entries["usage-tracker"]).toEqual({ enabled: true });
    expect(next.update.checkOnStart).toBe(false);
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
});
