const fs = require("fs");
const path = require("path");
const os = require("os");

let tmpDir;
let ap;

const readJson = (relPath) =>
  JSON.parse(
    fs.readFileSync(path.join(tmpDir, ".openclaw", relPath), "utf8"),
  );

const readAuthStore = () => ap.loadAuthStore();

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-auth-test-"));
  process.env.ALPHACLAW_ROOT_DIR = tmpDir;

  const openclawDir = path.join(tmpDir, ".openclaw");
  const agentDir = path.join(openclawDir, "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    JSON.stringify(
      {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: { "anthropic/claude-opus-4-6": {} },
          },
        },
        gateway: { port: 18789 },
      },
      null,
      2,
    ),
  );

  const { createAuthProfiles } = require("../../lib/server/auth-profiles");
  ap = createAuthProfiles();
});

beforeEach(() => {
  const openclawDir = path.join(tmpDir, ".openclaw");
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    JSON.stringify(
      {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: { "anthropic/claude-opus-4-6": {} },
          },
        },
        gateway: { port: 18789 },
      },
      null,
      2,
    ),
  );
  const storePath = path.join(
    openclawDir,
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );
  if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  const storeDatabasePath = path.join(
    openclawDir,
    "agents",
    "main",
    "agent",
    "openclaw-agent.sqlite",
  );
  if (fs.existsSync(storeDatabasePath)) fs.rmSync(storeDatabasePath, { force: true });
  const pendingStorePath = path.join(
    tmpDir,
    "pending-auth-profiles",
    "main.json",
  );
  if (fs.existsSync(pendingStorePath)) fs.unlinkSync(pendingStorePath);
});

