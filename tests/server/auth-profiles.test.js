const fs = require("fs");
const path = require("path");
const os = require("os");

let tmpDir;
let ap;

const readJson = (relPath) =>
  JSON.parse(fs.readFileSync(path.join(tmpDir, ".openclaw", relPath), "utf8"));

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
  delete process.env.OPENCLAW_OAUTH_DIR;
  delete process.env.ALPHACLAW_TEST_AGENT_DIR;
  const openclawDir = path.join(tmpDir, ".openclaw");
  const agentsDir = path.join(openclawDir, "agents");
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (entry.name !== "main") {
      fs.rmSync(path.join(agentsDir, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
  fs.rmSync(path.join(openclawDir, "credentials"), {
    recursive: true,
    force: true,
  });
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
  if (fs.existsSync(storeDatabasePath))
    fs.rmSync(storeDatabasePath, { force: true });
  const pendingStorePath = path.join(
    tmpDir,
    "pending-auth-profiles",
    "main.json",
  );
  if (fs.existsSync(pendingStorePath)) fs.unlinkSync(pendingStorePath);
});

afterAll(() => {
  delete process.env.OPENCLAW_OAUTH_DIR;
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

  it("stores and removes a non-secret brokered Claude CLI profile", () => {
    ap.upsertClaudeCliProfile({
      email: "owner@example.com",
      loginMethod: "claude.ai",
      brokered: true,
    });

    let store = readAuthStore();
    expect(store.profiles["anthropic:claude-cli"]).toEqual({
      type: "oauth",
      provider: "claude-cli",
      updatedAt: expect.any(Number),
      brokered: true,
      email: "owner@example.com",
      loginMethod: "claude.ai",
    });
    expect(store.order.anthropic).toEqual(["anthropic:claude-cli"]);
    expect(store.lastGood).toMatchObject({
      anthropic: "anthropic:claude-cli",
      "claude-cli": "anthropic:claude-cli",
    });
    expect(readJson("openclaw.json").auth.profiles["anthropic:claude-cli"]).toEqual({
      provider: "claude-cli",
      mode: "oauth",
    });

    expect(ap.removeClaudeCliProfile()).toBe(true);
    store = readAuthStore();
    expect(store.profiles["anthropic:claude-cli"]).toBeUndefined();
    expect(store.order.anthropic).toEqual([]);
    expect(store.lastGood?.anthropic).toBeUndefined();
    expect(store.lastGood?.["claude-cli"]).toBeUndefined();
    expect(
      readJson("openclaw.json").auth?.profiles?.["anthropic:claude-cli"],
    ).toBeUndefined();
  });

  it("retires a stale legacy JSON store after migrating its contents to SQLite", () => {
    const legacyPath = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        profiles: {
          "openai:codex-cli": {
            type: "oauth",
            provider: "openai",
            access: "old-access",
            refresh: "old-durable-refresh",
            expires: 1,
          },
        },
      }),
    );

    ap.upsertCodexProfile({
      access: "new-access",
      refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
      expires: 9999999999999,
    });

    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(readAuthStore().profiles["openai:codex-cli"]).toMatchObject({
      access: "new-access",
      refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
    });
    expect(JSON.stringify(readAuthStore())).not.toContain(
      "old-durable-refresh",
    );
  });

  it("removes duplicate OAuth profiles and known secret-bearing backups when brokering", () => {
    const agentDir = path.join(tmpDir, ".openclaw", "agents", "main", "agent");
    ap.upsertProfile("openai-codex:legacy", {
      type: "oauth",
      provider: "openai-codex",
      access: "legacy-access",
      refresh: "legacy-durable-refresh",
      expires: 1,
    });
    ap.upsertProfile("openai:alternate", {
      type: "oauth",
      provider: "openai",
      access: "alternate-access",
      refresh: "alternate-durable-refresh",
      expires: 1,
    });
    ap.upsertProfile("openai:api", {
      type: "api_key",
      provider: "openai",
      key: "api-key",
    });
    ap.upsertProfile("openai:codex-cli", {
      type: "oauth",
      provider: "openai",
      access: "canonical-sidecar-access",
      refresh: "canonical-sidecar-refresh",
      expires: 1,
      oauthRef: {
        id: "0123456789abcdef0123456789abcdef",
        provider: "openai-codex",
      },
    });
    ap.setAuthOrder("openai", [
      "openai-codex:legacy",
      "openai:alternate",
      "openai:api",
    ]);
    const importedBackup = path.join(
      agentDir,
      "auth-profiles.json.sqlite-import.1700000000000.bak",
    );
    const unifiedBackup = path.join(
      agentDir,
      "auth.json.openai-provider-unification.1700000000001.bak",
    );
    const manualBackup = path.join(agentDir, "auth-profiles.json.manual.bak");
    const aliasBackup = path.join(
      agentDir,
      "auth-profiles.json.api-key-alias.1700000000002.bak",
    );
    const oauthRefBackup = path.join(
      agentDir,
      "auth-profiles.json.oauth-ref.1700000000003.bak",
    );
    const legacyAuthPath = path.join(agentDir, "auth.json");
    const credentialsDir = path.join(tmpDir, ".openclaw", "credentials");
    const sharedOauthPath = path.join(credentialsDir, "oauth.json");
    const sharedOauthBackup = path.join(
      credentialsDir,
      "oauth.json.sqlite-import.1700000000004.bak",
    );
    const sidecarDir = path.join(credentialsDir, "auth-profiles");
    const sidecarPath = path.join(
      sidecarDir,
      "0123456789abcdef0123456789abcdef.json",
    );
    const orphanedCodexSidecarPath = path.join(
      sidecarDir,
      "11111111111111111111111111111111.json",
    );
    const unrelatedSidecarPath = path.join(
      sidecarDir,
      "22222222222222222222222222222222.json",
    );
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.writeFileSync(importedBackup, "legacy-durable-refresh");
    fs.writeFileSync(unifiedBackup, "alternate-durable-refresh");
    fs.writeFileSync(aliasBackup, "legacy-durable-refresh");
    fs.writeFileSync(oauthRefBackup, "legacy-durable-refresh");
    fs.writeFileSync(manualBackup, "operator-owned");
    fs.writeFileSync(
      legacyAuthPath,
      JSON.stringify({
        profiles: {
          "openai-codex:legacy": {
            type: "oauth",
            provider: "openai-codex",
            refresh: "auth-json-refresh",
            oauthRef: {
              id: "0123456789abcdef0123456789abcdef",
              provider: "openai-codex",
            },
          },
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "anthropic-key",
          },
        },
      }),
    );
    fs.writeFileSync(
      sharedOauthPath,
      JSON.stringify({
        openai: { refresh: "shared-openai-refresh" },
        google: { refresh: "shared-google-refresh" },
      }),
    );
    fs.writeFileSync(sharedOauthBackup, "shared-openai-refresh");
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({
        version: 1,
        profileId: "openai-codex:legacy",
        provider: "openai-codex",
        refresh: "sidecar-refresh",
      }),
    );
    fs.writeFileSync(
      orphanedCodexSidecarPath,
      JSON.stringify({
        version: 1,
        profileId: "openai-codex:orphaned",
        provider: "openai-codex",
        refresh: "orphaned-sidecar-refresh",
      }),
    );
    fs.writeFileSync(
      unrelatedSidecarPath,
      JSON.stringify({
        version: 1,
        profileId: "anthropic:external",
        provider: "anthropic",
        refresh: "unrelated-sidecar-refresh",
      }),
    );

    ap.upsertCodexProfile({
      access: "broker-access",
      refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
      expires: 9999999999999,
    });

    const store = readAuthStore();
    expect(store.profiles["openai-codex:legacy"]).toBeUndefined();
    expect(store.profiles["openai:alternate"]).toBeUndefined();
    expect(store.profiles["openai:api"]).toMatchObject({ type: "api_key" });
    expect(store.profiles["openai:codex-cli"]).toMatchObject({
      access: "broker-access",
      refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
    });
    expect(store.order.openai).toEqual(["openai:codex-cli", "openai:api"]);
    expect(JSON.stringify(store)).not.toContain("durable-refresh");
    expect(fs.existsSync(importedBackup)).toBe(false);
    expect(fs.existsSync(unifiedBackup)).toBe(false);
    expect(fs.existsSync(aliasBackup)).toBe(false);
    expect(fs.existsSync(oauthRefBackup)).toBe(false);
    expect(fs.existsSync(sharedOauthBackup)).toBe(false);
    expect(fs.existsSync(sidecarPath)).toBe(false);
    expect(fs.existsSync(orphanedCodexSidecarPath)).toBe(false);
    expect(fs.existsSync(unrelatedSidecarPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(legacyAuthPath, "utf8"))).toEqual({
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "anthropic-key",
        },
      },
    });
    expect(JSON.parse(fs.readFileSync(sharedOauthPath, "utf8"))).toEqual({
      google: { refresh: "shared-google-refresh" },
    });
    expect(fs.existsSync(manualBackup)).toBe(true);
    fs.rmSync(manualBackup, { force: true });
  });

  it("retries config cleanup after the SQLite deletion already committed", () => {
    ap.upsertCodexProfile({
      access: "access",
      refresh: "refresh",
      expires: 9999999999999,
    });
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    const renameFile = fs.renameSync.bind(fs);
    const renameSpy = vi
      .spyOn(fs, "renameSync")
      .mockImplementation((sourcePath, destinationPath) => {
        if (destinationPath === configPath)
          throw new Error("config write failed");
        return renameFile(sourcePath, destinationPath);
      });

    expect(() => ap.removeCodexProfiles()).toThrow("config write failed");
    renameSpy.mockRestore();
    expect(ap.getCodexProfile()).toBeNull();
    expect(
      readJson("openclaw.json").auth.profiles["openai:codex-cli"],
    ).toBeDefined();

    expect(ap.removeCodexProfiles()).toBe(false);
    const config = readJson("openclaw.json");
    expect(config.auth?.profiles?.["openai:codex-cli"]).toBeUndefined();
    expect(config.auth?.order?.openai).toBeUndefined();
  });

  it("physically removes durable Codex grants from every agent store", () => {
    const secondaryDir = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "secondary",
      "agent",
    );
    fs.mkdirSync(secondaryDir, { recursive: true });
    ap.upsertCodexProfile({
      access: "main-access",
      refresh: "main-physical-refresh",
      expires: 1,
    });
    ap.upsertProfile(
      "openai:secondary-codex",
      {
        type: "oauth",
        provider: "openai",
        access: "secondary-access",
        refresh: "secondary-physical-refresh",
        expires: 1,
      },
      "secondary",
    );
    ap.upsertProfile(
      "openai:secondary-api",
      {
        type: "api_key",
        provider: "openai",
        key: "secondary-api-key",
      },
      "secondary",
    );
    const secondaryBackup = path.join(
      secondaryDir,
      "auth-profiles.json.api-key-alias.1700000000010.bak",
    );
    fs.writeFileSync(secondaryBackup, "secondary-physical-refresh");
    const flatAuthPath = path.join(secondaryDir, "auth.json");
    fs.writeFileSync(
      flatAuthPath,
      JSON.stringify({
        openai: { type: "api_key", key: "flat-openai-api-key" },
        "openai-codex": {
          type: "oauth",
          access: "flat-access",
          refresh: "flat-codex-refresh",
        },
      }),
    );
    const rawLegacyDir = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "Legacy.Agent",
      "agent",
    );
    fs.mkdirSync(rawLegacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawLegacyDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai:legacy-raw-path": {
            type: "oauth",
            provider: "openai",
            access: "raw-path-access",
            refresh: "raw-path-refresh",
            expires: 1,
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(
        rawLegacyDir,
        "auth-profiles.json.sqlite-import.1700000000011.bak",
      ),
      "raw-path-refresh",
    );

    ap.upsertCodexProfile({
      access: "broker-access",
      refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
      expires: 9999999999999,
    });

    expect(ap.loadAuthStore("main").profiles["openai:codex-cli"]).toMatchObject(
      {
        refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
      },
    );
    expect(ap.loadAuthStore("secondary").profiles).toEqual({
      "openai:secondary-api": {
        type: "api_key",
        provider: "openai",
        key: "secondary-api-key",
      },
    });
    expect(JSON.parse(fs.readFileSync(flatAuthPath, "utf8"))).toEqual({
      openai: { type: "api_key", key: "flat-openai-api-key" },
    });
    expect(fs.existsSync(secondaryBackup)).toBe(false);

    const scanFiles = (directory) =>
      fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory() ? scanFiles(entryPath) : [entryPath];
      });
    const rawState = scanFiles(path.join(tmpDir, ".openclaw"))
      .map((filePath) => fs.readFileSync(filePath).toString("utf8"))
      .join("\n");
    expect(rawState).not.toContain("main-physical-refresh");
    expect(rawState).not.toContain("secondary-physical-refresh");
    expect(rawState).not.toContain("flat-codex-refresh");
    expect(rawState).not.toContain("raw-path-refresh");
  });

  it("uses OpenClaw's effective config to sanitize custom agent directories", () => {
    const customAgentDir = path.join(tmpDir, "custom-effective-agent");
    process.env.ALPHACLAW_TEST_AGENT_DIR = customAgentDir;
    fs.mkdirSync(customAgentDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".openclaw", "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: { "anthropic/claude-opus-4-6": {} },
          },
          list: [
            {
              id: "effective-agent",
              agentDir: "${ALPHACLAW_TEST_AGENT_DIR}",
            },
          ],
        },
        gateway: { port: 18789 },
      }),
    );
    fs.writeFileSync(
      path.join(customAgentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          " OPENAI-CODEX:Legacy ": {
            type: "oauth",
            provider: " OPENAI-CODEX ",
            access: "effective-access",
            refresh: "effective-durable-refresh",
            expires: 1,
          },
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "anthropic-key",
          },
        },
      }),
    );

    ap.upsertCodexProfile({
      access: "broker-access",
      refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
      expires: 9999999999999,
    });

    const execSpy = vi
      .spyOn(require("child_process"), "execFileSync")
      .mockImplementation(() => {
        throw new Error("effective config should be cached");
      });
    try {
      expect(ap.getCodexProfile()).toMatchObject({
        profileId: "openai:codex-cli",
        access: "broker-access",
      });
      expect(ap.getCodexProfile()).toMatchObject({
        profileId: "openai:codex-cli",
      });
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      execSpy.mockRestore();
    }

    expect(
      ap.loadAuthStore({
        agentId: "effective-agent",
        agentDir: customAgentDir,
      }).profiles,
    ).toEqual({
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: "anthropic-key",
      },
    });
    const rawState = fs
      .readdirSync(customAgentDir)
      .map((entry) =>
        fs.readFileSync(path.join(customAgentDir, entry)).toString("utf8"),
      )
      .join("\n");
    expect(rawState).not.toContain("effective-durable-refresh");
  });

  it("does not resolve effective agents for env values outside agents config", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".openclaw", "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: { "anthropic/claude-opus-4-6": {} },
          },
        },
        channels: { example: { token: "${CHANNEL_TOKEN}" } },
        gateway: { port: 18789 },
      }),
    );
    const execSpy = vi
      .spyOn(require("child_process"), "execFileSync")
      .mockImplementation(() => {
        throw new Error("OpenClaw CLI should not run");
      });

    try {
      expect(ap.getCodexProfile()).toBeNull();
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      execSpy.mockRestore();
    }
  });

  it("fails closed when OpenClaw's effective agent config is unavailable", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".openclaw", "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: { "anthropic/claude-opus-4-6": {} },
          },
          list: [{ id: "external", agentDir: "${MISSING_AGENT_DIR}" }],
        },
        gateway: { port: 18789 },
      }),
    );

    const execSpy = vi
      .spyOn(require("child_process"), "execFileSync")
      .mockImplementation(() => {
        throw new Error("effective config unavailable");
      });
    try {
      expect(() =>
        ap.upsertCodexProfile({
          access: "broker-access",
          refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
          expires: 9999999999999,
        }),
      ).toThrow("refusing to mutate brokered OAuth credentials");
    } finally {
      execSpy.mockRestore();
    }
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          ".openclaw",
          "agents",
          "main",
          "agent",
          "openclaw-agent.sqlite",
        ),
      ),
    ).toBe(false);
  });

  it("retries physical sanitization after a busy WAL checkpoint", () => {
    const { DatabaseSync } = require("node:sqlite");
    ap.upsertCodexProfile({
      access: "legacy-access",
      refresh: "retry-physical-refresh",
      expires: 1,
    });
    const databasePath = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    const setup = new DatabaseSync(databasePath);
    setup.exec("PRAGMA journal_mode = WAL;");
    setup.close();
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    reader.exec("BEGIN;");
    reader
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
      .get("primary");

    expect(() =>
      ap.upsertCodexProfile({
        access: "broker-access",
        refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
        expires: 9999999999999,
      }),
    ).toThrow("WAL checkpoint is busy");
    const markerPath = `${databasePath}.alphaclaw-oauth-sanitize-pending`;
    expect(fs.existsSync(markerPath)).toBe(true);
    reader.exec("COMMIT;");
    reader.close();

    ap.upsertCodexProfile({
      access: "broker-access",
      refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
      expires: 9999999999999,
    });

    expect(fs.existsSync(markerPath)).toBe(false);
    const rawDatabase = [databasePath, `${databasePath}-wal`]
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => fs.readFileSync(filePath).toString("utf8"))
      .join("\n");
    expect(rawDatabase).not.toContain("retry-physical-refresh");
  }, 15_000);

  it("physically scrubs brokered access tokens when they rotate or are removed", () => {
    const databasePath = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    const readRawDatabaseFamily = () =>
      [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
        .filter((filePath) => fs.existsSync(filePath))
        .map((filePath) => fs.readFileSync(filePath).toString("utf8"))
        .join("\n");

    ap.upsertCodexProfile({
      access: "broker-access-before-rotation",
      refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
      expires: 9999999999999,
    });
    expect(readRawDatabaseFamily()).toContain("broker-access-before-rotation");

    ap.upsertCodexProfile({
      access: "broker-access-after-rotation",
      refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
      expires: 9999999999999,
    });
    expect(readRawDatabaseFamily()).not.toContain(
      "broker-access-before-rotation",
    );
    expect(readRawDatabaseFamily()).toContain("broker-access-after-rotation");

    expect(ap.removeCodexProfiles()).toBe(true);
    const rawDatabase = readRawDatabaseFamily();
    expect(rawDatabase).not.toContain("broker-access-after-rotation");
    expect(rawDatabase).not.toContain(
      "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
    );
  });

  it("scrubs the configured OpenClaw OAuth directory", () => {
    const oauthDir = path.join(tmpDir, "custom-oauth");
    const sidecarDir = path.join(oauthDir, "auth-profiles");
    const refId = "fedcba9876543210fedcba9876543210";
    process.env.OPENCLAW_OAUTH_DIR = oauthDir;
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.writeFileSync(
      path.join(oauthDir, "oauth.json"),
      JSON.stringify({
        openai: { refresh: "custom-oauth-refresh" },
        google: { refresh: "google-refresh" },
      }),
    );
    fs.writeFileSync(
      path.join(sidecarDir, `${refId}.json`),
      JSON.stringify({
        version: 1,
        provider: "openai-codex",
        refresh: "custom-sidecar-refresh",
      }),
    );
    ap.upsertProfile("openai:codex-cli", {
      type: "oauth",
      provider: "openai",
      oauthRef: { id: refId, provider: "openai-codex" },
      access: "legacy-access",
      refresh: "custom-inline-refresh",
      expires: 1,
    });

    ap.upsertCodexProfile({
      access: "broker-access",
      refresh: "alphaclaw-oauth-broker:v1:openclaw-codex:openai",
      expires: 9999999999999,
    });

    expect(
      JSON.parse(fs.readFileSync(path.join(oauthDir, "oauth.json"), "utf8")),
    ).toEqual({
      google: { refresh: "google-refresh" },
    });
    expect(fs.existsSync(path.join(sidecarDir, `${refId}.json`))).toBe(false);
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

  it("removes every OpenAI OAuth profile while preserving non-OAuth profiles", () => {
    ap.upsertProfile("openai:alternate", {
      type: "oauth",
      provider: "openai",
      access: "alternate-access",
      refresh: "alternate-refresh",
      expires: 1,
    });
    ap.upsertProfile("openai:api", {
      type: "api_key",
      provider: "openai",
      key: "api-key",
    });

    expect(ap.removeCodexProfiles()).toBe(true);

    const store = readAuthStore();
    expect(store.profiles["openai:alternate"]).toBeUndefined();
    expect(store.profiles["openai:api"]).toMatchObject({ type: "api_key" });
    const config = readJson("openclaw.json");
    expect(config.auth?.profiles?.["openai:alternate"]).toBeUndefined();
    expect(config.auth?.profiles?.["openai:api"]).toBeDefined();
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