afterAll(() => {
  delete process.env.ALPHACLAW_ROOT_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("server/auth-profiles", () => {
  it("upserts an api_key profile and syncs openclaw.json", () => {
    ap.upsertProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "sk-ant-test-key",
    });

    const store = readAuthStore();
    expect(store.version).toBe(1);
    expect(store.profiles["anthropic:default"]).toEqual({
      type: "api_key",
      provider: "anthropic",
      key: "sk-ant-test-key",
    });
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          ".openclaw",
          "agents/main/agent/openclaw-agent.sqlite",
        ),
      ),
    ).toBe(true);

    const config = readJson("openclaw.json");
    expect(config.auth.profiles["anthropic:default"]).toEqual({
      provider: "anthropic",
      mode: "api_key",
    });
    expect(config.gateway.port).toBe(18789);
  });

  it("upserts a token profile and syncs config mode", () => {
    ap.upsertProfile("anthropic:manual", {
      type: "token",
      provider: "anthropic",
      token: "sk-ant-oat01-test",
      expires: 9999999999999,
    });

    const store = readAuthStore();
    expect(store.profiles["anthropic:manual"].type).toBe("token");
    expect(store.profiles["anthropic:manual"].token).toBe("sk-ant-oat01-test");

    const config = readJson("openclaw.json");
    expect(config.auth.profiles["anthropic:manual"].mode).toBe("token");
  });

  it("upserts an oauth profile and syncs config", () => {
    ap.upsertProfile("openai:codex-cli", {
      type: "oauth",
      provider: "openai",
      access: "jwt-access",
      refresh: "rt-refresh",
      expires: 9999999999999,
      accountId: "test-account",
    });

    const store = readAuthStore();
    expect(store.profiles["openai:codex-cli"].type).toBe("oauth");

    const config = readJson("openclaw.json");
    expect(config.auth.profiles["openai:codex-cli"]).toEqual({
      provider: "openai",
      mode: "oauth",
    });
  });

  it("removes a profile and cleans config reference", () => {
    ap.upsertProfile("google:default", {
      type: "api_key",
      provider: "google",
      key: "AItest",
    });

    let config = readJson("openclaw.json");
    expect(config.auth.profiles["google:default"]).toBeDefined();

    ap.removeProfile("google:default");

    const store = readAuthStore();
    expect(store.profiles["google:default"]).toBeUndefined();

    config = readJson("openclaw.json");
    expect(config.auth?.profiles?.["google:default"]).toBeUndefined();
  });

  it("preserves order, lastGood, and usageStats on write", () => {
    const storePath = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "existing",
          },
        },
        order: { anthropic: ["anthropic:default"] },
        lastGood: { anthropic: "anthropic:default" },
        usageStats: { total: 42 },
      }),
    );

    ap.upsertProfile("google:default", {
      type: "api_key",
      provider: "google",
      key: "AItest",
    });

    const store = readAuthStore();
    expect(store.order).toEqual({ anthropic: ["anthropic:default"] });
    expect(store.lastGood).toEqual({ anthropic: "anthropic:default" });
    expect(store.usageStats).toEqual({ total: 42 });
    expect(store.profiles["anthropic:default"].key).toBe("existing");
    expect(store.profiles["google:default"].key).toBe("AItest");
  });

  it("normalizes secrets (strips whitespace and line breaks)", () => {
    ap.upsertProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "  sk-ant-key\r\n  ",
    });

    const store = readAuthStore();
    expect(store.profiles["anthropic:default"].key).toBe("sk-ant-key");
  });

  it("preserves existing config keys when writing openclaw.json", () => {
    ap.upsertProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "test",
    });

    const config = readJson("openclaw.json");
    expect(config.agents.defaults.model.primary).toBe(
      "anthropic/claude-opus-4-6",
    );
    expect(config.agents.defaults.models).toEqual({
      "anthropic/claude-opus-4-6": {},
    });
    expect(config.gateway.port).toBe(18789);
  });

  it("setModelConfig writes primary and configuredModels", () => {
    ap.setModelConfig({
      primary: "openai/gpt-5.1-codex",
      configuredModels: {
        "openai/gpt-5.1-codex": {},
        "anthropic/claude-opus-4-6": {},
      },
    });

    const config = readJson("openclaw.json");
    expect(config.agents.defaults.model.primary).toBe("openai/gpt-5.1-codex");
    expect(config.agents.defaults.models).toEqual({
      "openai/gpt-5.1-codex": {},
      "anthropic/claude-opus-4-6": {},
    });
    expect(config.gateway.port).toBe(18789);
  });

  it("setModelConfig enables managed agent runtime owner plugins", () => {
    const result = ap.setModelConfig({
      primary: "openai/gpt-5.5",
      configuredModels: {
        "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
        "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
      },
    });

    const config = readJson("openclaw.json");
    expect(result.managedPluginIds).toEqual(["codex", "anthropic"]);
    expect(config.plugins.allow).toEqual(
      expect.arrayContaining(["codex", "anthropic"]),
    );
    expect(config.plugins.entries.codex).toEqual({ enabled: true });
    expect(config.plugins.entries.anthropic).toEqual({ enabled: true });
  });

  it("legacy upsertCodexProfile writes oauth and syncs config", () => {
    ap.upsertCodexProfile({
      access: "jwt",
      refresh: "rt",
      expires: 9999999999999,
      accountId: "acct",
    });

    const store = readAuthStore();
    expect(store.profiles["openai:codex-cli"]).toEqual({
      type: "oauth",
      provider: "openai",
      access: "jwt",
      refresh: "rt",
      expires: 9999999999999,
      updatedAt: expect.any(Number),
      accountId: "acct",
    });
    expect(store.order.openai).toEqual(["openai:codex-cli"]);

    const config = readJson("openclaw.json");
    expect(config.auth.profiles["openai:codex-cli"]).toEqual({
      provider: "openai",
      mode: "oauth",
    });
    expect(config.auth.order.openai).toEqual(["openai:codex-cli"]);
  });

  it("legacy removeCodexProfiles removes all codex profiles", () => {
    ap.upsertCodexProfile({
      access: "jwt",
      refresh: "rt",
      expires: 1,
    });

    let store = readAuthStore();
    expect(store.profiles["openai:codex-cli"]).toBeDefined();

    ap.removeCodexProfiles();

    store = readAuthStore();
    expect(store.profiles["openai:codex-cli"]).toBeUndefined();

    const config = readJson("openclaw.json");
    expect(config.auth?.profiles?.["openai:codex-cli"]).toBeUndefined();
    expect(config.auth?.order?.openai).toBeUndefined();
  });

  it("does not write auth refs into incomplete pre-onboarding config", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".openclaw", "openclaw.json"),
      JSON.stringify(
        {
          auth: {
            profiles: {},
          },
          gateway: { port: 18789 },
        },
        null,
        2,
      ),
    );

    ap.upsertCodexProfile({
      access: "jwt",
      refresh: "rt",
      expires: 9999999999999,
      accountId: "acct",
    });

    const store = readAuthStore();
    expect(store.profiles["openai:codex-cli"]).toBeDefined();

    const config = readJson("openclaw.json");
    expect(config.auth?.profiles || {}).toEqual({});
    expect(config.gateway.port).toBe(18789);
  });

  it("stages pre-onboarding auth profiles outside .openclaw and migrates them later", () => {
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    const finalStorePath = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    const pendingStorePath = path.join(
      tmpDir,
      "pending-auth-profiles",
      "main.json",
    );

    fs.unlinkSync(configPath);

    ap.upsertCodexProfile({
      access: "jwt",
      refresh: "rt",
      expires: 9999999999999,
      accountId: "acct",
    });

    expect(fs.existsSync(finalStorePath)).toBe(false);
    expect(fs.existsSync(pendingStorePath)).toBe(true);

    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.1-codex" },
            },
          },
          gateway: { port: 18789 },
        },
        null,
        2,
      ),
    );

    ap.syncConfigAuthReferencesForAgent();

    expect(fs.existsSync(finalStorePath)).toBe(true);
    expect(fs.existsSync(pendingStorePath)).toBe(false);
    const store = readAuthStore();
    expect(store.profiles["openai:codex-cli"]).toMatchObject({
      type: "oauth",
      provider: "openai",
      access: "jwt",
      refresh: "rt",
      accountId: "acct",
    });
  });
});
